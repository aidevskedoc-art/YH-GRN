/**
 * Standalone check of the HIS vs FOCUS reco: reads the two masters from the project
 * root with the real parsers, reconciles them, and compares the counts with
 * the ones measured from the same files when the feature was built. No
 * database needed.
 *
 *   node scripts/check-msme.js
 *
 * Use it after any change to the MSME parsers or the matching rules -- if the
 * numbers move, find out why before trusting the screen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendorMaster, readAccountMaster } from '../src/services/excelParser.js';
import { reconcileMsme, FIELDS, STATUS, STORED_STATUSES } from '../src/services/msmeReco.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../..');

const VENDOR_FILE = '00. VendorMasterReport from  HIS (1).xlsx';
const ACCOUNT_FILE = '02. 010Account (1).xlsx';

/** Measured from the sample files the feature was built on. */
const EXPECTED = {
  vendorSheet: 'Active',
  vendorRows: 1897,
  accountRows: 30549,
  [STATUS.MATCHED]: 580,
  [STATUS.MISMATCH]: 1144,
  [STATUS.NOT_IN_ACCOUNTS]: 173,
  [STATUS.NOT_IN_HIS]: 28822,
};

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
  if (!ok) failures += 1;
}

console.log(`\nReading files from ${DATA_DIR}\n`);

console.log(VENDOR_FILE);
const vendor = readVendorMaster(fs.readFileSync(path.join(DATA_DIR, VENDOR_FILE)));
check('sheet read', vendor.sheetName, EXPECTED.vendorSheet);
check('vendor rows', vendor.rows.length, EXPECTED.vendorRows);
console.log('  first row:', JSON.stringify(vendor.rows[0]).slice(0, 260));

console.log(`\n${ACCOUNT_FILE}`);
const account = readAccountMaster(fs.readFileSync(path.join(DATA_DIR, ACCOUNT_FILE)));
check('header row (1-based)', account.headerRow, 4);
check('account rows', account.rows.length, EXPECTED.accountRows);
console.log('  first row:', JSON.stringify(account.rows[0]).slice(0, 260));

console.log('\nReconciliation');
const { results, summary } = reconcileMsme(vendor.rows, account.rows);
for (const status of Object.values(STATUS)) check(status, summary.statuses[status], EXPECTED[status]);
check('rows produced', results.length, EXPECTED.vendorRows + EXPECTED[STATUS.NOT_IN_HIS]);
check(
  'rows stored (every HIS vendor)',
  results.filter((r) => STORED_STATUSES.includes(r.status)).length,
  EXPECTED.vendorRows,
);

console.log('\nMismatches by field');
for (const f of FIELDS) console.log(`  ${f.label.padEnd(16)} ${String(summary.fields[f.key]).padStart(5)}`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
