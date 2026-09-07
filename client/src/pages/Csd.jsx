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
import LocationFilter from '../components/LocationFilter.jsx';
import { formatAmount, formatDate } from '../components/ResultsTable.jsx';
import { IconTrash } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import PageSizeSelect, { usePageSize } from '../components/PageSize.jsx';


/** Matches the results page's search box -- see the note there. */
const SEARCH_DELAY_MS = 300;

/**
 * The four stages, in the order a handover travels through them.
 *
 * Queued is where Send to CSD puts a row; the other three are CSD's own
 * answers. The colours follow the app's semantic ladder rather than being
 * picked per card: queued is work outstanding (the warning amber the Pending
 * bucket uses), received is in-progress blue, and the two verdicts are the
 * green and red used everywhere else.
 *
 * Every stage a row can be in belongs in this list, whether or not it gets a
 * card -- it is what names a stage in the Status pill and what fills the
 * dropdown, and a row whose stage is missing from here would show the wrong
 * label and offer no way back to it.
 *
 * `card: false` would keep a stage off the KPI row; nothing uses it at present,
 * since all four are worth counting -- what is still waiting on CSD as much as
 * what they have done with it.
 */
const STAGES = [
  { key: 'QUEUED', label: 'Queued', hint: 'Sent, not yet acknowledged', tone: 'queued' },
  { key: 'RECEIVED', label: 'Received', hint: 'CSD have it', tone: 'received' },
  { key: 'APPROVED', label: 'Approved', hint: 'Cleared by CSD', tone: 'approved' },
  { key: 'REJECTED', label: 'Rejected', hint: 'Sent back', tone: 'rejected' },
];

/** The stages that get a KPI card, in the same order. */
const CARD_STAGES = STAGES.filter((s) => s.card !== false);

/**
 * Where a handover may go next, and nowhere else. The server holds the same
 * map and enforces it; this one decides what the dropdown offers, so a move
 * that would be refused is never presented in the first place.
 *
 * A one-way ladder: CSD cannot rule on a bill they have not acknowledged
 * receiving, and having ruled they cannot un-rule. The two verdicts are final,
 * which is why they have no options at all.
 */
const NEXT_STAGES = {
  QUEUED: ['RECEIVED'],
  RECEIVED: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
};

const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

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
];

/**
 * The header row below, counted: twelve columns from GRN No through Status,
 * then one per stage date, then Action. Worked out rather than written as a
 * number, which is what it was -- and the number had already drifted out of
 * step with the row it is meant to span.
 */
const COLUMN_COUNT = 12 + STAGE_DATES.length + 1;

/**
 * The two matched statuses, spelled for a reader. A GRN reaches CSD from either
 * of them; the second is the one whose bill number or vendor spelling did not
 * agree, which is worth carrying through the handover rather than flattening.
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
  const label = STAGE_LABELS[row.stage] || row.stage;

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
      aria-label={`Move GRN ${row.dprNo} to its next CSD stage`}
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
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

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
  }, [stage, location]);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listCsd({ page, pageSize, q, stage, location })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, pageSize, q, stage, location]);

  useEffect(load, [load]);

  /**
   * Pick a stage to look at, or press the chosen one again to see everything.
   *
   * Unlike the results page's cards -- where one bucket is always selected,
   * because every GRN is in exactly one of them -- "all four" is a legitimate
   * view here, and it is the one the screen opens on.
   */
  function selectStage(next) {
    // A card toggles: pressing the chosen one again clears the filter.
    applyStage(stage === next ? '' : next);
  }

  /**
   * Show one stage, or every stage for ''. What the dropdown calls; the cards
   * go through selectStage above so they can also toggle off.
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
      await exportCsd(q, stage, location);
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
  async function handleStage(row, next) {
    if (next === row.stage) return;
    setBusy(row.id);
    setError('');
    try {
      await api.setCsdStage(row.id, next);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Take one GRN back off the queue.
   *
   * Confirmed, because it is the only destructive control on the page and the
   * results tab's Send button silently goes back to unsent when it lands.
   */
  async function handleRemove(row) {
    const ok = await confirm({
      title: 'Take this GRN back?',
      message: `Are you sure you want to take GRN ${row.dprNo} off the CSD queue?`,
      confirmLabel: 'Take back',
    });
    if (!ok) return;

    setBusy(row.id);
    setError('');
    try {
      await api.removeFromCsd(row.id);
      // Removing the last row of the last page would otherwise leave the pager
      // pointing past the end of a now-shorter queue.
      if (data.rows.length === 1 && page > 1) setPage((p) => p - 1);
      else load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
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
  // The location filter is counted inside the same way and so is guarded the
  // same way: a branch nothing has been sent from yet is not an empty queue.
  const queueEmpty =
    data &&
    !q &&
    !location &&
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
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Sent to CSD</h2>
          <p className="page__lead">
            {data
              ? `${data.total.toLocaleString('en-IN')} GRN${data.total === 1 ? '' : 's'}` +
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
          <LocationFilter value={location} onChange={setLocation} />
        </div>
      </div>

      {data?.stages && (
        <div className="cards">
          {CARD_STAGES.map((s) => {
            const bucket = data.stages[s.key] || { count: 0, amount: 0 };
            return (
              <button
                key={s.key}
                type="button"
                className={`card stat stat--${s.tone} ${stage === s.key ? 'is-active' : ''}`}
                onClick={() => selectStage(s.key)}
                aria-pressed={stage === s.key}
              >
                <div className="stat__label">{s.label}</div>
                <div className="stat__value">{bucket.count.toLocaleString('en-IN')}</div>
                <div className="stat__amount">₹ {formatAmount(bucket.amount)}</div>
                <div className="stat__hint">{s.hint}</div>
              </button>
            );
          })}
        </div>
      )}
      {/* The same strip the results page carries above its table. That page
          fills the left half with its tab pills; this one has no tabs, so the
          controls take the right and the strip is otherwise empty. */}
      <div className="toolbar">
        <div className="toolbar__actions">
          {/* The same four stages the cards count, as a list. Either control
              sets the filter and both read it back from the URL, so they cannot
              disagree about what the table is showing. */}
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
            placeholder="Search vendor, GRN or bill no."
            aria-label="Search the CSD queue by vendor name, GRN number or bill number"
          />
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
              <table className="table">
                <thead>
                  <tr>
                    <th className="table__pin">GRN No</th>
                    <th>Division</th>
                    <th>GRN Date</th>
                    <th>Bill No</th>
                    <th>Bill Date</th>
                    <th>Vendor</th>
                    {/* The code used to sit under the name, where it could not
                        be read down the column. Location comes off the GRN
                        report and is kept on the handover's own snapshot, so it
                        still reads once that upload has gone. */}
                    <th>Vendor Code</th>
                    <th>Location</th>
                    <th>Focus doc_no</th>
                    <th className="table__num">NetAmt</th>
                    <th className="table__num">PayableAmount</th>
                    {/* <th>Match</th> */}
                    <th>Status</th>
                    {/* One column per stage, each showing the day the handover
                        reached it. A blank is a stage this GRN has not got to,
                        which is why they are not collapsed into one "last
                        moved" column: the gap is the information. */}
                    {STAGE_DATES.map((d) => (
                      <th key={d.key}>{d.label}</th>
                    ))}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr>
                      <td className="table__empty" colSpan={COLUMN_COUNT}>
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
                      <td className="table__mono table__pin">{row.dprNo}</td>
                      <td>{row.divisionCode}</td>
                      <td>{formatDate(row.dprDate)}</td>
                      <td className="table__mono">{row.billNo}</td>
                      <td>{formatDate(row.billDate)}</td>
                      <td>{row.vendorName}</td>
                      <td className="table__mono">
                        {row.vendorCode || <span className="table__miss">&mdash;</span>}
                      </td>
                      {/* Blank on a handover sent before the column existed:
                          the upload it was read from may be gone, and there is
                          nowhere else to recover it from. */}
                      <td>{row.location || <span className="table__miss">&mdash;</span>}</td>
                      <td className="table__mono">{row.ageingGrnNo}</td>
                      <td className="table__num">{formatAmount(row.netAmt)}</td>
                      <td className="table__num">{formatAmount(row.payableAmount)}</td>
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
                        <span className={`pill pill--${row.stage.toLowerCase()}`}>
                          {STAGE_LABELS[row.stage] || row.stage}
                        </span>
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
                      <td>
                        <div className="row-actions">
                          <StagePicker
                            row={row}
                            busy={busy === row.id}
                            onPick={(next) => handleStage(row, next)}
                          />
                          <button
                            type="button"
                            className="csd csd--take-back"
                            disabled={busy === row.id}
                            onClick={() => handleRemove(row)}
                            title={`Take GRN ${row.dprNo} back off the CSD queue`}
                          >
                            <span className="csd__icon">
                              <IconTrash size={14} />
                            </span>
                            Take back
                          </button>
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
