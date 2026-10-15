/**
 * Minimal RFC 4180 CSV serializer — no dependency for something this small.
 * A field is quoted only when it needs to be (contains a comma, quote, or
 * newline); an embedded quote is escaped by doubling it, per the spec.
 */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Spreadsheet formula injection: Excel/Sheets run a cell that starts with one
  // of these. Customer-supplied text (names, notes) ends up in exports, so
  // neutralise with a leading apostrophe — but leave plain numbers (-5, +1.50) alone.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str) && !/^[+-]?\d+(\.\d+)?$/.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(','));
  // CRLF per RFC 4180, and a BOM so Excel opens UTF-8 (accents, currency symbols) correctly.
  return '﻿' + lines.join('\r\n');
}
