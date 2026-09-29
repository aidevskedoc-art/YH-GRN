import { progressCardFigures } from '../services/resultsViews.js';
import { singlePress } from '../services/press.js';
import { formatAmount } from './ResultsTable.jsx';

/**
 * A card holding two filters side by side -- the Not Required pair on the
 * Accounts row (NOT_REQUIRED_PAIR in services/resultsViews.js): Cheque Not
 * Required and Payment Not Required, each with its own count and amount.
 *
 * The card itself is not a control, only the frame: each half is its own
 * button, narrowing the table to its `progress` key exactly as its card did
 * before the two shared one -- pressed again it stays, and the count at the
 * head of the row (`headLabel`) is the way back to every row. The card wears
 * the active ring while either half is the filter, and the half itself is
 * marked.
 *
 * Shared by the results screen and the Accounts Department, which show the same
 * Accounts row.
 */
export default function PairCard({ card, summary, byCheque, progress, onSelect, headLabel }) {
  const on = card.parts.some((part) => part.progress === progress);
  return (
    <div className={`card stat stat--dept stat--pair${on ? ' is-active' : ''}`} role="group" aria-label={card.label}>
      <div className="stat__label">{card.label}</div>
      <div className="stat__halves">
        {card.parts.map((part) => {
          const active = progress === part.progress;
          // GRN view leads with the GRN count, Cheque view with the cheque
          // count -- see progressCardFigures. These two have no cheque figure,
          // so they read the same on both.
          const { value } = progressCardFigures(part, summary, byCheque);
          return (
            <button
              key={part.progress}
              type="button"
              className={`stat__half${active ? ' is-active' : ''}`}
              onClick={singlePress(() => onSelect(part.progress))}
              aria-pressed={active}
              title={
                active
                  ? `Showing ${part.label} only — press ${headLabel} for every row`
                  : `Show only the ${part.label} rows: ${part.hint}`
              }
            >
              <span className="stat__half-label">{part.short}</span>
              <span className="stat__value">{value.toLocaleString('en-IN')}</span>
              <span className="stat__amount">₹ {formatAmount(summary?.progress?.[part.progress]?.amount ?? 0)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
