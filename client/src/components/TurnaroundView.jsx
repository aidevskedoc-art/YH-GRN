import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatAmount, formatAmountOrDash, formatDate } from './ResultsTable.jsx';
import SpanPicker from './SpanPicker.jsx';
import { CHECKPOINTS, spanDays, spanId, spanLabel, stageLabel, totalDays } from '../services/stages.js';
import PageSizeSelect, { usePageSize } from './PageSize.jsx';
import MsmeCells from './MsmeCells.jsx';

const int = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-IN'));

/**
 * One checkpoint, as read.
 *
 * Every date in this table used to be click-to-edit. Now only the three CSD
 * stamps are correctable, and only with the table put into edit mode first --
 * so the ordinary state of every cell here, CSD ones included, is this.
 */
function DateText({ value }) {
  return value ? formatDate(value) : <span className="table__miss">&mdash;</span>;
}

/**
 * One correctable CSD stamp, while the table is in edit mode.
 *
 * A plain input rather than the cell that used to turn into one: edit mode is
 * already the answer to "is this editable", so the cell has nothing left to
 * announce and can just be the field. Nothing is written as it is typed -- the
 * value goes to a draft and stays there until Save.
 */
function DateField({ value, onChange, disabled }) {
  return (
    <input
      className="cell-date__input cell-date__input--bulk"
      type="date"
      lang="en-GB"
      value={value || ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A day count: negative means the stage ended before it began. */
function Days({ value }) {
  if (value === null || value === undefined) return <span className="table__miss">&mdash;</span>;
  return <span className={value < 0 ? 'table__neg' : undefined}>{value}</span>;
}

export default function TurnaroundView({ batchId, q, location, msme, spans = [], onSpansChange }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Which transaction is open for correction -- its dispatch id, or null -- and
  // what has been typed into it but not yet written: { csdReceived: '2026-04-11' }.
  //
  // One row at a time, and its Edit button lives in the row itself. Nothing is
  // sent as it is typed: a date goes into the draft and stays there until Save,
  // which is the difference between this and what the table did before -- every
  // blur used to be a write, and a mistyped year was saved before it could be
  // looked at.
  const [editingRow, setEditingRow] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Page 7 of the old result set is rarely a page of the new one, so changing
  // the upload or the search starts again from the first page.
  useEffect(() => {
    setPage(1);
  }, [batchId, q, location, msme]);

  // Anything that fetches a different set of rows closes the editor. The draft
  // is held against a row that is about to leave the screen, and carrying it
  // silently across a page turn would save an edit its author can no longer see.
  useEffect(() => {
    setEditingRow(null);
    setDraft({});
  }, [batchId, q, location, msme, page]);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoading(true);
    api
      .turnaround(batchId, { page, pageSize, q, location, msme })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [batchId, page, pageSize, q, location, msme]);

  useEffect(load, [load]);

  /** Open one transaction for correction. Only one is open at a time. */
  function startEdit(row) {
    setEditingRow(row.csdId);
    setDraft({});
  }

  /** Close the open row without writing. Reached from Save with nothing changed. */
  function closeEdit() {
    setEditingRow(null);
    setDraft({});
  }

  /**
   * Note one changed CSD stamp, without writing it.
   *
   * A box put back to the value it started at, or emptied, leaves no draft:
   * emptying is not a way to clear a stamp -- the server refuses that, because
   * a stage the GRN reached happened on some day -- so it can only mean the
   * edit is being taken back.
   */
  function editField(row, field, value) {
    setDraft((prev) => {
      const next = { ...prev };
      if (!value || value === row[field]) delete next[field];
      else next[field] = value;
      return next;
    });
  }

  const fieldValue = (row, field) => draft[field] ?? row[field] ?? '';

  /**
   * Write this transaction's changed stamps, then reload the page.
   *
   * Reloading rather than patching the row in place is deliberate: the stage
   * medians, the p90s and the data-quality counts are all computed over the
   * whole population on the server, and a date that moves changes them too.
   * Editing the one row on screen would leave the statistics above it stale.
   */
  async function saveEdit(row) {
    if (!isAdmin) return;
    if (Object.keys(draft).length === 0) {
      closeEdit();
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.updateCsdDates(row.csdId, draft);
      setEditingRow(null);
      setDraft({});
      load();
    } catch (err) {
      setError(`GRN ${row.dprNo}: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Only a load failure replaces the table; a save failure is reported above it,
  // with the row and its unsaved draft still on screen to correct.
  if (error && !data) return <div className="alert alert--error">{error}</div>;
  if (loading && !data) return <div className="loading">Loading…</div>;
  if (!data) return null;

  const { stages, overall, quality, rows } = data;
  const isEmpty = overall.rows === 0;

  /**
   * What the two halves of the table are made of.
   *
   * With nothing picked, the report as it has always been: a day column per
   * stage the server measured, the row total, and every checkpoint under
   * Reached.
   *
   * Pick a span and both halves narrow to it together. The day columns become
   * the spans themselves -- "PR - PO", measured here from the row's own dates
   * rather than from the server's `gaps`, because a span is any pair and the
   * server only ever measures consecutive ones. Under Reached only the dates
   * those spans run between are left, in process order rather than in the order
   * they were picked, so the row still reads left to right as the bill moved.
   *
   * The Total column steps out with them: it is measured to the furthest
   * checkpoint the row reached, which is generally not one of the two on
   * screen, and a total that no visible pair of dates accounts for is a number
   * a reader cannot check.
   */
  const custom = spans.length > 0;
  const dayColumns = custom
    ? spans.map((span) => ({ key: spanId(span), label: spanLabel(span), span }))
    : stages.map((s) => ({ key: s.key, label: stageLabel(s.key) }));
  const dateColumns = custom
    ? CHECKPOINTS.filter((c) => spans.some((s) => s.from === c.key || s.to === c.key))
    : CHECKPOINTS;

  // Thirteen fixed columns, a day count per stage or span, the row total where
  // there is one, then the dates -- the same width the two header rows span
  // between them.
  // Fifteen Particulars: the thirteen identifiers and amounts, and MSME No and
  // MSME Status beside the vendor.
  const columnCount =
    15 + dayColumns.length + (custom ? 0 : 1) + dateColumns.length + (isAdmin ? 1 : 0);

  // An upload made before the stage dates were captured has rows but no dates.
  // Guarded on isEmpty: with nothing in scope every stage is empty too, and
  // that is a search with no matches rather than an upload with no dates.
  if (!isEmpty && overall.n === 0 && stages.every((s) => s.n === 0)) {
    return (
      <div className="alert alert--info">
        <strong>This upload predates the turnaround report.</strong> The stage dates are read at
        upload time, so re-upload this month&rsquo;s two reports to measure it.
      </div>
    );
  }

  return (
    <>
      {/* {(quality.impossible > 0 || quality.backwards > 0) && (
        <div className="alert alert--info">
          <strong>Worth correcting at source.</strong>{' '}
          {quality.impossible > 0 && (
            <>
              {int(quality.impossible)} row{quality.impossible === 1 ? '' : 's'} carry a date outside{' '}
              {quality.era} altogether ({quality.impossibleGrns.join(', ')}) — almost certainly a
              mistyped year.{' '}
            </>
          )}
          {quality.backwards > 0 && (
            <>
              {int(quality.backwards)} more have a step that finishes before it starts. Those days
              are shown below exactly as they compute, in red.
            </>
          )}
        </div>
      )} */}

      {/* <p className="table__note">
        Click any date under <strong>Reached</strong> to correct it. The day counts, the stage
        figures and the exports are all worked out from these dates, so they follow the change.
        {saving && <span className="table__note-busy"> Saving…</span>}
      </p> */}

      {/* Reported here rather than in place of the table: a save that failed
          leaves the row and its unsaved draft on screen to be corrected. */}
      {error && <div className="alert alert--error">{error}</div>}

      {/* Above the table rather than up in the page toolbar: it configures this
          one report, and the toolbar's filters change which ROWS are shown,
          which is a different question from which columns measure them. */}
      {onSpansChange && <SpanPicker spans={spans} onChange={onSpansChange} />}

      <div className="table-wrap table-wrap--sticky">
        <table className="table">
          <thead>
            <tr>
              <th className="table__group" colSpan="15">Particulars</th>
              <th className="table__group" colSpan={dayColumns.length + (custom ? 0 : 1)}>
                Days taken
              </th>
              <th className="table__group" colSpan={dateColumns.length}>
                Reached
              </th>
              {/* Action belongs to no group: it is not a fact about the GRN,
                  it is the control that corrects three of them. */}
              {isAdmin && <th className="table__group" />}
            </tr>
            <tr>
              {/* Division and Bill No stand as columns of their own rather
                  than as sub-lines under the GRN and the vendor. They are what
                  a row is looked up by when a query comes in about one branch
                  or one bill, and a value tucked under another is neither
                  sortable by eye down the column nor findable at a glance. The
                  order matches the results table: division, then GRN, then the
                  bill and its date, then who it is from. */}
              <th className="table__pin table__pin--division">Division</th>
              <th className="table__pin table__pin--grn">GRN No</th>
              <th>Bill No</th>
              <th>Bill Date</th>
              <th>Vendor</th>
              {/* The code beside the name rather than nowhere, matching the
                  results and CSD tables column for column so the three
                  screens read the same way. */}
              <th>Vendor Code</th>
              {/* The vendor's MSME registration off the HIS vendor master, as
                  on every GRN table -- see MsmeCells. */}
              <th>MSME No</th>
              <th>MSME Status</th>
              {/* The ageing report's own amount breakdown, ahead of
                  PayableAmount -- the same four columns and the same order as
                  the CSD and Valid GRNs tabs. */}
              <th className="table__num">NetAmt</th>
              <th className="table__num">AdjPurReturn</th>
              <th className="table__num">AdjustedJV</th>
              <th className="table__num">TDSJV</th>
              <th className="table__num">PayableAmount</th>
              {/* The cheque the bill was paid by. It sits with the identifiers
                  rather than in the Reached group: it is not a checkpoint, it
                  is what the clearance date over there was matched on. */}
              <th>Cheque No</th>
              {/* The ageing report's payment document number, right after the
                  cheque it belongs to. */}
              <th>PaymentDocNo</th>
                {dayColumns.map((c) => (
                <th key={c.key} className="table__num">
                  {c.label}
                </th>
              ))}
              {!custom && (
                <th
                  className="table__num"
                  title="PR to the furthest checkpoint this GRN has reached — including the CSD handover, not just the cheque."
                >
                  Total
                </th>
              )}

              {/* The first date column carries the divider down from the
                  "Days taken" / "Reached" split above it. */}
              {dateColumns.map((c, i) => (
                <th key={c.key} className={i === 0 ? 'table__edge' : undefined}>
                  {c.label}
                </th>
              ))}
              {/* Last, so it sits beside the three dates it opens rather than
                  at the far end of the identifiers, where a reader would have
                  to scroll back to reach the fields they had just opened. */}
              {isAdmin && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {isEmpty && (
              <tr>
                <td className="table__empty" colSpan={columnCount}>
                  Matches not found
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const isEditing = row.csdId != null && editingRow === row.csdId;
              return (
              <tr key={row.dprNo} className={isEditing ? 'is-editing' : undefined}>
                <td className="table__pin table__pin--division">
                  {row.divisionCode || <span className="table__miss">&mdash;</span>}
                </td>
                <td className="table__mono table__pin table__pin--grn">{row.dprNo}</td>
                <td className="table__mono">
                  {row.billNo || <span className="table__miss">&mdash;</span>}
                </td>
                <td><DateText value={row.billDate} /></td>
                <td>{row.vendorName}</td>
                <td className="table__mono">
                  {row.vendorCode || <span className="table__miss">&mdash;</span>}
                </td>
                <MsmeCells row={row} />
                <td className="table__num">{formatAmountOrDash(row.netAmt)}</td>
                <td className="table__num">{formatAmountOrDash(row.adjPurReturn)}</td>
                <td className="table__num">{formatAmountOrDash(row.adjustedJv)}</td>
                <td className="table__num">{formatAmountOrDash(row.tdsJv)}</td>
                <td className="table__num">{formatAmount(row.payableAmount)}</td>
                <td className="table__mono">
                  {row.chequeNo || <span className="table__miss">&mdash;</span>}
                </td>
                <td className="table__mono">
                  {row.paymentDocNo || <span className="table__miss">&mdash;</span>}
                </td>

                {dayColumns.map((c) => (
                  <td key={c.key} className="table__num">
                    {/* A stage comes measured from the server; a span is
                        measured here, off the same two dates the row shows two
                        columns along, so the count and the dates behind it
                        cannot disagree. */}
                    <Days value={c.span ? spanDays(row, c.span) : row.gaps[c.key]} />
                  </td>
                ))}
                {!custom && (
                  <td className="table__num">
                    <Days value={totalDays(row)} />
                  </td>
                )}
                {dateColumns.map((c) => {
                  // The checkpoints off the ageing report itself are read here
                  // and corrected at source; only the seven stamps this
                  // application writes itself (the three CSD ones and the
                  // three Accounts hand-back ones) are editable, and only in
                  // the one row whose Edit button has been pressed.
                  //
                  // Even then, a stamp is editable only where there is one to
                  // edit: a stage not yet reached has no date to correct. Those
                  // stay a dash, and the status dropdown or the Accounts
                  // buttons are what move a GRN far enough for the stamp to
                  // exist.
                  const editable = isEditing && c.editable && row[c.key];
                  return (
                    <td key={c.key}>
                      {editable ? (
                        <DateField
                          value={fieldValue(row, c.key)}
                          disabled={saving}
                          onChange={(v) => editField(row, c.key, v)}
                        />
                      ) : (
                        <DateText value={row[c.key]} />
                      )}
                    </td>
                  );
                })}
                {isAdmin && (
                  <td>
                    {/* A GRN never sent to CSD has no handover to write to, so
                        there is nothing on this row to correct. */}
                    {!row.csdId ? (
                      <span className="table__miss" title="Not sent to CSD — no stamps to correct">
                        &mdash;
                      </span>
                    ) : isEditing ? (
                      /* Save, and only Save. The cell holds one button at a
                         time: Edit opens the row, Save closes it, and the row
                         is back to Edit once it is written. Saving with nothing
                         changed simply closes the row, which is what a Cancel
                         beside it would have done anyway. */
                      <button
                        type="button"
                        className="primary ghost--sm"
                        onClick={() => saveEdit(row)}
                        disabled={saving}
                        title={`Save the CSD dates on GRN ${row.dprNo}`}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ghost ghost--sm"
                        onClick={() => startEdit(row)}
                        // One row at a time: opening a second while the first
                        // has unsaved changes would throw them away silently.
                        disabled={editingRow !== null || saving}
                        title={`Correct the CSD dates on GRN ${row.dprNo}`}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                )}
              
              </tr>
              );
            })}
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
              )} of ${int(data.total)}`}
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
  );
}
