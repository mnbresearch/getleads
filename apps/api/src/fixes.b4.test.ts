/**
 * Fix round B4: billing and upgrade paths, the growth funnel without Stripe, the forgot-
 * password answer when the server cannot send email, data-subject requests that cover
 * upgrade requests, invites and accounts, the 2FA copy, and CORS.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema. Nothing
 * leaves the machine: no Stripe call and no mail provider call is ever made.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.b4.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "fixes_b4";
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
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "STRIPE_SECRET_KEY", "CORS_ALLOW_REGEX", "CORS_EXTRA_ORIGINS", "LEAD_NOTIFY_EMAIL"]) delete process.env[k];
}

if (!TEST_DB) process.stderr.write('\n[!] "fixes B4" did NOT run: TEST_DATABASE_URL is not set.\n');

const suite = TEST_DB ? describe : describe.skip;
const REPO = join(__dirname, "../../..");

suite("fixes B4", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let envMod: typeof import("./env.js");
  const u8 = () => randomUUID().slice(0, 8);
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const freshIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const res: Response = await app.request(path, {
      method,
      headers: { "cf-connecting-ip": freshIp(), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, headers: res.headers };
  }
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, { body, headers: { "x-admin-token": ADMIN_TOKEN } });
  async function org(email = `p-${u8()}@example.com`) {
    const [o] = await db.insert(S.organizations).values({ name: `Org ${u8()}`, slug: `o-${u8()}` }).returning();
    const [u] = await db.insert(S.users).values({ orgId: o.id, email, passwordHash: "x" }).returning();
    return { orgId: o.id as string, userId: u.id as string, orgName: o.name as string };
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
    envMod = await import("./env.js");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 7. CORS ──
  describe("CORS", () => {
    it("allows APP_URL, localhost outside production, an explicit CORS_ALLOW_REGEX, and *.vercel.app only when APP_URL is on vercel.app", async () => {
      const { corsOriginAllowedFor } = await import("./app.js");
      const vercelDefault = envMod.compileOriginRegex(undefined, () => {})!;
      const base = { appUrl: "https://app.scout.test", nodeEnv: "production", extraOrigins: [] as string[], allowRegex: vercelDefault, allowRegexExplicit: false };

      expect(corsOriginAllowedFor("https://app.scout.test", base)).toBe(true);
      // Any stranger's Vercel project used to be reflected.
      expect(corsOriginAllowedFor("https://evil-project.vercel.app", base)).toBe(false);
      // Localhost only outside production.
      expect(corsOriginAllowedFor("http://localhost:5173", base)).toBe(false);
      expect(corsOriginAllowedFor("http://localhost:5173", { ...base, nodeEnv: "development" })).toBe(true);
      expect(corsOriginAllowedFor("http://127.0.0.1:3000", { ...base, nodeEnv: "test" })).toBe(true);
      // Extra origins still work.
      expect(corsOriginAllowedFor("https://admin.scout.test", { ...base, extraOrigins: ["https://admin.scout.test"] })).toBe(true);

      // APP_URL on vercel.app: its preview deployments are allowed (the default pattern).
      const onVercel = { ...base, appUrl: "https://scout-web.vercel.app" };
      expect(corsOriginAllowedFor("https://scout-web.vercel.app", onVercel)).toBe(true);
      expect(corsOriginAllowedFor("https://scout-web-git-branch-team.vercel.app", onVercel)).toBe(true);
      expect(corsOriginAllowedFor("http://scout-web.vercel.app", onVercel)).toBe(false);
      expect(corsOriginAllowedFor("https://x.vercel.app.evil.example", onVercel)).toBe(false);

      // An explicit pattern is used as given, whatever APP_URL is.
      const explicit = { ...base, allowRegex: envMod.compileOriginRegex("^https://[a-z0-9-]+\\.scout-previews\\.test$", () => {}), allowRegexExplicit: true };
      expect(corsOriginAllowedFor("https://pr-12.scout-previews.test", explicit)).toBe(true);
      expect(corsOriginAllowedFor("https://evil.vercel.app", explicit)).toBe(false);
      const explicitVercel = { ...base, allowRegexExplicit: true };
      expect(corsOriginAllowedFor("https://my-preview.vercel.app", explicitVercel)).toBe(true);
      // "none" turns it off.
      expect(corsOriginAllowedFor("https://scout-web-git-x.vercel.app", { ...onVercel, allowRegex: envMod.compileOriginRegex("none", () => {}) })).toBe(false);
      // APP_URL with a trailing path still matches by origin.
      expect(corsOriginAllowedFor("https://app.scout.test", { ...base, appUrl: "https://app.scout.test/app" })).toBe(true);
    });

    it("through the app: with APP_URL off vercel.app, a *.vercel.app preflight gets APP_URL back, not itself", async () => {
      const pre = async (origin: string) => {
        const r = await app.request("/v1/billing/plans", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
        return r.headers.get("access-control-allow-origin");
      };
      expect(await pre("https://app.scout.test")).toBe("https://app.scout.test");
      expect(await pre("https://someone-else.vercel.app")).toBe("https://app.scout.test");
      expect(await pre("http://localhost:5173")).toBe("http://localhost:5173");

      // An operator-set CORS_ALLOW_REGEX is honoured.
      const savedRe = envMod.env.corsAllowRegex;
      const savedRaw = process.env.CORS_ALLOW_REGEX;
      try {
        process.env.CORS_ALLOW_REGEX = "^https://[a-z0-9-]+\\.vercel\\.app$";
        envMod.env.corsAllowRegex = envMod.compileOriginRegex(process.env.CORS_ALLOW_REGEX, () => {});
        expect(await pre("https://our-preview.vercel.app")).toBe("https://our-preview.vercel.app");
      } finally {
        envMod.env.corsAllowRegex = savedRe;
        if (savedRaw === undefined) delete process.env.CORS_ALLOW_REGEX;
        else process.env.CORS_ALLOW_REGEX = savedRaw;
      }
    });
  });

  // ── 3. Forgot password ──
  describe("forgot password", () => {
    it("says when the server cannot send email at all, with the same answer for a known and an unknown address", async () => {
      const known = await org(`fp-${u8()}@example.com`);
      const [u] = await db.select().from(S.users).where(S.eq(S.users.id, known.userId));
      const saved = { nodeEnv: envMod.env.nodeEnv, resend: envMod.env.resendApiKey, smtp: envMod.env.smtp.host };
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        (envMod.env as any).nodeEnv = "production";
        (envMod.env as any).resendApiKey = undefined;
        (envMod.env.smtp as any).host = undefined;
        const a = await req("POST", "/v1/auth/password/forgot", { body: { email: u.email } });
        const b = await req("POST", "/v1/auth/password/forgot", { body: { email: `nobody-${u8()}@example.com` } });
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body).toEqual(b.body);
        expect(a.body).toMatchObject({ ok: true, emailUnavailable: true });
        expect(a.body.message).toMatch(/no email provider/i);
        expect(JSON.stringify(a.body)).not.toContain(u.email);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        (envMod.env as any).nodeEnv = saved.nodeEnv;
        (envMod.env as any).resendApiKey = saved.resend;
        (envMod.env.smtp as any).host = saved.smtp;
      }
    });

    it("with a mail provider (or outside production) the answer is the plain {ok:true} as before", async () => {
      const saved = envMod.env.resendApiKey;
      try {
        (envMod.env as any).resendApiKey = "re_test_not_used";
        // Unknown address: nothing is sent, so no provider call happens.
        const r = await req("POST", "/v1/auth/password/forgot", { body: { email: `nobody-${u8()}@example.com` } });
        expect(r.body).toEqual({ ok: true });
      } finally {
        (envMod.env as any).resendApiKey = saved;
      }
      const dev = await req("POST", "/v1/auth/password/forgot", { body: { email: `nobody-${u8()}@example.com` } });
      expect(dev.body).toEqual({ ok: true });
    });
  });

  // ── 1. Billing plans: what can be bought online ──
  describe("billing plans", () => {
    it("checkoutPlans is empty without Stripe, and lists only plans with a Stripe price when it is on", async () => {
      const off = await req("GET", "/v1/billing/plans");
      expect(off.body).toMatchObject({ stripeEnabled: false, checkoutPlans: [] });
      expect(Array.isArray(off.body.plans)).toBe(true);

      const saved = envMod.env.stripe.secretKey;
      const savedPrice = process.env.STRIPE_PRICE_GROWTH;
      try {
        (envMod.env.stripe as any).secretKey = "sk_test_not_used";
        process.env.STRIPE_PRICE_GROWTH = "price_growth_test";
        const on = await req("GET", "/v1/billing/plans");
        expect(on.body.stripeEnabled).toBe(true);
        expect(on.body.checkoutPlans).toContain("growth");
        expect(on.body.checkoutPlans).not.toContain("free");
        for (const id of on.body.checkoutPlans) expect(process.env[`STRIPE_PRICE_${id.toUpperCase()}`]).toBeTruthy();
      } finally {
        (envMod.env.stripe as any).secretKey = saved;
        if (savedPrice === undefined) delete process.env.STRIPE_PRICE_GROWTH;
        else process.env.STRIPE_PRICE_GROWTH = savedPrice;
      }
    });
  });

  // ── 2. Growth funnel without Stripe ──
  describe("growth funnel", () => {
    it("an upgrade request records `upgrade_requested` (plan only), and the funnel reports it with checkout marked as not set up", async () => {
      await q`DELETE FROM product_events`;
      const email = `buyer-${u8()}@example.com`;
      const r = await req("POST", "/v1/upgrade-requests", { body: { name: "Bea Buyer", email, mobile: "+15550001111", country: "US", planId: "growth", message: "call me" } });
      expect(r.status).toBe(201);
      const [ev] = await q`SELECT * FROM product_events WHERE name = 'upgrade_requested'`;
      expect(ev).toBeTruthy();
      expect(ev.props).toEqual({ plan: "growth" });
      expect(JSON.stringify(ev)).not.toMatch(/Bea|example\.com|1555/);

      const f = await admin("GET", "/analytics/funnel?days=30");
      expect(f.status).toBe(200);
      expect(f.body.checkout).toEqual({ enabled: false });
      expect(f.body.upgradeRequests.requested).toBe(1);
      expect(f.body.upgradeRequests.inRange).toBeGreaterThanOrEqual(1);
      expect(f.body.upgradeRequests.open).toBeGreaterThanOrEqual(1);
      // The step list keeps its shape.
      expect(f.body.steps.map((s: any) => s.key)).toEqual(["visits", "pricing_views", "signups", "verified", "activated", "checkout_started", "paid"]);

      const saved = envMod.env.stripe.secretKey;
      try {
        (envMod.env.stripe as any).secretKey = "sk_test_not_used";
        expect((await admin("GET", "/analytics/funnel?days=7")).body.checkout).toEqual({ enabled: true });
      } finally {
        (envMod.env.stripe as any).secretKey = saved;
      }
    });
  });

  // ── 4. Data-subject requests ──
  describe("data-subject lookup and erase", () => {
    it("reports upgrade requests, invites and accounts; erase anonymises requests, deletes invites and reports the account it leaves", async () => {
      const tag = u8();
      const person = `dana-${tag}@subject.example`;
      const home = await org(person);
      const other = await org();
      const [r1] = await db.insert(S.upgradeRequests).values({ orgId: null, name: "Dana Subject", email: person, mobile: "+4479000000", country: "UK", planId: "growth", message: "Please call Dana" }).returning();
      const [r2] = await db.insert(S.upgradeRequests).values({ orgId: home.orgId, name: "Dana S", email: person.replace("@", "+work@"), mobile: "+4479000001", country: "UK", planId: "scale" }).returning();
      await db.insert(S.invites).values({ orgId: other.orgId, email: person, role: "member", tokenHash: `h-${tag}` });
      // A bystander's request stays as it is.
      const [keep] = await db.insert(S.upgradeRequests).values({ name: "Other Person", email: `other-${tag}@subject.example`, mobile: "+100", country: "US", planId: "growth" }).returning();

      const report = await admin("GET", `/data-subject?email=${encodeURIComponent(person)}`);
      expect(report.status).toBe(200);
      expect(report.body.held).toBe(true);
      expect(report.body.upgradeRequests).toBe(2);
      const w = report.body.workspaces.find((x: any) => x.orgId === other.orgId);
      expect(w).toMatchObject({ invites: 1, leads: 0 });
      expect(report.body.accounts).toEqual([{ userId: home.userId, orgId: home.orgId, orgName: home.orgName, role: "owner" }]);
      expect(report.body.accountNote).toMatch(/does not delete accounts/);

      const erased = await admin("POST", "/data-subject/erase", { email: person, confirm: person });
      expect(erased.status).toBe(200);
      expect(erased.body).toMatchObject({ ok: true, upgradeRequestsAnonymised: 2, invitesDeleted: 1, globallySuppressed: true });
      expect(erased.body.accounts).toHaveLength(1);
      expect(erased.body.accountNote).toBeTruthy();

      const left = await q`SELECT name, email, mobile, message, country FROM upgrade_requests WHERE id IN (${r1.id}, ${r2.id})`;
      expect(left).toHaveLength(2);
      for (const r of left) {
        expect(r.name).toBe("(removed)");
        expect(r.mobile).toBe("(removed)");
        expect(r.message).toBeNull();
        expect(r.email).not.toContain("@");
      }
      const [still] = await db.select().from(S.upgradeRequests).where(S.eq(S.upgradeRequests.id, keep.id));
      expect(still.name).toBe("Other Person");
      expect(await db.select().from(S.invites).where(S.eq(S.invites.orgId, other.orgId))).toHaveLength(0);
      // The account is left for its holder to delete.
      expect(await db.select().from(S.users).where(S.eq(S.users.id, home.userId))).toHaveLength(1);

      const after = await admin("GET", `/data-subject?email=${encodeURIComponent(person)}`);
      expect(after.body).toMatchObject({ held: false, upgradeRequests: 0, globallySuppressed: true });
      expect(after.body.accounts).toHaveLength(1);

      const log = await q`SELECT data FROM audit_log WHERE action = 'admin.data_subject_erased' ORDER BY created_at DESC LIMIT 1`;
      expect(log[0].data).toMatchObject({ upgradeRequestsAnonymised: 2, invitesDeleted: 1, accounts: 1 });
      expect(JSON.stringify(log[0])).not.toContain(person);
    });

    it("an address with no account says so with no note", async () => {
      const r = await admin("GET", `/data-subject?email=${encodeURIComponent(`nobody-${u8()}@subject.example`)}`);
      expect(r.body).toMatchObject({ held: false, upgradeRequests: 0, accounts: [], accountNote: null });
    });
  });

  // ── 5. 2FA copy points to where the card is ──
  describe("two-factor copy", () => {
    it("no message points to a Settings > Security or Settings > Two-factor sign-in page that does not exist", () => {
      const files = ["apps/api/src/lib/securityMail.ts", "apps/web/src/components/AccountBanners.tsx", "apps/api/src/routes/auth.ts"];
      for (const f of files) {
        const text = readFileSync(join(REPO, f), "utf8");
        expect(text, f).not.toMatch(/Settings (>|&gt;) (Security\b(?! log)|Two-factor sign-in|Password\b)/);
      }
      expect(readFileSync(join(REPO, "apps/api/src/lib/securityMail.ts"), "utf8")).toMatch(/Settings > Workspace, in the Two-factor sign-in card/);
    });
  });
});
