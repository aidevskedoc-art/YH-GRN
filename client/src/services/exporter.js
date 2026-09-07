/**
 * Builds the Excel downloads, in the browser.
 *
 * The server hands over the rows as JSON and nothing else; the workbook itself
 * is assembled here with ExcelJS. That keeps the API to one job -- answering
 * with data -- and means a 1,200-row export costs the server a query rather
 * than a query plus a few hundred kilobytes of workbook held in memory.
 *
 * Only the columns marked numeric carry numbers. Everything else stays a
 * string, so a bill number like 3610006395 or 26-27/HT/001 is not reinterpreted
 * by Excel as a number or a date when the file is reopened.
 *
 * Two layouts exist. The default reconciliation layout carries both sides of
 * the match, because "Moved to accounts" and "Needs review" only mean anything
 * next to the ageing row they matched. The Pending layout is the GRN report's
 * own column set, in the source file's order and with its exact header
 * spelling, plus a single Remarks column -- a pending row has no ageing
 * counterpart, so the ageing columns would all be blank, and the file is meant
 * to be handed back to the stores as the same sheet they sent, annotated.
 */
import { api } from '../api/client.js';
import { CHECKPOINTS, STAGE_KEYS, spanDays, spanId, spanLabel, stageLabel, totalDays } from './stages.js';

const COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'dprNo', label: 'GRN No (DPR.No)' },
  { key: 'poNo', label: 'PO No' },
  { key: 'dprDate', label: 'GRN Date', date: true },
  { key: 'billNo', label: 'Bill No' },
  { key: 'billDate', label: 'Bill Date', date: true },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'location', label: 'Location' },
  { key: 'totalAmount', label: 'Total Amount', numeric: true },
  { key: 'ageingGrnNo', label: 'Focus doc_no' },
  { key: 'ageingBranchCode', label: 'Branch Code' },
  { key: 'ageingBillNo', label: 'Ageing Bill No' },
  { key: 'ageingVendorName', label: 'Ageing Vendor Name' },
  { key: 'billHandoverToAcc', label: 'Handed To Accounts', date: true },
  { key: 'discrepancyNotes', label: 'Remarks' },
];

/**
 * Valid GRNs -- both matched statuses, the ones that agree and the ones that
 * differ on a bill number or a vendor spelling. Every row here has an ageing
 * entry, so the accounts side leads throughout: Division carries the ageing
 * report's DivisionCode in place of the GRN report's Warehouse, and the amount
 * columns come across with their source spelling.
 *
 * Four columns the reconciliation layout carries are dropped here, all for the
 * same reason -- on this tab they say nothing a reader needs. Total Amount is
 * the stores' figure, and NetAmt through PayableAmount are the accounts one;
 * Branch Code, Ageing Bill No and Ageing Vendor Name are the ageing side of a
 * comparison this report no longer draws. Handed To Accounts goes too: the tab
 * is by definition the GRNs that were handed over, and the Turnaround export is
 * where that date is read.
 */
const MATCHED_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'divisionCode', label: 'Division' },
  { key: 'dprNo', label: 'GRN No (DPR.No)' },
  { key: 'poNo', label: 'PO No' },
  { key: 'dprDate', label: 'GRN Date', date: true },
  { key: 'billNo', label: 'Bill No' },
  { key: 'billDate', label: 'Bill Date', date: true },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'location', label: 'Location' },
  { key: 'ageingGrnNo', label: 'Focus doc_no' },
  { key: 'netAmt', label: 'NetAmt', numeric: true },
  { key: 'adjPurReturn', label: 'AdjPurReturn', numeric: true },
  { key: 'adjustedJv', label: 'AdjustedJV', numeric: true },
  { key: 'tdsJv', label: 'TDSJV', numeric: true },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true },
  // Text, not numeric: a cheque number is an identifier, and 063851 read as a
  // number reopens in Excel as 63851.
  { key: 'chequeNo', label: 'Cheque No' },
  // The day the cheque was cut, from the ageing report -- not the day it
  // cleared, which is the bank's answer in Cheque Status beside it.
  { key: 'chqDate', label: 'Cheque Date', date: true },
  // The bank statement's answer on that cheque. Blank when no statement carries
  // the number, which is not the same as "not cleared".
  { key: 'chequeStatus', label: 'Cheque Status' },
  { key: 'csdStage', label: 'CSD Status' },
  { key: 'discrepancyNotes', label: 'Remarks' },
];

/**
 * The GRN report's own columns, in its own order, spelled exactly as the source
 * file spells them -- "Bill  No" really does carry two spaces and " Total
 * Amount" a leading one.
 *
 * Differences from the source, all deliberate: Remarks is appended, and
 * DPR.Date / Bill.Date are dropped -- the batch is one month's GRNs and the
 * dates were not what anyone chasing a pending GRN reads. The reconciliation
 * layout above keeps its dates, since a row there is being compared against an
 * ageing entry. Location is here in its source position, between Total Amount
 * and Add.Amount, because the tables now show it.
 */
const GRN_COLUMNS = [
  { key: 'slNo', label: 'Sl.No', integer: true },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'dprNo', label: 'DPR.No' },
  { key: 'poNo', label: 'PO.No' },
  { key: 'billNo', label: 'Bill  No' },
  { key: 'dcNo', label: 'DC No' },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'billAmount', label: 'Bill.Amount', numeric: true },
  { key: 'transportAmount', label: 'Transport Amount', numeric: true },
  { key: 'totalAmount', label: ' Total Amount', numeric: true },
  { key: 'location', label: 'Location' },
  { key: 'addAmount', label: 'Add.Amount', numeric: true },
  { key: 'dedAmount', label: 'Ded.Amount', numeric: true },
  { key: 'discrepancyNotes', label: 'Remarks' },
];

/**
 * What every Turnaround file carries, whatever it is measuring: the eight
 * identifying columns, in the order the screen shows them.
 *
 * `group` is what puts a column under "Particulars", "Days taken" or "Reached"
 * in the merged row above the headers, exactly as the table's own group row
 * does. A column with no group sits under a blank stretch of band.
 */
const TURNAROUND_PARTICULARS = [
  { key: 'divisionCode', label: 'Division', group: 'Particulars' },
  { key: 'dprNo', label: 'GRN No', group: 'Particulars' },
  { key: 'billNo', label: 'Bill No', group: 'Particulars' },
  { key: 'vendorName', label: 'Vendor', group: 'Particulars' },
  { key: 'vendorCode', label: 'Vendor Code', group: 'Particulars' },
  { key: 'location', label: 'Location', group: 'Particulars' },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true, group: 'Particulars' },
  { key: 'chequeNo', label: 'Cheque No', group: 'Particulars' },
];

/**
 * The Turnaround layout for the spans the screen is showing -- column for
 * column with the table, same set, same order, same two-row header.
 *
 * With none picked it is the whole report: a column per stage, the total, and
 * every checkpoint -- which is what this was before the picker existed.
 *
 * With spans picked it narrows exactly as the table does, and for the same
 * reason: the file is meant to be the screen, saved. The day columns become the
 * spans, the Reached band keeps only the dates they are measured between, and
 * the Total leaves with the checkpoints that would have explained it.
 *
 * The day counts arrive nested under `gaps` on each row and the span counts are
 * worked out row by row, so exportResults flattens both up a level before
 * building -- toCell only reads top-level keys.
 */
function turnaroundColumns(spans = []) {
  const custom = spans.length > 0;

  // The day counts, named from the same helpers the table's header reads.
  const days = custom
    ? spans.map((span) => ({
        key: spanId(span),
        label: `${spanLabel(span)} (days)`,
        integer: true,
        group: 'Days taken',
      }))
    : [
        ...STAGE_KEYS.map((key) => ({
          key,
          label: `${stageLabel(key)} (days)`,
          integer: true,
          group: 'Days taken',
        })),
        { key: 'totalDays', label: 'Total (Days)', integer: true, group: 'Days taken' },
      ];

  const reached = custom
    ? CHECKPOINTS.filter((c) => spans.some((s) => s.from === c.key || s.to === c.key))
    : CHECKPOINTS;

  return [
    ...TURNAROUND_PARTICULARS,
    ...days,
    ...reached.map((c) => ({ key: c.key, label: c.label, date: true, group: 'Reached' })),
  ];
}

/**
 * The CSD queue, column for column with the screen.
 *
 * Deliberately the same set the table shows and nothing more: an export that
 * carries columns the screen does not is a second, differently-shaped report
 * that nobody asked for, and it makes checking the file against the page a
 * matter of guessing which extra column is which.
 *
 * The Action column has no counterpart -- it holds the stage dropdown and the
 * take-back button, and a control does not export.
 *
 * The dispatch still records who sent it, who moved it, and which upload it was
 * read from. Those stay on the API row for anything that wants them; they are
 * not in the file because they are not on the screen.
 */
const CSD_COLUMNS = [
  { key: 'dprNo', label: 'GRN No' },
  { key: 'divisionCode', label: 'Division' },
  { key: 'dprDate', label: 'GRN Date', date: true },
  { key: 'billNo', label: 'Bill No' },
  { key: 'billDate', label: 'Bill Date', date: true },
  { key: 'vendorName', label: 'Vendor' },
  { key: 'vendorCode', label: 'Vendor Code' },
  // Blank on a handover sent before the dispatch table kept it -- see the
  // location column in db/schema.sql.
  { key: 'location', label: 'Location' },
  { key: 'ageingGrnNo', label: 'Focus doc_no' },
  { key: 'netAmt', label: 'NetAmt', numeric: true },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true },
  { key: 'stage', label: 'Status' },
  { key: 'queueDate', label: 'Queue Date' },
  { key: 'receivedDate', label: 'Received Date' },
  { key: 'approvedDate', label: 'Approved Date' },
  { key: 'rejectedDate', label: 'Rejected Date' },
];

/**
 * Per-row, from the stored status. Valid GRNs holds both matched statuses, so
 * the Status column is where the export still distinguishes them -- alongside
 * Remarks, which spells the difference out.
 */
const STATUS_LABELS = {
  MATCHED: 'Moved to accounts',
  MATCHED_WITH_DIFF: 'Moved to accounts (check details)',
  PENDING: 'Pending - not in accounts',
};

/**
 * How far a handover has got at CSD, spelled the way both screens spell it.
 *
 * Read by two columns: `csdStage` on the Valid GRNs layout, where a blank means
 * the GRN was never sent, and `stage` on the CSD layout, where every row has one
 * by definition.
 */
/** The bank statement's verdict on a cheque, spelled for a reader. */
const CHEQUE_STATUS_LABELS = {
  CLEARED: 'Cleared',
  RETURNED: 'Returned',
};

/**
 * The stage as the CSD screen writes it. Its own map, because the Valid GRNs
 * layout spells the same stages from the other side of the handover -- "Sent to
 * CSD" there, "Queued" here -- and each file should read like the page it came
 * from.
 */
const CSD_QUEUE_LABELS = {
  QUEUED: 'Queued',
  RECEIVED: 'Received',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const CSD_STAGE_LABELS = {
  QUEUED: 'Sent to CSD',
  RECEIVED: 'CSD received',
  APPROVED: 'CSD approved',
  REJECTED: 'CSD rejected',
};

/**
 * The title written above the column headers, the way the source reports carry
 * a title block above theirs.
 */
const TITLES = {
  ALL: 'Total GRNs Report',
  VALID: 'Valid GRNs Report',
  PENDING: 'GRN Pendings Report',
  TURNAROUND: 'GRN SPAN Report',
  CSD: 'CSD GRN Report',
};

/**
 * The report's name as a filename fragment: "GRN SPAN Report" -> "GRN_SPAN_Report".
 *
 * Derived from the title rather than kept beside it, so the file that lands in
 * Downloads is called the same thing as the sheet inside it and the two cannot
 * be renamed apart.
 */
function slug(text) {
  return String(text).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Which column set a given export uses. Pending gets the GRN report's own.
 *
 * Total GRNs falls through to COLUMNS, which is the layout built for exactly
 * that: both sides of the match on one row, with Status saying which bucket
 * each is in -- the sheet the screen's Match column exists for.
 */
export function columnsForStatus(status, spans = []) {
  if (status === 'PENDING') return GRN_COLUMNS;
  if (status === 'TURNAROUND') return turnaroundColumns(spans);
  if (status === 'VALID') return MATCHED_COLUMNS;
  if (status === 'CSD') return CSD_COLUMNS;
  return COLUMNS;
}

export function titleForStatus(status) {
  return TITLES[status] || 'GRN Reconciliation';
}

/** Dates are stored as yyyy-MM-dd but shown as dd-MM-yyyy, matching the source reports. */
function toDisplayDate(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : value;
}

function toCell(row, column) {
  if (column.key === 'status') return STATUS_LABELS[row.status] || row.status;
  // The CSD layout carries the same verdict under its own name, to leave
  // `status` free for CSD's progress -- which is stored ready to read.
  if (column.key === 'matchStatus') return STATUS_LABELS[row.matchStatus] || row.matchStatus;
  // 'Not sent', not blank: a reader filtering this column wants the GRNs that
  // never went as much as the ones that did, and an empty cell reads as missing
  // data rather than as an answer.
  if (column.key === 'csdStage') return CSD_STAGE_LABELS[row.csdStage] || 'Not sent';
  if (column.key === 'chequeStatus') return CHEQUE_STATUS_LABELS[row.chequeStatus] ?? null;
  if (column.key === 'stage') return CSD_QUEUE_LABELS[row.stage] || row.stage;
  const value = row[column.key];
  // null, not '': an empty cell should stay empty rather than become a cell
  // holding an empty string, which ExcelJS would write as a styled blank.
  if (value === null || value === undefined) return null;
  if (column.date) return toDisplayDate(value);
  return value;
}

function buildAoa(rows, columns) {
  return [columns.map((c) => c.label), ...rows.map((row) => columns.map((c) => toCell(row, c)))];
}

/* -------------------------------------------------------------------------
   The look of the sheet.

   Sampled from the app's own palette (client/src/styles.css) so a printed
   export and the screen it came from are recognisably the same report. The
   light-theme rungs are the ones used here: this lands on white paper, not on
   the dark drape.

   Dark text on the orange header rather than white -- white on #F58633 is
   about 2.4:1, which is unreadable on a photocopy.
   ------------------------------------------------------------------------- */
const INK = 'FF241B12'; // --umber-900, warm near-black
const BRAND = '1370bf'; // --brand
const BAND = 'FFFFFFFF'; // --brand-50, the alternating row wash
const RULE = 'FFFBEEDA'; // warm grey for the gridlines
const PAPER = 'FFFFFFFF';

const FONT = 'Calibri';
const THIN = { style: 'thin', color: { argb: RULE } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/**
 * ExcelJS, not SheetJS, and only for writing.
 *
 * SheetJS's community build silently discards every cell style: set a fill or a
 * bold font and it round-trips back as {"patternType":"none"} with no styles
 * part in the file at all. Styling is a SheetJS Pro feature. ExcelJS is MIT,
 * runs in the browser, and writes fills, fonts, borders and frozen panes.
 *
 * The server still reads uploads with SheetJS -- the GRN report is a legacy
 * BIFF8 .xls, which ExcelJS cannot open. Read there, write here.
 *
 * It is a dynamic import so Vite gives it its own chunk, fetched only when
 * someone presses Export rather than before the login screen can paint. Still
 * bundled, never fetched from a CDN: this has to work with no outbound internet.
 */
async function loadExcelJS() {
  const mod = await import('exceljs');
  return mod.default ?? mod;
}

export async function buildXlsx(rows, { sheetName = 'Reconciliation', columns = COLUMNS, title } = {}) {
  const ExcelJS = await loadExcelJS();
  const book = new ExcelJS.Workbook();
  book.creator = 'YH GRN Reconciliation';

  // Excel caps sheet names at 31 characters.
  // The merged band above the headers, when the layout groups its columns --
  // the same "Days taken" / "Reached" split the table carries. Derived from the
  // columns rather than passed in, so the two can never drift apart.
  const groups = [];
  for (const column of columns) {
    const label = column.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.span += 1;
    else groups.push({ label, span: 1 });
  }
  const hasGroups = groups.some((g) => g.label);

  const headerRows = (title ? 1 : 0) + (hasGroups ? 1 : 0) + 1;

  const sheet = book.addWorksheet(sheetName.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: headerRows }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0, // as many pages tall as it takes; never squeezed vertically
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  const lastCol = columns.length;

  // --- Row 1: the title band ----------------------------------------------
  if (title) {
    sheet.mergeCells(1, 1, 1, lastCol);
    const cell = sheet.getCell(1, 1);
    cell.value = title;
    cell.font = { name: FONT, size: 14, bold: true, color: { argb: PAPER } };
    cell.fill = solid(INK);
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    sheet.getRow(1).height = 26;
  }

  // --- The group band ------------------------------------------------------
  if (hasGroups) {
    const row = sheet.addRow([]);
    row.height = 18;
    let col = 1;
    for (const group of groups) {
      if (group.span > 1) sheet.mergeCells(row.number, col, row.number, col + group.span - 1);
      const cell = sheet.getCell(row.number, col);
      cell.value = group.label || null;
      cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: PAPER } };
      // The ungrouped stretch on the left takes the ink rather than the brand,
      // so the two named bands read as the bands and it reads as the gap.
      cell.fill = solid(group.label ? BRAND : INK);
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = BORDER;
      col += group.span;
    }
  }

  // --- The header row ------------------------------------------------------
  const header = sheet.addRow(columns.map((c) => c.label));
  header.height = 20;
  header.eachCell((cell) => {
    cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: PAPER } };
    cell.fill = solid(BRAND);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = BORDER;
  });

  // --- The data ------------------------------------------------------------
  rows.forEach((row, i) => {
    const line = sheet.addRow(columns.map((c) => toCell(row, c)));
    const banded = i % 2 === 1;

    line.eachCell({ includeEmpty: true }, (cell, col) => {
      const column = columns[col - 1];
      cell.font = { name: FONT, size: 10, color: { argb: INK } };
      cell.border = BORDER;
      if (banded) cell.fill = solid(BAND);

      if (column?.integer) {
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'center' };
      } else if (column?.numeric) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else {
        // Left, and wrapped for the one column that holds a sentence rather
        // than an identifier.
        cell.alignment = { horizontal: 'left', wrapText: column?.key === 'discrepancyNotes' };
      }
    });
  });

  // --- Column widths -------------------------------------------------------
  // Remarks carries a full sentence on the reconciliation tabs, so it gets room
  // to wrap into; the rest are sized off their header.
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width =
      c.key === 'discrepancyNotes' ? 42 : Math.max(12, Math.min(34, c.label.length + 8));
  });

  // Repeat the header on every printed page of a 1,200-row handout -- the group
  // band with it, or the second page's columns would have no band over them.
  if (title) sheet.pageSetup.printTitlesRow = `2:${headerRows}`;

  // No autofilter: the dropdown arrows sit on top of the header text, and a
  // filter left applied is a good way to hand someone a sheet that silently
  // hides rows. Excel's Data > Filter turns it on when it is actually wanted.

  return new Blob([await book.xlsx.writeBuffer()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Hand a finished blob to the browser as a download. */
function save(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetch the rows behind the selected tab, build the file, save it.
 *
 * @param {number|string} batchId
 * @param {string} status one of the STATUS values, or '' for every row
 * @param {string} [q] the search box, so the file matches what is on screen
 */
/**
 * The workbook for one tab.
 *
 * `status` is the tab -- it picks the layout and names the sheet. `rowStatus`
 * is which rows go into it, and is the same thing everywhere except Total GRNS
 * with its dropdown set, where the tab is still Total GRNS and the rows are
 * only one of its two halves. Defaulting it to `status` keeps every other
 * caller as it was.
 */
export async function exportResults(batchId, status, q, progress, rowStatus = status, location, spans = []) {
  const { name, rows: raw } = await api.exportRows(batchId, rowStatus, q, progress, location);

  // Turnaround rows carry their day counts under `gaps`; lift them to the top
  // level so the column keys resolve like every other column's.
  const rows =
    status === 'TURNAROUND'
      ? // The Total and the span counts are worked out here, from the same
        // helpers the table uses, so the file and the screen cannot disagree
        // about them. Both go in whether or not this layout has a column for
        // them; the columns decide what is written.
        raw.map((r) => ({
          ...r,
          ...r.gaps,
          totalDays: totalDays(r),
          ...Object.fromEntries(spans.map((span) => [spanId(span), spanDays(r, span)])),
        }))
      : raw;

  const report = titleForStatus(status);

  // Strip characters Windows rejects in a filename. The CSD stage joins the
  // name when one is chosen, so two exports taken from the same tab minutes
  // apart are not the same file with different contents.
  const safeName = String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  const fileName = `${[
    slug(report),
    // Named only when it narrows the tab, for the same reason the status filter
    // is: two files off the same tab minutes apart must not share a name and
    // differ in contents.
    rowStatus !== status && slug(rowStatus),
    progress && slug(progress),
    // Same rule for the spans: a GRNS SPAN file narrowed to PR-to-PO is not
    // the same report as the full one, so it must not arrive under its name.
    spans.length > 0 && slug(spans.map(spanLabel).join(' ')),
    safeName,
  ]
    .filter(Boolean)
    .join('_')}.xlsx`;

  const blob = await buildXlsx(rows, {
    sheetName: report,
    columns: columnsForStatus(status, spans),
    title: report,
  });
  save(blob, fileName);
}

/**
 * The CSD queue as a file, matching what is on screen.
 *
 * `all: true` because the queue is a handover list -- someone is working from
 * the whole of it, not from page three of it.
 *
 * sentAt is a timestamp rather than one of the ISO dates toCell knows how to
 * turn round, so it is flattened to a display string here; the same goes for
 * the status label, which the queue stores raw.
 */
export async function exportCsd(q, stage, location) {
  const { rows: raw } = await api.listCsd({ all: true, q, stage, location });

  // The four stamps are timestamps; the screen shows the day, so the file does
  // too. Flattened here because toCell only reads top-level keys, and `date:
  // true` is for the yyyy-MM-dd columns rather than for a timestamp.
  const day = (value) => {
    if (!value) return null;
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB') : null;
  };

  const rows = raw.map((r) => ({
    ...r,
    queueDate: day(r.sentAt),
    receivedDate: day(r.receivedAt),
    approvedDate: day(r.approvedAt),
    rejectedDate: day(r.rejectedAt),
  }));

  const report = titleForStatus('CSD');

  // The stage joins the name when one is chosen, so two exports taken minutes
  // apart are not the same file with different contents.
  const fileName = `${[slug(report), stage && slug(stage)].filter(Boolean).join('_')}.xlsx`;

  const blob = await buildXlsx(rows, {
    sheetName: report,
    columns: columnsForStatus('CSD'),
    title: report,
  });
  save(blob, fileName);
}
