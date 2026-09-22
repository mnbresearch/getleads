import type { SearchResult } from "../types.js";
import { providerRecentlyRejected } from "../providers/health.js";
import { defaultProviders, type SearchProvider } from "./providers.js";

export interface WebSearchOptions {
  count?: number;
  offset?: number;
  country?: string;
  providers?: SearchProvider[];
  /** Stop after the first provider that returns >= minResults. */
  minResults?: number;
}

const cache = new Map<string, { at: number; results: SearchResult[] }>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

/**
 * Search the web with automatic provider fallback.
 * Order: Google CSE -> Serper -> SerpAPI -> Brave -> DuckDuckGo -> Bing HTML. Cheapest first,
 * since webSearch stops at the first provider returning enough results: Google CSE is free but
 * closed to new customers as of Sep 2026, Serper is ~30x cheaper per query than SerpAPI, and
 * Brave has had no free tier since Feb 2026. Providers that recently rejected us are skipped.
 * A provider that errors or returns nothing is skipped; results are cached 6h in-process.
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const key = JSON.stringify([query, opts.count, opts.offset, opts.country]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.results;

  // A provider that just rejected the credential will reject the next one too. Skipping it
  // for a while turns a permanently closed door (Google CSE, closed to new customers) from a
  // wasted round trip on every single search into one probe every half hour.
  const providers = (opts.providers ?? defaultProviders()).filter((p) => p.available() && !providerRecentlyRejected(p.name));
  const min = opts.minResults ?? 3;
  let best: SearchResult[] = [];
  for (const p of providers) {
    try {
      const results = await p.search(query, { count: opts.count, offset: opts.offset, country: opts.country });
      if (results.length > best.length) best = results;
      if (results.length >= min) break;
    } catch (err) {
      // fall through to next provider
      if (process.env.DEBUG_SEARCH) console.warn(`[search] ${p.name} failed:`, (err as Error).message);
    }
  }
  const deduped = dedupe(best);
  cache.set(key, { at: Date.now(), results: deduped });
  return deduped;
}

export function dedupe(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = r.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export * from "./providers.js";
