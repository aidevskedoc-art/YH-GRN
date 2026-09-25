/**
 * The Vendor Master: every vendor the HIS vendor master has ever listed, once
 * each, with its latest details.
 *
 * The HIS vendor master is the correct data -- the HIS vs FOCUS Reco says what
 * FOCUS (Accounts) needs changing to match it. It has no upload of its own:
 * each reco run applies the vendor master file it was given (the POST in
 * routes/msmeReco.js). A vendor code the master already has is updated with
 * the file's values; a new one is added. Nothing is ever removed, and a reco
 * run cannot be deleted, so uploading the same file again only updates what
 * changed.
 *
 * Read by routes/vendorMaster.js. The tables are vendor_master,
 * vendor_master_columns and vendor_master_applies in schema.sql.
 */
import { withTransaction } from '../db/pool.js';
import { cleanValue, codeKey } from './msmeReco.js';

/** Rows per INSERT, well under Postgres' 65535 parameter cap. */
const CHUNK_SIZE = 500;

/**
 * The vendor master columns the reco keeps in msme_reco_rows, under the file's
 * own names -- all a run applied late can give the master, since its file was
 * not kept.
 */
const RECO_COLUMNS = [
  ['VENDOR_CODE', 'vendor_code'],
  ['WAREHOUSE', 'warehouse'],
  ['STATUS', 'his_status'],
  ['VENDOR_NAME', 'his_name'],
  ['PAN_NO', 'his_pan'],
  ['GST_NUMBER', 'his_gst'],
  ['DRUG_LICENCE_NO', 'his_drug_licence'],
  ['MSME_NUMBER', 'his_msme_no'],
  ['ENTERPRISE_TYPE', 'his_msme_type'],
  ['ENTERPRISE_ACTIVITY', 'his_msme_activity'],
  ['BANK_ACCOUNT_NO', 'his_bank_account_no'],
  ['IFSC', 'his_ifsc'],
  ['PAYEE_NAME', 'his_payee_name'],
];

/** A stored or incoming value, with a blank and a missing column read alike. */
const valueOf = (value) => (value === undefined || value === '' ? null : value);

/** The vendor master's MSME number column, as the reco reads it. */
const MSME_COLUMN = 'MSME_NUMBER';

/**
 * A vendor's MSME number out of its details, or null when it has none --
 * vendor_master.msme_no, which the GRN screens' MSME No and MSME Status read
 * (services/vendorMsme.js).
 *
 * The column is found the way the reco's reader finds it (tightToken in
 * excelParser.js) -- upper-cased, spaces removed -- so "msme_number" in some
 * later export is still the same column, and a column the reco would not read
 * is not read here either.
 * The value is cleaned the way the reco cleans it (cleanValue), so "NA", "-" or
 * "Not Applicable" is no number rather than an MSME registration.
 */
export function msmeNumberOf(data) {
  if (!data) return null;
  const name = MSME_COLUMN in data
    ? MSME_COLUMN
    : Object.keys(data).find((key) => key.toUpperCase().replace(/\s+/g, '') === MSME_COLUMN);
  return (name && cleanValue(data[name])) || null;
}

/**
 * One apply at a time, for the rest of the caller's transaction: two recos
 * landing together cannot interleave their column orders, count each other's
 * new vendors as their own, or pick up the same unapplied run twice. Readers
 * are not blocked. Taking it again in the same transaction is a no-op.
 */
async function lockMaster(client) {
  await client.query(
    'LOCK TABLE vendor_master, vendor_master_columns, vendor_master_applies IN SHARE ROW EXCLUSIVE MODE',
  );
}

/**
 * Apply one reco run's vendor master file to the master, inside the caller's
 * transaction.
 *
 * `run` is `{ id, uploadedAt, fileName, uploadedBy }` -- the run's own row.
 * `master` is `{ sheetName, headers, rows: [{ vendorCode, cells }] }`, as
 * readVendorMaster returns it. `full` is false when the rows were rebuilt from
 * the reco's stored columns rather than read from the file. `at` is the time
 * the master records for this file: a late run passes its own uploaded_at;
 * a new one leaves it out, and the clock is read once the lock is held, so
 * files are timed in the order they are applied.
 *
 * For each vendor code in the file (a code listed twice: its last row):
 *  - not in the master: added.
 *  - in the master: its details are merged with the file's -- every column the
 *    file has takes the file's value, a blank included; a column the file
 *    lacks keeps its last value. It counts as updated when that changed
 *    anything, unchanged otherwise, and `updated_at` moves only when it did.
 *  - last carried by a newer file: skipped, so a run applied late cannot undo
 *    a newer one.
 *
 * The file's column order becomes the master's only when it is the newest
 * file the master has seen. Returns `{ added, updated, unchanged, skipped }`,
 * which are also recorded in vendor_master_applies.
 */
export async function applyVendorMaster(client, run, master, { full = true, at } = {}) {
  await lockMaster(client);

  const seenAt = at ? new Date(at) : (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;

  const latest = new Map();
  for (const row of master.rows) {
    const key = codeKey(row.vendorCode);
    if (!key) continue;
    // Deleted first so a repeat takes the place of its last row, not its first.
    latest.delete(key);
    latest.set(key, row);
  }

  const { rows: newestRows } = await client.query('SELECT max(last_seen_at) AS newest FROM vendor_master');
  const newest = newestRows[0].newest;
  const isNewest = !newest || newest <= seenAt;

  const { rows: stored } = await client.query(
    'SELECT code_key, vendor_code, data, updated_at, last_seen_at FROM vendor_master WHERE code_key = ANY($1)',
    [[...latest.keys()]],
  );
  const known = new Map(stored.map((r) => [r.code_key, r]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const writes = [];

  for (const [key, row] of latest) {
    const data = Object.fromEntries(master.headers.map((header, i) => [header, valueOf(row.cells[i])]));
    const before = known.get(key);
    // Off the details as they will stand after the merge below -- the file's
    // columns over what was there -- so a file without the column keeps the
    // number an earlier one gave.
    const msmeNo = msmeNumberOf({ ...(before?.data ?? {}), ...data });

    if (!before) {
      added += 1;
      writes.push({ key, row, data, msmeNo, updatedAt: seenAt });
      continue;
    }
    if (before.last_seen_at > seenAt) {
      skipped += 1;
      continue;
    }

    const changed =
      before.vendor_code !== row.vendorCode ||
      master.headers.some((header) => valueOf(before.data[header]) !== data[header]);
    if (changed) updated += 1;
    else unchanged += 1;
    writes.push({ key, row, data, msmeNo, updatedAt: changed ? seenAt : before.updated_at });
  }

  for (let start = 0; start < writes.length; start += CHUNK_SIZE) {
    const params = [run.id, seenAt];
    const tuples = writes.slice(start, start + CHUNK_SIZE).map((w) => {
      params.push(w.key, w.row.vendorCode, JSON.stringify(w.data), w.updatedAt, w.msmeNo);
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}::jsonb, $1, $2, $${n - 1}, $2, $${n})`;
    });
    // The WHERE repeats the newer-file check above, so the rule holds even if
    // the two ever drift apart.
    await client.query(
      `INSERT INTO vendor_master
         (code_key, vendor_code, data, last_run_id, created_at, updated_at, last_seen_at, msme_no)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (code_key) DO UPDATE
          SET vendor_code = EXCLUDED.vendor_code,
              data = vendor_master.data || EXCLUDED.data,
              last_run_id = EXCLUDED.last_run_id,
              updated_at = EXCLUDED.updated_at,
              last_seen_at = EXCLUDED.last_seen_at,
              msme_no = EXCLUDED.msme_no
        WHERE vendor_master.last_seen_at <= EXCLUDED.last_seen_at`,
      params,
    );
  }

  // The column order. The newest file read whole sets it: its own columns, in
  // its own order, then any only an earlier file had. Anything else -- columns
  // rebuilt from the reco, or a file applied after a newer one -- only adds
  // what is missing, at the end.
  const { rows: columns } = await client.query('SELECT name FROM vendor_master_columns ORDER BY position, name');
  const existing = columns.map((c) => c.name);
  const order =
    full && isNewest
      ? [...master.headers, ...existing.filter((name) => !master.headers.includes(name))]
      : [...existing, ...master.headers.filter((name) => !existing.includes(name))];
  await client.query(
    `INSERT INTO vendor_master_columns (name, position)
     SELECT name, ord FROM unnest($1::text[]) WITH ORDINALITY AS c(name, ord)
     ON CONFLICT (name) DO UPDATE SET position = EXCLUDED.position`,
    [order],
  );

  await client.query(
    `INSERT INTO vendor_master_applies
       (run_id, file_name, sheet_name, run_uploaded_at, uploaded_by, applied_at,
        added, updated, unchanged, skipped, full_file)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      run.id,
      run.fileName ?? null,
      master.sheetName ?? null,
      run.uploadedAt,
      run.uploadedBy ?? null,
      seenAt,
      added,
      updated,
      unchanged,
      skipped,
      full,
    ],
  );

  return { added, updated, unchanged, skipped };
}

/**
 * Whether the per-run copy a previous version of this screen kept is still
 * there: its table (vendor_master_rows) and its headers column on the run.
 */
async function perRunCopy(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('vendor_master_rows') IS NOT NULL AS has_table,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'msme_reco_runs'
                       AND column_name = 'vendor_master_headers') AS has_headers`,
  );
  return { table: rows[0].has_table, headers: rows[0].has_headers };
}

/**
 * Apply every reco run not yet applied, oldest first, inside the caller's
 * transaction; returns how many.
 *
 * Such a run was stored before the master existed, or by a server still
 * running older code after the migration. Its file was not kept, so it is
 * rebuilt from the columns the reco stored (RECO_COLUMNS) -- unless a previous
 * version of this screen kept a per-run copy of it (vendor_master_rows, with
 * its headers on the run), which may hold the whole file and is used instead.
 * Each is applied at its own uploaded_at, so it cannot undo a newer file.
 *
 * `exceptRunId` leaves out a run the caller has just inserted and is about to
 * apply itself -- in the caller's transaction it is visible, and unapplied.
 */
export async function applyPendingRuns(client, { exceptRunId = null } = {}) {
  await lockMaster(client);

  const copy = await perRunCopy(client);
  const useCopy = copy.table && copy.headers;

  const { rows: runs } = await client.query(
    `SELECT r.id, r.uploaded_at, r.uploaded_by, r.vendor_file_name, r.vendor_sheet_name
            ${useCopy ? ', r.vendor_master_headers, r.vendor_master_complete' : ''}
       FROM msme_reco_runs r
      WHERE NOT EXISTS (SELECT 1 FROM vendor_master_applies a WHERE a.run_id = r.id)
        AND r.id IS DISTINCT FROM $1
      ORDER BY r.uploaded_at, r.id`,
    [exceptRunId],
  );

  for (const run of runs) {
    let master = null;
    let full = false;

    if (useCopy && run.vendor_master_headers) {
      const { rows } = await client.query(
        'SELECT vendor_code, cells FROM vendor_master_rows WHERE run_id = $1 ORDER BY seq',
        [run.id],
      );
      if (rows.length > 0) {
        master = {
          sheetName: run.vendor_sheet_name,
          headers: run.vendor_master_headers,
          rows: rows.map((r) => ({ vendorCode: r.vendor_code, cells: r.cells })),
        };
        full = run.vendor_master_complete;
      }
    }

    if (!master) {
      const { rows } = await client.query(
        `SELECT ${RECO_COLUMNS.map(([, column]) => column).join(', ')}
           FROM msme_reco_rows
          WHERE run_id = $1 AND status <> 'NOT_IN_HIS'
          ORDER BY seq`,
        [run.id],
      );
      master = {
        sheetName: run.vendor_sheet_name,
        headers: RECO_COLUMNS.map(([header]) => header),
        rows: rows.map((r) => ({ vendorCode: r.vendor_code, cells: RECO_COLUMNS.map(([, column]) => r[column]) })),
      };
    }

    await applyVendorMaster(
      client,
      { id: run.id, uploadedAt: run.uploaded_at, fileName: run.vendor_file_name, uploadedBy: run.uploaded_by },
      master,
      { full, at: run.uploaded_at },
    );
  }

  return runs.length;
}

/**
 * Apply every run not yet applied, in a transaction of its own. Called at
 * server start, so a reco stored by a server still running older code is not
 * left out until the next one. Returns how many runs were applied.
 */
export function applyPendingVendorMasters() {
  return withTransaction(async (client) => {
    // The tables a migration takes before the master's, taken first here too
    // -- in the weakest mode, only to wait behind a migration already running
    // -- so a server started mid-migration cannot deadlock with it.
    await client.query('LOCK TABLE users, msme_reco_runs, msme_reco_rows IN ACCESS SHARE MODE');
    return applyPendingRuns(client);
  });
}

/**
 * msme_no brought in line with each vendor's details, inside the caller's
 * transaction -- for vendors stored before the column existed, or by a server
 * that did not yet write it. Returns how many were changed.
 */
async function syncMsmeNumbers(client) {
  const { rows } = await client.query('SELECT id, data, msme_no FROM vendor_master');
  const stale = rows
    .map((r) => ({ id: r.id, before: r.msme_no ?? null, msmeNo: msmeNumberOf(r.data) }))
    .filter((r) => r.msmeNo !== r.before);
  if (stale.length > 0) {
    await client.query(
      `UPDATE vendor_master v
          SET msme_no = u.msme_no
         FROM unnest($1::int[], $2::text[]) AS u(id, msme_no)
        WHERE v.id = u.id`,
      [stale.map((r) => r.id), stale.map((r) => r.msmeNo)],
    );
  }
  return stale.length;
}

/**
 * The migration's step, after schema.sql: apply every run not yet applied --
 * on the first migration, every reco stored before the master existed -- fill
 * in each vendor's MSME number (syncMsmeNumbers), then drop the per-run copy a
 * previous version of this screen kept (vendor_master_rows, and its two
 * columns on msme_reco_runs), which the master replaces. A second migration
 * does nothing.
 *
 * Returns how many runs were applied and how many MSME numbers were filled in.
 */
export async function backfillVendorMaster() {
  return withTransaction(async (client) => {
    const applied = await applyPendingRuns(client);
    const msmeNumbers = await syncMsmeNumbers(client);

    // Only when there is something to drop: an ALTER locks msme_reco_runs
    // whether or not it finds the columns.
    const copy = await perRunCopy(client);
    if (copy.table) await client.query('DROP TABLE vendor_master_rows');
    if (copy.headers) {
      await client.query(
        `ALTER TABLE msme_reco_runs
           DROP COLUMN IF EXISTS vendor_master_headers,
           DROP COLUMN IF EXISTS vendor_master_complete`,
      );
    }

    return { applied, msmeNumbers };
  });
}
