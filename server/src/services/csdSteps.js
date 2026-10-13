/**
 * Whether the CSD department's own steps are part of a handover.
 *
 * A GRN handed to CSD used to wait on three answers from them -- Received,
 * Approved or Rejected, Moved to accounts -- before Accounts could acknowledge
 * it back. The department no longer records those, so each side (the hospitals,
 * OP Pharmacy) has a switch on its own configuration screen: on, and a handover
 * runs exactly as it always has; off, and Accounts mark a GRN Received straight
 * after sending it, with nothing of CSD's in between.
 *
 * Switching one off writes nothing to any handover. It changes three rules and
 * no stored row:
 *
 *   - Accounts' Received accepts a handover still at CSD (receiveDirectSql);
 *   - "the Accounts queue" widens to everything awaiting that click
 *     (awaitingAccountsSql), which is what the cards, the Action filter and the
 *     export count by;
 *   - CSD's stage moves are refused (stepsOffRefusal).
 *
 * A handover received that way ends where the full flow ends -- MOVED_TO_ACCOUNTS
 * on CSD's ladder, RECEIVED on Accounts' -- so forwarding it on, and everything
 * that reads it afterwards, is the code that was already there. That is also
 * what makes the switch safe to turn back on: nothing was put in a state the
 * ladder cannot read.
 *
 * Kept in app_settings, one row per switch, and a switch with no row is on --
 * so an installation that has never touched one behaves as it did before any
 * of this existed, with nothing to seed. Read on every request rather than
 * cached, as requireAuth reads the user: a switch thrown on one screen has to
 * hold on the next request from every other.
 */
import { query } from '../db/pool.js';

/** The two sides, and the setting each one's switch is stored under. */
const KEYS = { hospital: 'csd_steps.hospital', pharmacy: 'csd_steps.pharmacy' };
export const SIDES = Object.keys(KEYS);

/**
 * Both switches: `{ hospital, pharmacy }`, each true while that side's CSD
 * steps are on.
 *
 * A database the migration has not reached yet has no app_settings table
 * (42P01). That is an installation nobody can have switched anything off on,
 * so it answers as one where both are on rather than failing every screen that
 * asks -- which is all of them.
 */
export async function csdSteps() {
  let rows;
  try {
    ({ rows } = await query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [
      Object.values(KEYS),
    ]));
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') return { hospital: true, pharmacy: true };
    throw err;
  }
  // Off only where a row says so: anything else stored there is not an answer.
  const on = (side) => !rows.some((row) => row.key === KEYS[side] && row.value === false);
  return { hospital: on('hospital'), pharmacy: on('pharmacy') };
}

/** Switch one side's CSD steps on or off. */
export async function saveCsdSteps(side, enabled, userId) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by`,
    [KEYS[side], JSON.stringify(Boolean(enabled)), userId],
  );
}

/** The sides switched off, as the session carries them: `['hospital']`, or `[]`. */
export function stepsOff(steps) {
  return SIDES.filter((side) => !steps[side]);
}

/**
 * What an answer says about the switch it was worked out under: nothing while
 * the steps are on -- so those answers are what they have always been -- and
 * `csdStepsOff` once they are off, which is what tells the page reading it to
 * draw the shorter flow.
 */
export function stepsEcho(on) {
  return on ? {} : { csdStepsOff: true };
}

/**
 * The Action values that are CSD's own steps, and so are not offered once the
 * steps are off. Every one of them is still a valid filter -- a page opened
 * before the switch was thrown asks truthfully rather than being refused.
 */
export const CSD_STEP_ACTIONS = ['QUEUED', 'RECEIVED', 'APPROVED'];

/**
 * A handover awaiting Accounts' Received while the steps are off: sent, not
 * rejected, and not yet acknowledged -- wherever CSD had got to with it. The
 * widened form of RETURNED_BY_CSD in routes/results.js, and the same test
 * receiveDirectSql below accepts by, so a row the queue counts is a row the
 * click works on.
 *
 * `c` is the handover's alias in whichever query asks. Parenthesised whole: it
 * is dropped into AND chains as it stands.
 */
export function awaitingAccountsSql(c = 'c') {
  return (
    `(${c}.forwarded_to IS NULL AND (${c}.stage IN ('QUEUED', 'RECEIVED', 'APPROVED')` +
    ` OR (${c}.stage = 'MOVED_TO_ACCOUNTS' AND ${c}.accounts_stage = 'QUEUED')))`
  );
}

/**
 * Accounts' Received while the steps are off: $1 the user, $2 the handover.
 *
 * One guarded statement, as the move it stands in for is -- two people
 * acknowledging one handover cannot both get through. It takes a handover from
 * wherever it stands short of a rejection, and leaves it MOVED_TO_ACCOUNTS and
 * RECEIVED.
 *
 * received_at, approved_at and moved_to_accounts_at are left as they are. CSD
 * did not do those things, and stamping them would put days in the GRN age
 * report that nobody spent. `stage_at` and `stage_by` move only when the stage
 * does: a handover CSD had already handed back keeps their hand-back on it.
 *
 * Returning `direct` -- whether CSD never handed it back -- and the stage it
 * was at, both read off stamps this statement does not touch.
 *
 * `table` is the caller's own constant, never a value off a request.
 */
export function receiveDirectSql(table) {
  return `
    UPDATE ${table}
       SET stage                = 'MOVED_TO_ACCOUNTS',
           stage_at             = CASE WHEN stage = 'MOVED_TO_ACCOUNTS' THEN stage_at ELSE NOW() END,
           stage_by             = CASE WHEN stage = 'MOVED_TO_ACCOUNTS' THEN stage_by ELSE $1 END,
           accounts_stage       = 'RECEIVED',
           accounts_received_at = NOW(),
           accounts_received_by = $1
     WHERE id = $2
       AND forwarded_to IS NULL
       AND (   (stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'QUEUED')
            OR  stage IN ('QUEUED', 'RECEIVED', 'APPROVED'))
    RETURNING id,
              (moved_to_accounts_at IS NULL) AS direct,
              CASE WHEN moved_to_accounts_at IS NOT NULL THEN 'MOVED_TO_ACCOUNTS'
                   WHEN approved_at IS NOT NULL THEN 'APPROVED'
                   WHEN received_at IS NOT NULL THEN 'RECEIVED'
                   ELSE 'QUEUED' END AS was_stage`;
}

/** The screen each side's switch is on, as the sidebar names it. */
const SWITCH_SCREEN = { hospital: 'Configuration', pharmacy: 'Ph-Configuration' };

/**
 * Why a stage move is refused while a side's steps are off -- naming the screen
 * that side's switch is on, since that is where whoever reads this would go to
 * ask about it, and the two sides' switches are on different ones.
 */
export function stepsOffRefusal(side) {
  return (
    `The CSD steps are switched off in ${SWITCH_SCREEN[side]}, so a GRN is no longer moved through` +
    ' CSD stages. Accounts mark it Received from the results screen. Reload the page.'
  );
}

/**
 * Why a handover that has reached Accounts cannot be taken back, while the
 * steps are off. With them on the reason given is that CSD handed it back
 * (NO_TAKE_BACK_REASON in routes/csd.js); off, it may never have been CSD's to
 * hand back -- Accounts received it themselves -- so this says where it is
 * rather than who put it there, which is true of both.
 */
export const TAKE_BACK_WITH_ACCOUNTS = 'it is already with Accounts';

/** Why Accounts cannot receive a handover CSD turned down, steps off or on. */
export const RECEIVE_REJECTED =
  'CSD rejected this GRN, so there is nothing for Accounts to receive. It reads as unsent' +
  ' again once an upload carries it.';

/**
 * How many handovers stand where, for the configuration screen to say what
 * throwing the switch will meet: the ones still on CSD's ladder, the ones they
 * turned down, and the ones handed back that Accounts have not acknowledged.
 *
 * `table` is the caller's own constant, as above.
 */
export async function inFlight(table) {
  const { rows } = await query(
    `SELECT (COUNT(*) FILTER (WHERE stage = 'QUEUED'))::int AS queued,
            (COUNT(*) FILTER (WHERE stage = 'RECEIVED'))::int AS received,
            (COUNT(*) FILTER (WHERE stage = 'APPROVED'))::int AS approved,
            (COUNT(*) FILTER (WHERE stage = 'REJECTED'))::int AS rejected,
            (COUNT(*) FILTER (
               WHERE stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'QUEUED' AND forwarded_to IS NULL
            ))::int AS handed_back
     FROM ${table}`,
  );
  const r = rows[0] || {};
  return {
    queued: r.queued ?? 0,
    received: r.received ?? 0,
    approved: r.approved ?? 0,
    rejected: r.rejected ?? 0,
    handedBack: r.handed_back ?? 0,
  };
}
