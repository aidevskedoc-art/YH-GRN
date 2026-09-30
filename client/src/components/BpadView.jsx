import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { todayIso } from '../services/ageing.js';
import { BpadAgeDays, bpadAgeHeaderTitle, formatAmountOrDash, formatDate } from './ResultsTable.jsx';
import PageSizeSelect, { usePageSize } from './PageSize.jsx';
import VendorCells, { VENDOR_CELL_COUNT } from './VendorCells.jsx';

/**
 * The BPAD register's entries for the GRNs in this upload.
 *
 * The uploaded workbook is the whole group's -- several hundred thousand rows
 * of it -- and the upload keeps the rows whose vendor code AND GRN number both
 * match a GRN in scope (see readBpadReport on the server). One row per register
 * entry, so a GRN the register repeats across a split invoice is on more than
 * one row.
 *
 * Only the register's own entries. The upload also stores a row for every GRN
 * the register had no entry for -- in practice a delivery received with no
 * vendor invoice raised against it yet, and BPAD is a register of BILLS
 * pending -- but those GRNs are not in BPAD. They are still at the GRN store,
 * and the Pending GRNs at GRN Store card on the Total GRNS row is where they
 * are counted and listed; the server leaves them out of this tab (see
 * BPAD_IN_REGISTER in routes/results.js). So the pager here counts the same
 * entries the BPAD card does.
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

/** A date the register carries, or a dash where the bill has not reached it. */
function DateText({ value }) {
  return value ? formatDate(value) : <span className="table__miss">&mdash;</span>;
}

/*
 * The Age from GRN Date cell is BpadAgeDays in ResultsTable.jsx, shared with
 * the Pending GRNs at BPAD view, which shows the same column by the same rule.
 */

export default function BpadView({
  batchId,
  q,
  location,
  msme,
  dept,
  notIntegrated = false,
  accountsFrom = '',
  onDepartments,
  onNotIntegrated,
  ageingAsOf = todayIso(),
  registerOnFile = false,
}) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // The date only narrows the rows while the Not Integrated card is pressed;
  // otherwise moving it re-counts that card and leaves the table as it is.
  const rowsFrom = notIntegrated ? accountsFrom : '';

  // Page 7 of the old result set is rarely a page of the new one, so changing
  // the upload, the search or the department starts again from the first page.
  useEffect(() => {
    setPage(1);
  }, [batchId, q, location, msme, dept, notIntegrated, rowsFrom]);

  // Which request is the latest. Typing a year into the date picker sends one
  // request per digit -- 0002, 0020, 0202, 2026 are each a whole date -- and
  // an older answer landing last would leave the card counting from year 202.
  const latestRequest = useRef(0);

  const load = useCallback(() => {
    if (!batchId) return;
    const request = ++latestRequest.current;
    const latest = () => request === latestRequest.current;
    setLoading(true);
    api
      .bpad(batchId, { page, pageSize, q, location, msme, dept, notIntegrated, accountsFrom })
      .then((next) => {
        if (!latest()) return;
        setData(next);
        // The departments the register knows about, handed up to the page that
        // owns the dropdown. It sits in the toolbar with Search and Location
        // rather than over the table, so the control is where every other
        // filter on this screen is -- but its options come from this response,
        // which is the only call that reads the register's own table.
        onDepartments?.(next.departments ?? []);
        // The Not Integrated in Accounts card's figure, the same way: the
        // card is the page's, the figure comes with the register's rows.
        onNotIntegrated?.(next.notIntegrated ?? null);
      })
      .catch((err) => {
        if (latest()) setError(err.message);
      })
      .finally(() => {
        if (latest()) setLoading(false);
      });
  }, [
    batchId,
    page,
    pageSize,
    q,
    location,
    msme,
    dept,
    notIntegrated,
    accountsFrom,
    onDepartments,
    onNotIntegrated,
  ]);

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
   * no department, no card: with any of them set, an empty table is the
   * ordinary answer and the pager below already says so. Not Integrated in
   * the Accounts above all, where no rows is the answer everybody hopes for.
   *
   * `registerOnFile` is the other way to get here: a register has been
   * uploaded, but it has no entry for any of these GRNs. Telling somebody to
   * upload a file they already have would be wrong, so that case says where
   * the GRNs are instead.
   */
  if (total === 0 && !q && !location && !msme && !dept && !notIntegrated) {
    return registerOnFile ? (
      <div className="alert alert--info">
        <strong>The BPAD register on file has no entry for any of these GRNs.</strong> They are
        still at the GRN store — see Pending GRNs at GRN Store on the Total GRNS view.
      </div>
    ) : (
      <div className="alert alert--info">
        <strong>No BPAD register has been matched to this upload yet.</strong> Upload BPAD.xlsx on
        the upload screen — its rows are matched to your GRNs by vendor code and GRN number, and
        the ones that match appear here.
      </div>
    );
  }

  return (
    <>
      {/* The GRNs the register has no entry for are not listed here: they are
          not in BPAD. The Pending GRNs at GRN Store card on the Total GRNS row
          counts them and shows them when pressed. */}
      <div className="table-wrap table-wrap--sticky">
        <table className="table">
          <thead>
            <tr>
              {/* The branch, resolved through the GRN row this record matched
                  -- the register's own Location beside it is a short site code
                  ("HTC"), which the configuration screen scopes nothing by (its
                  Location (BPAD) is read by the upload only). First column, as
                  on every other tab. */}
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
              {/* Not the register's own: the vendor's details off the Vendor
                  Master -- its MSME registration, and the Inter and Supply Type
                  picked there -- beside the vendor as on every GRN table. See
                  VendorCells. */}
              <th>MSME No</th>
              <th>MSME Status</th>
              <th>Inter</th>
              <th>Supply Type</th>
              {/* The register's Vendor Category used to follow. It is no
                  longer read, stored or exported. */}
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
              {/* Days from GRN Date, per desk: Accounts to Accounts Received
                  Date, Stores to the "Age as of" date in the toolbar (today
                  until changed), every other desk to BPAD Received Date. See
                  bpadAgeDays in services/ageing.js. */}
              <th className="table__num" title={bpadAgeHeaderTitle(ageingAsOf)}>
                Age from GRN Date
              </th>
            </tr>
          </thead>
          <tbody>
            {/* The header stays: which columns this tab has is worth seeing
                even when nothing matches, and the table not vanishing keeps
                the page from jumping as a search is typed. */}
            {rows.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={18 + VENDOR_CELL_COUNT}>
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
                <VendorCells row={row} />
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
                  <BpadAgeDays row={row} asOf={ageingAsOf} />
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
              : notIntegrated
                ? 'None — every bill BPAD has at Accounts is in the Vendor Ageing report'
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
