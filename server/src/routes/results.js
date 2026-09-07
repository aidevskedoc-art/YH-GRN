import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { STATUS } from '../services/reconcile.js';
import { gapsFor, summarise, dataQuality } from '../services/turnaround.js';
import { normKey } from '../services/normalize.js';
import { branchScope, bankAccountScope, branchAccountNo, branchPick } from '../services/branchScope.js';
import { branchFor } from '../config/screens.js';

export const resultsRouter = express.Router();

resultsRouter.use(requireAuth, requireScreen('results'));

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
   Cheque cleared, the four CSD stages, Sent to Records, Not sent -- so that
   picking a value asks for the rows showing it, rather than for some adjacent
   idea a reader has to translate.

   The buckets overlap on purpose, because the column does. A GRN whose cheque
   cleared while it was sitting at CSD shows "Cheque cleared" with its stage
   underneath, and it is a true answer to both "which cleared" and "which are
   approved at CSD" -- so both find it. Only NOT_SENT is exclusive, since it is
   defined as the absence of the others: it is what the column says when there
   is nothing else to say.
   -------------------------------------------------------------------------- */
const PROGRESS = {
  CLEARED: `${CHEQUE_CLEARED_ON} IS NOT NULL`,
  QUEUED: "c.stage = 'QUEUED'",
  RECEIVED: "c.stage = 'RECEIVED'",
  APPROVED: "c.stage = 'APPROVED'",
  REJECTED: "c.stage = 'REJECTED'",
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
         (c.id IS NOT NULL) AS csd_sent,
         c.sent_at          AS csd_sent_at,
         c.stage            AS csd_stage,
         (rd.id IS NOT NULL) AS records_sent,
         rd.sent_at          AS records_sent_at,
         ${CHEQUE_COLUMNS}
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

const rowSelect = (scope) => `${ROW_COLUMNS} ${resultJoins(scope)}`;

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
    csdSentAt: r.csd_sent_at ?? null,
    csdStage: r.csd_stage ?? null,
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
      `SELECT c.stage, COUNT(*)::int AS count, COALESCE(SUM(g.total_amount), 0) AS amount
       ${resultJoins(scope)}
       ${csdWhere}
       GROUP BY c.stage`,
      csdParams,
    );

    const csd = Object.fromEntries(CSD_STAGES.map((st) => [st, { count: 0, amount: 0 }]));
    for (const row of csdRows) {
      if (csd[row.stage]) csd[row.stage] = { count: row.count, amount: Number(row.amount) };
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
      ).join(', ')}
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

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      statusFilter(status, params),
      searchFilter(req.query.q, params),
      progressFilter(progress),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total ${resultJoins(scope)} ${where}`,
      params,
    );
    const total = countRows[0].total;

    const { rows } = await query(
      `${rowSelect(scope)} ${where} ${rowOrder(scope)}
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
 * GET /api/batches/:id/export?status=
 *
 * Every row for a status, unpaginated, as JSON. The Excel and CSV files are
 * assembled in the browser (client/src/services/exporter.js), so this endpoint
 * only has to answer with data -- no workbook is ever built or buffered here.
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

    if (status && !isKnownStatus(status)) {
      return res.status(400).json({ error: `Unknown status "${status}".` });
    }

    const progress = String(req.query.progress || '').toUpperCase();
    if (progress && !PROGRESS[progress]) {
      return res.status(400).json({ error: `Unknown status "${req.query.progress}".` });
    }

    const params = [];
    const where = whereFrom([
      batchFilter(scope, params),
      statusFilter(status, params),
      searchFilter(req.query.q, params),
      progressFilter(progress),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const { rows } = await query(`${rowSelect(scope)} ${where} ${rowOrder(scope)}`, params);

    return res.json({
      batchId: scope.id,
      name: scope.name,
      status: status || null,
      rows: rows.map(mapRow),
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
         c.id                AS csd_id,
         c.sent_at::date     AS sent_to_csd,
         c.received_at::date AS csd_received,
         c.approved_at::date AS csd_approved,
         c.rejected_at::date AS csd_rejected,
         c.stage             AS csd_stage`;

/**
 * The CSD handover for a GRN, if it has been sent. LEFT, and on the unique
 * dpr_no_key, so it neither drops a row that was never sent nor duplicates one
 * that was.
 */
const CSD_JOIN = 'LEFT JOIN csd_dispatches c ON c.dpr_no_key = g.dpr_no_key';

const TURNAROUND_COLUMNS = `
  SELECT r.status,
         a.id AS ageing_id,
         g.dpr_no, g.vendor_name, g.vendor_code, g.location,
         a.division_code, ${PAYABLE_AMOUNT} AS payable_amount,
         a.grn_no, a.bill_no,
         a.indent_date, a.po_date, a.security_date, a.grn_date,
         a.bill_to_audit, a.bill_handover_to_acc, a.chq_date,
         a.cheque_no,
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
    divisionCode: r.division_code,
    vendorName: r.vendor_name,
    vendorCode: r.vendor_code,
    location: r.location,
    payableAmount: r.payable_amount,
    indentDate: r.indent_date,
    poDate: r.po_date,
    securityDate: r.security_date,
    grnDate: r.grn_date,
    billToAudit: r.bill_to_audit,
    billHandOverToAcc: r.bill_handover_to_acc,
    chqDate: r.chq_date,
    chequeNo: r.cheque_no,
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

ageingRouter.use(requireAuth, requireScreen('results'));

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

recordsRouter.use(requireAuth, requireScreen('results'));

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

    const batchId = Number.isInteger(Number(body.batchId)) ? Number(body.batchId) : null;

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

    return res.status(201).json({
      record: { id: rows[0].id, dprNo: rows[0].dpr_no, sentAt: rows[0].sent_at },
    });
  }),
);
