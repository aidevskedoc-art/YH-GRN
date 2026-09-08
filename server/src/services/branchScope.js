/**
 * The branch filter, as SQL.
 *
 * The configuration screen holds one row per branch naming the three ways the
 * three source files spell it -- the ageing report's DivisionCode, a fragment
 * of the GRN report's Location, and the account its bank statement is for --
 * and a tick box saying whether it is in scope. These are the clauses that turn
 * whatever is ticked into what the screens show.
 *
 * Written against branch_configs directly rather than read into JavaScript and
 * bound as parameters. Three reasons, and the third is the one that decides it:
 * the clauses carry no parameters at all, so they can be dropped into any query
 * without disturbing its numbering; they cost no extra round trip; and they see
 * the configuration as it is at the moment the query runs, so a branch ticked
 * in one tab cannot be missed by a query already in flight in another.
 *
 * With nothing ticked there is no narrowing. That is deliberate, and it is the
 * state a fresh installation is in: an empty configuration means "no opinion",
 * not "nothing qualifies", so the screens go on showing everything exactly as
 * they did before any of this existed. Each clause says so itself, in its
 * leading NOT EXISTS, rather than leaving every caller to remember.
 *
 * Nothing here touches an upload. Every row of every file is stored and
 * reconciled whatever is ticked, so branches can be ticked and unticked freely
 * and the figures follow on the next page load.
 */

/** Is any branch ticked at all? While none is, nothing is narrowed. */
const NONE_SELECTED = 'NOT EXISTS (SELECT 1 FROM branch_configs WHERE is_selected)';

/**
 * A row is in scope if EITHER side of the match says it belongs to a ticked
 * branch -- the ageing report's DivisionCode equalling the branch code, or the
 * GRN report's Location containing the branch's location.
 *
 * Either, not both. The two names come from two systems maintained by two
 * teams, and they disagree: a GRN whose Location says SECUNDERABAD but whose
 * ageing row was filed under a different division is still a Secunderabad GRN,
 * and requiring both would hide it from every branch rather than showing it
 * under the one it plainly belongs to. Erring towards showing a row is the
 * right error for a reconciliation report to make -- a row wrongly shown gets
 * noticed and explained, a row wrongly hidden gets noticed by nobody.
 *
 * It also keeps a Pending row visible. Those have no ageing entry at all, so
 * the DivisionCode half cannot speak for them and only the Location half can.
 *
 * Location is a case-folded substring match, because the GRN report writes the
 * branch inside a longer string: "YASHODA HEALTHCARE SERVICES LIMITED,
 * SECUNDERABAD" is the Location on every Secunderabad row, and SECUNDERABAD is
 * the part of it that names the branch.
 *
 * @param divisionCode the column holding the ageing side's code on this query
 * @param location     the column holding the stores side's location
 */
export function branchScope({ divisionCode, location }) {
  return `(
    ${NONE_SELECTED}
    OR EXISTS (
      SELECT 1 FROM branch_configs bc
      WHERE bc.is_selected
        AND (
          upper(${divisionCode}) = upper(bc.branch_code)
          OR upper(${location}) LIKE '%' || upper(bc.location) || '%'
        )
    )
  )`;
}

/**
 * Which bank statements count as a ticked branch's.
 *
 * The cheque-clearance verdict is read from every statement ever uploaded, not
 * only the one that came in beside this month's reports -- a cheque cut in
 * April clears in May, and the May statement is where that shows. Once branches
 * are configured with account numbers, that sweep is narrowed to the accounts
 * those branches bank through, so one branch's cheque is never reported cleared
 * on the strength of another branch's statement.
 *
 * Three ways out of narrowing, not one. No branch ticked is the first, as
 * everywhere else here. The second is a ticked branch with no account number
 * against it: the account is the optional third of a branch definition, and an
 * installation banking through a single account has no reason to fill it in --
 * so while no ticked branch names an account, every statement still counts.
 *
 * The third is a statement whose own account is not recorded, and it is the one
 * that matters in practice. Account numbers are read out of the letterhead, and
 * that only started happening when this feature was built -- so every statement
 * uploaded before it has a null against it. Excluding those would mean that
 * filling in an account number silently stopped every historical cheque from
 * reading as cleared, which is a large and invisible change to the figures made
 * by what looks like a note-to-self on a settings screen.
 *
 * Unknown is not the same as mismatched. A statement is dropped only when its
 * account is known AND belongs to no ticked branch; re-uploading it records the
 * account and brings it under the rule properly.
 *
 * @param batchColumn the column holding a transaction's batch id
 */
export function bankAccountScope(batchColumn) {
  return `(
    ${NONE_SELECTED}
    OR NOT EXISTS (
      SELECT 1 FROM branch_configs WHERE is_selected AND account_no IS NOT NULL
    )
    OR ${batchColumn} IN (
      SELECT ub.id
      FROM upload_batches ub
      WHERE ub.bank_account_no IS NULL
         OR EXISTS (
              SELECT 1 FROM branch_configs bc
              WHERE bc.is_selected
                AND bc.account_no IS NOT NULL
                AND bc.account_no = ub.bank_account_no
            )
    )
  )`;
}

/**
 * The bank account a row's branch banks through, as SQL.
 *
 * The account number lives on the branch, not on the GRN: it is the third of
 * the three names the configuration screen holds for a branch, and it is the
 * one the bank statement is written against. So the column shown beside a
 * result is the configured account of whichever branch that result belongs to.
 *
 * A row is tied to its branch exactly as `branchScope` ties it -- the ageing
 * report's DivisionCode equalling the branch code, or the GRN report's Location
 * containing the branch's location -- because those are the two spellings the
 * two source files use, and a column that resolved the branch differently from
 * the filter would show one branch's account on a row the filter counts under
 * another.
 *
 * Every branch is looked at, ticked or not. Ticking scopes what is displayed;
 * it does not say which account a branch banks through, and a row that is on
 * screen at all should name its account whether or not its branch happens to be
 * the one filtered on.
 *
 * The DivisionCode match is preferred when both spellings find a branch. It is
 * an exact match on a code, where Location is a substring of a longer string,
 * so it is the more precise of the two answers. Null when the branch has no
 * account recorded, or when no configured branch claims the row.
 *
 * @param divisionCode the column holding the ageing side's code on this query
 * @param location     the column holding the stores side's location
 */
export function branchAccountNo({ divisionCode, location }) {
  return `(
    SELECT bc.account_no
    FROM branch_configs bc
    WHERE bc.account_no IS NOT NULL
      AND (
        upper(${divisionCode}) = upper(bc.branch_code)
        OR upper(${location}) LIKE '%' || upper(bc.location) || '%'
      )
    ORDER BY COALESCE(upper(${divisionCode}) = upper(bc.branch_code), FALSE) DESC, bc.id
    LIMIT 1
  )`;
}

/**
 * The configured branch code (DivisionCode) of the branch a row belongs to,
 * resolved the same way `branchAccountNo` resolves an account number.
 *
 * A matched row already carries the ageing report's own DivisionCode, which is
 * real data and is shown as-is elsewhere. This exists for the rows that have
 * none -- a Pending row has no ageing entry at all -- so that a GRN whose
 * Location says SECUNDERABAD can still show the SE1 the configuration screen
 * has on file for it, the same way a Pending row's bank account is resolved
 * from Location alone.
 *
 * @param divisionCode the column holding the ageing side's code on this query
 * @param location     the column holding the stores side's location
 */
export function branchDivisionCode({ divisionCode, location }) {
  return `(
    SELECT bc.branch_code
    FROM branch_configs bc
    WHERE (
        upper(${divisionCode}) = upper(bc.branch_code)
        OR upper(${location}) LIKE '%' || upper(bc.location) || '%'
      )
    ORDER BY COALESCE(upper(${divisionCode}) = upper(bc.branch_code), FALSE) DESC, bc.id
    LIMIT 1
  )`;
}

/**
 * One branch, chosen by name -- the Location dropdown on the results and CSD
 * screens.
 *
 * The dropdown offers the configured branches, so what travels from it is a
 * branch's `location` as the configuration screen spells it, and the clause
 * below turns that back into the two spellings the source files use. It is the
 * same either/or `branchScope` applies, for the same reason: the ageing report
 * files a row under a DivisionCode and the GRN report writes the branch inside
 * a longer Location string, and a row belongs to the branch either of them
 * names.
 *
 * Independent of the tick boxes, and narrower. Ticking scopes the installation
 * -- which branches these screens are about at all -- and this picks one of
 * what is left to look at, so the two compose: both clauses are applied, and a
 * location can only ever narrow what the ticks already allow.
 *
 * Matched against the configuration rather than against the raw Location text,
 * so picking "SECUNDERABAD" cannot be defeated by the GRN report's habit of
 * writing it as part of "YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD".
 * Two branches configured under one location name both count, which is the
 * right answer -- the dropdown showed that name once, and it means the place.
 *
 * @param divisionCode the column holding the ageing side's code on this query
 * @param location     the column holding the stores side's location
 * @returns (value, params) => SQL, or null when nothing is chosen
 */
export function branchPick({ divisionCode, location }) {
  return (value, params) => {
    const wanted = String(value ?? '').trim();
    if (!wanted) return null;
    params.push(wanted);
    const n = params.length;
    return `EXISTS (
      SELECT 1 FROM branch_configs bc
      WHERE upper(bc.location) = upper($${n})
        AND (
          upper(${divisionCode}) = upper(bc.branch_code)
          OR upper(${location}) LIKE '%' || upper(bc.location) || '%'
        )
    )`;
  };
}
