/**
 * A vendor's details off the Vendor Master, for the four columns every GRN
 * table carries beside its vendor -- MSME No, MSME Status, Inter and Supply
 * Type -- on Total GRNS, Pending, Accounts, BPAD, the PR-to-Bank ageing and
 * the CS Department queue, and in their exports.
 *
 * Read off the Vendor Master (vendor_master): every vendor the HIS vendor
 * master has ever listed, with its latest details, filled by each HIS vs FOCUS
 * Reco (services/vendorMaster.js). The HIS vendor master is the correct data,
 * and the vendor master and the GRN report both come out of HIS, so the codes
 * are the same codes -- 437 of the 438 vendors on the GRNs are on it. A vendor
 * a later file leaves out keeps the number it last had, where the latest reco
 * alone would have forgotten it.
 *
 * Looked up on every read, never copied onto a GRN: a new reco, or an Inter or
 * Supply Type changed on the Vendor Master screen, shows on every GRN of that
 * vendor -- stored or still to be uploaded -- with the next request.
 *
 * One definition, used by every route that lists GRNs, so the tables cannot
 * disagree about a vendor.
 */

/**
 * The master's key for the vendor code in `vendorCodeSql`, keyed the way the
 * master keys it (codeKey in services/msmeReco.js): runs of whitespace folded
 * to one space, trimmed, upper-cased. code_key is unique, so each lookup below
 * is one index probe.
 */
function codeKeyOf(vendorCodeSql) {
  return `upper(btrim(regexp_replace(${vendorCodeSql}, '\\s+', ' ', 'g')))`;
}

/**
 * The MSME lookup, as SQL, for the vendor code in `vendorCodeSql`.
 *
 * Three answers, and the empty string is what tells them apart: NULL when the
 * Vendor Master has no row for the vendor, '' when it has one with no MSME
 * number, and the number otherwise. msmeFields below turns that into what the
 * columns say. msme_no is stored cleaned -- a placeholder such as "NA" or "-"
 * is NULL -- so "has a number" means a real one.
 *
 * A scalar subquery rather than a join, for the page: it is not needed to sort
 * or filter, so Postgres evaluates it after the LIMIT, for the rows being
 * returned only -- the way the Account No lookup (branchAccountNo) already
 * works. An export asks for every row and pays one probe each.
 */
export function vendorMsmeNo(vendorCodeSql) {
  return `(
    SELECT COALESCE(vm.msme_no, '')
    FROM vendor_master vm
    WHERE vm.code_key = ${codeKeyOf(vendorCodeSql)}
  )`;
}

/**
 * The vendor's Inter and Supply Type, picked on the Vendor Master screen:
 * NO / YES and REGULAR / STENTS, or NULL when the master has no row for the
 * vendor. Scalar subqueries for the same reason as vendorMsmeNo.
 *
 * vendorInter is exported for the Cheque Not Required card, which counts an
 * Inter vendor's bills as needing no cheque (routes/results.js).
 */
export function vendorInter(vendorCodeSql) {
  return `(SELECT vm.inter FROM vendor_master vm WHERE vm.code_key = ${codeKeyOf(vendorCodeSql)})`;
}

// Exported for the Cheque Not Prepared section's Stents / Regular breakdown
// (routes/results.js), which groups by it.
export function vendorSupplyType(vendorCodeSql) {
  return `(SELECT vm.supply_type FROM vendor_master vm WHERE vm.code_key = ${codeKeyOf(vendorCodeSql)})`;
}

/**
 * All three lookups as select-list entries, for the vendor code in
 * `vendorCodeSql`, named as vendorFields reads them. The one thing a GRN query
 * adds to carry the four columns.
 */
export function vendorColumns(vendorCodeSql) {
  return `${vendorMsmeNo(vendorCodeSql)} AS vendor_msme_no,
         ${vendorInter(vendorCodeSql)} AS vendor_inter,
         ${vendorSupplyType(vendorCodeSql)} AS vendor_supply_type`;
}

/**
 * What the two MSME columns say, from the lookup's value.
 *
 * MSME Status is MSME when the Vendor Master has a number for the vendor and
 * Non-MSME when it has the vendor without one. A vendor it has no row for gets
 * null for both -- that says nothing either way, and calling it Non-MSME
 * would be a claim the data does not make.
 */
export function msmeFields(value) {
  return {
    msmeNo: value || null,
    msmeStatus: value == null ? null : value ? 'MSME' : 'Non-MSME',
  };
}

/** How Inter and Supply Type read, as the Vendor Master screen writes them. */
const INTER_LABELS = { NO: 'No', YES: 'Yes' };
const SUPPLY_TYPE_LABELS = { REGULAR: 'Regular', STENTS: 'Stents' };

/**
 * The four columns, from a row carrying vendorColumns: msmeNo, msmeStatus,
 * inter and supplyType, each null for a vendor the Vendor Master has no row
 * for.
 */
export function vendorFields(r) {
  return {
    ...msmeFields(r.vendor_msme_no),
    inter: INTER_LABELS[r.vendor_inter] ?? null,
    supplyType: SUPPLY_TYPE_LABELS[r.vendor_supply_type] ?? null,
  };
}

/**
 * The MSME dropdown on every GRN screen, as a WHERE clause -- or null for
 * every vendor.
 *
 * `value` is the dropdown's choice as the request carries it: 'MSME' or
 * 'NON_MSME'; anything else narrows nothing. It asks exactly what the MSME
 * Status column answers, off the same lookup, so the rows it keeps are the rows
 * that column labels MSME or Non-MSME. A vendor the Vendor Master has no row
 * for is neither, and so is in neither choice -- only in "All vendors".
 *
 * No parameter to push: both halves compare against a constant.
 */
export function msmeFilter(value, vendorCodeSql) {
  if (value === 'MSME') return `${vendorMsmeNo(vendorCodeSql)} <> ''`;
  if (value === 'NON_MSME') return `${vendorMsmeNo(vendorCodeSql)} = ''`;
  return null;
}

/**
 * The Supply Type choices a GRN list can be narrowed to -- the Stents and
 * Regular cards on the Cheque Not Prepared section, and NONE for a vendor the
 * Vendor Master has no row for, so the cards can add up to the section.
 */
export const SUPPLY_TYPE_CHOICES = new Set(['STENTS', 'REGULAR', 'NONE']);

/**
 * One of SUPPLY_TYPE_CHOICES as a WHERE clause, for the vendor code in
 * `vendorCodeSql` -- or null for anything else, which narrows nothing. Callers
 * refuse an unknown value first (400), so a typo cannot quietly widen a list.
 *
 * EXISTS rather than `(scalar lookup) = 'STENTS'`: the planner reads the
 * semi-join's selectivity from the table, where it would guess one row in two
 * hundred for the comparison -- the kind of misestimate that once turned a
 * results query into a nested loop (see NO_CHEQUE in routes/results.js).
 *
 * No parameter to push: the value is one of a closed set, spelled here.
 */
export function supplyTypeFilter(value, vendorCodeSql) {
  const wanted = String(value ?? '').trim().toUpperCase();
  const key = codeKeyOf(vendorCodeSql);
  if (wanted === 'NONE') return `NOT EXISTS (SELECT 1 FROM vendor_master vs WHERE vs.code_key = ${key})`;
  if (wanted !== 'STENTS' && wanted !== 'REGULAR') return null;
  return `EXISTS (SELECT 1 FROM vendor_master vs WHERE vs.code_key = ${key} AND vs.supply_type = '${wanted}')`;
}
