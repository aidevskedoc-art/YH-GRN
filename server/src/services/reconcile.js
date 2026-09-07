/**
 * Reconciliation engine.
 *
 * A GRN transaction is considered "moved to accounts" when its GRN number
 * appears in the Vendor Ageing report. The GRN number is the authoritative key:
 * it is unique per transaction and present in both systems.
 *
 * Bill number and vendor name are compared as well, but a disagreement does not
 * demote a row to PENDING -- the two systems spell vendor names differently
 * ("PVT. LTD." vs "PRIVATE LIMITED"), and treating that as a non-match would
 * report hundreds of already-processed GRNs as outstanding. Such rows are
 * flagged MATCHED_WITH_DIFF instead so the difference stays visible.
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
function indexAgeingByGrnNumber(ageingRows) {
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

function describeDiscrepancies(grnRow, ageingRow, billNoMatch, vendorNameMatch) {
  const notes = [];
  if (!billNoMatch) {
    notes.push(`Bill No differs - GRN report: "${grnRow.billNo}", Ageing: "${ageingRow.billNo}"`);
  }
  if (!vendorNameMatch) {
    notes.push(`Vendor Name differs - GRN report: "${grnRow.vendorName}", Ageing: "${ageingRow.vendorName}"`);
  }
  return notes.join('; ') || null;
}

function emptyBucket() {
  return { count: 0, amount: 0 };
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

    let status;
    let billNoMatch = null;
    let vendorNameMatch = null;
    let discrepancyNotes = null;

    if (!ageing) {
      status = STATUS.PENDING;
    } else {
      billNoMatch = grn.billNoKey === ageing.billNoKey;
      vendorNameMatch = grn.vendorNameKey === ageing.vendorNameKey;
      status = billNoMatch && vendorNameMatch ? STATUS.MATCHED : STATUS.MATCHED_WITH_DIFF;
      if (status === STATUS.MATCHED_WITH_DIFF) {
        discrepancyNotes = describeDiscrepancies(grn, ageing, billNoMatch, vendorNameMatch);
      }
    }

    summary[status].count += 1;
    summary[status].amount += amount;
    summary.total.count += 1;
    summary.total.amount += amount;

    return { grn, ageing: ageing ?? null, status, billNoMatch, vendorNameMatch, discrepancyNotes };
  });

  return { results, summary };
}
