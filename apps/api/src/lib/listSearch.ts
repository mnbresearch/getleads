import { isStatementTimeout, withStatementTimeout, type Db } from "@prospex/db";
import { ApiError } from "./errors.js";

/**
 * Bounds and a time cap for the free-text filters on list endpoints (leads, signals,
 * companies, ...).
 *
 * The text a caller types into `?q=` is matched with a leading-wildcard ILIKE across several
 * columns (and a subquery), which Postgres can only answer with a sequential scan. With no
 * length bound a 3,000-character pattern on a large table ran for tens of seconds, and a
 * handful in parallel occupied every pooled connection and stalled every other request on the
 * instance, the health check included. Two defences, both here so every list route uses the
 * same ones:
 *
 *  - `LIST_SEARCH_MAX` caps the text, and `likeContains` escapes the LIKE metacharacters so
 *    the value is a literal substring and a caller cannot turn one character into a scan of
 *    its own;
 *  - `boundedRead` runs the read under a transaction-local statement timeout and turns a
 *    time-out into a plain 503, never a 500 and never a silently empty result.
 */
export const LIST_SEARCH_MAX = 120;

/** How long any one list read may run. Generous for an honest query, short enough to shed a scan. */
export const LIST_QUERY_TIMEOUT_MS = (() => {
  const n = Number(process.env.LIST_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? Math.floor(n) : 8000;
})();

/**
 * A `col ILIKE <pattern>` pattern that matches `term` as a literal substring. The caller's
 * own `%`, `_` and `\` are escaped (Postgres LIKE treats `\` as the default escape), so they
 * match themselves instead of acting as wildcards. The term is trimmed and length-capped
 * first; an over-long value cannot widen the scan.
 */
export function likeContains(term: string): string {
  const t = term.slice(0, LIST_SEARCH_MAX).replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${t}%`;
}

/** Split a comma-separated filter into a bounded set of non-empty, length-capped values. */
export function boundedCsv(value: string, maxItems = 25, maxLen = 80): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const s = part.trim().slice(0, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export const SEARCH_TOO_SLOW = "That search is taking too long to run. Narrow it - shorter text or fewer filters - and try again.";

/**
 * Run a read under the list query time cap. A statement cancelled for running past the cap
 * becomes a 503 the caller can act on; any other error is left for the normal handler.
 */
export async function boundedRead<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await withStatementTimeout(db, LIST_QUERY_TIMEOUT_MS, fn);
  } catch (e) {
    if (isStatementTimeout(e)) throw new ApiError(503, SEARCH_TOO_SLOW, "search_timeout");
    throw e;
  }
}
