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
  // The two that stand in for CSD's own once the CSD steps are switched off
  // (see chainFor below), under the names of the columns they replace: sent
  // to CSD to Accounts having it back, and from there to the bank paying.
  sentToAccountsReceived: 'Accounts Received',
  accountsReceivedToClearance: 'Cheque Clearance',
  // The end-to-end figure, measured PR to Cheque.
  prToCheque: 'PR to Cheque',
  // ...and the OP Pharmacies', whose run starts at the GRN.
  grnToCheque: 'GRN to Cheque',
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

/**
 * The run's first checkpoint to the furthest one this row has reached, in whole
 * days.
 *
 * `from` is where the run starts: the PR unless said, the GRN for a pharmacy
 * purchase (see PHARMACY_CHAIN below). The start is never its own end -- a row
 * that has got no further than where it began has no run to measure, which is
 * blank rather than nought days.
 *
 * `ends` is the checkpoints the run can end at, latest first: CHAIN_END unless
 * said, a chain's own `end` where it has left some out (chainFor below).
 */
export function totalDays(row, from = 'indentDate', ends = CHAIN_END) {
  const end = ends.find((key) => key !== from && row[key]);
  return end ? daysBetween(row[from], row[end]) : null;
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
 * A chain: the checkpoints a report draws, the stages its export counts, the
 * checkpoint its row total is measured from, and the ones it can be measured
 * to (`end`, latest first -- see CHAIN_END).
 *
 * The hospitals' is the lists above, whole, and it is what the table, the span
 * picker and the export read unless they are handed another.
 */
export const HOSPITAL_CHAIN = {
  checkpoints: CHECKPOINTS,
  stageKeys: STAGE_KEYS,
  start: 'indentDate',
  end: CHAIN_END,
};

/** What a pharmacy purchase has no date for: the three checkpoints ahead of the GRN, and the stages to them. */
const BEFORE_GRN = new Set(['indentDate', 'poDate', 'securityDate', 'prToPo', 'poToSecurity', 'securityToGrn']);

/**
 * The OP Pharmacies' chain: the hospitals' from the GRN onward -- PHARMACY_CHAIN
 * in server/src/services/turnaround.js, which leaves out the same three stages.
 * Filtered out of the lists above rather than written again, so a checkpoint
 * keeps one name and one place on both reports.
 */
export const PHARMACY_CHAIN = {
  checkpoints: CHECKPOINTS.filter((c) => !BEFORE_GRN.has(c.key)),
  stageKeys: STAGE_KEYS.filter((key) => !BEFORE_GRN.has(key)),
  start: 'grnDate',
  end: CHAIN_END,
};

/**
 * A chain with the CSD steps switched off -- withoutCsdSteps in the server's
 * services/turnaround.js, which owns what is measured and is kept in step with
 * this by hand.
 *
 * Without CSD's own three checkpoints (Received, Approved, Moved To Accounts)
 * and the three stages only they could measure; and with the two stages either
 * side re-anchored on the one stamp left between sending a GRN to CSD and
 * sending it on -- Accounts receiving it. Each stands where the stage it
 * replaces stood, so the columns keep their order.
 *
 * `end` loses the same three: the row total is measured to the furthest
 * checkpoint a row has reached, and one the table no longer shows would leave
 * a total no pair of dates on screen accounts for. A GRN that did go through
 * CSD before the switch was thrown still has those dates; this chain does not
 * draw them or count to them.
 */
const CSD_OWN_CHECKPOINTS = new Set(['csdReceived', 'csdApproved', 'movedToAccountsAt']);
const CSD_OWN_STAGES = new Set(['receivedToApproved', 'approvedToMovedToAccounts', 'movedToAccountsToReceived']);
const DIRECT_STAGE = {
  csdToReceived: 'sentToAccountsReceived',
  approvedToClearance: 'accountsReceivedToClearance',
};

function withoutCsdSteps(chain) {
  return {
    ...chain,
    checkpoints: chain.checkpoints.filter((c) => !CSD_OWN_CHECKPOINTS.has(c.key)),
    stageKeys: chain.stageKeys.filter((key) => !CSD_OWN_STAGES.has(key)).map((key) => DIRECT_STAGE[key] ?? key),
    end: chain.end.filter((key) => !CSD_OWN_CHECKPOINTS.has(key)),
  };
}

/** Worked out once each, so a chain is the same object every time it is asked for. */
const DIRECT_CHAINS = new Map([HOSPITAL_CHAIN, PHARMACY_CHAIN].map((chain) => [chain, withoutCsdSteps(chain)]));

/**
 * The chain a report was measured over: `chain` itself while the CSD steps are
 * on, its shorter form once they are off. `stepsOn` is read off the answer the
 * report is drawing (stepsOnIn in services/csdSteps.js) rather than off the
 * session, so the checkpoints drawn are the ones the server's stages run
 * between.
 */
export function chainFor(chain, stepsOn = true) {
  if (stepsOn) return chain;
  return DIRECT_CHAINS.get(chain) ?? withoutCsdSteps(chain);
}

/**
 * The spans a chain can still measure: the ones whose two ends it draws. A
 * span picked before the CSD steps were switched off may run to a checkpoint
 * the report no longer has, and would otherwise head a column of blanks.
 */
export function spansIn(chain, spans = []) {
  const drawn = new Set(chain.checkpoints.map((c) => c.key));
  return spans.filter((span) => drawn.has(span.from) && drawn.has(span.to));
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
