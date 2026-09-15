import * as cheerio from "cheerio";
import type { SearchResult } from "../types.js";
import { fetchJson, fetchText } from "../util/http.js";

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
    const start = (opts.offset ?? 0) + 1;
    const params = new URLSearchParams({ key: apiKey!, cx: cx!, q: query, num: String(Math.min(opts.count ?? 10, 10)), start: String(start) });
    if (opts.country) params.set("gl", opts.country);
    const data = await fetchJson<{ items?: { title: string; link: string; snippet?: string }[] }>(
      `https://www.googleapis.com/customsearch/v1?${params}`,
    );
    return (data?.items ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "", provider: "google_cse" }));
  },
});

/** SerpAPI - 100 free searches/month. */
export const serpApiProvider = (apiKey = process.env.SERPAPI_KEY): SearchProvider => ({
  name: "serpapi",
  available: () => !!apiKey,
  async search(query, opts = {}) {
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
      return honorSiteOperator(query, outL).slice(0, opts.count ?? 20);
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
    return honorSiteOperator(query, out).slice(0, opts.count ?? 20);
  },
});

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
    return honorSiteOperator(query, out).slice(0, opts.count ?? 20);
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
  return [googleCseProvider(), serpApiProvider(), braveProvider(), duckDuckGoProvider(), bingHtmlProvider()];
}
