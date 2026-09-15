/**
 * The activity log: who did what, and when.
 *
 * Every route that changes something calls logActivity once the change has
 * gone through. The log is for monitoring, not part of the action, so writing
 * it can never fail the request: errors are caught here and printed, and the
 * write is not awaited by the response.
 *
 * Read by the Activity logs screen through routes/logs.js.
 */
import { query } from '../db/pool.js';

/** How long an entry is kept before purgeOldLogs removes it. */
export const RETENTION_DAYS = 90;

/** The groups the screen's cards and category filter divide the log into. */
export const CATEGORIES = [
  { key: 'UPLOAD', label: 'Uploads' },
  { key: 'CSD', label: 'CSD' },
  { key: 'ACCOUNTS', label: 'Accounts' },
  { key: 'RECORDS', label: 'Records' },
  { key: 'DATES', label: 'Date corrections' },
  { key: 'USERS', label: 'Users' },
  { key: 'CONFIG', label: 'Configuration' },
];

/**
 * Every action the log records, with the wording the screen shows and the
 * category it is filed under. The one list both the writer and the screen read.
 */
export const ACTIONS = {
  UPLOAD: { label: 'Uploaded reports', category: 'UPLOAD' },
  UPLOAD_DELETE: { label: 'Deleted upload', category: 'UPLOAD' },
  UPLOAD_FILE_DELETE: { label: 'Deleted uploaded file', category: 'UPLOAD' },
  CSD_SEND: { label: 'Sent to CSD', category: 'CSD' },
  CSD_STAGE: { label: 'Moved CSD stage', category: 'CSD' },
  CSD_TAKE_BACK: { label: 'Took back from CSD', category: 'CSD' },
  CSD_DELETE: { label: 'Deleted CSD record', category: 'CSD' },
  RECORDS_SEND: { label: 'Sent to Records', category: 'RECORDS' },
  ACCOUNTS_RECEIVE: { label: 'Accounts received', category: 'ACCOUNTS' },
  ACCOUNTS_FORWARD: { label: 'Accounts forwarded', category: 'ACCOUNTS' },
  CSD_DATES: { label: 'Corrected CSD dates', category: 'DATES' },
  AGEING_DATES: { label: 'Corrected stage dates', category: 'DATES' },
  USER_CREATE: { label: 'Created user', category: 'USERS' },
  USER_UPDATE: { label: 'Updated user', category: 'USERS' },
  USER_PASSWORD: { label: 'Reset password', category: 'USERS' },
  USER_DELETE: { label: 'Deleted user', category: 'USERS' },
  BRANCH_CREATE: { label: 'Added branch', category: 'CONFIG' },
  BRANCH_UPDATE: { label: 'Updated branch', category: 'CONFIG' },
  BRANCH_DELETE: { label: 'Deleted branch', category: 'CONFIG' },
};

/**
 * The deletions the Activity logs screen's Deleted card gathers: uploads and
 * their files, accounts and branches -- each logged with a full record of what
 * was removed. CSD deletions are logged too but are not part of this view.
 */
export const DELETE_ACTIONS = ['UPLOAD_DELETE', 'UPLOAD_FILE_DELETE', 'USER_DELETE', 'BRANCH_DELETE'];

/**
 * Record one action by the signed-in user on `req`.
 *
 * `target` is what was acted on, as a person would search for it -- a GRN
 * number, a username, a branch code, an upload's name. `summary` is one
 * readable sentence. `details` is anything else worth keeping (from/to
 * stages, remarks, changed fields); never a password.
 *
 * Returns nothing and never throws.
 */
export function logActivity(req, { action, target = null, summary, details = null }) {
  const entry = ACTIONS[action];
  if (!entry) {
    console.error(`activity log: unknown action "${action}"`);
    return;
  }
  const user = req.user || {};
  query(
    `INSERT INTO activity_logs (user_id, username, user_name, action, category, target, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      user.id ?? null,
      user.username ?? null,
      user.full_name ?? null,
      action,
      entry.category,
      target == null ? null : String(target),
      summary || entry.label,
      details ? JSON.stringify(details) : null,
      req.ip ?? null,
    ],
  ).catch((err) => console.error('activity log: could not write entry:', err.message));
}

/** Delete entries older than RETENTION_DAYS. Never throws. */
export async function purgeOldLogs() {
  try {
    const { rowCount } = await query(
      `DELETE FROM activity_logs WHERE created_at < NOW() - make_interval(days => $1)`,
      [RETENTION_DAYS],
    );
    return rowCount;
  } catch (err) {
    console.error('activity log: purge failed:', err.message);
    return 0;
  }
}

/**
 * Only the fields that actually changed between two plain objects, as
 * `{ field: { from, to } }` -- or null when nothing did. For the "updated"
 * entries, so a log line says what was changed rather than repeating the row.
 */
export function changedFields(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
