/**
 * The MSME reco: the HIS vendor master held against the Accounts vendor list.
 *
 * The vendor code is the key -- VENDOR_CODE in the vendor master, Code in the
 * Accounts list. Every vendor the two share is then compared field by field,
 * and every difference is written into the row's remarks, so a reader of the
 * sheet can see what to correct without holding the two files side by side.
 *
 * Pure: rows in, rows out. Reading the files is excelParser.js's job and
 * storing the result is the route's (routes/msmeReco.js).
 */
import { toText, normKey } from './normalize.js';

/** The four answers a row can carry. */
export const STATUS = {
  /** In both files, and every compared field agrees. */
  MATCHED: 'MATCHED',
  /** In both files, and at least one field does not. */
  MISMATCH: 'MISMATCH',
  /** In the vendor master, but no Accounts row has its code. */
  NOT_IN_ACCOUNTS: 'NOT_IN_ACCOUNTS',
  /** In the Accounts list, but no vendor master row has its code. */
  NOT_IN_HIS: 'NOT_IN_HIS',
};

export const STATUS_KEYS = Object.values(STATUS);

/**
 * The statuses a run keeps rows for: every vendor master row -- the ones found
 * in Accounts, compared field by field, and the ones Accounts has no code for,
 * which need setting up there (the remark names the Accounts code carrying the
 * same PAN or GSTIN, when one does).
 *
 * NOT_IN_HIS is counted on the run and not stored: it is the rest of the
 * Accounts ledger -- some 29,000 land, labour and staff accounts per run -- with
 * no vendor master row to compare against and no remark worth reading.
 */
export const STORED_STATUSES = [STATUS.MATCHED, STATUS.MISMATCH, STATUS.NOT_IN_ACCOUNTS];

/**
 * What is compared, in the order the screen and the sheet show it.
 *
 * `his` / `acc` are the source columns, spelled as the files spell them;
 * `hisProp` / `accProp` are the same columns as the parser names them.
 *
 * Payee Name is held against Accounts' "Bank Account Name", not its "Bank
 * Name": Bank Name holds the bank ("STATE BANK OF INDIA"), so compared with a
 * payee it agreed on none of the 1,724 vendors the September files share,
 * while Bank Account Name -- the name on the account -- agreed on 1,349.
 *
 * `kind` picks the comparison:
 *  - name:    case, punctuation, spacing, "&"/"AND", "PVT"/"PRIVATE" and
 *             "LTD"/"LIMITED" are ignored, so "S.V.ELECTRONICS" is
 *             "S V ELECTRONICS" -- but a different word is still a difference.
 *  - id:      case, spaces and separators are ignored ("AICP L8904E" is
 *             "AICPL8904E"); every letter and digit must agree.
 *  - account: as id, with a difference only in leading zeros named as such.
 */
export const FIELDS = [
  { key: 'name', label: 'Vendor Name', his: 'VENDOR_NAME', acc: 'Name', hisProp: 'vendorName', accProp: 'name', kind: 'name' },
  { key: 'pan', label: 'PAN No', his: 'PAN_NO', acc: 'PAN No', hisProp: 'panNo', accProp: 'panNo', kind: 'id' },
  { key: 'gst', label: 'GST No', his: 'GST_NUMBER', acc: 'GSTIN', hisProp: 'gstNumber', accProp: 'gstin', kind: 'id' },
  {
    key: 'drugLicence',
    label: 'Drug Licence No',
    his: 'DRUG_LICENCE_NO',
    acc: 'Drug Licence No',
    hisProp: 'drugLicenceNo',
    accProp: 'drugLicenceNo',
    kind: 'id',
  },
  { key: 'msmeNo', label: 'MSME No', his: 'MSME_NUMBER', acc: 'MSME Reg No', hisProp: 'msmeNumber', accProp: 'msmeRegNo', kind: 'id' },
  {
    key: 'msmeType',
    label: 'MSME Type',
    his: 'ENTERPRISE_TYPE',
    acc: 'MSME Type',
    hisProp: 'enterpriseType',
    accProp: 'msmeType',
    kind: 'id',
  },
  {
    key: 'msmeActivity',
    label: 'MSME Activity',
    his: 'ENTERPRISE_ACTIVITY',
    acc: 'MSME Activity',
    hisProp: 'enterpriseActivity',
    accProp: 'msmeActivity',
    kind: 'id',
  },
  {
    key: 'bankAccountNo',
    label: 'Bank Account No',
    his: 'BANK_ACCOUNT_NO',
    acc: 'Bank Account Number',
    hisProp: 'bankAccountNo',
    accProp: 'bankAccountNumber',
    kind: 'account',
  },
  { key: 'ifsc', label: 'IFSC', his: 'IFSC', acc: 'Bank IFSC Code', hisProp: 'ifsc', accProp: 'bankIfscCode', kind: 'id' },
  {
    key: 'payeeName',
    label: 'Payee Name',
    his: 'PAYEE_NAME',
    acc: 'Bank Account Name',
    hisProp: 'payeeName',
    accProp: 'bankAccountName',
    kind: 'name',
  },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);

/**
 * What the files write in a cell that has nothing to say, in any field: dashes
 * or dots, a value made only of zeros, NA / N/A, NIL, NULL, NONE and "Not
 * Applicable" -- and the Accounts list's own markers for a number the vendor
 * does not have: "Unregistered" in GSTIN (143 rows, 26 of them HIS vendors),
 * "PAN Applied" and "No Pan" in PAN. Each is read as empty, so "Unregistered"
 * against a blank GST_NUMBER is agreement -- neither side has a GSTIN --
 * rather than a GSTIN missing in HIS.
 */
const PLACEHOLDER =
  /^(?:[-.\s]+|0+|N\s*\/?\s*A|NIL|NULL|NONE|NOT\s+APPLICABLE|UN-?\s*REGISTERED|(?:PAN\s+)?APPLIED(?:\s+FOR)?|NO\s+PAN)$/i;

/**
 * A value as it should be shown: trimmed, placeholders to empty, and Excel's
 * escaped carriage return ("_x000D_", which the vendor master writes after a
 * name edited with a line break) removed.
 */
export function cleanValue(value) {
  const text = toText(value)
    .replace(/_x000d_/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return PLACEHOLDER.test(text) ? '' : text;
}

/** Word forms the two systems use interchangeably in a name. */
const NAME_WORDS = { PVT: 'PRIVATE', LTD: 'LIMITED' };

function nameKey(text) {
  return text
    .toUpperCase()
    .replace(/^M\s*\/\s*S\b\.?/, ' ') // a leading "M/S" is a courtesy, not part of the name
    .replace(/&/g, ' AND ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((word) => NAME_WORDS[word] ?? word)
    .join('');
}

function keyFor(kind, text) {
  return kind === 'name' ? nameKey(text) : normKey(text);
}

/**
 * One field's verdict: null when the two agree (or both are empty), otherwise
 * the remark that says how they differ.
 *
 * Remarks name the Accounts side FOCUS -- the system the Accounts list is
 * exported from -- which is what the screen and the sheet call it.
 */
export function compareField(field, hisValue, accValue) {
  const his = keyFor(field.kind, cleanValue(hisValue));
  const acc = keyFor(field.kind, cleanValue(accValue));
  if (his === acc) return null;
  if (!acc) return `${field.label} missing in FOCUS`;
  if (!his) return `${field.label} missing in HIS`;
  if (field.kind === 'account' && his.replace(/^0+/, '') === acc.replace(/^0+/, '')) {
    return `${field.label} differs only in leading zeros`;
  }
  return `${field.label} mismatch`;
}

/**
 * The matching key for a vendor code: trimmed, any run of spaces folded to
 * one, and upper-cased -- nothing else.
 */
export function codeKey(value) {
  return toText(value).replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Every field's cleaned value off one side's row, keyed by field. */
function sideValues(row, prop) {
  if (!row) return null;
  return Object.fromEntries(FIELDS.map((f) => [f.key, cleanValue(row[f[prop]])]));
}

/**
 * Reconcile the two lists.
 *
 * Every vendor master row produces one result -- MATCHED, MISMATCH or
 * NOT_IN_ACCOUNTS -- and every Accounts code no vendor master row carries
 * produces one NOT_IN_HIS row, so both files are accounted for whole.
 *
 * Codes are matched exactly, after trimming, folding runs of spaces to one and
 * upper-casing (see codeKey). Folding away
 * separators as the GRN matching does would gain nothing here -- it finds no
 * extra pairs in the September files -- and would merge sixteen pairs of
 * distinct Accounts codes into one.
 *
 * An Accounts code listed more than once is matched to its first row, and the
 * remarks say how many there were.
 *
 * A vendor master code missing from Accounts is looked for by PAN, then by
 * GSTIN: a vendor filed in Accounts under another code (often its PAN) is a
 * different fix from one that was never set up, and the remark says which.
 */
export function reconcileMsme(vendorRows, accountRows) {
  const accounts = new Map();
  const occurrences = new Map();
  const byPan = new Map();
  const byGst = new Map();

  for (const row of accountRows) {
    const key = codeKey(row.code);
    if (!key) continue;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    if (!accounts.has(key)) accounts.set(key, row);

    const pan = normKey(cleanValue(row.panNo));
    if (pan && !byPan.has(pan)) byPan.set(pan, row.code);
    const gst = normKey(cleanValue(row.gstin));
    if (gst && !byGst.has(gst)) byGst.set(gst, row.code);
  }

  const results = [];
  const hisCodes = new Set();

  for (const vendor of vendorRows) {
    const key = codeKey(vendor.vendorCode);
    if (!key) continue;
    hisCodes.add(key);

    const account = accounts.get(key) ?? null;
    const base = {
      vendorCode: vendor.vendorCode,
      hisRowNo: vendor.sourceRowNo ?? null,
      accRowNo: account?.sourceRowNo ?? null,
      accCode: account?.code ?? null,
      warehouse: cleanValue(vendor.warehouse) || null,
      hisStatus: cleanValue(vendor.status) || null,
      his: sideValues(vendor, 'hisProp'),
      acc: sideValues(account, 'accProp'),
    };

    if (!account) {
      const pan = normKey(cleanValue(vendor.panNo));
      const gst = normKey(cleanValue(vendor.gstNumber));
      const elsewhere = (pan && byPan.get(pan)) || (gst && byGst.get(gst)) || null;
      const via = pan && byPan.has(pan) ? 'PAN' : 'GST No';
      results.push({
        ...base,
        status: STATUS.NOT_IN_ACCOUNTS,
        mismatchFields: [],
        remarks: elsewhere
          ? `Vendor code not found in FOCUS - same ${via} is under code ${elsewhere}`
          : 'Vendor code not found in FOCUS',
      });
      continue;
    }

    const remarks = [];
    const mismatchFields = [];
    for (const field of FIELDS) {
      const remark = compareField(field, vendor[field.hisProp], account[field.accProp]);
      if (remark) {
        remarks.push(remark);
        mismatchFields.push(field.key);
      }
    }

    const copies = occurrences.get(key);
    if (copies > 1) remarks.push(`Code appears ${copies} times in FOCUS - compared with the first`);

    results.push({
      ...base,
      status: mismatchFields.length > 0 ? STATUS.MISMATCH : STATUS.MATCHED,
      mismatchFields,
      remarks: remarks.length > 0 ? remarks.join(', ') : 'All details match',
    });
  }

  // Accounts codes the vendor master never mentions, in the list's own order.
  for (const [key, account] of accounts) {
    if (hisCodes.has(key)) continue;
    results.push({
      vendorCode: account.code,
      hisRowNo: null,
      accRowNo: account.sourceRowNo ?? null,
      accCode: account.code,
      warehouse: null,
      hisStatus: null,
      his: null,
      acc: sideValues(account, 'accProp'),
      status: STATUS.NOT_IN_HIS,
      mismatchFields: [],
      remarks: 'Code not found in HIS vendor master',
    });
  }

  return { results, summary: summarise(results, vendorRows.length, accountRows.length) };
}

/** Counts per status and per field -- what the run row stores and the cards show. */
export function summarise(results, vendorRowCount, accountRowCount) {
  const statuses = Object.fromEntries(STATUS_KEYS.map((s) => [s, 0]));
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, 0]));
  for (const row of results) {
    statuses[row.status] += 1;
    for (const key of row.mismatchFields) fields[key] += 1;
  }
  return { vendorRowCount, accountRowCount, statuses, fields };
}
