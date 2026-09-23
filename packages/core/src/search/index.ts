import type { SearchResult } from "../types.js";
import { providerRecentlyRejected, reportProviderCall } from "../providers/health.js";
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
  const all = opts.providers ?? defaultProviders();
  const unavailable = all.filter((p) => !p.available()).map((p) => p.name);
  const skipped = all.filter((p) => p.available() && providerRecentlyRejected(p.name)).map((p) => p.name);
  const providers = all.filter((p) => p.available() && !providerRecentlyRejected(p.name));
  const min = opts.minResults ?? 3;
  let best: SearchResult[] = [];
  /** What each provider actually did, so a silent chain can be explained afterwards. */
  const attempts: string[] = [];

  for (const p of providers) {
    const started = Date.now();
    try {
      const results = await p.search(query, { count: opts.count, offset: opts.offset, country: opts.country });
      attempts.push(`${p.name}=${results.length} (${Date.now() - started}ms)`);
      if (results.length > best.length) best = results;
      if (results.length >= min) break;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      attempts.push(`${p.name}=threw:${msg.slice(0, 80)}`);
      // A thrown provider error used to vanish unless DEBUG_SEARCH was set, so a search that
      // silently returned nothing looked identical to a query nobody matched - the same
      // failure-as-absence bug this codebase keeps rediscovering. Report it like any other
      // provider call so it reaches the health table and the admin page.
      reportProviderCall({ provider: p.name, outcome: "network", detail: msg.slice(0, 200) });
    }
  }

  // Every provider tried and nothing came back. That is a fact about the system, not about the
  // query, and it is worth one line in the log whether or not anyone set a debug flag.
  if (!best.length) {
    const parts = [
      attempts.length ? `tried ${attempts.join(", ")}` : "no providers were eligible",
      unavailable.length ? `unavailable: ${unavailable.join(",")}` : "",
      skipped.length ? `cooling off: ${skipped.join(",")}` : "",
    ].filter(Boolean);
    console.warn(`[search] no results for ${JSON.stringify(query.slice(0, 120))} - ${parts.join("; ")}`);
  } else if (process.env.DEBUG_SEARCH) {
    console.log(`[search] ${JSON.stringify(query.slice(0, 120))} -> ${attempts.join(", ")}`);
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
