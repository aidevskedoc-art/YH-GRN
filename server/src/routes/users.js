/**
 * Accounts, and what each of them may open.
 *
 * Every route here is administrator-only. The screen an admin manages this from
 * is itself gated on the same role, but the gate that matters is this one -- the
 * client hides controls, the server refuses requests.
 */
import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import {
  SCREENS,
  ROLES,
  ROLE_KEYS,
  DEPARTMENTS,
  isScreen,
  isDepartment,
} from '../config/screens.js';

export const usersRouter = express.Router();

usersRouter.use(requireAuth, requireAdmin);

const MIN_PASSWORD = 6;

const USER_COLUMNS = `
  SELECT u.id, u.username, u.full_name, u.role, u.screens, u.department,
         u.branch_location, u.is_active, u.created_at,
         (SELECT COUNT(*)::int FROM upload_batches b WHERE b.uploaded_by = u.id) AS upload_count
  FROM users u`;

/**
 * One account for the management screen.
 *
 * `screens` is the stored column, not the resolved list: this is the form's
 * value, and an admin's ticks have to survive a demotion to standard user
 * rather than being flattened to "all" on the way out and back.
 */
function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    screens: row.screens || [],
    department: row.department,
    // The stored column, not the resolved answer: this is the form's value, and
    // an admin's branch has to survive a demotion to standard user rather than
    // being flattened to "every branch" on the way out and back -- the same
    // reason `screens` above is the stored list.
    branchLocation: row.branch_location,
    isActive: row.is_active,
    createdAt: row.created_at,
    uploadCount: row.upload_count ?? 0,
  };
}

/** Trimmed text, or null. */
function toText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

/** Only the keys that name a real screen, de-duplicated and in catalogue order. */
function cleanScreens(value) {
  if (!Array.isArray(value)) return [];
  const given = new Set(value.map((v) => String(v)));
  return SCREENS.map((s) => s.key).filter((key) => given.has(key) && isScreen(key));
}

/**
 * The department as given, or null for "not stated".
 *
 * '' and null both mean unstated -- an admin clearing the dropdown is saying
 * they do not know, which is a legitimate answer and not an error. Anything
 * else has to name a real department; a typo is rejected rather than stored.
 */
function readDepartment(value) {
  if (value === '' || value === null || value === undefined) return { ok: true, value: null };
  const key = String(value).toUpperCase();
  if (!isDepartment(key)) return { ok: false, value: null };
  return { ok: true, value: key };
}

/**
 * The branch grant as given, or null for "every branch".
 *
 * '' and null both mean unrestricted, which is a real answer and the one a new
 * account starts on -- most people are not confined to a branch, and defaulting
 * to a confinement would be deciding for the administrator.
 *
 * Anything else has to name a configured branch, matched the way the filter
 * matches it -- case-insensitively -- and stored back in the configuration's
 * own spelling. A typo is rejected rather than stored: a grant naming a place
 * that does not exist selects nothing, so the account would open every screen
 * to an empty table with nothing on it saying why.
 */
async function readBranchLocation(value) {
  if (value === '' || value === null || value === undefined) return { ok: true, value: null };
  const wanted = String(value).trim();
  if (wanted === '') return { ok: true, value: null };
  const { rows } = await query(
    'SELECT location FROM branch_configs WHERE upper(location) = upper($1) ORDER BY id LIMIT 1',
    [wanted],
  );
  if (rows.length === 0) return { ok: false, value: null };
  return { ok: true, value: rows[0].location };
}

/**
 * The branch names an account can be confined to: every configured location,
 * once each.
 *
 * Every branch, not only the ticked ones. Ticking scopes what the screens show
 * this month and can be changed by anyone with the configuration screen; a
 * grant on an account is meant to outlast that, and an admin should not have to
 * tick a branch in order to be able to give somebody to it.
 */
async function branchLocations() {
  const { rows } = await query(
    `SELECT DISTINCT ON (upper(location)) location
       FROM branch_configs
      WHERE location IS NOT NULL AND btrim(location) <> ''
      ORDER BY upper(location), id`,
  );
  return rows.map((r) => r.location);
}

/** How many administrators are still able to sign in. */
async function activeAdminCount() {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM users WHERE role = 'ADMIN' AND is_active = TRUE",
  );
  return rows[0].n;
}

/**
 * GET /api/users
 *
 * Every account, plus the two catalogues the form is built from, so the client
 * never carries its own copy of the screen list to fall out of step with.
 *
 * Ordered active first, then by name: a deactivated account is kept for the
 * record rather than for daily use, and it should not sit between two accounts
 * someone is looking for.
 */
usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${USER_COLUMNS} ORDER BY u.is_active DESC, lower(u.username)`);
    res.json({
      users: rows.map(mapUser),
      screens: SCREENS,
      roles: ROLES,
      departments: DEPARTMENTS,
      // The configured branches, so the form's Location dropdown offers what
      // this installation actually has rather than a list kept on the client
      // and left to drift. Empty until branches are configured, which the form
      // says in place of the dropdown.
      locations: await branchLocations(),
      // Which row is the caller's own, so the client can grey out the controls
      // that would lock them out of their own session.
      currentUserId: req.user.id,
    });
  }),
);

/**
 * POST /api/users
 *
 * Body: username, password, fullName, role, screens, branchLocation.
 *
 * The screens are stored whatever the role: an administrator reaches every
 * screen regardless, but keeping the ticks means demoting the account later
 * does not silently strip it of everything. The branch is stored on the same
 * terms and for the same reason.
 */
usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const username = toText(req.body?.username);
    const password = String(req.body?.password ?? '');
    const fullName = toText(req.body?.fullName);
    const role = String(req.body?.role ?? 'USER').toUpperCase();

    if (!username) {
      return res.status(400).json({ error: 'A username is required.' });
    }
    if (password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ error: `The password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (!ROLE_KEYS.includes(role)) {
      return res.status(400).json({ error: `"${req.body?.role ?? ''}" is not a role.` });
    }

    const department = readDepartment(req.body?.department);
    if (!department.ok) {
      return res
        .status(400)
        .json({ error: `"${req.body?.department ?? ''}" is not a department.` });
    }

    const branch = await readBranchLocation(req.body?.branchLocation);
    if (!branch.ok) {
      return res
        .status(400)
        .json({ error: `"${req.body?.branchLocation ?? ''}" is not a configured branch location.` });
    }

    const screens = cleanScreens(req.body?.screens);
    if (role === 'USER' && screens.length === 0) {
      return res
        .status(400)
        .json({ error: 'Tick at least one screen, or this account will have nowhere to go.' });
    }

    // Case-insensitively, because that is how signing in matches: letting
    // "kavitha" and "Kavitha" both exist would leave the login query returning
    // two rows for either spelling. A unique index on lower(username) enforces
    // the same rule in the database -- this check is only here to answer with a
    // sentence instead of a constraint violation.
    const taken = await query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    if (taken.rowCount > 0) {
      return res.status(409).json({ error: `"${username}" is already taken.` });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let created;
    try {
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, full_name, role, screens, department,
                            branch_location)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [username, passwordHash, fullName, role, screens, department.value, branch.value],
      );
      created = rows[0].id;
    } catch (err) {
      // Two admins creating the same name at once: the check above passed for
      // both and the index caught the second. Same answer either way.
      if (err.code === '23505') {
        return res.status(409).json({ error: `"${username}" is already taken.` });
      }
      throw err;
    }

    const { rows: full } = await query(`${USER_COLUMNS} WHERE u.id = $1`, [created]);
    return res.status(201).json({ user: mapUser(full[0]) });
  }),
);

/**
 * PATCH /api/users/:id
 *
 * Body: any subset of username, fullName, department, branchLocation, role,
 * screens, isActive.
 * Absent fields are left alone; the password is changed through its own route.
 *
 * A username can be changed. Nothing is attributed through it -- uploads,
 * handovers and stage changes all reference the account by id -- and a session
 * survives a rename for the same reason: the token carries the id, and
 * requireAuth looks the account up by that. What does follow the name is the
 * sign-in, so the person has to be told their new one.
 *
 * Two things are refused outright. An admin may not demote or deactivate their
 * own account -- the next request would be rejected and the screen they did it
 * from would close behind them. And the last active administrator may not be
 * demoted or deactivated by anyone, which would leave the installation with no
 * way to manage accounts at all short of a database edit.
 */
usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown account.' });
    }

    const { rows: existing } = await query(
      'SELECT id, username, role, is_active FROM users WHERE id = $1',
      [id],
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'That account no longer exists.' });
    }
    const before = existing[0];

    const assignments = [];
    const params = [];

    if ('username' in req.body) {
      const username = toText(req.body.username);
      if (!username) {
        return res.status(400).json({ error: 'A username is required.' });
      }
      // Case-insensitively, and excluding this account itself -- an admin
      // correcting the capitalisation of a name is changing it to something
      // that already matches their own row, and that is not a clash. The unique
      // index on lower(username) enforces the same rule; this only answers with
      // a sentence rather than a constraint violation.
      const taken = await query(
        'SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2',
        [username, id],
      );
      if (taken.rowCount > 0) {
        return res.status(409).json({ error: `"${username}" is already taken.` });
      }
      params.push(username);
      assignments.push(`username = $${params.length}`);
    }

    if ('fullName' in req.body) {
      params.push(toText(req.body.fullName));
      assignments.push(`full_name = $${params.length}`);
    }

    if ('department' in req.body) {
      const department = readDepartment(req.body.department);
      if (!department.ok) {
        return res
          .status(400)
          .json({ error: `"${req.body.department ?? ''}" is not a department.` });
      }
      params.push(department.value);
      assignments.push(`department = $${params.length}`);
    }

    if ('branchLocation' in req.body) {
      const branch = await readBranchLocation(req.body.branchLocation);
      if (!branch.ok) {
        return res
          .status(400)
          .json({ error: `"${req.body.branchLocation ?? ''}" is not a configured branch location.` });
      }
      params.push(branch.value);
      assignments.push(`branch_location = $${params.length}`);
    }

    let role = before.role;
    if ('role' in req.body) {
      role = String(req.body.role ?? '').toUpperCase();
      if (!ROLE_KEYS.includes(role)) {
        return res.status(400).json({ error: `"${req.body.role ?? ''}" is not a role.` });
      }
      params.push(role);
      assignments.push(`role = $${params.length}`);
    }

    let isActive = before.is_active;
    if ('isActive' in req.body) {
      isActive = Boolean(req.body.isActive);
      params.push(isActive);
      assignments.push(`is_active = $${params.length}`);
    }

    if ('screens' in req.body) {
      const screens = cleanScreens(req.body.screens);
      if (role === 'USER' && isActive && screens.length === 0) {
        return res
          .status(400)
          .json({ error: 'Tick at least one screen, or this account will have nowhere to go.' });
      }
      params.push(screens);
      assignments.push(`screens = $${params.length}`);
    }

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'Nothing was given to change.' });
    }

    const losesAdmin = before.role === 'ADMIN' && (role !== 'ADMIN' || isActive === false);

    if (losesAdmin && before.id === req.user.id) {
      return res.status(409).json({
        error: 'You cannot take your own administrator access away. Ask another admin to do it.',
      });
    }

    if (losesAdmin && before.is_active && (await activeAdminCount()) <= 1) {
      return res.status(409).json({
        error: 'This is the only active administrator. Promote another account first.',
      });
    }

    params.push(id);
    try {
      await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $${params.length}`, params);
    } catch (err) {
      // Two admins renaming to the same name at once: the check above passed
      // for both and the index caught the second.
      if (err.code === '23505') {
        return res.status(409).json({ error: `"${toText(req.body.username)}" is already taken.` });
      }
      throw err;
    }

    const { rows: full } = await query(`${USER_COLUMNS} WHERE u.id = $1`, [id]);
    return res.json({ user: mapUser(full[0]) });
  }),
);

/**
 * PATCH /api/users/:id/password
 *
 * Set a new password. There is no "current password" check: this is an admin
 * resetting an account somebody has been locked out of, not a user changing
 * their own. Existing tokens keep working -- they are signed, not stored -- so
 * an account being reset for a real security reason should be deactivated and
 * reactivated rather than only re-passworded.
 */
usersRouter.patch(
  '/:id/password',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown account.' });
    }

    const password = String(req.body?.password ?? '');
    if (password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ error: `The password must be at least ${MIN_PASSWORD} characters.` });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rowCount } = await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      id,
    ]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'That account no longer exists.' });
    }
    return res.json({ ok: true });
  }),
);

/**
 * DELETE /api/users/:id
 *
 * Remove an account outright. What it did stays: uploads, handovers and stage
 * changes all reference the user with ON DELETE SET NULL, so those records
 * survive with the person's name dropped rather than going with them.
 *
 * Deactivating is the gentler option and the one the screen leads with -- it
 * stops the sign-in immediately while keeping the name against past work.
 */
usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Unknown account.' });
    }
    if (id === req.user.id) {
      return res.status(409).json({ error: 'You cannot delete the account you are signed in as.' });
    }

    const { rows } = await query('SELECT role, is_active FROM users WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'That account no longer exists.' });
    }

    if (rows[0].role === 'ADMIN' && rows[0].is_active && (await activeAdminCount()) <= 1) {
      return res.status(409).json({
        error: 'This is the only active administrator. Promote another account first.',
      });
    }

    await query('DELETE FROM users WHERE id = $1', [id]);
    return res.status(204).end();
  }),
);
