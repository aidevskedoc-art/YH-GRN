import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { exportSection } from '../services/exporter.js';
import { nextAgeSort, todayIso } from '../services/ageing.js';
import { singlePress } from '../services/press.js';
import {
  ACCOUNTS_CHEQUE_VIEW,
  ACCOUNTS_GRN_VIEW,
  ACCOUNTS_QUEUE_CARD,
  ACCOUNTS_RECEIVED_CARD,
  ACCOUNTS_ROW,
  ACCOUNTS_ROW_GROUPS,
  ACCOUNTS_TAB,
  CHEQUE_CARDS,
  CHEQUE_NOT_PREPARED_ROW,
  CHEQUE_NOT_PREPARED_TAB,
  CHEQUE_NOT_PREPARED_VIEW,
  CSD_CARDS,
  NOT_REQUIRED_PAIR,
  SUPPLY_TYPE_CARDS,
  TURNAROUND,
  TURNAROUND_TAB,
  VALID,
  bulkCategory as bulkCategoryOf,
  cardShown,
  isAccountsFromDay,
  isAccountsSection,
  supplyCardFigure,
  tabFigure,
  bulkCsdEligible,
  canHandToCsd,
  bulkForwardEligible,
  bulkReceiveEligible,
  csdCardFigures,
  progressCardFigures,
  actionFilterOptions,
  progressFilterOptions,
  sectionSheets,
  tabTitle,
  titledCards,
} from '../services/resultsViews.js';
import ResultsTable, { formatAmount, ForwardDetailsDialog } from '../components/ResultsTable.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import PairCard from '../components/PairCard.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import MsmeFilter from '../components/MsmeFilter.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import { IconArrowRight, IconX } from '../components/icons.jsx';
import BackButton, { useSectionTrail } from '../components/BackButton.jsx';
import ViewModeRadios from '../components/ViewModeRadios.jsx';
import { expandCheques, resultsChequeBills } from '../services/chequeGroups.js';

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
 * the export sheet names match the results screen exactly. The Cheque Not
 * Prepared section sits between them: its card on the Accounts row opens it.
 */
const TABS = [ACCOUNTS_TAB, CHEQUE_NOT_PREPARED_TAB, TURNAROUND_TAB];

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
  // Two titled groups: Accounts -- its own count, the cheque cards that
  // divide it, the Accounts Queue and Received -- then the four CSD stages.
  // Imported, because the results screen shows this same row and the two must
  // not drift into different orders. See ACCOUNTS_ROW_GROUPS.
  [VALID]: ACCOUNTS_ROW,
  // Its own count, then the Supply Type cards that divide it.
  [CHEQUE_NOT_PREPARED_VIEW]: CHEQUE_NOT_PREPARED_ROW,
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
 * set. One card navigates: Cheque Not Prepared opens its own section (`opens`),
 * whose Supply Type cards narrow it in turn.
 */
const CARD_BY_ID = Object.fromEntries([
  // The count at the head of each row. `kind: 'bucket'` as on the results
  // screen, where the same tag marks a card that reports a whole view rather
  // than a slice of one -- Accounts, and the Cheque Not Prepared section; the
  // ageing view shows no cards at all.
  [ACCOUNTS_TAB.status, { kind: 'bucket', ...ACCOUNTS_TAB }],
  [CHEQUE_NOT_PREPARED_TAB.status, { kind: 'bucket', ...CHEQUE_NOT_PREPARED_TAB }],
  ...CSD_CARDS.map((card) => [card.stage, { kind: 'csd', ...card }]),
  ...CHEQUE_CARDS.map((card) => [card.progress, { kind: 'progress', ...card }]),
  // Cheque Not Required and Payment Not Required on one card, a half each.
  [NOT_REQUIRED_PAIR.id, { kind: 'pair', ...NOT_REQUIRED_PAIR }],
  [ACCOUNTS_QUEUE_CARD.progress, { kind: 'progress', ...ACCOUNTS_QUEUE_CARD }],
  [ACCOUNTS_RECEIVED_CARD.progress, { kind: 'progress', ...ACCOUNTS_RECEIVED_CARD }],
  ...SUPPLY_TYPE_CARDS.map((card) => [card.id, { kind: 'supplyType', ...card }]),
]);

/**
 * "All uploads": every batch reconciled together, which is the only scope this
 * screen has, as on the results screen. It travels where a batch id used to --
 * the value handed to every API call below -- and the server drops its batch
 * filter when it sees it.
 */
const ALL = 'all';

export default function AccountsDepartment() {
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
  // the CSD and cheque cards as well as by the Status dropdown -- one filter
  // with two ways in.
  const [progress, setProgress] = useState('');
  // Where the rows have got to -- Sent to CSD, Accounts received, Sent to
  // Bank -- or '' for anywhere: the Action dropdown beside the search box. It
  // narrows on top of the card's `progress` rather than replacing it, so a
  // card and an action together are the rows answering both.
  const [action, setAction] = useState('');
  // How the Accounts table is read: a row per GRN, or a row per cheque with its
  // bills' PayableAmount summed. The cards follow it -- GRN counts first on GRN
  // view, cheque counts first on Cheque view.
  const [accountsView, setAccountsView] = useState(ACCOUNTS_GRN_VIEW);
  // The Cheque Not Prepared section, opened from its card on the Accounts row.
  // Always by GRN: its bills have no cheque, so a row per cheque would be empty.
  const inChequeNotPrepared = status === CHEQUE_NOT_PREPARED_VIEW;
  const byCheque = !inChequeNotPrepared && accountsView === ACCOUNTS_CHEQUE_VIEW;
  // Which Supply Type that section is narrowed to by its cards -- STENTS,
  // REGULAR, NONE -- or '' for all of it. Cleared on the way out.
  const [supplyType, setSupplyType] = useState('');
  // Which rows request is the latest -- see loadRows.
  const rowsRequest = useRef(0);
  // The day a bill with no cheque yet counts its Ageing to -- the "Ageing as
  // of" input, today until changed. The table and the export both read it;
  // see services/ageing.js.
  const [ageingAsOf, setAgeingAsOf] = useState(todayIso);
  // The table's sort by its Ageing column, `{ key, dir }` -- pressing the
  // header sets it (see nextAgeSort) -- or null for the usual order. Sent with
  // the "as of" date, so the server orders every page by the figures shown;
  // cleared on the way to another view. The ageing view has no such column.
  const [ageSort, setAgeSort] = useState(null);
  const activeAgeSort = ageSort?.key === 'ageing' && isAccountsSection(status) ? ageSort : null;
  const ageSortKey = activeAgeSort?.key ?? '';
  const ageSortDir = activeAgeSort?.dir ?? '';
  const ageSortAsOf = activeAgeSort ? ageingAsOf : '';
  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. It narrows the whole page together -- rows, cards, option
  // counts and the export -- because it is a scope rather than a question
  // about a row, and it survives moving between the two views.
  const [location, setLocation] = useState('');
  // 'MSME', 'NON_MSME', or '' for every vendor -- the MSME dropdown, a scope
  // like Location. See MsmeFilter.jsx.
  const [msme, setMsme] = useState('');
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
      .summary(batchId, { q, location, msme })
      .then(({ summary: s }) => setSummary(s))
      .catch((err) => setError(err.message));
  }, [batchId, q, location, msme]);

  const loadRows = useCallback(() => {
    // Every call supersedes the one before: an answer for a request that is no
    // longer the latest -- the view left before it landed, say, Accounts left
    // for its Cheque Not Prepared section -- is dropped rather than drawn under
    // the view that replaced it.
    const request = ++rowsRequest.current;
    const latest = () => request === rowsRequest.current;
    // The ageing view is not a reconciliation status -- /results would reject
    // it as an unknown filter. It fetches its own rows, in TurnaroundView.
    if (status === TURNAROUND) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .results(batchId, {
        // The Cheque Not Prepared section is no status of the server's: it is
        // the Accounts rows its card selects -- see CHEQUE_NOT_PREPARED_TAB.
        status: inChequeNotPrepared ? CHEQUE_NOT_PREPARED_TAB.rowStatus : status,
        page,
        pageSize,
        q,
        progress: inChequeNotPrepared ? CHEQUE_NOT_PREPARED_TAB.progress : progress,
        action,
        // The counts beside the Action dropdown's options -- see selectAction.
        actionCounts: true,
        location,
        msme,
        supplyType: inChequeNotPrepared ? supplyType : undefined,
        view: byCheque ? ACCOUNTS_CHEQUE_VIEW : undefined,
        sort: ageSortKey,
        sortDir: ageSortDir,
        asOf: ageSortAsOf,
      })
      .then((result) => {
        if (latest()) setData(result);
      })
      .catch((err) => {
        if (latest()) setError(err.message);
      })
      .finally(() => {
        if (latest()) setLoading(false);
      });
  }, [
    batchId,
    status,
    inChequeNotPrepared,
    page,
    pageSize,
    q,
    progress,
    action,
    location,
    msme,
    supplyType,
    byCheque,
    ageSortKey,
    ageSortDir,
    ageSortAsOf,
  ]);

  useEffect(loadRows, [loadRows]);

  // A ticked GRN belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs invalidates the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [
    batchId,
    status,
    page,
    pageSize,
    q,
    progress,
    action,
    location,
    msme,
    supplyType,
    accountsView,
    ageSortKey,
    ageSortDir,
    ageSortAsOf,
  ]);

  /*
   * The three things "Select multiple" can batch, mirroring the row's own
   * journey -- see the predicates in services/resultsViews.js, which the
   * results screen applies to the same rows. Only the CSD one asks anything of
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

  /** What the bulk buttons call the selection: GRNs, or cheques on Cheque view. */
  const selectedLabel = byCheque
    ? `${selected.size} cheque${selected.size === 1 ? '' : 's'}`
    : `${selected.size}`;

  /**
   * The rows a bulk action actually acts on. On GRN view that is the ticked
   * rows. On Cheque view each ticked row stands for a whole cheque, so it is
   * every bill that cheque pays and that is still eligible for the same action
   * -- fetched from the server, since a cheque's bills are spread across the
   * whole table (the same lookup as chequeGroup in ResultsTable.jsx).
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
      await Promise.all(targets.map((row) => api.sendToCsd({ ...row, batchId: null })));
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

  /** Show one of the views. */
  function selectStatus(next) {
    // The Cheque Not Prepared section is a narrowing of Accounts: entering or
    // leaving it would otherwise draw the other one's rows under this one's
    // cards until the reload lands.
    if (next !== status && (next === CHEQUE_NOT_PREPARED_VIEW || status === CHEQUE_NOT_PREPARED_VIEW)) {
      setData(null);
    }
    setStatus(next);
    setPage(1);
    // The card and Action filters belong to the Accounts rows. The ageing view
    // has no such columns and does not apply them, so carrying them across
    // would leave the dropdown naming a stage over a table showing every row
    // regardless. Cleared on any change of view as well, so an Action picked
    // inside the Cheque Not Prepared section does not follow Back to Accounts.
    if (next !== VALID || next !== status) {
      setProgress('');
      setAction('');
    }
    // The Supply Type cards belong to the Cheque Not Prepared section.
    if (next !== CHEQUE_NOT_PREPARED_VIEW) setSupplyType('');
    // A view opens in its usual order, as it opens unnarrowed.
    if (next !== status) setAgeSort(null);
  }

  /**
   * The Ageing header, pressed: oldest first, then newest first, then the
   * usual order -- see nextAgeSort. Page 1, since the first page of a new
   * order is the one that answers it.
   */
  function selectAgeSort(key) {
    setAgeSort((current) => nextAgeSort(current, key));
    setPage(1);
  }

  /**
   * The "Ageing as of" picker's value, or '' for today. A value the server
   * could not sort to -- a mistyped five-digit year -- is not kept (see
   * isAccountsFromDay): a sorted Ageing column sends this date. And while it
   * is sorted, moving the date reorders the rows, so the first page of the
   * new order shows, as it does when the sort itself changes.
   */
  function selectAgeingAsOf(next) {
    if (next && !isAccountsFromDay(next)) return;
    setAgeingAsOf(next || todayIso());
    if (activeAgeSort) setPage(1);
  }

  /** Narrow the Cheque Not Prepared section to one Supply Type, or '' for all of it. */
  function selectSupplyType(next) {
    setSupplyType(next);
    setPage(1);
  }

  /** Switch the Accounts table between a row per GRN and a row per cheque. */
  function selectAccountsView(next) {
    if (next === accountsView) return;
    setAccountsView(next);
    setPage(1);
    // The rows on hand are the other view's shape; drawing them under this
    // view's columns until the reload lands would show a broken table.
    setData(null);
  }

  /** Narrow every figure on the page to one branch, or '' for all of them. */
  /** Narrow every figure on the page to MSME or Non-MSME vendors, or '' for all. */
  function selectMsme(next) {
    setMsme(next);
    setPage(1);
  }

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
    // Cheque not prepared has a section of its own, which its card opens -- so
    // choosing it here opens that too, rather than narrowing Accounts in place
    // with no card on the row to show for it.
    if (next === CHEQUE_NOT_PREPARED_TAB.progress) {
      selectStatus(CHEQUE_NOT_PREPARED_VIEW);
      return;
    }
    setProgress(next);
    setPage(1);
    if (next && status !== VALID) {
      setStatus(VALID);
      // Not through selectStatus, so its clearing is repeated here for the one
      // narrowing that belongs to another Accounts view.
      setSupplyType('');
    }
  }

  /**
   * Narrow the rows to where they have got to, inside whichever card is
   * selected -- or '' for anywhere. The card stays as it is: the two answer
   * different questions, and together they are the rows answering both.
   * Picking one from the ageing view moves to Accounts, as a card does.
   */
  function selectAction(next) {
    setAction(next);
    setPage(1);
    // The Cheque Not Prepared section is Accounts rows too, so it stays.
    if (next && !isAccountsSection(status)) setStatus(VALID);
  }

  // The views this page has shown, for the Back button -- the view only. A
  // card or dropdown narrowing it is not a step Back walks through; returning
  // opens the view the way the View dropdown does, unnarrowed. Accounts is
  // where the page opens, so Back is not offered there.
  const sectionTrail = useSectionTrail(status, selectStatus, VALID);
  const describeSection = (s) => TABS.find((tab) => tab.status === s)?.label ?? s;

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

  const progressFilters = progressFilterOptions(summary, progress);

  // The Action dropdown's options, with the counts the rows came back with --
  // how many each leaves inside the card as it stands. The ageing view's rows
  // are not these, so it offers them without counts.
  const actionFilters = actionFilterOptions(isAccountsSection(status) ? data?.actionCounts : null);

  // The cards this view shows, in the order CARDS_FOR names them -- the "Not
  // in Vendor Master" card only while there are such GRNs (SUPPLY_TYPE_CARDS).
  const cards = (CARDS_FOR[status] ?? [])
    .map((id) => CARD_BY_ID[id])
    .filter(Boolean)
    .filter((card) => cardShown(card, summary, supplyType));
  // The row as drawn: on Accounts each group's title ahead of its cards --
  // Accounts, then CSD. The Cheque Not Prepared row as it is. Drawing only:
  // the export reads `cards`. See titledCards.
  const cardRow = titledCards(cards, status === VALID ? ACCOUNTS_ROW_GROUPS : null);

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
      // The Accounts sheets follow the GRNs / Cheques switch -- see
      // exportSection. The Cheque Not Prepared section's are always by GRN.
      await exportSection(batchId, exportSheets, {
        q,
        location,
        msme,
        spans,
        accountsView: status === VALID ? accountsView : inChequeNotPrepared ? ACCOUNTS_GRN_VIEW : undefined,
        ageingAsOf,
      });
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
                const bucket = tabFigure(tab, summary);
                return (
                  <option key={tab.status} value={tab.status}>
                    {tab.label}
                    {bucket ? ` (${bucket.count.toLocaleString('en-IN')})` : ''}
                  </option>
                );
              })}
            </select>
          </label>

          {/* GRN view or Cheque view of the Accounts table -- see accountsView.
              Not on the ageing view, which has its own columns. */}
          {status === VALID && <ViewModeRadios value={accountsView} onChange={selectAccountsView} />}

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

      {/* Back to the Accounts view -- see BackButton. Not on Accounts itself.
          Outside the cards' own condition: the ageing view has no cards, and
          it is the one view here Back is offered on. */}
      <BackButton trail={sectionTrail} describe={describeSection} />

      {summary && cards.length > 0 && (
        /* The same outlined chips as the results screen. See .cards--tabs. */
        <div className="cards cards--tabs">
          {cardRow.map((card) => {
            if (card.kind === 'groupTitle') {
              /* A group's title, on a line of its own ahead of its cards --
                 Accounts, then CSD. See titledCards. */
              return (
                <h3 key={`title:${card.title}`} className="card-group__title">
                  {card.title}
                </h3>
              );
            }
            if (card.kind === 'bucket') {
              /* The count at the head of the row, and the "All" of it: every
                 GRN in accounts on Accounts, every GRN with no cheque prepared
                 on the Cheque Not Prepared section.

                 Every other card on the row narrows it -- `progress` on
                 Accounts, `supplyType` on Cheque Not Prepared -- and the Action
                 dropdown narrows on top, so pressing this one clears both and
                 the table goes back to every row of the view. The ring follows
                 that rather than saying which view is showing. The cards beside
                 it stay on when pressed again, so this is the one way back to
                 every row -- a head card that ignored a press would leave no way
                 back at all; same reasoning as the results screen's rowHead. */
              const head = inChequeNotPrepared
                ? {
                    on: Boolean(supplyType || action),
                    noun: 'GRN with no cheque prepared',
                    clear: () => {
                      selectSupplyType('');
                      setAction('');
                    },
                  }
                : {
                    on: Boolean(progress || action),
                    noun: 'GRN in accounts',
                    clear: () => {
                      selectProgress('');
                      setAction('');
                    },
                  };
              const figure = tabFigure(card, summary) ?? { count: 0, amount: 0 };
              return (
                <button
                  key={card.status}
                  type="button"
                  className={`card stat stat--${card.tone ?? card.status.toLowerCase()} ${head.on ? '' : 'is-active'}`}
                  onClick={head.clear}
                  aria-pressed={!head.on}
                  title={tabTitle(
                    card.hint,
                    head.on
                      ? `Show every ${head.noun} again`
                      : `Showing every ${head.noun} — press a card beside this to narrow it`,
                  )}
                >
                  <div className="stat__label">{card.label}</div>
                  <div className="stat__value">{(figure.count ?? 0).toLocaleString('en-IN')}</div>
                  <div className="stat__amount">₹ {formatAmount(figure.amount ?? 0)}</div>
                  <div className="stat__hint">{card.hint}</div>
                </button>
              );
            }
            return card.kind === 'progress' && card.opens ? (
              /* Cheque Not Prepared: opens its own section, split by the
                 vendor's Supply Type, rather than narrowing this table -- the
                 same kind of card as the results screen's (see .stat--go), so no
                 aria-pressed. Its count and its sheet in the Accounts workbook
                 are still the progress key's. */
              <button
                key={card.progress}
                type="button"
                className={`card stat stat--${card.tone ?? 'dept'} stat--go`}
                onClick={singlePress(() => selectStatus(card.opens))}
                title={tabTitle(
                  progressCardFigures(card, summary, byCheque).hint,
                  `Open the ${card.label} section — split by Stents and Regular`,
                )}
              >
                <IconArrowRight size={15} className="stat__go" />
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {progressCardFigures(card, summary, byCheque).value.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary.progress?.[card.progress]?.amount ?? 0)}
                </div>
                <div className="stat__hint">{progressCardFigures(card, summary, byCheque).hint}</div>
              </button>
            ) : card.kind === 'supplyType' ? (
              /* One Supply Type's share of the Cheque Not Prepared section --
                 the vendor's, off the Vendor Master. Pressing it narrows the
                 table to it; the section's own card at the head of the row goes
                 back to all of them. */
              <button
                key={card.id}
                type="button"
                className={`card stat ${card.supplyType === 'NONE' ? 'stat--missing' : 'stat--dept'} ${
                  supplyType === card.supplyType ? 'is-active' : ''
                }`}
                onClick={singlePress(() => selectSupplyType(card.supplyType))}
                aria-pressed={supplyType === card.supplyType}
                title={tabTitle(
                  card.hint,
                  supplyType === card.supplyType
                    ? `Showing ${card.label} only — press ${CHEQUE_NOT_PREPARED_TAB.label} for every row`
                    : `Show only the ${card.label} GRNs with no cheque prepared`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {supplyCardFigure(card, summary).count.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(supplyCardFigure(card, summary).amount ?? 0)}</div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ) : card.kind === 'pair' ? (
              /* Cheque Not Required and Payment Not Required, a half each --
                 each half narrows the table to its own key. See PairCard. */
              <PairCard
                key={card.id}
                card={card}
                summary={summary}
                byCheque={byCheque}
                progress={progress}
                onSelect={selectProgress}
                headLabel={ACCOUNTS_TAB.label}
              />
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
                className={`card stat stat--${card.tone ?? 'dept'} ${
                  progress === card.progress ? 'is-active' : ''
                }`}
                onClick={singlePress(() => selectProgress(card.progress))}
                aria-pressed={progress === card.progress}
                title={tabTitle(
                  progressCardFigures(card, summary, byCheque).hint,
                  progress === card.progress
                    ? `Showing ${card.label} only — press ${ACCOUNTS_TAB.label} for every row`
                    : `Show only the ${card.label} rows`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                {/* GRN view leads with the GRN count, Cheque view with the
                    cheque count -- see progressCardFigures. */}
                <div className="stat__value">
                  {progressCardFigures(card, summary, byCheque).value.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary.progress?.[card.progress]?.amount ?? 0)}
                </div>
                <div className="stat__hint">{progressCardFigures(card, summary, byCheque).hint}</div>
              </button>
            ) : (
              /* One CSD stage's share of the rows below. Pressing it narrows
                 the table to that stage, and pressing it again keeps it there:
                 the Accounts card heading the row is the way back to every
                 row. A press that undid itself also undid itself on a
                 double-click, which read as the card throwing you back to the
                 head of the row.

                 It sets `progress` (see PROGRESS in routes/results.js), which
                 the Status dropdown shows under this card's name while it is
                 set -- see progressFilterOptions. The same stages are also
                 Action dropdown options, which narrow on top of whatever card
                 is chosen rather than lighting one -- see selectAction.

                 singlePress on this and the cheque cards: see services/press.js. */
              <button
                key={card.stage}
                type="button"
                className={`card stat stat--${card.tone} ${progress === card.stage ? 'is-active' : ''}`}
                onClick={singlePress(() => selectProgress(card.stage))}
                aria-pressed={progress === card.stage}
                title={tabTitle(
                  csdCardFigures(card, summary, byCheque).hint,
                  progress === card.stage
                    ? `Showing ${card.label} only — press ${ACCOUNTS_TAB.label} for every row`
                    : `Show only the ${card.label} rows`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                {/* Cheque view: the cheque count big and the GRNs below it --
                    see CSD_CARDS. GRN view: the other way round. */}
                <div className="stat__value">
                  {csdCardFigures(card, summary, byCheque).value.toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.csd?.[card.stage]?.amount ?? 0)}</div>
                <div className="stat__hint">{csdCardFigures(card, summary, byCheque).hint}</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
          {/* MSME or Non-MSME vendors -- first, ahead of the Status dropdown,
              since it narrows the whole page (cards, rows and export). */}
          <MsmeFilter value={msme} onChange={selectMsme} />
          {/* Whether a cheque has been drawn up -- where the rows have got to
              is the Action dropdown's, beside it. Choosing a value on the
              ageing view takes the table to Accounts, which is the only view
              whose rows it can be about. It sets the cards' own `progress`, so
              a card and this move together -- see progressFilterOptions for
              how a CSD or Accounts card shows here -- and its counts are the
              cards' figures: GRNs, over the search and branch, before any
              Action is chosen.

              On the Cheque Not Prepared section the Supply Type cards stand in
              its place, as a dropdown: that section IS one status, and choosing
              another would leave it. */}
          {inChequeNotPrepared ? (
            <select
              className="field__input stage-filter"
              value={supplyType}
              onChange={(e) => selectSupplyType(e.target.value)}
              aria-label="Filter the table by the vendor's Supply Type"
            >
              <option value="">All supply types</option>
              {SUPPLY_TYPE_CARDS.filter((card) => cardShown({ kind: 'supplyType', ...card }, summary, supplyType)).map((card) => (
                <option key={card.id} value={card.supplyType}>
                  {card.label} ({supplyCardFigure(card, summary).count.toLocaleString('en-IN')})
                </option>
              ))}
            </select>
          ) : (
            <select
              className="field__input stage-filter"
              value={progress}
              onChange={(e) => selectProgress(e.target.value)}
              aria-label="Filter the table by whether a cheque has been prepared"
            >
              <option value="">All statuses</option>
              {progressFilters.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                  {summary?.progress?.[f.value]
                    ? ` (${summary.progress[f.value].count.toLocaleString('en-IN')})`
                    : ''}
                </option>
              ))}
            </select>
          )}

          {/* The Action filter, a dropdown of its own: where the rows have got
              to, inside whichever card or status is selected -- see
              selectAction. Choosing a value on the ageing view takes the table
              to Accounts, the only view with an Action column for it to be
              about. The counts come back with the rows, taken inside the card
              and search as they stand, so the number beside an option is the
              number of rows picking it shows. */}
          <select
            className="field__input stage-filter"
            value={action}
            onChange={(e) => selectAction(e.target.value)}
            aria-label="Filter the table by where the rows have got to, inside the card selected"
            title="Filter by action, inside the card selected"
          >
            <option value="">All actions</option>
            {actionFilters.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
                {f.count !== null ? ` (${f.count.toLocaleString('en-IN')})` : ''}
              </option>
            ))}
          </select>

          {/* The day a bill with no cheque yet counts its Ageing to -- today
              until changed, and back to today if cleared. Not on the ageing
              view, which has no Ageing column. */}
          {status !== TURNAROUND && (
            <label
              className="ageing-asof"
              title="Ageing counts to this date for a bill with no cheque date yet"
            >
              Ageing as of
              <input
                className="field__input stage-filter"
                type="date"
                max="9999-12-31"
                value={ageingAsOf}
                onChange={(e) => selectAgeingAsOf(e.target.value)}
                aria-label="Count the Ageing of bills with no cheque yet to this date"
              />
            </label>
          )}

          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, vendor code, GRN, bill or cheque no."
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
          {/* Nor on Cheque Not Prepared: every bulk action needs a cheque drawn
              up or a CSD handover, and those rows have neither. */}
          {status !== TURNAROUND && !inChequeNotPrepared && (
            <>
              {multiMode && allSelectedCsd && (
                <button type="button" className="primary" onClick={sendSelectedToCsd} disabled={bulkSending}>
                  {bulkSending ? 'Sending…' : `Send ${selectedLabel} to CSD`}
                </button>
              )}
              {multiMode && allSelectedReceive && (
                <button type="button" className="primary" onClick={receiveSelected} disabled={bulkSending}>
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

      {status === TURNAROUND ? (
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
            {/* The Cheque Not Prepared section is Accounts rows, laid out as the
                GRN view -- the cheque columns would be empty on every one. */}
            <ResultsTable
              rows={data.rows}
              status={inChequeNotPrepared ? VALID : status}
              batchId={batchId}
              onSent={loadRows}
              multiMode={multiMode}
              selected={selected}
              onToggleRow={toggleSelectRow}
              accountsView={inChequeNotPrepared ? ACCOUNTS_GRN_VIEW : accountsView}
              ageingAsOf={ageingAsOf}
              ageSort={activeAgeSort}
              onAgeSort={selectAgeSort}
            />
            <div className="pager">
              <span className="pager__info">
                {data.total === 0
                  ? action
                    ? // A card and an action that share no rows -- say which
                      // filter emptied the table, and how to undo it.
                      `No rows at ${actionFilters.find((f) => f.value === action)?.label ?? action} here — choose All actions to see the rest`
                    : q
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
