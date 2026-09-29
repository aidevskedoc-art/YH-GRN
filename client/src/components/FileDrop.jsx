import { useCallback, useRef, useState } from 'react';
import { IconCheck, IconSheet, IconUpload, IconX } from './icons.jsx';

/** 1.4 MB rather than 1468006 bytes -- the number is context, not data. Past
 *  100 MB the decimal is noise, and the upload limits read "300 MB", not
 *  "300.0 MB". Exported for the upload page's total. */
export function readableSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** The files a message is about: named while there are few, counted after. */
function listOf(files) {
  return files.length > 3 ? `${files.length} files` : files.map((f) => `"${f.name}"`).join(', ');
}

/** ".xls,.xlsx" -> ["xls", "xlsx"], so one prop drives both the native picker
 *  filter and the check we run on a dropped file (which bypasses that filter). */
function extensions(accept) {
  return accept
    .split(',')
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

/** The same file picked twice -- from a second trip to the picker, or dropped
 *  again -- is the same workbook, and is kept once. */
function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
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
 *
 * With `multiple`, the slot holds a list: `files` in, the whole new list out
 * through `onSelect`. Each pick ADDS to what is there rather than replacing it,
 * so a month's reports can be gathered from more than one folder; the input is
 * emptied after every pick, since the list lives in the parent's state and the
 * same file must be pickable again once removed. Without it, the slot holds
 * one `file`, exactly as before.
 *
 * `maxBytes` (per file) and `maxFiles` (per slot, with `multiple`) refuse what
 * the server would, before it is sent: a file over the size is not taken, and
 * a pick that would overfill the slot takes what fits in the order picked.
 * Either left out means no limit here -- the server still has the last word.
 */
export default function FileDrop({
  step,
  label,
  hint,
  example,
  accept = '.xls,.xlsx',
  file,
  files,
  multiple = false,
  maxBytes,
  maxFiles = Infinity,
  onSelect,
  onReject,
}) {
  const inputRef = useRef(null);
  const [depth, setDepth] = useState(0);

  // One shape to draw from, whichever way the slot was given its files.
  const chosen = multiple ? files ?? [] : file ? [file] : [];

  const take = useCallback(
    (picked) => {
      if (picked.length === 0) {
        // Cancelling the picker. A single slot has always read that as "no
        // file"; a list keeps what it had, since cancelling an ADD is not a
        // request to remove anything.
        if (!multiple) onSelect(null);
        return;
      }

      const allowed = extensions(accept);
      const good = [];
      const notExcel = [];
      const tooBig = [];
      for (const f of picked) {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        if (!allowed.includes(ext)) notExcel.push(f);
        else if (maxBytes && f.size > maxBytes) tooBig.push(f);
        else good.push(f);
      }
      const refused = notExcel.length + tooBig.length;

      // Clear the control too: leaving a rejected file in it would show the
      // slot as filled while the form refuses to submit. A list clears it
      // every time -- see above.
      if (inputRef.current && (multiple || refused > 0)) inputRef.current.value = '';

      let leftOut = [];
      if (multiple) {
        if (good.length > 0) {
          const seen = new Set(chosen.map(fileKey));
          const added = [];
          for (const f of good) {
            if (seen.has(fileKey(f))) continue;
            seen.add(fileKey(f));
            added.push(f);
          }
          const room = Math.max(0, maxFiles - chosen.length);
          leftOut = added.slice(room);
          onSelect([...chosen, ...added.slice(0, room)]);
        }
      } else if (refused === 0) {
        onSelect(good[0]);
      }

      // After onSelect, which clears the page's error: the good files in a
      // mixed drop are taken, and the refused ones still have to be named --
      // every reason at once, so fixing one does not uncover the next.
      const problems = [];
      if (notExcel.length > 0) {
        problems.push(
          notExcel.length === 1
            ? `${listOf(notExcel)} is not an Excel workbook. Choose ${multiple ? '' : 'an '}${accept} file${multiple ? 's' : ''}.`
            : `${listOf(notExcel)} are not Excel workbooks. Choose ${accept} files.`,
        );
      }
      if (tooBig.length > 0) {
        problems.push(
          tooBig.length === 1
            ? `${listOf(tooBig)} is ${readableSize(tooBig[0].size)}, larger than the ${readableSize(maxBytes)} one file can be.`
            : `${listOf(tooBig)} are larger than the ${readableSize(maxBytes)} one file can be.`,
        );
      }
      if (leftOut.length > 0) {
        problems.push(
          `${listOf(leftOut)} ${leftOut.length === 1 ? 'was' : 'were'} left out: this box takes at most ${maxFiles} files.`,
        );
      }
      if (problems.length > 0) onReject?.(problems.join(' '));
    },
    [accept, multiple, maxBytes, maxFiles, chosen, onSelect, onReject],
  );

  function clear(event) {
    // The button sits inside the input's hit area; without this the picker
    // opens on the way out and the user is asked to choose a file they just
    // removed.
    event.preventDefault();
    event.stopPropagation();
    if (inputRef.current) inputRef.current.value = '';
    onSelect(multiple ? [] : null);
  }

  const over = depth > 0;
  const filled = chosen.length > 0;
  const names = chosen.map((f) => f.name);
  const totalSize = chosen.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="dropslot">
      <div className={`dropslot__cap${filled ? ' is-done' : ''}`}>
        <span className="dropslot__n" aria-hidden="true">
          {filled ? <IconCheck size={12} /> : step}
        </span>
        {label}
      </div>

      <div
        className={`drop${filled ? ' drop--filled' : ''}${over ? ' drop--over' : ''}`}
        onDragEnter={() => setDepth((d) => d + 1)}
        onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => setDepth(0)}
      >
        {/* The title is the whole of what the box may be cutting short: on a
            short window the upload page steps its boxes down to a one-line
            hint (see the dropslot container rules in styles.css), and a long
            filename is always ellipsed. The input is what the pointer rests
            on, so the tooltip goes here. */}
        <input
          ref={inputRef}
          className="drop__input"
          type="file"
          accept={accept}
          multiple={multiple}
          aria-label={label}
          title={filled ? names.join('\n') : hint}
          onChange={(e) => take([...(e.target.files ?? [])])}
        />

        <span className="drop__glyph" aria-hidden="true">
          {filled ? <IconSheet size={26} /> : <IconUpload size={26} />}
        </span>

        <span className="drop__title">
          {chosen.length > 1
            ? `${chosen.length} files`
            : filled
              ? names[0]
              : multiple
                ? // "Files", so the box says it takes more than one -- and no
                  // longer than the single slot's wording, which is as long as
                  // a four-across column holds on one line.
                  'Drop files or click to browse'
                : 'Drag & drop or click to browse'}
        </span>

        {/* Several files are named here, where the hint's line clamp is what
            cuts a long list short -- the title is one ellipsed line, and a
            count is the most it can say. The tooltip has all of them. */}
        <span className="drop__hint">
          {chosen.length > 1
            ? `${readableSize(totalSize)} · ${names.join(', ')}`
            : filled
              ? `${readableSize(totalSize)} · ready to reconcile`
              : hint}
        </span>

        {/* The example filename is a line of its own: run into the hint it
            wraps mid-name in a column this narrow, and half a filename on each
            line is worse than no example at all. Once a list has files in it,
            the line says instead that the box still takes more. */}
        {!filled && example && (
          <span className="drop__eg">
            e.g. <code>{example}</code>
          </span>
        )}
        {filled && multiple && <span className="drop__eg">Drop or click to add more</span>}

        {filled && (
          <button
            type="button"
            className="drop__clear"
            onClick={clear}
            title={chosen.length > 1 ? 'Remove all files' : 'Remove file'}
            aria-label={chosen.length > 1 ? `Remove all ${chosen.length} files` : `Remove ${names[0]}`}
          >
            <IconX size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
