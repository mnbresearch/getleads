/**
 * Admin console, section D2: the Deliverability tab (GET /v1/admin/deliverability) and the
 * richer workspace detail and list (additive fields on GET /v1/admin/orgs/:id and /orgs).
 *
 * Seeds a workspace with a sender, a campaign, sent / bounced / replied messages, a spam
 * complaint, an integration in error, a webhook whose deliveries fail, and an inbound
 * address, then checks the numbers and - just as much - what must never come back: a
 * secret's value, a webhook's path, an address inside an error text.
 *
 * Runs against a real database through the real app:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/admin.d2.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = `admin-${"d".repeat(40)}`;
const RESEND_SECRET = "whsec_d2SecretValueThatMustNeverAppear0123456789";

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
  process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.DEFAULT_PLAN;
  delete process.env.TRUSTED_PROXY;
  delete process.env.STRIPE_SECRET_KEY;
}

if (!TEST_DB) process.stderr.write("\n[!] admin.d2 tests did NOT run: TEST_DATABASE_URL is not set.\n");

const suite = TEST_DB ? describe : describe.skip;

suite("admin D2: deliverability and workspace detail", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  const tag = randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const ADMIN = { "x-admin-token": ADMIN_TOKEN };

  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }
  const admin = (path: string) => req("GET", `/v1/admin${path}`, undefined, ADMIN);

  type Acct = { token: string; orgId: string; userId: string };
  async function signup(name: string): Promise<Acct> {
    const email = `${name}-${randomUUID().slice(0, 8)}@d2-${tag}.example.com`;
    const r = await req("POST", "/v1/auth/signup", { email, password: "correct-horse-battery", orgName: `${name} ${tag}` });
    expect(r.status, r.text).toBe(201);
    created.push(r.body.org.id);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id };
  }

  let u: Acct;
  let accountId: string;
  let hookId: string;
  const sender = `outreach-${tag}@sender-d2.example.com`;
  const hookUrl = `https://hooks.d2-${tag}.example.com/services/T000/SECRETPATHd2${tag}`;

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();

    u = await signup("deliv");
    const [acct] = await db.insert(S.emailAccounts).values({ orgId: u.orgId, provider: "smtp", fromName: "Out Reach", fromEmail: sender, dailyLimit: 80, status: "active" }).returning();
    accountId = acct.id;
    const [camp] = await db.insert(S.campaigns).values({ orgId: u.orgId, name: `D2 ${tag}`, status: "active", emailAccountId: acct.id }).returning();
    const now = new Date();
    const hourAgo = new Date(Date.now() - 3_600_000);
    // 250 sent in the last hour (enough to be among the 50 busiest senders): 19 bounced, 2 replied.
    const rows = Array.from({ length: 250 }, (_, i) => ({
      orgId: u.orgId,
      campaignId: camp.id,
      direction: "outbound",
      channel: "email",
      toEmail: `p${i}-${tag}@prospect-d2.example.com`,
      subject: "Hi",
      bodyText: "Hello",
      status: i < 19 ? "bounced" : i < 21 ? "replied" : "sent",
      sentAt: hourAgo,
      bouncedAt: i < 19 ? now : null,
      repliedAt: i >= 19 && i < 21 ? now : null,
      createdAt: hourAgo,
    }));
    await db.insert(S.messages).values(rows);
    // One reply arriving, one complaint on the suppression list, one bounce event.
    await db.insert(S.messages).values({ orgId: u.orgId, direction: "inbound", channel: "email", toEmail: sender, subject: "Re: Hi", bodyText: "Sure", status: "received" });
    await db.insert(S.suppressions).values({ orgId: u.orgId, email: `p7-${tag}@prospect-d2.example.com`, reason: "complaint" });
    await db.insert(S.events).values({ orgId: u.orgId, type: "message.bounced", data: {} });

    // An integration whose last sync failed, with an error that echoes a key and an address.
    await db.insert(S.integrations).values({
      orgId: u.orgId,
      provider: "hubspot",
      status: "error",
      settings: { lastError: `401 Unauthorized for owner jane-${tag}@client-d2.example.com with key pat-na1-1234567890abcdef1234567890abcdef`, lastErrorAt: now.toISOString(), credentialsRejected: true },
    });
    await db.insert(S.integrations).values({ orgId: u.orgId, provider: "inbound", status: "active", settings: { tokenHash: "x" } });

    // A webhook whose last delivery failed with a 503 (the stored error names the origin only).
    const [hook] = await db.insert(S.webhooks).values({ orgId: u.orgId, url: hookUrl, events: ["*"], active: true, failures: 2 }).returning();
    hookId = hook.id;
    await db.insert(S.jobs).values({ orgId: u.orgId, type: "webhook.deliver", status: "failed", attempts: 5, payload: { webhookId: hook.id, eventId: randomUUID() }, error: `webhook https://hooks.d2-${tag}.example.com → 503 Service Unavailable` });
    // One read to warm the database's caches: right after a restart the first cross-workspace
    // read can run past the per-statement cap, which the endpoint reports in `timedOut`
    // (covered below) rather than by failing.
    await admin("/deliverability?days=30");
  }, 60_000);

  // The seeded workspaces are deleted (with everything in them) so reruns do not pile up
  // busy senders in a shared test database.
  const created: string[] = [];
  afterAll(async () => {
    if (db && created.length) await db.delete(S.organizations).where(S.inArray(S.organizations.id, created));
  });

  it("GET /v1/admin/deliverability reports the seeded sends, bounces, complaints and replies", async () => {
    const r = await admin("/deliverability");
    expect(r.status, r.text).toBe(200);
    expect(r.body.days).toBe(7);
    expect(r.body.daily).toHaveLength(7);
    expect(r.body.timedOut).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    const hourAgoDay = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);
    const day = r.body.daily.find((d: any) => d.day === hourAgoDay);
    expect(day.sent).toBeGreaterThanOrEqual(250);
    expect(day.bounced).toBeGreaterThanOrEqual(19);
    expect(day.replied).toBeGreaterThanOrEqual(2);
    expect(r.body.daily.find((d: any) => d.day === today).complained).toBeGreaterThanOrEqual(1);
    expect(r.body.totals.sent).toBeGreaterThanOrEqual(250);
    expect(r.body.totals.bounceRate).toBeGreaterThan(0);
    expect(r.body.totals.bounceRate).toBeLessThanOrEqual(1);

    // The sender: its own volume and bounce rate over 7 days, and the scheduler's verdict
    // (19 of 250 bounced is 7.6%, above the 5% halt line).
    const s = r.body.senders.find((x: any) => x.accountId === accountId);
    expect(s, "seeded sender is among the top 50").toBeTruthy();
    expect(s).toMatchObject({ orgId: u.orgId, account: sender, provider: "smtp", status: "active", sent7d: 250, circuitBreaker: "halt", paused: true, dailyLimit: 80 });
    expect(s.bounceRate7d).toBeCloseTo(0.076, 3);
    expect(s.circuitReason).toMatch(/Bounce rate/);
    expect(s.warmupDay).toBe(1);

    expect(r.body.suppressions.workspaceTotal).toBeGreaterThanOrEqual(1);
    expect(typeof r.body.suppressions.global).toBe("number");
    expect(r.body.bounceTracking.resendWebhookConfigured).toBe(true);
    expect(Date.parse(r.body.bounceTracking.lastEventAt)).toBeGreaterThan(Date.now() - 3_600_000);
    expect(r.body.inbound.addressesCreated).toBeGreaterThanOrEqual(1);
    expect(r.body.inbound.repliesReceived7d).toBeGreaterThanOrEqual(1);
  });

  it("integrations: counts by provider and the errors, redacted; the inbound address is not a connection", async () => {
    const r = await admin("/deliverability");
    const hub = r.body.integrations.byProvider.find((p: any) => p.provider === "hubspot");
    expect(hub.connected).toBeGreaterThanOrEqual(1);
    expect(hub.inError).toBeGreaterThanOrEqual(1);
    expect(r.body.integrations.byProvider.find((p: any) => p.provider === "inbound")).toBeUndefined();
    const e = r.body.integrations.errors.find((x: any) => x.orgId === u.orgId);
    expect(e).toMatchObject({ provider: "hubspot", credentialsRejected: true });
    expect(e.lastError).toMatch(/401 Unauthorized/);
    expect(e.lastError).not.toContain(`jane-${tag}@client-d2.example.com`);
    expect(e.lastError).not.toContain("1234567890abcdef1234567890abcdef");
    expect(Date.parse(e.lastErrorAt)).not.toBeNaN();
  });

  it("webhooks: a failing hook is listed by host only with its last status, and no secret value is ever returned", async () => {
    const r = await admin("/deliverability");
    expect(r.body.webhooks.total).toBeGreaterThanOrEqual(1);
    const f = r.body.webhooks.failing.find((x: any) => x.webhookId === hookId);
    expect(f).toMatchObject({ orgId: u.orgId, host: `hooks.d2-${tag}.example.com`, lastStatus: 503, failures24h: 1, consecutiveFailures: 2, disabled: false });
    expect(f.lastError).toBe("503 Service Unavailable");
    expect(r.text).not.toContain(`SECRETPATHd2${tag}`);
    expect(r.text).not.toContain("/services/T000");
    expect(r.text).not.toContain(RESEND_SECRET);
    expect(r.text).not.toContain(ADMIN_TOKEN);
  });

  it("answers well under 2 s on this database (tens of thousands of workspaces), with no section timed out", async () => {
    await admin("/deliverability?days=30");
    const t0 = Date.now();
    const r = await admin("/deliverability?days=30");
    const ms = Date.now() - t0;
    expect(r.body.timedOut).toEqual([]);
    expect(ms, `took ${ms} ms`).toBeLessThan(2_000);
    const t1 = Date.now();
    await admin("/orgs");
    expect(Date.now() - t1, "workspace list").toBeLessThan(2_000);
  });

  it("days=30 gives a 30-day series; anything else is a 400", async () => {
    const r = await admin("/deliverability?days=30");
    expect(r.status).toBe(200);
    expect(r.body.daily).toHaveLength(30);
    expect(r.body.days).toBe(30);
    const days = r.body.daily.map((d: any) => d.day);
    expect([...days].sort()).toEqual(days);
    expect((await admin("/deliverability?days=9")).status).toBe(400);
  });

  it("bounce tracking reads 'not configured' when the webhook secret is not set", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const r = await admin("/deliverability");
      expect(r.body.bounceTracking.resendWebhookConfigured).toBe(false);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
    }
  });

  it("a customer session, an API key and no credential are all refused", async () => {
    const other = await signup("intruder");
    const key = await req("POST", "/v1/auth/api-keys", { name: "d2" }, { authorization: `Bearer ${other.token}` });
    expect(key.status, key.text).toBeLessThan(300);
    const apiKey = key.body.key ?? key.body.apiKey?.key ?? key.body.token;
    expect(typeof apiKey).toBe("string");
    for (const headers of [{}, { authorization: `Bearer ${other.token}` }, { authorization: `Bearer ${apiKey}` }, { "x-api-key": apiKey }]) {
      for (const path of ["/v1/admin/deliverability", `/v1/admin/orgs/${u.orgId}`, "/v1/admin/orgs"]) {
        const r = await req("GET", path, undefined, headers as Record<string, string>);
        expect([401, 403], `${path} ${JSON.stringify(Object.keys(headers))}: ${r.status}`).toContain(r.status);
        expect(r.text).not.toContain(sender);
      }
    }
  });

  it("GET /v1/admin/orgs/:id adds counts, activity, email, integrations, senders and recent security events", async () => {
    // Something for the counts and the security log.
    await db.insert(S.leads).values([{ orgId: u.orgId, email: `l1-${tag}@lead-d2.example.com` }, { orgId: u.orgId, email: `l2-${tag}@lead-d2.example.com` }]);
    await db.insert(S.lists).values({ orgId: u.orgId, name: "D2 list" });
    const r = await admin(`/orgs/${u.orgId}`);
    expect(r.status, r.text).toBe(200);
    // What was there before is still there.
    expect(r.body.org.id).toBe(u.orgId);
    expect(Array.isArray(r.body.users)).toBe(true);
    expect(typeof r.body.usage).toBe("object");
    expect(r.body.counts).toMatchObject({ members: 1, leads: 2, lists: 1, campaigns: 1, campaignsActive: 1, webhooks: 1, integrations: 1, plays: 0, clients: 0, pixels: 0, signalsSubscriptions: 0, autopilots: 0 });
    expect(typeof r.body.counts.apiKeysActive).toBe("number");
    expect(r.body.countsCapped).toEqual([]);
    expect(r.body.insightsTimedOut).toEqual([]);
    expect(r.body.emailsSent30d).toBe(250);
    expect(r.body.bounceRate30d).toBeCloseTo(0.076, 3);
    expect(Date.parse(r.body.lastActiveAt)).toBeGreaterThan(Date.now() - 600_000);
    expect(r.body.integrations).toEqual([expect.objectContaining({ provider: "hubspot", status: "error", lastSyncAt: null })]);
    expect(r.body.integrations[0].lastError).not.toContain("@client-d2.example.com");
    expect(r.body.senders).toEqual([{ account: sender, provider: "smtp", status: "active" }]);
    expect(r.body.recentAudit.length).toBeGreaterThan(0);
    expect(r.body.recentAudit.length).toBeLessThanOrEqual(10);
    for (const a of r.body.recentAudit) expect(Object.keys(a).sort()).toEqual(["action", "actorType", "createdAt", "result"]);
    // Stored credentials never reach the console.
    expect(r.text).not.toMatch(/configEncrypted|config_encrypted|tokenHash/);
  });

  it("an API key counts as active until it is revoked", async () => {
    const before = (await admin(`/orgs/${u.orgId}`)).body.counts.apiKeysActive;
    const k = await req("POST", "/v1/auth/api-keys", { name: "count me" }, { authorization: `Bearer ${u.token}` });
    expect(k.status, k.text).toBeLessThan(300);
    expect((await admin(`/orgs/${u.orgId}`)).body.counts.apiKeysActive).toBe(before + 1);
    await db.update(S.apiKeys).set({ revokedAt: new Date() }).where(S.eq(S.apiKeys.orgId, u.orgId));
    expect((await admin(`/orgs/${u.orgId}`)).body.counts.apiKeysActive).toBe(0);
  });

  it("GET /v1/admin/orgs list items carry lastActiveAt, membersCount and leadsTotal", async () => {
    const r = await admin(`/orgs?q=${encodeURIComponent(`deliv ${tag}`)}`);
    expect(r.status, r.text).toBe(200);
    const row = r.body.orgs.find((o: any) => o.id === u.orgId);
    expect(row).toBeTruthy();
    expect(row.membersCount).toBe(1);
    expect(row.membersCount).toBe(row.userCount);
    expect(row.leadsTotal).toBeGreaterThanOrEqual(2);
    expect(Date.parse(row.lastActiveAt)).toBeGreaterThan(Date.now() - 600_000);
    // A workspace with nothing in it: zero leads, and a last-active from its sign-up.
    const fresh = await signup("quiet");
    const all = await admin(`/orgs?q=${encodeURIComponent(`quiet ${tag}`)}`);
    const q = all.body.orgs.find((o: any) => o.id === fresh.orgId);
    expect(q).toMatchObject({ membersCount: 1, leadsTotal: 0 });
  });

  it("the helpers keep a webhook's path and an error's secrets out", async () => {
    const { hostOnly, safeErrorText } = await import("./services/adminDeliverability.js");
    expect(hostOnly("https://user:pw@hooks.example.com:8443/T/B/secret?token=abc")).toBe("hooks.example.com:8443");
    expect(hostOnly("not a url")).toBe("(invalid address)");
    expect(safeErrorText("")).toBeNull();
    expect(safeErrorText("Bearer abcdefghijklmnop1234 failed for a@b.co")).not.toMatch(/abcdefghijklmnop1234|a@b\.co/);
    expect(safeErrorText("x".repeat(500))!.length).toBeLessThanOrEqual(200);
  });
});
