/**
 * HIS vs FOCUS Reco: the HIS vendor master held against the Accounts (FOCUS)
 * vendor list. It began as the MSME reco, and the route, screen key and
 * tables keep that name.
 *
 *   GET    /api/msme-reco/runs            every run, newest first
 *   POST   /api/msme-reco/runs            upload both files, reconcile, store
 *   GET    /api/msme-reco/runs/:id/rows   one run's rows, filtered and paged
 *   DELETE /api/msme-reco/runs/:id        remove a run (administrators only)
 *
 * A run is stored -- a row for every vendor master row, and a count for the
 * Accounts codes the vendor master lacks -- so the screen and its export read
 * from the table rather than from the files, and reopening a
 * run a week later does not mean finding the two workbooks again. The
 * matching is services/msmeReco.js; nothing here decides what agrees.
 */
import express from 'express';
import multer from 'multer';
import { config } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { readVendorMaster, readAccountMaster, ExcelFormatError } from '../services/excelParser.js';
import { reconcileMsme, FIELDS, FIELD_KEYS, STATUS, STORED_STATUSES } from '../services/msmeReco.js';
import { bulkInsert } from '../services/ingest.js';
import { logActivity } from '../services/activityLog.js';

export const msmeRecoRouter = express.Router();

msmeRecoRouter.use(requireAuth, requireScreen('msme-reco'));

const upload = multer({
  storage: multer.memoryStorage(),
  // The two masters and nothing else.
  limits: { fileSize: config.maxUploadBytes, files: 2 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    return cb(new ExcelFormatError(`"${file.originalname}" is not an Excel file. Upload .xls or .xlsx.`));
  },
});

const MAX_PAGE_SIZE = 200;

/**
 * The views the screen's cards select. ALL -- the default -- is every stored
 * row, which is every vendor master row whatever the reco found. The others
 * are one stored status each. Accounts codes the vendor master lacks are not
 * stored (see STORED_STATUSES), so they have a count on the run and no view.
 */
const ALL_VIEW = 'ALL';
const VIEWS = new Set([ALL_VIEW, ...STORED_STATUSES]);

/** drugLicence -> drug_licence: a field key as its pair of columns spells it. */
const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The compared columns, in FIELDS order: his_name, acc_name, his_pan, ... */
const PAIR_COLUMNS = FIELDS.flatMap((f) => [`his_${snake(f.key)}`, `acc_${snake(f.key)}`]);

const ROW_COLUMNS = [
  'run_id',
  'seq',
  'status',
  'vendor_code',
  'acc_code',
  'his_row_no',
  'acc_row_no',
  'warehouse',
  'his_status',
  ...PAIR_COLUMNS,
  'mismatch_fields',
  'remarks',
];

/**
 * What the search box looks in: the code on either side, and the name, PAN and
 * GSTIN on either side -- the things a vendor is looked up by. Not the remarks:
 * the field chips are how a kind of difference is picked.
 */
const SEARCH_COLUMNS = [
  'vendor_code',
  'acc_code',
  'his_name',
  'acc_name',
  'his_pan',
  'acc_pan',
  'his_gst',
  'acc_gst',
];

/** The field list as the client needs it: no parser property names. */
const PUBLIC_FIELDS = FIELDS.map(({ key, label, his, acc }) => ({ key, label, his, acc }));

function mapRun(row) {
  return {
    id: row.id,
    vendorFileName: row.vendor_file_name,
    vendorSheetName: row.vendor_sheet_name,
    accountFileName: row.account_file_name,
    vendorRowCount: row.vendor_row_count,
    accountRowCount: row.account_row_count,
    counts: {
      [STATUS.MATCHED]: row.matched_count,
      [STATUS.MISMATCH]: row.mismatch_count,
      [STATUS.NOT_IN_ACCOUNTS]: row.not_in_accounts_count,
      [STATUS.NOT_IN_HIS]: row.not_in_his_count,
    },
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploader_name || row.uploader_username || null,
  };
}

/** One side's values as `{ name, pan, ... }`, or null when that side has no row. */
function sideOf(row, prefix, present) {
  if (!present) return null;
  return Object.fromEntries(FIELDS.map((f) => [f.key, row[`${prefix}_${snake(f.key)}`]]));
}

function mapRow(row) {
  return {
    id: row.id,
    status: row.status,
    vendorCode: row.vendor_code,
    accCode: row.acc_code,
    hisRowNo: row.his_row_no,
    accRowNo: row.acc_row_no,
    warehouse: row.warehouse,
    hisStatus: row.his_status,
    his: sideOf(row, 'his', row.status !== STATUS.NOT_IN_HIS),
    acc: sideOf(row, 'acc', row.status !== STATUS.NOT_IN_ACCOUNTS),
    mismatchFields: row.mismatch_fields ?? [],
    remarks: row.remarks,
  };
}

const RUN_SELECT = `
  SELECT r.*, u.full_name AS uploader_name, u.username AS uploader_username
    FROM msme_reco_runs r
    LEFT JOIN users u ON u.id = r.uploaded_by`;

async function findRun(id) {
  const { rows } = await query(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ?? null;
}

/** A positive integer id from the URL, or null. */
function runId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Push the search parameter and return its SQL, or null when nothing was typed. */
function searchFilter(term, params) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return null;
  params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`);
  const n = params.length;
  return `(${SEARCH_COLUMNS.map((col) => `${col} ILIKE $${n}`).join(' OR ')})`;
}

/**
 * Push the parameter for a view and return its SQL.
 *
 * ALL names the stored statuses rather than taking every row, so a run stored
 * before one-sided rows stopped being kept still reads the same as a new one.
 */
function viewFilter(view, params) {
  params.push(view === ALL_VIEW ? STORED_STATUSES : [view]);
  return `status = ANY($${params.length})`;
}

/**
 * GET /api/msme-reco/runs
 *
 * Also carries the field list, so the screen can lay out its table before a
 * run has been chosen.
 */
msmeRecoRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${RUN_SELECT} ORDER BY r.uploaded_at DESC, r.id DESC`);
    res.json({ runs: rows.map(mapRun), fields: PUBLIC_FIELDS });
  }),
);

/**
 * POST /api/msme-reco/runs - both files, as `vendorFile` and `accountFile`.
 *
 * Both are required: a reco of one list against nothing has no answer to
 * store. Each file's parse error names the file it came from, so a pair
 * dropped into the wrong slots says which one was not what it should be.
 */
msmeRecoRouter.post(
  '/runs',
  upload.fields([
    { name: 'vendorFile', maxCount: 1 },
    { name: 'accountFile', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const vendorFile = req.files?.vendorFile?.[0];
    const accountFile = req.files?.accountFile?.[0];

    if (!vendorFile || !accountFile) {
      return res.status(400).json({
        error: 'Choose both files: the HIS vendor master and the Accounts vendor list.',
      });
    }

    let vendor;
    try {
      vendor = readVendorMaster(vendorFile.buffer);
    } catch (err) {
      if (err instanceof ExcelFormatError) err.message = `HIS vendor master: ${err.message}`;
      throw err;
    }

    let account;
    try {
      account = readAccountMaster(accountFile.buffer);
    } catch (err) {
      if (err instanceof ExcelFormatError) err.message = `Accounts vendor list: ${err.message}`;
      throw err;
    }

    const { results, summary } = reconcileMsme(vendor.rows, account.rows);
    const { statuses } = summary;
    // Every status is counted on the run; only the vendor master's rows are
    // kept as rows -- see STORED_STATUSES.
    const stored = results.filter((r) => STORED_STATUSES.includes(r.status));

    const runRow = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO msme_reco_runs
           (vendor_file_name, vendor_sheet_name, account_file_name, vendor_row_count, account_row_count,
            matched_count, mismatch_count, not_in_accounts_count, not_in_his_count, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          vendorFile.originalname,
          vendor.sheetName ?? null,
          accountFile.originalname,
          summary.vendorRowCount,
          summary.accountRowCount,
          statuses[STATUS.MATCHED],
          statuses[STATUS.MISMATCH],
          statuses[STATUS.NOT_IN_ACCOUNTS],
          statuses[STATUS.NOT_IN_HIS],
          req.user.id,
        ],
      );
      const id = rows[0].id;

      await bulkInsert(client, 'msme_reco_rows', ROW_COLUMNS, stored, (r, i) => [
        id,
        i + 1,
        r.status,
        r.vendorCode,
        r.accCode,
        r.hisRowNo,
        r.accRowNo,
        r.warehouse,
        r.hisStatus,
        // null rather than '': a blank is "nothing written", and the screen
        // shows it as a dash either way.
        ...FIELDS.flatMap((f) => [r.his?.[f.key] || null, r.acc?.[f.key] || null]),
        r.mismatchFields,
        r.remarks,
      ]);

      return id;
    });

    const run = await findRun(runRow);

    logActivity(req, {
      action: 'MSME_RECO_RUN',
      target: `${vendorFile.originalname} vs ${accountFile.originalname}`,
      summary:
        `Ran HIS vs FOCUS reco on ${summary.vendorRowCount.toLocaleString('en-IN')} HIS vendors: ` +
        `${statuses[STATUS.MATCHED].toLocaleString('en-IN')} matched, ` +
        `${statuses[STATUS.MISMATCH].toLocaleString('en-IN')} mismatched, ` +
        `${statuses[STATUS.NOT_IN_ACCOUNTS].toLocaleString('en-IN')} not in Accounts`,
      details: {
        runId: run.id,
        vendorFile: vendorFile.originalname,
        vendorSheet: vendor.sheetName ?? null,
        accountFile: accountFile.originalname,
        vendorRows: summary.vendorRowCount,
        accountRows: summary.accountRowCount,
        onlyInAccounts: statuses[STATUS.NOT_IN_HIS],
        rowsStored: stored.length,
      },
    });

    return res.status(201).json({ run: mapRun(run) });
  }),
);

/**
 * GET /api/msme-reco/runs/:id/rows?view=&field=&q=&page=&pageSize=&all=
 *
 * `view` is one of the cards (ALL by default); `field` narrows to the rows
 * whose `field` pair disagrees; `q` is the search box. `all=1` drops the
 * paging, for the export.
 *
 * `counts` are per status with only the search applied -- the cards are how a
 * view is picked, so they must not shrink to the one already picked.
 * `fieldCounts` are per field within the view and the search: the chips are
 * how the view is narrowed, so they count what is in it.
 */
msmeRecoRouter.get(
  '/runs/:id/rows',
  asyncHandler(async (req, res) => {
    const id = runId(req.params.id);
    const run = id && (await findRun(id));
    if (!run) return res.status(404).json({ error: 'That reco could not be found.' });

    const view = VIEWS.has(req.query.view) ? req.query.view : ALL_VIEW;
    const field = FIELD_KEYS.includes(req.query.field) ? req.query.field : null;
    const wantsAll = req.query.all === '1';

    // --- The cards: per status, search only.
    const countParams = [id];
    const countWhere = ['run_id = $1', viewFilter(ALL_VIEW, countParams)];
    const countSearch = searchFilter(req.query.q, countParams);
    if (countSearch) countWhere.push(countSearch);
    const { rows: statusRows } = await query(
      `SELECT status, COUNT(*)::int AS n FROM msme_reco_rows WHERE ${countWhere.join(' AND ')} GROUP BY status`,
      countParams,
    );
    const counts = Object.fromEntries(STORED_STATUSES.map((s) => [s, 0]));
    for (const r of statusRows) counts[r.status] = r.n;
    counts[ALL_VIEW] = STORED_STATUSES.reduce((sum, s) => sum + counts[s], 0);

    // --- The chips: per field, within the view and the search.
    const chipParams = [id];
    const chipWhere = ['run_id = $1', viewFilter(view, chipParams)];
    const chipSearch = searchFilter(req.query.q, chipParams);
    if (chipSearch) chipWhere.push(chipSearch);
    const { rows: fieldRows } = await query(
      `SELECT f AS field, COUNT(*)::int AS n
         FROM msme_reco_rows, unnest(mismatch_fields) AS f
        WHERE ${chipWhere.join(' AND ')}
        GROUP BY f`,
      chipParams,
    );
    const fieldCounts = Object.fromEntries(FIELD_KEYS.map((k) => [k, 0]));
    for (const r of fieldRows) if (r.field in fieldCounts) fieldCounts[r.field] = r.n;

    // --- The rows: view, field and search.
    const params = [id];
    const where = ['run_id = $1', viewFilter(view, params)];
    if (field) {
      params.push(field);
      where.push(`$${params.length} = ANY(mismatch_fields)`);
    }
    const search = searchFilter(req.query.q, params);
    if (search) where.push(search);
    const whereSql = where.join(' AND ');

    const { rows: totalRows } = await query(
      `SELECT COUNT(*)::int AS n FROM msme_reco_rows WHERE ${whereSql}`,
      params,
    );
    const total = totalRows[0].n;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));

    const { rows } = await query(
      `SELECT * FROM msme_reco_rows WHERE ${whereSql} ORDER BY seq
       ${wantsAll ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      wantsAll ? params : [...params, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      run: mapRun(run),
      fields: PUBLIC_FIELDS,
      view,
      field,
      counts,
      fieldCounts,
      rows: rows.map(mapRow),
      total,
      ...(wantsAll ? {} : { page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
    });
  }),
);

/**
 * DELETE /api/msme-reco/runs/:id
 *
 * Administrators only, as deleting an upload is. Its rows go with it.
 */
msmeRecoRouter.delete(
  '/runs/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = runId(req.params.id);
    const run = id && (await findRun(id));
    if (!run) return res.status(404).json({ error: 'That reco could not be found.' });

    await query('DELETE FROM msme_reco_runs WHERE id = $1', [id]);

    logActivity(req, {
      action: 'MSME_RECO_DELETE',
      target: `${run.vendor_file_name} vs ${run.account_file_name}`,
      summary: `Deleted the HIS vs FOCUS reco of ${run.vendor_file_name} against ${run.account_file_name}`,
      details: {
        runId: run.id,
        vendorFile: run.vendor_file_name,
        vendorSheet: run.vendor_sheet_name,
        accountFile: run.account_file_name,
        ranAt: run.uploaded_at,
        ranBy: run.uploader_name || run.uploader_username || null,
        vendorRows: run.vendor_row_count,
        accountRows: run.account_row_count,
      },
    });

    return res.status(204).end();
  }),
);
