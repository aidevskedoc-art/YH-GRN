/**
 * The MSME dropdown, first in the toolbar above the table on every GRN screen
 * -- the results screen's sections, the Accounts Department and the CS
 * Department queue -- just ahead of each view's own filter dropdown, and drawn
 * the same compact way.
 *
 * Unlike the dropdown beside it, which is about one view, it is a scope: it
 * narrows the rows, the cards and their counts, and the Excel export together.
 * The server does the narrowing (msmeFilter in services/vendorMsme.js), off the
 * same lookup the MSME Status column reads, so choosing MSME keeps exactly the
 * rows that column calls MSME.
 *
 * A vendor the Vendor Master has no row for is neither MSME nor Non-MSME
 * -- its MSME Status reads as a dash -- so it shows under All vendors only.
 *
 * `value` is '' for every vendor, or one of the two keys below; they are the
 * values the server's `msme` parameter takes.
 */
export const MSME_OPTIONS = [
  { value: 'MSME', label: 'MSME' },
  { value: 'NON_MSME', label: 'Non-MSME' },
];

export default function MsmeFilter({ value, onChange }) {
  return (
    <select
      className="field__input stage-filter"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Filter by MSME status"
      title="Show MSME or Non-MSME vendors only, by the HIS vendor master"
    >
      <option value="">All vendors</option>
      {MSME_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
