import type { SearchResult } from "../types.js";
import { ProviderUnavailableError, providerCoolOff, providerRecentlyRejected, providerRetired, reportProviderCall, retiredReason, type ProviderOutcome } from "../providers/health.js";
import { defaultProviders, offSiteDiscarded, type SearchProvider } from "./providers.js";

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
  /**
   * Results this provider returned for a `site:` query that were NOT on that site, and so
   * were discarded. Scraped engines ignore the operator from some addresses: such a search
   * "answered" with nothing, yet it never looked where it was asked to. Set only when > 0.
   */
  offSite?: number;
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
 * an empty result only 5 minutes, and a run in which every provider threw - or in which a
 * `site:` search's results all had to be discarded as off that site - is not cached at
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
      const answer = await p.search(query, { count: opts.count, offset: opts.offset, country: opts.country });
      const offSite = offSiteDiscarded(answer);
      const results = tidyResults(answer);
      attempts.push({ provider: p.name, ok: true, outcome: "ok", count: results.length, ms: Date.now() - started, ...(offSite > 0 ? { offSite } : {}) });
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
    // The search text is what a customer typed - a person's name, "@theirdomain.com" - and a
    // provider's error can echo it back. Neither belongs in the log: by default the line
    // says how long the text was and which providers did what. DEBUG_SEARCH=true (an
    // operator's choice, for a debugging session) puts the text and the details back.
    console.warn(searchDebugOn() ? `[search] no results for ${JSON.stringify(query.slice(0, 120))} - ${parts.join("; ")}` : `[search] no results for a ${query.length}-character query - ${attempts.length ? `tried ${describeAttemptsBriefly(attempts)}` : "no providers were eligible"}${unavailable.length ? `; unavailable: ${unavailable.join(",")}` : ""}`);
  } else if (searchDebugOn()) {
    console.log(`[search] ${JSON.stringify(query.slice(0, 120))} -> ${describeAttempts(attempts)}`);
  }

  const deduped = dedupe(best);

  // What gets remembered, and for how long, depends on whether this was an answer or a
  // failure. Every provider failure path raises ProviderUnavailableError, so a failure is
  // countable; an empty list is only believed (briefly) when some provider actually answered.
  //
  // One empty answer is not believed at all: a `site:` search whose results were thrown away
  // for being off that site. The engine ignored the operator, so the site was never
  // searched - and a cached entry carries no attempts, so the second identical search in a
  // run would have read as "searched and found nobody" where the first said, correctly, that
  // the site could not be searched.
  const siteIgnored = !deduped.length && attempts.some((a) => a.ok && (a.offSite ?? 0) > 0);
  if (deduped.length) {
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + CACHE_TTL, results: deduped });
  } else if (answered && !siteIgnored) {
    cache.set(key, { at: Date.now(), expiresAt: Date.now() + EMPTY_CACHE_TTL, results: deduped });
  }
  // Otherwise: cache nothing. The next caller gets a real attempt rather than our bad day.

  return done({ results: deduped, attempts, everyProviderFailed, nothingConfigured });
}

/**
 * A result is three lines: a title, an address and a snippet. Whatever a provider (or a page a
 * scraper read) sends as one, only a line's worth of each is passed on, and a result whose
 * address is longer than any real one is left out - cutting it would make another address.
 *
 * Everything downstream reads these fields with patterns written for a line of text. Handed a
 * megabyte of spaces as a "title" - a results page can be made to carry one - several of them
 * went back over it from every character: minutes during which the process answered nobody.
 */
export const MAX_RESULT_TITLE = 300;
export const MAX_RESULT_SNIPPET = 1_000;
export const MAX_RESULT_URL = 2_000;
const MAX_RESULTS_PER_ANSWER = 200;

export function tidyResults(results: SearchResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  if (!Array.isArray(results)) return out;
  for (const r of results) {
    if (out.length >= MAX_RESULTS_PER_ANSWER) break;
    if (!r || typeof r.url !== "string" || !r.url || r.url.length > MAX_RESULT_URL) continue;
    const title = typeof r.title === "string" ? r.title : "";
    const snippet = typeof r.snippet === "string" ? r.snippet : "";
    out.push(title.length <= MAX_RESULT_TITLE && snippet.length <= MAX_RESULT_SNIPPET && title === r.title && snippet === r.snippet ? r : { ...r, title: title.slice(0, MAX_RESULT_TITLE), snippet: snippet.slice(0, MAX_RESULT_SNIPPET) });
  }
  return out;
}

/** DEBUG_SEARCH=true (or 1): log lines may carry the search text and providers' own words. */
export function searchDebugOn(): boolean {
  return /^(true|1)$/i.test((process.env.DEBUG_SEARCH ?? "").trim());
}

/** Provider, result count or kind of failure - never a provider's message, which can echo the query. */
function describeAttemptsBriefly(attempts: WebSearchAttempt[]): string {
  return attempts.map((a) => (a.ok ? `${a.provider}=${a.count}${a.ms !== undefined ? ` (${a.ms}ms)` : ""}` : `${a.provider}=${a.outcome ?? "failed"}`)).join(", ");
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
  // For the log: which fallbacks failed and how, without their messages (see searchDebugOn).
  const lastOutcome = new Map<string, string>();
  for (const o of outcomes) for (const a of o.attempts) if (!a.ok) lastOutcome.set(a.provider, a.outcome ?? "failed");
  const logDetail = searchDebugOn() ? detail.slice(0, 300) : [...lastOutcome].map(([p, e]) => `${p}: ${e}`).join("; ");
  const n = outcomes.length;
  if (outcomes.every((o) => o.nothingConfigured)) {
    // The operator's version - which settings are missing, and what the keyless fallbacks
    // said - goes to the server log (at most once a minute; a pipeline asks many times).
    // The returned sentence is shown to customers and carries neither.
    if (Date.now() - lastNoSearchLogAt > 60_000) {
      lastNoSearchLogAt = Date.now();
      console.warn(`[search] ${NO_WEB_SEARCH_CONFIGURED_OPERATOR}${logDetail ? `; the keyless fallbacks also failed (${logDetail})` : ""}`);
    }
    return NO_WEB_SEARCH_CONFIGURED;
  }
  return `Every web search provider failed across ${n} search${n === 1 ? "" : "es"}${detail ? `: ${detail}` : " (no provider was eligible)"}`;
}

/** Testing seam: forget everything remembered so far. */
export function resetSearchCache() {
  cache.clear();
}

/**
 * Query parameters that say where a click came from and never which page it is. Everything
 * else in a query string can be the page's identity (`news.ycombinator.com/item?id=...`,
 * `youtube.com/watch?v=...`) and is kept.
 */
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]*|ref|ref_src|ref_url|fbclid|gclid|gclsrc|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|trk|trkinfo|_hsenc|_hsmi|gh_src)$/i;

/** What makes two result URLs the same page: host and path without case, the query without tracking parameters, no fragment. */
export function resultKey(url: string): string {
  try {
    const u = new URL(url);
    const kept: string[] = [];
    for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) kept.push(`${k}=${v}`);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "").toLowerCase() + (kept.length ? `?${kept.join("&")}` : "");
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

/**
 * One result per page.
 *
 * The key used to drop the whole query string, which made every
 * `news.ycombinator.com/item?id=...` - and any other page identified by a parameter - the
 * same result, so a search that found ten threads returned one.
 */
export function dedupe(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = resultKey(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export * from "./providers.js";
