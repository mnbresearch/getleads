import { afterEach, describe, expect, it } from "vitest";
import { resetSearchCache, webSearch, webSearchDetailed, type SearchProvider } from "./index.js";
import { honorSiteOperator } from "./providers.js";
import { ProviderUnavailableError } from "../providers/health.js";
import type { SearchResult } from "../types.js";

const r = (url: string, title = url): SearchResult => ({ url, title, snippet: "", provider: "stub" });

afterEach(() => resetSearchCache());

/**
 * The cardinal sin of this codebase, in the function every discovery path funnels through:
 * serving an outage back as "nobody matched that query".
 *
 * webSearch has a guard against caching that, and the guard used to be defeated by the very
 * thing it guarded against - it counts providers that THREW, and the providers returned []
 * on an HTTP failure rather than throwing. A 429 from every configured provider therefore
 * looked exactly like a query with no matches.
 */
describe("a search never re-serves an outage as an empty result", () => {
  it("does not cache a run in which every provider failed", async () => {
    let calls = 0;
    const failing: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async () => {
        calls++;
        throw new ProviderUnavailableError("stub", "rate_limit", "429 too many requests");
      },
    };

    expect(await webSearch("best crm", { providers: [failing] })).toEqual([]);
    expect(await webSearch("best crm", { providers: [failing] })).toEqual([]);
    // Asked again rather than replaying our bad minute.
    expect(calls).toBe(2);
  });

  it("recovers as soon as a provider works again", async () => {
    let fail = true;
    const flaky: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async () => {
        if (fail) throw new ProviderUnavailableError("stub", "server", "503");
        return [r("https://a.test"), r("https://b.test"), r("https://c.test")];
      },
    };

    expect(await webSearch("best crm", { providers: [flaky] })).toEqual([]);
    fail = false;
    expect(await webSearch("best crm", { providers: [flaky] })).toHaveLength(3);
  });

  it("does believe a provider that answered and genuinely had nothing", async () => {
    let calls = 0;
    const empty: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async () => {
        calls++;
        return [];
      },
    };

    await webSearch("nonsense query", { providers: [empty] });
    await webSearch("nonsense query", { providers: [empty] });
    // Briefly cached: this is what the cache is for, and it expires in five minutes.
    expect(calls).toBe(1);
  });

  it("does not believe an empty answer whose results were all thrown away for being off the site asked for", async () => {
    let calls = 0;
    // An engine that ignores `site:`: what it sends is from anywhere, and the provider discards it.
    const ignoresSite: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async (q) => {
        calls++;
        return honorSiteOperator(q, [r("https://vendor.example/alternative-to-acme"), r("https://other.example/acme")]);
      },
    };
    const query = 'site:reddit.com "alternative to Acme"';
    for (let i = 0; i < 2; i++) {
      const o = await webSearchDetailed(query, { providers: [ignoresSite] });
      expect(o.results).toEqual([]);
      // Both times the caller is told the site was never searched: the second is not a remembered "nobody".
      expect(o.cached).toBeUndefined();
      expect(o.attempts).toMatchObject([{ provider: "stub", ok: true, count: 0, offSite: 2 }]);
    }
    expect(calls).toBe(2);
    // The same engine asked without a site answers, and that answer is remembered as before.
    const plain: SearchProvider = { ...ignoresSite, search: async () => (calls++, []) };
    await webSearchDetailed('"alternative to Acme"', { providers: [plain] });
    expect((await webSearchDetailed('"alternative to Acme"', { providers: [plain] })).cached).toBe(true);
    expect(calls).toBe(3);
  });

  it("still remembers a site search that kept some results, and one that was honoured and found nothing", async () => {
    let calls = 0;
    const partly: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async (q) => (calls++, honorSiteOperator(q, [r("https://www.reddit.com/r/sales/comments/1/x/"), r("https://vendor.example/x")])),
    };
    expect((await webSearchDetailed("site:reddit.com acme", { providers: [partly], minResults: 1 })).results).toHaveLength(1);
    expect((await webSearchDetailed("site:reddit.com acme", { providers: [partly], minResults: 1 })).cached).toBe(true);
    const honoured: SearchProvider = { name: "stub", available: () => true, search: async (q) => (calls++, honorSiteOperator(q, [])) };
    await webSearchDetailed("site:reddit.com nothing", { providers: [honoured] });
    expect((await webSearchDetailed("site:reddit.com nothing", { providers: [honoured] })).cached).toBe(true);
    expect(calls).toBe(2);
  });

  it("caches a real answer and does not ask twice", async () => {
    let calls = 0;
    const good: SearchProvider = {
      name: "stub",
      available: () => true,
      search: async () => {
        calls++;
        return [r("https://a.test"), r("https://b.test"), r("https://c.test")];
      },
    };
    expect(await webSearch("best crm", { providers: [good] })).toHaveLength(3);
    expect(await webSearch("best crm", { providers: [good] })).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it("falls through to a working provider and keeps its answer", async () => {
    const dead: SearchProvider = { name: "dead", available: () => true, search: async () => { throw new ProviderUnavailableError("dead", "auth", "401"); } };
    const live: SearchProvider = { name: "live", available: () => true, search: async () => [r("https://a.test"), r("https://b.test"), r("https://c.test")] };
    expect(await webSearch("best crm", { providers: [dead, live] })).toHaveLength(3);
  });

  it("does not cache when nothing was even eligible to run", async () => {
    let calls = 0;
    const unavailable: SearchProvider = { name: "off", available: () => false, search: async () => { calls++; return []; } };
    await webSearch("best crm", { providers: [unavailable] });
    const live: SearchProvider = { name: "live", available: () => true, search: async () => [r("https://a.test")] };
    // The earlier no-providers run must not have poisoned this key.
    expect(await webSearch("best crm", { providers: [live] })).toHaveLength(1);
    expect(calls).toBe(0);
  });
});
