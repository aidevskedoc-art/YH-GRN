/**
 * HIS vs FOCUS Reco: the HIS vendor master held against the Accounts (FOCUS)
 * vendor list. It began as the MSME reco, and the route, screen key and
 * tables keep that name.
 *
 *   POST   /api/msme-reco/runs   upload both files, reconcile, store
 *   GET    /api/msme-reco/rows   every vendor once, filtered and paged
 *
 * A run is stored -- a row for every vendor master row, and a count for the
 * Accounts codes the vendor master lacks -- so the screen and its export read
 * from the table rather than from the files. The screen shows no one run: it
 * shows every vendor once, from the latest reco that carried it (CURRENT
 * below). The matching is services/msmeReco.js; nothing here decides what
 * agrees.
 *
 * The vendor master file is also applied to the Vendor Master -- new vendors
 * added, known ones updated with the file's values (services/vendorMaster.js).
 * It is the correct data, and this is the only way in for it.
 *
 * There is no deleting a run. The Vendor Master keeps one row per vendor, so
 * uploading the same files again only updates what changed -- nothing piles
 * up that would need taking back out.
 */
import express from 'express';
import multer from 'multer';
import { config } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { readVendorMaster, readAccountMaster, ExcelFormatError } from '../services/excelParser.js';
import { reconcileMsme, FIELDS, FIELD_KEYS, STATUS, STORED_STATUSES } from '../services/msmeReco.js';
import { bulkInsert } from '../services/ingest.js';
import { applyPendingRuns, applyVendorMaster } from '../services/vendorMaster.js';
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
    // What the run did to the Vendor Master; null for one not yet applied.
    vendorMaster:
      row.vm_added == null ? null : { added: row.vm_added, updated: row.vm_updated, unchanged: row.vm_unchanged },
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
    // When the reco this row came from was run -- the latest that had the
    // vendor (see CURRENT).
    recoAt: row.run_uploaded_at ?? null,
  };
}

// With what the run's vendor master file did to the Vendor Master, when it has
// been applied -- see vendor_master_applies in schema.sql.
const RUN_SELECT = `
  SELECT r.*, u.full_name AS uploader_name, u.username AS uploader_username,
         vma.added AS vm_added, vma.updated AS vm_updated, vma.unchanged AS vm_unchanged
    FROM msme_reco_runs r
    LEFT JOIN users u ON u.id = r.uploaded_by
    LEFT JOIN vendor_master_applies vma ON vma.run_id = r.id`;

async function findRun(id) {
  const { rows } = await query(`${RUN_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ?? null;
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

    const { id: runRow, vendorMaster } = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO msme_reco_runs
           (vendor_file_name, vendor_sheet_name, account_file_name, vendor_row_count, account_row_count,
            matched_count, mismatch_count, not_in_accounts_count, not_in_his_count, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, uploaded_at`,
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

      // The same file, every column of it, into the Vendor Master: new vendors
      // added, known ones updated. In this transaction, so a reco that fails
      // leaves the master as it was.
      //
      // Last, after the reco's own rows: the master's lock is taken here, and
      // held to the end, so recos landing together are applied one after the
      // other. Taking it after the tables above keeps the order every other
      // path takes them in -- migrate.js runs schema.sql over the same tables
      // in that order -- so the two cannot deadlock. First any earlier run not
      // yet applied (one stored by a server still running older code), so this
      // file lands on top of it; not this one, which has no apply row yet.
      await applyPendingRuns(client, { exceptRunId: id });
      const applied = await applyVendorMaster(
        client,
        { id, uploadedAt: rows[0].uploaded_at, fileName: vendorFile.originalname, uploadedBy: req.user.id },
        vendor.master,
      );

      return { id, vendorMaster: applied };
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
        vendorMasterSheet: vendor.master.sheetName ?? null,
        vendorMasterAdded: vendorMaster.added,
        vendorMasterUpdated: vendorMaster.updated,
        vendorMasterUnchanged: vendorMaster.unchanged,
        vendorMasterSkipped: vendorMaster.skipped,
      },
    });

    return res.status(201).json({ run: mapRun(run) });
  }),
);

/**
 * Every vendor once, as a WITH clause named `cur`: each HIS vendor's row from
 * the latest reco that carried it. Vendors are told apart by code as the reco
 * matches them -- trimmed, runs of spaces folded to one, upper-cased (codeKey
 * in services/msmeReco.js) -- so uploading the same files again replaces
 * their rows here rather than adding a second copy, and a vendor the latest
 * file no longer lists keeps the answer its last reco gave.
 *
 * Every query below reads this rather than one run: the screen has no run to
 * pick, it shows everything at once.
 */
const CODE_KEY_SQL = `upper(regexp_replace(btrim(m.vendor_code), '\\s+', ' ', 'g'))`;
const CURRENT = `
  WITH cur AS (
    SELECT DISTINCT ON (${CODE_KEY_SQL}) m.*, r.uploaded_at AS run_uploaded_at
      FROM msme_reco_rows m
      JOIN msme_reco_runs r ON r.id = m.run_id
     WHERE m.status IN (${STORED_STATUSES.map((s) => `'${s}'`).join(', ')})
     ORDER BY ${CODE_KEY_SQL}, r.uploaded_at DESC, r.id DESC, m.seq
  )`;

/**
 * GET /api/msme-reco/rows?view=&field=&q=&page=&pageSize=&all=
 *
 * Every vendor once (see CURRENT), with the latest reco's own details for the
 * line over the table -- `latestRun` is null before the first reco -- and how
 * many recos have been run in all.
 *
 * `view` is one of the cards (ALL by default); `field` narrows to the rows
 * whose `field` pair disagrees; `q` is the search box. `all=1` drops the
 * paging, for the export. Rows come the latest reco's vendors first, in its
 * file's order, then any vendor only an earlier reco had.
 *
 * `counts` are per status with only the search applied -- the cards are how a
 * view is picked, so they must not shrink to the one already picked.
 * `fieldCounts` are per field within the view and the search: the chips are
 * how the view is narrowed, so they count what is in it.
 */
msmeRecoRouter.get(
  '/rows',
  asyncHandler(async (req, res) => {
    const { rows: latestRows } = await query(`${RUN_SELECT} ORDER BY r.uploaded_at DESC, r.id DESC LIMIT 1`);
    const { rows: runCountRows } = await query('SELECT COUNT(*)::int AS n FROM msme_reco_runs');

    const view = VIEWS.has(req.query.view) ? req.query.view : ALL_VIEW;
    const field = FIELD_KEYS.includes(req.query.field) ? req.query.field : null;
    const wantsAll = req.query.all === '1';

    // --- The cards: per status, search only.
    const countParams = [];
    const countWhere = [viewFilter(ALL_VIEW, countParams)];
    const countSearch = searchFilter(req.query.q, countParams);
    if (countSearch) countWhere.push(countSearch);
    const { rows: statusRows } = await query(
      `${CURRENT} SELECT status, COUNT(*)::int AS n FROM cur WHERE ${countWhere.join(' AND ')} GROUP BY status`,
      countParams,
    );
    const counts = Object.fromEntries(STORED_STATUSES.map((s) => [s, 0]));
    for (const r of statusRows) counts[r.status] = r.n;
    counts[ALL_VIEW] = STORED_STATUSES.reduce((sum, s) => sum + counts[s], 0);

    // --- The chips: per field, within the view and the search.
    const chipParams = [];
    const chipWhere = [viewFilter(view, chipParams)];
    const chipSearch = searchFilter(req.query.q, chipParams);
    if (chipSearch) chipWhere.push(chipSearch);
    const { rows: fieldRows } = await query(
      `${CURRENT}
       SELECT f AS field, COUNT(*)::int AS n
         FROM cur, unnest(mismatch_fields) AS f
        WHERE ${chipWhere.join(' AND ')}
        GROUP BY f`,
      chipParams,
    );
    const fieldCounts = Object.fromEntries(FIELD_KEYS.map((k) => [k, 0]));
    for (const r of fieldRows) if (r.field in fieldCounts) fieldCounts[r.field] = r.n;

    // --- The rows: view, field and search.
    const params = [];
    const where = [viewFilter(view, params)];
    if (field) {
      params.push(field);
      where.push(`$${params.length} = ANY(mismatch_fields)`);
    }
    const search = searchFilter(req.query.q, params);
    if (search) where.push(search);
    const whereSql = where.join(' AND ');

    const { rows: totalRows } = await query(`${CURRENT} SELECT COUNT(*)::int AS n FROM cur WHERE ${whereSql}`, params);
    const total = totalRows[0].n;

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));

    const { rows } = await query(
      `${CURRENT}
       SELECT * FROM cur WHERE ${whereSql} ORDER BY run_uploaded_at DESC, run_id DESC, seq
       ${wantsAll ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`}`,
      wantsAll ? params : [...params, pageSize, (page - 1) * pageSize],
    );

    return res.json({
      latestRun: latestRows[0] ? mapRun(latestRows[0]) : null,
      runCount: runCountRows[0].n,
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
