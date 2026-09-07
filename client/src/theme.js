/**
 * Theme mode. Dark is the default skin; light is kept because finance users
 * print and screenshot these tables, and a long pending list is easier on paper.
 *
 * The first paint is handled by the inline script in index.html - this module
 * only owns changes made after boot, and reads back what that script decided so
 * the two never disagree.
 */
import { useCallback, useEffect, useState } from 'react';

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
    ?.setAttribute('content', mode === 'light' ? '#ece3d3' : '#130e0a');
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

  const toggle = useCallback(() => setMode((m) => (m === 'dark' ? 'light' : 'dark')), []);

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
