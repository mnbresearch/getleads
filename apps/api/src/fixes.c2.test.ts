/**
 * Fix round C2: integration auto sync, the inbound address, the reply rules and the campaign
 * "Replied" figure. Each test pins one behaviour the verification pass found wrong.
 *
 * Real app (createApp) and a real database; no request leaves the process: `fetch` is
 * stubbed per test and `fetchPublic` (webhook-style destinations) is replaced by a recorder.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.c2.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.API_URL = "https://api.scout.test";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "INTEGRATION_VERIFY", "AUTO_SYNC_DELAY_SECONDS"]) delete process.env[k];
}

const mocks = vi.hoisted(() => ({ posts: [] as { url: string; body: string }[], hookStatus: 200 }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: `t-${Date.now()}` })) };
});
vi.mock("@prospex/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@prospex/core")>();
  return {
    ...orig,
    fetchPublic: vi.fn(async (url: string, init: { body?: string }) => {
      mocks.posts.push({ url, body: String(init?.body ?? "") });
      return new Response("ok", { status: mocks.hookStatus });
    }),
  };
});

const suite = TEST_DB ? describe : describe.skip;

suite("fix round C2", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let handlers: any;
  let I: typeof import("./services/integrations.js");
  const realFetch = globalThis.fetch;
  const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  const u8 = () => randomUUID().slice(0, 8);

  async function req(method: string, path: string, token?: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }

  async function signup(name: string, plan = "growth") {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password: "correct-horse-battery", orgName: `${name} Co` });
    expect(r.status).toBe(201);
    const o = { token: r.body.token as string, orgId: r.body.org.id as string };
    await db.update(S.organizations).set({ plan, planLimits: S.limitsFor(plan) }).where(S.eq(S.organizations.id, o.orgId));
    return o;
  }

  async function lead(orgId: string, extra: Record<string, unknown> = {}) {
    const [l] = await db.insert(S.leads).values({ orgId, fullName: "Asha Rao", firstName: "Asha", email: `p-${u8()}@prospect.example`, emailStatus: "valid", ...extra }).returning();
    return l;
  }

  const syncJobs = async (orgId: string) => db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, orgId), S.eq(S.jobs.type, "integration.sync")));
  const integ = async (orgId: string, provider: string) => (await db.select().from(S.integrations).where(S.and(S.eq(S.integrations.orgId, orgId), S.eq(S.integrations.provider, provider))))[0];
  const runJob = (orgId: string, payload: Record<string, unknown>, attempts = 1) =>
    handlers["integration.sync"]({ id: randomUUID(), type: "integration.sync", orgId, payload, attempts, maxAttempts: 3 } as never, { db, log: () => {}, progress: async () => {} } as never);
  const newLeadViaApi = async (token: string) => {
    const r = await req("POST", "/v1/leads", token, { fullName: "Auto Sync", email: `auto-${u8()}@prospect.example` });
    expect(r.status).toBeLessThan(300);
    return (r.body.lead?.id ?? r.body.id) as string;
  };

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();
    handlers = (await import("./jobs.js")).handlers;
    I = await import("./services/integrations.js");
  }, 60_000);

  afterEach(() => {
    vi.stubGlobal("fetch", realFetch);
    delete process.env.INTEGRATION_VERIFY;
    delete process.env.JOB_OPEN_TYPE_CAP;
    mocks.hookStatus = 200;
    mocks.posts.length = 0;
    I.resetAutoSyncMemo();
  });

  // ── 1. Auto sync ──
  describe("auto sync", () => {
    it("a burst of new leads arms one batch job, which pushes all of them and moves the cursor", async () => {
      const A = await signup("c2-burst");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" }, autoSync: true });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await newLeadViaApi(A.token));
      const jobs = await syncJobs(A.orgId);
      expect(jobs.length).toBe(1);
      expect(jobs[0].payload).toMatchObject({ batch: true, auto: true });
      // Delayed, so a burst of events is one push.
      expect(new Date(jobs[0].runAt).getTime()).toBeGreaterThan(Date.now() + 5_000);
      const row = await integ(A.orgId, "hubspot");
      expect(row.settings.autoSyncQueuedAt).toBeTruthy();

      const seen: string[] = [];
      vi.stubGlobal("fetch", (async (u: string | URL) => {
        seen.push(String(u));
        return new Response(JSON.stringify({ id: String(seen.length) }), { status: 201 });
      }) as typeof fetch);
      const out = await runJob(A.orgId, jobs[0].payload);
      expect(out).toMatchObject({ pushed: 5, leads: 5 });
      expect(seen.length).toBe(5);
      const after = await integ(A.orgId, "hubspot");
      expect(after.settings.autoSyncQueuedAt).toBeUndefined();
      expect(after.settings.autoSyncCursor).toBeTruthy();
      for (const id of ids) expect((await db.select().from(S.leads).where(S.eq(S.leads.id, id)))[0].custom.hubspot_id).toBeTruthy();
      // Nothing changed since: the next batch pushes nothing.
      expect(await runJob(A.orgId, jobs[0].payload)).toMatchObject({ pushed: 0, leads: 0 });
      // A later change arms a new batch (the flag was released).
      I.resetAutoSyncMemo();
      const { emitEvent } = await import("./lib/events.js");
      await emitEvent(A.orgId, "lead.updated", { id: ids[0] }, { type: "lead", id: ids[0] });
      expect((await syncJobs(A.orgId)).length).toBe(2);
    });

    it("webhook-style destinations (Sheets, Cortex, webhook) get each lead once, not once per change", async () => {
      const A = await signup("c2-once");
      const put = await req("PUT", "/v1/integrations/webhook", A.token, { config: { url: "https://hooks.example.com/scout" }, autoSync: true });
      expect(put.status).toBe(200);
      expect(I.syncOncePerLead("webhook")).toBe(true);
      expect(I.syncOncePerLead("sheets")).toBe(true);
      expect(I.syncOncePerLead("cortex")).toBe(true);
      expect(I.syncOncePerLead("hubspot")).toBe(false);
      const id = await newLeadViaApi(A.token);
      const [job] = await syncJobs(A.orgId);
      expect(await runJob(A.orgId, job.payload)).toMatchObject({ pushed: 1 });
      expect(mocks.posts.length).toBe(1);
      const { emitEvent } = await import("./lib/events.js");
      I.resetAutoSyncMemo();
      await emitEvent(A.orgId, "lead.updated", { id }, { type: "lead", id });
      await emitEvent(A.orgId, "lead.enriched", { id }, { type: "lead", id });
      expect(await runJob(A.orgId, job.payload)).toMatchObject({ pushed: 0, skipped: 1 });
      expect(mocks.posts.length).toBe(1);
    });

    it("a connection whose credentials the provider refused is not auto-synced; one after a network error still is", async () => {
      const A = await signup("c2-refused");
      process.env.INTEGRATION_VERIFY = "true";
      vi.stubGlobal("fetch", (async () => new Response("{}", { status: 401 })) as typeof fetch);
      const bad = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-wrong" }, autoSync: true });
      expect(bad.body).toMatchObject({ status: "error" });
      expect(bad.body.settings.credentialsRejected).toBe(true);
      await newLeadViaApi(A.token);
      expect((await syncJobs(A.orgId)).length).toBe(0);

      const B = await signup("c2-network");
      delete process.env.INTEGRATION_VERIFY;
      await req("PUT", "/v1/integrations/hubspot", B.token, { config: { accessToken: "pat" }, autoSync: true });
      const row = await integ(B.orgId, "hubspot");
      await I.recordIntegrationOutcome(row.id, false, "Could not reach HubSpot (timeout)");
      expect((await integ(B.orgId, "hubspot")).status).toBe("error");
      await newLeadViaApi(B.token);
      expect((await syncJobs(B.orgId)).length).toBe(1);
    });

    it("a batch refused with 401 stops without retrying and pauses auto sync for that connection", async () => {
      const A = await signup("c2-401");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" }, autoSync: true });
      await newLeadViaApi(A.token);
      const [job] = await syncJobs(A.orgId);
      vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ message: "Authentication credentials not found." }), { status: 401 })) as typeof fetch);
      expect(await runJob(A.orgId, job.payload)).toMatchObject({ stopped: "credentials rejected" });
      const row = await integ(A.orgId, "hubspot");
      expect(row.status).toBe("error");
      expect(row.settings.credentialsRejected).toBe(true);
      expect(row.settings.autoSyncQueuedAt).toBeUndefined();
      I.resetAutoSyncMemo();
      await newLeadViaApi(A.token);
      expect((await syncJobs(A.orgId)).length).toBe(1); // only the first one
    });

    it("a network failure retries the batch (cursor unchanged); the last attempt releases the flag", async () => {
      const A = await signup("c2-retry");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" }, autoSync: true });
      await newLeadViaApi(A.token);
      const [job] = await syncJobs(A.orgId);
      const before = (await integ(A.orgId, "hubspot")).settings.autoSyncCursor;
      vi.stubGlobal("fetch", (async () => new Response("{}", { status: 503 })) as typeof fetch);
      await expect(runJob(A.orgId, job.payload, 1)).rejects.toThrow();
      let row = await integ(A.orgId, "hubspot");
      expect(row.settings.autoSyncCursor).toBe(before);
      expect(row.settings.autoSyncQueuedAt).toBeTruthy();
      expect(row.settings.credentialsRejected).toBe(false);
      await expect(runJob(A.orgId, job.payload, 3)).rejects.toThrow();
      row = await integ(A.orgId, "hubspot");
      expect(row.settings.autoSyncQueuedAt).toBeUndefined();
    });

    it("respects the open-job ceiling: a full queue arms nothing and loses nothing", async () => {
      const A = await signup("c2-cap");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" }, autoSync: true });
      process.env.JOB_OPEN_TYPE_CAP = "1";
      await S.enqueue(db, "integration.sync", { integrationId: randomUUID(), leadId: randomUUID() }, { orgId: A.orgId, runAt: new Date(Date.now() + 3600_000) });
      const id = await newLeadViaApi(A.token);
      expect((await syncJobs(A.orgId)).filter((j: any) => j.payload.batch).length).toBe(0);
      expect((await integ(A.orgId, "hubspot")).settings.autoSyncQueuedAt).toBeUndefined();
      // Room again: the next event arms a batch, which still sees the earlier lead.
      delete process.env.JOB_OPEN_TYPE_CAP;
      I.resetAutoSyncMemo();
      const { emitEvent } = await import("./lib/events.js");
      await emitEvent(A.orgId, "lead.updated", { id }, { type: "lead", id });
      const batch = (await syncJobs(A.orgId)).filter((j: any) => j.payload.batch);
      expect(batch.length).toBe(1);
      vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ id: "1" }), { status: 201 })) as typeof fetch);
      expect(await runJob(A.orgId, batch[0].payload)).toMatchObject({ pushed: 1, leads: 1 });
    });

    it("a sync job for a lead that no longer exists finishes as skipped instead of failing", async () => {
      const A = await signup("c2-gone");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" } });
      const row = await integ(A.orgId, "hubspot");
      const l = await lead(A.orgId);
      await db.delete(S.leads).where(S.eq(S.leads.id, l.id));
      expect(await runJob(A.orgId, { integrationId: row.id, leadId: l.id })).toEqual({ skipped: "lead not found" });
      expect(await runJob(A.orgId, { integrationId: row.id, leadId: "not-a-uuid" })).toEqual({ skipped: "lead not found" });
      expect((await integ(A.orgId, "hubspot")).status).toBe("active");
    });
  });

  // ── 2. Inbound address ──
  describe("inbound address", () => {
    it("refuses replies for a suspended workspace and for one scheduled for deletion", async () => {
      const A = await signup("c2-in-susp");
      const tok = (await req("POST", "/v1/inbound-address", A.token, {})).body.token;
      const l = await lead(A.orgId);
      expect((await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: l.email, text: "hi" })).status).toBe(200);
      for (const status of ["deactivated", "revoked"]) {
        await db.update(S.organizations).set({ status }).where(S.eq(S.organizations.id, A.orgId));
        const r = await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: l.email, text: "hi" });
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe("account_suspended");
      }
      await db.update(S.organizations).set({ status: "active" }).where(S.eq(S.organizations.id, A.orgId));
      await db.insert(S.workspaceDeletionRequests).values({ orgId: A.orgId, scheduledFor: new Date(Date.now() + 7 * 86_400_000) });
      const r = await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: l.email, text: "hi" });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("workspace_pending_deletion");
      // The signed-in route follows the same rule.
      const s = await req("POST", "/v1/campaigns/inbound", A.token, { from: l.email, text: "hi" });
      expect(s.status).toBe(403);
      expect(s.body.error.code).toBe("workspace_pending_deletion");
    });

    it("the hourly allowance is counted in the database (holds across instances)", async () => {
      const A = await signup("c2-in-rate");
      const tok = (await req("POST", "/v1/inbound-address", A.token, {})).body.token;
      const { countInboundPost, INBOUND_HOURLY_LIMIT } = await import("./services/inbound.js");
      expect(INBOUND_HOURLY_LIMIT).toBe(300);
      expect((await countInboundPost(A.orgId, 2)).ok).toBe(true);
      expect((await countInboundPost(A.orgId, 2)).ok).toBe(true);
      const third = await countInboundPost(A.orgId, 2);
      expect(third.ok).toBe(false);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
      // As another instance would see it: the count is on the row.
      const row = await integ(A.orgId, "inbound");
      expect(row.settings.rateCount).toBe(3);
      await db.execute(S.sql`UPDATE integrations SET settings = settings || jsonb_build_object('rateCount', 300) WHERE id = ${row.id}`);
      const l = await lead(A.orgId);
      const r = await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: l.email, text: "hi" });
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe("rate_limited");
      // A new clock hour starts from one.
      await db.execute(S.sql`UPDATE integrations SET settings = settings || jsonb_build_object('rateHour', '2000-01-01T00') WHERE id = ${row.id}`);
      expect((await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: l.email, text: "hi" })).status).toBe(200);
    });
  });

  // ── 3. Reply rules ──
  describe("reply rules", () => {
    it("negative replies that contain a positive word are not interested", async () => {
      const { classifyReplyByRules } = await import("./services/replyRules.js");
      for (const t of [
        "No longer interested",
        "Thanks, but I'm not really interested.",
        "We are not at all interested",
        "We don't need a demo, thanks",
        "We do not need this right now",
        "No need, we have it covered",
        "Not a fit for us",
        "Sorry, not for us",
        "I don't want to talk about this",
      ]) {
        expect([t, classifyReplyByRules(t).intent]).toEqual([t, "not_interested"]);
      }
    });

    it("positive replies still classify as interested", async () => {
      const { classifyReplyByRules } = await import("./services/replyRules.js");
      for (const t of ["Sounds interesting, can we talk Thursday?", "Interested - send me pricing", "Happy to chat next week", "Could we book a demo?", "I'd love to hear more", "Yes please", "I don't want to miss this - let's talk"]) {
        expect([t, classifyReplyByRules(t).intent]).toEqual([t, "interested"]);
      }
      expect(classifyReplyByRules("What does it cost?").intent).toBe("question");
      expect(classifyReplyByRules("Please unsubscribe me").intent).toBe("unsubscribe");
    });
  });

  // ── 4. Campaign "Replied" ──
  describe("campaign replied figure", () => {
    it("counts contacts marked replied by hand, the same on the list and the campaign page", async () => {
      const A = await signup("c2-replied");
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "Seq", status: "active" }).returning();
      const l1 = await lead(A.orgId);
      const l2 = await lead(A.orgId);
      const [cc1] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: l1.id, status: "active", currentStep: 1, nextSendAt: new Date(Date.now() + 86_400_000) }).returning();
      await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: l2.id, status: "active", currentStep: 1, nextSendAt: new Date(Date.now() + 86_400_000) });
      await db.insert(S.messages).values([
        { orgId: A.orgId, campaignId: cp.id, leadId: l1.id, direction: "outbound", toEmail: l1.email, subject: "Hi", bodyText: "x", status: "sent", sentAt: new Date() },
        { orgId: A.orgId, campaignId: cp.id, leadId: l2.id, direction: "outbound", toEmail: l2.email, subject: "Hi", bodyText: "x", status: "sent", sentAt: new Date() },
      ]);
      // Marked by hand: no message gets a reply date.
      expect((await req("POST", `/v1/campaigns/${cp.id}/contacts/${cc1.id}/replied`, A.token, { positive: true })).status).toBe(200);
      const stats = await req("GET", `/v1/campaigns/${cp.id}/stats`, A.token);
      expect(stats.status).toBe(200);
      expect(stats.body.messages.replied).toBe(0);
      expect(stats.body.repliedContacts).toBe(1);
      expect(stats.body.contactsReached).toBe(2);
      expect(stats.body.rates.replyContacts).toBe(0.5);
      const list = await req("GET", "/v1/campaigns", A.token);
      const row = list.body.campaigns.find((c: any) => c.id === cp.id);
      expect(row.repliedContacts).toBe(1);
      expect(row.contacts).toBe(2);
    });
  });
});
