import { useState } from 'react';
import { CHECKPOINTS, checkpointLabel, spanId, spanLabel } from '../services/stages.js';

/**
 * Choose which stretches of the process the turnaround table measures.
 *
 * The table's own eleven columns are the process step by step -- PR to PO, PO
 * to Security, and so on down the chain. That answers "where is the time
 * going", but not "how long from the PR to the cheque actually clearing", which
 * is the question that gets asked when someone is chasing one bill or reporting
 * one number upward. That span crosses six stages and no column shows it.
 *
 * So: pick a From and a To, add it, and the table measures exactly that. Add a
 * second and it measures both -- PR to PO beside Cheque to Cheque Clearance --
 * because the two are usually asked about together and reading one, then
 * re-picking, then reading the other is not the same as seeing them side by
 * side on one row.
 *
 * With nothing picked the table is as it was, every stage and every date. That
 * is deliberate: this narrows the report, so an empty picker has to mean the
 * whole of it rather than an empty table waiting to be configured.
 */
export default function SpanPicker({ spans, onChange }) {
  const [from, setFrom] = useState(CHECKPOINTS[0].key);
  const [to, setTo] = useState(CHECKPOINTS[1].key);

  // A span from a checkpoint to itself measures nothing, and one already on
  // screen would draw a second identical column. Neither is an error worth
  // reporting -- the button simply has nothing to do, and says so by going flat.
  const duplicate = spans.some((s) => s.from === from && s.to === to);
  const canAdd = from !== to && !duplicate;

  function add() {
    if (!canAdd) return;
    onChange([...spans, { from, to }]);
  }

  function remove(span) {
    onChange(spans.filter((s) => spanId(s) !== spanId(span)));
  }

  return (
    <div className="spans">
      <div className="spans__pick">
        <span className="spans__label">Measure</span>
        <select
          className="field__input spans__select"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Measure from which checkpoint"
        >
          {CHECKPOINTS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="spans__to">to</span>
        <select
          className="field__input spans__select"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Measure to which checkpoint"
        >
          {CHECKPOINTS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost ghost--sm"
          onClick={add}
          disabled={!canAdd}
          title={
            from === to
              ? 'A checkpoint to itself measures nothing'
              : duplicate
                ? `${checkpointLabel(from)} to ${checkpointLabel(to)} is already shown`
                : `Add a ${checkpointLabel(from)} to ${checkpointLabel(to)} column`
          }
        >
          Add
        </button>
      </div>

      {spans.length > 0 && (
        <div className="spans__chosen">
          {spans.map((span) => (
            <span key={spanId(span)} className="spans__chip">
              {spanLabel(span)}
              <button
                type="button"
                className="spans__drop"
                onClick={() => remove(span)}
                aria-label={`Remove ${spanLabel(span)}`}
                title={`Remove ${spanLabel(span)}`}
              >
                &times;
              </button>
            </span>
          ))}
          {/* Back to the full report. Removing the chips one at a time gets
              there too; this is the way back when four are on screen. */}
          <button type="button" className="spans__clear" onClick={() => onChange([])}>
            Show all stages
          </button>
        </div>
      )}
    </div>
  );
}
