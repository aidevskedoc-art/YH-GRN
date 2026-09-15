/**
 * The activity log, for the Activity logs screen.
 *
 * Behind the Activity logs screen grant, which administrators hold by default
 * and can tick for anyone on User management. Read-only. Entries are written by
 * services/activityLog.js from the routes that change something; this router
 * only reads them.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ACTIONS, CATEGORIES, DELETE_ACTIONS, RETENTION_DAYS } from '../services/activityLog.js';

export const logsRouter = express.Router();

// The Activity logs screen grant -- administrators hold every screen.
logsRouter.use(requireAuth, requireScreen('logs'));

const MAX_PAGE_SIZE = 200;
/** The most an export will fetch; the screen says so when a file is cut short. */
const MAX_EXPORT_ROWS = 10000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `WHERE a AND b`, or '' when nothing is being filtered on. */
function whereFrom(clauses) {
  const kept = clauses.filter(Boolean);
  return kept.length > 0 ? `WHERE ${kept.join(' AND ')}` : '';
}

/**
 * Every filter except the category, as SQL clauses bound into `params`. The
 * category is left to the caller because the cards count across it.
 */
function baseFilters(req, params) {
  const clauses = [];

  const q = String(req.query.q || '').trim();
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const n = params.length;
    clauses.push(
      `(l.target ILIKE $${n} OR l.summary ILIKE $${n} OR l.username ILIKE $${n} OR l.user_name ILIKE $${n})`,
    );
  }

  const action = String(req.query.action || '').toUpperCase();
  if (action && ACTIONS[action]) {
    params.push(action);
    clauses.push(`l.action = $${params.length}`);
  }

  const userId = Number(req.query.userId);
  if (req.query.userId && Number.isInteger(userId)) {
    params.push(userId);
    clauses.push(`l.user_id = $${params.length}`);
  }

  const from = String(req.query.from || '');
  if (ISO_DATE.test(from)) {
    params.push(from);
    clauses.push(`l.created_at >= $${params.length}::date`);
  }

  const to = String(req.query.to || '');
  if (ISO_DATE.test(to)) {
    params.push(to);
    // Through the end of that day.
    clauses.push(`l.created_at < ($${params.length}::date + 1)`);
  }

  return clauses;
}

/** Only the tracked deletions (see DELETE_ACTIONS), when `deleted=1`. */
function deletedFilter(req, params) {
  if (String(req.query.deleted || '') !== '1') return null;
  params.push(DELETE_ACTIONS);
  return `l.action = ANY($${params.length})`;
}

function categoryFilter(req, params) {
  const category = String(req.query.category || '').toUpperCase();
  if (!category || !CATEGORIES.some((c) => c.key === category)) return null;
  params.push(category);
  return `l.category = $${params.length}`;
}

function mapLog(r) {
  return {
    id: Number(r.id),
    createdAt: r.created_at,
    userId: r.user_id,
    username: r.username,
    userName: r.user_name,
    action: r.action,
    actionLabel: ACTIONS[r.action]?.label ?? r.action,
    category: r.category,
    target: r.target,
    summary: r.summary,
    details: r.details,
    ip: r.ip,
  };
}

/**
 * GET /api/logs?page=&pageSize=&q=&category=&action=&userId=&from=&to=&all=
 *
 * The log, newest first, plus what the screen's cards and filters need: counts
 * for today, the last seven days and each category (every filter applied but
 * the category, so a card's figure does not vanish the moment it is pressed),
 * the action catalogue, and the people who appear in the log.
 *
 * `all=1` drops the pagination, for the export, up to MAX_EXPORT_ROWS.
 */
logsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const countParams = [];
    const countWhere = whereFrom(baseFilters(req, countParams));
    countParams.push(DELETE_ACTIONS);
    const deleteActionsParam = `$${countParams.length}`;
    const { rows: countRows } = await query(
      `SELECT l.category,
              COUNT(*)::int AS count,
              (COUNT(*) FILTER (WHERE l.action = ANY(${deleteActionsParam})))::int AS deleted,
              (COUNT(*) FILTER (WHERE l.created_at >= date_trunc('day', NOW())))::int AS today,
              (COUNT(*) FILTER (WHERE l.created_at >= NOW() - interval '7 days'))::int AS week
         FROM activity_logs l
         ${countWhere}
        GROUP BY l.category`,
      countParams,
    );

    const categories = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
    let today = 0;
    let week = 0;
    let all = 0;
    let deleted = 0;
    for (const r of countRows) {
      categories[r.category] = r.count;
      today += r.today;
      week += r.week;
      all += r.count;
      deleted += r.deleted;
    }

    const params = [];
    const where = whereFrom([
      ...baseFilters(req, params),
      categoryFilter(req, params),
      deletedFilter(req, params),
    ]);

    const { rows: totalRows } = await query(
      `SELECT COUNT(*)::int AS total FROM activity_logs l ${where}`,
      params,
    );
    const total = totalRows[0].total;

    const { rows: users } = await query(
      `SELECT DISTINCT ON (l.user_id) l.user_id, l.username, l.user_name
         FROM activity_logs l
        WHERE l.user_id IS NOT NULL
        ORDER BY l.user_id, l.created_at DESC`,
    );

    const order = 'ORDER BY l.created_at DESC, l.id DESC';
    const wantsAll = String(req.query.all || '') === '1';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = wantsAll
      ? MAX_EXPORT_ROWS
      : Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = wantsAll ? 0 : (page - 1) * pageSize;

    const { rows } = await query(
      `SELECT l.* FROM activity_logs l ${where} ${order}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    res.json({
      page: wantsAll ? 1 : page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      truncated: wantsAll && total > MAX_EXPORT_ROWS,
      counts: { all, today, week, deleted, categories },
      categories: CATEGORIES,
      actions: Object.entries(ACTIONS).map(([key, a]) => ({ key, ...a })),
      users: users
        .map((u) => ({ id: u.user_id, username: u.username, userName: u.user_name }))
        .sort((a, b) => String(a.userName || a.username).localeCompare(String(b.userName || b.username))),
      retentionDays: RETENTION_DAYS,
      rows: rows.map(mapLog),
    });
  }),
);
