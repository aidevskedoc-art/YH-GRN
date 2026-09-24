import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { exportSection } from '../services/exporter.js';
import {
  ACCOUNTS_CHEQUE_VIEW,
  ACCOUNTS_GRN_VIEW,
  ACCOUNTS_QUEUE_CARD,
  ACCOUNTS_ROW,
  ACCOUNTS_TAB,
  ALL_GRNS,
  BPAD,
  CHEQUE_CARDS,
  CSD_CARDS,
  MISSING,
  NOT_IN_BPAD,
  TURNAROUND,
  TURNAROUND_SCOPE,
  TURNAROUND_TAB,
  VALID,
  bulkCategory as bulkCategoryOf,
  bulkCsdEligible,
  canHandToCsd,
  bulkForwardEligible,
  bulkReceiveEligible,
  csdCardFigures,
  deptLabel,
  isAccountsDept,
  progressCardFigures,
  progressFilterOptions,
  sectionSheets,
} from '../services/resultsViews.js';
import ViewModeRadios from '../components/ViewModeRadios.jsx';
import { expandCheques, resultsChequeBills } from '../services/chequeGroups.js';
import ResultsTable, { formatAmount, ForwardDetailsDialog } from '../components/ResultsTable.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import BpadView from '../components/BpadView.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import MsmeFilter from '../components/MsmeFilter.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { IconArrowRight, IconX } from '../components/icons.jsx';

/** How long the search box waits for the typing to stop before it asks. */
const SEARCH_DELAY_MS = 300;

/*
 * Pending first: it is the answer the report is run to get.
 *
 * VALID and TURNAROUND are imported rather than declared: the Accounts Department
 * screen shows those same two views and has to name them the same way -- see
 * services/resultsViews.js. The two below are this screen's alone.
 */
/*
 * BPAD, ALL_GRNS, MISSING, NOT_IN_BPAD and deptLabel are imported rather than
 * declared here: the export builds a sheet per card (see sectionSheets in
 * services/resultsViews.js) and so has to name the same views, the same
 * register filter and the same "the register cannot place this" bucket that
 * the cards on this page do. One spelling, in the file both read.
 *
 * BPAD has a card, being a population with a count and a value, but reads a
 * different table from the three reconciliation views -- so it fetches its own
 * rows (see BpadView) rather than going through /results, and the toolbar's
 * filters below have nothing to ask it.
 */

const TABS = [
  // First, because it is the whole population the two entries after it divide
  // up: the row of cards then reads as everything, then the half still
  // outstanding, then the half that got through.
  //
  // `countKey` because the summary has no ALL bucket of its own -- the figure
  // it wants is the one it already adds up under `total`.
  { status: ALL_GRNS, label: 'Total GRNS', hint: 'Pending and valid together', countKey: 'total' },
  // The half the reconciliation has not moved on yet. It is a card again now
  // that the view is chosen from a dropdown: the dropdown says which one view
  // is showing and has room for one number at a time, so a count worth seeing
  // beside the others has to be a card to be seen at all.
   { status: BPAD, label: 'BPAD', hint: 'Entries in the register', countKey: 'bpadRegister' },
   ACCOUNTS_TAB,
  { status: 'PENDING', label: 'Pending GRNS', hint: 'Not yet in accounts' },
  // Imported, not spelled out here: the Accounts Department screen offers the same
  // two views and must label them identically.
  
  // After Accounts, because it is the same question asked of a different
  // register: the ageing report says a GRN reached accounts, and BPAD says
  // which desk it is sitting on and how long it has been there.
  //
  // `countKey` because the summary carries it under its own name rather than
  // as a reconciliation bucket -- and `bpadRegister` rather than `bpad`
  // because this card is about the register. The tab lists every GRN in scope,
  // including the ones the register had no entry for, so its pager counts more
  // rows than the register holds records; the gap is stated in the tab's own
  // banner. The card asks "how many records are in BPAD", so it answers with
  // the records that are in BPAD.
 
  TURNAROUND_TAB,
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

/*
 * The Status column's own filter values, their wording and their order, live
 * in services/resultsViews.js: the Accounts Department offers the same dropdown
 * over the same rows, and two copies of this list would be two vocabularies
 * for one column. progressFilterOptions builds the options from the summary.
 */

/*
 * The CSD stage cards and the cheque pair that close the Accounts row are in
 * services/resultsViews.js, for the reason the progress labels are: the
 * Accounts Department shows the same row of cards, counting the same GRNs.
 */

/* The bucket the turnaround report measures -- see TURNAROUND_SCOPE there. */

/**
 * The four counts, in the order the row shows them -- which is not the order
 * TABS lists the views in, so it is spelled out rather than derived from it.
 *
 * The whole population leads. Then the two registers a GRN can have reached,
 * BPAD and Accounts, and last the half that has reached neither. So the row
 * runs from everything, through where things have got to, to what is still
 * outstanding -- and the figure a reader is usually chasing is the one it ends
 * on rather than one buried mid-row.
 *
 * The GRNS SPAN view alone reads this now -- Total GRNS has its own row
 * below. Accounts stays on it there because that is the population the ageing
 * is measured over (see TURNAROUND_SCOPE), so its card is what says what the
 * day counts are counting.
 */
const BUCKET_CARDS = [ALL_GRNS, BPAD, VALID, 'PENDING'];

/**
 * Total GRNS' own row: the whole population, the half still outstanding, then
 * the register that says where those bills are sitting.
 *
 * Accounts is deliberately not on it. That half has a view of its own with a
 * row of its own -- the cheque pair, the CSD stages and the Accounts Queue --
 * and its count is still on the View dropdown beside its option, so nothing
 * became unreachable by dropping the card here.
 *
 * Pending comes before BPAD because it is the question BPAD answers: how many
 * have not reached accounts, then where the register says each one stopped.
 */
const TOTAL_ROW = [ALL_GRNS, MISSING, BPAD, 'PENDING'];

/**
 * Which cards each view shows.
 *
 * A view leads with its own count and then shows whatever divides it up.
 *
 * The row used to open with all four counts everywhere -- how many GRNs there
 * are, how many are still outstanding, how many got through, and how many the
 * BPAD register knows -- on the reasoning that a figure you have to change
 * view to read is a figure nobody reads. What broke that was the views that
 * have something of their own to show. Pending gained five desk cards and
 * Accounts already had four CSD ones, and behind four counts each made a row
 * of nine that had to be read in two halves: four counting different
 * populations, then the rest about one of them.
 *
 * So neither shows the four any more. Each keeps its own count and the cards
 * that divide it: Pending its five desks, Accounts the cheque pair and the
 * four CSD stages. Every dropped figure is a dropdown away and unchanged there
 * -- the view selector carries every count beside its option -- so nothing
 * became unreachable, and each row now describes one population from end to
 * end.
 *
 * Total GRNS keeps the counts that split it -- itself, Pending and BPAD (see
 * TOTAL_ROW) -- and Turnaround keeps all four, measuring one of those
 * populations rather than dividing one.
 *
 * The two rows are not the same shape behind the count, and deliberately not.
 * Pending's five desks ARE its breakdown: they divide the figure beside them
 * and sum back to it exactly, NOT_IN_BPAD included. On Accounts only the
 * cheque pair does that, which is why it comes first -- see ACCOUNTS_ROW in
 * services/resultsViews.js for that order. The CSD four do not: they go with
 * Accounts because that is where a sent GRN comes from -- only a matched row
 * can be sent, and a pending one has a dash where the Send picker would be --
 * but the summary counts them by the existence of a dispatch, with no
 * reconciliation-status clause at all, and drops the MOVED_TO_ACCOUNTS stage
 * entirely (see the csd query in routes/results.js). They neither sum to
 * Accounts nor sit inside it, so they are read as four separate questions
 * about the same rows rather than as a breakdown of the count at the head of
 * them.
 *
 * BPAD keeps none of the four. It is the one view not about the
 * reconciliation at all -- it reads the register's own table, and how many
 * GRNs are pending or through accounts says nothing about where a bill is
 * sitting. Its row is built entirely at render time: its own BPAD count, then
 * the register's own two questions -- which desk, and whether the register
 * knew the GRN at all.
 *
 * One thing the old arrangement bought that this does not: with the same four
 * cards in the same order everywhere, a press could never move a different
 * card under the pointer. Rows differ per view now, so a second press after a
 * view change lands on whatever the new row put in that position -- on
 * Accounts, a CSD card, which leaves the screen. Worth knowing before adding
 * anything else that navigates.
 */
const CARDS_FOR = {
  [ALL_GRNS]: TOTAL_ROW,
  // Its own count only -- the desk breakdown appended at render time is the
  // rest of this row. See the note above.
  PENDING: ['PENDING'],
  // Its own count, then the cheque pair that divides it, then the four CSD
  // stages -- imported, because the Accounts Department shows this same row and the
  // two must not drift into different orders. See ACCOUNTS_ROW.
  [VALID]: ACCOUNTS_ROW,
  [BPAD]: [],
  [TURNAROUND]: BUCKET_CARDS,
};

/**
 * Every card the row can show, under the id CARDS_FOR names it by -- a
 * reconciliation status for the bucket cards, a stage for the CSD ones, a
 * Status-filter key for the cheque pair.
 *
 * `kind` because they are different controls rather than three skins of one:
 * a bucket card opens its view, or clears the row where it heads one; a CSD
 * card and a cheque card each narrow the rows below to themselves, reading
 * their counts from different halves of the summary.
 */
const CARD_BY_ID = Object.fromEntries([
  ...CARD_TABS.map((tab) => [tab.status, { kind: 'bucket', ...tab }]),
  ...CSD_CARDS.map((card) => [card.stage, { kind: 'csd', ...card }]),
  ...CHEQUE_CARDS.map((card) => [card.progress, { kind: 'progress', ...card }]),
  [ACCOUNTS_QUEUE_CARD.progress, { kind: 'progress', ...ACCOUNTS_QUEUE_CARD }],
  // The GRNs the register has no entry for -- still at the GRN store rather
  // than pending at a desk. Filed under the register's own filter value, and
  // named here so the card and its sheet in the workbook cannot drift apart.
  [MISSING, { kind: 'missing', label: 'Pending GRNs at GRN Store' }],
]);

/**
 * "All uploads": every batch reconciled together, which is the only scope the
 * page has. It travels where a batch id used to -- the value handed to every
 * API call below -- and the server drops its batch filter when it sees it.
 */
const ALL = 'all';

export default function Results() {
  const { can } = useAuth();
  const navigate = useNavigate();
  // `routerLocation`, not `location` -- that name is already this page's branch
  // filter, a few lines down.
  const routerLocation = useLocation();

  /*
   * How many GRNs the upload just made took back off the CSD queue by naming a
   * bill CSD had rejected -- see reopenRejectedFor in services/ingest.js. Those
   * rows read as unsent again and have to be sent afresh, which is not
   * something to let somebody discover by accident.
   *
   * Kept in state rather than read straight off the router, so that dismissing
   * it sticks, and cleared out of the history entry immediately so a reload or
   * a Back does not announce an upload that happened an hour ago.
   */
  const [reopened, setReopened] = useState(routerLocation.state?.reopenedRejections ?? 0);
  useEffect(() => {
    if (routerLocation.state?.reopenedRejections) {
      navigate(routerLocation.pathname, { replace: true, state: null });
    }
  }, [routerLocation.pathname, routerLocation.state, navigate]);

  // Every upload, always. There is no picker any more: the page reports on
  // everything on file, counting a GRN number that repeats across uploads
  // only once (the server deduplicates for this scope).
  const batchId = ALL;

  // Kept only for the header's count and for telling "nothing uploaded yet"
  // apart from "still loading".
  const [batches, setBatches] = useState([]);
  const [summary, setSummary] = useState(null);
  // Total GRNS, always: the whole population is the honest thing to land on --
  // the two halves under it are a narrowing of what is already on screen,
  // rather than a fact the page has to be moved off a half to see.
  const [status, setStatus] = useState(ALL_GRNS);
  // Which Status value the table is narrowed to, or '' for every row.
  // Deliberately not part of `status`: it cuts across the reconciliation
  // buckets rather than being one of them.
  const [progress, setProgress] = useState('');
  // How the Accounts view's table is read: a row per GRN, or a row per cheque
  // with its bills' PayableAmount summed -- the same switch as the Accounts
  // Department's. Only the Accounts view has it; everywhere else is by GRN.
  const [accountsView, setAccountsView] = useState(ACCOUNTS_GRN_VIEW);
  const byCheque = status === VALID && accountsView === ACCOUNTS_CHEQUE_VIEW;
  // Which half of Total GRNS is showing, or '' for both. Meaningless on the
  // other tabs, and cleared on the way out of this one.
  const [matchFilter, setMatchFilter] = useState('');
  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. Unlike the two filters above it is not about a tab: it
  // narrows the whole page -- rows, cards, option counts and the export -- and
  // it survives moving between tabs, because "the Secunderabad numbers" is a
  // question every tab answers.
  const [location, setLocation] = useState('');
  // 'MSME', 'NON_MSME', or '' for every vendor -- the MSME dropdown. A scope
  // like Location: every tab, card, count and export follows it, and it
  // survives moving between tabs. See MsmeFilter.jsx.
  const [msme, setMsme] = useState('');
  // Which desk the BPAD tab is narrowed to -- one value of the register's own
  // Pending With Dept. column -- or '' for every one of them. It belongs to
  // that tab the way matchFilter belongs to Total GRNS, and `departments` is
  // the list to offer, which only BpadView's own call can know.
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState([]);
  // Which desk the PENDING view is narrowed to, set by the breakdown cards
  // under it, or '' for every one of them. Separate state from `dept` above
  // even though both hold a value of the same register column: that one
  // narrows the BPAD tab and this one narrows the reconciliation rows, they
  // are never on screen together, and sharing one would carry a filter from
  // one view into the other the moment the view changed.
  const [pendingDept, setPendingDept] = useState('');
  // Whether the BPAD tab is narrowed to the GRNs with no register entry, by
  // the Not in BPAD card. Its own state rather than a value of `dept`: it is
  // the other column, and the two cannot both hold at once.
  const [register, setRegister] = useState('');
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

  // Acting on several GRNs paid by the same cheque in one action, instead of
  // one dropdown per row -- sending several to CSD, receiving several back
  // from it, or forwarding several on to Bank, Vendor or Courier. `multiMode`
  // is the checkbox column showing at all; `selected` is which GRN numbers
  // are ticked within it. Both live here rather than in ResultsTable because
  // the toggle and the bulk action controls sit in this page's toolbar,
  // beside the search box.
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);
  // Which destination the bulk forward dialog is open for (VENDOR or
  // COURIER), or null -- Bank has nothing further to collect and acts at
  // once, the same as the per-row picker. Its own error stays apart from the
  // table's, same reason ResultsTable keeps forwardFormError apart: a
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

  // The batch list is no longer a choice, only a count -- and the one thing
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
    if (!batchId) return;
    api
      .summary(batchId, { q, location, msme })
      .then(({ summary: s }) => setSummary(s))
      .catch((err) => setError(err.message));
  }, [batchId, q, location, msme]);

  // Which rows to ask for, as against which tab is showing. The two are the
  // same everywhere except Total GRNS with its filter set, where the tab decides
  // the layout and the filter decides the population.
  const rowStatus = status === ALL_GRNS && matchFilter ? matchFilter : status;

  const loadRows = useCallback(() => {
    if (!batchId) return;
    // Neither Turnaround nor BPAD is a reconciliation status -- /results would
    // reject either as an unknown filter. Both tabs fetch their own data, in
    // TurnaroundView and BpadView.
    if (status === TURNAROUND || status === BPAD) return;
    setLoading(true);
    api
      .results(batchId, {
        status: rowStatus,
        page,
        pageSize,
        q,
        progress,
        location,
        msme,
        dept: pendingDept,
        view: byCheque ? ACCOUNTS_CHEQUE_VIEW : undefined,
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, status, rowStatus, page, pageSize, q, progress, location, msme, pendingDept, byCheque]);

  useEffect(loadRows, [loadRows]);

  // A ticked GRN belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs invalidates the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [batchId, rowStatus, page, pageSize, q, progress, location, msme, pendingDept, byCheque]);

  /*
   * The three things "Select multiple" can batch, mirroring the row's own
   * journey -- see the predicates in services/resultsViews.js, which the
   * Accounts Department applies to the same rows. Only the CSD one asks anything of
   * this account, so only it takes the grant.
   */
  const canBulkCsd = (row) => bulkCsdEligible(row, canHandToCsd(can));
  const canBulkReceive = bulkReceiveEligible;
  const canBulkForward = bulkForwardEligible;
  const bulkCategory = (row) => bulkCategoryOf(row, canHandToCsd(can));

  /**
   * Ticking one row also ticks every other row on the page still eligible for
   * the SAME action that shares its cheque number -- a cheque pays a group of
   * GRNs together, so selecting one of them is read as meaning the whole
   * group. Restricted to the same category so ticking a row awaiting CSD
   * never silently drags in a same-cheque row that has already come back from
   * it. Unticking only lets go of the one row: narrowing the group back down
   * is a deliberate choice, not one this page should second-guess by dragging
   * the rest off with it.
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

  /** What the bulk buttons call the selection: GRNs, or cheques on Cheque view. */
  const selectedLabel = byCheque
    ? `${selected.size} cheque${selected.size === 1 ? '' : 's'}`
    : `${selected.size}`;

  /**
   * The rows a bulk action actually acts on: the ticked rows, or on Cheque view
   * every still-eligible bill the ticked cheques pay -- see chequeGroups.js.
   */
  function bulkTargets(eligible) {
    if (!byCheque) return selectedRows;
    return expandCheques(
      selectedRows,
      (row) => resultsChequeBills(batchId, row, eligible),
      (row) => row.dprNo,
    );
  }

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
      const targets = await bulkTargets(canBulkCsd);
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

  /** Acknowledge every ticked row CSD has handed back, in one go. */
  async function receiveSelected() {
    if (selectedRows.length === 0) return;
    setBulkSending(true);
    setError('');
    try {
      const targets = await bulkTargets(canBulkReceive);
      await Promise.all(targets.map((row) => api.receiveAccountsReturn(row.csdDispatchId)));
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
      const targets = await bulkTargets(canBulkForward);
      await Promise.all(targets.map((row) => api.forwardAccountsReturn(row.csdDispatchId, { to })));
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
   * its fields are in. One form, filled in once, and the same answer is
   * copied onto every selected row's own dispatch -- see the note on
   * ForwardDetailsDialog for why `route: 'OTHERS'` is translated back into
   * `to: 'OTHERS'` here, same as the single-row version in ResultsTable does.
   */
  async function submitBulkForward({ route, name, mobile, date, courierName, docketNo, remarks }) {
    const to = bulkForwardTo === 'VENDOR' && route === 'OTHERS' ? 'OTHERS' : bulkForwardTo;
    setBulkSending(true);
    setBulkForwardError('');
    try {
      const targets = await bulkTargets(canBulkForward);
      await Promise.all(
        targets.map((row) =>
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

  function selectStatus(next) {
    // Moving onto or off a Cheque view table changes the rows' shape; drawing
    // the old rows under the new columns until the reload lands would show a
    // broken table.
    if (accountsView === ACCOUNTS_CHEQUE_VIEW && (next === VALID) !== (status === VALID)) setData(null);
    // BPAD and Turnaround fetch their own rows, so what is held here is still
    // whatever view came before them. Leaving one for Accounts -- which the
    // BPAD view's Accounts card does -- would otherwise draw that older view's
    // rows under the Accounts layout until the reload lands, which reads as
    // the page having filtered rather than moved.
    if (status === BPAD || status === TURNAROUND) setData(null);
    setStatus(next);
    setPage(1);
    // These values only ever appear on a GRN that reached accounts, so carrying
    // the filter onto Pending would show an empty tab with no visible reason why.
    if (next !== VALID) setProgress('');
    // The match filter belongs to Total GRNS and its dropdown is only rendered
    // there, so leaving it set would go on narrowing the next view invisibly.
    if (next !== ALL_GRNS) setMatchFilter('');
    // Same for the department and the register filter: both are the BPAD
    // register's own columns, and no other tab has either to be narrowed by.
    if (next !== BPAD) {
      setDept('');
      setRegister('');
    }
    // And the desk breakdown, which belongs to the pending rows. Cleared on
    // the way to anything else rather than only on the way to a view without
    // cards, because it narrows the rows themselves: left set, it would go on
    // hiding rows on a view that shows nothing to say why.
    if (next !== 'PENDING') setPendingDept('');
  }

  /**
   * Narrow the pending rows to one BPAD desk, or '' for every one of them.
   *
   * Page 1, for the reason every other narrowing resets it: page 4 of the
   * whole queue is rarely page 4 of one desk's share of it.
   */
  function selectPendingDept(next) {
    setPendingDept(next);
    setPage(1);
  }

  /**
   * Narrow the BPAD tab to one department, or '' for every one of them.
   *
   * Clears the Not in BPAD card, because a GRN the register never knew has no
   * Pending With Dept. value -- the two together would always be no rows, and
   * an empty table with two things lit up says nothing about which one emptied
   * it.
   */
  function selectDept(next) {
    setDept(next);
    if (next) setRegister('');
  }

  /** Show only the GRNs with no register entry, or '' for every row. */
  function selectRegister(next) {
    setRegister(next);
    // Same exclusion, from the other side.
    if (next) setDept('');
  }

  /** Switch the Accounts table between a row per GRN and a row per cheque. */
  function selectAccountsView(next) {
    if (next === accountsView) return;
    setAccountsView(next);
    setPage(1);
    // The rows on hand are the other view's shape -- see selectStatus.
    setData(null);
  }

  /** Narrow every figure on the page to one branch, or '' for all of them. */
  function selectLocation(next) {
    setLocation(next);
    // Page 7 of one branch is rarely a page of another.
    setPage(1);
  }

  /** Narrow every figure on the page to MSME or Non-MSME vendors, or '' for all. */
  function selectMsme(next) {
    setMsme(next);
    setPage(1);
  }

  /** Show one half of Total GRNS, or both. */
  function selectMatchFilter(next) {
    setMatchFilter(next);
    setPage(1);
    // Total GRNS narrowed to its pending half shows the desk cards too, since
    // those are the same rows -- but changing which half is showing changes
    // the population under them, so the desk goes back to all of them.
    if (next !== 'PENDING') setPendingDept('');
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

  // The progress dropdown's own options, built from the summary the page just
  // loaded rather than from a fixed list -- see progressFilterOptions.
  const progressFilters = progressFilterOptions(summary);

  // The cards this view shows, in the order CARDS_FOR names them.
  //
  // Keyed on `rowStatus` rather than `status`, so narrowing Total GRNS to one
  // of its halves brings that half's cards with it: those are the same rows
  // the Accounts view would put on screen, from the same call, so the figures
  // standing over them should be the same too.
  const cards = [
    ...(CARDS_FOR[rowStatus] ?? [])
      .map((id) => CARD_BY_ID[id])
      .filter(Boolean)
      // Nothing in the register yet: a Not in BPAD card would report a zero
      // about a file nobody has uploaded. Same suppression the BPAD row makes.
      .filter((card) => card.kind !== 'missing' || summary?.bpad?.count > 0),
    // The BPAD view's whole row, built here rather than in CARDS_FOR because
    // it is the register's own data: whatever desks the uploaded file happens
    // to name, and whether it knew each GRN at all.
    //
    // Not in BPAD leads, ahead of the desks, because it is the exception --
    // the same reason the table itself lists those rows first. Every card here
    // is a filter on the rows below: pressing one narrows the tab to it, and
    // pressing the one already showing goes back to everything. The two kinds
    // are mutually exclusive, because a GRN the register never knew has no
    // desk to be sitting at.
    //
    // Suppressed entirely with nothing in the register, where a row of zeroes
    // would sit over BpadView's own "no register uploaded yet" notice and
    // answer a question nobody asked.
    //
    // Headed by the BPAD count card itself, the way Pending and Accounts lead
    // with their own count: pressing it clears the desk filter -- and the Not
    // in BPAD one, which this row no longer carries a card for; that card
    // stands on the Total GRNS row instead (see TOTAL_ROW) and arrives here
    // with its filter already set. See rowHead.
    ...(status === BPAD && summary?.bpad?.count > 0
      ? [
          CARD_BY_ID[BPAD],
          // Accounts is the one desk this page has a section of its own for,
          // so its card opens that section instead of filtering the register
          // to it -- see the deptAccounts branch in the row below. Split here
          // rather than tested at render time so the export knows about it too
          // (cardSheet in resultsViews.js).
          ...departments.map((d) => ({ kind: isAccountsDept(d.dept) ? 'deptAccounts' : 'dept', ...d })),
        ]
      : []),
    // Where the pending ones are pending -- the register's Pending With Dept.
    // for each of them, grouped. "Pending" says only that the ageing report
    // has not picked a GRN up yet; it does not say where it stopped, and that
    // is the next thing anybody reading the figure wants. These answer it.
    //
    // Behind the four counts rather than instead of them, so the row still
    // opens with the same four cards it opens with on every other view and
    // pressing one of these never moves another out from under the pointer.
    //
    // Keyed on rowStatus, so Total GRNS narrowed to its pending half gets them
    // too: same rows below, same figures above. Suppressed when there are no
    // pending GRNs at all, where a row of zeroes would be reporting on an
    // empty table. They sum to the Pending card exactly -- see
    // pendingDepartments in routes/results.js.
    //
    // Suppressed with no register uploaded as well: the breakdown is the
    // register's answer, and without one every pending GRN falls into its
    // "cannot place this" bucket -- one card repeating the count beside it.
    ...(rowStatus === 'PENDING' && summary?.PENDING?.count > 0 && summary?.bpad?.count > 0
      ? (summary.pendingDepartments ?? [])
          // Not the register's "cannot place this" bucket: those are the GRNs
          // still at the GRN store, and they have their own card on the Total
          // GRNS row. Leaving it off here is also what makes these desks sum
          // to the Pending figure beside them -- see bucketFigure.
          .filter((d) => d.dept !== NOT_IN_BPAD)
          .map((d) => ({ kind: 'pendingDept', ...d }))
      : []),
  ];
  /**
   * What a count card prints. Everything reads its own bucket off the summary,
   * except Pending once a BPAD register has been uploaded.
   *
   * The register places every pending bill at a desk, and the ones it has no
   * entry for are not pending anywhere in that process -- they are the GRNs
   * still at the GRN store, counted by their own card on the Total GRNS row.
   * So with a register on file the Pending figure is the bills the register
   * actually places (175 of 183 here), and without one it is the whole bucket,
   * there being nothing to tell the two apart.
   *
   * Summed from the desk breakdown the summary already carries, so it is the
   * same scope -- same search, same branch -- as the figure it is taken from.
   */
  const bucketFigure = (card) => {
    // `summary` is null until the first load lands, and these run before it
    // -- the export's sheet list is built on every render, not only once the
    // cards are on screen.
    const own = summary?.[card.countKey ?? card.status] ?? { count: 0, amount: 0 };
    if (card.status !== 'PENDING' || !(summary?.bpad?.count > 0)) return own;
    const placed = (summary?.pendingDepartments ?? []).filter((d) => d.dept !== NOT_IN_BPAD);
    if (placed.length === 0) return own;
    return placed.reduce(
      (sum, d) => ({ count: sum.count + d.count, amount: sum.amount + (d.amount ?? 0) }),
      { count: 0, amount: 0 },
    );
  };

  /**
   * What a count card is called. Only Pending changes with the data: with a
   * BPAD register on file its figure is the bills that register places at a
   * desk (see bucketFigure), so the card says where they are pending rather
   * than leaving the reader to work out why it is not the whole bucket.
   * Without a register it is every pending GRN, and the plain name is right.
   */
  const bucketLabel = (card) => {
    if (card.status !== 'PENDING') return card.label;
    return summary?.bpad?.count > 0 ? 'Pending GRNs at BPAD' : 'Pending GRNs';
  };

  // Which bucket the view is about, for the one card that gets the ring. On
  // Turnaround that is the population being measured rather than the view's
  // own name -- see TURNAROUND_SCOPE.
  const activeBucket = status === TURNAROUND ? TURNAROUND_SCOPE : rowStatus;

  /**
   * The section showing, as its own entry in TABS -- the first sheet of the
   * export, and the population the cards below divide.
   *
   * Keyed on `rowStatus` for the reason the cards are: Total GRNS narrowed to
   * one of its halves is showing that half's rows under that half's cards, so
   * the file taken off it should be that half and its breakdown rather than
   * the whole population under someone else's cards.
   */
  const section = TABS.find((tab) => tab.status === rowStatus) ?? TABS[0];

  /**
   * What Export Excel will hand back: the section's own sheet, then a sheet
   * per card below it -- read off the very cards rendered further down, so the
   * file and the row cannot name different things. One sheet on the ageing
   * view, whose cards divide nothing; see sectionSheets.
   *
   * Worked out here rather than inside the handler because the button's
   * tooltip promises a sheet per card and has to stop promising it where there
   * is only the one.
   */
  const exportSheets = sectionSheets(section, cards, {
    // The sheets are named after the cards they were taken off -- Pending
    // reads "Pending GRNs at BPAD" once a register is uploaded, and the GRN
    // store card has a name of its own.
    labelFor: (card) => (card.kind === 'bucket' ? bucketLabel(card) : card.label),
    // ...and with a register on file the Pending sheets hold the bills it
    // places, which is the figure that card carries.
    pendingInBpad: summary?.bpad?.count > 0,
  });

  /**
   * The sheets above, as one workbook.
   *
   * It used to be one fixed workbook of every view, whichever view you pressed
   * it from. That answered a question nobody had asked -- a reader on Total
   * GRNS was not after the CSD stages -- and it had no sheet at all for the
   * figures the cards actually carry: the desks, the stages, the cheque pair.
   * Those are the numbers people are reading off this page, and now each one
   * has its rows in the file.
   *
   * Only the page's scope travels -- the search box and the branch. The
   * dropdown filters stay out, as before: each sheet already carries its own
   * card's narrowing, and letting a dropdown cut the rows first would hand
   * back sheets that no longer divide the section they claim to.
   */
  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      // The Accounts view's sheets follow the GRNs / Cheques switch; every
      // other view exports as before.
      await exportSection(batchId, exportSheets, {
        q,
        location,
        msme,
        spans,
        accountsView: status === VALID ? accountsView : undefined,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  /**
   * The filter a count card heads, when it stands at the front of a row that
   * divides it -- or null on a card that is only a count.
   *
   * Two views have such a row now. Pending's desk cards divide it by where
   * each bill is sitting; Accounts' CSD cards divide it by how far through the
   * handover each row has got. On both, the leading card is where "All" sits
   * in any other row of filters -- and a card that looks like the head of a
   * breakdown but ignores a press while the ones beside it toggle is the kind
   * of dead control people press twice and then stop trusting.
   *
   * `on` is whether anything is narrowing that row at the moment, which is
   * what pressing changes and therefore what the ring should follow. Every
   * other card gets null back and keeps the ring's older meaning: this is the
   * view showing.
   */
  const rowHead = (card) => {
    if (card.kind !== 'bucket' || card.status !== rowStatus) return null;
    if (rowStatus === 'PENDING') {
      return { on: Boolean(pendingDept), noun: 'pending GRN', clear: () => selectPendingDept('') };
    }
    if (rowStatus === ALL_GRNS) {
      // The one card beside it that narrows this row -- Pending GRNs at GRN
      // Store -- sets `pendingDept`, so clearing that is "all of them" here.
      return { on: Boolean(pendingDept), noun: 'GRN', clear: () => selectPendingDept('') };
    }
    if (rowStatus === VALID) {
      // The cheque pair and the four CSD stages all set `progress`, so that one
      // value is what narrows this row and clearing it is what "all of them"
      // means here.
      return { on: Boolean(progress), noun: 'GRN in accounts', clear: () => selectProgress('') };
    }
    if (rowStatus === BPAD) {
      // The desk cards set `dept` and Not in BPAD sets `register`, and the two
      // never stand together -- so either one is what narrows this row, and
      // clearing both is "all of them".
      return {
        on: Boolean(dept || register),
        noun: 'BPAD row',
        clear: () => {
          setDept('');
          setRegister('');
        },
      };
    }
    return null;
  };

  /**
   * Which count card wears the ring.
   *
   * Normally the view showing. On a row its card heads, the narrower question
   * -- "is anything filtering this row?" -- because that is what pressing it
   * changes, and a ring that never goes out says nothing.
   */
  const bucketActive = (card) => {
    const head = rowHead(card);
    return head ? !head.on : card.status === activeBucket;
  };

  /**
   * What pressing one does: open its view, and where it heads a row, clear
   * whatever is narrowing that row.
   *
   * Both, rather than only clearing, because these rows also stand over Total
   * GRNS narrowed to the same half -- the same rows under a different view --
   * and there the card should land where its label says it does.
   */
  const pressBucket = (card) => {
    const head = rowHead(card);
    selectStatus(card.status);
    if (head) head.clear();
  };

  /** That card's tooltip; none on a card that is only a count. */
  const bucketTitle = (card) => {
    const head = rowHead(card);
    if (!head) return undefined;
    return head.on
      ? `Show every ${head.noun} again`
      : `Showing every ${head.noun} — press a card beside this to narrow it`;
  };

  return (
    <>
      {/* The shell's top bar already names the page, so this row carries the
          scope and its controls only. */}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">All uploads</h2>
          {/* The row counts are not the sum of the uploads': a GRN number
              repeating across uploads is counted once, so the total comes
              from the deduplicated summary rather than from the batch list. */}
          <p className="page__lead">
            {batches.length} upload{batches.length === 1 ? '' : 's'} combined —{' '}
            {summary ? `${summary.total.count.toLocaleString('en-IN')} GRNs` : 'every GRN'},
            counting a GRN number that repeats across uploads only once.
          </p>
        </div>

        {/* Every upload is always in scope, so the scope left to choose is
            which view of it and which branch. The filters in the toolbar under
            the cards are a different kind of question: they ask about the rows
            these two select, so they stay down there with the table. */}
        <div className="page__actions">
          {/* Which view the table below shows -- what the strip of tabs under
              the cards used to ask. It sits here, before Location, because the
              two together are the scope: what is being looked at, then which
              branch of it. Each option carries its own count, so the number a
              tab's chip used to show is still on the option that would open it,
              and the four reconciliation views have a card up top as well. */}
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

          {/* GRNs or Cheques, on the Accounts view only -- see accountsView. */}
          {status === VALID && <ViewModeRadios value={accountsView} onChange={selectAccountsView} />}

          <LocationFilter value={location} onChange={selectLocation} />

          {/* The section showing, as one workbook: its own sheet, then a
              sheet per card on the row below -- see handleExport. It sits
              beside the View dropdown because that dropdown is what it
              follows: which view you are on decides which sheets you get.
              The filters down by the table still do not narrow it -- each
              sheet carries its own card's narrowing instead. */}
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

      {reopened > 0 && (
        <div className="alert alert--info alert--dismiss">
          <span>
            {reopened.toLocaleString('en-IN')} GRN{reopened === 1 ? '' : 's'} CSD had rejected{' '}
            {reopened === 1 ? 'is' : 'are'} back in this upload, so {reopened === 1 ? 'it has' : 'they have'}{' '}
            come off the CSD queue and {reopened === 1 ? 'reads' : 'read'} as unsent again. Send{' '}
            {reopened === 1 ? 'it' : 'them'} to CSD afresh when ready — the reason{' '}
            {reopened === 1 ? 'it was' : 'they were'} turned down before is still on file.
          </span>
          <button type="button" className="ghost icon-btn" onClick={() => setReopened(0)} aria-label="Dismiss">
            <IconX size={14} />
          </button>
        </div>
      )}

      {summary && cards.length > 0 && (
        /* A row of one or two -- Pending with no register uploaded -- keeps the
           cards their own size rather than stretching them across the width the
           four-card rows need. See .cards--few. */
        <div className={`cards${cards.length < 3 ? ' cards--few' : ''}`}>
          {cards.map((card) =>
            card.kind === 'missing' ? (
              /* The GRNs the register had no entry for -- in practice goods
                 received on a delivery challan with no vendor invoice raised
                 yet, and BPAD is a register of bills. The tab's own banner
                 explains that; this counts it and can show it. */
              <button
                key="missing"
                type="button"
                className={`card stat stat--missing ${
                  pendingDept === NOT_IN_BPAD ? 'is-active' : ''
                }`}
                /* It narrows the table below rather than going anywhere: the
                   register's "no entry for this GRN" is the same question the
                   rows' own desk filter answers with NOT_IN_BPAD (see
                   PENDING_DEPT in routes/results.js), so pressing it filters
                   the view showing, and pressing it again clears it. */
                onClick={() =>
                  selectPendingDept(pendingDept === NOT_IN_BPAD ? '' : NOT_IN_BPAD)
                }
                aria-pressed={pendingDept === NOT_IN_BPAD}
                title={
                  pendingDept === NOT_IN_BPAD
                    ? 'Showing only the GRNs with no register entry — press again for every row'
                    : 'Show only the GRNs the BPAD register has no entry for'
                }
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {(summary.bpadMissing?.count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.bpadMissing?.amount ?? 0)}</div>
                <div className="stat__hint">GRNs Not Finalized</div>
              </button>
            ) : card.kind === 'deptAccounts' ? (
              /* The register's Accounts desk -- the bills it says are sitting
                 with accounts. Alone among the desks, this page has a section
                 of its own for that: the Accounts view, which lists the GRNs
                 the ageing report picked up and is the next thing a reader
                 looking at this figure wants.

                 So pressing the card opens that section -- exactly what
                 choosing Accounts in the View dropdown does -- instead of
                 narrowing the register's table to the desk. The narrowing is
                 not lost: the Department dropdown in the toolbar below still
                 offers Accounts as a filter, and the export still takes its
                 sheet off this card's own count.

                 It is not a toggle, so no `aria-pressed`: a press leaves this
                 row entirely, and a pressed state on a control that is never
                 on screen to be unpressed says nothing. The Accounts tone and
                 the arrow are what mark it out from the plain desk cards
                 beside it -- see .stat--go. */
              <button
                key={`dept:${card.dept}`}
                type="button"
                className="card stat stat--valid stat--go"
                onClick={() => selectStatus(VALID)}
                title="Open the Accounts section — the same as choosing Accounts in the View dropdown"
              >
                <IconArrowRight size={15} className="stat__go" />
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{card.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">Pending with this desk — open Accounts</div>
              </button>
            ) : card.kind === 'dept' ? (
              <button
                key={`dept:${card.dept}`}
                type="button"
                className={`card stat stat--dept ${dept === card.dept ? 'is-active' : ''}`}
                onClick={() => selectDept(dept === card.dept ? '' : card.dept)}
                aria-pressed={dept === card.dept}
                title={
                  dept === card.dept
                    ? `Showing ${deptLabel(card.dept)} only — press again for every department`
                    : `Show only the bills pending with ${deptLabel(card.dept)}`
                }
              >
                {/* Title case rather than the register's capitals -- see
                    deptLabel. The filter still uses the stored value. */}
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{card.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">Pending with this desk</div>
              </button>
            ) : card.kind === 'pendingDept' ? (
              /* One desk's share of the pending queue. Pressing it narrows the
                 table to that desk; pressing the one already showing goes back
                 to all of them -- the same gesture as the BPAD tab's own desk
                 cards, because it is the same column being asked about.

                 The bucket for the GRNs the register cannot place takes the
                 Not in BPAD colouring rather than a desk's, since that is what
                 it is: not a desk, an absence of one. */
              <button
                key={`pending-dept:${card.dept}`}
                type="button"
                className={`card stat ${
                  card.dept === NOT_IN_BPAD ? 'stat--missing' : 'stat--dept'
                } ${pendingDept === card.dept ? 'is-active' : ''}`}
                onClick={() => selectPendingDept(pendingDept === card.dept ? '' : card.dept)}
                aria-pressed={pendingDept === card.dept}
                title={
                  pendingDept === card.dept
                    ? `Showing ${deptLabel(card.dept)} only — press again for every pending GRN`
                    : card.dept === NOT_IN_BPAD
                      ? 'Show only the pending GRNs the BPAD register cannot place'
                      : `Show only the pending GRNs sitting with ${deptLabel(card.dept)}`
                }
              >
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{card.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">
                  {card.dept === NOT_IN_BPAD
                    ? 'Register has no desk for these'
                    : 'Pending at this desk'}
                </div>
              </button>
            ) : card.kind === 'progress' ? (
              /* Cheque prepared / not prepared. Same control as the CSD cards
                 beside it and the same filter behind it -- these two just name
                 a `progress` key directly instead of a CSD stage, because what
                 they ask about is read off the ageing report's cheque columns
                 rather than off a handover. See CHEQUE_PREPARED in
                 routes/results.js for what counts as prepared. */
              <button
                key={card.progress}
                type="button"
                className={`card stat stat--${card.tone ?? 'dept'} ${
                  progress === card.progress ? 'is-active' : ''
                }`}
                onClick={() => selectProgress(progress === card.progress ? '' : card.progress)}
                aria-pressed={progress === card.progress}
                title={
                  progress === card.progress
                    ? `Showing ${card.label} only — press again for every row`
                    : `Show only the ${card.label} rows`
                }
              >
                <div className="stat__label">{card.label}</div>
                {/* GRN counts lead on GRN view, cheque counts on Cheque view
                    -- see progressCardFigures. */}
                <div className="stat__value">
                  {progressCardFigures(card, summary, byCheque).value.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary.progress?.[card.progress]?.amount ?? 0)}
                </div>
                <div className="stat__hint">{progressCardFigures(card, summary, byCheque).hint}</div>
              </button>
            ) : card.kind === 'csd' ? (
              /* One CSD stage's share of the rows below. Pressing it narrows
                 the table to that stage; pressing the one already showing goes
                 back to every row -- the same gesture as the desk cards on the
                 pending row.

                 It sets `progress`, which is the Status column's own filter and
                 already knows these four stages by name (see PROGRESS in
                 routes/results.js). So the dropdown under the cards moves with
                 the card, and the card lights up when the dropdown is used --
                 one filter with two ways in, rather than a second filter that
                 happens to mean the same thing.

                 These used to leave for the CSD screen instead. That was the
                 one press on this row that took you off the page, and it left
                 the Accounts view unable to answer a question it had the rows
                 for. */
              <button
                key={card.stage}
                type="button"
                className={`card stat stat--${card.tone} ${
                  progress === card.stage ? 'is-active' : ''
                }`}
                onClick={() => selectProgress(progress === card.stage ? '' : card.stage)}
                aria-pressed={progress === card.stage}
                title={
                  progress === card.stage
                    ? `Showing ${card.label} only — press again for every row`
                    : `Show only the ${card.label} rows`
                }
              >
                <div className="stat__label">{card.label}</div>
                {/* GRN count or cheque count first, by view -- see csdCardFigures. */}
                <div className="stat__value">
                  {csdCardFigures(card, summary, byCheque).value.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.csd?.[card.stage]?.amount ?? 0)}</div>
                <div className="stat__hint">{csdCardFigures(card, summary, byCheque).hint}</div>
              </button>
            ) : (
              /* Pressing a count opens its view, the second way in beside the
                 View dropdown.

                 These four used to stand on every view in the same order, so
                 the card under the pointer was the same card after the press
                 and a second click could not land on a different one. That no
                 longer holds -- Pending and Accounts show their own count only
                 -- so a double press after a view change lands on whatever the
                 new row put in that position. See the note on CARDS_FOR.

                 `aria-pressed` because the ring is the only thing saying which
                 view is showing, and a ring reaches nobody using a screen
                 reader. Same as the equivalent cards on the CSD screen.

                 `countKey` where the summary files the figure under a name of
                 its own rather than as a reconciliation bucket -- Total GRNS
                 reads the `total` it already adds up, and BPAD its own
                 register's query. */
              <button
                key={card.status}
                type="button"
                className={`card stat stat--${card.status.toLowerCase()} ${
                  bucketActive(card) ? 'is-active' : ''
                }`}
                onClick={() => pressBucket(card)}
                aria-pressed={bucketActive(card)}
                title={bucketTitle(card)}
              >
                <div className="stat__label">{bucketLabel(card)}</div>
                <div className="stat__value">
                  {(bucketFigure(card).count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(bucketFigure(card).amount ?? 0)}</div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ),
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
          {/* MSME or Non-MSME vendors, on every view -- first, ahead of the
              view's own dropdown, since it narrows the whole page (cards,
              rows and export) where that one narrows the table. */}
          <MsmeFilter value={msme} onChange={selectMsme} />
          {/* One dropdown, three questions -- whichever the view underneath
              can answer. Total GRNS is the mixed list, so there it asks which
              half; Accounts is already one bucket and the open question there
              is how far through CSD its rows have got; BPAD is the register's
              own table, so it asks the register's own question -- which desk
              the bill is sitting at. Pending GRNS has no ageing entry and so
              no Status column for any of them to be about, so it alone gets no
              dropdown. */}
          {status === BPAD ? (
            /* The register's Pending With Dept. column, offered as the values
               it actually holds. The count beside an option is the number of
               rows picking it yields, the same promise the two dropdowns below
               make -- and it is what makes the empty date columns legible:
               nearly every row still at STORES has no BPAD Received Date
               because the bill has not reached that desk yet, which reads as
               missing data until the column can be looked at one desk at a
               time. */
            <select
              className="field__input stage-filter"
              value={dept}
              onChange={(e) => selectDept(e.target.value)}
              disabled={departments.length === 0}
              aria-label="Filter the table by the department the bill is pending with"
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.dept} value={d.dept}>
                  {deptLabel(d.dept)} ({d.count.toLocaleString('en-IN')})
                </option>
              ))}
              {/* A department chosen before the upload changed under it would
                  otherwise vanish from the list while still narrowing the
                  table, which reads as the table having gone wrong. Keep it
                  selectable until it is changed. */}
              {dept && !departments.some((d) => d.dept === dept) && (
                <option value={dept}>{deptLabel(dept)}</option>
              )}
            </select>
          ) : status === ALL_GRNS ? (
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

          {/* Acting on several GRNs paid by the same cheque at once, rather
              than one dropdown per row -- sending them to CSD, receiving them
              back from it, or forwarding them on to Bank, Vendor or Courier,
              whichever the ticked rows agree on (see
              allSelectedCsd/allSelectedReceive/allSelectedForward). The
              toggle doubles as its own cancel: once a selection is open,
              pressing it again is the same button reading a cross rather
              than a second control beside it. */}
          {status !== 'PENDING' && status !== TURNAROUND && status !== BPAD && (
            <>
              {multiMode && allSelectedCsd && (
                <button
                  type="button"
                  className="primary"
                  onClick={sendSelectedToCsd}
                  disabled={bulkSending}
                >
                  {bulkSending ? 'Sending…' : `Send ${selectedLabel} to CSD`}
                </button>
              )}
              {multiMode && allSelectedReceive && (
                <button
                  type="button"
                  className="primary"
                  onClick={receiveSelected}
                  disabled={bulkSending}
                >
                  {bulkSending ? 'Receiving…' : `Receive ${selectedLabel}`}
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
                  <option value="">Send {selectedLabel} to…</option>
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
          subject={byCheque ? selectedLabel : `${selected.size} GRNs`}
          to={bulkForwardTo}
          busy={bulkSending}
          error={bulkForwardError}
          onSubmit={submitBulkForward}
          onClose={() => setBulkForwardTo(null)}
        />
      )}

      {status === BPAD ? (
        <BpadView
          batchId={batchId}
          q={q}
          location={location}
          msme={msme}
          dept={dept}
          register={register}
          onDepartments={setDepartments}
        />
      ) : status === TURNAROUND ? (
        <TurnaroundView
          batchId={batchId}
          q={q}
          location={location}
          msme={msme}
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
              accountsView={status === VALID ? accountsView : undefined}
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
