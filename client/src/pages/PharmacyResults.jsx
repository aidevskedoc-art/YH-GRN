import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';
import {
  AccountsStagePicker,
  ForwardDetailsDialog,
  formatAmount,
  formatAmountOrDash,
  formatDate,
  RowStatus,
} from '../components/ResultsTable.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { IconArrowRight, IconCheck, IconSend, IconUndo, IconX } from '../components/icons.jsx';
import BackButton, { useSectionTrail } from '../components/BackButton.jsx';
import LocationFilter from '../components/LocationFilter.jsx';
import MsmeFilter from '../components/MsmeFilter.jsx';
import PairCard from '../components/PairCard.jsx';
import TurnaroundView from '../components/TurnaroundView.jsx';
import VendorCells, { VENDOR_CELL_COUNT } from '../components/VendorCells.jsx';
import ViewModeRadios from '../components/ViewModeRadios.jsx';
import { chequeNotRequired, chequePrepared, paymentNotRequired } from '../services/cheque.js';
import { expandCheques } from '../services/chequeGroups.js';
import { exportPharmacySection, turnaroundColumns, turnaroundSheetRows } from '../services/exporter.js';
import { singlePress } from '../services/press.js';
import { PHARMACY_CHAIN, spanLabel } from '../services/stages.js';
import {
  ACCOUNTS_CHEQUE_VIEW,
  ACCOUNTS_GRN_VIEW,
  ACCOUNTS_QUEUE_CARD,
  ACCOUNTS_RECEIVED_CARD,
  ACCOUNTS_ROW_GROUPS,
  ACCOUNTS_TAB,
  ALL_GRNS,
  BPAD,
  CHEQUE_CARDS,
  CHEQUE_NOT_PREPARED_ROW,
  CHEQUE_NOT_PREPARED_TAB,
  CHEQUE_NOT_PREPARED_VIEW,
  CSD_CARDS,
  IN_BPAD,
  MISSING,
  NOT_IN_BPAD,
  NOT_INTEGRATED_CARD,
  NOT_REQUIRED_PAIR,
  PROGRESS_LABELS,
  SUPPLY_TYPE_CARDS,
  TURNAROUND,
  TURNAROUND_TAB,
  VALID,
  actionFilterOptions,
  bulkCategory as bulkCategoryOf,
  bulkCsdEligible,
  bulkForwardEligible,
  bulkReceiveEligible,
  canHandToCsd,
  cardShown,
  csdCardFigures,
  deptLabel,
  isAccountsDept,
  isAccountsFromDay,
  isAccountsSection,
  notIntegratedSince,
  progressCardFigures,
  progressFilterOptions,
  sectionSheets,
  supplyCardFigure,
  tabFigure,
  tabTitle,
  titledCards,
} from '../services/resultsViews.js';
import { OP_PHARMACY_LABELS, opPharmacyPath } from '../services/screens.js';

/**
 * Pharmacy Results and Ph-Accounts: the hospital results page
 * (pages/Results.jsx) and its Accounts Department (pages/AccountsDepartment.jsx)
 * for the pharmacy uploads.
 *
 * The same pages, section for section. Pharmacy Results has the View dropdown
 * choosing between Total GRNS, BPAD, Accounts, Cheque Not Prepared, Pending
 * GRNS and the GRN age view; Ph-Accounts (`desk="accounts"`) is that page with
 * the three Accounts views only, as the hospitals' Accounts Department is.
 * Each view has its own row of cards and its own filters; Accounts has the
 * GRNs / Cheques switch; the Location dropdown, the MSME dropdown and the
 * search box are the page's scope; and a GRN that has reached accounts can be
 * sent to CSD or to Records and taken back, acknowledged by Accounts once CSD
 * hand it back, and sent on to Bank, Vendor or Courier -- one row at a time,
 * or several with Select multiple.
 *
 * It reads its cards, their wording and their figures with the helpers the
 * hospital pages read their own with (services/resultsViews.js), draws the
 * Status and the Accounts steps with the hospital table's own cells, and the
 * server answers in the hospital shapes (server/src/routes/phResults.js) -- so
 * a card, a pill or a dropdown here means what the same one means there.
 *
 * With one difference in what "pending" covers, which is the server's rule
 * (BEFORE_ACCOUNTS in phResults.js): a pharmacy GRN is matched with the BPAD
 * bill status first, while one is on file for it, and only the bills BPAD has
 * at its Accounts desk are then compared with the Vendor Age report. So Total
 * GRNS divides three ways -- Pending GRNs at GRN Store (BPAD has no entry),
 * Pending GRNs at BPAD (BPAD has it at Stores, at Audit, or at Accounts with
 * the Vendor Age report not listing it) and Accounts (BPAD has it at Accounts
 * and the Vendor Age report lists it). The BPAD view's Accounts desk card is
 * therefore the Accounts view and the Not Integrated in Accounts card, added.
 *
 * Its own file, where the CS Department screen is one screen driven through
 * either queue, because the rows are not the same: a pharmacy GRN is its
 * number AND its unit, so nothing here can be keyed, ticked or grouped by GRN
 * number alone as the hospital table does throughout. A cheque likewise is its
 * number within its unit.
 *
 * What the hospital pages have and this does not: the Ageing column and its
 * "as of" date. The GRN age view is here from the GRN onward -- a pharmacy
 * purchase has no PR, PO or security step -- with each date read from the
 * pharmacy file that has it (PH_TURNAROUND_TAB below).
 */

const SEARCH_DELAY_MS = 300;

/** The views of each desk, in its View dropdown's order -- TABS on the two hospital pages. */
const TOTAL_TAB = { status: ALL_GRNS, label: 'Total GRNS', hint: 'Pending and valid together', countKey: 'total' };
const BPAD_TAB = { status: BPAD, label: 'BPAD', hint: 'Entries in the BPAD bill status', countKey: 'bpadRegister' };
const PH_ACCOUNTS_TAB = { ...ACCOUNTS_TAB, hint: 'At Accounts in BPAD, and in the Vendor Age report' };
const PENDING_TAB = { status: 'PENDING', label: 'Pending GRNS', hint: 'Not yet in accounts' };
/**
 * The GRNs out with CSD or filed to Records that are not in Accounts: sent
 * while they were, and held before Accounts since by a later BPAD status
 * (HELD_HANDOVER in server/src/routes/phResults.js, which is the `status` the
 * rows are asked for by, and the summary's bucket of that name).
 *
 * A view of their own on both desks, since the Accounts views list the GRNs in
 * Accounts and nothing else: without it Ph-Accounts would have no row to
 * receive such a handover from, send it on from, or take it back from. Offered
 * in the View dropdown only while there are any -- there are none, nearly
 * always.
 */
const HELD_TAB = {
  status: 'HELD_HANDOVER',
  label: 'Sent, held before Accounts',
  hint: 'Handed to CSD or Records, and not in Accounts by the BPAD bill status',
};

/**
 * The GRN age view, named for the run it measures: the hospitals' is PR to
 * Bank, and a pharmacy purchase starts at the GRN (PHARMACY_CHAIN in
 * services/stages.js). Its dates come from four places -- the GRN Purchase
 * report's InvDate, the BPAD bill status's two received dates, the Vendor Age
 * report's ChqDate, and from there on the days the CSD and Accounts steps were
 * done on this application and the bank statement's clearance; see
 * TURNAROUND_DATES in server/src/routes/phResults.js.
 */
const PH_TURNAROUND_TAB = { ...TURNAROUND_TAB, label: 'GRN age from GRN to Bank' };

/**
 * The export's titles for the reports that are not the hospitals', or not
 * under the hospitals' name: the held handovers, and the GRN age report, which
 * starts at the GRN here. Every other sheet keeps the hospital report's title.
 */
const OWN_TITLES = {
  [HELD_TAB.status]: `${HELD_TAB.label} Report`,
  [TURNAROUND]: 'GRN Age From GRN to Bank Report',
};

const DESKS = {
  results: {
    tabs: [TOTAL_TAB, BPAD_TAB, PH_ACCOUNTS_TAB, CHEQUE_NOT_PREPARED_TAB, PENDING_TAB, HELD_TAB, PH_TURNAROUND_TAB],
    home: ALL_GRNS,
    // The four counts stand over the GRN age view here, as on the hospital page.
    ageCards: [ALL_GRNS, BPAD, VALID, 'PENDING'],
  },
  accounts: {
    tabs: [PH_ACCOUNTS_TAB, CHEQUE_NOT_PREPARED_TAB, HELD_TAB, PH_TURNAROUND_TAB],
    home: VALID,
    ageCards: [],
  },
};

/** Total GRNS' own filter: which half of it to show -- MATCH_FILTERS in Results.jsx. */
const MATCH_FILTERS = [
  { value: 'PENDING', label: 'Pending' },
  { value: VALID, label: 'Moved to accounts' },
];

/**
 * The Status values a row per cheque can never show: each is a bill with no
 * cheque drawn up, and the Cheques view lists cheques. While one of them is
 * chosen the Accounts table is read by GRN whatever the switch says, rather
 * than narrowed to a table that is empty by definition.
 */
const NO_CHEQUE_PROGRESS = new Set([
  'CHEQUE_NOT_PREPARED',
  'CHEQUE_NOT_REQUIRED',
  'PAYMENT_NOT_REQUIRED',
  // A cash bill: no cheque, so no row on the Cheques view either.
  'CASH_PAYMENT',
]);

/**
 * Cash Payments: every cash purchase in Accounts -- Purchase Type Cash, with
 * no cheque number on the Vendor Age report (CASH_PAYMENT and CASH_BILL in
 * server/src/routes/phResults.js). Paid on a cash voucher, or still to be.
 *
 * A card the hospital Accounts row does not have. These bills used to be
 * counted on the cheque cards: the paid ones under Cheque Prepared, which
 * reads a payment document as a cheque drawn up, and the unpaid ones under
 * Cheque Not Prepared, as if a cheque were awaited. No cheque is ever coming
 * for a cash bill, so they are taken out of all of them -- and the cheque
 * cards with this one still add up to the Accounts count over them.
 *
 * A `progress` card like the cheque ones, so pressing it narrows the Accounts
 * table to its rows and the workbook gets a sheet for it. Its rows offer Send
 * to Records and nothing else: there is no cheque to hand CSD (canSendCsd,
 * and the server's own refusal).
 *
 * The hint says what the card is made of: how many are paid and how many are
 * not yet, off the summary (cashPaymentsPaid).
 */
const CASH_PAYMENT = 'CASH_PAYMENT';
const PH_CASH_CARD = {
  progress: CASH_PAYMENT,
  label: 'Cash Payments',
  hint: (summary) => {
    const all = summary?.progress?.[CASH_PAYMENT]?.count ?? 0;
    const paid = Math.min(summary?.cashPaymentsPaid ?? 0, all);
    const unpaid = all - paid;
    const split = unpaid > 0 ? `${paid.toLocaleString('en-IN')} paid, ${unpaid.toLocaleString('en-IN')} not yet paid` : 'all paid';
    return `Purchase Type Cash, separated from the cheque cards — ${split}`;
  },
};

/** The hospitals' Accounts row and its groups, with Cash Payments after Cheque Prepared. */
const PH_ACCOUNTS_ROW_GROUPS = ACCOUNTS_ROW_GROUPS.map((group) =>
  group.ids.includes('CHEQUE_PREPARED')
    ? { ...group, ids: group.ids.flatMap((id) => (id === 'CHEQUE_PREPARED' ? [id, CASH_PAYMENT] : [id])) }
    : group,
);
const PH_ACCOUNTS_ROW = PH_ACCOUNTS_ROW_GROUPS.flatMap((group) => group.ids);

/** Which cards each view shows -- CARDS_FOR in Results.jsx, which says why each row is as it is. */
const CARDS_FOR = {
  [ALL_GRNS]: [ALL_GRNS, MISSING, BPAD, 'PENDING'],
  PENDING: ['PENDING'],
  [VALID]: PH_ACCOUNTS_ROW,
  [CHEQUE_NOT_PREPARED_VIEW]: CHEQUE_NOT_PREPARED_ROW,
  [BPAD]: [],
  [HELD_TAB.status]: [],
};

const CARD_BY_ID = Object.fromEntries([
  ...[TOTAL_TAB, BPAD_TAB, PH_ACCOUNTS_TAB, CHEQUE_NOT_PREPARED_TAB, PENDING_TAB].map((tab) => [
    tab.status,
    { kind: 'bucket', ...tab },
  ]),
  ...CSD_CARDS.map((card) => [card.stage, { kind: 'csd', ...card }]),
  ...CHEQUE_CARDS.map((card) => [card.progress, { kind: 'progress', ...card }]),
  [CASH_PAYMENT, { kind: 'progress', ...PH_CASH_CARD }],
  [NOT_REQUIRED_PAIR.id, { kind: 'pair', ...NOT_REQUIRED_PAIR }],
  [ACCOUNTS_QUEUE_CARD.progress, { kind: 'progress', ...ACCOUNTS_QUEUE_CARD }],
  [ACCOUNTS_RECEIVED_CARD.progress, { kind: 'progress', ...ACCOUNTS_RECEIVED_CARD }],
  [MISSING, { kind: 'missing', label: 'Pending GRNs at GRN Store' }],
  ...SUPPLY_TYPE_CARDS.map((card) => [card.id, { kind: 'supplyType', ...card }]),
]);

/** The two destinations a GRN in accounts can be sent to. */
const SEND_CSD = 'CSD';
const SEND_RECORDS = 'RECORDS';

/**
 * The CSD stages a handover can still be taken back from -- kept in step by
 * hand with TAKE_BACK_STAGES in server/src/routes/csd.js, which is what
 * actually refuses the ones that cannot.
 */
const TAKE_BACK_STAGES = ['QUEUED', 'RECEIVED'];

/** A cheque this big would be a data problem, not a payment run. */
const GROUP_PAGE_SIZE = 200;
const GROUP_MAX_PAGES = 10;

function count(n) {
  return Number(n ?? 0).toLocaleString('en-IN');
}

const dash = <span className="table__miss">&mdash;</span>;

/**
 * Whether a cash bill has been paid: the Vendor Age report carries its cash
 * voucher -- a payment document, or the date it was paid -- as it carries a
 * cheque's. The rule the server's cashPaymentsPaid counts by.
 */
const cashPaid = (row) => Boolean(row.paymentDocNo || row.chqDate);

/**
 * Where a row stands on its payment, in the words of the card it is counted
 * on -- the export's Cheque column. The hospital sheets' own four answers
 * (toCell's `chequePrepared` in services/exporter.js), with the one the
 * pharmacies add: a cash purchase is a cash payment -- paid, or not yet --
 * and never a cheque prepared or awaited. Null for a row not in Accounts, of
 * which none of this is asked.
 */
function paymentState(row) {
  if (row.cashPayment) return cashPaid(row) ? 'Cash payment' : 'Cash payment (not yet paid)';
  const prepared = chequePrepared(row);
  if (prepared === null) return null;
  if (prepared) return 'Prepared';
  if (chequeNotRequired(row)) return 'Cheque not required';
  return paymentNotRequired(row) ? 'Payment not required' : 'Not prepared';
}

/* ---- The export's columns, a set per layout: the table's own, as a sheet. ---- */

const VENDOR_MASTER_EXPORT = [
  { key: 'msmeNo', label: 'MSME No' },
  { key: 'msmeStatus', label: 'MSME Status' },
  { key: 'inter', label: 'Inter' },
  { key: 'supplyType', label: 'Supply Type' },
];
const GRN_EXPORT = [
  { key: 'dprNo', label: 'GRN No' },
  { key: 'dprDate', label: 'GRN Date', date: true },
  { key: 'purchaseType', label: 'Purchase Type' },
  { key: 'location', label: 'Unit' },
  { key: 'vendorName', label: 'Vendor' },
  { key: 'vendorCode', label: 'Vendor Code' },
  ...VENDOR_MASTER_EXPORT,
  { key: 'billNo', label: 'Bill No' },
  { key: 'billDate', label: 'Bill Date', date: true },
  { key: 'totalAmount', label: 'GRN Amount', numeric: true },
];
const BPAD_ANSWER_EXPORT = [
  { key: 'pendingWithDept', label: 'Pending With Dept.' },
  { key: 'pendingWithUser', label: 'Pending With User/Status' },
  { key: 'bpadReceivedDate', label: 'BPAD Received Date', date: true },
  { key: 'accountsReceivedDate', label: 'Accounts Received Date', date: true },
];
const ACCOUNTS_EXPORT = [
  { key: 'divisionCode', label: 'Division' },
  { key: 'ageingGrnDoc', label: 'Focus doc_no' },
  { key: 'netAmt', label: 'NetAmt', numeric: true },
  { key: 'adjPurReturn', label: 'AdjPurReturn', numeric: true },
  { key: 'adjustedJv', label: 'AdjustedJV', numeric: true },
  { key: 'tdsJv', label: 'TDSJV', numeric: true },
  { key: 'payableAmount', label: 'PayableAmount', numeric: true },
  { key: 'paymentDocNo', label: 'PaymentDocNo' },
  { key: 'chequeNo', label: 'Cheque No' },
  { key: 'chqDate', label: 'Cheque Date', date: true },
  { key: 'accountNo', label: 'Account No' },
  // Not the hospital sheets' `chequePrepared`, which would write "Prepared"
  // against a cash payment: the page's own word for each row -- see
  // paymentState.
  { key: 'paymentState', label: 'Cheque' },
  { key: 'chequeStatus', label: 'Bank' },
  { key: 'chequeClearedOn', label: 'Cleared On', date: true },
  { key: 'csdStage', label: 'CSD Status' },
  { key: 'recordsLabel', label: 'Records' },
];
const EXPORT_COLUMNS = {
  [ALL_GRNS]: [{ key: 'status', label: 'Status' }, ...GRN_EXPORT, ...ACCOUNTS_EXPORT, ...BPAD_ANSWER_EXPORT],
  PENDING: [...GRN_EXPORT, { key: 'divisionCode', label: 'Division' }, ...BPAD_ANSWER_EXPORT],
  [VALID]: [...GRN_EXPORT, ...ACCOUNTS_EXPORT],
  cheque: [
    { key: 'divisionCode', label: 'Division' },
    { key: 'chequeNo', label: 'Cheque No' },
    { key: 'chequeGrnCount', label: 'GRNs', integer: true },
    { key: 'location', label: 'Unit' },
    { key: 'vendorName', label: 'Vendor' },
    { key: 'vendorCode', label: 'Vendor Code' },
    ...VENDOR_MASTER_EXPORT,
    { key: 'chqDate', label: 'Cheque Date', date: true },
    { key: 'chequeAmount', label: 'Cheque Amount', numeric: true },
    { key: 'paymentDocNo', label: 'PaymentDocNo' },
    { key: 'accountNo', label: 'Account No' },
    { key: 'chequeStatus', label: 'Bank' },
    { key: 'chequeClearedOn', label: 'Cleared On', date: true },
    { key: 'csdStage', label: 'CSD Status' },
    { key: 'recordsLabel', label: 'Records' },
  ],
  [BPAD]: [
    { key: 'branchDivisionCode', label: 'Division' },
    { key: 'unitName', label: 'Unit' },
    { key: 'location', label: 'Location' },
    { key: 'warehouse', label: 'WareHouse' },
    { key: 'vendorCode', label: 'Vendor Code' },
    { key: 'vendorName', label: 'Vendor Name' },
    ...VENDOR_MASTER_EXPORT,
    { key: 'invNo', label: 'Inv.No.' },
    { key: 'invDate', label: 'Inv Date', date: true },
    { key: 'grnNo', label: 'GRN No' },
    { key: 'grnDate', label: 'GRN Date', date: true },
    { key: 'grnAmount', label: 'GRN Amount', numeric: true },
    { key: 'poNumber', label: 'PO Number' },
    { key: 'pendingWithDept', label: 'Pending With Dept.' },
    { key: 'bpadReceivedDate', label: 'BPAD Received Date', date: true },
    { key: 'accountsReceivedDate', label: 'Accounts Received Date', date: true },
    { key: 'pendingWithUser', label: 'Pending With User/Status' },
    { key: 'pendReason', label: 'Pend.Reason/Pend Dept' },
    { key: 'bpadRemarks', label: 'Remarks' },
  ],
};

/**
 * Whether the GRN has reached accounts -- the hospital table's Match cell.
 *
 * A pharmacy GRN is matched with the BPAD bill status first, while one is on
 * file for it, and only the bills BPAD has at Accounts are then compared with
 * the Vendor Age report: so one BPAD has at another desk, or has no entry for,
 * is pending even where the Vendor Age report already lists it
 * (ageingAheadOfBpad) -- and the cell says where BPAD has it, which is what it
 * is waiting on.
 */
function MatchState({ row }) {
  if (row.status === 'PENDING') {
    if (row.ageingAheadOfBpad) {
      const desk = row.inBpad && row.pendingWithDept ? deptLabel(row.pendingWithDept) : '';
      return (
        <>
          <span
            className="pill pill--pending"
            title={
              desk
                ? `The BPAD bill status has this bill at ${desk}, not yet at Accounts`
                : 'The BPAD bill status has no entry for this GRN, so it is still at the GRN store'
            }
          >
            Pending
          </span>
          <div
            className="table__sub"
            title="The Vendor Age report lists this GRN already; it is counted in Accounts once BPAD has its bill at Accounts"
          >
            {desk ? `At ${desk} in BPAD` : 'Not in BPAD yet'}
          </div>
        </>
      );
    }
    return (
      <span className="pill pill--pending" title="Not found in the Vendor Age report">
        Pending
      </span>
    );
  }
  return (
    <>
      <span className="pill pill--valid" title="Found in the Vendor Age report">
        Moved to accounts
      </span>
      {/* The one thing the two matched verdicts differ by. Said under the pill
          rather than as a third state: the GRN reached accounts either way. */}
      {row.status === 'MATCHED_WITH_DIFF' && (
        <div className="table__sub" title={row.discrepancyNotes || undefined}>
          Bill No differs
        </div>
      )}
    </>
  );
}

/**
 * The Status column: the hospital table's own cell, off the same fields. A
 * pending GRN has none -- but for one that was sent to CSD or filed to Records
 * while it was in Accounts and has been held before it since, by a later BPAD
 * status: where it went still has to be said, or nothing here would. `sent`
 * and `filed` are the row's own, or the page's word that a send has just
 * landed and the reload has not (isSent, isFiled).
 */
function StatusCell({ row, sent = row.csdSent, filed = row.recordsSent }) {
  if (row.status === 'PENDING' && !sent && !filed) return dash;
  return (
    <RowStatus
      sent={sent}
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
      filed={filed}
      clearedOn={row.chequeClearedOn}
    />
  );
}

/**
 * The Action cell while a GRN can still be sent somewhere or taken back: the
 * hospital table's SendPicker, which says why it is a dropdown resting on a
 * prompt, why the two destinations are not gated alike (CSD are handed a
 * cheque; Records is a filing cabinet), and why there is no moving a GRN
 * straight from one to the other: take it back, then send it on.
 *
 * `sent` and `filed` rather than the row's own flags: a row just sent reads as
 * sent before the reload brings its new state (isSent, isFiled on the page).
 */
function SendPicker({
  row, sent, filed, busy, canCsd, canSendCsd, canFile, canTakeBackCsd, canTakeBackFiled, onSend, onTakeBack,
}) {
  // `row` comes with the cheque it went out on even where it is held before
  // Accounts and shows none -- see withItsCheque on the page.
  const grouped = Boolean(row.chequeNo);
  const withCheque = grouped ? ` — with every GRN of this unit paid by cheque ${row.chequeNo}` : '';

  if (busy) {
    return (
      <button type="button" className="csd" disabled>
        <span className="csd__icon">
          <IconSend size={14} />
        </span>
        Working…
      </button>
    );
  }

  if (sent && canTakeBackCsd) {
    return (
      <button
        type="button"
        className="csd csd--take-back csd--recall"
        onClick={() => onTakeBack(row, SEND_CSD)}
        aria-label={`Take GRN ${row.dprNo} back off the CSD queue`}
        title={`GRN ${row.dprNo} is in the CSD queue. Take it back while CSD have not acted on it${withCheque}.`}
      >
        <span className="csd__icon">
          <IconUndo size={14} />
        </span>
        Take back
      </button>
    );
  }

  if (filed && !sent && canTakeBackFiled) {
    return (
      <button
        type="button"
        className="csd csd--take-back csd--recall"
        onClick={() => onTakeBack(row, SEND_RECORDS)}
        aria-label={`Take GRN ${row.dprNo} back from Records`}
        title={`GRN ${row.dprNo} has been sent to Records. Take it back to send it somewhere else${withCheque}.`}
      >
        <span className="csd__icon">
          <IconUndo size={14} />
        </span>
        Take back
      </button>
    );
  }

  if (sent || filed) {
    return (
      <button
        type="button"
        className="csd csd--sent"
        disabled
        title={sent ? `GRN ${row.dprNo} is in the CSD queue` : `GRN ${row.dprNo} has been sent to Records`}
      >
        <span className="csd__icon">
          <IconCheck size={14} />
        </span>
        Sent
      </button>
    );
  }

  if (!canFile) return dash;

  const where = canSendCsd ? 'to CSD or to Records' : 'to Records';
  return (
    <select
      className="stage-select send-select"
      value=""
      onChange={(e) => e.target.value && onSend(row, e.target.value)}
      aria-label={`Send GRN ${row.dprNo} ${where}${withCheque}`}
      title={`Send GRN ${row.dprNo} ${where}${withCheque}`}
    >
      <option value="">Send to…</option>
      {/* No cheque prepared: the option is left out, there being nothing to
          hand over yet. No access: it is the account that cannot, not the row,
          so the option stays, disabled, and says why. */}
      {canSendCsd && (
        <option value={SEND_CSD} disabled={!canCsd}>
          {canCsd ? 'Send to CSD' : 'Send to CSD — no access'}
        </option>
      )}
      <option value={SEND_RECORDS}>Send to Records</option>
    </select>
  );
}

/** The BPAD answer's four cells on a pending row: desk, user, and the two received dates. */
function BpadAnswerCells({ row }) {
  return (
    <>
      <td>{row.pendingWithDept ? deptLabel(row.pendingWithDept) : dash}</td>
      <td>{row.pendingWithUser || dash}</td>
      <td className="table__mono">{formatDate(row.bpadReceivedDate) || dash}</td>
      <td className="table__mono">{formatDate(row.accountsReceivedDate) || dash}</td>
    </>
  );
}

/** The Vendor Master's four headers, beside the vendor on every table -- see VendorCells. */
const VENDOR_HEADS = (
  <>
    <th>MSME No</th>
    <th>MSME Status</th>
    <th>Inter</th>
    <th>Supply Type</th>
  </>
);

/**
 * @param {'results'|'accounts'} desk which page this is: Pharmacy Results, or
 *   Ph-Accounts -- the same rows with the Accounts views only. See DESKS.
 */
export default function PharmacyResults({ desk = 'results' }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { tabs: TABS, home: HOME, ageCards } = DESKS[desk] ?? DESKS.results;

  const [summary, setSummary] = useState(null);
  // The desk's first view: the whole population on Pharmacy Results, Accounts
  // on Ph-Accounts.
  const [status, setStatus] = useState(HOME);
  // Which Status value the table is narrowed to -- a cheque card's or a CSD
  // card's key -- or '' for every row.
  const [progress, setProgress] = useState('');
  // Where the rows have got to, on top of the card: the Action dropdown.
  const [action, setAction] = useState('');
  // How the Accounts table is read: a row per GRN, or a row per cheque.
  const [accountsView, setAccountsView] = useState(ACCOUNTS_GRN_VIEW);
  // Accounts only, and not while the rows asked for are bills with no cheque
  // -- see NO_CHEQUE_PROGRESS. The Cheque Not Prepared section is always by GRN.
  const chequeViewApplies = status === VALID && !NO_CHEQUE_PROGRESS.has(progress);
  const byCheque = chequeViewApplies && accountsView === ACCOUNTS_CHEQUE_VIEW;
  // The Cheque Not Prepared section, opened from its card on the Accounts row,
  // and which Supply Type its cards have narrowed it to.
  const inChequeNotPrepared = status === CHEQUE_NOT_PREPARED_VIEW;
  const [supplyType, setSupplyType] = useState('');
  // Which half of Total GRNS is showing, or '' for both.
  const [matchFilter, setMatchFilter] = useState('');
  // One branch, by its Unit name, and MSME or Non-MSME vendors -- the page's
  // scope with the search: every view, card, count and export follows them.
  const [location, setLocation] = useState('');
  const [msme, setMsme] = useState('');
  // The BPAD view's own narrowing: one desk, or the Not Integrated card's
  // bills from a date -- never both.
  const [dept, setDept] = useState('');
  const [notIntegrated, setNotIntegrated] = useState(false);
  const [accountsFrom, setAccountsFrom] = useState('');
  // Which desk the pending rows are narrowed to by the cards under them.
  const [pendingDept, setPendingDept] = useState('');
  // Which stretches of the process the GRN age view measures; here rather than
  // in the view, as on the hospital page.
  const [spans, setSpans] = useState([]);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  // The rows on hand, with the view they were asked for -- so a table is never
  // drawn from another view's rows while the next answer is on its way.
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Acting on several rows at once -- Select multiple. `selected` holds row
  // ids: a GRN number is not a key here.
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkForwardTo, setBulkForwardTo] = useState(null);
  const [bulkForwardError, setBulkForwardError] = useState('');
  // The single-row forward dialog: which row it is for, and where to.
  const [forwardFormRow, setForwardFormRow] = useState(null);
  const [forwardFormTo, setForwardFormTo] = useState(null);
  const [forwardFormError, setForwardFormError] = useState('');
  // The rows sent to CSD or filed to Records since the table was last loaded,
  // by row id. Whether a GRN is sent is the server's answer, on the row; these
  // only bridge the gap between a send landing and the reload that shows it,
  // when the row would otherwise offer "Send to…" again. Let go of when the
  // next rows arrive, which carry the answer themselves.
  const [justSent, setJustSent] = useState(() => new Set());
  const [justFiled, setJustFiled] = useState(() => new Set());

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Only the latest request of each kind may answer, as on the hospital page:
  // the filters can change faster than the server replies.
  const summaryRequest = useRef(0);
  const rowsRequest = useRef(0);

  const loadSummary = useCallback(() => {
    const mine = ++summaryRequest.current;
    api
      .phSummary({ q, location, msme })
      .then((answer) => mine === summaryRequest.current && setSummary(answer))
      .catch((err) => mine === summaryRequest.current && setError(err.message));
  }, [q, location, msme]);

  const s = summary?.summary;
  const uploads = summary?.uploads;
  // Whether a BPAD bill status is on file for these GRNs. With one, Pending is
  // "Pending GRNs at BPAD" -- the bills it places at a desk -- and the ones it
  // has no desk for are the GRN Store card's, on the Total GRNS row. Whatever
  // the search box says (bpad.onFile), so typing does not change the view.
  const registerOnFile = (s?.bpad?.onFile ?? 0) > 0;

  // Which rows to ask for, as against which view is showing: the same but on
  // Total GRNS with its filter set, where the view decides the layout and the
  // filter the population.
  const rowStatus = status === ALL_GRNS && matchFilter ? matchFilter : status;
  // What the API is asked for: the same, but the Cheque Not Prepared section
  // is no status of the server's -- it is the Accounts rows its card selects.
  const apiStatus = inChequeNotPrepared ? CHEQUE_NOT_PREPARED_TAB.rowStatus : rowStatus;
  const apiProgress = inChequeNotPrepared ? CHEQUE_NOT_PREPARED_TAB.progress : progress;
  const apiDept = pendingDept || (rowStatus === 'PENDING' && registerOnFile ? IN_BPAD : '');
  // The pending rows carry the status's desk and received dates once one is
  // on file to have them.
  const showPendingBpad = status === 'PENDING' && registerOnFile;

  const loadRows = useCallback(() => {
    const mine = ++rowsRequest.current;
    const latest = () => mine === rowsRequest.current;
    // The GRN age view fetches its own rows -- see TurnaroundView.
    if (status === TURNAROUND) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const asked =
      status === BPAD
        ? // The date always: the Not Integrated card counts from it whether or
          // not the card is pressed. The server narrows the ROWS by it only
          // while they are that card's.
          api.phBpad({ q, location, msme, dept, notIntegrated, accountsFrom, page, pageSize })
        : api.phResults({
            status: apiStatus,
            progress: apiProgress,
            action,
            // Only the Accounts views show the Action dropdown.
            actionCounts: isAccountsSection(status),
            dept: apiDept,
            supplyType: inChequeNotPrepared ? supplyType : undefined,
            q,
            location,
            msme,
            view: byCheque ? ACCOUNTS_CHEQUE_VIEW : undefined,
            page,
            pageSize,
          });
    asked
      .then((answer) => {
        if (!latest()) return;
        setData({ ...answer, view: status, byCheque });
        // These rows were asked for after every send so far had landed (a
        // send's own reload is the latest request), so they say what was sent.
        setJustSent((prev) => (prev.size > 0 ? new Set() : prev));
        setJustFiled((prev) => (prev.size > 0 ? new Set() : prev));
        // A page past the end -- the rows it held have gone since it was
        // turned to -- is the last page there is, not an empty table.
        if (answer.page > answer.totalPages) setPage(answer.totalPages);
      })
      .catch((err) => latest() && setError(err.message))
      .finally(() => latest() && setLoading(false));
  }, [
    status, apiStatus, apiProgress, action, apiDept, inChequeNotPrepared, supplyType, q, location, msme,
    byCheque, dept, notIntegrated, accountsFrom, page, pageSize,
  ]);

  useEffect(loadSummary, [loadSummary]);
  useEffect(loadRows, [loadRows]);

  function refresh() {
    loadSummary();
    loadRows();
  }
  // The refresh of the render on screen NOW. An action awaits the server
  // before it reloads, and by then the filters may have moved on: calling the
  // refresh it started with would ask again for the old filters' rows, and
  // that answer -- the latest request -- would be the one kept.
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  // A ticked row belongs to the page of rows it was ticked on -- changing any
  // of that page's own inputs lets go of the selection rather than carrying
  // it, silently, onto a different set of rows.
  useEffect(() => {
    setSelected(new Set());
    setMultiMode(false);
  }, [rowStatus, page, pageSize, q, progress, action, location, msme, pendingDept, supplyType, byCheque]);

  /* ---- Choosing what is shown. Each mirrors its namesake in Results.jsx. ---- */

  function selectStatus(next) {
    // The rows on hand are another view's shape.
    if (next !== status) setData(null);
    setStatus(next);
    setPage(1);
    if (next !== VALID || next !== status) {
      setProgress('');
      setAction('');
    }
    if (next !== CHEQUE_NOT_PREPARED_VIEW) setSupplyType('');
    if (next !== ALL_GRNS) setMatchFilter('');
    if (next !== BPAD) {
      setDept('');
      setNotIntegrated(false);
    }
    if (next !== 'PENDING' || pendingDept === NOT_IN_BPAD) setPendingDept('');
  }

  function selectPendingDept(next) {
    setPendingDept(next);
    setPage(1);
  }

  function selectSupplyType(next) {
    setSupplyType(next);
    setPage(1);
  }

  function selectDept(next) {
    setDept(next);
    if (next) setNotIntegrated(false);
    setPage(1);
  }

  function selectNotIntegrated() {
    setNotIntegrated(true);
    setDept('');
    setPage(1);
  }

  /** The "Accounts received from" picker's value. One the server could not count from is not kept. */
  function selectAccountsFrom(next) {
    if (next && !isAccountsFromDay(next)) return;
    setAccountsFrom(next);
    // The date moves the card's count always, and the rows only while they
    // are the card's -- so only then is there a first page to go back to.
    if (notIntegrated) setPage(1);
  }

  function selectAccountsView(next) {
    if (next === accountsView) return;
    setAccountsView(next);
    setPage(1);
    setData(null);
  }

  function selectLocation(next) {
    setLocation(next);
    setPage(1);
  }

  function selectMsme(next) {
    setMsme(next);
    setPage(1);
  }

  function selectMatchFilter(next) {
    setMatchFilter(next);
    setPage(1);
    if (next !== 'PENDING' || pendingDept === NOT_IN_BPAD) setPendingDept('');
  }

  /** Narrow the table to one Status value. Choosing one moves to Accounts: only its rows have one. */
  function selectProgress(next) {
    // Cheque not prepared has a section of its own, which its card opens.
    if (next === CHEQUE_NOT_PREPARED_TAB.progress) {
      selectStatus(CHEQUE_NOT_PREPARED_VIEW);
      return;
    }
    setProgress(next);
    setPage(1);
    if (next && status !== VALID) {
      setData(null);
      setStatus(VALID);
      setMatchFilter('');
      setPendingDept('');
      setSupplyType('');
    }
  }

  function selectAction(next) {
    // The Cheque Not Prepared section is Accounts rows too, so it stays.
    if (next && !isAccountsSection(status)) selectStatus(VALID);
    setAction(next);
    setPage(1);
  }

  const sectionTrail = useSectionTrail(status, selectStatus, HOME);
  const describeSection = (view) => TABS.find((tab) => tab.status === view)?.label ?? view;

  /* ---- Sending a GRN, taking it back, and Accounts' two steps once CSD hand
     it back. The hospital table's own send, takeBack, receiveAccounts and
     forward (components/ResultsTable.jsx). ---- */

  // Handing over is Accounts' side of the handover, so this screen's own
  // grant is enough -- see canHandToCsd, and CSD_HANDOVER on the server.
  const canCsd = canHandToCsd(can);
  // The rows in flight: the one chosen first, then every row of its cheque.
  const [busy, setBusy] = useState(() => new Set());
  const [confirm, confirmDialog] = useConfirm();

  /** Sent or filed, by the row or by a send that has landed since it was loaded -- see justSent. */
  const isSent = (row) => row.csdSent || justSent.has(row.id);
  const isFiled = (row) => row.recordsSent || justFiled.has(row.id);

  /** In accounts, CSD not done with it, and gone nowhere yet: it can be filed. */
  const canFile = (row) =>
    row.status !== 'PENDING' && row.csdStage !== 'MOVED_TO_ACCOUNTS' && !isSent(row) && !isFiled(row);
  /**
   * That, and a cheque drawn up to hand over: it can go to CSD. Never a cash
   * bill -- it has no cheque, paid or not, so Records is the only place its
   * picker offers (the server refuses the other: PH_CASH_TO_RECORDS).
   */
  const canSendCsd = (row) => canFile(row) && !row.cashPayment && chequePrepared(row) === true;
  /** Still CSD's to give back: sent, and not yet ruled on. */
  const canTakeBackCsd = (row) =>
    Boolean(canCsd && row.csdDispatchId && TAKE_BACK_STAGES.includes(row.csdStage || 'QUEUED'));
  /** Filed, with the record's id on the row to address it by. */
  const canTakeBackFiled = (row) => Boolean(row.recordsSent && row.recordsId);

  // What Select multiple can batch -- the predicates the hospital pages use.
  // Not a row a send has just landed on: it is no longer one to send, and its
  // next step waits for the reload. By the two bridge sets alone -- csdSent
  // itself is true of every row CSD have handed back, which are the very rows
  // Receive and Send on are for.
  const justLanded = (row) => justSent.has(row.id) || justFiled.has(row.id);
  // Nor a cash bill for Send to CSD: the shared predicate reads its payment
  // document as a cheque prepared, and it has none to hand over. One already
  // out with CSD from before is still received and sent on like any other.
  const canBulkCsd = (row) => !justLanded(row) && !row.cashPayment && bulkCsdEligible(row, canCsd);
  const canBulkReceive = bulkReceiveEligible;
  const canBulkForward = bulkForwardEligible;
  const bulkCategory = (row) => {
    if (justLanded(row)) return null;
    const category = bulkCategoryOf(row, canCsd);
    return category === 'CSD' && row.cashPayment ? null : category;
  };

  /**
   * The rows an action chosen on one row applies to: that row, plus every
   * other GRN the same cheque pays that `eligible` accepts -- a cheque moves
   * as one thing. Asked of the server, since a cheque's bills are spread
   * across the whole table (chequeGroup in ResultsTable.jsx says more).
   *
   * Within the row's own unit: a cheque number is one cheque only within the
   * account it is drawn on, and another unit's account can have issued the
   * same number. A row with no cheque number is its own group of one.
   */
  async function chequeGroup(row, eligible) {
    // A GRN held before Accounts shows no cheque, and is still one of its
    // cheque's bills where it went to CSD with them: the server keeps the
    // number for exactly this (storedChequeNo).
    const cheque = row.chequeNo || row.storedChequeNo;
    if (!cheque) return [row];
    const found = [];
    for (let p = 1; p <= GROUP_MAX_PAGES; p += 1) {
      const res = await api.phResults({
        status: 'ALL',
        chequeNo: cheque,
        unitKey: row.unitKey,
        page: p,
        pageSize: GROUP_PAGE_SIZE,
      });
      found.push(...res.rows);
      if (p >= res.totalPages) break;
    }
    const group = found.filter(eligible);
    // The row the action was chosen on always belongs to its own group.
    return group.some((r) => r.id === row.id) ? group : [row, ...group];
  }

  const beginBusy = (group) => setBusy(new Set(group.map((r) => r.id)));

  /** Send the row's cheque to its destination: each GRN it pays as its own send, together. */
  async function send(row, destination) {
    const toRecords = destination === SEND_RECORDS;
    beginBusy([row]);
    setError('');
    try {
      const group = await chequeGroup(row, toRecords ? canFile : canSendCsd);
      beginBusy(group);
      await Promise.all(group.map((r) => (toRecords ? api.phSendToRecords(r) : api.phSendToCsd(r))));
      // Sent, as far as these rows are concerned, until the reload says so itself.
      const ids = group.map((r) => r.id);
      (toRecords ? setJustFiled : setJustSent)((prev) => new Set([...prev, ...ids]));
      latestRefresh.current();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * Take the row's cheque back from where it was sent -- the undo for one
   * sent by mistake. Confirmed, because afterwards nothing on either screen
   * says the GRNs were ever sent. From CSD it is refused by the server once
   * CSD have acted; from Records it never is.
   */
  async function takeBack(row, from) {
    const fromRecords = from === SEND_RECORDS;
    const place = fromRecords ? 'Records' : 'the CSD queue';
    beginBusy([row]);
    setError('');

    let group;
    try {
      group = await chequeGroup(row, fromRecords ? canTakeBackFiled : canTakeBackCsd);
    } catch (err) {
      setError(err.message);
      setBusy(new Set());
      return;
    }

    const many = group.length > 1;
    const cheque = row.chequeNo || row.storedChequeNo;
    // The ones not in Accounts now -- held before it by a later BPAD status.
    // They come out all the same, but cannot be sent again while that lasts
    // (canFile, and the server's own refusal), so the dialog must not say so.
    const held = group.filter((r) => r.status === 'PENDING').length;
    const untilBpad = 'until the BPAD bill status has the bill at Accounts and the Vendor Age report lists it';
    const comesOut = many
      ? `Cheque ${cheque} pays ${group.length} GRNs that are in ${place}. All of them will come out of it`
      : `GRN ${row.dprNo} will come out of ${place}`;
    let message;
    if (held === 0) {
      message = many
        ? `${comesOut} and go back to Accounts as ones that have not been sent. They can be sent again afterwards.`
        : `${comesOut} and go back to Accounts as one that has not been sent. It can be sent again afterwards.`;
    } else if (held === group.length) {
      message = many
        ? `${comesOut}. None of them is in Accounts now, so they cannot be sent again ${untilBpad}.`
        : `${comesOut}. It is not in Accounts now, so it cannot be sent again ${untilBpad}.`;
    } else {
      message =
        `${comesOut}. ${held} of them ${held === 1 ? 'is' : 'are'} not in Accounts now and cannot be sent again ` +
        `${untilBpad}; the rest go back to Accounts as ones that have not been sent, and can be sent again.`;
    }
    const ok = await confirm({
      title: many ? `Take these ${group.length} GRNs back?` : 'Take this GRN back?',
      message,
      confirmLabel: 'Take back',
    });
    if (!ok) {
      setBusy(new Set());
      return;
    }

    beginBusy(group);
    try {
      await Promise.all(
        group.map((r) => (fromRecords ? api.phRemoveFromRecords(r.recordsId) : api.phRemoveFromCsd(r.csdDispatchId))),
      );
      // Back with Accounts: no longer ones a send has just landed on.
      const ids = group.map((r) => r.id);
      (fromRecords ? setJustFiled : setJustSent)((prev) => {
        if (!ids.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      latestRefresh.current();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /** Accounts' first move on a GRN CSD have handed back: acknowledge it -- and the rest of its cheque. */
  async function receiveAccounts(row) {
    beginBusy([row]);
    setError('');
    try {
      const group = await chequeGroup(row, canBulkReceive);
      beginBusy(group);
      await Promise.all(group.map((r) => api.phReceiveAccountsReturn(r.csdDispatchId)));
      latestRefresh.current();
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
      await Promise.all(group.map((r) => api.phForwardAccountsReturn(r.csdDispatchId, { to })));
      latestRefresh.current();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /**
   * What the forward dialog's fields come to as the server takes them. The
   * dialog only opens for Vendor or Courier, but its "Where" folds a third
   * door in under Vendor -- Others -- which the server knows as a destination
   * of its own, so it is translated back on the way out.
   */
  const forwardBody = (opened, { route, name, mobile, date, courierName, docketNo, remarks }) => {
    const to = opened === 'VENDOR' && route === 'OTHERS' ? 'OTHERS' : opened;
    return {
      to,
      ...(to === 'VENDOR' ? { route } : {}),
      ...(to === 'OTHERS' ? { remarks } : {}),
      ...(to === 'COURIER' ? { courierName, docketNo, date } : {}),
      ...(to === 'VENDOR' || to === 'OTHERS' ? { name, mobile, date } : {}),
    };
  };

  /** Vendor or Courier: the dialog's own submit -- one form, copied onto every dispatch the cheque pays. */
  async function submitForwardForm(fields) {
    const body = forwardBody(forwardFormTo, fields);
    beginBusy([forwardFormRow]);
    setForwardFormError('');
    try {
      const group = await chequeGroup(forwardFormRow, canBulkForward);
      beginBusy(group);
      await Promise.all(group.map((r) => api.phForwardAccountsReturn(r.csdDispatchId, body)));
      setForwardFormRow(null);
      latestRefresh.current();
    } catch (err) {
      setForwardFormError(err.message);
    } finally {
      setBusy(new Set());
    }
  }

  /* ---- Select multiple. Results.jsx's own, over row ids. ---- */

  /**
   * Ticking one row also ticks every other row on the page of the same cheque
   * -- its number and its unit -- that is up for the SAME action. Unticking
   * lets go of the one row only.
   */
  function toggleSelectRow(row) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) {
        next.delete(row.id);
        return next;
      }
      next.add(row.id);
      const category = bulkCategory(row);
      // A GRN held before Accounts shows no cheque and is still one of its
      // cheque's bills (storedChequeNo) -- the same reading as chequeGroup.
      const chequeOf = (r) => r.chequeNo || r.storedChequeNo;
      const cheque = chequeOf(row);
      if (cheque && category) {
        for (const r of data?.rows || []) {
          if (chequeOf(r) === cheque && r.unitKey === row.unitKey && bulkCategory(r) === category) next.add(r.id);
        }
      }
      return next;
    });
  }

  function exitMultiMode() {
    setMultiMode(false);
    setSelected(new Set());
  }

  const selectedRows = (data?.rows || []).filter((row) => selected.has(row.id));
  const selectedLabel = byCheque ? `${selected.size} cheque${selected.size === 1 ? '' : 's'}` : `${selected.size}`;

  /** The rows a bulk action acts on: the ticked rows, or on Cheque view every eligible bill their cheques pay. */
  function bulkTargets(eligible) {
    if (!byCheque) return selectedRows;
    return expandCheques(selectedRows, (row) => chequeGroup(row, eligible), (row) => row.id);
  }

  const allSelectedCsd = selectedRows.length > 0 && selectedRows.every(canBulkCsd);
  const allSelectedReceive = selectedRows.length > 0 && selectedRows.every(canBulkReceive);
  const allSelectedForward = selectedRows.length > 0 && selectedRows.every(canBulkForward);

  /** Run one bulk action over the ticked rows, then let go of the selection and reload. */
  async function bulk(eligible, act, { onError = setError, done, landed } = {}) {
    if (selectedRows.length === 0) return;
    setBulkSending(true);
    onError('');
    try {
      const targets = await bulkTargets(eligible);
      await Promise.all(targets.map(act));
      landed?.(targets);
      done?.();
      exitMultiMode();
      latestRefresh.current();
    } catch (err) {
      onError(err.message);
    } finally {
      setBulkSending(false);
    }
  }

  const sendSelectedToCsd = () =>
    bulk(canBulkCsd, (row) => api.phSendToCsd(row), {
      landed: (targets) => setJustSent((prev) => new Set([...prev, ...targets.map((r) => r.id)])),
    });
  const receiveSelected = () => bulk(canBulkReceive, (row) => api.phReceiveAccountsReturn(row.csdDispatchId));
  const forwardSelectedSimple = (to) =>
    bulk(canBulkForward, (row) => api.phForwardAccountsReturn(row.csdDispatchId, { to }));
  const submitBulkForward = (fields) => {
    const body = forwardBody(bulkForwardTo, fields);
    return bulk(canBulkForward, (row) => api.phForwardAccountsReturn(row.csdDispatchId, body), {
      onError: setBulkForwardError,
      done: () => setBulkForwardTo(null),
    });
  };

  // Nothing uploaded at all: say so, and offer the screen that fixes it.
  if (uploads && uploads.count === 0) {
    return (
      <div className="empty empty--page">
        <h2>No pharmacy reports yet</h2>
        <p>
          {OP_PHARMACY_LABELS[desk === 'accounts' ? 'accounts-department' : 'results']} shows the GRNs from the GRN
          Purchase report, matched to the Vendor Age report, the BPAD bill status and the bank statement. Nothing has
          been uploaded yet.
        </p>
        {can('upload') && (
          <button className="primary" type="button" onClick={() => navigate(opPharmacyPath('upload'))}>
            Go to {OP_PHARMACY_LABELS.upload}
          </button>
        )}
      </div>
    );
  }

  /* ---- The cards. Built as Results.jsx builds its own; see the notes there. ---- */

  const bpadData = data?.view === BPAD ? data : null;
  const departments = bpadData?.departments ?? [];
  const notIntegratedFigure = bpadData?.notIntegrated ?? null;

  const cards = [
    ...((status === TURNAROUND ? ageCards : CARDS_FOR[rowStatus]) ?? [])
      .map((id) => CARD_BY_ID[id])
      .filter(Boolean)
      // No status on file: a GRN Store card would report on a file nobody uploaded.
      .filter((card) => card.kind !== 'missing' || registerOnFile)
      // The "Not in Vendor Master" card, only while there are such GRNs.
      .filter((card) => cardShown(card, s, supplyType)),
    // The BPAD view's row: its own count, the status's desks, then Not
    // Integrated in Accounts. The Accounts desk opens the Accounts view.
    ...(status === BPAD && (s?.bpadRegister?.count ?? 0) > 0
      ? [
          CARD_BY_ID[BPAD],
          ...departments.map((d) => ({ kind: isAccountsDept(d.dept) ? 'deptAccounts' : 'dept', ...d })),
          ...(notIntegratedFigure
            ? [
                {
                  ...NOT_INTEGRATED_CARD,
                  ...notIntegratedFigure,
                  // The date the figure was counted from, which the card
                  // prints, and the date as picked, which its sheet asks for.
                  countedFrom: notIntegratedFigure.accountsFrom ?? '',
                  accountsFrom,
                },
              ]
            : []),
        ]
      : []),
    // Where the pending ones are pending: a card per desk. Not the "cannot
    // place this" bucket, which is the GRN Store card's -- leaving it off is
    // what makes the desks sum to the Pending figure beside them.
    ...(rowStatus === 'PENDING' && (s?.PENDING?.count ?? 0) > 0 && registerOnFile
      ? (s.pendingDepartments ?? []).filter((d) => d.dept !== NOT_IN_BPAD).map((d) => ({ kind: 'pendingDept', ...d }))
      : []),
  ];
  const cardRow = titledCards(cards, rowStatus === VALID ? PH_ACCOUNTS_ROW_GROUPS : null);

  /** What a count card prints: its own bucket, but Pending with a status on file is the bills it places. */
  const bucketFigure = (card) => {
    const own = tabFigure(card, s) ?? { count: 0, amount: 0 };
    if (card.status !== 'PENDING' || !registerOnFile || !s?.pendingDepartments) return own;
    return s.pendingDepartments
      .filter((d) => d.dept !== NOT_IN_BPAD)
      .reduce((sum, d) => ({ count: sum.count + d.count, amount: sum.amount + (d.amount ?? 0) }), { count: 0, amount: 0 });
  };
  const bucketLabel = (card) => {
    if (card.status !== 'PENDING') return card.label;
    return registerOnFile ? 'Pending GRNs at BPAD' : 'Pending GRNs';
  };

  /** The filter a count card heads, where it stands at the front of a row that divides it. */
  const rowHead = (card) => {
    if (card.kind !== 'bucket' || card.status !== rowStatus || status === TURNAROUND) return null;
    if (rowStatus === 'PENDING') return { on: Boolean(pendingDept), noun: 'pending GRN', clear: () => selectPendingDept('') };
    if (rowStatus === ALL_GRNS) return { on: Boolean(pendingDept), noun: 'GRN', clear: () => selectPendingDept('') };
    if (rowStatus === VALID) {
      return {
        on: Boolean(progress || action),
        noun: 'GRN in accounts',
        clear: () => {
          setProgress('');
          setAction('');
          setPage(1);
        },
      };
    }
    if (rowStatus === CHEQUE_NOT_PREPARED_VIEW) {
      return {
        on: Boolean(supplyType || action),
        noun: 'GRN with no cheque prepared',
        clear: () => {
          setSupplyType('');
          setAction('');
          setPage(1);
        },
      };
    }
    if (rowStatus === BPAD) {
      return {
        on: Boolean(dept || notIntegrated),
        noun: 'BPAD row',
        clear: () => {
          setDept('');
          setNotIntegrated(false);
          setPage(1);
        },
      };
    }
    return null;
  };
  const bucketActive = (card) => {
    const head = rowHead(card);
    // On the GRN age view the ring is on the population it measures: Accounts.
    return head ? !head.on : card.status === (status === TURNAROUND ? VALID : rowStatus);
  };
  const pressBucket = (card) => {
    const head = rowHead(card);
    selectStatus(card.status);
    if (head) head.clear();
  };
  const bucketTitle = (card) => {
    const head = rowHead(card);
    if (!head) return undefined;
    return head.on ? `Show every ${head.noun} again` : `Showing every ${head.noun} — press a card beside this to narrow it`;
  };
  const headLabel = () => (CARD_BY_ID[rowStatus] ? bucketLabel(CARD_BY_ID[rowStatus]) : 'the first card');

  // The Status dropdown: the hospitals' cheque answers, and Cash payments
  // after Cheque prepared -- the card beside it, as an option. The shared list
  // knows only its own keys, and would otherwise offer this one just while it
  // is the one chosen, under a made-up name.
  const progressFilters = progressFilterOptions(s, progress).filter((f) => f.value !== CASH_PAYMENT);
  if (s?.progress?.[CASH_PAYMENT] || progress === CASH_PAYMENT) {
    const after = progressFilters.findIndex((f) => f.value === 'CHEQUE_PREPARED');
    progressFilters.splice(after + 1, 0, { value: CASH_PAYMENT, label: 'Cash payments' });
  }
  // The Action dropdown's options are the keys the rows came back counted
  // under -- the server's own list. Until they arrive only the one chosen is
  // offered.
  const actionCounts = isAccountsSection(status) && data?.view === status ? data.actionCounts : null;
  const actionFilters = actionCounts
    ? actionFilterOptions(actionCounts)
    : action
      ? [{ value: action, label: PROGRESS_LABELS[action] ?? action, count: null }]
      : [];

  const section = TABS.find((tab) => tab.status === rowStatus) ?? TABS[0];
  const ticked = (summary?.branches ?? []).filter((b) => b.isSelected);

  /**
   * What Export Excel hands back: the section's own sheet, then a sheet per
   * card below it -- read off the very cards on screen, as the hospital page
   * does (sectionSheets). One sheet on the GRN age view: the table on screen,
   * with the spans picked for it.
   */
  const exportSheets = sectionSheets(section, cards, {
    labelFor: (card) => (card.kind === 'bucket' ? bucketLabel(card) : card.label),
    pendingInBpad: registerOnFile,
    // The hospital reports' own titles, said to be the pharmacies'.
  }).map((sheet) => ({
    ...sheet,
    title: `OP Pharmacy ${OWN_TITLES[sheet.status] ?? sheet.title}`,
  }));

  async function handleExport() {
    setExporting(true);
    setError('');
    try {
      // The Accounts sheets follow the GRNs / Cheques switch, but for the ones
      // that are bills with no cheque -- always by GRN.
      // By the table on screen (byCheque), which is also what names the file:
      // while a no-cheque status has put the table back to a row per GRN, the
      // switch is hidden and the workbook is per GRN with it.
      const sheetByCheque = (sheet) =>
        byCheque && sheet.status === VALID && !sheet.supplyType && !NO_CHEQUE_PROGRESS.has(sheet.progress);
      // The GRN age report narrowed to GRN-to-Cheque is not the same report as
      // the whole of it, so it does not arrive under the same name.
      const measured =
        status === TURNAROUND && spans.length > 0 ? ` ${spans.map(spanLabel).join(' ')}` : '';
      await exportPharmacySection(exportSheets, {
        fileName: `OP Pharmacy ${bucketLabel(section)}${measured}${byCheque ? ' Cheque View' : ''}`,
        columnsFor: (sheet) =>
          sheet.status === TURNAROUND
            ? // The table's own columns, over the pharmacies' chain.
              turnaroundColumns(spans, PHARMACY_CHAIN)
            : sheet.status === BPAD
              ? EXPORT_COLUMNS[BPAD]
              : sheetByCheque(sheet)
                ? EXPORT_COLUMNS.cheque
                : EXPORT_COLUMNS[sheet.status] ?? EXPORT_COLUMNS[ALL_GRNS],
        // Only the page's scope travels -- the search, the branch and MSME.
        // Each sheet carries its own card's narrowing instead of the dropdowns'.
        loadSheet: async (sheet) => {
          if (sheet.status === TURNAROUND) {
            // Every GRN in scope, with its day counts, Total and spans worked
            // out as the table works them out.
            const { rows: aged } = await api.phTurnaround({ q, location, msme, all: true });
            return turnaroundSheetRows(aged, spans, PHARMACY_CHAIN);
          }
          const answer =
            sheet.status === BPAD
              ? await api.phBpad({
                  q, location, msme, dept: sheet.dept, notIntegrated: sheet.notIntegrated,
                  accountsFrom: sheet.accountsFrom, all: true,
                })
              : await api.phResults({
                  status: sheet.status,
                  progress: sheet.progress,
                  dept: sheet.dept,
                  supplyType: sheet.supplyType,
                  q,
                  location,
                  msme,
                  view: sheetByCheque(sheet) ? ACCOUNTS_CHEQUE_VIEW : undefined,
                  all: true,
                });
          // Words where the sheet would otherwise carry a flag.
          return answer.rows.map((r) => ({
            ...r,
            recordsLabel: r.recordsSent ? 'Sent to Records' : null,
            paymentState: paymentState(r),
          }));
        },
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  /* ---- The tables: one layout per view, as the hospital table has. ---- */

  // Select multiple is for the views whose rows have an action to batch: the
  // Accounts rows, Total GRNS, and the handovers held before Accounts.
  const offersBulk = status === VALID || status === ALL_GRNS || status === HELD_TAB.status;
  // The bulk-select column, on those views.
  const canSelect = multiMode && offersBulk;
  const selectHead = canSelect && (
    <th className="table__select table__pin table__pin--select" aria-label="Select for bulk action" />
  );
  const selectCell = (row) =>
    canSelect && (
      <td className="table__select table__pin table__pin--select">
        {bulkCategory(row) && (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={() => toggleSelectRow(row)}
            aria-label={byCheque ? `Select cheque ${row.chequeNo} for a bulk action` : `Select GRN ${row.dprNo} for a bulk action`}
          />
        )}
      </td>
    );
  const tableClass = canSelect ? 'table table--pinned-select' : 'table';

  // The row as the two pickers are handed it: with the cheque it went out on
  // where it is held before Accounts and shows none (storedChequeNo), so they
  // say what the move moves and hand the same row back to be acted on.
  const withItsCheque = (row) =>
    row.chequeNo || !row.storedChequeNo ? row : { ...row, chequeNo: row.storedChequeNo };

  const actionCell = (listed) => {
    const row = withItsCheque(listed);
    return (
    <td className="table__pin table__pin--action">
      <div className="row-actions">
        {/* A pending GRN has nothing to hand over -- unless it already was:
            sent or filed while in Accounts, and held before it since by a
            later BPAD status. That one keeps its take-back and Accounts'
            steps, or its handover could not be finished from this page. */}
        {row.status === 'PENDING' && !isSent(row) && !isFiled(row) ? (
          <span className="table__miss" title="Not in Accounts yet — nothing to hand over">
            &mdash;
          </span>
        ) : row.csdStage === 'MOVED_TO_ACCOUNTS' ? (
          <AccountsStagePicker
            row={row}
            busy={busy.has(row.id)}
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
            busy={busy.has(row.id)}
            canCsd={canCsd}
            canSendCsd={canSendCsd(row)}
            canFile={canFile(row)}
            canTakeBackCsd={canTakeBackCsd(row)}
            canTakeBackFiled={canTakeBackFiled(row)}
            onSend={send}
            onTakeBack={takeBack}
          />
        )}
      </div>
    </td>
    );
  };

  const vendorCells = (row) => (
    <>
      <td>{row.vendorName || dash}</td>
      <td className="table__mono" title={row.focusCode ? `Focus code ${row.focusCode}` : undefined}>
        {row.vendorCode || dash}
      </td>
      <VendorCells row={row} />
    </>
  );

  const emptyRow = (span) => (
    <tr>
      <td className="table__empty" colSpan={span + (canSelect ? 1 : 0)}>
        {q ? 'Matches not found' : 'No rows'}
      </td>
    </tr>
  );

  function totalTable(rows) {
    return (
      <table className={tableClass}>
        <thead>
          <tr>
            {selectHead}
            <th className="table__pin table__pin--division" title="DivisionCode in the Vendor Age report">Division</th>
            <th className="table__pin table__pin--grn" title="FeedNo in the GRN Purchase report">GRN No</th>
            <th>GRN Date</th>
            <th title="Type in the GRN Purchase report">Purchase Type</th>
            <th title="Unit Name">Unit</th>
            <th>Vendor</th>
            <th title="PM Code">Vendor Code</th>
            {VENDOR_HEADS}
            <th title="InvNo and InvDate">Bill No</th>
            <th className="table__num" title="NetAmt in the GRN Purchase report">GRN Amount</th>
            <th>Match</th>
            <th title="GRNDoc in the Vendor Age report">Focus doc_no</th>
            <th className="table__num">PayableAmount</th>
            <th title="ChequeNo and ChqDate">Cheque No</th>
            <th title="The value date the bank paid the cheque out">Cleared On</th>
            <th title="Pending With Dept. in the BPAD bill status">BPAD Desk</th>
            <th>Status</th>
            <th className="table__pin table__pin--action">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyRow(17 + VENDOR_CELL_COUNT)}
          {rows.map((row) => (
            <tr key={row.id}>
              {selectCell(row)}
              <td className="table__mono table__pin table__pin--division">
                {row.divisionCode || row.branchDivisionCode || dash}
              </td>
              <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
              <td className="table__mono">{formatDate(row.dprDate) || dash}</td>
              <td>{row.purchaseType || dash}</td>
              <td>{row.location || dash}</td>
              {vendorCells(row)}
              <td>
                <span className="table__mono">{row.billNo || dash}</span>
                {row.billDate && <div className="table__sub">{formatDate(row.billDate)}</div>}
              </td>
              <td className="table__num">{row.totalAmount == null ? dash : formatAmount(row.totalAmount)}</td>
              <td>
                <MatchState row={row} />
              </td>
              <td className="table__mono">{row.ageingGrnDoc || row.ageingGrnNo || dash}</td>
              <td className="table__num">{row.payableAmount == null ? dash : formatAmount(row.payableAmount)}</td>
              <td>
                {/* A cash purchase has no cheque: said -- paid, with its
                    payment document on hover, or not yet -- rather than left
                    as a dash a reader would take for a cheque still to come. */}
                {row.cashPayment ? (
                  cashPaid(row) ? (
                    <span title={row.paymentDocNo ? `Cash payment ${row.paymentDocNo}` : 'Paid in cash'}>
                      Cash payment
                    </span>
                  ) : (
                    <span title="A cash purchase: no cheque is prepared for it, and it has not been paid yet">
                      Cash — not yet paid
                    </span>
                  )
                ) : (
                  <span className="table__mono">{row.chequeNo || dash}</span>
                )}
                {row.chqDate && <div className="table__sub">{formatDate(row.chqDate)}</div>}
              </td>
              <td className="table__mono">{formatDate(row.chequeClearedOn) || dash}</td>
              <td>
                {row.pendingWithDept ? (
                  <>
                    {deptLabel(row.pendingWithDept)}
                    {row.pendingWithUser && <div className="table__sub">{row.pendingWithUser}</div>}
                  </>
                ) : registerOnFile ? (
                  <span className="table__miss" title="No BPAD bill status on file places this GRN at a desk">
                    Not in BPAD
                  </span>
                ) : (
                  dash
                )}
              </td>
              <td>
                <StatusCell row={row} sent={isSent(row)} filed={isFiled(row)} />
              </td>
              {actionCell(row)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function pendingTable(rows) {
    return (
      <table className="table">
        <thead>
          <tr>
            <th className="table__pin table__pin--division" title={`The branch's code on ${OP_PHARMACY_LABELS.config}`}>
              Division
            </th>
            <th className="table__pin table__pin--grn" title="FeedNo in the GRN Purchase report">GRN No</th>
            <th>GRN Date</th>
            <th title="Type in the GRN Purchase report">Purchase Type</th>
            <th title="Unit Name">Unit</th>
            <th>Vendor</th>
            <th title="PM Code">Vendor Code</th>
            {VENDOR_HEADS}
            <th>Bill No</th>
            <th>Bill Date</th>
            <th className="table__num">GRN Amount</th>
            {showPendingBpad && (
              <>
                <th>Pending With Dept.</th>
                <th>Pending With User/Status</th>
                <th>BPAD Received Date</th>
                <th>Accounts Received Date</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyRow((showPendingBpad ? 14 : 10) + VENDOR_CELL_COUNT)}
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="table__mono table__pin table__pin--division">{row.branchDivisionCode || dash}</td>
              <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
              <td className="table__mono">{formatDate(row.dprDate) || dash}</td>
              <td>{row.purchaseType || dash}</td>
              <td>{row.location || dash}</td>
              {vendorCells(row)}
              <td className="table__mono">{row.billNo || dash}</td>
              <td className="table__mono">{formatDate(row.billDate) || dash}</td>
              <td className="table__num">{row.totalAmount == null ? dash : formatAmount(row.totalAmount)}</td>
              {showPendingBpad && <BpadAnswerCells row={row} />}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function accountsTable(rows) {
    return (
      <table className={tableClass}>
        <thead>
          <tr>
            {selectHead}
            <th className="table__pin table__pin--division" title="DivisionCode in the Vendor Age report">Division</th>
            {/* On Cheque view the cheque is what a row is looked up by, so it
                takes GRN No's pinned place. */}
            <th className="table__pin table__pin--grn">{byCheque ? 'Cheque No' : 'GRN No'}</th>
            <th title="Unit Name">Unit</th>
            {!byCheque && <th>GRN Date</th>}
            {!byCheque && <th>Bill No</th>}
            {!byCheque && <th>Bill Date</th>}
            <th>Vendor</th>
            <th title="PM Code">Vendor Code</th>
            {VENDOR_HEADS}
            {byCheque ? (
              <>
                <th>Cheque Date</th>
                <th className="table__num" title="Every PayableAmount the cheque pays, added up">Cheque Amount</th>
                <th>PaymentDocNo</th>
                <th title={`The branch's Account number on ${OP_PHARMACY_LABELS.config}`}>Account No</th>
                <th title="The value date the bank paid the cheque out">Cleared On</th>
              </>
            ) : (
              <>
                <th title="GRNDoc in the Vendor Age report">Focus doc_no</th>
                <th className="table__num">NetAmt</th>
                <th className="table__num">AdjPurReturn</th>
                <th className="table__num">AdjustedJV</th>
                <th className="table__num">TDSJV</th>
                <th className="table__num">PayableAmount</th>
              </>
            )}
            <th>Status</th>
            <th className="table__pin table__pin--action">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyRow((byCheque ? 12 : 16) + VENDOR_CELL_COUNT)}
          {rows.map((row) => (
            <tr key={row.id}>
              {selectCell(row)}
              <td className="table__mono table__pin table__pin--division">
                {row.divisionCode || row.branchDivisionCode || dash}
              </td>
              {byCheque ? (
                <td className="table__mono table__pin table__pin--grn">
                  {row.chequeNo || dash}
                  {row.chequeGrnCount != null && (
                    <div className="table__sub">{`${row.chequeGrnCount} GRN${row.chequeGrnCount === 1 ? '' : 's'}`}</div>
                  )}
                </td>
              ) : (
                <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
              )}
              <td>{row.location || dash}</td>
              {!byCheque && <td className="table__mono">{formatDate(row.dprDate) || dash}</td>}
              {!byCheque && <td className="table__mono">{row.billNo || dash}</td>}
              {!byCheque && <td className="table__mono">{formatDate(row.billDate) || dash}</td>}
              {vendorCells(row)}
              {byCheque ? (
                <>
                  <td className="table__mono">{formatDate(row.chqDate) || dash}</td>
                  <td className="table__num">{formatAmountOrDash(row.chequeAmount)}</td>
                  <td className="table__mono">{row.paymentDocNo || dash}</td>
                  <td className="table__mono">{row.accountNo || dash}</td>
                  <td className="table__mono">{formatDate(row.chequeClearedOn) || dash}</td>
                </>
              ) : (
                <>
                  <td className="table__mono">{row.ageingGrnDoc || row.ageingGrnNo || dash}</td>
                  <td className="table__num">{formatAmount(row.netAmt)}</td>
                  <td className="table__num">{formatAmountOrDash(row.adjPurReturn)}</td>
                  <td className="table__num">{formatAmountOrDash(row.adjustedJv)}</td>
                  <td className="table__num">{formatAmountOrDash(row.tdsJv)}</td>
                  <td className="table__num">{formatAmount(row.payableAmount)}</td>
                </>
              )}
              <td>
                <StatusCell row={row} sent={isSent(row)} filed={isFiled(row)} />
              </td>
              {actionCell(row)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  function bpadTable(rows) {
    return (
      <table className="table">
        <thead>
          <tr>
            <th className="table__pin table__pin--division" title={`The branch's code on ${OP_PHARMACY_LABELS.config}`}>
              Division
            </th>
            <th className="table__pin table__pin--grn">GRN No</th>
            <th title="The unit the bill's GRN belongs to">Unit</th>
            <th>Location</th>
            <th>WareHouse</th>
            <th>Vendor Code</th>
            <th>Vendor Name</th>
            {VENDOR_HEADS}
            <th>Inv.No.</th>
            <th>Inv Date</th>
            <th>GRN Date</th>
            <th className="table__num">GRN Amount</th>
            <th>PO Number</th>
            <th>Pending With Dept.</th>
            <th>BPAD Received Date</th>
            <th>Accounts Received Date</th>
            <th>Pending With User/Status</th>
            <th>Pend.Reason/Pend Dept</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && emptyRow(18 + VENDOR_CELL_COUNT)}
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="table__mono table__pin table__pin--division">{row.branchDivisionCode || dash}</td>
              <td className="table__mono table__pin table__pin--grn">{row.grnNo}</td>
              <td>{row.unitName || dash}</td>
              <td className="table__mono">{row.location || dash}</td>
              <td>{row.warehouse || dash}</td>
              <td className="table__mono">{row.vendorCode || dash}</td>
              <td>{row.vendorName || dash}</td>
              <VendorCells row={row} />
              <td className="table__mono">{row.invNo || dash}</td>
              <td className="table__mono">{formatDate(row.invDate) || dash}</td>
              <td className="table__mono">{formatDate(row.grnDate) || dash}</td>
              <td className="table__num">{row.grnAmount == null ? dash : formatAmount(row.grnAmount)}</td>
              <td className="table__mono">{row.poNumber || dash}</td>
              <td>{row.pendingWithDept ? deptLabel(row.pendingWithDept) : dash}</td>
              <td className="table__mono">{formatDate(row.bpadReceivedDate) || dash}</td>
              <td className="table__mono">{formatDate(row.accountsReceivedDate) || dash}</td>
              <td>{row.pendingWithUser || dash}</td>
              <td>{row.pendReason || dash}</td>
              <td>
                {row.bpadNotIntegrated ? (
                  <span className="pill pill--pending" title={NOT_INTEGRATED_CARD.hint}>
                    Not Integrated in Accounts
                  </span>
                ) : (
                  dash
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // The rows on hand, where they are this view's own.
  const shown = data && data.view === status && Boolean(data.byCheque) === byCheque ? data : null;

  return (
    <>
      {confirmDialog}
      {forwardFormRow && (
        <ForwardDetailsDialog
          /* Named for the whole cheque the submit will act on, not for the row
             the picker was used on. */
          subject={forwardFormRow.chequeNo ? `every GRN on cheque ${forwardFormRow.chequeNo}` : `GRN ${forwardFormRow.dprNo}`}
          to={forwardFormTo}
          busy={busy.has(forwardFormRow.id)}
          error={forwardFormError}
          onSubmit={submitForwardForm}
          onClose={() => setForwardFormRow(null)}
        />
      )}
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

      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">All uploads</h2>
          <p className="page__lead">
            {uploads ? `${count(uploads.count)} upload${uploads.count === 1 ? '' : 's'} combined — ` : ''}
            {s ? `${count(s.total.count)} pharmacy GRN${s.total.count === 1 ? '' : 's'}` : 'every pharmacy GRN'}, each once per
            unit.{' '}
            {/* Once the summary is in, and not before: until then nothing is
                known of the ticks, and "none is ticked" would be a guess. */}
            {summary &&
              (ticked.length > 0
                ? `Narrowed to ${ticked.map((b) => b.branchCode).join(', ')} on ${OP_PHARMACY_LABELS.config}.`
                : `Every branch — none is ticked on ${OP_PHARMACY_LABELS.config}.`)}
            {summary?.confinedTo && ` Your account is limited to the branch ${summary.confinedTo}.`}
          </p>
        </div>

        <div className="page__actions">
          {/* Which view the table below shows. Each option carries its own
              count, as on the hospital page. */}
          <label className="picker">
            <span className="picker__label">View</span>
            <select
              className="field__input picker__input"
              value={status}
              onChange={(e) => selectStatus(e.target.value)}
              aria-label="Choose what the table below shows"
            >
              {TABS.map((tab) => {
                const pendingAtBpad = tab.status === 'PENDING' && registerOnFile;
                const bucket = s ? (pendingAtBpad ? bucketFigure(tab) : tabFigure(tab, s)) : null;
                // The held handovers: offered only while there are any, or
                // while it is the view showing -- see HELD_TAB.
                if (tab.status === HELD_TAB.status && status !== HELD_TAB.status && !(bucket?.count > 0)) return null;
                return (
                  <option key={tab.status} value={tab.status}>
                    {pendingAtBpad ? bucketLabel(tab) : tab.label}
                    {bucket ? ` (${count(bucket.count)})` : ''}
                  </option>
                );
              })}
            </select>
          </label>

          {/* GRNs or Cheques, on the Accounts view only -- and not while it is
              narrowed to bills with no cheque, which are always by GRN. */}
          {chequeViewApplies && <ViewModeRadios value={accountsView} onChange={selectAccountsView} />}

          <LocationFilter
            value={location}
            onChange={selectLocation}
            load={api.phListBranches}
            screen={OP_PHARMACY_LABELS.config}
          />

          {/* The section showing, as one workbook: its own sheet, then a sheet
              per card on the row below. One sheet on the GRN age view -- the
              table as it stands, spans and all. */}
          <button
            className="ghost"
            type="button"
            onClick={handleExport}
            disabled={exporting || exportSheets.length === 0}
            title={
              exportSheets.length > 1
                ? `Download ${bucketLabel(section)} as Excel — a sheet per card below`
                : `Download ${bucketLabel(section)} as Excel`
            }
          >
            {exporting ? 'Preparing…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {/* What a statement-less page cannot say, said once: without one on file
          no cheque can read as cleared. */}
      {uploads && uploads.statements === 0 && s && s.VALID.count > 0 && isAccountsSection(status) && (
        <div className="alert alert--info">
          <strong>No bank statement is on file.</strong> Cheques show as prepared, and none as cleared, until one is
          uploaded on {OP_PHARMACY_LABELS.upload}.
        </div>
      )}

      {/* What the held handovers are, said over their own view: nothing else
          on the page explains a pending GRN with a Status and an Action. */}
      {status === HELD_TAB.status && (
        <div className="alert alert--info">
          <strong>These GRNs were sent to CSD or Records while they were in Accounts.</strong> The BPAD bill status no
          longer has their bill at Accounts, so they count as pending — but each handover can still be received, sent
          on or taken back from here. One taken back cannot be sent again until BPAD has its bill at Accounts.
        </div>
      )}

      <BackButton trail={sectionTrail} describe={describeSection} />

      {s && cards.length > 0 && (
        <div className="cards cards--tabs">
          {cardRow.map((card) =>
            card.kind === 'groupTitle' ? (
              <h3 key={`title:${card.title}`} className="card-group__title">
                {card.title}
              </h3>
            ) : card.kind === 'missing' ? (
              /* The pending GRNs the status has no desk for -- still at the
                 GRN store. Pressing it narrows the rows below to them. */
              <button
                key="missing"
                type="button"
                className={`card stat stat--missing ${pendingDept === NOT_IN_BPAD ? 'is-active' : ''}`}
                onClick={singlePress(() => selectPendingDept(NOT_IN_BPAD))}
                aria-pressed={pendingDept === NOT_IN_BPAD}
                title={tabTitle(
                  'GRNs Not Finalized',
                  pendingDept === NOT_IN_BPAD
                    ? `Showing only the GRNs with no BPAD desk — press ${headLabel()} for every row`
                    : 'Show only the pending GRNs the BPAD bill status has no desk for',
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(s.bpadMissing?.count)}</div>
                <div className="stat__amount">₹ {formatAmount(s.bpadMissing?.amount ?? 0)}</div>
                <div className="stat__hint">GRNs Not Finalized</div>
              </button>
            ) : card.kind === 'notIntegrated' ? (
              <button
                key={card.id}
                type="button"
                className={`card stat stat--gap ${notIntegrated ? 'is-active' : ''}`}
                onClick={singlePress(selectNotIntegrated)}
                aria-pressed={notIntegrated}
                title={tabTitle(
                  card.grns !== card.count ? `${card.hint} — ${count(card.grns)} GRNs` : card.hint,
                  notIntegrated
                    ? `Showing only these bills — press ${headLabel()} for every row`
                    : 'Show only the bills BPAD has at Accounts that the Vendor Age report does not have',
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(card.count)}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">{notIntegratedSince(card.countedFrom)}</div>
              </button>
            ) : card.kind === 'deptAccounts' ? (
              /* The status's Accounts desk: the one desk this page has a view
                 of its own for, so its card opens that view. */
              <button
                key={`dept:${card.dept}`}
                type="button"
                className="card stat stat--valid stat--go"
                onClick={singlePress(() => selectStatus(VALID))}
                title="Open the Accounts view — the same as choosing Accounts in the View dropdown"
              >
                <IconArrowRight size={15} className="stat__go" />
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{count(card.count)}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">Pending with this desk — open Accounts</div>
              </button>
            ) : card.kind === 'dept' ? (
              <button
                key={`dept:${card.dept}`}
                type="button"
                className={`card stat stat--dept ${dept === card.dept ? 'is-active' : ''}`}
                onClick={singlePress(() => selectDept(card.dept))}
                aria-pressed={dept === card.dept}
                title={
                  dept === card.dept
                    ? `Showing ${deptLabel(card.dept)} only — press ${headLabel()} for every department`
                    : `Show only the bills pending with ${deptLabel(card.dept)}`
                }
              >
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{count(card.count)}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">Pending with this desk</div>
              </button>
            ) : card.kind === 'pendingDept' ? (
              <button
                key={`pending-dept:${card.dept}`}
                type="button"
                className={`card stat stat--dept ${pendingDept === card.dept ? 'is-active' : ''}`}
                onClick={singlePress(() => selectPendingDept(card.dept))}
                aria-pressed={pendingDept === card.dept}
                title={
                  pendingDept === card.dept
                    ? `Showing ${deptLabel(card.dept)} only — press ${headLabel()} for every pending GRN`
                    : `Show only the pending GRNs sitting with ${deptLabel(card.dept)}`
                }
              >
                <div className="stat__label">{deptLabel(card.dept)}</div>
                <div className="stat__value">{count(card.count)}</div>
                <div className="stat__amount">₹ {formatAmount(card.amount ?? 0)}</div>
                <div className="stat__hint">Pending at this desk</div>
              </button>
            ) : card.kind === 'progress' && card.opens ? (
              /* Cheque Not Prepared: opens its own section, split by the
                 vendor's Supply Type, rather than narrowing this table. */
              <button
                key={card.progress}
                type="button"
                className={`card stat stat--${card.tone ?? 'dept'} stat--go`}
                onClick={singlePress(() => selectStatus(card.opens))}
                title={tabTitle(
                  progressCardFigures(card, s, byCheque).hint,
                  `Open the ${card.label} section — split by Stents and Regular`,
                )}
              >
                <IconArrowRight size={15} className="stat__go" />
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(progressCardFigures(card, s, byCheque).value)}</div>
                <div className="stat__amount">₹ {formatAmount(s.progress?.[card.progress]?.amount ?? 0)}</div>
                <div className="stat__hint">{progressCardFigures(card, s, byCheque).hint}</div>
              </button>
            ) : card.kind === 'supplyType' ? (
              /* One Supply Type's share of the Cheque Not Prepared section --
                 the vendor's, off the Vendor Master. */
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
                    ? `Showing ${card.label} only — press ${headLabel()} for every GRN with no cheque prepared`
                    : `Show only the ${card.label} GRNs with no cheque prepared`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(supplyCardFigure(card, s).count)}</div>
                <div className="stat__amount">₹ {formatAmount(supplyCardFigure(card, s).amount ?? 0)}</div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ) : card.kind === 'pair' ? (
              <PairCard
                key={card.id}
                card={card}
                summary={s}
                byCheque={byCheque}
                progress={progress}
                onSelect={selectProgress}
                headLabel={headLabel()}
              />
            ) : card.kind === 'progress' ? (
              <button
                key={card.progress}
                type="button"
                className={`card stat stat--${card.tone ?? 'dept'} ${progress === card.progress ? 'is-active' : ''}`}
                onClick={singlePress(() => selectProgress(card.progress))}
                aria-pressed={progress === card.progress}
                title={tabTitle(
                  progressCardFigures(card, s, byCheque).hint,
                  progress === card.progress
                    ? `Showing ${card.label} only — press ${headLabel()} for every row`
                    : `Show only the ${card.label} rows`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(progressCardFigures(card, s, byCheque).value)}</div>
                <div className="stat__amount">₹ {formatAmount(s.progress?.[card.progress]?.amount ?? 0)}</div>
                <div className="stat__hint">{progressCardFigures(card, s, byCheque).hint}</div>
              </button>
            ) : card.kind === 'csd' ? (
              <button
                key={card.stage}
                type="button"
                className={`card stat stat--${card.tone} ${progress === card.stage ? 'is-active' : ''}`}
                onClick={singlePress(() => selectProgress(card.stage))}
                aria-pressed={progress === card.stage}
                title={tabTitle(
                  csdCardFigures(card, s, byCheque).hint,
                  progress === card.stage
                    ? `Showing ${card.label} only — press ${headLabel()} for every row`
                    : `Show only the ${card.label} rows`,
                )}
              >
                <div className="stat__label">{card.label}</div>
                <div className="stat__value">{count(csdCardFigures(card, s, byCheque).value)}</div>
                <div className="stat__amount">₹ {formatAmount(s.csd?.[card.stage]?.amount ?? 0)}</div>
                <div className="stat__hint">{csdCardFigures(card, s, byCheque).hint}</div>
              </button>
            ) : (
              /* A count: pressing it opens its view, and where it heads a row
                 that divides it, clears whatever is narrowing that row. */
              <button
                key={card.status}
                type="button"
                className={`card stat stat--${card.tone ?? card.status.toLowerCase()} ${bucketActive(card) ? 'is-active' : ''}`}
                onClick={singlePress(() => pressBucket(card))}
                aria-pressed={bucketActive(card)}
                title={tabTitle(card.hint, bucketTitle(card))}
              >
                <div className="stat__label">{bucketLabel(card)}</div>
                <div className="stat__value">{count(bucketFigure(card).count)}</div>
                <div className="stat__amount">₹ {formatAmount(bucketFigure(card).amount ?? 0)}</div>
                <div className="stat__hint">{card.hint}</div>
              </button>
            ),
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar__actions">
          {/* MSME or Non-MSME vendors, on every view -- first, since it narrows
              the whole page (cards, rows and export). */}
          <MsmeFilter value={msme} onChange={selectMsme} />
          {/* The view's own dropdown, asking whichever question the view
              underneath can answer -- see the same place in Results.jsx. */}
          {status === BPAD ? (
            <>
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
                    {deptLabel(d.dept)} ({count(d.count)})
                  </option>
                ))}
                {dept && !departments.some((d) => d.dept === dept) && <option value={dept}>{deptLabel(dept)}</option>}
              </select>
              <label
                className="ageing-asof"
                title="Not Integrated in Accounts counts the bills with an Accounts Received Date from this day to the latest. Clear it to count every date."
              >
                Accounts received from
                <input
                  className="field__input stage-filter"
                  type="date"
                  max="9999-12-31"
                  value={accountsFrom}
                  onChange={(e) => selectAccountsFrom(e.target.value)}
                  aria-label="Count the bills not integrated in Accounts from this Accounts Received Date"
                />
                {accountsFrom && (
                  <button
                    type="button"
                    className="ghost icon-btn"
                    onClick={() => selectAccountsFrom('')}
                    title="Clear the date — count every Accounts Received Date"
                    aria-label="Clear the Accounts received from date"
                  >
                    <IconX size={14} />
                  </button>
                )}
              </label>
            </>
          ) : status === ALL_GRNS ? (
            <select
              className="field__input stage-filter"
              value={matchFilter}
              onChange={(e) => selectMatchFilter(e.target.value)}
              aria-label="Filter the table by reconciliation status"
            >
              <option value="">All</option>
              {MATCH_FILTERS.map((f) => {
                // With a BPAD status on file the pending half listed is the
                // bills it places at a desk (apiDept) -- so the option says
                // that and carries that figure, as the View dropdown does. The
                // ones still at the GRN store are that card's, on this row.
                const atBpad = f.value === 'PENDING' && registerOnFile;
                const figure = s ? (atBpad ? bucketFigure(CARD_BY_ID.PENDING) : s[f.value]) : null;
                return (
                  <option key={f.value} value={f.value}>
                    {atBpad ? 'Pending at BPAD' : f.label}
                    {figure ? ` (${count(figure.count)})` : ''}
                  </option>
                );
              })}
            </select>
          ) : status === 'PENDING' || status === HELD_TAB.status || status === TURNAROUND ? null : (
            <>
              {inChequeNotPrepared ? (
                /* The Supply Type cards as a dropdown -- no Status dropdown
                   here: the section IS one status. */
                <select
                  className="field__input stage-filter"
                  value={supplyType}
                  onChange={(e) => selectSupplyType(e.target.value)}
                  aria-label="Filter the table by the vendor's Supply Type"
                >
                  <option value="">All supply types</option>
                  {SUPPLY_TYPE_CARDS.filter((card) => cardShown({ kind: 'supplyType', ...card }, s, supplyType)).map(
                    (card) => (
                      <option key={card.id} value={card.supplyType}>
                        {card.label} ({count(supplyCardFigure(card, s).count)})
                      </option>
                    ),
                  )}
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
                      {s?.progress?.[f.value] ? ` (${count(s.progress[f.value].count)})` : ''}
                    </option>
                  ))}
                </select>
              )}
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
                    {f.count !== null ? ` (${count(f.count)})` : ''}
                  </option>
                ))}
              </select>
            </>
          )}
          <input
            className="field__input search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, vendor code, GRN, bill or cheque no."
            aria-label="Search by vendor name, GRN number, bill number or cheque number"
          />

          {/* Acting on several GRNs at once -- sending them to CSD, receiving
              them back from it, or sending them on -- whichever the ticked
              rows agree on. The toggle doubles as its own cancel. */}
          {offersBulk && (
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
                    if (value === 'VENDOR' || value === 'COURIER') {
                      setBulkForwardError('');
                      setBulkForwardTo(value);
                    } else if (value === 'BANK') forwardSelectedSimple('BANK');
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

      {status === TURNAROUND ? (
        /* The hospital page's own view, fed the pharmacy rows over the
           pharmacies' chain: from the GRN, there being no PR, PO or security
           step. An administrator corrects a captured date in place, as there. */
        <>
          {/* Where each date is read from, since no one report has them all. */}
          <p className="table__note">
            Counted from the GRN. <strong>GRN</strong> is the InvDate of the GRN Purchase report;{' '}
            <strong>Audit</strong> and <strong>Accounts</strong> are the BPAD Received Date and Accounts Received
            Date of the BPAD report; <strong>Cheque</strong> is the ChqDate of the Vendor Age report; the CSD and
            Accounts steps after it are the days they were done here; and <strong>Cheque Clearance</strong> is the
            bank statement&rsquo;s. Audit and Accounts are blank for a unit with no BPAD bill status on file.
          </p>
          <TurnaroundView
            batchId="all"
            q={q}
            location={location}
            msme={msme}
            spans={spans}
            onSpansChange={setSpans}
            load={api.phTurnaround}
            updateDates={api.phUpdateCsdDates}
            sourceDated={false}
            chain={PHARMACY_CHAIN}
          />
        </>
      ) : status === BPAD && summary && !registerOnFile && !msme ? (
        /* No status on file for these GRNs: say so rather than draw an empty
           table under a view called BPAD. Not while the MSME dropdown is
           narrowing: bpad.onFile is counted inside that choice, so zero there
           means no bill of those vendors, not no file -- and the empty table
           below is the answer. */
        <div className="alert alert--info">
          <strong>No BPAD bill status is on file{location ? ` for ${location}` : ''}.</strong> Upload one on{' '}
          {OP_PHARMACY_LABELS.upload} to see which desk each bill is with.
        </div>
      ) : loading && !shown ? (
        <div className="loading">Loading…</div>
      ) : (
        shown && (
          <>
            <div className="table-wrap table-wrap--sticky">
              {/* By the view, not by the rows asked for: Total GRNS narrowed
                  to one of its halves keeps its own wide layout, and the
                  Cheque Not Prepared section is the Accounts table by GRN. */}
              {status === BPAD
                ? bpadTable(shown.rows)
                : isAccountsSection(status)
                  ? accountsTable(shown.rows)
                  : status === 'PENDING'
                    ? pendingTable(shown.rows)
                    : totalTable(shown.rows)}
            </div>

            <div className="pager">
              <span className="pager__info">
                {shown.total === 0
                  ? action
                    ? `No rows at ${actionFilters.find((f) => f.value === action)?.label ?? action} here — choose All actions to see the rest`
                    : q
                      ? `Nothing matches "${q}"`
                      : 'No rows'
                  : `Showing ${(shown.page - 1) * shown.pageSize + 1}–${Math.min(
                      shown.page * shown.pageSize,
                      shown.total,
                    )} of ${count(shown.total)}`}
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
                  disabled={shown.page <= 1}
                >
                  Previous
                </button>
                <span className="pager__page">
                  Page {shown.page} of {shown.totalPages}
                </span>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => setPage((p) => Math.min(shown.totalPages, p + 1))}
                  disabled={shown.page >= shown.totalPages}
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
