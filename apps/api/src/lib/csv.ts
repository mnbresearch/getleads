/**
 * CSV in and out.
 *
 * Parsing walks the whole text as one stream rather than splitting on newlines first: a
 * quoted cell may legally contain a line break (an address, a note pasted from an email),
 * and splitting first cut such a row in two - the second half became a bogus lead and every
 * column after the break shifted by one.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 BOM
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
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  // Blank lines are not rows.
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Header row -> objects, with headers normalised to snake_case keys. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  return rows.slice(1).map((r) => Object.fromEntries(r.map((v, i) => [headers[i] ?? `col${i}`, v.trim()])));
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
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
