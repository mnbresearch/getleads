import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMxCache, setMxResolver, verifyEmail } from "./verify.js";

/**
 * The pay-as-you-go verifiers.
 *
 * What matters is not the happy path but the failure paths. A verifier that has run out of
 * credits, rejected the key, or does not know, must hand over to the next verifier - never
 * report the address as bad. An "invalid" written off a billing problem suppresses a real
 * lead for good.
 */

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

describe("pay-as-you-go email verifiers", () => {
  beforeEach(() => {
    resetMxCache();
    setMxResolver({ resolveMx: async () => [{ exchange: "mx.target.example", priority: 10 }], resolve4: async () => ["203.0.113.5"] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMxResolver(null);
  });

  it("takes Reoon's verdict when it has one, and does not spend a Hunter credit", async () => {
    const calls = stubFetch((u) => (u.includes("reoon.com") ? { body: { status: "safe", overall_score: 97 } } : undefined));
    const v = await verifyEmail("jane@target.example", { smtp: false, reoonApiKey: "r", hunterApiKey: "h" });
    expect(v.status).toBe("valid");
    expect(v.reason).toBe("reoon:safe");
    expect(calls.some((c) => c.includes("hunter.io"))).toBe(false);
  });

  it("maps Reoon's catch-all and role verdicts without calling them valid", async () => {
    stubFetch(() => ({ body: { status: "catch_all" } }));
    expect((await verifyEmail("a@target.example", { smtp: false, reoonApiKey: "r" })).status).toBe("catch_all");
    resetMxCache();
    stubFetch(() => ({ body: { status: "role_account" } }));
    expect((await verifyEmail("sales@target.example", { smtp: false, reoonApiKey: "r" })).status).toBe("risky");
  });

  it("falls through to MillionVerifier when Reoon does not know", async () => {
    stubFetch((u) =>
      u.includes("reoon.com") ? { body: { status: "unknown" } } : u.includes("millionverifier.com") ? { body: { result: "ok", role: false } } : undefined,
    );
    const v = await verifyEmail("jane@target.example", { smtp: false, reoonApiKey: "r", millionVerifierApiKey: "m" });
    expect(v.status).toBe("valid");
    expect(v.reason).toBe("millionverifier:ok");
  });

  it("does not read MillionVerifier's 200-with-an-error as a verdict on the address", async () => {
    // A bad key or an empty balance comes back as HTTP 200 with an `error` field.
    stubFetch((u) => (u.includes("millionverifier.com") ? { body: { error: "Insufficient credits", result: "" } } : undefined));
    const v = await verifyEmail("jane@target.example", { smtp: false, millionVerifierApiKey: "m" });
    expect(v.status).not.toBe("invalid");
    expect(v.reason).not.toMatch(/millionverifier/);
  });

  it("hands over to Hunter when the dedicated verifier is out of credits", async () => {
    stubFetch((u) => {
      if (u.includes("reoon.com")) return { status: 402, body: { status: "error", reason: "no credits" } };
      if (u.includes("hunter.io")) return { body: { data: { status: "valid", score: 91 } } };
      return undefined;
    });
    const v = await verifyEmail("jane@target.example", { smtp: false, reoonApiKey: "r", hunterApiKey: "h" });
    expect(v.status).toBe("valid");
    expect(v.reason).toBe("hunter:valid");
  });

  it("downgrades a role mailbox MillionVerifier accepts to risky", async () => {
    stubFetch(() => ({ body: { result: "ok", role: true } }));
    expect((await verifyEmail("info@target.example", { smtp: false, millionVerifierApiKey: "m" })).status).toBe("risky");
  });
});
