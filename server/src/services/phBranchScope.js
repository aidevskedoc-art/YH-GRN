/**
 * The pharmacy branch filter, as SQL -- services/branchScope.js against
 * ph_branch_configs.
 *
 * The same clauses for the same reasons: written against the configuration
 * table directly, so they carry no parameters, cost no round trip and see the
 * ticks as they are when the query runs; and with nothing ticked there is no
 * narrowing.
 *
 * What differs is how a row is tied to its branch. The hospitals find a
 * branch's name somewhere inside the GRN report's Location; a pharmacy GRN
 * carries the unit's own name, so it is held equal -- folded, as everywhere in
 * the pharmacy matching (see "The branch, and what goes through it" in
 * routes/phBatches.js). So each function here takes the two KEYS of a row, as
 * SQL: its DivisionCode folded and its Unit Name folded. On the results they
 * are the columns stored beside each (a.division_key, g.unit_key); on the CSD
 * queue, which keeps its own copy of a GRN, the snapshot's.
 *
 * Read by routes/phResults.js and routes/phCsd.js, so that a row is under the
 * same branch on both screens.
 */
import { folded } from './phIngest.js';

/** Is any branch ticked at all? While none is, nothing is narrowed. */
export const PH_NONE_SELECTED = 'NOT EXISTS (SELECT 1 FROM ph_branch_configs WHERE is_selected)';

/** Whether the row's DivisionCode is branch `bc`'s Branch code (Focus). A blank is nobody's. */
const divisionIsBranchs = (divisionKey) =>
  `(${divisionKey} <> '' AND ${divisionKey} = ${folded('bc.branch_code')})`;

/**
 * Whether the row is branch `bc`'s: its DivisionCode is the branch's Branch
 * code (Focus), or its Unit Name is the branch's Unit name (HIS).
 *
 * Either, not both, for the hospitals' reason: a pending row has no ageing
 * entry at all, so only the unit can place it, and a row either side places
 * should be shown under that branch rather than under none. (Whether a GRN is
 * MATCHED to an ageing row is the stricter question, and needs both -- see
 * SAME_BRANCH in services/phIngest.js.)
 *
 * A key that is NULL -- the ageing side of a pending row -- makes its half
 * NULL, which the OR and the EXISTS around it both read as "not this half".
 */
const rowIsBranchs = ({ divisionKey, unitKey }) => `(
          ${divisionIsBranchs(divisionKey)}
          OR (${unitKey} <> '' AND ${unitKey} = ${folded('bc.location')})
        )`;

/** branchScope: the rows of the ticked branches, or every row while none is ticked. */
export function phBranchScope(keys) {
  return `(
    ${PH_NONE_SELECTED}
    OR EXISTS (
      SELECT 1 FROM ph_branch_configs bc
      WHERE bc.is_selected AND ${rowIsBranchs(keys)}
    )
  )`;
}

/**
 * branchPick: one branch, chosen by its Unit name (HIS) -- the Location
 * dropdown, and the one branch an account is confined to (users.branch_location;
 * branchFor returns null for an administrator and for an account that is not).
 *
 * The confinement is a permission, applied to every query and never read off
 * the request. An account confined to a name no pharmacy branch carries sees no
 * pharmacy rows: that is the safe way round for a permission -- the alternative
 * is showing a confined account everything.
 *
 * @returns (value, params) => SQL with the name pushed onto `params`, or null
 *   when nothing is chosen
 */
export function phBranchPick(keys) {
  return (value, params) => {
    const wanted = String(value ?? '').trim();
    if (!wanted) return null;
    params.push(wanted);
    const name = folded(`$${params.length}::text`);
    return `EXISTS (
      SELECT 1 FROM ph_branch_configs bc
      WHERE ${name} <> ''
        AND ${folded('bc.location')} = ${name}
        AND ${rowIsBranchs(keys)}
    )`;
  };
}

/**
 * branchAccountNo: the account the row's branch banks through, off
 * Ph-Configuration. Every branch is looked at, ticked or not; the DivisionCode
 * match is preferred where both names find a branch. Null when the branch has
 * no account recorded, or no configured branch claims the row.
 */
export function phBranchAccountNo(keys) {
  return `(
    SELECT bc.account_no
    FROM ph_branch_configs bc
    WHERE bc.account_no IS NOT NULL AND ${rowIsBranchs(keys)}
    ORDER BY COALESCE(${divisionIsBranchs(keys.divisionKey)}, FALSE) DESC, bc.id
    LIMIT 1
  )`;
}

/**
 * branchDivisionCode: the configured Branch code (Focus) of the row's branch --
 * for a pending row, which has no ageing DivisionCode of its own to show.
 */
export function phBranchDivisionCode(keys) {
  return `(
    SELECT bc.branch_code
    FROM ph_branch_configs bc
    WHERE ${rowIsBranchs(keys)}
    ORDER BY COALESCE(${divisionIsBranchs(keys.divisionKey)}, FALSE) DESC, bc.id
    LIMIT 1
  )`;
}
