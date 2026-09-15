import express from 'express';
import multer from 'multer';
import { config } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdmin, requireScreen } from '../middleware/auth.js';
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
import { saveBatch } from '../services/ingest.js';

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
      vendorCategory: null,
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
      const identities = await grnMatchKeys(grn?.rows ?? []);
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

    const { results, summary } = reconcile(grn?.rows ?? [], ageing?.rows ?? []);

    const { batchId, reopenedRejections } = await saveBatch({
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
      bpadFileName: bpadFile?.originalname ?? null,
      bpadRows,
      bpadScanned: bpad?.scanned ?? 0,
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

/**
 * The four files an upload can carry, and what removing one means.
 *
 * Keyed on the same strings the upload form sends (`grnFile` minus the suffix),
 * so the screen that lists a file and the route that deletes it name it
 * identically rather than through a translation table nobody maintains.
 *
 * `column` is the file name on upload_batches -- a null there IS "not
 * uploaded", so clearing it is what makes the file stop existing as far as
 * every list and every count is concerned. `clear` blanks the counts that went
 * with it in the same statement. `remove` takes the rows the file put in.
 */
const FILE_KINDS = {
  grn: {
    label: 'GRN report',
    column: 'grn_file_name',
    clear: 'grn_file_name = NULL, grn_row_count = 0',
    /**
     * The GRN rows, and with them every reconciliation result that was about
     * one: reconciliation_results.grn_transaction_id cascades, so a result
     * cannot outlive the GRN it describes -- including results stored by a
     * LATER upload against these rows (see the cross-batch matching in
     * services/ingest.js), which is right, because the GRN they were about is
     * what is being deleted.
     */
    async remove(client, batchId) {
      const { rowCount } = await client.query('DELETE FROM grn_transactions WHERE batch_id = $1', [batchId]);
      return rowCount;
    },
  },
  ageing: {
    label: 'Vendor Ageing report',
    column: 'ageing_file_name',
    clear: 'ageing_file_name = NULL, ageing_row_count = 0',
    /**
     * The ageing rows -- and first, the results that matched against them.
     *
     * matched_ageing_id is ON DELETE SET NULL, which on its own would leave a
     * row still saying MATCHED with nothing left to have matched: a Valid GRN
     * whose evidence has been deleted. Those results are put back to PENDING
     * instead, which is exactly what reconcile() says about a GRN with no
     * ageing row -- so deleting this file returns its GRNs to where they were
     * before it was uploaded, rather than to a state the reconciliation could
     * never have produced.
     *
     * Not scoped to this batch: an ageing row is matched by whichever upload
     * happened to find it, so the results pointing at these rows can belong to
     * any batch.
     */
    async remove(client, batchId) {
      await client.query(
        `UPDATE reconciliation_results
            SET matched_ageing_id = NULL,
                status = 'PENDING',
                bill_no_match = NULL,
                vendor_name_match = NULL,
                discrepancy_notes = NULL
          WHERE matched_ageing_id IN (SELECT id FROM vendor_ageing WHERE batch_id = $1)`,
        [batchId],
      );
      const { rowCount } = await client.query('DELETE FROM vendor_ageing WHERE batch_id = $1', [batchId]);
      return rowCount;
    },
  },
  bank: {
    label: 'Bank statement',
    column: 'bank_file_name',
    // The account number goes too: it was read off this statement's letterhead
    // and means nothing once the statement is gone.
    clear: 'bank_file_name = NULL, bank_row_count = 0, bank_account_no = NULL',
    /** Matched to nothing at upload time, so nothing else has to be told. */
    async remove(client, batchId) {
      const { rowCount } = await client.query(
        'DELETE FROM bank_statement_transactions WHERE batch_id = $1',
        [batchId],
      );
      return rowCount;
    },
  },
  bpad: {
    label: 'BPAD register',
    column: 'bpad_file_name',
    clear: 'bpad_file_name = NULL, bpad_row_count = 0, bpad_matched_count = 0',
    /**
     * The register's answers from this upload. A GRN whose only BPAD row came
     * from here goes back to having none -- the BPAD tab simply stops
     * reporting on it, which is what it did before the register was uploaded.
     * An earlier register's rows for the same GRNs are not restored: they were
     * replaced when this one landed (see clearBpadRecordsFor in ingest.js),
     * and a snapshot that has been superseded is not worth resurrecting.
     */
    async remove(client, batchId) {
      const { rowCount } = await client.query('DELETE FROM bpad_records WHERE batch_id = $1', [batchId]);
      return rowCount;
    },
  },
};

/**
 * DELETE /api/batches/:id/files/:kind - remove one file from an upload.
 *
 * Administrators only, for the reason the whole-batch delete below is: this
 * takes stored rows out from under a results screen other people are reading.
 *
 * An upload is up to four files that happened to be sent together, and they
 * are independent afterwards -- a bank statement is matched against every
 * ageing row on file, a register against every GRN -- so removing the wrong
 * one should not cost the other three. Deleting the last remaining file
 * deletes the upload itself: a batch naming no file is not a batch of
 * anything, and the table says so (upload_batches_has_a_file).
 */
batchesRouter.delete(
  '/:id/files/:kind',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const batchId = Number(req.params.id);
    const kind = FILE_KINDS[req.params.kind];
    if (!kind) return res.status(400).json({ error: 'That is not one of the files an upload can carry.' });

    const result = await withTransaction(async (client) => {
      // Locked for the length of the transaction, so two admins deleting the
      // last two files at once cannot both read "one file left" and leave a
      // batch behind that names none.
      const { rows } = await client.query(
        `SELECT grn_file_name, ageing_file_name, bank_file_name, bpad_file_name
           FROM upload_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      if (rows.length === 0) return { missing: 'batch' };

      const batch = rows[0];
      if (!batch[kind.column]) return { missing: 'file' };

      const rowsDeleted = await kind.remove(client, batchId);

      // What the upload would still be carrying afterwards.
      const remaining = Object.values(FILE_KINDS).filter(
        (k) => k.column !== kind.column && batch[k.column],
      );

      if (remaining.length === 0) {
        // Everything under it cascades -- see the references in schema.sql.
        await client.query('DELETE FROM upload_batches WHERE id = $1', [batchId]);
        return { rowsDeleted, batchDeleted: true };
      }

      await client.query(`UPDATE upload_batches SET ${kind.clear} WHERE id = $1`, [batchId]);
      return { rowsDeleted, batchDeleted: false };
    });

    if (result.missing === 'batch') return res.status(404).json({ error: 'That upload no longer exists.' });
    if (result.missing === 'file') {
      return res.status(404).json({ error: `This upload has no ${kind.label} to remove.` });
    }

    return res.json({
      batchId,
      kind: req.params.kind,
      rowsDeleted: result.rowsDeleted,
      batchDeleted: result.batchDeleted,
    });
  }),
);
