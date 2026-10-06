/**
 * Persists a parsed OP Pharmacy upload as one batch, and reconciles what it
 * touched.
 *
 * services/ingest.js over again, against the pharmacies' own tables (the ph_
 * ones at the foot of db/schema.sql), and the rules are the same ones for the
 * same reasons -- they are argued there, beside the hospital code, and only
 * what differs is said here:
 *
 *  - one copy of everything: an upload replaces the GRN rows, the ageing rows,
 *    the bank transactions and the BPAD rows it carries rather than adding a
 *    second copy beside them, and each GRN has one result, rebuilt whenever an
 *    upload touches either side of it;
 *  - all inside one transaction, so a batch is stored whole or not at all.
 *
 * Two things the hospital upload does that this one does not. It does not
 * reopen a CSD rejection: no pharmacy GRN goes to CSD, so there is no queue for
 * an upload to take one back off. And the purchase register and the pharmacy
 * ageing report each bring a few columns the hospitals' do not, which are
 * stored beside the shared ones.
 *
 * A copy rather than the hospital functions with the table names passed in.
 * The hospital upload is the one in daily use, and threading a table name
 * through each of its statements would have meant rewriting all of them to add
 * a screen that has nothing to do with them.
 */
import { withTransaction } from '../db/pool.js';
import { matchGrnAgeingPair } from './reconcile.js';
import { bulkInsert, lastRowPerGrn } from './ingest.js';

/** Clear whatever a previous upload stored for the GRNs this one is about. */
async function clearBpadRecordsFor(client, rows) {
  const vendorCodeKeys = [];
  const grnNoKeys = [];

  for (const row of rows) {
    if (!row.vendorCodeKey || !row.grnNoKey) continue;
    vendorCodeKeys.push(row.vendorCodeKey);
    grnNoKeys.push(row.grnNoKey);
  }

  if (grnNoKeys.length === 0) return 0;

  const { rowCount } = await client.query(
    `DELETE FROM ph_bpad_records b
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
 * Pharmacy uploads one at a time -- see lockUploadTables in ingest.js. Its own
 * five tables, so a pharmacy upload and a hospital one never wait on each
 * other.
 */
async function lockUploadTables(client) {
  await client.query(
    `LOCK TABLE ph_grn_transactions, ph_vendor_ageing, ph_reconciliation_results,
                ph_bank_statement_transactions, ph_bpad_records
       IN SHARE ROW EXCLUSIVE MODE`,
  );
}

/**
 * Hand-typed cheque clearance dates on the ageing rows about to be replaced,
 * by GRN and cheque number, to be carried onto the rows that replace them.
 *
 * Nothing on the pharmacy side writes one yet. The column is there because the
 * table is the hospitals' over again, and it is carried here so that whatever
 * does come to write it is not undone by the next report naming the GRN.
 */
async function clearanceOverridesFor(client, keys) {
  if (keys.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT grn_number_key, cheque_no, cheque_clearance_override
       FROM ph_vendor_ageing
      WHERE grn_number_key = ANY($1)
        AND cheque_clearance_override IS NOT NULL
        AND COALESCE(cheque_no, '') <> ''
      ORDER BY batch_id, id`,
    [keys],
  );
  return new Map(rows.map((r) => [`${r.grn_number_key}|${r.cheque_no}`, r.cheque_clearance_override]));
}

/**
 * A text column folded the way normKey (services/normalize.js) folds a value:
 * capitals, and nothing but letters and digits. In SQL because the one place
 * it is used compares two columns inside a query -- see verdictsFor.
 */
function folded(column) {
  return `regexp_replace(upper(COALESCE(${column}, '')), '[^A-Z0-9]', '', 'g')`;
}

/**
 * Whether ageing row `a` and GRN row `g` are one configured branch's: the
 * row's DivisionCode its Branch code (Focus), and the GRN's Unit Name its Unit
 * name (HIS).
 *
 * The purchase register calls the branch "Secunderabad" and the ageing report
 * calls it "PSE", so the two cannot be held against each other directly; the
 * Ph-Configuration screen is where somebody has said they are the same place.
 * A pair nobody has said that about is not matched -- the GRN number alone is
 * not enough, because another division's document can carry the same number.
 *
 * Folded on both sides, so "pse" and "PSE " are one code and "SECUNDERABAD"
 * and "Secunderabad" one unit, as routes/phBatches.js compares the unit for
 * the BPAD status. A blank on the report's side matches nothing: a branch
 * whose code folded to nothing would otherwise claim every row without one.
 */
const SAME_BRANCH = `EXISTS (
  SELECT 1 FROM ph_branch_configs bc
   WHERE ${folded('a.division_code')} <> ''
     AND ${folded('g.location')} <> ''
     AND ${folded('bc.branch_code')} = ${folded('a.division_code')}
     AND ${folded('bc.location')} = ${folded('g.location')}
)`;

/**
 * Each GRN row's verdict against the ageing row it pairs with now.
 *
 * An ageing row is the GRN's when it carries the GRN's number AND belongs to
 * the GRN's branch (SAME_BRANCH above). A GRN with no such row is PENDING.
 *
 * Of the rows that qualify, the one paired is the one that carries the payable
 * amount, and the first of them where more than one does or none does. For a
 * GRN paid by several cheques that is the first row, as it is for the
 * hospitals: the later rows are the further cheques, and carry no amounts. It
 * differs for a bill accounts booked twice -- written off in full against a
 * purchase return and booked again under a corrected vendor, as
 * "PSE/26-27/HE00195" and "PSE/26-27/HE00195/A" are. The first of those rows
 * has nothing left payable and no cheque; the second is the bill as it was
 * paid, and it is the one a result should point at.
 *
 * `where` selects the GRN rows, as SQL over `g`, with `params` for it. Returns
 * the verdict for each, with the result it has now, if any, and whether the
 * verdict would change it.
 */
async function verdictsFor(client, where, params) {
  const { rows } = await client.query(
    `SELECT g.id AS grn_id, g.bill_no_key, g.bill_no, g.vendor_name_key,
            m.id AS ageing_id, m.bill_no_key AS ageing_bill_no_key,
            m.bill_no AS ageing_bill_no, m.vendor_name_key AS ageing_vendor_name_key,
            r.id AS result_id, r.matched_ageing_id, r.status AS current_status
       FROM ph_grn_transactions g
       LEFT JOIN LATERAL (
         SELECT a.id, a.bill_no_key, a.bill_no, a.vendor_name_key
           FROM ph_vendor_ageing a
          WHERE a.grn_number_key = g.dpr_no_key
            AND g.dpr_no_key <> ''
            AND ${SAME_BRANCH}
          ORDER BY a.batch_id DESC, (a.payable_amount IS NULL), a.source_row_no NULLS LAST, a.id
          LIMIT 1
       ) m ON TRUE
       LEFT JOIN ph_reconciliation_results r ON r.grn_transaction_id = g.id
      WHERE ${where}
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
      changed:
        row.result_id == null ||
        (row.matched_ageing_id ?? null) !== (row.ageing_id ?? null) ||
        row.current_status !== verdict.status,
      ...verdict,
    };
  });
}

/**
 * One result per GRN this upload touched, rebuilt from what is stored now: a
 * GRN row this upload stored, or a GRN already on file whose ageing rows this
 * upload replaced. Read back out of the tables rather than taken from the
 * parsed files, so the answer is the same whichever order the two reports
 * arrived in.
 */
async function linkResults(client, batchId, ageingKeys) {
  const verdicts = await verdictsFor(
    client,
    'g.batch_id = $1 OR g.dpr_no_key = ANY($2)',
    [batchId, ageingKeys],
  );
  if (verdicts.length === 0) return verdicts;

  await client.query('DELETE FROM ph_reconciliation_results WHERE grn_transaction_id = ANY($1)', [
    verdicts.map((v) => v.grnId),
  ]);
  await bulkInsert(client, 'ph_reconciliation_results', RESULT_COLUMNS, verdicts, (v) => [
    batchId, v.grnId, v.ageingId, v.status, v.billNoMatch, v.vendorNameMatch, v.discrepancyNotes,
  ]);
  return verdicts;
}

/**
 * Bring every stored result in line with Ph-Configuration as it stands now.
 * Expects `client` to be inside a transaction.
 *
 * Which ageing row is a GRN's depends on the configured branches (SAME_BRANCH
 * above), and a result is worked out when an upload touches its GRN -- so a
 * branch added, corrected or removed afterwards would leave the stored results
 * answering for a configuration that is no longer there. This is run in the
 * same transaction that changes a branch (routes/phConfig.js), so the two
 * cannot disagree: a GRN left pending because its unit was not configured is
 * matched the moment it is, with nothing uploaded again.
 *
 * Only what the ageing report can answer. A BPAD row is matched while the
 * status is being read, and the rows that do not match are not kept, so the
 * BPAD side follows a changed branch only when the status is uploaded again.
 *
 * Only the results whose ageing row or verdict actually changes are written,
 * and each stays filed under the upload it was. Takes the upload's lock, so it
 * waits for an upload in flight rather than relinking half of one.
 *
 * @returns {Promise<{changed: number, linked: object}>} how many results
 *   changed, and how every GRN on file stands afterwards
 */
export async function relinkPhResults(client) {
  await lockUploadTables(client);

  const verdicts = await verdictsFor(client, 'TRUE', []);
  const linked = { MATCHED: 0, MATCHED_WITH_DIFF: 0, PENDING: 0 };
  for (const v of verdicts) linked[v.status] += 1;

  const changed = verdicts.filter((v) => v.changed && v.resultId != null);
  if (changed.length > 0) {
    // Six arrays, one parameter each, paired back up by position -- so the
    // number of results changed is not bounded by Postgres' parameter cap.
    await client.query(
      `UPDATE ph_reconciliation_results r
          SET matched_ageing_id = u.ageing_id,
              status            = u.status,
              bill_no_match     = u.bill_no_match,
              vendor_name_match = u.vendor_name_match,
              discrepancy_notes = u.discrepancy_notes
         FROM unnest($1::int[], $2::int[], $3::text[], $4::boolean[], $5::boolean[], $6::text[])
                AS u(id, ageing_id, status, bill_no_match, vendor_name_match, discrepancy_notes)
        WHERE r.id = u.id`,
      [
        changed.map((v) => v.resultId),
        changed.map((v) => v.ageingId),
        changed.map((v) => v.status),
        changed.map((v) => v.billNoMatch),
        changed.map((v) => v.vendorNameMatch),
        changed.map((v) => v.discrepancyNotes),
      ],
    );
  }

  return { changed: changed.length, linked };
}

/** A bank transaction the new statement carries, stored by an earlier upload. */
async function clearEarlierBankRows(client, batchId, accountNo) {
  const { rowCount } = await client.query(
    `DELETE FROM ph_bank_statement_transactions o
      USING ph_bank_statement_transactions n, ph_upload_batches ob
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

// Each list must stay the same length and order as its value tuple in
// storePhBatch below -- bulkInsert checks the length, not the order.
//
// The purchase register's columns only. sl_no, warehouse, po_no, dc_no and the
// bill, transport and add/deduct amounts are the hospital report's, and are
// left to their NULL.
const GRN_COLUMNS = [
  'batch_id', 'source_row_no', 'dpr_no', 'dpr_no_key', 'dpr_date', 'bill_date', 'bill_no',
  'bill_no_key', 'vendor_code', 'vendor_name', 'vendor_name_key', 'total_amount', 'location',
  'purchase_type', 'focus_code', 'gstin', 'tot_taxable', 'cgst', 'sgst', 'igst', 'tcs_amt',
];

const AGEING_COLUMNS = [
  'batch_id', 'source_row_no', 'division', 'division_code', 'store_name', 'vendor_name',
  'vendor_name_key', 'vendor_code', 'grn_doc', 'grn_no', 'branch_code', 'grn_number',
  'grn_number_key', 'bill_no', 'bill_no_key', 'bill_date', 'net_amt', 'adj_pur_return',
  'adjusted_jv', 'tds_jv', 'payable_amount',
  'indent_date', 'po_date', 'security_date', 'grn_date', 'bill_to_audit',
  'bill_handover_to_acc', 'chq_date', 'cheque_clearance_date',
  'payment_doc_no', 'cheque_no', 'balance',
  'cheque_clearance_override',
  'payment_amt', 'advance_payment_amt',
];

const BANK_COLUMNS = [
  'batch_id', 'source_row_no', 'txn_date', 'narration', 'chq_ref_no',
  'extracted_cheque_no', 'value_date', 'withdrawal_amt', 'deposit_amt', 'closing_balance',
];

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
 * Store one upload on `client`, which is expected to be inside a transaction.
 *
 * Split from savePhBatch so the whole of it can be run and rolled back -- by a
 * check that the reports store and reconcile as they should, on a database
 * that is then left exactly as it was.
 *
 * Takes what saveBatch in ingest.js takes. Returns the new batch id, how many
 * stored rows the upload replaced per file, and `linked`: how many GRNs it
 * touched came out at each verdict, counted from the results as stored -- so
 * it covers a GRN uploaded earlier that this upload's ageing report has only
 * now found, which a count taken from the files alone would miss.
 */
export async function storePhBatch(
  client,
  {
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
  },
) {
  const { rows: batchRows } = await client.query(
    `INSERT INTO ph_upload_batches
       (name, grn_file_name, ageing_file_name, grn_row_count, ageing_row_count, uploaded_by,
        bank_file_name, bank_row_count, bank_account_no,
        bpad_file_name, bpad_row_count, bpad_matched_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      name, grnFileName, ageingFileName, grnRows.length, ageingRows.length, userId,
      bankFileName, bankRows.length, bankAccountNo,
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
    ? await client.query('DELETE FROM ph_grn_transactions WHERE dpr_no_key = ANY($1)', [grnKeys])
    : { rowCount: 0 };

  await bulkInsert(client, 'ph_grn_transactions', GRN_COLUMNS, grnToStore, (r) => [
    batchId, r.sourceRowNo, r.dprNo, r.dprNoKey, r.dprDate, r.billDate, r.billNo,
    r.billNoKey, r.vendorCode, r.vendorName, r.vendorNameKey, r.totalAmount, r.location,
    r.purchaseType, r.focusCode, r.gstin, r.totTaxable, r.cgst, r.sgst, r.igst, r.tcsAmt,
  ]);

  // Ageing rows: the same, a whole GRN at a time -- its rows in the report are
  // its current payment picture, and all of the older ones go.
  const ageingKeys = [...new Set(ageingRows.map((r) => r.grnNumberKey).filter(Boolean))];
  const overrides = await clearanceOverridesFor(client, ageingKeys);
  const { rowCount: replacedAgeingRows } = ageingKeys.length > 0
    ? await client.query('DELETE FROM ph_vendor_ageing WHERE grn_number_key = ANY($1)', [ageingKeys])
    : { rowCount: 0 };

  await bulkInsert(client, 'ph_vendor_ageing', AGEING_COLUMNS, ageingRows, (r) => [
    batchId, r.sourceRowNo, r.division, r.divisionCode, r.storeName, r.vendorName,
    r.vendorNameKey, r.vendorCode, r.grnDoc, r.grnNo, r.branchCode, r.grnNumber,
    r.grnNumberKey, r.billNo, r.billNoKey, r.billDate, r.netAmt, r.adjPurReturn,
    r.adjustedJv, r.tdsJv, r.payableAmount,
    r.indentDate, r.poDate, r.securityDate, r.grnDate, r.billToAudit,
    r.billHandOverToAcc, r.chqDate, r.chequeClearanceDate,
    r.paymentDocNo, r.chequeNo, r.balance,
    (r.grnNumberKey && r.chequeNo && overrides.get(`${r.grnNumberKey}|${r.chequeNo}`)) || null,
    r.paymentAmt, r.advancePaymentAmt,
  ]);

  // Then one result for every GRN either report touched.
  const verdicts = await linkResults(client, batchId, ageingKeys);
  const linked = { MATCHED: 0, MATCHED_WITH_DIFF: 0, PENDING: 0 };
  for (const v of verdicts) linked[v.status] += 1;

  // The statement, stored as it was read. In first, so the earlier copies of
  // its transactions can be found by joining to it.
  let replacedBankRows = 0;
  if (bankRows.length > 0) {
    await bulkInsert(client, 'ph_bank_statement_transactions', BANK_COLUMNS, bankRows, (r) => [
      batchId, r.sourceRowNo, r.txnDate, r.narration, r.chqRefNo,
      r.extractedChequeNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance,
    ]);
    replacedBankRows = await clearEarlierBankRows(client, batchId, bankAccountNo);
  }

  // The BPAD rows, already one per GRN in scope -- see routes/phBatches.js. A
  // re-uploaded status is a newer answer about the same bills, so the older
  // answer about those bills goes first.
  let replacedBpadRows = 0;
  if (bpadRows.length > 0) {
    replacedBpadRows = await clearBpadRecordsFor(client, bpadRows);
    await bulkInsert(client, 'ph_bpad_records', BPAD_COLUMNS, bpadRows, (r) => [
      batchId, r.sourceRowNo, r.slNo, r.location, r.warehouse,
      r.vendorCode, r.vendorCodeKey, r.vendorName,
      r.invNo, r.invDate, r.grnNo, r.grnNoKey, r.grnDate, r.grnAmount,
      r.poNumber, r.poDate, r.pendingWithDept,
      r.bpadReceivedDate, r.accountsReceivedDate,
      r.pendingWithUser, r.pendReason,
      r.inRegister ?? true,
    ]);
  }

  return {
    batchId,
    linked,
    replaced: {
      grnRows: replacedGrnRows,
      ageingRows: replacedAgeingRows,
      bankRows: replacedBankRows,
      bpadRows: replacedBpadRows,
    },
  };
}

/** Store one upload in a transaction of its own: all of it, or none. */
export function savePhBatch(batch) {
  return withTransaction((client) => storePhBatch(client, batch));
}
