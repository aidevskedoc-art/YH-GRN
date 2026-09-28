/**
 * The Accounts table's Ageing: days from the bill being handed to Accounts
 * (BillHandOverToAcc) to the cheque being cut (ChqDate).
 *
 * A bill with no cheque yet counts to a date the reader picks instead -- the
 * "Ageing as of" date in the Accounts toolbar, today until it is changed -- so
 * the figure can be read as of any day, a month end say, rather than only as
 * of the moment the page loaded.
 *
 * Worked out here, in the browser, rather than on the server, because that date
 * is the reader's: changing it redraws the column at once, and the table and
 * the Excel export read the same rule from the one place (exporter.js).
 */

/** Today as the yyyy-MM-dd a date input holds -- the browser's own day. */
export function todayIso() {
  return new Date().toLocaleDateString('en-CA');
}

/** A yyyy-MM-dd date as a whole day count, for subtracting one from another. */
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

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
  const from = row?.billHandoverToAcc;
  const to = row?.chqDate || asOf;
  if (!from || !to) return null;
  const days = Math.round(dayNumber(to) - dayNumber(from));
  return Number.isFinite(days) ? days : null;
}
