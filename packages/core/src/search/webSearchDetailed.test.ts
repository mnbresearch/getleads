import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchCache, serperProvider, summarizeWebSearchFailures, webSearchDetailed, isNoWebSearchConfigured, NO_WEB_SEARCH_CONFIGURED, NO_WEB_SEARCH_CONFIGURED_OPERATOR, type SearchProvider } from "./index.js";
import { ProviderUnavailableError, reportProviderCall, resetProviderSkips } from "../providers/health.js";
import { findPeopleDetailed } from "../discovery/people.js";

/**
 * A search where every provider failed must say so. webSearch returns [] for both "nobody
 * matched" and "nothing could answer"; webSearchDetailed is what lets the pipeline tell them
 * apart and stop finishing such a search as done/0/error:null.
 */
const failing = (name: string, outcome: "rate_limit" | "server" | "out_of_credit" = "server"): SearchProvider => ({
  name,
  available: () => true,
  search: async () => {
    throw new ProviderUnavailableError(name, outcome, `${name} said no (${outcome})`);
  },
});

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webSearchDetailed", () => {
  it("reports every provider failing, with each provider's reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = await webSearchDetailed("head of growth fintech", { providers: [failing("serper", "rate_limit"), failing("brave")] });
    expect(o.results).toEqual([]);
    expect(o.everyProviderFailed).toBe(true);
    expect(o.nothingConfigured).toBe(false);
    expect(o.attempts.map((a) => [a.provider, a.ok, a.outcome])).toEqual([
      ["serper", false, "rate_limit"],
      ["brave", false, "server"],
    ]);
    expect(o.attempts[0].error).toMatch(/serper said no/);
    expect(summarizeWebSearchFailures([o])).toMatch(/Every web search provider failed across 1 search: serper: .*; brave: /);
  });

  it("is not a failure when one provider answered with nothing", async () => {
    const empty: SearchProvider = { name: "serper", available: () => true, search: async () => [] };
    const o = await webSearchDetailed("zzzz no match", { providers: [failing("google_cse"), empty] });
    expect(o.everyProviderFailed).toBe(false);
    expect(summarizeWebSearchFailures([o])).toBeNull();
  });

  it("says nothing is configured when only the keyless scrapers exist", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = await webSearchDetailed("q", { providers: [failing("duckduckgo"), failing("bing_html")] });
    expect(o.nothingConfigured).toBe(true);
    expect(summarizeWebSearchFailures([o])).toContain(NO_WEB_SEARCH_CONFIGURED);
  });

  it("what a customer is told about it names no server setting; the operator's version goes to the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = await webSearchDetailed("q2", { providers: [failing("duckduckgo"), failing("bing_html")] });
    const said = summarizeWebSearchFailures([o])!;
    // Exactly the customer sentence: no env var names, no provider error text appended.
    expect(said).toBe(NO_WEB_SEARCH_CONFIGURED);
    expect(said).not.toMatch(/_API_KEY|SMTP_|\.env\b|duckduckgo|bing/i);
    expect(said).toMatch(/not a result about your market/);
    expect(isNoWebSearchConfigured(said)).toBe(true);
    expect(isNoWebSearchConfigured("Every web search provider failed across 1 search: serper: HTTP 402")).toBe(false);
    // The settings to change are still findable - by whoever reads the server log.
    expect(NO_WEB_SEARCH_CONFIGURED_OPERATOR).toMatch(/SERPER_API_KEY or BRAVE_SEARCH_API_KEY/);
    void warn;
  });

  it("records a cooling-off provider as skipped instead of calling it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reportProviderCall({ provider: "serper", outcome: "rate_limit", status: 429 });
    let called = 0;
    const serper: SearchProvider = { name: "serper", available: () => true, search: async () => (called++, []) };
    const o = await webSearchDetailed("q", { providers: [serper] });
    expect(called).toBe(0);
    expect(o.attempts[0]).toMatchObject({ provider: "serper", ok: false, outcome: "skipped" });
    expect(o.everyProviderFailed).toBe(true);
  });

  it("surfaces a real 402 from Serper as out_of_credit (mocked fetch)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not enough credits" }), { status: 402 })));
    const o = await webSearchDetailed("q", { providers: [serperProvider("key")] });
    expect(o.everyProviderFailed).toBe(true);
    expect(o.attempts[0].outcome).toBe("out_of_credit");
  });

  it("threads outcomes through findPeopleDetailed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await findPeopleDetailed({ titles: ["CTO"], limit: 5 }, { providers: [failing("serper")] });
    expect(r.people).toEqual([]);
    expect(r.everySearchFailed).toBe(true);
    expect(r.failedSearches).toBe(r.searches.length);
    expect(r.failureMessage).toMatch(/serper/);
  });
});

/**
 * The search text is what a customer typed (a person's name, "@theirdomain.com"), and a
 * provider's error can echo it. Neither goes to the log unless an operator asked for it.
 */
describe("the search log does not carry the search text", () => {
  const QUERY = '"Priya Raman" "@zz-customer-domain.example" head of growth';
  const echoing = (name: string): SearchProvider => ({
    name,
    available: () => true,
    search: async (q: string) => {
      throw new ProviderUnavailableError(name, "unsupported_query", `400 Query not allowed: ${q}`);
    },
  });
  const answering = (name: string): SearchProvider => ({ name, available: () => true, search: async () => [{ title: "t", url: "https://example.com/a", snippet: "s" }] });
  const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

  afterEach(() => {
    delete process.env.DEBUG_SEARCH;
  });

  it("by default: the length of the text, the providers and what each did - no text, no provider message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const o = await webSearchDetailed(QUERY, { providers: [echoing("serper"), failing("brave", "rate_limit")] });
    expect(o.everyProviderFailed).toBe(true);
    const out = `${logged(warn)}\n${logged(log)}`;
    expect(out).toContain(`[search] no results for a ${QUERY.length}-character query`);
    expect(out).toContain("serper=unsupported_query");
    expect(out).toContain("brave=rate_limit");
    for (const piece of ["Priya", "Raman", "zz-customer-domain", "head of growth", "Query not allowed"]) expect(out, piece).not.toContain(piece);
    // The caller still gets each provider's own words (they go to the search's error, not the log).
    expect(o.attempts[0].error).toContain("Query not allowed");
  });

  it("a search that found something logs nothing at all by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const o = await webSearchDetailed(QUERY, { providers: [answering("serper")] });
    expect(o.results).toHaveLength(1);
    expect(`${logged(warn)}${logged(log)}`).toBe("");
  });

  it("DEBUG_SEARCH=true puts the text and the details back; any other value does not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DEBUG_SEARCH = "true";
    await webSearchDetailed(QUERY, { providers: [echoing("serper")] });
    expect(logged(warn)).toContain("Priya Raman");
    expect(logged(warn)).toContain("Query not allowed");
    warn.mockClear();
    resetSearchCache();
    resetProviderSkips();
    for (const off of ["false", "0", "no", ""]) {
      process.env.DEBUG_SEARCH = off;
      resetSearchCache();
      resetProviderSkips();
      await webSearchDetailed(QUERY, { providers: [echoing("serper")] });
    }
    expect(logged(warn)).not.toContain("Priya");
    expect(logged(warn)).toContain("-character query");
  });
});
