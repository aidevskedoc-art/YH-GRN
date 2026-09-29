/**
 * The day counts that run to a date the reader picks -- the "as of" date in the
 * results toolbar, today until it is changed -- so a figure can be read as of
 * any day, a month end say, rather than only as of the moment the page loaded:
 *
 *  - ageingDays: the Accounts table's Ageing, from the bill being handed to
 *    Accounts (BillHandOverToAcc) to the cheque being cut (ChqDate), or to the
 *    "as of" date while there is no cheque.
 *  - bpadAgeDays: the BPAD tab's Age from GRN Date, from the GRN date to the
 *    date the bill reached the desk it is pending with -- or, at Stores, where
 *    it has reached no desk, to the "as of" date.
 *
 * Worked out here, in the browser, rather than on the server, because that date
 * is the reader's: changing it redraws the column at once, and the table and
 * the Excel export read the same rule from the one place (exporter.js).
 */

/** Today as the yyyy-MM-dd a date input holds -- the browser's own day. */
export function todayIso() {
  return new Date().toLocaleDateString('en-CA');
}

/** The 1st of the current month, as the yyyy-MM-dd a date input holds. */
export function monthStartIso() {
  return `${todayIso().slice(0, 7)}-01`;
}

/** A yyyy-MM-dd date as a whole day count, for subtracting one from another. */
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Whole days from one yyyy-MM-dd date to another, or null when either is missing. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const days = Math.round(dayNumber(to) - dayNumber(from));
  return Number.isFinite(days) ? days : null;
}

/**
 * The row's Ageing in days, or null with no BillHandOverToAcc to count from.
 *
 * Negative where the date counted to is before the handover: a cheque cut
 * before the bill reached Accounts -- an advance, which is what 40 of the 42
 * such bills in September are (PaymentDocNo ADVP:...) -- or an "as of" date
 * before the handover. Shown as it is; the table says which underneath.
 *
 * `asOf` is the date a bill with no ChqDate counts to.
 */
export function ageingDays(row, asOf) {
  return daysBetween(row?.billHandoverToAcc, row?.chqDate || asOf);
}

/** The BPAD register's desk a row is pending with, as the rule below matches it. */
export function bpadDesk(row) {
  return String(row?.pendingWithDept ?? '').trim().toUpperCase();
}

/**
 * The BPAD row's Age from GRN Date in days, or null where a date on either end
 * is missing -- a GRN the register has no entry for among them. Counted from
 * GRN Date to:
 *
 *  - ACCOUNTS: Accounts Received Date
 *  - STORES:   `asOf` -- the bill has not left the stores, so it has no
 *              received date anywhere and is still ageing
 *  - any other desk (AUDIT, PURCHASE DEPARTMENT, ...): BPAD Received Date
 *
 * The same desks as BPAD_AGEING_SQL in routes/results.js, which still answers
 * the API's `ageing` as of today; keep the two in step.
 */
export function bpadAgeDays(row, asOf) {
  const desk = bpadDesk(row);
  const to =
    desk === 'ACCOUNTS' ? row?.accountsReceivedDate : desk === 'STORES' ? asOf : row?.bpadReceivedDate;
  return daysBetween(row?.grnDate, to);
}
