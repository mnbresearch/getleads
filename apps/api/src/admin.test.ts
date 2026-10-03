/**
 * Admin API regressions (final fix round).
 *
 * Each test replays something the admin QA pass or the upgrade rehearsal demonstrated against
 * the running app - a plan called "toString", an override that switched a quota off, ten
 * parallel grants that landed as four, a search for "%" that listed every workspace - and
 * asserts that it no longer works. They go through the real app (createApp) and a real
 * database.
 *
 * Authentication here is the server-to-server header (x-admin-token) throughout. The admin
 * PASSWORD login, its lockout and admin sign-out are covered in security.auth.test.ts: the
 * admin login has one subject for the whole platform, and this file runs in parallel with
 * that one against the same database.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = `admin-${"b".repeat(40)}`;
const NOTIFY = "ops-notify@scout.test";

/** Every provider key "Test all keys" reads. Cleared so nothing in this file calls a real provider. */
const PROVIDER_KEYS = [
  "APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "RESEND_API_KEY", "REOON_API_KEY",
  "MILLIONVERIFIER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "IPINFO_TOKEN", "ABSTRACT_EMAIL_API_KEY", "WHATSAPP_ACCESS_TOKEN",
];

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "inline";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.LEAD_NOTIFY_EMAIL = NOTIFY;
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.DEFAULT_PLAN;
  delete process.env.TRUSTED_PROXY;
  delete process.env.SMTP_HOST;
  delete process.env.STRIPE_SECRET_KEY;
  for (const k of PROVIDER_KEYS) delete process.env[k];
}

/** Every email the app tries to send in this file, captured instead of sent; `fail` makes the next sends fail. */
const mocks = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string; replyTo?: string }[], fail: null as null | "result" | "throw" }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text: string; replyTo?: string }) => {
      if (mocks.fail === "throw") throw new Error("connect ECONNREFUSED 10.0.0.1:587");
      if (mocks.fail === "result") return { ok: false, provider: "none", error: "No email provider configured" };
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("admin API")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the regression tests for the admin dashboard's API (plans, overrides, credits, search, upgrade requests, key tests).\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("admin API", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  const realFetch = globalThis.fetch;

  const ADMIN = { "x-admin-token": ADMIN_TOKEN };
  const tag = randomUUID().slice(0, 8);

  /** A distinct client IP per call, so the per-IP rate limits never couple tests. */
  let ipSeq = 0;
  const ip = () => `198.19.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, body, ADMIN);

  type Acct = { token: string; orgId: string; userId: string; email: string; orgName: string; slug: string };
  async function signup(name: string, orgName = `${name} ${tag} Co`): Promise<Acct> {
    const email = `${name}-${randomUUID().slice(0, 8)}@adm-${tag}.example.com`.toLowerCase();
    const r = await req("POST", "/v1/auth/signup", { email, password: "correct-horse-battery", orgName });
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email, orgName, slug: r.body.org.slug };
  }
  const orgRow = async (orgId: string) => (await db.select().from(S.organizations).where(S.eq(S.organizations.id, orgId)))[0];
  const auditCount = async (orgId: string) => (await db.select({ id: S.auditLog.id }).from(S.auditLog).where(S.and(S.eq(S.auditLog.orgId, orgId), S.eq(S.auditLog.actorType, "admin")))).length;
  const used = async (orgId: string, metric: string) =>
    (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, orgId), S.eq(S.usage.period, S.currentPeriod()), S.eq(S.usage.metric, metric))))[0]?.count ?? 0;
  const setUsed = (orgId: string, metric: string, count: number) =>
    db
      .insert(S.usage)
      .values({ orgId, period: S.currentPeriod(), metric, count })
      .onConflictDoUpdate({ target: [S.usage.orgId, S.usage.period, S.usage.metric], set: { count } });

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 60_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  // ── 1. A plan id is one of the real plans, never an Object.prototype key ──
  describe("plan ids", () => {
    const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

    it("PATCH /v1/admin/orgs/:id/plan refuses prototype keys and unknown plans with a readable 400, and stores nothing", async () => {
      const u = await signup("proto");
      const before = await orgRow(u.orgId);
      const audits = await auditCount(u.orgId);
      for (const plan of [...PROTO_KEYS, "platinum", "", "FREE"]) {
        const r = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan });
        expect(r.status, `${plan}: ${r.text}`).toBe(400);
        expect(r.body.error.message).toMatch(/Unknown plan/);
        expect(r.body.error.message).toContain("free, pilot, starter, growth, scale, enterprise");
      }
      const after = await orgRow(u.orgId);
      expect(after.plan).toBe(before.plan);
      expect(after.planLimits).toEqual(before.planLimits);
      expect(await auditCount(u.orgId)).toBe(audits);
      // Every real plan is still accepted.
      for (const plan of S.PLAN_IDS) expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan })).status, plan).toBe(200);
    });

    it("POST /v1/upgrade-requests refuses a prototype key as the plan and stores nothing", async () => {
      mocks.sent.length = 0;
      const email = `proto-${randomUUID().slice(0, 8)}@adm-${tag}.example.com`;
      for (const planId of PROTO_KEYS) {
        const r = await req("POST", "/v1/upgrade-requests", { name: "Proto Test", email, mobile: "+91 99999 00000", country: "India", planId });
        expect(r.status, `${planId}: ${r.text}`).toBe(400);
        expect(r.body.error.message).toMatch(/Unknown plan/);
      }
      expect(await db.select().from(S.upgradeRequests).where(S.eq(S.upgradeRequests.email, email))).toHaveLength(0);
      // Nothing was emailed either (the old subject read "wants Object ($undefined/mo)").
      expect(mocks.sent.filter((m) => m.replyTo === email)).toHaveLength(0);
    });

    it("POST /v1/billing/checkout refuses a prototype key as the plan before it reaches Stripe", async () => {
      const u = await signup("checkout");
      const { env } = await import("./env.js");
      const saved = env.stripe.secretKey;
      env.stripe.secretKey = "sk_test_not_a_real_key";
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: any) => {
        calls.push(String(typeof input === "string" ? input : input?.url ?? input));
        throw new Error("no outbound calls in this test");
      });
      try {
        for (const plan of PROTO_KEYS) {
          const r = await req("POST", "/v1/billing/checkout", { plan }, { authorization: `Bearer ${u.token}` });
          expect(r.status, `${plan}: ${r.text}`).toBe(400);
          // Used to get as far as "Stripe price id not configured for plan "toString" (set STRIPE_PRICE_TOSTRING)".
          expect(r.body.error.message, plan).toMatch(/^Unknown plan/);
        }
        expect(calls).toEqual([]);
      } finally {
        env.stripe.secretKey = saved;
        vi.unstubAllGlobals();
      }
    });

    it("isPlanId / limitsFor: only own keys are plans; anything else reads as the free plan without throwing", () => {
      for (const k of PROTO_KEYS) expect(S.isPlanId(k), k).toBe(false);
      for (const junk of [undefined, null, 7, {}, [], "", "Free"]) expect(S.isPlanId(junk)).toBe(false);
      expect(S.PLAN_IDS).toEqual(["free", "pilot", "starter", "growth", "scale", "enterprise"]);
      for (const p of S.PLAN_IDS) expect(S.isPlanId(p)).toBe(true);
      for (const k of [...PROTO_KEYS, "platinum", undefined, null]) expect(S.limitsFor(k as any)).toEqual(S.PLANS.free.limits);
      expect(S.limitsFor("growth")).toEqual(S.PLANS.growth.limits);
    });

    it("a workspace that already holds an invalid plan keeps working, on the free plan's limits, and can be moved to a real plan", async () => {
      const u = await signup("badplan");
      await db.update(S.organizations).set({ plan: "toString", planLimits: {} }).where(S.eq(S.organizations.id, u.orgId));
      const auth = { authorization: `Bearer ${u.token}` };
      const usage = await req("GET", "/v1/usage", undefined, auth);
      expect(usage.status, usage.text).toBe(200);
      expect(usage.body.usage.leads.limit).toBe(S.PLANS.free.limits.leadsPerMonth);
      const me = await req("GET", "/v1/auth/me", undefined, auth);
      expect(me.status).toBe(200);
      expect(me.body.org.limits).toEqual(S.PLANS.free.limits);
      const detail = await admin("GET", `/orgs/${u.orgId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.org.limits).toEqual(S.PLANS.free.limits);
      expect(detail.body.overrides).toEqual({});
      const list = await admin("GET", `/orgs?q=${encodeURIComponent(u.slug)}`);
      expect(list.body.orgs.find((o: any) => o.id === u.orgId).limits).toEqual(S.PLANS.free.limits);
      // The free quota is enforced for it.
      await setUsed(u.orgId, "leads", S.PLANS.free.limits.leadsPerMonth);
      await expect(S.consume(db, u.orgId, "leads", 1)).rejects.toBeInstanceOf(S.QuotaExceededError);
      const fixed = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter" });
      expect(fixed.status, fixed.text).toBe(200);
      expect(fixed.body).toMatchObject({ plan: "starter", changed: true, overrides: {} });
      expect(fixed.body.limits).toEqual(S.PLANS.starter.limits);
    });
  });

  // ── 2. Overrides are a strict partial of the plan limits; junk never switches a quota off ──
  describe("plan overrides", () => {
    it("refuses junk overrides with a 400 that names the field, and stores nothing", async () => {
      const u = await signup("junk");
      const before = await orgRow(u.orgId);
      const audits = await auditCount(u.orgId);
      // The wording of a validation message is the shared validator's; what matters here is
      // that the request is refused and the message names the field (or the unknown key).
      const bad: [Record<string, unknown>, RegExp][] = [
        [{ leadsPerMonth: "lots" }, /Leads per month/i],
        [{ seats: -1 }, /Seats/i],
        [{ campaigns: null }, /Campaigns/i],
        [{ evil: {} }, /evil/i],
        [{ leadsPerMonth: 1.5 }, /Leads per month/i],
        [{ leadsPerMonth: 1e12 }, /Leads per month.*1,?000,?000,?000/i],
        [{ apiAccess: "no" }, /Api access|API access/i],
        [{ integrations: 1 }, /Integrations/i],
        [{ emailsPerDay: 0 }, /Emails per day/i],
        [{ toString: 5, constructor: 5 } as any, /toString.*constructor|constructor.*toString/i],
        // The exact body from the QA report: every bad entry is named.
        [{ leadsPerMonth: "lots", seats: -1, campaigns: null, evil: {} }, /^(?=.*Leads per month)(?=.*Seats)(?=.*Campaigns)(?=.*evil)/i],
      ];
      for (const [overrides, message] of bad) {
        const r = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides });
        expect(r.status, `${JSON.stringify(overrides)}: ${r.text}`).toBe(400);
        expect(r.body.error.code).toBe("validation_error");
        expect(r.body.error.message, JSON.stringify(overrides)).toMatch(message);
      }
      for (const overrides of ["x", [1], 5, null]) expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides })).status).toBe(400);
      // A literal "__proto__" key in the JSON must not become a way to slip limits in.
      const proto = await admin("PATCH", `/orgs/${u.orgId}/plan`, `{"plan":"${before.plan}","overrides":{"__proto__":{"leadsPerMonth":0,"seats":0}}}`);
      if (proto.status === 200) expect(proto.body).toMatchObject({ changed: false, overrides: {} });
      else expect(proto.status).toBe(400);
      expect(({} as any).leadsPerMonth).toBeUndefined();
      const after = await orgRow(u.orgId);
      expect(after.plan).toBe(before.plan);
      expect(after.planLimits).toEqual(before.planLimits);
      expect(await auditCount(u.orgId)).toBe(audits);
    });

    it("accepts real overrides, returns them, and shows them on GET /v1/admin/orgs/:id", async () => {
      const u = await signup("real-ov");
      const r = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides: { leadsPerMonth: 5000, apiAccess: false, seats: 0, emailsPerDay: 25 } });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ id: u.orgId, plan: "starter", changed: true });
      expect(r.body.overrides).toEqual({ leadsPerMonth: 5000, apiAccess: false, seats: 0, emailsPerDay: 25 });
      expect(r.body.limits).toEqual({ ...S.PLANS.starter.limits, leadsPerMonth: 5000, apiAccess: false, seats: 0, emailsPerDay: 25 });
      const detail = await admin("GET", `/orgs/${u.orgId}`);
      expect(detail.body.overrides).toEqual({ leadsPerMonth: 5000, apiAccess: false, seats: 0, emailsPerDay: 25 });
      expect(detail.body.org.overrides).toEqual(detail.body.overrides);
      expect(detail.body.org.limits.leadsPerMonth).toBe(5000);
      // An override equal to the plan's default is not an override.
      const same = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides: { leadsPerMonth: S.PLANS.starter.limits.leadsPerMonth } });
      expect(same.body.overrides).toEqual({});
      expect((await admin("GET", `/orgs/${u.orgId}`)).body.overrides).toEqual({});
    });

    it("junk that is ALREADY stored never disables a quota: every unusable value reads as the plan's default", async () => {
      const u = await signup("stored-junk");
      const starter = S.PLANS.starter.limits;
      // What the QA pass managed to store, plus the other shapes JSON allows.
      const junk = { leadsPerMonth: "lots", seats: -1, campaigns: null, evil: { a: 1 }, searchesPerMonth: 1.5, verificationsPerMonth: [], aiMessagesPerMonth: {}, emailsPerMonth: true, premiumLeadsPerMonth: "", apiAccess: "no", integrations: 0, emailsPerDay: -4 };
      await db.update(S.organizations).set({ plan: "starter", planLimits: junk }).where(S.eq(S.organizations.id, u.orgId));
      const auth = { authorization: `Bearer ${u.token}` };

      expect(S.effectiveLimits({ plan: "starter", planLimits: junk })).toEqual(starter);
      expect(S.planOverrides({ plan: "starter", planLimits: junk })).toEqual({});
      expect(S.sanitizePlanLimits(junk).rejected.sort()).toEqual(Object.keys(junk).sort());

      // What the customer sees: real numbers, not null ("limit": null read as unlimited).
      const usage = await req("GET", "/v1/usage", undefined, auth);
      expect(usage.status).toBe(200);
      for (const [metric, key] of Object.entries(S.metricToLimit)) expect(usage.body.usage[metric].limit, metric).toBe((starter as any)[key as string]);
      expect((await req("GET", "/v1/auth/me", undefined, auth)).body.org.limits).toEqual(starter);
      // What the operator sees: no "3/NaN".
      const row = (await admin("GET", `/orgs?q=${encodeURIComponent(u.slug)}`)).body.orgs.find((o: any) => o.id === u.orgId);
      expect(row.limits).toEqual(starter);
      expect((await admin("GET", `/orgs/${u.orgId}`)).body.org.limits).toEqual(starter);

      // And the quota is enforced. With the string in place this lead was created (201).
      await setUsed(u.orgId, "leads", starter.leadsPerMonth);
      await expect(S.consume(db, u.orgId, "leads", 1)).rejects.toBeInstanceOf(S.QuotaExceededError);
      expect(await S.tryConsumeQuota(db, u.orgId, "leads", 1)).toBe(false);
      expect(await used(u.orgId, "leads")).toBe(starter.leadsPerMonth);
      const lead = await req("POST", "/v1/leads", { firstName: "Over", lastName: "Quota", email: `over-${tag}@example.org` }, auth);
      expect(lead.status, lead.text).toBe(402);
      expect(lead.body.error).toMatchObject({ code: "quota_exceeded", metric: "leads", limit: starter.leadsPerMonth });
      await setUsed(u.orgId, "searches", starter.searchesPerMonth);
      await expect(S.consume(db, u.orgId, "searches", 1)).rejects.toBeInstanceOf(S.QuotaExceededError);
      // Premium leads: junk does not open a budget either.
      await setUsed(u.orgId, "premiumLeads", 0);
      expect(await S.remainingPremiumBudget(db, u.orgId)).toBe(starter.premiumLeadsPerMonth);

      // The next plan save cleans the row up and says so.
      const repaired = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter" });
      expect(repaired.status, repaired.text).toBe(200);
      expect(repaired.body.changed).toBe(true);
      expect(repaired.body.note).toMatch(/Removed stored limit values that were not usable/);
      expect((await orgRow(u.orgId)).planLimits).toEqual(starter);
    });

    it("effectiveLimits keeps what was honoured before: usable numbers, digit strings, 0 (no limit) and emailsPerDay", () => {
      const pilot = S.PLANS.pilot.limits;
      expect(S.effectiveLimits({ plan: "pilot", planLimits: {} })).toEqual(pilot);
      expect(S.effectiveLimits({ plan: "pilot", planLimits: null })).toEqual(pilot);
      expect(S.effectiveLimits(null)).toEqual(S.PLANS.free.limits);
      expect(S.effectiveLimits({ plan: "pilot", planLimits: { leadsPerMonth: 2 } })).toEqual({ ...pilot, leadsPerMonth: 2 });
      expect(S.effectiveLimits({ plan: "pilot", planLimits: { leadsPerMonth: "5000", seats: 0, emailsPerDay: 3, integrations: false } })).toEqual({ ...pilot, leadsPerMonth: 5000, seats: 0, emailsPerDay: 3, integrations: false });
      for (const bad of [NaN, Infinity, -1, 1.5, "1e9", "-3", " 5", null, undefined, [], {}, true]) {
        expect(S.effectiveLimits({ plan: "pilot", planLimits: { leadsPerMonth: bad } }).leadsPerMonth, String(bad)).toBe(pilot.leadsPerMonth);
      }
      expect(S.effectiveLimits({ plan: "pilot", planLimits: "nonsense" })).toEqual(pilot);
      expect(S.effectiveLimits({ plan: "pilot", planLimits: [1, 2] })).toEqual(pilot);
    });
  });

  // ── 5. Overrides survive a plan change unless the request says otherwise ──
  describe("overrides and plan changes", () => {
    it("changing only the plan keeps the workspace's overrides; an explicit {} clears them; new overrides replace them", async () => {
      const u = await signup("keep-ov");
      expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "pilot", overrides: { leadsPerMonth: 5000, seats: 9 } })).status).toBe(200);

      // What the dashboard sends: the plan alone. This used to rewrite plan_limits from the new plan's defaults.
      const moved = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter" });
      expect(moved.status, moved.text).toBe(200);
      expect(moved.body).toMatchObject({ plan: "starter", changed: true });
      expect(moved.body.overrides).toEqual({ leadsPerMonth: 5000, seats: 9 });
      expect(moved.body.limits).toEqual({ ...S.PLANS.starter.limits, leadsPerMonth: 5000, seats: 9 });
      // Not silent: the response says what was carried and how to clear it.
      expect(moved.body.note).toMatch(/Kept this workspace's existing overrides \(.*leadsPerMonth: 5000/);
      expect((await orgRow(u.orgId)).planLimits).toEqual({ ...S.PLANS.starter.limits, leadsPerMonth: 5000, seats: 9 });
      expect((await admin("GET", `/orgs/${u.orgId}`)).body.overrides).toEqual({ leadsPerMonth: 5000, seats: 9 });
      const [audit] = await db.select().from(S.auditLog).where(S.and(S.eq(S.auditLog.orgId, u.orgId), S.eq(S.auditLog.action, "admin.plan_changed"))).orderBy(S.desc(S.auditLog.createdAt));
      expect(audit.data).toMatchObject({ before: { plan: "pilot" }, after: { plan: "starter" }, overrides: { leadsPerMonth: 5000, seats: 9 }, overridesFrom: "kept" });

      // New overrides replace the old set entirely.
      const replaced = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "growth", overrides: { campaigns: 2 } });
      expect(replaced.body.overrides).toEqual({ campaigns: 2 });
      expect(replaced.body.limits).toEqual({ ...S.PLANS.growth.limits, campaigns: 2 });
      expect(replaced.body.note).toBeUndefined();

      // An explicit empty object clears them.
      const cleared = await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "growth", overrides: {} });
      expect(cleared.body).toMatchObject({ plan: "growth", changed: true, overrides: {} });
      expect(cleared.body.limits).toEqual(S.PLANS.growth.limits);
      expect((await orgRow(u.orgId)).planLimits).toEqual(S.PLANS.growth.limits);
      expect((await admin("GET", `/orgs/${u.orgId}`)).body.overrides).toEqual({});
    });
  });

  // ── 3. Credits: bounded, atomic, and honest about what happened ──
  describe("credits", () => {
    it("bounds the amount to whole numbers within +/- 1,000,000 and names the field", async () => {
      const u = await signup("bounds");
      await setUsed(u.orgId, "searches", 4);
      const bad: [unknown, RegExp][] = [
        [2147483647, /Amount.*1,?000,?000/],
        [1e308, /Amount.*1,?000,?000/],
        [1_000_001, /Amount.*1,?000,?000/],
        [-1_000_001, /Amount.*-1,?000,?000/],
        [99999999999, /Amount.*1,?000,?000/],
        [1.5, /Amount/],
        ["5", /Amount/],
        [null, /Amount/],
      ];
      for (const action of ["set", "grant"]) {
        for (const [amount, message] of bad) {
          const r = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action, amount });
          expect(r.status, `${action} ${String(amount)}: ${r.text}`).toBe(400);
          expect(r.body.error.code).toBe("validation_error");
          expect(r.body.error.message).toMatch(message);
        }
      }
      // NaN and Infinity are not JSON; they arrive as a malformed body or as null.
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, '{"metric":"searches","action":"set","amount":NaN}')).status).toBe(400);
      expect(await used(u.orgId, "searches")).toBe(4);
      // The edges are accepted.
      const top = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action: "set", amount: 1_000_000 });
      expect(top.status, top.text).toBe(200);
      expect(top.body).toMatchObject({ used: 1_000_000, changed: true });
      // Consuming on top of that never overflows the counter into a database error.
      const more = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action: "grant", amount: -1_000_000 });
      expect(more.body).toMatchObject({ used: 2_000_000, changed: true });
      await setUsed(u.orgId, "searches", 2147483600);
      const capped = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action: "grant", amount: -100 });
      expect(capped.status, capped.text).toBe(200);
      expect(capped.body).toMatchObject({ used: 2147483647, changed: true });
      expect(capped.body.note).toMatch(/only 47 were added/);
      // `action` and `mode` are the same field; one is required and they must agree.
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", mode: "set", amount: 2 })).body).toMatchObject({ used: 2, changed: true });
      const none = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", amount: 2 });
      expect(none.status).toBe(400);
      expect(none.body.error.message).toMatch(/Action/);
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action: "set", mode: "grant", amount: 2 })).status).toBe(400);
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "gold", action: "set", amount: 2 })).status).toBe(400);
    });

    it("ten parallel requests each count: the update is one statement on the row as it is", async () => {
      const u = await signup("parallel");
      await setUsed(u.orgId, "leads", 0);
      // "grant -1" takes one more from the allowance. Ten of these in parallel left used at 4.
      const up = await Promise.all(Array.from({ length: 10 }, () => admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: -1 })));
      for (const r of up) expect(r.status, r.text).toBe(200);
      expect(await used(u.orgId, "leads")).toBe(10);
      expect(up.map((r) => r.body.used).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(up.every((r) => r.body.changed === true)).toBe(true);
      // One audit row per change, each with its own before/after.
      const rows = await db.select().from(S.auditLog).where(S.and(S.eq(S.auditLog.orgId, u.orgId), S.eq(S.auditLog.action, "admin.credits_changed")));
      expect(rows).toHaveLength(10);
      expect(rows.map((r: any) => r.data.after.used - r.data.before.used)).toEqual(Array(10).fill(1));
      expect(rows.map((r: any) => r.data.after.used).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // The other direction, past zero: ten parallel "give one back" from 3. Exactly three land,
      // the counter stops at 0, and the seven that did nothing say so and leave no audit row.
      await setUsed(u.orgId, "leads", 3);
      const down = await Promise.all(Array.from({ length: 10 }, () => admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: 1 })));
      for (const r of down) expect(r.status, r.text).toBe(200);
      expect(await used(u.orgId, "leads")).toBe(0);
      expect(down.filter((r) => r.body.changed).length).toBe(3);
      for (const r of down.filter((r) => !r.body.changed)) {
        expect(r.body.used).toBe(0);
        expect(r.body.note).toMatch(/nothing to give back/);
      }
      expect(await db.select().from(S.auditLog).where(S.and(S.eq(S.auditLog.orgId, u.orgId), S.eq(S.auditLog.action, "admin.credits_changed")))).toHaveLength(13);
      // No workspace was left without a usage row or with two.
      expect(await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, u.orgId), S.eq(S.usage.metric, "leads")))).toHaveLength(1);
    });

    it("the first adjustment for a workspace with no usage row yet is just as safe in parallel", async () => {
      const u = await signup("norow");
      const r = await Promise.all(Array.from({ length: 10 }, () => admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "emails", action: "grant", amount: -2 })));
      for (const x of r) expect(x.status, x.text).toBe(200);
      expect(await used(u.orgId, "emails")).toBe(20);
      const direct = await S.adjustUsage(db, u.orgId, "emails", { delta: -50 });
      expect(direct).toMatchObject({ before: 20, after: 0 });
      expect(await S.adjustUsage(db, u.orgId, "emails", { set: 7 })).toMatchObject({ before: 0, after: 7 });
    });

    it("says what happened: used, limit, changed, and a note when the request could not be met in full", async () => {
      const u = await signup("honest"); // free plan: 50 leads, 0 premium leads
      await setUsed(u.orgId, "leads", 3);
      const audits = await auditCount(u.orgId);

      // Asked to give back 5 when only 3 were used.
      const clamp = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: 5 });
      expect(clamp.status, clamp.text).toBe(200);
      expect(clamp.body).toEqual({ metric: "leads", period: S.currentPeriod(), used: 0, limit: 50, changed: true, note: "Usage cannot go below zero, so only 3 were granted back." });
      expect(await auditCount(u.orgId)).toBe(audits + 1);
      await setUsed(u.orgId, "leads", 1);
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: 5 })).body.note).toBe("Usage cannot go below zero, so only 1 was granted back.");

      // "Grant +50" to a workspace that has used nothing: this answered "saved" and did nothing.
      const before = await auditCount(u.orgId);
      const nothing = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "premiumLeads", action: "grant", amount: 50 });
      expect(nothing.status).toBe(200);
      expect(nothing.body).toMatchObject({ metric: "premiumLeads", used: 0, limit: 0, changed: false });
      expect(nothing.body.note).toMatch(/used 0 premium leads this month.*nothing changed/);
      expect(nothing.body.note).toMatch(/does not raise the allowance of 0/);
      expect(nothing.body.note).toMatch(/plan override/);
      expect(await auditCount(u.orgId)).toBe(before);
      // ...and the override it points to does what the operator wanted.
      expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "free", overrides: { premiumLeadsPerMonth: 50 } })).body.overrides).toEqual({ premiumLeadsPerMonth: 50 });
      expect(await S.remainingPremiumBudget(db, u.orgId)).toBe(50);
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "premiumLeads", action: "set", amount: 20 })).body).toMatchObject({ used: 20, limit: 50, changed: true });

      // Exact grants and sets carry no note.
      await setUsed(u.orgId, "leads", 10);
      const exact = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: 4 });
      expect(exact.body).toEqual({ metric: "leads", period: S.currentPeriod(), used: 6, limit: 50, changed: true });
      const neg = await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "leads", action: "set", amount: -5 });
      expect(neg.body).toMatchObject({ used: 0, changed: true, note: "Usage cannot go below zero, so used was set to 0." });
      // A metric with no limit on this workspace (0 = no limit) reports limit null.
      await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "free", overrides: { searchesPerMonth: 0 } });
      expect((await admin("PATCH", `/orgs/${u.orgId}/credits`, { metric: "searches", action: "set", amount: 9 })).body).toMatchObject({ used: 9, limit: null, changed: true });
      expect((await admin("PATCH", `/orgs/${randomUUID()}/credits`, { metric: "leads", action: "set", amount: 1 })).status).toBe(404);
    });

    it("tool usage limits are bounded too, with the field named", async () => {
      const big = await admin("PATCH", "/tools/bing_html", { usageLimit: 99999999999 });
      expect(big.status).toBe(400);
      expect(big.body.error.code).toBe("validation_error");
      expect(big.body.error.message).toMatch(/Usage limit.*1,?000,?000,?000/);
      expect((await admin("PATCH", "/tools/bing_html", { usageLimit: -1 })).status).toBe(400);
      expect((await admin("PATCH", "/tools/bing_html", { usageLimit: 1.5 })).status).toBe(400);
      expect((await admin("PATCH", "/tools/no_such_tool", { usageLimit: 5 })).status).toBe(404);
    });
  });

  // ── 4. A request that changes nothing says so and leaves no audit row ──
  describe("no-op mutations", () => {
    it("grant 0, the current status, the current plan (with or without the same overrides) and an unchanged upgrade request: changed:false, no audit row", async () => {
      const u = await signup("noop");
      expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides: { leadsPerMonth: 777 } })).body.changed).toBe(true);
      await setUsed(u.orgId, "leads", 12);
      const [ur] = await db.insert(S.upgradeRequests).values({ orgId: u.orgId, name: "N", email: u.email, mobile: "+1 555 0100", country: "IN", planId: "growth" }).returning();
      const stored = await orgRow(u.orgId);
      const audits = await auditCount(u.orgId);

      const cases: [string, unknown, Record<string, unknown>][] = [
        [`/orgs/${u.orgId}/credits`, { metric: "leads", action: "grant", amount: 0 }, { used: 12, limit: 777, changed: false }],
        [`/orgs/${u.orgId}/credits`, { metric: "leads", action: "set", amount: 12 }, { used: 12, changed: false }],
        [`/orgs/${u.orgId}/status`, { status: "active" }, { id: u.orgId, status: "active", changed: false }],
        [`/orgs/${u.orgId}/plan`, { plan: "starter" }, { plan: "starter", changed: false, overrides: { leadsPerMonth: 777 } }],
        [`/orgs/${u.orgId}/plan`, { plan: "starter", overrides: { leadsPerMonth: 777 } }, { plan: "starter", changed: false, overrides: { leadsPerMonth: 777 } }],
        [`/upgrade-requests/${ur.id}`, { status: "new" }, { id: ur.id, status: "new", changed: false }],
      ];
      for (const [path, body, expected] of cases) {
        const r = await admin("PATCH", path, body);
        expect(r.status, `${path} ${JSON.stringify(body)}: ${r.text}`).toBe(200);
        expect(r.body, `${path} ${JSON.stringify(body)}`).toMatchObject(expected);
      }
      expect(await auditCount(u.orgId)).toBe(audits);
      const after = await orgRow(u.orgId);
      expect({ plan: after.plan, planLimits: after.planLimits, status: after.status }).toEqual({ plan: stored.plan, planLimits: stored.planLimits, status: stored.status });
      expect(await used(u.orgId, "leads")).toBe(12);

      // The same routes still record a real change, once.
      expect((await admin("PATCH", `/orgs/${u.orgId}/status`, { status: "deactivated" })).body).toMatchObject({ status: "deactivated", changed: true });
      expect((await admin("PATCH", `/upgrade-requests/${ur.id}`, { status: "contacted" })).body).toMatchObject({ status: "contacted", changed: true });
      expect((await admin("PATCH", `/orgs/${u.orgId}/plan`, { plan: "starter", overrides: {} })).body).toMatchObject({ changed: true, overrides: {} });
      expect(await auditCount(u.orgId)).toBe(audits + 3);
      await admin("PATCH", `/orgs/${u.orgId}/status`, { status: "active" });
    });

    it("PATCH /v1/admin/tools/:provider with {} or with the values it already has: changed:false, no audit row, alert state untouched", async () => {
      const provider = "bing_html";
      const toolAudits = async () => (await db.select({ id: S.auditLog.id }).from(S.auditLog).where(S.and(S.eq(S.auditLog.action, "admin.tool_limit_changed"), S.eq(S.auditLog.targetId, provider)))).length;
      const current = (await admin("GET", "/tools")).body.tools.find((t: any) => t.provider === provider);
      expect(current).toBeTruthy();
      await db.update(S.toolRegistry).set({ lastAlertPeriod: "2026-01" }).where(S.eq(S.toolRegistry.provider, provider));
      const before = await toolAudits();
      for (const body of [{}, { notes: current.notes }, { usageLimit: current.usageLimit, period: current.period, alertThresholdPct: current.alertThresholdPct }]) {
        const r = await admin("PATCH", `/tools/${provider}`, body);
        expect(r.status, r.text).toBe(200);
        expect(r.body).toMatchObject({ provider, changed: false, notes: current.notes, usageLimit: current.usageLimit });
      }
      expect(await toolAudits()).toBe(before);
      // A no-op must not re-arm the usage alert (a real update clears lastAlertPeriod).
      expect((await db.select().from(S.toolRegistry).where(S.eq(S.toolRegistry.provider, provider)))[0].lastAlertPeriod).toBe("2026-01");
      try {
        const real = await admin("PATCH", `/tools/${provider}`, { notes: `noop-test ${tag}` });
        expect(real.body).toMatchObject({ provider, changed: true, notes: `noop-test ${tag}` });
        expect(await toolAudits()).toBe(before + 1);
      } finally {
        await db.update(S.toolRegistry).set({ notes: current.notes, lastAlertPeriod: null }).where(S.eq(S.toolRegistry.provider, provider));
      }
    });
  });

  // ── 6. Search text is text ──
  describe("workspace search", () => {
    it("% and _ are characters, not wildcards: neither returns every workspace", async () => {
      const plain = await signup("plain", `Plain ${tag} Trading`);
      const pct = await signup("pct", `O'Reilly & Sons <Exports> 100% ${tag}`);
      const under = await signup("under", `Snake_Case ${tag} Labs`);
      const ids = async (q: string) => ((await admin("GET", `/orgs?q=${encodeURIComponent(q)}`)).body.orgs as any[]).map((o) => o.id);

      const byPct = await ids("%");
      expect(byPct).toContain(pct.orgId);
      expect(byPct).not.toContain(plain.orgId);
      expect(byPct).not.toContain(under.orgId);
      const byUnder = await ids("_");
      expect(byUnder).toContain(under.orgId);
      expect(byUnder).not.toContain(plain.orgId);
      expect(byUnder).not.toContain(pct.orgId);
      // In the middle of a term too: "S_ns" must not match "Sons", "1%0" must not match "100".
      expect(await ids(`S_ns <Exports> 100% ${tag}`)).toEqual([]);
      expect(await ids(`100% ${tag}`)).toEqual([pct.orgId]);
      expect(await ids(`1%0% ${tag}`)).toEqual([]);
      expect(await ids(`Snake_Case ${tag}`)).toEqual([under.orgId]);
      expect(await ids(`Snake%Case ${tag}`)).toEqual([]);
      expect(await ids("\\")).not.toContain(pct.orgId);
      // Ordinary searches are unchanged: name, slug and member email, case-insensitive.
      expect(await ids(`plain ${tag} trading`)).toEqual([plain.orgId]);
      expect(await ids(plain.slug)).toEqual([plain.orgId]);
      expect(await ids(plain.email.toUpperCase())).toEqual([plain.orgId]);
      expect(await ids(`O'Reilly & Sons <Exports> 100% ${tag}`)).toEqual([pct.orgId]);
      expect(await ids(`zzzz-nothing-${tag}`)).toEqual([]);
      // No search term (or only spaces) still lists everything.
      const all = await ids("   ");
      for (const o of [plain, pct, under]) expect(all).toContain(o.orgId);
      expect(all.length).toBeGreaterThan(byPct.length);
    });
  });

  // ── 7. Upgrade requests ──
  describe("upgrade requests", () => {
    const form = (over: Record<string, unknown> = {}) => ({ name: "Sara O'Reilly", email: `sara-${randomUUID().slice(0, 8)}@adm-${tag}.example.com`, mobile: "+353 1 234 5678", country: "Ireland", planId: "scale", message: "Need more leads.", ...over });

    it("list rows carry orgId and orgName (null when the person was not signed in)", async () => {
      const u = await signup("asker", `Asker ${tag} Ltd`);
      const signedIn = form();
      const anon = form({ planId: "starter" });
      expect((await req("POST", "/v1/upgrade-requests", signedIn, { authorization: `Bearer ${u.token}` })).status).toBe(201);
      expect((await req("POST", "/v1/upgrade-requests", anon)).status).toBe(201);
      const list = await admin("GET", "/upgrade-requests");
      expect(list.status).toBe(200);
      const a = list.body.requests.find((r: any) => r.email === signedIn.email);
      const b = list.body.requests.find((r: any) => r.email === anon.email);
      expect(a).toMatchObject({ orgId: u.orgId, orgName: `Asker ${tag} Ltd`, planId: "scale", status: "new", name: "Sara O'Reilly", message: "Need more leads." });
      expect(b).toMatchObject({ orgId: null, orgName: null, planId: "starter", status: "new" });
      // Every field the dashboard already read is still there.
      expect(Object.keys(a).sort()).toEqual(["country", "createdAt", "email", "id", "message", "mobile", "name", "orgId", "orgName", "planId", "status"]);
      // The status filter keeps the join.
      const onlyNew = await admin("GET", "/upgrade-requests?status=new");
      expect(onlyNew.body.requests.find((r: any) => r.email === signedIn.email).orgName).toBe(`Asker ${tag} Ltd`);
      expect((await admin("GET", "/upgrade-requests?status=weird")).body.requests).toEqual([]);
    });

    it("the notification names the plan and its price - never 'undefined' - for every plan", async () => {
      for (const planId of S.PLAN_IDS) {
        mocks.sent.length = 0;
        const f = form({ planId, name: "Rahul Verma" });
        expect((await req("POST", "/v1/upgrade-requests", f)).status, planId).toBe(201);
        const mail = mocks.sent.find((m) => m.replyTo === f.email)!;
        expect(mail, planId).toBeTruthy();
        expect(mail.to).toBe(NOTIFY);
        expect(mail.subject).toBe(`Upgrade request: Rahul Verma wants ${S.PLANS[planId].name} ($${S.PLANS[planId].priceUsd}/mo)`);
        expect(`${mail.subject}\n${mail.text}`).not.toMatch(/undefined|\[object|NaN/);
      }
    });

    it("a notification that cannot be sent is logged as a warning; the request is still saved", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const mode of ["result", "throw"] as const) {
          warn.mockClear();
          mocks.fail = mode;
          const f = form();
          const r = await req("POST", "/v1/upgrade-requests", f);
          mocks.fail = null;
          expect(r.status, r.text).toBe(201);
          const [row] = await db.select().from(S.upgradeRequests).where(S.eq(S.upgradeRequests.email, f.email));
          expect(row.id).toBe(r.body.id);
          const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[leadCapture]"));
          expect(lines, mode).toHaveLength(1);
          expect(lines[0]).toContain(row.id);
          expect(lines[0]).toMatch(/notification email was not sent/);
          // The stranger's address is not copied into the log.
          expect(lines[0]).not.toContain(f.email);
        }
        // A send that works logs nothing.
        warn.mockClear();
        expect((await req("POST", "/v1/upgrade-requests", form())).status).toBe(201);
        expect(warn.mock.calls.filter((c) => String(c[0]).includes("[leadCapture]"))).toHaveLength(0);
      } finally {
        mocks.fail = null;
        warn.mockRestore();
      }
    });
  });

  // ── 8. "Test all keys" says what it tested ──
  describe("POST /v1/admin/tools/check", () => {
    const checkAudits = async () => (await db.select({ id: S.auditLog.id }).from(S.auditLog).where(S.eq(S.auditLog.action, "admin.tools_checked"))).length;
    const setKeys = (keys: Record<string, string>) => {
      for (const k of PROVIDER_KEYS) delete process.env[k];
      Object.assign(process.env, keys);
    };

    it("with no key configured it does not claim success", async () => {
      setKeys({});
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: any) => {
        calls.push(String(typeof input === "string" ? input : input?.url ?? input));
        throw new Error("no outbound calls expected");
      });
      try {
        const before = await checkAudits();
        const r = await admin("POST", "/tools/check", {});
        expect(r.status, r.text).toBe(200);
        // Was: "All configured providers responded successfully."
        expect(r.body.summary).toBe("No provider keys are configured, so nothing was tested.");
        expect(r.body).toMatchObject({ tested: 0, passed: 0, notTested: [] });
        expect(r.body.results.length).toBeGreaterThanOrEqual(15);
        expect(r.body.results.every((x: any) => x.configured === false && x.ok === false && x.outcome === "not_configured")).toBe(true);
        expect(typeof r.body.checkedAt).toBe("string");
        expect(Array.isArray(r.body.retired)).toBe(true);
        expect(calls).toEqual([]);
        // Nothing was called, so nothing is recorded.
        expect(await checkAudits()).toBe(before);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("tests the AI and ipinfo keys with free read-only calls, and names the providers it could not test", async () => {
      const keys = { GROQ_API_KEY: "gsk_SECRETGROQ", GEMINI_API_KEY: "AIzaSECRETGEMINI", ANTHROPIC_API_KEY: "sk-ant-SECRETANTHROPIC", IPINFO_TOKEN: "SECRETIPINFO", ABSTRACT_EMAIL_API_KEY: "SECRETABSTRACT", WHATSAPP_ACCESS_TOKEN: "SECRETWHATSAPP" };
      setKeys(keys);
      const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
      vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        calls.push({ url, method: String(init.method ?? "GET").toUpperCase(), headers: Object.fromEntries([...new Headers(init.headers ?? {}).entries()]) });
        const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.startsWith("https://api.groq.com/")) return j(200, { data: [] });
        if (url.startsWith("https://generativelanguage.googleapis.com/")) return j(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
        if (url.startsWith("https://api.anthropic.com/")) return j(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        if (url.startsWith("https://ipinfo.io/")) return j(200, { token: "x", requests: { month: 3, limit: 50000 } });
        throw new Error(`unexpected outbound call to ${url}`);
      });
      const providers = ["groq", "gemini", "anthropic", "ipinfo"];
      try {
        const before = await checkAudits();
        const r = await admin("POST", "/tools/check", {});
        expect(r.status, r.text).toBe(200);
        const by = Object.fromEntries(r.body.results.map((x: any) => [x.provider, x]));
        expect(by.groq).toMatchObject({ configured: true, ok: true, outcome: "ok", endpoint: "GET /openai/v1/models" });
        expect(by.gemini).toMatchObject({ configured: true, ok: false, outcome: "auth", endpoint: "GET /v1beta/models" });
        expect(by.anthropic).toMatchObject({ configured: true, ok: false, outcome: "auth", endpoint: "GET /v1/models" });
        expect(by.ipinfo).toMatchObject({ configured: true, ok: true, outcome: "ok", endpoint: "GET /me" });

        // Free and side-effect free: four GETs to list/account endpoints, nothing that generates or sends.
        expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`).sort()).toEqual([
          "GET https://api.anthropic.com/v1/models",
          "GET https://api.groq.com/openai/v1/models",
          "GET https://generativelanguage.googleapis.com/v1beta/models",
          "GET https://ipinfo.io/me",
        ]);
        expect(calls.find((c) => c.url.includes("groq"))!.headers.authorization).toBe("Bearer gsk_SECRETGROQ");
        expect(calls.find((c) => c.url.includes("anthropic"))!.headers).toMatchObject({ "x-api-key": "sk-ant-SECRETANTHROPIC", "anthropic-version": "2023-06-01" });
        expect(calls.find((c) => c.url.includes("generativelanguage"))!.headers["x-goog-api-key"]).toBe("AIzaSECRETGEMINI");
        expect(calls.find((c) => c.url.includes("generativelanguage"))!.url).not.toContain("AIza");
        // Abstract and WhatsApp hold keys and were NOT called...
        expect(calls.some((c) => /abstractapi|facebook|whatsapp/i.test(c.url))).toBe(false);
        // ...and the answer says so, instead of "all configured providers responded".
        expect(r.body.notTested.map((n: any) => n.provider).sort()).toEqual(["abstract_email", "whatsapp_cloud"]);
        for (const n of r.body.notTested) {
          expect(n.label).toBeTruthy();
          expect(n.reason.length).toBeGreaterThan(20);
        }
        expect(r.body).toMatchObject({ tested: 4, passed: 2 });
        expect(r.body.summary).toMatch(/^2 of 4 tested provider key\(s\) did not respond successfully: /);
        expect(r.body.summary).toMatch(/gemini \(auth\)/);
        expect(r.body.summary).toMatch(/anthropic \(auth\)/);
        expect(r.body.summary).toMatch(/Not tested: .*Abstract.*WhatsApp|Not tested: .*WhatsApp.*Abstract/);
        // No credential in the response.
        for (const v of Object.values(keys)) expect(r.text).not.toContain(v);
        expect(await checkAudits()).toBe(before + 1);

        // All passing, with untested ones still configured: "all" is qualified.
        setKeys({ GROQ_API_KEY: keys.GROQ_API_KEY, IPINFO_TOKEN: keys.IPINFO_TOKEN, ABSTRACT_EMAIL_API_KEY: keys.ABSTRACT_EMAIL_API_KEY });
        const ok = await admin("POST", "/tools/check", {});
        expect(ok.body).toMatchObject({ tested: 2, passed: 2 });
        expect(ok.body.summary).toMatch(/^All 2 tested provider key\(s\) responded successfully\./);
        expect(ok.body.summary).toMatch(/Not tested: Abstract Email Validation \(no free test call exists for it\)\.$/);
        // Only untestable keys configured: nothing was tested, and it says which and why.
        setKeys({ WHATSAPP_ACCESS_TOKEN: keys.WHATSAPP_ACCESS_TOKEN });
        const none = await admin("POST", "/tools/check", {});
        expect(none.body).toMatchObject({ tested: 0, passed: 0 });
        expect(none.body.summary).toMatch(/^No provider key that can be tested is configured, so nothing was tested\. Not tested: WhatsApp/);
        // The results were recorded against the registry rows (they exist for every checked provider).
        const reg = await db.select().from(S.toolRegistry).where(S.inArray(S.toolRegistry.provider, providers));
        expect(reg.map((t: any) => t.provider).sort()).toEqual([...providers].sort());
      } finally {
        vi.unstubAllGlobals();
        setKeys({});
        await db.update(S.toolRegistry).set({ lastOutcome: null, lastStatus: null, lastDetail: null, lastSeenAt: null, lastOkAt: null }).where(S.inArray(S.toolRegistry.provider, providers));
      }
    });

    it("every provider that holds a key is either tested or listed as untested, and every tested provider has a Tools row", async () => {
      const core = await import("@prospex/core");
      const checked = new Set(core.PROVIDER_CHECKS.map((c: any) => c.provider));
      const registry = await db.select().from(S.toolRegistry);
      const rows = new Set(registry.map((t: any) => t.provider));
      // Reoon and MillionVerifier were tested and metered without a row, so their results were dropped.
      for (const p of checked) expect(rows.has(p), `${p} has no tool_registry row`).toBe(true);
      for (const p of ["groq", "gemini", "anthropic", "ipinfo", "reoon", "millionverifier"]) expect(checked.has(p), p).toBe(true);
      const keyed = registry.filter((t: any) => t.keyEnvVar && t.category !== "Infrastructure");
      for (const t of keyed) expect(checked.has(t.provider) || !!core.UNTESTED_PROVIDERS[t.provider], `${t.provider} is neither tested nor listed as untested`).toBe(true);
      for (const [p, u] of Object.entries(core.UNTESTED_PROVIDERS) as [string, any][]) {
        expect(checked.has(p)).toBe(false);
        expect(registry.find((t: any) => t.provider === p)?.keyEnvVar).toBe(u.envVar);
      }
      // Each new check reports "not configured" without calling anything when its key is unset.
      for (const k of PROVIDER_KEYS) delete process.env[k];
      for (const fn of [core.checkGroq, core.checkGemini, core.checkAnthropic, core.checkIpinfo]) expect(await fn()).toMatchObject({ configured: false, ok: false, outcome: "not_configured" });
    });
  });

  // ── 14. Errors on admin routes are JSON with a message a person can read ──
  describe("admin errors", () => {
    it("every kind of failure answers JSON with error.message", async () => {
      const u = await signup("errors");
      const cases: [string, string, unknown, Record<string, string>, number][] = [
        ["GET", "/v1/admin/orgs", undefined, {}, 401],
        ["GET", "/v1/admin/orgs", undefined, { authorization: `Bearer ${u.token}` }, 401],
        ["GET", "/v1/admin/orgs", undefined, { "x-admin-token": "wrong" }, 401],
        ["POST", "/v1/admin/logout", undefined, {}, 401],
        ["GET", `/v1/admin/orgs/${randomUUID()}`, undefined, ADMIN, 404],
        ["GET", "/v1/admin/orgs/not-a-uuid", undefined, ADMIN, 400],
        ["GET", "/v1/admin/nope", undefined, ADMIN, 404],
        ["DELETE", `/v1/admin/orgs/${u.orgId}`, undefined, ADMIN, 404],
        ["PATCH", `/v1/admin/orgs/${u.orgId}/plan`, "{not json", ADMIN, 400],
        ["PATCH", `/v1/admin/orgs/${u.orgId}/plan`, {}, ADMIN, 400],
        ["PATCH", `/v1/admin/orgs/${u.orgId}/status`, { status: "paused" }, ADMIN, 400],
        ["PATCH", `/v1/admin/orgs/${u.orgId}/credits`, [], ADMIN, 400],
        ["PATCH", `/v1/admin/upgrade-requests/${randomUUID()}`, { status: "dismissed" }, ADMIN, 404],
        ["PATCH", "/v1/admin/tools/hunter", { period: "year" }, ADMIN, 400],
        ["POST", "/v1/admin/login", { email: "root@scout.test" }, {}, 400],
        ["GET", `/v1/admin/orgs?q=${"x".repeat(300)}`, undefined, ADMIN, 400],
      ];
      for (const [method, path, body, headers, status] of cases) {
        const r = await req(method, path, body, headers);
        expect(r.status, `${method} ${path}: ${r.text}`).toBe(status);
        expect(r.headers.get("content-type"), `${method} ${path}`).toMatch(/application\/json/);
        expect(typeof r.body?.error?.message, `${method} ${path}: ${r.text}`).toBe("string");
        expect(r.body.error.message.length).toBeGreaterThan(3);
        expect(r.body.error.message).not.toMatch(/undefined|\[object Object\]/);
      }
    });
  });

  // ── 16. The API description covers what changed ──
  describe("openapi", () => {
    it("documents the new and changed admin endpoints, webhook secret rotation and the sender retest", async () => {
      const r = await req("GET", "/openapi.json");
      expect(r.status).toBe(200);
      const paths = r.body.paths;
      for (const p of ["/v1/webhooks/{id}/rotate-secret", "/v1/admin/logout", "/v1/campaigns/email-accounts/{id}/retest", "/v1/admin/orgs/{id}/plan", "/v1/admin/orgs/{id}/credits", "/v1/admin/orgs/{id}", "/v1/admin/upgrade-requests", "/v1/admin/tools/check"]) {
        expect(paths[p], p).toBeTruthy();
      }
      const schemaOf = (p: string, m: string) => paths[p][m].responses["200"].content["application/json"].schema;
      expect(Object.keys(schemaOf("/v1/admin/orgs/{id}/credits", "patch").properties)).toEqual(expect.arrayContaining(["used", "limit", "changed", "note"]));
      expect(Object.keys(schemaOf("/v1/admin/orgs/{id}/plan", "patch").properties)).toEqual(expect.arrayContaining(["overrides", "changed"]));
      expect(Object.keys(schemaOf("/v1/admin/orgs/{id}", "get").properties)).toContain("overrides");
      expect(Object.keys(schemaOf("/v1/admin/upgrade-requests", "get").properties.requests.items.properties)).toEqual(expect.arrayContaining(["orgId", "orgName"]));
      expect(Object.keys(schemaOf("/v1/admin/tools/check", "post").properties)).toEqual(expect.arrayContaining(["summary", "notTested", "tested"]));
      expect(paths["/v1/admin/orgs/{id}/plan"].patch.requestBody.content["application/json"].schema.properties.plan.enum).toEqual(S.PLAN_IDS);
      expect(paths["/v1/admin/orgs/{id}/plan"].patch.requestBody.content["application/json"].schema.properties.overrides.additionalProperties).toBe(false);
      expect(Object.keys(schemaOf("/v1/webhooks/{id}/rotate-secret", "post").properties)).toEqual(["id", "secret", "signatureVersion"]);
      expect(Object.keys(schemaOf("/v1/campaigns/email-accounts/{id}/retest", "post").properties)).toEqual(["emailAccount", "test"]);
    });
  });
});
