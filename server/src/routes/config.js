/**
 * Branches, as configured.
 *
 * A branch is the same place seen from several files, and this is where its
 * names are written down: the ageing report's DivisionCode, a fragment of the
 * GRN report's Location, the account its bank statement is for, and the BPAD
 * register's Location.
 *
 * Reading is open to any signed-in account, because every screen that shows
 * figures has to know which branches are in scope in order to say so. Writing
 * needs the Configuration screen: ticking a branch changes what everyone else
 * is looking at.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { changedFields, logActivity } from '../services/activityLog.js';
import { normKey } from '../services/normalize.js';

export const configRouter = express.Router();

/** The branch fields the activity log records on create and compares on update. */
const LOGGED_BRANCH_FIELDS = ['branchCode', 'location', 'accountNo', 'bpadLocation', 'isSelected'];

configRouter.use(requireAuth);

const BRANCH_COLUMNS = `
  SELECT b.id, b.branch_code, b.location, b.account_no, b.bpad_location, b.is_selected, b.created_at
  FROM branch_configs b`;

function mapBranch(row) {
  return {
    id: row.id,
    branchCode: row.branch_code,
    location: row.location,
    accountNo: row.account_no,
    bpadLocation: row.bpad_location,
    isSelected: row.is_selected,
    createdAt: row.created_at,
  };
}

/** Trimmed text, or null. */
function toText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

/**
 * The BPAD register's Location as typed, or null.
 *
 * Kept as typed -- "Sbd" stays "Sbd" -- because the upload folds both sides
 * through normKey before comparing. A value that folds to nothing ("-") could
 * never match a register row, so it is stored as blank rather than as a filter
 * that would quietly turn away every one of the branch's rows.
 */
function toBpadLocation(value) {
  const text = toText(value);
  return text && normKey(text) ? text : null;
}

/** An account number as the statement writes it: digits, nothing else. */
function toAccountNo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits === '' ? null : digits;
}

/**
 * GET /api/config/branches
 *
 * Every branch, ticked first and then by code -- the ones in scope are the ones
 * being worked with, and they should not be scattered among the ones that are
 * not.
 */
configRouter.get(
  '/branches',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${BRANCH_COLUMNS} ORDER BY b.is_selected DESC, upper(b.branch_code)`,
    );
    res.json({ branches: rows.map(mapBranch) });
  }),
);

/**
 * POST /api/config/branches
 *
 * Body: branchCode, location, accountNo, bpadLocation, isSelected.
 *
 * A branch code and a location are both required: one identifies the branch on
 * the accounts side and the other on the stores side, and a branch known by
 * only one of them would silently drop half the rows it is meant to select. The
 * account number is optional -- it narrows which bank statement's cheques count
 * as this branch's, and an installation with one account does not need it. So
 * is the BPAD location -- it narrows which register rows an upload keeps for
 * this branch's GRNs (see grnMatchKeys in routes/batches.js), and left blank
 * they are matched on vendor code and GRN number alone, as before.
 */
configRouter.post(
  '/branches',
  requireScreen('config'),
  asyncHandler(async (req, res) => {
    const branchCode = toText(req.body?.branchCode);
    const location = toText(req.body?.location);

    if (!branchCode) {
      return res
        .status(400)
        .json({ error: "A branch code is required — the ageing report's DivisionCode, such as SE1." });
    }
    if (!location) {
      return res.status(400).json({
        error:
          "A location is required — enough of the GRN report's Location to identify this branch, such as SECUNDERABAD.",
      });
    }

    try {
      const { rows } = await query(
        `INSERT INTO branch_configs (branch_code, location, account_no, bpad_location, is_selected, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          branchCode,
          location,
          toAccountNo(req.body?.accountNo),
          toBpadLocation(req.body?.bpadLocation),
          Boolean(req.body?.isSelected),
          req.user.id,
        ],
      );
      const { rows: full } = await query(`${BRANCH_COLUMNS} WHERE b.id = $1`, [rows[0].id]);
      const branch = mapBranch(full[0]);
      logActivity(req, {
        action: 'BRANCH_CREATE',
        target: branch.branchCode,
        summary: `Added branch ${branch.branchCode} (${branch.location})`,
        details: {
          branchId: branch.id,
          ...Object.fromEntries(LOGGED_BRANCH_FIELDS.map((f) => [f, branch[f] ?? null])),
        },
      });
      return res.status(201).json({ branch });
    } catch (err) {
      // The unique index is on upper(branch_code) -- see db/schema.sql.
      if (err.code === '23505') {
        return res.status(409).json({ error: `Branch code "${branchCode}" is already configured.` });
      }
      throw err;
    }
  }),
);

/**
 * PATCH /api/config/branches/:id
 *
 * Body: any subset of branchCode, location, accountNo, bpadLocation,
 * isSelected. Absent fields are left alone, so the tick box sends one field and
 * the edit form sends the rest.
 *
 * accountNo and bpadLocation are the fields that can be cleared: '' and null
 * both mean "not recorded for this branch", which is a legitimate state and not
 * an error. A branch code or a location cleared to nothing is refused -- see
 * POST.
 */
configRouter.patch(
  '/branches/:id',
  requireScreen('config'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown branch.' });
    }

    // The branch as it stood, for the activity log's list of changes.
    const { rows: beforeRows } = await query(`${BRANCH_COLUMNS} WHERE b.id = $1`, [id]);
    const before = beforeRows[0] ? mapBranch(beforeRows[0]) : null;

    const assignments = [];
    const params = [];

    if ('branchCode' in req.body) {
      const branchCode = toText(req.body.branchCode);
      if (!branchCode) return res.status(400).json({ error: 'A branch code is required.' });
      params.push(branchCode);
      assignments.push(`branch_code = $${params.length}`);
    }

    if ('location' in req.body) {
      const location = toText(req.body.location);
      if (!location) return res.status(400).json({ error: 'A location is required.' });
      params.push(location);
      assignments.push(`location = $${params.length}`);
    }

    if ('accountNo' in req.body) {
      params.push(toAccountNo(req.body.accountNo));
      assignments.push(`account_no = $${params.length}`);
    }

    if ('bpadLocation' in req.body) {
      params.push(toBpadLocation(req.body.bpadLocation));
      assignments.push(`bpad_location = $${params.length}`);
    }

    if ('isSelected' in req.body) {
      params.push(Boolean(req.body.isSelected));
      assignments.push(`is_selected = $${params.length}`);
    }

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'Nothing was given to change.' });
    }

    params.push(id);

    let updated;
    try {
      const result = await query(
        `UPDATE branch_configs SET ${assignments.join(', ')} WHERE id = $${params.length}`,
        params,
      );
      updated = result.rowCount;
    } catch (err) {
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: `Branch code "${toText(req.body.branchCode)}" is already configured.` });
      }
      throw err;
    }

    if (updated === 0) return res.status(404).json({ error: 'That branch no longer exists.' });

    const { rows: full } = await query(`${BRANCH_COLUMNS} WHERE b.id = $1`, [id]);
    const branch = mapBranch(full[0]);
    const changes = changedFields(before, branch, LOGGED_BRANCH_FIELDS);
    if (changes) {
      // The tick box on its own reads as what it did, rather than a field list.
      const onlyTick = Object.keys(changes).length === 1 && changes.isSelected;
      logActivity(req, {
        action: 'BRANCH_UPDATE',
        target: branch.branchCode,
        summary: onlyTick
          ? `${branch.isSelected ? 'Ticked' : 'Unticked'} branch ${branch.branchCode} (${branch.location})`
          : `Updated branch ${branch.branchCode}: ${Object.keys(changes).join(', ')}`,
        details: { branchId: id, changes },
      });
    }
    return res.json({ branch });
  }),
);

/**
 * DELETE /api/config/branches/:id
 *
 * Nothing references a branch: it is read at query time to narrow what is
 * shown, never stored against a row. So removing one takes nothing with it --
 * the rows it was selecting simply stop being narrowed to.
 */
configRouter.delete(
  '/branches/:id',
  requireScreen('config'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown branch.' });
    }
    const { rows } = await query(
      `DELETE FROM branch_configs b WHERE b.id = $1
       RETURNING b.branch_code, b.location, b.account_no, b.bpad_location, b.is_selected, b.created_at,
                 (SELECT COALESCE(u.full_name, u.username) FROM users u WHERE u.id = b.created_by) AS created_by`,
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'That branch no longer exists.' });
    logActivity(req, {
      action: 'BRANCH_DELETE',
      target: rows[0].branch_code,
      summary: `Deleted branch ${rows[0].branch_code} (${rows[0].location})`,
      details: {
        branchId: id,
        branchCode: rows[0].branch_code,
        location: rows[0].location,
        accountNo: rows[0].account_no,
        bpadLocation: rows[0].bpad_location,
        isSelected: rows[0].is_selected,
        createdBy: rows[0].created_by,
        createdAt: rows[0].created_at,
      },
    });
    return res.status(204).end();
  }),
);
