import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQueryDetailed, runLeadPipelineDetailed } from "./pipeline.js";
import { resetSearchCache, NO_WEB_SEARCH_CONFIGURED } from "./search/index.js";
import { resetProviderSkips } from "./providers/health.js";
import type { AiProvider } from "./types.js";

const KEYS = ["APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY"];

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  for (const k of KEYS) vi.stubEnv(k, "");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a search where web search could not answer is not 'no leads match'", () => {
  it("pushes a web_search providerFailure when no search provider is configured", async () => {
    const r = await runLeadPipelineDetailed({ titles: ["CTO"], industries: ["fintech"], findEmails: false, limit: 5 });
    expect(r.leads).toEqual([]);
    expect(r.providerFailures).toContainEqual({ provider: "web_search", message: NO_WEB_SEARCH_CONFIGURED });
    expect(r.webSearch.searches).toBeGreaterThan(0);
    expect(r.webSearch.failed).toBe(r.webSearch.searches);
  });

  it("names the provider when the configured one fails", async () => {
    vi.stubEnv("SERPER_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })));
    const r = await runLeadPipelineDetailed({ titles: ["CTO"], industries: ["fintech"], findEmails: false, limit: 5 });
    const f = r.providerFailures.find((p) => p.provider === "web_search");
    expect(f?.message).toMatch(/Every web search provider failed.*serper/);
  });

  it("does not push one when a provider answered, even with nothing", async () => {
    vi.stubEnv("SERPER_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ organic: [] }), { status: 200 })));
    const r = await runLeadPipelineDetailed({ titles: ["CTO"], industries: ["fintech"], findEmails: false, limit: 5 });
    expect(r.providerFailures.find((p) => p.provider === "web_search")).toBeUndefined();
  });
});

describe("parseQuery when the AI is rate limited", () => {
  const limited: AiProvider = { name: "groq", model: "m", complete: async () => { throw new Error("groq 429: rate limit reached"); } };

  it("falls back to the keyword parser and says so", async () => {
    const r = await parseQueryDetailed(limited, { query: "CTO at fintech in Bangalore" });
    expect(r.query.titles).toEqual(["CTO"]);
    expect(r.note).toMatch(/AI query parsing failed \(groq 429/);
  });

  it("correctly identifies product and niche categories without setting them as job titles", async () => {
    const r = await parseQueryDetailed(undefined, { query: "rice meals in India" });
    // "rice meals" must NOT be a job title!
    expect(r.query.titles?.includes("rice meals")).toBe(false);
    // Should have assigned real decision maker roles
    expect(r.query.titles?.some((t) => ["Founder", "CEO", "Managing Director", "Owner"].includes(t))).toBe(true);
    // Should have recognized Food & Beverage / FMCG / Packaged Foods
    expect(r.query.industries?.some((i) => i.toLowerCase().includes("food") || i.toLowerCase().includes("fmcg"))).toBe(true);
    // Location extracted
    expect(r.query.locations).toContain("India");
    // Keywords include rice meals
    expect(r.query.keywords).toContain("rice meals");
  });
});
