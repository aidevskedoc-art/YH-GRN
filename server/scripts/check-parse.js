/**
 * Standalone sanity check: proves SheetJS reads both supplied report formats
 * (legacy BIFF8 .xls and OOXML .xlsx) and that the reconciliation engine
 * reproduces the figures measured directly from the source files.
 *
 *   node scripts/check-parse.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGrnReport, readAgeingReport } from '../src/services/excelParser.js';
import { reconcile } from '../src/services/reconcile.js';
import { daysBetween, toIsoDateString } from '../src/services/normalize.js';
import { summarise, dataQuality } from '../src/services/turnaround.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../..');

const GRN_FILE = "01. GRN Report _ Apr'26.xls";
const AGEING_FILE = "02. Vendor ageing report _ Apr'26.xlsx";

/** Expected values, measured directly from the April 2026 source files. */
const EXPECTED = {
  grnRows: 3467,
  ageingRows: 3200,
  matched: 2247,
  matchedWithDiff: 2,
  pending: 1218,
  pendingAmount: 86979127.97,
};

let failures = 0;

function check(label, actual, expected) {
  const ok = typeof expected === 'number' && !Number.isInteger(expected)
    ? Math.abs(actual - expected) < 0.01
    : actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
  if (!ok) failures += 1;
}

console.log(`\nReading files from ${DATA_DIR}\n`);

console.log(`${GRN_FILE}`);
const grn = readGrnReport(fs.readFileSync(path.join(DATA_DIR, GRN_FILE)));
check('data rows', grn.rows.length, EXPECTED.grnRows);
check('header row (1-based)', grn.headerRow, 2);
check('column count', grn.headers.length, 16);
console.log(`  headers: ${grn.headers.join(' | ')}`);
console.log('  first row:', JSON.stringify(grn.rows[0], null, 0).slice(0, 260));

console.log(`\n${AGEING_FILE}`);
const ageing = readAgeingReport(fs.readFileSync(path.join(DATA_DIR, AGEING_FILE)));
check('data rows', ageing.rows.length, EXPECTED.ageingRows);
check('header row (1-based)', ageing.headerRow, 6);
console.log('  first row:', JSON.stringify(ageing.rows[0], null, 0).slice(0, 260));

console.log('\nReconciliation');
const { results, summary } = reconcile(grn.rows, ageing.rows);
check('total classified', results.length, EXPECTED.grnRows);
check('MATCHED', summary.MATCHED.count, EXPECTED.matched);
check('MATCHED_WITH_DIFF', summary.MATCHED_WITH_DIFF.count, EXPECTED.matchedWithDiff);
check('PENDING', summary.PENDING.count, EXPECTED.pending);
check('PENDING amount', Number(summary.PENDING.amount.toFixed(2)), EXPECTED.pendingAmount);

// Spot-checks: each asserts a specific behaviour of the matching rule.
const byDpr = new Map(results.map((r) => [r.grn.dprNo, r]));

// SE1BMWH0000794 in the ageing report -> BMWH0000794 here, so the branch code
// was stripped correctly. The vendor is an alias ("BET MEDICAL PRIVATE LIMITED"
// vs "BET MEDICAL (P)LTD"), but vendor name is not compared at all, so this is
// a clean match rather than something flagged.
const branchStrip = byDpr.get('BMWH0000794');
check('BMWH0000794 (branch code stripped) status', branchStrip?.status, 'MATCHED');

// The bill number differs ("HN00681" vs "HR00681"), which is compared and does
// get flagged -- unlike the vendor-name spelling above.
const billNoDiff = byDpr.get('CSHDPR004759');
check('CSHDPR004759 (bill no differs) status', billNoDiff?.status, 'MATCHED_WITH_DIFF');
if (billNoDiff) console.log(`  flagged: ${billNoDiff.discrepancyNotes}`);

// Same vendor, one document later, genuinely absent from the ageing report.
const pending = byDpr.get('CSHDPR004514');
check('CSHDPR004514 status', pending?.status, 'PENDING');
check('CSHDPR004514 has no ageing row', pending?.ageing, null);

// Numeric bill numbers must survive as plain text, never 3.61E+09.
const numericBill = grn.rows.find((r) => r.billNo === '3610006395');
check('numeric bill no kept as text', numericBill?.billNo, '3610006395');
check('excel serial date parsed', grn.rows[0].dprDate, '2026-04-01');

// ---------------------------------------------------------------------------
// Turnaround: the seven stage dates and the six gaps between them.
// ---------------------------------------------------------------------------

console.log('\nStage dates (ageing row 1)');
const a0 = ageing.rows[0];
check('indentDate', a0.indentDate, '2026-02-06');
check('poDate', a0.poDate, '2026-02-07');
check('securityDate', a0.securityDate, '2026-02-17');
check('grnDate', a0.grnDate, '2026-02-28');
// These two used to be read as text; a raw "07-03-2026" cannot be subtracted.
check('billToAudit is a date, not text', a0.billToAudit, '2026-03-07');
check('billHandOverToAcc is a date, not text', a0.billHandOverToAcc, '2026-04-06');
check('chqDate', a0.chqDate, '2026-02-20');

console.log('\nDate helpers');
check('daysBetween forward', daysBetween('2026-02-06', '2026-02-07'), 1);
check('daysBetween same day', daysBetween('2026-02-06', '2026-02-06'), 0);
// The sign is kept on purpose: the source report publishes the absolute value,
// which hides every out-of-order row.
check('daysBetween backwards keeps its sign', daysBetween('2026-04-06', '2026-02-20'), -45);
check('daysBetween with a missing end', daysBetween('2026-04-06', null), null);
check('daysBetween across a month end', daysBetween('2026-02-28', '2026-03-07'), 7);
// An impossible date must become null rather than reaching Postgres, where it
// would abort the whole upload transaction.
check('impossible month rejected', toIsoDateString('45-99-2026'), null);
check('29 Feb in a non-leap year rejected', toIsoDateString('29-02-2026'), null);
check('29 Feb in a leap year accepted', toIsoDateString('29-02-2024'), '2024-02-29');
check('31 Apr rejected', toIsoDateString('31-04-2026'), null);

console.log('\nTurnaround statistics');
// Scope: the GRNs that reached the ageing report. A pending GRN has no ageing
// row, so it has no stage dates at all.
const inScope = results.filter((r) => r.ageing).map((r) => r.ageing);
check('rows in scope', inScope.length, EXPECTED.matched + EXPECTED.matchedWithDiff);

const { stages, overall } = summarise(inScope);
const stage = (key) => stages.find((s) => s.key === key);

// Medians measured directly from the April source file.
check('PR to PO median', stage('prToPo').median, 0);
check('PO to Security median', stage('poToSecurity').median, 1);
check('Security to GRN median', stage('securityToGrn').median, 1);
check('GRN to Audit median', stage('grnToAudit').median, 3);
check('Audit to Accounts median', stage('auditToAccounts').median, 3);
check('Accounts to Cheque median', stage('accountsToCheque').median, 12);
check('end to end median', overall.median, 24);

// Median leads the UI because the average does not survive this data: two rows
// carry a mistyped year, and that alone moves Security-to-GRN from 1 to 10.5.
check('Security to GRN average is skewed by the typo rows', stage('securityToGrn').average, 10.5);

// Missing dates are normal -- a bill with no cheque simply has not been paid.
check('rows with no SecurityDate', stage('poToSecurity').missing, 16);
check('rows with no ChqDate', stage('accountsToCheque').missing, 219);

// Backwards stages are real and are reported, not clamped or dropped.
check('PO to Security backwards', stage('poToSecurity').backwards, 467);
check('Accounts to Cheque backwards', stage('accountsToCheque').backwards, 16);
check('GRN to Audit backwards', stage('grnToAudit').backwards, 0);

const quality = dataQuality(inScope);
check('reporting era derived from the data', quality.era, 2026);
check('rows with a mistyped year', quality.impossible.length, 2);
check(
  'the two typo rows are the expected ones',
  quality.impossible.map((r) => r.grnNo).sort().join(','),
  'SE1CIVIL0016144,SE1CSHDPR004704',
);
// The 2 typo rows are reported under "impossible" only, not counted twice.
check('rows with a backwards stage', quality.backwards.length, 478);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
