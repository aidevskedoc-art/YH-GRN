/**
 * Persists a parsed + reconciled upload as one batch.
 *
 * Everything happens inside a single transaction: a batch is either fully
 * stored with its reconciliation results, or not stored at all.
 */
import { withTransaction } from '../db/pool.js';

/** Rows per multi-row INSERT. Keeps well under Postgres' 65535 parameter cap. */
const CHUNK_SIZE = 500;

/**
 * Insert `rows` into `table`, `CHUNK_SIZE` at a time, returning the new ids in
 * input order.
 */
async function bulkInsert(client, table, columns, rows, toValues) {
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
 * @returns {Promise<number>} the new batch id
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
}) {
  return withTransaction(async (client) => {
    const { rows: batchRows } = await client.query(
      `INSERT INTO upload_batches
         (name, grn_file_name, ageing_file_name, grn_row_count, ageing_row_count, uploaded_by,
          bank_file_name, bank_row_count, bank_account_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        name, grnFileName, ageingFileName, grnRows.length, ageingRows.length, userId,
        bankFileName, bankRows.length, bankAccountNo,
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

    await bulkInsert(client, 'reconciliation_results', RESULT_COLUMNS, results, (r, index) => [
      batchId,
      grnIds[index],
      r.ageing ? ageingIdBySourceRow.get(r.ageing.sourceRowNo) ?? null : null,
      r.status,
      r.billNoMatch,
      r.vendorNameMatch,
      r.discrepancyNotes,
    ]);

    // Optional, and reconciled against nothing: the statement is stored as it
    // was read, for matching later by extracted_cheque_no.
    if (bankRows.length > 0) {
      await bulkInsert(client, 'bank_statement_transactions', BANK_COLUMNS, bankRows, (r) => [
        batchId, r.sourceRowNo, r.txnDate, r.narration, r.chqRefNo,
        r.extractedChequeNo, r.valueDate, r.withdrawalAmt, r.depositAmt, r.closingBalance,
      ]);
    }

    return batchId;
  });
}
