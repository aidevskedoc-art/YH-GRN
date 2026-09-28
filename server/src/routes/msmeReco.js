/**
 * HIS vs FOCUS Reco: the HIS vendor master held against the Accounts (FOCUS)
 * vendor list. It began as the MSME reco, and the route, screen key and
 * tables keep that name.
 *
 *   POST   /api/msme-reco/runs   upload either file or both, reconcile, store
 *   GET    /api/msme-reco/rows   every vendor once, filtered and paged
 *
 * A run is stored -- a row for every vendor master row, and a count for the
 * Accounts codes the vendor master lacks -- so the screen and its export read
 * from the table rather than from the files. The screen shows no one run: it
 * shows every vendor once, from the latest reco that carried it (CURRENT
 * below). The matching is services/msmeReco.js; nothing here decides what
 * agrees.
 *
 * Each side's latest file is kept, as the reco reads it (msme_reco_files), so
 * either can be uploaded alone: a new FOCUS list is reconciled against the
 * latest HIS vendor master, and a new HIS vendor master against the latest
 * FOCUS list. With nothing kept for the other side yet, the file is only kept.
 *
 * An HIS vendor master file is also applied to the Vendor Master -- new
 * vendors added, known ones updated with the file's values
 * (services/vendorMaster.js) -- whether or not a reco could be run. It is the
 * correct data, and this is the only way in for it. A FOCUS list uploaded
 * alone leaves the master as it is.
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
  // The two masters, or either one, and nothing else.
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

/** The two sides of a reco, as msme_reco_files keys its kept files. */
const HIS = 'HIS';
const FOCUS = 'FOCUS';

function mapRun(row) {
  return {
    id: row.id,
    vendorFileName: row.vendor_file_name,
    vendorSheetName: row.vendor_sheet_name,
    accountFileName: row.account_file_name,
    vendorRowCount: row.vendor_row_count,
    accountRowCount: row.account_row_count,
    // Whether this run's upload brought each file -- false: it used the one
    // kept from an earlier upload, which *FileAt dates. A run from before
    // either could come alone brought both.
    vendorFileNew: row.vendor_file_new,
    accountFileNew: row.account_file_new,
    vendorFileAt: row.vendor_file_at ?? row.uploaded_at,
    accountFileAt: row.account_file_at ?? row.uploaded_at,
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

/** The kept files without their rows -- what the upload form says it will use. */
const FILE_SELECT = `
  SELECT f.side, f.file_name, f.sheet_name, f.row_count, f.uploaded_at,
         u.full_name AS uploader_name, u.username AS uploader_username
    FROM msme_reco_files f
    LEFT JOIN users u ON u.id = f.uploaded_by`;

function mapFile(row) {
  if (!row) return null;
  return {
    fileName: row.file_name,
    sheetName: row.sheet_name,
    rowCount: row.row_count,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploader_name || row.uploader_username || null,
  };
}

/**
 * One side's kept file, rows and all, inside the caller's transaction -- for
 * the side an upload left out. Null while that side has none yet.
 */
async function keptFile(client, side) {
  const { rows } = await client.query(
    'SELECT file_name, sheet_name, rows, uploaded_at FROM msme_reco_files WHERE side = $1',
    [side],
  );
  if (!rows[0]) return null;
  return {
    isNew: false,
    fileName: rows[0].file_name,
    sheetName: rows[0].sheet_name,
    rows: rows[0].rows,
    uploadedAt: rows[0].uploaded_at,
  };
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
 * POST /api/msme-reco/runs - either file or both, as `vendorFile` and
 * `accountFile`.
 *
 * A side left out is its latest kept file (msme_reco_files): a FOCUS list
 * alone is held against the latest HIS vendor master, and an HIS vendor master
 * alone against the latest FOCUS list. With no kept file for that side yet --
 * before the first FOCUS list, say -- there is no reco to run: the upload is
 * kept for when the other side comes, and an HIS file still updates the Vendor
 * Master, so vendors can be added from the HIS file alone.
 *
 * Answers `{ run, waitingFor, vendorMaster }`: the run stored, or null when
 * none could be, with `waitingFor` naming the side it waits for (HIS or
 * FOCUS); and what an HIS file did to the Vendor Master, or null.
 *
 * Each file's parse error names the file it came from, so a pair dropped into
 * the wrong slots says which one was not what it should be.
 */
msmeRecoRouter.post(
  '/runs',
  upload.fields([
    { name: 'vendorFile', maxCount: 1 },
    { name: 'accountFile', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const vendorFile = req.files?.vendorFile?.[0] ?? null;
    const accountFile = req.files?.accountFile?.[0] ?? null;

    if (!vendorFile && !accountFile) {
      return res.status(400).json({
        error: 'Choose a file: the HIS vendor master, the Accounts vendor list, or both.',
      });
    }

    // Whichever came, read before the transaction: it is the slow part.
    let vendor = null;
    if (vendorFile) {
      try {
        vendor = readVendorMaster(vendorFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `HIS vendor master: ${err.message}`;
        throw err;
      }
    }

    let account = null;
    if (accountFile) {
      try {
        account = readAccountMaster(accountFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `Accounts vendor list: ${err.message}`;
        throw err;
      }
    }

    const { id: runRow, his, focus, summary, stored, vendorMaster } = await withTransaction(async (client) => {
      // One reco at a time. Each reads the files the last one kept, so two
      // uploads landing together -- an HIS file and a FOCUS list, say -- must
      // not each be held against the other's old file. Readers are not
      // blocked. The runs table is the first of these tables every path takes
      // (see the Vendor Master's lock below), so taking it first keeps that
      // order.
      await client.query('LOCK TABLE msme_reco_runs IN SHARE ROW EXCLUSIVE MODE');
      // Read once the lock is held, so runs are timed in the order they ran.
      const { rows: clock } = await client.query('SELECT clock_timestamp() AS now');
      const at = clock[0].now;

      const his = vendor
        ? { isNew: true, fileName: vendorFile.originalname, sheetName: vendor.sheetName ?? null, rows: vendor.rows, uploadedAt: at }
        : await keptFile(client, HIS);
      const focus = account
        ? { isNew: true, fileName: accountFile.originalname, sheetName: account.sheetName ?? null, rows: account.rows, uploadedAt: at }
        : await keptFile(client, FOCUS);

      // A reco needs both sides. With the other not on file yet, the upload
      // is only kept for it -- and an HIS file still reaches the Vendor Master
      // below, which is how vendors are added without a FOCUS list to hand.
      let id = null;
      let summary = null;
      let stored = [];
      if (his && focus) ({ id, summary, stored } = await storeReco(client, req, his, focus, at));

      // The files this upload brought replace the kept ones of their side,
      // for the next upload of the other. After the reco's rows, before the
      // Vendor Master: the order schema.sql takes these tables in.
      for (const [side, file] of [
        [HIS, his],
        [FOCUS, focus],
      ]) {
        if (!file?.isNew) continue;
        await client.query(
          `INSERT INTO msme_reco_files (side, file_name, sheet_name, row_count, rows, uploaded_by, uploaded_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (side) DO UPDATE
              SET file_name = EXCLUDED.file_name,
                  sheet_name = EXCLUDED.sheet_name,
                  row_count = EXCLUDED.row_count,
                  rows = EXCLUDED.rows,
                  uploaded_by = EXCLUDED.uploaded_by,
                  uploaded_at = EXCLUDED.uploaded_at`,
          [side, file.fileName, file.sheetName, file.rows.length, JSON.stringify(file.rows), req.user.id, at],
        );
      }

      // A new HIS file, every column of it, into the Vendor Master: new
      // vendors added, known ones updated -- reconciled or not. In this
      // transaction, so an upload that fails leaves the master as it was. A
      // FOCUS list alone has nothing for the master: the kept HIS file was
      // applied by the upload that brought it. Without a reco there is no run
      // to record the apply against, and its row says so with a NULL run_id.
      //
      // Last, after the reco's own rows: the master's lock is taken here, and
      // held to the end, so uploads landing together are applied one after the
      // other. Taking it after the tables above keeps the order every other
      // path takes them in -- migrate.js runs schema.sql over the same tables
      // in that order -- so the two cannot deadlock. First any earlier run not
      // yet applied (one stored by a server still running older code), so this
      // file lands on top of it; not this one, which has no apply row yet.
      let applied = null;
      if (vendor) {
        await applyPendingRuns(client, { exceptRunId: id });
        applied = await applyVendorMaster(
          client,
          { id, uploadedAt: at, fileName: vendorFile.originalname, uploadedBy: req.user.id },
          vendor.master,
        );
      }

      return { id, his, focus, summary, stored, vendorMaster: applied };
    });

    if (!runRow) {
      // Kept, and waiting for the other side's file to reconcile against.
      const file = his ?? focus;
      const waitingFor = his ? FOCUS : HIS;
      logActivity(req, {
        action: 'MSME_FILE_KEPT',
        target: file.fileName,
        summary: his
          ? `Uploaded the HIS vendor master alone, with no FOCUS list on file to reconcile it against: ` +
            `${vendorMaster.added.toLocaleString('en-IN')} vendors added to the Vendor Master, ` +
            `${vendorMaster.updated.toLocaleString('en-IN')} updated`
          : 'Uploaded the FOCUS list alone, with no HIS vendor master on file to reconcile it against',
        details: {
          side: his ? HIS : FOCUS,
          file: file.fileName,
          sheet: file.sheetName,
          rows: file.rows.length,
          ...(vendorMaster ? vendorMasterDetails(vendor, vendorMaster) : {}),
        },
      });
      return res.status(201).json({ run: null, waitingFor, vendorMaster });
    }

    const run = await findRun(runRow);
    const { statuses } = summary;
    const alone = !vendor
      ? ' (FOCUS list alone, against the kept HIS vendor master)'
      : !account
        ? ' (HIS vendor master alone, against the kept FOCUS list)'
        : '';

    logActivity(req, {
      action: 'MSME_RECO_RUN',
      target: `${his.fileName} vs ${focus.fileName}`,
      summary:
        `Ran HIS vs FOCUS reco${alone} on ${summary.vendorRowCount.toLocaleString('en-IN')} HIS vendors: ` +
        `${statuses[STATUS.MATCHED].toLocaleString('en-IN')} matched, ` +
        `${statuses[STATUS.MISMATCH].toLocaleString('en-IN')} mismatched, ` +
        `${statuses[STATUS.NOT_IN_ACCOUNTS].toLocaleString('en-IN')} not in Accounts`,
      details: {
        runId: run.id,
        vendorFile: his.fileName,
        vendorFileUploaded: his.isNew,
        vendorSheet: his.sheetName,
        accountFile: focus.fileName,
        accountFileUploaded: focus.isNew,
        vendorRows: summary.vendorRowCount,
        accountRows: summary.accountRowCount,
        onlyInAccounts: statuses[STATUS.NOT_IN_HIS],
        rowsStored: stored.length,
        ...(vendorMaster ? vendorMasterDetails(vendor, vendorMaster) : {}),
      },
    });

    return res.status(201).json({ run: mapRun(run), waitingFor: null, vendorMaster });
  }),
);

/** What an upload did to the Vendor Master, for its activity log entry. */
function vendorMasterDetails(vendor, applied) {
  return {
    vendorMasterSheet: vendor.master.sheetName ?? null,
    vendorMasterAdded: applied.added,
    vendorMasterUpdated: applied.updated,
    vendorMasterUnchanged: applied.unchanged,
    vendorMasterSkipped: applied.skipped,
  };
}

/**
 * Reconcile the two sides and store the run and its rows, inside the upload's
 * transaction. `his` and `focus` are each an uploaded file or a kept one
 * (`isNew` says which); `at` is the upload's time. Returns the run's id, the
 * reco's summary and the rows stored.
 */
async function storeReco(client, req, his, focus, at) {
  const { results, summary } = reconcileMsme(his.rows, focus.rows);
  const { statuses } = summary;
  // Every status is counted on the run; only the vendor master's rows are
  // kept as rows -- see STORED_STATUSES.
  const stored = results.filter((r) => STORED_STATUSES.includes(r.status));

  const { rows } = await client.query(
    `INSERT INTO msme_reco_runs
       (vendor_file_name, vendor_sheet_name, account_file_name, vendor_row_count, account_row_count,
        matched_count, mismatch_count, not_in_accounts_count, not_in_his_count, uploaded_by,
        vendor_file_new, account_file_new, vendor_file_at, account_file_at, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      his.fileName,
      his.sheetName,
      focus.fileName,
      summary.vendorRowCount,
      summary.accountRowCount,
      statuses[STATUS.MATCHED],
      statuses[STATUS.MISMATCH],
      statuses[STATUS.NOT_IN_ACCOUNTS],
      statuses[STATUS.NOT_IN_HIS],
      req.user.id,
      his.isNew,
      focus.isNew,
      his.uploadedAt,
      focus.uploadedAt,
      at,
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

  return { id, summary, stored };
}

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
 * line over the table -- `latestRun` is null before the first reco -- how
 * many recos have been run in all, and the kept file of each side (`files.HIS`,
 * `files.FOCUS`, null while there is none): what a file uploaded alone will be
 * held against.
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
    const { rows: fileRows } = await query(FILE_SELECT);

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
      files: {
        [HIS]: mapFile(fileRows.find((f) => f.side === HIS)),
        [FOCUS]: mapFile(fileRows.find((f) => f.side === FOCUS)),
      },
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
