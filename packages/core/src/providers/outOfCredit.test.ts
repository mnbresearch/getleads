import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHttp, isActionable, providerCoolOff, providerRecentlyRejected, RATE_LIMIT_COOL_MS, reportProviderCall, resetProviderSkips } from "./health.js";
import { checkHunter, checkReoon, checkSerpApi, PROVIDER_CHECKS } from "./check.js";

beforeEach(() => resetProviderSkips());
afterEach(() => vi.unstubAllGlobals());

describe("out-of-credit is its own, actionable outcome", () => {
  it("classifies 402 as out_of_credit, not bad_response", () => {
    expect(classifyHttp(402, "").outcome).toBe("out_of_credit");
    expect(isActionable("out_of_credit")).toBe(true);
  });

  it("reads the body when providers use other codes for it", () => {
    expect(classifyHttp(429, JSON.stringify({ error: "Your account has run out of searches." })).outcome).toBe("out_of_credit");
    expect(classifyHttp(400, JSON.stringify({ message: "Not enough credits" })).outcome).toBe("out_of_credit");
    // A plain 429 is still a rate limit.
    expect(classifyHttp(429, JSON.stringify({ error: "Too many requests" })).outcome).toBe("rate_limit");
  });

  it("cools a provider off briefly after a 429 and for longer when out of credit", () => {
    const now = Date.now();
    reportProviderCall({ provider: "serper", outcome: "rate_limit", status: 429 });
    expect(providerRecentlyRejected("serper", now)).toBe(true);
    expect(providerCoolOff("serper", now)?.outcome).toBe("rate_limit");
    expect(providerRecentlyRejected("serper", now + RATE_LIMIT_COOL_MS + 1000)).toBe(false);

    reportProviderCall({ provider: "brave", outcome: "out_of_credit", status: 402 });
    expect(providerRecentlyRejected("brave", Date.now() + RATE_LIMIT_COOL_MS + 1000)).toBe(true);
    // A later 429 does not shorten the longer window.
    reportProviderCall({ provider: "brave", outcome: "rate_limit", status: 429 });
    expect(providerCoolOff("brave")?.outcome).toBe("out_of_credit");
  });
});

describe("provider checks", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("checkReoon reads the body: a 200 with status error is a rejected key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: "error", reason: "Invalid API key" })));
    const r = await checkReoon("bad");
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("auth");
  });

  it("checkReoon passes a working key and flags an empty balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: "success", remaining_daily_credits: 10, remaining_instant_credits: 0 })));
    expect((await checkReoon("k")).ok).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: "success", remaining_daily_credits: 0, remaining_instant_credits: 0 })));
    expect((await checkReoon("k")).outcome).toBe("out_of_credit");
  });

  it("SerpAPI and Hunter checks use the free account endpoints", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => (urls.push(String(u)), json({ total_searches_left: 50, data: { requests: { credits: { used: 1, available: 50 } } } }))));
    expect((await checkSerpApi("k")).ok).toBe(true);
    expect((await checkHunter("k")).ok).toBe(true);
    expect(urls[0]).toMatch(/^https:\/\/serpapi\.com\/account\.json\?/);
    expect(urls[1]).toMatch(/^https:\/\/api\.hunter\.io\/v2\/account\?/);
  });

  it("lists Brave", () => {
    expect(PROVIDER_CHECKS.map((c) => c.provider)).toContain("brave");
  });
});
