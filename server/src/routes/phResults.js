/**
 * OP Pharmacy's results -- the Pharmacy Results screen.
 *
 * routes/results.js for the pharmacies' tables, as far as the pharmacies have
 * the same things: every GRN once, with the verdict the upload stored for it,
 * the Vendor Age row it is matched to, what the bank statement says of its
 * cheque, the account its branch banks through, and where the BPAD status has
 * the bill.
 *
 * THE RULES ARE THE HOSPITALS', clause for clause, and each is noted beside
 * the hospital constant it is the twin of. In particular, the two the bank
 * statement and the account number turn on:
 *
 *  - a cheque is matched to the statement by its number -- the report's
 *    ChequeNo against the last six digits of the statement's Chq./Ref.No. --
 *    and whether it has cleared is whichever way the money moved last, with
 *    the value date of the latest withdrawal as the day it cleared (CHEQUE_MATCH);
 *  - a branch's Account number does two things: it is the account shown beside
 *    each of the branch's rows (ACCOUNT_NO), and, once ticked branches name
 *    accounts, only those accounts' statements are read for clearance
 *    (BANK_ACCOUNT_SCOPE).
 *
 * With two rules added that the hospitals do not have:
 *
 *  - a row's cheque is read off the statements of its own branch's account
 *    only, since two pharmacy units' accounts can each have issued the same
 *    cheque number (OWN_ACCOUNT);
 *  - a GRN is matched with the BPAD bill status FIRST, while one is on file for
 *    it, and only the bills that status has at Accounts' desk are then
 *    compared with the Vendor Age report. A GRN BPAD has at another desk, or
 *    has no entry for, is pending there, whatever the Vendor Age report says
 *    of it (BEFORE_ACCOUNTS, ROW_STATUS).
 *
 * What differs is how a row is tied to its branch. The hospitals find a
 * branch's name somewhere inside the GRN report's Location; a pharmacy GRN
 * carries the unit's own name, so it is held equal -- folded, as everywhere in
 * the pharmacy matching (see routes/phBatches.js).
 *
 * A row also says whether its GRN has been handed to CSD and how far that has
 * got, and whether it has been filed to Records, off the pharmacies' own two
 * tables (RESULT_JOINS; routes/phCsd.js, routes/phRecords.js).
 *
 * The page it answers is the hospital results page over again -- the same View
 * dropdown, cards and filters -- so the answers here are in results.js's own
 * shapes: see the note above phSummary.
 *
 * The Vendor Master's columns ride on a pharmacy row as they do on a hospital
 * one -- MSME No, MSME Status, Inter, Supply Type -- looked up by the vendor's
 * FOCUS CODE, not its PM Code. The master is HIS's vendor list keyed by the
 * code Focus knows a vendor by; the GRN Purchase report carries that code
 * beside the pharmacy system's own PM Code, and it is the one the master has
 * (VENDOR_CODE below). A vendor it has no row for reads as a dash in all four.
 *
 * What the hospitals have and this does not: the Ageing columns and their "as
 * of" date. The GRN age view is here from the GRN onward -- a pharmacy purchase
 * has no PR, PO or security step -- with each date read from the file that has
 * it: the GRN Purchase report, the BPAD bill status, the Vendor Age report,
 * the stamps this application writes and the bank's clearance (see
 * TURNAROUND_DATES below).
 *
 * Read-only: nothing here writes.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { STATUS } from '../services/reconcile.js';
import { folded } from '../services/phIngest.js';
import {
  PH_NONE_SELECTED,
  phBranchScope,
  phBranchPick,
  phBranchAccountNo,
  phBranchDivisionCode,
} from '../services/phBranchScope.js';
import { branchFor } from '../config/screens.js';
import {
  msmeFilter,
  supplyTypeFilter,
  vendorColumns,
  vendorFields,
  vendorInter,
  vendorSupplyType,
  SUPPLY_TYPE_CHOICES,
} from '../services/vendorMsme.js';
import { summarise, dataQuality, gapsFor, PHARMACY_CHAIN } from '../services/turnaround.js';

export const phResultsRouter = express.Router();

// Either grant, as on the hospital router: Ph-Accounts is this screen with
// fewer views, reading the same rows.
phResultsRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

const VALID_STATUSES = new Set(Object.values(STATUS));
const MAX_PAGE_SIZE = 200;

/** The two matched statuses as one bucket, and every bucket -- as in results.js. */
const VALID = 'VALID';
const VALID_MEMBERS = [STATUS.MATCHED, STATUS.MATCHED_WITH_DIFF];
const ALL_STATUSES = 'ALL';

function isKnownStatus(status) {
  return VALID_STATUSES.has(status) || status === VALID || status === ALL_STATUSES || status === HELD_HANDOVER;
}

/**
 * One verdict's rows, VALID's two, the held handovers, or null for every row
 * -- by the verdict a row is shown under (ROW_STATUS).
 */
function statusFilter(status, params) {
  if (!status || status === ALL_STATUSES) return null;
  // No parameter: the clause is this file's own.
  if (status === HELD_HANDOVER) return HELD_HANDOVER_SQL;
  if (status === VALID) {
    params.push(VALID_MEMBERS);
    return `${ROW_STATUS} = ANY($${params.length})`;
  }
  params.push(status);
  return `${ROW_STATUS} = $${params.length}`;
}

/** `WHERE a AND b`, or '' when nothing is being filtered on. */
function whereFrom(clauses) {
  const kept = clauses.filter(Boolean);
  return kept.length > 0 ? `WHERE ${kept.join(' AND ')}` : '';
}

/* --------------------------------------------------------------------------
   The branch a row belongs to, and what the configuration says of it.
   services/branchScope.js, against ph_branch_configs.
   -------------------------------------------------------------------------- */

/**
 * A result's two keys, as services/phBranchScope.js reads them: the folds
 * stored beside the ageing row's DivisionCode and the GRN's Unit Name. The
 * first is NULL on a pending row, which has no ageing row -- only the unit
 * places it.
 */
const ROW_KEYS = { divisionKey: 'a.division_key', unitKey: 'g.unit_key' };

/** The rows of the ticked branches, or every row while none is ticked. */
const BRANCH_SCOPE = phBranchScope(ROW_KEYS);

/**
 * One branch, by its Unit name (HIS), as a clause -- see phBranchPick. Asked
 * twice of every query, as results.js's branchClauses asks: for the account's
 * own branch grant, then for the Location dropdown's choice within it.
 *
 * The grant is held against the pharmacy branches' Unit name: an account
 * confined to a name no pharmacy branch carries sees no pharmacy rows, and the
 * summary says what the account is confined to, so an empty page is explained.
 *
 * @returns SQL, with the name pushed onto `params` -- or null for no narrowing
 */
const branchPick = phBranchPick(ROW_KEYS);

/** The account the row's branch banks through, off Ph-Configuration. */
const ACCOUNT_NO = phBranchAccountNo(ROW_KEYS);

/** The configured Branch code (Focus) of the row's branch -- for a pending row. */
const BRANCH_DIVISION_CODE = phBranchDivisionCode(ROW_KEYS);

/**
 * The code the Vendor Master knows a GRN's vendor by: its Focus code, off the
 * GRN Purchase report. Not g.vendor_code, which is the PM Code -- the pharmacy
 * system's own, and on no master. See services/vendorMsme.js.
 */
const VENDOR_CODE = 'g.focus_code';

/**
 * bankAccountScope: which statements count towards clearance.
 *
 * Every statement, in three cases -- no branch ticked; no ticked branch names
 * an account; and a statement whose own account is not recorded, which counts
 * whatever is ticked. Otherwise only the statements for a ticked branch's
 * account. Unknown is not the same as mismatched: a statement is left out only
 * when its account is known AND is no ticked branch's.
 */
const BANK_ACCOUNT_SCOPE = `(
    ${PH_NONE_SELECTED}
    OR NOT EXISTS (
      SELECT 1 FROM ph_branch_configs WHERE is_selected AND account_no IS NOT NULL
    )
    OR bt.batch_id IN (
      SELECT ub.id
      FROM ph_upload_batches ub
      WHERE ub.bank_account_no IS NULL
         OR EXISTS (
              SELECT 1 FROM ph_branch_configs bc
              WHERE bc.is_selected
                AND bc.account_no IS NOT NULL
                AND bc.account_no = ub.bank_account_no
            )
    )
  )`;

/* --------------------------------------------------------------------------
   The cheque, and the bank statement's answer on it. results.js's PAYABLE_AMOUNT,
   CHEQUE_MATCH, CHEQUE_CLEARED_ON and PROGRESS, against the ph_ tables.
   -------------------------------------------------------------------------- */

/** PayableAmount, with the report's blank zeros recomputed from NetAmt less the three adjustments. */
const PAYABLE_AMOUNT = `
  COALESCE(
    a.payable_amount,
    CASE WHEN a.net_amt IS NOT NULL THEN
      a.net_amt - COALESCE(a.adj_pur_return, 0) - COALESCE(a.adjusted_jv, 0) - COALESCE(a.tds_jv, 0)
    END
  )`;

/**
 * Whether statement batch `sb` is for the account the row's branch banks
 * through (ACCOUNT_NO, off Ph-Configuration) -- the one rule of CHEQUE_MATCH
 * below that is not the hospitals'.
 *
 * A cheque number is one cheque only within the account it is drawn on, and
 * the pharmacy units bank through accounts of their own -- so two units can
 * each have issued cheque 001653, and matched by number alone one unit's bill
 * would read as cleared, on the other's date, off the other's statement.
 *
 * Unknown is not the same as mismatched, here as in BANK_ACCOUNT_SCOPE: a
 * statement is left out only when its account is known AND the row's branch's
 * is known AND they differ. A statement whose letterhead named no account, and
 * a row whose branch has no Account number recorded (or that no branch
 * claims), go on being matched by the cheque number alone -- filling in the
 * Account number on Ph-Configuration is what brings a branch under the rule.
 *
 * The COALESCE says both of those in one comparison, so the branch is looked
 * up once: a row with no account of its own compares the statement's with
 * itself.
 */
const OWN_ACCOUNT = `(
        sb.bank_account_no IS NULL
        OR COALESCE(${ACCOUNT_NO}, sb.bank_account_no) = sb.bank_account_no
      )`;

/**
 * The statement's verdict on a GRN's cheque, matched by number.
 *
 * A cheque leaves the account as a withdrawal; when it bounces the money comes
 * back as a deposit under the same number, and when it is re-presented it goes
 * out again. So the state is whichever way the money moved LAST -- W cleared,
 * W D returned, W D W cleared again -- and it cleared on the value date of the
 * latest withdrawal. Matched against every statement uploaded, not one batch's:
 * a cheque written in April clears in May. '000000' is what the statement
 * writes for a transfer or a charge, and is nobody's cheque.
 *
 * Within two narrowings: the ticked branches' accounts, as the hospitals have
 * (BANK_ACCOUNT_SCOPE), and the row's own branch's account (OWN_ACCOUNT).
 *
 * LEFT JOIN LATERAL over aggregates, so it always yields exactly one row.
 */
const CHEQUE_MATCH = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS txn_count,
           (ARRAY_AGG(
              CASE WHEN COALESCE(bt.withdrawal_amt, 0) > 0 THEN 'W' ELSE 'D' END
              ORDER BY bt.txn_date DESC, bt.id DESC
            ))[1] AS last_movement,
           MAX(bt.value_date) FILTER (WHERE COALESCE(bt.withdrawal_amt, 0) > 0) AS cleared_on
    FROM ph_bank_statement_transactions bt
    JOIN ph_upload_batches sb ON sb.id = bt.batch_id
    WHERE bt.extracted_cheque_no = a.cheque_no
      AND bt.extracted_cheque_no <> '000000'
      AND ${BANK_ACCOUNT_SCOPE}
      AND ${OWN_ACCOUNT}
  ) chq ON TRUE`;

/** The day the cheque cleared: a hand correction if there is one, else the statement's answer. */
const CHEQUE_CLEARED_ON = `
         COALESCE(
           a.cheque_clearance_override,
           CASE WHEN chq.last_movement = 'W' THEN chq.cleared_on END
         )`;

const CHEQUE_COLUMNS = `
         chq.txn_count AS cheque_txn_count,
         CASE chq.last_movement WHEN 'W' THEN 'CLEARED' WHEN 'D' THEN 'RETURNED' END AS cheque_status,
         ${CHEQUE_CLEARED_ON} AS cheque_cleared_on`;

/** None of the three cheque columns filled in. Spelled against the bare columns -- see results.js. */
const NO_CHEQUE =
  `(a.cheque_no IS NULL OR a.cheque_no = '') AND a.chq_date IS NULL` +
  ` AND (a.payment_doc_no IS NULL OR a.payment_doc_no = '')`;

/**
 * Whether BPAD row `alias` is the GRN's: the GRN's number, under the GRN's
 * unit and the GRN's vendor code -- the three a status row is matched and
 * stored by (matchBpadFiles in routes/phBatches.js). The number alone would
 * hand one unit's GRN the status of another unit's bill of the same number.
 */
const bpadRowIsGrns = (alias) =>
  `${alias}.grn_no_key = g.dpr_no_key AND ${alias}.unit_key = g.unit_key` +
  ` AND ${alias}.vendor_code_key = ${folded('g.vendor_code')}`;

/**
 * Why a bill needs no cheque at all, whatever it has left to pay --
 * chequeExemptSql in results.js, both halves: the vendor is Inter, as picked on
 * the Vendor Master screen (looked up by its Focus code), or the BPAD status
 * has the bill at Accounts with "cash" in Pending With User/Status -- a cash
 * bill. A vendor the master does not have is not Inter: the COALESCE keeps a
 * missing answer from turning NOT (...) into NULL.
 */
const CHEQUE_EXEMPT = `(COALESCE(${vendorInter(VENDOR_CODE)} = 'YES', FALSE)
      OR EXISTS (
        SELECT 1 FROM ph_bpad_records cx
         WHERE ${bpadRowIsGrns('cx')}
           AND upper(btrim(cx.pending_with_dept)) = 'ACCOUNTS'
           AND cx.pending_with_user ILIKE '%cash%'))`;

/**
 * A payment has been drawn up for the bill: any of the three columns the
 * Vendor Age report fills in when one has -- the cheque number, its date, the
 * payment document. CHEQUE_PREPARED in results.js, where it is the whole of
 * that key.
 */
const PAYMENT_PREPARED =
  `(COALESCE(a.cheque_no, '') <> '' OR a.chq_date IS NOT NULL OR COALESCE(a.payment_doc_no, '') <> '')`;

/**
 * A cash bill: the GRN's Purchase Type is Cash (the purchase register's Type
 * column), and the Vendor Age report puts no cheque number on it. A cash
 * purchase is paid on a cash voucher ("CPT:PSE/26-27/PCP-31") -- a payment
 * document and a date, and no cheque -- so no cheque is ever coming for it,
 * paid yet or not: it is asked nothing about one, and is no cheque card's.
 * Folded, so "Cash", "CASH" and "cash " are one type.
 *
 * A cash-type GRN that does carry a cheque number has a cheque to its name,
 * and stays with the cheques: it is listed on the Cheques view and is handed
 * to CSD with the rest of what that cheque pays.
 */
const CASH_BILL = `(${folded('g.purchase_type')} = 'CASH' AND COALESCE(a.cheque_no, '') = '')`;

/**
 * What the cards, the Status filter and the Action filter ask of a row --
 * results.js's PROGRESS, key for key, as far as the pharmacies have the thing
 * each asks about. `c` is the GRN's handover to CSD and `rd` its filing to
 * Records (see RESULT_JOINS).
 *
 * The cheque keys first; `a.id IS NOT NULL` on the five that split the
 * Accounts rows between them, so a pending GRN falls in none. Then how far a
 * handover has got at CSD; then Accounts' own two steps once CSD hand it back
 * -- queued for Accounts, received by them -- and where they sent it on to
 * (routes/phAccountsReturns.js); then filed to Records, and gone to neither.
 *
 * With one key the hospitals do not have: CASH_PAYMENT, every cash bill in
 * Accounts (CASH_BILL above), paid or still to be -- taken out of all four
 * cheque keys, so that Cheque Prepared counts cheques' bills and nothing
 * else, Cheque Not Prepared counts only bills a cheque is awaited for, and
 * the five still add up to the GRNs in Accounts.
 */
const PROGRESS = {
  CLEARED: `${CHEQUE_CLEARED_ON} IS NOT NULL`,
  CHEQUE_PREPARED: `a.id IS NOT NULL AND ${PAYMENT_PREPARED} AND NOT ${CASH_BILL}`,
  CASH_PAYMENT: `a.id IS NOT NULL AND ${CASH_BILL}`,
  CHEQUE_NOT_REQUIRED: `a.id IS NOT NULL AND ${NO_CHEQUE} AND NOT ${CASH_BILL} AND ${CHEQUE_EXEMPT}`,
  CHEQUE_NOT_PREPARED:
    `a.id IS NOT NULL AND ${NO_CHEQUE} AND NOT ${CASH_BILL} AND NOT ${CHEQUE_EXEMPT} AND ${PAYABLE_AMOUNT} >= 1`,
  PAYMENT_NOT_REQUIRED:
    `a.id IS NOT NULL AND ${NO_CHEQUE} AND NOT ${CASH_BILL} AND NOT ${CHEQUE_EXEMPT}` +
    ` AND (${PAYABLE_AMOUNT} IS NULL OR ${PAYABLE_AMOUNT} < 1)`,
  QUEUED: "c.stage = 'QUEUED'",
  RECEIVED: "c.stage = 'RECEIVED'",
  APPROVED: "c.stage = 'APPROVED'",
  REJECTED: "c.stage = 'REJECTED'",
  RETURNED_BY_CSD: "c.stage = 'MOVED_TO_ACCOUNTS' AND c.accounts_stage = 'QUEUED' AND c.forwarded_to IS NULL",
  ACCOUNTS_RECEIVED: "c.stage = 'MOVED_TO_ACCOUNTS' AND c.accounts_stage = 'RECEIVED' AND c.forwarded_to IS NULL",
  BANK: "c.forwarded_to = 'BANK'",
  VENDOR: "c.forwarded_to = 'VENDOR' AND c.forwarded_route = 'VENDOR'",
  PURCHASE_DEPT: "c.forwarded_to = 'VENDOR' AND c.forwarded_route = 'PURCHASE_DEPT'",
  OTHERS: "c.forwarded_to = 'OTHERS'",
  COURIER: "c.forwarded_to = 'COURIER'",
  RECORDS: 'rd.id IS NOT NULL',
  NOT_SENT: 'c.id IS NULL AND rd.id IS NULL',
};
const PROGRESS_KEYS = Object.keys(PROGRESS);

/**
 * PROGRESS as the summary counts it for the cards: each value within the GRNs
 * in Accounts, which is where every one of its cards stands and what pressing
 * one lists (status VALID with the value).
 *
 * The cheque five say that themselves. The rest ask only about the handover,
 * and a GRN can have one and not be in Accounts: sent to CSD or filed to
 * Records, and held before Accounts since, by a later BPAD status
 * (BEFORE_ACCOUNTS). Counted here it would be on a card whose rows leave it
 * out. NOT_SENT alone is of every GRN: no card reads it.
 *
 * The rows still filter by PROGRESS itself -- under a status of their own.
 */
const CARD_PROGRESS = Object.fromEntries(
  PROGRESS_KEYS.map((key) => [key, key === 'NOT_SENT' ? PROGRESS[key] : `(${PROGRESS[key]}) AND a.id IS NOT NULL`]),
);

/** The CSD stages the Accounts row has a card for -- CSD_STAGES in results.js. */
const CSD_STAGES = ['QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED'];

/**
 * The values the Action filter takes: where a row stands in its own journey --
 * ACTIONS in results.js. Every PROGRESS key but the cheque ones, which are the
 * cards' question, and NOT_SENT, which the dropdown does not offer; plus
 * SEND_TO_CSD, the rows whose Send picker offers Send to CSD -- in accounts,
 * sent nowhere yet, and with a cheque drawn up to hand over. Never a cash
 * bill: there is no cheque to hand CSD, so its picker offers Records alone
 * (canSendCsd on the page), and the route refuses it (phGrnStanding below).
 *
 * It narrows on top of `progress` rather than replacing it.
 */
const NOT_ACTIONS = new Set([
  'CHEQUE_PREPARED',
  'CASH_PAYMENT',
  'CHEQUE_NOT_REQUIRED',
  'CHEQUE_NOT_PREPARED',
  'PAYMENT_NOT_REQUIRED',
  'NOT_SENT',
]);
const ACTIONS = {
  ...Object.fromEntries(PROGRESS_KEYS.filter((key) => !NOT_ACTIONS.has(key)).map((key) => [key, PROGRESS[key]])),
  SEND_TO_CSD: `(${PROGRESS.NOT_SENT}) AND (${PROGRESS.CHEQUE_PREPARED})`,
};
const ACTION_KEYS = Object.keys(ACTIONS);

/** A row of `<key>` count columns, as `{ KEY: n }` over ACTION_KEYS. */
function actionCountsFrom(row) {
  return Object.fromEntries(ACTION_KEYS.map((key) => [key, row?.[key.toLowerCase()] ?? 0]));
}

/*
 * NOT_SENT, spelled for a WHERE clause: as an anti-join the planner can
 * estimate, where "the two LEFT JOINs found nothing" gives it no statistic at
 * all -- see NOT_SENT_WHERE in results.js, where that guess cost minutes. The
 * same rows either way: each table holds one row at most per number and unit.
 */
const NOT_SENT_WHERE =
  'NOT EXISTS (SELECT 1 FROM ph_csd_dispatches cx WHERE cx.dpr_no_key = g.dpr_no_key AND cx.unit_key = g.unit_key)' +
  ' AND NOT EXISTS (SELECT 1 FROM ph_record_dispatches rx WHERE rx.dpr_no_key = g.dpr_no_key AND rx.unit_key = g.unit_key)';

/** PROGRESS and ACTIONS as WHERE clauses -- the same answers; see NOT_SENT_WHERE. */
const PROGRESS_WHERE = { ...PROGRESS, NOT_SENT: NOT_SENT_WHERE };
const ACTIONS_WHERE = { ...ACTIONS, SEND_TO_CSD: `(${NOT_SENT_WHERE}) AND (${PROGRESS.CHEQUE_PREPARED})` };

/** The SQL for one Status or Action value out of `clauses`, or null for any. No parameters. */
function keyedFilter(key, clauses) {
  if (!key) return null;
  const sql = clauses[key];
  return sql ? `(${sql})` : null;
}

/* --------------------------------------------------------------------------
   The BPAD status's answer for the GRN. results.js's PENDING_DEPT_JOIN.
   -------------------------------------------------------------------------- */

/**
 * Where a GRN's bill is sitting. A LATERAL with LIMIT 1, since the status can
 * repeat a GRN; newest first, as the hospitals' -- so a later status that had
 * no entry for the GRN is the answer, rather than the desk an earlier one had
 * it on.
 *
 * Part of RESULT_JOINS, and so of every query here, where the hospitals join
 * theirs only for the desk: whether the GRN has reached Accounts at all turns
 * on it (BEFORE_ACCOUNTS).
 */
const BPAD_JOIN = `
  LEFT JOIN LATERAL (
    SELECT pbb.pending_with_dept, pbb.pending_with_user, pbb.bpad_received_date,
           pbb.accounts_received_date, pbb.in_register
    FROM ph_bpad_records pbb
    WHERE ${bpadRowIsGrns('pbb')}
    ORDER BY pbb.batch_id DESC, pbb.id DESC
    LIMIT 1
  ) pb ON TRUE`;

/**
 * A desk that is Accounts', as SQL over `column` (Pending With Dept.): the word
 * at the start, any case, with no letter after it -- isAccountsDept on the
 * client, which is what puts a desk's card on the page as the Accounts one.
 */
const atAccountsDesk = (column) => `${column} ~* '^\\s*accounts(?![a-z])'`;

/** The BPAD status has the GRN's bill, at Accounts' desk. False where it has no row for the GRN. */
const BPAD_AT_ACCOUNTS_DESK = `COALESCE(pb.in_register AND ${atAccountsDesk('pb.pending_with_dept')}, FALSE)`;

/**
 * A BPAD bill status is on file for the GRN: it answers for the GRN's unit.
 *
 * By the unit, not by whether the GRN has a row of its own. A status uploaded
 * alone stores a row for every GRN on file of each unit it covers -- its own
 * entry, or one saying it had none (matchBpadFiles in routes/phBatches.js);
 * one uploaded beside a GRN report stores them for that report's GRNs and for
 * the earlier ones it lists. Either way a GRN can be left with no row -- one
 * raised since the last status, or an earlier one a later status did not list
 * -- and its unit's status is on file all the same. The subquery names no row
 * of the outer query, so it is worked out once.
 *
 * A GRN with no unit is placed by its own row alone. So is one with no PM
 * Code: a status row is a GRN's by its vendor code (bpadRowIsGrns), so no
 * upload can ever store a row for it, and holding it by its unit would hold
 * it for good -- it goes on being matched with the Vendor Age report alone.
 */
const BPAD_ON_FILE = `(
    pb.in_register IS NOT NULL
    OR (
      g.unit_key <> ''
      AND ${folded('g.vendor_code')} <> ''
      AND g.unit_key IN (SELECT cov.unit_key FROM ph_bpad_records cov)
    )
  )`;

/**
 * Not yet with Accounts, by the BPAD bill status: one is on file for the GRN,
 * and does not have its bill at Accounts' desk. The one rule of the matching
 * that is not the hospitals'.
 *
 * A pharmacy bill goes GRN store -> BPAD's desks -> Accounts, and a GRN is
 * matched in that order. With the BPAD bill status first, while one is on
 * file for it; and only the bills that status has AT ACCOUNTS are then
 * compared with the Vendor Age report -- found there, the GRN is in Accounts;
 * not found, it is pending at BPAD's Accounts desk, and the BPAD view counts
 * its bill as Not Integrated in Accounts. Every other GRN is pending where
 * BPAD has it -- at Stores, at Audit, or with no entry at all, which is the
 * GRN store -- whatever the Vendor Age report says of it: that report lists a
 * GRN document from the day it is raised, long before its bill has moved.
 *
 * A GRN of a unit no status covers is asked nothing here, and goes on being
 * matched with the Vendor Age report alone. The latest row answers, as for
 * the desk (BPAD_JOIN): what a later status says of the bill is where it is.
 */
const BEFORE_ACCOUNTS = `(${BPAD_ON_FILE} AND NOT ${BPAD_AT_ACCOUNTS_DESK})`;

/**
 * The verdict a row is shown, counted and filtered under: pending while BPAD
 * does not have its bill at Accounts, and otherwise what the upload stored for
 * it against the Vendor Age report. The stored verdict is left as it is -- a
 * BPAD status uploaded later moves a row here with no reconciliation run again.
 */
const ROW_STATUS = `(CASE WHEN ${BEFORE_ACCOUNTS} THEN '${STATUS.PENDING}' ELSE r.status END)`;

/**
 * The GRNs that are out with CSD or filed to Records and are not in Accounts:
 * sent while they were, and held before Accounts since by a later BPAD status
 * (or dropped from the Vendor Age report). A view of their own, as a `status`
 * the rows endpoint takes, because no other view Accounts work from lists
 * them -- the Accounts views are of the GRNs in Accounts, and their cards
 * count those alone (CARD_PROGRESS) -- and a handover still has to be
 * received, sent on or taken back by somebody. Empty nearly always.
 *
 * `c` and `rd` are RESULT_JOINS' own, which every query a status filters has.
 */
const HELD_HANDOVER = 'HELD_HANDOVER';
const HELD_HANDOVER_SQL = `(${ROW_STATUS} = '${STATUS.PENDING}' AND (c.id IS NOT NULL OR rd.id IS NOT NULL))`;

/** A desk as it is grouped and filtered by: the status's own text, trimmed and in capitals. */
const deskKey = (column) => `upper(btrim(${column}))`;

/** The bucket for "the status cannot say" -- no entry, or one with the desk blank. */
const NOT_IN_BPAD = '__not_in_bpad__';
/** The other side of it: every GRN the status does place at a desk -- IN_BPAD in results.js. */
const IN_BPAD = '__in_bpad__';
const BPAD_DEPT = `COALESCE(NULLIF(${deskKey('pb.pending_with_dept')}, ''), '${NOT_IN_BPAD}')`;

/**
 * One desk's rows, the two sentinels', or null for every row -- results.js's
 * pendingDeptFilter. NOT_IN_BPAD is asked from the Total GRNS row, over mixed
 * verdicts, so it asks for the pending half itself -- which a GRN the status
 * has no entry for is in, whatever the Vendor Age report says (BEFORE_ACCOUNTS);
 * a GRN in accounts that no status covers at all is not.
 */
function deskFilter(dept, params) {
  const desk = String(dept || '').trim();
  if (!desk) return null;
  if (desk === IN_BPAD) return `${BPAD_DEPT} <> '${NOT_IN_BPAD}'`;
  if (desk === NOT_IN_BPAD) return `(${BPAD_DEPT} = '${NOT_IN_BPAD}' AND ${ROW_STATUS} = '${STATUS.PENDING}')`;
  params.push(desk.toUpperCase());
  return `${BPAD_DEPT} = $${params.length}`;
}

/* --------------------------------------------------------------------------
   The rows.
   -------------------------------------------------------------------------- */

/**
 * Both sides of the match, joined on their primary keys, so they neither add
 * nor drop rows and a count over them counts results. One result per GRN is
 * the upload's own rule (idx_ph_results_one_per_grn), so there is nothing to
 * fold here as the hospital's every-upload view folds.
 *
 * Then the GRN's handover to CSD and its filing to Records, if it has either
 * -- read off those tables on every request rather than stored on the result,
 * so taking a GRN back puts its Send control back by itself, and an answer CSD
 * give on their own screen shows here on the next load (routes/phCsd.js,
 * routes/phRecords.js). Each on the number AND the unit, which is what a
 * pharmacy GRN is known by and what both tables hold unique: so each matches
 * one row at most, the counts stay counts of results, and another unit's GRN
 * of the same number is not shown as sent.
 *
 * The BPAD status's answer comes first (`pb`, one row at most), because the
 * Vendor Age row hangs on it: a GRN BPAD does not have at Accounts is given no
 * ageing row here (BEFORE_ACCOUNTS). So everywhere below, `a` being there
 * means what it says on the page -- the bill has reached Accounts -- and a GRN
 * held before it has no cheque and no payable, as any other pending GRN has
 * none. (The Vendor Age row the upload matched it to is still
 * r.matched_ageing_id: see STORED_CHEQUE_NO for the one place that reads it.)
 */
const RESULT_JOINS = `
  FROM ph_reconciliation_results r
  JOIN ph_grn_transactions g ON g.id = r.grn_transaction_id
  ${BPAD_JOIN}
  LEFT JOIN ph_vendor_ageing a ON a.id = r.matched_ageing_id AND NOT ${BEFORE_ACCOUNTS}
  LEFT JOIN ph_csd_dispatches c ON c.dpr_no_key = g.dpr_no_key AND c.unit_key = g.unit_key
  LEFT JOIN ph_record_dispatches rd ON rd.dpr_no_key = g.dpr_no_key AND rd.unit_key = g.unit_key
  ${CHEQUE_MATCH}
`;

/**
 * The cheque the Vendor Age report puts a GRN's bill on, off the row the upload
 * matched it to -- there whether or not the GRN is held before Accounts, which
 * `a.cheque_no` is not. For gathering a cheque's bills only: chequeFilters
 * matches it, and a row carries it as storedChequeNo so the page can ask for
 * the cheque of a held row. Nothing shown or counted reads it.
 */
const STORED_CHEQUE_NO = `(SELECT sa.cheque_no FROM ph_vendor_ageing sa WHERE sa.id = r.matched_ageing_id)`;

/** What the two sending routes answer for a GRN phGrnStanding says is not in Accounts. */
export const PH_NOT_IN_ACCOUNTS =
  'This GRN is not in Accounts: the BPAD bill status does not have its bill at the Accounts desk, ' +
  'or the Vendor Age report does not list it. Reload the page to see where it is.';

/** And what the CSD route answers for a cash bill: Records is the only place it goes. */
export const PH_CASH_TO_RECORDS =
  'This GRN is a cash payment: there is no cheque to hand to CSD. Send it to Records instead.';

/** And what both answer for a GRN number sent under a unit it is not on file under. */
export const PH_WRONG_UNIT =
  'This GRN is on file under a different Unit Name. Reload the page and send it from its own row.';

/**
 * Where a GRN stands, by the rules every row here is read with -- for the two
 * routes that send a GRN on (routes/phCsd.js, routes/phRecords.js) to ask
 * before they do, rather than take the page's word for the row: the page may
 * have been loaded before a later BPAD status came in.
 *
 * `reached`: it is in Accounts (BEFORE_ACCOUNTS says not, and so does a GRN the
 * Vendor Age report has no row for). `cashPayment`: it is a cash bill
 * (PROGRESS.CASH_PAYMENT), which has no cheque for CSD to be handed.
 *
 * `wrongUnit`: no GRN of that number is on file under that unit, but one is
 * under another -- a request that names no unit, or the wrong one. A pharmacy
 * GRN is its number AND its unit, so that is not this GRN, and sending it on
 * would file a handover no GRN's row joins back to, past both rules above.
 *
 * @returns `{ reached, cashPayment, wrongUnit }`, or null where no GRN of that number is on file at all
 */
export async function phGrnStanding(db, dprNoKey, unitKey) {
  const { rows } = await db.query(
    `SELECT (a.id IS NOT NULL) AS reached, (${PROGRESS.CASH_PAYMENT}) AS cash_payment
     FROM ph_reconciliation_results r
     JOIN ph_grn_transactions g ON g.id = r.grn_transaction_id
     ${BPAD_JOIN}
     LEFT JOIN ph_vendor_ageing a ON a.id = r.matched_ageing_id AND NOT ${BEFORE_ACCOUNTS}
     WHERE g.dpr_no_key = $1 AND g.unit_key = $2
     LIMIT 1`,
    [dprNoKey, unitKey],
  );
  if (rows.length > 0) {
    return { reached: rows[0].reached, cashPayment: rows[0].cash_payment ?? false, wrongUnit: false };
  }
  const { rows: elsewhere } = await db.query('SELECT 1 FROM ph_grn_transactions WHERE dpr_no_key = $1 LIMIT 1', [
    dprNoKey,
  ]);
  return elsewhere.length > 0 ? { reached: false, cashPayment: false, wrongUnit: true } : null;
}

/** Whether a GRN has reached Accounts -- phGrnStanding's first answer. True, false, or null where it is not on file. */
export async function phReachedAccounts(db, dprNoKey, unitKey) {
  const standing = await phGrnStanding(db, dprNoKey, unitKey);
  return standing ? standing.reached : null;
}

/**
 * The last time CSD rejected this GRN before whatever it is doing now -- see
 * PRIOR_REJECTION_JOIN in results.js. A reopened GRN reads as unsent, so
 * without this nothing on the row would say it had been round once already.
 */
const PRIOR_REJECTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT h.reject_remarks, h.rejected_at, h.superseded_at
    FROM ph_csd_rejection_history h
    WHERE h.dpr_no_key = g.dpr_no_key AND h.unit_key = g.unit_key
    ORDER BY h.superseded_at DESC, h.id DESC
    LIMIT 1
  ) pr ON TRUE`;

const ROW_COLUMNS = `
  SELECT ${ROW_STATUS} AS status, r.bill_no_match, r.discrepancy_notes,
         (${BEFORE_ACCOUNTS} AND r.matched_ageing_id IS NOT NULL) AS ageing_ahead_of_bpad,
         g.id AS grn_id, g.batch_id AS grn_batch_id, g.source_row_no AS grn_row_no,
         g.dpr_no, g.dpr_date, g.bill_no, g.bill_date,
         g.vendor_code, g.focus_code, g.vendor_name, g.total_amount, g.location, g.unit_key, g.purchase_type,
         a.grn_no       AS ageing_grn_no,
         a.grn_doc      AS ageing_grn_doc,
         a.bill_no      AS ageing_bill_no,
         a.vendor_name  AS ageing_vendor_name,
         a.vendor_code  AS ageing_vendor_code,
         a.division     AS ageing_division,
         a.division_code,
         a.net_amt, a.adj_pur_return, a.adjusted_jv, a.tds_jv,
         ${PAYABLE_AMOUNT} AS payable_amount,
         a.payment_doc_no, a.cheque_no, a.chq_date, a.payment_amt, a.balance,
         ${STORED_CHEQUE_NO} AS stored_cheque_no,
         ${ACCOUNT_NO} AS account_no,
         ${BRANCH_DIVISION_CODE} AS branch_division_code,
         ${CHEQUE_COLUMNS},
         ${CHEQUE_EXEMPT} AS cheque_exempt,
         (${PROGRESS.CASH_PAYMENT}) AS cash_payment,
         pb.pending_with_dept      AS bpad_pending_with_dept,
         pb.pending_with_user      AS bpad_pending_with_user,
         pb.bpad_received_date     AS bpad_received_date,
         pb.accounts_received_date AS bpad_accounts_received_date,
         COALESCE(pb.in_register, FALSE) AS in_bpad,
         (c.id IS NOT NULL)        AS csd_sent,
         c.id                      AS csd_dispatch_id,
         c.sent_at                 AS csd_sent_at,
         c.stage                   AS csd_stage,
         c.reject_remarks          AS csd_reject_remarks,
         c.accounts_stage          AS csd_accounts_stage,
         c.forwarded_to            AS csd_forwarded_to,
         c.forwarded_route         AS csd_forwarded_route,
         c.forwarded_name          AS csd_forwarded_name,
         c.forwarded_mobile        AS csd_forwarded_mobile,
         c.forwarded_date          AS csd_forwarded_date,
         c.forwarded_courier_name  AS csd_forwarded_courier_name,
         c.forwarded_docket_no     AS csd_forwarded_docket_no,
         c.forwarded_remarks       AS csd_forwarded_remarks,
         (rd.id IS NOT NULL)       AS records_sent,
         rd.id                     AS records_id,
         rd.sent_at                AS records_sent_at,
         pr.reject_remarks         AS prior_reject_remarks,
         pr.rejected_at            AS prior_rejected_at,
         pr.superseded_at          AS prior_reopened_at`;

/** The rows' FROM: the results, each with its last rejection. */
const ROW_JOINS = `
  ${RESULT_JOINS}
  ${PRIOR_REJECTION_JOIN}`;

/**
 * The Vendor Master's three lookups ride on this select and not on
 * ROW_COLUMNS, which the Cheque view also builds on: that one reads every row
 * before it folds them into cheques, so it asks afterwards, once per cheque
 * listed -- see chequeRows.
 */
const ROW_SELECT = `${ROW_COLUMNS}, ${vendorColumns(VENDOR_CODE)} ${ROW_JOINS}`;

/** In the order the purchase register lists them, upload by upload. */
const ROW_ORDER = 'ORDER BY g.batch_id, g.source_row_no NULLS LAST, g.id';

function mapRow(r) {
  return {
    id: r.grn_id,
    // The upload the GRN row came in, which a handover to CSD is filed with.
    batchId: r.grn_batch_id,
    // The verdict the row is shown under -- pending while it is still at the
    // GRN store (ROW_STATUS). ageingAheadOfBpad marks the ones held there that
    // the Vendor Age report already lists, so the page can say so.
    status: r.status,
    ageingAheadOfBpad: r.ageing_ahead_of_bpad ?? false,
    // The GRN, as the purchase register has it. dprNo is FeedNo -- the name
    // the hospital rows use for the GRN number, kept so the two read alike.
    dprNo: r.dpr_no,
    dprDate: r.dpr_date,
    billNo: r.bill_no,
    billDate: r.bill_date,
    vendorCode: r.vendor_code,
    focusCode: r.focus_code,
    vendorName: r.vendor_name,
    // The vendor's MSME No, MSME Status, Inter and Supply Type, off the Vendor
    // Master by its Focus code -- see VENDOR_CODE.
    ...vendorFields(r),
    totalAmount: r.total_amount,
    // Unit Name, and the register's Type column -- shown as Purchase Type.
    // unitKey is the unit as the GRN is known by it -- what narrows a cheque's
    // bills to this unit's (see phResultRows).
    location: r.location,
    unitKey: r.unit_key,
    purchaseType: r.purchase_type,
    // The Vendor Age row it is matched to. ageingGrnNo is the GRN number taken
    // out of GRNDoc, which is beside it whole.
    ageingGrnNo: r.ageing_grn_no,
    ageingGrnDoc: r.ageing_grn_doc,
    ageingBillNo: r.ageing_bill_no,
    ageingVendorName: r.ageing_vendor_name,
    ageingVendorCode: r.ageing_vendor_code,
    ageingDivision: r.ageing_division,
    divisionCode: r.division_code,
    // The branch's configured code -- for a pending row, which has no ageing
    // DivisionCode. Null when no configured branch claims the row.
    branchDivisionCode: r.branch_division_code ?? null,
    netAmt: r.net_amt,
    adjPurReturn: r.adj_pur_return,
    adjustedJv: r.adjusted_jv,
    tdsJv: r.tds_jv,
    payableAmount: r.payable_amount,
    paymentDocNo: r.payment_doc_no,
    chequeNo: r.cheque_no,
    // The cheque the Vendor Age report puts the bill on, there even while the
    // GRN is held before Accounts and chequeNo is blank. For gathering a
    // cheque's bills from a held row only (chequeGroup on the page); never
    // shown or exported -- a held GRN has no cheque to its name.
    storedChequeNo: r.stored_cheque_no ?? null,
    chqDate: r.chq_date,
    paymentAmt: r.payment_amt,
    balance: r.balance,
    // No cheque is meant for this bill -- a cash bill. See CHEQUE_EXEMPT.
    chequeExempt: r.cheque_exempt ?? false,
    // A cash bill in Accounts: a cash purchase with no cheque to its name,
    // paid or still to be -- the Cash Payments card's rows. See CASH_BILL.
    cashPayment: r.cash_payment ?? false,
    // The account this row's branch banks through, off Ph-Configuration.
    accountNo: r.account_no ?? null,
    // The bank statement's answer on the cheque. Null when no statement carries
    // the number, which is not the same as "not cleared".
    chequeStatus: r.cheque_status ?? null,
    chequeClearedOn: r.cheque_cleared_on ?? null,
    chequeTxnCount: r.cheque_txn_count ?? 0,
    billNoMatch: r.bill_no_match,
    discrepancyNotes: r.discrepancy_notes,
    // The BPAD status's answer: whose desk the bill is on, and its two dates.
    // inBpad is false where the status has no entry for the GRN.
    inBpad: r.in_bpad ?? false,
    pendingWithDept: r.bpad_pending_with_dept ?? null,
    pendingWithUser: r.bpad_pending_with_user ?? null,
    bpadReceivedDate: r.bpad_received_date ?? null,
    accountsReceivedDate: r.bpad_accounts_received_date ?? null,
    // The handover to CSD, if the GRN has been sent -- see RESULT_JOINS. The
    // dispatch id is what taking it back addresses; the stage is CSD's own
    // progress, and the remarks why they rejected it, where they have.
    csdSent: r.csd_sent ?? false,
    csdDispatchId: r.csd_dispatch_id ?? null,
    csdSentAt: r.csd_sent_at ?? null,
    csdStage: r.csd_stage ?? null,
    csdRejectRemarks: r.csd_reject_remarks ?? null,
    // Accounts' own acknowledgement once CSD hand a GRN back, and where they
    // sent it on to -- see routes/phAccountsReturns.js. Null until csdStage
    // reaches MOVED_TO_ACCOUNTS; Route only for VENDOR, Name/Mobile/Date for
    // VENDOR and OTHERS, CourierName/DocketNo for COURIER, Remarks for OTHERS.
    csdAccountsStage: r.csd_accounts_stage ?? null,
    csdForwardedTo: r.csd_forwarded_to ?? null,
    csdForwardedRoute: r.csd_forwarded_route ?? null,
    csdForwardedName: r.csd_forwarded_name ?? null,
    csdForwardedMobile: r.csd_forwarded_mobile ?? null,
    csdForwardedDate: r.csd_forwarded_date ?? null,
    csdForwardedCourierName: r.csd_forwarded_courier_name ?? null,
    csdForwardedDocketNo: r.csd_forwarded_docket_no ?? null,
    csdForwardedRemarks: r.csd_forwarded_remarks ?? null,
    // The last time CSD rejected this GRN before whatever it is doing now --
    // null where they never have. See PRIOR_REJECTION_JOIN.
    priorRejection: r.prior_rejected_at
      ? {
          remarks: r.prior_reject_remarks ?? null,
          rejectedAt: r.prior_rejected_at,
          reopenedAt: r.prior_reopened_at,
        }
      : null,
    // Filed to Records, the other destination -- the record's id is what
    // taking it back addresses. See routes/phRecords.js.
    recordsSent: r.records_sent ?? false,
    recordsId: r.records_id ?? null,
    recordsSentAt: r.records_sent_at ?? null,
  };
}

/**
 * The columns the search box looks in: the GRN, the bill and the vendor on
 * both sides of the match, and the cheque -- results.js's SEARCH_COLUMNS, with
 * the document reference the GRN number was taken from.
 */
const SEARCH_COLUMNS = [
  'g.vendor_name',
  'g.vendor_code',
  'g.focus_code',
  'g.dpr_no',
  'g.bill_no',
  'a.vendor_name',
  'a.vendor_code',
  'a.grn_no',
  'a.grn_doc',
  'a.bill_no',
  'a.cheque_no',
];

function searchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/* --------------------------------------------------------------------------
   The answers, each as a function of something that can run a query -- the
   pool for a request, or one connection for a check that has to see what it
   has only just written. None writes.

   They answer in the shapes results.js answers in -- the summary's buckets,
   `progress`, `csd`, `bpad` and `pendingDepartments`; the rows' paging and
   `actionCounts`; the BPAD view's `departments` and `notIntegrated` -- so that
   Pharmacy Results can read its cards, its dropdowns and its figures with the
   helpers the hospital page reads its own with (services/resultsViews.js on
   the client).
   -------------------------------------------------------------------------- */

/** The pool, in the shape the functions below take. */
const POOL = { query };

/** The rows endpoint's Cheque view, as the `view` query parameter spells it. */
const CHEQUE_VIEW = 'cheque';

/**
 * The page's scope, as clauses: the search box, the ticked branches, the
 * account's own branch grant and the Location dropdown's choice within it.
 * Every figure and every row is taken inside it, so the cards describe one
 * population throughout -- results.js's searchFilter, BRANCH_SCOPE and
 * branchClauses, together.
 */
function scopeClauses({ q, grant, location, msme }, params) {
  return [
    searchFilter(q, params),
    BRANCH_SCOPE,
    branchPick(grant, params),
    branchPick(location, params),
    // MSME or Non-MSME vendors -- a scope like Location: every card, count and
    // export follows it. No parameter; see msmeFilter.
    msmeFilter(msme, VENDOR_CODE),
  ];
}

/**
 * One cheque's bills, matched exactly where the search matches the same column
 * loosely -- what Send to CSD reads to gather the rest of a cheque before it
 * hands it over (results.js's chequeFilter). `unitKey` narrows that to one
 * unit's: a cheque number is only one cheque within the account it is drawn
 * on, and two units' accounts can each have issued the same number.
 *
 * By the cheque the Vendor Age report puts the bill on, held before Accounts
 * or not (STORED_CHEQUE_NO): a bill that went to CSD with its cheque and has
 * since been held still has to come back, be received and be sent on with the
 * rest of it. What may be done to each bill is then the page's to decide, by
 * the row -- a held one cannot be sent, having no cheque on it to hand over.
 */
function chequeFilters({ chequeNo, unitKey }, params) {
  const clauses = [];
  const cheque = String(chequeNo || '').trim();
  if (cheque) {
    params.push(cheque);
    clauses.push(`${STORED_CHEQUE_NO} = $${params.length}`);
  }
  const unit = String(unitKey || '').trim();
  if (unit) {
    params.push(unit);
    clauses.push(`g.unit_key = $${params.length}`);
  }
  return clauses;
}

/* --------------------------------------------------------------------------
   The BPAD bill status's own rows -- the BPAD view. results.js's BPAD section,
   against ph_bpad_records.
   -------------------------------------------------------------------------- */

/**
 * A status row's branch: the unit of the GRN it was matched to, which is
 * stored on it (unit_key). It has no DivisionCode of its own to be placed by.
 */
const BPAD_KEYS = { divisionKey: "''", unitKey: 'b.unit_key' };
const BPAD_BRANCH_SCOPE = phBranchScope(BPAD_KEYS);
const bpadBranchPick = phBranchPick(BPAD_KEYS);

/** The status's own entries only: a row written for a GRN it had no entry for is not in BPAD. */
const BPAD_IN_REGISTER = 'b.in_register';

const BPAD_SEARCH_COLUMNS = ['b.vendor_name', 'b.vendor_code', 'b.grn_no', 'b.inv_no'];

function bpadSearchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${BPAD_SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/**
 * The Focus code of the GRN a status row was matched to -- the code the Vendor
 * Master knows its vendor by. The status itself carries the PM Code only, so
 * it is read off the GRN the row is stored under (number and unit; one row at
 * most). Null where that GRN is no longer on file.
 */
const BPAD_VENDOR_CODE = `(
    SELECT bg.focus_code FROM ph_grn_transactions bg
     WHERE bg.dpr_no_key = b.grn_no_key AND bg.unit_key = b.unit_key
     LIMIT 1
  )`;

/** The ticked branches, the account's grant, the Location dropdown and the MSME one, for the status's rows. */
function bpadScopeClauses({ grant, location, msme }, params) {
  return [
    BPAD_BRANCH_SCOPE,
    bpadBranchPick(grant, params),
    bpadBranchPick(location, params),
    msmeFilter(msme, BPAD_VENDOR_CODE),
  ];
}

/*
 * Not Integrated in Accounts: the bills the status says Accounts has received
 * that the Vendor Age report -- the Accounts system's own list -- has no GRN
 * for. The desk is matched as the hospital page matches it (isAccountsDept on
 * the client): the word at the start of Pending With Dept., any case, with no
 * letter after it.
 *
 * The ageing side is the GRN number AND the division, as everywhere here: a
 * row under the number counts only where its DivisionCode is the Branch code
 * of the branch the status row's unit belongs to. Another unit's document of
 * the same number is not this bill reaching accounts.
 */
const BPAD_AT_ACCOUNTS = atAccountsDesk('b.pending_with_dept');
const BPAD_NOT_IN_AGEING = `NOT EXISTS (
    SELECT 1
      FROM ph_vendor_ageing na
      JOIN ph_branch_configs nb ON ${folded('nb.branch_code')} = na.division_key
     WHERE na.grn_number_key = b.grn_no_key
       AND na.division_key <> ''
       AND ${folded('nb.location')} = b.unit_key
  )`;

/** `yyyy-MM-dd`, a real calendar day -- isIsoDay in results.js. */
function isIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** The Not Integrated rows as SQL, from `from` (an Accounts Received Date) where one is given. */
function bpadNotIntegratedFilter(from, params) {
  const clauses = [BPAD_AT_ACCOUNTS, BPAD_NOT_IN_AGEING];
  if (from) {
    params.push(from);
    clauses.push(`b.accounts_received_date >= $${params.length}`);
  }
  return `(${clauses.join(' AND ')})`;
}

/**
 * The status's rows with the branch each belongs to -- its configured Branch
 * code and Unit name, off the unit the row was stored under.
 */
const BPAD_ROW_SELECT = `
  SELECT b.id, b.sl_no, b.location, b.warehouse, b.vendor_code, b.vendor_name,
         b.inv_no, b.inv_date, b.grn_no, b.grn_date, b.grn_amount, b.po_number, b.po_date,
         b.pending_with_dept, b.bpad_received_date, b.accounts_received_date,
         b.pending_with_user, b.pend_reason,
         br.branch_code AS branch_division_code,
         br.location    AS unit_name,
         (${BPAD_AT_ACCOUNTS} AND ${BPAD_NOT_IN_AGEING}) AS not_integrated,
         ${vendorColumns(BPAD_VENDOR_CODE)}
  FROM ph_bpad_records b
  LEFT JOIN LATERAL (
    SELECT bc.branch_code, bc.location
    FROM ph_branch_configs bc
    WHERE b.unit_key <> '' AND ${folded('bc.location')} = b.unit_key
    ORDER BY bc.id
    LIMIT 1
  ) br ON TRUE`;

function mapBpadRow(r) {
  return {
    id: r.id,
    slNo: r.sl_no,
    // The status's own Location code ("SBD1"), and the branch it is: the
    // configured Branch code and the Unit name of the GRN's unit.
    location: r.location,
    branchDivisionCode: r.branch_division_code ?? null,
    unitName: r.unit_name ?? null,
    warehouse: r.warehouse,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    // The Vendor Master's four, by the Focus code of the row's GRN.
    ...vendorFields(r),
    invNo: r.inv_no,
    invDate: r.inv_date,
    grnNo: r.grn_no,
    grnDate: r.grn_date,
    grnAmount: r.grn_amount,
    poNumber: r.po_number,
    poDate: r.po_date,
    pendingWithDept: r.pending_with_dept,
    bpadReceivedDate: r.bpad_received_date,
    accountsReceivedDate: r.accounts_received_date,
    pendingWithUser: r.pending_with_user,
    pendReason: r.pend_reason,
    // At Accounts in the status, with no GRN in the Vendor Age report.
    bpadNotIntegrated: r.not_integrated ?? false,
  };
}

/**
 * The status's coverage of the GRNs in scope -- bpadSummary in results.js.
 * `onFile` is every row stored, whatever the search box says: what the page
 * reads to tell whether a status has been uploaded for these GRNs at all.
 * `inRegister` is the status's own entries the search matches -- the BPAD
 * card's figure, and the rows the BPAD view lists.
 */
async function bpadSummary(db, scope) {
  const params = [];
  const where = whereFrom(bpadScopeClauses(scope, params));
  const matches = bpadSearchFilter(scope.q, params) ?? 'TRUE';
  const { rows } = await db.query(
    `SELECT (COUNT(*) FILTER (WHERE ${matches} AND b.in_register))::int AS in_register_count,
            COALESCE(SUM(b.grn_amount) FILTER (WHERE ${matches} AND b.in_register), 0) AS in_register_amount,
            COUNT(*)::int AS on_file
     FROM ph_bpad_records b
     ${where}`,
    params,
  );
  return {
    onFile: rows[0]?.on_file ?? 0,
    inRegister: { count: rows[0]?.in_register_count ?? 0, amount: Number(rows[0]?.in_register_amount ?? 0) },
  };
}

/**
 * The BPAD view: the status's own rows for the GRNs in scope, the desks they
 * name, and the Not Integrated in Accounts card's figure -- GET /:id/bpad in
 * results.js, answer for answer.
 *
 * `dept` narrows the rows to one desk; `notIntegrated` to that card's bills,
 * from `accountsFrom` where a date is given. The desks follow the branch and
 * nothing else, so the dropdown built from them does not reshuffle as a search
 * is typed; the card's figure follows the search too, since its number has to
 * be the rows pressing it shows. `all` drops the pagination, for the export.
 */
export async function phBpadRows(
  db,
  { q, grant, location, msme, dept, notIntegrated = false, accountsFrom = '', all = false, page = 1, pageSize = 50 } = {},
) {
  const scope = { q, grant, location, msme };
  const from = String(accountsFrom || '').trim();

  const params = [];
  const desk = String(dept || '').trim();
  const clauses = [bpadSearchFilter(q, params), BPAD_IN_REGISTER, ...bpadScopeClauses(scope, params)];
  if (desk) {
    params.push(desk.toUpperCase());
    clauses.push(`${deskKey('b.pending_with_dept')} = $${params.length}`);
  }
  if (notIntegrated) clauses.push(bpadNotIntegratedFilter(from, params));
  const where = whereFrom(clauses);
  const order = 'ORDER BY b.batch_id, b.source_row_no NULLS LAST, b.id';

  const deptParams = [];
  const deptWhere = whereFrom([
    BPAD_IN_REGISTER,
    ...bpadScopeClauses(scope, deptParams),
    `COALESCE(${deskKey('b.pending_with_dept')}, '') <> ''`,
  ]);

  const cardParams = [];
  const cardWhere = whereFrom([
    bpadSearchFilter(q, cardParams),
    bpadNotIntegratedFilter(from, cardParams),
    BPAD_IN_REGISTER,
    ...bpadScopeClauses(scope, cardParams),
  ]);

  const [{ rows: countRows }, { rows }, { rows: deptRows }, { rows: cardRows }] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total FROM ph_bpad_records b ${where}`, params),
    all
      ? db.query(`${BPAD_ROW_SELECT} ${where} ${order}`, params)
      : db.query(
          `${BPAD_ROW_SELECT} ${where} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, (page - 1) * pageSize],
        ),
    db.query(
      `SELECT ${deskKey('b.pending_with_dept')} AS dept, COUNT(*)::int AS count, COALESCE(SUM(b.grn_amount), 0) AS amount
       FROM ph_bpad_records b ${deptWhere}
       GROUP BY 1
       ORDER BY 1`,
      deptParams,
    ),
    // `grns` beside `count` because the status can repeat a GRN: the table
    // lists rows, and the question asked of the card is how many GRNs.
    db.query(
      `SELECT COUNT(*)::int AS count,
              COUNT(DISTINCT (b.unit_key, b.grn_no_key))::int AS grns,
              COALESCE(SUM(b.grn_amount), 0) AS amount
       FROM ph_bpad_records b ${cardWhere}`,
      cardParams,
    ),
  ]);

  const total = countRows[0].total;
  return {
    ...(all ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    total,
    departments: deptRows.map((d) => ({ dept: d.dept, count: d.count, amount: Number(d.amount) })),
    notIntegrated: {
      count: cardRows[0]?.count ?? 0,
      grns: cardRows[0]?.grns ?? 0,
      amount: Number(cardRows[0]?.amount ?? 0),
      // Which date the figure was counted from, so the card can say so.
      accountsFrom: from || null,
    },
    rows: rows.map(mapBpadRow),
  };
}

/* --------------------------------------------------------------------------
   The summary and the reconciliation rows.
   -------------------------------------------------------------------------- */

/**
 * The figures the cards and the View dropdown read, over one scope -- the
 * search, the ticked branches, the account's own grant and the Location
 * dropdown: how many GRNs stand at each verdict and what they come to; how
 * many each Status value would show (`progress`), and each CSD stage with the
 * cheques its GRNs are spread across (`csd`); how many cheques the prepared
 * ones are spread across; the BPAD status's own figures; and where the pending
 * ones are pending.
 *
 * A cheque is counted as its number within its unit, here as on the CSD queue.
 */
export async function phSummary(db, { q, grant, location, msme } = {}) {
  const scopeOf = { q, grant, location, msme };
  // Every query below adds its own clause to the one scope and binds the same
  // parameters.
  const params = [];
  const scope = scopeClauses(scopeOf, params);
  const where = whereFrom(scope);
  const run = (text, values) => db.query(text, values);

  const [status, progress, cheques, csdRows, depts, bpad, uploads, branches, supply] = await Promise.all([
    run(
      `SELECT ${ROW_STATUS} AS status, COUNT(*)::int AS count, COALESCE(SUM(g.total_amount), 0) AS amount
       ${RESULT_JOINS} ${where}
       GROUP BY 1`,
      params,
    ),
    // FILTER aggregates rather than a GROUP BY, because the buckets overlap:
    // a cleared cheque is a prepared one too, and may be sitting at CSD.
    run(
      `SELECT ${PROGRESS_KEYS.map(
        (key) =>
          `(COUNT(*) FILTER (WHERE ${CARD_PROGRESS[key]}))::int AS ${key.toLowerCase()}_count,
           COALESCE(SUM(g.total_amount) FILTER (WHERE ${CARD_PROGRESS[key]}), 0) AS ${key.toLowerCase()}_amount`,
      ).join(', ')},
       -- How many cheques the Accounts queue's GRNs are spread across, and the
       -- ones Accounts have received and not yet sent on: a cheque is handed
       -- back from CSD as one thing. For the two Accounts cards.
       (COUNT(DISTINCT (g.unit_key, a.cheque_no)) FILTER (
          WHERE ${PROGRESS.RETURNED_BY_CSD} AND COALESCE(a.cheque_no, '') <> ''
       ))::int AS accounts_queue_cheques,
       (COUNT(DISTINCT (g.unit_key, a.cheque_no)) FILTER (
          WHERE ${PROGRESS.ACCOUNTS_RECEIVED} AND COALESCE(a.cheque_no, '') <> ''
       ))::int AS accounts_received_cheques,
       -- Of the cash bills, the ones already paid -- for the Cash Payments card
       -- to say how many of its GRNs are paid and how many are still to be.
       (COUNT(*) FILTER (WHERE (${PROGRESS.CASH_PAYMENT}) AND ${PAYMENT_PREPARED}))::int AS cash_paid_count,
       -- The handovers of GRNs that are not in Accounts -- a view of their own.
       (COUNT(*) FILTER (WHERE ${HELD_HANDOVER_SQL}))::int AS held_handover_count,
       COALESCE(SUM(g.total_amount) FILTER (WHERE ${HELD_HANDOVER_SQL}), 0) AS held_handover_amount
       ${RESULT_JOINS} ${where}`,
      params,
    ),
    // How many cheques the prepared GRNs are spread across: one cheque pays a
    // group of bills. The non-empty clause is said on purpose -- a bill can
    // count as prepared on its payment document or cheque date alone.
    run(
      `SELECT COUNT(DISTINCT (g.unit_key, a.cheque_no))::int AS cheques
       ${RESULT_JOINS}
       ${whereFrom([...scope, `(${PROGRESS.CHEQUE_PREPARED})`, `COALESCE(a.cheque_no, '') <> ''`])}`,
      params,
    ),
    // How many of the GRNs in scope sit at each CSD stage, and across how many
    // cheques -- the csd query in results.js. Amounts from the GRN, as the
    // verdict cards', so the row measures value one way. Of the GRNs in
    // Accounts, which is where these cards stand and what pressing one lists
    // -- see CARD_PROGRESS.
    run(
      `SELECT c.stage,
              COUNT(*)::int AS count,
              COUNT(DISTINCT (g.unit_key, a.cheque_no)) FILTER (WHERE COALESCE(a.cheque_no, '') <> '')::int AS cheques,
              COALESCE(SUM(g.total_amount), 0) AS amount
       ${RESULT_JOINS}
       ${whereFrom([...scope, 'c.id IS NOT NULL', 'a.id IS NOT NULL'])}
       GROUP BY c.stage`,
      params,
    ),
    // Where the pending ones are pending. Sums to the pending count. Largest
    // first, with the "not in BPAD" bucket last whatever its size -- it is
    // the remainder, not a desk.
    run(
      `SELECT ${BPAD_DEPT} AS dept, COUNT(*)::int AS count, COALESCE(SUM(g.total_amount), 0) AS amount
       ${RESULT_JOINS}
       ${whereFrom([...scope, `${ROW_STATUS} = '${STATUS.PENDING}'`])}
       GROUP BY 1
       ORDER BY (${BPAD_DEPT} = '${NOT_IN_BPAD}'), COUNT(*) DESC, 1`,
      params,
    ),
    bpadSummary(db, scopeOf),
    run(
      `SELECT COUNT(*)::int AS count, MAX(uploaded_at) AS last_at,
              COUNT(*) FILTER (WHERE bank_file_name IS NOT NULL)::int AS statements,
              COUNT(*) FILTER (WHERE bpad_file_name IS NOT NULL)::int AS bpad_files
       FROM ph_upload_batches`,
    ),
    run(
      `SELECT branch_code, location, account_no, is_selected
       FROM ph_branch_configs ORDER BY is_selected DESC, upper(branch_code)`,
    ),
    // The Cheque Not Prepared GRNs by their vendor's Supply Type -- the Stents
    // and Regular cards on that section, and NONE for a vendor the Vendor
    // Master has no row for, so the three add up to the section's own card.
    // See chequeNotPreparedSupply in results.js.
    run(
      `SELECT COALESCE(${vendorSupplyType(VENDOR_CODE)}, 'NONE') AS supply_type,
              COUNT(*)::int AS count,
              COALESCE(SUM(g.total_amount), 0) AS amount
       ${RESULT_JOINS}
       ${whereFrom([...scope, `(${PROGRESS.CHEQUE_NOT_PREPARED})`])}
       GROUP BY 1`,
      params,
    ),
  ]);

  const summary = {
    [STATUS.MATCHED]: { count: 0, amount: 0 },
    [STATUS.MATCHED_WITH_DIFF]: { count: 0, amount: 0 },
    [STATUS.PENDING]: { count: 0, amount: 0 },
    [VALID]: { count: 0, amount: 0 },
    total: { count: 0, amount: 0 },
  };
  for (const row of status.rows) {
    summary[row.status] = { count: row.count, amount: Number(row.amount) };
    if (VALID_MEMBERS.includes(row.status)) {
      summary[VALID].count += row.count;
      summary[VALID].amount += Number(row.amount);
    }
    summary.total.count += row.count;
    summary.total.amount += Number(row.amount);
  }

  const p = progress.rows[0] || {};
  summary.progress = Object.fromEntries(
    PROGRESS_KEYS.map((key) => [
      key,
      { count: p[`${key.toLowerCase()}_count`] ?? 0, amount: Number(p[`${key.toLowerCase()}_amount`] ?? 0) },
    ]),
  );
  summary.chequesPrepared = cheques.rows[0]?.cheques ?? 0;

  summary.csd = Object.fromEntries(CSD_STAGES.map((stage) => [stage, { count: 0, cheques: 0, amount: 0 }]));
  for (const row of csdRows.rows) {
    if (summary.csd[row.stage]) {
      summary.csd[row.stage] = { count: row.count, cheques: row.cheques, amount: Number(row.amount) };
    }
  }
  // The two Accounts cards' cheque figures -- their GRN counts and amounts are
  // summary.progress.RETURNED_BY_CSD and .ACCOUNTS_RECEIVED above.
  summary.accountsQueueCheques = p.accounts_queue_cheques ?? 0;
  summary.accountsReceivedCheques = p.accounts_received_cheques ?? 0;
  // How many of summary.progress.CASH_PAYMENT have been paid already (a
  // payment document on the Vendor Age report); the rest are still to be.
  summary.cashPaymentsPaid = p.cash_paid_count ?? 0;
  // Sent to CSD or Records, and not in Accounts -- the figure of the view that
  // lists them, filed as a bucket under the status the rows endpoint takes.
  summary[HELD_HANDOVER] = { count: p.held_handover_count ?? 0, amount: Number(p.held_handover_amount ?? 0) };
  // The Cheque Not Prepared section's Stents / Regular cards. Sums to
  // summary.progress.CHEQUE_NOT_PREPARED.
  summary.chequeNotPreparedSupply = Object.fromEntries(
    [...SUPPLY_TYPE_CHOICES].map((key) => [key, { count: 0, amount: 0 }]),
  );
  for (const row of supply.rows) {
    summary.chequeNotPreparedSupply[row.supply_type] = { count: row.count, amount: Number(row.amount) };
  }

  summary.pendingDepartments = depts.rows.map((d) => ({
    dept: d.dept,
    notInBpad: d.dept === NOT_IN_BPAD,
    count: d.count,
    amount: Number(d.amount),
  }));
  // The status's own figures, under the names the hospital summary files them
  // by: `bpad.onFile` for whether one is on file for these GRNs at all,
  // `bpadRegister` for its own entries -- the BPAD card and the rows its view
  // lists -- and `bpadMissing` for the pending GRNs it has no desk for, the
  // Pending GRNs at GRN Store card, taken from the breakdown above so the
  // card always equals the rows pressing it shows.
  summary.bpad = bpad;
  summary.bpadRegister = bpad.inRegister;
  const atGrnStore = summary.pendingDepartments.find((d) => d.notInBpad);
  summary.bpadMissing = { count: atGrnStore?.count ?? 0, amount: atGrnStore?.amount ?? 0 };

  const up = uploads.rows[0];
  return {
    summary,
    // What is on file at all, so an empty page can say why it is empty.
    uploads: {
      count: up.count,
      lastAt: up.last_at,
      statements: up.statements,
      bpadFiles: up.bpad_files,
    },
    // The branches in scope, so the page can say what it is showing.
    branches: branches.rows.map((b) => ({
      branchCode: b.branch_code,
      location: b.location,
      accountNo: b.account_no,
      isSelected: b.is_selected,
    })),
    // The one branch this account is confined to, by name, or null -- so a
    // page left empty by the grant can say that is why.
    confinedTo: String(grant ?? '').trim() || null,
  };
}

/**
 * The rows' Cheque view: one row per cheque instead of one per GRN --
 * chequeRows in results.js, with a cheque being its number within its unit.
 *
 * Two layers of filtering, deliberately apart, as there: the cheque's own
 * population (verdict, branch) decides which bills make up a cheque and so
 * what it adds up to; the search, the Status, the desk and the Action only
 * decide which cheques are listed. A cheque is shown when ANY of its bills
 * matches, and its amount is still the whole cheque. The rest of the row is
 * one representative bill's: the first matching one in the table's own order.
 */
async function chequeRows(
  db,
  {
    status, progress, action, dept, supplyType, q, grant, location, msme, chequeNo, unitKey,
    all, withActionCounts, page, pageSize,
  },
) {
  const params = [];
  const baseWhere = whereFrom([
    statusFilter(status, params),
    ...chequeFilters({ chequeNo, unitKey }, params),
    BRANCH_SCOPE,
    branchPick(grant, params),
    branchPick(location, params),
    msmeFilter(msme, VENDOR_CODE),
    `COALESCE(a.cheque_no, '') <> ''`,
  ]);
  // Everything that decides whether a bill matches, bar the Action filter --
  // kept apart so the Action filter's own counts can be taken over it.
  const scopeHitClauses = [
    searchFilter(q, params),
    keyedFilter(progress, PROGRESS),
    deskFilter(dept, params),
    supplyTypeFilter(supplyType, VENDOR_CODE),
  ].filter(Boolean);
  const hitClauses = [...scopeHitClauses, keyedFilter(action, ACTIONS)].filter(Boolean);
  // COALESCE because an ILIKE over a null column is null, not false.
  const hit = `COALESCE((${hitClauses.length > 0 ? hitClauses.join(' AND ') : 'TRUE'}), FALSE)`;
  const order = 'z.grn_batch_id, z.grn_row_no NULLS LAST, z.grn_id';

  const [{ rows: countRows }, { rows }, counted] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT 1
         ${RESULT_JOINS} ${baseWhere}
         GROUP BY g.unit_key, a.cheque_no
         HAVING BOOL_OR(${hit})
       ) t`,
      params,
    ),
    // The vendor's Vendor Master details on the outer select, after the fold:
    // it is the representative bill's vendor, looked up once per cheque listed.
    db.query(
      `SELECT z.*, ${vendorColumns('z.focus_code')} FROM (
         SELECT q.*,
                SUM(q.payable_amount) OVER (PARTITION BY q.unit_key, q.cheque_no) AS cheque_amount,
                (COUNT(*) OVER (PARTITION BY q.unit_key, q.cheque_no))::int AS cheque_grn_count,
                ROW_NUMBER() OVER (
                  PARTITION BY q.unit_key, q.cheque_no
                  ORDER BY q.cv_hit DESC, q.grn_batch_id, q.grn_row_no NULLS LAST, q.grn_id
                ) AS cv_rn
         FROM (${ROW_COLUMNS}, ${hit} AS cv_hit ${ROW_JOINS} ${baseWhere}) q
       ) z
       WHERE z.cv_rn = 1 AND z.cv_hit
       ORDER BY ${order}
       ${all ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      all ? params : [...params, pageSize, (page - 1) * pageSize],
    ),
    // How many cheques each Action value would list, with every other filter
    // as it stands. A cheque counts under a value when any of its matching
    // bills is there, which is the same rule that lists it.
    withActionCounts
      ? db.query(
          `SELECT ${ACTION_KEYS.map(
            (key) => `(COUNT(*) FILTER (WHERE t.${key.toLowerCase()}))::int AS ${key.toLowerCase()}`,
          ).join(', ')}
           FROM (
             SELECT ${ACTION_KEYS.map(
               (key) =>
                 `BOOL_OR(COALESCE((${scopeHitClauses.length > 0 ? scopeHitClauses.join(' AND ') : 'TRUE'} AND (${ACTIONS[key]})), FALSE)) AS ${key.toLowerCase()}`,
             ).join(', ')}
             ${RESULT_JOINS} ${baseWhere}
             GROUP BY g.unit_key, a.cheque_no
           ) t`,
          params,
        )
      : null,
  ]);

  const total = countRows[0].total;
  return {
    ...(all ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    total,
    ...(counted ? { actionCounts: actionCountsFrom(counted.rows[0]) } : {}),
    rows: rows.map((r) => ({
      ...mapRow(r),
      // Every PayableAmount the cheque pays, added up, and how many GRNs.
      chequeAmount: r.cheque_amount ?? null,
      chequeGrnCount: r.cheque_grn_count ?? 0,
    })),
  };
}

/**
 * One page of GRNs -- GET /:id/results in results.js, filter for filter.
 *
 * `status` is a verdict, VALID for the two matched ones, or ALL; `progress` is
 * one Status value (see PROGRESS) and `action` one Action value on top of it
 * (see ACTIONS); `dept` is one BPAD desk, or one of the two sentinels (see
 * deskFilter); `chequeNo` with `unitKey` is one cheque's bills. Every filter
 * narrows on top of the others, and all of them inside the page's scope -- the
 * search, the ticked branches, the account's grant and the Location dropdown.
 * The caller has checked `status`, `progress` and `action` are ones this knows.
 *
 * `view` 'cheque' folds the rows into one per cheque (chequeRows). `all` drops
 * the pagination, for the export. `withActionCounts` adds `actionCounts`: how
 * many rows each Action value would leave, with every other filter as it
 * stands -- the numbers beside the Action dropdown's options.
 */
export async function phResultRows(
  db,
  {
    status,
    progress,
    action,
    dept,
    supplyType,
    q,
    grant,
    location,
    msme,
    chequeNo,
    unitKey,
    view,
    all = false,
    withActionCounts = false,
    page = 1,
    pageSize = 50,
  } = {},
) {
  if (String(view || '').toLowerCase() === CHEQUE_VIEW) {
    return chequeRows(db, {
      status, progress, action, dept, supplyType, q, grant, location, msme, chequeNo, unitKey,
      all, withActionCounts, page, pageSize,
    });
  }

  const params = [];
  // Every filter bar the Action one, which is added on top below -- kept apart
  // so the Action dropdown's counts can be taken over the rest.
  const filters = [
    statusFilter(status, params),
    ...scopeClauses({ q, grant, location, msme }, params),
    keyedFilter(progress, PROGRESS_WHERE),
    deskFilter(dept, params),
    // The Cheque Not Prepared section's Stents / Regular cards: the vendor's
    // Supply Type off the Vendor Master. No parameter; see supplyTypeFilter.
    supplyTypeFilter(supplyType, VENDOR_CODE),
    ...chequeFilters({ chequeNo, unitKey }, params),
  ];
  const where = whereFrom([...filters, keyedFilter(action, ACTIONS_WHERE)]);

  const [{ rows: countRows }, { rows }, counted] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total ${RESULT_JOINS} ${where}`, params),
    all
      ? db.query(`${ROW_SELECT} ${where} ${ROW_ORDER}`, params)
      : db.query(
          `${ROW_SELECT} ${where} ${ROW_ORDER}
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, (page - 1) * pageSize],
        ),
    withActionCounts
      ? db.query(
          `SELECT ${ACTION_KEYS.map(
            (key) => `(COUNT(*) FILTER (WHERE ${ACTIONS[key]}))::int AS ${key.toLowerCase()}`,
          ).join(', ')}
           ${RESULT_JOINS} ${whereFrom(filters)}`,
          params,
        )
      : null,
  ]);
  const total = countRows[0].total;

  return {
    ...(all ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    total,
    ...(counted ? { actionCounts: actionCountsFrom(counted.rows[0]) } : {}),
    rows: rows.map(mapRow),
  };
}

/* --------------------------------------------------------------------------
   GRN age: how many days a bill spends at each step. results.js's Turnaround
   section, through the same arithmetic (services/turnaround.js) -- from the
   GRN onward, which is where a pharmacy purchase starts (PHARMACY_CHAIN).
   -------------------------------------------------------------------------- */

/**
 * The checkpoints of one GRN in accounts, under the names services/turnaround.js
 * measures between. A pharmacy purchase has no PR, PO or security date, and the
 * pharmacy Vendor Age report carries none of the hospital report's handover
 * dates, so each checkpoint is read from the file that does have it:
 *
 *   GRN       the GRN Purchase report's InvDate (bill_date). Not its FeedDate,
 *             which the other tables head "GRN Date": the run is measured from
 *             the day on the vendor's invoice.
 *   Audit     the BPAD bill status's BPAD Received Date.
 *   Accounts  the BPAD bill status's Accounts Received Date.
 *   Cheque    the Vendor Age report's ChqDate.
 *
 * and from there on as the hospitals': the stamps this application wrote on the
 * handover (sent to CSD, received, approved, moved to Accounts, received there,
 * forwarded), and the bank statement's clearance.
 *
 * The Vendor Age report's own grn_date and bill_to_audit are not read, even
 * where it has them: one checkpoint read from two files would be two
 * definitions of it under one heading. A unit with no BPAD status on file has
 * no Audit or Accounts date, and the three stages either side are blank.
 *
 * Both BPAD dates are renamed on the way out. `accounts_received_date` in
 * particular is already the handover's own stamp below -- the day Accounts
 * acknowledged a bill CSD handed back -- which is a different day altogether.
 */
const TURNAROUND_DATES = `
         g.bill_date               AS grn_date,
         pb.bpad_received_date     AS bill_to_audit,
         pb.accounts_received_date AS bill_handover_to_acc,
         a.chq_date,
         ${CHEQUE_COLUMNS},
         c.id                          AS csd_id,
         c.sent_at::date               AS sent_to_csd,
         c.received_at::date           AS csd_received,
         c.approved_at::date           AS csd_approved,
         c.rejected_at::date           AS csd_rejected,
         c.moved_to_accounts_at::date  AS moved_to_accounts_date,
         c.accounts_received_at::date  AS accounts_received_date,
         c.forwarded_at::date          AS forwarded_action_date,
         c.stage                       AS csd_stage`;

/** The date fields of a row, as gapsFor, summarise and dataQuality read them. */
function turnaroundDates(r) {
  return {
    grnDate: r.grn_date,
    billToAudit: r.bill_to_audit,
    billHandOverToAcc: r.bill_handover_to_acc,
    chqDate: r.chq_date,
    // From the bank statement, as the cards read it.
    chequeClearanceDate: r.cheque_cleared_on ?? null,
    sentToCsd: r.sent_to_csd,
    csdReceived: r.csd_received,
    csdApproved: r.csd_approved,
    csdRejected: r.csd_rejected,
    movedToAccountsAt: r.moved_to_accounts_date,
    accountsReceivedAt: r.accounts_received_date,
    forwardedAt: r.forwarded_action_date,
  };
}

/**
 * Per-stage statistics over every GRN in accounts in scope, plus one page of
 * the rows -- GET /:id/turnaround in results.js, answer for answer, over the
 * pharmacies' chain. Only a GRN in accounts is measured, as there: one BPAD
 * still has at Audit or Stores has a GRN date and perhaps an Audit one, and is
 * no further along than the Pending GRNs at BPAD view already says.
 *
 * `all` is the export's: every row in scope and no paging, as phBpadRows
 * answers it. The rows are then the population the figures are counted over,
 * so they are read once.
 */
export async function phTurnaround(db, { q, grant, location, msme, page = 1, pageSize = 50, all = false } = {}) {
  const params = [];
  const where = whereFrom([`a.id IS NOT NULL`, ...scopeClauses({ q, grant, location, msme }, params)]);

  const rowsSql = `
       SELECT r.status, g.id AS grn_id, a.id AS ageing_id,
              g.dpr_no, g.bill_date, g.vendor_name, g.vendor_code, g.location, g.total_amount,
              a.division_code, a.net_amt, a.adj_pur_return, a.adjusted_jv, a.tds_jv,
              ${PAYABLE_AMOUNT} AS payable_amount,
              a.grn_doc, a.grn_no, a.bill_no, a.cheque_no, a.payment_doc_no,
              ${TURNAROUND_DATES},
              ${vendorColumns(VENDOR_CODE)}
       ${RESULT_JOINS} ${where} ${ROW_ORDER}`;

  let population;
  let rows;
  if (all) {
    ({ rows } = await db.query(rowsSql, params));
    population = rows;
  } else {
    [{ rows: population }, { rows }] = await Promise.all([
      db.query(`SELECT a.grn_no, ${TURNAROUND_DATES} ${RESULT_JOINS} ${where}`, params),
      db.query(`${rowsSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
        ...params,
        pageSize,
        (page - 1) * pageSize,
      ]),
    ]);
  }

  const dated = population.map((r) => ({ grnNo: r.grn_no, ...turnaroundDates(r) }));
  const { stages, overall } = summarise(dated, PHARMACY_CHAIN);
  const { era, impossible, backwards } = dataQuality(dated, { chain: PHARMACY_CHAIN });
  const total = dated.length;

  return {
    stages,
    overall,
    quality: {
      era,
      impossible: impossible.length,
      backwards: backwards.length,
      impossibleGrns: impossible.map((r) => r.grnNo),
    },
    ...(all ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    total,
    rows: rows.map((r) => {
      const row = {
        // A pharmacy GRN number is not a key on its own -- two units can share
        // one -- so the table is keyed by the GRN row.
        rowKey: r.grn_id,
        status: r.status,
        ageingId: r.ageing_id,
        dprNo: r.dpr_no,
        // The Focus document, whole, as the CSD queue shows it.
        grnNo: r.grn_doc || r.grn_no,
        billNo: r.bill_no,
        billDate: r.bill_date,
        divisionCode: r.division_code,
        vendorName: r.vendor_name,
        vendorCode: r.vendor_code,
        ...vendorFields(r),
        location: r.location,
        // The purchase register has one amount, NetAmt; the hospital report's
        // transport and add/deduct columns have no counterpart on it.
        billAmount: r.total_amount,
        transportAmount: null,
        addAmount: null,
        dedAmount: null,
        netAmt: r.net_amt,
        adjPurReturn: r.adj_pur_return,
        adjustedJv: r.adjusted_jv,
        tdsJv: r.tds_jv,
        payableAmount: r.payable_amount,
        chequeNo: r.cheque_no,
        paymentDocNo: r.payment_doc_no,
        chequeStatus: r.cheque_status ?? null,
        csdId: r.csd_id,
        csdStage: r.csd_stage,
        ...turnaroundDates(r),
      };
      return { ...row, gaps: gapsFor(row, PHARMACY_CHAIN) };
    }),
  };
}

/** GET /api/op-pharmacy/results/summary?q=&location=&msme= -- see phSummary. */
phResultsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    // The grant is read off the signed-in user, never off the request.
    res.json(
      await phSummary(POOL, {
        q: req.query.q,
        location: req.query.location,
        msme: req.query.msme,
        grant: branchFor(req.user),
      }),
    );
  }),
);

/** GET /api/op-pharmacy/results/turnaround?q=&location=&msme=&page=&pageSize=&all= -- see phTurnaround. */
phResultsRouter.get(
  '/turnaround',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));
    res.json(
      await phTurnaround(POOL, {
        q: req.query.q,
        location: req.query.location,
        msme: req.query.msme,
        grant: branchFor(req.user),
        page,
        pageSize,
        all: String(req.query.all || '') === '1',
      }),
    );
  }),
);

/**
 * GET /api/op-pharmacy/results/bpad?q=&location=&dept=&notIntegrated=&accountsFrom=&page=&pageSize=&all=
 * -- see phBpadRows.
 */
phResultsRouter.get(
  '/bpad',
  asyncHandler(async (req, res) => {
    // A date it cannot count from is refused rather than ignored: ignoring it
    // would quietly widen the card to every date.
    const accountsFrom = String(req.query.accountsFrom ?? '').trim();
    if (accountsFrom && !isIsoDay(accountsFrom)) {
      return res.status(400).json({ error: `Unknown Accounts received date "${accountsFrom}".` });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));

    return res.json(
      await phBpadRows(POOL, {
        q: req.query.q,
        location: req.query.location,
        msme: req.query.msme,
        grant: branchFor(req.user),
        dept: req.query.dept,
        notIntegrated: String(req.query.notIntegrated ?? '').trim() === '1',
        accountsFrom,
        all: String(req.query.all || '') === '1',
        page,
        pageSize,
      }),
    );
  }),
);

/**
 * GET /api/op-pharmacy/results?status=&progress=&action=&actionCounts=&dept=&q=&location=
 *   &chequeNo=&unitKey=&view=&all=&page=&pageSize= -- see phResultRows.
 */
phResultsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status;
    if (status && !isKnownStatus(status)) {
      return res.status(400).json({ error: `Unknown status "${status}".` });
    }

    const progress = String(req.query.progress || '').toUpperCase();
    if (progress && !PROGRESS[progress]) {
      return res.status(400).json({ error: `Unknown status "${req.query.progress}".` });
    }

    const action = String(req.query.action || '').toUpperCase();
    if (action && !ACTIONS[action]) {
      return res.status(400).json({ error: `Unknown action "${req.query.action}".` });
    }

    // Refused when unknown, so a typo cannot quietly list every row.
    const supplyType = String(req.query.supplyType || '').trim().toUpperCase();
    if (supplyType && !SUPPLY_TYPE_CHOICES.has(supplyType)) {
      return res.status(400).json({ error: `Unknown supply type "${req.query.supplyType}".` });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));
    const chequeNo = String(req.query.chequeNo || '').trim();

    return res.json(
      await phResultRows(POOL, {
        status,
        progress,
        action,
        dept: req.query.dept,
        supplyType,
        q: req.query.q,
        location: req.query.location,
        msme: req.query.msme,
        chequeNo,
        unitKey: req.query.unitKey,
        grant: branchFor(req.user),
        view: req.query.view,
        all: String(req.query.all || '') === '1',
        // Never for the Action column's own cheque lookup, which only wants rows.
        withActionCounts: String(req.query.actionCounts || '') === '1' && !chequeNo,
        page,
        pageSize,
      }),
    );
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phResultsRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
