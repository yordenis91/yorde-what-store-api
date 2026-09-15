import { toCsv } from './csv.util';

describe('toCsv', () => {
  it('joins headers and rows with commas and CRLF, prefixed with a UTF-8 BOM', () => {
    const csv = toCsv(['Name', 'Total'], [['Ana', 10], ['Bob', 20]]);

    expect(csv).toBe('﻿Name,Total\r\nAna,10\r\nBob,20');
  });

  it('quotes a field containing a comma, quote, or newline, and escapes embedded quotes', () => {
    const csv = toCsv(['Note'], [['Hello, "world"'], ['line1\nline2']]);

    expect(csv).toBe('﻿Note\r\n"Hello, ""world"""\r\n"line1\nline2"');
  });

  it('renders null/undefined as an empty field rather than the literal word', () => {
    const csv = toCsv(['A', 'B'], [[null, undefined]]);

    expect(csv).toBe('﻿A,B\r\n,');
  });
});
