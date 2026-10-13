/**
 * Product analytics: what trackProduct keeps, the public page-view beacon, the admin funnel
 * and the retention of both new tables.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema. Nothing
 * leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/analytics.product.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "product_analytics";
const ADMIN_TOKEN = randomBytes(24).toString("hex");

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.MAIL_FROM = "Scout <no-reply@platform.test>";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.TRUSTED_PROXY = "cloudflare";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "STRIPE_SECRET_KEY", "CHECKOUT_FOLLOWUP", "CHECKOUT_FOLLOWUP_AFTER_HOURS"]) delete process.env[k];
}

if (!TEST_DB) process.stderr.write('\n[!] "product analytics" did NOT run: TEST_DATABASE_URL is not set.\n');

const suite = TEST_DB ? describe : describe.skip;

suite("product analytics", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let pe: typeof import("./lib/productEvents.js");
  let retention: typeof import("./lib/privacyRetention.js");
  const u8 = () => randomUUID().slice(0, 8);
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const freshIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, opts: { body?: string; headers?: Record<string, string>; ip?: string } = {}) {
    const res: Response = await app.request(path, { method, headers: { "cf-connecting-ip": opts.ip ?? freshIp(), ...(opts.headers ?? {}) }, body: opts.body });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }
  const admin = (method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN) =>
    req(method, `/v1/admin${path}`, { body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) } });
  const pv = (body: unknown, headers: Record<string, string> = {}, ip?: string) => req("POST", "/v1/public/pv", { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "text/plain", ...headers }, ip });
  const lastEvents = async (n = 5) => q`SELECT * FROM product_events ORDER BY created_at DESC LIMIT ${n}`;
  async function org() {
    const [o] = await db.insert(S.organizations).values({ name: `Org ${u8()}`, slug: `o-${u8()}` }).returning();
    const [u] = await db.insert(S.users).values({ orgId: o.id, email: `p-${u8()}@example.com`, passwordHash: "x" }).returning();
    return { orgId: o.id as string, userId: u.id as string };
  }

  beforeAll(async () => {
    try {
      const { default: postgres } = await import("postgres");
      const adminSql = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await adminSql.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB;
    }
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    pe = await import("./lib/productEvents.js");
    retention = await import("./lib/privacyRetention.js");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {});

  describe("trackProduct", () => {
    it("keeps allow-listed keys only, caps strings at 80, drops anything address-shaped and non-scalar", async () => {
      const o = await org();
      await pe.trackProduct("signup", {
        orgId: o.orgId,
        userId: o.userId,
        props: { method: "password", plan: "p".repeat(200), email: "jane@example.com", source: "jane@example.com", password: "hunter2", token: "t", nested: { a: 1 } as any, kind: 5, scope: true, reason: null, campaign: "a\nb" } as any,
      });
      const [row] = await q`SELECT * FROM product_events WHERE org_id = ${o.orgId} AND name = 'signup'`;
      expect(row).toBeTruthy();
      expect(row.user_id).toBe(o.userId);
      expect(row.props).toEqual({ method: "password", plan: "p".repeat(80), kind: 5, scope: true, reason: null, campaign: "a b" });
      expect(JSON.stringify(row)).not.toMatch(/example\.com|hunter2/);
    });

    it("never throws: an unknown workspace (foreign key), a bad id and an unknown name are swallowed with one line that carries no data", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ghost = randomUUID();
      await expect(pe.trackProduct("login_succeeded", { orgId: ghost, props: { method: "password" } })).resolves.toBeUndefined();
      await expect(pe.trackProduct("login_failed", { orgId: "not-a-uuid", userId: "nope" })).resolves.toBeUndefined();
      await expect(pe.trackProduct("no_such_event" as any)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toMatch(/\[product-events\] could not record "login_succeeded"/);
      expect(line).not.toContain(ghost);
      // The bad ids were dropped, not stored: the row exists with no workspace or user.
      const bad = await q`SELECT * FROM product_events WHERE name = 'login_failed' ORDER BY created_at DESC LIMIT 1`;
      expect(bad[0].org_id).toBeNull();
      expect(bad[0].user_id).toBeNull();
    });

    it("markActivated records one `activated` per workspace, even when called together", async () => {
      const o = await org();
      const results = await Promise.all(Array.from({ length: 6 }, () => pe.markActivated(o.orgId, o.userId)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await pe.markActivated(o.orgId)).toBe(false);
      const [{ n }] = await q`SELECT count(*)::int AS n FROM product_events WHERE org_id = ${o.orgId} AND name = 'activated'`;
      expect(n).toBe(1);
    });
  });

  describe("page-view beacon", () => {
    it("records the path without its query string, the referrer's host only and utm tags; no IP, no identifier", async () => {
      const ip = "203.0.113.77";
      const r = await pv({ path: "/?email=jane@example.com&x=1#top", ref: "https://news.ycombinator.com/item?id=123", utm_source: "hn", utm_medium: "social", utm_campaign: "launch", userId: "u1" }, {}, ip);
      expect(r.status).toBe(204);
      expect(r.text).toBe("");
      const [row] = await lastEvents(1);
      expect(row.name).toBe("page_view");
      expect(row.path).toBe("/");
      expect(row.org_id).toBeNull();
      expect(row.user_id).toBeNull();
      expect(row.props).toEqual({ referrer_host: "news.ycombinator.com", source: "hn", medium: "social", campaign: "launch" });
      expect(JSON.stringify(row)).not.toContain(ip);
      expect(JSON.stringify(row)).not.toContain("item?id");
      // The table has no column an address or IP could live in.
      const cols = (await q`SELECT column_name FROM information_schema.columns WHERE table_schema = ${SCHEMA} AND table_name = 'product_events'`).map((c) => c.column_name).sort();
      expect(cols).toEqual(["created_at", "id", "name", "org_id", "path", "props", "user_id"]);
    });

    it("drops our own hosts as referrers, and turns /pricing into pricing_viewed", async () => {
      await pv({ path: "/pricing", ref: "https://app.scout.test/signup" });
      const [row] = await lastEvents(1);
      expect(row.name).toBe("pricing_viewed");
      expect(row.props).toEqual({});
    });

    it("ignores Do Not Track and Global Privacy Control: 204, nothing stored", async () => {
      const [{ n: before }] = await q`SELECT count(*)::int AS n FROM product_events`;
      expect((await pv({ path: "/dnt" }, { dnt: "1" })).status).toBe(204);
      expect((await pv({ path: "/gpc" }, { "sec-gpc": "1" })).status).toBe(204);
      const [{ n: after }] = await q`SELECT count(*)::int AS n FROM product_events`;
      expect(after).toBe(before);
    });

    it("answers 204 to junk and stores nothing: bad JSON, no leading slash, oversized body", async () => {
      const [{ n: before }] = await q`SELECT count(*)::int AS n FROM product_events`;
      for (const body of ["not json", JSON.stringify([1]), JSON.stringify({ path: "https://evil.test/x" }), JSON.stringify({ path: 5 }), JSON.stringify({ path: "/big", ref: "x".repeat(5000) })]) {
        expect((await pv(body)).status).toBe(204);
      }
      const [{ n: after }] = await q`SELECT count(*)::int AS n FROM product_events`;
      expect(after).toBe(before);
    });

    it("counts only the pages the site sends (/, /pricing, /signup, /login): an invented path stores nothing", async () => {
      const [{ n: before }] = await q`SELECT count(*)::int AS n FROM product_events`;
      for (const path of ["/features", `/${"a".repeat(400)}`, "/admin", "/signup/extra"]) expect((await pv({ path })).status).toBe(204);
      const [{ n: after }] = await q`SELECT count(*)::int AS n FROM product_events`;
      expect(after).toBe(before);
      await pv({ path: "/signup?ref=x" });
      const [row] = await lastEvents(1);
      expect(row.path).toBe("/signup");
    });

    it("is rate-limited per address: past the limit it still answers 204 but stores nothing", async () => {
      const ip = "192.0.2.200";
      const tag = `rl-${u8()}`;
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) statuses.push((await pv({ path: "/login", utm_campaign: tag }, {}, ip)).status);
      expect(new Set(statuses)).toEqual(new Set([204]));
      const [{ n }] = await q`SELECT count(*)::int AS n FROM product_events WHERE props->>'campaign' = ${tag}`;
      expect(n).toBe(30);
      // Another address is not affected.
      await pv({ path: "/login", utm_campaign: tag });
      const [{ n: n2 }] = await q`SELECT count(*)::int AS n FROM product_events WHERE props->>'campaign' = ${tag}`;
      expect(n2).toBe(31);
    });
  });

  describe("admin funnel", () => {
    it("requires the admin: every new admin endpoint is 401 without credentials", async () => {
      for (const [m, p] of [["GET", "/analytics/funnel?days=30"], ["GET", "/checkouts"], ["POST", "/checkout-followup/preview"], ["POST", "/checkout-followup/test"]] as const) {
        const r = await admin(m, p, m === "POST" ? {} : undefined, null);
        expect(r.status, `${m} ${p}`).toBe(401);
        const wrong = await admin(m, p, m === "POST" ? {} : undefined, "not-the-token");
        expect(wrong.status, `${m} ${p}`).toBe(401);
      }
    });

    it("rejects a range other than 7, 30 or 90 days", async () => {
      expect((await admin("GET", "/analytics/funnel?days=13")).status).toBe(400);
    });

    it("counts each step in range, with step-to-step conversion, daily series, referrers, sources, sign-ins and API keys", async () => {
      await q`DELETE FROM product_events`;
      await q`DELETE FROM api_keys`;
      const o = await org();
      const ins = (name: string, n: number, extra: { props?: Record<string, unknown>; daysAgo?: number } = {}) =>
        Array.from({ length: n }, () => ({ name, orgId: name === "page_view" || name === "pricing_viewed" ? null : o.orgId, props: extra.props ?? {}, createdAt: new Date(Date.now() - (extra.daysAgo ?? 0) * 86_400_000 - 60_000) }));
      await db.insert(S.productEvents).values([
        ...ins("page_view", 6, { props: { referrer_host: "google.com", source: "newsletter" } }),
        ...ins("page_view", 4, { props: { referrer_host: "x.com" }, daysAgo: 2 }),
        ...ins("pricing_viewed", 5),
        ...ins("signup", 4),
        ...ins("email_verified", 2),
        ...ins("activated", 2),
        ...ins("checkout_started", 1),
        ...ins("checkout_completed", 1),
        ...ins("login_succeeded", 7),
        ...ins("login_failed", 3),
        // Outside a 30-day window.
        ...ins("signup", 9, { daysAgo: 45 }),
        ...ins("page_view", 9, { daysAgo: 45, props: { referrer_host: "old.example" } }),
      ]);
      const [k1] = await db.insert(S.apiKeys).values({ orgId: o.orgId, name: "a", prefix: "px_live_aa", keyHash: `h-${u8()}`, lastUsedAt: new Date() }).returning();
      await db.insert(S.apiKeys).values({ orgId: o.orgId, name: "b", prefix: "px_live_bb", keyHash: `h-${u8()}` });
      await db.insert(S.apiKeys).values({ orgId: o.orgId, name: "c", prefix: "px_live_cc", keyHash: `h-${u8()}`, revokedAt: new Date() });
      await db.insert(S.apiKeys).values({ orgId: o.orgId, name: "d", prefix: "px_live_dd", keyHash: `h-${u8()}`, expiresAt: new Date(Date.now() - 1000) });
      expect(k1).toBeTruthy();

      const r = await admin("GET", "/analytics/funnel?days=30");
      expect(r.status).toBe(200);
      const f = r.body;
      expect(f.range.days).toBe(30);
      expect(Object.fromEntries(f.steps.map((s: any) => [s.key, s.count]))).toEqual({ visits: 10, pricing_views: 5, signups: 4, verified: 2, activated: 2, checkout_started: 1, paid: 1 });
      expect(f.conversion[0]).toEqual({ from: "visits", to: "pricing_views", rate: 0.5 });
      expect(f.conversion[1]).toEqual({ from: "pricing_views", to: "signups", rate: 0.8 });
      expect(f.conversion[5]).toEqual({ from: "checkout_started", to: "paid", rate: 1 });
      expect(f.daily).toHaveLength(30);
      expect(f.daily.reduce((a: number, d: any) => a + d.visits, 0)).toBe(10);
      expect(f.daily[f.daily.length - 1].signups).toBe(4);
      expect(f.referrers).toEqual([{ host: "google.com", count: 6 }, { host: "x.com", count: 4 }]);
      expect(f.sources).toEqual([{ source: "newsletter", count: 6 }]);
      expect(f.logins).toEqual({ succeeded: 7, failed: 3 });
      expect(f.apiKeys).toEqual({ active: 2, usedInRange: 1 });

      const wide = (await admin("GET", "/analytics/funnel?days=90")).body;
      expect(wide.steps.find((s: any) => s.key === "signups").count).toBe(13);
      expect(wide.referrers.map((x: any) => x.host)).toContain("old.example");
      const narrow = (await admin("GET", "/analytics/funnel?days=7")).body;
      expect(narrow.daily).toHaveLength(7);
    });

    it("an empty period is all zeros with null conversion, not an error", async () => {
      await q`DELETE FROM product_events`;
      const r = await admin("GET", "/analytics/funnel?days=7");
      expect(r.status).toBe(200);
      expect(r.body.steps.every((s: any) => s.count === 0)).toBe(true);
      expect(r.body.conversion.every((c: any) => c.rate === null)).toBe(true);
    });
  });

  describe("retention", () => {
    it("deletes product events after 395 days and checkout sessions after 400", async () => {
      const o = await org();
      const day = 86_400_000;
      const [oldEv] = await db.insert(S.productEvents).values({ name: "page_view", createdAt: new Date(Date.now() - (retention.PRODUCT_RETENTION.productEventDays + 1) * day) }).returning();
      const [keepEv] = await db.insert(S.productEvents).values({ name: "page_view", createdAt: new Date(Date.now() - (retention.PRODUCT_RETENTION.productEventDays - 1) * day) }).returning();
      const [oldCs] = await db.insert(S.checkoutSessions).values({ orgId: o.orgId, plan: "growth", providerSessionId: `cs_${u8()}`, createdAt: new Date(Date.now() - (retention.PRODUCT_RETENTION.checkoutSessionDays + 1) * day) }).returning();
      const [keepCs] = await db.insert(S.checkoutSessions).values({ orgId: o.orgId, plan: "growth", providerSessionId: `cs_${u8()}`, createdAt: new Date(Date.now() - (retention.PRODUCT_RETENTION.productEventDays + 1) * day) }).returning();
      const report = await retention.runRetention(db);
      expect(report.failed).not.toContain("product events");
      expect(report.failed).not.toContain("checkout sessions");
      const ids = (await q`SELECT id FROM product_events WHERE id IN (${oldEv.id}, ${keepEv.id})`).map((r) => r.id);
      expect(ids).toEqual([keepEv.id]);
      const cs = (await q`SELECT id FROM checkout_sessions WHERE id IN (${oldCs.id}, ${keepCs.id})`).map((r) => r.id);
      expect(cs).toEqual([keepCs.id]);
    });
  });
});
