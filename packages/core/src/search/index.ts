import type { SearchResult } from "../types.js";
import { ProviderUnavailableError, providerCoolOff, providerRecentlyRejected, providerRetired, reportProviderCall, retiredReason, type ProviderOutcome } from "../providers/health.js";
import { defaultProviders, type SearchProvider } from "./providers.js";

export interface WebSearchOptions {
  count?: number;
  offset?: number;
  country?: string;
  providers?: SearchProvider[];
  /** Stop after the first provider that returns >= minResults. */
  minResults?: number;
  /**
   * Called once per search with what every provider did. Lets a caller several layers up
   * (the pipeline, through findPeople/findCompanies) tell "nobody matched" from "nothing we
   * asked could answer" without every intermediate function changing its return type.
   */
  onOutcome?: (outcome: WebSearchOutcome, query: string) => void;
}

/** What one provider did for one search. */
export interface WebSearchAttempt {
  provider: string;
  /** True when the provider answered - with results or genuinely without. */
  ok: boolean;
  /** Why it did not answer. Never contains a credential. */
  error?: string;
  /** Health outcome when known, or "skipped" for a provider that was not called. */
  outcome?: ProviderOutcome | "skipped";
  count: number;
  ms?: number;
}

export interface WebSearchOutcome {
  results: SearchResult[];
  attempts: WebSearchAttempt[];
  /** No provider answered: every one threw, was cooling off, retired, or none was eligible. */
  everyProviderFailed: boolean;
  /** No keyed search API (Serper, SerpAPI, Brave, Google CSE) is configured at all. */
  nothingConfigured: boolean;
  /** Served from the in-process cache; only answers are cached, so this implies one answered. */
  cached?: boolean;
}

/** Scrapers need no key; their presence says nothing about whether search is configured. */
const KEYLESS = new Set(["duckduckgo", "bing_html"]);

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
 *
 * Back-compatible shape: the results alone. Use webSearchDetailed to learn whether an empty
 * list means "nobody matched" or "nothing could answer".
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  return (await webSearchDetailed(query, opts)).results;
}

/** webSearch, with what each provider did alongside what came back. */
export async function webSearchDetailed(query: string, opts: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const all = opts.providers ?? defaultProviders();
  const nothingConfigured = !all.some((p) => !KEYLESS.has(p.name) && p.available());
  const done = (o: WebSearchOutcome): WebSearchOutcome => {
    try {
      opts.onOutcome?.(o, query);
    } catch {
      // an observer must never break the search it is observing
    }
    return o;
  };

  const key = JSON.stringify([query, opts.count, opts.offset, opts.country]);
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return done({ results: hit.results, attempts: [], everyProviderFailed: false, nothingConfigured, cached: true });

  // A provider that just rejected the credential will reject the next one too. Skipping it
  // for a while turns a permanently closed door (Google CSE, closed to new customers) from a
  // wasted round trip on every single search into one probe every half hour.
  const unavailable = all.filter((p) => !p.available()).map((p) => p.name);
  const attempts: WebSearchAttempt[] = [];
  const providers: SearchProvider[] = [];
  for (const p of all) {
    if (!p.available()) continue;
    if (providerRetired(p.name)) {
      attempts.push({ provider: p.name, ok: false, outcome: "skipped", count: 0, error: `retired: ${retiredReason(p.name)}` });
    } else if (providerRecentlyRejected(p.name)) {
      const c = providerCoolOff(p.name);
      attempts.push({ provider: p.name, ok: false, outcome: "skipped", count: 0, error: `cooling off after ${c?.outcome ?? "a rejection"}` });
    } else providers.push(p);
  }
  const min = opts.minResults ?? 3;
  let best: SearchResult[] = [];

  for (const p of providers) {
    const started = Date.now();
    try {
      const results = await p.search(query, { count: opts.count, offset: opts.offset, country: opts.country });
      attempts.push({ provider: p.name, ok: true, outcome: "ok", count: results.length, ms: Date.now() - started });
      if (results.length > best.length) best = results;
      if (results.length >= min) break;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const outcome = err instanceof ProviderUnavailableError ? err.outcome : "network";
      attempts.push({ provider: p.name, ok: false, outcome, error: msg.slice(0, 200), count: 0, ms: Date.now() - started });
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

  const answered = attempts.some((a) => a.ok);
  const everyProviderFailed = !answered;

  // Every provider tried and nothing came back. That is a fact about the system, not about the
  // query, and it is worth one line in the log whether or not anyone set a debug flag.
  if (!best.length) {
    const parts = [
      attempts.length ? `tried ${describeAttempts(attempts)}` : "no providers were eligible",
      unavailable.length ? `unavailable: ${unavailable.join(",")}` : "",
    ].filter(Boolean);
    console.warn(`[search] no results for ${JSON.stringify(query.slice(0, 120))} - ${parts.join("; ")}`);
  } else if (process.env.DEBUG_SEARCH) {
    console.log(`[search] ${JSON.stringify(query.slice(0, 120))} -> ${describeAttempts(attempts)}`);
  }

  const deduped = dedupe(best);

  // What gets remembered, and for how long, depends on whether this was an answer or a
  // failure. Every provider failure path raises ProviderUnavailableError, so a failure is
  // countable; an empty list is only believed (briefly) when some provider actually answered.
  if (deduped.length) {
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + CACHE_TTL, results: deduped });
  } else if (answered) {
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + EMPTY_CACHE_TTL, results: deduped });
  }
  // Otherwise: cache nothing. The next caller gets a real attempt rather than our bad day.

  return done({ results: deduped, attempts, everyProviderFailed, nothingConfigured });
}

function describeAttempts(attempts: WebSearchAttempt[]): string {
  return attempts.map((a) => (a.ok ? `${a.provider}=${a.count}${a.ms !== undefined ? ` (${a.ms}ms)` : ""}` : `${a.provider}=${a.outcome === "skipped" ? "skipped" : "threw"}:${(a.error ?? "").slice(0, 80)}`)).join(", ");
}

/**
 * What a CUSTOMER is told when no web search provider is set up on the platform.
 *
 * This sentence travels: it becomes a search's error, an autopilot's note, a saved search's
 * alert. It used to name the server's environment variables ("set SERPER_API_KEY or
 * BRAVE_SEARCH_API_KEY"), which a customer can do nothing with - and it must still say that
 * an empty result here is our problem, not a finding about their market.
 */
export const NO_WEB_SEARCH_CONFIGURED =
  "Lead search isn't available right now because no search source is connected on our side. This is not a result about your market - contact support.";
/** The same fact for whoever runs the server: which settings turn web search on. Logs and admin screens only. */
export const NO_WEB_SEARCH_CONFIGURED_OPERATOR = "No web search provider is configured (set SERPER_API_KEY or BRAVE_SEARCH_API_KEY)";
/** Is this the "nothing is connected on our side" failure, as opposed to a provider that refused us? */
export const isNoWebSearchConfigured = (message: string | null | undefined): boolean => String(message ?? "").startsWith(NO_WEB_SEARCH_CONFIGURED);

let lastNoSearchLogAt = 0;

/**
 * One sentence for a run of searches in which no provider ever answered, or null when at
 * least one search got a real answer (or none were run).
 *
 * Aggregated per provider, keeping the last error each gave, because a pipeline fires dozens
 * of searches and the operator needs "serper: out of credit", not the same line forty times.
 */
export function summarizeWebSearchFailures(outcomes: WebSearchOutcome[]): string | null {
  if (!outcomes.length) return null;
  if (outcomes.some((o) => !o.everyProviderFailed)) return null;
  const last = new Map<string, string>();
  for (const o of outcomes) for (const a of o.attempts) if (!a.ok) last.set(a.provider, a.error ?? a.outcome ?? "failed");
  const detail = [...last].map(([p, e]) => `${p}: ${e}`).join("; ");
  const n = outcomes.length;
  if (outcomes.every((o) => o.nothingConfigured)) {
    // The operator's version - which settings are missing, and what the keyless fallbacks
    // said - goes to the server log (at most once a minute; a pipeline asks many times).
    // The returned sentence is shown to customers and carries neither.
    if (Date.now() - lastNoSearchLogAt > 60_000) {
      lastNoSearchLogAt = Date.now();
      console.warn(`[search] ${NO_WEB_SEARCH_CONFIGURED_OPERATOR}${detail ? `; the keyless fallbacks also failed (${detail.slice(0, 300)})` : ""}`);
    }
    return NO_WEB_SEARCH_CONFIGURED;
  }
  return `Every web search provider failed across ${n} search${n === 1 ? "" : "es"}${detail ? `: ${detail}` : " (no provider was eligible)"}`;
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
