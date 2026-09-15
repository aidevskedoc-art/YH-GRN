import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { exportSection } from '../services/exporter.js';
import {
  ACCOUNTS_ROW,
  ACCOUNTS_TAB,
  CHEQUE_CARDS,
  CSD_CARDS,
  TURNAROUND,
  TURNAROUND_TAB,
  VALID,
  bulkCategory as bulkCategoryOf,
  bulkCsdEligible,
  bulkForwardEligible,
  bulkReceiveEligible,
  progressFilterOptions,
  sectionSheets,
} from '../services/resultsViews.js';
import ResultsTable, { formatAmount, ForwardDetailsDialog } from '../components/ResultsTable.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { IconX } from '../components/icons.jsx';

/**
 * The Accounts desk's own screen: the GRNs that reached accounts, and how long
 * each step of the journey to the bank took.
 *
 * Two of the results screen's five views and nothing else. It is a screen
 * rather than a filter because what it leaves out is the point -- the pending
 * half, the whole-population count and the BPAD register are someone else's
 * question, and a desk that only works bills already in accounts should not
 * have to rule three of them out before starting. The views it does show are
 * the same views, reading the same rows from the same endpoints under the same
 * labels: the declarations both screens stand on are in
 * services/resultsViews.js, so a stage renamed there is renamed on both.
 *
 * What it deliberately does NOT narrow is the data. Every row Accounts can see
 * on the results screen is here, with the same branch scoping
 * (`branchFor` on the server) and the same actions -- handing a cheque's bills
 * to CSD, taking them back, and forwarding them on to Bank, Vendor or Courier.
 * This is a shorter way into the same work, not a read-only copy of it.
 */

/** How long the search box waits for the typing to stop before it asks. */
const SEARCH_DELAY_MS = 300;

/**
 * The two views, in the order the work goes: what is in accounts, then how
 * long it took to get there and onward.
 *
 * Both entries are the shared ones, so the view dropdown, the stat cards and
 * the export sheet names match the results screen exactly.
 */
const TABS = [ACCOUNTS_TAB, TURNAROUND_TAB];

/**
 * Which cards each view shows.
 *
 * Accounts shows where its GRNs have got to -- the four CSD stages, then the
 * cheque pair -- and no count of its own at the head of them: the figure is on
 * the View dropdown beside this view's own option, and a count standing over
 * cards that do not sum to it invites the arithmetic anyway. The CSD four do
 * not sum to anything (a cheque whose bills sit at two stages is counted at
 * both); the cheque pair does, which is why it closes the row.
 *
 * The GRNS SPAN view shows none. It divides nothing -- it measures elapsed time
 * over the Accounts bucket rather than splitting it -- so a card row there
 * could only repeat the count already on the View dropdown beside its own
 * option, standing over a table of day counts it does not describe. The stage
 * figures that view does have to give are in its own header, per span.
 */
const CARDS_FOR = {
  // Its own count, then the cheque pair that divides it, then the four CSD
  // stages -- imported, because the results screen shows this same row and the
  // two must not drift into different orders. See ACCOUNTS_ROW.
  [VALID]: ACCOUNTS_ROW,
  [TURNAROUND]: [],
};

/**
 * Every card the row can show, under the id CARDS_FOR names it by -- the
 * Accounts view's own reconciliation status for the count, a `progress` key for
 * the cheque pair, a CSD stage for the four.
 *
 * `kind` because they are different controls rather than one skinned three
 * ways: the cheque and CSD cards each narrow the rows below to themselves,
 * reading their counts from different halves of the summary, while the count at
 * the head of the row is the "all of them" that clears whichever of them is
 * set. Still nothing that navigates -- unlike the results screen, this one has
 * no other view for a card to open.
 */
const CARD_BY_ID = Object.fromEntries([
  // The count at the head of the row. `kind: 'bucket'` as on the results
  // screen, where the same tag marks a card that reports a whole view rather
  // than a slice of one -- here there is only ever this one, since the ageing
  // view shows no cards at all.
  [ACCOUNTS_TAB.status, { kind: 'bucket', ...ACCOUNTS_TAB }],
  ...CSD_CARDS.map((card) => [card.stage, { kind: 'csd', ...card }]),
  ...CHEQUE_CARDS.map((card) => [card.progress, { kind: 'progress', ...card }]),
]);

/**
 * "All uploads": every batch reconciled together, which is the only scope this
 * screen has, as on the results screen. It travels where a batch id used to --
 * the value handed to every API call below -- and the server drops its batch
 * filter when it sees it.
 */
const ALL = 'all';

export default function AccountsDepot() {
  const { can } = useAuth();
  const navigate = useNavigate();

  // Every upload, always. A GRN number that repeats across uploads is counted
  // once (the server deduplicates for this scope).
  const batchId = ALL;

  // Kept only for the header's count and for telling "nothing uploaded yet"
  // apart from "still loading".
  const [batches, setBatches] = useState([]);
  const [summary, setSummary] = useState(null);
  // Accounts, always, this screen being about the GRNs that got there. The
  // ageing view is a step away on the same dropdown.
  const [status, setStatus] = useState(VALID);
  // Which Status value the table is narrowed to, or '' for every row. Set by
  // the CSD and cheque cards as well as by the dropdown -- one filter with two
  // ways in.
  const [progress, setProgress] = useState('');
  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. It narrows the whole page together -- rows, cards, option
  // counts and the export -- because it is a scope rather than a question
  // about a row, and it survives moving between the two views.
  const [location, setLocation] = useState('');
  // Which stretches of the process the ageing view measures -- `{ from, to }`
  // pairs of checkpoints, empty for every stage. It lives here rather than in
  // the view because the Export button lives here too, and a file that carried
  // eleven stage columns after the screen had been narrowed to two would be a
  // different report from the one it was taken off.
  const [spans, setSpans] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Acting on several GRNs paid by the same cheque in one action, instead of
  // one dropdown per row. `multiMode` is the checkbox column showing at all;
  // `selected` is which GRN numbers are ticked within it. Both live here
  // rather than in ResultsTable because the toggle and the bulk action
  // controls sit in this page's toolbar, beside the search box.
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);
  // Which destination the bulk forward dialog is open for (VENDOR or COURIER),
  // or null -- Bank has nothing further to collect and acts at once, the same
  // as the per-row picker. Its own error stays apart from the table's: a
  // rejected submit has to stay on the dialog where the fields are.
  const [bulkForwardTo, setBulkForwardTo] = useState(null);
  const [bulkForwardError, setBulkForwardError] = useState('');

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

  // The batch list is not a choice here, only a count -- and the one thing
  // that tells an empty database apart from a slow one.
  useEffect(() => {
    api
      .listBatches()
      .then(({ batches: list }) => {
        setBatches(list);
        if (list.length === 0) setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    api
      .summary(batchId, { q, location })
      .then(({ summary: s }) => setSummary(s))
      .catch((err) => setError(err.message));
  }, [batchId, q, location]);

  const loadRows = useCallback(() => {
    // The ageing view is not a reconciliation status -- /results would reject
    // it as an unknown filter. It fetches its own rows, in TurnaroundView.
    if (status === TURNAROUND) return;
    setLoading(true);
    api
      .results(batchId, { status, page, pageSize, q, progress, location })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, status, page, pageSize, q, progress, location]);

  useEffect(loadRows, [loadRows]);

  // A ticked GRN belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs invalidates the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [batchId, status, page, pageSize, q, progress, location]);

  /*
   * The three things "Select multiple" can batch, mirroring the row's own
   * journey -- see the predicates in services/resultsViews.js, which the
   * results screen applies to the same rows. Only the CSD one asks anything of
   * this account, so only it takes the grant.
   */
  const canBulkCsd = (row) => bulkCsdEligible(row, can('csd'));
  const canBulkReceive = bulkReceiveEligible;
  const canBulkForward = bulkForwardEligible;
  const bulkCategory = (row) => bulkCategoryOf(row, can('csd'));

  /**
   * Ticking one row also ticks every other row on the page still eligible for
   * the SAME action that shares its cheque number -- a cheque pays a group of
   * GRNs together, so selecting one of them is read as meaning the whole
   * group. Restricted to the same category so ticking a row awaiting CSD never
   * silently drags in a same-cheque row that has already come back from it.
   * Unticking only lets go of the one row: narrowing the group back down is a
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
      const category = bulkCategory(row);
      if (row.chequeNo && category) {
        for (const r of data?.rows || []) {
          if (r.chequeNo === row.chequeNo && bulkCategory(r) === category) next.add(r.dprNo);
        }
      }
      return next;
    });
  }

  function exitMultiMode() {
    setMultiMode(false);
    setSelected(new Set());
  }

  const selectedRows = (data?.rows || []).filter((row) => selected.has(row.dprNo));
  const allSelectedCsd = selectedRows.length > 0 && selectedRows.every(canBulkCsd);
  const allSelectedReceive = selectedRows.length > 0 && selectedRows.every(canBulkReceive);
  const allSelectedForward = selectedRows.length > 0 && selectedRows.every(canBulkForward);

  /**
   * Send every ticked row to CSD in one go. Each still goes over as its own
   * POST -- the server has no bulk endpoint of its own -- but firing them
   * together and reloading once is what makes it read as one action rather
   * than one dropdown per row.
   */
  async function sendSelectedToCsd() {
    if (selectedRows.length === 0) return;
    setBulkSending(true);
    setError('');
    try {
      await Promise.all(selectedRows.map((row) => api.sendToCsd({ ...row, batchId: null })));
      exitMultiMode();
      loadRows();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  /** Acknowledge every ticked row CSD has handed back, in one go. */
  async function receiveSelected() {
    if (selectedRows.length === 0) return;
    setBulkSending(true);
    setError('');
    try {
      await Promise.all(selectedRows.map((row) => api.receiveAccountsReturn(row.csdDispatchId)));
      exitMultiMode();
      loadRows();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  /** Bank: nothing further to say, so this acts on every ticked row at once. */
  async function forwardSelectedSimple(to) {
    if (selectedRows.length === 0) return;
    setBulkSending(true);
    setError('');
    try {
      await Promise.all(selectedRows.map((row) => api.forwardAccountsReturn(row.csdDispatchId, { to })));
      exitMultiMode();
      loadRows();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  /**
   * Vendor or Courier for every ticked row: the bulk dialog's own submit, once
   * its fields are in. One form, filled in once, and the same answer is copied
   * onto every selected row's own dispatch -- see the note on
   * ForwardDetailsDialog for why `route: 'OTHERS'` is translated back into
   * `to: 'OTHERS'` here, as the single-row version in ResultsTable does.
   */
  async function submitBulkForward({ route, name, mobile, date, courierName, docketNo, remarks }) {
    const to = bulkForwardTo === 'VENDOR' && route === 'OTHERS' ? 'OTHERS' : bulkForwardTo;
    setBulkSending(true);
    setBulkForwardError('');
    try {
      await Promise.all(
        selectedRows.map((row) =>
          api.forwardAccountsReturn(row.csdDispatchId, {
            to,
            ...(to === 'VENDOR' ? { route } : {}),
            ...(to === 'OTHERS' ? { remarks } : {}),
            ...(to === 'COURIER' ? { courierName, docketNo, date } : {}),
            ...(to === 'VENDOR' || to === 'OTHERS' ? { name, mobile, date } : {}),
          }),
        ),
      );
      setBulkForwardTo(null);
      exitMultiMode();
      loadRows();
    } catch (err) {
      setBulkForwardError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  /** Show one of the two views. */
  function selectStatus(next) {
    setStatus(next);
    setPage(1);
    // The Status filter belongs to the Accounts rows. The ageing view has no
    // such column and does not apply it, so carrying it across would leave the
    // dropdown naming a stage over a table showing every row regardless.
    if (next !== VALID) setProgress('');
  }

  /** Narrow every figure on the page to one branch, or '' for all of them. */
  function selectLocation(next) {
    setLocation(next);
    // Page 7 of one branch is rarely a page of another.
    setPage(1);
  }

  /**
   * Narrow the table to one value of the Status column.
   *
   * Choosing one moves to Accounts if the ageing view is showing: the rows
   * being asked for are Accounts rows, and the ageing view has no Status
   * column for the filter to be about, so leaving it up would answer the
   * question with a table that ignored it.
   */
  function selectProgress(next) {
    setProgress(next);
    setPage(1);
    if (next && status !== VALID) setStatus(VALID);
  }

  if (batches.length === 0 && !loading) {
    return (
      <div className="empty empty--page">
        <h2>Nothing uploaded yet</h2>
        <p>
          Once the GRN report and the Vendor Ageing report have been uploaded, the GRNs that reached
          accounts show up here.
        </p>
        {/* Only for an account that can actually upload: this screen is given
            to desks that read the reconciliation rather than run it. */}
        {can('upload') && (
          <button className="primary" type="button" onClick={() => navigate('/upload')}>
            Go to upload
          </button>
        )}
      </div>
    );
  }

  const progressFilters = progressFilterOptions(summary);

  // The cards this view shows, in the order CARDS_FOR names them.
  const cards = (CARDS_FOR[status] ?? []).map((id) => CARD_BY_ID[id]).filter(Boolean);

  /** The view showing, as its own TABS entry -- the export's first sheet. */
  const section = TABS.find((tab) => tab.status === status) ?? TABS[0];

  /**
   * What Export Excel will hand back: this view's own sheet, then a sheet per
   * card below it -- the four CSD stages and the cheque pair on Accounts, and
   * on the ageing view its one sheet alone, that row having no cards of its
   * own here. Read off the rendered cards, so the file and the row agree; the
   * button's tooltip reads the length, to stop promising a sheet per card
   * where there is only the one.
   */
  const exportSheets = sectionSheets(section, cards);

  /**
   * The view showing as one workbook: its own sheet, then a sheet per card on
   * the row below -- the four CSD stages and the cheque pair on Accounts,
   * nothing beside it on the ageing view. Same shape as the results screen's
   * export, off the same shared card declarations (see sectionSheets in
   * services/resultsViews.js), so the Accounts sheets read identically on
   * either screen.
   *
   * Still this screen's views and not the results screen's five: a file taken
   * off here should be what is on here, so nobody has to work out which
   * sheets were theirs.
   */
  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      await exportSection(batchId, exportSheets, { q, location, spans });
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      {/* The shell's top bar already names the page, so this row carries the
          scope and its controls only. */}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">All uploads</h2>
          {/* The Accounts count rather than the whole population: this screen
              is about the GRNs that reached accounts, and the figure it opens
              on should be the one it is reporting. A GRN number repeating
              across uploads is counted once, so it comes from the
              deduplicated summary rather than from the batch list. */}
          <p className="page__lead">
            {batches.length} upload{batches.length === 1 ? '' : 's'} combined —{' '}
            {summary
              ? `${(summary[VALID]?.count ?? 0).toLocaleString('en-IN')} GRNs in accounts`
              : 'every GRN in accounts'}
            , counting a GRN number that repeats across uploads only once.
          </p>
        </div>

        <div className="page__actions">
          {/* Which of the two views the table below shows. Each option carries
              its own count, so the Accounts figure is readable without a card
              standing over a row that does not sum to it. */}
          <label className="picker">
            <span className="picker__label">View</span>
            <select
              className="field__input picker__input"
              value={status}
              onChange={(e) => selectStatus(e.target.value)}
              aria-label="Choose what the table below shows"
            >
              {TABS.map((tab) => {
                const bucket = summary?.[tab.countKey ?? tab.status];
                return (
                  <option key={tab.status} value={tab.status}>
                    {tab.label}
                    {bucket ? ` (${bucket.count.toLocaleString('en-IN')})` : ''}
                  </option>
                );
              })}
            </select>
          </label>

          <LocationFilter value={location} onChange={selectLocation} />

          {/* The view showing, as one workbook -- see handleExport. Beside
              the View dropdown because that is what it follows. The toolbar's
              filters still do not narrow it: each sheet carries its own
              card's narrowing instead. */}
          <button
            className="ghost"
            type="button"
            onClick={handleExport}
            disabled={exporting}
            title={
              exportSheets.length > 1
                ? `Download ${section.label} as Excel — a sheet per card below`
                : `Download ${section.label} as Excel`
            }
          >
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {summary && cards.length > 0 && (
        <div className="cards">
          {cards.map((card) =>
            card.kind === 'bucket' ? (
              /* How many GRNs are in accounts at all -- the count at the head
                 of the row, and the "All" of it.

                 Every other card on this row sets `progress`, so pressing this
                 one clears it and the table goes back to every Accounts row.
                 The ring follows that rather than saying which view is showing
                 -- there is only one view with cards here, so a ring that never
                 went out would say nothing. A card that looks like the head of
                 a row but ignores a press while the ones beside it toggle is
                 the kind of dead control people press twice and stop trusting;
                 same reasoning as the results screen's rowHead. */
              <button
                key={card.status}
                type="button"
                className={`card stat stat--${card.status.toLowerCase()} ${
                  progress ? '' : 'is-active'
                }`}
                onClick={() => selectProgress('')}
                aria-pressed={!progress}
                title={
                  progress
                    ? 'Show every GRN in accounts again'
                    : 'Showing every GRN in accounts — press a card beside this to narrow it'
                }
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {(summary[card.countKey ?? card.status]?.count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary[card.countKey ?? card.status]?.amount ?? 0)}
                </div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ) : card.kind === 'progress' ? (
              /* Cheque prepared / not prepared. The same control as the CSD
                 cards beside it and the same filter behind it -- these two just
                 name a `progress` key directly instead of a CSD stage, because
                 what they ask about is read off the ageing report's cheque
                 columns rather than off a handover. See CHEQUE_PREPARED in
                 routes/results.js for what counts as prepared. */
              <button
                key={card.progress}
                type="button"
                className={`card stat stat--dept ${progress === card.progress ? 'is-active' : ''}`}
                onClick={() => selectProgress(progress === card.progress ? '' : card.progress)}
                aria-pressed={progress === card.progress}
                title={
                  progress === card.progress
                    ? `Showing ${card.label} only — press again for every row`
                    : `Show only the ${card.label} rows`
                }
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {(typeof card.value === 'function'
                    ? card.value(summary)
                    : (summary.progress?.[card.progress]?.count ?? 0)
                  ).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary.progress?.[card.progress]?.amount ?? 0)}
                </div>
                <div className="stat__hint">
                  {typeof card.hint === 'function' ? card.hint(summary) : card.hint}
                </div>
              </button>
            ) : (
              /* One CSD stage's share of the rows below. Pressing it narrows
                 the table to that stage; pressing the one already showing goes
                 back to every row.

                 It sets `progress`, which is the Status column's own filter and
                 already knows these four stages by name (see PROGRESS in
                 routes/results.js). So the dropdown under the cards moves with
                 the card, and the card lights up when the dropdown is used --
                 one filter with two ways in, rather than a second filter that
                 happens to mean the same thing. */
              <button
                key={card.stage}
                type="button"
                className={`card stat stat--${card.tone} ${progress === card.stage ? 'is-active' : ''}`}
                onClick={() => selectProgress(progress === card.stage ? '' : card.stage)}
                aria-pressed={progress === card.stage}
                title={
                  progress === card.stage
                    ? `Showing ${card.label} only — press again for every row`
                    : `Show only the ${card.label} rows`
                }
              >
                <div className="stat__label">{card.label}</div>
                {/* The cheque count, not the GRN count -- see CSD_CARDS. */}
                <div className="stat__value">
                  {(summary.csd?.[card.stage]?.cheques ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.csd?.[card.stage]?.amount ?? 0)}</div>
                <div className="stat__hint">
                  {`${(summary.csd?.[card.stage]?.count ?? 0).toLocaleString('en-IN')} GRN${
                    (summary.csd?.[card.stage]?.count ?? 0) === 1 ? '' : 's'
                  } ${card.note}`}
                </div>
              </button>
            ),
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
          {/* How far through CSD the rows have got -- the open question on both
              views, since every row either screen shows here has an ageing
              entry. Choosing a value on the ageing view takes the table to
              Accounts, which is the only view that has a Status column for it
              to be about. The counts come from the same clauses the filter
              uses, so the number beside an option is the number of rows
              picking it yields. */}
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

          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, GRN, bill or cheque no."
            aria-label="Search by vendor name, GRN number, bill number or cheque number"
          />

          {/* Acting on several GRNs paid by the same cheque at once, rather
              than one dropdown per row -- sending them to CSD, receiving them
              back from it, or forwarding them on to Bank, Vendor or Courier,
              whichever the ticked rows agree on. The toggle doubles as its own
              cancel: once a selection is open, pressing it again is the same
              button reading a cross rather than a second control beside it.

              Not on the ageing view, which has no Action column and no rows of
              this shape to tick. */}
          {status !== TURNAROUND && (
            <>
              {multiMode && allSelectedCsd && (
                <button type="button" className="primary" onClick={sendSelectedToCsd} disabled={bulkSending}>
                  {bulkSending ? 'Sending…' : `Send ${selected.size} to CSD`}
                </button>
              )}
              {multiMode && allSelectedReceive && (
                <button type="button" className="primary" onClick={receiveSelected} disabled={bulkSending}>
                  {bulkSending ? 'Receiving…' : `Receive ${selected.size}`}
                </button>
              )}
              {multiMode && allSelectedForward && (
                <select
                  className="stage-select send-select"
                  value=""
                  disabled={bulkSending}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === 'VENDOR' || value === 'COURIER') setBulkForwardTo(value);
                    else if (value === 'BANK') forwardSelectedSimple('BANK');
                  }}
                  aria-label={`Send ${selected.size} selected GRNs on to their next destination`}
                >
                  <option value="">Send {selected.size} to…</option>
                  <option value="BANK">Send to Bank</option>
                  <option value="VENDOR">Send to Vendor</option>
                  <option value="COURIER">Send to Courier</option>
                </select>
              )}
              <button
                type="button"
                className={multiMode ? 'ghost icon-btn' : 'ghost'}
                onClick={() => (multiMode ? exitMultiMode() : setMultiMode(true))}
                title={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to act on together'}
                aria-label={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to act on together'}
              >
                {multiMode ? <IconX size={14} /> : 'Select multiple'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {bulkForwardTo && (
        <ForwardDetailsDialog
          subject={`${selected.size} GRNs`}
          to={bulkForwardTo}
          busy={bulkSending}
          error={bulkForwardError}
          onSubmit={submitBulkForward}
          onClose={() => setBulkForwardTo(null)}
        />
      )}

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
