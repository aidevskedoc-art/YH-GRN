/**
 * Turning the Cheque view's rows back into the GRNs they stand for.
 *
 * On Cheque view one table row is a whole cheque, so a bulk action taken on
 * ticked rows has to act on every bill those cheques pay -- not only the one
 * representative bill each row happens to carry. The bills are fetched from
 * the server, since a cheque's bills are spread across the whole table.
 */
import { api } from '../api/client.js';

/** A cheque this big would be a data problem, not a payment run. */
const GROUP_PAGE_SIZE = 200;
const GROUP_MAX_PAGES = 10;

/**
 * Every results row paid by `row`'s cheque that `eligible` accepts -- `row`
 * itself always included. The same lookup as chequeGroup in ResultsTable.jsx.
 */
export async function resultsChequeBills(batchId, row, eligible) {
  if (!row.chequeNo) return [row];
  const found = [];
  for (let page = 1; page <= GROUP_MAX_PAGES; page += 1) {
    const res = await api.results(batchId, {
      status: 'ALL',
      chequeNo: row.chequeNo,
      page,
      pageSize: GROUP_PAGE_SIZE,
    });
    found.push(...res.rows);
    if (page >= res.totalPages) break;
  }
  const group = found.filter(eligible);
  return group.some((r) => r.dprNo === row.dprNo) ? group : [row, ...group];
}

/** Every CSD handover paid by `row`'s cheque that `eligible` accepts. */
export async function csdChequeHandovers(row, eligible) {
  if (!row.chequeNo) return [row];
  const found = [];
  for (let page = 1; page <= GROUP_MAX_PAGES; page += 1) {
    const res = await api.listCsd({ chequeNo: row.chequeNo, page, pageSize: GROUP_PAGE_SIZE });
    found.push(...res.rows);
    if (page >= res.totalPages) break;
  }
  const group = found.filter(eligible);
  return group.some((r) => r.id === row.id) ? group : [row, ...group];
}

/**
 * `rows` widened to every bill their cheques pay, via `groupOf`, with no bill
 * twice. `keyOf` names a bill (dprNo for results rows, id for handovers).
 */
export async function expandCheques(rows, groupOf, keyOf) {
  const groups = await Promise.all(rows.map(groupOf));
  const seen = new Set();
  return groups.flat().filter((r) => {
    const key = keyOf(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
