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
 * bulk-select checkbox, neither of which will hand a bill to CSD without one,
 * and the Excel export's own column -- and three copies of a rule like this
 * drift.
 *
 * It gates CSD only. Filing to Records asks nothing about a cheque: the bill
 * reached accounts and accounts are done with it, which is the whole of what
 * going on file means.
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

/**
 * Whether a bill with no cheque needs none: its PayableAmount is zero or under
 * a rupee (or has no figure at all), so there is nothing left to pay. Word for
 * word the rule PAYMENT_NOT_REQUIRED counts by in routes/results.js -- which is
 * also why a bill that does have a cheque is never this, whatever its payable
 * says.
 *
 * Null where chequePrepared is null, for the same reason.
 *
 * @returns {boolean|null}
 */
export function paymentNotRequired(row) {
  const prepared = chequePrepared(row);
  if (prepared === null) return null;
  if (prepared) return false;
  return row.payableAmount == null || Number(row.payableAmount) < 1;
}
