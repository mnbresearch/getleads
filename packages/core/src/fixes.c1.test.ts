/**
 * C1 fix round, in the search layer:
 *
 *  - a scraper's garbage answer (a `site:` search whose every result was off that site) is a
 *    provider failure, so "no source could search" applies to it;
 *  - with a keyed source connected but failing, a search answered only by a keyless
 *    fallback scraper is not a real answer either (`fallbackOnly`), is not cached, and an
 *    empty result built from such searches says so (emptySearchNote);
 *  - plays "find people" is blocked, not "nobody with those titles", in that case;
 *  - a Bing decoy page is a failure, and with a keyed source down the note still applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "./providers/health.js";
import { NO_SEARCH_ANSWERED, NO_WEB_SEARCH_CONFIGURED, emptySearchNote, resetSearchCache, searchCouldNotLook, summarizeWebSearchFailures, webSearchDetailed, type SearchProvider } from "./search/index.js";
import { bingHtmlProvider, honorSiteOperator } from "./search/providers.js";
import { findPeopleDetailed } from "./discovery/people.js";
import { findPeopleForFinding } from "./plays/people.js";
import { brokenSearch, searchWith } from "./plays/kit.test.js";
import type { SearchResult } from "./types.js";

const r = (url: string, title = "t", snippet = ""): SearchResult => ({ title, url, snippet, provider: "x" });

/** A keyless scraper (by name) that ignores `site:` and sends results from anywhere. */
const ignoresSite = (name = "bing_html"): SearchProvider => ({
  name,
  available: () => true,
  search: async (q) => honorSiteOperator(q, [r("https://vendor.example/acme", "Acme vendor page"), r("https://other.example/acme", "Acme elsewhere")]),
});
const emptyScraper = (name = "duckduckgo"): SearchProvider => ({ name, available: () => true, search: async () => [] });
const emptyKeyed = (name = "serper"): SearchProvider => ({ name, available: () => true, search: async () => [] });

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: unknown) => {
    throw new Error(`unexpected fetch of ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a garbage answer is a provider failure", () => {
  it("a site: search whose every result was off the site did not search: everyProviderFailed", async () => {
    const o = await webSearchDetailed('site:linkedin.com/in "Head of Sales" "Acme"', { providers: [ignoresSite()] });
    expect(o.results).toEqual([]);
    expect(o.attempts).toMatchObject([{ provider: "bing_html", ok: true, count: 0, offSite: 2 }]);
    expect(o.everyProviderFailed).toBe(true);
    // Nothing keyed is configured among these providers, so the customer sentence is "not connected".
    expect(emptySearchNote([o], 0)).toBe(NO_WEB_SEARCH_CONFIGURED);
  });

  it("with a keyed source connected (but down), the same garbage gives the 'none answered' sentence", async () => {
    const o = await webSearchDetailed('site:linkedin.com/in "Head of Sales" "Acme"', { providers: [brokenSearch("serper"), ignoresSite()] });
    expect(o.nothingConfigured).toBe(false);
    expect(o.everyProviderFailed).toBe(true);
    expect(emptySearchNote([o], 0)).toBe(NO_SEARCH_ANSWERED);
    // The operator's summary names the discarded answer instead of claiming nothing was eligible.
    expect(summarizeWebSearchFailures([o])).toMatch(/bing_html: ignored the site: operator/);
  });

  it("a site search that kept some results is still an answer", async () => {
    const partly: SearchProvider = { name: "bing_html", available: () => true, search: async (q) => honorSiteOperator(q, [r("https://www.linkedin.com/in/jane-doe", "Jane Doe - Head of Sales - Acme | LinkedIn"), r("https://vendor.example/x")]) };
    const o = await webSearchDetailed('site:linkedin.com/in "Head of Sales" "Acme"', { providers: [partly], minResults: 1 });
    expect(o.everyProviderFailed).toBe(false);
    expect(o.results).toHaveLength(1);
  });

  it("a Bing decoy page (results about the first word only) fails the provider; with the keyed source down the note applies", async () => {
    const decoy = `<html><body><ol>${["Best Buy - official site", "Best - definition", "Best Western hotels"].map((t, i) => `<li class="b_algo"><h2><a href="https://decoy${i}.example/">${t}</a></h2><div class="b_caption"><p>${t}</p></div></li>`).join("")}</ol></body></html>`;
    vi.stubGlobal("fetch", async () => new Response(decoy, { status: 200, headers: { "content-type": "text/html" } }));
    const o = await webSearchDetailed("best CRM for logistics startups", { providers: [brokenSearch("serper"), bingHtmlProvider()] });
    expect(o.attempts.find((a) => a.provider === "bing_html")).toMatchObject({ ok: false, outcome: "bad_response" });
    expect(o.everyProviderFailed).toBe(true);
    expect(emptySearchNote([o], 0)).toBe(NO_SEARCH_ANSWERED);
  });
});

describe("answered only by a keyless fallback while a keyed source is connected", () => {
  it("is flagged fallbackOnly, counts as could-not-look, and is not cached", async () => {
    let calls = 0;
    const ddg: SearchProvider = { name: "duckduckgo", available: () => true, search: async () => (calls++, []) };
    const o = await webSearchDetailed("head of sales acme logistics", { providers: [brokenSearch("serper"), ddg] });
    expect(o.everyProviderFailed).toBe(false);
    expect(o.fallbackOnly).toBe(true);
    expect(searchCouldNotLook(o)).toBe(true);
    expect(emptySearchNote([o], 0)).toBe(NO_SEARCH_ANSWERED);
    const again = await webSearchDetailed("head of sales acme logistics", { providers: [brokenSearch("serper"), ddg] });
    expect(again.cached).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("a keyed source answering empty is a real answer: no note, and it is cached briefly as before", async () => {
    const o = await webSearchDetailed("head of sales acme logistics", { providers: [emptyKeyed(), emptyScraper()] });
    expect(o.fallbackOnly).toBeUndefined();
    expect(searchCouldNotLook(o)).toBe(false);
    expect(emptySearchNote([o], 0)).toBeNull();
    expect((await webSearchDetailed("head of sales acme logistics", { providers: [emptyKeyed(), emptyScraper()] })).cached).toBe(true);
  });

  it("findPeopleDetailed carries the note; something found means no note", async () => {
    const none = await findPeopleDetailed({ companyName: "Acme", titles: ["CEO"] }, { providers: [brokenSearch("serper"), emptyScraper()] });
    expect(none.people).toEqual([]);
    expect(none.everySearchFailed).toBe(false);
    expect(none.emptyNote).toBe(NO_SEARCH_ANSWERED);
    const some = await findPeopleDetailed({ companyName: "Acme", titles: ["CEO"] }, { providers: [searchWith(() => [{ title: "Ann Lee - CEO - Acme | LinkedIn", url: "https://www.linkedin.com/in/ann-lee" }], "duckduckgo")] });
    expect(some.people).toHaveLength(1);
    expect(some.emptyNote).toBeNull();
  });
});

describe("plays find people uses the same rule", () => {
  const FINDING = { kind: "company" as const, companyName: "Globex", relevantBecause: "Raised a round.", evidenceUrl: "https://news.example/globex", evidenceTitle: "Globex raises", evidenceQuote: "Globex raises", signalType: "funding", confidence: 0.9 };

  it("the domain search answers (via the fallback) but the people search ignores the site: blocked, not 'nobody with those titles'", async () => {
    // The fallback scraper answers the company-website search with real-looking pages, so
    // the run is not "fallback found nothing" - but every LinkedIn search came back off-site.
    const scraper: SearchProvider = {
      name: "bing_html",
      available: () => true,
      search: async (q) => (/official website/.test(q) ? [r("https://www.globex.com/", "Globex - logistics software", "Globex builds logistics software.")] : honorSiteOperator(q, [r("https://vendor.example/globex-sales", "Globex sales team")])),
    };
    const { people, trace } = await findPeopleForFinding(FINDING as never, { titles: ["VP Sales"], limit: 3 }, { searchOpts: { providers: [brokenSearch("serper"), scraper] } });
    expect(people).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason ?? "").not.toMatch(/No one matching those job titles/);
    expect(trace.notes.join(" ")).not.toMatch(/No one matching those job titles/);
  });

  it("only the fallback answered (empty), keyed source down: blocked with the 'none answered' sentence", async () => {
    const scraper: SearchProvider = { name: "duckduckgo", available: () => true, search: async (q) => (/official website/.test(q) ? [r("https://www.globex.com/", "Globex - logistics software", "Globex builds logistics software.")] : []) };
    const { trace } = await findPeopleForFinding(FINDING as never, { titles: ["VP Sales"], limit: 3 }, { searchOpts: { providers: [brokenSearch("serper"), scraper] } });
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe(NO_SEARCH_ANSWERED);
  });

  it("a keyed source that answered and found nobody is still 'nobody' (not blocked)", async () => {
    const keyed = searchWith((q) => (/official website/.test(q) ? [{ title: "Globex - logistics software", url: "https://www.globex.com/", snippet: "Globex builds logistics software." }] : []), "serper");
    const { trace } = await findPeopleForFinding(FINDING as never, { titles: ["VP Sales"], limit: 3 }, { searchOpts: { providers: [keyed] } });
    expect(trace.blocked).toBe(false);
    expect(trace.notes.join(" ")).toMatch(/No one matching those job titles was found at Globex/);
  });
});
