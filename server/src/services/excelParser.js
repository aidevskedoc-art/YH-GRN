/**
 * Readers for the two monthly source reports.
 *
 * Both are read with SheetJS, which handles the GRN report's legacy BIFF8 .xls
 * as well as the ageing report's OOXML .xlsx. Neither file starts at row 1 --
 * both carry a title block above the header -- so the header row is located by
 * looking for its column names rather than being hardcoded to a row number.
 */
import * as XLSX from 'xlsx';
import {
  toText,
  toNumber,
  normKey,
  normVendorName,
  stripBranchCode,
  toIsoDateString,
} from './normalize.js';

/** Column names that identify each report's header row. */
const GRN_SIGNATURE = ['DPR.NO', 'BILL NO', 'VENDOR NAME'];
const AGEING_SIGNATURE = ['GRN_NO', 'BILLNO', 'VENDORNAME'];

/** How far down the sheet to look for the header before giving up. */
const HEADER_SEARCH_LIMIT = 30;

export class ExcelFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExcelFormatError';
    this.status = 400;
  }
}

function readGrid(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ExcelFormatError('The workbook contains no sheets.');

  // blankrows must stay true so that a grid index maps to the real spreadsheet
  // row number; the reports carry blank spacer rows inside the title block, and
  // dropping them would make `sourceRowNo` untraceable back to the source file.
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    blankrows: true,
    defval: null,
  });
  return { sheetName, grid };
}

/** Collapse a header cell to a comparable token ("Bill  No" -> "BILL NO"). */
function headerToken(value) {
  return toText(value).toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Same, but with all whitespace removed, for the ageing report's tight names. */
function tightToken(value) {
  return toText(value).toUpperCase().replace(/\s+/g, '');
}

/**
 * Find the header row by locating a row that contains every signature column.
 * Returns the 0-based grid index.
 */
function findHeaderRow(grid, signature, tight) {
  const tokenize = tight ? tightToken : headerToken;
  const limit = Math.min(grid.length, HEADER_SEARCH_LIMIT);

  for (let i = 0; i < limit; i += 1) {
    const tokens = new Set((grid[i] || []).map(tokenize));
    if (signature.every((name) => tokens.has(name))) return i;
  }
  return -1;
}

/**
 * Build a {token -> column index} lookup for a header row.
 *
 * A blank cell BETWEEN two labels is skipped rather than counted as a column
 * of its own, because it is a label-row artifact rather than a column the data
 * has. The August GRN export ("01. HIS GRNs Aug'26.xls") writes exactly one:
 * an empty cell sits where "Bill  No" should be, pushing that label and every
 * label after it one place to the right of the data they name. Read literally,
 * the vendor code lands under "DC No", the vendor name under "Vendor Code",
 * Bill.Amount reads 0, Total Amount reads the location text (so parses as
 * null) and Location comes out empty on all 3,402 rows.
 *
 * Empty Location is the damaging one. A GRN with no ageing row has no
 * DivisionCode either, so Location is the only thing that can place it in a
 * branch -- and with branches ticked on the configuration screen, every
 * pending row then falls outside the scope and the Pending tab reads empty
 * (see branchScope in services/branchScope.js).
 *
 * Counting from the first label's own position rather than from zero keeps a
 * LEADING blank meaning what it has always meant: an unlabelled first column
 * that the data really does carry. Only the gaps between labels are treated as
 * spurious. Every other report on file -- both ageing exports, the bank
 * statement, the April GRN report -- labels every column, so for those this
 * behaves exactly as counting the literal position did.
 */
function indexHeaders(headerRow, tight) {
  const tokenize = tight ? tightToken : headerToken;
  const index = new Map();
  let col = -1;

  headerRow.forEach((cell, literalCol) => {
    const token = tokenize(cell);
    if (!token) return;
    col = col === -1 ? literalCol : col + 1;
    if (!index.has(token)) index.set(token, col);
  });

  return index;
}

function makeGetter(row, index) {
  return (...names) => {
    for (const name of names) {
      const col = index.get(name);
      if (col !== undefined) return row[col];
    }
    return null;
  };
}

/**
 * Parse the GRN report (file 01).
 *
 * Columns: Sl.No, Warehouse, DPR.No, PO.No, DPR.Date, Bill.Date, Bill  No,
 * DC No, Vendor Code, Vendor Name, Bill.Amount, Transport Amount,
 * Total Amount, Location, Add.Amount, Ded.Amount
 */
export function readGrnReport(buffer) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, GRN_SIGNATURE, false);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like a GRN report - could not find a header row containing DPR.No, Bill No and Vendor Name.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], false);
  const rows = [];

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);
    const dprNo = toText(get('DPR.NO'));
    if (!dprNo) continue; // skip blank spacers and any trailing total row

    rows.push({
      sourceRowNo: i + 1,
      slNo: toNumber(get('SL.NO')),
      warehouse: toText(get('WAREHOUSE')),
      dprNo,
      dprNoKey: normKey(dprNo),
      poNo: toText(get('PO.NO')),
      dprDate: toIsoDateString(get('DPR.DATE')),
      billDate: toIsoDateString(get('BILL.DATE')),
      billNo: toText(get('BILL NO', 'BILL.NO', 'BILLNO')),
      billNoKey: normKey(get('BILL NO', 'BILL.NO', 'BILLNO')),
      dcNo: toText(get('DC NO', 'DC.NO')),
      vendorCode: toText(get('VENDOR CODE')),
      vendorName: toText(get('VENDOR NAME')),
      vendorNameKey: normVendorName(get('VENDOR NAME')),
      billAmount: toNumber(get('BILL.AMOUNT')),
      transportAmount: toNumber(get('TRANSPORT AMOUNT')),
      totalAmount: toNumber(get('TOTAL AMOUNT')),
      location: toText(get('LOCATION')),
      addAmount: toNumber(get('ADD.AMOUNT')),
      dedAmount: toNumber(get('DED.AMOUNT')),
    });
  }

  if (rows.length === 0) throw new ExcelFormatError('The GRN report contains no data rows.');

  return { sheetName, headerRow: headerIdx + 1, headers, rows };
}

/**
 * Parse the Vendor Ageing report (file 02).
 *
 * GRN_NO carries the division code as a prefix ("SE1BMWH0000782"); it is split
 * here into `branchCode` and `grnNumber` so the GRN number alone can be joined
 * against the GRN report's DPR.No.
 */
export function readAgeingReport(buffer) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, AGEING_SIGNATURE, true);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like a Vendor Ageing report - could not find a header row containing GRN_NO, BillNo and VendorName.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], true);
  const rows = [];

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);
    const grnNo = toText(get('GRN_NO'));
    if (!grnNo) continue;

    const divisionCode = toText(get('DIVISIONCODE'));
    const { branchCode, grnNumber } = stripBranchCode(grnNo, divisionCode);

    rows.push({
      sourceRowNo: i + 1,
      division: toText(get('DIVISION')),
      divisionCode,
      storeName: toText(get('STORENAME')),
      vendorName: toText(get('VENDORNAME')),
      vendorNameKey: normVendorName(get('VENDORNAME')),
      vendorCode: toText(get('VENDORCODE')),
      grnDoc: toText(get('GRNDOC')),
      grnNo,
      branchCode,
      grnNumber,
      grnNumberKey: normKey(grnNumber),
      billNo: toText(get('BILLNO')),
      billNoKey: normKey(get('BILLNO')),
      billDate: toIsoDateString(get('BILLDATE')),
      netAmt: toNumber(get('NETAMT')),
      // The three adjustments that sit between NetAmt and PayableAmount on the
      // source sheet, carried through so the Valid GRNs view can show how one
      // becomes the other.
      adjPurReturn: toNumber(get('ADJPURRETURN')),
      adjustedJv: toNumber(get('ADJUSTEDJV')),
      tdsJv: toNumber(get('TDSJV')),
      payableAmount: toNumber(get('PAYABLEAMOUNT')),

      // The seven stages a bill passes through, in order. Every one of them is
      // a date, and the turnaround report is the difference between them.
      // BILLTOAUDIT and BILLHANDOVERTOACC used to be read as text -- they look
      // right on screen either way, but "07-03-2026" cannot be subtracted.
      indentDate: toIsoDateString(get('INDENTDATE')),
      poDate: toIsoDateString(get('PO_DATE')),
      securityDate: toIsoDateString(get('SECURITYDATE')),
      grnDate: toIsoDateString(get('GRN_DATE')),
      billToAudit: toIsoDateString(get('BILLTOAUDIT')),
      billHandOverToAcc: toIsoDateString(get('BILLHANDOVERTOACC')),
      chqDate: toIsoDateString(get('CHQDATE')),
      // Stored but not yet reported on; makes a cheque-to-clearance stage a
      // one-line addition later.
      chequeClearanceDate: toIsoDateString(get('CHEQUE_CLEARANCEDATE')),

      paymentDocNo: toText(get('PAYMENTDOCNO')),
      // toText, not toNumber: a cheque number is an identifier. Read as a
      // number, 000123 becomes 123 and a long one turns into scientific
      // notation -- neither of which is the cheque anybody wrote.
      chequeNo: toText(get('CHEQUENO')),
      balance: toNumber(get('BALANCE')),
    });
  }

  if (rows.length === 0) throw new ExcelFormatError('The Vendor Ageing report contains no data rows.');

  return { sheetName, headerRow: headerIdx + 1, headers, rows };
}

/* ==========================================================================
   The bank statement (file 06).

   Only the transaction table is read. The sheet around it is a letterhead: an
   address block, account details, a statement summary and a page of small
   print. None of that is data, and none of it is stored.
   ========================================================================== */

/** The columns that identify the statement's table header row. */
const BANK_SIGNATURE = ['DATE', 'NARRATION', 'CHQ./REF.NO.'];

/** A statement date: dd/MM/yy. */
const BANK_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/;

/**
 * A statement date to yyyy-MM-dd.
 *
 * The shared toIsoDateString handles four-digit years; this sheet writes two
 * ("01/04/26"), which that parser reads as a number and gives up on. A
 * statement is always recent, so 00-99 expands to 2000-2099 -- a rule that is
 * wrong only for a statement printed after 2099.
 */
function bankDate(value) {
  const m = BANK_DATE.exec(toText(value));
  if (m) return toIsoDateString(`${m[1]}/${m[2]}/20${m[3]}`);
  return toIsoDateString(value);
}

/**
 * The last six digits of a cheque / reference number.
 *
 * This is the column the statement can be matched to the ageing report by: the
 * ageing report's ChequeNo is six digits, and the statement pads the same
 * number out to fifteen or sixteen ("0000000000066893" -> "066893"). Non-cheque
 * entries carry a reference in the same column -- an NEFT or a charge code --
 * and its last six digits are extracted just the same; whether a value is a
 * real cheque is a question for whatever reads this, not for the parser.
 *
 * Kept as text, and padded back to six, because a cheque number's leading zero
 * is part of it.
 */
export function lastSixDigits(value) {
  const digits = toText(value).replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(-6);
}

/**
 * The account the statement is for, out of the letterhead above the table.
 *
 * HDFC writes it as one cell reading "Account No :59219911199911   Imperia" --
 * the label, the number, and the product name trailing after it on the same
 * line. The number is the run of digits after the label; everything either side
 * is presentation.
 *
 * The whole letterhead is searched rather than a fixed cell, because the block
 * shifts by a row or two between statements: the joint-holders line is absent
 * on a sole account, and the address runs to a different number of lines.
 *
 * Null when the block does not carry one. That is not an error -- the
 * transactions are still readable, which is what the statement is uploaded for.
 */
const BANK_ACCOUNT_NO = /account\s*n(?:o|umber)?\s*[:.-]?\s*(\d{6,})/i;

function findAccountNo(grid, beforeRow) {
  for (let i = 0; i < beforeRow && i < grid.length; i += 1) {
    for (const cell of grid[i] || []) {
      const m = BANK_ACCOUNT_NO.exec(toText(cell));
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Parse the HDFC bank statement (file 06).
 *
 * Rows are recognised by a dd/MM/yy date in the first column, which is what
 * separates a transaction from the asterisk rules, the repeated page headers
 * and the summary block that follow the table.
 */
export function readBankStatement(buffer) {
  const { sheetName, grid } = readGrid(buffer);
  const headerIdx = findHeaderRow(grid, BANK_SIGNATURE, false);

  if (headerIdx === -1) {
    throw new ExcelFormatError(
      'This does not look like a bank statement - could not find a header row containing Date, Narration and Chq./Ref.No.',
    );
  }

  const headers = (grid[headerIdx] || []).map((h) => toText(h)).filter(Boolean);
  const index = indexHeaders(grid[headerIdx], false);
  const rows = [];

  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const get = makeGetter(grid[i] || [], index);

    const txnDate = bankDate(get('DATE'));
    if (!txnDate) continue; // rules, page headers, the summary block, blank spacers

    const chqRefNo = toText(get('CHQ./REF.NO.'));

    rows.push({
      sourceRowNo: i + 1,
      txnDate,
      narration: toText(get('NARRATION')),
      chqRefNo,
      extractedChequeNo: lastSixDigits(chqRefNo),
      valueDate: bankDate(get('VALUE DT')),
      withdrawalAmt: toNumber(get('WITHDRAWAL AMT.')),
      depositAmt: toNumber(get('DEPOSIT AMT.')),
      closingBalance: toNumber(get('CLOSING BALANCE')),
    });
  }

  if (rows.length === 0) throw new ExcelFormatError('The bank statement contains no transaction rows.');

  return {
    sheetName,
    headerRow: headerIdx + 1,
    headers,
    rows,
    // The one thing worth keeping from the letterhead: which account these
    // transactions belong to.
    accountNo: findAccountNo(grid, headerIdx),
  };
}
