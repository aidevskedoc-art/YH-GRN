/**
 * The CSD queue.
 *
 * What Send to CSD on the Valid GRNs tab hands over lands here: one row per
 * GRN, with the details as they stood when it was sent, who sent it and when,
 * and how far CSD have got with it.
 *
 * It is deliberately not scoped to an upload. A handover is a thing that
 * happened, and it has to keep reading correctly after the upload it was taken
 * from has been deleted or replaced by next month's -- so there is no batch
 * selector here, and the upload column shows "upload deleted" rather than
 * dropping the row.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { exportCsd } from '../services/exporter.js';
import { singlePress } from '../services/press.js';
import LocationFilter from '../components/LocationFilter.jsx';
import MsmeFilter from '../components/MsmeFilter.jsx';
import {
  formatAmount,
  formatAmountOrDash,
  formatDate,
  Remark,
  PriorRejection,
} from '../components/ResultsTable.jsx';
import { IconTrash, IconX } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import Sheet from '../components/Sheet.jsx';
import ViewModeRadios from '../components/ViewModeRadios.jsx';
import VendorCells, { VENDOR_CELL_COUNT } from '../components/VendorCells.jsx';
import { ACCOUNTS_CHEQUE_VIEW, ACCOUNTS_GRN_VIEW, leadFigures } from '../services/resultsViews.js';
import { csdChequeHandovers, expandCheques } from '../services/chequeGroups.js';


/** Matches the results page's search box -- see the note there. */
const SEARCH_DELAY_MS = 300;

/**
 * The five stages, in the order a handover travels through them.
 *
 * Queued is where Send to CSD puts a row; the other four are CSD's own
 * answers -- Received leads to a verdict, Approved or Rejected, and an
 * approved bill has one further step of its own: handed back to Accounts. The
 * colours follow the app's semantic ladder rather than being picked per card:
 * queued is work outstanding (the warning amber the Pending bucket uses),
 * received is in-progress blue, Approved and Rejected are the green and red
 * used everywhere else, and Moved to accounts gets the brand orange -- it is a
 * resolution too, just not a verdict on the bill.
 *
 * Every stage a row can be in belongs in this list, whether or not it gets a
 * card -- it is what names a stage in the Status pill and what fills the
 * dropdown, and a row whose stage is missing from here would show the wrong
 * label and offer no way back to it.
 *
 * `card: false` keeps Moved to accounts off this screen's KPI row: what needs
 * counting once a GRN is handed back is Accounts' own Queued/Received split,
 * which the Accounts tab's own card reads (see accountsReturnsRouter in
 * routes/results.js) -- a second count of the same rows here would just be
 * noise. The stage still appears in the Status pill and the filter dropdown
 * below, so a handed-back GRN is not hidden from the CSD screen, only left out
 * of the row of cards.
 */
/*
 * `note` rather than `hint`, because the card's small line is built at render
 * time out of the stage's GRN count and this wording together -- the headline
 * figure is the number of CHEQUES at that stage, not the number of rows. A
 * cheque is what was physically handed to CSD and what they acknowledge and
 * rule on, so it is the thing worth counting; the bills it covers read
 * underneath. Same arrangement as the Accounts view's own CSD cards, see
 * CSD_CARDS in Results.jsx.
 *
 * The cheque figures do not add up to anything: a cheque whose bills sit at
 * two stages at once is counted at both. The GRN counts on the line below do
 * partition the queue, and are what pressing a card filters the table to.
 */
const STAGES = [
  { key: 'QUEUED', label: 'Queued', note: 'not yet acknowledged', tone: 'queued' },
  { key: 'RECEIVED', label: 'Received', note: 'CSD have them', tone: 'received' },
  { key: 'APPROVED', label: 'Approved', note: 'cleared by CSD', tone: 'approved' },
  { key: 'REJECTED', label: 'Rejected', note: 'sent back', tone: 'rejected' },
  { key: 'MOVED_TO_ACCOUNTS', label: 'Moved to accounts', note: 'handed back to Accounts', tone: 'moved_to_accounts', card: false },
];

/** The stages that get a KPI card, in the same order. */
const CARD_STAGES = STAGES.filter((s) => s.card !== false);

/**
 * Where a handover may go next, and nowhere else. The server holds the same
 * map and enforces it; this one decides what the dropdown offers, so a move
 * that would be refused is never presented in the first place.
 *
 * A one-way ladder: CSD cannot rule on a bill they have not acknowledged
 * receiving, and having ruled they cannot un-rule -- Rejected is final for
 * that reason. Approved is not quite: an approved bill still has to be handed
 * back to Accounts, which is its one further move. Moved to accounts is
 * final here too, but for a different reason -- it hands the GRN to Accounts'
 * own Queued/Received tracking rather than reopening this ladder.
 */
const NEXT_STAGES = {
  QUEUED: ['RECEIVED'],
  RECEIVED: ['APPROVED', 'REJECTED'],
  APPROVED: ['MOVED_TO_ACCOUNTS'],
  REJECTED: [],
  MOVED_TO_ACCOUNTS: [],
};

/**
 * The stages a handover can still be taken back from -- kept in step by hand
 * with TAKE_BACK_STAGES in routes/csd.js, which is what actually refuses the
 * ones that cannot, and with ResultsTable.jsx's own copy of the same list.
 *
 * While CSD have only queued or received it, nothing of theirs is undone by
 * recalling it. Once they have ruled, the answer is not this screen's to
 * delete. Read here to decide which of a cheque's OTHER handovers a take-back
 * should carry with it; the row it was pressed on goes either way, and the
 * server has the last word on whether it may.
 */
const TAKE_BACK_STAGES = ['QUEUED', 'RECEIVED'];

const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

/** Where Accounts sent a forwarded GRN on to -- see forwardedLabel in ResultsTable.jsx. */
const FORWARD_LABELS = { BANK: 'Sent to Bank', OTHERS: 'Sent to Others', COURIER: 'Sent to Courier' };

function forwardedLabel(forwardedTo, forwardedRoute) {
  if (forwardedTo === 'VENDOR') {
    return forwardedRoute === 'PURCHASE_DEPT' ? 'Sent to Purchase Dept' : 'Sent to Vendor';
  }
  return FORWARD_LABELS[forwardedTo] || null;
}

/**
 * What a row's Status pill says, and which rung it borrows its colour from.
 *
 * MOVED_TO_ACCOUNTS is the one stage this screen does not have the last word
 * on: CSD's own ladder ends there, but Accounts still has two moves of its own
 * -- acknowledging the hand-back, then forwarding it on (see accounts_stage
 * and forwarded_to, tracked on the same dispatch). This reads whichever of the
 * three is furthest along rather than sitting on "Moved to accounts" forever
 * -- CSD's own screen should show how far the GRN has actually got, not just
 * that CSD is done with it.
 */
function describeStage(row) {
  if (row.stage === 'MOVED_TO_ACCOUNTS' && row.forwardedTo) {
    return { label: forwardedLabel(row.forwardedTo, row.forwardedRoute), tone: 'approved' };
  }
  if (row.stage === 'MOVED_TO_ACCOUNTS' && row.accountsStage === 'RECEIVED') {
    return { label: 'Accounts received', tone: 'approved' };
  }
  return { label: STAGE_LABELS[row.stage] || row.stage, tone: String(row.stage).toLowerCase() };
}

/**
 * The date each stage was reached, as its own column.
 *
 * Queue Date is `sentAt` -- pressing Send to CSD is what queues a handover, so
 * the moment it was sent and the moment it was queued are the same one.
 *
 * A row only ever has dates for the stages it actually passed through: a
 * rejected GRN has a queue date, a received date and a reject date, and no
 * approve date. The blanks are the shape of its journey, so each stage gets a
 * column of its own rather than sharing one.
 */
const STAGE_DATES = [
  { key: 'sentAt', label: 'Queue Date' },
  { key: 'receivedAt', label: 'Received Date' },
  { key: 'approvedAt', label: 'Approved Date' },
  { key: 'rejectedAt', label: 'Rejected Date' },
  { key: 'movedToAccountsAt', label: 'Moved To Accounts Date' },
];

/**
 * The header row below, counted, for either view: Division, the pinned GRN No
 * (Cheque No on Cheque view), Vendor, Vendor Code and Status on both, with the
 * Vendor Master's four (MSME No, MSME Status, Inter, Supply Type -- see
 * VendorCells); GRN view adds GRN Date, Bill No, Bill Date, Focus doc_no and
 * the five amounts; Cheque view adds Cheque Date, Cheque Amount, PaymentDocNo
 * and Account No. Then one per stage date, then Action.
 */
const columnCount = (byCheque) => 5 + VENDOR_CELL_COUNT + (byCheque ? 4 : 9) + STAGE_DATES.length + 1;

/**
 * The two matched statuses, spelled for a reader. A GRN reaches CSD from either
 * of them; the second is the one whose bill number did not agree, which is
 * worth carrying through the handover rather than flattening.
 */
const MATCH_LABELS = {
  MATCHED: 'Matched',
  MATCHED_WITH_DIFF: 'Check details',
};

/** dd/MM/yyyy from a timestamptz, in the browser's own zone. */
function formatStageDate(value) {
  if (!value) return '';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB') : '';
}

/** dd-MM-yyyy HH:mm from a timestamptz, in the browser's own zone. */
function formatSentAt(value) {
  if (!value) return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * The stage control: what this handover may be moved to next.
 *
 * The dropdown lists the row's own stage first, as the resting selection, then
 * only the stages it may actually move to -- one option from Queued, two from
 * Received. A verdict has none, so the control becomes a disabled button naming
 * the verdict: the cell keeps a control in it, and the control is plainly spent.
 */
function StagePicker({ row, busy, onPick }) {
  const next = NEXT_STAGES[row.stage] ?? [];
  const label = describeStage(row).label;
  // Whether the move will carry the rest of the cheque with it -- see
  // chequeGroup. Whether, not how many: the count is only known once the
  // server has been asked, and asking per row per render to fill in a tooltip
  // would be a request per row for a number nobody has looked at yet.
  const groupNote = row.chequeNo
    ? ` — this moves every GRN paid by cheque ${row.chequeNo}, not just this one`
    : '';

  if (next.length === 0) {
    return (
      <button
        type="button"
        className="stage-select stage-select--done"
        disabled
        title={`This GRN has been ${label.toLowerCase()}. That is final.`}
      >
        {label}
      </button>
    );
  }

  return (
    <select
      className="stage-select"
      value={row.stage}
      disabled={busy}
      onChange={(e) => onPick(e.target.value)}
      aria-label={`Move GRN ${row.dprNo} to its next CSD stage${groupNote}`}
      title={`Move GRN ${row.dprNo} to its next CSD stage${groupNote}`}
    >
      {/* The current stage, as the selection the box rests on. Picking it again
          is a no-op, which handleStage returns early on. */}
      <option value={row.stage}>{STAGE_LABELS[row.stage] || row.stage}</option>
      {next.map((key) => (
        <option key={key} value={key}>
          {STAGE_LABELS[key] || key}
        </option>
      ))}
    </select>
  );
}

/**
 * The reason a rejection carries, collected before it is recorded.
 *
 * A rejection is an instruction to somebody else to do something -- the GRN
 * goes back to Accounts for them to act on -- and one with no reason on it is
 * a GRN nobody can act on. So the reason is asked for as part of the verdict
 * rather than left as a note somebody may or may not add afterwards, and the
 * server refuses a REJECTED move without one regardless of what this dialog
 * does (see STAGE_REMARKS_REQUIRED in routes/csd.js).
 *
 * A dialog rather than the confirm box every other destructive action here
 * uses, because this one has to collect something: a confirm asks a question
 * that can be answered with a button, and this cannot. Submitting IS the
 * confirmation -- Reject is the submit button, and it stays disabled until
 * there is something in the box, so the two steps the user asked for are the
 * one form: write the reason, then press Reject.
 *
 * `subject` names what is being rejected, which for a cheque is more than the
 * row the picker was used on.
 */
function RejectReasonDialog({ subject, busy, error, onSubmit, onClose }) {
  const [remarks, setRemarks] = useState('');
  const ready = remarks.trim().length > 0;

  return (
    <Sheet label={`Reject ${subject}`} narrow onClose={busy ? () => {} : onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit(remarks.trim());
        }}
      >
        <div className="sheet__head">
          <h2>Reject {subject}</h2>
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}

          <p className="sheet__lead">
            The reason goes back to Accounts with the GRN, so write what has to be put right.
          </p>

          <label className="field">
            <span className="field__label">Reason for rejection</span>
            <textarea
              className="field__input"
              rows={4}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              maxLength={1000}
              autoFocus
              required
            />
          </label>
        </div>

        <div className="sheet__foot">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {/* Disabled until there is a reason to send, so the rule is visible
              on the button rather than only in the error the server would
              otherwise answer with. */}
          <button type="submit" className="primary" disabled={busy || !ready}>
            {busy ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default function Csd() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // The stage lives in the URL, so the results page's CSD cards can link
  // straight to a stage and the filtered view can be bookmarked or shared.
  // Anything unrecognised is treated as no filter rather than as an error.
  const stage = STAGE_LABELS[String(params.get('stage') || '').toUpperCase()]
    ? String(params.get('stage')).toUpperCase()
    : '';

  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Which handovers are in flight. A set rather than one id: the per-row
  // controls act on the row's whole cheque group (see chequeGroup below), so
  // every picker in that group has to read as busy at once.
  const [busy, setBusy] = useState(() => new Set());
  const [confirm, confirmDialog] = useConfirm();
  // Deleting a handover CSD have ruled on is an administrator's, the same as
  // deleting an upload -- see handleDeleteRecord below.
  const { isAdmin } = useAuth();
  // What a rejection is being written for, or null -- `{ row }` from a row's
  // own stage picker, `{ bulk: true }` from the toolbar's "Move n to…". Both
  // doors lead to the same dialog, because the server requires a reason on
  // either and a rejection that can be recorded without one from one of them
  // is the reason the rule is worth having. Its own error stays apart from the
  // page's: a refused submit has to stay on the dialog where the reason is,
  // not flash below a table the dialog is covering.
  const [reject, setReject] = useState(null);
  const [rejectError, setRejectError] = useState('');

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  // One branch, by the name the configuration screen gives it, or '' for every
  // branch in scope. It narrows the cards as well as the rows -- see the note
  // on LOCATION_FILTER in routes/csd.js -- so the four counts describe the
  // queue as it is being looked at rather than as a whole.
  //
  // Local state rather than the URL, which the stage filter uses: a stage is
  // linked to from the results page's cards and is worth bookmarking, where a
  // location is a view somebody adjusts while reading this screen.
  const [location, setLocation] = useState('');
  // 'MSME', 'NON_MSME', or '' for every vendor -- the MSME dropdown. Counted
  // inside like Location, for the same reason. See MsmeFilter.jsx.
  const [msme, setMsme] = useState('');

  // How the queue is read: a row per GRN, or a row per cheque with its
  // handovers' PayableAmount summed -- the same switch the Accounts views
  // carry. The cards follow it: GRN counts first on GRN view, cheque counts
  // first on Cheque view.
  const [csdView, setCsdView] = useState(ACCOUNTS_GRN_VIEW);
  const byCheque = csdView === ACCOUNTS_CHEQUE_VIEW;

  // Acting on several handovers at once, same idea as the Valid GRNS tab's own
  // "Select multiple" -- a cheque that pays several GRNs together is one thing
  // to move or take back, not one dropdown per row. `multiMode` is the
  // checkbox column showing at all; `selected` is which dispatch ids are
  // ticked within it, keyed by id rather than GRN number since a handover here
  // is addressed by its own row, not by the GRN it carries.
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Page 7 of one stage is rarely a page of the next, and the stage can now
  // change from outside this component -- a link in from the results page, or
  // the browser's Back button.
  useEffect(() => {
    setPage(1);
  }, [stage, location, msme, csdView]);

  // A ticked row belongs to the page it was ticked on -- changing any of the
  // page's own inputs invalidates the selection rather than carrying it,
  // silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [page, pageSize, q, stage, location, msme, csdView]);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listCsd({ page, pageSize, q, stage, location, msme, view: byCheque ? ACCOUNTS_CHEQUE_VIEW : undefined })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, pageSize, q, stage, location, msme, byCheque]);

  /** Switch the queue between a row per GRN and a row per cheque. */
  function selectCsdView(next) {
    if (next === csdView) return;
    setCsdView(next);
    // The rows on hand are the other view's shape; drawing them under this
    // view's columns until the reload lands would show a broken table.
    setData(null);
  }

  useEffect(load, [load]);

  /**
   * Ticking one row also ticks every other row on the page still there that
   * shares its cheque number -- a cheque pays a group of GRNs together, so
   * selecting one of them is read as meaning the whole group. Unticking only
   * lets go of the one row.
   */
  function toggleSelectRow(row) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) {
        next.delete(row.id);
        return next;
      }
      next.add(row.id);
      if (row.chequeNo) {
        for (const r of data?.rows || []) {
          if (r.chequeNo === row.chequeNo) next.add(r.id);
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
   * The stages every ticked row could move to next, in common -- the
   * intersection of each one's own NEXT_STAGES. Rows sent together usually
   * share a stage, in which case this is just that stage's own next steps;
   * mixed stages narrow it, honestly, to whatever move would be valid for
   * all of them at once rather than silently skipping the rows it would not
   * apply to.
   */
  const selectedRows = (data?.rows || []).filter((row) => selected.has(row.id));

  /** What the bulk controls call the selection: GRNs, or cheques on Cheque view. */
  const selectedLabel = byCheque
    ? `${selected.size} cheque${selected.size === 1 ? '' : 's'}`
    : `${selected.size}`;

  /**
   * The handovers a bulk action actually acts on: the ticked rows, or on
   * Cheque view every handover the ticked cheques pay that `eligible` accepts
   * -- see chequeGroups.js.
   */
  function bulkTargets(eligible) {
    if (!byCheque) return selectedRows;
    return expandCheques(selectedRows, (row) => csdChequeHandovers(row, eligible), (row) => row.id);
  }

  const bulkNextStages = selectedRows.length
    ? selectedRows
        .map((row) => NEXT_STAGES[row.stage] ?? [])
        .reduce((common, options) => common.filter((s) => options.includes(s)))
    : [];

  /** Move every ticked row to one stage at once. */
  async function bulkSetStage(next, remarks) {
    if (!next || selectedRows.length === 0) return;

    // Same rule as the per-row picker: rejecting needs a reason first, and the
    // dialog calls back into here with it.
    if (next === 'REJECTED' && !remarks) {
      setRejectError('');
      setReject({ bulk: true });
      return;
    }

    setBulkBusy(true);
    setError('');
    try {
      const targets = await bulkTargets((r) => (NEXT_STAGES[r.stage] ?? []).includes(next));
      await Promise.all(targets.map((row) => api.setCsdStage(row.id, next, remarks)));
      setReject(null);
      exitMultiMode();
      load();
    } catch (err) {
      if (remarks) setRejectError(err.message);
      else setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  /** Take every ticked row back off the queue at once. */
  async function bulkRemove() {
    if (selectedRows.length === 0) return;
    const ok = await confirm({
      title: byCheque ? 'Take these cheques back?' : 'Take these GRNs back?',
      message: byCheque
        ? `Are you sure you want to take every recallable GRN on ${selectedLabel} off the CSD queue?`
        : `Are you sure you want to take ${selectedRows.length} GRN${
            selectedRows.length === 1 ? '' : 's'
          } off the CSD queue?`,
      confirmLabel: 'Take back',
    });
    if (!ok) return;

    setBulkBusy(true);
    setError('');
    try {
      const targets = await bulkTargets((r) => TAKE_BACK_STAGES.includes(r.stage));
      await Promise.all(targets.map((row) => api.removeFromCsd(row.id)));
      exitMultiMode();
      // Removing every row of the last page would otherwise leave the pager
      // pointing past the end of a now-shorter queue.
      if (data.rows.length === selectedRows.length && page > 1) setPage((p) => p - 1);
      else load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  /** A cheque this big would be a data problem, not a payment run. */
  const GROUP_PAGE_SIZE = 200;
  const GROUP_MAX_PAGES = 10;

  /**
   * The handovers an action chosen on one row actually applies to: that row,
   * plus every other GRN the same cheque pays that could make the same move.
   *
   * A cheque is what was physically handed to CSD, so it is what CSD
   * acknowledge, rule on and hand back -- one bill of it moving on its own was
   * never the intent. This is the same rule the results screen's own Action
   * column follows; see chequeGroup in ResultsTable.jsx.
   *
   * Asked of the SERVER rather than filtered out of `data.rows`, which is the
   * one thing this could not be done locally. The queue is ordered by when
   * each handover was sent and paged twenty at a time, so a cheque's bills are
   * rarely all on the page the action was chosen from -- and filtering the
   * page would quietly move one row and leave the rest behind, which is
   * exactly what it would look like from the outside.
   *
   * The fetch carries no stage, search or location, so it finds the cheque's
   * handovers wherever the screen happens to be narrowed to at the time.
   * Branch scope still applies -- the server puts it on every query regardless
   * of what is asked for -- so this can never reach a row the account may not
   * see.
   *
   * `eligible` keeps the group honest: a same-cheque handover that cannot make
   * this particular move is left out rather than sent over to be refused.
   *
   * A row with no cheque number is its own group of one -- there is nothing to
   * group it by, and gathering every blank together would be a coincidence of
   * missing data rather than a cheque.
   */
  async function chequeGroup(row, eligible) {
    if (!row.chequeNo) return [row];

    const found = [];
    for (let p = 1; p <= GROUP_MAX_PAGES; p += 1) {
      const res = await api.listCsd({ chequeNo: row.chequeNo, page: p, pageSize: GROUP_PAGE_SIZE });
      found.push(...res.rows);
      if (p >= res.totalPages) break;
    }

    const group = found.filter(eligible);
    // The row the action was chosen on always belongs to its own group, even
    // if the fetch or the predicate disagrees -- it is what the person
    // pressed, and the one row whose action must not silently do nothing.
    return group.some((r) => r.id === row.id) ? group : [row, ...group];
  }

  /** Mark every row of a group in flight, and nothing else. */
  function beginBusy(group) {
    setBusy(new Set(group.map((r) => r.id)));
  }

  /**
   * Show one stage, or every stage for ''. What the cards and the dropdown
   * both call.
   *
   * A card pressed again keeps its stage: one that switched itself off on a
   * second press also switched itself off on a double-click, and dropped the
   * queue back to every stage without being asked. "All stages" in the
   * dropdown beside the search box is the way back to the whole queue -- it is
   * also what the screen opens on.
   */
  function applyStage(next) {
    // replace, not push: working through the four stages should not leave four
    // entries in the history for Back to walk out through.
    setParams(next ? { stage: next } : {}, { replace: true });
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      await exportCsd(q, stage, location, csdView, msme);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  /**
   * Move one handover to a stage.
   *
   * The whole page reloads rather than the one row being patched in place: the
   * cards count over every row in scope, and a row that changes stage changes
   * two of them. Editing the row alone would leave the numbers above it stale.
   */
  async function handleStage(row, next, remarks) {
    if (next === row.stage) return;

    // Rejecting needs a reason before it can be recorded, so picking it opens
    // the dialog rather than acting. The dialog calls back into here with the
    // reason, which is the branch below.
    if (next === 'REJECTED' && !remarks) {
      setRejectError('');
      setReject({ row });
      return;
    }

    // Busy on the one row first, so the control it was chosen on stops
    // responding while the group is being worked out.
    beginBusy([row]);
    setError('');
    try {
      // Only the handovers that could make this very move. A same-cheque row
      // sitting at a different stage is left where it is rather than sent over
      // to be refused -- the server holds the same ladder and would say no.
      const group = await chequeGroup(row, (r) => (NEXT_STAGES[r.stage] ?? []).includes(next));
      beginBusy(group);
      // The one reason is written onto every handover the cheque pays: they
      // were rejected together, for the same thing, in one decision.
      await Promise.all(group.map((r) => api.setCsdStage(r.id, next, remarks)));
      setReject(null);
      load();
    } catch (err) {
      // A rejection's error belongs on the dialog it was submitted from, which
      // is still open and still holds the typed reason.
      if (remarks) setRejectError(err.message);
      else setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Take one GRN back off the queue.
   *
   * Confirmed, because it is the only destructive control on the page and the
   * results tab's Send button silently goes back to unsent when it lands.
   */
  async function handleRemove(row) {
    beginBusy([row]);
    setError('');

    let group;
    try {
      // Only the handovers that can still be recalled -- the server refuses
      // the rest (see TAKE_BACK_STAGES in routes/csd.js), and a cheque whose
      // bills CSD has already ruled on should not have the whole action fail
      // on their account.
      group = await chequeGroup(row, (r) => TAKE_BACK_STAGES.includes(r.stage));
    } catch (err) {
      setError(err.message);
      setBusy(new Set());
      return;
    }

    const many = group.length > 1;
    const ok = await confirm({
      title: many ? `Take these ${group.length} GRNs back?` : 'Take this GRN back?',
      message: many
        ? `Cheque ${row.chequeNo} pays ${group.length} GRNs that can still be recalled. Are you sure you want to take all of them off the CSD queue?`
        : `Are you sure you want to take GRN ${row.dprNo} off the CSD queue?`,
      confirmLabel: 'Take back',
    });
    if (!ok) {
      setBusy(new Set());
      return;
    }

    beginBusy(group);
    try {
      await Promise.all(group.map((r) => api.removeFromCsd(r.id)));
      // Removing every row of the last page would otherwise leave the pager
      // pointing past the end of a now-shorter queue.
      const goneFromPage = data.rows.filter((r) => group.some((g) => g.id === r.id)).length;
      if (goneFromPage >= data.rows.length && page > 1) setPage((p) => p - 1);
      else load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Delete a handover CSD have already ruled on.
   *
   * The gap the take-back above leaves. Once CSD approve, reject or hand a GRN
   * back to Accounts it can no longer be recalled -- rightly, because recalling
   * it would undo their answer -- and until this button there was no way to
   * remove the record at all, however wrong it was.
   *
   * One row, not the cheque group the rest of this screen acts on. Every other
   * control here is a move in the process, and a cheque moves whole; this is a
   * correction to one row somebody got wrong, and quietly deleting the six
   * other bills on its cheque is not what pressing delete on a row means.
   *
   * Administrator-only, and the server says so too -- the button is hidden for
   * everyone else, but requireAdmin on the route is the guard.
   */
  async function handleDeleteRecord(row) {
    const ok = await confirm({
      title: 'Delete this handover?',
      message: [
        `GRN ${row.dprNo} and its CSD record — ${STAGE_LABELS[row.stage] || row.stage}, and any remarks — will be deleted. This cannot be undone.`,
        'It goes back to Accounts as a GRN that was never handed over.',
      ],
      confirmLabel: 'Delete handover',
    });
    if (!ok) return;

    beginBusy([row]);
    setError('');
    try {
      await api.deleteCsdRecord(row.id);
      // Deleting the last row of the last page would otherwise leave the pager
      // pointing past the end of a now-shorter queue.
      if (data.rows.length === 1 && page > 1) setPage((p) => p - 1);
      else load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  // Nothing has ever been sent -- as opposed to nothing matching a search or a
  // stage, which the table's own empty row covers without the page changing
  // shape.
  //
  // Summed over whatever the server sends back rather than over STAGES above.
  // Asking only about the stages this file happens to list would hide the whole
  // queue behind "nothing sent yet" the moment a stage was dropped from that
  // list -- which is exactly what taking Queued out of it used to do, with every
  // row sitting in Queued and none of them counted.
  //
  // Guarded on `q` because these counts are taken AFTER the search is applied
  // (only the stage filter is excluded from them), so a search matching nothing
  // zeroes all four. Without the guard, typing a term with no hits would replace
  // the whole page with "nothing sent yet" -- losing the search box along with
  // it, and saying something plainly untrue about the queue.
  //
  // The location and MSME filters are counted inside the same way and so are
  // guarded the same way: a branch nothing has been sent from yet is not an
  // empty queue, and nor is an MSME choice no handover matches.
  const queueEmpty =
    data &&
    !q &&
    !location &&
    !msme &&
    Object.values(data.stages ?? {}).every((bucket) => (bucket?.count ?? 0) === 0);
  if (!loading && queueEmpty) {
    return (
      <div className="empty empty--page">
        <h2>Nothing sent to CSD yet</h2>
        <p>
          Open the Valid GRNS tab on the results page and press Send to CSD on a row. What you send
          appears here, with the GRN&apos;s details as they stood at the time.
        </p>
        <button className="primary" type="button" onClick={() => navigate('/results')}>
          Go to results
        </button>
      </div>
    );
  }

  return (
    <>
      {confirmDialog}
      {reject && (
        <RejectReasonDialog
          /* Named for what the submit will actually reject. From a row's own
             picker that is the whole cheque, not the row the picker was used
             on -- see chequeGroup -- and with no count, since the group is
             only counted once the server has been asked, which is after this
             is submitted. From the toolbar it is the ticked rows, which are
             counted already because the person ticked them. */
          subject={
            reject.bulk
              ? byCheque
                ? selectedLabel
                : `${selected.size} GRN${selected.size === 1 ? '' : 's'}`
              : reject.row.chequeNo
                ? `every GRN on cheque ${reject.row.chequeNo}`
                : `GRN ${reject.row.dprNo}`
          }
          busy={reject.bulk ? bulkBusy : busy.has(reject.row.id)}
          error={rejectError}
          onSubmit={(remarks) =>
            reject.bulk
              ? bulkSetStage('REJECTED', remarks)
              : handleStage(reject.row, 'REJECTED', remarks)
          }
          onClose={() => setReject(null)}
        />
      )}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Sent to CSD</h2>
          <p className="page__lead">
            {data
              ? `${data.total.toLocaleString('en-IN')} ${byCheque ? 'cheque' : 'GRN'}${data.total === 1 ? '' : 's'}` +
                `${stage ? ` ${STAGE_LABELS[stage].toLowerCase()}` : ' handed over'}` +
                ` — ₹ ${formatAmount(data.amount)} payable.`
              : 'Everything handed over from the Valid GRNS tab.'}{' '}
            Each row keeps the details as they stood when it was sent.
          </p>
        </div>

        {/* Where the results screen keeps its pair of scope pickers. This
            screen has no upload to choose -- a handover outlives the upload it
            came from, so the queue is every upload at once -- which leaves the
            location on its own, in the same place and the same shape. */}
        <div className="page__actions">
          <ViewModeRadios value={csdView} onChange={selectCsdView} />
          <LocationFilter value={location} onChange={setLocation} />
        </div>
      </div>

      {data?.stages && (
        <div className="cards">
          {CARD_STAGES.map((s) => {
            const bucket = data.stages[s.key] || { count: 0, cheques: 0, amount: 0 };
            // GRN count first on GRN view, cheque count first on Cheque view.
            const figures = leadFigures({ grns: bucket.count, cheques: bucket.cheques ?? 0 }, byCheque);
            return (
              <button
                key={s.key}
                type="button"
                className={`card stat stat--${s.tone} ${stage === s.key ? 'is-active' : ''}`}
                onClick={singlePress(() => applyStage(s.key))}
                aria-pressed={stage === s.key}
                title={
                  stage === s.key
                    ? `Showing ${s.label} only — choose All stages in the stage filter for the whole queue`
                    : `Show only the ${s.label} handovers`
                }
              >
                <div className="stat__label">{s.label}</div>
                <div className="stat__value">{figures.value.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(bucket.amount)}</div>
                <div className="stat__hint">{`${figures.sub} ${s.note}`}</div>
              </button>
            );
          })}
        </div>
      )}
      {/* The same strip the results page carries above its table. Neither page
          fills the left half any more -- choosing a view moved up to the head
          row -- so on both the controls take the right and the strip is
          otherwise empty. */}
      <div className="toolbar">
        <div className="toolbar__actions">
          {/* MSME or Non-MSME vendors -- first, ahead of the stage dropdown,
              since it narrows the cards and the export as well as the rows. */}
          <MsmeFilter value={msme} onChange={setMsme} />
          {/* Every stage, not just the four the cards count -- Moved to
              accounts has no card here (see STAGES) but is still a stage a
              row can be filtered to. Either control sets the filter and both
              read it back from the URL, so they cannot disagree about what
              the table is showing. */}
          <select
            className="field__input stage-filter"
            value={stage}
            onChange={(e) => applyStage(e.target.value)}
            aria-label="Filter the queue by CSD stage"
          >
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
                {data?.stages?.[s.key] ? ` (${data.stages[s.key].count})` : ''}
              </option>
            ))}
          </select>
          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, vendor code, GRN or bill no."
            aria-label="Search the CSD queue by vendor name, GRN number or bill number"
          />

          {/* Acting on several handovers at once, same idea as the Valid
              GRNS tab's own "Select multiple" -- a cheque that pays several
              GRNs together is one thing to move or take back, not one
              dropdown per row. The toggle doubles as its own cancel: once a
              selection is open, pressing it again is the same button reading
              a cross rather than a second control beside it. */}
          <button
            type="button"
            className={multiMode ? 'ghost icon-btn' : 'ghost'}
            onClick={() => (multiMode ? exitMultiMode() : setMultiMode(true))}
            title={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to act on together'}
            aria-label={multiMode ? 'Cancel selecting' : 'Select multiple GRNs to act on together'}
          >
            {multiMode ? <IconX size={14} /> : 'Select multiple'}
          </button>
          {multiMode && (
            <>
              {/* Only the stages every ticked row could move to in common --
                  see bulkNextStages above -- so choosing one is never refused
                  for a row it does not apply to. Absent whenever that set is
                  empty, same as the per-row picker becoming a plain verdict
                  once a row has nowhere left to go. */}
              {bulkNextStages.length > 0 && (
                <select
                  className="stage-select send-select"
                  value=""
                  disabled={bulkBusy}
                  onChange={(e) => e.target.value && bulkSetStage(e.target.value)}
                  aria-label={`Move ${selectedLabel} selected to a CSD stage`}
                >
                  <option value="">Move {selectedLabel} to…</option>
                  {bulkNextStages.map((key) => (
                    <option key={key} value={key}>
                      {STAGE_LABELS[key] || key}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="ghost danger"
                onClick={bulkRemove}
                disabled={selected.size === 0 || bulkBusy}
              >
                {bulkBusy ? 'Working…' : selected.size > 0 ? `Sent back ${selectedLabel}` : 'Sent back'}
              </button>
            </>
          )}

          <button
            className="ghost"
            type="button"
            onClick={handleExport}
            disabled={exporting || !data?.total}
          >
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {loading && !data ? (
        <div className="loading">Loading…</div>
      ) : (
        data && (
          <>
            <div className="table-wrap table-wrap--sticky">
              <table className={multiMode ? 'table table--pinned-select' : 'table'}>
                <thead>
                  <tr>
                    {/* The bulk-select checkbox, pinned ahead of Division and
                        GRN No when "Select multiple" is on -- see
                        .table__pin--select and .table--pinned-select in
                        styles.css, which shift the other two over to make
                        room for it. */}
                    {multiMode && (
                      <th
                        className="table__select table__pin table__pin--select"
                        aria-label="Select for bulk action"
                      />
                    )}
                    {/* Division and GRN No pinned together, in the same order
                        as the results and turnaround tables -- see
                        .table__pin in styles.css -- so the two together hold
                        the left edge once the queue is scrolled sideways. */}
                    <th className="table__pin table__pin--division">Division</th>
                    {/* On Cheque view the cheque is what a row is looked up
                        by, so it takes GRN No's pinned place. */}
                    <th className="table__pin table__pin--grn">{byCheque ? 'Cheque No' : 'GRN No'}</th>
                    {!byCheque && <th>GRN Date</th>}
                    {!byCheque && <th>Bill No</th>}
                    {!byCheque && <th>Bill Date</th>}
                    <th>Vendor</th>
                    {/* The code used to sit under the name, where it could not
                        be read down the column. */}
                    <th>Vendor Code</th>
                    {/* The vendor's details off the Vendor Master -- its MSME
                        registration, and the Inter and Supply Type picked there
                        -- read live rather than copied onto the handover. See
                        VendorCells. On both views: they are about the vendor. */}
                    <th>MSME No</th>
                    <th>MSME Status</th>
                    <th>Inter</th>
                    <th>Supply Type</th>
                    {!byCheque && (
                      <>
                        <th>Focus doc_no</th>
                        <th className="table__num">NetAmt</th>
                        {/* The ageing report's own amount breakdown, in the same
                            order as the Valid GRNs export: NetAmt through
                            PayableAmount, each an adjustment on the last. */}
                        <th className="table__num">AdjPurReturn</th>
                        <th className="table__num">AdjustedJV</th>
                        <th className="table__num">TDSJV</th>
                        <th className="table__num">PayableAmount</th>
                      </>
                    )}
                    {/* Cheque view only: the cheque's own columns. GRN view
                        leaves them off, as the Accounts views do. Cheque
                        Amount is every PayableAmount the cheque pays, summed
                        on the server -- see chequeDispatches in routes/csd.js. */}
                    {byCheque && (
                      <>
                        {/* The day the ageing report says the cheque was cut
                            -- not the day it cleared. */}
                        <th>Cheque Date</th>
                        <th className="table__num">Cheque Amount</th>
                        <th>PaymentDocNo</th>
                        {/* The account the dispatch's branch banks through,
                            off the configuration screen. */}
                        <th>Account No</th>
                      </>
                    )}

                    {/* <th>Match</th> */}
                    <th>Status</th>
                    {/* One column per stage, each showing the day the handover
                        reached it. A blank is a stage this GRN has not got to,
                        which is why they are not collapsed into one "last
                        moved" column: the gap is the information. */}
                    {STAGE_DATES.map((d) => (
                      <th key={d.key}>{d.label}</th>
                    ))}
                    {/* Pinned to the right edge, so the stage picker and Sent
                        back stay in reach however far the row is scrolled --
                        see .table__pin--action in styles.css. */}
                    <th className="table__pin table__pin--action">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr>
                      <td
                        className="table__empty"
                        colSpan={columnCount(byCheque) + (multiMode ? 1 : 0)}
                      >
                        {/* The same wording the results table uses for a search
                            that finds nothing, so the two screens answer an
                            empty search the same way. A stage filter with no
                            rows is a different thing and still says so. */}
                        {q
                          ? 'Matches not found'
                          : `Nothing is ${STAGE_LABELS[stage]?.toLowerCase() ?? 'here'}`}
                      </td>
                    </tr>
                  )}
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      {multiMode && (
                        <td className="table__select table__pin table__pin--select">
                          <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            onChange={() => toggleSelectRow(row)}
                            aria-label={
                              byCheque
                                ? `Select cheque ${row.chequeNo} for a bulk action`
                                : `Select GRN ${row.dprNo} for a bulk action`
                            }
                          />
                        </td>
                      )}
                      <td className="table__pin table__pin--division">{row.divisionCode}</td>
                      {byCheque ? (
                        <td className="table__mono table__pin table__pin--grn">
                          {row.chequeNo || <span className="table__miss">&mdash;</span>}
                          {row.chequeGrnCount != null && (
                            <div className="table__sub">
                              {`${row.chequeGrnCount} GRN${row.chequeGrnCount === 1 ? '' : 's'}`}
                            </div>
                          )}
                        </td>
                      ) : (
                        <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
                      )}
                      {!byCheque && <td>{formatDate(row.dprDate)}</td>}
                      {!byCheque && <td className="table__mono">{row.billNo}</td>}
                      {!byCheque && <td>{formatDate(row.billDate)}</td>}
                      <td>{row.vendorName}</td>
                      <td className="table__mono">
                        {row.vendorCode || <span className="table__miss">&mdash;</span>}
                      </td>
                      <VendorCells row={row} />
                      {!byCheque && (
                        <>
                          <td className="table__mono">{row.ageingGrnNo}</td>
                          <td className="table__num">{formatAmount(row.netAmt)}</td>
                          <td className="table__num">{formatAmountOrDash(row.adjPurReturn)}</td>
                          <td className="table__num">{formatAmountOrDash(row.adjustedJv)}</td>
                          <td className="table__num">{formatAmountOrDash(row.tdsJv)}</td>
                          <td className="table__num">{formatAmount(row.payableAmount)}</td>
                        </>
                      )}
                      {byCheque && (
                        <>
                          <td>{formatDate(row.chqDate) || <span className="table__miss">&mdash;</span>}</td>
                          <td className="table__num">{formatAmountOrDash(row.chequeAmount)}</td>
                          <td className="table__mono">
                            {row.paymentDocNo || <span className="table__miss">&mdash;</span>}
                          </td>
                          <td className="table__mono">
                            {row.accountNo || <span className="table__miss">&mdash;</span>}
                          </td>
                        </>
                      )}

                      {/* <td>
                        <span
                          className={`pill ${
                            row.matchStatus === 'MATCHED_WITH_DIFF' ? 'pill--diff' : 'pill--sent'
                          }`}
                          // The note is the whole point of the "check details"
                          // state, and it is a sentence -- too long for a cell,
                          // right for the thing you hover to read.
                          title={row.discrepancyNotes || undefined}
                        >
                          {MATCH_LABELS[row.matchStatus] || row.matchStatus || '—'}
                        </span>
                        {row.matchStatus === 'MATCHED_WITH_DIFF' && row.discrepancyNotes && (
                          <div className="table__sub table__wrap">{row.discrepancyNotes}</div>
                        )}
                      </td> */}
                      <td>
                        <span
                          className={`pill pill--${describeStage(row).tone}`}
                          title={row.rejectRemarks || undefined}
                        >
                          {describeStage(row).label}
                        </span>
                        {/* Why it was rejected. The reason is the whole point
                            of a rejection -- it is what Accounts have to act
                            on -- so it reads in the cell rather than only on
                            hover, the way the discrepancy note above used to.
                            Only rejections carry one; see reject_remarks in
                            schema.sql. */}
                        {row.rejectRemarks && <Remark text={row.rejectRemarks} />}
                        {/* Turned down once before and sent round again. Only
                            where there is no current reason to read instead --
                            see PriorRejection. Worth more here than anywhere:
                            a reopened GRN arrives back in this queue looking
                            like any other fresh handover, and this is the only
                            thing saying CSD have seen it before. */}
                        {!row.rejectRemarks && row.priorRejection && (
                          <PriorRejection prior={row.priorRejection} />
                        )}
                        {/* Who moved it, and when. Absent while a row is still
                            queued: nobody has answered for it yet. */}
                        {/* {row.stageAt && (
                          <div className="table__sub">
                            {formatSentAt(row.stageAt)}
                            {row.stageBy ? ` · ${row.stageBy}` : ''}
                          </div>
                        )} */}
                      </td>
                      {STAGE_DATES.map((d) => (
                        <td key={d.key}>
                          {row[d.key] ? (
                            // The day, with the full stamp on hover. A stamp
                            // corrected from the span page reads 00:00, so the
                            // time is worth having but not worth a column.
                            <span title={formatSentAt(row[d.key])}>{formatStageDate(row[d.key])}</span>
                          ) : (
                            <span className="table__miss">&mdash;</span>
                          )}
                        </td>
                      ))}
                      <td className="table__pin table__pin--action">
                        <div className="row-actions">
                          <StagePicker
                            row={row}
                            busy={busy.has(row.id)}
                            onPick={(next) => handleStage(row, next)}
                          />
                          <button
                            type="button"
                            className="csd csd--take-back"
                            disabled={busy.has(row.id)}
                            onClick={() => handleRemove(row)}
                            title={
                              row.chequeNo
                                ? `Take GRN ${row.dprNo} back off the CSD queue — this takes back every recallable GRN paid by cheque ${row.chequeNo}`
                                : `Take GRN ${row.dprNo} back off the CSD queue`
                            }
                          >
                            <span className="csd__icon">
                              <IconTrash size={14} />
                            </span>
                            Sent back
                          </button>
                          {/* Only where Sent back cannot reach, so a row never
                              carries two buttons that mean nearly the same
                              thing: a handover CSD have ruled on, which they
                              refuse to give back and which until now could not
                              be removed at all. */}
                          {/* GRN view only: Delete removes one handover, and a
                              Cheque view row stands for several. */}
                          {isAdmin && !byCheque && !TAKE_BACK_STAGES.includes(row.stage) && (
                            <button
                              type="button"
                              className="csd csd--delete"
                              disabled={busy.has(row.id)}
                              onClick={() => handleDeleteRecord(row)}
                              title={`Delete the CSD record for GRN ${row.dprNo} — it goes back to Accounts as never handed over`}
                            >
                              <span className="csd__icon">
                                <IconTrash size={14} />
                              </span>
                              Delete
                            </button>
                          )}
                        </div>
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
