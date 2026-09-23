import * as cheerio from "cheerio";
import type { SearchResult } from "../types.js";
import { fetchJson, fetchText, fetchWithTimeout } from "../util/http.js";
import { meter } from "../util/meter.js";
import { classifyHttp, providerRecentlyRejected, recordHttp, reportProviderCall, retireProvider } from "../providers/health.js";
// Keys arrive from dashboards and .env files, where a trailing newline or a wrapping pair of
// quotes survives the paste. Cleaning at the edge means the value the provider sees is the
// value the operator thinks they stored. See util/secret.ts.
import { secret } from "../util/secret.js";

export interface SearchProvider {
  name: string;
  available(): boolean;
  search(query: string, opts?: { count?: number; offset?: number; country?: string }): Promise<SearchResult[]>;
}

/** Brave Search API - no free tier since Feb 2026, $5/1,000 queries. Kept last in the
 * fallback chain (see defaultProviders below) so it's only used when free providers fall short. */
export const braveProvider = (apiKey = secret(process.env.BRAVE_SEARCH_API_KEY)): SearchProvider => ({
  name: "brave",
  available: () => !!apiKey,
  async search(query, opts = {}) {
    meter("brave");
    const params = new URLSearchParams({ q: query, count: String(Math.min(opts.count ?? 20, 20)), offset: String(opts.offset ?? 0) });
    if (opts.country) params.set("country", opts.country);
    const data = await fetchJson<{ web?: { results?: { title: string; url: string; description?: string }[] } }>(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      { headers: { "x-subscription-token": apiKey!, accept: "application/json" } },
    );
    return (data?.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "", provider: "brave" }));
  },
});

/**
 * Google Programmable Search JSON API.
 *
 * Google closed this to new customers in Sep 2026; existing projects lose access 1 Jan 2027.
 * A project without access answers 403 "This project does not have the access to Custom
 * Search JSON API", which no key, project or enablement change fixes. It used to sit first in
 * the chain spending a round trip on every single search to be told that again, so it now
 * retires itself for the life of the process the first time it hears it.
 */
const CSE_CLOSED = /does not have the access to custom search/i;

export const googleCseProvider = (apiKey = secret(process.env.GOOGLE_CSE_API_KEY), cx = secret(process.env.GOOGLE_CSE_CX)): SearchProvider => ({
  name: "google_cse",
  available: () => !!apiKey && !!cx,
  async search(query, opts = {}) {
    meter("google_cse");
    const start = (opts.offset ?? 0) + 1;
    const params = new URLSearchParams({ key: apiKey!, cx: cx!, q: query, num: String(Math.min(opts.count ?? 10, 10)), start: String(start) });
    if (opts.country) params.set("gl", opts.country);
    const res = await fetchWithTimeout(`https://www.googleapis.com/customsearch/v1?${params}`, { timeoutMs: 15_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const { outcome, detail } = classifyHttp(res.status, body);
      reportProviderCall({ provider: "google_cse", outcome, status: res.status, detail });
      if (CSE_CLOSED.test(detail)) {
        retireProvider("google_cse", "Google closed the Custom Search JSON API to new customers (Sep 2026)");
      }
      return [];
    }
    reportProviderCall({ provider: "google_cse", outcome: "ok", status: res.status });
    const data = (await res.json().catch(() => null)) as { items?: { title: string; link: string; snippet?: string }[] } | null;
    return (data?.items ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "", provider: "google_cse" }));
  },
});


/**
 * Serper - Google results as JSON. 2,500 free queries on signup, then $0.30 per 1,000.
 *
 * Added 22 Sep 2026 because Google closed the Custom Search JSON API to new customers, which
 * removed the only genuinely free search provider in the chain. Serper is roughly thirty
 * times cheaper per query than SerpAPI, so it sits ahead of it: webSearch stops at the first
 * provider that returns enough results, which makes this ordering the thing that decides
 * what a search actually costs.
 */
export const serperProvider = (apiKey = secret(process.env.SERPER_API_KEY)): SearchProvider => ({
  name: "serper",
  available: () => !!apiKey,
  async search(query, opts = {}) {
    const attempt = async (q: string) => {
      meter("serper");
      const body: Record<string, unknown> = { q, num: Math.min(opts.count ?? 20, 100) };
      if (opts.country) body.gl = opts.country.toLowerCase();
      if (opts.offset) body.page = Math.floor(opts.offset / (opts.count ?? 10)) + 1;
      return fetchWithTimeout("https://google.serper.dev/search", {
        method: "POST",
        timeoutMs: 20_000,
        headers: { "X-API-KEY": apiKey!, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    };

    const parse = async (res: Response): Promise<SearchResult[]> => {
      const data = (await res.json().catch(() => null)) as { organic?: { title?: string; link?: string; snippet?: string }[] } | null;
      return (data?.organic ?? [])
        .filter((r) => r.link)
        .map((r) => ({ title: r.title ?? "", url: r.link!, snippet: r.snippet ?? "", provider: "serper" }));
    };

    // Known-restricted accounts skip straight to the plain query rather than spending a round
    // trip proving the restriction again. The window expires, so upgrading the plan starts
    // working on its own: the next full query after it lapses succeeds and clears the flag.
    const plain = simplifyQuery(query);
    const hasOperators = plain !== query;

    // A known-restricted account skips straight to the plain query rather than spending a
    // round trip proving the restriction again - but only when there is something to strip.
    // A query with no operators is one this plan accepts, restricted or not.
    if (!operatorQueriesRestricted() || !hasOperators) {
      const res = await attempt(query);
      if (res.ok) {
        // A full operator query succeeding is how a plan upgrade announces itself.
        if (hasOperators) noteOperatorQueriesAllowed();
        reportProviderCall({ provider: "serper", outcome: "ok", status: res.status });
        return parse(res);
      }
      const body = await res.text().catch(() => "");
      const { outcome, detail } = classifyHttp(res.status, body);
      reportProviderCall({ provider: "serper", outcome, status: res.status, detail });
      if (outcome !== "unsupported_query" || !hasOperators) return [];
      // The free tier refuses site:, quotes, parentheses and OR. The account is healthy and
      // the credits are unspent, so degrade the query rather than the provider.
      noteOperatorQueriesRestricted();
    }

    if (!plain) return [];
    const res2 = await attempt(plain);
    if (!(await recordHttp("serper", res2))) return [];
    return parse(res2);
  },
});

/**
 * Whether this Serper account has refused operator syntax recently.
 *
 * Time-boxed rather than sticky for one reason that matters to the operator: when they put a
 * card on the account, nothing in this codebase has to change and nothing has to be
 * redeployed. The window lapses, the next search sends the full operator query, it succeeds,
 * and the flag clears itself. A permanent flag would mean a paid plan quietly kept running
 * degraded queries until someone remembered to restart the service.
 */
const OPERATOR_RETRY_MS = 15 * 60 * 1000;
let operatorRestrictedUntil = 0;

function operatorQueriesRestricted(now = Date.now()): boolean {
  return operatorRestrictedUntil > now;
}
function noteOperatorQueriesRestricted(now = Date.now()) {
  operatorRestrictedUntil = now + OPERATOR_RETRY_MS;
}
function noteOperatorQueriesAllowed() {
  operatorRestrictedUntil = 0;
}
/** Testing seam. */
export function resetSerperQueryRestriction() {
  operatorRestrictedUntil = 0;
}

/**
 * Strip search operators a restricted plan will not accept, keeping the words.
 *
 * `site:linkedin.com/in "Head of Growth" ("India" OR "UAE")` becomes
 * `linkedin.com/in Head of Growth India UAE`. The domain is kept as a plain term on purpose:
 * it still biases results toward LinkedIn without using the operator that was refused. This
 * is a degraded query and is meant to be - it exists so a free account returns something
 * rather than nothing, not so anyone mistakes it for the targeted search.
 */
export function simplifyQuery(query: string): string {
  return query
    .replace(/\bsite:(\S+)/gi, "$1")
    .replace(/\b(OR|AND)\b/g, " ")
    .replace(/["'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** SerpAPI - 100 free searches/month. */
export const serpApiProvider = (apiKey = secret(process.env.SERPAPI_KEY)): SearchProvider => ({
  name: "serpapi",
  available: () => !!apiKey,
  async search(query, opts = {}) {
    meter("serpapi");
    const params = new URLSearchParams({ api_key: apiKey!, engine: "google", q: query, num: String(opts.count ?? 20), start: String(opts.offset ?? 0) });
    if (opts.country) params.set("gl", opts.country);
    const data = await fetchJson<{ organic_results?: { title: string; link: string; snippet?: string }[] }>(
      `https://serpapi.com/search.json?${params}`,
    );
    return (data?.organic_results ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "", provider: "serpapi" }));
  },
});

/** DuckDuckGo HTML endpoint - no key, rate-limited; used as last resort. */
export const duckDuckGoProvider = (): SearchProvider => ({
  name: "duckduckgo",
  available: () => process.env.DDG_DISABLED !== "true",
  async search(query, opts = {}) {
    const params = new URLSearchParams({ q: query, kl: opts.country ? `${opts.country}-en` : "wt-wt" });
    if (opts.offset) params.set("s", String(opts.offset));
    const html = await fetchText(`https://html.duckduckgo.com/html/?${params}`, {
      // 15s per endpoint, twice, meant a single dead provider could cost 30s of a search's
      // wall clock. Measured in production on 23 Sep 2026: every call timed out at ~20s and
      // returned nothing. A provider this far down the chain does not get to be the slowest
      // thing in the request - if it cannot answer quickly it has nothing worth waiting for.
      timeoutMs: 5_000,
      headers: { referer: "https://html.duckduckgo.com/" },
    });
    if (!html || !html.includes("result__a")) {
      // fallback: lite endpoint
      const lite = await fetchText(`https://lite.duckduckgo.com/lite/?${params}`, { timeoutMs: 5_000 });
      if (!lite) return [];
      const $l = cheerio.load(lite);
      const outL: SearchResult[] = [];
      $l("a.result-link").each((_, el) => {
        let href = $l(el).attr("href") ?? "";
        const m = href.match(/uddg=([^&]+)/);
        if (m) href = decodeURIComponent(m[1]);
        if (!href.startsWith("http")) return;
        const snippet = $l(el).closest("tr").next("tr").find(".result-snippet").text().trim();
        outL.push({ title: $l(el).text().trim(), url: href, snippet, provider: "duckduckgo" });
      });
      return rejectDecoys("duckduckgo", query, honorSiteOperator(query, outL)).slice(0, opts.count ?? 20);
    }
    const $ = cheerio.load(html);
    const out: SearchResult[] = [];
    $(".result").each((_, el) => {
      const a = $(el).find("a.result__a");
      let href = a.attr("href") ?? "";
      const m = href.match(/uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
      if (!href.startsWith("http")) return;
      out.push({ title: a.text().trim(), url: href, snippet: $(el).find(".result__snippet").text().trim(), provider: "duckduckgo" });
    });
    return rejectDecoys("duckduckgo", query, honorSiteOperator(query, out)).slice(0, opts.count ?? 20);
  },
});


/**
 * Discard a scraped result set that does not answer the query.
 *
 * Verified against Bing on 22 Sep 2026: from a datacenter IP it echoes the full query in the
 * page title and the search box, returns a normal-looking `li.b_algo` list, and fills it with
 * results for the FIRST TOKEN ONLY. "best CRM for small business" came back as Best Buy and
 * dictionary entries for "best"; "Razorpay fintech Bengaluru" came back as Razorpay's own
 * pages with nothing about fintech or Bengaluru. Nothing errors, so the junk flows straight
 * into lead discovery looking like real data - the worst failure shape there is, and the same
 * principle as the visibility work: better to return nothing than to return noise as signal.
 *
 * The bar is deliberately low to avoid discarding good results: across the whole set, at least
 * one result must mention at least one distinctive term from the query. A genuine result set
 * clears that trivially; a first-token decoy cannot clear it at all, because every distinctive
 * term is precisely what the decoy dropped.
 *
 * Only applied to scraped providers. A keyed API that returns nothing is answering honestly.
 */
const QUERY_STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "in", "on", "at", "to", "and", "or", "is", "are", "with",
  "best", "top", "how", "what", "who", "which", "site", "com", "www", "vs", "by", "from",
]);

export function distinctiveTerms(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/site:\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // The first token is exactly what a decoy keeps, so it proves nothing and is excluded.
  return tokens.slice(1).filter((t) => t.length > 2 && !QUERY_STOPWORDS.has(t));
}

export function resultsAnswerQuery(query: string, results: SearchResult[]): boolean {
  const terms = distinctiveTerms(query);
  if (terms.length === 0 || results.length === 0) return true; // nothing to check against
  return results.some((r) => {
    const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

/** Drop a decoyed set and report it, so the chain falls through instead of passing junk on. */
function rejectDecoys(provider: string, query: string, results: SearchResult[]): SearchResult[] {
  if (resultsAnswerQuery(query, results)) return results;
  reportProviderCall({
    provider,
    outcome: "bad_response",
    detail: `returned ${results.length} result(s) matching none of the query's distinctive terms; the scrape is being served decoy results`,
  });
  return [];
}

/** Bing HTML fallback (no key). */
export const bingHtmlProvider = (): SearchProvider => ({
  name: "bing_html",
  available: () => process.env.BING_HTML_DISABLED !== "true",
  async search(query, opts = {}) {
    const params = new URLSearchParams({ q: query, count: String(opts.count ?? 20), first: String((opts.offset ?? 0) + 1), setlang: "en" });
    const html = await fetchText(`https://www.bing.com/search?${params}`, { timeoutMs: 15_000 });
    if (!html) return [];
    const $ = cheerio.load(html);
    const out: SearchResult[] = [];
    $("li.b_algo").each((_, el) => {
      const a = $(el).find("h2 a");
      let href = a.attr("href") ?? "";
      // Bing wraps targets: /ck/a?...&u=a1<base64url>
      const m = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
      if (m) {
        try {
          href = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        } catch {}
      }
      if (!href.startsWith("http")) return;
      out.push({ title: a.text().trim(), url: href, snippet: $(el).find(".b_caption p, .b_lineclamp2, .b_algoSlug").first().text().trim(), provider: "bing_html" });
    });
    return rejectDecoys("bing_html", query, honorSiteOperator(query, out)).slice(0, opts.count ?? 20);
  },
});

/** If the query used site:x, discard results outside x (scraped engines sometimes ignore operators). */
export function honorSiteOperator(query: string, results: SearchResult[]) {
  const m = query.match(/site:([^\s]+)/i);
  if (!m) return results;
  const site = m[1].toLowerCase().replace(/^https?:\/\//, "");
  return results.filter((r) => r.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").startsWith(site.replace(/^www\./, "")) || r.url.toLowerCase().includes(`.${site}`) || r.url.toLowerCase().includes(`//${site}`));
}

export function defaultProviders(): SearchProvider[] {
  // Free-tier providers first (Google CSE, SerpAPI), Brave last since it has no free tier as
  // of Feb 2026 (metered from the first query) - webSearch() stops at the first provider that
  // returns enough results, so ordering here directly controls what you pay for. Putting a
  // paid provider ahead of a free one would silently spend money on every search even when
  // the free option alone would have worked.
  // Google CSE stays first for accounts that still have access: it is 100 free queries a day
  // and nothing beats free. Google closed that API to new customers on 22 Sep 2026, so for
  // everyone else it 403s and is skipped by the cooling-off window rather than costing a
  // round trip on every search. Serper precedes SerpAPI because it is about thirty times
  // cheaper per query, and webSearch stops at the first provider that returns enough - which
  // makes this line, not a pricing page, what decides the cost of a search.
  return [googleCseProvider(), serperProvider(), serpApiProvider(), braveProvider(), duckDuckGoProvider(), bingHtmlProvider()];
}
