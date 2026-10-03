/**
 * CSV in and out.
 *
 * Parsing walks the whole text as one stream rather than splitting on newlines first: a
 * quoted cell may legally contain a line break (an address, a note pasted from an email),
 * and splitting first cut such a row in two - the second half became a bogus lead and every
 * column after the break shifted by one.
 */
export function parseCsvRows(text: string): string[][] {
  return parseCsvDetailed(text).rows;
}

/**
 * Most columns kept from one row. A single 100,000-column line was parsed, mapped and
 * stored as 100,000 custom fields on one lead; a real export has a few dozen.
 */
export const CSV_MAX_COLUMNS = 200;

/**
 * `parseCsvRows`, plus what the parse noticed about the file:
 *  - `unterminatedQuote`: the text ended inside a quoted cell, so everything after the stray
 *    quote was read as ONE cell (it used to be imported as a lead whose name was the rest
 *    of the file);
 *  - `overWide`: 0-based indexes (into `rows`) of rows that had more than CSV_MAX_COLUMNS
 *    cells. Their extra cells are dropped here so nothing downstream handles them; the
 *    caller reports those rows instead of importing them.
 * NUL characters are removed: Postgres text cannot hold them.
 */
export function parseCsvDetailed(text: string): { rows: string[][]; unterminatedQuote: boolean; overWide: number[] } {
  const all: string[][] = [];
  const wide: boolean[] = [];
  let row: string[] = [];
  let cells = 0;
  let cur = "";
  let inQ = false;
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 BOM
  const s = noBom.indexOf("\u0000") === -1 ? noBom : noBom.replace(/\u0000/g, "");
  const pushCell = () => {
    cells++;
    if (cells <= CSV_MAX_COLUMNS) row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    all.push(row);
    wide.push(cells > CSV_MAX_COLUMNS);
    row = [];
    cells = 0;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === ",") pushCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      pushCell();
      pushRow();
    } else cur += ch;
  }
  if (cur !== "" || cells > 0) {
    pushCell();
    pushRow();
  }
  // Blank lines are not rows.
  const rows: string[][] = [];
  const overWide: number[] = [];
  all.forEach((r, i) => {
    if (!r.some((v) => v.trim() !== "")) return;
    if (wide[i]) overWide.push(rows.length);
    rows.push(r);
  });
  return { rows, unterminatedQuote: inQ, overWide };
}

const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 100);

/** Header row -> objects, with headers normalised to snake_case keys. */
export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvRecords(text).records;
}

/**
 * `parseCsv` with the parse diagnostics. `overWide` holds 0-based indexes into `records`.
 * Records are built without a prototype chain in play: a header named `__proto__` or
 * `constructor` is an ordinary own key here, never a way to reach Object.prototype.
 */
export function parseCsvRecords(text: string): { records: Record<string, string>[]; unterminatedQuote: boolean; overWide: number[] } {
  const { rows, unterminatedQuote, overWide } = parseCsvDetailed(text);
  if (rows.length < 2) return { records: [], unterminatedQuote, overWide: [] };
  const headers = rows[0].map(headerKey);
  const records = rows.slice(1).map((r) => {
    const o: Record<string, string> = Object.create(null);
    r.forEach((v, i) => {
      o[headers[i] || `col${i}`] = v.trim();
    });
    return o;
  });
  return { records, unterminatedQuote, overWide: overWide.filter((i) => i > 0).map((i) => i - 1) };
}

/**
 * One CSV cell, quoted, and defused against formula injection.
 *
 * A lead's title or company comes from scraped pages and imported files, so it is attacker
 * text. A cell starting with = + - @ (or a tab/CR that Excel strips first) is executed as a
 * formula when the export is opened in a spreadsheet - `=HYPERLINK(...)` is enough to leak
 * data. A leading apostrophe makes the spreadsheet show it as text.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  // Spreadsheets trim leading whitespace and control characters before deciding whether a
  // cell is a formula, so " =1+1" and "\n=cmd|..." run exactly like "=1+1". The test is
  // made on what the spreadsheet will look at, not on the raw first character.
  // eslint-disable-next-line no-control-regex
  const lead = s.replace(/^[\s\u0000-\u001f\u007f\u00a0\ufeff\u200b]+/, "");
  // Phone numbers and plain numbers ("+14155550100", "-5", "+1 (415) 555-0100") cannot be
  // formulas; prefixing them corrupted every exported phone number.
  const formulaStart = /^[=+\-@]/.test(lead) || /^[\t\r]/.test(s);
  if (lead && formulaStart && !/^[+-]?[\d\s().-]+$/.test(lead)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
