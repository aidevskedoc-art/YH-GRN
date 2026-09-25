/**
 * Vendor Master: every vendor the HIS vendor master has ever listed, once
 * each, with its latest details -- the correct data the HIS vs FOCUS Reco
 * holds FOCUS to.
 *
 *   GET   /api/vendor-master/rows   the master, filtered and paged
 *   PATCH /api/vendor-master/:id    set a vendor's Supply Type or Inter
 *
 * The details are the HIS file's, filled by each reco run's vendor master file
 * (see applyVendorMaster in services/vendorMaster.js), and nothing here changes
 * or removes them. Supply Type and Inter are the two things picked here, by
 * hand.
 */
import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { logActivity } from '../services/activityLog.js';

export const vendorMasterRouter = express.Router();

vendorMasterRouter.use(requireAuth, requireScreen('vendor-master'));

const MAX_PAGE_SIZE = 200;

/**
 * The views the screen's cards select: every vendor (the default), the ones
 * with no STATUS, or one STATUS value as the files spell it -- which values
 * there are is the files' to say, so any other `view` is taken as one.
 */
const ALL_VIEW = 'ALL';
const NO_STATUS_VIEW = 'NO_STATUS';

/** "Vendor  Code" -> "VENDORCODE": a column name as the parser matches it. */
const token = (label) => String(label ?? '').toUpperCase().replace(/\s+/g, '');

/**
 * File columns kept in the master but not shown, exported or searched, by
 * token. CREATED_DATE is when the vendor was set up in HIS, which nobody
 * reading this screen needs.
 */
const HIDDEN_COLUMNS = ['CREATED_DATE'];

/**
 * The details picked by hand on the screen, each from a dropdown, by the name
 * the API uses: the column it is kept in, what the screen calls it, and the
 * values it can take, as stored, with how each reads. Not the HIS file's, so
 * applying a file never touches them. See vendor_master in schema.sql.
 *
 * Neither can be cleared: a vendor always has one of the values, Regular and
 * No until somebody picks otherwise (the columns' defaults).
 */
const PICKED = {
  supplyType: { column: 'supply_type', label: 'Supply Type', values: { REGULAR: 'Regular', STENTS: 'Stents' } },
  inter: { column: 'inter', label: 'Inter', values: { NO: 'No', YES: 'Yes' } },
};

/** The `view` query parameter as one of the views above, or a STATUS key. */
function parseView(value) {
  const text = String(value ?? '').trim();
  if (text === '' || text === ALL_VIEW) return ALL_VIEW;
  if (text === NO_STATUS_VIEW) return NO_STATUS_VIEW;
  return text.toUpperCase();
}

/**
 * Push the search parameters and return their SQL, or null when nothing was
 * typed.
 *
 * Every column shown is searched, not a chosen few: the point of keeping the
 * whole master is that a vendor can be found by whatever is known about it --
 * an IFSC, a city, a drug licence -- and so is its supply type. A hidden column
 * is not, or a vendor could match on a value the screen does not show. Each
 * value is matched on its own, so a term cannot match across the edge of two.
 */
function searchFilter(term, params, hidden) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const like = `$${params.length}`;
  params.push(hidden);
  return `(EXISTS (SELECT 1 FROM jsonb_each_text(data) AS kv
                    WHERE kv.value ILIKE ${like} AND NOT (kv.key = ANY($${params.length}::text[])))
           OR supply_type ILIKE ${like})`;
}

/**
 * The last file applied to the master, for the screen's "last updated" line,
 * or null before any has been. Read from vendor_master_applies, which records
 * each file the master took in.
 *
 * `rebuiltOnly` is true while no file read whole has ever been applied -- only
 * runs from before the master existed, rebuilt from the columns the reco
 * keeps -- so the screen can say why columns are missing.
 */
async function lastApply() {
  const { rows } = await query(
    `SELECT a.run_id, a.file_name, a.sheet_name, a.run_uploaded_at, a.added, a.updated, a.unchanged,
            a.skipped, u.full_name AS uploader_name, u.username AS uploader_username,
            NOT EXISTS (SELECT 1 FROM vendor_master_applies f WHERE f.full_file) AS rebuilt_only
       FROM vendor_master_applies a
       LEFT JOIN users u ON u.id = a.uploaded_by
      ORDER BY a.applied_at DESC, a.id DESC
      LIMIT 1`,
  );
  const apply = rows[0];
  if (!apply) return null;
  return {
    runId: apply.run_id,
    fileName: apply.file_name,
    sheetName: apply.sheet_name,
    uploadedAt: apply.run_uploaded_at,
    uploadedBy: apply.uploader_name || apply.uploader_username || null,
    added: apply.added,
    updated: apply.updated,
    unchanged: apply.unchanged,
    skipped: apply.skipped,
    rebuiltOnly: apply.rebuilt_only,
  };
}

/**
 * GET /api/vendor-master/rows?view=&q=&page=&pageSize=&all=
 *
 * `view` is one of the cards (ALL by default); `q` is the search box. `all=1`
 * drops the paging, for the export. Rows come in vendor code order, each as
 * its `cells` in the order of `headers`.
 *
 * `statuses` are the cards past the first: one per STATUS value the master
 * holds, each with its count under the search. The set comes from the whole
 * master, so a card does not vanish when a search leaves it empty.
 *
 * `headers` leaves out HIDDEN_COLUMNS. Each row carries its `supplyType`
 * (REGULAR or STENTS) and `inter` (NO or YES) beside its cells.
 */
vendorMasterRouter.get(
  '/rows',
  asyncHandler(async (req, res) => {
    const { rows: columnRows } = await query('SELECT name FROM vendor_master_columns ORDER BY position, name');
    const hidden = columnRows.map((c) => c.name).filter((name) => HIDDEN_COLUMNS.includes(token(name)));
    const headers = columnRows.map((c) => c.name).filter((name) => !hidden.includes(name));

    // The cards read the STATUS column, wherever the files put it: its value
    // trimmed and upper-cased, or NULL. Pushes the column name only where the
    // SQL uses it -- a parameter the statement never names is an error.
    const statusColumn = headers.find((name) => token(name) === 'STATUS');
    const statusOf = (params) => {
      if (!statusColumn) return 'NULL::text';
      params.push(statusColumn);
      return `NULLIF(upper(btrim(data->>$${params.length})), '')`;
    };

    const view = parseView(req.query.view);
    const wantsAll = req.query.all === '1';

    // --- The cards: per status, search only.
    const countParams = [];
    const countStatus = statusOf(countParams);
    const countSearch = searchFilter(req.query.q, countParams, hidden);
    const { rows: statusRows } = await query(
      `SELECT ${countStatus} AS status, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${countSearch ?? 'TRUE'})::int AS n
         FROM vendor_master
        GROUP BY 1
        ORDER BY 1 NULLS LAST`,
      countParams,
    );
    const statuses = statusRows.map((r) => ({ key: r.status ?? NO_STATUS_VIEW, count: r.n }));
    const vendorCount = statusRows.reduce((sum, r) => sum + r.total, 0);

    // --- The rows: view and search.
    const params = [];
    const where = [];
    if (view === NO_STATUS_VIEW) {
      where.push(`${statusOf(params)} IS NULL`);
    } else if (view !== ALL_VIEW) {
      const status = statusOf(params);
      params.push(view);
      where.push(`${status} = $${params.length}`);
    }
    const search = searchFilter(req.query.q, params, hidden);
    if (search) where.push(search);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { rows: totalRows } = await query(`SELECT COUNT(*)::int AS n FROM vendor_master ${whereSql}`, params);
    const total = totalRows[0].n;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));

    const { rows } = await query(
      `SELECT id, data, supply_type, inter FROM vendor_master ${whereSql} ORDER BY code_key
       ${wantsAll ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      wantsAll ? params : [...params, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      lastApply: await lastApply(),
      vendorCount,
      headers,
      // Where the two columns every row is read by stand, so the screen can
      // hold them at the left edge; -1 when no file has had such a column.
      codeIndex: headers.findIndex((h) => token(h) === 'VENDOR_CODE'),
      nameIndex: headers.findIndex((h) => token(h) === 'VENDOR_NAME'),
      view,
      counts: { [ALL_VIEW]: statuses.reduce((sum, s) => sum + s.count, 0), statuses },
      rows: rows.map((r) => ({
        id: r.id,
        supplyType: r.supply_type,
        inter: r.inter,
        cells: headers.map((h) => r.data?.[h] ?? null),
      })),
      total,
      ...(wantsAll ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    });
  }),
);

/**
 * PATCH /api/vendor-master/:id  { supplyType?: 'REGULAR' | 'STENTS', inter?: 'NO' | 'YES' }
 *
 * Set a vendor's Supply Type and/or Inter -- whichever the body names. Neither
 * can be cleared: a vendor always has one of the values. Open to anyone given
 * this screen, like the rest of it.
 * Kept in their own columns, which applying a HIS file never touches, so a
 * later reco cannot undo them. Each change is logged, with what it was before.
 */
vendorMasterRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Unknown vendor.' });
    }

    // The fields the body names, each checked against its own list.
    const changes = [];
    for (const [field, spec] of Object.entries(PICKED)) {
      if (!(field in (req.body ?? {}))) continue;
      const raw = req.body[field];
      const value = raw == null || raw === '' ? null : String(raw).trim().toUpperCase();
      if (value === null || !(value in spec.values)) {
        return res.status(400).json({ error: `${spec.label} must be ${Object.values(spec.values).join(' or ')}.` });
      }
      changes.push({ field, spec, value });
    }
    if (changes.length === 0) {
      return res.status(400).json({ error: `Nothing to change: send ${Object.keys(PICKED).join(' or ')}.` });
    }

    // The values before, read in the same statement that changes them, for the log.
    const params = [id, ...changes.map((c) => c.value)];
    const { rows } = await query(
      `UPDATE vendor_master v
          SET ${changes.map((c, i) => `${c.spec.column} = $${i + 2}`).join(', ')}
         FROM vendor_master old
        WHERE v.id = $1 AND old.id = v.id
       RETURNING v.id, v.vendor_code, v.data->>'VENDOR_NAME' AS vendor_name,
                 ${Object.values(PICKED).map((s) => `old.${s.column} AS before_${s.column}, v.${s.column}`).join(', ')}`,
      params,
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'That vendor is not in the Vendor Master.' });

    const name = row.vendor_name ? ` (${row.vendor_name})` : '';
    for (const { spec, value } of changes) {
      const before = row[`before_${spec.column}`];
      if (before === value) continue;
      logActivity(req, {
        action: 'VENDOR_UPDATE',
        target: row.vendor_code,
        summary: value
          ? `Set ${spec.label} of ${row.vendor_code}${name} to ${spec.values[value]}`
          : `Cleared ${spec.label} of ${row.vendor_code}${name}`,
        details: { vendorCode: row.vendor_code, field: spec.label, from: before, to: value },
      });
    }

    return res.json({ id: row.id, supplyType: row.supply_type, inter: row.inter });
  }),
);
