/**
 * What each turnaround stage is called on screen and in the exports.
 *
 * The server owns the stages themselves -- their order, which two dates each
 * one measures between, and the arithmetic -- and sends them back keyed by
 * `key`. What they are *called* is a display decision, so it lives here, on the
 * side that displays them. The Excel and CSV exports are built in the browser
 * and need the same wording, so both read this one map.
 *
 * Keyed rather than ordered on purpose: the table renders in the order the
 * server sends, so a positional list would silently mislabel every column the
 * day a stage is added or reordered.
 */
export const STAGE_LABELS = {
  prToPo: 'PR to PO',
  poToSecurity: 'PO to Security',
  securityToGrn: 'Security to GRN',
  grnToAudit: 'GRN to Audit',
  auditToAccounts: 'Audit to Acc',
  accountsToCheque: 'Acc to Cheque',
  // The CSD handover. The first joins the ageing report's chain to it.
  chequeToCsd: 'CSD Queue',
  csdToReceived: 'CSD Received',
  receivedToApproved: 'CSD Approved',
  // Accounts' side of the hand-back, once CSD approves and returns a GRN.
  approvedToMovedToAccounts: 'Moved To Accounts',
  movedToAccountsToReceived: 'Accounts Received',
  receivedToForwarded: 'Cheque Forwarded',
  // CSD's approval to the day the bank actually paid, off the statement.
  approvedToClearance: 'Cheque Clearance',
  // The end-to-end figure, measured PR to Cheque.
  prToCheque: 'PR to Cheque',
};

/** The stage's name, falling back to its key so a new stage is never blank. */
export function stageLabel(key) {
  return STAGE_LABELS[key] ?? key;
}

/**
 * The gaps, in process order -- the export's day-count columns.
 *
 * Kept in step by hand with STAGES in server/src/services/turnaround.js, which
 * owns the order and the arithmetic. The table reads the order the server
 * sends; only the export needs this list.
 */
export const STAGE_KEYS = [
  'prToPo',
  'poToSecurity',
  'securityToGrn',
  'grnToAudit',
  'auditToAccounts',
  'accountsToCheque',
  'chequeToCsd',
  'csdToReceived',
  'receivedToApproved',
  'approvedToMovedToAccounts',
  'movedToAccountsToReceived',
  'receivedToForwarded',
  'approvedToClearance',
];

/**
 * The run's checkpoints, latest first, for the row total.
 *
 * The total is measured end to end -- PR to the furthest point this GRN has
 * actually reached -- rather than summed from the stage columns, because a row
 * missing an intermediate date has null stages either side of the gap and
 * adding those as zero would understate it.
 *
 * Which checkpoint is "furthest" is per row: a GRN still awaiting its cheque
 * ends at Accounts, one just handed over ends at Sent to CSD, one CSD have
 * ruled on ends at the verdict. Taking the first of these the row carries walks
 * back from the end of the chain to wherever it has got to.
 *
 * csdRejected is here although no day column measures it: the total is the
 * GRN's whole elapsed time, and for a rejected bill that run ended when CSD
 * sent it back.
 *
 * forwardedAt, accountsReceivedAt and movedToAccountsAt sit ahead of the CSD
 * verdicts: a GRN CSD approved and handed back has gone further than one
 * merely approved, so a row carrying any of the three counts to whichever is
 * its own furthest point rather than stopping at csdApproved.
 *
 * Lives here rather than in the table because the export shows the same Total
 * column and must arrive at the same number.
 */
export const CHAIN_END = [
  'forwardedAt',
  'accountsReceivedAt',
  'movedToAccountsAt',
  'csdRejected',
  'csdApproved',
  'csdReceived',
  'sentToCsd',
  'chequeClearanceDate',
  'chqDate',
  'billHandOverToAcc',
  'billToAudit',
  'grnDate',
  'securityDate',
  'poDate',
];

/** Whole days between two yyyy-MM-dd strings; the mirror of the server's daysBetween. */
export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

/** PR to the furthest checkpoint this row has reached, in whole days. */
export function totalDays(row) {
  const end = CHAIN_END.find((key) => row[key]);
  return end ? daysBetween(row.indentDate, row[end]) : null;
}

/**
 * The checkpoints a GRN passes, in process order -- the "Reached" columns, and
 * the two ends anyone can measure a span between.
 *
 * Lives here rather than in the table because three screens now read the same
 * list: the table draws a date column per entry, the span picker offers each
 * one as a From and a To, and the export names its columns from it. A second
 * copy anywhere would let the file and the screen drift apart on the wording.
 *
 * `editable: true` marks the seven stamps the turnaround table can correct in
 * place: the three CSD ones plus the three Accounts hand-back ones further
 * down. All seven are written automatically, by a button rather than typed in
 * -- so what is being fixed is never a typo, only a date entered a day late.
 */
export const CHECKPOINTS = [
  { key: 'indentDate', label: 'PR' },
  { key: 'poDate', label: 'PO' },
  { key: 'securityDate', label: 'Security' },
  { key: 'grnDate', label: 'GRN' },
  { key: 'billToAudit', label: 'Audit' },
  { key: 'billHandOverToAcc', label: 'Accounts' },
  { key: 'chqDate', label: 'Cheque' },
  { key: 'sentToCsd', editable: true, label: 'Sent to CSD' },
  { key: 'csdReceived', editable: true, label: 'CSD Received' },
  { key: 'csdApproved', editable: true, label: 'CSD Approved' },
  // Accounts' side of the hand-back.
  { key: 'movedToAccountsAt', editable: true, label: 'Moved To Accounts' },
  { key: 'accountsReceivedAt', editable: true, label: 'Accounts Received' },
  { key: 'forwardedAt', editable: true, label: 'Cheque Forwarded' },
  // Last. Its value is read off the bank statement by matching the cheque
  // number; correcting it here does not touch the statement, it records an
  // override that wins over it -- and clearing the cell hands the answer back
  // to the bank.
  { key: 'chequeClearanceDate', label: 'Cheque Clearance' },
];

const CHECKPOINT_LABELS = Object.fromEntries(CHECKPOINTS.map((c) => [c.key, c.label]));

/** A checkpoint's name, falling back to its key so a new one is never blank. */
export function checkpointLabel(key) {
  return CHECKPOINT_LABELS[key] ?? key;
}

/**
 * A span: one pair of checkpoints, `{ from, to }`, measured on demand.
 *
 * The eleven stages the server sends are the process as it is meant to run --
 * each step to the next one. A span is the question asked of it afterwards:
 * "how long from the PR to the cheque clearing", which crosses six of those
 * steps and is no stage at all. So spans are not a server concept; both dates
 * are already on every row, and the arithmetic is the same daysBetween the
 * stages use, which is why the picker can offer any pair without a round trip.
 */

/** A span's identity, for React keys and for the export's column keys. */
export function spanId(span) {
  return `${span.from}>${span.to}`;
}

/** "PR - PO": how a span heads its own column. */
export function spanLabel(span) {
  return `${checkpointLabel(span.from)} - ${checkpointLabel(span.to)}`;
}

/** One row's day count for one span; null unless the row carries both ends. */
export function spanDays(row, span) {
  return daysBetween(row[span.from], row[span.to]);
}
