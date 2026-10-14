/**
 * B1 fix round: discovery honesty and data quality in core.
 *  - an empty run from the keyless fallback scrapers alone is "no source could search", never "nobody matched";
 *  - a blocked SMTP probe is not a check;
 *  - "asking in public" keeps to its posted-within window and to the category's own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLeadPipelineDetailed } from "./pipeline.js";
import { NO_SEARCH_ANSWERED, NO_WEB_SEARCH_CONFIGURED, emptySearchNote, onlyFallbackSearch, resetSearchCache, webSearchDetailed, type SearchProvider, type WebSearchOutcome } from "./search/index.js";
import { findPeopleDetailed } from "./discovery/people.js";
import { findCompaniesDetailed } from "./discovery/companies.js";
import { resetProviderSkips } from "./providers/health.js";
import { findPeopleForFinding } from "./plays/people.js";
import { DEFAULT_ASK_DAYS, findPublicAsks } from "./plays/publicAsks.js";
import { isUncheckedSmtp } from "./email/verify.js";
import type { PlayFinding } from "./plays/types.js";
import type { SearchResult } from "./types.js";

const KEYS = ["APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY"];

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  for (const k of KEYS) vi.stubEnv(k, "");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.stubEnv("PLAYS_HOST_PAUSE_MS", "0");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A provider that answers every search with `rows` (an empty page by default). */
const answering = (name: string, rows: (q: string) => SearchResult[] = () => []): SearchProvider => ({ name, available: () => true, search: async (q) => rows(q) });
const failing = (name: string): SearchProvider => ({ name, available: () => true, search: async () => { throw new Error(`${name} is down`); } });

const outcome = (o: Partial<WebSearchOutcome>): WebSearchOutcome => ({ results: [], attempts: [], everyProviderFailed: false, nothingConfigured: false, ...o });

describe("emptySearchNote", () => {
  it("says no source is connected when only the keyless fallbacks answered, and found nothing", () => {
    expect(onlyFallbackSearch([outcome({ nothingConfigured: true })])).toBe(true);
    expect(emptySearchNote([outcome({ nothingConfigured: true }), outcome({ nothingConfigured: true, everyProviderFailed: true })], 0)).toBe(NO_WEB_SEARCH_CONFIGURED);
  });
  it("says none answered when a keyed source is connected but every search failed", () => {
    expect(emptySearchNote([outcome({ everyProviderFailed: true }), outcome({ everyProviderFailed: true })], 0)).toBe(NO_SEARCH_ANSWERED);
  });
  it("says nothing when a keyed source answered, when something was found, or when nothing ran", () => {
    expect(emptySearchNote([outcome({}), outcome({ everyProviderFailed: true })], 0)).toBeNull();
    expect(emptySearchNote([outcome({ nothingConfigured: true })], 3)).toBeNull();
    expect(emptySearchNote([], 0)).toBeNull();
  });
});

describe("discovery helpers carry the note", () => {
  it("findPeopleDetailed and findCompaniesDetailed, keyless only and empty", async () => {
    const providers = [answering("bing_html")];
    const p = await findPeopleDetailed({ companyName: "Acme", titles: ["CEO"] }, { providers });
    expect(p.people).toEqual([]);
    expect(p.emptyNote).toBe(NO_WEB_SEARCH_CONFIGURED);
    const c = await findCompaniesDetailed({ query: "logistics" }, { providers });
    expect(c.companies).toEqual([]);
    expect(c.emptyNote).toBe(NO_WEB_SEARCH_CONFIGURED);
  });
  it("no note when a keyed source answered with nobody", async () => {
    const p = await findPeopleDetailed({ companyName: "Acme", titles: ["CEO"] }, { providers: [answering("serper")] });
    expect(p.emptyNote).toBeNull();
  });
  it("keyed source down: the note says none answered", async () => {
    const p = await findPeopleDetailed({ companyName: "Acme", titles: ["CEO"] }, { providers: [failing("serper")] });
    expect(p.emptyNote).toBe(NO_SEARCH_ANSWERED);
  });
});

describe("the pipeline: a keyless scraper's empty page is not an empty market", () => {
  it("adds a web_search failure when bing_html answered with an empty page and nothing else is connected", async () => {
    vi.stubEnv("BING_HTML_DISABLED", "false");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><ol id=b_results></ol></body></html>", { status: 200, headers: { "content-type": "text/html" } })));
    const probe = await webSearchDetailed("probe query");
    expect(probe.everyProviderFailed).toBe(false);
    expect(probe.nothingConfigured).toBe(true);
    resetSearchCache();
    const r = await runLeadPipelineDetailed({ titles: ["CTO"], industries: ["fintech"], findEmails: false, limit: 5 });
    expect(r.leads).toEqual([]);
    expect(r.providerFailures).toContainEqual({ provider: "web_search", message: NO_WEB_SEARCH_CONFIGURED });
  });
  it("adds none when a keyed source answered with nothing (a real empty result)", async () => {
    vi.stubEnv("SERPER_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    const r = await runLeadPipelineDetailed({ titles: ["CTO"], industries: ["fintech"], findEmails: false, limit: 5 });
    expect(r.providerFailures.find((p) => p.provider === "web_search")).toBeUndefined();
  });
});

describe("plays 'find people': nobody found only when a source really searched", () => {
  const company: PlayFinding = { kind: "company", companyName: "Acme Logistics", companyDomain: "acmelogistics.example", relevantBecause: "x", signalType: "x", confidence: 0.8 } as PlayFinding;
  it("keyless only, empty: blocked with the plays' sentence, not 'No one matching'", async () => {
    const { people, trace } = await findPeopleForFinding(company, { titles: ["CEO"] }, { searchOpts: { providers: [answering("bing_html")] } });
    expect(people).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("No search source is connected on our side, so this run could not search. This is not a result about your market.");
    expect(trace.notes.some((n) => /No one matching/.test(n))).toBe(false);
  });
  it("a keyed source that answered empty: a real 'nobody'", async () => {
    const { trace } = await findPeopleForFinding(company, { titles: ["CEO"] }, { searchOpts: { providers: [answering("serper")] } });
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("No one matching those job titles was found at Acme Logistics.");
  });
});

describe("a blocked SMTP probe is not a check", () => {
  it("names the markers", () => {
    expect(isUncheckedSmtp("smtp-blocked")).toBe(true);
    expect(isUncheckedSmtp("smtp-error")).toBe(true);
    expect(isUncheckedSmtp("smtp")).toBe(false);
    expect(isUncheckedSmtp(undefined)).toBe(false);
  });
});

describe("asking in public: the window and the category's words", () => {
  const NOW = Date.now();
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
  /** Serve the Hacker News search and item APIs from memory; nothing else is reachable. */
  const serveHn = (hits: unknown[], items: Record<string, unknown> = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://hn.algolia.com/api/v1/search_by_date?")) return new Response(JSON.stringify({ hits }), { status: 200, headers: { "content-type": "application/json" } });
        const m = /^https:\/\/hn\.algolia\.com\/api\/v1\/items\/(\d+)$/.exec(url);
        if (m && items[m[1]]) return new Response(JSON.stringify(items[m[1]]), { status: 200, headers: { "content-type": "application/json" } });
        return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
      }),
    );
  const story = (id: number, title: string, text: string, daysAgo: number) => ({ objectID: String(id), title, story_text: text, created_at: iso(daysAgo), created_at_i: Math.floor((NOW - daysAgo * 86_400_000) / 1000), author: `u${id}`, _tags: ["story", "ask_hn"] });

  it("with no window set, the 30-day default applies: a six-year-old Ask HN is left out", async () => {
    expect(DEFAULT_ASK_DAYS).toBe(30);
    serveHn([
      story(22841667, "Ask HN: Recommendations for an order management software?", "Can someone recommend a good order management software tool for our shop?", 6 * 365),
      story(46100001, "Ask HN: Recommendations for an order management software?", "We need an order management software. Which tool would you recommend?", 5),
    ]);
    const r = await findPublicAsks({ category: "order management software", sources: ["hackernews"] }, { searchOpts: { providers: [answering("serper")] } });
    const ids = r.findings.map((f) => f.evidenceUrl);
    expect(ids).toContain("https://news.ycombinator.com/item?id=46100001");
    expect(ids).not.toContain("https://news.ycombinator.com/item?id=22841667");
  });

  it("an undated Hacker News thread from web search is dated by the item API and kept out when older than the window", async () => {
    serveHn([], { "22841667": { created_at: iso(6 * 365) } });
    const web = answering("serper", (q) => (q.includes("ycombinator") || !q.startsWith("site:") ? [{ title: "Ask HN: Anyone recommend an order management software?", url: "https://news.ycombinator.com/item?id=22841667", snippet: "Can anyone recommend an order management software for a small shop?", provider: "serper" }] : []));
    const r = await findPublicAsks({ category: "order management software", sources: ["hackernews"], days: 30 }, { searchOpts: { providers: [web] } });
    expect(r.findings.map((f) => f.evidenceUrl)).not.toContain("https://news.ycombinator.com/item?id=22841667");
    expect(r.trace.notes).toContain("1 conversation older than 30 days was left out.");
  });

  it("the category's key words must be there, as the phrase: a photo-management thread is not about order management", async () => {
    serveHn([
      story(49000001, "Ask HN: Recommendations for a Photo Management Tool?", "Can someone recommend a good software tool to automate the task of photo management, in order to save time?", 3),
      story(49000002, "Ask HN: Which order management system do you use?", "Looking for order management software recommendations for our D2C brand.", 3),
    ]);
    const r = await findPublicAsks({ category: "order management software", problems: ["automate order management"], sources: ["hackernews"] }, { searchOpts: { providers: [answering("serper")] } });
    const ids = r.findings.map((f) => f.evidenceUrl);
    expect(ids).not.toContain("https://news.ycombinator.com/item?id=49000001");
    expect(ids).toContain("https://news.ycombinator.com/item?id=49000002");
  });
});
