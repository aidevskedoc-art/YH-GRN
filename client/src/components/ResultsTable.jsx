import { useState } from 'react';
import { api } from '../api/client.js';
import { IconCheck, IconSend } from './icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';

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
 * had a differing bill number or vendor spelling -- it is stored, and the CSD
 * screen still reads it -- but this table does not report it: a GRN found in
 * the ageing report has moved to accounts, and how the two sheets spell the
 * vendor is not a fact about the GRN. So both matched statuses read the same
 * here, and Remarks below no longer carries the note either.
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
function RowStatus({ sent, stage, filed, clearedOn }) {
  // Records has no stages, so there is one thing to say about it and this is
  // it. A GRN cannot be at both destinations -- the dropdown that sends it goes
  // away once it has gone -- so the two never have to be shown together.
  const destination = sent
    ? CSD_STAGES[stage] || CSD_STAGES.QUEUED
    : filed
      ? RECORDS_STATE
      : null;

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
  return <span className={`pill pill--${destination.tone}`}>{destination.label}</span>;
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
 * The rows that reached accounts with a differing bill number or vendor
 * spelling are counted here like any other, and are not marked out: the
 * difference is between how two sheets spell a name, not between two GRNs.
 * Remarks is left to the cheque that came back.
 */
export default function ResultsTable({ rows, status, batchId, onSent }) {
  const { can } = useAuth();

  // Three layouts out of two questions: which report's columns does this tab
  // carry?
  //
  // `showGrnSide` is the stores' side -- Warehouse and Total Amount. Pending
  // has nothing else, and Valid GRNS deliberately drops both, so that no column
  // on the accounts tab is the stores' number. Total GRNS keeps them, because
  // on a mixed list they are the only identity and the only money figure a
  // pending row has.
  //
  // `showAgeing` is the accounts side -- Division, the ageing amounts, and the
  // CSD controls, which only a GRN that reached accounts can use at all.
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

  // The header row below, counted. Seven columns every layout shares -- GRN No
  // through Location -- and the rest by the same two flags. Kept in step by hand;
  // it is only read to span the "nothing found" row across the full width.
  const columnCount =
    (isAll ? 1 : 0) + // Match
    (showGrnSide ? 1 : 0) + // Warehouse
    (showAgeing ? 1 : 0) + // Division
    7 + // GRN No, GRN Date, Bill No, Bill Date, Vendor, Vendor Code, Location
    (showGrnSide ? 1 : 0) + // Total Amount
    // Focus doc_no, the amounts, Cheque No, Cheque Date, Account No, Remarks,
    // Action, Status
    (showAgeing ? AMOUNT_COLUMNS.length + 7 : 0);

  const isSent = (row) => row.csdSent || justSent.has(row.dprNo);
  const isFiled = (row) => row.recordsSent || justFiled.has(row.dprNo);

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

  return (
    <>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="table-wrap table-wrap--sticky">
      <table className="table">
        <thead>
          <tr>
            {isAll && <th>Match</th>}
            {showGrnSide && <th>Warehouse</th>}
            {showAgeing && <th>Division</th>}
            <th className="table__pin">GRN No</th>
            <th>GRN Date</th>
            <th>Bill No</th>
            <th>Bill Date</th>
            <th>Vendor</th>
            {/* The code used to sit under the name and Location was not shown
                at all. Both are columns now: a code tucked under a name cannot
                be read down the column or lined up against the row above it,
                which is the whole reason for having it beside the name. */}
            <th>Vendor Code</th>
            <th>Location</th>
            {showGrnSide && <th className="table__num">Total Amount</th>}
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
            {showAgeing && <th>Remarks</th>}
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
              {isAll && (
                <td>
                  <MatchState status={row.status} />
                </td>
              )}
              {showGrnSide && <td>{row.warehouse}</td>}
              {showAgeing && (
                <td>{row.divisionCode || <span className="table__miss">&mdash;</span>}</td>
              )}
              <td className="table__mono table__pin">{row.dprNo}</td>
              <td>{formatDate(row.dprDate)}</td>
              <td className="table__mono">{row.billNo}</td>
              <td>{formatDate(row.billDate)}</td>
              <td>{row.vendorName}</td>
              <td className="table__mono">
                {row.vendorCode || <span className="table__miss">&mdash;</span>}
              </td>
              <td>{row.location || <span className="table__miss">&mdash;</span>}</td>
              {showGrnSide && <td className="table__num">{formatAmount(row.totalAmount)}</td>}
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
              {showAgeing && (
                <td>
                  {/* A cheque that went out and came back, and nothing else.
                      This cell used to carry the bill-number and vendor-spelling
                      differences too; those are no longer reported here (see
                      MATCH_STATES), which leaves the column to the one remark
                      that is about the money rather than about the paperwork. */}
                  {row.chequeStatus === 'RETURNED' ? (
                    <span
                      className="pill pill--rejected"
                      title={`Cheque ${row.chequeNo} went out and came back — the bank statement shows it returned.`}
                    >
                      Cheque returned
                    </span>
                  ) : (
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
    </>
  );
}
