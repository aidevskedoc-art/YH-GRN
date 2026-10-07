/**
 * Readers for OP Pharmacy's reports.
 *
 * The pharmacies run the same reconciliation as the hospitals from the same
 * four kinds of file, but three of the four come out of different systems and
 * are laid out differently:
 *
 *   GRN Purchase report   the pharmacy system's purchase register. A GRN is a
 *                         FeedNo ("HE00184") rather than a DPR.No, the bill is
 *                         InvNo, and the vendor arrives under two codes -- PM
 *                         Code, the pharmacy system's own, and FocusCode, the
 *                         accounts system's.
 *   Vendor Age report     FOCUS's ageing export for the pharmacy division. It
 *                         leaves GRN_NO empty on every row; the GRN number is
 *                         inside GRNDoc instead ("PSE/26-27/HE00184").
 *   BPAD bill status      the same register the hospitals' BPAD is, with two
 *                         columns spelled differently and times on its dates.
 *
 * The bank statement is HDFC's own layout either way, so readBankStatement in
 * services/excelParser.js reads the pharmacies' as it reads the hospitals'.
 *
 * Every reader returns rows under the names the hospital readers use -- dprNo
 * for the GRN number, billNo for the bill -- because what is stored and
 * reconciled is the same thing under either spelling, and the rest of the
 * upload (services/phIngest.js, reconcile.js) is written against those names.
 * What a pharmacy report has and a hospital one does not rides along under a
 * name of its own.
 */
import { toText, toNumber, normKey, normVendorName, toIsoDateString } from './normalize.js';
import { ExcelFormatError, readGrid, findHeaderRow, indexHeaders, makeGetter } from './excelParser.js';

/* Column names that identify each report's header row. Every heading in all
   three reports is compared with its whitespace removed and in capitals, so a
   column is found whether its heading is spaced or not: "PM Code" and "PMCode"
   are one column, and so are "GRN No" and "GRNNo". Which is why every name a
   reader below asks for is written closed up. */
const PH_GRN_SIGNATURE = ['FEEDNO', 'INVNO', 'NETAMT'];
const PH_AGEING_SIGNATURE = ['GRNDOC', 'BILLNO', 'VENDORNAME'];
const PH_BPAD_SIGNATURE = ['GRNNO', 'VENDORCODE', 'GRNAMOUNT'];

/*
 * Columns the GRN Purchase report must carry, beyond the three its header row
 * is found by. A report without one of them is refused rather than stored
 * with the column empty:
 *
 *   Type        the purchase type, Cash or Credit. The report always heads
 *               the column "Type", and that is the only heading taken. It is
 *               stored as purchase_type and shown on screen as Purchase Type:
 *               "Type" on its own says nothing once it is out of the report.
 *   PM Code     the vendor's code in the pharmacy system, which is what a GRN
 *               is matched to the BPAD status by. Without it no status row can
 *               match any of the report's GRNs.
 *   Unit Name   the branch, as Ph-Configuration's Unit name (HIS) finds it.
 *               Without it no GRN belongs to a branch.
 *
 * Kept apart from the signature so that a report missing one is recognised as
 * the purchase register and told which column it lacks, instead of being
 * turned away as a file that is not the purchase register at all.
 */
const PH_GRN_REQUIRED = [
  { label: 'Type', tokens: ['TYPE'] },
  { label: 'PM Code', tokens: ['PMCODE'] },
  { label: 'Unit Name', tokens: ['UNITNAME'] },
];

/*
 * The column the Vendor Age report must carry beyond the three its header row
 * is found by. DivisionCode is the report's name for the branch -- the Branch
 * code (Focus) on Ph-Configuration -- and a row is matched to a GRN only when
 * it and the GRN's Unit Name are one configured branch's (see verdictsFor in
 * services/phIngest.js). A report without the column could match nothing, so
 * it is refused rather than stored.
 */
const PH_AGEING_REQUIRED = [{ label: 'DivisionCode', tokens: ['DIVISIONCODE'] }];

/** "A", "A and B", "A, B and C". */
function listed(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A time of day trailing a date written as text: "27/08/2026 12:00:00AM". */
const TIME_SUFFIX = /^(.*?)\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?$/i;

/**
 * A date cell to yyyy-MM-dd, whatever time of day it carries.
 *
 * The BPAD status stamps its two received dates with the time -- 46260.7772 is
 * the day and the fraction of it gone -- and toIsoDateString rounds a serial to
 * the nearest day, which would file anything received after noon under the day
 * after. The day is the whole part, so that is what is kept. A date written as
 * text loses a trailing time the same way.
 */
function phDate(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? toIsoDateString(Math.floor(value)) : null;
  }
  const m = TIME_SUFFIX.exec(toText(value));
  return toIsoDateString(m ? m[1] : value);
}

/**
 * Parse the GRN Purchase report (file 01, "Purchase Register With
 * Percentages").
 *
 * Columns: Type, InvNo, InvDate, FeedNo, FeedDate, Name, GstIn, the taxable
 * value and tax at each GST rate, TotTaxable, CGst, SGst, IGSt, TcsAmt, NetAmt,
 * FocusCode, PM Code, Unit Name.
 *
 * Six of them are required: FeedNo, InvNo and NetAmt, which the header row is
 * found by, and Type, PM Code and Unit Name (see PH_GRN_REQUIRED). The column
 * has to be there; a row that leaves one of them blank is still stored.
 *
 * `purchaseType` is the Type column: Cash or Credit.
 *
 * The per-rate taxable values and taxes are read past: they add up to
 * TotTaxable and the three GST totals, which are kept, and nothing about
 * whether a GRN has reached accounts turns on the rate it was taxed at.
 *
 * `vendorCode` is PM Code, not FocusCode. It is the code the BPAD status files
 * a bill under, which is what a vendor code on a GRN is matched by (see
 * grnMatchKeys in routes/phBatches.js) -- as the hospitals' GRN report's
 * Vendor Code is. FocusCode, the ageing report's VendorCode, is kept beside it.
 *
 * `location` is Unit Name ("Secunderabad"): the stores side's name for the
 * branch, which is what the hospitals' GRN report's Location is.
 */
export function readPhGrnReport(buffer) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, PH_GRN_SIGNATURE, true);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like the GRN Purchase report - could not find a header row containing FeedNo, InvNo and NetAmt.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], true);

  const missing = PH_GRN_REQUIRED.filter((column) => !column.tokens.some((token) => index.has(token)));
  if (missing.length > 0) {
    throw new ExcelFormatError(
      `Required column${missing.length === 1 ? '' : 's'} missing - ${listed(missing.map((c) => c.label))}. ` +
        'The GRN Purchase report must have FeedNo, InvNo, NetAmt, Type, PM Code and Unit Name.',
    );
  }

  const rows = [];

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);
    const feedNo = toText(get('FEEDNO'));
    if (!feedNo) continue; // blank spacers and any trailing total row

    rows.push({
      sourceRowNo: i + 1,
      purchaseType: toText(get('TYPE')),
      dprNo: feedNo,
      dprNoKey: normKey(feedNo),
      dprDate: phDate(get('FEEDDATE')),
      billNo: toText(get('INVNO')),
      billNoKey: normKey(get('INVNO')),
      billDate: phDate(get('INVDATE')),
      vendorCode: toText(get('PMCODE')),
      focusCode: toText(get('FOCUSCODE')),
      vendorName: toText(get('NAME')),
      vendorNameKey: normVendorName(get('NAME')),
      gstin: toText(get('GSTIN')),
      totTaxable: toNumber(get('TOTTAXABLE')),
      cgst: toNumber(get('CGST')),
      sgst: toNumber(get('SGST')),
      igst: toNumber(get('IGST')),
      tcsAmt: toNumber(get('TCSAMT')),
      totalAmount: toNumber(get('NETAMT')),
      location: toText(get('UNITNAME')),
      // The unit folded for comparison. With the GRN number it is what a
      // pharmacy GRN is known by: the units number their FeedNos separately,
      // so one number under two units is two GRNs.
      unitKey: normKey(get('UNITNAME')),
    });
  }

  if (rows.length === 0) throw new ExcelFormatError('The GRN Purchase report contains no data rows.');

  return { sheetName, headerRow: headerIdx + 1, headers, rows };
}

/**
 * The ageing report's GRNDoc, taken apart.
 *
 * "PSE/26-27/HE00195/A": the division the document was raised in, the
 * financial year, the GRN number -- the purchase register's FeedNo -- and, on a
 * document accounts booked again, a mark saying so. The GRN number is the third
 * part. A document written any other way gives its last part, so a shape nobody
 * has seen yet still has a number to be matched by rather than none.
 */
function splitGrnDoc(grnDoc) {
  const parts = toText(grnDoc)
    .split('/')
    .map((part) => part.trim());
  if (parts.length >= 3) return { docPrefix: parts[0], grnNumber: parts[2] };
  return { docPrefix: '', grnNumber: parts[parts.length - 1] };
}

/**
 * Parse the pharmacies' Vendor Age report (file 00).
 *
 * Columns: Division, DivisionCode, VendorName, VendorCode, GRNDoc, GRN_NO,
 * BillNo, BillDate, NetAmt, AdjPurReturn, AdjustedJV, TDSJV, PayableAmount,
 * PaymentDocNo, ChequeNo, ChqDate, Cheque_ClearanceDate, PaymentAmt,
 * AdvancePaymentAmt, balance.
 *
 * Four of them are required: GRNDoc, BillNo and VendorName, which the header
 * row is found by, and DivisionCode (see PH_AGEING_REQUIRED).
 *
 * GRN_NO is there and empty, so the GRN number comes out of GRNDoc -- see
 * splitGrnDoc -- and GRNDoc is where it is taken from even on a report that
 * does fill GRN_NO in. GRN_NO is read only for a row whose GRNDoc is empty,
 * less the division code where that really is its prefix. Either way `grnNo`
 * is the GRN number itself -- "HE00184", the purchase register's FeedNo --
 * which is what the GRN No column stores and Pharmacy Results shows.
 *
 * The report has none of the hospitals' stage dates (IndentDate through
 * BillHandOverToAcc) and no StoreName. They are looked for anyway and come out
 * empty: the rows are stored in the same shape as the hospitals', and a later
 * export that grows one of those columns then fills it without a change here.
 *
 * The Grand Total row at the foot has neither a GRNDoc nor a GRN_NO, which is
 * what leaves it out.
 */
export function readPhAgeingReport(buffer) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, PH_AGEING_SIGNATURE, true);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like the Vendor Age report - could not find a header row containing GRNDoc, BillNo and VendorName.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], true);

  const missing = PH_AGEING_REQUIRED.filter((column) => !column.tokens.some((token) => index.has(token)));
  if (missing.length > 0) {
    throw new ExcelFormatError(
      `Required column${missing.length === 1 ? '' : 's'} missing - ${listed(missing.map((c) => c.label))}. ` +
        'The Vendor Age report must have GRNDoc, BillNo, VendorName and DivisionCode.',
    );
  }

  const rows = [];

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);
    const grnDoc = toText(get('GRNDOC'));
    const grnNoCell = toText(get('GRN_NO'));
    if (!grnDoc && !grnNoCell) continue;

    const divisionCode = toText(get('DIVISIONCODE'));
    const doc = splitGrnDoc(grnDoc);
    // Not stripBranchCode, the hospitals' rule for GRN_NO: where the division
    // code is not the prefix it falls back to taking any leading letters for
    // one, and a pharmacy number's own letters ("HE" in HE00184) would go.
    const cellNumber =
      divisionCode && grnNoCell.toUpperCase().startsWith(divisionCode.toUpperCase())
        ? grnNoCell.slice(divisionCode.length)
        : grnNoCell;
    const grnNumber = doc.grnNumber || cellNumber;

    rows.push({
      sourceRowNo: i + 1,
      division: toText(get('DIVISION')),
      divisionCode,
      // Folded for comparison, as the GRN row's unitKey is. With the GRN number
      // it is what an ageing row is known and replaced by.
      divisionKey: normKey(divisionCode),
      storeName: toText(get('STORENAME')),
      vendorName: toText(get('VENDORNAME')),
      vendorNameKey: normVendorName(get('VENDORNAME')),
      vendorCode: toText(get('VENDORCODE')),
      grnDoc,
      // The GRN number itself, taken out of GRNDoc. The whole document
      // reference is kept beside it in grnDoc.
      grnNo: grnNumber,
      branchCode: doc.docPrefix || divisionCode || null,
      grnNumber,
      grnNumberKey: normKey(grnNumber),
      billNo: toText(get('BILLNO')),
      billNoKey: normKey(get('BILLNO')),
      billDate: phDate(get('BILLDATE')),
      netAmt: toNumber(get('NETAMT')),
      adjPurReturn: toNumber(get('ADJPURRETURN')),
      adjustedJv: toNumber(get('ADJUSTEDJV')),
      tdsJv: toNumber(get('TDSJV')),
      payableAmount: toNumber(get('PAYABLEAMOUNT')),

      indentDate: phDate(get('INDENTDATE')),
      poDate: phDate(get('PO_DATE')),
      securityDate: phDate(get('SECURITYDATE')),
      grnDate: phDate(get('GRN_DATE')),
      billToAudit: phDate(get('BILLTOAUDIT')),
      billHandOverToAcc: phDate(get('BILLHANDOVERTOACC')),
      chqDate: phDate(get('CHQDATE')),
      chequeClearanceDate: phDate(get('CHEQUE_CLEARANCEDATE')),

      paymentDocNo: toText(get('PAYMENTDOCNO')),
      // toText, not toNumber: a cheque number's leading zero is part of it.
      chequeNo: toText(get('CHEQUENO')),
      // What has been paid against the bill so far, and what was paid ahead of
      // it. The hospitals' report has neither column.
      paymentAmt: toNumber(get('PAYMENTAMT')),
      advancePaymentAmt: toNumber(get('ADVANCEPAYMENTAMT')),
      balance: toNumber(get('BALANCE')),
    });
  }

  if (rows.length === 0) throw new ExcelFormatError('The Vendor Age report contains no data rows.');

  return { sheetName, headerRow: headerIdx + 1, headers, rows };
}

/**
 * Parse the pharmacies' BPAD current bill status, keeping only the rows `keep`
 * accepts.
 *
 * Columns: Sl.No., Location, WareHouse, Vendor Code, Vendor Name, Vendor
 * Category, Inv.No., Inv.Date, GRN No, GRN Date, GRN Amount, PO Number/Date,
 * Pending With Dept., BPAD Received Date., Accounts Received Date., Pending
 * With User/Status, Pend.Reason/Pend Dept, QueryAgeing, Ageing, GRN Age, and
 * Vendor Code again at the far end.
 *
 * Read as readBpadReport reads the hospitals' register, into the same row,
 * with what differs here:
 *
 *  - Inv.Date has a full stop where the hospitals' register writes Inv Date;
 *  - PO Number and PO Date are one column, PO Number/Date. Whatever it holds
 *    is kept as the PO number -- it is empty on every row of the sample, so
 *    how the two share a cell is not known -- and the PO date stays empty;
 *  - the two received dates carry a time of day (see phDate);
 *  - a heading is found with or without its spaces, where the hospitals'
 *    register's must be spaced as that register spaces them. Full stops and
 *    slashes still count, so the headings that have been seen both with and
 *    without one are asked for both ways.
 *
 * The three ageing counts and Vendor Category are read past, as they are on
 * the hospitals' register and for the same reasons; the second Vendor Code is
 * the first one again.
 *
 * @param {Buffer} buffer
 * @param {(vendorCodeKey: string, grnNoKey: string, locationKey: string) => boolean} [keep]
 *   Asked once per row, before the row is built. Default keeps every row.
 * @returns {{ sheetName, headerRow, headers, rows, scanned }}
 */
export function readPhBpadReport(buffer, { keep = () => true } = {}) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, PH_BPAD_SIGNATURE, true);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like the BPAD current bill status - could not find a header row containing GRN No, Vendor Code and GRN Amount.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], true);
  const rows = [];
  let scanned = 0;

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);
    const grnNo = toText(get('GRNNO'));
    if (!grnNo) continue; // blank spacers

    scanned += 1;

    const vendorCode = toText(get('VENDORCODE'));
    const location = toText(get('LOCATION'));
    const grnNoKey = normKey(grnNo);
    const vendorCodeKey = normKey(vendorCode);
    if (!keep(vendorCodeKey, grnNoKey, normKey(location))) continue;

    rows.push({
      sourceRowNo: i + 1,
      slNo: toNumber(get('SL.NO.', 'SL.NO', 'SLNO')),
      location,
      warehouse: toText(get('WAREHOUSE')),
      vendorCode,
      vendorCodeKey,
      vendorName: toText(get('VENDORNAME')),
      invNo: toText(get('INV.NO.', 'INV.NO', 'INVNO')),
      invDate: phDate(get('INV.DATE', 'INVDATE')),
      grnNo,
      grnNoKey,
      grnDate: phDate(get('GRNDATE')),
      // "     7,031.00" -- text, padded and grouped. toNumber drops the commas.
      grnAmount: toNumber(get('GRNAMOUNT')),
      poNumber: toText(get('PONUMBER/DATE', 'PONUMBER')),
      poDate: phDate(get('PODATE')),
      pendingWithDept: toText(get('PENDINGWITHDEPT.', 'PENDINGWITHDEPT')),
      bpadReceivedDate: phDate(get('BPADRECEIVEDDATE.', 'BPADRECEIVEDDATE')),
      accountsReceivedDate: phDate(get('ACCOUNTSRECEIVEDDATE.', 'ACCOUNTSRECEIVEDDATE')),
      pendingWithUser: toText(get('PENDINGWITHUSER/STATUS')),
      pendReason: toText(get('PEND.REASON/PENDDEPT')),
    });
  }

  if (scanned === 0) throw new ExcelFormatError('The BPAD current bill status contains no data rows.');

  return { sheetName, headerRow: headerIdx + 1, headers, rows, scanned };
}
