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
 * spelling -- a pending row has no ageing counterpart, so the ageing columns
 * would all be blank, and the file is meant to be handed back to the stores as
 * the same sheet they sent, annotated.
 */
import { api } from '../api/client.js';
import { CHECKPOINTS, STAGE_KEYS, spanDays, spanId, spanLabel, stageLabel, totalDays } from './stages.js';
import { chequePrepared, paymentNotRequired } from './cheque.js';

/*
 * The GRNs / Cheques switch's two values. Spelled here rather than imported
 * from resultsViews.js, which imports this file -- and must match it, since
 * they are the same values the server's `view` parameter takes.
 */
const ACCOUNTS_GRN_VIEW = 'grn';
const ACCOUNTS_CHEQUE_VIEW = 'cheque';

const COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'divisionCode', label: 'Division' },
  { key: 'dprNo', label: 'GRN No (DPR.No)' },
  { key: 'poNo', label: 'PO No' },
  { key: 'dprDate', label: 'GRN Date', date: true },
  { key: 'billNo', label: 'Bill No' },
  { key: 'billDate', label: 'Bill Date', date: true },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  // The GRN report's own amount breakdown, in its source order -- see the
  // same four columns on GRN_COLUMNS below.
  { key: 'billAmount', label: 'Bill.Amount', numeric: true },
  { key: 'transportAmount', label: 'Transport Amount', numeric: true },
  { key: 'totalAmount', label: 'Total Amount', numeric: true },
  { key: 'addAmount', label: 'Add.Amount', numeric: true },
  { key: 'dedAmount', label: 'Ded.Amount', numeric: true },
  { key: 'ageingGrnNo', label: 'Focus doc_no' },
  { key: 'ageingBranchCode', label: 'Branch Code' },
  { key: 'ageingBillNo', label: 'Ageing Bill No' },
  { key: 'ageingVendorName', label: 'Ageing Vendor Name' },
  { key: 'billHandoverToAcc', label: 'Handed To Accounts', date: true },
];

/**
 * Valid GRNs -- both matched statuses, the ones that agree on the bill number
 * and the ones that do not. Every row here has an ageing entry, so the
 * accounts side leads throughout: Division carries the ageing
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
  // The report's own reference for the payment the cheque belongs to
  // ("Pmt:SE1/26-27/RTG/929"). Here rather than beside Focus doc_no so the
  // sheet runs in the same order as the table it is taken off.
  //
  // Text, for the reason Cheque No is: it is an identifier, and one that
  // carries colons and slashes Excel would otherwise try to read as something
  // else. PaymentDocNo, the ageing report's own spelling and the one the CSD
  // and register sheets already use -- one name for it across the workbook and
  // the screen, rather than a friendlier one on the sheet that happens to
  // mirror the table.
  { key: 'paymentDocNo', label: 'PaymentDocNo' },
  // Whether a cheque has been drawn up at all, which is the three columns
  // above read as one answer -- or, with none drawn up and nothing left to
  // pay, that none is needed. The same three answers the cheque cards count
  // by (see CHEQUE_PREPARED in routes/results.js). Derived rather than stored,
  // so it lives in toCell below.
  //
  // Right after the three it is read off, and before Cheque Status, which is
  // the next thing that happens to a cheque once one exists.
  { key: 'chequePrepared', label: 'Cheque Prepared' },
  // The bank statement's answer on that cheque. Blank when no statement carries
  // the number, which is not the same as "not cleared".
  { key: 'chequeStatus', label: 'Cheque Status' },
  { key: 'csdStage', label: 'CSD Status' },
];

/** The cheque's own columns, which GRN view leaves off -- as the table does. */
const CHEQUE_DETAIL_KEYS = new Set(['chequeNo', 'chqDate', 'paymentDocNo', 'accountNo']);

/** The Accounts sheet on GRN view: a row per GRN, without the cheque's columns. */
const ACCOUNTS_GRN_COLUMNS = MATCHED_COLUMNS.filter((c) => !CHEQUE_DETAIL_KEYS.has(c.key));

/**
 * The Accounts sheet on Cheque view: a row per cheque, the per-GRN columns
 * gone and the cheque's own in their place -- Cheque Amount being every
 * PayableAmount the cheque pays, summed on the server (see chequeRows in
 * routes/results.js).
 */
const ACCOUNTS_CHEQUE_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'divisionCode', label: 'Division' },
  { key: 'chequeNo', label: 'Cheque No' },
  { key: 'chequeGrnCount', label: 'GRNs', integer: true },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'chqDate', label: 'Cheque Date', date: true },
  { key: 'chequeAmount', label: 'Cheque Amount', numeric: true },
  { key: 'paymentDocNo', label: 'PaymentDocNo' },
  { key: 'accountNo', label: 'Account No' },
  { key: 'chequeStatus', label: 'Cheque Status' },
  { key: 'csdStage', label: 'CSD Status' },
];

/**
 * The GRN report's own columns, in its own order, spelled exactly as the source
 * file spells them -- "Bill  No" really does carry two spaces and " Total
 * Amount" a leading one.
 *
 * Differences from the source, all deliberate: DPR.Date / Bill.Date and
 * Location are dropped -- the batch is one month's GRNs and neither is what
 * anyone chasing a pending GRN reads. The reconciliation layout above keeps
 * its dates, since a row there is being compared against an ageing entry.
 * Division is appended right after Warehouse -- a pending row has no ageing
 * entry to read a DivisionCode off, so it falls back to the configuration
 * screen's resolved branch code (see the `divisionCode` case in toCell).
 *
 * Sl.No goes too. It is the source workbook's row number, and nothing the
 * reader is looking at is that workbook any more: a sheet here is the pending
 * half of every upload combined, or one desk's share of it, so the numbers
 * arrive starting wherever the first row happened to fall and full of gaps
 * where the rows between went to another sheet. That reads as rows missing
 * rather than as the source's numbering, and it is not on screen either -- the
 * reconciliation table has never carried it. Anyone wanting to count the rows
 * has Excel's own numbers down the side. The BPAD layout below drops its own
 * Sl.No. for the same reason.
 */
const GRN_COLUMNS = [
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'divisionCode', label: 'Division' },
  { key: 'dprNo', label: 'DPR.No' },
  { key: 'poNo', label: 'PO.No' },
  { key: 'billNo', label: 'Bill  No' },
  { key: 'dcNo', label: 'DC No' },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'billAmount', label: 'Bill.Amount', numeric: true },
  { key: 'transportAmount', label: 'Transport Amount', numeric: true },
  { key: 'totalAmount', label: ' Total Amount', numeric: true },
  { key: 'addAmount', label: 'Add.Amount', numeric: true },
  { key: 'dedAmount', label: 'Ded.Amount', numeric: true },
];

/**
 * The BPAD register's own columns, in the register's own order and spelled the
 * way it spells them -- the same reasoning as GRN_COLUMNS above: the sheet is
 * meant to be checkable against the file it was extracted from, and reordering
 * or renaming its columns would make that harder rather than easier.
 *
 * Division leads, as it does on the tab and on every other sheet: it is the
 * branch resolved through the GRN row each record matched, since the
 * register's own Location beside it is a short site code rather than a branch.
 *
 * The register's own Sl.No. is dropped, as the GRN report's is above and for
 * the same reason: a sheet here is every upload's records together, or one
 * desk's share of them, so the register's numbering arrives starting wherever
 * the first row fell and full of gaps where the rows between went elsewhere.
 * It is off the tab too. The rows still come back in that order -- see
 * bpadRows on the server -- so the sheet is still checkable against the file
 * it was extracted from, by the register's own columns rather than by a serial
 * that no longer runs 1, 2, 3.
 *
 * The register's own QueryAgeing, Ageing and GRN Age used to close the sheet.
 * They are gone from the whole feature -- the register recomputes them from
 * dates it also carries, so an exported copy was only true on the day the file
 * was uploaded.
 */
const BPAD_COLUMNS = [
  { key: 'branchDivisionCode', label: 'Division' },
  { key: 'location', label: 'Location' },
  { key: 'warehouse', label: 'WareHouse' },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'vendorName', label: 'Vendor Name' },
  { key: 'vendorCategory', label: 'Vendor Category' },
  { key: 'invNo', label: 'Inv.No.' },
  { key: 'invDate', label: 'Inv Date', date: true },
  { key: 'grnNo', label: 'GRN No' },
  { key: 'grnDate', label: 'GRN Date', date: true },
  { key: 'grnAmount', label: 'GRN Amount', numeric: true },
  { key: 'poNumber', label: 'PO Number' },
  { key: 'poDate', label: 'PO Date', date: true },
  { key: 'pendingWithDept', label: 'Pending With Dept.' },
  { key: 'bpadReceivedDate', label: 'BPAD Received Date', date: true },
  { key: 'accountsReceivedDate', label: 'Accounts Received Date', date: true },
  { key: 'pendingWithUser', label: 'Pending With User/Status' },
  { key: 'pendReason', label: 'Pend.Reason/Pend Dept' },
  // Days from GRN Date, per desk -- see BPAD_AGEING_SQL on the server.
  { key: 'ageing', label: 'Ageing', integer: true },
];

/**
 * What every Turnaround file carries, whatever it is measuring: the thirteen
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
  { key: 'billDate', label: 'Bill Date', date: true, group: 'Particulars' },
  { key: 'vendorName', label: 'Vendor', group: 'Particulars' },
  { key: 'vendorCode', label: 'Vendor Code', group: 'Particulars' },
  // The ageing report's own amount breakdown, ahead of PayableAmount -- the
  // same order as NetAmt through PayableAmount on the CSD and Valid GRNs tabs.
  { key: 'netAmt', label: 'NetAmt', numeric: true, group: 'Particulars' },
  { key: 'adjPurReturn', label: 'AdjPurReturn', numeric: true, group: 'Particulars' },
  { key: 'adjustedJv', label: 'AdjustedJV', numeric: true, group: 'Particulars' },
  { key: 'tdsJv', label: 'TDSJV', numeric: true, group: 'Particulars' },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true, group: 'Particulars' },
  { key: 'chequeNo', label: 'Cheque No', group: 'Particulars' },
  // The ageing report's payment document number, right after the cheque it
  // belongs to.
  { key: 'paymentDocNo', label: 'PaymentDocNo', group: 'Particulars' },
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
 * worked out row by row, so sheetRows flattens both up a level before
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
  { key: 'ageingGrnNo', label: 'Focus doc_no' },
  { key: 'netAmt', label: 'NetAmt', numeric: true },
  { key: 'adjPurReturn', label: 'AdjPurReturn', numeric: true },
  { key: 'adjustedJv', label: 'AdjustedJV', numeric: true },
  { key: 'tdsJv', label: 'TDSJV', numeric: true },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true },
  { key: 'paymentDocNo', label: 'PaymentDocNo' },
  { key: 'chequeNo', label: 'Cheque No' },
  { key: 'chqDate', label: 'Cheque Date', date: true },
  { key: 'accountNo', label: 'Account No' },
  { key: 'stage', label: 'Status' },
  { key: 'queueDate', label: 'Queue Date' },
  { key: 'receivedDate', label: 'Received Date' },
  { key: 'approvedDate', label: 'Approved Date' },
  { key: 'rejectedDate', label: 'Rejected Date' },
  { key: 'movedToAccountsDate', label: 'Moved To Accounts Date' },
];

/** The CSD file on GRN view: without the cheque's columns, as the table. */
const CSD_GRN_COLUMNS = CSD_COLUMNS.filter((c) => !CHEQUE_DETAIL_KEYS.has(c.key));

/** The CSD file on Cheque view: a row per cheque, as the table. */
const CSD_CHEQUE_COLUMNS = [
  { key: 'divisionCode', label: 'Division' },
  { key: 'chequeNo', label: 'Cheque No' },
  { key: 'chequeGrnCount', label: 'GRNs', integer: true },
  { key: 'vendorName', label: 'Vendor' },
  { key: 'vendorCode', label: 'Vendor Code' },
  { key: 'chqDate', label: 'Cheque Date', date: true },
  { key: 'chequeAmount', label: 'Cheque Amount', numeric: true },
  { key: 'paymentDocNo', label: 'PaymentDocNo' },
  { key: 'accountNo', label: 'Account No' },
  { key: 'stage', label: 'Status' },
  { key: 'queueDate', label: 'Queue Date' },
  { key: 'receivedDate', label: 'Received Date' },
  { key: 'approvedDate', label: 'Approved Date' },
  { key: 'rejectedDate', label: 'Rejected Date' },
  { key: 'movedToAccountsDate', label: 'Moved To Accounts Date' },
];

/**
 * Per-row, from the stored status. Valid GRNs holds both matched statuses, but
 * both read the same here -- a GRN found in the ageing report has moved to
 * accounts regardless of whether its bill number agrees.
 */
const STATUS_LABELS = {
  MATCHED: 'Moved to accounts',
  MATCHED_WITH_DIFF: 'Moved to accounts',
  PENDING: 'Not received by Accounts',
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
  MOVED_TO_ACCOUNTS: 'Moved to accounts',
};

const CSD_STAGE_LABELS = {
  QUEUED: 'Sent to CSD',
  RECEIVED: 'CSD received',
  APPROVED: 'CSD approved',
  REJECTED: 'CSD rejected',
  // Not "Moved to accounts": on this export that phrase already names a
  // different fact (see STATUS_LABELS above), so this names who sent it back
  // instead. Overridden below once Accounts has acknowledged the hand-back.
  MOVED_TO_ACCOUNTS: 'Handover by CSD',
};

/**
 * Where Accounts sent a forwarded GRN on to -- see the matching helper in
 * ResultsTable.jsx. Not "Moved to accounts" or "Accounts received": both
 * exports still spell this per their own two labels above, so the shared
 * fact under all three names is that a Vendor hand-off further splits by
 * `forwardedRoute`, which BANK and OTHERS have no equivalent of.
 */
const FORWARD_LABELS = { BANK: 'Sent to Bank', OTHERS: 'Sent to Others', COURIER: 'Sent to Courier' };

function forwardedLabel(forwardedTo, forwardedRoute) {
  if (forwardedTo === 'VENDOR') {
    return forwardedRoute === 'PURCHASE_DEPT' ? 'Sent to Purchase Dept' : 'Sent to Vendor';
  }
  return FORWARD_LABELS[forwardedTo] || null;
}

/**
 * The title written above the column headers, the way the source reports carry
 * a title block above theirs.
 */
const TITLES = {
  ALL: 'Total GRNS Report',
  VALID: 'Accounts Report',
  PENDING: 'GRN Pendings Report',
  TURNAROUND: 'GRN Age From GRN to Accounts Report',
  BPAD: 'BPAD Register Report',
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
export function columnsForStatus(status, spans = [], view) {
  if (status === 'PENDING') return GRN_COLUMNS;
  if (status === 'TURNAROUND') return turnaroundColumns(spans);
  // `view` is the GRNs / Cheques switch, where the screen has one; without it
  // a sheet carries every column, as before.
  if (status === 'VALID') {
    if (view === ACCOUNTS_CHEQUE_VIEW) return ACCOUNTS_CHEQUE_COLUMNS;
    if (view === ACCOUNTS_GRN_VIEW) return ACCOUNTS_GRN_COLUMNS;
    return MATCHED_COLUMNS;
  }
  if (status === 'BPAD') return BPAD_COLUMNS;
  if (status === 'CSD') {
    if (view === ACCOUNTS_CHEQUE_VIEW) return CSD_CHEQUE_COLUMNS;
    if (view === ACCOUNTS_GRN_VIEW) return CSD_GRN_COLUMNS;
    return CSD_COLUMNS;
  }
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

  // The ageing report's own DivisionCode where the row has one, and the
  // configuration screen's resolved branch code where it does not -- see
  // branchDivisionCode on the server. One column rather than two, because a
  // reader wants to know the branch, not which report happened to carry it.
  if (column.key === 'divisionCode') return row.divisionCode ?? row.branchDivisionCode ?? null;
  if (column.key === 'status') return STATUS_LABELS[row.status] || row.status;
  // The CSD layout carries the same verdict under its own name, to leave
  // `status` free for CSD's progress -- which is stored ready to read.
  if (column.key === 'matchStatus') return STATUS_LABELS[row.matchStatus] || row.matchStatus;
  // 'Not sent', not blank: a reader filtering this column wants the GRNs that
  // never went as much as the ones that did, and an empty cell reads as missing
  // data rather than as an answer.
  if (column.key === 'csdStage') {
    // Accounts' own acknowledgement and forwarding, once CSD is done -- see
    // csdAccountsStage/csdForwardedTo handling in ResultsTable.jsx. "Not sent"
    // is the one label not stored in CSD_STAGE_LABELS, for a row with no
    // dispatch at all.
    if (row.csdStage === 'MOVED_TO_ACCOUNTS' && row.csdForwardedTo) {
      return forwardedLabel(row.csdForwardedTo, row.csdForwardedRoute);
    }
    if (row.csdStage === 'MOVED_TO_ACCOUNTS' && row.csdAccountsStage === 'RECEIVED') {
      return 'Accounts received';
    }
    return CSD_STAGE_LABELS[row.csdStage] || 'Not sent';
  }
  if (column.key === 'chequeStatus') return CHEQUE_STATUS_LABELS[row.chequeStatus] ?? null;
  // Words rather than Yes/No: this is read by people, and Excel's filter
  // dropdown should offer the answer rather than make one up from the
  // heading. Null where the question does not apply
  // -- see chequePrepared, which is also what gates the Send picker's CSD
  // option.
  if (column.key === 'chequePrepared') {
    const prepared = chequePrepared(row);
    if (prepared === null) return null;
    if (prepared) return 'Prepared';
    // The same three answers as the cards, so a sheet taken off Payment Not
    // Required does not read "Not prepared" all the way down.
    return paymentNotRequired(row) ? 'Payment not required' : 'Not prepared';
  }
  if (column.key === 'stage') {
    // The CSD queue's own row shape names these fields `accountsStage` and
    // `forwardedTo` (see mapDispatch in routes/csd.js), not the `csd`-prefixed
    // names above -- those only exist on the results row, which carries a
    // GRN's own fields alongside its CSD dispatch's.
    if (row.stage === 'MOVED_TO_ACCOUNTS' && row.forwardedTo) {
      return forwardedLabel(row.forwardedTo, row.forwardedRoute);
    }
    if (row.stage === 'MOVED_TO_ACCOUNTS' && row.accountsStage === 'RECEIVED') {
      return 'Accounts received';
    }
    return CSD_QUEUE_LABELS[row.stage] || row.stage;
  }
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
const INK = '2D5080'; // --umber-900, warm near-black
const BRAND = '2D5080'; // --brand
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

/**
 * One worksheet, added to an already-open workbook.
 *
 * Split out of buildXlsx so a multi-tab export (see buildWorkbook below) can
 * add several sheets -- one per UI tab -- to a single file rather than
 * opening a workbook per sheet and writing several files.
 */
function addSheet(book, rows, { sheetName = 'Reconciliation', columns = COLUMNS, title } = {}) {
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

  const sheet = book.addWorksheet(sheetName.trim().slice(0, 31), {
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
  // Filled cell by cell rather than merged, so the row stays a normal row of
  // cells -- selectable and filterable one column at a time -- with the ink
  // fill carried across all of them for the same banner look a merge gave.
  if (title) {
    const row = sheet.getRow(1);
    for (let col = 1; col <= lastCol; col += 1) {
      row.getCell(col).fill = solid(INK);
    }
    const cell = row.getCell(1);
    cell.value = title;
    cell.font = { name: FONT, size: 14, bold: true, color: { argb: PAPER } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    row.height = 26;
  }

  // --- The group band ------------------------------------------------------
  if (hasGroups) {
    const row = sheet.addRow([]);
    row.height = 26;
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
  header.height = 24;
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
      cell.font = { name: FONT, size: 10, color:"#0b1017" };
      cell.border = BORDER;
      if (banded) cell.fill = solid(BAND);

      if (column?.integer) {
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'center' };
      } else if (column?.numeric) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else {
        cell.alignment = { horizontal: 'left' };
      }
    });
  });

  // --- Column widths -------------------------------------------------------
  // Sized off each column's own header.
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = Math.max(12, Math.min(34, c.label.length + 8));
  });

  // Repeat the header on every printed page of a 1,200-row handout -- the group
  // band with it, or the second page's columns would have no band over them.
  if (title) sheet.pageSetup.printTitlesRow = `2:${headerRows}`;

  // No autofilter: the dropdown arrows sit on top of the header text, and a
  // filter left applied is a good way to hand someone a sheet that silently
  // hides rows. Excel's Data > Filter turns it on when it is actually wanted.

  return sheet;
}

/** One tab's worth of rows, in a workbook of its own. */
export async function buildXlsx(rows, opts = {}) {
  const ExcelJS = await loadExcelJS();
  const book = new ExcelJS.Workbook();
  book.creator = 'YH GRN Reconciliation';
  addSheet(book, rows, opts);
  return new Blob([await book.xlsx.writeBuffer()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Every tab in one workbook, each on its own sheet named the way the results
 * page's tab strip names it -- so the file reads the same way the screen does,
 * and a reader on one sheet can flip to the next tab's numbers rather than
 * hunting through a folder of separate downloads for it.
 *
 * `sheets` is `[{ sheetName, rows, columns, title }]`, in the order the sheets
 * should appear.
 */
export async function buildWorkbook(sheets) {
  const ExcelJS = await loadExcelJS();
  const book = new ExcelJS.Workbook();
  book.creator = 'YH GRN Reconciliation';
  const taken = new Set();
  for (const s of sheets) addSheet(book, s.rows, { ...s, sheetName: uniqueSheetName(s.sheetName, taken) });
  return new Blob([await book.xlsx.writeBuffer()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** The characters Excel will not have in a sheet name. */
const SHEET_NAME_ILLEGAL = /[\\/?*:[\]]/g;

/**
 * A card's label, as a sheet name Excel will accept.
 *
 * Sheet names come from whatever the cards are called, and two of those are
 * outside this file's control: the BPAD desks are the register's own wording
 * ("PURCHASE DEPARTMENT", and whatever the next upload spells), and a desk
 * named with a slash would have the workbook rejected outright rather than
 * renamed. So the illegal characters go, the 31-character cap is applied, and
 * a collision takes a number -- because Excel will not have two sheets of one
 * name either, and two desks whose names agree for 31 characters is a thing
 * a register can do.
 */
function uniqueSheetName(label, taken) {
  const base =
    String(label ?? '')
      .replace(SHEET_NAME_ILLEGAL, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet';

  // Excel compares sheet names case-insensitively, so the register's ACCOUNTS
  // and a tab's Accounts are the same name to it.
  const key = (name) => name.toLowerCase();
  if (!taken.has(key(base))) {
    taken.add(key(base));
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    if (!taken.has(key(name))) {
      taken.add(key(name));
      return name;
    }
  }
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
 * One sheet's rows, ready for it.
 *
 * A sheet is described by which view's rows it holds (`status`) and which of
 * that view's cards narrowed them -- `progress` for a CSD stage or the cheque
 * pair, `dept` for a BPAD desk, `register` for the GRNs the register never
 * knew. Nothing narrowing is the view's own sheet. See sectionSheets in
 * services/resultsViews.js, which turns the cards into these.
 *
 * Turnaround rows carry their day counts under `gaps`; lifted to the top
 * level here so the column keys resolve like every other column's, the same
 * way the table itself reads them.
 */
async function sheetRows(batchId, spec, { q, location, spans, view }) {
  const { name, rows: raw } = await api.exportRows(batchId, spec.status, {
    q,
    location,
    progress: spec.progress,
    dept: spec.dept,
    register: spec.register,
    view,
  });
  const rows =
    spec.status === 'TURNAROUND'
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
  return { name, rows };
}

/**
 * How many sheets are fetched at once.
 *
 * Every sheet is an unpaginated query over the whole scope, and a section can
 * carry a dozen cards -- the Pending view has one per desk the register names.
 * All of them at once is a dozen full table scans landing together, which is
 * how one person pressing Export makes the page slow for everybody else. Four
 * keeps the file quick to build without doing that.
 */
const SHEET_FETCH_LIMIT = 4;

/** `work` over every item, at most SHEET_FETCH_LIMIT at a time, in order. */
async function inBatches(items, work) {
  const out = [];
  for (let i = 0; i < items.length; i += SHEET_FETCH_LIMIT) {
    out.push(...(await Promise.all(items.slice(i, i + SHEET_FETCH_LIMIT).map(work))));
  }
  return out;
}

/**
 * The section on screen as one workbook: its own sheet first, then a sheet
 * per card standing over it, in the order the row shows them.
 *
 * A section's cards are how that section divides up -- Total GRNS into the
 * registers each GRN has reached, Accounts into how far through the handover
 * each row has got, Pending into the desk each bill is sitting at -- and the
 * file is that reading of it. So Export Excel hands back the view somebody is
 * actually looking at, card by card, rather than one fixed workbook of every
 * view regardless of where they were when they pressed it. Which is also why
 * it is per section: a reader on Total GRNS was not asking about CSD stages,
 * and eleven sheets to find the four they wanted is a worse answer than four.
 *
 * `sheets` is `[{ sheetName, status, progress, dept, register, title }]` --
 * built by sectionSheets in services/resultsViews.js out of the same card
 * declarations the row on screen is rendered from, so a card renamed or
 * reordered there moves its sheet with it and nothing here has to be edited.
 * The first entry is the section itself, and it names the file.
 *
 * Only `q` and `location` travel across every sheet: they are the page's
 * scope. The dropdown filters are left out, the same as before -- each sheet
 * carries its own card's narrowing and nothing else, so a section's sheets
 * always divide that section whole rather than whatever was left after a
 * dropdown had already cut it down.
 */
export async function exportSection(batchId, sheets, { q, location, spans = [], accountsView } = {}) {
  // The GRNs / Cheques switch reaches the Accounts sheets only: those are the
  // rows it changes on screen.
  const viewFor = (s) => (s.status === 'VALID' ? accountsView : undefined);
  const fetched = await inBatches(sheets, (s) =>
    sheetRows(batchId, s, {
      q,
      location,
      spans,
      view: viewFor(s) === ACCOUNTS_CHEQUE_VIEW ? ACCOUNTS_CHEQUE_VIEW : undefined,
    }),
  );
  const name = fetched.find((f) => f.name)?.name ?? '';

  const built = sheets.map((s, i) => ({
    sheetName: s.sheetName,
    rows: fetched[i].rows,
    columns: columnsForStatus(s.status, spans, viewFor(s)),
    // A card's sheet says which card it is above its headers; a section's own
    // sheet is just the report.
    title: s.title ?? titleForStatus(s.status),
  }));

  // Named after the section it was taken off, so two sections' files do not
  // land in Downloads under one name.
  const report = slug(sheets[0]?.title ?? titleForStatus(sheets[0]?.status)) || 'GRN_Report';

  // Strip characters Windows rejects in a filename.
  const safeName = String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  const fileName = `${[
    report,
    // An ageing sheet narrowed to PR-to-PO is not the same report as the full
    // one, so it must not arrive under the same name. Only where the workbook
    // actually carries that sheet: the span picker belongs to that one view,
    // and a Total GRNS file is not about PR-to-PO whatever the picker was left
    // set to.
    spans.length > 0 &&
      sheets.some((s) => s.status === 'TURNAROUND') &&
      slug(spans.map(spanLabel).join(' ')),
    // A cheque-per-row file is a different report from a GRN-per-row one.
    accountsView === ACCOUNTS_CHEQUE_VIEW && sheets.some((s) => s.status === 'VALID') && 'Cheque_View',
    safeName,
  ]
    .filter(Boolean)
    .join('_')}.xlsx`;

  const blob = await buildWorkbook(built);
  save(blob, fileName);
}

/** The activity log's sheet, column for column with its screen. */
const LOG_COLUMNS = [
  { key: 'time', label: 'Time' },
  { key: 'userName', label: 'User' },
  { key: 'username', label: 'Username' },
  { key: 'categoryLabel', label: 'Category' },
  { key: 'actionLabel', label: 'Action' },
  { key: 'target', label: 'Target' },
  { key: 'summary', label: 'Summary' },
  { key: 'detailText', label: 'Details' },
];

/**
 * The activity log as a file, with the screen's filters applied.
 *
 * `describe` turns one entry's details into readable text -- passed in by the
 * screen so the file and the page word them identically.
 */
export async function exportLogs(filters, describe) {
  const data = await api.listLogs({ ...filters, all: true });
  const categoryLabels = Object.fromEntries((data.categories ?? []).map((c) => [c.key, c.label]));
  const stamp = (value) => {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return null;
    return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const rows = data.rows.map((r) => ({
    ...r,
    time: stamp(r.createdAt),
    userName: r.userName || r.username,
    categoryLabel: categoryLabels[r.category] || r.category,
    detailText: describe(r.details).join('\n') || null,
  }));

  const report = 'Activity Logs';
  const blob = await buildXlsx(rows, { sheetName: report, columns: LOG_COLUMNS, title: report });
  save(blob, `${slug(report)}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return { count: rows.length, truncated: Boolean(data.truncated), total: data.total };
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
export async function exportCsd(q, stage, location, view) {
  const { rows: raw } = await api.listCsd({
    all: true,
    q,
    stage,
    location,
    view: view === ACCOUNTS_CHEQUE_VIEW ? ACCOUNTS_CHEQUE_VIEW : undefined,
  });

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
    movedToAccountsDate: day(r.movedToAccountsAt),
  }));

  const report = titleForStatus('CSD');

  // The stage joins the name when one is chosen, so two exports taken minutes
  // apart are not the same file with different contents.
  const fileName = `${[slug(report), stage && slug(stage), view === ACCOUNTS_CHEQUE_VIEW && 'Cheque_View']
    .filter(Boolean)
    .join('_')}.xlsx`;

  const blob = await buildXlsx(rows, {
    sheetName: report,
    columns: columnsForStatus('CSD', [], view),
    title: report,
  });
  save(blob, fileName);
}
