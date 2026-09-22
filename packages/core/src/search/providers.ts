import * as cheerio from "cheerio";
import type { SearchResult } from "../types.js";
import { fetchJson, fetchText, fetchWithTimeout } from "../util/http.js";
import { meter } from "../util/meter.js";
import { providerRecentlyRejected, recordHttp, reportProviderCall } from "../providers/health.js";

export interface SearchProvider {
  name: string;
  available(): boolean;
  search(query: string, opts?: { count?: number; offset?: number; country?: string }): Promise<SearchResult[]>;
}

/** Brave Search API - no free tier since Feb 2026, $5/1,000 queries. Kept last in the
 * fallback chain (see defaultProviders below) so it's only used when free providers fall short. */
export const braveProvider = (apiKey = process.env.BRAVE_SEARCH_API_KEY): SearchProvider => ({
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

/** Google Programmable Search JSON API - 100 free queries/day. */
export const googleCseProvider = (apiKey = process.env.GOOGLE_CSE_API_KEY, cx = process.env.GOOGLE_CSE_CX): SearchProvider => ({
  name: "google_cse",
  available: () => !!apiKey && !!cx,
  async search(query, opts = {}) {
    meter("google_cse");
    const start = (opts.offset ?? 0) + 1;
    const params = new URLSearchParams({ key: apiKey!, cx: cx!, q: query, num: String(Math.min(opts.count ?? 10, 10)), start: String(start) });
    if (opts.country) params.set("gl", opts.country);
    const data = await fetchJson<{ items?: { title: string; link: string; snippet?: string }[] }>(
      `https://www.googleapis.com/customsearch/v1?${params}`,
    );
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
export const serperProvider = (apiKey = process.env.SERPER_API_KEY): SearchProvider => ({
  name: "serper",
  available: () => !!apiKey,
  async search(query, opts = {}) {
    meter("serper");
    const body: Record<string, unknown> = { q: query, num: Math.min(opts.count ?? 20, 100) };
    if (opts.country) body.gl = opts.country.toLowerCase();
    if (opts.offset) body.page = Math.floor(opts.offset / (opts.count ?? 10)) + 1;

    const res = await fetchWithTimeout("https://google.serper.dev/search", {
      method: "POST",
      timeoutMs: 20_000,
      headers: { "X-API-KEY": apiKey!, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Classified rather than swallowed: a rejected key here would otherwise look exactly
    // like a query nobody matched, which is the failure this codebase keeps tripping over.
    if (!(await recordHttp("serper", res))) return [];

    const data = (await res.json().catch(() => null)) as { organic?: { title?: string; link?: string; snippet?: string }[] } | null;
    return (data?.organic ?? [])
      .filter((r) => r.link)
      .map((r) => ({ title: r.title ?? "", url: r.link!, snippet: r.snippet ?? "", provider: "serper" }));
  },
});

/** SerpAPI - 100 free searches/month. */
export const serpApiProvider = (apiKey = process.env.SERPAPI_KEY): SearchProvider => ({
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
      timeoutMs: 15_000,
      headers: { referer: "https://html.duckduckgo.com/" },
    });
    if (!html || !html.includes("result__a")) {
      // fallback: lite endpoint
      const lite = await fetchText(`https://lite.duckduckgo.com/lite/?${params}`, { timeoutMs: 15_000 });
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
