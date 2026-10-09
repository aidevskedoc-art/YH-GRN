/**
 * OP Pharmacy's Records: the second destination on a Pharmacy Results row,
 * beside Send to CSD.
 *
 * The "Handed to Records" section at the foot of routes/results.js, for the
 * pharmacies' own table (ph_record_dispatches). As there, it is a note and not
 * a queue -- one route to file a GRN and one to take it back -- and it is
 * gated on Pharmacy Results and Ph-Accounts, by their own grants, not on a
 * screen of its own: the control is on the results table, and anyone who can
 * work that table can use it.
 *
 * What differs is the key: a pharmacy GRN is its number AND its unit (see
 * "What a pharmacy GRN is known by" in services/phIngest.js), so a filed GRN
 * is too, and two units' GRNs of one number are filed separately.
 *
 * Each answer is a function of something that can run a query, with the route
 * below it reading the request, calling it and logging what changed -- as
 * routes/phCsd.js is laid out, and for the same reason.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { normKey } from '../services/normalize.js';
import { logActivity } from '../services/activityLog.js';
import { DISPATCHABLE, toText } from './csd.js';
import { PH_NOT_IN_ACCOUNTS, PH_WRONG_UNIT, phGrnStanding } from './phResults.js';

export const phRecordsRouter = express.Router();

phRecordsRouter.use(requireAuth, requireScreen('ph-results', 'ph-accounts-department'));

const POOL = { query };
const refuse = (status, error) => ({ refused: { status, error } });

/**
 * File one GRN: `body` is one Pharmacy Results row, as the table holds it --
 * the shape POST /op-pharmacy/csd takes, so the two destinations are called
 * the same way. Only the GRN number, its unit and its upload are kept.
 *
 * Filing a GRN already filed refreshes its timestamp rather than failing.
 */
export async function sendPhRecord(db, body = {}, userId = null) {
  const dprNo = toText(body.dprNo);
  if (!dprNo) return refuse(400, 'A GRN number is required to send to Records.');

  const key = normKey(dprNo);
  if (!key) return refuse(400, `"${dprNo}" is not a usable GRN number.`);

  // Only a GRN that reached accounts has anything to file.
  const status = toText(body.status);
  if (status && !DISPATCHABLE.has(status)) {
    return refuse(400, 'Only GRNs found in the Vendor Age report can go to Records.');
  }

  const location = toText(body.location);
  // Asked of what is stored too, as sendPhCsd asks and for its reason: the
  // page's row may be older than the BPAD status on file.
  const standing = await phGrnStanding(db, key, normKey(location));
  if (standing?.wrongUnit) return refuse(409, PH_WRONG_UNIT);
  if (standing && !standing.reached) return refuse(409, PH_NOT_IN_ACCOUNTS);
  // `> 0`: no particular upload is null, never 0 -- see POST /api/records.
  const batchId =
    Number.isInteger(Number(body.batchId)) && Number(body.batchId) > 0 ? Number(body.batchId) : null;

  const { rows } = await db.query(
    `INSERT INTO ph_record_dispatches (dpr_no_key, unit_key, dpr_no, location, batch_id, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dpr_no_key, unit_key) DO UPDATE SET
       dpr_no = EXCLUDED.dpr_no,
       location = EXCLUDED.location,
       batch_id = EXCLUDED.batch_id,
       sent_by = EXCLUDED.sent_by,
       sent_at = NOW()
     RETURNING id, dpr_no, location, sent_at`,
    [key, normKey(location), dprNo, location, batchId, userId],
  );

  const r = rows[0];
  return { record: { id: r.id, dprNo: r.dpr_no, location: r.location, sentAt: r.sent_at } };
}

/**
 * Take a GRN back from Records -- the undo for one filed by mistake. No stage
 * to check, unlike the CSD take-back: nobody acts on a filed GRN.
 *
 * @returns `{ gone }`, the row as it was
 */
export async function takeBackPhRecord(db, id) {
  if (!Number.isInteger(id)) return refuse(400, 'Unknown row.');
  const { rows } = await db.query(
    'DELETE FROM ph_record_dispatches WHERE id = $1 RETURNING dpr_no, location, sent_at',
    [id],
  );
  return rows.length === 0 ? refuse(404, 'That GRN is no longer in Records.') : { gone: rows[0] };
}

function refused(res, answer) {
  if (!answer.refused) return false;
  res.status(answer.refused.status).json({ error: answer.refused.error });
  return true;
}

/** POST /api/op-pharmacy/records -- see sendPhRecord. */
phRecordsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const answer = await sendPhRecord(POOL, body, req.user.id);
    if (refused(res, answer)) return undefined;

    const { record } = answer;
    logActivity(req, {
      action: 'PH_RECORDS_SEND',
      target: record.dprNo,
      summary: `Sent pharmacy GRN ${record.dprNo}${record.location ? ` (${record.location})` : ''} to Records`,
      details: {
        recordId: record.id,
        unitName: record.location,
        chequeNo: toText(body.chequeNo),
        vendorName: toText(body.vendorName),
      },
    });
    return res.status(201).json({ record });
  }),
);

/** DELETE /api/op-pharmacy/records/:id -- see takeBackPhRecord. */
phRecordsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const answer = await takeBackPhRecord(POOL, id);
    if (refused(res, answer)) return undefined;

    const { gone } = answer;
    logActivity(req, {
      action: 'PH_RECORDS_TAKE_BACK',
      target: gone.dpr_no,
      summary: `Took pharmacy GRN ${gone.dpr_no} back from Records`,
      details: { recordId: id, unitName: gone.location, sentAt: gone.sent_at },
    });
    return res.status(204).end();
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phRecordsRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
