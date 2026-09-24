/**
 * Persists a parsed + reconciled upload as one batch.
 *
 * Everything happens inside a single transaction: a batch is either fully
 * stored with its reconciliation results, or not stored at all.
 */
import { withTransaction } from '../db/pool.js';
import { STATUS, matchGrnAgeingPair, indexAgeingByGrnNumber } from './reconcile.js';

/** Rows per multi-row INSERT. Keeps well under Postgres' 65535 parameter cap. */
const CHUNK_SIZE = 500;

/**
 * Insert `rows` into `table`, `CHUNK_SIZE` at a time, returning the new ids in
 * input order.
 *
 * Exported for the MSME reco's rows (routes/msmeReco.js), which are stored
 * the same way but are not part of a batch.
 */
export async function bulkInsert(client, table, columns, rows, toValues) {
  const ids = [];

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const params = [];
    const tuples = chunk.map((row, i) => {
      const values = toValues(row, start + i);
      // The placeholder offset is derived from columns.length, so a value tuple
      // of a different length would silently misnumber every subsequent row
      // rather than error. Adding a column means editing two lists; this is what
      // catches forgetting the second one.
      if (values.length !== columns.length) {
        throw new Error(
          `${table}: ${values.length} values for ${columns.length} columns - the column list and the value tuple are out of step.`,
        );
      }
      const placeholders = values.map((_, j) => `$${i * columns.length + j + 1}`);
      params.push(...values);
      return `(${placeholders.join(', ')})`;
    });

    const { rows: inserted } = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} RETURNING id`,
      params,
    );
    ids.push(...inserted.map((r) => r.id));
  }

  return ids;
}

/**
 * Clear whatever a previous upload stored for the GRNs this one is about.
 *
 * The register is a snapshot of where a set of bills had got to when it was
 * exported, so a re-export is a newer snapshot of the same bills rather than a
 * second set of them -- and it is re-exported and re-uploaded as bills move,
 * several times in a day. Keeping both meant a table of 23,814 rows describing
 * 3,402 GRNs, of which only the newest copy of each was ever read. The older
 * copy is deleted here rather than filtered out on every read, which is where
 * it used to go.
 *
 * Keyed on the vendor code and the GRN number together -- the same pair the
 * register was matched on in the first place -- and only on the pairs this
 * upload actually carries. A GRN this upload says nothing about keeps the rows
 * it has: uploading May's register must not blank out April's answers, and a
 * delete scoped to the table rather than to these keys would do exactly that.
 *
 * Deletes per GRN rather than per row, so the register's own repeats survive.
 * It writes a GRN once per invoice across a split bill, and all of those rows
 * go back in together immediately afterwards -- which is also why this is a
 * delete and an insert rather than an upsert onto a unique key. There is no
 * key here to be unique on.
 */
async function clearBpadRecordsFor(client, rows) {
  const vendorCodeKeys = [];
  const grnNoKeys = [];

  for (const row of rows) {
    // Both halves are filled on every row that gets this far -- a register row
    // is only kept when the pair matched a GRN, and a filled-in row is built
    // from a GRN that had both. A null would quietly match nothing here rather
    // than complain, so it is worth not sending one.
    if (!row.vendorCodeKey || !row.grnNoKey) continue;
    vendorCodeKeys.push(row.vendorCodeKey);
    grnNoKeys.push(row.grnNoKey);
  }

  if (grnNoKeys.length === 0) return 0;

  // Two parallel arrays rather than a few thousand placeholders: unnest pairs
  // them back up positionally, and DISTINCT folds the register's own repeats
  // down to the one key they share before the join sees them.
  const { rowCount } = await client.query(
    `DELETE FROM bpad_records b
      USING (
        SELECT DISTINCT *
        FROM unnest($1::text[], $2::text[]) AS t(vendor_code_key, grn_no_key)
      ) k
      WHERE b.vendor_code_key = k.vendor_code_key
        AND b.grn_no_key      = k.grn_no_key`,
    [vendorCodeKeys, grnNoKeys],
  );

  return rowCount;
}

/**
 * Rejected handovers for GRNs this upload carries: archived, then taken off
 * the queue so the GRN reads as unsent again.
 *
 * A GRN CSD rejects goes back to the branch to be put right. When it turns up
 * in a new report it is a fresh bill -- the thing that was wrong with it has
 * been dealt with, or it would not have been sent round again -- so it should
 * look like one: no dispatch, Send picker back, free to go to CSD afresh. That
 * is what removing the dispatch does, since every screen reads "has this been
 * sent" from the existence of that row rather than from a flag.
 *
 * Only REJECTED. A GRN still queued or received is with CSD now and a new
 * upload says nothing about that; approved and moved-to-accounts have got past
 * CSD entirely, and reopening either would throw away an answer nobody asked to
 * revisit.
 *
 * Only the keys this upload actually carries -- the same scoping
 * clearBpadRecordsFor uses, and for the same reason. Uploading May's reports
 * must not reopen a rejection about a GRN May says nothing about. Both files'
 * keys count: the GRN report names a GRN directly, and an ageing report naming
 * it is equally a new statement about that bill.
 *
 * Archived rather than dropped, because dpr_no_key is UNIQUE on csd_dispatches
 * -- there is no room for the old rejection beside the new handover -- and
 * deleting it outright would take CSD's reason with it. See
 * csd_rejection_history in schema.sql.
 *
 * One statement: the DELETE's own RETURNING feeds the INSERT, so a dispatch
 * cannot be removed without its record being written. It runs inside the
 * upload's transaction like everything else here, so a failed upload reopens
 * nothing.
 *
 * Worth knowing: re-uploading the same file reopens its rejections too. The
 * rule is "this GRN appears in an upload", and nothing here can tell a
 * corrected report from the same one sent twice.
 */
async function reopenRejectedFor(client, batchId, grnKeys) {
  if (grnKeys.length === 0) return 0;

  const { rowCount } = await client.query(
    `WITH superseded AS (
       DELETE FROM csd_dispatches c
        WHERE c.stage = 'REJECTED'
          AND c.dpr_no_key = ANY($1)
       RETURNING c.*
     )
     INSERT INTO csd_rejection_history
       (dpr_no_key, dpr_no, division_code, location, bill_no, vendor_code,
        vendor_name, cheque_no, payable_amount, reject_remarks, rejected_at,
        rejected_by, sent_at, sent_by, superseded_by_batch_id)
     SELECT dpr_no_key, dpr_no, division_code, location, bill_no, vendor_code,
            vendor_name, cheque_no, payable_amount, reject_remarks, rejected_at,
            stage_by, sent_at, sent_by, $2
       FROM superseded`,
    [grnKeys, batchId],
  );

  return rowCount;
}

/**
 * The most recent row per key, across every batch, restricted to a
 * caller-supplied set of keys -- an upload only ever needs to ask about the
 * keys it just saw, not the whole table.
 *
 * "Most recent" means the highest batch_id, the same tie-break the "all
 * uploads" results view uses (see DEDUPED_RESULTS in routes/results.js): a
 * GRN or ageing row re-uploaded since is a correction, and the newer copy is
 * the one worth matching against.
 */
async function findLatestByKey(client, table, keyColumn, keys, extraColumns) {
  if (keys.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT DISTINCT ON (${keyColumn}) id, ${keyColumn} AS key, ${extraColumns.join(', ')}
     FROM ${table}
     WHERE ${keyColumn} = ANY($1)
     ORDER BY ${keyColumn}, batch_id DESC, id DESC`,
    [keys],
  );
  return new Map(rows.map((r) => [r.key, r]));
}

const GRN_COLUMNS = [
  'batch_id', 'source_row_no', 'sl_no', 'warehouse', 'dpr_no', 'dpr_no_key', 'po_no',
  'dpr_date', 'bill_date', 'bill_no', 'bill_no_key', 'dc_no', 'vendor_code', 'vendor_name',
  'vendor_name_key', 'bill_amount', 'transport_amount', 'total_amount', 'location',
  'add_amount', 'ded_amount',
];

// Must stay the same length and order as the value tuple in saveBatch below:
// bulkInsert numbers its placeholders from `columns.length`, so a mismatch
// misnumbers every row rather than failing loudly.
const AGEING_COLUMNS = [
  'batch_id', 'source_row_no', 'division', 'division_code', 'store_name', 'vendor_name',
  'vendor_name_key', 'vendor_code', 'grn_doc', 'grn_no', 'branch_code', 'grn_number',
  'grn_number_key', 'bill_no', 'bill_no_key', 'bill_date', 'net_amt', 'adj_pur_return',
  'adjusted_jv', 'tds_jv', 'payable_amount',
  'indent_date', 'po_date', 'security_date', 'grn_date', 'bill_to_audit',
  'bill_handover_to_acc', 'chq_date', 'cheque_clearance_date',
  'payment_doc_no', 'cheque_no', 'balance',
];

/** The statement's transaction table. See schema.sql for why only this part. */
const BANK_COLUMNS = [
  'batch_id', 'source_row_no', 'txn_date', 'narration', 'chq_ref_no',
  'extracted_cheque_no', 'value_date', 'withdrawal_amt', 'deposit_amt', 'closing_balance',
];

/**
 * One row per GRN the upload is about: the register's own row where it had one
 * (already narrowed by readBpadReport, which filters as it reads rather than
 * handing 327,000 rows over to be thrown away here), and a row carrying only
 * what the GRN report knows where it did not -- see bpadRowsForGrns in
 * routes/batches.js. `in_register` is which of the two a row is.
 */
const BPAD_COLUMNS = [
  'batch_id', 'source_row_no', 'sl_no', 'location', 'warehouse',
  'vendor_code', 'vendor_code_key', 'vendor_name',
  'inv_no', 'inv_date', 'grn_no', 'grn_no_key', 'grn_date', 'grn_amount',
  'po_number', 'po_date', 'pending_with_dept',
  'bpad_received_date', 'accounts_received_date',
  'pending_with_user', 'pend_reason',
  'in_register',
];

const RESULT_COLUMNS = [
  'batch_id', 'grn_transaction_id', 'matched_ageing_id', 'status',
  'bill_no_match', 'vendor_name_match', 'discrepancy_notes',
];

/**
 * @param {object} params
 * @param {string} params.name  what the person uploading called this batch
 * @param {string} [params.grnFileName]    the GRN report, if one was given
 * @param {string} [params.ageingFileName] the ageing report, if one was given
 * @param {number} params.userId
 * @param {Array}  [params.grnRows]     parsed GRN rows
 * @param {Array}  [params.ageingRows]  parsed ageing rows
 * @param {Array}  params.results     from reconcile()
 * @param {string} [params.bankFileName] the bank statement, if one was given
 * @param {Array}  [params.bankRows]     its parsed transaction rows
 * @param {string} [params.bpadFileName] the BPAD register, if one was given
 * @param {Array}  [params.bpadRows]     one row per GRN in scope: the
 *   register's own where it had one, a GRN-report-only row where it did not
 * @param {number} [params.bpadScanned]  how many rows the register held
 * @returns {Promise<{batchId: number, reopenedRejections: number}>} the new
 *   batch id, and how many GRNs this upload took back off the CSD queue by
 *   carrying a bill CSD had rejected -- see reopenRejectedFor.
 */
export function saveBatch({
  name,
  grnFileName = null,
  ageingFileName = null,
  userId,
  grnRows = [],
  ageingRows = [],
  results,
  bankFileName = null,
  bankRows = [],
  bankAccountNo = null,
  bpadFileName = null,
  bpadRows = [],
  bpadScanned = 0,
}) {
  return withTransaction(async (client) => {
    const { rows: batchRows } = await client.query(
      `INSERT INTO upload_batches
         (name, grn_file_name, ageing_file_name, grn_row_count, ageing_row_count, uploaded_by,
          bank_file_name, bank_row_count, bank_account_no,
          bpad_file_name, bpad_row_count, bpad_matched_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        name, grnFileName, ageingFileName, grnRows.length, ageingRows.length, userId,
        bankFileName, bankRows.length, bankAccountNo,
        // Both counts, not just the one that was kept: "3,468 of 327,292" is
        // what tells a reader the register was read whole and narrowed, rather
        // than leaving them to wonder where the other 323,824 rows went.
        bpadFileName, bpadScanned, bpadRows.length,
      ],
    );
    const batchId = batchRows[0].id;

    const grnIds = await bulkInsert(client, 'grn_transactions', GRN_COLUMNS, grnRows, (r) => [
      batchId, r.sourceRowNo, r.slNo, r.warehouse, r.dprNo, r.dprNoKey, r.poNo,
      r.dprDate, r.billDate, r.billNo, r.billNoKey, r.dcNo, r.vendorCode, r.vendorName,
      r.vendorNameKey, r.billAmount, r.transportAmount, r.totalAmount, r.location,
      r.addAmount, r.dedAmount,
    ]);

    const ageingIds = await bulkInsert(client, 'vendor_ageing', AGEING_COLUMNS, ageingRows, (r) => [
      batchId, r.sourceRowNo, r.division, r.divisionCode, r.storeName, r.vendorName,
      r.vendorNameKey, r.vendorCode, r.grnDoc, r.grnNo, r.branchCode, r.grnNumber,
      r.grnNumberKey, r.billNo, r.billNoKey, r.billDate, r.netAmt, r.adjPurReturn,
      r.adjustedJv, r.tdsJv, r.payableAmount,
      r.indentDate, r.poDate, r.securityDate, r.grnDate, r.billToAudit,
      r.billHandOverToAcc, r.chqDate, r.chequeClearanceDate,
      r.paymentDocNo, r.chequeNo, r.balance,
    ]);

    // reconcile() preserves input order, so a result's position maps to the id
    // of the GRN row at the same position. The matched ageing row is located by
    // its own position, recorded during parsing.
    const ageingIdBySourceRow = new Map(ageingRows.map((r, i) => [r.sourceRowNo, ageingIds[i]]));

    /*
     * reconcile() above only ever paired this upload's own two files. That
     * misses two situations someone uploading one report at a time hits
     * constantly:
     *
     *  - a GRN uploaded today whose matching ageing row was uploaded last
     *    week, on its own, days before this GRN report existed to match it;
     *  - an ageing report uploaded today, on its own, naming a GRN that was
     *    uploaded last week and has been sitting PENDING ever since.
     *
     * Both are the same shape of problem: half the pair is in *this* batch's
     * freshly-parsed rows and the other half is already sitting in an earlier
     * batch's table. The fix is to go look for it there.
     */
    const grnKeysThisBatch = new Set(grnRows.map((r) => r.dprNoKey).filter(Boolean));

    // This upload's own GRN rows that stayed PENDING after matching against
    // this upload's own ageing file (if it had one) get a second chance
    // against whatever ageing row is the latest on file for that GRN number,
    // from any earlier upload.
    const pendingDprKeys = [
      ...new Set(results.filter((r) => r.status === STATUS.PENDING && r.grn.dprNoKey).map((r) => r.grn.dprNoKey)),
    ];
    const priorAgeingByKey = await findLatestByKey(client, 'vendor_ageing', 'grn_number_key', pendingDprKeys, [
      'bill_no_key',
      'bill_no',
      'vendor_name_key',
    ]);

    const upgradedResults = results.map((r) => {
      if (r.status !== STATUS.PENDING || !r.grn.dprNoKey) return r;
      const prior = priorAgeingByKey.get(r.grn.dprNoKey);
      if (!prior) return r;
      const match = matchGrnAgeingPair(r.grn, {
        billNoKey: prior.bill_no_key,
        billNo: prior.bill_no,
        vendorNameKey: prior.vendor_name_key,
      });
      return { ...r, ...match, priorAgeingId: prior.id };
    });

    await bulkInsert(client, 'reconciliation_results', RESULT_COLUMNS, upgradedResults, (r, index) => [
      batchId,
      grnIds[index],
      r.ageing ? ageingIdBySourceRow.get(r.ageing.sourceRowNo) ?? null : (r.priorAgeingId ?? null),
      r.status,
      r.billNoMatch,
      r.vendorNameMatch,
      r.discrepancyNotes,
    ]);

    // The other direction: this upload's own ageing rows that name a GRN
    // number no GRN row in this same upload carries. Those keys are looked up
    // among every earlier upload's GRN rows instead, and a fresh result is
    // stored -- against that earlier GRN row's own id, since this batch never
    // stored one of its own for it -- so the newer upload is what the "all
    // uploads" view now shows for that GRN (it dedupes by highest batch_id;
    // see DEDUPED_RESULTS in routes/results.js).
    const { index: ageingIndex } = indexAgeingByGrnNumber(ageingRows);
    const ageingOnlyKeys = [...ageingIndex.keys()].filter((key) => !grnKeysThisBatch.has(key));
    const priorGrnByKey = await findLatestByKey(client, 'grn_transactions', 'dpr_no_key', ageingOnlyKeys, [
      'bill_no_key',
      'bill_no',
      'vendor_name_key',
    ]);

    const crossBatchResults = [];
    for (const key of ageingOnlyKeys) {
      const priorGrn = priorGrnByKey.get(key);
      // No GRN by that number has ever been uploaded -- the ageing row is
      // stored (above) with nothing yet to reconcile it against, same as
      // when the two arrive together and one side has no match.
      if (!priorGrn) continue;

      const ageingRow = ageingIndex.get(key);
      const match = matchGrnAgeingPair(
        { billNoKey: priorGrn.bill_no_key, billNo: priorGrn.bill_no, vendorNameKey: priorGrn.vendor_name_key },
        ageingRow,
      );
      crossBatchResults.push({
        grnTransactionId: priorGrn.id,
        matchedAgeingId: ageingIdBySourceRow.get(ageingRow.sourceRowNo) ?? null,
        ...match,
      });
    }

    if (crossBatchResults.length > 0) {
      await bulkInsert(client, 'reconciliation_results', RESULT_COLUMNS, crossBatchResults, (r) => [
        batchId,
        r.grnTransactionId,
        r.matchedAgeingId,
        r.status,
        r.billNoMatch,
        r.vendorNameMatch,
        r.discrepancyNotes,
      ]);
    }

    // Optional, and reconciled against nothing: the statement is stored as it
    // was read, for matching later by extracted_cheque_no.
    if (bankRows.length > 0) {
      await bulkInsert(client, 'bank_statement_transactions', BANK_COLUMNS, bankRows, (r) => [
        batchId, r.sourceRowNo, r.txnDate, r.narration, r.chqRefNo,
        r.extractedChequeNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance,
      ]);
    }

    // Optional too, and reconciled against nothing here: the matching was done
    // while the register was read (see readBpadReport), and the GRNs it had no
    // entry for were filled in afterwards, so what arrives is already one row
    // per GRN and ready to store.
    if (bpadRows.length > 0) {
      // Replacing rather than adding to. A re-uploaded register is a newer
      // answer about the same bills, so the older answer about those bills
      // goes first -- inside this transaction, so a failed upload leaves the
      // rows it was about to replace exactly where they were.
      await clearBpadRecordsFor(client, bpadRows);
      await bulkInsert(client, 'bpad_records', BPAD_COLUMNS, bpadRows, (r) => [
        batchId, r.sourceRowNo, r.slNo, r.location, r.warehouse,
        r.vendorCode, r.vendorCodeKey, r.vendorName,
        r.invNo, r.invDate, r.grnNo, r.grnNoKey, r.grnDate, r.grnAmount,
        r.poNumber, r.poDate, r.pendingWithDept,
        r.bpadReceivedDate, r.accountsReceivedDate,
        r.pendingWithUser, r.pendReason,
        // Defaulted rather than required, so a row built straight off the
        // register -- which knows nothing about this flag -- is a register row.
        r.inRegister ?? true,
      ]);
    }

    /*
     * Last, once both files' rows are in: any GRN this upload carries that CSD
     * had rejected comes back off the queue and reads as unsent again -- see
     * reopenRejectedFor. Both files' keys, since either naming a GRN is a new
     * statement about that bill.
     *
     * After the inserts rather than before, so that if anything above fails the
     * transaction rolls back with the rejections untouched.
     */
    const reopenKeys = [
      ...new Set([
        ...grnRows.map((r) => r.dprNoKey),
        ...ageingRows.map((r) => r.grnNumberKey),
      ].filter(Boolean)),
    ];
    const reopenedRejections = await reopenRejectedFor(client, batchId, reopenKeys);

    return { batchId, reopenedRejections };
  });
}
