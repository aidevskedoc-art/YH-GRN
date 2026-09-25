import { useEffect, useRef, useState } from 'react';
import { IconArrowLeft } from './icons.jsx';
import { singlePress } from '../services/press.js';

/** How many sections back the button remembers. Far more than anyone walks. */
const TRAIL_LIMIT = 50;

/**
 * The sections a page has shown since it was last on its home section, so
 * Back can return through them.
 *
 * A section is the page's view -- Total GRNS, BPAD, Accounts and so on --
 * and nothing finer. A card or dropdown narrowing the view showing is not a
 * step of its own: Back leaves the section, it does not unpick filters one
 * by one inside it. Nor does Back ever leave the page; that is what the
 * sidebar and the browser's own Back are for.
 *
 * `home` is the section the page opens on. Back is not offered there, so
 * arriving on it ends the trail: nothing before it could be reached again.
 * Anywhere else, with nothing remembered, Back goes home.
 *
 * `goTo(section)` is the page's own way of opening a view -- the same one the
 * View dropdown calls. What it changes is not remembered as a fresh step, or
 * Back would only ever bounce between the last two sections.
 *
 * `const trail = useSectionTrail(status, selectStatus, ALL_GRNS)`
 */
export function useSectionTrail(section, goTo, home) {
  const [trail, setTrail] = useState([]);
  // The section on screen, as of the last change, and whether the next change
  // is Back returning to one.
  const shown = useRef(null);
  const returning = useRef(false);

  useEffect(() => {
    const left = shown.current;
    shown.current = section;
    if (left === null || left === section) return;
    const wasReturning = returning.current;
    returning.current = false;
    if (section === home) setTrail([]);
    else if (!wasReturning) setTrail((t) => [...t, left].slice(-TRAIL_LIMIT));
  }, [section, home]);

  const previous = section === home ? null : trail.length ? trail[trail.length - 1] : home;

  return {
    /** The section Back would return to, or null on the home section. */
    previous,
    /** Return to it. */
    back() {
      if (previous === null) return;
      if (trail.length) setTrail(trail.slice(0, -1));
      // Only flag a change that will actually happen: returning to the section
      // already showing would leave the flag up to swallow the next real step.
      if (previous === section) return;
      returning.current = true;
      goTo(previous);
    },
  };
}

/**
 * The button above a page's cards: back to the section shown before this one.
 * Not rendered on the home section, where there is nothing to go back to.
 *
 * `describe(section)` names it for the label, so the button says where it
 * goes: "Back to BPAD", not just "Back".
 *
 * singlePress, like the cards: a double-click would otherwise go back two
 * steps and land somewhere the label never mentioned.
 */
export default function BackButton({ trail, describe = String }) {
  if (trail.previous === null) return null;
  const label = `Back to ${describe(trail.previous)}`;

  return (
    <div className="back-row">
      <button
        type="button"
        className="ghost ghost--sm back-btn"
        onClick={singlePress(() => trail.back())}
        title={label}
      >
        <IconArrowLeft size={14} />
        {label}
      </button>
    </div>
  );
}
