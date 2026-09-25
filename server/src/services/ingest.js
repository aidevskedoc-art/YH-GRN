/**
 * Persists a parsed upload as one batch, and reconciles what it touched.
 *
 * Everything happens inside a single transaction: a batch is either fully
 * stored with its reconciliation results, or not stored at all.
 *
 * One copy of everything. A report re-uploaded -- the same file twice, or next
 * month's carrying a GRN that was still pending in this month's -- is newer
 * data about rows already stored, so it replaces them rather than adding a
 * second copy beside them:
 *
 *  - a GRN row, by its GRN number;
 *  - a GRN's ageing rows, all of them together, by the GRN number they are
 *    about;
 *  - a bank transaction, when the new statement carries the same one;
 *  - a GRN's BPAD register rows, as before (clearBpadRecordsFor).
 *
 * and each GRN has one reconciliation result, rebuilt whenever an upload
 * touches either side of it (see linkResults). Anything the upload says
 * nothing about is left exactly as it was.
 *
 * `batch_id` on a row therefore says which upload last brought it. The upload
 * itself stays listed with the file names and row counts it arrived with.
 */
import { withTransaction } from '../db/pool.js';
import { matchGrnAgeingPair } from './reconcile.js';

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
 * Uploads one at a time.
 *
 * Replacing is a delete followed by an insert, and two uploads carrying the
 * same GRN side by side would each delete only what was committed before they
 * started -- then both insert, and the GRN has two copies again (or, with the
 * unique indexes schema.sql adds, one of the uploads fails). This makes the
 * second wait for the first. relinkStoredResults takes the same lock.
 *
 * SHARE ROW EXCLUSIVE: it conflicts with itself and with every write to these
 * tables, and not with reads, so the screens keep working while a file is
 * stored. Taken after the upload's own row is inserted into upload_batches,
 * and in the order schema.sql reaches these five tables, so an upload does not
 * take them the other way round from `npm run migrate`. That is not a promise
 * the two can overlap: schema.sql locks `users` before `upload_batches`, and
 * the upload's insert checks `users` (uploaded_by) after taking
 * `upload_batches`. Run the migration with the server stopped -- a clash is
 * caught by Postgres as a deadlock and one side rolls back whole, but it is
 * still a failed upload or a failed migration.
 */
async function lockUploadTables(client) {
  await client.query(
    `LOCK TABLE grn_transactions, vendor_ageing, reconciliation_results,
                bank_statement_transactions, bpad_records
       IN SHARE ROW EXCLUSIVE MODE`,
  );
}

/**
 * The GRN report's rows, one per GRN number -- the last row wins.
 *
 * A report is not expected to carry a GRN twice, but nothing in the parser
 * stops it, and a second row would break the one-row-per-GRN rule (and the
 * unique index behind it). The later row is kept, as the later of two uploads
 * would be. A row whose GRN number folds to nothing is kept as it is: there is
 * no telling two of those apart.
 *
 * Exported for routes/batches.js, which builds the BPAD register's filler rows
 * and the upload's summary from the same rows this stores. Applied again here
 * all the same, so saveBatch holds the rule whoever calls it.
 */
export function lastRowPerGrn(grnRows) {
  const seen = new Set();
  const kept = [];
  for (let i = grnRows.length - 1; i >= 0; i -= 1) {
    const key = grnRows[i].dprNoKey;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(grnRows[i]);
  }
  return kept.reverse();
}

/**
 * Hand-typed cheque clearance dates on the ageing rows about to be replaced,
 * by GRN and cheque number.
 *
 * cheque_clearance_override is the one column on an ageing row that is not
 * the report's: it is written by PATCH /api/ageing/:id/dates (routes/results.js;
 * no screen offers it now) and wins over the bank statement's date. The new
 * report cannot carry it, so it is carried across to the new row for the same
 * cheque. The seven stage dates that route can also change are the report's
 * own columns, and the new report's values replace them -- a correction there
 * does not outlive the next report naming the GRN.
 */
async function clearanceOverridesFor(client, keys) {
  if (keys.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT grn_number_key, cheque_no, cheque_clearance_override
       FROM vendor_ageing
      WHERE grn_number_key = ANY($1)
        AND cheque_clearance_override IS NOT NULL
        AND COALESCE(cheque_no, '') <> ''
      ORDER BY batch_id, id`,
    [keys],
  );
  // Oldest first, so where two copies disagree the newer one is what is kept.
  return new Map(rows.map((r) => [`${r.grn_number_key}|${r.cheque_no}`, r.cheque_clearance_override]));
}

/**
 * Each GRN row's verdict against the ageing row it pairs with now.
 *
 * The ageing row is the first of the GRN's rows -- the report repeats a GRN
 * once per cheque, and the first row is the one that carries NetAmt and the
 * payable amount (see indexAgeingByGrnNumber in reconcile.js). Every GRN's rows come from one
 * upload, so "first" is simply the lowest row number; the batch order ahead of
 * it only matters on a database the migration has not yet cleaned up.
 *
 * `where` selects the GRN rows, as SQL over `g`, with `params` for it. Returns
 * the verdict for each, and the result it currently has, if any.
 */
async function verdictsFor(client, where, params) {
  const { rows } = await client.query(
    `SELECT g.id AS grn_id, g.bill_no_key, g.bill_no, g.vendor_name_key,
            m.id AS ageing_id, m.bill_no_key AS ageing_bill_no_key,
            m.bill_no AS ageing_bill_no, m.vendor_name_key AS ageing_vendor_name_key,
            r.id AS result_id, r.matched_ageing_id, r.status AS current_status
       FROM grn_transactions g
       LEFT JOIN LATERAL (
         SELECT a.id, a.bill_no_key, a.bill_no, a.vendor_name_key
           FROM vendor_ageing a
          WHERE a.grn_number_key = g.dpr_no_key
            AND g.dpr_no_key <> ''
          ORDER BY a.batch_id DESC, a.source_row_no NULLS LAST, a.id
          LIMIT 1
       ) m ON TRUE
       LEFT JOIN LATERAL (
         SELECT rr.id, rr.matched_ageing_id, rr.status
           FROM reconciliation_results rr
          WHERE rr.grn_transaction_id = g.id
          ORDER BY rr.batch_id DESC, rr.id DESC
          LIMIT 1
       ) r ON TRUE
      WHERE ${where}
      -- Oldest copy first, so on a database the migration has not cleaned yet
      -- the newest copy of a GRN gets the highest result id -- which is the
      -- tie-break DEDUPED_RESULTS (routes/results.js) shows by.
      ORDER BY g.batch_id, g.id`,
    params,
  );

  return rows.map((row) => {
    const verdict = matchGrnAgeingPair(
      { billNoKey: row.bill_no_key, billNo: row.bill_no, vendorNameKey: row.vendor_name_key },
      row.ageing_id == null
        ? undefined
        : {
            billNoKey: row.ageing_bill_no_key,
            billNo: row.ageing_bill_no,
            vendorNameKey: row.ageing_vendor_name_key,
          },
    );
    return {
      grnId: row.grn_id,
      ageingId: row.ageing_id ?? null,
      resultId: row.result_id ?? null,
      changed: row.result_id == null
        || (row.matched_ageing_id ?? null) !== (row.ageing_id ?? null)
        || row.current_status !== verdict.status,
      ...verdict,
    };
  });
}

/**
 * One result per GRN this upload touched, rebuilt from what is stored now.
 *
 * Touched means: a GRN row this upload stored, or a GRN already on file whose
 * ageing rows this upload replaced. Both sides are read back out of the tables
 * rather than taken from the parsed files, so the answer is the same whichever
 * order the two reports arrived in -- GRN report today and ageing report last
 * week, or the other way round, or both together. Whatever result those GRNs
 * had before goes, and the new one is filed under this upload.
 */
async function linkResults(client, batchId, ageingKeys) {
  const verdicts = await verdictsFor(
    client,
    'g.batch_id = $1 OR g.dpr_no_key = ANY($2)',
    [batchId, ageingKeys],
  );
  if (verdicts.length === 0) return verdicts;

  await client.query('DELETE FROM reconciliation_results WHERE grn_transaction_id = ANY($1)', [
    verdicts.map((v) => v.grnId),
  ]);
  await bulkInsert(client, 'reconciliation_results', RESULT_COLUMNS, verdicts, (v) => [
    batchId, v.grnId, v.ageingId, v.status, v.billNoMatch, v.vendorNameMatch, v.discrepancyNotes,
  ]);
  return verdicts;
}

/**
 * Bring every stored result in line with the ageing row its GRN pairs with
 * now -- run by `npm run migrate`, after schema.sql has cleared the older
 * copies away.
 *
 * Two things left results pointing at the wrong ageing row, or at none:
 *
 *  - an upload used to pair a GRN with the LAST of its ageing rows when they
 *    had arrived in an earlier upload, and with the first when they arrived
 *    together -- so a GRN paid by several cheques could show a later cheque's
 *    row, which carries no amounts;
 *  - clearing an older upload's ageing rows (schema.sql) sets the link on any
 *    result that still pointed at one of them to NULL.
 *
 * Only results whose ageing row or verdict actually changes are written, and
 * they keep the upload they are filed under. Idempotent: once every result is
 * in line, this changes nothing.
 *
 * @returns {Promise<number>} how many results were changed
 */
export function relinkStoredResults() {
  return withTransaction(async (client) => {
    await lockUploadTables(client);

    const changed = (await verdictsFor(client, 'TRUE', [])).filter((v) => v.changed && v.resultId != null);
    for (let start = 0; start < changed.length; start += CHUNK_SIZE) {
      const chunk = changed.slice(start, start + CHUNK_SIZE);
      await client.query(
        `UPDATE reconciliation_results r
            SET matched_ageing_id = u.ageing_id,
                status            = u.status,
                bill_no_match     = u.bill_no_match,
                vendor_name_match = u.vendor_name_match,
                discrepancy_notes = u.discrepancy_notes
           FROM unnest($1::int[], $2::int[], $3::text[], $4::boolean[], $5::boolean[], $6::text[])
                  AS u(id, ageing_id, status, bill_no_match, vendor_name_match, discrepancy_notes)
          WHERE r.id = u.id`,
        [
          chunk.map((v) => v.resultId),
          chunk.map((v) => v.ageingId),
          chunk.map((v) => v.status),
          chunk.map((v) => v.billNoMatch),
          chunk.map((v) => v.vendorNameMatch),
          chunk.map((v) => v.discrepancyNotes),
        ],
      );
    }
    return changed.length;
  });
}

/**
 * A bank transaction the new statement carries, stored by an earlier upload.
 *
 * A statement has no transaction id, so a transaction is known by everything
 * on its row: dates, reference, narration, amounts and the closing balance --
 * the account's running balance after it, which is what tells two otherwise
 * identical same-day charges apart. The account comes from the upload's
 * letterhead (upload_batches.bank_account_no), and a statement whose letterhead
 * did not give one matches any account.
 *
 * Every earlier copy of each transaction goes, and the new statement's rows are
 * what stay -- all of them, including a row it genuinely carries twice.
 *
 * Kept in step with the bank clean-up at the end of schema.sql.
 */
async function clearEarlierBankRows(client, batchId, accountNo) {
  const { rowCount } = await client.query(
    `DELETE FROM bank_statement_transactions o
      USING bank_statement_transactions n, upload_batches ob
      WHERE n.batch_id = $1
        AND o.batch_id <> $1
        AND ob.id = o.batch_id
        AND (ob.bank_account_no IS NULL OR $2::text IS NULL OR ob.bank_account_no = $2::text)
        AND o.txn_date = n.txn_date
        AND COALESCE(o.chq_ref_no, '') = COALESCE(n.chq_ref_no, '')
        AND COALESCE(o.narration, '')  = COALESCE(n.narration, '')
        AND o.value_date      IS NOT DISTINCT FROM n.value_date
        AND o.withdrawal_amt  IS NOT DISTINCT FROM n.withdrawal_amt
        AND o.deposit_amt     IS NOT DISTINCT FROM n.deposit_amt
        AND o.closing_balance IS NOT DISTINCT FROM n.closing_balance`,
    [batchId, accountNo],
  );
  return rowCount;
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
  // Not the report's: carried over from the row this one replaces. See
  // clearanceOverridesFor.
  'cheque_clearance_override',
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
 * @param {string} [params.bankFileName] the bank statement, if one was given
 * @param {Array}  [params.bankRows]     its parsed transaction rows
 * @param {string} [params.bankAccountNo] the account its letterhead names
 * @param {string} [params.bpadFileName] the BPAD register, if one was given
 * @param {Array}  [params.bpadRows]     one row per GRN in scope: the
 *   register's own where it had one, a GRN-report-only row where it did not
 * @param {number} [params.bpadScanned]  how many rows the register held
 * @returns {Promise<{batchId: number, reopenedRejections: number, replaced: object}>}
 *   the new batch id; how many GRNs this upload took back off the CSD queue by
 *   carrying a bill CSD had rejected -- see reopenRejectedFor; and how many
 *   stored rows it replaced, per file.
 */
export function saveBatch({
  name,
  grnFileName = null,
  ageingFileName = null,
  userId,
  grnRows = [],
  ageingRows = [],
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

    await lockUploadTables(client);

    // GRN rows: whatever is stored for these GRN numbers goes -- taking its
    // result with it (ON DELETE CASCADE) -- and this report's rows go in.
    const grnToStore = lastRowPerGrn(grnRows);
    const grnKeys = [...new Set(grnToStore.map((r) => r.dprNoKey).filter(Boolean))];
    const { rowCount: replacedGrnRows } = grnKeys.length > 0
      ? await client.query('DELETE FROM grn_transactions WHERE dpr_no_key = ANY($1)', [grnKeys])
      : { rowCount: 0 };

    await bulkInsert(client, 'grn_transactions', GRN_COLUMNS, grnToStore, (r) => [
      batchId, r.sourceRowNo, r.slNo, r.warehouse, r.dprNo, r.dprNoKey, r.poNo,
      r.dprDate, r.billDate, r.billNo, r.billNoKey, r.dcNo, r.vendorCode, r.vendorName,
      r.vendorNameKey, r.billAmount, r.transportAmount, r.totalAmount, r.location,
      r.addAmount, r.dedAmount,
    ]);

    // Ageing rows: the same, a whole GRN at a time. The report repeats a GRN
    // once per cheque and adds rows as payments are made, so its rows for a
    // GRN are that GRN's current payment picture, and all of the older rows go
    // -- matching them one by one could leave a stale "no cheque yet" row
    // beside the cheque that has since been written. Rows whose GRN number
    // folds to nothing are never matched and never replaced.
    //
    // A result still pointing at one of the deleted rows loses the link (ON
    // DELETE SET NULL) for a moment; linkResults below rebuilds it, since
    // every such result is for one of these GRN numbers.
    const ageingKeys = [...new Set(ageingRows.map((r) => r.grnNumberKey).filter(Boolean))];
    const overrides = await clearanceOverridesFor(client, ageingKeys);
    const { rowCount: replacedAgeingRows } = ageingKeys.length > 0
      ? await client.query('DELETE FROM vendor_ageing WHERE grn_number_key = ANY($1)', [ageingKeys])
      : { rowCount: 0 };

    await bulkInsert(client, 'vendor_ageing', AGEING_COLUMNS, ageingRows, (r) => [
      batchId, r.sourceRowNo, r.division, r.divisionCode, r.storeName, r.vendorName,
      r.vendorNameKey, r.vendorCode, r.grnDoc, r.grnNo, r.branchCode, r.grnNumber,
      r.grnNumberKey, r.billNo, r.billNoKey, r.billDate, r.netAmt, r.adjPurReturn,
      r.adjustedJv, r.tdsJv, r.payableAmount,
      r.indentDate, r.poDate, r.securityDate, r.grnDate, r.billToAudit,
      r.billHandOverToAcc, r.chqDate, r.chequeClearanceDate,
      r.paymentDocNo, r.chequeNo, r.balance,
      (r.grnNumberKey && r.chequeNo && overrides.get(`${r.grnNumberKey}|${r.chequeNo}`)) || null,
    ]);

    // Then one result for every GRN either report touched. This is also what
    // pairs across uploads: a GRN report today against ageing rows uploaded
    // last week, or an ageing report today naming a GRN uploaded last week and
    // sitting PENDING since.
    await linkResults(client, batchId, ageingKeys);

    // Optional, and reconciled against nothing: the statement is stored as it
    // was read, for matching later by extracted_cheque_no. In first, so the
    // earlier copies of its transactions can be found by joining to it.
    let replacedBankRows = 0;
    if (bankRows.length > 0) {
      await bulkInsert(client, 'bank_statement_transactions', BANK_COLUMNS, bankRows, (r) => [
        batchId, r.sourceRowNo, r.txnDate, r.narration, r.chqRefNo,
        r.extractedChequeNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance,
      ]);
      replacedBankRows = await clearEarlierBankRows(client, batchId, bankAccountNo);
    }

    // Optional too, and reconciled against nothing here: the matching was done
    // while the register was read (see readBpadReport), and the GRNs it had no
    // entry for were filled in afterwards, so what arrives is already one row
    // per GRN and ready to store.
    let replacedBpadRows = 0;
    if (bpadRows.length > 0) {
      // Replacing rather than adding to. A re-uploaded register is a newer
      // answer about the same bills, so the older answer about those bills
      // goes first -- inside this transaction, so a failed upload leaves the
      // rows it was about to replace exactly where they were.
      replacedBpadRows = await clearBpadRecordsFor(client, bpadRows);
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

    return {
      batchId,
      reopenedRejections,
      replaced: {
        grnRows: replacedGrnRows,
        ageingRows: replacedAgeingRows,
        bankRows: replacedBankRows,
        bpadRows: replacedBpadRows,
      },
    };
  });
}
