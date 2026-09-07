import { useCallback, useRef, useState } from 'react';
import { IconCheck, IconSheet, IconUpload, IconX } from './icons.jsx';

/** 1.4 MB rather than 1468006 bytes -- the number is context, not data. */
function readableSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** ".xls,.xlsx" -> ["xls", "xlsx"], so one prop drives both the native picker
 *  filter and the check we run on a dropped file (which bypasses that filter). */
function extensions(accept) {
  return accept
    .split(',')
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

/**
 * One report slot on the upload page: a caption naming the file that belongs
 * here, and a target beneath it big enough to be aimed at with a dragged file.
 * The two slots stand side by side, so the target is composed down its centre
 * rather than across a row -- at half the card's width there is no room for a
 * glyph, a filename and a button on one line.
 *
 * The native control is kept -- it is the file picker, it is keyboard
 * reachable, and a file dropped onto it lands in `input.files` for free, which
 * is the whole of drag and drop handled by the platform. It is simply made
 * transparent and stretched over the target, so what the user sees is the
 * dashed box and what they click is still the input. Everything drawn inside
 * is inert (`pointer-events: none` in the stylesheet) apart from the clear
 * button, which is lifted back above it.
 *
 * The drag styling cannot come from the input either -- there is no
 * `:drag-over` -- so the wrapper watches the events as they bubble up out of
 * it. `enter` and `leave` fire once per element crossed, not once per box, so
 * they are counted rather than toggled; a plain boolean flickers off the
 * moment the pointer passes over a child.
 */
export default function FileDrop({
  step,
  label,
  hint,
  example,
  accept = '.xls,.xlsx',
  file,
  onSelect,
  onReject,
}) {
  const inputRef = useRef(null);
  const [depth, setDepth] = useState(0);

  const take = useCallback(
    (picked) => {
      if (!picked) return onSelect(null);
      const ext = picked.name.split('.').pop()?.toLowerCase() || '';
      if (!extensions(accept).includes(ext)) {
        // Clear the control too: leaving a rejected file in it would show the
        // slot as filled while the form refuses to submit.
        if (inputRef.current) inputRef.current.value = '';
        return onReject?.(`"${picked.name}" is not an Excel workbook. Choose an ${accept} file.`);
      }
      return onSelect(picked);
    },
    [accept, onSelect, onReject],
  );

  function clear(event) {
    // The button sits inside the input's hit area; without this the picker
    // opens on the way out and the user is asked to choose a file they just
    // removed.
    event.preventDefault();
    event.stopPropagation();
    if (inputRef.current) inputRef.current.value = '';
    onSelect(null);
  }

  const over = depth > 0;

  return (
    <div className="dropslot">
      <div className={`dropslot__cap${file ? ' is-done' : ''}`}>
        <span className="dropslot__n" aria-hidden="true">
          {file ? <IconCheck size={12} /> : step}
        </span>
        {label}
      </div>

      <div
        className={`drop${file ? ' drop--filled' : ''}${over ? ' drop--over' : ''}`}
        onDragEnter={() => setDepth((d) => d + 1)}
        onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => setDepth(0)}
      >
        <input
          ref={inputRef}
          className="drop__input"
          type="file"
          accept={accept}
          aria-label={label}
          onChange={(e) => take(e.target.files?.[0] || null)}
        />

        <span className="drop__glyph" aria-hidden="true">
          {file ? <IconSheet size={26} /> : <IconUpload size={26} />}
        </span>

        <span className="drop__title">{file ? file.name : 'Drag & drop or click to browse'}</span>

        <span className="drop__hint">
          {file ? `${readableSize(file.size)} · ready to reconcile` : hint}
        </span>

        {/* The example filename is a line of its own: run into the hint it
            wraps mid-name in a column this narrow, and half a filename on each
            line is worse than no example at all. */}
        {!file && example && (
          <span className="drop__eg">
            e.g. <code>{example}</code>
          </span>
        )}

        {file && (
          <button
            type="button"
            className="drop__clear"
            onClick={clear}
            title="Remove file"
            aria-label={`Remove ${file.name}`}
          >
            <IconX size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
