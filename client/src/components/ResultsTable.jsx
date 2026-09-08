import { useState } from 'react';
import { api } from '../api/client.js';
import { IconCheck, IconSend } from './icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Sheet from './Sheet.jsx';

const currency = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatAmount(value) {
  if (value === null || value === undefined) return '';
  return currency.format(value);
}

export function formatDate(value) {
  if (!value) return '';
  const [y, m, d] = String(value).split('-');
  return d ? `${d}-${m}-${y}` : value;
}

/**
 * An amount cell, or a dash. For the GRN report's own optional figures --
 * Bill.Amount, Transport Amount, Add.Amount, Ded.Amount -- which are
 * genuinely blank on plenty of rows, not zero; a dash says so the same way it
 * does everywhere else in this table.
 */
export function formatAmountOrDash(value) {
  return value === null || value === undefined ? (
    <span className="table__miss">&mdash;</span>
  ) : (
    formatAmount(value)
  );
}

/**
 * The ageing report's amount columns, in the order the source sheet carries
 * them: NetAmt, the three adjustments that reduce it, then what is left to pay.
 */
/** The Total GRNS tab, as Results.jsx and the server both name it. */
const ALL = 'ALL';

const AMOUNT_COLUMNS = [
  { key: 'netAmt', label: 'NetAmt' },
  { key: 'adjPurReturn', label: 'AdjPurReturn' },
  { key: 'adjustedJv', label: 'AdjustedJV' },
  { key: 'tdsJv', label: 'TDSJV' },
  { key: 'payableAmount', label: 'PayableAmount' },
];

/**
 * The Status cell, once a GRN has been handed over: where it has got to at CSD.
 *
 * Queued reads as "Sent to CSD" rather than "Queued". From this table the fact
 * worth stating is that it went; that CSD have not answered yet is what the
 * absence of an answer means. The other three name CSD explicitly, because on
 * this tab every row already has a reconciliation status of its own and
 * "Approved" alone would not say by whom.
 *
 * The tones match the CSD screen's cards and pills exactly, so a row here and
 * the card counting it there are recognisably the same colour.
 */
const CSD_STAGES = {
  QUEUED: { label: 'Sent to CSD', tone: 'queued' },
  RECEIVED: { label: 'CSD received', tone: 'received' },
  APPROVED: { label: 'CSD approved', tone: 'approved' },
  REJECTED: { label: 'CSD rejected', tone: 'rejected' },
};

/**
 * MOVED_TO_ACCOUNTS is the one CSD stage not read straight off CSD_STAGES
 * above: CSD's own ladder ends there, but Accounts still has one step of its
 * own -- acknowledging the hand-back (see `accountsStage` on the row, and the
 * Action column's picker below) -- so the label has to say which side of that
 * step a GRN is on rather than sitting on one word forever.
 *
 * Neither reads "Moved to accounts": that phrase is already this tab's own
 * wording for a different fact (see MOVED_TO_ACCOUNTS below -- being on this
 * tab at all), so a column that repeated it would read as saying the same
 * thing twice about two different things.
 */
const ACCOUNTS_RETURN_STATES = {
  QUEUED: { label: 'Returned by CSD', tone: 'moved_to_accounts' },
  RECEIVED: { label: 'Accounts received', tone: 'approved' },
};

/**
 * Once Accounts has forwarded a received GRN on, the Status cell reads where
 * to rather than "Accounts received" -- that fact is done with by then. Bank
 * and Others need only their own name; Vendor further distinguishes the
 * vendor itself from the purchase department that stands in for it.
 */
const FORWARD_LABELS = {
  BANK: 'Sent to Bank',
  OTHERS: 'Sent to Others',
  COURIER: 'Sent to Courier',
};

function forwardedLabel(forwardedTo, forwardedRoute) {
  if (forwardedTo === 'VENDOR') {
    return forwardedRoute === 'PURCHASE_DEPT' ? 'Sent to Purchase Dept' : 'Sent to Vendor';
  }
  return FORWARD_LABELS[forwardedTo] || null;
}

/**
 * The other destination, in the Status cell.
 *
 * One state, where CSD has four. Records is a filing cabinet, not a queue:
 * nothing comes back from it, there is no screen showing what is in it, and no
 * stage for a row to move to. So "Sent to Records" is the whole of what this
 * column has to say about such a row, from the moment it is sent onwards.
 *
 * The received blue rather than the queued amber. Amber on the CSD side means
 * somebody still owes an answer; nobody owes one here, and colouring it as
 * though they did would put these rows on a chase list they do not belong on.
 */
const RECORDS_STATE = { label: 'Sent to Records', tone: 'received' };

/**
 * The Match cell, on the Total GRNS tab only.
 *
 * That tab is the two reconciliation buckets shown together, so each row has to
 * say which one it is in -- on the Pending and Valid GRNS tabs the tab itself
 * is the answer and the column would repeat it on every row.
 *
 * Two states, not three. The reconciliation still records which matched rows
 * had a differing bill number -- it is stored, and the CSD screen still reads
 * it -- but this table does not report it: a GRN found in the ageing report
 * has moved to accounts either way. So both matched statuses read the same
 * here.
 *
 * "Moved to accounts" is the export's own wording (see STATUS_LABELS in
 * services/exporter.js): the sheet is what gets forwarded and argued over, and
 * a column that reads differently on screen and in the file is a column two
 * people can disagree about while both looking at the right answer. Pending is
 * the one that is shortened -- the export spells it "Pending - not in
 * accounts", which on screen would say twice what the tab beside it says once.
 *
 * The tones are the status cards': warn for pending, the matched green for a
 * GRN that got through.
 */
const MOVED_TO_ACCOUNTS = {
  label: 'Moved to accounts',
  tone: 'valid',
  hint: 'Found in the ageing report',
};

const MATCH_STATES = {
  PENDING: { label: 'Pending', tone: 'pending', hint: 'Not found in the ageing report' },
  MATCHED: MOVED_TO_ACCOUNTS,
  MATCHED_WITH_DIFF: MOVED_TO_ACCOUNTS,
};

function MatchState({ status }) {
  const state = MATCH_STATES[status];
  if (!state) return <span className="table__miss">&mdash;</span>;
  return (
    <span className={`pill pill--${state.tone}`} title={state.hint}>
      {state.label}
    </span>
  );
}

/**
 * A row's status: whether the cheque cleared, and where it has been sent.
 *
 * Cheque cleared leads when there is a clearance date. A cleared cheque means
 * the vendor has actually been paid, which outranks where the paperwork has got
 * to -- and on the great majority of rows, which were never sent to CSD, it is
 * the only thing this column has to say.
 *
 * The CSD stage is not dropped for it, though. A GRN can be paid and still be
 * sitting with CSD, so when it is both, the stage follows underneath rather
 * than being replaced by the cheque.
 *
 * `stage` is null for the moment between the send resolving and the reload
 * landing -- the row on screen is still the one the server sent before it knew
 * -- so it falls back to QUEUED, which is where a send has just put it.
 */
function RowStatus({ sent, stage, accountsStage, forwardedTo, forwardedRoute, forwardedName, forwardedMobile, forwardedDate, forwardedCourierName, forwardedDocketNo, filed, clearedOn }) {
  // Records has no stages, so there is one thing to say about it and this is
  // it. A GRN cannot be at both destinations -- the dropdown that sends it goes
  // away once it has gone -- so the two never have to be shown together.
  const destination = sent
    ? stage === 'MOVED_TO_ACCOUNTS'
      ? forwardedTo
        ? { label: forwardedLabel(forwardedTo, forwardedRoute), tone: 'approved' }
        : ACCOUNTS_RETURN_STATES[accountsStage] || ACCOUNTS_RETURN_STATES.QUEUED
      : CSD_STAGES[stage] || CSD_STAGES.QUEUED
    : filed
      ? RECORDS_STATE
      : null;

  // Who it was handed to and when, on hover -- set for VENDOR and OTHERS,
  // both hand-offs to a person, and too much detail for the pill itself.
  // Courier gets the same treatment with its own two fields in place of a
  // person's name and mobile number.
  const forwardHint =
    forwardedTo === 'VENDOR' || forwardedTo === 'OTHERS'
      ? `Handed to ${forwardedName}, ${forwardedMobile}, on ${formatDate(forwardedDate)}`
      : forwardedTo === 'COURIER'
        ? `Handed to ${forwardedCourierName}, docket ${forwardedDocketNo}`
        : undefined;

  if (clearedOn) {
    return (
      <>
        <span className="pill pill--approved" title={`Cleared by the bank on ${formatDate(clearedOn)}`}>
          Cheque cleared
        </span>
        {destination && <div className="table__sub">{destination.label}</div>}
      </>
    );
  }

  if (!destination) return <span className="pill pill--unsent">Not sent</span>;
  return (
    <span className={`pill pill--${destination.tone}`} title={forwardHint}>
      {destination.label}
    </span>
  );
}

/**
 * The Action cell's control: where to send this GRN.
 *
 * A dropdown rather than the single Send to CSD button it replaces, because
 * there are now two places a Valid GRN can go and neither is the obvious
 * default. Choosing acts at once -- the same way the CSD screen's stage picker
 * works -- so it is one gesture, not a choice followed by a confirmation.
 *
 * It rests on a prompt rather than on either destination, so nothing is
 * pre-selected: a box already reading "Send to CSD" invites a click that sends
 * to CSD by accident, and a handover is not something to undo casually.
 *
 * Once the GRN has gone, the dropdown is replaced by where it went. There is no
 * moving it from one destination to the other from here -- taking it back is
 * the CSD screen's job on that side, and Records has no screen at all.
 */
const SEND_CSD = 'CSD';
const SEND_RECORDS = 'RECORDS';

function SendPicker({ row, sent, filed, busy, canCsd, onSend }) {
  // Where it has gone, if it has. Both read as an arrival rather than as a
  // disabled control: the row is finished with, and the Status column beside
  // this one carries the detail.
  if (sent || filed) {
    return (
      <button
        type="button"
        className="csd csd--sent"
        disabled
        title={
          sent
            ? `GRN ${row.dprNo} is in the CSD queue`
            : `GRN ${row.dprNo} has been sent to Records`
        }
      >
        <span className="csd__icon">
          <IconCheck size={14} />
        </span>
        Sent
      </button>
    );
  }

  if (busy) {
    return (
      <button type="button" className="csd" disabled>
        <span className="csd__icon">
          <IconSend size={14} />
        </span>
        Sending…
      </button>
    );
  }

  return (
    <select
      className="stage-select send-select"
      value=""
      onChange={(e) => e.target.value && onSend(row, e.target.value)}
      aria-label={`Send GRN ${row.dprNo} to CSD or to Records`}
    >
      <option value="">Send to…</option>
      {/* An account that was not given the CS Department screen cannot hand a
          GRN to it -- the POST is refused by requireScreen('csd'). The option
          stays, disabled, rather than being dropped: the row still reads as one
          that COULD go to CSD, and says plainly why this account cannot send
          it. Records is gated on the results screen, which anyone looking at
          this table already has. */}
      <option value={SEND_CSD} disabled={!canCsd}>
        {canCsd ? 'Send to CSD' : 'Send to CSD — no access'}
      </option>
      <option value={SEND_RECORDS}>Send to Records</option>
    </select>
  );
}

/**
 * The Action cell once CSD has handed a GRN back (csdStage reaches
 * MOVED_TO_ACCOUNTS): Accounts' own two moves, in the same shape as the CSD
 * screen's own stage picker throughout -- a dropdown resting on the current
 * state, offering what it may still move to, and a disabled button reading
 * the verdict once there is nowhere further to go.
 *
 * Two moves, not one control each: acknowledging receipt and choosing where
 * it goes on to are different questions asked at different times, so the
 * dropdown itself changes shape once Received rather than growing a second
 * control beside it. Send to Vendor and Others both open ForwardDetailsDialog
 * instead of acting on selection, because a hand-off to a person needs who
 * took it, on what number, and on what day before it means anything; Courier
 * opens the same dialog for its own two fields, a courier name and a docket
 * number, since a hand-off to a service needs proof of its own before it
 * means anything either. Bank alone acts at once, having no such record to
 * collect.
 */
function AccountsStagePicker({ row, busy, onReceive, onForwardSimple, onOpenForwardForm }) {
  const accountsStage = row.csdAccountsStage || 'QUEUED';

  if (accountsStage === 'RECEIVED' && row.csdForwardedTo) {
    const label = forwardedLabel(row.csdForwardedTo, row.csdForwardedRoute);
    return (
      <button
        type="button"
        className="stage-select stage-select--done"
        disabled
        title={`GRN ${row.dprNo}: ${label.toLowerCase()}. That is final.`}
      >
        {label}
      </button>
    );
  }

  if (accountsStage === 'RECEIVED') {
    return (
      <select
        className="stage-select"
        value="RECEIVED"
        disabled={busy}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'VENDOR' || value === 'OTHERS' || value === 'COURIER') onOpenForwardForm(row, value);
          else if (value === 'BANK') onForwardSimple(row, value);
        }}
        aria-label={`Send GRN ${row.dprNo} on to its next destination`}
      >
        <option value="RECEIVED">Received</option>
        <option value="BANK">Send to Bank</option>
        <option value="VENDOR">Send to Vendor</option>
        <option value="OTHERS">Others</option>
        <option value="COURIER">Send to Courier</option>
      </select>
    );
  }

  return (
    <select
      className="stage-select"
      value="QUEUED"
      disabled={busy}
      onChange={(e) => e.target.value === 'RECEIVED' && onReceive(row)}
      aria-label={`Acknowledge GRN ${row.dprNo} as received by Accounts`}
    >
      <option value="QUEUED">Queued</option>
      <option value="RECEIVED">Received</option>
    </select>
  );
}

/**
 * Send to Vendor and Send to Others both open this dialog rather than acting
 * immediately, because a hand-off to a person needs who took it, on what
 * number, and on what day before it means anything -- unlike Bank, which has
 * no such person to record and so still acts on selection.
 *
 * Vendor alone carries a further choice on top of that: which of its two
 * doors the GRN went out of, the vendor itself or the purchase department
 * that stands in for it. That field is left unchosen at first rather than
 * defaulting to Vendor -- picking one is what reveals the three fields below
 * it, which is the closest a plain form gets to a nested dropdown. Others has
 * no such door, so for it the three fields show right away.
 */
function ForwardDetailsDialog({ row, to, busy, error, onSubmit, onClose }) {
  const isVendor = to === 'VENDOR';
  const isCourier = to === 'COURIER';
  const [route, setRoute] = useState('');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [date, setDate] = useState('');
  const [courierName, setCourierName] = useState('');
  const [docketNo, setDocketNo] = useState('');

  // Vendor's fields wait on the door being chosen; Others has no door to wait
  // on, so its fields are there from the start. Courier has neither a door
  // nor these fields -- it gets its own pair below instead.
  const showFields = !isVendor && !isCourier ? true : isVendor && route;
  const label = isVendor ? 'Vendor' : isCourier ? 'Courier' : 'Others';

  return (
    <Sheet label={`Send GRN ${row.dprNo} to ${label}`} narrow onClose={busy ? () => {} : onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ route, name, mobile, date, courierName, docketNo });
        }}
      >
        <div className="sheet__head">
          <h2>Send to {label}</h2>
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}

          {isVendor && (
            <label className="field">
              <span className="field__label">Where</span>
              <select
                className="field__input"
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                required
              >
                <option value="" disabled>
                  Choose where this goes…
                </option>
                <option value="VENDOR">Vendor</option>
                <option value="PURCHASE_DEPT">Purchase Department</option>
              </select>
            </label>
          )}

          {/* For Vendor, only once a door is chosen -- see the note above the
              component. For Others there is no door, so these show at once. */}
          {showFields && (
            <>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="field__input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  required
                />
              </label>

              <label className="field">
                <span className="field__label">Mobile number</span>
                <input
                  className="field__input"
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  autoComplete="off"
                  required
                />
              </label>

              <label className="field">
                <span className="field__label">Date</span>
                <input
                  className="field__input"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </label>
            </>
          )}

          {isCourier && (
            <>
              <label className="field">
                <span className="field__label">Courier name</span>
                <input
                  className="field__input"
                  value={courierName}
                  onChange={(e) => setCourierName(e.target.value)}
                  autoComplete="off"
                  required
                />
              </label>

              <label className="field">
                <span className="field__label">Docket number</span>
                <input
                  className="field__input"
                  value={docketNo}
                  onChange={(e) => setDocketNo(e.target.value)}
                  autoComplete="off"
                  required
                />
              </label>
            </>
          )}
        </div>

        <div className="sheet__foot">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || (isVendor && !route)}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * The results grid, in one of two layouts.
 *
 * Pending rows have no ageing entry, so every ageing column would be blank:
 * that layout is the GRN report's own columns and nothing else.
 *
 * Valid GRNs is the accounts-side view, and it is the ageing report's own
 * figures throughout: Division (DivisionCode) in place of the GRN report's
 * Warehouse, and NetAmt through PayableAmount in place of its Total Amount, so
 * no column on that tab is the stores' number. The handover date is dropped --
 * the whole tab is "already handed over", and Turnaround is where that date is
 * read.
 *
 * Cheque No comes off the ageing report too, at the end of the money columns:
 * it is the answer to "has this actually been paid, and by which cheque", which
 * is the next question after PayableAmount. It is blank on a bill not yet paid.
 *
 * The rows that reached accounts with a differing bill number are counted
 * here like any other, and are not marked out.
 */
export default function ResultsTable({
  rows,
  status,
  batchId,
  onSent,
  multiMode,
  selected,
  onToggleRow,
}) {
  const { can } = useAuth();

  // Three layouts out of two questions: which report's columns does this tab
  // carry?
  //
  // `showGrnSide` is the stores' side -- Warehouse and Total Amount. Pending
  // has nothing else, and Valid GRNS deliberately drops them, so that no
  // column on the accounts tab is the stores' number. Total GRNS keeps them,
  // because on a mixed list they are the only identity and the only money
  // figure a pending row has.
  //
  // `showAgeing` is the accounts side -- the ageing amounts and the CSD
  // controls, which only a GRN that reached accounts can use at all. Division
  // is neither: it is on every tab, since a Pending row's is resolved from
  // configuration rather than read off an ageing entry.
  //
  // Total GRNS shows both, which is what makes it the widest tab; it is also
  // the only one whose rows are not all of a kind, so it alone leads with a
  // Match column saying which bucket each row is in.
  const isAll = status === ALL;
  const isPending = status === 'PENDING';
  const showGrnSide = isPending || isAll;
  const showAgeing = !isPending;
  // Which GRN is in flight, and which have landed since this table was drawn.
  //
  // Whether a GRN is queued is the server's answer -- it arrives on the row as
  // csdSent -- so `justSent` is only there to bridge the gap between the POST
  // resolving and the reload finishing, which would otherwise show the button
  // springing back to "Send to CSD" for a moment.
  const [busy, setBusy] = useState(null);
  const [justSent, setJustSent] = useState(() => new Set());
  const [justFiled, setJustFiled] = useState(() => new Set());
  const [error, setError] = useState('');
  // The row ForwardDetailsDialog is open for, or null, and which of its two
  // destinations (VENDOR or OTHERS) it was opened for. Its own error is kept
  // apart from the table's: a rejected submit has to stay on the dialog where
  // the fields are, not flash below a table the dialog is covering.
  const [forwardFormRow, setForwardFormRow] = useState(null);
  const [forwardFormTo, setForwardFormTo] = useState(null);
  const [forwardFormError, setForwardFormError] = useState('');

  // The header row below, counted. Seven columns every layout shares --
  // Division through Vendor Code -- and the rest by the same two flags. Kept
  // in step by hand; it is only read to span the "nothing found" row across
  // the full width.
  const columnCount =
    (multiMode && showAgeing ? 1 : 0) + // bulk-select checkbox
    (isAll ? 1 : 0) + // Match
    (showGrnSide ? 1 : 0) + // Warehouse
    7 + // Division, GRN No, GRN Date, Bill No, Bill Date, Vendor, Vendor Code
    // Bill.Amount, Transport Amount, Total Amount, Add.Amount, Ded.Amount
    (showGrnSide ? 5 : 0) +
    // Focus doc_no, the amounts, Cheque No, Cheque Date, Account No, Action, Status
    (showAgeing ? AMOUNT_COLUMNS.length + 6 : 0);

  const isSent = (row) => row.csdSent || justSent.has(row.dprNo);
  const isFiled = (row) => row.recordsSent || justFiled.has(row.dprNo);

  /**
   * Whether a row may show the bulk-select checkbox at all: the same rows the
   * single-row dropdown offers "Send to CSD" on -- reached accounts, not
   * already sent or filed, not past CSD already. Grouping ticked rows by
   * cheque number, and the send itself, are Results.jsx's own doing -- see
   * canBulkSelect there -- this only decides whether the box is there to tick.
   */
  const canBulkSelect = (row) =>
    can('csd') && row.status !== 'PENDING' && row.csdStage !== 'MOVED_TO_ACCOUNTS' && !isSent(row) && !isFiled(row);

  /**
   * Send one GRN to its destination.
   *
   * The whole row goes to the server either way, which is what lets the two
   * calls read alike here. CSD keeps its own snapshot of the fields its queue
   * holds -- a handover has to still read correctly once this upload has been
   * deleted or replaced by next month's -- while Records keeps only the GRN
   * number, having no screen to read anything back on.
   */
  async function send(row, destination) {
    setBusy(row.dprNo);
    setError('');
    const payload = { ...row, batchId: typeof batchId === 'number' ? batchId : null };
    try {
      if (destination === SEND_RECORDS) {
        await api.sendToRecords(payload);
        setJustFiled((prev) => new Set(prev).add(row.dprNo));
      } else {
        await api.sendToCsd(payload);
        setJustSent((prev) => new Set(prev).add(row.dprNo));
      }
      // Let the page reload, so the row carries the server's own answer from
      // here on and the CSD screen's count is not stale behind this one.
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Accounts' one move on a GRN CSD has handed back: acknowledge it. Keyed on
   * the CSD dispatch id, not the GRN number -- that is what the endpoint
   * addresses, and it is the same id whichever tab this table is showing.
   */
  async function receiveAccounts(row) {
    setBusy(row.dprNo);
    setError('');
    try {
      await api.receiveAccountsReturn(row.csdDispatchId);
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  /** Bank: nothing further to say, so this acts the moment it is picked. */
  async function forwardSimple(row, to) {
    setBusy(row.dprNo);
    setError('');
    try {
      await api.forwardAccountsReturn(row.csdDispatchId, { to });
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  /** Vendor, Others or Courier: the dialog's own submit, once its fields are in. */
  async function submitForwardForm({ route, name, mobile, date, courierName, docketNo }) {
    const row = forwardFormRow;
    const to = forwardFormTo;
    setBusy(row.dprNo);
    setForwardFormError('');
    try {
      await api.forwardAccountsReturn(row.csdDispatchId, {
        to,
        ...(to === 'VENDOR' ? { route } : {}),
        ...(to === 'COURIER' ? { courierName, docketNo } : { name, mobile, date }),
      });
      setForwardFormRow(null);
      onSent?.();
    } catch (err) {
      setForwardFormError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="table-wrap table-wrap--sticky">
      <table className={multiMode && showAgeing ? 'table table--pinned-select' : 'table'}>
        <thead>
          <tr>
            {multiMode && showAgeing && (
              <th
                className="table__select table__pin table__pin--select"
                aria-label="Select for bulk send"
              />
            )}
            {isAll && <th>Match</th>}
            {showGrnSide && <th>Warehouse</th>}
            {/* One column on every tab: the ageing report's own DivisionCode
                where the row has one, and the configuration screen's resolved
                branch code where it does not -- a Pending row has no ageing
                entry to read a DivisionCode off. See branchDivisionCode on
                the server. Pinned alongside GRN No -- see .table__pin in
                styles.css -- since the two together are what a row is looked
                up by once the table is scrolled sideways. */}
            <th className="table__pin table__pin--division">Division</th>
            <th className="table__pin table__pin--grn">GRN No</th>
            <th>GRN Date</th>
            <th>Bill No</th>
            <th>Bill Date</th>
            <th>Vendor</th>
            {/* The code used to sit under the name and was not shown at all.
                Both are columns now: a code tucked under a name cannot be read
                down the column or lined up against the row above it, which is
                the whole reason for having it beside the name. */}
            <th>Vendor Code</th>
            {/* The GRN report's own amount breakdown, in its source order --
                Bill.Amount and Transport Amount make up Total Amount, and
                Add.Amount / Ded.Amount adjust it further. A Pending row is
                read straight off this report, so all five are worth showing
                rather than only the total they arrive at. */}
            {showGrnSide && <th className="table__num">Bill.Amount</th>}
            {showGrnSide && <th className="table__num">Transport Amount</th>}
            {showGrnSide && <th className="table__num">Total Amount</th>}
            {showGrnSide && <th className="table__num">Add.Amount</th>}
            {showGrnSide && <th className="table__num">Ded.Amount</th>}
            {showAgeing && <th>Focus doc_no</th>}
            {showAgeing &&
              AMOUNT_COLUMNS.map((c) => (
                <th key={c.key} className="table__num">
                  {c.label}
                </th>
              ))}
            {showAgeing && <th>Cheque No</th>}
            {/* The day the cheque was cut, off the ageing report -- beside the
                cheque it belongs to, and not to be read as the day it cleared.
                That is the bank's answer, and it is in Status. */}
            {showAgeing && <th>Cheque Date</th>}
            {/* The account the branch banks through, off the configuration
                screen rather than off any of the three reports -- so it sits
                after the cheque, as the account that cheque was drawn on. */}
            {showAgeing && <th>Account No</th>}
            {showAgeing && <th>Action</th>}
            {showAgeing && <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {/* The header stays: which columns a tab has is worth seeing even when
              nothing matches, and the table not vanishing keeps the page from
              jumping as a search is typed. */}
          {rows.length === 0 && (
            <tr>
              <td className="table__empty" colSpan={columnCount}>
                Matches not found
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.dprNo}>
              {multiMode && showAgeing && (
                <td className="table__select table__pin table__pin--select">
                  {canBulkSelect(row) && (
                    <input
                      type="checkbox"
                      checked={selected.has(row.dprNo)}
                      onChange={() => onToggleRow(row)}
                      aria-label={`Select GRN ${row.dprNo} for bulk send to CSD`}
                    />
                  )}
                </td>
              )}
              {isAll && (
                <td>
                  <MatchState status={row.status} />
                </td>
              )}
              {showGrnSide && <td>{row.warehouse}</td>}
              <td className="table__mono table__pin table__pin--division">
                {row.divisionCode || row.branchDivisionCode || (
                  <span className="table__miss">&mdash;</span>
                )}
              </td>
              <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
              <td>{formatDate(row.dprDate)}</td>
              <td className="table__mono">{row.billNo}</td>
              <td>{formatDate(row.billDate)}</td>
              <td>{row.vendorName}</td>
              <td className="table__mono">
                {row.vendorCode || <span className="table__miss">&mdash;</span>}
              </td>
              {showGrnSide && <td className="table__num">{formatAmountOrDash(row.billAmount)}</td>}
              {showGrnSide && (
                <td className="table__num">{formatAmountOrDash(row.transportAmount)}</td>
              )}
              {showGrnSide && <td className="table__num">{formatAmount(row.totalAmount)}</td>}
              {showGrnSide && <td className="table__num">{formatAmountOrDash(row.addAmount)}</td>}
              {showGrnSide && <td className="table__num">{formatAmountOrDash(row.dedAmount)}</td>}
              {showAgeing && (
                <td className="table__mono">
                  {row.ageingGrnNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {showAgeing &&
                AMOUNT_COLUMNS.map((c) => (
                  <td key={c.key} className="table__num">
                    {/* A pending row has no ageing entry, so these are not
                        zero -- there is no figure. A dash says that; 0.00 would
                        claim the vendor is owed nothing. */}
                    {row[c.key] === null || row[c.key] === undefined ? (
                      <span className="table__miss">&mdash;</span>
                    ) : (
                      formatAmount(row[c.key])
                    )}
                  </td>
                ))}
              {showAgeing && (
                <td className="table__mono">
                  {row.chequeNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {showAgeing && (
                <td>{formatDate(row.chqDate) || <span className="table__miss">&mdash;</span>}</td>
              )}
              {showAgeing && (
                <td className="table__mono">
                  {/* Blank when the row's branch has no account recorded, or
                      no configured branch claims it -- there is nothing to
                      show, and a dash says so as it does everywhere else. */}
                  {row.accountNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {/* A pending GRN has no ageing entry, so there is nothing to
                  hand over and nothing for CSD to have done with it. On Total
                  GRNS those two cells are dashes rather than a disabled button
                  and a "Not sent" pill, which would both read as a step not yet
                  taken when it is one that cannot be. */}
              {showAgeing && (
                <td>
                  {row.status === 'PENDING' ? (
                    <span className="table__miss" title="Not in the ageing report yet — nothing to hand over">
                      &mdash;
                    </span>
                  ) : row.csdStage === 'MOVED_TO_ACCOUNTS' ? (
                    <AccountsStagePicker
                      row={row}
                      busy={busy === row.dprNo}
                      onReceive={receiveAccounts}
                      onForwardSimple={forwardSimple}
                      onOpenForwardForm={(r, to) => {
                        setForwardFormError('');
                        setForwardFormRow(r);
                        setForwardFormTo(to);
                      }}
                    />
                  ) : (
                    <SendPicker
                      row={row}
                      sent={isSent(row)}
                      filed={isFiled(row)}
                      busy={busy === row.dprNo}
                      canCsd={can('csd')}
                      onSend={send}
                    />
                  )}
                </td>
              )}
              {showAgeing && (
                <td>
                  {row.status === 'PENDING' ? (
                    <span className="table__miss">&mdash;</span>
                  ) : (
                    <RowStatus
                      sent={isSent(row)}
                      stage={row.csdStage}
                      accountsStage={row.csdAccountsStage}
                      forwardedTo={row.csdForwardedTo}
                      forwardedRoute={row.csdForwardedRoute}
                      forwardedName={row.csdForwardedName}
                      forwardedMobile={row.csdForwardedMobile}
                      forwardedDate={row.csdForwardedDate}
                      forwardedCourierName={row.csdForwardedCourierName}
                      forwardedDocketNo={row.csdForwardedDocketNo}
                      filed={isFiled(row)}
                      clearedOn={row.chequeClearedOn}
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {forwardFormRow && (
        <ForwardDetailsDialog
          row={forwardFormRow}
          to={forwardFormTo}
          busy={busy === forwardFormRow.dprNo}
          error={forwardFormError}
          onSubmit={submitForwardForm}
          onClose={() => setForwardFormRow(null)}
        />
      )}
    </>
  );
}
