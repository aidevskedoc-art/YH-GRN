import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { formatAmountOrDash, formatDate } from './ResultsTable.jsx';
import PageSizeSelect, { usePageSize } from './PageSize.jsx';

/**
 * Where every GRN in this upload stands in the BPAD register.
 *
 * One row per GRN, not one row per register entry. The uploaded workbook is
 * the whole group's -- several hundred thousand rows of it -- and the upload
 * keeps the rows whose vendor code AND GRN number both match a GRN in scope
 * (see readBpadReport on the server), then adds a row for every GRN the
 * register turned out to have no entry for at all.
 *
 * Those last are the point of the column below. A GRN with no register entry
 * is an answer, not an omission: in practice it is a delivery received with no
 * vendor invoice raised against it yet -- the GRN report writes "-" in Bill No
 * -- and BPAD is a register of BILLS pending, so there is nothing yet for it
 * to be pending on. Showing only the entries the register had would leave a
 * reader counting 3,392 rows against 3,402 GRNs with no way to tell which ten
 * were missing or why.
 *
 * It fetches its own rows and owns its own pager, the same way TurnaroundView
 * does and for the same reason: it reads a different table from the other
 * three tabs, so the results page's `status` filter has nothing to say about
 * it and its row count is its own.
 */

/** A cell that is genuinely empty on plenty of rows, said so rather than blank. */
function Text({ value }) {
  return value ? value : <span className="table__miss">&mdash;</span>;
}

/**
 * Whether the register had an entry for this GRN.
/** A date the register carries, or a dash where the bill has not reached it. */
function DateText({ value }) {
  return value ? formatDate(value) : <span className="table__miss">&mdash;</span>;
}

export default function BpadView({ batchId, q, location, dept, register, onDepartments }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Page 7 of the old result set is rarely a page of the new one, so changing
  // the upload, the search or the department starts again from the first page.
  useEffect(() => {
    setPage(1);
  }, [batchId, q, location, dept, register]);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoading(true);
    api
      .bpad(batchId, { page, pageSize, q, location, dept, register })
      .then((next) => {
        setData(next);
        // The departments the register knows about, handed up to the page that
        // owns the dropdown. It sits in the toolbar with Search and Location
        // rather than over the table, so the control is where every other
        // filter on this screen is -- but its options come from this response,
        // which is the only call that reads the register's own table.
        onDepartments?.(next.departments ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, page, pageSize, q, location, dept, register, onDepartments]);

  useEffect(load, [load]);

  if (error) return <div className="alert alert--error">{error}</div>;
  if (loading && !data) return <div className="loading">Loading…</div>;
  if (!data) return null;

  const { rows, total, totalPages } = data;

  /*
   * Nothing here at all is worth explaining rather than showing as an empty
   * table: on this tab it almost always means the register has not been
   * uploaded yet, which is a thing to go and do rather than a search that
   * found nothing. Guarded on nothing being narrowed -- no search, no branch,
   * no department: with any of them set, an empty table is the ordinary answer
   * and the pager below already says so.
   */
  if (total === 0 && !q && !location && !dept && !register) {
    return (
      <div className="alert alert--info">
        <strong>No BPAD register has been matched to this upload yet.</strong> Upload BPAD.xlsx on
        the upload screen — its rows are matched to your GRNs by vendor code and GRN number, and
        the ones that match appear here.
      </div>
    );
  }

  return (
    <>
      {/* The gap between the GRNs in scope and the ones the register knows used
          to be stated in a banner here. It is on the Not in BPAD card above the
          table now -- counting the same rows, and able to show them when
          pressed, which the banner never was. */}
      <div className="table-wrap table-wrap--sticky">
        <table className="table">
          <thead>
            <tr>
              {/* The branch, resolved through the GRN row this record matched
                  -- the register's own Location beside it is a short site code
                  ("HTC"), which is not the vocabulary the configuration screen
                  holds branches under. First column, as on every other tab. */}
              <th>Division</th>
              {/* From here on, the register's own columns in the register's own
                  order. It is a report somebody else produces and reads, and
                  reordering it would make the tab harder to check against the
                  file it came from, not easier.

                  Its Sl.No. led this run and no longer shows, here or in the
                  export: it is the source workbook's row number, and a tab
                  that pages through every upload's records together hands back
                  numbers starting wherever the page happened to fall. The
                  register's own ordering is unchanged -- the rows still arrive
                  in Sl.No. order (see bpadRows on the server), the column
                  saying so is just not printed. */}
              <th>Location</th>
              <th>WareHouse</th>
              <th>Vendor Code</th>
              <th>Vendor Name</th>
              <th>Vendor Category</th>
              <th>Inv.No.</th>
              <th>Inv Date</th>
              <th>GRN No</th>
              <th>GRN Date</th>
              <th className="table__num">GRN Amount</th>
              <th>PO Number</th>
              <th>PO Date</th>
              <th>Pending With Dept.</th>
              {/* The two dates the register exists to report. */}
              <th>BPAD Received Date</th>
              <th>Accounts Received Date</th>
              <th>Pending With User/Status</th>
              {/* Last. The register's own QueryAgeing, Ageing and GRN Age used
                  to follow -- they are gone, here and in the store: the
                  register derives all three from dates it also carries, so a
                  copy taken at upload time was only ever true on that day. The
                  two dates above are the ones it reports, and they do not go
                  stale. */}
              <th>Pend.Reason/Pend Dept</th>
              {/* Days from GRN Date, worked out on the server per desk:
                  Accounts to Accounts Received Date, Stores to today, every
                  other desk to BPAD Received Date. */}
              <th className="table__num">Age from GRN Date</th>
            </tr>
          </thead>
          <tbody>
            {/* The header stays: which columns this tab has is worth seeing
                even when nothing matches, and the table not vanishing keeps
                the page from jumping as a search is typed. */}
            {rows.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={19}>
                  Matches not found
                </td>
              </tr>
            )}
            {rows.map((row) => (
              // The register repeats a GRN across a split invoice, so the GRN
              // number is not a key here the way it is on the other tabs. The
              // stored row's own id is.
              <tr key={row.id}>
                <td>
                  <Text value={row.branchDivisionCode} />
                </td>
                <td>
                  <Text value={row.location} />
                </td>
                <td>
                  <Text value={row.warehouse} />
                </td>
                <td>{row.vendorCode}</td>
                <td>{row.vendorName}</td>
                <td>
                  <Text value={row.vendorCategory} />
                </td>
                <td>
                  <Text value={row.invNo} />
                </td>
                <td>
                  <DateText value={row.invDate} />
                </td>
                <td>{row.grnNo}</td>
                <td>
                  <DateText value={row.grnDate} />
                </td>
                <td className="table__num">{formatAmountOrDash(row.grnAmount)}</td>
                <td>
                  <Text value={row.poNumber} />
                </td>
                <td>
                  <DateText value={row.poDate} />
                </td>
                <td>
                  <Text value={row.pendingWithDept} />
                </td>
                <td>
                  <DateText value={row.bpadReceivedDate} />
                </td>
                <td>
                  <DateText value={row.accountsReceivedDate} />
                </td>
                <td>
                  <Text value={row.pendingWithUser} />
                </td>
                <td>
                  <Text value={row.pendReason} />
                </td>
                <td className="table__num">
                  {row.ageing ?? <span className="table__miss">&mdash;</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span className="pager__info">
          {total === 0
            ? q
              ? `Nothing matches "${q}"`
              : 'No rows'
            : `Showing ${(page - 1) * pageSize + 1}–${Math.min(
                page * pageSize,
                total,
              )} of ${total.toLocaleString('en-IN')}`}
        </span>
        <div className="pager__controls">
          <PageSizeSelect
            value={pageSize}
            onChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
          <button
            className="ghost"
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span className="pager__page">
            Page {page} of {totalPages}
          </span>
          <button
            className="ghost"
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
