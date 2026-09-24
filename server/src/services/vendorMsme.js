/**
 * A vendor's MSME registration, for the MSME No and MSME Status columns every
 * GRN table carries beside its vendor -- Total GRNS, Pending, Accounts, BPAD,
 * the PR-to-Bank ageing and the CS Department queue.
 *
 * Read off the HIS vendor master, as the latest HIS vs FOCUS Reco run stored it
 * (msme_reco_rows), matched on vendor code trimmed and upper-cased -- the way
 * that reco matches. The vendor master and the GRN report both come out of HIS,
 * so the codes are the same codes: 367 of the 368 vendors in the September GRN
 * data are on it. A new reco run is picked up by the next request; nothing is
 * copied anywhere.
 *
 * One definition, used by every route that lists GRNs, so the tables cannot
 * disagree about a vendor.
 */

/**
 * The lookup, as SQL, for the vendor code in `vendorCodeSql`.
 *
 * Three answers, and the empty string is what tells them apart: NULL when the
 * vendor master has no row for the vendor (or no reco has been run), '' when
 * it has one with no MSME number, and the number otherwise. msmeFields below
 * turns that into what the columns say. The reco stores the number cleaned --
 * a placeholder such as "Not Applicable" or "NA" is NULL -- so "has a number"
 * means a real one.
 *
 * A scalar subquery rather than a join, for the page: it is not needed to sort
 * or filter, so Postgres evaluates it after the LIMIT, for the rows being
 * returned only -- the way the Account No lookup (branchAccountNo) already
 * works. An export asks for every row and pays for each lookup;
 * idx_msme_rows_run_vendor in schema.sql turns those into index probes.
 */
export function vendorMsmeNo(vendorCodeSql) {
  return `(
    SELECT COALESCE(mr.his_msme_no, '')
    FROM msme_reco_rows mr
    WHERE mr.run_id = (SELECT MAX(id) FROM msme_reco_runs)
      AND upper(btrim(mr.vendor_code)) = upper(btrim(${vendorCodeSql}))
    ORDER BY mr.seq
    LIMIT 1
  )`;
}

/**
 * What the two columns say, from the lookup's value.
 *
 * MSME Status is MSME when the vendor master has a number for the vendor and
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

/**
 * The MSME dropdown on every GRN screen, as a WHERE clause -- or null for
 * every vendor.
 *
 * `value` is the dropdown's choice as the request carries it: 'MSME' or
 * 'NON_MSME'; anything else narrows nothing. It asks exactly what the MSME
 * Status column answers, off the same lookup, so the rows it keeps are the rows
 * that column labels MSME or Non-MSME. A vendor the vendor master has no row
 * for is neither, and so is in neither choice -- only in "All vendors".
 *
 * No parameter to push: both halves compare against a constant.
 */
export function msmeFilter(value, vendorCodeSql) {
  if (value === 'MSME') return `${vendorMsmeNo(vendorCodeSql)} <> ''`;
  if (value === 'NON_MSME') return `${vendorMsmeNo(vendorCodeSql)} = ''`;
  return null;
}
