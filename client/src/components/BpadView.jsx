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
 *
 * A pill rather than a Yes/No, and the same pills the rest of the app uses for
 * a row's standing: on a tab where most rows say the same thing, the exception
 * has to be the one that catches the eye. `unsent` is the muted grey the other
 * tables use for "this has not happened", which is exactly what this is.
 */
function RegisterState({ inRegister }) {
  return inRegister ? (
    <span className="pill pill--valid" title="The BPAD register has an entry for this GRN">
      In register
    </span>
  ) : (
    <span
      className="pill pill--unsent"
      title="The BPAD register has no entry for this GRN — usually a delivery with no vendor invoice raised against it yet, and BPAD tracks bills"
    >
      Not in register
    </span>
  );
}

/** A date the register carries, or a dash where the bill has not reached it. */
function DateText({ value }) {
  return value ? formatDate(value) : <span className="table__miss">&mdash;</span>;
}

/**
 * One of the register's three ageing counts, in days.
 *
 * GRN Age arrives fractional ("9.44") and the other two whole, so they are
 * formatted as they come rather than rounded to a common shape -- the register
 * means something slightly different by each, and rounding would quietly make
 * them look like the same measure.
 */
function Days({ value }) {
  if (value === null || value === undefined) return <span className="table__miss">&mdash;</span>;
  return <span>{Number(value).toLocaleString('en-IN')}</span>;
}

export default function BpadView({ batchId, q, location }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Page 7 of the old result set is rarely a page of the new one, so changing
  // the upload or the search starts again from the first page.
  useEffect(() => {
    setPage(1);
  }, [batchId, q, location]);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoading(true);
    api
      .bpad(batchId, { page, pageSize, q, location })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, page, pageSize, q, location]);

  useEffect(load, [load]);

  if (error) return <div className="alert alert--error">{error}</div>;
  if (loading && !data) return <div className="loading">Loading…</div>;
  if (!data) return null;

  const { rows, total, totalPages, missing = 0 } = data;

  /*
   * Nothing here at all is worth explaining rather than showing as an empty
   * table: on this tab it almost always means the register has not been
   * uploaded yet, which is a thing to go and do rather than a search that
   * found nothing. Guarded on there being no search: with one typed, an empty
   * table is the ordinary answer and the pager below already says so.
   */
  if (total === 0 && !q && !location) {
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
      {/* Stated once, above the table, rather than left to be inferred from a
          run of grey pills at the top of the first page. Counted over
          everything in scope rather than over this page, so it does not change
          as the reader pages through. Only shown when there is a gap: on an
          upload the register covers completely there is nothing to say. */}
      {missing > 0 && (
        <div className="alert alert--info">
          <strong>
            {missing.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} GRN
            {total === 1 ? '' : 's'} {missing === 1 ? 'has' : 'have'} no entry in the BPAD register.
          </strong>{' '}
          They are listed first, with the register&rsquo;s own columns empty. Usually these are
          goods received on a delivery challan with no vendor invoice raised yet — BPAD is a
          register of bills pending, so a GRN with no bill has nothing to be pending on.
        </div>
      )}

      <div className="table-wrap table-wrap--sticky">
        <table className="table">
          <thead>
            <tr>
              {/* The branch, resolved through the GRN row this record matched
                  -- the register's own Location beside it is a short site code
                  ("HTC"), which is not the vocabulary the configuration screen
                  holds branches under. First column, as on every other tab. */}
              <th>Division</th>
              {/* Ahead of the register's columns rather than after them,
                  because it is what says how to read the rest of the row: on a
                  "Not in register" row everything from Sl.No. onwards is empty
                  because BPAD has never been told about the bill, not because
                  the data is missing. */}
              <th>In BPAD Register</th>
              {/* From here on, the register's own columns in the register's own
                  order. It is a report somebody else produces and reads, and
                  reordering it would make the tab harder to check against the
                  file it came from, not easier. */}
              <th className="table__num">Sl.No.</th>
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
              <th>Pend.Reason/Pend Dept</th>
              <th className="table__num">QueryAgeing</th>
              <th className="table__num">Ageing</th>
              <th className="table__num">GRN Age</th>
            </tr>
          </thead>
          <tbody>
            {/* The header stays: which columns this tab has is worth seeing
                even when nothing matches, and the table not vanishing keeps
                the page from jumping as a search is typed. */}
            {rows.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={23}>
                  Matches not found
                </td>
              </tr>
            )}
            {rows.map((row) => (
              // The register repeats a GRN across a split invoice, and a GRN it
              // has no entry for carries no Sl.No at all -- so neither is a key
              // here the way the GRN number is on the other tabs. The stored
              // row's own id is.
              <tr key={row.id}>
                <td>
                  <Text value={row.branchDivisionCode} />
                </td>
                <td>
                  <RegisterState inRegister={row.inRegister} />
                </td>
                <td className="table__num">{row.slNo ?? ''}</td>
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
                  <Days value={row.queryAgeing} />
                </td>
                <td className="table__num">
                  <Days value={row.ageing} />
                </td>
                <td className="table__num">
                  <Days value={row.grnAge} />
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
