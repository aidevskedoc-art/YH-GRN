import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { exportResults } from '../services/exporter.js';
import { chequePrepared } from '../services/cheque.js';
import ResultsTable, { formatAmount, ForwardDetailsDialog } from '../components/ResultsTable.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import BpadView from '../components/BpadView.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
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
 * Turnaround is the one entry with `card: false`: it is not a bucket at all.
 * Every other entry names a population with a count and a value, which is what
 * a stat card shows; Turnaround measures elapsed time over one of those
 * populations, so it belongs in the view dropdown but not in the row of cards.
 */
const TURNAROUND = 'TURNAROUND';
/**
 * The BPAD register's own view. It has a card, being a population with a count
 * and a value, but reads a different table from the three reconciliation views
 * -- so it fetches its own rows (see BpadView) rather than going through
 * /results, and the toolbar's filters below have nothing to ask it.
 */
const BPAD = 'BPAD';
const VALID = 'VALID';
/**
 * Every GRN in scope, pending and valid together -- the upload as it arrived,
 * before the reconciliation splits it in two. The server knows the name and
 * treats it as no filter at all.
 */
const ALL_GRNS = 'ALL';

/**
 * The BPAD tab narrowed to the GRNs the register had no entry for -- what the
 * Not in BPAD card asks for. The server knows the word (see
 * bpadRegisterFilter in routes/results.js); '' is every row.
 */
const MISSING = 'missing';

/**
 * The bucket the Pending breakdown puts the GRNs it cannot place in -- the
 * register has no entry for them at all, or it has one with Pending With
 * Dept. left blank. Both mean the same to whoever is reading the card, so
 * they are one bucket.
 *
 * Spelled exactly as the server spells it (NOT_IN_BPAD in routes/results.js),
 * because the card hands it straight back as the filter value.
 */
const NOT_IN_BPAD = '__not_in_bpad__';

/** What that bucket is called on screen; every other desk is its own name. */
function deptLabel(dept) {
  return dept === NOT_IN_BPAD ? 'Not in BPAD' : dept;
}

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
  { status: 'PENDING', label: 'Pending GRNS', hint: 'Not yet in accounts' },
  { status: VALID, label: 'Accounts', hint: 'Found in the ageing report' },
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
  { status: BPAD, label: 'BPAD', hint: 'Entries in the register', countKey: 'bpadRegister' },
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
  RETURNED_BY_CSD: 'Handover by CSD',
  ACCOUNTS_RECEIVED: 'Accounts received',
  // Where Accounts forwards a received GRN on to -- see forwardedLabel in
  // ResultsTable.jsx for the same four labels.
  BANK: 'Sent to Bank',
  VENDOR: 'Sent to Vendor',
  PURCHASE_DEPT: 'Sent to Purchase Dept',
  OTHERS: 'Sent to Others',
  RECORDS: 'Sent to Records',
  // Ahead of Cheque cleared, which is the next thing that happens to a cheque
  // once it exists. Read off the ageing report's own cheque columns rather
  // than recorded here -- see CHEQUE_PREPARED in routes/results.js.
  CHEQUE_PREPARED: 'Cheque prepared',
  CHEQUE_NOT_PREPARED: 'Cheque not prepared',
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
 * Whether a cheque has been drawn up, as two cards at the end of the Accounts
 * row.
 *
 * Behind the CSD four because that is the order it happens in: a bill goes
 * through the handover, then a cheque gets cut for it. The two halves are
 * exhaustive over that row -- every Accounts GRN is in exactly one -- so they
 * sum to the Accounts card, which the CSD four do not.
 *
 * They read a `progress` key rather than a CSD stage, so `kind: 'progress'`
 * where the CSD cards are `kind: 'csd'`. Both set the same filter, which is
 * what keeps every card on this row mutually exclusive.
 *
 * Neutral, where the CSD four run warn / info / ok / danger. There is no fifth
 * and sixth colour left in that ladder, and borrowing two of it would put the
 * same amber on "awaiting CSD" and "no cheque yet" -- two unrelated answers
 * side by side. Plain cards read as the different question they are, the same
 * way the desk cards do on the pending row.
 */
const CHEQUE_CARDS = [
  {
    progress: 'CHEQUE_PREPARED',
    label: 'Cheque Prepared',
    /*
     * Cheques big, GRNs small -- the one card on this row whose headline is
     * not the number of rows below it.
     *
     * One cheque pays a group of GRNs, so the two figures are a long way
     * apart: 349 cheques cover 1,370 bills, and the biggest single cheque
     * covers twenty-five of them. How many cheques were actually written is
     * the answer being looked for here; how many bills they settle is the
     * supporting detail, and it reads on the line below.
     *
     * Both stay on the card, which matters because pressing it still filters
     * the table to the GRNs -- 1,370 rows, the smaller of the two numbers
     * printed on it. Worth knowing: every other card on this row leads with
     * the count pressing it returns.
     *
     * Functions rather than strings, since both need the summary. The card
     * beside this one stays plain: there is no second figure to give for the
     * GRNs nobody has written a cheque for.
     */
    value: (summary) => summary?.chequesPrepared ?? 0,
    hint: (summary) => {
      const grns = summary?.progress?.CHEQUE_PREPARED?.count ?? 0;
      return `For ${grns.toLocaleString('en-IN')} GRN${grns === 1 ? '' : 's'}`;
    },
  },
  {
    progress: 'CHEQUE_NOT_PREPARED',
    label: 'Cheque Not Prepared',
    hint: 'None of the three yet',
  },
];

/**
 * The bucket the turnaround report measures. Every GRN with an ageing row has
 * the stage dates, and that is exactly the Valid GRNs bucket -- so on the
 * Turnaround tab that card is marked active, answering "what is this counting?"
 * rather than going dead because no bucket is selected.
 */
const TURNAROUND_SCOPE = VALID;

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
 * Both views that show all four read this, so they cannot drift apart. The
 * cost of spelling it out is that a fifth card would have to be added here as
 * well as to TABS; that is the right way round, now that the order is a
 * decision rather than a consequence of how the views happen to be listed.
 */
const BUCKET_CARDS = [ALL_GRNS, BPAD, VALID, 'PENDING'];

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
 * So neither shows the four any more. Pending keeps its own count, which its
 * desks divide and sum back to; Accounts keeps none, its row being entirely
 * about where its GRNs have got to. Every dropped figure is a dropdown away
 * and unchanged there -- the view selector carries every count beside its
 * option -- so nothing became unreachable, and each row now describes one
 * population from end to end.
 *
 * Total GRNS and Turnaround keep all four, having nothing of their own to add:
 * Total GRNS is the whole population and the other counts are how it splits,
 * and Turnaround measures one of those populations rather than dividing one.
 *
 * The two rows are not the same shape behind the count, and deliberately not.
 * Pending's five desks ARE its breakdown: they divide the figure beside them
 * and sum back to it exactly, NOT_IN_BPAD included. The CSD four are not.
 * They go with Accounts because that is where a sent GRN comes from -- only a
 * matched row can be sent, and a pending one has a dash where the Send picker
 * would be -- but the summary counts them by the existence of a dispatch, with
 * no reconciliation-status clause at all, and drops the MOVED_TO_ACCOUNTS
 * stage entirely (see the csd query in routes/results.js). They neither sum to
 * Accounts nor sit inside it, which is the other reason that count is not at
 * the head of them: a figure standing over cards that do not add up to it
 * invites the arithmetic anyway. The cheque pair after them does add up --
 * every Accounts GRN is in exactly one of the two halves -- which is why those
 * close the row rather than opening it.
 *
 * BPAD keeps none of the four. It is the one view not about the
 * reconciliation at all -- it reads the register's own table, and how many
 * GRNs are pending or through accounts says nothing about where a bill is
 * sitting. Its row is built entirely at render time, out of the register's own
 * two questions: which desk, and whether the register knew the GRN at all.
 *
 * One thing the old arrangement bought that this does not: with the same four
 * cards in the same order everywhere, a press could never move a different
 * card under the pointer. Rows differ per view now, so a second press after a
 * view change lands on whatever the new row put in that position -- on
 * Accounts, a CSD card, which leaves the screen. Worth knowing before adding
 * anything else that navigates.
 */
const CARDS_FOR = {
  [ALL_GRNS]: BUCKET_CARDS,
  // Its own count only -- the desk breakdown appended at render time is the
  // rest of this row. See the note above.
  PENDING: ['PENDING'],
  // The CSD stages, then the two cheque cards -- in the order the work goes.
  // No Accounts count at the head of them: the figure is on the View dropdown
  // beside this view's own option, and the row is about where its GRNs have
  // got to rather than how many there are.
  [VALID]: [
    ...CSD_CARDS.map((card) => card.stage),
    ...CHEQUE_CARDS.map((card) => card.progress),
  ],
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
  // Which half of Total GRNS is showing, or '' for both. Meaningless on the
  // other tabs, and cleared on the way out of this one.
  const [matchFilter, setMatchFilter] = useState('');
  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. Unlike the two filters above it is not about a tab: it
  // narrows the whole page -- rows, cards, option counts and the export -- and
  // it survives moving between tabs, because "the Secunderabad numbers" is a
  // question every tab answers.
  const [location, setLocation] = useState('');
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
    // Neither Turnaround nor BPAD is a reconciliation status -- /results would
    // reject either as an unknown filter. Both tabs fetch their own data, in
    // TurnaroundView and BpadView.
    if (status === TURNAROUND || status === BPAD) return;
    setLoading(true);
    api
      .results(batchId, { status: rowStatus, page, pageSize, q, progress, location, dept: pendingDept })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, status, rowStatus, page, pageSize, q, progress, location, pendingDept]);

  useEffect(loadRows, [loadRows]);

  // A ticked GRN belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs invalidates the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [batchId, rowStatus, page, pageSize, q, progress, location, pendingDept]);

  /**
   * The three things "Select multiple" can now batch, mirroring the row's own
   * journey: sending several to CSD, acknowledging several CSD has handed
   * back to Accounts, and forwarding several Accounts has already received on
   * to Bank, Vendor or Courier. A row only ever qualifies for one of the
   * three at a time -- they are consecutive steps -- so a selection is only
   * ever actioned once every ticked row agrees on which one applies; see
   * `allSelectedCsd`/`allSelectedReceive`/`allSelectedForward` below.
   *
   * Kept in step by hand with ResultsTable's own copies of these three
   * checks, which decide only whether a row's checkbox is there to tick at
   * all -- these decide what ticking it, and the rows it drags in by cheque
   * number, are allowed to do.
   */
  const canBulkCsd = (row) =>
    can('csd') &&
    row.status !== 'PENDING' &&
    // Nothing to hand over until a cheque has been drawn up -- the same bar
    // the Send picker puts on the single-row action, and ResultsTable's own
    // copy of this check on whether the box is there to tick.
    chequePrepared(row) === true &&
    row.csdStage !== 'MOVED_TO_ACCOUNTS' &&
    !row.csdSent &&
    !row.recordsSent;
  const canBulkReceive = (row) =>
    row.csdStage === 'MOVED_TO_ACCOUNTS' && (row.csdAccountsStage || 'QUEUED') === 'QUEUED';
  const canBulkForward = (row) =>
    row.csdStage === 'MOVED_TO_ACCOUNTS' && row.csdAccountsStage === 'RECEIVED' && !row.csdForwardedTo;

  /** Which of the three above a row currently qualifies for, or null for none. */
  function bulkCategory(row) {
    if (canBulkCsd(row)) return 'CSD';
    if (canBulkReceive(row)) return 'RECEIVE';
    if (canBulkForward(row)) return 'FORWARD';
    return null;
  }

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
      await Promise.all(
        selectedRows.map((row) =>
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

  function selectStatus(next) {
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

  // The cards this view shows, in the order CARDS_FOR names them.
  //
  // Keyed on `rowStatus` rather than `status`, so narrowing Total GRNS to one
  // of its halves brings that half's cards with it: those are the same rows
  // the Accounts view would put on screen, from the same call, so the figures
  // standing over them should be the same too.
  const cards = [
    ...(CARDS_FOR[rowStatus] ?? []).map((id) => CARD_BY_ID[id]).filter(Boolean),
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
    ...(status === BPAD && summary?.bpad?.count > 0
      ? [{ kind: 'missing' }, ...departments.map((d) => ({ kind: 'dept', ...d }))]
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
    ...(rowStatus === 'PENDING' && summary?.PENDING?.count > 0
      ? (summary.pendingDepartments ?? []).map((d) => ({ kind: 'pendingDept', ...d }))
      : []),
  ];
  // Which bucket the view is about, for the one card that gets the ring. On
  // Turnaround that is the population being measured rather than the view's
  // own name -- see TURNAROUND_SCOPE.
  const activeBucket = status === TURNAROUND ? TURNAROUND_SCOPE : rowStatus;

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
    // Accounts had a branch here while its own count led that row. The count
    // is gone from it, so no bucket card renders there to head it, and every
    // card on that row is a filter that toggles itself off. Pending is the one
    // row left with a head.
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

          <LocationFilter value={location} onChange={selectLocation} />

          {/* One workbook, every tab -- see the note on exportResults for why
              the progress dropdown and the Total GRNS match filter do not
              narrow it. It acts on the whole scope rather than on the rows one
              tab's filters narrow, so it sits up here rather than down with
              the table. */}
          <button className="ghost" type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {summary && cards.length > 0 && (
        <div className="cards">
          {cards.map((card) =>
            card.kind === 'missing' ? (
              /* The GRNs the register had no entry for -- in practice goods
                 received on a delivery challan with no vendor invoice raised
                 yet, and BPAD is a register of bills. The tab's own banner
                 explains that; this counts it and can show it. */
              <button
                key="missing"
                type="button"
                className={`card stat stat--missing ${register === MISSING ? 'is-active' : ''}`}
                onClick={() => selectRegister(register === MISSING ? '' : MISSING)}
                aria-pressed={register === MISSING}
                title={
                  register === MISSING
                    ? 'Showing only the GRNs with no register entry — press again for every row'
                    : 'Show only the GRNs the BPAD register has no entry for'
                }
              >
                <div className="stat__label">Not in BPAD</div>
                <div className="stat__value">
                  {(summary.bpadMissing?.count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.bpadMissing?.amount ?? 0)}</div>
                <div className="stat__hint">No entry in the register</div>
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
                    ? `Showing ${card.dept} only — press again for every department`
                    : `Show only the bills pending with ${card.dept}`
                }
              >
                <div className="stat__label">{card.dept}</div>
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
                      : `Show only the pending GRNs sitting with ${card.dept}`
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
                className={`card stat stat--dept ${
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
                <div className="stat__value">
                  {(summary.csd?.[card.stage]?.count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">₹ {formatAmount(summary.csd?.[card.stage]?.amount ?? 0)}</div>
                <div className="stat__hint">{card.hint}</div>
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
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">
                  {(summary[card.countKey ?? card.status]?.count ?? 0).toLocaleString('en-IN')}
                </div>
                <div className="stat__amount">
                  ₹ {formatAmount(summary[card.countKey ?? card.status]?.amount ?? 0)}
                </div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ),
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
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
                  {d.dept} ({d.count.toLocaleString('en-IN')})
                </option>
              ))}
              {/* A department chosen before the upload changed under it would
                  otherwise vanish from the list while still narrowing the
                  table, which reads as the table having gone wrong. Keep it
                  selectable until it is changed. */}
              {dept && !departments.some((d) => d.dept === dept) && (
                <option value={dept}>{dept}</option>
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
                  {bulkSending ? 'Sending…' : `Send ${selected.size} to CSD`}
                </button>
              )}
              {multiMode && allSelectedReceive && (
                <button
                  type="button"
                  className="primary"
                  onClick={receiveSelected}
                  disabled={bulkSending}
                >
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

      {status === BPAD ? (
        <BpadView
          batchId={batchId}
          q={q}
          location={location}
          dept={dept}
          register={register}
          onDepartments={setDepartments}
        />
      ) : status === TURNAROUND ? (
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
