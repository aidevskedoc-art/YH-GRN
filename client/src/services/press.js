/**
 * A card's click handler that acts on the first click of a double-click and
 * ignores the rest.
 *
 * A double-click is two clicks, and a card row is not always the same row by
 * the second one. The cards that switch view (Results' count cards, the BPAD
 * row's Accounts card) redraw the row under the pointer, so the second click
 * pressed whichever card the new row had put there. And the cards that still
 * toggle -- the logs' Deleted and category cards, the HIS vs FOCUS view cards
 * and field chips -- went on and straight back off.
 *
 * `event.detail` is the browser's own count of clicks in the current run -- 1,
 * then 2 for the second click of a double-click, 3 for a triple -- so anything
 * past the first is a repeat of a press already acted on. A keyboard press
 * (Enter or Space on the focused button) reports 0 and always goes through.
 */
export function singlePress(handler) {
  return (event) => {
    if (event.detail > 1) return;
    handler(event);
  };
}
