/**
 * HIS vs FOCUS Reco: the HIS vendor master held against the Accounts (FOCUS)
 * vendor list. Named MsmeReco in code, where it began as the MSME reco -- the
 * route, the screen key and the tables keep that name.
 *
 * Both files are uploaded together as a run. Vendors are matched on their code
 * -- VENDOR_CODE in the vendor master, Code in the Accounts list -- and every
 * vendor the two share is compared on name, PAN, GST, drug licence, MSME
 * number, type and activity, bank account, IFSC and payee name. Anything that
 * differs is named in the row's Remarks and marked in red in the table; the
 * Excel file is plain and relies on Remarks (see services/msmeReco.js on the
 * server for the rules).
 *
 * Runs are stored, but there is no picking one: the page shows every vendor
 * at once, each once, from the latest reco that had it -- so uploading the
 * same files again replaces those rows rather than adding a second set. The
 * line over the table describes the latest reco, and each row says which
 * reco it came from. There is no deleting a run either: the HIS vendor master
 * each brought is merged into the Vendor Master, which keeps one row per
 * vendor.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import FileDrop from '../components/FileDrop.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { IconAlert, IconArrowRight, IconPlus } from '../components/icons.jsx';
import { exportMsmeReco, MSME_STATUS_LABELS } from '../services/exporter.js';
import { singlePress } from '../services/press.js';

/** Matches the other screens' search boxes. */
const SEARCH_DELAY_MS = 300;

/**
 * The cards, in the order they stand: the vendor master whole, then its three
 * verdicts. Every vendor master row is stored; the Accounts codes it lacks are
 * only counted, and the latest reco's count is shown in the note under the
 * line over the table, with no rows to open.
 * `tone` borrows an existing card colour.
 */
const ALL_VIEW = 'ALL';
const VIEWS = [
  { key: ALL_VIEW, label: 'HIS vendors', hint: 'every vendor master row', tone: 'all' },
  { key: 'MISMATCH', label: 'Mismatched', hint: 'in both files, details differ', tone: 'rejected' },
  { key: 'MATCHED', label: 'Matched', hint: 'in both files, every detail agrees', tone: 'valid' },
  { key: 'NOT_IN_ACCOUNTS', label: 'Not in FOCUS', hint: 'vendor code missing from FOCUS', tone: 'missing' },
];

/** The views a field chip means anything in -- the others have no mismatches to narrow by. */
const FIELD_VIEWS = new Set([ALL_VIEW, 'MISMATCH']);

const STATUS_PILLS = {
  MATCHED: 'valid',
  MISMATCH: 'rejected',
  NOT_IN_ACCOUNTS: 'queued',
};

/** dd/MM/yyyy HH:mm from a timestamp, in the browser's own zone. */
function formatStamp(value) {
  if (!value) return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** dd/MM/yyyy from a timestamp -- the Reco date column. */
function formatDay(value) {
  if (!value) return '';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB') : '';
}

const count = (n) => (n ?? 0).toLocaleString('en-IN');

function runLabel(run) {
  return `${formatStamp(run.uploadedAt)} — ${run.vendorFileName} vs ${run.accountFileName}`;
}

/** The fields that hold a name rather than a code: wide enough to wrap. */
const WIDE_FIELDS = new Set(['name', 'payeeName']);

/**
 * The field whose pair stays put with Vendor Code and Status while the table
 * is scrolled sideways -- the vendor's name is what every row is read by. Both
 * its columns are held, not just the HIS one: they share one header band, and
 * half a band cannot be pinned. See the msme-pin rules in styles.css.
 */
const PINNED_FIELD = 'name';

/** The classes that hold one of the pinned field's cells at the left edge. */
function pinClass(fieldKey, side) {
  if (fieldKey !== PINNED_FIELD) return '';
  return ` table__pin msme-pin--${side}-name`;
}

/**
 * One compared field as the Excel file lays it out: the vendor master's value
 * and the FOCUS (Accounts) one in two columns of their own, both marked when
 * the reco found them different. A blank reads as a dash, and so does the
 * FOCUS side of a vendor FOCUS has no code for -- the Status column says which.
 */
function PairCells({ row, fieldKey }) {
  const flagged = row.mismatchFields.includes(fieldKey);
  const className = `msme-cell${WIDE_FIELDS.has(fieldKey) ? ' msme-cell--wide' : ''}${flagged ? ' is-flagged' : ''}`;
  const his = row.his?.[fieldKey];
  const acc = row.acc?.[fieldKey];
  return (
    <>
      <td className={`${className}${pinClass(fieldKey, 'his')}`}>
        {his || <span className="table__miss">&mdash;</span>}
      </td>
      <td className={`${className} msme-cell--acc${pinClass(fieldKey, 'acc')}`}>
        {acc || <span className="table__miss">&mdash;</span>}
      </td>
    </>
  );
}

export default function MsmeReco() {
  const [showUpload, setShowUpload] = useState(false);

  // --- The upload form ---------------------------------------------------
  const [vendorFile, setVendorFile] = useState(null);
  const [accountFile, setAccountFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // --- What is on screen -------------------------------------------------
  const [data, setData] = useState(null);
  const [view, setView] = useState(ALL_VIEW);
  const [field, setField] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  // Bumped after an upload, so the rows are read again even when every filter
  // is already where the upload leaves it.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Page 7 of one view is rarely a page of the next.
  useEffect(() => {
    setPage(1);
  }, [view, field]);

  const load = useCallback(() => {
    // A newer request supersedes an older one still in flight, so a quick run
    // of card clicks cannot end on the rows of a card that is no longer picked.
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .msmeRows({ view, field, q, page, pageSize })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // No reco yet: the form opens, since uploading is the only thing to do.
        if (!result.latestRun) setShowUpload(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        // The form still works when the rows could not be read, so it is not
        // left unreachable behind the error.
        setShowUpload(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, field, q, page, pageSize, reloads]);

  useEffect(load, [load]);

  function pickView(key) {
    // The active card pressed again goes back to the whole vendor master.
    const next = key === view && key !== ALL_VIEW ? ALL_VIEW : key;
    setView(next);
    if (!FIELD_VIEWS.has(next)) setField('');
  }

  function pickFile(setter) {
    return (file) => {
      setUploadError('');
      setter(file);
    };
  }

  async function handleUpload(event) {
    event.preventDefault();
    setUploadError('');
    if (!vendorFile || !accountFile) {
      setUploadError('Please choose both files: the HIS vendor master and the Accounts vendor list.');
      return;
    }

    const formData = new FormData();
    formData.append('vendorFile', vendorFile);
    formData.append('accountFile', accountFile);

    setUploading(true);
    try {
      await api.runMsmeReco(formData);
      // Back to every vendor, first page, with the new reco's rows in place.
      setView(ALL_VIEW);
      setField('');
      setSearch('');
      setQ('');
      setPage(1);
      setReloads((n) => n + 1);
      setVendorFile(null);
      setAccountFile(null);
      setShowUpload(false);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      // One workbook, a sheet per card -- the cards themselves are the list,
      // so the file always has the sheets the screen has.
      await exportMsmeReco({
        q,
        cards: VIEWS.map((v) => ({ label: v.label, status: v.key === ALL_VIEW ? null : v.key })),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function clearFilters() {
    setSearch('');
    setQ('');
    setField('');
    setView(ALL_VIEW);
    setPage(1);
  }

  // The latest reco: what the line over the table describes. Everything below
  // the form waits for there to be one.
  const run = data?.latestRun ?? null;
  const shownFields = data?.fields ?? [];
  const anyFilter = Boolean(q || field || view !== ALL_VIEW);
  const chipsShown = FIELD_VIEWS.has(view) && run && shownFields.length > 0;
  // Vendor Code, Warehouse, Status, two per field, Remarks, Reco date.
  const colSpan = shownFields.length * 2 + 5;

  return (
    <>
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">HIS vs FOCUS Reco</h2>
          <p className="page__lead">
            The HIS vendor master against the FOCUS (Accounts) vendor list, matched on vendor code. Name, PAN, GST,
            drug licence, MSME and bank details are compared, and every difference is written in Remarks.
          </p>
        </div>
        <div className="page__actions">
          {run && (
            <button
              className={showUpload ? 'ghost' : 'primary'}
              type="button"
              onClick={() => setShowUpload((v) => !v)}
              aria-expanded={showUpload}
            >
              {showUpload ? (
                'Hide upload'
              ) : (
                <>
                  <IconPlus size={16} /> New reco
                </>
              )}
            </button>
          )}
          {/* Enabled on the whole run, not the card on screen: the workbook
              carries every card, so an empty card is no reason to refuse it. */}
          <button
            className="ghost"
            type="button"
            onClick={handleExport}
            disabled={exporting || !data?.counts?.ALL}
            title="One workbook, with a sheet for each card"
          >
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {showUpload && (
        <form className="card upload msme-upload" onSubmit={handleUpload}>
          <div className="upload__rule">
            <span>The two masters</span>
          </div>

          <div className="drops drops--two">
            <FileDrop
              step={1}
              label="HIS Vendor Master"
              hint="The correct data: matched on VENDOR_CODE, and added to the Vendor Master — new vendors added, known ones updated. The reco reads the Active sheet when the workbook has one."
              example="00. VendorMasterReport from HIS.xlsx"
              file={vendorFile}
              onSelect={pickFile(setVendorFile)}
              onReject={setUploadError}
            />
            <FileDrop
              step={2}
              label="Accounts Vendor List"
              hint="The 010Account export. Matched on Code."
              example="02. 010Account.xlsx"
              file={accountFile}
              onSelect={pickFile(setAccountFile)}
              onReject={setUploadError}
            />
          </div>

          {uploadError && (
            <div className="alert alert--error alert--icon" role="alert">
              <IconAlert size={16} />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="upload__foot">
            <p className="upload__ready">
              <span
                className={`readydots readydots--${[vendorFile, accountFile].filter(Boolean).length}`}
                aria-hidden="true"
              >
                <i />
                <i />
              </span>
              {vendorFile && accountFile
                ? 'Both files ready'
                : vendorFile
                  ? 'Vendor master ready — choose the Accounts vendor list'
                  : accountFile
                    ? 'Accounts vendor list ready — choose the HIS vendor master'
                    : 'Choose the HIS vendor master and the Accounts vendor list'}
            </p>
            <button className="primary upload__go" type="submit" disabled={uploading}>
              {uploading ? 'Reconciling…' : 'Run HIS vs FOCUS reco'}
              {!uploading && <IconArrowRight size={16} />}
            </button>
          </div>

          {uploading && (
            <div className="progress" role="status">
              <span className="progress__bar" />
              <p className="upload__note">
                Reading both workbooks and comparing every vendor. The Accounts list runs to tens of thousands of
                rows, so this can take a little while.
              </p>
            </div>
          )}
        </form>
      )}

      {loading && !data && <div className="loading">Loading…</div>}

      {/* No picking a reco: every vendor is on screen once, from the latest
          reco that had it. This line is the latest reco itself. */}
      {run && (
        <div className="msme-runbar">
          <span className="msme-runbar__meta">
            Latest reco {runLabel(run)}
            {run.vendorSheetName ? ` · Sheet “${run.vendorSheetName}”` : ''} · {count(run.vendorRowCount)} HIS
            vendors · {count(run.accountRowCount)} FOCUS rows
            {run.uploadedBy ? ` · by ${run.uploadedBy}` : ''}
            {run.vendorMaster
              ? ` · Vendor Master: ${count(run.vendorMaster.added)} new, ${count(run.vendorMaster.updated)} updated`
              : ''}
            {data.runCount > 1 ? ` · ${count(data.runCount)} recos in all, each vendor shown once` : ''}
          </span>
        </div>
      )}

      {/* The Accounts codes the vendor master lacks, in the latest reco:
          counted when it ran, not stored, so there is nothing to open -- a
          line of information, not a card. */}
      {run && run.counts?.NOT_IN_HIS > 0 && (
        <p className="table__note">
          Not stored: {count(run.counts.NOT_IN_HIS)} FOCUS code{run.counts.NOT_IN_HIS === 1 ? '' : 's'} not in
          the HIS vendor master.
        </p>
      )}

      {run && (
        <div className="cards">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`card stat stat--${v.tone} ${view === v.key ? 'is-active' : ''}`}
              onClick={singlePress(() => pickView(v.key))}
              aria-pressed={view === v.key}
              title={
                view === v.key && v.key !== ALL_VIEW
                  ? 'Press again to show every HIS vendor'
                  : `Show ${v.label}`
              }
            >
              <div className="stat__label">{v.label}</div>
              <div className="stat__value">{count(data.counts[v.key])}</div>
              <div className="stat__hint">{v.hint}</div>
            </button>
          ))}
        </div>
      )}

      {chipsShown && (
        <div className="msme-fields" role="group" aria-label="Mismatches by field">
          <span className="msme-fields__label">Mismatches by field</span>
          {shownFields.map((f) => {
            const n = data.fieldCounts?.[f.key] ?? 0;
            const active = field === f.key;
            return (
              <button
                key={f.key}
                type="button"
                className={`msme-chip${active ? ' is-active' : ''}`}
                onClick={singlePress(() => setField(active ? '' : f.key))}
                aria-pressed={active}
                disabled={n === 0 && !active}
                title={`${f.his} (HIS) against ${f.acc} (FOCUS)`}
              >
                {f.label}
                <span className="msme-chip__n">{count(n)}</span>
              </button>
            );
          })}
        </div>
      )}

      {run && (
        <div className="toolbar">
          <p className="msme-legend">
            Laid out as the Excel file is: each field has an <strong>HIS</strong> column and a{' '}
            <strong>FOCUS</strong> column. Here, values that differ are marked in red; in the Excel file,
            Remarks says what differs. <strong>Reco date</strong> is the reco each vendor&rsquo;s row comes from.
          </p>
          <div className="toolbar__actions">
            <input
              className="field__input search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search code, name, PAN or GSTIN"
              aria-label="Search the reco"
            />
            {anyFilter && (
              <button type="button" className="ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}

      {run && (
        <>
          <div className={`table-wrap table-wrap--sticky${loading ? ' is-loading' : ''}`}>
            <table className="table msme-table">
              {/* The Excel file's two header rows: a band naming each field
                  over its HIS and FOCUS columns, headed with the source
                  files' own column names. The columns that belong to no field
                  span both rows rather than sitting under an empty band. */}
              <thead>
                <tr>
                  <th rowSpan={2} className="table__pin msme-pin--code msme-table__lead">
                    Vendor Code
                  </th>
                  {/* Not pinned: it slides under Status as the table scrolls. */}
                  <th rowSpan={2} className="msme-table__lead">
                    Warehouse
                  </th>
                  <th rowSpan={2} className="table__pin msme-pin--status msme-table__lead">
                    Status
                  </th>
                  {shownFields.map((f) => (
                    <th
                      key={f.key}
                      colSpan={2}
                      className={`table__group msme-table__band${
                        f.key === PINNED_FIELD ? ' table__pin msme-pin--band' : ''
                      }`}
                    >
                      {f.label}
                    </th>
                  ))}
                  <th rowSpan={2} className="msme-table__lead msme-table__remarks">
                    Remarks
                  </th>
                  <th rowSpan={2} className="msme-table__lead">
                    Reco date
                  </th>
                </tr>
                <tr>
                  {shownFields.map((f) => (
                    <Fragment key={f.key}>
                      <th className={`msme-table__side${pinClass(f.key, 'his')}`} title="HIS vendor master">
                        {f.his} (HIS)
                      </th>
                      <th
                        className={`msme-table__side msme-table__side--acc${pinClass(f.key, 'acc')}`}
                        title="FOCUS (Accounts) vendor list"
                      >
                        {f.acc} (FOCUS)
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td className="table__empty" colSpan={colSpan}>
                      {anyFilter ? 'No vendors match these filters' : 'No vendors in the reco yet'}
                    </td>
                  </tr>
                )}
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="table__pin msme-pin--code table__mono">{row.vendorCode}</td>
                    <td>{row.warehouse || <span className="table__miss">&mdash;</span>}</td>
                    <td className="table__pin msme-pin--status">
                      <span className={`pill pill--${STATUS_PILLS[row.status] ?? 'user'}`}>
                        {MSME_STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    {shownFields.map((f) => (
                      <PairCells key={f.key} row={row} fieldKey={f.key} />
                    ))}
                    <td className="msme-remarks">{row.remarks}</td>
                    <td>{formatDay(row.recoAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <span className="pager__info">
              {data.total === 0
                ? 'No rows'
                : `Showing ${(data.page - 1) * data.pageSize + 1}–${Math.min(
                    data.page * data.pageSize,
                    data.total,
                  )} of ${count(data.total)}`}
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
                disabled={data.page <= 1}
              >
                Previous
              </button>
              <span className="pager__page">
                Page {data.page} of {data.totalPages}
              </span>
              <button
                className="ghost"
                type="button"
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={data.page >= data.totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
