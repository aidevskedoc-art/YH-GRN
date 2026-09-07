import express from 'express';
import multer from 'multer';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import {
  readGrnReport,
  readAgeingReport,
  readBankStatement,
  ExcelFormatError,
} from '../services/excelParser.js';
import { reconcile } from '../services/reconcile.js';
import { saveBatch } from '../services/ingest.js';

export const batchesRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Three: the two reports the reconciliation runs on, plus the optional bank
  // statement. Kept as a hard cap rather than left open, so a malformed form
  // cannot stream an unbounded number of workbooks into memory.
  limits: { fileSize: config.maxUploadBytes, files: 3 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    return cb(new ExcelFormatError(`"${file.originalname}" is not an Excel file. Upload .xls or .xlsx.`));
  },
});

batchesRouter.use(requireAuth);

/**
 * POST /api/batches - upload one or both reports, reconcile, and store the batch.
 *
 * Behind the upload screen, not the router: GET below is what fills the batch
 * selector on the results page and the count in the sidebar, so an account with
 * results but not uploads still has to be able to list them.
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
    // later. At least one of the two is required; see the check below.
    { name: 'ageingFile', maxCount: 1 },
    // Optional. The two reports are what the reconciliation runs on; the bank
    // statement is stored alongside them and reconciled against nothing yet.
    { name: 'bankFile', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const grnFile = req.files?.grnFile?.[0];
    const ageingFile = req.files?.ageingFile?.[0];
    const bankFile = req.files?.bankFile?.[0];

    if (!grnFile && !ageingFile) {
      return res.status(400).json({ error: 'Choose the GRN report, the Vendor Ageing report, or both.' });
    }

    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Please give this upload a name, for example "April GRN reconciliation".' });
    }

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

    let bank = null;
    if (bankFile) {
      try {
        bank = readBankStatement(bankFile.buffer);
      } catch (err) {
        if (err instanceof ExcelFormatError) err.message = `Bank statement: ${err.message}`;
        throw err;
      }
    }

    const { results, summary } = reconcile(grn?.rows ?? [], ageing?.rows ?? []);

    const batchId = await saveBatch({
      name,
      grnFileName: grnFile?.originalname ?? null,
      ageingFileName: ageingFile?.originalname ?? null,
      userId: req.user.id,
      grnRows: grn?.rows ?? [],
      ageingRows: ageing?.rows ?? [],
      results,
      bankFileName: bankFile?.originalname ?? null,
      bankRows: bank?.rows ?? [],
      bankAccountNo: bank?.accountNo ?? null,
    });

    return res.status(201).json({
      batchId,
      name,
      summary,
      bankRowCount: bank?.rows.length ?? 0,
      bankAccountNo: bank?.accountNo ?? null,
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
        grnRowCount: r.grn_row_count,
        ageingRowCount: r.ageing_row_count,
        uploadedAt: r.uploaded_at,
        uploadedBy: r.uploaded_by,
      })),
    });
  }),
);

/**
 * DELETE /api/batches/:id - removes the batch and everything under it.
 *
 * Administrators only. Being given the upload screen is permission to add a
 * month's reports, not to remove one: a delete takes the GRN rows, the ageing
 * rows and every reconciled result with it, and the results screen is read by
 * people who did not upload them. requireAdmin rather than a hidden button --
 * the button is hidden too, but that is a courtesy, not the guard.
 */
batchesRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM upload_batches WHERE id = $1', [Number(req.params.id)]);
    if (rowCount === 0) return res.status(404).json({ error: 'That upload no longer exists.' });
    return res.status(204).end();
  }),
);
