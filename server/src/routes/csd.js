/**
 * The CSD queue: GRNs handed off from the Valid GRNs tab.
 *
 * A dispatch is a record of a handover, not a view of a reconciliation. It
 * carries its own copy of the GRN's details, taken at the moment Send to CSD
 * was pressed, so the queue still reads correctly after the upload it came from
 * has been deleted or superseded by the next month's -- see the comment on
 * csd_dispatches in schema.sql.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { normKey } from '../services/normalize.js';
import { branchFor } from '../config/screens.js';
import { branchScope, branchPick, branchAccountNo } from '../services/branchScope.js';

export const csdRouter = express.Router();

csdRouter.use(requireAuth, requireScreen('csd'));

const MAX_PAGE_SIZE = 200;

/**
 * How far a handover has got at CSD's end.
 *
 * QUEUED is where Send to CSD puts it: sent, not yet acknowledged. The other
 * four are CSD's own answers: Received leads to a verdict, Approved or
 * Rejected, and an approved bill has one further step -- handed back to
 * Accounts.
 *
 * Distinct from a dispatch's `status`, which is the reconciliation's verdict on
 * the GRN and does not change once it has been sent.
 */
const STAGES = ['QUEUED', 'RECEIVED', 'APPROVED', 'REJECTED', 'MOVED_TO_ACCOUNTS'];
const STAGE_SET = new Set(STAGES);

/**
 * Where a handover may go next, and nowhere else. A one-way ladder: nothing
 * moves back to an earlier CSD stage.
 *
 * CSD cannot rule on a bill they have not acknowledged receiving, and having
 * ruled they cannot un-rule -- an approval that could quietly become a rejection
 * an hour later is not a record of anything. Rejected is final for that reason.
 * Approved is not quite: an approved bill still has to be handed back to
 * Accounts, which is its one further move.
 *
 * MOVED_TO_ACCOUNTS is a resolution rather than a step back: CSD is done with
 * the GRN, and what happens to it next is Accounts' own accounts_stage,
 * tracked separately (see the accounts-returns endpoints below) -- it does not
 * reopen the CSD ladder, so it has no next stages of its own.
 *
 * Enforced here rather than only in the dropdown that offers it: the dropdown is
 * a convenience, this is the rule.
 */
const NEXT_STAGES = {
  QUEUED: ['RECEIVED'],
  RECEIVED: ['APPROVED', 'REJECTED'],
  APPROVED: ['MOVED_TO_ACCOUNTS'],
  REJECTED: [],
  MOVED_TO_ACCOUNTS: [],
};

/** Stage names as the message writes them: APPROVED -> "approved". */
const spellStage = (stage) => (stage === 'MOVED_TO_ACCOUNTS' ? 'moved to accounts' : String(stage).toLowerCase());

/**
 * The column that records when a row reached each stage, alongside the general
 * `stage_at`. QUEUED has none: `sent_at` already is the moment it was queued.
 *
 * Kept per stage rather than as one column because the turnaround report
 * measures sent-to-received and received-to-approved separately, and a single
 * stamp would have been overwritten by the second move.
 */
const STAGE_STAMPS = {
  RECEIVED: 'received_at',
  APPROVED: 'approved_at',
  REJECTED: 'rejected_at',
  MOVED_TO_ACCOUNTS: 'moved_to_accounts_at',
};

/**
 * The columns the search box looks in. The same three a GRN is chased by --
 * vendor, GRN number, bill number -- plus the ageing report's own GRN_NO, which
 * is what CSD quote back, and the cheque it was paid by.
 */
const SEARCH_COLUMNS = ['c.vendor_name', 'c.dpr_no', 'c.bill_no', 'c.ageing_grn_no', 'c.cheque_no'];

/** Push the search parameter and return its SQL, or null when nothing was typed. */
function searchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/** Push the parameter for a stage filter and return its SQL, or null for all. */
function stageFilter(stage, params) {
  if (!stage) return null;
  params.push(stage);
  return `c.stage = $${params.length}`;
}

/**
 * The configured bank account of the branch a dispatch belongs to, resolved
 * off its own snapshotted division_code and location -- the same lookup
 * results.js runs for the results and turnaround tables, see branchAccountNo.
 */
const BRANCH_ACCOUNT_NO = branchAccountNo({
  divisionCode: 'c.division_code',
  location: 'c.location',
});

const DISPATCH_COLUMNS = `
  SELECT c.id, c.dpr_no, c.division_code, c.dpr_date, c.bill_no, c.bill_date,
         c.vendor_code, c.vendor_name, c.location, c.ageing_grn_no,
         c.net_amt, c.adj_pur_return, c.adjusted_jv, c.tds_jv, c.payable_amount,
         c.cheque_no, c.chq_date, c.payment_doc_no,
         ${BRANCH_ACCOUNT_NO} AS account_no,
         c.status, c.discrepancy_notes,
         c.batch_id, c.sent_at,
         c.stage, c.stage_at, c.received_at, c.approved_at, c.rejected_at,
         c.moved_to_accounts_at, c.accounts_stage, c.accounts_received_at,
         c.forwarded_to, c.forwarded_route, c.forwarded_name, c.forwarded_mobile,
         c.forwarded_date, c.forwarded_at,
         u.full_name  AS sent_by_name,
         u.username   AS sent_by_username,
         su.full_name AS stage_by_name,
         su.username  AS stage_by_username,
         au.full_name AS accounts_received_by_name,
         au.username  AS accounts_received_by_username,
         fu.full_name AS forwarded_by_name,
         fu.username  AS forwarded_by_username,
         b.name       AS batch_name
  FROM csd_dispatches c
  LEFT JOIN users u ON u.id = c.sent_by
  LEFT JOIN users su ON su.id = c.stage_by
  LEFT JOIN users au ON au.id = c.accounts_received_by
  LEFT JOIN users fu ON fu.id = c.forwarded_by
  LEFT JOIN upload_batches b ON b.id = c.batch_id
`;

function mapDispatch(r) {
  return {
    id: r.id,
    dprNo: r.dpr_no,
    divisionCode: r.division_code,
    dprDate: r.dpr_date,
    billNo: r.bill_no,
    billDate: r.bill_date,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    location: r.location,
    ageingGrnNo: r.ageing_grn_no,
    netAmt: r.net_amt,
    adjPurReturn: r.adj_pur_return,
    adjustedJv: r.adjusted_jv,
    tdsJv: r.tds_jv,
    payableAmount: r.payable_amount,
    // Text, not numeric, same as the results table -- a cheque number is an
    // identifier, and one with a leading zero must not reopen as a plain number.
    chequeNo: r.cheque_no,
    // The day the ageing report says the cheque was cut -- not the day it
    // cleared, which this table does not track at all.
    chqDate: r.chq_date,
    paymentDocNo: r.payment_doc_no,
    // The account the dispatch's branch banks through, off the configuration
    // screen -- null when that branch has no account recorded, or none claims it.
    accountNo: r.account_no ?? null,
    // The reconciliation's verdict, fixed at the moment of sending. Named apart
    // from `stage` so the two are never mistaken for each other on the client.
    matchStatus: r.status,
    discrepancyNotes: r.discrepancy_notes,
    stage: r.stage,
    stageAt: r.stage_at,
    receivedAt: r.received_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    movedToAccountsAt: r.moved_to_accounts_at,
    stageBy: r.stage_by_name || r.stage_by_username || null,
    // Accounts' own progress once CSD has handed a GRN back -- see
    // accounts_stage in schema.sql. Null until stage reaches MOVED_TO_ACCOUNTS.
    accountsStage: r.accounts_stage,
    accountsReceivedAt: r.accounts_received_at,
    accountsReceivedBy: r.accounts_received_by_name || r.accounts_received_by_username || null,
    // Where Accounts sent the GRN on to, once received -- the last step in its
    // journey. forwardedRoute, forwardedName and forwardedMobile only ever
    // carry a value for VENDOR; see forwarded_route in schema.sql.
    forwardedTo: r.forwarded_to,
    forwardedRoute: r.forwarded_route,
    forwardedName: r.forwarded_name,
    forwardedMobile: r.forwarded_mobile,
    forwardedDate: r.forwarded_date,
    forwardedAt: r.forwarded_at,
    forwardedBy: r.forwarded_by_name || r.forwarded_by_username || null,
    batchId: r.batch_id,
    // Null once the upload it was read from has been deleted, which is a state
    // the screen shows rather than hides -- the handover still happened.
    batchName: r.batch_name,
    sentAt: r.sent_at,
    sentBy: r.sent_by_name || r.sent_by_username || null,
  };
}

/** The stored statuses a dispatch may carry, mirroring reconciliation_results. */
const DISPATCHABLE = new Set(['MATCHED', 'MATCHED_WITH_DIFF']);

/**
 * A yyyy-MM-dd string, or null. The client sends the dates straight back out of
 * a results row, where they are already ISO; anything else is dropped rather
 * than handed to Postgres to reject.
 */
function toDate(value) {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** A finite number, or null. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed text, or null -- never an empty string in a nullable column. */
function toText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

/**
 * The configured branch filter, against the dispatch's own snapshot.
 *
 * The queue is joined to nothing -- a handover keeps its own copy of the GRN so
 * it still reads once its upload is gone -- so the two names are read off this
 * table rather than off the reports. Both were copied from them at the moment
 * of sending, which is what makes that possible.
 *
 * A handover made before the location column existed has none, so only its
 * division code can speak for it. That is the same either/or the results screen
 * applies, and it lands the right way round here: such a row is still selected
 * by its branch code, rather than disappearing from every branch.
 */
const BRANCH_SCOPE = branchScope({ divisionCode: 'c.division_code', location: 'c.location' });

/**
 * The Location dropdown, read off the same two snapshot columns. It behaves
 * like the search box rather than like the stage filter: the cards count inside
 * it, because a location is what the queue is being looked at through, where a
 * stage is what the cards are for choosing.
 */
const LOCATION_FILTER = branchPick({ divisionCode: 'c.division_code', location: 'c.location' });

/**
 * The account's own branch grant, then the dropdown's choice within it. Same
 * pair and same reasoning as branchClauses on the results router: the first is
 * read off the signed-in user and cannot be widened by anything the browser
 * sends, and null for an administrator.
 */
function branchClauses(req, params) {
  return [
    LOCATION_FILTER(branchFor(req.user), params),
    LOCATION_FILTER(req.query.location, params),
  ];
}

/** `WHERE a AND b`, or '' when nothing is being filtered on. */
function whereFrom(clauses) {
  const kept = clauses.filter(Boolean);
  return kept.length > 0 ? `WHERE ${kept.join(' AND ')}` : '';
}

/**
 * GET /api/csd?page=&pageSize=&q=&stage=&all=
 *
 * The queue, newest handover first, plus the five stage counts the cards read.
 *
 * The counts follow the search but deliberately NOT the stage filter. They are
 * how a stage is picked, so computing them inside their own filter would zero
 * the other three the moment one was chosen and leave no way back.
 *
 * Both the counts and the header's total run over every row in scope rather
 * than the page: a figure that changed as you paged would be describing the
 * page, and the page is not what anyone is asking about.
 *
 * `all=1` drops the pagination, for the export.
 */
csdRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const stage = String(req.query.stage || '').toUpperCase();
    if (stage && !STAGE_SET.has(stage)) {
      return res.status(400).json({ error: `Unknown stage "${req.query.stage}".` });
    }

    // Search only -- the scope the cards count over.
    const scopeParams = [];
    const scopeWhere = whereFrom([
      searchFilter(req.query.q, scopeParams),
      BRANCH_SCOPE,
      ...branchClauses(req, scopeParams),
    ]);

    const { rows: byStage } = await query(
      `SELECT c.stage, COUNT(*)::int AS count, COALESCE(SUM(c.payable_amount), 0) AS amount
       FROM csd_dispatches c ${scopeWhere}
       GROUP BY c.stage`,
      scopeParams,
    );

    const stages = Object.fromEntries(STAGES.map((s) => [s, { count: 0, amount: 0 }]));
    let allCount = 0;
    let allAmount = 0;
    for (const r of byStage) {
      // A stage retired from STAGES but still on old rows would otherwise land
      // an unexpected key on the response; it is counted in the total either way.
      if (stages[r.stage]) stages[r.stage] = { count: r.count, amount: Number(r.amount) };
      allCount += r.count;
      allAmount += Number(r.amount);
    }

    // Search and stage -- the scope the rows and the pager run over.
    const params = [];
    const where = whereFrom([
      searchFilter(req.query.q, params),
      stageFilter(stage, params),
      BRANCH_SCOPE,
      ...branchClauses(req, params),
    ]);

    const total = stage ? stages[stage].count : allCount;
    const amount = stage ? stages[stage].amount : allAmount;

    const wantsAll = String(req.query.all || '') === '1';
    const order = 'ORDER BY c.sent_at DESC, c.id DESC';

    if (wantsAll) {
      const { rows } = await query(`${DISPATCH_COLUMNS} ${where} ${order}`, params);
      return res.json({ total, amount, stages, stage: stage || null, rows: rows.map(mapDispatch) });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));

    const { rows } = await query(
      `${DISPATCH_COLUMNS} ${where} ${order}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      page,
      pageSize,
      total,
      amount,
      stages,
      stage: stage || null,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      rows: rows.map(mapDispatch),
    });
  }),
);

/**
 * POST /api/csd
 *
 * Body: one Valid GRNs row, as the table holds it. Only the fields the queue
 * keeps are read; the rest of the row is ignored.
 *
 * Sending a GRN already in the queue refreshes its snapshot and its timestamp
 * rather than failing -- pressing the button twice, or sending the same GRN
 * again from a newer upload, is a re-send, not an error. The unique key is
 * derived here with the same normKey the reconciliation matches on, so
 * "236/25-26" and "236 25 26" are one GRN in the queue as well.
 */
csdRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};

    const dprNo = toText(body.dprNo);
    if (!dprNo) {
      return res.status(400).json({ error: 'A GRN number is required to send to CSD.' });
    }

    const key = normKey(dprNo);
    if (!key) {
      return res.status(400).json({ error: `"${dprNo}" is not a usable GRN number.` });
    }

    // Only a GRN that reached accounts can be handed on: the Pending tab has no
    // ageing figures for CSD to work from, and its rows carry no Send button.
    const status = toText(body.status);
    if (status && !DISPATCHABLE.has(status)) {
      return res.status(400).json({ error: 'Only GRNs found in the ageing report can go to CSD.' });
    }

    const values = [
      key,
      dprNo,
      toText(body.divisionCode),
      toDate(body.dprDate),
      toText(body.billNo),
      toDate(body.billDate),
      toText(body.vendorCode),
      toText(body.vendorName),
      toText(body.location),
      toText(body.ageingGrnNo),
      toNumber(body.netAmt),
      toNumber(body.adjPurReturn),
      toNumber(body.adjustedJv),
      toNumber(body.tdsJv),
      toNumber(body.payableAmount),
      toText(body.chequeNo),
      toDate(body.chqDate),
      toText(body.paymentDocNo),
      status,
      toText(body.discrepancyNotes),
      Number.isInteger(Number(body.batchId)) && Number(body.batchId) > 0 ? Number(body.batchId) : null,
      req.user.id,
    ];

    const { rows } = await query(
      `INSERT INTO csd_dispatches
         (dpr_no_key, dpr_no, division_code, dpr_date, bill_no, bill_date,
          vendor_code, vendor_name, location, ageing_grn_no, net_amt,
          adj_pur_return, adjusted_jv, tds_jv, payable_amount, cheque_no,
          chq_date, payment_doc_no, status, discrepancy_notes, batch_id, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (dpr_no_key) DO UPDATE SET
         dpr_no = EXCLUDED.dpr_no,
         division_code = EXCLUDED.division_code,
         dpr_date = EXCLUDED.dpr_date,
         bill_no = EXCLUDED.bill_no,
         bill_date = EXCLUDED.bill_date,
         vendor_code = EXCLUDED.vendor_code,
         vendor_name = EXCLUDED.vendor_name,
         location = EXCLUDED.location,
         ageing_grn_no = EXCLUDED.ageing_grn_no,
         net_amt = EXCLUDED.net_amt,
         adj_pur_return = EXCLUDED.adj_pur_return,
         adjusted_jv = EXCLUDED.adjusted_jv,
         tds_jv = EXCLUDED.tds_jv,
         payable_amount = EXCLUDED.payable_amount,
         cheque_no = EXCLUDED.cheque_no,
         chq_date = EXCLUDED.chq_date,
         payment_doc_no = EXCLUDED.payment_doc_no,
         status = EXCLUDED.status,
         discrepancy_notes = EXCLUDED.discrepancy_notes,
         batch_id = EXCLUDED.batch_id,
         sent_by = EXCLUDED.sent_by,
         sent_at = NOW()
       RETURNING id`,
      values,
    );

    const { rows: full } = await query(`${DISPATCH_COLUMNS} WHERE c.id = $1`, [rows[0].id]);
    return res.status(201).json({ dispatch: mapDispatch(full[0]) });
  }),
);

/**
 * PATCH /api/csd/:id/stage
 *
 * Body: { stage }. Only a stage the row may move to next -- see NEXT_STAGES.
 *
 * Who moved it and when are recorded alongside, so a row that has been through
 * CSD says so on its face rather than only in an audit table that does not exist.
 *
 * The move is one statement, with the permitted from-stages in its own WHERE
 * clause. Two people answering the same handover at once would otherwise both
 * read RECEIVED, both pass the check, and the second would overwrite the first's
 * verdict; here the second updates no rows and is told why.
 */
csdRouter.patch(
  '/:id/stage',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const stage = String(req.body?.stage || '').toUpperCase();
    if (!STAGE_SET.has(stage)) {
      return res.status(400).json({
        error: `"${req.body?.stage ?? ''}" is not a CSD stage. Expected one of ${STAGES.join(', ')}.`,
      });
    }

    // Which stages this one may be reached from -- the reverse of NEXT_STAGES.
    const from = STAGES.filter((s) => NEXT_STAGES[s].includes(stage));

    // COALESCE, not a plain assignment: the ladder means a stage is reached once,
    // and the first time it was reached is the answer the report wants.
    const stamp = STAGE_STAMPS[stage];
    // Handing a GRN to MOVED_TO_ACCOUNTS starts Accounts' own two-step
    // acknowledgement fresh -- QUEUED the moment it lands, same as this
    // dispatch itself started at QUEUED on the CSD side.
    const startsAccountsStage = stage === 'MOVED_TO_ACCOUNTS' ? ", accounts_stage = 'QUEUED'" : '';
    const { rows } = await query(
      `UPDATE csd_dispatches
       SET stage = $1, stage_at = NOW(), stage_by = $2
           ${stamp ? `, ${stamp} = COALESCE(${stamp}, NOW())` : ''}
           ${startsAccountsStage}
       WHERE id = $3 AND stage = ANY($4)
       RETURNING id`,
      [stage, req.user.id, id, from],
    );

    if (rows.length > 0) {
      const { rows: full } = await query(`${DISPATCH_COLUMNS} WHERE c.id = $1`, [id]);
      return res.json({ dispatch: mapDispatch(full[0]) });
    }

    // Nothing moved. Either the row is gone, or it is not somewhere this stage
    // can be reached from -- and the two need different answers.
    const { rows: current } = await query('SELECT stage FROM csd_dispatches WHERE id = $1', [id]);
    if (current.length === 0) {
      return res.status(404).json({ error: 'That GRN is no longer in the CSD queue.' });
    }

    const now = current[0].stage;
    // A repeat of the stage it is already in: the answer already stands, so say
    // so plainly rather than reporting it as an illegal move.
    if (now === stage) {
      return res.status(409).json({ error: `This GRN is already marked ${spellStage(stage)}.` });
    }

    const allowed = NEXT_STAGES[now] || [];
    return res.status(409).json({
      error: allowed.length
        ? `A GRN marked ${spellStage(now)} can only be moved to ${allowed
            .map(spellStage)
            .join(' or ')}.`
        : `This GRN has already been ${spellStage(now)}. That is final — take it back off` +
          ` the queue and send it again if it has to be reopened.`,
    });
  }),
);

/**
 * The stamps that can be corrected, and the column behind each.
 *
 * Recorded automatically when a button is pressed, so unlike the ageing
 * report's checkpoints they cannot arrive mistyped -- but a handover entered a
 * day late, or a status ticked on the Monday for something that arrived on the
 * Friday, still leaves the wrong date on the record. These are correctable for
 * that.
 *
 * The three Accounts hand-back stamps sit alongside the four CSD ones for the
 * same reason: each is still just the day a button was pressed, and that can
 * be entered late exactly as a CSD stamp can.
 */
const EDITABLE_CSD_DATES = {
  sentToCsd: 'sent_at',
  csdReceived: 'received_at',
  csdApproved: 'approved_at',
  csdRejected: 'rejected_at',
  movedToAccountsAt: 'moved_to_accounts_at',
  accountsReceivedAt: 'accounts_received_at',
  forwardedAt: 'forwarded_at',
};

/** The stage a stamp belongs to, for the message when it has not been reached. */
const STAMP_STAGE = {
  sentToCsd: 'sent',
  csdReceived: 'received',
  csdApproved: 'approved',
  csdRejected: 'rejected',
  movedToAccountsAt: 'moved to accounts',
  accountsReceivedAt: 'received by accounts',
  forwardedAt: 'forwarded',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in yyyy-MM-dd. The pattern alone accepts 2026-02-31,
 * which Postgres then rejects with an error nobody can act on.
 */
function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * PATCH /api/csd/:id/dates
 *
 * Body: any subset of the seven stamps, each yyyy-MM-dd. Absent fields are left
 * alone.
 *
 * Only a stamp the handover already carries can be corrected. Writing one for a
 * stage the row has not reached would leave it with, say, an approval date
 * while still sitting at Received -- a state the stage ladder cannot produce
 * and the report cannot read. Advancing a row is what the status dropdown is
 * for; this only fixes the date it landed on.
 *
 * Clearing is refused for the same reason: a stage that has been reached
 * happened on some day, and blanking it would lose that without un-reaching it.
 *
 * The stored value is a timestamp and the correction is a date, so the time of
 * day is replaced with midnight. The queue screen shows a time against each
 * handover; a corrected one reads 00:00 there, which is the honest answer --
 * the day is known and the hour is not.
 */
csdRouter.patch(
  '/:id/dates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const { rows: existing } = await query(
      `SELECT sent_at, received_at, approved_at, rejected_at,
              moved_to_accounts_at, accounts_received_at, forwarded_at
       FROM csd_dispatches WHERE id = $1`,
      [id],
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'That GRN is no longer in the CSD queue.' });
    }

    const assignments = [];
    const params = [];

    for (const [field, column] of Object.entries(EDITABLE_CSD_DATES)) {
      if (!(field in req.body)) continue;

      const raw = req.body[field];
      if (raw === '' || raw === null || raw === undefined) {
        return res.status(400).json({
          error: `"${field}" cannot be cleared — the GRN did reach that stage on some day.`,
        });
      }

      const value = String(raw);
      if (!isCalendarDate(value)) {
        return res.status(400).json({ error: `"${field}" must be a real date in yyyy-MM-dd.` });
      }

      if (!existing[0][column]) {
        return res.status(409).json({
          error: `This GRN has not been ${STAMP_STAGE[field]} yet, so it has no date to correct.`,
        });
      }

      params.push(value);
      assignments.push(`${column} = $${params.length}::date`);
    }

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'No date was given to change.' });
    }

    params.push(id);
    await query(
      `UPDATE csd_dispatches SET ${assignments.join(', ')} WHERE id = $${params.length}`,
      params,
    );

    const { rows: full } = await query(`${DISPATCH_COLUMNS} WHERE c.id = $1`, [id]);
    return res.json({ dispatch: mapDispatch(full[0]) });
  }),
);

/**
 * DELETE /api/csd/:id
 *
 * Take a GRN back off the queue. The Send button on the results tab goes back
 * to its unsent state, because that flag is read from this table rather than
 * stored on the result.
 */
csdRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown row.' });
    }

    const { rowCount } = await query('DELETE FROM csd_dispatches WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'That GRN is no longer in the CSD queue.' });
    }

    return res.status(204).end();
  }),
);
