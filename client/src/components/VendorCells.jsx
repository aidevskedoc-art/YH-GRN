/**
 * The vendor's Vendor Master cells, beside the vendor on every GRN table --
 * Total GRNS, Pending, Accounts, BPAD, the PR-to-Bank ageing and the CS
 * Department queue: MSME No, MSME Status, Inter and Supply Type.
 *
 * The values come from the server (see services/vendorMsme.js there), looked up
 * in the Vendor Master on every read: the vendor's MSME number and MSME or
 * Non-MSME from whether it has one, and the Inter and Supply Type picked on the
 * Vendor Master screen -- so a change there shows on every GRN of the vendor
 * the next time a table loads. All four are null for a vendor the Vendor Master
 * has no row for, and read as a dash then -- that says nothing either way,
 * which Non-MSME, No or Regular would not.
 *
 * One component so the six tables cannot drift apart on how an absent value
 * reads. Their headers stay in each table, which is where each keeps its own
 * header row: MSME No, MSME Status, Inter, Supply Type, in that order.
 */

/** How many cells this renders, for the tables' column counts. */
export const VENDOR_CELL_COUNT = 4;

const MISSING = (
  <span className="table__miss" title="Not in the Vendor Master">
    &mdash;
  </span>
);

export default function VendorCells({ row }) {
  return (
    <>
      <td className="table__mono">{row.msmeNo || <span className="table__miss">&mdash;</span>}</td>
      <td>{row.msmeStatus || MISSING}</td>
      <td>{row.inter || MISSING}</td>
      <td>{row.supplyType || MISSING}</td>
    </>
  );
}
