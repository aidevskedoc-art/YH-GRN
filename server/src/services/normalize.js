/**
 * Value normalization shared by the parser and the reconciliation engine.
 *
 * The two source reports come from different systems and spell the same data
 * differently, so every comparison runs against a derived `*_key` rather than
 * the raw value. Raw values are always preserved for display.
 */

/** Corporate suffixes/noise words that differ between the two systems. */
const VENDOR_NOISE = /\b(?:PRIVATE|PVT|LIMITED|LTD|LLP|COMPANY|CO|INDIA|AND|THE|MS)\b/g;

/**
 * Coerce any cell value to a trimmed string.
 *
 * Bill numbers arrive as numbers in the GRN report (e.g. 3610006395), and a
 * naive String() on a float would yield "3610006395.0" or scientific notation,
 * which would never match the ageing report's text value.
 */
export function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // Integers must not gain a decimal part or an exponent.
    if (Number.isInteger(value)) return value.toFixed(0);
    return String(value);
  }
  if (value instanceof Date) return toIsoDate(value);
  return String(value).trim();
}

/** Parse a cell to a number, or null when it is not numeric. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = toText(value).replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Comparison key for document numbers (GRN / DPR / bill numbers).
 * Uppercases and drops every separator, so "236/25-26" and "236 25 26" agree.
 */
export function normKey(value) {
  return toText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Comparison key for vendor names.
 * Drops punctuation and corporate suffixes so that
 * "MATRIX THERAPEUTICS PRIVATE LIMITED" and "MATRIX THERAPEUTICS PVT. LTD."
 * produce the same key.
 */
export function normVendorName(value) {
  return toText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9& ]/g, ' ')
    .replace(VENDOR_NOISE, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Split an ageing-report GRN_NO into its branch code and GRN number.
 *
 * GRN_NO is the division code followed by the GRN number ("SE1BMWH0000782").
 * The division code is supplied in its own column and prefixes GRN_NO in every
 * row of the sample data, so that is the primary rule; the regex fallback
 * covers files where the division code is missing or inconsistent.
 */
export function stripBranchCode(grnNo, divisionCode) {
  const grn = toText(grnNo);
  const division = toText(divisionCode);

  if (division && grn.toUpperCase().startsWith(division.toUpperCase())) {
    return { branchCode: division, grnNumber: grn.slice(division.length) };
  }

  const fallback = /^([A-Z]{2,4})(?=[A-Z]*\d)/.exec(grn.toUpperCase());
  if (fallback) {
    return { branchCode: fallback[1], grnNumber: grn.slice(fallback[1].length) };
  }

  return { branchCode: division || null, grnNumber: grn };
}

function toIsoDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Normalize a date cell to an ISO `yyyy-MM-dd` string, or null.
 *
 * The GRN report stores dates as Excel serial numbers (46113 = 2026-04-01)
 * while the ageing report stores them as `dd-MM-yyyy` text, so both are handled.
 */
export function toIsoDateString(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) return toIsoDate(value);

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel's day 0 is 1899-12-30 under the 1900 date system.
    if (value <= 0 || value > 2958465) return null;
    const ms = Math.round(value) * 86400000;
    return toIsoDate(new Date(Date.UTC(1899, 11, 30) + ms));
  }

  const text = toText(value);
  if (!text) return null;

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    return asIso(y, m, d);
  }

  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (ymd) {
    const [, y, m, d] = ymd;
    return asIso(y, m, d);
  }

  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 0 && serial <= 2958465) {
    return toIsoDateString(serial);
  }

  return null;
}

/**
 * Assemble yyyy-MM-dd, rejecting anything that is not a real calendar date.
 *
 * Without this check a fat-fingered "45-99-2026" would sail through as
 * "2026-99-45" and be rejected by Postgres at INSERT time (22008) -- and since
 * an upload is a single transaction, one bad cell would roll back the whole
 * batch. Returning null instead leaves that one field empty and keeps the
 * upload alive.
 */
function asIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip through Date to catch 31-02 and non-leap 29-02.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Whole days between two `yyyy-MM-dd` strings, or null when either is missing.
 *
 * The result is NEGATIVE when the dates are out of order. That is deliberate:
 * in the ageing report a stage genuinely does sometimes end before it starts
 * (a SecurityDate before its PO, a cheque before the handover), and the source
 * report's own gap columns hide it by reporting the absolute value. Here the
 * sign is kept so the anomaly stays visible instead of reading as a fast step.
 *
 * Both ends are parsed as UTC midnight, so no timezone can shift the count.
 */
export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}
