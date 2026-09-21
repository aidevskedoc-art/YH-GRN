/**
 * A results table with a loading veil it can raise over its own rows.
 *
 * The first load has nothing to show and gets the page's plain spinner. Every
 * load after that -- a card pressed, a filter changed, the next page -- used to
 * leave the previous rows sitting there untouched until the new ones arrived,
 * which reads as the press not having taken. So the old rows stay, dimmed, with
 * a badge over them saying the next ones are on their way, and the veil takes
 * the clicks meanwhile: a row about to be replaced is not one to act on.
 *
 * The veil appears a beat late (see .table-stage) so a quick answer swaps the
 * rows without a flash of it.
 */
export default function TableStage({ loading, children }) {
  return (
    <div className={`table-stage${loading ? ' is-loading' : ''}`} aria-busy={loading}>
      {children}
      {loading && (
        <div className="table-stage__veil" role="status">
          <span className="table-stage__badge">Loading…</span>
        </div>
      )}
    </div>
  );
}
