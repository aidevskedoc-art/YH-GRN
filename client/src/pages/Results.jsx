import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { exportResults } from '../services/exporter.js';
import ResultsTable, { formatAmount } from '../components/ResultsTable.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { IconX } from '../components/icons.jsx';

/** How long the search box waits for the typing to stop before it asks. */
const SEARCH_DELAY_MS = 300;

/**
 * Pending first: it is the answer the report is run to get.
 *
 * Valid GRNS is both matched statuses at once. A GRN found in the ageing report
 * has reached accounts even when the bill number differs, so those rows are
 * counted as valid rather than held in a separate "needs review" bucket; the
 * difference is still stored per row (`discrepancyNotes`), for anyone who
 * reads it off the API directly, though neither the screen nor the export
 * shows it any more.
 *
 * Turnaround is `card: false` because it is not a reconciliation bucket. The
 * other two partition every GRN and each has a count and a value; Turnaround
 * measures elapsed time over a different population, so it belongs in the tab
 * strip but not in the row of stat cards.
 */
const TURNAROUND = 'TURNAROUND';
const VALID = 'VALID';
/**
 * Every GRN in scope, pending and valid together -- the upload as it arrived,
 * before the reconciliation splits it in two. The server knows the name and
 * treats it as no filter at all.
 */
const ALL_GRNS = 'ALL';
const TABS = [
  // First, because it is the whole population the two tabs after it divide up:
  // the tab strip then reads as everything, then the half still outstanding,
  // then the half that got through.
  //
  // `countKey` because the summary has no ALL bucket of its own -- the figure
  // it wants is the one it already adds up under `total`.
  { status: ALL_GRNS, label: 'Total GRNS', hint: 'Pending and valid together', card: false, countKey: 'total' },
  // Still a tab, no longer a card. The row of cards now follows one GRN's
  // journey onward -- valid, then through CSD -- and a Pending count is the
  // population that journey has not started for. The tab keeps its own count.
  { status: 'PENDING', label: 'Pending GRNS', hint: 'Not yet in accounts', card: false },
  { status: VALID, label: 'Accounts ', hint: 'Found in the ageing report' },
  { status: TURNAROUND, label: 'GRN age from PR to Bank', hint: 'Days at each step', card: false },
];

const CARD_TABS = TABS.filter((t) => t.card !== false);

/**
 * The CSD stages, as cards beside Valid GRNs.
 *
 * They count THIS upload's GRNs at each stage -- same batch and same search as
 * every other card in the row -- rather than the whole CSD queue, so the row
 * describes one population throughout. The CSD screen's own cards count the
 * queue across every upload, which is the right scope there.
 *
 * Pressing one opens the CSD screen with that stage already chosen. The cards
 * report; the dropdown beside the search box is what filters this table. They
 * are deliberately not wired to each other, so neither lights up because of the
 * other.
 */
/**
 * The Total GRNS tab's own filter: which half of the tab to show.
 *
 * It stands where the CSD stage dropdown stands on every other tab, because on
 * Total GRNS a stage is the wrong question -- only a GRN that reached accounts
 * can have one, so choosing a stage there would quietly discard half the tab.
 * The question that tab does raise, looking at a mixed list, is "just the ones
 * still outstanding" or "just the ones through", and these are those.
 *
 * The values are statuses the server already knows, so this narrows the rows
 * without changing the tab: the table keeps its own wide layout, Match column
 * and all, and the filter travels beside `status` rather than replacing it.
 */
const MATCH_FILTERS = [
  { value: 'PENDING', label: 'Pending' },
  { value: VALID, label: 'Moved to accounts' },
];

/**
 * The filter dropdown beside the search box: the Status column's own values.
 *
 * Every one of these is something that column says, spelled the way the pill
 * in it spells it -- so picking one asks for the rows showing it rather than
 * for an adjacent idea a reader has to translate. The server owns the meaning
 * of each key (see PROGRESS in routes/results.js); this is the wording and the
 * order they are offered in.
 *
 * The order follows a GRN's life rather than the alphabet: not sent, then out
 * to one of the two destinations, then through CSD's three answers, then paid.
 *
 * They deliberately overlap, because the column does. A GRN whose cheque
 * cleared while it sat at CSD shows both, and is found under both.
 */
const PROGRESS_LABELS = {
  // NOT_SENT: 'Not sent',
  QUEUED: 'Sent to CSD',
  RECEIVED: 'CSD received',
  APPROVED: 'CSD approved',
  REJECTED: 'CSD rejected',
  // Accounts' own hand-back ladder, once CSD reaches MOVED_TO_ACCOUNTS -- see
  // ACCOUNTS_RETURN_STATES in ResultsTable.jsx for the same two labels.
  RETURNED_BY_CSD: 'Returned by CSD',
  ACCOUNTS_RECEIVED: 'Accounts received',
  // Where Accounts forwards a received GRN on to -- see forwardedLabel in
  // ResultsTable.jsx for the same four labels.
  BANK: 'Sent to Bank',
  VENDOR: 'Sent to Vendor',
  PURCHASE_DEPT: 'Sent to Purchase Dept',
  OTHERS: 'Sent to Others',
  RECORDS: 'Sent to Records',
  CLEARED: 'Cheque cleared',
};

/** This list's own order -- a GRN's life rather than the alphabet -- for the
 * keys it knows the wording for. Anything summary.progress carries that is
 * not named here still gets offered (see `progressFilters` below); it just
 * falls in after these, in whatever order the server sent it. */
const PROGRESS_ORDER = Object.keys(PROGRESS_LABELS);

/**
 * A status key this list has no wording for yet -- a new value the server
 * started sending -- spelled out on the fly ("IN_TRANSIT" -> "In transit")
 * rather than left off the dropdown until someone edits this file to name it.
 */
function fallbackProgressLabel(key) {
  const words = key.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CSD_CARDS = [
  { stage: 'QUEUED', label: 'CSD Pending', hint: 'Sent, awaiting CSD', tone: 'queued' },
  { stage: 'RECEIVED', label: 'CSD Received', hint: 'CSD have it', tone: 'received' },
  { stage: 'APPROVED', label: 'CSD Approved', hint: 'Cleared by CSD', tone: 'approved' },
  { stage: 'REJECTED', label: 'CSD Rejected', hint: 'Sent back', tone: 'rejected' },
];

/**
 * The bucket the turnaround report measures. Every GRN with an ageing row has
 * the stage dates, and that is exactly the Valid GRNs bucket -- so on the
 * Turnaround tab that card is marked active, answering "what is this counting?"
 * rather than going dead because no bucket is selected.
 */
const TURNAROUND_SCOPE = VALID;

/**
 * "All uploads": every batch reconciled together. It travels in the same place
 * as a batch id -- the `:batchId` route segment and the selector's value -- and
 * the server drops its batch filter when it sees it.
 */
const ALL = 'all';

/** The `:batchId` segment as a batch id, the all sentinel, or null. */
function parseBatchId(param) {
  if (!param) return null;
  if (String(param).toLowerCase() === ALL) return ALL;
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The upload header's one-line description of what this batch actually holds.
 *
 * Either report may have been uploaded on its own, so this covers all three
 * shapes a batch can take rather than assuming both counts are non-zero.
 */
function batchDescription(batch) {
  const grn = batch.grnRowCount;
  const ageing = batch.ageingRowCount;
  const n = (x) => x.toLocaleString('en-IN');

  if (grn > 0 && ageing > 0) return `${n(grn)} GRN transactions checked against ${n(ageing)} ageing rows.`;
  if (grn > 0) return `${n(grn)} GRN transactions — no ageing report uploaded, so every GRN shows as pending.`;
  if (ageing > 0) return `${n(ageing)} ageing rows — no GRN report uploaded, so there is nothing yet to reconcile them against.`;
  return 'No rows in this upload.';
}

export default function Results() {
  const { isAdmin, can } = useAuth();
  const { batchId: batchIdParam } = useParams();
  const navigate = useNavigate();

  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState(parseBatchId(batchIdParam));
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('PENDING');
  // Which Status value the table is narrowed to, or '' for every row.
  // Deliberately not part of `status`: it cuts across the reconciliation
  // buckets rather than being one of them.
  const [progress, setProgress] = useState('');
  // Which half of Total GRNS is showing, or '' for both. Meaningless on the
  // other tabs, and cleared on the way out of this one.
  const [matchFilter, setMatchFilter] = useState('');
  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. Unlike the two filters above it is not about a tab: it
  // narrows the whole page -- rows, cards, option counts and the export -- and
  // it survives moving between tabs, because "the Secunderabad numbers" is a
  // question every tab answers.
  const [location, setLocation] = useState('');
  // Which stretches of the process the GRNS SPAN tab measures -- `{ from, to }`
  // pairs of checkpoints, empty for every stage. It lives here rather than in
  // the tab because the Export button lives here too, and a file that carried
  // eleven stage columns after the screen had been narrowed to two would be a
  // different report from the one it was taken off.
  const [spans, setSpans] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  // Sending several GRNs paid by the same cheque to CSD in one action, instead
  // of one dropdown per row. `multiMode` is the checkbox column showing at
  // all; `selected` is which GRN numbers are ticked within it. Both live here
  // rather than in ResultsTable because the toggle and the bulk send button
  // sit in this page's toolbar, beside the search box.
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);

  // `search` is what is in the box; `q` is what has been asked for. Typing
  // "SRI VENKATESWARA" would otherwise be sixteen round trips.
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Load the batch list, and fall back to the newest batch when none is in the URL.
  useEffect(() => {
    api
      .listBatches()
      .then(({ batches: list }) => {
        setBatches(list);
        if (!batchIdParam && list.length > 0) {
          setBatchId(list[0].id);
          navigate(`/results/${list[0].id}`, { replace: true });
        }
        if (list.length === 0) setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    // Runs once on mount; later batch changes go through selectBatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (batchIdParam) setBatchId(parseBatchId(batchIdParam));
  }, [batchIdParam]);

  useEffect(() => {
    if (!batchId) return;
    api
      .summary(batchId, { q, location })
      .then(({ summary: s }) => setSummary(s))
      .catch((err) => setError(err.message));
  }, [batchId, q, location]);

  // Which rows to ask for, as against which tab is showing. The two are the
  // same everywhere except Total GRNS with its filter set, where the tab decides
  // the layout and the filter decides the population.
  const rowStatus = status === ALL_GRNS && matchFilter ? matchFilter : status;

  const loadRows = useCallback(() => {
    if (!batchId) return;
    // Turnaround is not a reconciliation status -- /results would reject it as
    // an unknown filter. That tab fetches its own data in TurnaroundView.
    if (status === TURNAROUND) return;
    setLoading(true);
    api
      .results(batchId, { status: rowStatus, page, pageSize, q, progress, location })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, status, rowStatus, page, pageSize, q, progress, location]);

  useEffect(loadRows, [loadRows]);

  // A ticked GRN belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs invalidates the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [batchId, rowStatus, page, pageSize, q, progress, location]);

  /**
   * Whether a row may join the bulk send: the same rows the table's own
   * per-row dropdown offers "Send to CSD" on -- reached accounts, not already
   * sent or filed to Records, not past CSD already -- and only when this
   * account has access to CSD at all.
   */
  const canBulkSelect = (row) =>
    can('csd') &&
    row.status !== 'PENDING' &&
    row.csdStage !== 'MOVED_TO_ACCOUNTS' &&
    !row.csdSent &&
    !row.recordsSent;

  /**
   * Ticking one row also ticks every other row on the page still eligible
   * that shares its cheque number -- a cheque pays a group of GRNs together,
   * so selecting one of them is read as meaning the whole group. Unticking
   * only lets go of the one row: narrowing the group back down is a
   * deliberate choice, not one this page should second-guess by dragging the
   * rest off with it.
   */
  function toggleSelectRow(row) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.dprNo)) {
        next.delete(row.dprNo);
        return next;
      }
      next.add(row.dprNo);
      if (row.chequeNo) {
        for (const r of data?.rows || []) {
          if (r.chequeNo === row.chequeNo && canBulkSelect(r)) next.add(r.dprNo);
        }
      }
      return next;
    });
  }

  function exitMultiMode() {
    setMultiMode(false);
    setSelected(new Set());
  }

  /**
   * Send every ticked row to CSD in one go. Each still goes over as its own
   * POST -- the server has no bulk endpoint of its own -- but firing them
   * together and reloading once is what makes it read as one action rather
   * than one dropdown per row.
   */
  async function sendSelectedToCsd() {
    const targets = (data?.rows || []).filter((row) => selected.has(row.dprNo));
    if (targets.length === 0) return;
    setBulkSending(true);
    setError('');
    try {
      await Promise.all(
        targets.map((row) =>
          api.sendToCsd({ ...row, batchId: typeof batchId === 'number' ? batchId : null }),
        ),
      );
      exitMultiMode();
      loadRows();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  function selectBatch(id) {
    setBatchId(id);
    setPage(1);
    setSummary(null);
    navigate(`/results/${id}`);
  }

  function selectStatus(next) {
    setStatus(next);
    setPage(1);
    // These values only ever appear on a GRN that reached accounts, so carrying
    // the filter onto Pending would show an empty tab with no visible reason why.
    if (next !== VALID) setProgress('');
    // The match filter belongs to Total GRNS and its dropdown is only rendered
    // there, so leaving it set would go on narrowing the next tab invisibly.
    if (next !== ALL_GRNS) setMatchFilter('');
  }

  /** Narrow every figure on the page to one branch, or '' for all of them. */
  function selectLocation(next) {
    setLocation(next);
    // Page 7 of one branch is rarely a page of another.
    setPage(1);
  }

  /** Show one half of Total GRNS, or both. */
  function selectMatchFilter(next) {
    setMatchFilter(next);
    setPage(1);
  }

  /**
   * Narrow the table to one value of the Status column.
   *
   * Choosing one moves to Valid GRNS if it is not already showing: only a GRN
   * that reached accounts can have been sent anywhere or paid by cheque, so the
   * rows being asked for are all valid ones, and leaving the Pending tab up
   * would answer the question with an empty table.
   */
  function selectProgress(next) {
    setProgress(next);
    setPage(1);
    if (next && status !== VALID) {
      setStatus(VALID);
      setMatchFilter('');
    }
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      // One workbook, every tab -- see the note on exportResults for why the
      // progress dropdown and the Total GRNS match filter do not narrow it.
      await exportResults(batchId, TABS, { q, location, spans });
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete this upload?',
      message: 'Are you sure? This cannot be undone.',
      confirmLabel: 'Delete upload',
    });
    if (!ok) return;
    try {
      await api.deleteBatch(batchId);
      const remaining = batches.filter((b) => b.id !== batchId);
      setBatches(remaining);
      if (remaining.length > 0) selectBatch(remaining[0].id);
      else navigate('/upload');
    } catch (err) {
      setError(err.message);
    }
  }

  if (batches.length === 0 && !loading) {
    return (
      <div className="empty empty--page">
        <h2>Nothing uploaded yet</h2>
        <p>Upload the GRN report and the Vendor Ageing report to see which GRNs are still pending.</p>
        <button className="primary" type="button" onClick={() => navigate('/upload')}>
          Go to upload
        </button>
      </div>
    );
  }

  const isAll = batchId === ALL;
  const activeBatch = batches.find((b) => b.id === batchId);

  // The progress dropdown's own options: every key the server's summary
  // carries (see PROGRESS in routes/results.js), not a fixed list copied out
  // of it -- so a key added there shows up here the next time the summary
  // loads, with no matching edit needed in this file. Ordered by
  // PROGRESS_ORDER where this list knows the wording, and by arrival after
  // that for anything it doesn't.
  const progressFilters = Object.keys(summary?.progress ?? {})
    .filter((key) => key !== 'NOT_SENT')
    .sort((a, b) => {
      const ia = PROGRESS_ORDER.indexOf(a);
      const ib = PROGRESS_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map((key) => ({ value: key, label: PROGRESS_LABELS[key] || fallbackProgressLabel(key) }));

  return (
    <>
      {confirmDialog}
      {/* The shell's top bar already names the page, so this row carries the
          batch context and its controls only. */}
      <div className="page__head page__head--row">
        <div>
          {isAll ? (
            <>
              <h2 className="page__title">All uploads</h2>
              {/* The row counts are not the sum of the uploads': a GRN number
                  repeating across uploads is counted once, so the total comes
                  from the deduplicated summary rather than from the batch list. */}
              <p className="page__lead">
                {batches.length} upload{batches.length === 1 ? '' : 's'} combined —{' '}
                {summary ? `${summary.total.count.toLocaleString('en-IN')} GRNs` : 'every GRN'},
                counting a GRN number that repeats across uploads only once.
              </p>
            </>
          ) : (
            activeBatch && (
              <>
                {/* The selector shows names only, so the upload date lives here. */}
                <h2 className="page__title">{activeBatch.name}</h2>
                <p className="page__lead">
                  Uploaded {new Date(activeBatch.uploadedAt).toLocaleDateString('en-GB')} —{' '}
                  {batchDescription(activeBatch)}
                </p>
              </>
            )
          )}
        </div>

        {/* The page's scope, in the order it is decided: which upload, then
            which branch of it. Both are labelled and sized alike, because they
            are two halves of one answer -- everything below reads as "this
            upload, this location" -- rather than a control and an afterthought
            bolted beside it. The filters in the toolbar under the cards are a
            different kind of question: they ask about the rows this pair
            selects, so they stay down there with the table. */}
        <div className="page__actions">
           <LocationFilter value={location} onChange={selectLocation} />
          <label className="picker">
            <span className="picker__label">Uploaded files</span>
            <select
              className="field__input picker__input"
              value={batchId ?? ''}
              onChange={(e) => selectBatch(parseBatchId(e.target.value))}
            >
              <option value={ALL}>All uploads</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          {/* One workbook, every tab -- see the note on exportResults for why
              the progress dropdown and the Total GRNS match filter do not
              narrow it. Sits beside Delete upload since both act on the
              upload as a whole, rather than down with the table's own
              filters, which act on the rows they narrow. */}
          <button className="ghost" type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>

          {/* Administrators only, and never when every upload is in scope --
              there is no single one to delete then. Being given the upload
              screen is permission to add a month's reports, not to remove one:
              a delete takes its GRN rows, its ageing rows and every reconciled
              result with it. The server refuses it too; this only keeps a
              button that would 403 off the screen. */}
          {isAdmin && !isAll && (
            <button className="ghost danger" type="button" onClick={handleDelete}>
              Delete upload
            </button>
          )}
        </div>
      </div>

      {summary && (
        <div className="cards">
          {CARD_TABS.map((tab) => {
            const bucket = summary[tab.status] || { count: 0, amount: 0 };
            const active = status === TURNAROUND ? tab.status === TURNAROUND_SCOPE : status === tab.status;
            return (
              <button
                key={tab.status}
                type="button"
                className={`card stat stat--${tab.status.toLowerCase()} ${active ? 'is-active' : ''}`}
                onClick={() => selectStatus(tab.status)}
              >
                <div className="stat__label">{tab.label}</div>
                <div className="stat__value">{bucket.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(bucket.amount)}</div>
                <div className="stat__hint">{tab.hint}</div>
              </button>
            );
          })}

          {CSD_CARDS.map((card) => {
            const bucket = summary.csd?.[card.stage] || { count: 0, amount: 0 };
            return (
              <button
                key={card.stage}
                type="button"
                className={`card stat stat--${card.tone}`}
                onClick={() => navigate(`/csd?stage=${card.stage}`)}
                title={`Open the CSD queue, showing what is ${card.label
                  .replace('CSD ', '')
                  .toLowerCase()}`}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{bucket.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(bucket.amount)}</div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              className={`tab ${status === tab.status ? 'is-active' : ''}`}
              onClick={() => selectStatus(tab.status)}
            >
              {tab.label}
              {/* Keyed off the summary having a bucket for this tab, not off
                  `card` -- that flag decides what appears in the row of cards
                  above, and a tab kept off the cards still has a count worth
                  showing. Turnaround has no bucket, so it gets no chip. */}
              {summary?.[tab.countKey ?? tab.status] && (
                <span className="tab__count">
                  {summary[tab.countKey ?? tab.status].count.toLocaleString('en-IN')}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="toolbar__actions">
          {/* One dropdown, two questions -- whichever the tab underneath can
              answer. Total GRNS is the mixed list, so there it asks which half;
              Accounts is already one bucket and the open question there is how
              far through CSD its rows have got. Pending GRNS has no ageing
              entry and so no Status column for either question to be about, so
              it gets no dropdown at all. */}
          {status === ALL_GRNS ? (
            <select
              className="field__input stage-filter"
              value={matchFilter}
              onChange={(e) => selectMatchFilter(e.target.value)}
              aria-label="Filter the table by reconciliation status"
            >
              <option value="">All</option>
              {MATCH_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                  {summary?.[f.value] ? ` (${summary[f.value].count})` : ''}
                </option>
              ))}
            </select>
          ) : status === 'PENDING' ? null : (
            /* Choosing a value takes the table to Valid GRNS itself rather
               than being hidden until you get there. The counts come from the
               same clauses the filter uses, so the number beside an option is
               the number of rows picking it yields. */
            <select
              className="field__input stage-filter"
              value={progress}
              onChange={(e) => selectProgress(e.target.value)}
              aria-label="Filter the table by what the Status column says"
            >
              <option value="">All </option>
              {progressFilters.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                  {summary?.progress?.[f.value] ? ` (${summary.progress[f.value].count})` : ''}
                </option>
              ))}
            </select>
          )}
          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, GRN, bill or cheque no."
            aria-label="Search by vendor name, GRN number, bill number or cheque number"
          />

          {/* Sending several GRNs paid by the same cheque to CSD at once,
              rather than one dropdown per row -- only where a row could be
              sent to CSD in the first place. The toggle doubles as its own
              cancel: once a selection is open, pressing it again is the same
              button reading a cross rather than a second control beside it. */}
          {status !== 'PENDING' && status !== TURNAROUND && can('csd') && (
            <>
             
              {multiMode && (
                <button
                  type="button"
                  className="primary"
                  onClick={sendSelectedToCsd}
                  disabled={selected.size === 0 || bulkSending}
                >
                  {bulkSending
                    ? 'Sending…'
                    : selected.size > 0
                      ? `Send ${selected.size} to CSD`
                      : 'Send to CSD'}
                </button>
              )}
               <button
                type="button"
                className={multiMode ? 'ghost icon-btn' : 'ghost'}
                onClick={() => (multiMode ? exitMultiMode() : setMultiMode(true))}
                title={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to send to CSD together'}
                aria-label={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to send to CSD together'}
              >
                {multiMode ? <IconX size={14} /> : 'Select multiple'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {status === TURNAROUND ? (
        <TurnaroundView
          batchId={batchId}
          q={q}
          location={location}
          spans={spans}
          onSpansChange={setSpans}
        />
      ) : loading && !data ? (
        <div className="loading">Loading…</div>
      ) : (
        data && (
          <>
            <ResultsTable
              rows={data.rows}
              status={status}
              batchId={batchId}
              onSent={loadRows}
              multiMode={multiMode}
              selected={selected}
              onToggleRow={toggleSelectRow}
            />
            <div className="pager">
              <span className="pager__info">
                {data.total === 0
                  ? q
                    ? `Nothing matches "${q}"`
                    : 'No rows'
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
