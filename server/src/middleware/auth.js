import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { screensFor } from '../config/screens.js';

/**
 * Verify the bearer token and attach the user to the request.
 * The user is re-read from the database on each request so that a deactivated
 * account stops working immediately rather than when its token expires.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const { rows } = await query(
      `SELECT id, username, full_name, role, screens, department, branch_location, is_active
         FROM users WHERE id = $1`,
      [payload.sub],
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    // Switched off while signed in: the session ends here, and it says why, in
    // the same words the login form uses, so the two routes to being turned
    // away read as the one thing that they are.
    if (!user.is_active) {
      return res
        .status(401)
        .json({ error: 'Login restricted. Please contact the administrator.' });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Refuse anyone who is not an administrator.
 *
 * Mounted after requireAuth, on the handful of routes that change who may do
 * what -- the user management API -- and on the two date corrections behind the
 * GRNS SPAN tab. The client hides those controls from a standard user, but
 * hiding a button is a courtesy; this is the rule.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only an administrator can do that.' });
  }
  return next();
}

/**
 * Refuse anyone who holds none of `screens`.
 *
 * An administrator passes without being granted anything -- see screensFor --
 * so the account that hands out access can never be shut out of a screen by the
 * same list it edits.
 *
 * More than one key is allowed because a route can stand behind more than one
 * screen: the Accounts Depot is the results screen with two of its five views,
 * reading the same rows from the same endpoints, so those carry both keys (see
 * routes/results.js) rather than a second copy of every query. Holding either
 * is enough -- these are alternatives, not a set to satisfy all of.
 */
export function requireScreen(...screens) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const held = screensFor(req.user);
    if (screens.some((screen) => held.includes(screen))) return next();
    return res.status(403).json({ error: 'You have not been given access to this screen.' });
  };
}
