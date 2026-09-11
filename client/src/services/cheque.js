/**
 * Whether a cheque has been drawn up for a GRN's bill yet.
 *
 * Nothing in this system prepares a cheque, so there is no stage to read. The
 * answer is the three columns the ageing report fills in when one has been --
 * the cheque number, the date it was cut, and the payment document reference
 * -- and any one of them filled counts, because the report does not fill all
 * three at the same moment. A bill carrying a payment document and no cheque
 * number yet has plainly had a cheque prepared.
 *
 * Word for word the rule CHEQUE_PREPARED counts by in routes/results.js. Kept
 * here in one place because three callers ask it -- the Send picker and the
 * bulk-select checkbox, which will not hand a bill to CSD without one, and the
 * Excel export's own column -- and three copies of a rule like this drift.
 *
 * Three answers, not two. `null` is a row the question cannot be asked of: it
 * has no ageing entry, so there are no cheque columns to read, and calling
 * that "not prepared" would be an answer about a report the row does not
 * appear in. A row has an ageing entry exactly when it is not PENDING.
 *
 * @returns {boolean|null}
 */
export function chequePrepared(row) {
  if (row.status === 'PENDING') return null;
  return Boolean(row.chequeNo || row.chqDate || row.paymentDocNo);
}
