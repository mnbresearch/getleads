/**
 * Checkout sessions and the one-time follow-up email.
 *
 *  - a started checkout is a row (open) and a `checkout_started` event; the Stripe webhook
 *    moves it to completed or expired, and a cancelled subscription is counted;
 *  - the follow-up run gives every due session exactly one outcome, for every skip reason;
 *  - two runs at once send one email; dry_run and off send none;
 *  - the unsubscribe link is signed, and a bad signature changes nothing;
 *  - the admin preview writes nothing, and the test email goes to ADMIN_EMAIL only.
 *
 * Stripe and the mailer are replaced: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/checkout.followup.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "checkout_followup";
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
  process.env.ADMIN_EMAIL = "operator@platform.test";
  process.env.TRUSTED_PROXY = "cloudflare";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CHECKOUT_FOLLOWUP", "CHECKOUT_FOLLOWUP_AFTER_HOURS"]) delete process.env[k];
}

type Sent = { to: string; from: string; subject: string; text: string; headers?: Record<string, string> };
const mocks = vi.hoisted(() => ({ sent: [] as Sent[], platformMailer: true, sessionSeq: 0, failSend: false }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    systemMailerConfig: () => (mocks.platformMailer ? { provider: "resend" as const, resendApiKey: "re_test_platform_key" } : null),
    sendMail: vi.fn(async (_cfg: unknown, input: Sent) => {
      // Slow enough that two runs started together really overlap.
      await new Promise((r) => setTimeout(r, 20));
      if (mocks.failSend) return { ok: false, provider: "test", error: "boom jane@example.com" };
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Math.random().toString(36).slice(2)}` };
    }),
  };
});
// Stripe without the network: a checkout gets a made-up session id, and a webhook "signature"
// is good when it is the word "good".
vi.mock("stripe", () => {
  class FakeStripe {
    customers = { create: async () => ({ id: `cus_${Math.random().toString(36).slice(2, 10)}` }) };
    checkout = { sessions: { create: async () => ({ id: `cs_test_${++mocks.sessionSeq}_${Math.random().toString(36).slice(2, 8)}`, url: "https://checkout.stripe.test/pay" }) } };
    webhooks = {
      constructEvent: (body: string, sig: string) => {
        if (sig !== "good") throw new Error("No signatures found matching the expected signature for payload");
        return JSON.parse(body);
      },
    };
  }
  return { default: FakeStripe };
});

if (!TEST_DB) process.stderr.write('\n[!] "checkout follow-up" did NOT run: TEST_DATABASE_URL is not set.\n');

const suite = TEST_DB ? describe : describe.skip;

suite("checkout sessions and follow-up", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let fu: typeof import("./services/checkoutFollowup.js");
  let authLib: typeof import("./lib/auth.js");
  let envMod: typeof import("./env.js");
  const u8 = () => randomUUID().slice(0, 8);
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const freshIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const HOUR = 3600_000;

  async function req(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
    const res: Response = await app.request(path, {
      method,
      headers: { "cf-connecting-ip": freshIp(), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, { body, headers: { "x-admin-token": ADMIN_TOKEN } });

  type Who = { orgId: string; userId: string; email: string; token: string };
  async function workspace(opts: { verified?: boolean; plan?: string; status?: string; email?: string } = {}): Promise<Who> {
    const [o] = await db.insert(S.organizations).values({ name: `Acme ${u8()}`, slug: `acme-${u8()}`, plan: opts.plan ?? "free", status: opts.status ?? "active" }).returning();
    const email = opts.email ?? `owner-${u8()}@example.com`;
    const [u] = await db.insert(S.users).values({ orgId: o.id, email, passwordHash: "x", role: "owner", emailVerifiedAt: opts.verified === false ? null : new Date() }).returning();
    return { orgId: o.id, userId: u.id, email, token: await authLib.issueJwt(u) };
  }
  async function session(w: Pick<Who, "orgId"> & { userId?: string | null }, opts: { hoursAgo?: number; plan?: string; status?: string; followupStatus?: string | null; followupAt?: Date } = {}) {
    const [row] = await db
      .insert(S.checkoutSessions)
      .values({
        orgId: w.orgId,
        userId: w.userId === undefined ? null : w.userId,
        plan: opts.plan ?? "growth",
        providerSessionId: `cs_${u8()}${u8()}`,
        status: opts.status ?? "open",
        createdAt: new Date(Date.now() - (opts.hoursAgo ?? 30) * HOUR),
        // A completed session was paid some time after it was started.
        completedAt: (opts.status ?? "open") === "completed" ? new Date(Date.now() - ((opts.hoursAgo ?? 30) - 1) * HOUR) : null,
        followupStatus: opts.followupStatus ?? null,
        followupAt: opts.followupAt ?? null,
      })
      .returning();
    return row;
  }
  const outcome = async (id: string) => (await q`SELECT followup_status FROM checkout_sessions WHERE id = ${id}`)[0]?.followup_status ?? null;
  const abandonedFor = async (orgId: string) => (await q`SELECT count(*)::int AS n FROM product_events WHERE name = 'checkout_abandoned' AND org_id = ${orgId}`)[0].n as number;
  // trackProduct is fire-and-forget; give it a moment to land.
  const settle = () => new Promise((r) => setTimeout(r, 50));

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
    fu = await import("./services/checkoutFollowup.js");
    authLib = await import("./lib/auth.js");
    envMod = await import("./env.js");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  beforeEach(async () => {
    await q`DELETE FROM checkout_sessions`;
  });
  afterEach(() => {
    mocks.sent.length = 0;
    mocks.platformMailer = true;
    mocks.failSend = false;
    delete process.env.CHECKOUT_FOLLOWUP;
    delete process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS;
    vi.restoreAllMocks();
  });

  describe("checkout row lifecycle", () => {
    const withStripe = async (fn: () => Promise<void>) => {
      const st = envMod.env.stripe as any;
      const saved = { secretKey: st.secretKey, webhookSecret: st.webhookSecret };
      st.secretKey = "sk_test_dummy";
      st.webhookSecret = "whsec_test";
      process.env.STRIPE_PRICE_GROWTH = "price_growth_t";
      try {
        await fn();
      } finally {
        st.secretKey = saved.secretKey;
        st.webhookSecret = saved.webhookSecret;
        delete process.env.STRIPE_PRICE_GROWTH;
      }
    };
    const hook = (event: unknown, sig = "good") => req("POST", "/v1/billing/webhook", { body: JSON.stringify(event), headers: { "stripe-signature": sig, "content-type": "application/json" } });
    const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_${u8()}`, object: "event", type, data: { object } });

    it("starting a checkout records an open session and checkout_started; completing it marks it completed once", async () => {
      await withStripe(async () => {
        const w = await workspace();
        const r = await req("POST", "/v1/billing/checkout", { token: w.token, body: { plan: "growth" } });
        expect(r.status).toBe(200);
        expect(r.body.url).toBe("https://checkout.stripe.test/pay");
        const [row] = await q`SELECT * FROM checkout_sessions WHERE org_id = ${w.orgId}`;
        expect(row).toMatchObject({ status: "open", plan: "growth", user_id: w.userId, provider: "stripe", followup_status: null });
        expect(row.provider_session_id).toMatch(/^cs_test_/);
        await settle();
        const started = await q`SELECT * FROM product_events WHERE name = 'checkout_started' AND org_id = ${w.orgId}`;
        expect(started).toHaveLength(1);
        expect(started[0].props).toEqual({ plan: "growth" });

        const completed = evt("checkout.session.completed", { id: row.provider_session_id, object: "checkout.session", subscription: "sub_1", metadata: { orgId: w.orgId, plan: "growth" } });
        expect((await hook(completed)).status).toBe(200);
        expect((await hook(completed)).status).toBe(200); // Stripe retries; nothing is counted twice.
        await settle();
        const [after] = await q`SELECT * FROM checkout_sessions WHERE id = ${row.id}`;
        expect(after.status).toBe("completed");
        expect(after.completed_at).toBeTruthy();
        expect((await q`SELECT count(*)::int AS n FROM product_events WHERE name = 'checkout_completed' AND org_id = ${w.orgId}`)[0].n).toBe(1);
        // The existing behaviour is untouched: the plan changed.
        expect((await q`SELECT plan FROM organizations WHERE id = ${w.orgId}`)[0].plan).toBe("growth");
      });
    });

    it("an expired Stripe session marks the row expired; a deleted subscription is counted as cancelled", async () => {
      await withStripe(async () => {
        const w = await workspace({ plan: "growth" });
        await db.update(S.organizations).set({ stripeCustomerId: `cus_${w.orgId.slice(0, 8)}` }).where(S.eq(S.organizations.id, w.orgId));
        const s = await session(w, { hoursAgo: 1 });
        expect((await hook(evt("checkout.session.expired", { id: s.provider_session_id ?? s.providerSessionId, object: "checkout.session", metadata: { orgId: w.orgId, plan: "growth" } }))).status).toBe(200);
        expect((await q`SELECT status FROM checkout_sessions WHERE id = ${s.id}`)[0].status).toBe("expired");
        expect((await hook(evt("customer.subscription.deleted", { id: "sub_x", object: "subscription", customer: `cus_${w.orgId.slice(0, 8)}`, items: { data: [{ price: { id: "price_growth_t" } }] } }))).status).toBe(200);
        await settle();
        const cancelled = await q`SELECT * FROM product_events WHERE name = 'subscription_cancelled' AND org_id = ${w.orgId}`;
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0].props).toEqual({ plan: "growth" });
        expect((await q`SELECT plan FROM organizations WHERE id = ${w.orgId}`)[0].plan).toBe("free");
      });
    });

    it("a webhook with a bad signature is refused and changes nothing", async () => {
      await withStripe(async () => {
        const w = await workspace();
        const s = await session(w, { hoursAgo: 1 });
        const r = await hook(evt("checkout.session.completed", { id: s.providerSessionId, metadata: { orgId: w.orgId, plan: "growth" } }), "forged");
        expect(r.status).toBe(400);
        expect((await q`SELECT status FROM checkout_sessions WHERE id = ${s.id}`)[0].status).toBe("open");
      });
    });
  });

  describe("eligibility", () => {
    it("gives each due session exactly one outcome, for every skip reason", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      const ok = await workspace();
      const sOk = await session(ok);
      const expiredOk = await workspace();
      const sExpired = await session(expiredOk, { status: "expired" });

      const unverified = await workspace({ verified: false });
      const sUnverified = await session(unverified);
      const optedOut = await workspace();
      await db.insert(S.emailOptOuts).values({ userId: optedOut.userId, kind: "checkout_followup" });
      const sOpted = await session(optedOut);
      const base = `listed-${u8()}`;
      const suppressed = await workspace({ email: `${base}+billing@example.com` });
      await db.insert(S.globalSuppressions).values({ email: `${base}@example.com` });
      const sSuppressed = await session(suppressed);
      const paidLater = await workspace();
      const sPaidLater = await session(paidLater, { hoursAgo: 40 });
      await session(paidLater, { hoursAgo: 35, status: "completed" });
      const already = await workspace({ plan: "growth" });
      const sAlready = await session(already);
      const old = await workspace();
      const sOld = await session(old, { hoursAgo: 8 * 24 });
      const noUser = await workspace();
      const sNoUser = await session({ orgId: noUser.orgId, userId: null });
      const recent = await workspace();
      await session(recent, { hoursAgo: 72, followupStatus: "sent", followupAt: new Date(Date.now() - 3 * 24 * HOUR) });
      const sRecent = await session(recent);
      const suspended = await workspace({ status: "deactivated" });
      const sSuspended = await session(suspended);
      const twice = await workspace();
      const sTwiceA = await session(twice, { hoursAgo: 50 });
      const sTwiceB = await session(twice, { hoursAgo: 30 });
      const fresh = await workspace();
      const sFresh = await session(fresh, { hoursAgo: 2 });

      const r = await fu.runCheckoutFollowups();
      await settle();
      expect(await outcome(sOk.id)).toBe("sent");
      expect(await outcome(sExpired.id)).toBe("sent");
      expect(await outcome(sUnverified.id)).toBe("skipped:unverified");
      expect(await outcome(sOpted.id)).toBe("skipped:opted_out");
      expect(await outcome(sSuppressed.id)).toBe("skipped:suppressed");
      expect(await outcome(sPaidLater.id)).toBe("skipped:completed_later");
      expect(await outcome(sAlready.id)).toBe("skipped:plan_already");
      expect(await outcome(sOld.id)).toBe("skipped:too_old");
      expect(await outcome(sNoUser.id)).toBe("skipped:no_user");
      expect(await outcome(sRecent.id)).toBe("skipped:recent_followup");
      expect(await outcome(sSuspended.id)).toBe("skipped:org_inactive");
      expect(await outcome(sTwiceA.id)).toBe("sent");
      expect(await outcome(sTwiceB.id)).toBe("skipped:recent_followup");
      // Not due yet: untouched.
      expect(await outcome(sFresh.id)).toBeNull();

      expect(r.sent).toBe(3);
      expect(mocks.sent.map((m) => m.to).sort()).toEqual([ok.email, expiredOk.email, twice.email].sort());
      // Abandoned once per session judged abandoned; never for one that was paid.
      expect(await abandonedFor(ok.orgId)).toBe(1);
      expect(await abandonedFor(unverified.orgId)).toBe(1);
      expect(await abandonedFor(paidLater.orgId)).toBe(0);
      expect(await abandonedFor(already.orgId)).toBe(0);
      expect(await abandonedFor(twice.orgId)).toBe(2);
      expect(await abandonedFor(fresh.orgId)).toBe(0);

      // A second run finds nothing to do: every outcome is final.
      const again = await fu.runCheckoutFollowups();
      expect(again.considered).toBe(0);
      expect(mocks.sent).toHaveLength(3);
      await settle();
      expect(await abandonedFor(ok.orgId)).toBe(1);
    });

    it("the email: plain copy with the workspace, the plan, the billing link, a signed unsubscribe link and List-Unsubscribe", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      const w = await workspace();
      await session(w);
      await fu.runCheckoutFollowups();
      expect(mocks.sent).toHaveLength(1);
      const m = mocks.sent[0];
      const name = (await q`SELECT name FROM organizations WHERE id = ${w.orgId}`)[0].name;
      expect(m.from).toBe("Scout <no-reply@platform.test>");
      expect(m.text).toContain(`You started upgrading ${name} to Growth but didn't finish. Pick up where you left off: https://app.scout.test/settings/billing`);
      const link = `https://api.scout.test/v1/public/email-opt-out?u=${w.userId}&k=checkout_followup&s=${fu.optOutSignature(w.userId, "checkout_followup")}`;
      expect(m.text).toContain(link);
      expect(m.headers?.["List-Unsubscribe"]).toBe(`<${link}>`);
      expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(m.text).not.toMatch(/\u2014/);
    });

    it("waits CHECKOUT_FOLLOWUP_AFTER_HOURS (clamped to 1-168) before a session counts as abandoned", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS = "48";
      expect(fu.followupAfterHours()).toBe(48);
      const w = await workspace();
      const s = await session(w, { hoursAgo: 30 });
      await fu.runCheckoutFollowups();
      expect(await outcome(s.id)).toBeNull();
      process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS = "0";
      expect(fu.followupAfterHours()).toBe(1);
      process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS = "9999";
      expect(fu.followupAfterHours()).toBe(168);
      process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS = "junk";
      expect(fu.followupAfterHours()).toBe(24);
    });
  });

  describe("modes and idempotency", () => {
    it("two runs at once send one email per session", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      const ws = await Promise.all([workspace(), workspace(), workspace()]);
      const ss = [];
      for (const w of ws) ss.push(await session(w));
      const [a, b] = await Promise.all([fu.runCheckoutFollowups(), fu.runCheckoutFollowups()]);
      expect(a.sent + b.sent).toBe(3);
      expect(mocks.sent).toHaveLength(3);
      expect(new Set(mocks.sent.map((m) => m.to)).size).toBe(3);
      for (const s of ss) expect(await outcome(s.id)).toBe("sent");
    });

    it("two runs at once, two sessions of one workspace: one email", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      const w = await workspace();
      const s1 = await session(w, { hoursAgo: 30 });
      const s2 = await session(w, { hoursAgo: 31 });
      // Both runs see both sessions. Whichever claims one first sends; the other session is
      // then refused by the 14-day workspace gap, checked under a lock with its claim.
      await Promise.all([fu.runCheckoutFollowups({ limit: 2 }), fu.runCheckoutFollowups({ limit: 2 })]);
      expect(mocks.sent).toHaveLength(1);
      expect([await outcome(s1.id), await outcome(s2.id)].sort()).toEqual(["sent", "skipped:recent_followup"]);
    });

    it("dry_run records the decision and sends nothing", async () => {
      process.env.CHECKOUT_FOLLOWUP = "dry_run";
      const w = await workspace();
      const s = await session(w);
      const r = await fu.runCheckoutFollowups();
      await settle();
      expect(r.dryRun).toBe(1);
      expect(mocks.sent).toHaveLength(0);
      expect(await outcome(s.id)).toBe("dry_run");
      expect(await abandonedFor(w.orgId)).toBe(1);
    });

    it("off (the default) sends nothing but still counts the abandoned checkout", async () => {
      expect(fu.followupMode()).toBe("off");
      const w = await workspace();
      const s = await session(w);
      await fu.runCheckoutFollowups();
      await settle();
      expect(mocks.sent).toHaveLength(0);
      expect(await outcome(s.id)).toBe("skipped:off");
      expect(await abandonedFor(w.orgId)).toBe(1);
    });

    it("no mail provider: failed:no_mailer, nothing thrown", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      mocks.platformMailer = false;
      const w = await workspace();
      const s = await session(w);
      const r = await fu.runCheckoutFollowups();
      expect(r.failed).toBe(1);
      expect(await outcome(s.id)).toBe("failed:no_mailer");
      expect(mocks.sent).toHaveLength(0);
    });

    it("a send the provider refuses is failed, with a log line that names no address", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      mocks.failSend = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const w = await workspace();
      const s = await session(w);
      await fu.runCheckoutFollowups();
      expect(await outcome(s.id)).toBe("failed");
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).not.toContain("@");
    });

    it("the job body reports counts only", async () => {
      process.env.CHECKOUT_FOLLOWUP = "on";
      const w = await workspace();
      await session(w);
      const out = await fu.checkoutFollowupJob();
      expect(out).toEqual({ mode: "on", considered: 1, sent: 1, dryRun: 0, failed: 0, skipped: {} });
      expect(JSON.stringify(out)).not.toContain("@");
    });
  });

  describe("unsubscribe link", () => {
    it("a signed link shows a button on GET and opts the person out on POST; a bad signature is a 400 that changes nothing", async () => {
      const w = await workspace();
      const sig = fu.optOutSignature(w.userId, "checkout_followup");
      const bad = await req("GET", `/v1/public/email-opt-out?u=${w.userId}&k=checkout_followup&s=${sig.slice(0, -2)}xx`);
      expect(bad.status).toBe(400);
      expect(bad.text).toMatch(/not valid/);
      const other = await workspace();
      const crossed = await req("GET", `/v1/public/email-opt-out?u=${other.userId}&k=checkout_followup&s=${sig}`);
      expect(crossed.status).toBe(400);
      expect((await req("GET", `/v1/public/email-opt-out?u=${w.userId}&k=newsletter&s=${sig}`)).status).toBe(400);
      expect((await req("GET", `/v1/public/email-opt-out?u=not-a-uuid&k=checkout_followup&s=${sig}`)).status).toBe(400);
      expect(await q`SELECT * FROM email_opt_outs WHERE user_id IN (${w.userId}, ${other.userId})`).toHaveLength(0);

      // GET (what a mail scanner opening the link does) only shows the button; nothing changes.
      const good = await req("GET", `/v1/public/email-opt-out?u=${w.userId}&k=checkout_followup&s=${sig}`);
      expect(good.status).toBe(200);
      expect(good.text).toMatch(/<form method="post"/);
      expect(await q`SELECT * FROM email_opt_outs WHERE user_id = ${w.userId}`).toHaveLength(0);
      const post = await req("POST", `/v1/public/email-opt-out?u=${w.userId}&k=checkout_followup&s=${sig}`, { body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(post.status).toBe(200);
      expect(post.text).toMatch(/unsubscribed/i);
      expect(await q`SELECT kind FROM email_opt_outs WHERE user_id = ${w.userId}`).toEqual([{ kind: "checkout_followup" }]);

      // ...and the follow-up respects it.
      process.env.CHECKOUT_FOLLOWUP = "on";
      const s = await session(w);
      await fu.runCheckoutFollowups();
      expect(await outcome(s.id)).toBe("skipped:opted_out");
      expect(mocks.sent).toHaveLength(0);
    });

    it("verifyOptOutSignature rejects empty, oversized and other-kind signatures", () => {
      const id = randomUUID();
      const sig = fu.optOutSignature(id, "checkout_followup");
      expect(fu.verifyOptOutSignature(id, "checkout_followup", sig)).toBe(true);
      expect(fu.verifyOptOutSignature(id, "checkout_followup", "")).toBe(false);
      expect(fu.verifyOptOutSignature(id, "checkout_followup", "a".repeat(500))).toBe(false);
      expect(fu.verifyOptOutSignature(id, "other", sig)).toBe(false);
    });
  });

  describe("admin endpoints", () => {
    it("preview shows what a run would do and the first email, and writes nothing", async () => {
      process.env.CHECKOUT_FOLLOWUP = "dry_run";
      const w = await workspace();
      const s = await session(w);
      const u = await workspace({ verified: false });
      const s2 = await session(u);
      const [{ n: eventsBefore }] = await q`SELECT count(*)::int AS n FROM product_events`;
      const r = await admin("POST", "/checkout-followup/preview", {});
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe("dry_run");
      expect(r.body.considered).toBe(2);
      expect(r.body.dryRun).toBe(1);
      expect(r.body.skipped).toEqual({ unverified: 1 });
      expect(r.body.sample.to).toBe(w.email);
      expect(r.body.sample.text).toContain("Pick up where you left off");
      await settle();
      expect(await outcome(s.id)).toBeNull();
      expect(await outcome(s2.id)).toBeNull();
      expect(mocks.sent).toHaveLength(0);
      expect((await q`SELECT count(*)::int AS n FROM product_events`)[0].n).toBe(eventsBefore);
    });

    it("send test goes to ADMIN_EMAIL only, whatever the request says", async () => {
      const w = await workspace();
      await session(w);
      const r = await admin("POST", "/checkout-followup/test", { to: "someone-else@example.com" });
      expect(r.status).toBe(200);
      expect(r.body.sent).toBe(true);
      expect(mocks.sent.map((m) => m.to)).toEqual(["operator@platform.test"]);
      expect(mocks.sent[0].subject).toMatch(/^\[Test\] /);
      // The sample's unsubscribe link is not the real customer's.
      expect(mocks.sent[0].text).not.toContain(w.userId);
      mocks.platformMailer = false;
      const none = await admin("POST", "/checkout-followup/test", {});
      expect(none.body).toMatchObject({ sent: false, reason: "no_mailer" });
    });

    it("the checkout list shows workspace, plan, status, follow-up outcome and the owner's address only; filters work", async () => {
      process.env.CHECKOUT_FOLLOWUP = "dry_run";
      const w = await workspace();
      await db.insert(S.users).values({ orgId: w.orgId, email: `member-${u8()}@example.com`, passwordHash: "x", role: "member" });
      const s = await session(w);
      // Completed BEFORE the open one was started, so the open one still counts as abandoned.
      const done = await session(w, { status: "completed", hoursAgo: 60 });
      await fu.runCheckoutFollowups();
      const all = await admin("GET", "/checkouts");
      expect(all.status).toBe(200);
      expect(all.body.followup).toEqual({ mode: "dry_run", afterHours: 24, mailer: true });
      const mine = all.body.checkouts.filter((c: any) => c.orgId === w.orgId);
      expect(mine).toHaveLength(2);
      expect(mine.every((c: any) => c.ownerEmail === w.email)).toBe(true);
      expect(JSON.stringify(all.body)).not.toContain("member-");
      const abandoned = (await admin("GET", "/checkouts?status=abandoned")).body.checkouts.map((c: any) => c.id);
      expect(abandoned).toContain(s.id);
      expect(abandoned).not.toContain(done.id);
      const completed = (await admin("GET", "/checkouts?status=completed")).body.checkouts.map((c: any) => c.id);
      expect(completed).toEqual([done.id]);
      expect((await admin("GET", "/checkouts?status=bogus")).status).toBe(400);
    });
  });
});
