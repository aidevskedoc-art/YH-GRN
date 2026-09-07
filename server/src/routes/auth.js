import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { screensFor, branchFor } from '../config/screens.js';

export const authRouter = express.Router();

/**
 * The account as the browser is allowed to see it.
 *
 * `screens` is the resolved list rather than the stored column: an admin has
 * every screen whatever the row says, and the client renders its navigation
 * straight off this, so resolving it here keeps the two in step.
 */
export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    department: user.department ?? null,
    screens: screensFor(user),
    // The branch this account is confined to, or null for every branch. The
    // resolved answer rather than the stored column, as `screens` is: the
    // client reads it to lock the Location dropdown to one place, and it should
    // lock only where the server actually narrows.
    branchLocation: branchFor(user),
    isActive: user.is_active !== false,
  };
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are both required.' });
    }

    const { rows } = await query(
      `SELECT id, username, password_hash, full_name, role, screens, department, branch_location,
              is_active
         FROM users WHERE lower(username) = lower($1)`,
      [String(username).trim()],
    );
    const user = rows[0];

    // A single generic message for every failure, so the response cannot be
    // used to discover which usernames exist.
    const reject = () => res.status(401).json({ error: 'Incorrect username or password.' });

    if (!user) return reject();

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return reject();

    // Only now, once the password has been proved, is the account's state worth
    // naming: someone who has typed their own password correctly deserves to be
    // told why they are being turned away rather than being left to retype it.
    // Saying it any earlier would turn the message into a way of discovering
    // which usernames exist. 403 rather than 401 -- the credentials were good,
    // the account is not permitted -- which also keeps it clear of the client's
    // expired-session handling.
    if (!user.is_active) {
      return res
        .status(403)
        .json({ error: 'Login restricted. Please contact the administrator.' });
    }

    return res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});
