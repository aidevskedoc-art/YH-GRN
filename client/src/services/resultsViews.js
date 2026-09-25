/**
 * What the results screen and the Accounts Department both have to agree on.
 *
 * Two screens now show the Accounts view and the PR-to-Bank ageing: the
 * results screen, where they are two of five views, and the Accounts Department,
 * where they are the only two. They read the same rows from the same endpoints
 * and they have to read them under the same wording -- a stage renamed on one
 * and not the other is the same GRN reported two ways -- so the declarations
 * neither page owns alone live here rather than in whichever page was written
 * first.
 *
 * Everything in this file is a declaration or a pure predicate over one row.
 * The state, the handlers and the layout belong to each page, because that is
 * where the two genuinely differ.
 */
import { chequePrepared } from './cheque.js';
import { titleForStatus } from './exporter.js';

/**
 * The GRNs the ageing report has picked up. Both matched statuses at once: a
 * GRN found there has reached accounts even when the bill number differs, so
 * those rows are counted as valid rather than held in a separate "needs
 * review" bucket. The difference is still stored per row (`discrepancyNotes`),
 * for anyone reading it off the API directly, though neither screen nor export
 * shows it any more.
 */
export const VALID = 'VALID';

/**
 * How long each step took, per GRN -- indent to PO to GRN, through audit and
 * accounts, to the cheque and the bank.
 *
 * The one view that is not a bucket: every other names a population with a
 * count and a value, which is what a stat card shows, and this measures
 * elapsed time over one of those populations. Hence `card: false` on its tab
 * below -- it belongs in the view dropdown but not in the row of cards.
 */
export const TURNAROUND = 'TURNAROUND';

/**
 * The bucket the ageing report measures. Every GRN with an ageing row has the
 * stage dates, and that is exactly the Accounts bucket -- so on the turnaround
 * view the Accounts card is marked active, answering "what is this counting?"
 * rather than going dead because no bucket is selected.
 */
export const TURNAROUND_SCOPE = VALID;

/**
 * Every GRN in scope, pending and valid together -- the upload as it arrived,
 * before the reconciliation splits it in two. The server knows the name and
 * treats it as no filter at all.
 */
export const ALL_GRNS = 'ALL';

/**
 * The BPAD register's own view. It reads a different table from the three
 * reconciliation views -- so its rows come from the register rather than from
 * /results, and the toolbar's status filters have nothing to ask it.
 */
export const BPAD = 'BPAD';

/**
 * The BPAD rows the register had no entry for -- what the Not in BPAD card
 * asks for. The server knows the word (see bpadRegisterFilter in
 * routes/results.js); '' is every row.
 */
export const MISSING = 'missing';

/**
 * Its opposite: the rows the register does have an entry for, which is what
 * the BPAD card counts (see bpadRegister in routes/results.js). The BPAD view
 * itself lists every GRN in scope and says so in its own banner, so only the
 * card's sheet carries this -- see cardSheet.
 */
export const IN_REGISTER = 'in';

/**
 * The bucket the Pending breakdown puts the GRNs it cannot place in -- the
 * register has no entry for them at all, or it has one with Pending With
 * Dept. left blank. Both mean the same to whoever is reading the card, so
 * they are one bucket.
 *
 * Spelled exactly as the server spells it (NOT_IN_BPAD in routes/results.js),
 * because the card hands it straight back as the filter value.
 */
export const NOT_IN_BPAD = '__not_in_bpad__';

/**
 * The other side of it: every GRN the register DOES place at a desk, which is
 * what the Pending figure counts once a register has been uploaded (see
 * bucketFigure in Results.jsx). Spelled as the server spells it -- IN_BPAD in
 * routes/results.js -- because it travels as the same `dept` filter value.
 */
export const IN_BPAD = '__in_bpad__';

/**
 * A desk's name the way a label should read, not the way the register stores
 * it: "PURCHASE DEPARTMENT" -> "Purchase Department".
 *
 * The BPAD workbook is typed in capitals throughout, which is fine in a
 * spreadsheet column and wrong on a card -- a row of cards is read at a glance,
 * and four of them shouting makes the one that matters no easier to find.
 *
 * Word by word over the letter runs, so a desk written "STORES/MAIN" comes back
 * "Stores/Main" rather than losing its separator. Two things are deliberately
 * left alone: a word that is not all capitals already (a register that writes
 * "Purchase Dept." keeps its own spelling rather than being re-cased around
 * it), and an all-capitals word of three letters or fewer, which is an
 * initialism -- IT, HR, MD, GM -- and reads as a typo once it becomes "It".
 */
function deptCase(name) {
  return String(name).replace(/[A-Za-z]+/g, (word) => {
    if (word !== word.toUpperCase()) return word;
    if (word.length <= 3) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  });
}

/**
 * What a desk is called on screen -- and, through sectionSheets below, on its
 * sheet in the workbook, so the two cannot disagree.
 *
 * The bucket for the GRNs the register cannot place has wording of its own and
 * keeps it: it is not a desk, and "Not In BPAD" is not what anybody calls it.
 */
export function deptLabel(dept) {
  return dept === NOT_IN_BPAD ? 'Not in BPAD' : deptCase(dept);
}

/**
 * Whether a desk the register names is the Accounts department.
 *
 * Pending With Dept. is free text out of somebody else's workbook -- the
 * values on file are ACCOUNTS, AUDIT, STORES, PURCHASE DEPARTMENT and CIVIL
 * DEPARTMENT -- so this matches the word rather than one exact spelling, and a
 * file that starts writing "Accounts Dept." keeps working with no edit here.
 *
 * Anchored at the start, so a desk that merely mentions accounts further along
 * its name is not swept in with it; and no letter may follow, so the word has
 * to end there. That end is a lookahead rather than `\b` on purpose: a `\b`
 * here was once saved into this file as a literal backspace character, which
 * matched nothing at all and quietly turned the Accounts card into a plain
 * filter card.
 *
 * It is the one desk this system has a screen of its own for, which is what
 * the card on the BPAD row does with the answer -- see the deptAccounts card
 * in Results.jsx.
 */
export function isAccountsDept(dept) {
  return typeof dept === 'string' && /^accounts(?![a-z])/i.test(dept.trim());
}

/** The Accounts view, as the view dropdown and the export sheet name it. */
export const ACCOUNTS_TAB = { status: VALID, label: 'Accounts', hint: 'Found in the ageing report' };

/**
 * The Accounts Department's two ways of reading its Accounts table.
 *
 * GRN view is a row per GRN, as the results screen shows it, without the
 * cheque's own columns; its cards lead with GRN counts. Cheque view is a row
 * per cheque -- the bills one cheque pays folded together, their PayableAmount
 * summed into a Cheque Amount -- and its cards lead with cheque counts.
 *
 * The values are what the rows endpoint's `view` parameter takes.
 */
export const ACCOUNTS_GRN_VIEW = 'grn';
export const ACCOUNTS_CHEQUE_VIEW = 'cheque';

/**
 * A card's two counts, arranged for the view: on Cheque view the cheque count
 * is the headline and the GRNs it covers read on the line below; on GRN view
 * the other way round. `sub` is that line's count and noun ("12 cheques"),
 * for the caller to finish with its own wording.
 */
export function leadFigures({ grns = 0, cheques = 0 }, byCheque) {
  const [value, n, noun] = byCheque ? [cheques, grns, 'GRN'] : [grns, cheques, 'cheque'];
  return { value, sub: `${n.toLocaleString('en-IN')} ${noun}${n === 1 ? '' : 's'}` };
}

/** The ageing view, same. See TURNAROUND above for the `card: false`. */
export const TURNAROUND_TAB = {
  status: TURNAROUND,
  label: 'GRN age from PR to Bank',
  hint: 'Days at each step',
  card: false,
};

/**
 * The CSD stages, as cards on the Accounts row.
 *
 * Cheques big, GRNs small. A cheque pays a group of bills and is what actually
 * gets handed to CSD, so "how many cheques are sitting at this stage" is the
 * figure being looked for; how many GRNs those cheques cover is the supporting
 * detail, and it reads on the line below. The two are a long way apart -- one
 * cheque here covers twenty-five bills -- so leading with the GRN count
 * answered a question nobody on this row was asking.
 *
 * `note` rather than `hint`, because the hint line is built at render time out
 * of the GRN count and this wording together. Pressing the card still filters
 * the table to the GRNs, which is the smaller of the two numbers printed on
 * it -- worth knowing, and the reason the GRN count stays on the card at all.
 *
 * The four figures do not add up to anything: a cheque whose bills sit at two
 * stages at once is counted at both. See the csd query in routes/results.js.
 */
export const CSD_CARDS = [
  { stage: 'QUEUED', label: 'CSD Pending', note: 'awaiting CSD', tone: 'queued' },
  { stage: 'RECEIVED', label: 'CSD Received', note: 'CSD have them', tone: 'received' },
  { stage: 'APPROVED', label: 'CSD Approved', note: 'cleared by CSD', tone: 'approved' },
  { stage: 'REJECTED', label: 'CSD Rejected', note: 'sent back', tone: 'rejected' },
];

/**
 * Where each Accounts bill stands on its cheque, as three cards following the
 * Accounts count: a cheque drawn up, one still to come, or none needed at all
 * because there is nothing left to pay (a PayableAmount of zero or under a
 * rupee). The three are exhaustive over that row -- every Accounts GRN is in
 * exactly one -- so they sum to the Accounts count, which the CSD four do not.
 * See CHEQUE_PREPARED in routes/results.js for where the lines are drawn.
 *
 * They read a `progress` key rather than a CSD stage, so `kind: 'progress'`
 * where the CSD cards are `kind: 'csd'`. Both set the same filter, which is
 * what keeps every card on this row mutually exclusive.
 *
 * Neutral, where the CSD four run warn / info / ok / danger. There are no
 * colours left in that ladder, and borrowing from it would put the same amber
 * on "awaiting CSD" and "no cheque yet" -- two unrelated answers side by side.
 */
export const CHEQUE_CARDS = [
  {
    progress: 'CHEQUE_PREPARED',
    label: 'Cheque Prepared',
    /*
     * Cheques big, GRNs small -- the one card on this row whose headline is
     * not the number of rows below it. One cheque pays a group of GRNs, so the
     * two figures are a long way apart: 349 cheques cover 1,370 bills, and the
     * biggest single cheque covers twenty-five of them.
     *
     * Both stay on the card, which matters because pressing it still filters
     * the table to the GRNs -- the smaller of the two numbers printed on it.
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
  // The bills no cheque is coming for: nothing left to pay. Beside Cheque Not
  // Prepared because it is the other half of what that card used to count.
  {
    progress: 'PAYMENT_NOT_REQUIRED',
    label: 'Payment Not Required',
    hint: 'Payable ₹0 or under ₹1',
  },
];

/**
 * The Accounts Queue: GRNs CSD has handed back that Accounts has not received
 * yet -- the rows whose Action column still reads Queued. It comes after the
 * CSD four, being where a GRN lands once CSD are done with it (see
 * ACCOUNTS_ROW).
 *
 * A `progress` card like the cheque pair, reading RETURNED_BY_CSD (see PROGRESS
 * in routes/results.js) -- the same clause as the Action dropdown's "Accounts
 * queue" option. Cheques and GRNs swap with the view, as on Cheque Prepared.
 */
export const ACCOUNTS_QUEUE_CARD = {
  progress: 'RETURNED_BY_CSD',
  label: 'Accounts Queue',
  tone: 'moved_to_accounts',
  value: (summary) => summary?.accountsQueueCheques ?? 0,
  hint: (summary) => {
    const grns = summary?.progress?.RETURNED_BY_CSD?.count ?? 0;
    return `${grns.toLocaleString('en-IN')} GRN${grns === 1 ? '' : 's'} awaiting Accounts`;
  },
};

/**
 * Accounts Received: the queue's next step. GRNs Accounts has acknowledged
 * from CSD and not yet forwarded on to Bank, Vendor or Courier -- the rows
 * whose Status reads "Accounts received". Last on the row, after the queue it
 * is taken from.
 *
 * Same shape as the Accounts Queue, reading ACCOUNTS_RECEIVED (see PROGRESS in
 * routes/results.js). The green of its own "Accounts received" pill in the
 * Status column, as the queue card wears its pill's brand orange.
 */
export const ACCOUNTS_RECEIVED_CARD = {
  progress: 'ACCOUNTS_RECEIVED',
  label: 'Accounts Received',
  tone: 'approved',
  value: (summary) => summary?.accountsReceivedCheques ?? 0,
  hint: (summary) => {
    const grns = summary?.progress?.ACCOUNTS_RECEIVED?.count ?? 0;
    return `${grns.toLocaleString('en-IN')} GRN${grns === 1 ? '' : 's'} received by Accounts`;
  },
};

/**
 * What a `progress` card (the cheque cards, the two Accounts cards) prints,
 * for the view. A card with a cheque figure swaps it with the GRN count by view; one
 * without reads the same on both.
 */
export function progressCardFigures(card, summary, byCheque) {
  const grns = summary?.progress?.[card.progress]?.count ?? 0;
  if (typeof card.value !== 'function') {
    return { value: grns, hint: typeof card.hint === 'function' ? card.hint(summary) : card.hint };
  }
  if (byCheque) return { value: card.value(summary), hint: card.hint(summary) };
  return { value: grns, hint: leadFigures({ grns, cheques: card.value(summary) }, false).sub };
}

/** What a CSD stage card on the Accounts row prints, for the view. */
export function csdCardFigures(card, summary, byCheque) {
  const bucket = summary?.csd?.[card.stage] ?? {};
  const { value, sub } = leadFigures({ grns: bucket.count ?? 0, cheques: bucket.cheques ?? 0 }, byCheque);
  return { value, hint: `${sub} ${card.note}` };
}

/**
 * The Accounts row, in the order it is shown -- on both screens, which is why
 * it is settled here rather than composed twice.
 *
 * It reads as the work goes, from the outside in. The count leads: how many
 * GRNs are in accounts at all. Then where each stands on its cheque -- drawn
 * up, still to come, or not needed -- which is the first thing that has to
 * happen and is exhaustive over the row: the three sum back to the count
 * standing over them. Then how far through the CSD handover the ones with a
 * cheque have got, which is the part of the row that moves day to day.
 *
 * The count used to be left off, on the reasoning that a figure standing over
 * cards that do not sum to it invites the arithmetic anyway -- and the CSD four
 * do not sum to it. What changed is the order: the cards that DO sum to it
 * now sit directly under it, so the row answers the arithmetic it invites
 * before the CSD stages, which are a different question, are reached. The
 * count is also what the Accounts card has to be pressable for -- it is the
 * "all of them" at the head of a row of filters, the same as the Pending card
 * over its desks.
 *
 * Entries are the ids CARD_BY_ID files each card under on either page -- a
 * reconciliation status for the count, a `progress` key for the cheque cards
 * and the two Accounts cards, a CSD stage for the four.
 *
 * The two Accounts cards close the row, Queue then Received: they are where a
 * GRN goes once CSD hand it back, so they follow the CSD four in the order the
 * work does.
 */
export const ACCOUNTS_ROW = [
  VALID,
  ...CHEQUE_CARDS.map((card) => card.progress),
  ...CSD_CARDS.map((card) => card.stage),
  ACCOUNTS_QUEUE_CARD.progress,
  ACCOUNTS_RECEIVED_CARD.progress,
];

/**
 * The Status column's own values, as the Action filter beside the search box
 * names them.
 *
 * Every one of these is something that column says, spelled the way the pill
 * in it spells it -- so picking one asks for the rows showing it rather than
 * for an adjacent idea a reader has to translate. The server owns the meaning
 * of each key (see PROGRESS in routes/results.js); this is the wording and the
 * order they are offered in.
 *
 * The order follows a GRN's life rather than the alphabet: ready to send, out
 * to one of the two destinations, through CSD's answers, back with Accounts
 * and on from there, then paid.
 *
 * They deliberately overlap, because the column does. A GRN whose cheque
 * cleared while it sat at CSD shows both, and is found under both.
 */
export const PROGRESS_LABELS = {
  // The rows whose Send picker offers Send to CSD: gone nowhere yet, with a
  // cheque drawn up to hand over. The Action dropdown's alone: it is what the
  // Action cell offers rather than anything the Status column says, so the
  // server keeps it out of PROGRESS and the Status dropdown never sees it (see
  // ACTIONS in routes/results.js). Plain "not sent" is not offered at all.
  SEND_TO_CSD: 'Send to CSD (ready to send)',
  QUEUED: 'Sent to CSD',
  RECEIVED: 'CSD received',
  APPROVED: 'CSD approved',
  REJECTED: 'CSD rejected',
  // Accounts' own hand-back ladder, once CSD reaches MOVED_TO_ACCOUNTS -- see
  // ACCOUNTS_RETURN_STATES in ResultsTable.jsx for the same two labels.
  // Named for the queue it is, with the Status pill's own wording beside it so
  // the option and the rows it finds are recognisably the same thing.
  RETURNED_BY_CSD: 'Accounts queue (Handover by CSD)',
  ACCOUNTS_RECEIVED: 'Accounts received',
  // Where Accounts forwards a received GRN on to -- see forwardedLabel in
  // ResultsTable.jsx for the same labels.
  BANK: 'Sent to Bank',
  VENDOR: 'Sent to Vendor',
  PURCHASE_DEPT: 'Sent to Purchase Dept',
  OTHERS: 'Sent to Others',
  COURIER: 'Sent to Courier',
  RECORDS: 'Sent to Records',
  // Ahead of Cheque cleared, which is the next thing that happens to a cheque
  // once it exists. Read off the ageing report's own cheque columns rather
  // than recorded here -- see CHEQUE_PREPARED in routes/results.js.
  CHEQUE_PREPARED: 'Cheque prepared',
  CHEQUE_NOT_PREPARED: 'Cheque not prepared',
  PAYMENT_NOT_REQUIRED: 'Payment not required',
  CLEARED: 'Cheque cleared',
};

/** This list's own order -- a GRN's life rather than the alphabet. */
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

/** PROGRESS_ORDER's order, then arrival for anything it has no wording for. */
function byProgressOrder(a, b) {
  const ia = PROGRESS_ORDER.indexOf(a);
  const ib = PROGRESS_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return 0;
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

/** The cheque cards' own keys: the cards' question, not a place a row gets to. */
const CHEQUE_PROGRESS = new Set(CHEQUE_CARDS.map((card) => card.progress));

/** What the other cards setting `progress` are called on the row. */
const CARD_LABELS = Object.fromEntries([
  ...CSD_CARDS.map((card) => [card.stage, card.label]),
  [ACCOUNTS_QUEUE_CARD.progress, ACCOUNTS_QUEUE_CARD.label],
  [ACCOUNTS_RECEIVED_CARD.progress, ACCOUNTS_RECEIVED_CARD.label],
]);

/**
 * The Status dropdown's options: whether a cheque has been drawn up -- the
 * cheque keys the summary carries (see PROGRESS in routes/results.js), in
 * PROGRESS_ORDER. Everything about where a row has got to is the Action
 * dropdown's beside it (see actionFilterOptions), and offering it here as well
 * would put the same question in two places.
 *
 * `selected` is the `progress` the page has set. A CSD or Accounts card sets
 * a value this list does not offer, so while one is chosen it is added under
 * the card's own name -- otherwise the dropdown would read "All statuses"
 * over a table the card is narrowing.
 */
export function progressFilterOptions(summary, selected = '') {
  const options = Object.keys(summary?.progress ?? {})
    .filter((key) => CHEQUE_PROGRESS.has(key))
    .sort(byProgressOrder)
    .map((key) => ({ value: key, label: PROGRESS_LABELS[key] || fallbackProgressLabel(key) }));
  if (selected && !options.some((option) => option.value === selected)) {
    options.push({
      value: selected,
      label: CARD_LABELS[selected] || PROGRESS_LABELS[selected] || fallbackProgressLabel(selected),
    });
  }
  return options;
}

/**
 * The Action dropdown's options: where a row stands in its own journey. Its
 * own dropdown, beside the Status one on the Accounts view.
 *
 * It narrows on top of whichever card or Status value is selected rather than
 * replacing it -- Cheque Prepared on the cards, then CSD received here, is the
 * bills with a cheque that CSD have received. So it offers every Status value
 * but the cheque three, which are the cards' question.
 *
 * `counts` is the rows response's `actionCounts` (see ACTION_KEYS in
 * routes/results.js): how many rows each option leaves inside the card and
 * search as they stand, so the number beside an option is the number of rows
 * picking it shows. Its keys are the options, so a value added on the server
 * shows up with no edit here; until it arrives, the ones this file knows are
 * offered without a count.
 */
export function actionFilterOptions(counts) {
  const keys = counts ? Object.keys(counts) : PROGRESS_ORDER.filter((key) => !CHEQUE_PROGRESS.has(key));
  return keys
    .sort(byProgressOrder)
    .map((key) => ({
      value: key,
      label: PROGRESS_LABELS[key] || fallbackProgressLabel(key),
      count: counts?.[key] ?? null,
    }));
}

/*
 * What "Select multiple" can batch, mirroring a row's own journey: sending
 * several to CSD, acknowledging several CSD has handed back to Accounts, and
 * forwarding several Accounts has already received on to Bank, Vendor or
 * Courier. A row only ever qualifies for one of the three at a time -- they
 * are consecutive steps -- so a selection is only ever actioned once every
 * ticked row agrees on which one applies.
 *
 * Kept in step by hand with ResultsTable's own copies of these checks, which
 * decide only whether a row's checkbox is there to tick at all; these decide
 * what ticking it, and the rows it drags in by cheque number, are allowed to
 * do.
 *
 * `canCsd` is the caller's `can('csd')`: handing a GRN over needs that screen,
 * and these are predicates rather than hooks.
 */

/**
 * Whether this account may hand GRNs to CSD, and take them back again.
 *
 * Not the CS Department screen alone: handing over is Accounts' side of the
 * handover, done from the Results and Accounts tables, so either of those
 * screens is enough. CSD's own queue (stage moves and the rest) still needs the
 * CSD screen. Mirrors CSD_HANDOVER in routes/csd.js. `can` is useAuth's.
 */
export function canHandToCsd(can) {
  return can('csd') || can('results') || can('accounts-department');
}

export function bulkCsdEligible(row, canCsd) {
  return (
    canCsd &&
    row.status !== 'PENDING' &&
    // Nothing to hand over until a cheque has been drawn up -- the same bar the
    // Send picker puts on its CSD option. Only CSD's: filing to Records asks
    // for no cheque, and there is no bulk version of that to gate.
    chequePrepared(row) === true &&
    row.csdStage !== 'MOVED_TO_ACCOUNTS' &&
    !row.csdSent &&
    !row.recordsSent
  );
}

export function bulkReceiveEligible(row) {
  return row.csdStage === 'MOVED_TO_ACCOUNTS' && (row.csdAccountsStage || 'QUEUED') === 'QUEUED';
}

export function bulkForwardEligible(row) {
  return (
    row.csdStage === 'MOVED_TO_ACCOUNTS' && row.csdAccountsStage === 'RECEIVED' && !row.csdForwardedTo
  );
}

/** Which of the three above a row currently qualifies for, or null for none. */
export function bulkCategory(row, canCsd) {
  if (bulkCsdEligible(row, canCsd)) return 'CSD';
  if (bulkReceiveEligible(row)) return 'RECEIVE';
  if (bulkForwardEligible(row)) return 'FORWARD';
  return null;
}

/* --- The section on screen, as a workbook --------------------------------
   Export Excel hands back the section somebody is looking at, card by card:
   its own sheet first, then one sheet per card standing over it. A section's
   cards ARE how that section divides up -- Total GRNS into the registers each
   GRN has reached, Accounts into how far through the handover each row has
   got, Pending into the desk each bill is sitting at -- so a sheet per card is
   the reading of it the row already offers, in a file.

   Built here rather than in either page because both pages render their rows
   from the same card declarations above, and a sheet list assembled separately
   from them is a sheet list that goes stale the first time a card is renamed.
   Here it cannot: each sheet takes its name from the card's own label and its
   rows from the filter pressing that card sets. The columns and the workbook
   itself belong to services/exporter.js.
   -------------------------------------------------------------------------- */

/**
 * One card's sheet: its label, and the rows pressing it puts on screen.
 *
 * The filters are exactly the ones each card sets -- `progress` for a CSD
 * stage or a cheque card, `dept` for a desk, `register` for Not in BPAD -- so
 * a sheet holds what its card counts, and the two cannot report different
 * populations under one name.
 */
function narrowedSheet(status, label, filters) {
  return {
    status,
    sheetName: label,
    // Which card this is, above the headers. The section's own sheet carries
    // the plain report title; these say which slice of it they are.
    title: `${titleForStatus(status)} — ${label}`,
    ...filters,
  };
}

/**
 * The sheet one card stands for, or null for a card that is not a filter on
 * rows this export can ask for.
 *
 * `kind` is the page's own tag on each card (see CARD_BY_ID on both screens),
 * and every kind is a different question: a bucket card names a whole view, a
 * CSD or cheque card a value of the Status column, a desk card a value of the
 * register's Pending With Dept., and the missing card the register's other
 * column.
 */
function cardSheet(card) {
  switch (card.kind) {
    // A view of its own, whole -- so no narrowing, and its own report title.
    case 'bucket':
      return {
        status: card.status,
        sheetName: card.label,
        title: titleForStatus(card.status),
        // Except BPAD, whose card counts the register's entries while the view
        // lists every GRN in scope, the ones it has no entry for included. The
        // sheet holds what the card says it does; the view's own workbook still
        // gets the whole tab, since that card is the section there and is
        // dropped for it below.
        ...(card.status === BPAD ? { register: IN_REGISTER } : {}),
      };
    // Both read the Status column, which already knows the four stages and the
    // two cheque answers by name -- see PROGRESS in routes/results.js.
    case 'csd':
      return narrowedSheet(VALID, card.label, { progress: card.stage });
    case 'progress':
      return narrowedSheet(VALID, card.label, { progress: card.progress });
    // The pending half by desk. The GRNs the register cannot place travel
    // under the sentinel, the same value the card hands the table.
    case 'pendingDept':
      return narrowedSheet('PENDING', deptLabel(card.dept), { dept: card.dept });
    // The register's own two questions: which desk, and whether it knew the
    // GRN at all.
    //
    // The Accounts desk is the same sheet as any other. Its card opens the
    // Accounts section rather than narrowing the table, but the sheet reports
    // what the card COUNTS -- the register rows sitting at that desk -- and
    // that is unchanged by where pressing it goes.
    case 'dept':
    case 'deptAccounts':
      return narrowedSheet(BPAD, deptLabel(card.dept), { dept: card.dept });
    // The GRNs the register has no entry for. Its card stands on the Total
    // GRNS row and narrows those rows by the desk filter's own sentinel, so
    // the sheet is that section's rows narrowed the same way -- not the
    // register's table, which is a different population.
    case 'missing':
      return narrowedSheet(ALL_GRNS, deptLabel(NOT_IN_BPAD), { dept: NOT_IN_BPAD });
    default:
      return null;
  }
}

/**
 * The section's workbook, as a list of sheets for exportSection.
 *
 * `tab` is the view showing, as its own TABS entry -- so the first sheet is
 * that view whole, named the way the View dropdown names it. `cards` is the
 * row on screen, in the order it is shown, which is the order the sheets come
 * in.
 *
 * The view's own bucket card is dropped where the row carries one: on Total
 * GRNS and Pending the count at the head of the row is the section itself, and
 * a workbook that opened with the same rows twice under two names would have a
 * reader checking which of the two to trust. Accounts and BPAD have no such
 * card -- their rows are entirely about how the section divides -- so those
 * get the section's sheet from `tab` and nothing is dropped.
 *
 * The ageing view is the exception to all of it: one sheet, its own. The four
 * counts on that row are the only cards on either screen that do not divide
 * the view they stand over -- they are the reconciliation's populations, and
 * this view measures elapsed time across one of them (see TURNAROUND_SCOPE).
 * So a sheet per card there would hand back four sheets of GRNs with no day
 * counts on them, under a file named for the ageing report, which is three
 * reports nobody asked for and one that does not say what the name says.
 */
export function sectionSheets(tab, cards, options = {}) {
  /*
   * `labelFor` is the page's own wording for a card, where the card on screen
   * is named something the declaration alone does not know -- Pending reads
   * "Pending GRNs at BPAD" once a register is uploaded, and the GRN store card
   * has a name of its own. A sheet named differently from the card it was
   * taken off is a sheet somebody has to match up by hand.
   *
   * `pendingInBpad` is that same register: with one on file, the Pending
   * figure counts the bills it places, so the Pending sheets carry the filter
   * that selects them and hold the rows the card claims.
   */
  const { labelFor, pendingInBpad = false } = options;
  const rename = (sheet, card) => {
    const label = labelFor?.(card);
    if (!label || label === sheet.sheetName) return sheet;
    return {
      ...sheet,
      sheetName: label,
      // A card's sheet says which card it is above its headers; the section's
      // own sheet carries the plain report title and keeps it.
      title: sheet.title === titleForStatus(sheet.status) ? sheet.title : `${titleForStatus(sheet.status)} — ${label}`,
    };
  };
  const placed = (sheet) =>
    pendingInBpad && sheet.status === 'PENDING' && !sheet.dept ? { ...sheet, dept: IN_BPAD } : sheet;

  const ownCard = { kind: 'bucket', ...tab };
  const own = { status: tab.status, sheetName: tab.label, title: titleForStatus(tab.status) };
  if (tab.status === TURNAROUND) return [own];
  const rest = (cards ?? [])
    .map((card) => {
      const sheet = cardSheet(card);
      return sheet ? { sheet, card } : null;
    })
    .filter(Boolean)
    // The section itself, again: same status and nothing narrowing it.
    // The section itself, again: a count card for the view showing IS that
    // view, whatever narrowing its sheet carries elsewhere.
    .filter(
      ({ sheet, card }) =>
        !(
          sheet.status === own.status &&
          (card.kind === 'bucket' || (!sheet.progress && !sheet.dept && !sheet.register))
        ),
    )
    .map(({ sheet, card }) => placed(rename(sheet, card)));
  return [placed(rename(own, ownCard)), ...rest];
}
