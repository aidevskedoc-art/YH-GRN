/**
 * Theme mode. Dark is the default skin; light is kept because finance users
 * print and screenshot these tables, and a long pending list is easier on paper.
 *
 * The first paint is handled by the inline script in index.html - this module
 * only owns changes made after boot, and reads back what that script decided so
 * the two never disagree.
 */
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

const KEY = 'yh.grn.theme';

function current() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function apply(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  // Keeps the mobile browser chrome in step with the page it frames. Literals
  // because a meta tag cannot read a token, and they are duplicated in
  // index.html's pre-paint block for the same reason - change one, change both.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', mode === 'light' ? '#f3f5fa' : '#0a0d14');
}

export function useTheme() {
  const [mode, setMode] = useState(current);

  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // Private browsing or a locked-down profile: the theme still applies for
      // this session, it just will not be remembered. Not worth failing over.
    }
  }, [mode]);

  /**
   * Where the browser supports view transitions, the new theme grows out of
   * the control that was pressed as an expanding circle. The DOM has to be in
   * its final state by the time the callback returns, which is why the change
   * is applied directly and the state update is flushed synchronously.
   * Anywhere else, or with reduced motion on, the theme simply switches.
   */
  const toggle = useCallback((event) => {
    const next = current() === 'dark' ? 'light' : 'dark';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!document.startViewTransition || reduce) {
      setMode(next);
      return;
    }

    // A keyboard press still has a target to grow from; only a call with no
    // event at all falls back to the top centre of the window.
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    const transition = document.startViewTransition(() => {
      apply(next);
      flushSync(() => setMode(next));
    });

    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: 600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
        );
      })
      .catch(() => {
        // Skipped transitions reject here; the theme has already been applied.
      });
  }, []);

  return { mode, toggle };
}

/** "Yashoda Admin" -> "YA"; used for the sidebar avatar. */
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
