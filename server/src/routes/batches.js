import express from 'express';
import multer from 'multer';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { requireAuth, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import {
  readGrnReport,
  readAgeingReport,
  readBankStatement,
  readBpadReport,
  ExcelFormatError,
} from '../services/excelParser.js';
import { normKey } from '../services/normalize.js';
import { reconcile } from '../services/reconcile.js';
import { saveBatch, lastRowPerGrn } from '../services/ingest.js';
import { logActivity } from '../services/activityLog.js';

export const batchesRouter = express.Router();

/* The caps, the multer instance and the helpers marked `export` below are
   shared with OP Pharmacy's upload (routes/phBatches.js), which takes the same
   four slots under the same limits and settles two files naming one GRN the
   same way. Only what reads or writes a table is not shared: that is the
   pharmacies' own, against their own tables. */

// Per slot. Several months' reports, or several banks' statements, can go up
// in one upload -- a year's worth is the most anyone has reason to pick at once.
export const MAX_FILES_PER_SLOT = 12;
// Except the BPAD register: it is the whole group's, near 50 MB and half a
// minute to read, and there is seldom more than one to send.
export const MAX_BPAD_FILES = 3;

export const upload = multer({
  storage: multer.memoryStorage(),
  // Four slots: the two reports the reconciliation runs on, plus the optional
  // bank statement and the optional BPAD register. Kept as a hard cap rather
  // than left open, so a malformed form cannot stream an unbounded number of
  // workbooks into memory. The size of the whole upload is capped separately
  // -- see refuseOversizedUpload.
  limits: { fileSize: config.maxUploadBytes, files: MAX_FILES_PER_SLOT * 3 + MAX_BPAD_FILES },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    return cb(new ExcelFormatError(`"${file.originalname}" is not an Excel file. Upload .xls or .xlsx.`));
  },
});

batchesRouter.use(requireAuth);

/** 1 MB rather than 1048576 -- the wording the upload errors are read in. */
function megabytes(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function tooLargeMessage(bytes) {
  return (
    `These files come to ${megabytes(bytes)}, and one upload can carry at most ` +
    `${megabytes(config.maxUploadTotalBytes)}. Upload them in more than one go.`
  );
}

/**
 * Refuse an upload too large in total before any of it is read.
 *
 * Multer caps each file but not their sum, and holds every file in memory, so
 * the check has to come first: by the time multer hands the files over the
 * memory is already spent. Content-Length is what a browser declares for a
 * form it sends -- the multipart framing makes it a few hundred bytes larger
 * than the files, which does not matter at this scale. A request that declares
 * no length is caught by the backstop in the handler instead.
 */
export function refuseOversizedUpload(req, res, next) {
  const declared = Number(req.headers['content-length']);
  if (declared > config.maxUploadTotalBytes) {
    return res.status(413).json({ error: tooLargeMessage(declared) });
  }
  return next();
}

/**
 * GET /api/batches/limits - what the upload screen checks files against as
 * they are picked, so a file the server would refuse is refused before it is
 * sent. Served rather than copied into the client, since MAX_UPLOAD_MB and
 * MAX_UPLOAD_TOTAL_MB are set per installation.
 */
batchesRouter.get('/limits', requireScreen('upload'), (req, res) => {
  res.json({
    maxFileBytes: config.maxUploadBytes,
    maxTotalBytes: config.maxUploadTotalBytes,
    maxFilesPerSlot: MAX_FILES_PER_SLOT,
    maxBpadFiles: MAX_BPAD_FILES,
  });
});

/**
 * What to call an upload now that nobody is asked to name one.
 *
 * The column is still NOT NULL and the name is still what an upload is listed
 * under, so it is derived rather than dropped: the report that arrived, with
 * the date it arrived on, which is what a name typed by hand said anyway. The
 * results screen reports on every upload at once and never shows it -- this
 * only keeps the row readable to anyone reading the table directly.
 */
export function defaultBatchName(files) {
  const first = files.find(Boolean);
  const stamp = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return first ? `${first.originalname} — ${stamp}` : `Upload — ${stamp}`;
}

/**
 * Parse every file in one slot, naming the file in any error it raises.
 *
 * With one file in the slot the label alone says which it was, as it always
 * has; with several the label no longer does, so the file's own name is added.
 */
export function readEach(files, label, read) {
  return files.map((file) => {
    try {
      return read(file.buffer);
    } catch (err) {
      if (err instanceof ExcelFormatError) {
        const which = files.length > 1 ? `${label} "${file.originalname}"` : label;
        err.message = `${which}: ${err.message}`;
      }
      throw err;
    }
  });
}

/**
 * Several files' rows as one, keeping each key's rows from the last file that
 * carries it.
 *
 * For the reports that are a snapshot of where each GRN had got to -- the
 * ageing report (a GRN's rows there are its whole payment picture) and the
 * BPAD register (a re-export is a newer answer about the same bills). saveBatch
 * replaces a GRN's stored rows whole with the ones an upload brings, so two
 * such files uploaded one after the other leave the second one's rows. Putting
 * them in one upload has to leave the same thing; simply concatenating them
 * would store both snapshots side by side.
 *
 * "Last" is the order the files were sent in, which is the order they were
 * picked. Rows with no key are never matched and never replaced, so all of
 * them are kept.
 */
export function lastFilePerKey(rowsPerFile, keyOf) {
  const owner = new Map();
  rowsPerFile.forEach((rows, i) => {
    for (const row of rows) {
      const key = keyOf(row);
      if (key) owner.set(key, i);
    }
  });
  return rowsPerFile.flatMap((rows, i) =>
    rows.filter((row) => {
      const key = keyOf(row);
      return !key || owner.get(key) === i;
    }),
  );
}

/** Several files' names as the one column upload_batches keeps for the slot. */
export function fileNames(files) {
  return files.length > 0 ? files.map((f) => f.originalname).join(', ') : null;
}

/**
 * The GRNs the BPAD register is read against, keyed by `VENDORCODE|GRNNUMBER`.
 *
 * Both halves are required to match, and both go through normKey -- the same
 * fold the reconciliation matches with -- so the register's spelling of a
 * vendor code or a GRN number cannot miss the GRN report's over a separator.
 *
 * WHICH GRNs, and why it depends on what else was uploaded:
 *
 *  - With a GRN report in the same upload, that report's own rows and nothing
 *    else. A batch is the month its GRN report covers, and its BPAD tab should
 *    hold the register's answer for exactly those GRNs -- upload April's
 *    report with the register and you get April's GRNs back, not April's plus
 *    every other month already in the database.
 *  - Without one, every GRN on file. There is no report in this batch to take
 *    the question from, and the register is still worth matching -- it is
 *    exported on its own schedule and is perfectly ordinary to upload alone.
 *
 * A map rather than a set of keys, because the GRNs the register turns out to
 * have no entry for are stored too (see bpadRowsForGrns), and those rows are
 * built from what the GRN report knows about them.
 *
 * AND THE BRANCH, where one is configured with a BPAD location. The register
 * is the whole group's, and branches number some GRN series independently --
 * Malakpet has a GFEVT0000013 raised against the same vendor as Secunderabad's
 * -- so vendor code and GRN number alone can let another branch's bill in
 * beside this one's. Each GRN therefore also carries `bpadLocationKeys`: the
 * register Locations its branch is known by, which the register row's own
 * Location has to be one of. See bpadLocationsFor for how the branch is found,
 * and when it is null (no check, the match as it was before).
 *
 * The GRN rows are passed in rather than read back out of the table because at
 * this point they have only been parsed; saveBatch inserts them afterwards.
 */
async function grnMatchKeys(grnRows, branches) {
  const identities = new Map();

  const add = (id) => {
    if (!id.vendorCode || !id.grnNoKey) return;
    const key = `${normKey(id.vendorCode)}|${id.grnNoKey}`;
    // First writer wins. The same GRN can appear in more than one upload, and
    // findLatest-style ordering below hands them over newest first.
    if (!identities.has(key)) {
      identities.set(key, {
        ...id,
        vendorCodeKey: normKey(id.vendorCode),
        bpadLocationKeys: bpadLocationsFor(id.grnLocation, branches),
      });
    }
  };

  if (grnRows.length > 0) {
    for (const row of grnRows) {
      add({
        vendorCode: row.vendorCode,
        vendorName: row.vendorName,
        grnNo: row.dprNo,
        grnNoKey: row.dprNoKey,
        grnDate: row.dprDate,
        grnAmount: row.totalAmount,
        poNumber: row.poNo,
        invNo: row.billNo,
        invDate: row.billDate,
        grnLocation: row.location,
      });
    }
    return identities;
  }

  // Newest upload first, so a GRN carried by several uploads contributes the
  // most recent report's version of itself -- the same tie-break the "all
  // uploads" views use.
  const { rows } = await query(
    `SELECT DISTINCT ON (vendor_code, dpr_no_key)
            vendor_code, vendor_name, dpr_no, dpr_no_key, dpr_date,
            total_amount, po_no, bill_no, bill_date, location
     FROM grn_transactions
     WHERE vendor_code IS NOT NULL AND vendor_code <> ''
     ORDER BY vendor_code, dpr_no_key, batch_id DESC, id DESC`,
  );
  for (const row of rows) {
    add({
      vendorCode: row.vendor_code,
      vendorName: row.vendor_name,
      grnNo: row.dpr_no,
      grnNoKey: row.dpr_no_key,
      grnDate: row.dpr_date,
      grnAmount: row.total_amount,
      poNumber: row.po_no,
      invNo: row.bill_no,
      invDate: row.bill_date,
      grnLocation: row.location,
    });
  }

  return identities;
}

/**
 * Every configured branch, as the two names the BPAD match needs: the fragment
 * of the GRN report's Location that finds the branch, and the register
 * Location it is known by ('' where none is configured). The code and the
 * register Location as typed ride along for bpadLocationMismatch's message.
 *
 * Every branch, ticked or not. The tick box scopes what the screens show; it
 * does not change what a branch is called, and a register row belongs to the
 * branch it names whether or not that branch is being looked at today.
 */
async function branchBpadLocations() {
  const { rows } = await query('SELECT branch_code, location, bpad_location FROM branch_configs');
  return rows
    .map((r) => ({
      branchCode: r.branch_code,
      bpadLocation: r.bpad_location,
      locationKey: String(r.location ?? '').trim().toUpperCase(),
      bpadLocationKey: normKey(r.bpad_location),
    }))
    .filter((b) => b.locationKey !== '');
}

/**
 * Why the upload is being refused, when a branch's BPAD location looks
 * mistyped -- or null when none does.
 *
 * A BPAD location that is not the register's code for the branch ("SDB" for
 * SBD, or the GRN report's "SECUNDERABAD" typed in the wrong box) does not fail
 * loudly on its own: every register row for the branch's GRNs is turned away
 * as another branch's, each GRN is stored as a filler row the register "has no
 * entry for", and those fillers replace the good rows already stored (see
 * clearBpadRecordsFor). One upload would quietly empty the branch's BPAD tab.
 *
 * The register is the whole group's, so the right code for a branch appears in
 * its Location column somewhere. A configured code the register never writes,
 * while rows about that branch's GRNs WERE turned away for naming something
 * else, is a code that cannot be right -- so the upload stops before storing
 * anything and says which branch, what it is set to, and what the register
 * wrote instead. Refusing costs one corrected setting and one re-upload; the
 * alternative costs the branch's register data until somebody notices.
 *
 * @param {Map<string, Map<string, number>>} turnedAway configured code ->
 *   register Location -> rows turned away for GRNs requiring that code
 * @param {Set<string>} registerLocations every Location the registers carry
 * @param {object} [wording] how the message names things. Every default is
 *   this route's own, so the hospital call passes nothing and reads as it
 *   always has; the pharmacies' call (routes/phBatches.js) passes its own.
 * @param {string} [wording.screen] the screen the setting is corrected on
 * @param {boolean} [wording.canClear] whether clearing the setting is a way
 *   out. It is here, where a branch without one is matched on vendor code and
 *   GRN number alone; it is not for the pharmacies, where a branch without one
 *   is not matched at all
 * @param {string} [wording.file] what the uploaded file is called
 * @param {string} [wording.fileShort] and what it is called the second time
 */
export function bpadLocationMismatch(
  turnedAway,
  registerLocations,
  branches,
  { screen = 'Configuration', canClear = true, file = 'BPAD register', fileShort = 'register' } = {},
) {
  const problems = [];
  for (const [key, locations] of turnedAway) {
    if (registerLocations.has(key)) continue;
    const names = branches
      .filter((b) => b.bpadLocationKey === key)
      .map((b) => `${b.branchCode} has Location (BPAD) "${b.bpadLocation}"`);
    const found = [...locations]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([loc, n]) => `${loc || '(blank)'} (${n.toLocaleString('en-IN')} row${n === 1 ? '' : 's'})`);
    problems.push(
      `${names.join(' and ')}, but no row in the ${file} has that Location. ` +
        `The ${fileShort} writes this branch's GRNs under ${found.join(', ')}.`,
    );
  }
  if (problems.length === 0) return null;
  return (
    `${problems.join(' ')} Correct Location (BPAD) on the ${screen} screen${canClear ? ', or clear it,' : ''} ` +
    'and upload again. Nothing from this upload was stored.'
  );
}

/**
 * The register Locations a GRN's register rows may carry, or null for any.
 *
 * The GRN's branch is found the way every screen finds it from the stores
 * side: the GRN report's Location contains the branch's configured Location
 * (branchScope in services/branchScope.js), case-folded, so "YASHODA
 * HEALTHCARE SERVICES LIMITED, SECUNDERABAD" is the SECUNDERABAD branch.
 *
 * Null -- no check, vendor code and GRN number alone, as before this existed --
 * when the GRN names no configured branch, or when a branch it names has no
 * BPAD location. The second is what keeps the field optional: a branch nobody
 * has filled it in for goes on matching exactly as it did, rather than having
 * every register row turned away for failing a test nobody set. Where the
 * Location names more than one branch, a row naming any of theirs is kept.
 */
export function bpadLocationsFor(grnLocation, branches) {
  const text = String(grnLocation ?? '').toUpperCase();
  if (text === '') return null;
  const named = branches.filter((b) => text.includes(b.locationKey));
  if (named.length === 0 || named.some((b) => b.bpadLocationKey === '')) return null;
  return new Set(named.map((b) => b.bpadLocationKey));
}

/**
 * One BPAD row per GRN in scope: the register's own rows, plus a row for every
 * GRN the register turned out to have no entry for (inRegister false).
 *
 * Those extra rows are stored but never shown as BPAD rows: a GRN the register
 * has no entry for is not in BPAD -- it is still at the GRN store, and the
 * Pending GRNs at GRN Store card is where it is counted. The BPAD tab, its
 * export, its desk cards and its Not Integrated card all read the register's
 * own entries only (BPAD_IN_REGISTER in routes/results.js). They are written
 * anyway because this upload's "no entry" is still an answer for that GRN:
 * they replace an older register's row for it (clearBpadRecordsFor clears the
 * keys an upload writes), so the Pending breakdown moves the GRN to the GRN
 * store bucket rather than leaving it on a desk the register no longer lists;
 * and they keep the summary's bpad.onFile above zero once a register is on
 * file, even one that knew none of these GRNs.
 *
 * A row built this way carries only the facts the GRN report and the register
 * spell the same way: the vendor, the GRN number, its date and value, the PO,
 * and the invoice number -- which is generally "-" on exactly these rows,
 * because a GRN received on a delivery challan with no invoice raised has no
 * bill for a register of bills to be pending on. Everything the register alone
 * would know -- its Sl.No., its site code, the two received dates, whose desk
 * it is on -- stays null, because nothing knows it.
 *
 * Location and WareHouse are deliberately left null too, even though the GRN
 * report has both: it writes them in a different vocabulary from the register
 * ("YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD" against "HTC", "PHRM"
 * against "CENTRAL STORES PHARMACY"), and half a column in each vocabulary is
 * worse than a column that is honestly empty.
 *
 * The register can carry a GRN more than once -- it repeats one across a split
 * invoice -- so this is keyed off which GRNs were SEEN, not off a count.
 */
export function bpadRowsForGrns(registerRows, identities) {
  const seen = new Set(registerRows.map((r) => `${r.vendorCodeKey}|${r.grnNoKey}`));

  const missing = [];
  for (const [key, id] of identities) {
    if (seen.has(key)) continue;
    missing.push({
      sourceRowNo: null,
      slNo: null,
      location: null,
      warehouse: null,
      vendorCode: id.vendorCode,
      vendorCodeKey: id.vendorCodeKey,
      vendorName: id.vendorName,
      invNo: id.invNo,
      invDate: id.invDate,
      grnNo: id.grnNo,
      grnNoKey: id.grnNoKey,
      grnDate: id.grnDate,
      grnAmount: id.grnAmount,
      poNumber: id.poNumber,
      poDate: null,
      pendingWithDept: null,
      bpadReceivedDate: null,
      accountsReceivedDate: null,
      pendingWithUser: null,
      pendReason: null,
      inRegister: false,
    });
  }

  return [...registerRows, ...missing];
}

/**
 * POST /api/batches - upload one or more of the four files, store them, and
 * reconcile what they touched.
 *
 * Each slot takes several files. The GRN reports, ageing reports and BPAD
 * registers are each merged into one set of rows and stored as one batch, as
 * if they had been one file apiece -- see lastFilePerKey for how two files
 * naming the same GRN are settled. Bank statements are the exception: a batch
 * holds one statement's account (upload_batches.bank_account_no, which is also
 * what scopes it to a branch -- see services/branchScope.js), so the first
 * statement rides with the reports and every further one is stored as a batch
 * of its own. Every file is read before anything is stored, so a workbook that
 * fails to parse stops the whole upload rather than half of it.
 *
 * Behind the upload screen, not the router: GET below is what the results and
 * Accounts screens count uploads with ("N uploads combined", and whether there
 * is anything to show at all), so an account with results but not uploads
 * still has to be able to list them.
 */
batchesRouter.post(
  '/',
  requireScreen('upload'),
  refuseOversizedUpload,
  upload.fields([
    // Optional. Without the ageing report every GRN row simply has nothing to
    // match against, and reconcile() reports it PENDING -- a GRN report on its
    // own is still a usable upload.
    { name: 'grnFile', maxCount: MAX_FILES_PER_SLOT },
    // Optional too, the same way round: without the GRN report there is
    // nothing to reconcile, but the ageing rows are still stored for the month
    // -- reconciling them is then just a matter of uploading the GRN report
    // later.
    { name: 'ageingFile', maxCount: MAX_FILES_PER_SLOT },
    // Optional as well, and independent of the other two: the statement is
    // stored and matched to nothing at upload time, but every cheque number in
    // it is matched by routes/results.js against every ageing row on file, on
    // every future read -- not just this batch's -- so it is just as usable
    // uploaded on its own as either report is. At least one of the four files
    // is required; see the check below.
    { name: 'bankFile', maxCount: MAX_FILES_PER_SLOT },
    // Optional as well, and the only one of the four that is filtered as it is
    // read: the BPAD register is the whole group's, several hundred thousand
    // rows of it, and only the rows naming a GRN this upload is about are
    // kept. See grnMatchKeys above and readBpadReport.
    { name: 'bpadFile', maxCount: MAX_BPAD_FILES },
  ]),
  asyncHandler(async (req, res) => {
    const grnFiles = req.files?.grnFile ?? [];
    const ageingFiles = req.files?.ageingFile ?? [];
    const bankFiles = req.files?.bankFile ?? [];
    const bpadFiles = req.files?.bpadFile ?? [];
    const allFiles = [...grnFiles, ...ageingFiles, ...bankFiles, ...bpadFiles];

    if (allFiles.length === 0) {
      return res.status(400).json({ error: 'Choose at least one file: the GRN report, the Vendor Ageing report, the bank statement, or the BPAD register.' });
    }

    // The backstop for a request that declared no length -- see
    // refuseOversizedUpload. Too late to save the memory, but not too late to
    // refuse to parse and store it.
    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > config.maxUploadTotalBytes) {
      return res.status(413).json({ error: tooLargeMessage(totalBytes) });
    }

    // Optional now: the upload screen no longer asks for one, so an upload
    // that sends no name is named after the files it brought. A name sent by
    // an older client, or by anything calling the API directly, still wins.
    const name = String(req.body.name || '').trim() || defaultBatchName(allFiles);

    // Parsing errors carry status 400 and a message naming the offending file,
    // so the user is told which file was wrong.
    const grns = readEach(grnFiles, 'GRN report', readGrnReport);
    const ageings = readEach(ageingFiles, 'Vendor Ageing report', readAgeingReport);
    const banks = readEach(bankFiles, 'Bank statement', readBankStatement);

    // One row per GRN number, as saveBatch will store them, so the BPAD filler
    // rows and the summary are built from the same row a GRN is stored as. A
    // GRN in more than one report keeps the later report's row, which is what
    // lastRowPerGrn does with a report that repeats one.
    const grnRows = lastRowPerGrn(grns.flatMap((g) => g.rows));
    const ageingRows = lastFilePerKey(
      ageings.map((a) => a.rows),
      (r) => r.grnNumberKey,
    );

    // Read last, and the only one narrowed as it is read -- against this
    // upload's own GRN reports where there are any, and against every GRN on
    // file where there are not. See grnMatchKeys.
    let bpads = [];
    let bpadRows = [];
    // Register rows whose vendor code and GRN number matched one of these GRNs
    // but whose Location named a different branch -- see grnMatchKeys. Counted
    // rather than dropped quietly, so an upload that turned some away says so.
    let bpadOtherBranchCount = 0;
    if (bpadFiles.length > 0) {
      const branches = await branchBpadLocations();
      const identities = await grnMatchKeys(grnRows, branches);
      // For bpadLocationMismatch: every Location the registers write, and what
      // the turned-away rows wrote, by the code their GRN's branch required.
      const registerLocations = new Set();
      const turnedAway = new Map();
      const keep = (vendorCodeKey, grnNoKey, locationKey) => {
        registerLocations.add(locationKey);
        const id = identities.get(`${vendorCodeKey}|${grnNoKey}`);
        if (!id) return false;
        if (id.bpadLocationKeys && !id.bpadLocationKeys.has(locationKey)) {
          bpadOtherBranchCount += 1;
          for (const required of id.bpadLocationKeys) {
            const seen = turnedAway.get(required) ?? new Map();
            seen.set(locationKey, (seen.get(locationKey) ?? 0) + 1);
            turnedAway.set(required, seen);
          }
          return false;
        }
        return true;
      };
      bpads = readEach(bpadFiles, 'BPAD register', (buffer) => readBpadReport(buffer, { keep }));
      const mismatch = bpadLocationMismatch(turnedAway, registerLocations, branches);
      if (mismatch) return res.status(400).json({ error: mismatch });
      const registerRows = lastFilePerKey(
        bpads.map((b) => b.rows),
        (r) => (r.vendorCodeKey && r.grnNoKey ? `${r.vendorCodeKey}|${r.grnNoKey}` : null),
      );
      // Every GRN in scope gets a row, whether or not a register had one for
      // it -- see bpadRowsForGrns.
      bpadRows = bpadRowsForGrns(registerRows, identities);
    }

    // The files against each other only, for the summary in the response.
    // What is stored is paired against everything on file -- see linkResults
    // in services/ingest.js.
    const { summary } = reconcile(grnRows, ageingRows);

    // The reports, and the first bank statement with them -- so one file per
    // slot is stored exactly as it always was.
    const [firstBank, ...laterBanks] = banks;
    const main = await saveBatch({
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
    // account. In the order picked, so a transaction two statements share is
    // left with the later one, as two uploads one after the other would leave it.
    const batchIds = [main.batchId];
    let replacedBankRows = main.replaced.bankRows;
    for (const [i, bank] of laterBanks.entries()) {
      const file = bankFiles[i + 1];
      const extra = await saveBatch({
        name: defaultBatchName([file]),
        userId: req.user.id,
        bankFileName: file.originalname,
        bankRows: bank.rows,
        bankAccountNo: bank.accountNo ?? null,
      });
      batchIds.push(extra.batchId);
      replacedBankRows += extra.replaced.bankRows;
    }

    const { batchId, reopenedRejections } = main;
    const replaced = { ...main.replaced, bankRows: replacedBankRows };
    const bankRowCount = banks.reduce((sum, b) => sum + b.rows.length, 0);

    const files = allFiles.map((f) => f.originalname);
    logActivity(req, {
      action: 'UPLOAD',
      target: name,
      summary: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`,
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
        reopenedRejections,
        // Rows already stored that this upload replaced -- see saveBatch.
        replaced,
      },
    });

    return res.status(201).json({
      batchId,
      // More than one only when several bank statements came up together --
      // see the loop above.
      batchIds,
      name,
      summary,
      bankRowCount,
      bankAccountNo: firstBank?.accountNo ?? null,
      // Three figures, because they answer three different questions: how big
      // the registers were, how much of them was about these GRNs, and how many
      // rows were stored -- the matched ones, which the BPAD tab shows, plus one
      // per GRN the register had no entry for (see bpadRowsForGrns), which it
      // does not. A register that matched nothing says so, rather than reading
      // like a file that failed to parse.
      bpadRowCount: bpads.reduce((sum, b) => sum + b.scanned, 0),
      bpadMatchedCount: bpads.reduce((sum, b) => sum + b.rows.length, 0),
      bpadStoredCount: bpadRows.length,
      // Register rows that named one of these GRNs but another branch's
      // Location, and were not kept -- see grnMatchKeys.
      bpadOtherBranchCount,
      // How many GRNs this upload took back off the CSD queue by carrying a
      // bill CSD had rejected -- see reopenRejectedFor in services/ingest.js.
      // Worth reporting rather than doing quietly: those GRNs have just
      // changed from rejected to unsent, and somebody has to send them again.
      reopenedRejections,
      // How many rows already stored this upload replaced, per file, rather
      // than adding beside them -- see saveBatch in services/ingest.js.
      replaced,
    });
  }),
);

/**
 * GET /api/batches - most recent first.
 *
 * The list the Results and Accounts Department screens read, so it is behind
 * their two grants. Said here because nothing else says it: the results
 * router's own gate, which stands ahead of this router on the same mount,
 * covers only that router's addresses.
 */
batchesRouter.get(
  '/',
  requireScreen('results', 'accounts-department'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.id, b.name, b.grn_file_name, b.ageing_file_name,
              b.grn_row_count, b.ageing_row_count, b.bank_file_name, b.bank_row_count,
              b.bank_account_no,
              b.bpad_file_name, b.bpad_row_count, b.bpad_matched_count,
              b.uploaded_at, u.username AS uploaded_by
       FROM upload_batches b
       LEFT JOIN users u ON u.id = b.uploaded_by
       ORDER BY b.uploaded_at DESC, b.id DESC`,
    );

    res.json({
      batches: rows.map((r) => ({
        id: r.id,
        name: r.name,
        grnFileName: r.grn_file_name,
        ageingFileName: r.ageing_file_name,
        bankFileName: r.bank_file_name,
        bankRowCount: r.bank_row_count,
        bankAccountNo: r.bank_account_no,
        bpadFileName: r.bpad_file_name,
        // What the register held, against how much of it was about this
        // installation's GRNs -- see bpad_row_count in schema.sql.
        bpadRowCount: r.bpad_row_count,
        bpadMatchedCount: r.bpad_matched_count,
        grnRowCount: r.grn_row_count,
        ageingRowCount: r.ageing_row_count,
        uploadedAt: r.uploaded_at,
        uploadedBy: r.uploaded_by,
      })),
    });
  }),
);
