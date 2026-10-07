/**
 * OP Pharmacy's GRNs returned from CSD: Accounts' own two moves once CSD mark a
 * pharmacy handover Moved to accounts.
 *
 * The "Returned from CSD" section at the foot of routes/results.js, for the
 * pharmacies' own queue (ph_csd_dispatches) -- move for move and rule for
 * rule: `accounts_stage` starts QUEUED the moment CSD hand a GRN back
 * (routes/phCsd.js); /receive moves it to RECEIVED; /forward then records
 * where it went on from there -- Bank, Vendor (the vendor itself or the
 * purchase department), Others or Courier -- and who or what took it.
 *
 * No listing of its own, as there: Pharmacy Results and Ph-Accounts already
 * show every such row (routes/phResults.js carries the columns), and these are
 * only the writes their Action column makes. Gated on those two screens.
 *
 * Each answer is a function of something that can run a query, with the route
 * below it reading the request, calling it and logging what changed -- as
 * routes/phCsd.js is laid out, and for the same reason.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { logActivity } from '../services/activityLog.js';

export const phAccountsReturnsRouter = express.Router();

phAccountsReturnsRouter.use(requireAuth, requireScreen('results', 'accounts-department'));

const POOL = { query };
const refuse = (status, error) => ({ refused: { status, error } });
const GONE = 'That GRN is no longer in the CSD queue.';

const RETURN_COLUMNS = `
  SELECT c.id, c.dpr_no, c.location, c.division_code, c.cheque_no,
         c.accounts_stage, c.accounts_received_at,
         c.forwarded_to, c.forwarded_route, c.forwarded_name, c.forwarded_mobile,
         c.forwarded_date, c.forwarded_courier_name, c.forwarded_docket_no,
         c.forwarded_remarks, c.forwarded_at
  FROM ph_csd_dispatches c`;

function mapReturn(r) {
  return {
    id: r.id,
    dprNo: r.dpr_no,
    // The unit the handover is of -- a pharmacy GRN is its number and its unit.
    location: r.location,
    divisionCode: r.division_code,
    chequeNo: r.cheque_no,
    accountsStage: r.accounts_stage,
    accountsReceivedAt: r.accounts_received_at,
    forwardedTo: r.forwarded_to,
    forwardedRoute: r.forwarded_route,
    forwardedName: r.forwarded_name,
    forwardedMobile: r.forwarded_mobile,
    forwardedDate: r.forwarded_date,
    forwardedCourierName: r.forwarded_courier_name,
    forwardedDocketNo: r.forwarded_docket_no,
    forwardedRemarks: r.forwarded_remarks,
    forwardedAt: r.forwarded_at,
  };
}

async function returnById(db, id) {
  const { rows } = await db.query(`${RETURN_COLUMNS} WHERE c.id = $1`, [id]);
  return rows.length > 0 ? mapReturn(rows[0]) : null;
}

/** BANK carries nothing further; VENDOR/OTHERS need name+mobile+date; COURIER needs its own two fields. */
const FORWARD_DESTINATIONS = new Set(['BANK', 'VENDOR', 'OTHERS', 'COURIER']);
const FORWARD_ROUTES = new Set(['VENDOR', 'PURCHASE_DEPT']);

/** A real calendar date in yyyy-MM-dd. */
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Accounts' first move: acknowledge a hand-back. Only from QUEUED, and only on
 * a dispatch CSD have actually handed back -- in one guarded statement, so two
 * people acknowledging the same row at once cannot both succeed.
 */
export async function receivePhReturn(db, id, userId = null) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');

  const { rows } = await db.query(
    `UPDATE ph_csd_dispatches
     SET accounts_stage = 'RECEIVED', accounts_received_at = NOW(), accounts_received_by = $1
     WHERE id = $2 AND stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'QUEUED'
     RETURNING id`,
    [userId, id],
  );
  if (rows.length > 0) return { accountsReturn: await returnById(db, id) };

  const { rows: current } = await db.query('SELECT stage FROM ph_csd_dispatches WHERE id = $1', [id]);
  if (current.length === 0) return refuse(404, GONE);
  if (current[0].stage !== 'MOVED_TO_ACCOUNTS') return refuse(409, 'This GRN has not been moved to accounts.');
  return refuse(409, 'This GRN has already been received by accounts.');
}

/**
 * Accounts' last move: where the paperwork goes once they have it. `body` is
 * { to, route, name, mobile, date, courierName, docketNo, remarks } -- see
 * PATCH /api/accounts-returns/:id/forward in results.js for what each
 * destination asks for and why. A one-shot write: only from a dispatch
 * Accounts have received, and only once.
 *
 * @returns `{ accountsReturn, sent }` -- `sent` being what was recorded, for the log
 */
export async function forwardPhReturn(db, id, body = {}, userId = null) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');

  const to = String(body.to || '').toUpperCase();
  if (!FORWARD_DESTINATIONS.has(to)) {
    return refuse(400, `"${body.to ?? ''}" is not a destination. Expected Bank, Vendor, Others or Courier.`);
  }

  let route = null;
  let name = null;
  let mobile = null;
  let date = null;
  let courierName = null;
  let docketNo = null;
  let remarks = null;

  if (to === 'VENDOR') {
    route = String(body.route || '').toUpperCase();
    if (!FORWARD_ROUTES.has(route)) {
      return refuse(400, 'Choose whether this goes to the vendor directly or to the purchase department.');
    }
  }

  // Vendor and Others both hand the GRN to a person: who took it, on what
  // number, on what day.
  if (to === 'VENDOR' || to === 'OTHERS') {
    name = String(body.name || '').trim();
    if (!name) return refuse(400, 'A name is required for this hand-off.');
    mobile = String(body.mobile || '').trim();
    if (!mobile) return refuse(400, 'A mobile number is required for this hand-off.');
    date = String(body.date || '');
    if (!isCalendarDate(date)) return refuse(400, 'A real date is required for this hand-off.');
  }

  // Others alone carries a remark: there is no vendor record or department
  // behind it to say what it was.
  if (to === 'OTHERS') {
    remarks = String(body.remarks || '').trim();
    if (!remarks) return refuse(400, 'A remark is required for this hand-off.');
  }

  // Courier hands the GRN to a service: which one, under what docket, on what day.
  if (to === 'COURIER') {
    courierName = String(body.courierName || '').trim();
    if (!courierName) return refuse(400, 'A courier name is required for this hand-off.');
    docketNo = String(body.docketNo || '').trim();
    if (!docketNo) return refuse(400, 'A docket number is required for this hand-off.');
    date = String(body.date || '');
    if (!isCalendarDate(date)) return refuse(400, 'A real date is required for this hand-off.');
  }

  const { rows } = await db.query(
    `UPDATE ph_csd_dispatches
     SET forwarded_to = $1, forwarded_route = $2, forwarded_name = $3,
         forwarded_mobile = $4, forwarded_date = $5, forwarded_courier_name = $6,
         forwarded_docket_no = $7, forwarded_remarks = $8,
         forwarded_at = NOW(), forwarded_by = $9
     WHERE id = $10 AND stage = 'MOVED_TO_ACCOUNTS' AND accounts_stage = 'RECEIVED'
           AND forwarded_to IS NULL
     RETURNING id`,
    [to, route, name, mobile, date, courierName, docketNo, remarks, userId, id],
  );
  if (rows.length > 0) {
    return {
      accountsReturn: await returnById(db, id),
      sent: { to, route, name, mobile, date, courierName, docketNo, remarks },
    };
  }

  const { rows: current } = await db.query(
    'SELECT stage, accounts_stage FROM ph_csd_dispatches WHERE id = $1',
    [id],
  );
  if (current.length === 0) return refuse(404, GONE);
  if (current[0].stage !== 'MOVED_TO_ACCOUNTS' || current[0].accounts_stage !== 'RECEIVED') {
    return refuse(409, 'Accounts has not received this GRN yet.');
  }
  return refuse(409, 'This GRN has already been forwarded.');
}

function refused(res, answer) {
  if (!answer.refused) return false;
  res.status(answer.refused.status).json({ error: answer.refused.error });
  return true;
}

/** PATCH /api/op-pharmacy/accounts-returns/:id/receive -- see receivePhReturn. */
phAccountsReturnsRouter.patch(
  '/:id/receive',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await receivePhReturn(POOL, id, req.user.id);
    if (refused(res, answer)) return undefined;

    const { accountsReturn } = answer;
    logActivity(req, {
      action: 'PH_ACCOUNTS_RECEIVE',
      target: accountsReturn.dprNo,
      summary:
        `Accounts received pharmacy GRN ${accountsReturn.dprNo} back from CSD` +
        (accountsReturn.chequeNo ? ` (cheque ${accountsReturn.chequeNo})` : ''),
      details: { dispatchId: id, unitName: accountsReturn.location, chequeNo: accountsReturn.chequeNo },
    });
    return res.json({ accountsReturn });
  }),
);

/** PATCH /api/op-pharmacy/accounts-returns/:id/forward -- see forwardPhReturn. */
phAccountsReturnsRouter.patch(
  '/:id/forward',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await forwardPhReturn(POOL, id, req.body || {}, req.user.id);
    if (refused(res, answer)) return undefined;

    const { accountsReturn, sent } = answer;
    const where =
      sent.to === 'VENDOR' && sent.route === 'PURCHASE_DEPT'
        ? 'Purchase Dept'
        : sent.to.charAt(0) + sent.to.slice(1).toLowerCase();
    logActivity(req, {
      action: 'PH_ACCOUNTS_FORWARD',
      target: accountsReturn.dprNo,
      summary:
        `Sent pharmacy GRN ${accountsReturn.dprNo} to ${where}` +
        (sent.name ? ` — handed to ${sent.name}` : '') +
        (sent.courierName ? ` — ${sent.courierName}, docket ${sent.docketNo}` : ''),
      details: {
        dispatchId: id,
        unitName: accountsReturn.location,
        chequeNo: accountsReturn.chequeNo,
        to: sent.to,
        ...(sent.route ? { route: sent.route } : {}),
        ...(sent.name ? { name: sent.name, mobile: sent.mobile } : {}),
        ...(sent.courierName ? { courierName: sent.courierName, docketNo: sent.docketNo } : {}),
        ...(sent.date ? { date: sent.date } : {}),
        ...(sent.remarks ? { remarks: sent.remarks } : {}),
      },
    });
    return res.json({ accountsReturn });
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phAccountsReturnsRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
