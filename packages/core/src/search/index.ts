import type { SearchResult } from "../types.js";
import { ProviderUnavailableError, providerRecentlyRejected, providerRetired, reportProviderCall, retiredReason } from "../providers/health.js";
import { defaultProviders, type SearchProvider } from "./providers.js";

export interface WebSearchOptions {
  count?: number;
  offset?: number;
  country?: string;
  providers?: SearchProvider[];
  /** Stop after the first provider that returns >= minResults. */
  minResults?: number;
}

const cache = new Map<string, { at: number; expiresAt: number; results: SearchResult[] }>();

/** A real answer is stable for hours; re-asking the same question wastes a paid credit. */
const CACHE_TTL = 6 * 60 * 60 * 1000;

/**
 * How long an EMPTY answer is trusted.
 *
 * Deliberately short. A search where every provider failed used to be cached for the full
 * six hours, so one outage - or one cooling-off window - was re-served as "nobody matched
 * that query" long after the providers came back. That is this codebase's cardinal sin,
 * committed by the function every discovery path funnels through.
 *
 * Five minutes still absorbs the duplicate queries a single pipeline run fires (the same
 * company name resolved for several leads), which is what the cache is really for, while
 * making a transient failure cost minutes rather than the rest of the working day.
 */
const EMPTY_CACHE_TTL = 5 * 60 * 1000;

/**
 * Search the web with automatic provider fallback.
 * Order: Google CSE -> Serper -> SerpAPI -> Brave -> DuckDuckGo -> Bing HTML. Cheapest first,
 * since webSearch stops at the first provider returning enough results: Google CSE is free but
 * closed to new customers as of Sep 2026, Serper is ~30x cheaper per query than SerpAPI, and
 * Brave has had no free tier since Feb 2026. Providers that recently rejected us are skipped.
 * A provider that errors or returns nothing is skipped. Results are cached 6h in-process;
 * an empty result only 5 minutes, and a run in which every provider threw is not cached at
 * all, so an outage cannot be re-served as absence.
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const key = JSON.stringify([query, opts.count, opts.offset, opts.country]);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.results;

  // A provider that just rejected the credential will reject the next one too. Skipping it
  // for a while turns a permanently closed door (Google CSE, closed to new customers) from a
  // wasted round trip on every single search into one probe every half hour.
  const all = opts.providers ?? defaultProviders();
  const unavailable = all.filter((p) => !p.available()).map((p) => p.name);
  const gone = all.filter((p) => p.available() && providerRetired(p.name)).map((p) => `${p.name} (${retiredReason(p.name)})`);
  const skipped = all.filter((p) => p.available() && !providerRetired(p.name) && providerRecentlyRejected(p.name)).map((p) => p.name);
  const providers = all.filter((p) => p.available() && !providerRetired(p.name) && !providerRecentlyRejected(p.name));
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
      //
      // A ProviderUnavailableError has already been reported with its real outcome (429,
      // 5xx, decoy results); reporting it again here would overwrite that with "network".
      if (!(err instanceof ProviderUnavailableError)) {
        reportProviderCall({ provider: p.name, outcome: "network", detail: msg.slice(0, 200) });
      }
    }
  }

  // Every provider tried and nothing came back. That is a fact about the system, not about the
  // query, and it is worth one line in the log whether or not anyone set a debug flag.
  if (!best.length) {
    const parts = [
      attempts.length ? `tried ${attempts.join(", ")}` : "no providers were eligible",
      unavailable.length ? `unavailable: ${unavailable.join(",")}` : "",
      skipped.length ? `cooling off: ${skipped.join(",")}` : "",
      gone.length ? `retired: ${gone.join(",")}` : "",
    ].filter(Boolean);
    console.warn(`[search] no results for ${JSON.stringify(query.slice(0, 120))} - ${parts.join("; ")}`);
  } else if (process.env.DEBUG_SEARCH) {
    console.log(`[search] ${JSON.stringify(query.slice(0, 120))} -> ${attempts.join(", ")}`);
  }

  const deduped = dedupe(best);

  // What gets remembered, and for how long, depends on whether this was an answer or a
  // failure.
  //
  // This guard used to be defeated by the thing it guarded against: it counts providers
  // that THREW, and the providers did not throw on an HTTP failure - they returned []. So a
  // 429 or a 5xx from every configured provider produced `everyProviderFailed === false`,
  // and the empty result was cached and re-served as "nobody matched that query". Every
  // provider failure path now raises ProviderUnavailableError, so a failure is countable.
  const threw = attempts.filter((a) => a.includes("=threw:")).length;
  const everyProviderFailed = attempts.length > 0 && threw === attempts.length;
  const nothingWasEligible = attempts.length === 0;

  if (deduped.length) {
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + CACHE_TTL, results: deduped });
  } else if (!everyProviderFailed && !nothingWasEligible) {
    // At least one provider answered and genuinely had nothing. Believe it, briefly.
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + EMPTY_CACHE_TTL, results: deduped });
  }
  // Otherwise: cache nothing. The next caller gets a real attempt rather than our bad day.

  return deduped;
}

/** Testing seam: forget everything remembered so far. */
export function resetSearchCache() {
  cache.clear();
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
