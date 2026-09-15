import { useState } from 'react';
import { api } from '../api/client.js';
import { IconCheck, IconSend, IconUndo } from './icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Sheet from './Sheet.jsx';
import { chequePrepared } from '../services/cheque.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { ACCOUNTS_CHEQUE_VIEW, ACCOUNTS_GRN_VIEW, canHandToCsd } from '../services/resultsViews.js';

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
  QUEUED: { label: 'Handover by CSD', tone: 'moved_to_accounts' },
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

/** How much of a remark shows before the rest goes behind Read more. */
const REMARK_PREVIEW_CHARS = 20;

/**
 * A remark, cut short with the rest one click away.
 *
 * The reason CSD rejected a bill is a sentence somebody wrote for somebody
 * else to act on, so it cannot be reduced to a tooltip -- but at full length on
 * every rejected row it pushes the rows apart and makes the column hard to
 * read down. So twenty characters show, and the rest opens on request.
 *
 * A flat character count, not a line clamp measured against the rendered box.
 * Twenty characters is the rule as asked for: it is the same preview on every
 * row whatever the column happens to be doing, and whether the button appears
 * is decided by the text itself rather than by what the browser made of it.
 *
 * Its own component because the open/closed state is per remark: opening one
 * must not open the rest of the column. A remark inside the limit gets no
 * button -- there is nothing behind it to read.
 */
export function Remark({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > REMARK_PREVIEW_CHARS;

  return (
    <div className="table__sub table__wrap">
      {/* trimEnd, so the ellipsis never follows a space. */}
      {open || !long ? text : `${text.slice(0, REMARK_PREVIEW_CHARS).trimEnd()}…`}
      {long && (
        <>
          {' '}
          <button
            type="button"
            className="table__more"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? 'Read less' : 'Read more'}
          </button>
        </>
      )}
    </div>
  );
}

/** dd-MM-yyyy from a timestamptz, in the browser's own zone. */
function formatStamp(value) {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB') : '';
}

/**
 * "CSD rejected this before, and here is why" -- the line under a GRN that has
 * been round once already.
 *
 * A reopened GRN reads as unsent, and a re-sent one as an ordinary handover:
 * in neither case does anything else on the row say it has a history. That
 * history is exactly what somebody about to send it, or about to rule on it,
 * wants to know.
 *
 * Suppressed by the caller while the GRN is rejected RIGHT NOW -- the current
 * reason is already on the row, and two reasons stacked under one pill is a
 * cell nobody reads. Shown with no reason at all where the rejection predates
 * the day reasons were asked for: that it was turned down before is worth
 * saying on its own.
 */
export function PriorRejection({ prior }) {
  return (
    <div className="table__sub table__prior">
      <span className="table__prior-tag">Rejected before</span>{' '}
      {formatStamp(prior.rejectedAt)}
      {/* Remark is a block of its own, so the reason sits on the line under
          the tag rather than being run on after it with a dash. */}
      {prior.remarks && <Remark text={prior.remarks} />}
    </div>
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
function RowStatus({ sent, stage, accountsStage, forwardedTo, forwardedRoute, forwardedName, forwardedMobile, forwardedDate, forwardedCourierName, forwardedDocketNo, forwardedRemarks, rejectRemarks, priorRejection, filed, clearedOn }) {
  // Only where there is no current one -- see PriorRejection.
  const prior = !rejectRemarks && priorRejection ? priorRejection : null;
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
  // OTHERS adds its own remark, since there is no vendor record or department
  // name behind that door to say what it actually was. Courier gets the same
  // treatment with its own two fields in place of a person's name and mobile
  // number, plus the same day every hand-off but Bank records.
  const forwardHint =
    forwardedTo === 'VENDOR' || forwardedTo === 'OTHERS'
      ? `Handed to ${forwardedName}, ${forwardedMobile}, on ${formatDate(forwardedDate)}` +
        (forwardedTo === 'OTHERS' && forwardedRemarks ? ` — ${forwardedRemarks}` : '')
      : forwardedTo === 'COURIER'
        ? `Handed to ${forwardedCourierName}, docket ${forwardedDocketNo}, on ${formatDate(forwardedDate)}`
        : undefined;

  if (clearedOn) {
    return (
      <>
        <span className="pill pill--approved" title={`Cleared by the bank on ${formatDate(clearedOn)}`}>
          Cheque cleared
        </span>
        {destination && <div className="table__sub">{destination.label}</div>}
        {prior && <PriorRejection prior={prior} />}
      </>
    );
  }

  if (!destination) {
    return (
      <>
        <span className="pill pill--unsent">Not sent</span>
        {/* The whole point of keeping the history: a GRN reopened by a new
            upload reads as unsent, and this is the only thing on the row that
            says it has been round before. */}
        {prior && <PriorRejection prior={prior} />}
      </>
    );
  }
  return (
    <>
      <span className={`pill pill--${destination.tone}`} title={forwardHint || rejectRemarks || undefined}>
        {destination.label}
      </span>
      {/* Why CSD rejected it. The reason is the whole point of a rejection
          from this side -- it is what Accounts have to act on -- so it reads
          in the cell rather than only on hover, cut to a couple of lines with
          the rest behind Read more. Only a rejected GRN carries one; see
          reject_remarks in schema.sql. */}
      {rejectRemarks && <Remark text={rejectRemarks} />}
      {prior && <PriorRejection prior={prior} />}
    </>
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

/**
 * The CSD stages a handover can still be taken back from -- kept in step by
 * hand with TAKE_BACK_STAGES in routes/csd.js, which is what actually refuses
 * the ones that cannot.
 *
 * While CSD have only queued or received it, nothing of theirs is undone by
 * recalling it. Once they have approved or rejected it they have answered, and
 * the answer is not this screen's to delete.
 */
const TAKE_BACK_STAGES = ['QUEUED', 'RECEIVED'];

/**
 * Whether the Take back option is offered on a row that has gone to CSD.
 *
 * Needs the dispatch's own id, which is what the endpoint addresses -- a row
 * still showing as sent from the optimistic flag set a moment ago has not been
 * reloaded yet and has no id to send, so it waits for the reload rather than
 * offering a button that cannot work.
 *
 * Records is not takeable-back at all: it keeps only the GRN number and has no
 * screen to take anything back from.
 */
function canTakeBack(row, canCsd) {
  return Boolean(
    canCsd && row.csdDispatchId && TAKE_BACK_STAGES.includes(row.csdStage || 'QUEUED'),
  );
}

/**
 * `grouped` is whether the chosen action will carry the rest of the row's
 * cheque with it (see chequeGroup). It changes no behaviour here; it is only
 * so the control can say what it is about to do, since a dropdown sitting on
 * one row that quietly acts on fifteen of them is the kind of surprise this
 * column cannot afford.
 *
 * Whether, not how many. How many is only known once the server has been
 * asked, and asking on every row of every render to fill in a tooltip would
 * be a request per row for a number nobody has looked at yet.
 */
function SendPicker({ row, sent, filed, busy, canCsd, chequeReady, grouped = false, onSend, onTakeBack }) {
  // Sent to CSD and still recallable -- the GRN went by mistake and CSD have
  // not acted on it yet.
  //
  // A plain Take back button. It used to be a dropdown resting on "Sent" with
  // Take back as its second option, which read as a label rather than a
  // control and left people unsure what to do with it. The Status column
  // beside this one already says it was sent, and pressing the button still
  // asks for confirmation before anything is taken back (see takeBack).
  if (sent && canTakeBack(row, canCsd)) {
    return (
      <button
        type="button"
        className="csd csd--take-back csd--recall"
        disabled={busy}
        onClick={() => onTakeBack(row)}
        aria-label={`Take GRN ${row.dprNo} back off the CSD queue`}
        title={
          grouped
            ? `GRN ${row.dprNo} is in the CSD queue. Taking it back takes every GRN paid by cheque ${row.chequeNo} back with it.`
            : `GRN ${row.dprNo} is in the CSD queue. Take it back while CSD have not acted on it.`
        }
      >
        <span className="csd__icon">
          <IconUndo size={14} />
        </span>
        {busy ? 'Taking back…' : 'Take back'}
      </button>
    );
  }

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

  /*
   * The two destinations are not gated alike, and the difference is the cheque.
   *
   * CSD are handed a cheque to take round, so a bill with none drawn up yet has
   * nothing to give them -- that option stays shut until the ageing report
   * fills one of the three cheque columns in. Records is a filing cabinet: a
   * bill reached accounts, accounts are done with it, and it goes on file
   * whether or not anybody ever wrote a cheque for it. Plenty never will --
   * a bill settled some other way, or one closed off -- and those are exactly
   * the rows that were stuck with no action at all while the whole picker was
   * disabled for want of a cheque.
   *
   * So the picker opens on every row that has reached accounts, and says per
   * option what is and is not available. `groupNote` is dropped from a
   * no-cheque row's wording because there is no group: chequePrepared is false
   * only when all three cheque columns are empty, the cheque number among
   * them, so chequeGroup has nothing to gather it by and files the one row.
   */
  const groupNote =
    grouped && chequeReady
      ? ` — this sends every GRN paid by cheque ${row.chequeNo}, not just this one`
      : '';
  const where = chequeReady ? 'to CSD or to Records' : 'to Records';

  return (
    <select
      className="stage-select send-select"
      value=""
      onChange={(e) => e.target.value && onSend(row, e.target.value)}
      aria-label={`Send GRN ${row.dprNo} ${where}${groupNote}`}
      title={`Send GRN ${row.dprNo} ${where}${groupNote}`}
    >
      <option value="">Send to…</option>
      {/* Two reasons this one can be shut, and it says which.
 
          No cheque prepared: there is nothing to hand over yet. It is the row
          that is not ready, and the ageing report's next upload may well make
          it so.

          No access: an account holding none of the CS Department, Results or
          Accounts screens cannot hand a GRN over -- see canHandToCsd, and
          CSD_HANDOVER in routes/csd.js. It is the account that cannot, not the
          row.

          Either way the option stays, disabled, rather than being dropped: the
          row still reads as one that COULD go to CSD, and says plainly why it
          is not going there now. Records needs neither -- it is gated on the
          results screen, which anyone looking at this table already has. */}
      <option value={SEND_CSD} disabled={!canCsd || !chequeReady}>
        {!canCsd
          ? 'Send to CSD — no access'
          : !chequeReady
            ? 'Send to CSD — no cheque yet'
            : 'Send to CSD'}
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
function AccountsStagePicker({ row, busy, grouped = false, onReceive, onForwardSimple, onOpenForwardForm }) {
  const accountsStage = row.csdAccountsStage || 'QUEUED';
  // Same job as SendPicker's own -- say what the move actually moves.
  const groupNote = grouped
    ? ` — this moves every GRN paid by cheque ${row.chequeNo}, not just this one`
    : '';

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
          if (value === 'VENDOR' || value === 'COURIER') onOpenForwardForm(row, value);
          else if (value === 'BANK') onForwardSimple(row, value);
        }}
        aria-label={`Send GRN ${row.dprNo} on to its next destination${groupNote}`}
        title={`Send GRN ${row.dprNo} on to its next destination${groupNote}`}
      >
        <option value="RECEIVED">Received</option>
        <option value="BANK">Send to Bank</option>
        {/* Others lives inside this dialog now -- see the Where select in
            ForwardDetailsDialog -- rather than as a destination of its own
            here, since it is really a third door alongside Vendor and
            Purchase Department. */}
        <option value="VENDOR">Send to Vendor</option>
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
      aria-label={`Acknowledge GRN ${row.dprNo} as received by Accounts${groupNote}`}
      title={`Acknowledge GRN ${row.dprNo} as received by Accounts${groupNote}`}
    >
      <option value="QUEUED">Queued</option>
      <option value="RECEIVED">Received</option>
    </select>
  );
}

/**
 * Send to Vendor and Send to Courier both open this dialog rather than acting
 * immediately, because a hand-off to a person or a service needs who took it,
 * on what number (or docket), and on what day before it means anything --
 * unlike Bank, which has no such record to collect and so still acts on
 * selection.
 *
 * Vendor carries a further choice on top of that: which of its three doors
 * the GRN went out of -- the vendor itself, the purchase department that
 * stands in for it, or Others, for a destination that is neither. That field
 * is left unchosen at first rather than defaulting to one of the three --
 * picking one is what reveals the fields below it, which is the closest a
 * plain form gets to a nested dropdown. Others is a door alongside the other
 * two rather than a destination of its own for the same reason Purchase
 * Department is: neither is a vendor record, but both are still something
 * accounts hands the GRN off through on the vendor's side of the ledger, and
 * Others additionally carries a remark, since there is no vendor record or
 * department name behind it to say what it actually was.
 *
 * `subject` names what is being sent -- "GRN 100234" for a single row, or
 * "12 GRNs" for a bulk send from the toolbar's own "Select multiple" -- and is
 * the only thing that differs between the two: the same fields, the same
 * validation and the same submit shape apply whether the answer is written to
 * one dispatch or copied across several. Exported so Results.jsx can reuse it
 * for its own bulk dialog rather than keeping a second copy of these fields.
 */
export function ForwardDetailsDialog({ subject, to, busy, error, onSubmit, onClose }) {
  const isVendor = to === 'VENDOR';
  const isCourier = to === 'COURIER';
  const [route, setRoute] = useState('');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [date, setDate] = useState('');
  const [courierName, setCourierName] = useState('');
  const [docketNo, setDocketNo] = useState('');
  const [remarks, setRemarks] = useState('');

  const othersChosen = isVendor && route === 'OTHERS';

  // Vendor's fields wait on the door being chosen -- Vendor, Purchase
  // Department or Others all reveal the same three below. Courier has no
  // door and none of these -- it gets its own pair, plus the shared Date.
  const showFields = isVendor && route;
  const label = isCourier ? 'Courier' : othersChosen ? 'Others' : 'Vendor';

  return (
    <Sheet label={`Send ${subject} to ${label}`} narrow onClose={busy ? () => {} : onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ route, name, mobile, date, courierName, docketNo, remarks });
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
                <option value="OTHERS">Others</option>
              </select>
            </label>
          )}

          {/* Only once a door is chosen -- see the note above the component. */}
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
                  maxLength={12}
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
                  lang="en-GB"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </label>

              {/* Others alone: there is no vendor record or department name
                  behind this door, so a remark is what explains it. */}
              {othersChosen && (
                <label className="field">
                  <span className="field__label">Remarks</span>
                  <textarea
                    className="field__input"
                    rows={3}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    required
                  />
                </label>
              )}
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

              <label className="field">
                <span className="field__label">Date</span>
                <input
                  className="field__input"
                  type="date"
                  lang="en-GB"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
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
  // The Accounts Department's GRN / Cheque view (see ACCOUNTS_GRN_VIEW in
  // services/resultsViews.js), or undefined for every column at once, which is
  // how the results screen shows the Accounts view.
  accountsView,
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
  // Cheque view: a row per cheque, so the per-GRN columns -- GRN No and Date,
  // Bill No and Date, Focus doc_no and the ageing amounts -- give way to the
  // cheque's own summed Cheque Amount. GRN view is the other way round: the
  // cheque's four columns are left off.
  const byCheque = showAgeing && accountsView === ACCOUNTS_CHEQUE_VIEW;
  const showGrnDetail = !byCheque;
  const showChequeDetail = showAgeing && accountsView !== ACCOUNTS_GRN_VIEW;
  // Which GRNs are in flight, and which have landed since this table was drawn.
  //
  // A set rather than one GRN number: every action in this column now acts on
  // the whole cheque group the row belongs to (see chequeGroup below), so the
  // pickers on all of those rows have to read as busy at once rather than only
  // the one that was used.
  //
  // Whether a GRN is queued is the server's answer -- it arrives on the row as
  // csdSent -- so `justSent` is only there to bridge the gap between the POST
  // resolving and the reload finishing, which would otherwise show the button
  // springing back to "Send to CSD" for a moment.
  const [busy, setBusy] = useState(() => new Set());
  const [justSent, setJustSent] = useState(() => new Set());
  // Taking a GRN back off the CSD queue is the one destructive thing this
  // table does, so it asks first -- the same dialog the CSD screen's own
  // version of this action uses.
  const [confirm, confirmDialog] = useConfirm();
  const [justFiled, setJustFiled] = useState(() => new Set());
  const [error, setError] = useState('');
  // The row ForwardDetailsDialog is open for, or null, and which of its two
  // destinations (VENDOR or COURIER) it was opened for -- Others is a door
  // inside the Vendor dialog rather than a destination of its own, see the
  // note on ForwardDetailsDialog. Its own error is kept apart from the
  // table's: a rejected submit has to stay on the dialog where the fields
  // are, not flash below a table the dialog is covering.
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
    4 + // Division, GRN No (Cheque No on Cheque view), Vendor, Vendor Code
    (showGrnDetail ? 3 : 0) + // GRN Date, Bill No, Bill Date
    // Bill.Amount, Transport Amount, Total Amount, Add.Amount, Ded.Amount
    (showGrnSide ? 5 : 0) +
    // Focus doc_no and the amounts, or the Cheque Amount in their place
    (showAgeing ? (showGrnDetail ? 1 + AMOUNT_COLUMNS.length : 1) : 0) +
    // Cheque No (pinned up front on Cheque view), Cheque Date, PaymentDocNo,
    // Account No
    (showChequeDetail ? (byCheque ? 3 : 4) : 0) +
    (showAgeing ? 2 : 0); // Action, Status

  const isSent = (row) => row.csdSent || justSent.has(row.dprNo);
  const isFiled = (row) => row.recordsSent || justFiled.has(row.dprNo);

  /**
   * Where a row has got to in its own journey, as the three questions this
   * table asks of it: could it still be sent anywhere, is it a hand-back
   * Accounts has not acknowledged yet, or is it one Accounts has received and
   * not forwarded on. Only one is ever true at a time -- they are consecutive
   * steps -- even though nothing here enforces that.
   *
   * They do two jobs now. They decide whether a row may show the bulk-select
   * checkbox at all (see canBulkSelect, and Results.jsx's own copies of the
   * same three checks, which decide what ticking one is then allowed to do);
   * and they are what chequeGroup below reads to work out which same-cheque
   * rows a per-row picker should carry with it.
   *
   * `canSend` is kept apart from `canBulkCsd` because `canHandToCsd(can)` is a fact
   * about the account, not about the row: Send to Records is open to anyone
   * looking at this table, and which rows travel together is decided by what
   * the rows are, not by which of the two destinations was picked.
   *
   * There are two of the first question, because the two destinations do not
   * ask the same thing of a row. `canFile` is the part both agree on -- the row
   * reached accounts, CSD have not had it, and it has not already gone
   * somewhere -- and `canSend` is that plus a cheque, which only CSD need. See
   * the note in SendPicker for why Records does not.
   */
  const canFile = (row) =>
    row.status !== 'PENDING' &&
    row.csdStage !== 'MOVED_TO_ACCOUNTS' &&
    !isSent(row) &&
    !isFiled(row);
  const canSend = (row) =>
    canFile(row) &&
    // No cheque drawn up yet, so there is nothing to hand over -- the same bar
    // the Send picker puts on its CSD option.
    chequePrepared(row) === true;
  const canBulkCsd = (row) => canHandToCsd(can) && canSend(row);
  const canBulkReceive = (row) =>
    row.csdStage === 'MOVED_TO_ACCOUNTS' && (row.csdAccountsStage || 'QUEUED') === 'QUEUED';
  const canBulkForward = (row) =>
    row.csdStage === 'MOVED_TO_ACCOUNTS' && row.csdAccountsStage === 'RECEIVED' && !row.csdForwardedTo;
  const canBulkSelect = (row) => canBulkCsd(row) || canBulkReceive(row) || canBulkForward(row);

  /** A cheque this big would be a data problem, not a payment run. */
  const GROUP_PAGE_SIZE = 200;
  const GROUP_MAX_PAGES = 10;

  /**
   * The rows an action chosen on one row actually applies to: that row, plus
   * every other GRN the same cheque pays that is at the same point in its own
   * journey.
   *
   * A cheque pays a group of bills and moves as one thing -- it is handed to
   * CSD once, comes back once, and goes on to the bank or the vendor once --
   * so acting on one of its bills and leaving the rest behind was never the
   * intent.
   *
   * Asked of the SERVER rather than filtered out of `rows`, which is the one
   * thing this could not be done locally. The table is ordered by the GRN
   * report's serial number, so a cheque's bills are scattered the whole length
   * of it -- one real cheque here pays fifteen GRNs spread from row 155 to row
   * 2,382 of 6,621 -- and at any page size all but one of them are off screen.
   * Filtering the page found a group of one and sent a group of one, which is
   * exactly what it looked like from the outside.
   *
   * The fetch carries no other filter, so it finds the cheque's bills wherever
   * the table happens to be narrowed to at the time. Branch scope still
   * applies -- the server puts it on every query regardless of what is asked
   * for -- so this can never reach a row the account may not see.
   *
   * `eligible` is what keeps the group honest: a same-cheque bill that has
   * already been sent, or that CSD has already ruled on, is not dragged into
   * an action that would be refused for it. It is the same check the
   * bulk-select checkbox uses, so a picker and a tick build the same group.
   *
   * A row with no cheque number is its own group of one -- there is nothing to
   * group it by, and gathering every blank together would be a coincidence of
   * missing data rather than a cheque.
   */
  async function chequeGroup(row, eligible) {
    if (!row.chequeNo) return [row];

    const found = [];
    for (let page = 1; page <= GROUP_MAX_PAGES; page += 1) {
      const data = await api.results(batchId, {
        status: ALL,
        chequeNo: row.chequeNo,
        page,
        pageSize: GROUP_PAGE_SIZE,
      });
      found.push(...data.rows);
      if (page >= data.totalPages) break;
    }

    const group = found.filter(eligible);
    // The row the action was chosen on always belongs to its own group, even
    // if the fetch or the predicate disagrees -- it is what the person
    // pressed, and it is the one row whose action must not silently do
    // nothing.
    return group.some((r) => r.dprNo === row.dprNo) ? group : [row, ...group];
  }

  /** Mark a group in flight, and hand back its GRN numbers. */
  function beginBusy(group) {
    const numbers = group.map((r) => r.dprNo);
    setBusy(new Set(numbers));
    return numbers;
  }

  /**
   * Send a GRN to its destination -- and with it every other GRN the same
   * cheque pays, wherever in the table it falls, since the cheque is what is
   * actually being handed over.
   *
   * Each still goes over as its own POST; the server has no bulk endpoint.
   * Firing them together and reloading once is what makes it one action.
   *
   * The whole row goes to the server either way, which is what lets the two
   * calls read alike here. CSD keeps its own snapshot of the fields its queue
   * holds -- a handover has to still read correctly once this upload has been
   * deleted or replaced by next month's -- while Records keeps only the GRN
   * number, having no screen to read anything back on.
   */
  async function send(row, destination) {
    // Busy on the one row first, so the control it was chosen on stops
    // responding while the group is being worked out, then on the whole group
    // once it is known.
    beginBusy([row]);
    setError('');
    try {
      // Which rows travel with it depends on where it is going: a cheque is
      // handed to CSD as one thing, and filing is the same action over the same
      // group. The predicates differ only on the cheque, and only ever for a
      // row that has none -- which is a group of one anyway, having no cheque
      // number to be grouped by.
      const group = await chequeGroup(row, destination === SEND_RECORDS ? canFile : canSend);
      const numbers = beginBusy(group);
      await Promise.all(
        group.map((r) => {
          const payload = { ...r, batchId: typeof batchId === 'number' ? batchId : null };
          return destination === SEND_RECORDS ? api.sendToRecords(payload) : api.sendToCsd(payload);
        }),
      );
      const land = destination === SEND_RECORDS ? setJustFiled : setJustSent;
      land((prev) => new Set([...prev, ...numbers]));
      // Let the page reload, so the rows carry the server's own answer from
      // here on and the CSD screen's count is not stale behind this one.
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Take a GRN back off the CSD queue -- the undo for one sent by mistake.
   *
   * The dispatch row is deleted, which is what taking it back means here:
   * `csdSent` is read from that table rather than stored on the result, so the
   * GRN stops being in the queue and comes back to Accounts as one that has
   * not been handed over, Send picker and all. The CSD screen loses the row at
   * the same time, being a view of the same table.
   *
   * Confirmed, because it is destructive and silent -- nothing on either
   * screen afterwards says the GRN was ever sent. Refused by the server once
   * CSD have acted (see TAKE_BACK_STAGES in routes/csd.js); the picker is not
   * offered then either, and the two disagree only in the seconds between CSD
   * approving it and this page reloading, which is what the error is for.
   */
  async function takeBack(row) {
    // The whole cheque went over together, so the whole cheque comes back
    // together -- undoing a grouped send one row at a time would be the one
    // gesture on this column that still had to be repeated.
    beginBusy([row]);
    setError('');

    let group;
    try {
      group = await chequeGroup(row, (r) => canTakeBack(r, canHandToCsd(can)));
    } catch (err) {
      setError(err.message);
      setBusy(new Set());
      return;
    }

    const many = group.length > 1;
    const ok = await confirm({
      title: many ? `Take these ${group.length} GRNs back?` : 'Take this GRN back?',
      message: many
        ? `Cheque ${row.chequeNo} pays ${group.length} GRNs that are on the CSD queue. All of them will come off it and go back to Accounts as ones that have not been sent. They can be sent again afterwards.`
        : `GRN ${row.dprNo} will come off the CSD queue and go back to Accounts as one that has not been sent. It can be sent again afterwards.`,
      confirmLabel: 'Take back',
    });
    if (!ok) {
      setBusy(new Set());
      return;
    }

    const numbers = beginBusy(group);
    try {
      await Promise.all(group.map((r) => api.removeFromCsd(r.csdDispatchId)));
      // The optimistic flags from a send made earlier in this page's life would
      // otherwise go on claiming the rows are sent after the reload disagrees.
      setJustSent((prev) => {
        const next = new Set(prev);
        for (const dprNo of numbers) next.delete(dprNo);
        return next;
      });
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Accounts' one move on a GRN CSD has handed back: acknowledge it. Keyed on
   * the CSD dispatch id, not the GRN number -- that is what the endpoint
   * addresses, and it is the same id whichever tab this table is showing.
   */
  async function receiveAccounts(row) {
    beginBusy([row]);
    setError('');
    try {
      const group = await chequeGroup(row, canBulkReceive);
      beginBusy(group);
      await Promise.all(group.map((r) => api.receiveAccountsReturn(r.csdDispatchId)));
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /** Bank: nothing further to say, so this acts the moment it is picked. */
  async function forwardSimple(row, to) {
    beginBusy([row]);
    setError('');
    try {
      const group = await chequeGroup(row, canBulkForward);
      beginBusy(group);
      await Promise.all(group.map((r) => api.forwardAccountsReturn(r.csdDispatchId, { to })));
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Vendor or Courier: the dialog's own submit, once its fields are in.
   *
   * The dialog only ever opens for VENDOR or COURIER (see AccountsStagePicker
   * and forwardFormTo), but its "Where" select folds a third door in under
   * Vendor -- Others. That is a form-level choice, not the server's: the API
   * still knows Others as its own destination (`to: 'OTHERS'`), the same as
   * before this was nested here, so a route of OTHERS is translated back into
   * a plain destination on the way out rather than sent as `route`, which the
   * server would reject as neither VENDOR nor PURCHASE_DEPT.
   */
  async function submitForwardForm({ route, name, mobile, date, courierName, docketNo, remarks }) {
    const to = forwardFormTo === 'VENDOR' && route === 'OTHERS' ? 'OTHERS' : forwardFormTo;
    // One form, filled in once, copied onto every dispatch the same cheque
    // pays -- the bills went out of the door in one envelope, so they were
    // handed to one person on one day.
    beginBusy([forwardFormRow]);
    setForwardFormError('');
    try {
      const group = await chequeGroup(forwardFormRow, canBulkForward);
      beginBusy(group);
      await Promise.all(
        group.map((r) =>
          api.forwardAccountsReturn(r.csdDispatchId, {
            to,
            ...(to === 'VENDOR' ? { route } : {}),
            ...(to === 'OTHERS' ? { remarks } : {}),
            ...(to === 'COURIER' ? { courierName, docketNo, date } : {}),
            ...(to === 'VENDOR' || to === 'OTHERS' ? { name, mobile, date } : {}),
          }),
        ),
      );
      setForwardFormRow(null);
      onSent?.();
    } catch (err) {
      setForwardFormError(err.message);
    } finally {
      setBusy(new Set());
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
            {/* On Cheque view the cheque is what a row is looked up by, so it
                takes GRN No's pinned place. */}
            <th className="table__pin table__pin--grn">{byCheque ? 'Cheque No' : 'GRN No'}</th>
            {showGrnDetail && <th>GRN Date</th>}
            {showGrnDetail && <th>Bill No</th>}
            {showGrnDetail && <th>Bill Date</th>}
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
            {showAgeing && showGrnDetail && <th>Focus doc_no</th>}
            {showAgeing &&
              showGrnDetail &&
              AMOUNT_COLUMNS.map((c) => (
                <th key={c.key} className="table__num">
                  {c.label}
                </th>
              ))}
            {showChequeDetail && !byCheque && <th>Cheque No</th>}
            {/* The day the cheque was cut, off the ageing report -- beside the
                cheque it belongs to, and not to be read as the day it cleared.
                That is the bank's answer, and it is in Status. */}
            {showChequeDetail && <th>Cheque Date</th>}
            {/* Every PayableAmount the cheque pays, added up on the server --
                see chequeRows in routes/results.js. */}
            {byCheque && <th className="table__num">Cheque Amount</th>}
            {/* The ageing report's own reference for the payment -- "Pmt:SE1/
                26-27/RTG/929", "ADVP:..." for an advance. After the cheque
                rather than beside Focus doc_no, because it identifies the
                payment that cheque belongs to and is read with it. Off the
                report, so it is blank on a row the report has not paid yet,
                which is most of them.

                Headed as the report spells it, which is how NetAmt through
                PayableAmount beside it are headed and how every sheet of the
                export spells it -- one name for the column wherever it is
                read. */}
            {showChequeDetail && <th>PaymentDocNo</th>}
            {/* The account the branch banks through, off the configuration
                screen rather than off any of the three reports -- so it sits
                after the cheque, as the account that cheque was drawn on. */}
            {showChequeDetail && <th>Account No</th>}
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
            <tr key={byCheque ? `${row.chequeNo}:${row.dprNo}` : row.dprNo}>
              {multiMode && showAgeing && (
                <td className="table__select table__pin table__pin--select">
                  {canBulkSelect(row) && (
                    <input
                      type="checkbox"
                      checked={selected.has(row.dprNo)}
                      onChange={() => onToggleRow(row)}
                      aria-label={
                        byCheque
                          ? `Select cheque ${row.chequeNo} for a bulk action`
                          : `Select GRN ${row.dprNo} for a bulk action`
                      }
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
              {showGrnDetail && <td>{formatDate(row.dprDate)}</td>}
              {showGrnDetail && <td className="table__mono">{row.billNo}</td>}
              {showGrnDetail && <td>{formatDate(row.billDate)}</td>}
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
              {showAgeing && showGrnDetail && (
                <td className="table__mono">
                  {row.ageingGrnNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {showAgeing &&
                showGrnDetail &&
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
              {showChequeDetail && !byCheque && (
                <td className="table__mono">
                  {row.chequeNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {showChequeDetail && (
                <td>{formatDate(row.chqDate) || <span className="table__miss">&mdash;</span>}</td>
              )}
              {byCheque && <td className="table__num">{formatAmountOrDash(row.chequeAmount)}</td>}
              {showChequeDetail && (
                /* Mono, like every other identifier in this table: it is a
                   reference to be read character by character and compared,
                   not a phrase. A dash where the report carries none, which is
                   how every other unanswered cell here reads. */
                <td className="table__mono">
                  {row.paymentDocNo || <span className="table__miss">&mdash;</span>}
                </td>
              )}
              {showChequeDetail && (
                <td className="table__mono">
                  {/* Blank when the row's branch has no account recorded, or
                      no configured branch claims it -- there is nothing to
                      show, and a dash says so as it does everywhere else.
                      Also blank while no cheque has been drawn up: the
                      account is the one that cheque is drawn on, so with no
                      cheque there is no account to name yet. */}
                  {(chequePrepared(row) !== false && row.accountNo) || (
                    <span className="table__miss">&mdash;</span>
                  )}
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
                      busy={busy.has(row.dprNo)}
                      grouped={Boolean(row.chequeNo)}
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
                      busy={busy.has(row.dprNo)}
                      canCsd={canHandToCsd(can)}
                      chequeReady={chequePrepared(row) === true}
                      grouped={Boolean(row.chequeNo)}
                      onSend={send}
                      onTakeBack={takeBack}
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
                      forwardedRemarks={row.csdForwardedRemarks}
                      rejectRemarks={row.csdRejectRemarks}
                      priorRejection={row.priorRejection}
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
      {confirmDialog}
      {forwardFormRow && (
        <ForwardDetailsDialog
          /* Named for the whole cheque the submit will act on, not for the row
             the picker was used on -- a dialog headed "Send GRN 1234 to
             Vendor" that then forwards fifteen of them would be lying about
             what pressing Send does. No count: the group is only counted once
             the server has been asked, which is after this is submitted. */
          subject={
            forwardFormRow.chequeNo
              ? `every GRN on cheque ${forwardFormRow.chequeNo}`
              : `GRN ${forwardFormRow.dprNo}`
          }
          to={forwardFormTo}
          busy={busy.has(forwardFormRow.dprNo)}
          error={forwardFormError}
          onSubmit={submitForwardForm}
          onClose={() => setForwardFormRow(null)}
        />
      )}
    </>
  );
}
