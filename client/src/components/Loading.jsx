import { createPortal } from 'react-dom';

/**
 * The spinner a screen shows while its first answer is on the way.
 *
 * Drawn in the middle of the window's height, not where the screen happens to
 * reach it: under a page head that was the top of an otherwise empty page, and
 * under a results screen's cards and filters it could be below the fold.
 *
 * Rendered into document.body for the reason Sheet.jsx gives. The page is drawn
 * inside `.page-transition`, whose children animate a transform as they arrive,
 * and a transformed ancestor is what `position: fixed` resolves against -- in
 * place, the spinner would be centred on the page's own box for the length of
 * that animation and jump to the window's when it ended.
 *
 * A status, not a control: it takes no clicks (see .loading in styles.css), so
 * whatever it is drawn over stays usable.
 */
export default function Loading() {
  return createPortal(
    <div className="loading" role="status">
      Loading…
    </div>,
    document.body,
  );
}
