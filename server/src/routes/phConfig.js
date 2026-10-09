/**
 * Pharmacy branches, as configured -- the Ph-Configuration screen.
 *
 * routes/config.js for the pharmacies: the same four names and the same tick
 * box, kept in ph_branch_configs. What each is matched against:
 *
 *   branchCode     Branch code (Focus)   the Vendor Age report's DivisionCode
 *   location       Unit name (HIS)       the GRN Purchase report's Unit Name
 *   bpadLocation   Location (BPAD)       the BPAD current bill status's Location
 *   accountNo      Account number        the account its bank statement is for
 *
 * `location` is called that here as it is on the hospital route, though the
 * screen labels it Unit name (HIS): the two screens send and receive the same
 * fields, and it is the stores side's name for the branch in both.
 *
 * Where it differs from the hospital route is in what a branch does. Here a
 * branch is what ties the three reports together -- a GRN is matched to a
 * Vendor Age row only when the row's DivisionCode and the GRN's Unit Name are
 * one branch's Branch code and Unit name (services/phIngest.js), and to a BPAD
 * row only when the row's Location is that branch's too (routes/phBatches.js).
 * So adding, removing or correcting a branch changes which ageing rows the
 * GRNs already on file are matched to, and each of those writes re-matches
 * them in the same transaction (relinkPhResults). The tick box, the account
 * number and the BPAD location change none of that, and re-match nothing.
 *
 * Reading is open to any signed-in account, as on the hospital route; writing
 * needs the Ph-Configuration grant (`ph-config`), which is its own and not the
 * hospital screen's `config`.
 */
import express from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { changedFields, logActivity } from '../services/activityLog.js';
import { normKey } from '../services/normalize.js';
import { relinkPhResults } from '../services/phIngest.js';

export const phConfigRouter = express.Router();

/** The branch fields the activity log records on create and compares on update. */
const LOGGED_BRANCH_FIELDS = ['branchCode', 'location', 'accountNo', 'bpadLocation', 'isSelected'];

phConfigRouter.use(requireAuth);

const BRANCH_COLUMNS = `
  SELECT b.id, b.branch_code, b.location, b.account_no, b.bpad_location, b.is_selected, b.created_at
  FROM ph_branch_configs b`;

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
 * The BPAD status's Location as typed, or null. A value that folds to nothing
 * ("-") could never match a row, so it is stored as blank rather than as a
 * filter that would turn away every one of the branch's rows.
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

/** The columns PATCH may set -- see updateBranchOn. */
const UPDATABLE_COLUMNS = new Set(['branch_code', 'location', 'account_no', 'bpad_location', 'is_selected']);

/* --------------------------------------------------------------------------
   The three writes, each on a client inside a transaction, each followed by
   the re-match where it changes what a GRN can be matched to. Exported, and
   taking the client rather than opening a transaction of their own, so the
   write and its re-match can be run together and rolled back.
   -------------------------------------------------------------------------- */

/**
 * Add a branch, and re-match the GRNs on file: the new branch may be the one
 * a unit's GRNs were waiting for.
 *
 * @returns {Promise<{branch: object, relinked: object}>}
 */
export async function createBranchOn(client, { branchCode, location, accountNo, bpadLocation, isSelected }, userId) {
  const { rows } = await client.query(
    `INSERT INTO ph_branch_configs (branch_code, location, account_no, bpad_location, is_selected, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [branchCode, location, accountNo, bpadLocation, isSelected, userId],
  );
  const { rows: full } = await client.query(`${BRANCH_COLUMNS} WHERE b.id = $1`, [rows[0].id]);
  const relinked = await relinkPhResults(client);
  return { branch: mapBranch(full[0]), relinked };
}

/**
 * Change a branch. `fields` holds only the columns being changed, by column
 * name. Re-matches the GRNs on file when the branch code or the unit name is
 * among them and comes out different -- the two names a match goes through --
 * and not otherwise, so a tick is not made to wait for a lock it has no use
 * for.
 *
 * @returns {Promise<null | {before: object, branch: object, relinked: object|null}>}
 *   null when there is no such branch
 */
export async function updateBranchOn(client, id, fields) {
  // Locked, so the comparison below is with the row as this change found it.
  const { rows: beforeRows } = await client.query(`${BRANCH_COLUMNS} WHERE b.id = $1 FOR UPDATE`, [id]);
  if (beforeRows.length === 0) return null;
  const before = mapBranch(beforeRows[0]);

  // The names go into the statement as they are, so only these five do.
  const columns = Object.keys(fields).filter((c) => UPDATABLE_COLUMNS.has(c));
  if (columns.length === 0) return { before, branch: before, relinked: null };
  await client.query(
    `UPDATE ph_branch_configs SET ${columns.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${columns.length + 1}`,
    [...columns.map((c) => fields[c]), id],
  );

  const { rows: full } = await client.query(`${BRANCH_COLUMNS} WHERE b.id = $1`, [id]);
  const branch = mapBranch(full[0]);

  const rematch =
    normKey(before.branchCode) !== normKey(branch.branchCode) ||
    normKey(before.location) !== normKey(branch.location);
  const relinked = rematch ? await relinkPhResults(client) : null;
  return { before, branch, relinked };
}

/**
 * Remove a branch, and re-match the GRNs on file: the ones matched through it
 * have nothing to be matched through now, and go back to pending.
 *
 * @returns {Promise<null | {row: object, relinked: object}>} null when there
 *   is no such branch
 */
export async function deleteBranchOn(client, id) {
  const { rows } = await client.query(
    `DELETE FROM ph_branch_configs b WHERE b.id = $1
     RETURNING b.branch_code, b.location, b.account_no, b.bpad_location, b.is_selected, b.created_at, b.created_by`,
    [id],
  );
  if (rows.length === 0) return null;
  const relinked = await relinkPhResults(client);
  return { row: rows[0], relinked };
}

/** What a re-match did, for the activity log: how many results it changed. */
function relinkedDetails(relinked) {
  return relinked ? { resultsRematched: relinked.changed, grnsNow: relinked.linked } : {};
}

/** GET /api/op-pharmacy/config/branches - every branch, ticked first and then by code. */
phConfigRouter.get(
  '/branches',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${BRANCH_COLUMNS} ORDER BY b.is_selected DESC, upper(b.branch_code)`,
    );
    res.json({ branches: rows.map(mapBranch) });
  }),
);

/**
 * POST /api/op-pharmacy/config/branches
 *
 * Body: branchCode, location, accountNo, bpadLocation, isSelected. A branch
 * code and a unit name are both required -- one identifies the branch on the
 * accounts side and the other on the stores side. The account number and the
 * BPAD location are optional, though a branch without a BPAD location has none
 * of its GRNs matched to the BPAD status.
 *
 * Answers with the branch and `relinked`: how many stored results the new
 * branch changed, and how every GRN on file stands now.
 */
phConfigRouter.post(
  '/branches',
  requireScreen('ph-config'),
  asyncHandler(async (req, res) => {
    const branchCode = toText(req.body?.branchCode);
    const location = toText(req.body?.location);

    if (!branchCode) {
      return res
        .status(400)
        .json({ error: "A branch code is required — the Vendor Age report's DivisionCode, such as PSE." });
    }
    if (!location) {
      return res.status(400).json({
        error: "A unit name is required — the GRN Purchase report's Unit Name, such as Secunderabad.",
      });
    }

    let created;
    try {
      created = await withTransaction((client) =>
        createBranchOn(
          client,
          {
            branchCode,
            location,
            accountNo: toAccountNo(req.body?.accountNo),
            bpadLocation: toBpadLocation(req.body?.bpadLocation),
            isSelected: Boolean(req.body?.isSelected),
          },
          req.user.id,
        ),
      );
    } catch (err) {
      // The unique index is on upper(branch_code) -- see db/schema.sql.
      if (err.code === '23505') {
        return res.status(409).json({ error: `Branch code "${branchCode}" is already configured.` });
      }
      throw err;
    }

    const { branch, relinked } = created;
    logActivity(req, {
      action: 'PH_BRANCH_CREATE',
      target: branch.branchCode,
      summary: `Added pharmacy branch ${branch.branchCode} (${branch.location})`,
      details: {
        branchId: branch.id,
        ...Object.fromEntries(LOGGED_BRANCH_FIELDS.map((f) => [f, branch[f] ?? null])),
        ...relinkedDetails(relinked),
      },
    });
    return res.status(201).json({ branch, relinked });
  }),
);

/**
 * PATCH /api/op-pharmacy/config/branches/:id
 *
 * Body: any subset of branchCode, location, accountNo, bpadLocation,
 * isSelected. Absent fields are left alone, so the tick box sends one field
 * and the edit form sends the rest. accountNo and bpadLocation can be cleared;
 * a branch code or a unit name cleared to nothing is refused.
 *
 * Answers with the branch and `relinked` -- null unless the branch code or the
 * unit name changed, which is what re-matches the GRNs on file.
 */
phConfigRouter.patch(
  '/branches/:id',
  requireScreen('ph-config'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown branch.' });
    }

    // The columns being changed, by column name -- see updateBranchOn.
    const fields = {};

    if ('branchCode' in req.body) {
      const branchCode = toText(req.body.branchCode);
      if (!branchCode) return res.status(400).json({ error: 'A branch code is required.' });
      fields.branch_code = branchCode;
    }

    if ('location' in req.body) {
      const location = toText(req.body.location);
      if (!location) return res.status(400).json({ error: 'A unit name is required.' });
      fields.location = location;
    }

    if ('accountNo' in req.body) fields.account_no = toAccountNo(req.body.accountNo);
    if ('bpadLocation' in req.body) fields.bpad_location = toBpadLocation(req.body.bpadLocation);
    if ('isSelected' in req.body) fields.is_selected = Boolean(req.body.isSelected);

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Nothing was given to change.' });
    }

    let updated;
    try {
      updated = await withTransaction((client) => updateBranchOn(client, id, fields));
    } catch (err) {
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: `Branch code "${toText(req.body.branchCode)}" is already configured.` });
      }
      throw err;
    }

    if (!updated) return res.status(404).json({ error: 'That branch no longer exists.' });

    const { before, branch, relinked } = updated;
    const changes = changedFields(before, branch, LOGGED_BRANCH_FIELDS);
    if (changes) {
      // The tick box on its own reads as what it did, rather than a field list.
      const onlyTick = Object.keys(changes).length === 1 && changes.isSelected;
      logActivity(req, {
        action: 'PH_BRANCH_UPDATE',
        target: branch.branchCode,
        summary: onlyTick
          ? `${branch.isSelected ? 'Ticked' : 'Unticked'} pharmacy branch ${branch.branchCode} (${branch.location})`
          : `Updated pharmacy branch ${branch.branchCode}: ${Object.keys(changes).join(', ')}`,
        details: { branchId: id, changes, ...relinkedDetails(relinked) },
      });
    }
    return res.json({ branch, relinked });
  }),
);

/**
 * DELETE /api/op-pharmacy/config/branches/:id
 *
 * No row references a branch, so removing one deletes nothing else. It does
 * change what the GRNs on file are matched to -- the ones matched through this
 * branch go back to pending -- and they are re-matched as it goes. Answers
 * with `relinked`, as POST and PATCH do.
 */
phConfigRouter.delete(
  '/branches/:id',
  requireScreen('ph-config'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown branch.' });
    }

    const deleted = await withTransaction((client) => deleteBranchOn(client, id));
    if (!deleted) return res.status(404).json({ error: 'That branch no longer exists.' });

    const { row, relinked } = deleted;
    // Who added it, for the log. Read afterwards and outside the transaction,
    // and allowed to fail: it is a name for a log line, and the branch is
    // already gone whether or not it can be found.
    const { rows: who } = row.created_by
      ? await query('SELECT COALESCE(full_name, username) AS name FROM users WHERE id = $1', [
          row.created_by,
        ]).catch(() => ({ rows: [] }))
      : { rows: [] };

    logActivity(req, {
      action: 'PH_BRANCH_DELETE',
      target: row.branch_code,
      summary: `Deleted pharmacy branch ${row.branch_code} (${row.location})`,
      details: {
        branchId: id,
        branchCode: row.branch_code,
        location: row.location,
        accountNo: row.account_no,
        bpadLocation: row.bpad_location,
        isSelected: row.is_selected,
        createdBy: who[0]?.name ?? null,
        createdAt: row.created_at,
        ...relinkedDetails(relinked),
      },
    });
    // 200 with what the removal did, where the hospital route answers 204:
    // removing a branch here sends the GRNs matched through it back to
    // pending, and the screen should be able to say how many.
    return res.json({ relinked });
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phConfigRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
