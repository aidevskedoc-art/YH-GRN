import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { STATUS } from '../services/reconcile.js';
import { gapsFor, summarise, dataQuality } from '../services/turnaround.js';
import { normKey } from '../services/normalize.js';
import {
  branchScope,
  bankAccountScope,
  branchAccountNo,
  branchDivisionCode,
  branchPick,
} from '../services/branchScope.js';
import { branchFor } from '../config/screens.js';
import { logActivity } from '../services/activityLog.js';

export const resultsRouter = express.Router();

/*
 * Either screen, not only `results`: the Accounts Department is this screen with two
 * of its five views -- Accounts and the PR-to-Bank ageing -- and reads the same
 * rows from the same endpoints. What it leaves out is decided in the browser,
 * by offering no other view, so there is nothing here to narrow and no second
 * copy of these queries to keep in step. See config/screens.js.
 */
resultsRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

const VALID_STATUSES = new Set(Object.values(STATUS));
const MAX_PAGE_SIZE = 200;

/**
 * The Turnaround tab's identifier. It travels in the same `status` query
 * parameter as the three reconciliation buckets but is not one of them -- it
 * selects a different population entirely -- so it is deliberately kept out of
 * VALID_STATUSES and handled on its own.
 */
const TURNAROUND = 'TURNAROUND';

/**
 * The BPAD tab's identifier. Like TURNAROUND above it travels in the `status`
 * parameter without being a reconciliation bucket: it selects rows from the
 * BPAD register rather than a slice of the reconciliation, so it is kept out
 * of VALID_STATUSES and answered by its own endpoint below.
 */
const BPAD = 'BPAD';

/**
 * The Valid GRNs tab's identifier, and the two stored statuses it covers.
 *
 * A GRN whose number appears in the ageing report has reached accounts whether
 * or not the bill number and vendor spelling agree, so both matched statuses
 * are reported as one bucket. The distinction is still recorded per row -- it
 * travels in `discrepancyNotes` and the two match flags -- so a reviewer can
 * still see which rows disagree; it is no longer a separate population.
 */
const VALID = 'VALID';
const VALID_MEMBERS = [STATUS.MATCHED, STATUS.MATCHED_WITH_DIFF];

/**
 * The Total GRNs tab's identifier: every reconciliation bucket at once.
 *
 * It narrows nothing, so it filters like an absent status -- but it is named
 * rather than sent as a missing parameter, because a tab that is deliberately
 * showing everything and a request that forgot to say which tab it wants are
 * different things, and only one of them should survive a typo.
 *
 * ALL_STATUSES, not ALL: `ALL` below is the every-UPLOAD selection, which
 * travels in the path rather than the query and is a different axis entirely.
 */
const ALL_STATUSES = 'ALL';

/** Is `status` something the results and export endpoints will filter on? */
function isKnownStatus(status) {
  return VALID_STATUSES.has(status) || status === VALID || status === ALL_STATUSES;
}

/**
 * Push the parameters for a status filter and return its SQL, or null when no
 * status was given, or when every bucket was asked for (both meaning every row).
 */
function statusFilter(status, params) {
  if (!status || status === ALL_STATUSES) return null;
  if (status === VALID) {
    params.push(VALID_MEMBERS);
    return `r.status = ANY($${params.length})`;
  }
  params.push(status);
  return `r.status = $${params.length}`;
}

/**
 * The CSD stages, for the summary's per-stage counts. Mirrors STAGES in
 * routes/csd.js, which owns the workflow itself.
 *
 * Filtering the table is no longer done by stage alone -- see PROGRESS below,
 * which covers everything the Status column can say.
 */
const CSD_STAGES = ['QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED'];

/**
 * The configured branch filter, against this file's two joins: the ageing row's
 * DivisionCode and the GRN row's Location. Every query below carries it, so a
 * branch ticked on the configuration screen narrows the tabs, the stat cards,
 * the exports and the turnaround statistics together rather than one of them at
 * a time. No branch ticked means no narrowing -- see services/branchScope.js.
 */
const BRANCH_SCOPE = branchScope({ divisionCode: 'a.division_code', location: 'g.location' });

/**
 * The Location dropdown, as a clause. One configured branch, read off the same
 * two columns the scope above reads -- see branchPick. Applied beside
 * BRANCH_SCOPE rather than instead of it, so choosing a location narrows what
 * the tick boxes allow and can never widen it.
 */
const LOCATION_FILTER = branchPick({ divisionCode: 'a.division_code', location: 'g.location' });

/**
 * The branch narrowings every query on this router carries, in order.
 *
 * Two clauses from the same builder, doing two different jobs. The first is the
 * account's own grant -- one branch, or nothing at all for an unrestricted
 * account -- and it is a permission: it is read off the signed-in user, never
 * off the request, so nothing a browser sends can widen it. The second is the
 * Location dropdown, which is the person choosing what to look at within that.
 *
 * Applied together and never instead of one another, so an account confined to
 * one branch that asks for another gets its own branch AND the other -- which
 * is no rows, and is the right answer.
 *
 * `branchFor` returns null for an administrator, so the first clause simply
 * vanishes for them. See config/screens.js.
 */
function branchClauses(req, params) {
  return [
    LOCATION_FILTER(branchFor(req.user), params),
    LOCATION_FILTER(req.query.location, params),
  ];
}

/**
 * The configured bank account of the branch a row belongs to, resolved the same
 * way the filter above resolves the branch. See branchAccountNo.
 */
const BRANCH_ACCOUNT_NO = branchAccountNo({
  divisionCode: 'a.division_code',
  location: 'g.location',
});

/**
 * The configured branch code (DivisionCode) of the branch a row belongs to,
 * resolved off the configuration screen the same way BRANCH_ACCOUNT_NO is --
 * see branchDivisionCode. Chiefly for a Pending row, which has no ageing
 * DivisionCode of its own to show.
 */
const BRANCH_DIVISION_CODE = branchDivisionCode({
  divisionCode: 'a.division_code',
  location: 'g.location',
});

/**
 * The columns the search box looks in: the three a transaction is looked up by,
 * on both sides of the match, plus the cheque it was paid by. The two systems
 * spell vendor names differently and number the GRN differently again, so
 * either side's spelling is a legitimate thing to type.
 */
const SEARCH_COLUMNS = [
  'g.vendor_name',
  'g.dpr_no',
  'g.bill_no',
  'a.vendor_name',
  'a.grn_no',
  'a.grn_number',
  'a.bill_no',
  // The cheque a bill was paid by. Only the ageing side has it, so it can only
  // ever match a GRN that reached accounts -- which is the population anyone
  // searching by cheque is asking about anyway.
  'a.cheque_no',
];

/**
 * Push the parameter for the search filter and return its SQL, or null when
 * nothing was typed.
 *
 * `%`, `_` and `\` are escaped, so a bill number containing one is searched for
 * literally instead of being read as a wildcard.
 */
function searchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/**
 * PayableAmount, with the source sheet's blank zeros filled in.
 *
 * The ageing report writes nothing at all when a bill nets to zero -- 266 of
 * this batch's 3,200 rows -- so the column arrived full of empty cells that
 * read as missing data rather than as "nothing left to pay". PayableAmount is
 * NetAmt less the three adjustments, an identity that holds exactly on all
 * 2,934 rows that do carry a value, so a blank is recomputed from them instead
 * of being passed through.
 *
 * Guarded on NetAmt: a row with no NetAmt either is one of the extra payment
 * rows a split-paid GRN repeats across, which carries no amounts at all. That
 * is genuinely absent rather than zero, and stays blank.
 */
const PAYABLE_AMOUNT = `
  COALESCE(
    a.payable_amount,
    CASE WHEN a.net_amt IS NOT NULL THEN
      a.net_amt - COALESCE(a.adj_pur_return, 0) - COALESCE(a.adjusted_jv, 0) - COALESCE(a.tds_jv, 0)
    END
  )`;

/**
 * The bank statement's verdict on a GRN's cheque, matched by number.
 *
 * A cheque leaves the account as a WITHDRAWAL. When it bounces the money comes
 * back as a DEPOSIT under the same number, and when it is re-presented it goes
 * out again. So the state is not a count of anything -- it is whichever way the
 * money moved LAST:
 *
 *   W                -> cleared
 *   W, D             -> returned
 *   W, D, W          -> cleared (re-presented and paid)
 *   W, D, W, D       -> returned again
 *
 * Cleared on is the value date of the latest withdrawal: the day the bank
 * actually parted with the money, which is what the turnaround report measures
 * the cheque stage to.
 *
 * Not scoped to a batch. A cheque written in April often clears in May, so it
 * is matched against every statement uploaded rather than only the one that
 * came in beside this month's reports.
 *
 * '000000' is excluded: it is what the statement writes in the reference column
 * for a transfer or a charge -- 236 rows of this month's -- and it is not a
 * cheque number that anything should match on.
 *
 * A hand-corrected date wins over all of it. That is what makes the clearance
 * cell on the span page editable: the statement is the default answer, not the
 * only one, and clearing the correction hands the question back to it.
 *
 * LEFT JOIN LATERAL over aggregates, so it always yields exactly one row and
 * can never multiply a result or inflate a count.
 */
const BANK_ACCOUNT_SCOPE = bankAccountScope('bt.batch_id');

const CHEQUE_MATCH = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS txn_count,
           (ARRAY_AGG(
              CASE WHEN COALESCE(bt.withdrawal_amt, 0) > 0 THEN 'W' ELSE 'D' END
              ORDER BY bt.txn_date DESC, bt.id DESC
            ))[1] AS last_movement,
           MAX(bt.value_date) FILTER (WHERE COALESCE(bt.withdrawal_amt, 0) > 0) AS cleared_on
    FROM bank_statement_transactions bt
    WHERE bt.extracted_cheque_no = a.cheque_no
      AND bt.extracted_cheque_no <> '000000'
      -- ...and, once branches are configured with account numbers, only from
      -- statements for those accounts. See bankAccountScope.
      AND ${BANK_ACCOUNT_SCOPE}
  ) chq ON TRUE`;

/**
 * The day the cheque cleared: the hand correction if there is one, else the
 * statement's own answer, and null when the bank has not paid it out.
 *
 * Its own constant because two things need it and one of them is a WHERE
 * clause, which cannot see the `cheque_cleared_on` alias the SELECT gives it.
 */
const CHEQUE_CLEARED_ON = `
         COALESCE(
           a.cheque_clearance_override,
           CASE WHEN chq.last_movement = 'W' THEN chq.cleared_on END
         )`;

/** The three columns that verdict produces, for whichever query needs them. */
const CHEQUE_COLUMNS = `
         chq.txn_count AS cheque_txn_count,
         CASE chq.last_movement WHEN 'W' THEN 'CLEARED' WHEN 'D' THEN 'RETURNED' END AS cheque_status,
         ${CHEQUE_CLEARED_ON} AS cheque_cleared_on`;

/* --------------------------------------------------------------------------
   The Status column, as a filter.

   The dropdown beside the search box offers exactly what that column can say --
   Cheque cleared, the four CSD stages, Accounts' own two hand-back steps, the
   four places Accounts can send a GRN on to, Sent to Records, Not sent -- so
   that picking a value asks for the rows showing it, rather than for some
   adjacent idea a reader has to translate.

   The buckets overlap on purpose, because the column does. A GRN whose cheque
   cleared while it was sitting at CSD shows "Cheque cleared" with its stage
   underneath, and it is a true answer to both "which cleared" and "which are
   approved at CSD" -- so both find it. Only NOT_SENT is exclusive, since it is
   defined as the absence of the others: it is what the column says when there
   is nothing else to say.
   -------------------------------------------------------------------------- */
const PROGRESS = {
  CLEARED: `${CHEQUE_CLEARED_ON} IS NOT NULL`,
  /*
   * Whether a cheque has been drawn up for the bill yet.
   *
   * Not a stage anybody records here -- nothing in this system prepares a
   * cheque. It is read off the three columns the ageing report fills in when
   * one has been: the cheque number, the date it was cut, and the payment
   * document reference. Any one of them filled counts, because the report does
   * not fill all three at the same moment, and a bill with a payment document
   * and no cheque number yet has plainly had a cheque prepared.
   *
   * Not the same question as CLEARED above, which is the bank's answer on a
   * cheque that already exists. Prepared is this side of the counter.
   *
   * `a.id IS NOT NULL` on BOTH halves, so a pending GRN falls in neither. It
   * has no ageing entry at all, so "no cheque prepared" would be true of it
   * for a reason that has nothing to do with cheques -- and since a row has an
   * ageing entry exactly when it is one of the Accounts ones, carrying the
   * clause here is what makes the two counts sum to the Accounts figure the
   * cards sit under rather than overshoot it by every pending row on file.
   */
  CHEQUE_PREPARED:
    `a.id IS NOT NULL AND (COALESCE(a.cheque_no, '') <> ''` +
    ` OR a.chq_date IS NOT NULL OR COALESCE(a.payment_doc_no, '') <> '')`,
  CHEQUE_NOT_PREPARED:
    `a.id IS NOT NULL AND COALESCE(a.cheque_no, '') = ''` +
    ` AND a.chq_date IS NULL AND COALESCE(a.payment_doc_no, '') = ''`,
  QUEUED: "c.stage = 'QUEUED'",
  RECEIVED: "c.stage = 'RECEIVED'",
  APPROVED: "c.stage = 'APPROVED'",
  REJECTED: "c.stage = 'REJECTED'",
  // MOVED_TO_ACCOUNTS is CSD's fourth resolution, and Accounts' own hand-back
  // ladder runs on top of it -- see accounts_stage in schema.sql. Not yet
  // forwarded on, so these two are mutually exclusive with the four below.
  RETURNED_BY_CSD: "c.stage = 'MOVED_TO_ACCOUNTS' AND c.accounts_stage = 'QUEUED' AND c.forwarded_to IS NULL",
  ACCOUNTS_RECEIVED: "c.stage = 'MOVED_TO_ACCOUNTS' AND c.accounts_stage = 'RECEIVED' AND c.forwarded_to IS NULL",
  // Where Accounts sent a received GRN on -- see forwardAccountsReturn.
  // Vendor and Purchase Dept are one column (forwarded_to = 'VENDOR') split
  // by forwarded_route, since the Status column reads them as two answers.
  BANK: "c.forwarded_to = 'BANK'",
  VENDOR: "c.forwarded_to = 'VENDOR' AND c.forwarded_route = 'VENDOR'",
  PURCHASE_DEPT: "c.forwarded_to = 'VENDOR' AND c.forwarded_route = 'PURCHASE_DEPT'",
  OTHERS: "c.forwarded_to = 'OTHERS'",
  RECORDS: 'rd.id IS NOT NULL',
  NOT_SENT: `c.id IS NULL AND rd.id IS NULL AND ${CHEQUE_CLEARED_ON} IS NULL`,
};

const PROGRESS_KEYS = Object.keys(PROGRESS);

/**
 * The SQL for one Status value, or null when every row is in scope.
 *
 * No parameters: every clause is a fixed string chosen by key from the map
 * above, so nothing from the query string reaches the statement.
 */
function progressFilter(progress) {
  if (!progress) return null;
  const sql = PROGRESS[progress];
  return sql ? `(${sql})` : null;
}

/**
 * The last time CSD rejected this GRN before the handover it is on now -- the
 * newest row of csd_rejection_history for it, or nulls where there is none.
 *
 * A GRN CSD rejects goes back, gets put right, and comes round again in a new
 * upload, at which point the dispatch is removed and it reads as unsent (see
 * reopenRejectedFor in services/ingest.js). What it does NOT read as is a GRN
 * with a history, and that history is the one thing somebody about to send it
 * again wants: it was turned down last time, and here is what for.
 *
 * LATERAL with LIMIT 1, so a GRN rejected and reopened several times
 * contributes one row rather than one per rejection -- the table has no unique
 * key on dpr_no_key and deliberately does not, since each rejection is its own
 * record. ON TRUE keeps it a LEFT join: every result row comes back exactly
 * once whether or not it has ever been rejected.
 *
 * Carried on the ROW select only, not in resultJoins below, so the summary and
 * the count queries -- which never read it -- do not pay for it.
 */
const PRIOR_REJECTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT h.reject_remarks, h.rejected_at, h.superseded_at
    FROM csd_rejection_history h
    WHERE h.dpr_no_key = g.dpr_no_key
    ORDER BY h.superseded_at DESC, h.id DESC
    LIMIT 1
  ) pr ON TRUE`;

const PRIOR_REJECTION_COLUMNS = `
         pr.reject_remarks AS prior_reject_remarks,
         pr.rejected_at    AS prior_rejected_at,
         pr.superseded_at  AS prior_reopened_at`;

/** The projection shared by the table view and the exports. */
const ROW_COLUMNS = `
  SELECT r.status,
         r.bill_no_match,
         r.vendor_name_match,
         r.discrepancy_notes,
         g.sl_no, g.warehouse, g.dpr_no, g.po_no, g.dpr_date, g.bill_no, g.bill_date,
         g.dc_no, g.vendor_code, g.vendor_name,
         g.bill_amount, g.transport_amount, g.total_amount,
         g.location, g.add_amount, g.ded_amount,
         a.grn_no       AS ageing_grn_no,
         a.branch_code  AS ageing_branch_code,
         a.grn_number   AS ageing_grn_number,
         a.bill_no      AS ageing_bill_no,
         a.vendor_name  AS ageing_vendor_name,
         a.division     AS ageing_division,
         a.division_code,
         a.net_amt, a.adj_pur_return, a.adjusted_jv, a.tds_jv,
         ${PAYABLE_AMOUNT} AS payable_amount,
         a.bill_handover_to_acc,
         a.payment_doc_no,
         a.cheque_no,
         a.chq_date,
         ${BRANCH_ACCOUNT_NO} AS account_no,
         ${BRANCH_DIVISION_CODE} AS branch_division_code,
         (c.id IS NOT NULL) AS csd_sent,
         c.id                AS csd_dispatch_id,
         c.sent_at          AS csd_sent_at,
         c.stage            AS csd_stage,
         c.reject_remarks   AS csd_reject_remarks,
         c.accounts_stage    AS csd_accounts_stage,
         c.forwarded_to      AS csd_forwarded_to,
         c.forwarded_route   AS csd_forwarded_route,
         c.forwarded_name    AS csd_forwarded_name,
         c.forwarded_mobile  AS csd_forwarded_mobile,
         c.forwarded_date    AS csd_forwarded_date,
         c.forwarded_courier_name AS csd_forwarded_courier_name,
         c.forwarded_docket_no    AS csd_forwarded_docket_no,
         c.forwarded_remarks      AS csd_forwarded_remarks,
         (rd.id IS NOT NULL) AS records_sent,
         rd.sent_at          AS records_sent_at,
         ${CHEQUE_COLUMNS},
         ${PRIOR_REJECTION_COLUMNS}
`;

/**
 * Both sides of the match, joined on their primary keys -- so they neither add
 * nor drop rows, and a count over them counts results. Every query carries them
 * because the search filter reads columns from both.
 *
 * The CSD and Records joins are on dpr_no_key, which is UNIQUE on both tables,
 * so they hold that guarantee too: each can only ever match one row, and the
 * summary's counts stay counts of results rather than of handovers.
 */
const resultJoins = (scope) => `
  FROM ${resultsFrom(scope)} r
  JOIN grn_transactions g ON g.id = r.grn_transaction_id
  LEFT JOIN vendor_ageing a ON a.id = r.matched_ageing_id
  LEFT JOIN csd_dispatches c ON c.dpr_no_key = g.dpr_no_key
  LEFT JOIN record_dispatches rd ON rd.dpr_no_key = g.dpr_no_key
  ${CHEQUE_MATCH}
`;

const rowSelect = (scope) => `${ROW_COLUMNS} ${resultJoins(scope)} ${PRIOR_REJECTION_JOIN}`;

function mapRow(r) {
  return {
    status: r.status,
    slNo: r.sl_no,
    warehouse: r.warehouse,
    dprNo: r.dpr_no,
    poNo: r.po_no,
    dprDate: r.dpr_date,
    billNo: r.bill_no,
    billDate: r.bill_date,
    dcNo: r.dc_no,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    billAmount: r.bill_amount,
    transportAmount: r.transport_amount,
    totalAmount: r.total_amount,
    location: r.location,
    addAmount: r.add_amount,
    dedAmount: r.ded_amount,
    ageingGrnNo: r.ageing_grn_no,
    ageingBranchCode: r.ageing_branch_code,
    ageingGrnNumber: r.ageing_grn_number,
    ageingBillNo: r.ageing_bill_no,
    ageingVendorName: r.ageing_vendor_name,
    ageingDivision: r.ageing_division,
    divisionCode: r.division_code,
    // The branch's configured code, off the same lookup as accountNo below --
    // not the ageing report's own DivisionCode above, which is null on a
    // Pending row. Null when no configured branch claims the row's Location.
    branchDivisionCode: r.branch_division_code ?? null,
    netAmt: r.net_amt,
    adjPurReturn: r.adj_pur_return,
    adjustedJv: r.adjusted_jv,
    tdsJv: r.tds_jv,
    payableAmount: r.payable_amount,
    billHandoverToAcc: r.bill_handover_to_acc,
    paymentDocNo: r.payment_doc_no,
    chequeNo: r.cheque_no,
    // The date the ageing report says the cheque was cut. Not the same as
    // chequeClearedOn below, which is the bank's answer on what happened to it.
    chqDate: r.chq_date,
    // The account this row's branch banks through, off the configuration
    // screen -- not read from any of the three reports. Null while the branch
    // has no account against it, or none is configured for the row at all.
    accountNo: r.account_no ?? null,
    // The bank statement's answer on that cheque -- see CHEQUE_MATCH. Null when
    // no statement carries the number, which is not the same as "not cleared".
    chequeStatus: r.cheque_status ?? null,
    chequeClearedOn: r.cheque_cleared_on ?? null,
    chequeTxnCount: r.cheque_txn_count ?? 0,
    billNoMatch: r.bill_no_match,
    vendorNameMatch: r.vendor_name_match,
    discrepancyNotes: r.discrepancy_notes,
    // Read from csd_dispatches on every request rather than stored here, so
    // taking a GRN back off the queue puts its Send button back by itself, and
    // an answer CSD give on their own screen shows up here on the next load.
    csdSent: r.csd_sent ?? false,
    // The dispatch this row's CSD handover lives on, if any -- what Accounts'
    // own "Received" action (see accounts-returns below) has to address.
    csdDispatchId: r.csd_dispatch_id ?? null,
    csdSentAt: r.csd_sent_at ?? null,
    csdStage: r.csd_stage ?? null,
    // Why CSD rejected it, where they have. The reason is the whole point of a
    // rejection from Accounts' side -- it is what they have to act on -- so it
    // travels with the row rather than living only on the CSD screen.
    csdRejectRemarks: r.csd_reject_remarks ?? null,
    /*
     * The last time CSD rejected this GRN before whatever it is doing now --
     * null where they never have. A reopened GRN reads as unsent, so without
     * this nothing on the row would say it had been round once already; see
     * PRIOR_REJECTION_JOIN.
     */
    priorRejection: r.prior_rejected_at
      ? {
          remarks: r.prior_reject_remarks ?? null,
          rejectedAt: r.prior_rejected_at,
          reopenedAt: r.prior_reopened_at,
        }
      : null,
    // Accounts' own acknowledgement once CSD hands a GRN back -- see
    // accounts_stage in schema.sql. Null until csdStage reaches
    // MOVED_TO_ACCOUNTS.
    csdAccountsStage: r.csd_accounts_stage ?? null,
    // Where Accounts sent the GRN on to, once received -- see forwarded_to in
    // schema.sql. csdForwardedRoute only ever carries a value for VENDOR;
    // Name/Mobile/Date carry one for VENDOR and OTHERS alike, and stay null
    // for BANK. CourierName/DocketNo carry one for COURIER alone, which also
    // has its own Date. Remarks carries one for OTHERS alone.
    csdForwardedTo: r.csd_forwarded_to ?? null,
    csdForwardedRoute: r.csd_forwarded_route ?? null,
    csdForwardedName: r.csd_forwarded_name ?? null,
    csdForwardedMobile: r.csd_forwarded_mobile ?? null,
    csdForwardedDate: r.csd_forwarded_date ?? null,
    csdForwardedCourierName: r.csd_forwarded_courier_name ?? null,
    csdForwardedDocketNo: r.csd_forwarded_docket_no ?? null,
    csdForwardedRemarks: r.csd_forwarded_remarks ?? null,
    // The other destination. Records keeps no stages, so there is nothing to
    // report but that it went and when.
    recordsSent: r.records_sent ?? false,
    recordsSentAt: r.records_sent_at ?? null,
  };
}

/**
 * The "every upload at once" selection. It travels in the same `:id` path
 * segment as a batch id, so a scope is resolved once per request and each query
 * then either binds one batch id or drops the batch filter entirely.
 */
const ALL = 'all';

/**
 * Turn the `:id` segment into the scope the queries run against.
 *
 * @returns {Promise<{ id: number|'all', name: string, all: boolean }>}
 */
async function resolveScope(idParam) {
  if (String(idParam).toLowerCase() === ALL) {
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM upload_batches');
    if (rows[0].count === 0) {
      const err = new Error('Nothing has been uploaded yet.');
      err.status = 404;
      throw err;
    }
    return { id: ALL, name: 'All uploads', all: true };
  }

  const batchId = Number(idParam);
  const { rows } = Number.isInteger(batchId)
    ? await query('SELECT id, name FROM upload_batches WHERE id = $1', [batchId])
    : { rows: [] };
  if (rows.length === 0) {
    const err = new Error('That upload no longer exists.');
    err.status = 404;
    throw err;
  }
  return { id: rows[0].id, name: rows[0].name, all: false };
}

/**
 * Push the parameter for the batch filter and return its SQL, or null when
 * every batch is in scope.
 */
function batchFilter(scope, params) {
  if (scope.all) return null;
  params.push(scope.id);
  return `r.batch_id = $${params.length}`;
}

/** `WHERE a AND b`, or '' when nothing is being filtered on. */
function whereFrom(clauses) {
  const kept = clauses.filter(Boolean);
  return kept.length > 0 ? `WHERE ${kept.join(' AND ')}` : '';
}

/**
 * One row per GRN number, for the combined view.
 *
 * A GRN still pending when one month's report is taken is uploaded again with
 * the next, so across uploads the same GRN number appears several times. The
 * most recently uploaded row wins -- it carries the latest state of that GRN,
 * which is usually the one that has since reached accounts -- and the earlier
 * copies are dropped.
 *
 * Within one upload the GRN number is already unique (it is the key the whole
 * reconciliation is built on), so a single batch reads the plain table and pays
 * nothing for this.
 */
const DEDUPED_RESULTS = `(
  SELECT DISTINCT ON (dg.dpr_no_key) dr.*
  FROM reconciliation_results dr
  JOIN grn_transactions dg ON dg.id = dr.grn_transaction_id
  ORDER BY dg.dpr_no_key, dr.batch_id DESC, dr.id DESC
)`;

/** The relation the result queries read from, deduplicated when scope is all. */
function resultsFrom(scope) {
  return scope.all ? DEDUPED_RESULTS : 'reconciliation_results';
}

/**
 * Sl.No restarts at 1 in every GRN report, so across uploads it orders rows
 * into an interleaved mess. Group by batch first when more than one is in
 * scope, which keeps each upload's rows together and in its own order.
 */
function rowOrder(scope) {
  return scope.all
    ? 'ORDER BY r.batch_id, g.sl_no NULLS LAST, g.id'
    : 'ORDER BY g.sl_no NULLS LAST, g.id';
}

/**
 * The bucket the Pending breakdown uses for "the register cannot say".
 *
 * A sentinel rather than an empty string, because it travels back as a filter
 * value and an empty one is how every other filter on this router spells "not
 * filtering". Underscored so it cannot collide with a desk: the register
 * writes those as words -- ACCOUNTS, STORES, PURCHASE DEPARTMENT.
 */
const NOT_IN_BPAD = '__not_in_bpad__';

/**
 * Where a GRN's bill is sitting, according to the BPAD register.
 *
 * A LATERAL with LIMIT 1 rather than a plain join, for the reason
 * BPAD_GRN_JOIN is one in the other direction: the register repeats a GRN
 * across a split invoice, and a flat join would then count that GRN once per
 * invoice line. A breakdown that summed to more than the figure it breaks down
 * is worse than no breakdown. Newest upload first, the same tie-break every
 * other cross-table read on this page uses.
 *
 * Appended only by the two queries that ask about the desk -- the breakdown
 * and its filter -- rather than folded into resultJoins, which every query on
 * this router uses and none of the others would read this from.
 */
const PENDING_DEPT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT pbb.pending_with_dept
    FROM bpad_records pbb
    WHERE pbb.grn_no_key = g.dpr_no_key
    ORDER BY pbb.batch_id DESC, pbb.id DESC
    LIMIT 1
  ) pb ON TRUE`;

/**
 * That desk as one expression, with both ways of not having one folded
 * together.
 *
 * There are two -- the register has no entry for this GRN at all, or it has
 * one with the column blank -- and they say the same thing to whoever is
 * reading: BPAD cannot tell you where this bill is. One bucket rather than
 * two, and the card that reports it is worded that way.
 */
const PENDING_DEPT = `COALESCE(NULLIF(pb.pending_with_dept, ''), '${NOT_IN_BPAD}')`;

/**
 * Where the pending GRNs are pending -- the breakdown behind the Pending GRNS
 * card.
 *
 * "Pending" is this system's word for a GRN the ageing report has not picked
 * up yet, which says only that it has not reached accounts. It does not say
 * where it stopped, and that is the question anybody looking at the figure
 * asks next. The register does know: it is a register of exactly that, and it
 * writes the desk in Pending With Dept.
 *
 * So this is the same population the Pending card counts, grouped by the
 * register's answer for each one. Same scope, same search, same branch
 * narrowing as the card above it -- a breakdown counting a different set from
 * the figure it breaks down would be read as a contradiction, and would be
 * one. It sums to the Pending count exactly, NOT_IN_BPAD included, which is
 * why that bucket is in it rather than dropped for being untidy.
 *
 * Amounts from g.total_amount, the column the status cards sum, rather than
 * the register's own grn_amount -- the BPAD tab's cards measure the register
 * and these measure the GRNs, and each row of cards has to be one population
 * measured one way.
 *
 * Biggest desk first: this is read to find where the queue actually is, and
 * alphabetical order buries that. The bucket for "no answer" goes last however
 * big it is, being the exception rather than a desk.
 */
async function pendingDepartments(req, scope) {
  const params = [];
  const where = whereFrom([
    batchFilter(scope, params),
    searchFilter(req.query.q, params),
    BRANCH_SCOPE,
    ...branchClauses(req, params),
    `r.status = '${STATUS.PENDING}'`,
  ]);

  const { rows } = await query(
    `SELECT ${PENDING_DEPT} AS dept,
            COUNT(*)::int AS count,
            COALESCE(SUM(g.total_amount), 0) AS amount
     ${resultJoins(scope)}
     ${PENDING_DEPT_JOIN}
     ${where}
     GROUP BY 1
     ORDER BY (${PENDING_DEPT} = '${NOT_IN_BPAD}'), COUNT(*) DESC, 1`,
    params,
  );

  return rows.map((r) => ({ dept: r.dept, count: r.count, amount: Number(r.amount) }));
}

/**
 * Every row paid by one cheque, or null when no cheque was asked for.
 *
 * An exact match, deliberately, where the search box's own `q` matches this
 * same column loosely along with five others. This is not a search: it is what
 * the Action column reads to find the rest of a cheque's bills before it acts
 * on them, and a fuzzy answer there would hand a GRN to CSD because its bill
 * number happened to contain the cheque's digits.
 *
 * It is asked for across every page at once (see the rows endpoint's own note
 * on pageSize), because the bills one cheque pays are scattered through the
 * table -- it is ordered by the GRN report's serial number, not by cheque --
 * so the group is almost never on the page the action was chosen from.
 */
function chequeFilter(chequeNo, params) {
  if (!chequeNo) return null;
  params.push(chequeNo);
  return `a.cheque_no = $${params.length}`;
}

/**
 * Narrow the rows to one of those desks, or null when nothing is chosen.
 *
 * Only ever asked for alongside status=PENDING -- it is the Pending cards that
 * set it -- but it is not written to depend on that. A desk filter on a
 * matched row would simply find nothing, which is the honest answer rather
 * than an error, and pinning the two together here would make the rows query
 * lie about which of its filters did the narrowing.
 */
function pendingDeptFilter(dept, params) {
  if (!dept) return null;
  params.push(dept);
  return `${PENDING_DEPT} = $${params.length}`;
}

/**
 * The Accounts Department's Cheque view, as the `view` query parameter spells it.
 */
const CHEQUE_VIEW = 'cheque';

/**
 * The rows endpoint's Cheque view: one row per cheque instead of one per GRN.
 *
 * A cheque pays a group of bills, and on this view the cheque is the thing
 * being read -- its number, date, payment document and account, and what it
 * pays in total. So the GRNs one cheque number covers are folded into a single
 * row carrying the sum of their PayableAmount as `chequeAmount`. Bills with no
 * cheque number are not a cheque and are left off.
 *
 * Two layers of filtering, deliberately apart:
 *
 *  - the cheque's own population (batch, status, branch) decides which bills
 *    make up a cheque and so what it adds up to;
 *  - the search box and the Status filter only decide which cheques are
 *    listed. A cheque is shown when ANY of its bills matches, and its amount is
 *    still the whole cheque -- searching one GRN number must not report the
 *    cheque as paying only that bill.
 *
 * The rest of the row (Division, Vendor, the CSD columns the Action and Status
 * cells read) is one representative bill's: the first matching bill in the
 * table's usual order. The Action column already acts on every bill the cheque
 * pays (see chequeGroup in ResultsTable.jsx), so which bill stands in for it
 * does not change what an action does.
 */
async function chequeRows(
  req,
  scope,
  { status, progress, dept, deptJoin = '', chequeNo, page = 1, pageSize = 50, all = false },
) {
  const params = [];
  const baseWhere = whereFrom([
    batchFilter(scope, params),
    statusFilter(status, params),
    chequeFilter(chequeNo, params),
    BRANCH_SCOPE,
    ...branchClauses(req, params),
    `COALESCE(a.cheque_no, '') <> ''`,
  ]);
  const hitClauses = [
    searchFilter(req.query.q, params),
    progressFilter(progress),
    pendingDeptFilter(dept, params),
  ].filter(Boolean);
  // COALESCE because an ILIKE over a null column is null, not false, and a
  // null would sort ahead of true when picking the representative bill.
  const hit = `COALESCE((${hitClauses.length > 0 ? hitClauses.join(' AND ') : 'TRUE'}), FALSE)`;
  const batchOrder = (alias) => (scope.all ? `${alias}.cv_batch_id, ` : '');

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM (
       SELECT a.cheque_no
       ${resultJoins(scope)} ${deptJoin} ${baseWhere}
       GROUP BY a.cheque_no
       HAVING BOOL_OR(${hit})
     ) t`,
    params,
  );
  const total = countRows[0].total;

  const { rows } = await query(
    `SELECT z.* FROM (
       SELECT q.*,
              SUM(q.payable_amount) OVER (PARTITION BY q.cheque_no) AS cheque_amount,
              (COUNT(*) OVER (PARTITION BY q.cheque_no))::int AS cheque_grn_count,
              ROW_NUMBER() OVER (
                PARTITION BY q.cheque_no
                ORDER BY q.cv_hit DESC, ${batchOrder('q')}q.sl_no NULLS LAST, q.cv_grn_id
              ) AS cv_rn
       FROM (
         ${ROW_COLUMNS},
         r.batch_id AS cv_batch_id,
         g.id AS cv_grn_id,
         ${hit} AS cv_hit
         ${resultJoins(scope)} ${PRIOR_REJECTION_JOIN} ${deptJoin}
         ${baseWhere}
       ) q
     ) z
     WHERE z.cv_rn = 1 AND z.cv_hit
     ORDER BY ${batchOrder('z')}z.sl_no NULLS LAST, z.cv_grn_id
     ${all ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
    // `all` is the export: every cheque, unpaginated.
    all ? params : [...params, pageSize, (page - 1) * pageSize],
  );

  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((r) => ({
      ...mapRow(r),
      // Every PayableAmount the cheque pays, added up -- see above.
      chequeAmount: r.cheque_amount ?? null,
      chequeGrnCount: r.cheque_grn_count ?? 0,
    })),
  };
}

/** GET /api/batches/:id/summary - counts and amounts per status, plus per CSD stage. */
resultsRouter.get(
  '/:id/summary',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req.params.id);

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      searchFilter(req.query.q, params),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const { rows } = await query(
      `SELECT r.status, COUNT(*)::int AS count, COALESCE(SUM(g.total_amount), 0) AS amount
       ${resultJoins(scope)}
       ${where}
       GROUP BY r.status`,
      params,
    );

    const summary = {
      [STATUS.MATCHED]: { count: 0, amount: 0 },
      [STATUS.MATCHED_WITH_DIFF]: { count: 0, amount: 0 },
      [STATUS.PENDING]: { count: 0, amount: 0 },
      // The two matched statuses added together, which is what the Valid GRNs
      // card reads. The per-status buckets stay in the response: the counts are
      // cheap and the split is still worth having on hand.
      [VALID]: { count: 0, amount: 0 },
      total: { count: 0, amount: 0 },
    };

    for (const row of rows) {
      summary[row.status] = { count: row.count, amount: Number(row.amount) };
      if (VALID_MEMBERS.includes(row.status)) {
        summary[VALID].count += row.count;
        summary[VALID].amount += Number(row.amount);
      }
      summary.total.count += row.count;
      summary.total.amount += Number(row.amount);
    }

    /*
     * How many of THIS upload's GRNs sit at each CSD stage.
     *
     * Scoped like every other card on the page -- same batch, same search -- so
     * the row of cards is describing one population throughout. That makes it a
     * different figure from the CSD screen's own cards, which count the whole
     * queue across every upload; a handover outlives the upload it came from,
     * and the queue is the right scope there.
     *
     * Amounts come from g.total_amount, as the status cards do, rather than the
     * dispatch's payable amount -- two cards side by side measuring value two
     * different ways would not add up.
     *
     * `cheques` is how many cheques those GRNs are spread across, counted the
     * same way summary.chequesPrepared below counts its own -- COUNT(DISTINCT)
     * over the cheque number, with the non-empty clause said on purpose rather
     * than left to DISTINCT skipping nulls. It is the figure the stage cards
     * lead with: a cheque pays a group of bills and is handed to CSD as one
     * thing, so how many cheques are sitting at a stage is the question, and
     * how many GRNs they cover is the supporting line under it.
     *
     * Unlike the GRN counts, the four cheque figures do not partition anything:
     * a cheque whose bills sit at two stages at once is counted at both, the
     * same way the Status column shows a row under every value that applies to
     * it. Do not add them up.
     */
    const csdParams = [];
    const csdWhere = whereFrom([
      batchFilter(scope, csdParams),
      searchFilter(req.query.q, csdParams),
      BRANCH_SCOPE,
      ...branchClauses(req, csdParams),
      'c.id IS NOT NULL',
    ]);

    const { rows: csdRows } = await query(
      `SELECT c.stage,
              COUNT(*)::int AS count,
              COUNT(DISTINCT a.cheque_no) FILTER (WHERE COALESCE(a.cheque_no, '') <> '')::int AS cheques,
              COALESCE(SUM(g.total_amount), 0) AS amount
       ${resultJoins(scope)}
       ${csdWhere}
       GROUP BY c.stage`,
      csdParams,
    );

    const csd = Object.fromEntries(
      CSD_STAGES.map((st) => [st, { count: 0, cheques: 0, amount: 0 }]),
    );
    for (const row of csdRows) {
      if (csd[row.stage]) {
        csd[row.stage] = {
          count: row.count,
          cheques: row.cheques,
          amount: Number(row.amount),
        };
      }
    }
    summary.csd = csd;

    /*
     * How many of this upload's GRNs the Status column would show each of its
     * values against -- the counts the filter dropdown puts beside its options.
     *
     * FILTER aggregates rather than a GROUP BY, because these buckets overlap:
     * a cleared cheque on a GRN sitting at CSD counts under both, exactly as
     * the column shows both. A GROUP BY would have to pick one, and the counts
     * would then disagree with what selecting that option returns.
     *
     * Same scope and same clauses as the filter itself -- PROGRESS is the one
     * definition of each -- so the number beside an option is the number of
     * rows choosing it yields.
     */
    const progressParams = [];
    const progressWhere = whereFrom([
      batchFilter(scope, progressParams),
      searchFilter(req.query.q, progressParams),
      BRANCH_SCOPE,
      ...branchClauses(req, progressParams),
    ]);

    const { rows: progressRows } = await query(
      `SELECT ${PROGRESS_KEYS.map(
        (key) =>
          `(COUNT(*) FILTER (WHERE ${PROGRESS[key]}))::int AS ${key.toLowerCase()}_count,
           COALESCE(SUM(g.total_amount) FILTER (WHERE ${PROGRESS[key]}), 0) AS ${key.toLowerCase()}_amount`,
      ).join(', ')},
       -- How many cheques the Accounts queue's GRNs are spread across, for its
       -- card: a cheque is handed back from CSD as one thing.
       (COUNT(DISTINCT a.cheque_no) FILTER (
          WHERE ${PROGRESS.RETURNED_BY_CSD} AND COALESCE(a.cheque_no, '') <> ''
       ))::int AS accounts_queue_cheques
       ${resultJoins(scope)}
       ${progressWhere}`,
      progressParams,
    );

    const p = progressRows[0] || {};
    summary.progress = Object.fromEntries(
      PROGRESS_KEYS.map((key) => [
        key,
        {
          count: p[`${key.toLowerCase()}_count`] ?? 0,
          amount: Number(p[`${key.toLowerCase()}_amount`] ?? 0),
        },
      ]),
    );
    // The Accounts Queue card's cheque figure -- its GRN count and amount are
    // summary.progress.RETURNED_BY_CSD above.
    summary.accountsQueueCheques = p.accounts_queue_cheques ?? 0;

    /*
     * How many cheques those prepared GRNs are spread across.
     *
     * One cheque pays a group of GRNs -- that is the whole reason this screen
     * can select several by cheque number and act on them together -- so
     * "1,370 GRNs have a cheque prepared" says nothing about how many cheques
     * were actually written. The card carries both, and the two are usually a
     * long way apart: the biggest single cheque here covers twenty-five GRNs.
     *
     * COUNT(DISTINCT) over the cheque number, and the non-empty clause is
     * needed on top of CHEQUE_PREPARED rather than implied by it: a bill can
     * count as prepared on its payment document or cheque date alone, and
     * those rows have no cheque number to count. COUNT(DISTINCT) would skip
     * their nulls anyway -- the clause is here to say so on purpose rather
     * than by accident.
     *
     * Same batch, search and branch as everything else on the page, so it
     * describes the same population the card above it counts.
     */
    const chequeParams = [];
    const chequeWhere = whereFrom([
      batchFilter(scope, chequeParams),
      searchFilter(req.query.q, chequeParams),
      BRANCH_SCOPE,
      ...branchClauses(req, chequeParams),
      `(${PROGRESS.CHEQUE_PREPARED})`,
      `COALESCE(a.cheque_no, '') <> ''`,
    ]);

    const { rows: chequeRows } = await query(
      `SELECT COUNT(DISTINCT a.cheque_no)::int AS cheques
       ${resultJoins(scope)}
       ${chequeWhere}`,
      chequeParams,
    );
    summary.chequesPrepared = chequeRows[0]?.cheques ?? 0;

    // The BPAD register's figures. Its own query over its own table -- see
    // bpadSummary -- scoped by the same search and branch clauses as
    // everything else on the page.
    summary.bpad = await bpadSummary(req, scope, req.query.q);
    // Lifted to the top level because that is where the card reads its figure
    // from, by name (see countKey in the results screen's TABS). `bpad` above
    // keeps the whole tab's count, which is what the pager under its table
    // shows; this is the register's own entries, which is what the card
    // labelled BPAD is asking about.
    summary.bpadRegister = summary.bpad.inRegister;
    // And the GRNs it had no entry for, which is the BPAD view's other card.
    summary.bpadMissing = summary.bpad.notInRegister;
    // Where the pending ones are actually pending, which is the row of cards
    // under the Pending view. Sums to summary.PENDING.count -- see
    // pendingDepartments for why that matters and what the last bucket is.
    summary.pendingDepartments = await pendingDepartments(req, scope);

    res.json({ batchId: scope.id, name: scope.name, summary });
  }),
);

/** GET /api/batches/:id/results?status=&page=&pageSize= */
resultsRouter.get(
  '/:id/results',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req.params.id);

    const status = req.query.status;
    if (status && !isKnownStatus(status)) {
      return res.status(400).json({ error: `Unknown status "${status}".` });
    }

    const progress = String(req.query.progress || '').toUpperCase();
    if (progress && !PROGRESS[progress]) {
      return res.status(400).json({ error: `Unknown status "${req.query.progress}".` });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));

    // Which BPAD desk the rows are narrowed to, set by the cards under the
    // Pending view. The join it reads from is carried only while it is asked
    // for -- see PENDING_DEPT_JOIN.
    const dept = String(req.query.dept || '');
    const deptJoin = dept ? PENDING_DEPT_JOIN : '';

    // One cheque's bills, all of them, wherever they fall in the table. The
    // Action column asks for this before it acts, so that sending a GRN to CSD
    // sends the whole cheque rather than the one bill that happened to be on
    // screen -- see chequeGroup in ResultsTable.jsx. Every other filter still
    // applies on top of it, branch scope included, so it can never reach a row
    // the account is not allowed to see.
    const chequeNo = String(req.query.chequeNo || '').trim();

    // The Accounts Department's Cheque view: one row per cheque rather than per GRN.
    if (String(req.query.view || '').toLowerCase() === CHEQUE_VIEW) {
      return res.json(
        await chequeRows(req, scope, { status, progress, dept, deptJoin, chequeNo, page, pageSize }),
      );
    }

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      statusFilter(status, params),
      searchFilter(req.query.q, params),
      progressFilter(progress),
      pendingDeptFilter(dept, params),
      chequeFilter(chequeNo, params),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total ${resultJoins(scope)} ${deptJoin} ${where}`,
      params,
    );
    const total = countRows[0].total;

    const { rows } = await query(
      `${rowSelect(scope)} ${deptJoin} ${where} ${rowOrder(scope)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      rows: rows.map(mapRow),
    });
  }),
);

/**
 * GET /api/batches/:id/export?status=&q=&progress=&location=&dept=&register=
 *
 * Every row for a status, unpaginated, as JSON. The Excel and CSV files are
 * assembled in the browser (client/src/services/exporter.js), so this endpoint
 * only has to answer with data -- no workbook is ever built or buffered here.
 *
 * It takes the narrowing filters the cards on each view set -- `progress` for
 * the CSD stages and the cheque pair, `dept` for the Pending breakdown,
 * `register` for Not in BPAD -- because a section's workbook carries a sheet
 * per card and each sheet is that card's own rows. Filters left out narrow
 * nothing, which is the whole of a section's own sheet.
 */
resultsRouter.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req.params.id);

    const status = req.query.status;

    // The Turnaround tab is not a reconciliation bucket, so it exports its own
    // rows rather than a filtered slice of the results table.
    if (status === TURNAROUND) {
      const turnaroundParams = [];
      const turnaroundWhere = whereFrom([
        batchFilter(scope, turnaroundParams),
        searchFilter(req.query.q, turnaroundParams),
        BRANCH_SCOPE,
        ...branchClauses(req, turnaroundParams),
      ]);
      const { rows: turnaroundRows } = await query(
        `${turnaroundSelect(scope)} ${turnaroundWhere} ${rowOrder(scope)}`,
        turnaroundParams,
      );
      return res.json({
        batchId: scope.id,
        name: scope.name,
        status,
        rows: turnaroundRows.map(mapTurnaroundRow),
      });
    }

    // Nor is BPAD: it is the register's own table, so it exports the whole of
    // what the tab shows rather than a filtered slice of the results.
    if (status === BPAD) {
      const { rows: bpad } = await bpadRows(req, scope, { all: true });
      return res.json({ batchId: scope.id, name: scope.name, status, rows: bpad });
    }

    if (status && !isKnownStatus(status)) {
      return res.status(400).json({ error: `Unknown status "${status}".` });
    }

    const progress = String(req.query.progress || '').toUpperCase();
    if (progress && !PROGRESS[progress]) {
      return res.status(400).json({ error: `Unknown status "${req.query.progress}".` });
    }

    // Which BPAD desk the rows are narrowed to -- the same filter the rows
    // endpoint takes, for the same reason: the Pending view's breakdown cards
    // set it, and a workbook with a sheet per card has to be able to ask for
    // one desk's rows the way the card asks for them. The join it reads from
    // is carried only while it is asked for -- see PENDING_DEPT_JOIN.
    const dept = String(req.query.dept || '');
    const deptJoin = dept ? PENDING_DEPT_JOIN : '';

    // The Cheque view's sheet: one row per cheque, the same rows the table
    // shows on that view -- see chequeRows.
    if (String(req.query.view || '').toLowerCase() === CHEQUE_VIEW) {
      const { rows: cheques } = await chequeRows(req, scope, {
        status,
        progress,
        dept,
        deptJoin,
        all: true,
      });
      return res.json({ batchId: scope.id, name: scope.name, status: status || null, rows: cheques });
    }

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      statusFilter(status, params),
      searchFilter(req.query.q, params),
      progressFilter(progress),
      pendingDeptFilter(dept, params),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const { rows } = await query(
      `${rowSelect(scope)} ${deptJoin} ${where} ${rowOrder(scope)}`,
      params,
    );

    return res.json({
      batchId: scope.id,
      name: scope.name,
      status: status || null,
      rows: rows.map(mapRow),
    });
  }),
);

/* ==========================================================================
   BPAD: the register of bills pending at the accounts department.

   One row per GRN the upload is about. The register's own row where it had
   one -- matched on the vendor code and the GRN number together, while the
   workbook is read (see readBpadReport and grnMatchKeys) -- and a row carrying
   only what the GRN report knows where it did not, flagged in_register false
   (see bpadRowsForGrns).

   So by the time anything here runs the several hundred thousand register rows
   are already the few thousand worth showing, and this tab is a plain read of
   them rather than a reconciliation of anything.
   ========================================================================== */

/**
 * The GRN row a BPAD record was matched to, for its Location.
 *
 * The register writes its own Location as a short site code ("HTC", "MLK"),
 * which is not the vocabulary the configuration screen holds branches under --
 * that is the GRN report's longer Location string. So the branch a BPAD row
 * belongs to is resolved through the GRN row it matched, which is the same
 * column every other screen resolves a branch from, and a person confined to
 * one branch sees the same set of GRNs on this tab as on the others.
 *
 * Matched on the GRN number alone. The vendor code was already required for
 * the row to be stored at all, so adding it here would narrow nothing.
 *
 * LEFT JOIN LATERAL over one row, newest upload first, so it can neither
 * multiply a record nor drop one whose GRN report has since been deleted.
 */
const BPAD_GRN_JOIN = `
  LEFT JOIN LATERAL (
    SELECT gg.location
    FROM grn_transactions gg
    WHERE gg.dpr_no_key = b.grn_no_key
    ORDER BY gg.batch_id DESC, gg.id DESC
    LIMIT 1
  ) g ON TRUE`;

/**
 * The same two branch narrowings every other query on this router carries --
 * the account's own grant and the Location dropdown -- resolved off the
 * matched GRN row's Location.
 *
 * The DivisionCode half is written as a typed NULL rather than left out: these
 * builders take both spellings, and a BPAD row has no ageing entry to read a
 * DivisionCode from, so that half of the either/or simply never fires. The
 * cast is what stops Postgres having to guess a type for a bare NULL.
 */
const BPAD_BRANCH_COLUMNS = { divisionCode: 'CAST(NULL AS text)', location: 'g.location' };
const BPAD_BRANCH_SCOPE = branchScope(BPAD_BRANCH_COLUMNS);
const BPAD_LOCATION_FILTER = branchPick(BPAD_BRANCH_COLUMNS);
const BPAD_BRANCH_DIVISION_CODE = branchDivisionCode(BPAD_BRANCH_COLUMNS);

function bpadBranchClauses(req, params) {
  return [
    BPAD_LOCATION_FILTER(branchFor(req.user), params),
    BPAD_LOCATION_FILTER(req.query.location, params),
  ];
}

/**
 * What the search box looks in on this tab: the two columns the row was
 * matched by, plus the three a bill is chased by. Deliberately not the same
 * list as SEARCH_COLUMNS above -- there is no ageing side here to search, and
 * a cheque number the register does not carry.
 */
const BPAD_SEARCH_COLUMNS = [
  'b.grn_no',
  'b.vendor_code',
  'b.vendor_name',
  'b.inv_no',
  'b.po_number',
  'b.pending_with_user',
];

function bpadSearchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${BPAD_SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/**
 * The Pending With Dept. dropdown, as SQL.
 *
 * An exact match rather than a search over the column: the options offered are
 * the values the column actually holds (see bpadDepartments), so what arrives
 * is a whole value rather than a fragment, and picking "STORES" must not also
 * drag in a department that merely contains the word.
 *
 * Case-folded all the same. The register is typed at the desk it reports on,
 * and the same department reaches it as "ACCOUNTS" one month and "Accounts"
 * the next; the dropdown offers one of those spellings and means both.
 */
function bpadDeptFilter(value, params) {
  const wanted = String(value ?? '').trim();
  if (!wanted) return null;
  params.push(wanted);
  return `upper(COALESCE(b.pending_with_dept, '')) = upper($${params.length})`;
}

/**
 * The In BPAD Register column, as SQL: the tab narrowed to one side of it.
 *
 * `missing` is the GRNs the register had no entry for -- the ones the tab
 * lists first and its banner counts. They are the exception the tab exists to
 * surface, so they are worth being able to ask for on their own rather than
 * only worth being told about.
 *
 * Anything else is no filter at all, so an unknown value shows every row
 * rather than none.
 *
 * No `params` beside it, unlike every other filter here: the values are a
 * closed set this function decides between, so nothing off the request reaches
 * the SQL and there is nothing to bind.
 */
function bpadRegisterFilter(value) {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (wanted === 'missing') return 'NOT b.in_register';
  if (wanted === 'in') return 'b.in_register';
  return null;
}

/**
 * The relation the BPAD queries read from -- the table, plainly.
 *
 * This used to fold the table down to one row per GRN with a DISTINCT ON for
 * the combined view, the way DEDUPED_RESULTS still does for the reconciliation
 * one. It no longer has to: an upload replaces the rows for the GRNs it is
 * about instead of stacking a fresh generation on top of them (see
 * clearBpadRecordsFor in services/ingest.js), so the table already holds one
 * generation per GRN and there is nothing left to fold away.
 *
 * Removed rather than kept as a harmless safety net, because it was not a
 * harmless one. DISTINCT ON (grn_no_key) also collapsed the register's own
 * repeats of a GRN across a split invoice -- rows the tab means to show, and
 * which every per-upload view did show -- so the combined view was quietly the
 * only place they went missing.
 */
const BPAD_JOINS = `
  FROM bpad_records b
  ${BPAD_GRN_JOIN}
`;

/**
 * Ageing: days from the GRN date to the date the bill reached the desk it is
 * pending with, for the desks that date is known for.
 *
 * - ACCOUNTS  -- to Accounts Received Date
 * - STORES    -- to today; the bill has not left the stores, so it has no
 *                received date anywhere and is still ageing
 * - every other desk (AUDIT, CIVIL DEPARTMENT, PURCHASE DEPARTMENT, ...)
 *                -- to BPAD Received Date
 *
 * A date missing on either end is null. Worked out on read
 * rather than stored, so the STORES figure is true on the day it is looked at.
 * CURRENT_DATE is in the database's timezone, the same local day ::date casts
 * use elsewhere in this file.
 */
const BPAD_AGEING_SQL = `
  CASE
    WHEN upper(btrim(b.pending_with_dept)) = 'ACCOUNTS'
      THEN b.accounts_received_date - b.grn_date
    WHEN upper(btrim(b.pending_with_dept)) = 'STORES'
      THEN CURRENT_DATE - b.grn_date
    ELSE b.bpad_received_date - b.grn_date
  END
`;

const BPAD_COLUMNS_SQL = `
  SELECT b.id, b.in_register,
         b.sl_no, b.location, b.warehouse,
         b.vendor_code, b.vendor_name, b.vendor_category,
         b.inv_no, b.inv_date,
         b.grn_no, b.grn_date, b.grn_amount,
         b.po_number, b.po_date,
         b.pending_with_dept, b.bpad_received_date, b.accounts_received_date,
         b.pending_with_user, b.pend_reason,
         ${BPAD_AGEING_SQL} AS ageing,
         ${BPAD_BRANCH_DIVISION_CODE} AS branch_division_code
`;

/**
 * Narrow the BPAD tab to one upload, or null for every upload.
 *
 * Not `b.batch_id = $n`, though it reads as though it ought to be. A BPAD row
 * is one generation per GRN rather than one per upload -- a re-uploaded
 * register replaces the rows for the GRNs it covers, see clearBpadRecordsFor
 * in services/ingest.js -- so a row's batch_id records which upload last spoke
 * about that GRN, not which upload the row belongs to. Filtering on it would
 * empty this tab for every batch but the most recent, including the batch
 * whose GRN report the rows were matched against in the first place.
 *
 * What the tab means by "this upload" is that upload's GRNs, so that is what
 * it asks for: the rows for the GRNs this batch's report carried. Where it
 * carried no report -- a register uploaded on its own, which is ordinary --
 * every row, because there is no report here to take the question from. Which
 * is the same either/or grnMatchKeys applies in routes/batches.js when it
 * decides which GRNs to keep the register's rows for, and it has to be: a row
 * kept under one rule and hidden under the other would be stored and then
 * never shown.
 *
 * Both halves read grn_transactions by (batch_id, dpr_no_key), which is
 * idx_grn_batch_key exactly.
 */
function bpadBatchFilter(scope, params) {
  if (scope.all) return null;
  params.push(scope.id);
  const batch = `$${params.length}`;
  return `(
    EXISTS (
      SELECT 1 FROM grn_transactions bg
      WHERE bg.batch_id = ${batch} AND bg.dpr_no_key = b.grn_no_key
    )
    OR NOT EXISTS (SELECT 1 FROM grn_transactions bg WHERE bg.batch_id = ${batch})
  )`;
}

/**
 * The GRNs the register had no entry for lead, then the register's own rows in
 * its own Sl.No order.
 *
 * Those rows carry no Sl.No -- there is no register row to have one -- so
 * ordering on Sl.No alone would drop every one of them onto the last page,
 * which is where nobody looks. They are ten rows in three thousand and they
 * are the exceptions worth seeing, so they go first: anyone opening this tab
 * to check coverage finds them without paging, and anyone reading the register
 * scrolls past ten rows to reach it.
 *
 * Sl.No is the register's own and restarts per upload, so more than one batch
 * in scope groups by batch first -- same as rowOrder.
 */
function bpadOrder(scope) {
  return scope.all
    ? 'ORDER BY b.in_register, b.batch_id, b.sl_no NULLS LAST, b.id'
    : 'ORDER BY b.in_register, b.sl_no NULLS LAST, b.id';
}

function mapBpadRow(r) {
  return {
    // The register repeats a GRN across a split invoice, so the GRN number is
    // not a key on this tab the way it is on the others -- the row's own id is.
    id: r.id,
    // False on a GRN the register had no entry for. Every register column on
    // such a row is null; what it does carry came from the GRN report. See
    // bpadRowsForGrns in routes/batches.js.
    inRegister: r.in_register ?? true,
    slNo: r.sl_no,
    // The register's own site code ("HTC"), as it wrote it -- not the branch.
    // The GRN report's longer Location string is what the configuration screen
    // holds branches under, and it is what BPAD_GRN_JOIN above filters on;
    // branchDivisionCode below is that lookup's answer, and the column the tab
    // actually shows as Division.
    location: r.location,
    branchDivisionCode: r.branch_division_code ?? null,
    warehouse: r.warehouse,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    vendorCategory: r.vendor_category,
    invNo: r.inv_no,
    invDate: r.inv_date,
    grnNo: r.grn_no,
    grnDate: r.grn_date,
    grnAmount: r.grn_amount,
    poNumber: r.po_number,
    poDate: r.po_date,
    pendingWithDept: r.pending_with_dept,
    // The two dates the register exists to report. Null on a bill that has not
    // reached that desk, which is the answer rather than missing data.
    bpadReceivedDate: r.bpad_received_date,
    accountsReceivedDate: r.accounts_received_date,
    pendingWithUser: r.pending_with_user,
    pendReason: r.pend_reason,
    // Days from GRN date, per desk -- see BPAD_AGEING_SQL. Null where it does
    // not apply.
    ageing: r.ageing ?? null,
  };
}

/**
 * How many BPAD records are in scope, and what they come to.
 *
 * Its own small query rather than a bucket of the summary's main one: the
 * register is a different table with a different population, and folding it
 * into a GROUP BY over reconciliation_results would have it counted against
 * statuses it has none of.
 *
 * `dept` is optional and only the tab passes it. The card on the results page
 * reports the register's whole coverage of the upload, the same way the other
 * cards ignore the Status dropdown standing beside them; the tab's own count
 * and its "no entry in the register" line have to follow the rows on screen.
 */
async function bpadSummary(req, scope, search, dept) {
  const params = [];
  const where = whereFrom([
    bpadBatchFilter(scope, params),
    bpadSearchFilter(search, params),
    bpadDeptFilter(dept, params),
    BPAD_BRANCH_SCOPE,
    ...bpadBranchClauses(req, params),
  ]);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(b.grn_amount), 0) AS amount,
            (COUNT(*) FILTER (WHERE NOT b.in_register))::int AS missing,
            (COUNT(*) FILTER (WHERE b.in_register))::int AS in_register_count,
            COALESCE(SUM(b.grn_amount) FILTER (WHERE b.in_register), 0) AS in_register_amount
     ${BPAD_JOINS}
     ${where}`,
    params,
  );
  return {
    // Every row the tab shows: the register's own entries and the GRNs it had
    // no entry for, together. It is what the pager under the table counts.
    count: rows[0]?.count ?? 0,
    amount: Number(rows[0]?.amount ?? 0),
    // How many of those the register had no entry for. The tab reports it, so
    // a gap between the GRN count and the register's coverage is stated rather
    // than left to be worked out from two numbers on different screens.
    missing: rows[0]?.missing ?? 0,
    /*
     * The register's own entries alone -- `count` less `missing`, with the
     * value to match.
     *
     * This is what the BPAD card reports, and it is the figure that answers
     * the label on it: "how many records are in the BPAD register" is a
     * question about the register, not about how many GRNs the tab lines up
     * against it. The amount is filtered the same way for the same reason -- a
     * card counting 3,392 records while summing 3,402 rows' worth of value
     * would be two different populations in one card.
     */
    inRegister: {
      count: rows[0]?.in_register_count ?? 0,
      amount: Number(rows[0]?.in_register_amount ?? 0),
    },
    /*
     * The other side of it: the GRNs the register had no entry for, as a
     * bucket rather than as the bare `missing` count above, so the card can
     * carry a value like every other card in the row.
     *
     * Same figure as `missing`, kept beside it rather than replacing it
     * because `missing` is what the tab's own banner reads and its shape is a
     * number, not a bucket.
     */
    notInRegister: {
      count: rows[0]?.missing ?? 0,
      amount: Number(rows[0]?.amount ?? 0) - Number(rows[0]?.in_register_amount ?? 0),
    },
  };
}

/**
 * The values the Pending With Dept. column actually holds, for the dropdown.
 *
 * Built from the rows rather than from a fixed list, because the departments a
 * bill can be sitting at are the register's business and not this system's --
 * a new desk appears in the dropdown the upload after it appears in the file,
 * with no edit here.
 *
 * Scoped by the batch and the branch, and deliberately not by the search box
 * or by the department already chosen. A list that collapsed to the one value
 * already picked could never be used to pick a second, and one that reshuffled
 * itself as a search was typed would move the option under the pointer.
 *
 * Blank is left out. The rows carrying no department are the GRNs the register
 * had no entry for at all, which the tab already marks in its own column and
 * explains in its own banner; an option reading "(none)" would be a second and
 * worse way of asking the same question.
 */
async function bpadDepartments(req, scope) {
  const params = [];
  const where = whereFrom([
    bpadBatchFilter(scope, params),
    BPAD_BRANCH_SCOPE,
    ...bpadBranchClauses(req, params),
    `COALESCE(b.pending_with_dept, '') <> ''`,
  ]);
  const { rows } = await query(
    `SELECT b.pending_with_dept AS dept,
            COUNT(*)::int AS count,
            COALESCE(SUM(b.grn_amount), 0) AS amount
     ${BPAD_JOINS}
     ${where}
     GROUP BY b.pending_with_dept
     ORDER BY b.pending_with_dept`,
    params,
  );
  // The value as well as the count, because each of these is a card on the
  // results screen now as well as an option in the dropdown, and every other
  // card in that row carries both. From b.grn_amount, the same column the BPAD
  // card itself sums -- a card measuring value a different way from the card
  // beside it would not add up.
  return rows.map((r) => ({ dept: r.dept, count: r.count, amount: Number(r.amount) }));
}

/**
 * Every BPAD row in scope, for the tab and for its sheet in the export.
 *
 * `all` drops the pagination, which is what the export asks for.
 *
 * The department filter is read off the request like the search box is, so it
 * narrows whatever asks for these rows. In practice that is the tab only: the
 * export sends the search and the branch and nothing else, the same way it
 * leaves the other tabs' own dropdowns out of the workbook.
 */
async function bpadRows(req, scope, { page, pageSize, all = false } = {}) {
  const params = [];
  const where = whereFrom([
    bpadBatchFilter(scope, params),
    bpadSearchFilter(req.query.q, params),
    bpadDeptFilter(req.query.dept, params),
    bpadRegisterFilter(req.query.register),
    BPAD_BRANCH_SCOPE,
    ...bpadBranchClauses(req, params),
  ]);

  if (all) {
    const { rows } = await query(
      `${BPAD_COLUMNS_SQL} ${BPAD_JOINS} ${where} ${bpadOrder(scope)}`,
      params,
    );
    return { total: rows.length, rows: rows.map(mapBpadRow) };
  }

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total ${BPAD_JOINS} ${where}`,
    params,
  );
  const total = countRows[0].total;

  const { rows } = await query(
    `${BPAD_COLUMNS_SQL} ${BPAD_JOINS} ${where} ${bpadOrder(scope)}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return { total, rows: rows.map(mapBpadRow) };
}

/**
 * GET /api/batches/:id/bpad?page=&pageSize=&q=&location=&dept=&register=
 *
 * The BPAD register's rows for the GRNs in scope. No status filter: every row
 * here is in the register because it matched a GRN, and the register's own
 * verdict on a bill is `pendingWithDept` rather than anything this system
 * decided -- which is what `dept` narrows the tab by.
 */
resultsRouter.get(
  '/:id/bpad',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req.params.id);

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));

    const { total, rows } = await bpadRows(req, scope, { page, pageSize });
    const { missing } = await bpadSummary(req, scope, req.query.q, req.query.dept);
    // Every department in scope, not only the ones on this page -- the
    // dropdown is built from it, and one rebuilt per page of rows would offer
    // a different set of choices as the reader paged through.
    const departments = await bpadDepartments(req, scope);

    return res.json({
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      // How many of `total` the register had no entry for -- counted over
      // everything in scope, not over this page, because it is a fact about
      // the upload rather than about the fifty rows on screen.
      missing,
      departments,
      rows,
    });
  }),
);

/* ==========================================================================
   Turnaround: how many days a bill spends at each step.
   ========================================================================== */

/**
 * Only GRNs that reached the ageing report have any of these dates, so the join
 * is an inner one. That is also what limits the report to the GRNs matched to
 * this month's GRN report, and it resolves the handful of GRNs that repeat
 * across payment rows -- reconcile() already picked one ageing row per GRN.
 */
/**
 * The CSD handover's four stamps, cast to plain dates.
 *
 * They are stored as timestamps -- the moment a button was pressed -- but the
 * turnaround report measures in whole days against the ageing report's DATE
 * columns, so they are reduced to the same shape here. `::date` resolves in the
 * database's own timezone, which is the local day the action happened on.
 */
const CSD_DATES = `
         c.id                          AS csd_id,
         c.sent_at::date               AS sent_to_csd,
         c.received_at::date           AS csd_received,
         c.approved_at::date           AS csd_approved,
         c.rejected_at::date           AS csd_rejected,
         c.moved_to_accounts_at::date  AS moved_to_accounts_date,
         c.accounts_received_at::date  AS accounts_received_date,
         c.forwarded_at::date          AS forwarded_action_date,
         c.stage                       AS csd_stage`;

/**
 * The CSD handover for a GRN, if it has been sent. LEFT, and on the unique
 * dpr_no_key, so it neither drops a row that was never sent nor duplicates one
 * that was.
 */
const CSD_JOIN = 'LEFT JOIN csd_dispatches c ON c.dpr_no_key = g.dpr_no_key';

const TURNAROUND_COLUMNS = `
  SELECT r.status,
         a.id AS ageing_id,
         g.dpr_no, g.bill_date, g.vendor_name, g.vendor_code, g.location,
         g.bill_amount, g.transport_amount, g.add_amount, g.ded_amount,
         a.division_code,
         a.net_amt, a.adj_pur_return, a.adjusted_jv, a.tds_jv,
         ${PAYABLE_AMOUNT} AS payable_amount,
         a.grn_no, a.bill_no,
         a.indent_date, a.po_date, a.security_date, a.grn_date,
         a.bill_to_audit, a.bill_handover_to_acc, a.chq_date,
         a.cheque_no, a.payment_doc_no,
         ${CHEQUE_COLUMNS},
         ${CSD_DATES}
`;

const turnaroundSelect = (scope) => `
  ${TURNAROUND_COLUMNS}
  FROM ${resultsFrom(scope)} r
  JOIN vendor_ageing a ON a.id = r.matched_ageing_id
  JOIN grn_transactions g ON g.id = r.grn_transaction_id
  ${CSD_JOIN}
  ${CHEQUE_MATCH}
`;

/**
 * The turnaround join, for the statistics query. It is an inner join to the
 * ageing table -- only GRNs that reached accounts have any of these dates --
 * plus the GRN row, which is there for the search filter to read.
 */
const turnaroundJoins = (scope) => `
  FROM ${resultsFrom(scope)} r
  JOIN vendor_ageing a ON a.id = r.matched_ageing_id
  JOIN grn_transactions g ON g.id = r.grn_transaction_id
  ${CSD_JOIN}
  ${CHEQUE_MATCH}
`;

/**
 * Field names here must match the `from`/`to` fields in services/turnaround.js
 * STAGES -- `gapsFor` reads them straight off this object. Note the capital `O`
 * in billHandOverToAcc, which follows the source column and the parser rather
 * than mapRow's spelling above.
 */
function mapTurnaroundRow(r) {
  const row = {
    status: r.status,
    // The row the dates are stored on, so a correction knows what to write to.
    ageingId: r.ageing_id,
    dprNo: r.dpr_no,
    grnNo: r.grn_no,
    billNo: r.bill_no,
    // The GRN report's own Bill Date -- not one of the seven checkpoints, just
    // an identifying fact about the bill, alongside Bill No beside it.
    billDate: r.bill_date,
    divisionCode: r.division_code,
    vendorName: r.vendor_name,
    vendorCode: r.vendor_code,
    location: r.location,
    // The GRN report's own amount breakdown, ahead of PayableAmount -- the
    // ageing report's own figure, which they add up to on the stores' side.
    billAmount: r.bill_amount,
    transportAmount: r.transport_amount,
    addAmount: r.add_amount,
    dedAmount: r.ded_amount,
    // The ageing report's own amount breakdown -- NetAmt through PayableAmount,
    // the same four columns and order as the CSD and Valid GRNs tabs.
    netAmt: r.net_amt,
    adjPurReturn: r.adj_pur_return,
    adjustedJv: r.adjusted_jv,
    tdsJv: r.tds_jv,
    payableAmount: r.payable_amount,
    indentDate: r.indent_date,
    poDate: r.po_date,
    securityDate: r.security_date,
    grnDate: r.grn_date,
    billToAudit: r.bill_to_audit,
    billHandOverToAcc: r.bill_handover_to_acc,
    chqDate: r.chq_date,
    chequeNo: r.cheque_no,
    // The ageing report's payment document number, off the cheque it belongs
    // to -- sits right after it for the same reason Cheque No sits after
    // PayableAmount: it is the next answer once a cheque exists at all.
    paymentDocNo: r.payment_doc_no,
    // From the bank statement, not from the ageing report's own
    // Cheque_ClearanceDate column: the statement is the record of what the bank
    // actually did, and it is the only side that shows a cheque coming back.
    chequeClearanceDate: r.cheque_cleared_on ?? null,
    chequeStatus: r.cheque_status ?? null,
    // The CSD handover. Null on every row that has not been sent, which is what
    // leaves the three CSD stages blank rather than zero.
    // The dispatch these stamps live on, so a correction knows what to write
    // to. Null on a GRN that was never sent, which is what leaves its CSD dates
    // uneditable -- there is no record to correct.
    csdId: r.csd_id,
    sentToCsd: r.sent_to_csd,
    csdReceived: r.csd_received,
    csdApproved: r.csd_approved,
    csdRejected: r.csd_rejected,
    // Accounts' side of the hand-back: when CSD returned it, when Accounts
    // acknowledged that, and when Accounts sent it on to Bank/Vendor/Others.
    // All three are null until the button behind them has been pressed.
    movedToAccountsAt: r.moved_to_accounts_date,
    accountsReceivedAt: r.accounts_received_date,
    forwardedAt: r.forwarded_action_date,
    csdStage: r.csd_stage,
  };
  return { ...row, gaps: gapsFor(row) };
}

/**
 * Every date column in scope, for statistics computed over all rows.
 *
 * The search filter applies here too: a median taken over rows the table is not
 * showing would contradict the rows it is.
 */
async function turnaroundPopulation(req, scope, search) {
  const params = [];
  const where = whereFrom([
    batchFilter(scope, params),
    searchFilter(search, params),
    BRANCH_SCOPE,
    ...branchClauses(req, params),
  ]);
  const { rows } = await query(
    `SELECT a.grn_no,
            a.indent_date, a.po_date, a.security_date, a.grn_date,
            a.bill_to_audit, a.bill_handover_to_acc, a.chq_date,
            ${CHEQUE_COLUMNS},
            ${CSD_DATES}
     ${turnaroundJoins(scope)}
     ${where}`,
    params,
  );
  return rows.map((r) => ({
    grnNo: r.grn_no,
    indentDate: r.indent_date,
    poDate: r.po_date,
    securityDate: r.security_date,
    grnDate: r.grn_date,
    billToAudit: r.bill_to_audit,
    billHandOverToAcc: r.bill_handover_to_acc,
    chqDate: r.chq_date,
    chequeClearanceDate: r.cheque_cleared_on,
    sentToCsd: r.sent_to_csd,
    csdReceived: r.csd_received,
    csdApproved: r.csd_approved,
    csdRejected: r.csd_rejected,
    movedToAccountsAt: r.moved_to_accounts_date,
    accountsReceivedAt: r.accounts_received_date,
    forwardedAt: r.forwarded_action_date,
  }));
}

/**
 * GET /api/batches/:id/turnaround?page=&pageSize=
 *
 * Per-stage statistics over every in-scope row, plus one page of the rows
 * themselves. The statistics deliberately do not follow the pagination -- a
 * median of the fifty rows on screen would be meaningless.
 */
resultsRouter.get(
  '/:id/turnaround',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req.params.id);

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 50));

    const population = await turnaroundPopulation(req, scope, req.query.q);
    const { stages, overall } = summarise(population);
    const { era, impossible, backwards } = dataQuality(population);

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      searchFilter(req.query.q, params),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);
    const { rows } = await query(
      `${turnaroundSelect(scope)} ${where} ${rowOrder(scope)}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const total = population.length;

    return res.json({
      batchId: scope.id,
      name: scope.name,
      stages,
      overall,
      quality: {
        era,
        impossible: impossible.length,
        backwards: backwards.length,
        impossibleGrns: impossible.map((r) => r.grnNo),
      },
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      rows: rows.map(mapTurnaroundRow),
    });
  }),
);


/* ==========================================================================
   Correcting a stage date.

   The seven checkpoints are transcribed by hand into the source system, and
   the data-quality check on the turnaround tab exists because some of them
   arrive wrong -- a mistyped year puts a bill decades out, and a security date
   before its PO makes a stage read negative. Rather than re-uploading a
   corrected workbook, the dates are editable in place.

   Only these eight columns can be written. Everything else on an ageing row is
   the report's own data and stays exactly as it was uploaded.

   The eighth is not a report column at all: cheque_clearance_override holds a
   correction to the date derived from the bank statement, and emptying it puts
   the statement's own answer back.
   ========================================================================== */

export const ageingRouter = express.Router();

ageingRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

/** The editable checkpoints: the name on the wire, and the column behind it. */
const EDITABLE_DATES = {
  indentDate: 'indent_date',
  poDate: 'po_date',
  securityDate: 'security_date',
  grnDate: 'grn_date',
  billToAudit: 'bill_to_audit',
  billHandOverToAcc: 'bill_handover_to_acc',
  chqDate: 'chq_date',
  // Not a checkpoint off the report: a correction to the clearance date the
  // bank statement produced. Null means "no correction", not "never cleared".
  chequeClearanceDate: 'cheque_clearance_override',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in yyyy-MM-dd.
 *
 * The pattern alone would accept 2026-02-31, which Postgres then rejects with
 * an error the user cannot act on. Round-tripping it through Date catches that
 * here instead, with a message naming the field.
 */
function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * PATCH /api/ageing/:id/dates
 *
 * Body: any subset of the seven checkpoints, each a yyyy-MM-dd string, or null
 * to clear one. Absent fields are left alone.
 *
 * The day counts are not stored -- they are computed from the dates on every
 * read -- so correcting a date here is all it takes for the row's gaps, the
 * stage medians and both exports to follow.
 */
ageingRouter.patch(
  '/:id/dates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ageingId = Number(req.params.id);
    if (!Number.isInteger(ageingId)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const assignments = [];
    const params = [];

    for (const [field, column] of Object.entries(EDITABLE_DATES)) {
      if (!(field in req.body)) continue;

      const raw = req.body[field];
      // '' and null both mean "no date recorded", which is a legitimate state:
      // a bill that has not reached that checkpoint yet has none.
      const value = raw === '' || raw === null || raw === undefined ? null : String(raw);

      if (value !== null && !isCalendarDate(value)) {
        return res.status(400).json({ error: `"${field}" must be a real date, or empty to clear it.` });
      }

      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    }

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'No date was given to change.' });
    }

    // The dates as they stood, so the activity log can say what changed.
    const { rows: before } = await query(
      `SELECT grn_number, grn_no, ${Object.values(EDITABLE_DATES).join(', ')}
         FROM vendor_ageing WHERE id = $1`,
      [ageingId],
    );

    params.push(ageingId);
    const { rows } = await query(
      `UPDATE vendor_ageing
       SET ${assignments.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, indent_date, po_date, security_date, grn_date,
                 bill_to_audit, bill_handover_to_acc, chq_date`,
      params,
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'That row no longer exists.' });
    }

    const r = rows[0];
    const dates = {
      indentDate: r.indent_date,
      poDate: r.po_date,
      securityDate: r.security_date,
      grnDate: r.grn_date,
      billToAudit: r.bill_to_audit,
      billHandOverToAcc: r.bill_handover_to_acc,
      chqDate: r.chq_date,
    };

    const old = before[0] ?? {};
    const changes = {};
    for (const [field, column] of Object.entries(EDITABLE_DATES)) {
      if (!(field in req.body)) continue;
      const from = old[column] ?? null;
      const to = req.body[field] === '' || req.body[field] == null ? null : String(req.body[field]);
      if (from !== to) changes[field] = { from, to };
    }
    const grnNo = old.grn_number || old.grn_no || `ageing row ${ageingId}`;
    const changed = Object.keys(changes).length;
    if (changed > 0) {
      logActivity(req, {
        action: 'AGEING_DATES',
        target: grnNo,
        summary: `Corrected ${changed} stage date${changed === 1 ? '' : 's'} on GRN ${grnNo}`,
        details: { ageingId, changes },
      });
    }

    return res.json({ id: r.id, dates, gaps: gapsFor(dates) });
  }),
);

/* ==========================================================================
   Handed to Records
   --------------------------------------------------------------------------
   The second destination on the Valid GRNs row, beside Send to CSD.

   It is a note, not a queue. CSD has a screen, four stages, stamps for each and
   a report measuring the time between them; Records has none of that -- the row
   simply says "Sent to Records" from then on. So this is one route with one
   verb, and it lives here rather than in a routes/records.js of its own because
   there is nothing else for such a file to hold.

   Gated on the results screen, not on a screen of its own: the control is on
   the results table, and anyone who can work that table can use it. That is the
   difference from CSD, which is gated on the CSD screen because sending there
   puts work on that team's queue.
   ========================================================================== */

export const recordsRouter = express.Router();

recordsRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

/** Only a GRN that reached accounts has anything to file. */
const FILEABLE = new Set([STATUS.MATCHED, STATUS.MATCHED_WITH_DIFF]);

/**
 * POST /api/records
 *
 * Body: one Valid GRNs row, as the table holds it -- the same shape POST /csd
 * takes, so the two destinations are called the same way. Only dprNo and
 * batchId are kept.
 *
 * Sending a GRN already filed refreshes its timestamp rather than failing:
 * pressing twice, or sending the same GRN again from a newer upload, is a
 * re-send and not an error.
 */
recordsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};

    const dprNo = String(body.dprNo ?? '').trim();
    if (!dprNo) {
      return res.status(400).json({ error: 'A GRN number is required to send to Records.' });
    }

    // The same normKey the reconciliation matches on, so "236/25-26" and
    // "236 25 26" are one GRN here as well as there.
    const key = normKey(dprNo);
    if (!key) {
      return res.status(400).json({ error: `"${dprNo}" is not a usable GRN number.` });
    }

    const status = String(body.status ?? '').trim();
    if (status && !FILEABLE.has(status)) {
      return res
        .status(400)
        .json({ error: 'Only GRNs found in the ageing report can go to Records.' });
    }

    /*
     * Which upload it came from, or null for none.
     *
     * `> 0` is the whole of it, and it is not decoration: the screens send
     * `batchId: null` -- their scope is every upload, so there is no one batch
     * to name -- and Number(null) is 0, which is an integer. Without the
     * guard every send from those screens reached the INSERT with batch_id 0,
     * which is no row in upload_batches, and the foreign key turned the whole
     * thing into a 500. The column is nullable precisely so that "no
     * particular upload" is sayable; 0 is not how to say it.
     *
     * Same expression as the CSD route's (see POST /csd in routes/csd.js),
     * which takes the same body from the same table and had the guard from the
     * start.
     */
    const batchId =
      Number.isInteger(Number(body.batchId)) && Number(body.batchId) > 0
        ? Number(body.batchId)
        : null;

    const { rows } = await query(
      `INSERT INTO record_dispatches (dpr_no_key, dpr_no, batch_id, sent_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dpr_no_key) DO UPDATE SET
         dpr_no = EXCLUDED.dpr_no,
         batch_id = EXCLUDED.batch_id,
         sent_by = EXCLUDED.sent_by,
         sent_at = NOW()
       RETURNING id, dpr_no, sent_at`,
      [key, dprNo, batchId, req.user.id],
    );

    logActivity(req, {
      action: 'RECORDS_SEND',
      target: rows[0].dpr_no,
      summary: `Sent GRN ${rows[0].dpr_no} to Records`,
      details: {
        recordId: rows[0].id,
        chequeNo: String(body.chequeNo ?? '').trim() || null,
        vendorName: String(body.vendorName ?? '').trim() || null,
      },
    });

    return res.status(201).json({
      record: { id: rows[0].id, dprNo: rows[0].dpr_no, sentAt: rows[0].sent_at },
    });
  }),
);

/* ==========================================================================
   Returned from CSD
   --------------------------------------------------------------------------
   A GRN CSD marks MOVED_TO_ACCOUNTS on their own queue (see routes/csd.js) is
   acknowledged and disposed of here -- Accounts' own two moves once it lands
   back with them. `accounts_stage` starts QUEUED the moment CSD hands it
   back; /receive moves it to RECEIVED; /forward then records where it went on
   from there (Bank, Vendor, or Others) and, for Vendor, who took it.

   No listing of its own -- the results table already shows every such row
   (Action column offers Received then the forwarding choice, Status column
   reads the answer; see csdAccountsStage/csdForwardedTo in mapRow above and
   their handling in ResultsTable.jsx). These are only the writes that table's
   dropdowns make.

   Gated on the results screen, the same as Records: this is a control on the
   Accounts side of the app, not a CSD one, and anyone who can work the results
   table can act on it.
   ========================================================================== */

const ACCOUNTS_RETURN_COLUMNS = `
  SELECT c.id, c.dpr_no, c.division_code, c.bill_no, c.bill_date,
         c.vendor_code, c.vendor_name, c.payable_amount,
         c.cheque_no, c.chq_date, c.payment_doc_no,
         c.moved_to_accounts_at, c.accounts_stage, c.accounts_received_at,
         c.forwarded_to, c.forwarded_route, c.forwarded_name, c.forwarded_mobile,
         c.forwarded_date, c.forwarded_courier_name, c.forwarded_docket_no,
         c.forwarded_remarks, c.forwarded_at,
         au.full_name AS accounts_received_by_name,
         au.username  AS accounts_received_by_username,
         fu.full_name AS forwarded_by_name,
         fu.username  AS forwarded_by_username
  FROM csd_dispatches c
  LEFT JOIN users au ON au.id = c.accounts_received_by
  LEFT JOIN users fu ON fu.id = c.forwarded_by
`;

function mapAccountsReturn(r) {
  return {
    id: r.id,
    dprNo: r.dpr_no,
    divisionCode: r.division_code,
    billNo: r.bill_no,
    billDate: r.bill_date,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    payableAmount: r.payable_amount,
    chequeNo: r.cheque_no,
    chqDate: r.chq_date,
    paymentDocNo: r.payment_doc_no,
    movedToAccountsAt: r.moved_to_accounts_at,
    accountsStage: r.accounts_stage,
    accountsReceivedAt: r.accounts_received_at,
    accountsReceivedBy: r.accounts_received_by_name || r.accounts_received_by_username || null,
    forwardedTo: r.forwarded_to,
    forwardedRoute: r.forwarded_route,
    forwardedName: r.forwarded_name,
    forwardedMobile: r.forwarded_mobile,
    forwardedDate: r.forwarded_date,
    forwardedCourierName: r.forwarded_courier_name,
    forwardedDocketNo: r.forwarded_docket_no,
    forwardedRemarks: r.forwarded_remarks,
    forwardedAt: r.forwarded_at,
    forwardedBy: r.forwarded_by_name || r.forwarded_by_username || null,
  };
}

/** BANK carries nothing further; VENDOR/OTHERS need name+mobile+date; COURIER needs its own two fields. */
const FORWARD_DESTINATIONS = new Set(['BANK', 'VENDOR', 'OTHERS', 'COURIER']);
const FORWARD_ROUTES = new Set(['VENDOR', 'PURCHASE_DEPT']);

const FORWARD_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in yyyy-MM-dd -- see the same check in routes/csd.js. */
function isForwardCalendarDate(value) {
  if (!FORWARD_ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const accountsReturnsRouter = express.Router();

accountsReturnsRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

/**
 * PATCH /api/accounts-returns/:id/receive
 *
 * Accounts' one move: acknowledge a hand-back. Only from QUEUED, and only on a
 * dispatch CSD has actually handed back -- the same guarded, one-statement
 * update pattern as the CSD stage move, so two people acknowledging the same
 * row at once cannot both succeed.
 */
accountsReturnsRouter.patch(
  '/:id/receive',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const { rows } = await query(
      `UPDATE csd_dispatches
       SET accounts_stage = 'RECEIVED', accounts_received_at = NOW(), accounts_received_by = $1
       WHERE id = $2 AND stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'QUEUED'
       RETURNING id`,
      [req.user.id, id],
    );

    if (rows.length > 0) {
      const { rows: full } = await query(`${ACCOUNTS_RETURN_COLUMNS} WHERE c.id = $1`, [id]);
      const accountsReturn = mapAccountsReturn(full[0]);
      logActivity(req, {
        action: 'ACCOUNTS_RECEIVE',
        target: accountsReturn.dprNo,
        summary:
          `Accounts received GRN ${accountsReturn.dprNo} back from CSD` +
          (accountsReturn.chequeNo ? ` (cheque ${accountsReturn.chequeNo})` : ''),
        details: { dispatchId: id, chequeNo: accountsReturn.chequeNo },
      });
      return res.json({ accountsReturn });
    }

    const { rows: current } = await query(
      "SELECT stage, accounts_stage FROM csd_dispatches WHERE id = $1",
      [id],
    );
    if (current.length === 0) {
      return res.status(404).json({ error: 'That GRN is no longer in the CSD queue.' });
    }
    if (current[0].stage !== 'MOVED_TO_ACCOUNTS') {
      return res.status(409).json({ error: 'This GRN has not been moved to accounts.' });
    }
    return res.status(409).json({ error: 'This GRN has already been received by accounts.' });
  }),
);

/**
 * PATCH /api/accounts-returns/:id/forward
 *
 * Body: { to, route, name, mobile, date, courierName, docketNo, remarks }.
 * Accounts' last move on a GRN: where the paperwork goes once they have it --
 * Bank needs nothing further, Vendor and Others both need who took it, on
 * what number, on what day, and Vendor additionally needs the door it went
 * out of (the vendor itself or the purchase department). Others carries a
 * remark on top of that, since there is no vendor record or purchase-
 * department door behind an arbitrary destination to explain it otherwise.
 * Courier hands the GRN to a service, not a person -- so it carries its own
 * pair in place of name/mobile: which courier, and the docket number it went
 * out under -- but still records the day, the same as every other
 * destination but Bank.
 *
 * A one-shot write, same as /receive: only from a dispatch Accounts has
 * actually received, and only once -- there is nowhere for a second forward to
 * go, so it is refused rather than silently overwriting the first.
 */
accountsReturnsRouter.patch(
  '/:id/forward',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const to = String(req.body?.to || '').toUpperCase();
    if (!FORWARD_DESTINATIONS.has(to)) {
      return res.status(400).json({
        error: `"${req.body?.to ?? ''}" is not a destination. Expected Bank, Vendor, Others or Courier.`,
      });
    }

    let route = null;
    let name = null;
    let mobile = null;
    let date = null;
    let courierName = null;
    let docketNo = null;
    let remarks = null;

    if (to === 'VENDOR') {
      route = String(req.body?.route || '').toUpperCase();
      if (!FORWARD_ROUTES.has(route)) {
        return res
          .status(400)
          .json({ error: 'Choose whether this goes to the vendor directly or to the purchase department.' });
      }
    }

    // Vendor and Others both hand the GRN to a person, so both need who took
    // it, on what number, on what day. Bank does not -- there is no one
    // person on that side to record -- so it alone skips this and stays with
    // nothing more than the fact and the day it was sent.
    if (to === 'VENDOR' || to === 'OTHERS') {
      name = String(req.body?.name || '').trim();
      if (!name) {
        return res.status(400).json({ error: 'A name is required for this hand-off.' });
      }

      mobile = String(req.body?.mobile || '').trim();
      if (!mobile) {
        return res.status(400).json({ error: 'A mobile number is required for this hand-off.' });
      }

      date = String(req.body?.date || '');
      if (!isForwardCalendarDate(date)) {
        return res.status(400).json({ error: 'A real date is required for this hand-off.' });
      }
    }

    // Others alone carries a remark: it is the door with no vendor record and
    // no purchase-department option behind it, so a free-text note is what
    // says what it actually was.
    if (to === 'OTHERS') {
      remarks = String(req.body?.remarks || '').trim();
      if (!remarks) {
        return res.status(400).json({ error: 'A remark is required for this hand-off.' });
      }
    }

    // Courier hands the GRN to a service, not a person -- which courier, and
    // the docket number it went out under, in place of name/mobile -- and the
    // day it was handed over, same as every other destination but Bank.
    if (to === 'COURIER') {
      courierName = String(req.body?.courierName || '').trim();
      if (!courierName) {
        return res.status(400).json({ error: 'A courier name is required for this hand-off.' });
      }

      docketNo = String(req.body?.docketNo || '').trim();
      if (!docketNo) {
        return res.status(400).json({ error: 'A docket number is required for this hand-off.' });
      }

      date = String(req.body?.date || '');
      if (!isForwardCalendarDate(date)) {
        return res.status(400).json({ error: 'A real date is required for this hand-off.' });
      }
    }

    const { rows } = await query(
      `UPDATE csd_dispatches
       SET forwarded_to = $1, forwarded_route = $2, forwarded_name = $3,
           forwarded_mobile = $4, forwarded_date = $5, forwarded_courier_name = $6,
           forwarded_docket_no = $7, forwarded_remarks = $8,
           forwarded_at = NOW(), forwarded_by = $9
       WHERE id = $10 AND stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'RECEIVED'
             AND forwarded_to IS NULL
       RETURNING id`,
      [to, route, name, mobile, date, courierName, docketNo, remarks, req.user.id, id],
    );

    if (rows.length > 0) {
      const { rows: full } = await query(`${ACCOUNTS_RETURN_COLUMNS} WHERE c.id = $1`, [id]);
      const accountsReturn = mapAccountsReturn(full[0]);
      const where =
        to === 'VENDOR' && route === 'PURCHASE_DEPT'
          ? 'Purchase Dept'
          : to.charAt(0) + to.slice(1).toLowerCase();
      logActivity(req, {
        action: 'ACCOUNTS_FORWARD',
        target: accountsReturn.dprNo,
        summary:
          `Sent GRN ${accountsReturn.dprNo} to ${where}` +
          (name ? ` — handed to ${name}` : '') +
          (courierName ? ` — ${courierName}, docket ${docketNo}` : ''),
        details: {
          dispatchId: id,
          chequeNo: accountsReturn.chequeNo,
          to,
          ...(route ? { route } : {}),
          ...(name ? { name, mobile } : {}),
          ...(courierName ? { courierName, docketNo } : {}),
          ...(date ? { date } : {}),
          ...(remarks ? { remarks } : {}),
        },
      });
      return res.json({ accountsReturn });
    }

    const { rows: current } = await query(
      'SELECT stage, accounts_stage, forwarded_to FROM csd_dispatches WHERE id = $1',
      [id],
    );
    if (current.length === 0) {
      return res.status(404).json({ error: 'That GRN is no longer in the CSD queue.' });
    }
    if (current[0].stage !== 'MOVED_TO_ACCOUNTS' || current[0].accounts_stage !== 'RECEIVED') {
      return res.status(409).json({ error: 'Accounts has not received this GRN yet.' });
    }
    return res.status(409).json({ error: 'This GRN has already been forwarded.' });
  }),
);
