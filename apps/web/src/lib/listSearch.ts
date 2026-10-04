/**
 * The longest search text a list accepts - the same number the server enforces.
 *
 * Search boxes carry it as `maxLength`, so the text cannot get longer than the server will
 * take. Before that, a 150-character search was sent, refused, and the page went on showing
 * the previous, unfiltered rows as if they were the result - with the bulk actions live.
 */
export const LIST_SEARCH_MAX = 120;

export const SEARCH_TOO_LONG = `Search text is too long (${LIST_SEARCH_MAX} characters at most)`;

/** What a search box hands to the list: trimmed, and never longer than the limit. */
export const searchText = (value: string) => value.trim().slice(0, LIST_SEARCH_MAX);

/**
 * A list-load error as a sentence a person can act on. A server that still names the field
 * by its parameter ("Q is too long ...") is put into the same words the newer one uses.
 */
export function listErrorText(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  if (/^q is too long/i.test(m)) return `${SEARCH_TOO_LONG}. Shorten the search and try again.`;
  if (/^search text is too long/i.test(m)) return `${m.replace(/\.$/, "")}. Shorten the search and try again.`;
  return m || "Something went wrong.";
}
