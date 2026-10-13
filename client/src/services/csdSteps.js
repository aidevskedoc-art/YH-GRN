/**
 * The CSD steps switch, as the tables read it off a row.
 *
 * Each side -- the hospitals, OP Pharmacy -- has a switch on its configuration
 * screen for whether a handover still goes through the CSD department's own
 * stages (Received, Approved or Rejected, Moved to accounts). On, a GRN waits
 * at CSD until they hand it back, and only then can Accounts receive it. Off,
 * Accounts receive it straight from wherever it stands. The server owns the
 * rule (services/csdSteps.js there) and says which it answered under: rows and
 * summaries carry `csdStepsOff` once the steps are off, and nothing while they
 * are on.
 *
 * No imports, so the exporter can read it as well as the pages.
 */

/**
 * The CSD stages Accounts can receive a handover straight from once the steps
 * are off -- kept in step by hand with receiveDirectSql in the server's
 * services/csdSteps.js, which is what actually takes it. Not REJECTED: a bill
 * CSD turned down has nothing to receive.
 */
const DIRECT_RECEIVE_STAGES = ['QUEUED', 'RECEIVED', 'APPROVED'];

/**
 * Whether a results row is waiting on Accounts' Received.
 *
 * With the steps on (`stepsOn`, the default) that is a GRN CSD have handed
 * back and Accounts have not acknowledged -- the test this has always been.
 *
 * With them off it is every handover short of that click: still at CSD, at
 * whatever stage, or handed back. It needs the dispatch's own id, which is
 * what the endpoint addresses -- a row marked sent a moment ago has not been
 * reloaded yet and has none, so it waits for the reload rather than offering a
 * control that cannot work.
 *
 * Off only on a plain `false`. This is handed to filter() and every() as a
 * predicate here and there, which pass the row's index second -- and an index
 * of 0 must not read as "steps off" for the first row of every list.
 */
export function awaitsAccounts(row, stepsOn = true) {
  const handedBack =
    row.csdStage === 'MOVED_TO_ACCOUNTS' && (row.csdAccountsStage || 'QUEUED') === 'QUEUED';
  if (stepsOn !== false) return handedBack;
  return (
    Boolean(row.csdDispatchId) &&
    !row.csdForwardedTo &&
    (handedBack || DIRECT_RECEIVE_STAGES.includes(row.csdStage))
  );
}

/** Whether an answer was worked out with the steps on: true unless it says `csdStepsOff`. */
export function stepsOnIn(answer) {
  return !answer?.csdStepsOff;
}
