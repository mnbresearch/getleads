import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEmail } from "./find.js";
import { candidatesFor } from "./pattern.js";
import { resetMxCache, setMxResolver, verifyEmail } from "./verify.js";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";

type Route = (url: string) => { status?: number; body: unknown } | undefined;
function stubFetch(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = route(url);
      if (!r) return new Response("not stubbed", { status: 599 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const emailIn = (u: string) => decodeURIComponent(new URL(u).searchParams.get("email") ?? "");

const KEYS = ["GOOGLE_CSE_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY"];
beforeEach(() => {
  resetMxCache();
  resetProviderSkips();
  resetSearchCache();
  for (const k of KEYS) vi.stubEnv(k, "");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setMxResolver({ resolveMx: async () => [{ exchange: "mx.acme.example", priority: 10 }], resolve4: async () => ["203.0.113.5"] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setMxResolver(null);
});

const person = { firstName: "Jane", lastName: "Doe", domain: "acme.example" };

describe("findEmail with SMTP disabled uses the configured verifier", () => {
  it("asks Reoon about the top candidates and returns the first it calls safe", async () => {
    const list = candidatesFor("Jane", "Doe", "acme.example", null);
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { body: { status: emailIn(u) === list[1] ? "safe" : "invalid", overall_score: 96 } } : undefined));
    const r = await findEmail(person, { smtp: false, reoonApiKey: "r" });
    expect(r.email).toBe(list[1]);
    expect(r.status).toBe("valid");
    expect(r.verifiedBy).toBe("reoon:safe");
    expect(calls.filter((c) => c.includes("reoon.com"))).toHaveLength(2);
  });

  it("returns catch_all as catch_all, not valid, and stops spending", async () => {
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { body: { status: "catch_all" } } : undefined));
    const r = await findEmail(person, { smtp: false, reoonApiKey: "r" });
    expect(r.status).toBe("catch_all");
    expect(r.verifiedBy).toBe("reoon:catch_all");
    expect(calls.filter((c) => c.includes("reoon.com"))).toHaveLength(1);
  });

  it("checks at most maxVerifierChecks candidates", async () => {
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { body: { status: "invalid" } } : undefined));
    const r = await findEmail(person, { smtp: false, reoonApiKey: "r", maxVerifierChecks: 3 });
    expect(calls.filter((c) => c.includes("reoon.com"))).toHaveLength(3);
    // Nothing verified: the best unchecked candidate comes back as a guess, never as valid.
    expect(r.status).toBe("risky");
    expect(r.verifiedBy).toBeUndefined();
  });

  it("skips excluded addresses, case-insensitively, without spending a check on them", async () => {
    const list = candidatesFor("Jane", "Doe", "acme.example", null);
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { body: { status: "safe" } } : undefined));
    const r = await findEmail(person, { smtp: false, reoonApiKey: "r", exclude: [list[0].toUpperCase()] });
    expect(r.email).toBe(list[1]);
    expect(calls.some((c) => emailIn(c) === list[0])).toBe(false);
  });

  it("stops after a verifier that gives no verdict, and falls back to a guess", async () => {
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { status: 402, body: { status: "error", reason: "no credits" } } : undefined));
    const r = await findEmail(person, { smtp: false, reoonApiKey: "r" });
    expect(calls.filter((c) => c.includes("reoon.com"))).toHaveLength(1);
    expect(r.status).toBe("risky");
  });

  it("still guesses without calling anything when no verifier is configured", async () => {
    const calls = stubFetch(() => undefined);
    const r = await findEmail(person, { smtp: false });
    expect(calls).toHaveLength(0);
    expect(r.status).toBe("risky");
  });
});

describe("Hunter email-finder results are not called valid on score alone", () => {
  const hunter = (verification: string | null, score = 95) => (u: string) =>
    u.includes("hunter.io/v2/email-finder") ? { body: { data: { email: "Jane.Doe@acme.example", score, verification: { status: verification } } } } : undefined;

  it("labels an unverified high-score guess risky", async () => {
    stubFetch(hunter(null));
    const r = await findEmail(person, { smtp: false, hunterApiKey: "h" });
    expect(r.email).toBe("jane.doe@acme.example");
    expect(r.status).toBe("risky");
    expect(r.verifiedBy).toBeUndefined();
  });

  it("keeps Hunter's own verified verdict", async () => {
    stubFetch(hunter("valid"));
    const r = await findEmail(person, { smtp: false, hunterApiKey: "h" });
    expect(r.status).toBe("valid");
    expect(r.verifiedBy).toBe("hunter:valid");
  });

  it("lets a configured PAYG verifier decide before anything is called valid", async () => {
    const route = hunter(null);
    stubFetch((u) => route(u) ?? (u.includes("reoon.com") ? { body: { status: "safe", overall_score: 90 } } : undefined));
    const r = await findEmail(person, { smtp: false, hunterApiKey: "h", reoonApiKey: "r" });
    expect(r.status).toBe("valid");
    expect(r.verifiedBy).toBe("reoon:safe");
  });

  it("moves past a Hunter address the verifier rejects", async () => {
    const route = hunter("valid");
    stubFetch((u) => route(u) ?? (u.includes("reoon.com") ? { body: { status: emailIn(u) === "jane.doe@acme.example" ? "invalid" : "safe" } } : undefined));
    const r = await findEmail(person, { smtp: false, hunterApiKey: "h", reoonApiKey: "r" });
    expect(r.email).not.toBe("jane.doe@acme.example");
    expect(r.candidates[0]).toMatchObject({ email: "jane.doe@acme.example", status: "invalid" });
  });
});

describe("verify chain falls through on 'unknown'", () => {
  it("asks Abstract after Hunter says unknown", async () => {
    stubFetch((u) =>
      u.includes("hunter.io") ? { body: { data: { status: "unknown", score: 40 } } } : u.includes("abstractapi.com") ? { body: { deliverability: "DELIVERABLE", is_catchall_email: { value: false }, quality_score: "0.9" } } : undefined,
    );
    const v = await verifyEmail("jane@acme.example", { smtp: false, hunterApiKey: "h", abstractApiKey: "a" });
    expect(v.status).toBe("valid");
    expect(v.verifiedBy).toBe("abstract:DELIVERABLE");
    expect(v.verifierAttempts).toEqual([{ verifier: "hunter", result: "no verdict (unknown)" }]);
  });

  it("does not stop at Abstract's UNKNOWN, and records both declines", async () => {
    stubFetch((u) => (u.includes("hunter.io") ? { body: { data: { status: "unknown", score: 40 } } } : u.includes("abstractapi.com") ? { body: { deliverability: "UNKNOWN" } } : undefined));
    const v = await verifyEmail("jane@acme.example", { smtp: false, hunterApiKey: "h", abstractApiKey: "a" });
    expect(v.verifiedBy).toBe("mx-only");
    expect(v.verifierAttempts?.map((a) => a.verifier)).toEqual(["hunter", "abstract"]);
  });

  it("always says what produced the verdict", async () => {
    expect((await verifyEmail("not an email")).verifiedBy).toBe("syntax");
    stubFetch((u) => (u.includes("reoon.com") ? { body: { status: "safe" } } : undefined));
    expect((await verifyEmail("jane@acme.example", { smtp: false, reoonApiKey: "r" })).verifiedBy).toBe("reoon:safe");
  });
});
