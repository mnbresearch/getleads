import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAllBalances } from "./balances.js";

/**
 * Balances are read from each provider's own account endpoint, for free. The rules pinned
 * here: a missing endpoint is never a zero, a rejected key is never a balance, and the key
 * never appears in what is returned.
 */

const KEYS = ["HUNTER_API_KEY", "REOON_API_KEY", "MILLIONVERIFIER_API_KEY", "SERPAPI_KEY", "APOLLO_API_KEY", "IPINFO_TOKEN", "SERPER_API_KEY", "BRAVE_SEARCH_API_KEY", "PDL_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "RESEND_API_KEY", "GOOGLE_CSE_API_KEY"];
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function stub(route: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const body = route(String(u));
      return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("provider balances", () => {
  it("reads Hunter's remaining allowance, deriving it when only used/available are given", async () => {
    setEnv({ HUNTER_API_KEY: "hk_secret_value" });
    stub((u) =>
      u.includes("hunter.io/v2/account")
        ? { data: { reset_date: "2026-10-01", requests: { searches: { used: 40, available: 500 }, verifications: { used: 10, available: 1000 } } } }
        : undefined,
    );
    const all = await checkAllBalances();
    const h = all.find((b) => b.provider === "hunter")!;
    expect(h.status).toBe("ok");
    expect(h.lines.find((l) => l.label === "searches")!.remaining).toBe(460);
    expect(h.resetsAt).toBe("2026-10-01");
    expect(JSON.stringify(all)).not.toContain("hk_secret_value");
  });

  it("treats MillionVerifier's 200-with-error as a failed read, not a balance", async () => {
    setEnv({ MILLIONVERIFIER_API_KEY: "mv" });
    stub((u) => (u.includes("millionverifier.com") ? { error: "Invalid API key" } : undefined));
    const mv = (await checkAllBalances()).find((b) => b.provider === "millionverifier")!;
    expect(mv.status).toBe("error");
    expect(mv.lines).toHaveLength(0);
  });

  it("flags a low balance", async () => {
    setEnv({ REOON_API_KEY: "r" });
    stub((u) => (u.includes("reoon.com") ? { status: "success", remaining_instant_credits: 120, remaining_daily_credits: 20 } : undefined));
    const r = (await checkAllBalances()).find((b) => b.provider === "reoon")!;
    expect(r.status).toBe("ok");
    expect(r.low).toBe(true);
  });

  it("says a provider has no balance API instead of reporting zero, and says when it is not set up", async () => {
    setEnv({ SERPER_API_KEY: "s" });
    stub(() => undefined);
    const all = await checkAllBalances();
    const serper = all.find((b) => b.provider === "serper")!;
    expect(serper.status).toBe("no_endpoint");
    expect(serper.lines).toHaveLength(0);
    expect(serper.summary).toMatch(/no balance API/);
    expect(all.find((b) => b.provider === "hunter")!.status).toBe("not_configured");
  });
});
