/**
 * OP Pharmacy's CSD queue: GRNs handed off from Pharmacy Results -- the CS
 * Department screen's "OP Pharmacy CSD" view.
 *
 * routes/csd.js for the pharmacies' own table (ph_csd_dispatches), so that the
 * one screen can show either queue and neither can reach the other's rows.
 * The rules are that file's own, imported rather than written again: the
 * stages and the ladder between them, which of them a handover can still be
 * taken back from, that a rejection carries its reason, and how a posted row
 * is read. Its comments say why each is as it is; what is noted here is what
 * differs.
 *
 *  - A handover is known by its GRN number AND its unit, as a pharmacy GRN is
 *    (see "What a pharmacy GRN is known by" in services/phIngest.js). Two
 *    units' GRNs of one number are two handovers.
 *  - So is a cheque. A cheque number is one cheque only within the account it
 *    is drawn on, and two units' accounts can each have issued the same
 *    number -- so wherever the hospitals' queue gathers "every handover this
 *    cheque pays", this one gathers the ones of that unit.
 *  - A row is tied to its branch by its own snapshot held equal to
 *    Ph-Configuration's names, folded (services/phBranchScope.js), where the
 *    hospitals search the GRN's Location for the branch.
 *  - The Vendor Master's four columns and the MSME filter are looked up by the
 *    vendor's Focus code, which a handover keeps beside its PM Code: the
 *    master knows a pharmacy vendor by that code, not by the PM Code.
 *  - A stamp's date is corrected as the hospitals' is, from the pharmacies' own
 *    GRN age report (phTurnaround in routes/phResults.js): the same seven
 *    stamps, and the same refusals.
 *
 * Behind its own grants, as the hospital queue is behind its own: OP Pharmacy
 * CSD (`ph-csd`) for the queue itself, and that or either of the two pharmacy
 * results screens (`ph-results`, `ph-accounts-department`) for handing a GRN
 * over and taking it back. No hospital grant opens anything here.
 *
 * Each answer is a function of something that can run a query -- the pool for
 * a request, or one connection for a check that has to see what it has only
 * just written -- with the route below it doing no more than read the request,
 * call it, and log what changed (as routes/phResults.js and routes/phConfig.js
 * are laid out). One that has to refuse returns `{ refused: { status, error } }`.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { normKey } from '../services/normalize.js';
import { branchFor } from '../config/screens.js';
import { folded } from '../services/phIngest.js';
import { phBranchScope, phBranchPick, phBranchAccountNo } from '../services/phBranchScope.js';
import { logActivity } from '../services/activityLog.js';
import { msmeFilter, vendorColumns, vendorFields } from '../services/vendorMsme.js';
import { PH_CASH_TO_RECORDS, PH_NOT_IN_ACCOUNTS, PH_WRONG_UNIT, phGrnStanding } from './phResults.js';
import {
  MAX_PAGE_SIZE,
  STAGES,
  STAGE_SET,
  NEXT_STAGES,
  spellStage,
  STAGE_STAMPS,
  DISPATCHABLE,
  toDate,
  toNumber,
  toText,
  whereFrom,
  CHEQUE_VIEW,
  STAGE_REMARKS_REQUIRED,
  MAX_REMARKS,
  TAKE_BACK_STAGES,
  NO_TAKE_BACK_REASON,
  EDITABLE_CSD_DATES,
  STAMP_STAGE,
  isCalendarDate,
} from './csd.js';

export const phCsdRouter = express.Router();

phCsdRouter.use(requireAuth);

/** The queue is CSD's own work; handing over and taking back is Accounts' side of it. */
const CSD_QUEUE = requireScreen('ph-csd');
const CSD_HANDOVER = requireScreen('ph-csd', 'ph-results', 'ph-accounts-department');

/** The pool, in the shape the functions below take. */
const POOL = { query };

const refuse = (status, error) => ({ refused: { status, error } });
const GONE = 'That GRN is no longer in the CSD queue.';

/** The columns the search box looks in -- csd.js's, with the unit a handover is known by. */
const SEARCH_COLUMNS = [
  'c.vendor_name',
  'c.vendor_code',
  'c.dpr_no',
  'c.bill_no',
  'c.ageing_grn_no',
  'c.cheque_no',
  'c.location',
];

function searchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

function stageFilter(stage, params) {
  if (!stage) return null;
  params.push(stage);
  return `c.stage = $${params.length}`;
}

/**
 * Every handover paid by one cheque -- of one unit, where `unitKey` says which
 * -- or null when no cheque was asked for. An exact match, and it narrows the
 * stage counts as well as the rows; see chequeFilter in csd.js for both.
 */
function chequeFilter(chequeNo, unitKey, params) {
  if (!chequeNo) return null;
  params.push(chequeNo);
  const cheque = `c.cheque_no = $${params.length}`;
  if (!unitKey) return cheque;
  params.push(unitKey);
  return `(${cheque} AND c.unit_key = $${params.length})`;
}

/**
 * A handover's two keys, as services/phBranchScope.js reads them, off its own
 * snapshot: the queue is joined to nothing, so that it still reads once the
 * upload a GRN came in is gone.
 */
const ROW_KEYS = { divisionKey: folded('c.division_code'), unitKey: 'c.unit_key' };

/** The handovers of the ticked branches, or every one while none is ticked. */
const BRANCH_SCOPE = phBranchScope(ROW_KEYS);

/** One branch, by its Unit name (HIS): the Location dropdown, and an account's own grant. */
const LOCATION_FILTER = phBranchPick(ROW_KEYS);

/** The account the handover's branch banks through, off Ph-Configuration. */
const BRANCH_ACCOUNT_NO = phBranchAccountNo(ROW_KEYS);

/**
 * The account's own branch grant, then the dropdown's choice within it. The
 * grant is read off the signed-in user by the route and cannot be widened by
 * anything the browser sends; it is null for an administrator.
 */
function branchClauses({ grant, location, msme }, params) {
  return [
    LOCATION_FILTER(grant, params),
    LOCATION_FILTER(location, params),
    // The MSME dropdown, a scope the cards count inside, as on the hospitals'.
    msmeFilter(msme, 'c.focus_code'),
  ];
}

/**
 * The last time CSD rejected this GRN before the handover it is on now -- see
 * PRIOR_REJECTION_JOIN in csd.js. On the number and the unit: another unit's
 * rejection of a GRN of the same number is not this one's history.
 */
const PRIOR_REJECTION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT h.reject_remarks, h.rejected_at, h.superseded_at
    FROM ph_csd_rejection_history h
    WHERE h.dpr_no_key = c.dpr_no_key AND h.unit_key = c.unit_key
    ORDER BY h.superseded_at DESC, h.id DESC
    LIMIT 1
  ) pr ON TRUE`;

/** The dispatch select, with `extra` columns appended to its list (see chequeDispatches). */
const dispatchSelect = (extra = '') => `
  SELECT c.id, c.dpr_no, c.unit_key, c.division_code, c.dpr_date, c.bill_no, c.bill_date,
         c.vendor_code, c.vendor_name, c.location, c.ageing_grn_no,
         c.net_amt, c.adj_pur_return, c.adjusted_jv, c.tds_jv, c.payable_amount,
         c.cheque_no, c.chq_date, c.payment_doc_no,
         ${BRANCH_ACCOUNT_NO} AS account_no,
         ${vendorColumns('c.focus_code')},
         c.status, c.discrepancy_notes,
         c.batch_id, c.sent_at,
         c.stage, c.stage_at, c.received_at, c.approved_at, c.rejected_at,
         c.moved_to_accounts_at, c.accounts_stage, c.accounts_received_at,
         c.forwarded_to, c.forwarded_route, c.forwarded_name, c.forwarded_mobile,
         c.forwarded_date, c.forwarded_at,
         c.reject_remarks,
         pr.reject_remarks AS prior_reject_remarks,
         pr.rejected_at    AS prior_rejected_at,
         pr.superseded_at  AS prior_reopened_at,
         u.full_name  AS sent_by_name,
         u.username   AS sent_by_username,
         su.full_name AS stage_by_name,
         su.username  AS stage_by_username,
         au.full_name AS accounts_received_by_name,
         au.username  AS accounts_received_by_username,
         fu.full_name AS forwarded_by_name,
         fu.username  AS forwarded_by_username,
         b.name       AS batch_name${extra}
  FROM ph_csd_dispatches c
  LEFT JOIN users u ON u.id = c.sent_by
  LEFT JOIN users su ON su.id = c.stage_by
  LEFT JOIN users au ON au.id = c.accounts_received_by
  LEFT JOIN users fu ON fu.id = c.forwarded_by
  LEFT JOIN ph_upload_batches b ON b.id = c.batch_id
  ${PRIOR_REJECTION_JOIN}
`;

const DISPATCH_COLUMNS = dispatchSelect();

/** A handover as the screen reads it -- mapDispatch in csd.js, less the Vendor Master's four. */
function mapDispatch(r) {
  return {
    id: r.id,
    dprNo: r.dpr_no,
    // The unit the handover is known by, folded -- what a cheque's handovers
    // are gathered within. `location` is the same unit as the report wrote it.
    unitKey: r.unit_key,
    divisionCode: r.division_code,
    dprDate: r.dpr_date,
    billNo: r.bill_no,
    billDate: r.bill_date,
    vendorCode: r.vendor_code,
    vendorName: r.vendor_name,
    // The vendor's MSME No, MSME Status, Inter and Supply Type, read live off
    // the Vendor Master by the handover's Focus code.
    ...vendorFields(r),
    location: r.location,
    ageingGrnNo: r.ageing_grn_no,
    netAmt: r.net_amt,
    adjPurReturn: r.adj_pur_return,
    adjustedJv: r.adjusted_jv,
    tdsJv: r.tds_jv,
    payableAmount: r.payable_amount,
    chequeNo: r.cheque_no,
    chqDate: r.chq_date,
    paymentDocNo: r.payment_doc_no,
    accountNo: r.account_no ?? null,
    matchStatus: r.status,
    discrepancyNotes: r.discrepancy_notes,
    stage: r.stage,
    stageAt: r.stage_at,
    receivedAt: r.received_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    rejectRemarks: r.reject_remarks ?? null,
    priorRejection: r.prior_rejected_at
      ? {
          remarks: r.prior_reject_remarks ?? null,
          rejectedAt: r.prior_rejected_at,
          reopenedAt: r.prior_reopened_at,
        }
      : null,
    movedToAccountsAt: r.moved_to_accounts_at,
    stageBy: r.stage_by_name || r.stage_by_username || null,
    // Accounts' own progress once CSD has handed a GRN back. Started by the
    // Moved to accounts move; nothing on the pharmacy side moves it on yet.
    accountsStage: r.accounts_stage,
    accountsReceivedAt: r.accounts_received_at,
    accountsReceivedBy: r.accounts_received_by_name || r.accounts_received_by_username || null,
    forwardedTo: r.forwarded_to,
    forwardedRoute: r.forwarded_route,
    forwardedName: r.forwarded_name,
    forwardedMobile: r.forwarded_mobile,
    forwardedDate: r.forwarded_date,
    forwardedAt: r.forwarded_at,
    forwardedBy: r.forwarded_by_name || r.forwarded_by_username || null,
    batchId: r.batch_id,
    batchName: r.batch_name,
    sentAt: r.sent_at,
    sentBy: r.sent_by_name || r.sent_by_username || null,
  };
}

/** One handover, whole, by its id. */
async function dispatchById(db, id) {
  const { rows } = await db.query(`${DISPATCH_COLUMNS} WHERE c.id = $1`, [id]);
  return rows.length > 0 ? mapDispatch(rows[0]) : null;
}

/**
 * The queue's Cheque view: one row per cheque instead of one per handover --
 * chequeDispatches in csd.js, with a cheque being its number within its unit.
 */
async function chequeDispatches(db, { q, stage, chequeNo, unitKey, scope, page, pageSize, all }) {
  const params = [];
  const baseWhere = whereFrom([
    chequeFilter(chequeNo, unitKey, params),
    BRANCH_SCOPE,
    ...branchClauses(scope, params),
    `COALESCE(c.cheque_no, '') <> ''`,
  ]);
  const hitClauses = [searchFilter(q, params), stageFilter(stage, params)].filter(Boolean);
  // COALESCE because an ILIKE over a null column is null, not false.
  const hit = `COALESCE((${hitClauses.length > 0 ? hitClauses.join(' AND ') : 'TRUE'}), FALSE)`;

  const { rows: totals } = await db.query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(t.amount), 0) AS amount FROM (
       SELECT SUM(c.payable_amount) AS amount
       FROM ph_csd_dispatches c ${baseWhere}
       GROUP BY c.unit_key, c.cheque_no
       HAVING BOOL_OR(${hit})
     ) t`,
    params,
  );

  const { rows } = await db.query(
    `SELECT z.* FROM (
       SELECT q.*,
              SUM(q.payable_amount) OVER (PARTITION BY q.unit_key, q.cheque_no) AS cheque_amount,
              (COUNT(*) OVER (PARTITION BY q.unit_key, q.cheque_no))::int AS cheque_grn_count,
              ROW_NUMBER() OVER (
                PARTITION BY q.unit_key, q.cheque_no ORDER BY q.cv_hit DESC, q.sent_at DESC, q.id DESC
              ) AS cv_rn
       FROM (${dispatchSelect(`, ${hit} AS cv_hit`)} ${baseWhere}) q
     ) z
     WHERE z.cv_rn = 1 AND z.cv_hit
     ORDER BY z.sent_at DESC, z.id DESC
     ${all ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
    all ? params : [...params, pageSize, (page - 1) * pageSize],
  );

  return {
    total: totals[0].total,
    amount: Number(totals[0].amount),
    rows: rows.map((r) => ({
      ...mapDispatch(r),
      chequeAmount: r.cheque_amount ?? null,
      chequeGrnCount: r.cheque_grn_count ?? 0,
    })),
  };
}

/**
 * The queue, newest handover first, plus the five stage counts the cards read
 * -- GET /api/csd, answer for answer. The counts follow the search and the
 * location but not the stage filter; `all` drops the pagination, for the
 * export; `chequeNo` with `unitKey` is one cheque's handovers, which the
 * Action column asks for before it moves anything; `view` 'cheque' folds the
 * rows into one per cheque. `grant` is the account's own branch, or null.
 */
export async function listPhCsd(
  db,
  {
    q, stage: stageIn, location, msme, grant, chequeNo: chequeIn, unitKey: unitIn, view, all,
    page: pageIn, pageSize: sizeIn,
  } = {},
) {
  const stage = String(stageIn || '').toUpperCase();
  if (stage && !STAGE_SET.has(stage)) return refuse(400, `Unknown stage "${stageIn}".`);

  const chequeNo = String(chequeIn || '').trim();
  const unitKey = String(unitIn || '').trim();
  const scope = { grant, location, msme };

  // Search only -- the scope the cards count over.
  const scopeParams = [];
  const scopeWhere = whereFrom([
    searchFilter(q, scopeParams),
    chequeFilter(chequeNo, unitKey, scopeParams),
    BRANCH_SCOPE,
    ...branchClauses(scope, scopeParams),
  ]);

  // `cheques` is how many cheques each stage's handovers are spread across --
  // see the note in csd.js. A cheque being its number within its unit, that
  // pair is what is counted distinct.
  const { rows: byStage } = await db.query(
    `SELECT c.stage,
            COUNT(*)::int AS count,
            COUNT(DISTINCT (c.unit_key, c.cheque_no)) FILTER (WHERE COALESCE(c.cheque_no, '') <> '')::int AS cheques,
            COALESCE(SUM(c.payable_amount), 0) AS amount
     FROM ph_csd_dispatches c ${scopeWhere}
     GROUP BY c.stage`,
    scopeParams,
  );

  const stages = Object.fromEntries(STAGES.map((s) => [s, { count: 0, cheques: 0, amount: 0 }]));
  let allCount = 0;
  let allAmount = 0;
  for (const r of byStage) {
    if (stages[r.stage]) {
      stages[r.stage] = { count: r.count, cheques: r.cheques, amount: Number(r.amount) };
    }
    allCount += r.count;
    allAmount += Number(r.amount);
  }

  const page = Math.max(1, Number(pageIn) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(sizeIn) || 20));

  // The Cheque view: one row per cheque rather than per handover.
  if (String(view || '').toLowerCase() === CHEQUE_VIEW) {
    const result = await chequeDispatches(db, { q, stage, chequeNo, unitKey, scope, page, pageSize, all });
    return {
      ...result,
      stages,
      stage: stage || null,
      ...(all ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) }),
    };
  }

  // Search and stage -- the scope the rows and the pager run over.
  const params = [];
  const where = whereFrom([
    searchFilter(q, params),
    stageFilter(stage, params),
    chequeFilter(chequeNo, unitKey, params),
    BRANCH_SCOPE,
    ...branchClauses(scope, params),
  ]);

  const total = stage ? stages[stage].count : allCount;
  const amount = stage ? stages[stage].amount : allAmount;
  const order = 'ORDER BY c.sent_at DESC, c.id DESC';

  if (all) {
    const { rows } = await db.query(`${DISPATCH_COLUMNS} ${where} ${order}`, params);
    return { total, amount, stages, stage: stage || null, rows: rows.map(mapDispatch) };
  }

  const { rows } = await db.query(
    `${DISPATCH_COLUMNS} ${where} ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return {
    page,
    pageSize,
    total,
    amount,
    stages,
    stage: stage || null,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map(mapDispatch),
  };
}

/**
 * Hand one GRN over: `body` is one Pharmacy Results row, as the table holds
 * it, of which only the fields the queue keeps are read. As POST /api/csd,
 * sending a GRN already in the queue refreshes its snapshot and its timestamp
 * rather than failing.
 *
 * The key is the GRN number and the unit, each folded as the upload folds
 * them, so the handover is the one Pharmacy Results joins back to its GRN.
 */
export async function sendPhCsd(db, body = {}, userId = null) {
  const dprNo = toText(body.dprNo);
  if (!dprNo) return refuse(400, 'A GRN number is required to send to CSD.');

  const key = normKey(dprNo);
  if (!key) return refuse(400, `"${dprNo}" is not a usable GRN number.`);

  // Only a GRN that reached accounts can be handed on.
  const status = toText(body.status);
  if (status && !DISPATCHABLE.has(status)) {
    return refuse(400, 'Only GRNs found in the Vendor Age report can go to CSD.');
  }

  const location = toText(body.location);
  // And asked of what is stored, not only of the row the page sent: that row
  // may have been loaded before a later BPAD status came in, and a GRN BPAD
  // does not have at Accounts' desk is not in Accounts whatever it reads
  // there (BEFORE_ACCOUNTS in routes/phResults.js). A GRN not on file at all
  // is let through, as it always was.
  const standing = await phGrnStanding(db, key, normKey(location));
  // The number is on file, but not under the unit this request names: not
  // this GRN, and a handover filed so would join back to no GRN's row.
  if (standing?.wrongUnit) return refuse(409, PH_WRONG_UNIT);
  if (standing && !standing.reached) return refuse(409, PH_NOT_IN_ACCOUNTS);
  // A cash bill has no cheque to hand over: Records is the only place it goes
  // (the page offers nothing else for it; this is the rule itself).
  if (standing?.cashPayment) return refuse(409, PH_CASH_TO_RECORDS);

  const values = [
    key,
    normKey(location),
    dprNo,
    toText(body.divisionCode),
    location,
    toDate(body.dprDate),
    toText(body.billNo),
    toDate(body.billDate),
    toText(body.vendorCode),
    toText(body.vendorName),
    // The Focus document, whole, where the row has it -- "PSE/26-27/HE00184"
    // is what CSD quote back, and the bare number is beside it as the GRN No.
    toText(body.ageingGrnDoc) ?? toText(body.ageingGrnNo),
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
    userId,
    // The code the Vendor Master knows the vendor by -- see focus_code in schema.sql.
    toText(body.focusCode),
  ];

  const { rows } = await db.query(
    `INSERT INTO ph_csd_dispatches
       (dpr_no_key, unit_key, dpr_no, division_code, location, dpr_date, bill_no, bill_date,
        vendor_code, vendor_name, ageing_grn_no, net_amt,
        adj_pur_return, adjusted_jv, tds_jv, payable_amount, cheque_no,
        chq_date, payment_doc_no, status, discrepancy_notes, batch_id, sent_by, focus_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT (dpr_no_key, unit_key) DO UPDATE SET
       focus_code = EXCLUDED.focus_code,
       dpr_no = EXCLUDED.dpr_no,
       division_code = EXCLUDED.division_code,
       location = EXCLUDED.location,
       dpr_date = EXCLUDED.dpr_date,
       bill_no = EXCLUDED.bill_no,
       bill_date = EXCLUDED.bill_date,
       vendor_code = EXCLUDED.vendor_code,
       vendor_name = EXCLUDED.vendor_name,
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

  return { dispatch: await dispatchById(db, rows[0].id) };
}

/**
 * Move one handover to a stage -- PATCH /api/csd/:id/stage, rule for rule:
 * only a stage the row may move to next, a reason required for REJECTED and
 * ignored otherwise, and the move in one statement with the permitted
 * from-stages in its own WHERE clause, so two people answering one handover at
 * once cannot both get through.
 *
 * @returns `{ dispatch, from }` -- `from` being the stage it left
 */
export async function movePhCsdStage(db, id, stageIn, remarksIn, userId = null) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');

  const stage = String(stageIn || '').toUpperCase();
  if (!STAGE_SET.has(stage)) {
    return refuse(400, `"${stageIn ?? ''}" is not a CSD stage. Expected one of ${STAGES.join(', ')}.`);
  }

  const needsRemarks = STAGE_REMARKS_REQUIRED[stage];
  const remarks = String(remarksIn ?? '').trim();
  if (needsRemarks && !remarks) return refuse(400, `A reason is required when ${needsRemarks} a GRN.`);
  if (remarks.length > MAX_REMARKS) {
    return refuse(400, `That reason is too long — ${MAX_REMARKS} characters at most.`);
  }

  // Which stages this one may be reached from -- the reverse of NEXT_STAGES.
  const from = STAGES.filter((s) => NEXT_STAGES[s].includes(stage));

  const stamp = STAGE_STAMPS[stage];
  const startsAccountsStage = stage === 'MOVED_TO_ACCOUNTS' ? ", accounts_stage = 'QUEUED'" : '';
  const writesRemarks = needsRemarks ? ', reject_remarks = $5' : '';
  const params = [stage, userId, id, from];
  if (needsRemarks) params.push(remarks);
  const { rows } = await db.query(
    `UPDATE ph_csd_dispatches
     SET stage = $1, stage_at = NOW(), stage_by = $2
         ${stamp ? `, ${stamp} = COALESCE(${stamp}, NOW())` : ''}
         ${startsAccountsStage}
         ${writesRemarks}
     WHERE id = $3 AND stage = ANY($4)
     RETURNING id`,
    params,
  );

  if (rows.length > 0) {
    return {
      dispatch: await dispatchById(db, id),
      from: from.length === 1 ? from[0] : from.join(' / '),
      to: stage,
      ...(needsRemarks ? { remarks } : {}),
    };
  }

  // Nothing moved. Either the row is gone, or it is not somewhere this stage
  // can be reached from -- and the two need different answers.
  const { rows: current } = await db.query('SELECT stage FROM ph_csd_dispatches WHERE id = $1', [id]);
  if (current.length === 0) return refuse(404, GONE);

  const now = current[0].stage;
  if (now === stage) return refuse(409, `This GRN is already marked ${spellStage(stage)}.`);

  const allowed = NEXT_STAGES[now] || [];
  return refuse(
    409,
    allowed.length
      ? `A GRN marked ${spellStage(now)} can only be moved to ${allowed.map(spellStage).join(' or ')}.`
      : `This GRN has already been ${spellStage(now)}. That is final — take it back off` +
          ` the queue and send it again if it has to be reopened.`,
  );
}

/**
 * Correct the day one or more of a handover's stamps landed on -- PATCH
 * /api/csd/:id/dates, rule for rule: any subset of the seven stamps, each a
 * real yyyy-MM-dd; only a stamp the handover already carries, since writing one
 * for a stage it has not reached would leave a state the ladder cannot
 * produce; and never cleared, since a stage that was reached happened on some
 * day. Nothing is written unless every field given passes.
 *
 * @returns `{ dispatch, changes, dprNo, location }` -- `changes` being each
 *   stamp's old and new day. `dispatch` is null where the handover was taken
 *   back or deleted between the write and reading it again: the correction was
 *   made all the same, so the GRN and its unit come from the row as first read
 *   and the route can still say whose dates were changed.
 */
export async function updatePhCsdDates(db, id, body = {}) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');

  const { rows: existing } = await db.query(
    `SELECT dpr_no, location, sent_at, received_at, approved_at, rejected_at,
            moved_to_accounts_at, accounts_received_at, forwarded_at
     FROM ph_csd_dispatches WHERE id = $1`,
    [id],
  );
  if (existing.length === 0) return refuse(404, GONE);

  const given = body || {};
  const assignments = [];
  const params = [];
  // Old and new day per corrected stamp, for the activity log.
  const changes = {};

  for (const [field, column] of Object.entries(EDITABLE_CSD_DATES)) {
    if (!(field in given)) continue;

    const raw = given[field];
    if (raw === '' || raw === null || raw === undefined) {
      return refuse(400, `"${field}" cannot be cleared — the GRN did reach that stage on some day.`);
    }

    const value = String(raw);
    if (!isCalendarDate(value)) return refuse(400, `"${field}" must be a real date in yyyy-MM-dd.`);

    if (!existing[0][column]) {
      return refuse(409, `This GRN has not been ${STAMP_STAGE[field]} yet, so it has no date to correct.`);
    }

    params.push(value);
    assignments.push(`${column} = $${params.length}::date`);
    changes[field] = { from: existing[0][column], to: value };
  }

  if (assignments.length === 0) return refuse(400, 'No date was given to change.');

  params.push(id);
  const { rows } = await db.query(
    `UPDATE ph_csd_dispatches SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params,
  );
  // Taken back between the read and the write.
  if (rows.length === 0) return refuse(404, GONE);

  return {
    dispatch: await dispatchById(db, id),
    changes,
    dprNo: existing[0].dpr_no,
    location: existing[0].location,
  };
}

/**
 * Take a GRN back off the queue -- DELETE /api/csd/:id. Refused once CSD have
 * acted, here as well as in the two screens that offer the button.
 *
 * @returns `{ gone }`, the row as it was
 */
export async function takeBackPhCsd(db, id) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');

  const { rows } = await db.query(
    'SELECT dpr_no, location, stage, cheque_no FROM ph_csd_dispatches WHERE id = $1',
    [id],
  );
  if (rows.length === 0) return refuse(404, GONE);

  const { dpr_no: dprNo, stage } = rows[0];
  if (!TAKE_BACK_STAGES.includes(stage)) {
    return refuse(
      409,
      `GRN ${dprNo} cannot be taken back: ${NO_TAKE_BACK_REASON[stage] || 'CSD have already acted on it'}.`,
    );
  }

  // The stage again in the DELETE itself, so a take-back cannot land either
  // side of CSD approving it and remove an approved handover.
  const { rowCount } = await db.query('DELETE FROM ph_csd_dispatches WHERE id = $1 AND stage = ANY($2)', [
    id,
    TAKE_BACK_STAGES,
  ]);
  if (rowCount === 0) {
    return refuse(409, `GRN ${dprNo} moved on at CSD while you were taking it back. Reload and try again.`);
  }
  return { gone: rows[0] };
}

/**
 * Remove a handover whatever stage it reached -- DELETE /api/csd/:id/record: a
 * correction to the data rather than a step in the work.
 *
 * @returns `{ gone }`, the row as it was
 */
export async function deletePhCsdRecord(db, id) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');
  const { rows } = await db.query(
    'DELETE FROM ph_csd_dispatches WHERE id = $1 RETURNING dpr_no, location, stage, cheque_no, reject_remarks',
    [id],
  );
  return rows.length === 0 ? refuse(404, GONE) : { gone: rows[0] };
}

/** Answer a refusal, and say whether there was one. */
function refused(res, answer) {
  if (!answer.refused) return false;
  res.status(answer.refused.status).json({ error: answer.refused.error });
  return true;
}

/** GET /api/op-pharmacy/csd?page=&pageSize=&q=&stage=&location=&all=&view=&chequeNo=&unitKey= -- see listPhCsd. */
phCsdRouter.get(
  '/',
  CSD_QUEUE,
  asyncHandler(async (req, res) => {
    const answer = await listPhCsd(POOL, {
      q: req.query.q,
      stage: req.query.stage,
      location: req.query.location,
      msme: req.query.msme,
      // The grant is read off the signed-in user, never off the request.
      grant: branchFor(req.user),
      chequeNo: req.query.chequeNo,
      unitKey: req.query.unitKey,
      view: req.query.view,
      all: String(req.query.all || '') === '1',
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    if (refused(res, answer)) return undefined;
    return res.json(answer);
  }),
);

/** POST /api/op-pharmacy/csd -- see sendPhCsd. */
phCsdRouter.post(
  '/',
  CSD_HANDOVER,
  asyncHandler(async (req, res) => {
    const answer = await sendPhCsd(POOL, req.body || {}, req.user.id);
    if (refused(res, answer)) return undefined;

    const { dispatch } = answer;
    logActivity(req, {
      action: 'PH_CSD_SEND',
      target: dispatch.dprNo,
      summary:
        `Sent pharmacy GRN ${dispatch.dprNo}${dispatch.location ? ` (${dispatch.location})` : ''} to CSD` +
        (dispatch.chequeNo ? ` (cheque ${dispatch.chequeNo})` : ''),
      details: {
        dispatchId: dispatch.id,
        unitName: dispatch.location,
        chequeNo: dispatch.chequeNo,
        vendorName: dispatch.vendorName,
        payableAmount: dispatch.payableAmount,
        divisionCode: dispatch.divisionCode,
      },
    });
    return res.status(201).json({ dispatch });
  }),
);

/** PATCH /api/op-pharmacy/csd/:id/stage -- body { stage, remarks }; see movePhCsdStage. */
phCsdRouter.patch(
  '/:id/stage',
  CSD_QUEUE,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await movePhCsdStage(POOL, id, req.body?.stage, req.body?.remarks, req.user.id);
    if (refused(res, answer)) return undefined;

    const { dispatch, from, to, remarks } = answer;
    logActivity(req, {
      action: 'PH_CSD_STAGE',
      target: dispatch.dprNo,
      summary:
        `Moved pharmacy GRN ${dispatch.dprNo} from ${spellStage(from)} to ${spellStage(to)}` +
        (dispatch.chequeNo ? ` (cheque ${dispatch.chequeNo})` : ''),
      details: {
        dispatchId: id,
        unitName: dispatch.location,
        chequeNo: dispatch.chequeNo,
        from,
        to,
        ...(remarks ? { remarks } : {}),
      },
    });
    return res.json({ dispatch });
  }),
);

/** PATCH /api/op-pharmacy/csd/:id/dates -- an administrator's; body: the stamps to correct. See updatePhCsdDates. */
phCsdRouter.patch(
  '/:id/dates',
  CSD_QUEUE,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await updatePhCsdDates(POOL, id, req.body || {});
    if (refused(res, answer)) return undefined;

    // Logged from the row as it was read, not as it is read back: the dates
    // were changed whether or not the handover is still there to show them.
    const { dispatch, changes, dprNo, location } = answer;
    const changed = Object.keys(changes).length;
    logActivity(req, {
      action: 'PH_CSD_DATES',
      target: dprNo,
      summary: `Corrected ${changed} CSD date${changed === 1 ? '' : 's'} on pharmacy GRN ${dprNo}`,
      details: { dispatchId: id, unitName: location, changes },
    });
    // Taken back or deleted since the write: there is no row to answer with.
    if (!dispatch) return res.status(404).json({ error: GONE });
    return res.json({ dispatch });
  }),
);

/** DELETE /api/op-pharmacy/csd/:id -- see takeBackPhCsd. */
phCsdRouter.delete(
  '/:id',
  CSD_HANDOVER,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await takeBackPhCsd(POOL, id);
    if (refused(res, answer)) return undefined;

    const { gone } = answer;
    logActivity(req, {
      action: 'PH_CSD_TAKE_BACK',
      target: gone.dpr_no,
      summary: `Took pharmacy GRN ${gone.dpr_no} back off the CSD queue (was ${spellStage(gone.stage)})`,
      details: { dispatchId: id, unitName: gone.location, chequeNo: gone.cheque_no, stage: gone.stage },
    });
    return res.status(204).end();
  }),
);

/** DELETE /api/op-pharmacy/csd/:id/record -- an administrator's; see deletePhCsdRecord. */
phCsdRouter.delete(
  '/:id/record',
  CSD_QUEUE,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await deletePhCsdRecord(POOL, id);
    if (refused(res, answer)) return undefined;

    const { gone } = answer;
    logActivity(req, {
      action: 'PH_CSD_DELETE',
      target: gone.dpr_no,
      summary: `Deleted the CSD record for pharmacy GRN ${gone.dpr_no} (was ${spellStage(gone.stage)})`,
      details: {
        dispatchId: id,
        unitName: gone.location,
        chequeNo: gone.cheque_no,
        stage: gone.stage,
        ...(gone.reject_remarks ? { rejectRemarks: gone.reject_remarks } : {}),
      },
    });
    return res.status(204).end();
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phCsdRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
