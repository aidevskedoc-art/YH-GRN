/**
 * Activity logs: who did what, and when.
 *
 * The administrator's monitoring screen. Every action that changes something
 * -- an upload, a GRN sent to CSD or Records, a CSD stage move, a take-back,
 * Accounts receiving or forwarding a GRN, a date correction, an account or a
 * branch edited -- is written to the log by the server once it has gone
 * through (see services/activityLog.js). This screen reads it back, newest
 * first, with the filters to find one GRN's history or one person's day.
 *
 * Entries are kept for 90 days.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { exportLogs } from '../services/exporter.js';
import { singlePress } from '../services/press.js';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';

/** Matches the other screens' search boxes. */
const SEARCH_DELAY_MS = 300;

/** Each category's colour, borrowed from the existing card and pill tones. */
const CATEGORY_TONES = {
  UPLOAD: { stat: 'valid', pill: 'valid' },
  CSD: { stat: 'queued', pill: 'queued' },
  ACCOUNTS: { stat: 'approved', pill: 'approved' },
  RECORDS: { stat: 'received', pill: 'received' },
  DATES: { stat: 'pending', pill: 'pending' },
  USERS: { stat: 'dept', pill: 'admin' },
  CONFIG: { stat: 'missing', pill: 'diff' },
  MSME: { stat: 'bpad', pill: 'diff' },
  VENDOR_MASTER: { stat: 'moved_to_accounts', pill: 'moved_to_accounts' },
};

/** dd/MM/yyyy HH:mm from a timestamp, in the browser's own zone. */
function formatStamp(value) {
  if (!value) return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** "chequeNo" -> "Cheque no". */
function fieldLabel(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One detail value as text: timestamps as a day and time, lists joined, blanks as a dash. */
function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatStamp(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * An entry's details as readable lines. `changes` (on the "updated" and date
 * corrections) reads as "Field: before → after"; everything else as
 * "Field: value". Ids are left out -- they mean nothing to a reader.
 */
export function describeDetails(details) {
  if (!details || typeof details !== 'object') return [];
  const lines = [];
  for (const [key, value] of Object.entries(details)) {
    if (key === 'changes' && value && typeof value === 'object') {
      for (const [field, change] of Object.entries(value)) {
        lines.push(`${fieldLabel(field)}: ${valueText(change?.from)} → ${valueText(change?.to)}`);
      }
      continue;
    }
    if (/Id$/.test(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${fieldLabel(key)}: ${valueText(value)}`);
  }
  return lines;
}

/** The Details cell: the summary, with the rest one click away. */
function LogDetails({ entry }) {
  const [open, setOpen] = useState(false);
  const lines = describeDetails(entry.details);
  return (
    <div className="table__wrap">
      {entry.summary}
      {lines.length > 0 && (
        <>
          {' '}
          <button
            type="button"
            className="table__more"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
          {open && (
            <ul className="log-details">
              {lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function Logs() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Only the tracked deletions -- uploads and files, users, branches -- each
  // with a full record of what was removed in its details.
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Page 7 of one filter is rarely a page of the next.
  useEffect(() => {
    setPage(1);
  }, [category, userId, from, to, deleted]);

  const filters = { q, category, userId, from, to, deleted };

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api
      .listLogs({ page, pageSize, q, category, userId, from, to, deleted })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, pageSize, q, category, userId, from, to, deleted]);

  useEffect(load, [load]);

  /** A category card toggles its filter; pressing the chosen one again clears it. */
  function toggleCategory(key) {
    setCategory((current) => (current === key ? '' : key));
  }

  /** Today shows everything again: no category, not only deletions. */
  function showEverything() {
    setCategory('');
    setDeleted(false);
  }

  function clearFilters() {
    setSearch('');
    setQ('');
    setCategory('');
    setDeleted(false);
    setUserId('');
    setFrom('');
    setTo('');
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const result = await exportLogs(filters, describeDetails);
      if (result.truncated) {
        setNotice(
          `The file holds the newest ${result.count.toLocaleString('en-IN')} of ${result.total.toLocaleString(
            'en-IN',
          )} matching entries. Narrow the dates to export the rest.`,
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  const categories = data?.categories ?? [];
  const categoryLabel = Object.fromEntries(categories.map((c) => [c.key, c.label]));
  const anyFilter = Boolean(q || category || userId || from || to || deleted);

  return (
    <>
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Activity logs</h2>
          <p className="page__lead">
            {data
              ? `${data.counts.all.toLocaleString('en-IN')} entr${data.counts.all === 1 ? 'y' : 'ies'}`
              : 'Every change made in the app'}{' '}
            — who did what and when. Entries are kept for {data?.retentionDays ?? 90} days.
          </p>
        </div>
        <div className="page__actions">
          <button className="ghost" type="button" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="ghost" type="button" onClick={handleExport} disabled={exporting || !data?.total}>
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {data && (
        <div className="cards">
          {/* Today and the last seven days count with every filter but the
              category applied -- they describe what the rest of the page is
              narrowed to. Pressing either clears the category. */}
          <button
            type="button"
            className={`card stat stat--all ${category || deleted ? '' : 'is-active'}`}
            onClick={showEverything}
            aria-pressed={!category && !deleted}
            title="Show every entry"
          >
            <div className="stat__label">Today</div>
            <div className="stat__value">{data.counts.today.toLocaleString('en-IN')}</div>
            <div className="stat__hint">
              {`${data.counts.week.toLocaleString('en-IN')} in the last 7 days`}
            </div>
          </button>
          {/* Deleted uploads and files, vendor recos, users and branches.
              Combines with a category card -- Uploads + Deleted is just the
              deleted uploads. */}
          <button
            type="button"
            className={`card stat stat--rejected ${deleted ? 'is-active' : ''}`}
            onClick={singlePress(() => setDeleted((v) => !v))}
            aria-pressed={deleted}
            title={
              deleted
                ? 'Showing deletions only — press again for every entry'
                : 'Show only deleted uploads, files, HIS vs FOCUS recos, users and branches'
            }
          >
            <div className="stat__label">Deleted</div>
            <div className="stat__value">{(data.counts.deleted ?? 0).toLocaleString('en-IN')}</div>
            <div className="stat__hint">uploads, files, vendor recos, users, branches</div>
          </button>
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`card stat stat--${CATEGORY_TONES[c.key]?.stat ?? 'dept'} ${
                category === c.key ? 'is-active' : ''
              }`}
              onClick={singlePress(() => toggleCategory(c.key))}
              aria-pressed={category === c.key}
              title={
                category === c.key ? `Showing ${c.label} only — press again for everything` : `Show only ${c.label}`
              }
            >
              <div className="stat__label">{c.label}</div>
              <div className="stat__value">{(data.counts.categories[c.key] ?? 0).toLocaleString('en-IN')}</div>
              <div className="stat__hint">entries</div>
            </button>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
          <select
            className="field__input stage-filter"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select
            className="field__input stage-filter"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            aria-label="Filter by user"
          >
            <option value="">All users</option>
            {(data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.userName ? `${u.userName} (${u.username})` : u.username}
              </option>
            ))}
          </select>
          <label className="log-date">
            <span>From</span>
            <input
              className="field__input stage-filter"
              type="date"
              lang="en-GB"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="log-date">
            <span>To</span>
            <input
              className="field__input stage-filter"
              type="date"
              lang="en-GB"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search GRN, cheque, user or text"
            aria-label="Search the activity log"
          />
          {/* <label className="log-date">
            <input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} />
            <span>Deleted only</span>
          </label> */}
          {anyFilter && (
            <button type="button" className="ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--info">{notice}</div>}

      {loading && !data ? (
        <div className="loading">Loading…</div>
      ) : (
        data && (
          <>
            <div className="table-wrap table-wrap--sticky">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Category</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr>
                      <td className="table__empty" colSpan={6}>
                        {anyFilter ? 'No activity matches these filters' : 'No activity recorded yet'}
                      </td>
                    </tr>
                  )}
                  {data.rows.map((entry) => (
                    <tr key={entry.id}>
                      <td className="table__mono">{formatStamp(entry.createdAt)}</td>
                      <td>
                        {entry.userName || entry.username || <span className="table__miss">&mdash;</span>}
                        {entry.userName && entry.username && (
                          <div className="table__sub">{entry.username}</div>
                        )}
                      </td>
                      <td>
                        <span className={`pill pill--${CATEGORY_TONES[entry.category]?.pill ?? 'user'}`}>
                          {categoryLabel[entry.category] || entry.category}
                        </span>
                      </td>
                      <td>{entry.actionLabel}</td>
                      <td className="table__mono">
                        {entry.target || <span className="table__miss">&mdash;</span>}
                      </td>
                      <td>
                        <LogDetails entry={entry} />
                      </td>
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
                    )} of ${data.total.toLocaleString('en-IN')}`}
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
        )
      )}
    </>
  );
}
