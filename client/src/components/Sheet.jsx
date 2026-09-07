import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * The shell a dialog panel is drawn in.
 *
 * Shared by the user management and configuration screens, which both open a
 * form over the page and both need the same three things of it.
 *
 * Rendered into document.body rather than in place, and that is not a
 * preference -- it is the only way the dialog can be sized to the window.
 *
 * The page content is wrapped in `.page-transition`, which animates a transform
 * with `fill-mode: both`. An element with a filling transform animation is kept
 * as a containing block for fixed-position descendants, so a `position: fixed;
 * inset: 0` overlay rendered inside it resolves against the PAGE CONTENT BOX
 * instead of the viewport -- on a short page that is a couple of hundred pixels
 * tall, and the panel is then clipped mid-form with the Save button below the
 * cut. A portal puts the overlay outside that wrapper, where fixed means fixed.
 *
 * Escape closes it. Clicking away does NOT: the scrim is a backdrop, not a
 * control. Every panel drawn in here is either a form with typed-in values or
 * a question about deleting something, and a stray click beside the box -- on
 * a laptop trackpad, or on a phone where the box leaves only a strip of
 * backdrop either side -- should not be able to throw either away. The way out
 * is the panel's own Cancel button, or Escape.
 */
export default function Sheet({ label, narrow = false, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The page behind must not scroll under an open dialog. Restored on close,
  // including when the panel is unmounted by a save rather than by Cancel.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
      {/* Inert by design -- see above. It still has to be an element rather
          than a background on `.sheet`, because it is what swallows a click
          aimed past the panel and keeps it off the page underneath. */}
      <div className="sheet__scrim" aria-hidden="true" />
      <div className={`sheet__panel${narrow ? ' sheet__panel--narrow' : ''}`}>{children}</div>
    </div>,
    document.body,
  );
}

