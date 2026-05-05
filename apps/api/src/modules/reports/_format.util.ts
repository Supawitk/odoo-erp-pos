/**
 * Format helpers shared across the reports module.
 *
 * Each PND/PP form spec has its own quirks for `onlyDigits`, `safe`, `pad`,
 * etc. (e.g. v1.0 RD-Prep allows commas inside values; v2.0 SWC forbids them;
 * the v2.0 emitter pads empty TINs with zeros while v1.0 keeps them empty).
 * Those format-specific variants stay in their own files. This file holds
 * only the helpers that are truly identical across all consumers.
 */

/** Two-digit zero-padded integer string. `pad2(5)` → `"05"`. */
export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/**
 * Escape a value for CSV output. Wraps in `"..."` (with internal quotes
 * doubled) only when the value contains a comma, quote, or newline.
 */
export function csvSafe(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Format integer satang as a baht string with thousands separator.
 * `toBaht(123450)` → `"1,234.50"`. Use only OUTSIDE comma-delimited contexts
 * (e.g. inside an XLSX cell or `|`-pipe-delimited file). For CSV, see
 * `bahtPlain` instead — the thousands separator collides with the delimiter.
 */
export function toBaht(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const baht = Math.floor(abs / 100);
  const sat = abs % 100;
  return `${sign}${baht.toLocaleString('en-US')}.${pad2(sat)}`;
}

/**
 * Format integer satang as a baht string WITHOUT thousands separator.
 * `bahtPlain(123450)` → `"1234.50"`. Safe to drop into a CSV cell.
 */
export function bahtPlain(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${pad2(abs % 100)}`;
}

/**
 * RD's display format for 13-digit TINs: `"0-1234-56789-01-2"`. Falls back to
 * the input verbatim when it isn't 13 digits — avoids silently mangling
 * already-formatted strings.
 */
export function formatTinDisplay(tin: string): string {
  const d = (tin || '').replace(/\D/g, '');
  if (d.length !== 13) return tin;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}
