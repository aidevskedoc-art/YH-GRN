/**
 * OP Pharmacy's uploads -- the Pharmacy Uploads screen.
 *
 * routes/batches.js for the pharmacies' four files: the GRN Purchase report,
 * the Vendor Age report, the BPAD current bill status and the bank statement.
 * The same four slots under the same caps, read by the pharmacies' own readers
 * (services/phExcelParser.js) and stored in the pharmacies' own tables
 * (services/phIngest.js), so nothing uploaded here can reach a hospital row.
 *
 * Whatever does not touch a table is the hospital route's own, imported: the
 * multer instance and its caps, the size check, and how several files in one
 * slot are merged. What does -- which GRNs the BPAD status is read against,
 * and what each branch is called -- is written again here against the ph_
 * tables.
 *
 * Behind the same `upload` grant as the hospital screen. An account that may
 * upload sees both New uploads and Pharmacy Uploads in the sidebar, and the
 * API should not disagree with the menu about what it may do.
 */
import express from 'express';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler, tablesNotMigrated } from '../middleware/error.js';
import { readBankStatement } from '../services/excelParser.js';
import { readPhGrnReport, readPhAgeingReport, readPhBpadReport } from '../services/phExcelParser.js';
import { normKey } from '../services/normalize.js';
import { lastRowPerGrn } from '../services/ingest.js';
import { savePhBatch } from '../services/phIngest.js';
import { logActivity } from '../services/activityLog.js';
import {
  MAX_FILES_PER_SLOT,
  MAX_BPAD_FILES,
  upload,
  tooLargeMessage,
  refuseOversizedUpload,
  defaultBatchName,
  readEach,
  lastFilePerKey,
  fileNames,
  bpadLocationMismatch,
  bpadRowsForGrns,
} from './batches.js';

export const phBatchesRouter = express.Router();

phBatchesRouter.use(requireAuth);

/** GET /api/op-pharmacy/batches/limits - the caps, for checking files as they are picked. */
phBatchesRouter.get('/limits', requireScreen('upload'), (req, res) => {
  res.json({
    maxFileBytes: config.maxUploadBytes,
    maxTotalBytes: config.maxUploadTotalBytes,
    maxFilesPerSlot: MAX_FILES_PER_SLOT,
    maxBpadFiles: MAX_BPAD_FILES,
  });
});

/* ==========================================================================
   The branch, and what goes through it.

   The three reports each call a branch something different -- the purchase
   register "Secunderabad", the ageing report "PSE", the BPAD status "SBD1" --
   so no two of them can be held against each other directly. Ph-Configuration
   is where somebody has said the three names are one place, and a GRN is
   matched to the other two reports only through it:

     GRN Purchase report      Vendor Age report         BPAD current bill status
     FeedNo                   GRN number (in GRNDoc)    GRN No
     PM Code                                            Vendor Code
     Unit Name                DivisionCode              Location
       = Unit name (HIS)        = Branch code (Focus)     = Location (BPAD)
                              ...of one and the same branch

   This is stricter than the hospitals', where a row nobody has configured a
   branch for is matched on its numbers alone. Here a GRN whose Unit Name is
   not configured is matched to neither report: without the configuration there
   is nothing to say a row carrying the right GRN number is not another unit's.

   The ageing half of the rule is applied where the result is worked out, in
   SQL (SAME_BRANCH in services/phIngest.js); what is here is the BPAD half,
   and the checks that refuse an upload the configuration cannot place.

   The functions down to matchBpadFiles are exported so the rules can be run
   against real files without a request or a table -- none of them reads one.
   ========================================================================== */

/** One ph_branch_configs row, as the matching reads it: each name, folded. */
export function toBranch(row) {
  return {
    branchCode: row.branch_code,
    unitName: row.location,
    bpadLocation: row.bpad_location,
    branchKey: normKey(row.branch_code),
    unitKey: normKey(row.location),
    bpadLocationKey: normKey(row.bpad_location),
  };
}

/** "A", "A and B", "A, B and C". */
function listed(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How many of `what`, with the word in the singular for one. */
function counted(n, what) {
  return `${n.toLocaleString('en-IN')} ${what}${n === 1 ? '' : 's'}`;
}

/** A name as a message quotes it, or "(blank)". */
function quoted(name) {
  return name ? `"${name}"` : '(blank)';
}

/**
 * `rows` grouped by `nameOf`, as `[{ name, count }]`, largest first -- for
 * saying which names a check turned up, and how much of the file each is.
 */
function tally(rows, nameOf) {
  const counts = new Map();
  for (const row of rows) {
    const name = String(nameOf(row) ?? '').trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/* --------------------------------------------------------------------------
   The Vendor Age report: DivisionCode against Branch code (Focus).
   -------------------------------------------------------------------------- */

/**
 * The ageing rows whose DivisionCode is no configured branch's Branch code
 * (Focus), by code -- or `{ error }` when that is every row of the report.
 *
 * A row like that is matched to no GRN (SAME_BRANCH in services/phIngest.js),
 * so a report made of nothing else would be stored and leave every GRN it is
 * about reading as pending -- which says the bills have not reached accounts,
 * when what is wrong is a setting. That upload is refused, with the code the
 * report writes, so the message says what to enter.
 *
 * A report where only some rows are like that is stored whole: the other
 * divisions' rows do no harm on file, and are matched as soon as a branch is
 * configured for them (relinkPhResults). They are counted for the answer.
 */
export function checkAgeingDivisions(ageingRows, branches) {
  const configured = new Set(branches.map((b) => b.branchKey).filter(Boolean));
  const strays = ageingRows.filter((row) => !configured.has(normKey(row.divisionCode)));
  const divisions = tally(strays, (row) => row.divisionCode);

  if (ageingRows.length > 0 && strays.length === ageingRows.length) {
    const codes = divisions.slice(0, 5).map((d) => `${quoted(d.name)} (${counted(d.count, 'row')})`);
    const have = branches.map((b) => quoted(b.branchCode));
    return {
      error:
        `The Vendor Age report cannot be matched: its DivisionCode is ${listed(codes)}, and ` +
        `Ph-Configuration has no branch with ${divisions.length === 1 ? 'that' : 'any of those'} as its ` +
        `Branch code (Focus)${have.length > 0 ? ` -- the branches there are ${listed(have)}` : ''}. ` +
        `A Vendor Age row is matched to a GRN only when the row's DivisionCode and the GRN's Unit Name ` +
        `are one branch's Branch code (Focus) and Unit name (HIS). ` +
        'Add or correct the branch on the Ph-Configuration screen and upload again. ' +
        'Nothing from this upload was stored.',
    };
  }

  return { unconfigured: { rowCount: strays.length, divisions } };
}

/**
 * The GRNs of this upload whose Unit Name is no configured branch's Unit name
 * (HIS), by unit. They are stored like any other, and matched to no ageing row
 * until a branch is configured for the unit -- so the answer says how many.
 */
export function unconfiguredGrnUnits(grnRows, branches) {
  const configured = new Set(branches.map((b) => b.unitKey).filter(Boolean));
  const strays = grnRows.filter((row) => !configured.has(normKey(row.location)));
  return { grnCount: strays.length, units: tally(strays, (row) => row.location) };
}

/* --------------------------------------------------------------------------
   The BPAD status: Location against Location (BPAD).
   -------------------------------------------------------------------------- */

/** A parsed GRN Purchase row, as the BPAD match reads it. */
export function grnForBpad(row) {
  return {
    vendorCode: row.vendorCode,
    vendorName: row.vendorName,
    grnNo: row.dprNo,
    grnNoKey: row.dprNoKey,
    grnDate: row.dprDate,
    grnAmount: row.totalAmount,
    // The purchase register has no PO.
    poNumber: null,
    invNo: row.billNo,
    invDate: row.billDate,
    unitName: row.location,
  };
}

/**
 * The BPAD Locations a GRN's status rows may carry: the Location (BPAD) of
 * every configured branch whose Unit name (HIS) is the GRN's own Unit Name.
 *
 * The two unit names are compared through normKey, as every other key here is,
 * so "Secunderabad", "SECUNDERABAD" and "Secunderabad " are one unit -- but
 * they have to be the same name, not one inside the other. A unit is a short
 * name of its own, unlike the hospitals' GRN Location, which carries the
 * branch somewhere inside a company name and has to be searched for it.
 *
 * Null when no branch is configured for the unit, or none of them has a
 * Location (BPAD): such a GRN is not matched to the status -- see above.
 */
export function bpadLocationsForUnit(unitName, branches) {
  const unitKey = normKey(unitName);
  if (!unitKey) return null;
  const keys = branches
    .filter((b) => b.unitKey === unitKey && b.bpadLocationKey !== '')
    .map((b) => b.bpadLocationKey);
  return keys.length > 0 ? new Set(keys) : null;
}

/**
 * The GRNs the status is read against, keyed by `VENDORCODE|GRNNUMBER`, each
 * with `bpadLocationKeys` -- the Locations its status rows may carry, or null
 * where its unit is not configured.
 *
 * The vendor code is the purchase register's PM Code, which is the code the
 * status files a bill under: on the sample, every one of the status's 12,446
 * rows names a GRN in the register under exactly that code.
 *
 * First writer wins, so `grns` is handed over newest first where one GRN can
 * arrive more than once.
 */
export function indexGrnsForBpad(grns, branches) {
  const identities = new Map();
  for (const grn of grns) {
    if (!grn.vendorCode || !grn.grnNoKey) continue;
    const vendorCodeKey = normKey(grn.vendorCode);
    const key = `${vendorCodeKey}|${grn.grnNoKey}`;
    if (identities.has(key)) continue;
    identities.set(key, {
      ...grn,
      vendorCodeKey,
      bpadLocationKeys: bpadLocationsForUnit(grn.unitName, branches),
    });
  }
  return identities;
}

/**
 * The units among `identities` that Ph-Configuration does not have with a
 * Location (BPAD), largest first, and how many GRNs they come to.
 */
function unconfiguredUnits(identities) {
  const strays = [...identities.values()].filter((id) => !id.bpadLocationKeys);
  return { grnCount: strays.length, units: tally(strays, (id) => id.unitName) };
}

/**
 * Why the upload is refused when not one of its GRNs can be matched to the
 * status: every unit they name is missing from Ph-Configuration, or is there
 * without a Location (BPAD).
 *
 * Refused rather than stored with nothing matched. The status would otherwise
 * go in as a file that "matched 0 rows", which reads like a wrong file rather
 * than a missing setting -- and the message can say exactly what to enter: the
 * unit as the purchase register writes it, and the Locations the status holds.
 */
function notConfiguredMessage(unconfigured, fileLocations) {
  const units = unconfigured.units.slice(0, 5).map((u) => `${quoted(u.name)} (${counted(u.count, 'GRN')})`);
  const locations = [...fileLocations]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, n]) => `${key || '(blank)'} (${counted(n, 'row')})`);
  return (
    `The BPAD bill status cannot be matched: Ph-Configuration has no branch with a Location (BPAD) ` +
    `for Unit Name ${listed(units)}. A BPAD row is matched to a GRN only when the GRN's Unit Name and ` +
    `the row's Location are one branch's Unit name (HIS) and Location (BPAD). ` +
    `The BPAD file's Location column has ${listed(locations)}. ` +
    'Add the branch, or fill in its Location (BPAD), on the Ph-Configuration screen and upload again. ' +
    'Nothing from this upload was stored.'
  );
}

/**
 * Read the status files against `identities` and settle what is stored.
 *
 * A row is kept when its Vendor Code and GRN No are a GRN's and its Location
 * is one that GRN's unit is configured with. The rest are read past, and
 * counted by why:
 *
 *  - `otherBranchCount`: the GRN's unit is configured, and the row's Location
 *    is not one of its own -- another unit's bill under the same number;
 *  - `unconfigured.rowCount`: the GRN's unit is not configured, so the row was
 *    not considered.
 *
 * Every GRN whose unit IS configured gets a row -- the status's own, or one
 * saying the status has no entry for it (see bpadRowsForGrns in
 * routes/batches.js). A GRN whose unit is not configured gets neither: the
 * upload says nothing about it, and whatever is stored for it stays.
 *
 * Returns `{ error }` when the upload has to be refused: a Location (BPAD)
 * that looks mistyped (bpadLocationMismatch), or no GRN that can be matched at
 * all (notConfiguredMessage). With no GRNs to read against there is nothing to
 * refuse -- the status is stored as a file that matched nothing, as before.
 */
export function matchBpadFiles(files, identities, branches) {
  // Every Location the files write, folded, and how many rows carry it.
  const fileLocations = new Map();
  const turnedAway = new Map();
  let otherBranchCount = 0;
  let unconfiguredRowCount = 0;

  const keep = (vendorCodeKey, grnNoKey, locationKey) => {
    fileLocations.set(locationKey, (fileLocations.get(locationKey) ?? 0) + 1);
    const id = identities.get(`${vendorCodeKey}|${grnNoKey}`);
    if (!id) return false;
    if (!id.bpadLocationKeys) {
      unconfiguredRowCount += 1;
      return false;
    }
    if (!id.bpadLocationKeys.has(locationKey)) {
      otherBranchCount += 1;
      for (const required of id.bpadLocationKeys) {
        const seen = turnedAway.get(required) ?? new Map();
        seen.set(locationKey, (seen.get(locationKey) ?? 0) + 1);
        turnedAway.set(required, seen);
      }
      return false;
    }
    return true;
  };

  const bpads = readEach(files, 'BPAD current bill status', (buffer) => readPhBpadReport(buffer, { keep }));

  // `false`: clearing a Location (BPAD) is no way out here -- the unit would
  // then not be matched at all.
  const mismatch = bpadLocationMismatch(
    turnedAway,
    new Set(fileLocations.keys()),
    branches,
    'Ph-Configuration',
    false,
  );
  if (mismatch) return { error: mismatch };

  const eligible = new Map([...identities].filter(([, id]) => id.bpadLocationKeys));
  const unconfigured = unconfiguredUnits(identities);
  if (identities.size > 0 && eligible.size === 0) {
    return { error: notConfiguredMessage(unconfigured, fileLocations) };
  }

  const registerRows = lastFilePerKey(
    bpads.map((b) => b.rows),
    (r) => (r.vendorCodeKey && r.grnNoKey ? `${r.vendorCodeKey}|${r.grnNoKey}` : null),
  );

  return {
    bpads,
    rows: bpadRowsForGrns(registerRows, eligible),
    otherBranchCount,
    unconfigured: { ...unconfigured, rowCount: unconfiguredRowCount },
  };
}

/**
 * The GRNs the status is read against: with a GRN Purchase report in the same
 * upload, that report's own rows and nothing else; without one, every pharmacy
 * GRN on file, newest upload first.
 */
async function grnMatchKeys(grnRows, branches) {
  if (grnRows.length > 0) return indexGrnsForBpad(grnRows.map(grnForBpad), branches);

  const { rows } = await query(
    `SELECT DISTINCT ON (vendor_code, dpr_no_key)
            vendor_code, vendor_name, dpr_no, dpr_no_key, dpr_date,
            total_amount, po_no, bill_no, bill_date, location
     FROM ph_grn_transactions
     WHERE vendor_code IS NOT NULL AND vendor_code <> ''
     ORDER BY vendor_code, dpr_no_key, batch_id DESC, id DESC`,
  );
  return indexGrnsForBpad(
    rows.map((row) => ({
      vendorCode: row.vendor_code,
      vendorName: row.vendor_name,
      grnNo: row.dpr_no,
      grnNoKey: row.dpr_no_key,
      grnDate: row.dpr_date,
      grnAmount: row.total_amount,
      poNumber: row.po_no,
      invNo: row.bill_no,
      invDate: row.bill_date,
      unitName: row.location,
    })),
    branches,
  );
}

/**
 * Every configured pharmacy branch, as the matching reads it. Every branch,
 * ticked or not -- the tick scopes what is shown, not what a branch is called.
 */
async function configuredBranches() {
  const { rows } = await query('SELECT branch_code, location, bpad_location FROM ph_branch_configs');
  return rows.map(toBranch);
}

/**
 * POST /api/op-pharmacy/batches - upload one or more of the four pharmacy
 * files, store them, and reconcile what they touched.
 *
 * As POST /api/batches: each slot takes several files, the GRN reports, ageing
 * reports and BPAD statuses are each merged into one set of rows and stored as
 * one batch, and every bank statement after the first is a batch of its own.
 * Every file is read before anything is stored.
 */
phBatchesRouter.post(
  '/',
  requireScreen('upload'),
  refuseOversizedUpload,
  upload.fields([
    { name: 'grnFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'ageingFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'bankFile', maxCount: MAX_FILES_PER_SLOT },
    { name: 'bpadFile', maxCount: MAX_BPAD_FILES },
  ]),
  asyncHandler(async (req, res) => {
    const grnFiles = req.files?.grnFile ?? [];
    const ageingFiles = req.files?.ageingFile ?? [];
    const bankFiles = req.files?.bankFile ?? [];
    const bpadFiles = req.files?.bpadFile ?? [];
    const allFiles = [...grnFiles, ...ageingFiles, ...bankFiles, ...bpadFiles];

    if (allFiles.length === 0) {
      return res.status(400).json({
        error:
          'Choose at least one file: the GRN Purchase report, the Vendor Age report, the bank statement, or the BPAD current bill status.',
      });
    }

    // The backstop for a request that declared no length -- see
    // refuseOversizedUpload.
    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > config.maxUploadTotalBytes) {
      return res.status(413).json({ error: tooLargeMessage(totalBytes) });
    }

    const name = String(req.body.name || '').trim() || defaultBatchName(allFiles);

    const grns = readEach(grnFiles, 'GRN Purchase report', readPhGrnReport);
    const ageings = readEach(ageingFiles, 'Vendor Age report', readPhAgeingReport);
    const banks = readEach(bankFiles, 'Bank statement', readBankStatement);

    // One row per GRN number, as the upload will store them.
    const grnRows = lastRowPerGrn(grns.flatMap((g) => g.rows));
    const ageingRows = lastFilePerKey(
      ageings.map((a) => a.rows),
      (r) => r.grnNumberKey,
    );

    // What Ph-Configuration holds, which is what ties the three reports to one
    // another -- see "The branch, and what goes through it" above.
    const branches = await configuredBranches();

    // The ageing report's DivisionCode has to be a configured branch's. A
    // report where none is can match nothing, and is refused before anything
    // is stored; where some are not, those rows are counted for the answer.
    const divisions = checkAgeingDivisions(ageingRows, branches);
    if (divisions.error) return res.status(400).json({ error: divisions.error });
    const ageingUnconfigured = divisions.unconfigured;

    // This upload's GRNs whose Unit Name no branch is configured for: stored,
    // and left pending until one is.
    const grnUnconfigured = unconfiguredGrnUnits(grnRows, branches);

    // Read last, and narrowed as it is read -- against this upload's own GRN
    // reports where there are any, and against every pharmacy GRN on file
    // where there are not. See matchBpadFiles for what makes a row a GRN's.
    let bpads = [];
    let bpadRows = [];
    // Status rows that named one of these GRNs under another unit's Location.
    let bpadOtherBranchCount = 0;
    // GRNs whose Unit Name Ph-Configuration has no Location (BPAD) for, and
    // the status rows about them that were therefore not considered.
    let bpadUnconfigured = { grnCount: 0, rowCount: 0, units: [] };
    if (bpadFiles.length > 0) {
      const identities = await grnMatchKeys(grnRows, branches);
      const matched = matchBpadFiles(bpadFiles, identities, branches);
      if (matched.error) return res.status(400).json({ error: matched.error });
      bpads = matched.bpads;
      bpadRows = matched.rows;
      bpadOtherBranchCount = matched.otherBranchCount;
      bpadUnconfigured = matched.unconfigured;
    }

    const [firstBank, ...laterBanks] = banks;
    const main = await savePhBatch({
      name,
      grnFileName: fileNames(grnFiles),
      ageingFileName: fileNames(ageingFiles),
      userId: req.user.id,
      grnRows,
      ageingRows,
      bankFileName: bankFiles[0]?.originalname ?? null,
      bankRows: firstBank?.rows ?? [],
      bankAccountNo: firstBank?.accountNo ?? null,
      bpadFileName: fileNames(bpadFiles),
      bpadRows,
      bpadScanned: bpads.reduce((sum, b) => sum + b.scanned, 0),
    });

    // Every further statement in a batch of its own, since a batch holds one
    // account.
    const batchIds = [main.batchId];
    let replacedBankRows = main.replaced.bankRows;
    for (const [i, bank] of laterBanks.entries()) {
      const file = bankFiles[i + 1];
      const extra = await savePhBatch({
        name: defaultBatchName([file]),
        userId: req.user.id,
        bankFileName: file.originalname,
        bankRows: bank.rows,
        bankAccountNo: bank.accountNo ?? null,
      });
      batchIds.push(extra.batchId);
      replacedBankRows += extra.replaced.bankRows;
    }

    const { batchId, linked } = main;
    const replaced = { ...main.replaced, bankRows: replacedBankRows };
    const bankRowCount = banks.reduce((sum, b) => sum + b.rows.length, 0);
    const bpadMatchedCount = bpads.reduce((sum, b) => sum + b.rows.length, 0);

    const files = allFiles.map((f) => f.originalname);
    logActivity(req, {
      action: 'PH_UPLOAD',
      target: name,
      summary: `Uploaded ${files.length} pharmacy file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`,
      details: {
        batchId,
        batchIds,
        grnFile: fileNames(grnFiles),
        grnRows: grnRows.length,
        ageingFile: fileNames(ageingFiles),
        ageingRows: ageingRows.length,
        bankFile: fileNames(bankFiles),
        bankRows: bankRowCount,
        bpadFile: fileNames(bpadFiles),
        bpadStoredRows: bpadRows.length,
        bpadOtherBranchRows: bpadOtherBranchCount,
        bpadUnconfiguredGrns: bpadUnconfigured.grnCount,
        bpadUnconfiguredRows: bpadUnconfigured.rowCount,
        bpadUnconfiguredUnits: bpadUnconfigured.units.map((u) => u.name),
        ageingUnconfiguredRows: ageingUnconfigured.rowCount,
        ageingUnconfiguredDivisions: ageingUnconfigured.divisions.map((d) => d.name),
        grnUnconfiguredGrns: grnUnconfigured.grnCount,
        grnUnconfiguredUnits: grnUnconfigured.units.map((u) => u.name),
        linked,
        replaced,
      },
    });

    return res.status(201).json({
      batchId,
      batchIds,
      name,
      grnRowCount: grnRows.length,
      ageingRowCount: ageingRows.length,
      // How the GRNs this upload touched came out, counted from the results as
      // stored: in accounts, in accounts under a different bill number, or
      // pending. Either report can touch a GRN -- see storePhBatch.
      linked,
      bankRowCount,
      bankAccountNo: firstBank?.accountNo ?? null,
      // How big the statuses were, how much of them was about these GRNs, and
      // how many rows were stored -- the matched ones plus one per GRN the
      // status had no entry for.
      bpadRowCount: bpads.reduce((sum, b) => sum + b.scanned, 0),
      bpadMatchedCount,
      bpadStoredCount: bpadRows.length,
      // Status rows that named one of these GRNs under a Location that is not
      // its unit's.
      bpadOtherBranchCount,
      // GRNs the status could not be matched for, because Ph-Configuration has
      // no Location (BPAD) for their Unit Name -- how many, which units, and
      // how many status rows about them were passed over. Nothing was stored
      // or replaced for these GRNs.
      bpadUnconfiguredGrnCount: bpadUnconfigured.grnCount,
      bpadUnconfiguredRowCount: bpadUnconfigured.rowCount,
      bpadUnconfiguredUnits: bpadUnconfigured.units.map((u) => u.name),
      // Vendor Age rows whose DivisionCode is no configured branch's Branch
      // code (Focus), and which codes: stored, and matched to no GRN until a
      // branch is configured for them.
      ageingUnconfiguredRowCount: ageingUnconfigured.rowCount,
      ageingUnconfiguredDivisions: ageingUnconfigured.divisions.map((d) => d.name),
      // This upload's GRNs whose Unit Name is no configured branch's Unit name
      // (HIS), and which units: stored, and pending until one is.
      grnUnconfiguredCount: grnUnconfigured.grnCount,
      grnUnconfiguredUnits: grnUnconfigured.units.map((u) => u.name),
      replaced,
    });
  }),
);

// The ph_ tables are added by a migration. Until it has been run, say so.
phBatchesRouter.use(tablesNotMigrated('The OP Pharmacy tables'));
