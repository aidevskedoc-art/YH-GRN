/**
 * The MSME No and MSME Status cells, beside the vendor on every GRN table --
 * Total GRNS, Pending, Accounts, BPAD, the PR-to-Bank ageing and the CS
 * Department queue.
 *
 * The values come from the server (see services/vendorMsme.js there): the
 * vendor's MSME number off the HIS vendor master, and MSME or Non-MSME from
 * whether it has one. Both are null for a vendor the vendor master has no row
 * for, and both cells read as a dash then -- that says nothing either way,
 * which Non-MSME would not.
 *
 * One component so the six tables cannot drift apart on how an absent value
 * reads. Their headers stay in each table, which is where each keeps its own
 * header row.
 */
export default function MsmeCells({ row }) {
  return (
    <>
      <td className="table__mono">{row.msmeNo || <span className="table__miss">&mdash;</span>}</td>
      <td>
        {row.msmeStatus || (
          <span className="table__miss" title="Not on the HIS vendor master">
            &mdash;
          </span>
        )}
      </td>
    </>
  );
}
