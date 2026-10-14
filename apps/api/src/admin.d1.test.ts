/**
 * Admin console, D1: the Overview and System tabs and retrying a failed job.
 *
 * The alert rules and the configuration checklist are pure and tested directly. The three
 * routes go through the real app (createApp) and a real database, authenticated with the
 * server-to-server admin header; a customer's session must be refused on every one.
 *
 * Other files run against the same database at the same time, so counts are asserted as
 * "at least what this file created", never as exact platform totals.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/admin.d1.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = `admin-d1-${"c".repeat(40)}`;
/** Values that must never appear in any response, whatever the setting. */
const SECRETS = {
  JWT_SECRET: `jwt-d1-${"q".repeat(40)}`,
  ENCRYPTION_KEY: `enc-d1-${"w".repeat(40)}`,
  RESEND_WEBHOOK_SECRET: "whsec_d1secretvalue0123456789",
  STRIPE_SECRET_KEY: "sk_test_d1secretvalue0123456789",
  PILOT_INVITE_CODE: "pilot-d1-invite-code-9876",
};
const PROVIDER_KEYS = [
  "APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "RESEND_API_KEY", "REOON_API_KEY",
  "MILLIONVERIFIER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "IPINFO_TOKEN", "ABSTRACT_EMAIL_API_KEY", "OPENAI_COMPAT_BASE_URL",
];

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = SECRETS.JWT_SECRET;
  process.env.ENCRYPTION_KEY = SECRETS.ENCRYPTION_KEY;
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "inline";
  process.env.APP_URL = "https://app.scout.test";
  process.env.API_URL = "https://api.scout.test";
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  delete process.env.PILOT_INVITE_CODE;
  delete process.env.DEFAULT_PLAN;
  delete process.env.SMTP_HOST;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.ADMIN_TOTP_SECRET;
  delete process.env.KEEP_AWAKE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  for (const k of PROVIDER_KEYS) delete process.env[k];
}

const suite = TEST_DB ? describe : describe.skip;
if (!TEST_DB) process.stderr.write("\n[!] admin D1 tests did NOT run: TEST_DATABASE_URL is not set.\n");

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("deriveAlerts (pure)", () => {
  const base = async () => {
    const { deriveAlerts } = await import("./services/adminOverview.js");
    const facts = {
      nodeEnv: "production",
      searchKeys: 1,
      aiEngine: true,
      mailer: true,
      mailFromSet: true,
      resendWebhookSecret: true,
      adminTotp: true,
      stripe: true,
      stripeWebhook: true,
      outboundSending: true,
      encryptionKey: true,
      workerInProcess: true,
      jobMode: "worker",
      keepAwake: { configured: false, window: null, timeZone: null, onRender: false },
      campaignsActive: 0,
      failedJobs24h: 0,
      stuckJobs: 0,
      oldestDueSeconds: null,
      integrationsInError: 0,
      webhooksFailing: 0,
      openUpgradeRequests: 0,
      pendingDeletion: 0,
      bounces7d: 0,
      sent7d: 0,
      complaints7d: 0,
      schedulers: [],
    };
    return { deriveAlerts, facts };
  };

  it("says nothing when everything is set up and quiet", async () => {
    const { deriveAlerts, facts } = await base();
    expect(deriveAlerts(facts)).toEqual([]);
  });

  it("names each missing piece with a fix, critical first", async () => {
    const { deriveAlerts, facts } = await base();
    const alerts = deriveAlerts({
      ...facts,
      searchKeys: 0,
      aiEngine: false,
      resendWebhookSecret: false,
      campaignsActive: 2,
      adminTotp: false,
      stripe: false,
      openUpgradeRequests: 3,
      failedJobs24h: 7,
      keepAwake: { configured: true, window: "10:00-19:00", timeZone: "Asia/Kolkata", onRender: true },
    });
    const ids = alerts.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["no_search", "no_ai", "bounce_tracking_off", "admin_2fa_off", "stripe_off", "failed_jobs", "keep_awake"]));
    const levels = alerts.map((a) => a.level);
    const order = { critical: 0, warning: 1, info: 2 } as const;
    expect([...levels].sort((a, b) => order[a] - order[b])).toEqual(levels);
    const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
    expect(byId.bounce_tracking_off.level).toBe("critical");
    expect(byId.bounce_tracking_off.title).toBe("Bounce tracking is off - RESEND_WEBHOOK_SECRET is not set");
    expect(byId.no_search.level).toBe("critical");
    expect(byId.failed_jobs.title).toBe("7 jobs failed in the last 24 hours");
    expect(byId.stripe_off.title).toBe("Stripe not configured - upgrades arrive as requests");
    expect(byId.stripe_off.detail).toContain("3 requests are waiting");
    expect(byId.keep_awake.title).toBe("Free Render instance sleeps outside 10:00-19:00 IST (keep-awake)");
    for (const a of alerts) {
      expect(a.fix.length).toBeGreaterThan(10);
      expect(`${a.title} ${a.detail} ${a.fix}`).not.toMatch(/\u2014/);
    }
  });

  it("is a warning, not critical, when bounce tracking is off but nothing is sending", async () => {
    const { deriveAlerts, facts } = await base();
    const [a] = deriveAlerts({ ...facts, resendWebhookSecret: false, campaignsActive: 0 });
    expect(a.id).toBe("bounce_tracking_off");
    expect(a.level).toBe("warning");
  });

  it("flags a queue that is not draining, stuck jobs and dead schedulers", async () => {
    const { deriveAlerts, facts } = await base();
    const ids = deriveAlerts({ ...facts, oldestDueSeconds: 3600, stuckJobs: 1, schedulers: [{ type: "campaign.tick", healthy: false, problem: "Not scheduled." }] }).map((a) => `${a.level}:${a.id}`);
    expect(ids).toEqual(expect.arrayContaining(["critical:queue_not_draining", "critical:stuck_jobs", "critical:schedulers"]));
  });
});

describe("configChecklist (pure)", () => {
  it("says whether each setting is set and never returns a secret's value", async () => {
    const { configChecklist } = await import("./services/adminConfig.js");
    const e = {
      ...SECRETS,
      SERPER_API_KEY: "serper-d1-secret-value-123456",
      ADMIN_API_TOKEN: "admin-token-d1-secret-value-123456",
      ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DP",
      SMTP_HOST: "smtp.internal.example",
      SMTP_PASS: "smtp-pass-d1-secret",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret-d1",
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id-d1",
      DEFAULT_PLAN: "starter",
      CHECKOUT_FOLLOWUP: "dry_run",
      PRIVACY_SWEEP: "off",
      JOB_MODE: "worker",
      EMBED_WORKER: "true",
      KEEP_AWAKE_URL: "https://scout.example.com",
      KEEP_AWAKE_HOURS: "10-19",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv;
    const items = configChecklist(e, new Date("2026-10-14T06:00:00Z"));
    const text = JSON.stringify(items);
    for (const [k, v] of Object.entries(e)) {
      if (["DEFAULT_PLAN", "CHECKOUT_FOLLOWUP", "PRIVACY_SWEEP", "JOB_MODE", "EMBED_WORKER", "KEEP_AWAKE_HOURS", "NODE_ENV"].includes(k)) continue;
      expect(text, k).not.toContain(String(v));
    }
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.SERPER_API_KEY.set).toBe(true);
    expect(by.SERPAPI_KEY.set).toBe(false);
    expect(by.STRIPE_SECRET_KEY.set).toBe(true);
    expect(by.RESEND_WEBHOOK_SECRET.set).toBe(true);
    expect(by.ADMIN_TOTP_SECRET.set).toBe(true);
    expect(by.DEFAULT_PLAN.value).toBe("starter");
    expect(by.CHECKOUT_FOLLOWUP.value).toBe("dry_run");
    expect(by.PRIVACY_SWEEP.value).toBe("off");
    expect(by.EMBED_WORKER.value).toBe("on");
    // 06:00 UTC is 11:30 in India: inside the 10-19 window.
    expect(by.KEEP_AWAKE.value).toBe("10:00-19:00 Asia/Kolkata, pinging now");
    // Secrets carry no value at all.
    for (const k of ["SERPER_API_KEY", "STRIPE_SECRET_KEY", "RESEND_WEBHOOK_SECRET", "ADMIN_TOTP_SECRET", "JWT_SECRET", "ENCRYPTION_KEY", "PILOT_INVITE_CODE", "SMTP_HOST", "GOOGLE_OAUTH_CLIENT_ID"]) expect(by[k].value, k).toBeUndefined();
    const areas = new Set(items.map((i) => i.area));
    for (const a of ["search", "ai", "email", "billing", "security", "privacy", "runtime"]) expect(areas.has(a as never), a).toBe(true);
    for (const i of items) {
      expect(i.effect.length, i.key).toBeGreaterThan(10);
      expect(i.effect, i.key).not.toMatch(/\u2014/);
    }
  });

  it("reads keep-awake as off outside Render and the window as not active at night", async () => {
    const { configChecklist, keepAwakeState } = await import("./services/adminConfig.js");
    expect(keepAwakeState({} as NodeJS.ProcessEnv).configured).toBe(false);
    const night = keepAwakeState({ RENDER_EXTERNAL_URL: "https://scout.onrender.com" } as NodeJS.ProcessEnv, new Date("2026-10-14T20:00:00Z"));
    expect(night).toMatchObject({ configured: true, window: "10:00-19:00", timeZone: "Asia/Kolkata", activeNow: false, onRender: true });
    const off = configChecklist({ KEEP_AWAKE: "off", RENDER: "true" } as NodeJS.ProcessEnv).find((i) => i.key === "KEEP_AWAKE");
    expect(off).toMatchObject({ set: false, value: "off" });
  });
});

suite("admin overview, system and job retry", () => {
  let app: any;
  let db: any;
  let S: any;
  const ADMIN = { "x-admin-token": ADMIN_TOKEN };
  const tag = randomUUID().slice(0, 8);
  const created: string[] = [];
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

  async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
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
  const admin = (method: string, path: string) => req(method, `/v1/admin${path}`, ADMIN);

  async function signup(name: string) {
    const email = `${name}-${randomUUID().slice(0, 8)}@d1-${tag}.example.com`;
    const r = await req("POST", "/v1/auth/signup", {}, { email, password: "correct-horse-battery", orgName: `${name} ${tag}` });
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token as string, orgId: r.body.org.id as string, email };
  }
  async function job(values: Record<string, unknown>) {
    const [row] = await db.insert(S.jobs).values(values).returning();
    created.push(row.id);
    return row;
  }

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 60_000);

  afterAll(async () => {
    if (created.length) await db.delete(S.jobs).where(S.inArray(S.jobs.id, created));
  });

  it("refuses a customer's session and anonymous callers on all three routes", async () => {
    const u = await signup("cust");
    for (const [m, p] of [["GET", "/v1/admin/overview"], ["GET", "/v1/admin/system"], ["POST", `/v1/admin/jobs/${randomUUID()}/retry`]] as const) {
      expect((await req(m, p, { authorization: `Bearer ${u.token}` })).status, p).toBe(401);
      expect((await req(m, p)).status, p).toBe(401);
    }
  });

  it("GET /v1/admin/overview: every group, counts that include this file's data, and the alerts for what is missing", async () => {
    const u = await signup("ovw");
    await job({ orgId: u.orgId, type: "d1.stuck", status: "running", attempts: 1, lockedAt: new Date(), lockedBy: "d1-test", updatedAt: new Date(Date.now() - 60 * 60_000) });
    await job({ orgId: u.orgId, type: "d1.failed", status: "failed", attempts: 3, error: "boom", updatedAt: new Date() });
    const t0 = Date.now();
    const r = await admin("GET", "/overview");
    const ms = Date.now() - t0;
    expect(r.status, r.text).toBe(200);
    // Each group is capped at 1.2 s and they run side by side; the margin is for this shared
    // test database, which other files load at the same moment.
    expect(ms).toBeLessThan(2500);
    const o = r.body;
    // Other test files load the same database at the same time. A group that ran out of its
    // time limit is named in `unavailable` with its numbers null - that is the behaviour under
    // test too - so each group is checked only when it answered.
    expect(Array.isArray(o.unavailable)).toBe(true);
    const ok = (g: string) => !o.unavailable.includes(g);
    if (ok("workspaces")) {
      expect(o.workspaces.total).toBeGreaterThanOrEqual(1);
      expect(o.workspaces.new7d).toBeGreaterThanOrEqual(1);
      expect(o.workspaces.byStatus.active).toBeGreaterThanOrEqual(1);
      expect(o.users.total).toBeGreaterThanOrEqual(1);
      expect(typeof o.users.twoFactorOn).toBe("number");
      expect(o.revenue.stripeEnabled).toBe(false);
      expect(typeof o.revenue.paidWorkspaces).toBe("number");
    } else {
      expect(o.workspaces.total).toBeNull();
    }
    if (ok("active7d")) expect(o.workspaces.active7d).toBeGreaterThanOrEqual(0);
    if (ok("usage30d")) for (const k of ["leads", "searches", "verifications", "aiMessages"]) expect(typeof o.usage30d[k], k).toBe("number");
    expect(o.usage30d.basis.verifications).toBe("month");
    if (ok("outreach")) for (const k of ["emailsSent7d", "replies7d", "bounces7d", "complaints7d"]) expect(typeof o.outreach[k], k).toBe("number");
    if (ok("plays")) for (const k of ["total", "active", "runs7d", "candidatesPending"]) expect(typeof o.plays[k], k).toBe("number");
    if (ok("health")) {
      expect(o.health.stuckJobs).toBeGreaterThanOrEqual(1);
      expect(o.health.failedJobs24h).toBeGreaterThanOrEqual(1);
      expect(o.health.queueOpen).toBeGreaterThanOrEqual(1);
    }
    const ids = o.alerts.map((a: any) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["no_search", "bounce_tracking_off", "admin_2fa_off", "stripe_off"]));
    if (ok("health")) expect(ids).toEqual(expect.arrayContaining(["stuck_jobs", "failed_jobs"]));
    expect(o.alerts[0].level).toBe("critical");
    for (const v of Object.values(SECRETS)) expect(r.text).not.toContain(v);
    expect(r.text).not.toContain(ADMIN_TOKEN);
  });

  it("GET /v1/admin/system: build, database, config checklist without secrets, queue and schedulers", async () => {
    const u = await signup("sys");
    const failed = await job({
      orgId: u.orgId,
      type: "d1.sysfail",
      status: "failed",
      attempts: 3,
      error: `could not reach provider for jane.doe@example.org with key ${SECRETS.STRIPE_SECRET_KEY} ${"x".repeat(400)}`,
      updatedAt: new Date(),
    });
    const t0 = Date.now();
    const r = await admin("GET", "/system");
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.status, r.text).toBe(200);
    const s = r.body;
    expect(Array.isArray(s.unavailable)).toBe(true);
    const ok = (g: string) => !s.unavailable.includes(g);
    expect(s.build.node).toBe(process.version);
    expect(s.build.jobMode).toBe("inline");
    expect(typeof s.build.uptimeSeconds).toBe("number");
    if (ok("database")) {
      expect(s.database.migrationsApplied).toBeGreaterThan(10);
      expect(s.database.latestMigration).toMatch(/\.sql$/);
      expect(s.database.sizeBytes).toBeGreaterThan(0);
    }
    if (ok("largestTables")) expect(s.database.largestTables.length).toBeGreaterThan(0);
    expect(s.database.largestTables.length).toBeLessThanOrEqual(10);
    const cfg = Object.fromEntries(s.config.map((i: any) => [i.key, i]));
    expect(cfg.ADMIN_API_TOKEN.set).toBe(true);
    expect(cfg.RESEND_WEBHOOK_SECRET.set).toBe(false);
    expect(cfg.SERPER_API_KEY.set).toBe(false);
    expect(cfg.JOB_MODE.value).toBe("inline");
    for (const v of [...Object.values(SECRETS), ADMIN_TOKEN]) expect(r.text).not.toContain(v);
    const { RECURRING_JOBS } = await import("./jobs.js");
    if (ok("recurring")) expect(s.jobs.recurring.map((x: any) => x.type).sort()).toEqual(Object.keys(RECURRING_JOBS).sort());
    if (ok("jobs24h")) expect(s.jobs.byType.find((x: any) => x.type === "d1.sysfail")).toMatchObject({ failed24h: 1, queued: 0 });
    if (!ok("recentFailures")) return;
    const f = s.jobs.recentFailures.find((x: any) => x.id === failed.id);
    expect(f).toBeTruthy();
    expect(f.orgName).toBe(`sys ${tag}`);
    expect(f.retryable).toBe(true);
    expect(f.error.length).toBeLessThanOrEqual(200);
    expect(f.error).not.toContain("jane.doe@example.org");
    expect(f.error).toContain("[email]");
  });

  it("POST /v1/admin/jobs/:id/retry requeues a failed job once, audits it, and clears its charge marker", async () => {
    const u = await signup("retry");
    const j = await job({ orgId: u.orgId, type: "d1.retry", status: "failed", attempts: 3, maxAttempts: 3, error: "provider timeout", payload: { leadId: "x", charged_verifications: true } });
    const r = await admin("POST", `/jobs/${j.id}/retry`);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: j.id, type: "d1.retry", status: "queued" });
    const [row] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, j.id));
    expect(row.payload).toEqual({ leadId: "x" });
    expect(row.error === null || /no handler/.test(row.error)).toBe(true);
    // Not failed any more (or failed again only because another file drained the queue: "no handler for d1.retry").
    if (row.status === "queued") expect(row.attempts).toBe(2);
    const audits = await db.select().from(S.auditLog).where(S.and(S.eq(S.auditLog.action, "admin.job_retried"), S.eq(S.auditLog.targetId, j.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].orgId).toBe(u.orgId);
    expect(audits[0].data.previousError).toBe("provider timeout");
    // Only a failed job: once queued, a second retry is refused and nothing more is logged.
    if (row.status === "queued") {
      const again = await admin("POST", `/jobs/${j.id}/retry`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("not_failed");
    }
  });

  it("refuses schedulers, unknown jobs and malformed ids", async () => {
    const sched = await job({ orgId: null, type: "d1.scheduler", status: "failed", attempts: 1, maxAttempts: 1, payload: { recurring: true }, error: "x" });
    const r = await admin("POST", `/jobs/${sched.id}/retry`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("recurring_job");
    const [row] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, sched.id));
    expect(row.status).toBe("failed");
    expect((await admin("POST", `/jobs/${randomUUID()}/retry`)).status).toBe(404);
    expect((await admin("POST", "/jobs/not-a-uuid/retry")).status).toBe(400);
    const running = await job({ type: "d1.running", status: "queued" });
    const q = await admin("POST", `/jobs/${running.id}/retry`);
    expect(q.status).toBe(409);
  });
});
