import { useCallback, useEffect, useRef, useState } from 'react';
import Sheet from './Sheet.jsx';
import { IconAlert } from './icons.jsx';

/**
 * The confirmation step for a destructive control.
 *
 * Replaces window.confirm, which was never really a choice -- it is the
 * browser's chrome, not the app's: it cannot say which branch or which account
 * in anything but plain text, it names its buttons "OK" and "Cancel" whatever
 * the question was, and some browsers offer to suppress it for the rest of the
 * session, which would silently arm every delete on the page. A panel of our
 * own can label the button with the act ("Delete account"), and it stays put.
 *
 * Escape and the scrim both cancel, inherited from Sheet.
 */
function ConfirmDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', busy = false, onConfirm, onCancel }) {
  const cancelRef = useRef(null);

  /*
   * Focus opens on Cancel, not on the confirm button. Enter is pressed by
   * reflex on a box that has just appeared, and on this box the reflex would
   * delete something; the safe half of the choice is the one that should
   * absorb it. It also puts focus inside the dialog, which is where a keyboard
   * has to land for Tab to reach the panel at all.
   */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // One string, or a list of them -- a caller can add the "here is what happens
  // instead" sentence as its own paragraph without composing JSX for it.
  const paragraphs = Array.isArray(message)
    ? message
    : typeof message === 'string'
      ? [message]
      : null;

  return (
    <Sheet label={title} narrow onClose={busy ? () => {} : onCancel}>
      <div className="sheet__head confirm__head">
        <span className="confirm__mark" aria-hidden="true">
          <IconAlert size={17} />
        </span>
        <h2>{title}</h2>
      </div>

      <div className="sheet__body confirm__body">
        {paragraphs ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : message}
      </div>

      <div className="sheet__foot">
        <button type="button" className="ghost" ref={cancelRef} onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className="danger--solid" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * `window.confirm` with the same shape, so the call sites keep their control
 * flow: `if (!(await confirm({...}))) return;` reads as the line it replaced.
 *
 * Returns the asking function and the element to render. The element is null
 * until something asks, so a page that never deletes anything renders nothing.
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   ...
 *   if (!(await confirm({ title: '...', message: '...', confirmLabel: '...' }))) return;
 *   ...
 *   return <>{confirmDialog}...</>;
 */
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const resolveRef = useRef(null);

  const settle = useCallback((answer) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    if (resolve) resolve(answer);
  }, []);

  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        // A second ask while one is open would strand the first caller's
        // promise forever, and an awaited promise that never settles is a
        // handler that never returns. Answer it "no" and let the new one open.
        if (resolveRef.current) resolveRef.current(false);
        resolveRef.current = resolve;
        setRequest(options);
      }),
    [],
  );

  // Navigating away with the panel open is a decision not to go through with
  // it, and the awaiting handler has to be told so it can unwind.
  useEffect(
    () => () => {
      if (resolveRef.current) resolveRef.current(false);
      resolveRef.current = null;
    },
    [],
  );

  const dialog = request ? (
    <ConfirmDialog
      {...request}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return [confirm, dialog];
}

export default ConfirmDialog;
