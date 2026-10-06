/**
 * Three things the plays depend on in the shared search layer, each changed as little as
 * possible:
 *
 *  - two results are the same page only when their addresses are the same page, query
 *    string included (`news.ycombinator.com/item?id=1` and `...?id=2` are two threads);
 *  - a keyless scraper that answers with a bot challenge, or whose endpoints both fail in
 *    one search, rests instead of being asked again by every search of a run;
 *  - an engine that ignores `site:` says how much it threw away, so a caller can tell
 *    "nothing on that site" from "that site was never searched".
 *
 * And what webSearch returns is otherwise exactly what it returned before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../types.js";
import { coolOffProvider, providerCoolOff, providerRecentlyRejected, resetProviderSkips } from "../providers/health.js";
import { dedupe, resetSearchCache, resultKey, webSearch, webSearchDetailed, type SearchProvider } from "./index.js";
import { KEYLESS_COOL_MS, bingHtmlProvider, duckDuckGoProvider, honorSiteOperator, isDuckDuckGoChallenge, offSiteDiscarded } from "./providers.js";

const r = (url: string, title = "t"): SearchResult => ({ title, url, snippet: "", provider: "x" });

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which results are the same page", () => {
  it("keeps pages that differ only in their query string apart", () => {
    const threads = [r("https://news.ycombinator.com/item?id=41234567"), r("https://news.ycombinator.com/item?id=41239999"), r("https://www.youtube.com/watch?v=aaa"), r("https://www.youtube.com/watch?v=bbb"), r("https://example.com/search?q=one&page=2"), r("https://example.com/search?q=one&page=3")];
    expect(dedupe(threads)).toEqual(threads);
  });

  it("still treats one page reached two ways as one", () => {
    const same = [
      r("https://Example.com/Pricing/"),
      r("https://example.com/pricing"),
      r("https://example.com/pricing#plans"),
      r("https://example.com/pricing?utm_source=newsletter&utm_medium=email"),
      r("https://example.com/pricing?ref=hn"),
      r("https://example.com/pricing?fbclid=abc123"),
      r("https://example.com/pricing?gclid=xyz&msclkid=1"),
      r("https://example.com/pricing/?trk=public_post"),
    ];
    expect(dedupe(same)).toEqual([same[0]]);
    // A tracking parameter next to a real one: the real one still tells pages apart.
    expect(dedupe([r("https://news.ycombinator.com/item?id=1&utm_source=x"), r("https://news.ycombinator.com/item?id=1"), r("https://news.ycombinator.com/item?id=2&ref=y")]).map((x) => x.url)).toEqual(["https://news.ycombinator.com/item?id=1&utm_source=x", "https://news.ycombinator.com/item?id=2&ref=y"]);
  });

  it("everything that was one page before is still one page (no query string involved)", () => {
    const before = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    for (const url of ["https://example.com/", "https://example.com", "https://Example.com/A/B/", "http://example.com/a#top", "https://sub.example.co.uk/path/to/page", "https://www.linkedin.com/in/jane-doe-1a2b3c", "https://boards.greenhouse.io/globex/jobs/4012345"]) {
      expect(resultKey(url)).toBe(before(url));
    }
    // Something that is not an address at all falls back to the old key.
    expect(resultKey("not a url?x=1")).toBe("not a url");
  });

  it("webSearch returns every thread a provider found", async () => {
    const threads = [r("https://news.ycombinator.com/item?id=1", "Ask HN: one"), r("https://news.ycombinator.com/item?id=2", "Ask HN: two"), r("https://news.ycombinator.com/item?id=3", "Ask HN: three")];
    const provider: SearchProvider = { name: "serper", available: () => true, search: async () => threads };
    expect((await webSearch("site:news.ycombinator.com ask hn", { providers: [provider] })).map((x) => x.url)).toEqual(threads.map((t) => t.url));
  });
});

describe("a keyless scraper that is being turned away", () => {
  const CHALLENGE = `<!DOCTYPE html><html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><div>Please complete the following challenge to confirm this search was made by a human.</div></body></html>`;
  const RESULTS = `<html><body><div class="result"><a class="result__a" href="https://globex.example/alternative-to-acme">An alternative to Acme</a><a class="result__snippet">alternative to Acme for small teams</a></div></body></html>`;
  const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

  it("knows a challenge page from a page of results", () => {
    expect(isDuckDuckGoChallenge(CHALLENGE)).toBe(true);
    expect(isDuckDuckGoChallenge(RESULTS)).toBe(false);
    expect(isDuckDuckGoChallenge("")).toBe(false);
    expect(isDuckDuckGoChallenge("<html><body>No results found for your search.</body></html>")).toBe(false);
  });

  it("a bot challenge is a failure, and the provider rests: the next search does not ask it again", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      calls.push(String(url));
      // HTTP 202 with the challenge page, as the real service answers.
      return html(CHALLENGE, 202);
    });
    const ddg = duckDuckGoProvider();
    const first = await webSearchDetailed("alternative to Acme", { providers: [ddg] });
    expect(first.everyProviderFailed).toBe(true);
    expect(first.attempts).toMatchObject([{ provider: "duckduckgo", ok: false, outcome: "rate_limit" }]);
    // One request: the second endpoint is not tried after a challenge.
    expect(calls).toHaveLength(1);
    expect(providerCoolOff("duckduckgo")).toMatchObject({ outcome: "rate_limit" });
    expect(providerCoolOff("duckduckgo")!.until - Date.now()).toBeGreaterThan(KEYLESS_COOL_MS - 5_000);

    const second = await webSearchDetailed("switching from Acme", { providers: [ddg] });
    expect(calls).toHaveLength(1);
    expect(second.attempts).toMatchObject([{ provider: "duckduckgo", ok: false, outcome: "skipped" }]);
    expect(second.everyProviderFailed).toBe(true);
  });

  it("both endpoints failing in one search rests it too, instead of ten seconds of waiting per search for a whole run", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    });
    const ddg = duckDuckGoProvider();
    for (const q of ["alternative to Acme", "switching from Acme", "frustrated with Acme", "Acme is too expensive"]) await webSearchDetailed(q, { providers: [ddg] });
    // The first search tried both endpoints; the other three asked for nothing.
    expect(calls).toHaveLength(2);
    expect(providerRecentlyRejected("duckduckgo")).toBe(true);
    expect(providerCoolOff("duckduckgo")).toMatchObject({ outcome: "network" });
  });

  it("a page of results is an answer, and clears nothing it should not", async () => {
    vi.stubGlobal("fetch", async () => html(RESULTS));
    const o = await webSearchDetailed("alternative to Acme", { providers: [duckDuckGoProvider()] });
    expect(o.everyProviderFailed).toBe(false);
    expect(o.results.map((x) => x.url)).toEqual(["https://globex.example/alternative-to-acme"]);
    expect(providerRecentlyRejected("duckduckgo")).toBe(false);
  });

  it("one endpoint answering with nothing while the other works is not a reason to rest", async () => {
    // The html endpoint times out; the lite endpoint answers (with no results for this query).
    vi.stubGlobal("fetch", async (url: unknown) => {
      if (String(url).startsWith("https://html.duckduckgo.com/")) throw new TypeError("fetch failed");
      return html("<html><body><table></table></body></html>");
    });
    const o = await webSearchDetailed("zzzz qqqq", { providers: [duckDuckGoProvider()] });
    expect(o.everyProviderFailed).toBe(false);
    expect(providerRecentlyRejected("duckduckgo")).toBe(false);
  });

  it("resting never shortens a longer rest, and does nothing for a non-positive time", () => {
    const now = 1_800_000_000_000;
    coolOffProvider("duckduckgo", "rate_limit", 60_000, now);
    coolOffProvider("duckduckgo", "network", 1_000, now);
    expect(providerCoolOff("duckduckgo", now)).toEqual({ outcome: "rate_limit", until: now + 60_000 });
    coolOffProvider("bing_html", "network", 0, now);
    expect(providerRecentlyRejected("bing_html", now)).toBe(false);
    // It ends by itself.
    expect(providerRecentlyRejected("duckduckgo", now + 60_001)).toBe(false);
  });
});

describe("an engine that ignores the site it was asked to search", () => {
  const BING = (links: [string, string][]): string => `<html><body><ol>${links.map(([href, text]) => `<li class="b_algo"><h2><a href="${href}">${text}</a></h2><div class="b_caption"><p>${text}</p></div></li>`).join("")}</ol></body></html>`;
  const page = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("says how many results it threw away for being off the site - and returns what it always returned", async () => {
    vi.stubGlobal("fetch", async () => page(BING([["https://www.somevendor.example/blog/alternative-to-acme", "The best alternative to Acme"], ["https://other.example/acme-alternative", "Acme alternative"]])));
    const o = await webSearchDetailed('site:reddit.com "alternative to Acme"', { providers: [bingHtmlProvider()] });
    expect(o.results).toEqual([]);
    // The provider answered, as before: this is not reported as a failure here.
    expect(o.everyProviderFailed).toBe(false);
    expect(o.attempts).toMatchObject([{ provider: "bing_html", ok: true, outcome: "ok", count: 0, offSite: 2 }]);
  });

  it("says nothing when the site was honoured, or when no site was asked for", async () => {
    vi.stubGlobal("fetch", async () => page(BING([["https://www.reddit.com/r/sales/comments/1abc/alternative_to_acme/", "Looking for an alternative to Acme"], ["https://other.example/alternative-to-acme", "alternative to Acme"]])));
    const on = await webSearchDetailed('site:reddit.com "alternative to Acme"', { providers: [bingHtmlProvider()] });
    expect(on.results.map((x) => x.url)).toEqual(["https://www.reddit.com/r/sales/comments/1abc/alternative_to_acme/"]);
    expect(on.attempts[0].offSite).toBe(1);
    resetSearchCache();
    const plain = await webSearchDetailed('"alternative to Acme"', { providers: [bingHtmlProvider()] });
    expect(plain.results).toHaveLength(2);
    expect("offSite" in plain.attempts[0]).toBe(false);
  });

  it("the count rides on the results without being part of them", () => {
    const all = [r("https://www.reddit.com/r/a/comments/1/x/"), r("https://vendor.example/x"), r("https://vendor.example/y")];
    const kept = honorSiteOperator("site:reddit.com x", all);
    expect(kept).toEqual([all[0]]);
    expect(JSON.stringify(kept)).toBe(JSON.stringify([all[0]]));
    expect(Object.keys(kept)).toEqual(["0"]);
    expect(offSiteDiscarded(kept)).toBe(2);
    expect(offSiteDiscarded(all)).toBe(0);
    expect(offSiteDiscarded(honorSiteOperator("no operator here", all))).toBe(0);
  });
});
