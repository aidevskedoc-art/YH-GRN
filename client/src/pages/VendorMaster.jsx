/**
 * Vendor Master: every vendor the HIS vendor master -- the correct data -- has
 * ever listed, once each, with its latest details.
 *
 * No upload of its own: each vendor master file uploaded on the HIS vs FOCUS
 * Reco screen adds its new vendors here and updates the ones already here
 * (services/vendorMaster.js on the server). Nothing is ever removed, and a
 * reco cannot be deleted. What FOCUS (Accounts) needs changing to match it is
 * the reco screen's to show.
 *
 * The two things set here are each vendor's Inter (No or Yes) and Supply Type
 * (Regular or Stents), which no file carries -- No and Regular until somebody
 * picks otherwise from the dropdown in its column, which saves at once.
 *
 * The cards divide the master by its STATUS column, whatever values the files
 * use, when they use more than one.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { VENDOR_PICKED, exportVendorMaster, pickedValue, vendorMasterLayout } from '../services/exporter.js';
import { singlePress } from '../services/press.js';

/** Matches the other screens' search boxes. */
const SEARCH_DELAY_MS = 300;

/** The card holding every row, and the one for rows with a blank STATUS -- as the API names them. */
const ALL_VIEW = 'ALL';
const NO_STATUS_VIEW = 'NO_STATUS';

/** A STATUS card's colour, borrowed from an existing card tone. */
const STATUS_TONES = {
  ACTIVE: 'valid',
  INACTIVE: 'rejected',
  [NO_STATUS_VIEW]: 'dept',
};

/** A cell longer than this wraps rather than widening its column to fit. */
const LONG_CELL = 40;

/** dd/MM/yyyy HH:mm from a timestamp, in the browser's own zone. */
function formatStamp(value) {
  if (!value) return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

const count = (n) => (n ?? 0).toLocaleString('en-IN');

/** "INACTIVE" -> "Inactive": a STATUS value as a card names it. */
function statusLabel(key) {
  if (key === NO_STATUS_VIEW) return 'No status';
  return key.charAt(0) + key.slice(1).toLowerCase();
}

/**
 * The cards, in the order they stand: the whole master, then one per STATUS
 * value -- only when there is more than one, since a lone Active card would
 * repeat the first card's number.
 */
function cardsFor(counts) {
  const statuses = counts.statuses ?? [];
  return [
    { key: ALL_VIEW, label: 'All vendors', hint: 'every vendor in the Vendor Master', tone: 'all', n: counts[ALL_VIEW] },
    ...(statuses.length > 1 ? statuses : []).map((s) => ({
      key: s.key,
      label: statusLabel(s.key),
      hint: s.key === NO_STATUS_VIEW ? 'STATUS left blank' : `STATUS is ${s.key}`,
      tone: STATUS_TONES[s.key] ?? 'received',
      n: s.count,
    })),
  ];
}

export default function VendorMaster() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [view, setView] = useState(ALL_VIEW);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  // The vendors with a pick on its way to the server, by id.
  const [saving, setSaving] = useState({});

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
  }, [view]);

  const load = useCallback(() => {
    // A newer request supersedes an older one still in flight, so a quick run
    // of card clicks cannot end on the rows of a card that is no longer picked.
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .vendorMasterRows({ view, q, page, pageSize })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, q, page, pageSize]);

  useEffect(load, [load]);

  function pickView(key) {
    // The active card pressed again goes back to every vendor.
    setView(key === view && key !== ALL_VIEW ? ALL_VIEW : key);
  }

  /** One vendor's row, changed in place. */
  function patchRow(id, change) {
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...change } : r)) });
  }

  /**
   * Save a vendor's Inter or Supply Type (`field`, as VENDOR_PICKED names it)
   * as soon as it is picked. Shown at once, and put back with the reason if the
   * server refuses it.
   */
  async function changePicked(row, field, value) {
    const next = value;
    const before = pickedValue(row, field);
    if (!next || next === before) return;
    setError('');
    setSaving((s) => ({ ...s, [row.id]: true }));
    patchRow(row.id, { [field]: next });
    try {
      await api.updateVendor(row.id, { [field]: next });
    } catch (err) {
      patchRow(row.id, { [field]: before });
      setError(err.message);
    } finally {
      setSaving(({ [row.id]: _done, ...rest }) => rest);
    }
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      const card = data?.counts && cardsFor(data.counts).find((c) => c.key === view);
      await exportVendorMaster({
        view,
        // The whole master's sheet is just "Vendor Master"; a card's says which.
        label: view === ALL_VIEW ? '' : card?.label,
        q,
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
    setView(ALL_VIEW);
    setPage(1);
  }

  // Everything below the head waits for the first answer, and for there to be
  // a vendor in it.
  const ready = Boolean(data && data.vendorCount > 0);
  const lastApply = data?.lastApply ?? null;
  const cards = ready ? cardsFor(data.counts) : [];
  const headers = data?.headers ?? [];
  const codeAt = data?.codeIndex ?? -1;
  const nameAt = data?.nameIndex ?? -1;
  // The same columns, in the same order, as the export writes.
  const layout = vendorMasterLayout(data ?? {});
  const anyFilter = Boolean(q || view !== ALL_VIEW);

  /** The pin classes for the column at source index `i`, if it is one of the two held. */
  const pinClass = (i) => {
    if (i < 0) return '';
    if (i === codeAt) return ' table__pin vm-pin--code';
    if (i === nameAt) return ' table__pin vm-pin--name';
    return '';
  };

  // No reco has brought a vendor in yet.
  if (data && data.vendorCount === 0) {
    return (
      <div className="empty empty--page">
        <h2>No vendors yet</h2>
        <p>
          The Vendor Master is filled from the HIS vendor master uploaded with each reco on the HIS vs FOCUS Reco
          screen.
        </p>
        {can('msme-reco') && (
          <button className="primary" type="button" onClick={() => navigate('/msme-reco')}>
            Go to HIS vs FOCUS Reco
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Vendor Master</h2>
          <p className="page__lead">
            Every vendor from the HIS vendor master, which is the correct data, once each. Each HIS vs FOCUS Reco adds
            its new vendors and updates the rest with the latest values. What needs changing in the FOCUS (Accounts)
            vendor list to match is on the HIS vs FOCUS Reco screen.
          </p>
        </div>
        <div className="page__actions">
          {can('msme-reco') && (
            <button className="ghost" type="button" onClick={() => navigate('/msme-reco')}>
              Open HIS vs FOCUS Reco
            </button>
          )}
          <button
            className="ghost"
            type="button"
            onClick={handleExport}
            disabled={exporting || !data?.total}
            title="Every column of the vendors on screen: the card and the search apply"
          >
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {ready && (
        <div className="msme-runbar">
          <span className="msme-runbar__meta">
            {count(data.vendorCount)} vendors · {count(headers.length)} columns
            {lastApply &&
              ` · Last updated by the reco of ${formatStamp(lastApply.uploadedAt)} (${lastApply.fileName}` +
                `${lastApply.sheetName ? `, sheet “${lastApply.sheetName}”` : ''}` +
                `${lastApply.uploadedBy ? `, by ${lastApply.uploadedBy}` : ''}): ` +
                `${count(lastApply.added)} new, ${count(lastApply.updated)} updated, ` +
                `${count(lastApply.unchanged)} unchanged` +
                `${lastApply.skipped > 0 ? `, ${count(lastApply.skipped)} already newer` : ''}`}
          </span>
        </div>
      )}

      {/* No file read whole has reached the master yet, only recos run before
          it existed: their files were not kept, so they could only bring the
          columns the reco reads. */}
      {ready && lastApply?.rebuiltOnly && (
        <p className="table__note">
          These details were rebuilt from recos run before the Vendor Master existed, so only the columns the reco
          reads are here. The next HIS vs FOCUS Reco fills in every column of the file.
        </p>
      )}

      {ready && (
        <div className={`cards${cards.length <= 2 ? ' cards--few' : ''}`}>
          {cards.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`card stat stat--${c.tone} ${view === c.key ? 'is-active' : ''}`}
              onClick={singlePress(() => pickView(c.key))}
              aria-pressed={view === c.key}
              title={view === c.key && c.key !== ALL_VIEW ? 'Press again to show every vendor' : `Show ${c.label}`}
            >
              <div className="stat__label">{c.label}</div>
              <div className="stat__value">{count(c.n)}</div>
              <div className="stat__hint">{c.hint}</div>
            </button>
          ))}
        </div>
      )}

      {ready && (
        <div className="toolbar">
          <p className="msme-legend">
            Columns are headed with the vendor master&rsquo;s own names. <strong>VENDOR_CODE</strong> and{' '}
            <strong>VENDOR_NAME</strong> stay put while the table scrolls sideways. Pick each vendor&rsquo;s{' '}
            <strong>Inter</strong> (No unless changed to Yes) and <strong>Supply Type</strong> (Regular unless
            changed to Stents) and it is saved at once; a later reco leaves both as they are.
          </p>
          <div className="toolbar__actions">
            <input
              className="field__input search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search any column: code, name, PAN, GST, IFSC…"
              aria-label="Search the vendor master"
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

      {loading && !data && <div className="loading">Loading…</div>}

      {ready && (
        <>
          <div className={`table-wrap table-wrap--sticky${loading ? ' is-loading' : ''}`}>
            <table className="table vm-table">
              <thead>
                <tr>
                  {layout.map((c) => (
                    <th key={c.key} className={pinClass(c.index).trim() || undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td className="table__empty" colSpan={layout.length}>
                      {anyFilter ? 'No vendors match these filters' : 'No vendors in the Vendor Master'}
                    </td>
                  </tr>
                )}
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    {layout.map((c) => {
                      if (c.picked) {
                        return (
                          <td key={c.key}>
                            <select
                              className="stage-select"
                              value={pickedValue(row, c.picked)}
                              onChange={(e) => changePicked(row, c.picked, e.target.value)}
                              disabled={Boolean(saving[row.id])}
                              aria-label={`${c.label} of ${codeAt >= 0 ? row.cells[codeAt] : 'this vendor'}`}
                            >
                              {Object.entries(VENDOR_PICKED[c.picked].options).map(([key, label]) => (
                                <option key={key} value={key}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </td>
                        );
                      }
                      const value = c.index >= 0 ? row.cells[c.index] : null;
                      const long = value && value.length > LONG_CELL;
                      const className = `${pinClass(c.index)}${c.index >= 0 && c.index === codeAt ? ' table__mono' : ''}${
                        long ? ' vm-cell--long' : ''
                      }`.trim();
                      return (
                        <td key={c.key} className={className || undefined}>
                          {value || <span className="table__miss">&mdash;</span>}
                        </td>
                      );
                    })}
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
