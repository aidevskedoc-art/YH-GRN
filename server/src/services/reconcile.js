/**
 * Reconciliation engine.
 *
 * A GRN transaction is considered "moved to accounts" when its GRN number
 * appears in the Vendor Ageing report. The GRN number is the authoritative key:
 * it is unique per transaction and present in both systems.
 *
 * Bill number is compared as well, but a disagreement does not demote a row to
 * PENDING -- such rows are flagged MATCHED_WITH_DIFF instead so the difference
 * stays visible. Vendor name is not compared: the two systems spell it
 * differently often enough ("PVT. LTD." vs "PRIVATE LIMITED") that it is not a
 * meaningful signal, so a row's vendor name is left exactly as its own source
 * report spells it.
 */

export const STATUS = {
  MATCHED: 'MATCHED',
  MATCHED_WITH_DIFF: 'MATCHED_WITH_DIFF',
  PENDING: 'PENDING',
};

/**
 * Index the ageing rows by GRN number key.
 *
 * A GRN with several cheque/payment entries repeats across rows, so the first
 * occurrence wins and the rest are counted as duplicates.
 */
export function indexAgeingByGrnNumber(ageingRows) {
  const index = new Map();
  let duplicateRows = 0;

  for (const row of ageingRows) {
    if (!row.grnNumberKey) continue;
    if (index.has(row.grnNumberKey)) {
      duplicateRows += 1;
      continue;
    }
    index.set(row.grnNumberKey, row);
  }

  return { index, duplicateRows };
}

function describeDiscrepancies(grnRow, ageingRow, billNoMatch) {
  const notes = [];
  if (!billNoMatch) {
    notes.push(`Bill No differs - GRN report: "${grnRow.billNo}", Ageing: "${ageingRow.billNo}"`);
  }
  return notes.join('; ') || null;
}

function emptyBucket() {
  return { count: 0, amount: 0 };
}

/**
 * Pair one GRN row against its ageing row, or against `undefined` when none
 * was found, and return the reconciliation verdict for that pair alone.
 *
 * Split out from reconcile() because this is the verdict that is stored:
 * ingest.js pairs every GRN an upload touches with the first ageing row on file
 * for it -- whichever upload either side came from -- and judges the pair here
 * (see linkResults there). reconcile() below pairs the two files of one upload
 * with each other only, for the summary the upload answers with.
 */
export function matchGrnAgeingPair(grn, ageing) {
  if (!ageing) {
    return { status: STATUS.PENDING, billNoMatch: null, vendorNameMatch: null, discrepancyNotes: null };
  }

  const billNoMatch = grn.billNoKey === ageing.billNoKey;
  const vendorNameMatch = grn.vendorNameKey === ageing.vendorNameKey;
  const status = billNoMatch ? STATUS.MATCHED : STATUS.MATCHED_WITH_DIFF;
  const discrepancyNotes = status === STATUS.MATCHED_WITH_DIFF ? describeDiscrepancies(grn, ageing, billNoMatch) : null;

  return { status, billNoMatch, vendorNameMatch, discrepancyNotes };
}

/**
 * Reconcile parsed GRN rows against parsed ageing rows.
 *
 * @param {Array} grnRows    from readGrnReport()
 * @param {Array} ageingRows from readAgeingReport()
 * @returns {{results: Array, summary: Object}}
 */
export function reconcile(grnRows, ageingRows) {
  const { index, duplicateRows } = indexAgeingByGrnNumber(ageingRows);

  const summary = {
    [STATUS.MATCHED]: emptyBucket(),
    [STATUS.MATCHED_WITH_DIFF]: emptyBucket(),
    [STATUS.PENDING]: emptyBucket(),
    total: emptyBucket(),
    ageingRowCount: ageingRows.length,
    ageingDistinctGrnCount: index.size,
    ageingDuplicateRowCount: duplicateRows,
  };

  const results = grnRows.map((grn) => {
    const ageing = grn.dprNoKey ? index.get(grn.dprNoKey) : undefined;
    const amount = grn.totalAmount ?? 0;
    const { status, billNoMatch, vendorNameMatch, discrepancyNotes } = matchGrnAgeingPair(grn, ageing);

    summary[status].count += 1;
    summary[status].amount += amount;
    summary.total.count += 1;
    summary.total.amount += amount;

    return { grn, ageing: ageing ?? null, status, billNoMatch, vendorNameMatch, discrepancyNotes };
  });

  return { results, summary };
}
