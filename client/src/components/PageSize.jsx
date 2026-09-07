import { useCallback, useState } from 'react';

/**
 * How many rows a table shows at a time, and the control that sets it.
 *
 * One preference, shared by every paginated screen and remembered between
 * visits: someone who works through the month's GRNs a hundred at a time wants
 * a hundred on the CSD queue too, and wants them again tomorrow, rather than
 * resetting three dropdowns every morning.
 *
 * 200 is the ceiling because the server's is (MAX_PAGE_SIZE in routes/results.js
 * and routes/csd.js). Asking for more would silently come back as 200, and a
 * control that says one number while the table shows another is worse than one
 * that never offers the number.
 */
const STORAGE_KEY = 'yh_grn_page_size';
export const PAGE_SIZES = [20, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 20;

function readStored() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return PAGE_SIZES.includes(saved) ? saved : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/**
 * `const [pageSize, setPageSize] = usePageSize()`.
 *
 * Reads like useState and can be used as one; the difference is that the value
 * starts from what was chosen last time and is written back on every change.
 * A screen that changes it must also send the reader back to page 1 -- page 7
 * of 20-row pages is not page 7 of 200-row ones, and staying put would land
 * them somewhere they did not ask to be, or past the end.
 */
export function usePageSize() {
  const [pageSize, setPageSize] = useState(readStored);

  const choose = useCallback((next) => {
    setPageSize(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* private browsing - the choice simply will not outlive the tab */
    }
  }, []);

  return [pageSize, choose];
}

/** The dropdown itself. It lives in the pager, at the end the count is at. */
export default function PageSizeSelect({ value, onChange }) {
  return (
    <label className="pager__size">
      <span>Rows per page</span>
      <select
        className="field__input pager__size-input"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        title="How many rows to show at a time"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
