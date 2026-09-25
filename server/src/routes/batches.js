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

const upload = multer({
  storage: multer.memoryStorage(),
  // Four: the two reports the reconciliation runs on, plus the optional bank
  // statement and the optional BPAD register. Kept as a hard cap rather than
  // left open, so a malformed form cannot stream an unbounded number of
  // workbooks into memory.
  limits: { fileSize: config.maxUploadBytes, files: 4 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    return cb(new ExcelFormatError(`"${file.originalname}" is not an Excel file. Upload .xls or .xlsx.`));
  },
});

batchesRouter.use(requireAuth);

/**
 * What to call an upload now that nobody is asked to name one.
 *
 * The column is still NOT NULL and the name is still what an upload is listed
 * under, so it is derived rather than dropped: the report that arrived, with
 * the date it arrived on, which is what a name typed by hand said anyway. The
 * results screen reports on every upload at once and never shows it -- this
 * only keeps the row readable to anyone reading the table directly.
 */
function defaultBatchName(files) {
  const first = files.find(Boolean);
  const stamp = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return first ? `${first.originalname} — ${stamp}` : `Upload — ${stamp}`;
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
 * The GRN rows are passed in rather than read back out of the table because at
 * this point they have only been parsed; saveBatch inserts them afterwards.
 */
async function grnMatchKeys(grnRows) {
  const identities = new Map();

  const add = (id) => {
    if (!id.vendorCode || !id.grnNoKey) return;
    const key = `${normKey(id.vendorCode)}|${id.grnNoKey}`;
    // First writer wins. The same GRN can appear in more than one upload, and
    // findLatest-style ordering below hands them over newest first.
    if (!identities.has(key)) identities.set(key, { ...id, vendorCodeKey: normKey(id.vendorCode) });
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
            total_amount, po_no, bill_no, bill_date
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
    });
  }

  return identities;
}

/**
 * One BPAD row per GRN in scope: the register's own rows, plus a row for every
 * GRN the register turned out to have no entry for.
 *
 * The tab is "the BPAD position of the GRNs in this upload", so a GRN the
 * register never heard of is an answer rather than an omission -- and a silent
 * omission is the worst version of it, since a reader counting 3,392 rows
 * against 3,402 GRNs has no way to tell which ten are missing or why.
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
function bpadRowsForGrns(registerRows, identities) {
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
 * Behind the upload screen, not the router: GET below is what the results and
 * Accounts screens count uploads with ("N uploads combined", and whether there
 * is anything to show at all), so an account with results but not uploads
 * still has to be able to list them.
 */
batchesRouter.post(
  '/',
  requireScreen('upload'),
  upload.fields([
    // Optional. Without the ageing report every GRN row simply has nothing to
    // match against, and reconcile() reports it PENDING -- a GRN report on its
    // own is still a usable upload.
    { name: 'grnFile', maxCount: 1 },
    // Optional too, the same way round: without the GRN report there is
    // nothing to reconcile, but the ageing rows are still stored for the month
    // -- reconciling them is then just a matter of uploading the GRN report
    // later.
    { name: 'ageingFile', maxCount: 1 },
    // Optional as well, and independent of the other two: the statement is
    // stored and matched to nothing at upload time, but every cheque number in
    // it is matched by routes/results.js against every ageing row on file, on
    // every future read -- not just this batch's -- so it is just as usable
    // uploaded on its own as either report is. At least one of the four files
    // is required; see the check below.
    { name: 'bankFile', maxCount: 1 },
    // Optional as well, and the only one of the four that is filtered as it is
    // read: the BPAD register is the whole group's, several hundred thousand
    // rows of it, and only the rows naming a GRN this upload is about are
    // kept. See grnMatchKeys above and readBpadReport.
    { name: 'bpadFile', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const grnFile = req.files?.grnFile?.[0];
    const ageingFile = req.files?.ageingFile?.[0];
    const bankFile = req.files?.bankFile?.[0];
    const bpadFile = req.files?.bpadFile?.[0];

    if (!grnFile && !ageingFile && !bankFile && !bpadFile) {
      return res.status(400).json({ error: 'Choose at least one file: the GRN report, the Vendor Ageing report, the bank statement, or the BPAD register.' });
    }

    // Optional now: the upload screen no longer asks for one, so an upload
    // that sends no name is named after the files it brought. A name sent by
    // an older client, or by anything calling the API directly, still wins.
    const name =
      String(req.body.name || '').trim() ||
      defaultBatchName([grnFile, ageingFile, bankFile, bpadFile]);

    // Parsing errors carry status 400 and a message naming the offending file,
    // so the user is told which file was wrong.
    let grn = null;
    let ageing = null;
    if (grnFile) {
      try {
        grn = readGrnReport(grnFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `GRN report: ${err.message}`;
        throw err;
      }
    }
    if (ageingFile) {
      try {
        ageing = readAgeingReport(ageingFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `Vendor Ageing report: ${err.message}`;
        throw err;
      }
    }

    // One row per GRN number, as saveBatch will store them, so the BPAD filler
    // rows and the summary are built from the same row a GRN is stored as.
    const grnRows = lastRowPerGrn(grn?.rows ?? []);

    let bank = null;
    if (bankFile) {
      try {
        bank = readBankStatement(bankFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `Bank statement: ${err.message}`;
        throw err;
      }
    }

    // Read last, and the only one narrowed as it is read -- against this
    // upload's own GRN report where there is one, and against every GRN on file
    // where there is not. See grnMatchKeys.
    let bpad = null;
    let bpadRows = [];
    if (bpadFile) {
      const identities = await grnMatchKeys(grnRows);
      try {
        bpad = readBpadReport(bpadFile.buffer, {
          keep: (vendorCodeKey, grnNoKey) => identities.has(`${vendorCodeKey}|${grnNoKey}`),
        });
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `BPAD register: ${err.message}`;
        throw err;
      }
      // Every GRN in scope gets a row, whether or not the register had one for
      // it -- see bpadRowsForGrns.
      bpadRows = bpadRowsForGrns(bpad.rows, identities);
    }

    // The two files against each other only, for the summary in the response.
    // What is stored is paired against everything on file -- see linkResults
    // in services/ingest.js.
    const { summary } = reconcile(grnRows, ageing?.rows ?? []);

    const { batchId, reopenedRejections, replaced } = await saveBatch({
      name,
      grnFileName: grnFile?.originalname ?? null,
      ageingFileName: ageingFile?.originalname ?? null,
      userId: req.user.id,
      grnRows,
      ageingRows: ageing?.rows ?? [],
      bankFileName: bankFile?.originalname ?? null,
      bankRows: bank?.rows ?? [],
      bankAccountNo: bank?.accountNo ?? null,
      bpadFileName: bpadFile?.originalname ?? null,
      bpadRows,
      bpadScanned: bpad?.scanned ?? 0,
    });

    const files = [grnFile, ageingFile, bankFile, bpadFile].filter(Boolean).map((f) => f.originalname);
    logActivity(req, {
      action: 'UPLOAD',
      target: name,
      summary: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`,
      details: {
        batchId,
        grnFile: grnFile?.originalname ?? null,
        grnRows: grn?.rows.length ?? 0,
        ageingFile: ageingFile?.originalname ?? null,
        ageingRows: ageing?.rows.length ?? 0,
        bankFile: bankFile?.originalname ?? null,
        bankRows: bank?.rows.length ?? 0,
        bpadFile: bpadFile?.originalname ?? null,
        bpadStoredRows: bpadRows.length,
        reopenedRejections,
        // Rows already stored that this upload replaced -- see saveBatch.
        replaced,
      },
    });

    return res.status(201).json({
      batchId,
      name,
      summary,
      bankRowCount: bank?.rows.length ?? 0,
      bankAccountNo: bank?.accountNo ?? null,
      // Three figures, because they answer three different questions: how big
      // the register was, how much of it was about these GRNs, and how many
      // rows the tab will therefore show. A register that matched nothing says
      // so, rather than reading like a file that failed to parse.
      bpadRowCount: bpad?.scanned ?? 0,
      bpadMatchedCount: bpad?.rows.length ?? 0,
      bpadStoredCount: bpadRows.length,
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

/** GET /api/batches - most recent first. */
batchesRouter.get(
  '/',
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
