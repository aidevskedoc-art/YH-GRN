/**
 * Stage-by-stage cycle time: how many days a bill spends at each step.
 *
 * A bill passes through seven dated checkpoints, so there are six gaps between
 * them. Every date comes from the Vendor Ageing report; the GRN report has no
 * counterpart for any of them, which is why a GRN that has not reached accounts
 * yet has no turnaround at all.
 *
 * The ageing report ships its own pre-computed gap columns (IndentToPO,
 * POToSeurity [sic], ...) and this module deliberately ignores them. Measured
 * across all 3,200 April rows they are the ABSOLUTE value of the gap, with zero
 * written as blank -- so a SecurityDate that falls before its PO is reported as
 * a positive number, and 573 out-of-order rows read as normal ones. Computing
 * from the dates keeps the sign, and the sign is the interesting part.
 */
import { daysBetween } from './normalize.js';

/**
 * The gaps, in process order. `from`/`to` name fields on a parsed ageing row.
 *
 * No display names here: what a stage is called is the client's business (see
 * client/src/services/stages.js), and it is keyed by `key`. This module owns the
 * order, the two dates each stage measures between, and the arithmetic.
 *
 * The first six run on the ageing report's own hand-entered checkpoints. The
 * rest cover the CSD handover and what Accounts does with it afterwards,
 * whose dates are all stamps this application wrote when someone pressed a
 * button -- Send to CSD, then the status dropdown, then Received / Send to
 * Bank / Send to Vendor / Others on the Accounts side.
 *
 * chequeToCsd is the join between the two: it is the only CSD stage with one
 * foot in the ageing report, measuring from the cheque to the day the GRN was
 * handed on. The rest are stamp-to-stamp.
 *
 * `csd: true` marks every stamp-to-stamp stage. Their end cannot carry a typo
 * -- there is no source to correct it in -- so dataQuality below leaves them
 * out of its checks.
 */
export const STAGES = [
  { key: 'prToPo', from: 'indentDate', to: 'poDate' },
  { key: 'poToSecurity', from: 'poDate', to: 'securityDate' },
  { key: 'securityToGrn', from: 'securityDate', to: 'grnDate' },
  { key: 'grnToAudit', from: 'grnDate', to: 'billToAudit' },
  { key: 'auditToAccounts', from: 'billToAudit', to: 'billHandOverToAcc' },
  { key: 'accountsToCheque', from: 'billHandOverToAcc', to: 'chqDate' },
  { key: 'chequeToCsd', from: 'chqDate', to: 'sentToCsd', csd: true },
  { key: 'csdToReceived', from: 'sentToCsd', to: 'csdReceived', csd: true },
  { key: 'receivedToApproved', from: 'csdReceived', to: 'csdApproved', csd: true },
  // CSD's approval to the day it was handed back to Accounts.
  { key: 'approvedToMovedToAccounts', from: 'csdApproved', to: 'movedToAccountsAt', csd: true },
  // The queue wait: handed back to Accounts, to Accounts acknowledging it.
  { key: 'movedToAccountsToReceived', from: 'movedToAccountsAt', to: 'accountsReceivedAt', csd: true },
  // Accounts' acknowledgement to whichever of Bank / Vendor / Others it was
  // sent on to -- the last stamp this application writes on a GRN.
  { key: 'receivedToForwarded', from: 'accountsReceivedAt', to: 'forwardedAt', csd: true },
  // The last leg, and the one that closes the loop: from CSD's approval to the
  // day the bank actually parted with the money.
  //
  // Measured from csdApproved rather than from the cheque date, so it answers
  // "once CSD cleared it, how long until the vendor was really paid" rather
  // than how long the cheque sat in the banking system. That makes it the only
  // stage spanning both records -- CSD's own stamp at one end, the bank
  // statement at the other. It runs alongside the Accounts hand-back rather
  // than after it -- the bank can clear a cheque before or after Accounts
  // finishes with the paperwork -- so it still measures from csdApproved
  // rather than from forwardedAt.
  //
  // Null unless BOTH ends exist: a GRN CSD have not approved has no start, and
  // one whose cheque bounced or is in no statement has no end. A returned
  // cheque never cleared, so there is nothing to measure.
  { key: 'approvedToClearance', from: 'csdApproved', to: 'chequeClearanceDate', derived: true },
];

/**
 * The stages whose dates come off the source report, and so are the only ones
 * worth checking for transcription mistakes. The CSD stamps are written by this
 * application and the clearance date is read off the bank statement; neither
 * can be corrected at source, because neither has one.
 */
const SOURCE_STAGES = STAGES.filter((stage) => !stage.csd && !stage.derived);

/**
 * The whole run, first checkpoint to last.
 *
 * Still PR to Cheque, not PR to Approved: this is the payment cycle, and it is
 * complete when the vendor is paid. The CSD handover is what happens to the
 * paperwork afterwards, and stretching the headline figure over it would move a
 * number people already read against a target.
 */
export const END_TO_END = { key: 'prToCheque', from: 'indentDate', to: 'chqDate' };

/**
 * The seven source checkpoints, for the era check.
 *
 * The three CSD stamps are deliberately absent. They are recorded when the
 * button is pressed -- always now -- so on a report run over an older month
 * they would sit years outside the batch's era and every sent row would be
 * flagged as a mistyped date.
 */
export const STAGE_DATES = [
  'indentDate', 'poDate', 'securityDate', 'grnDate', 'billToAudit', 'billHandOverToAcc', 'chqDate',
];

/** The four CSD checkpoints, for the per-row table. */
export const CSD_DATES = ['sentToCsd', 'csdReceived', 'csdApproved', 'csdRejected'];

/**
 * Day count for every stage of one row: `{ prToPo: 1, poToSecurity: -9, ... }`.
 * Includes the three CSD stages, which are null until the GRN has been sent.
 * A stage whose start or end date is missing is null, not zero -- "we do not
 * know" and "it took no time" are different answers.
 */
export function gapsFor(row) {
  const gaps = {};
  for (const stage of STAGES) gaps[stage.key] = daysBetween(row[stage.from], row[stage.to]);
  return gaps;
}

/**
 * Nearest-rank percentile over a sorted array. Deterministic and always an
 * actual observed value, so a median of day counts stays a whole number of days
 * rather than landing on x.5 between two rows.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Descriptive statistics for one stage across many rows.
 *
 * Median leads, not average. Two April rows carry a typo'd year (2006 for 2026)
 * which produces a 7,300-day gap, and that single row drags the Security-to-GRN
 * average from 1 day to 10.5. The median does not move. Average and p90 are
 * still reported, beside it, so the spread stays visible.
 */
function describe(values, total) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    missing: total - values.length,
    backwards: values.filter((v) => v < 0).length,
    median: percentile(sorted, 0.5),
    average: values.length ? Number((values.reduce((a, c) => a + c, 0) / values.length).toFixed(1)) : null,
    p90: percentile(sorted, 0.9),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

/**
 * Summarise a set of ageing rows into per-stage statistics plus the end-to-end
 * figure.
 *
 * @param {Array} rows parsed ageing rows (or DB rows with the same field names)
 * @returns {{stages: Array, overall: object}}
 */
export function summarise(rows) {
  const total = rows.length;

  const stages = STAGES.map((stage) => ({
    key: stage.key,
    ...describe(
      rows.map((r) => daysBetween(r[stage.from], r[stage.to])).filter((v) => v !== null),
      total,
    ),
  }));

  const endToEnd = rows
    .map((r) => daysBetween(r[END_TO_END.from], r[END_TO_END.to]))
    .filter((v) => v !== null);

  return {
    stages,
    overall: { key: END_TO_END.key, rows: total, ...describe(endToEnd, total) },
  };
}

const year = (iso) => (iso ? Number(String(iso).slice(0, 4)) : null);

/**
 * Rows worth correcting at source: a date so far outside the reporting era that
 * it can only be a mistyped year, or a stage that runs backwards.
 *
 * The era is derived from the data rather than hardcoded, so this keeps working
 * for any month: GRN_Date is present on every row, so its median year is the
 * year the batch belongs to. April 2026 has two rows carrying "09-04-2006" and
 * "07-04-2006" -- a slipped 2 -- which produce 7,300-day gaps.
 *
 * A row is reported once, under the worse of the two problems: an impossible
 * date is the cause of the backwards stage it produces, so listing it twice
 * would double-count the same mistake.
 */
export function dataQuality(rows, { tolerance = 2 } = {}) {
  const years = rows.map((r) => year(r.grnDate)).filter((y) => y !== null).sort((a, b) => a - b);
  const era = percentile(years, 0.5);

  const impossible = [];
  const backwards = [];

  for (const row of rows) {
    const outOfEra =
      era !== null &&
      STAGE_DATES.some((f) => {
        const y = year(row[f]);
        return y !== null && Math.abs(y - era) > tolerance;
      });

    // Source stages only. A cheque dated after the day someone pressed Send to
    // CSD makes chequeToCsd negative, and that is an ordinary thing rather than
    // a mistake to go and correct -- the CSD stamps are recorded by this
    // application, not transcribed from a report, so there is no source to fix.
    const runsBackwards = SOURCE_STAGES.some((stage) => {
      const days = daysBetween(row[stage.from], row[stage.to]);
      return days !== null && days < 0;
    });

    if (outOfEra) impossible.push(row);
    else if (runsBackwards) backwards.push(row);
  }

  return { era, impossible, backwards };
}
