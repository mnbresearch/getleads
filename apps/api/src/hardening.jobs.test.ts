/**
 * Regression tests for the background pipeline: sending, quotas, the job queue.
 *
 * Same bootstrap as integration.test.ts: DB-backed, skipped (loudly) without
 * TEST_DATABASE_URL. The mailer is replaced with a controllable stub, so these tests can
 * make a send fail, bounce, or succeed without touching any provider.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  process.env.SMTP_PROBE_ENABLED = "false";
}

if (!TEST_DB) {
  process.stderr.write(`\n[!] "hardening: jobs and sending" did NOT run: TEST_DATABASE_URL is not set.\n`);
}

/** What the stubbed mailer does, per test. Default: accept everything. */
const mail = vi.hoisted(() => ({
  impl: null as null | ((input: { to: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; provider: string; providerMessageId?: string; error?: string }>),
  calls: [] as { to: string; subject: string; headers?: Record<string, string> }[],
}));

vi.mock("./lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...actual,
    sendMail: async (_cfg: unknown, input: { to: string; subject: string; headers?: Record<string, string> }) => {
      mail.calls.push(input);
      if (mail.impl) return mail.impl(input);
      return { ok: true, provider: "test", providerMessageId: `test-${randomUUID()}` };
    },
  };
});

const suite = TEST_DB ? describe : describe.skip;

suite("hardening: jobs and sending", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let schema: any;
  let core: any;
  let campaignsSvc: any;
  let jobHandlers: any;

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    schema = dbPkg;
    db = dbPkg.getDb().db;
    core = await import("@prospex/core");
    campaignsSvc = await import("./services/campaigns.js");
    ({ handlers: jobHandlers } = await import("./jobs.js"));
  }, 60_000);

  afterEach(() => {
    mail.impl = null;
    mail.calls = [];
    vi.restoreAllMocks();
  });

  const uid = () => randomUUID().slice(0, 8);
  const ALL_DAY = { timezone: "UTC", sendWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } };

  async function newOrg(name = "h", patch: Record<string, unknown> = {}) {
    const [org] = await db.insert(schema.organizations).values({ name, slug: `${name}-${uid()}`, ...patch }).returning();
    return org;
  }

  async function newAccount(orgId: string, dailyLimit = 500) {
    const [acct] = await db.insert(schema.emailAccounts).values({ orgId, provider: "system", fromName: "T", fromEmail: `t-${uid()}@example.com`, dailyLimit }).returning();
    // Old enough that warm-up does not bind.
    await db.execute(schema.sql`UPDATE email_accounts SET created_at = now() - interval '120 days' WHERE id = ${acct.id}`);
    return (await db.query.emailAccounts.findFirst({ where: schema.eq(schema.emailAccounts.id, acct.id) }))!;
  }

  /** An org with a sending account, an active campaign and a plain (non-AI) email step. */
  async function setup(opts: { dailyLimit?: number; campaignPatch?: Record<string, unknown>; steps?: number; aiPersonalize?: boolean; orgPatch?: Record<string, unknown> } = {}) {
    const org = await newOrg("send", opts.orgPatch);
    const acct = await newAccount(org.id, opts.dailyLimit ?? 500);
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active", settings: { ...ALL_DAY, dailyLimit: 500 }, ...(opts.campaignPatch ?? {}) })
      .returning();
    const steps = [];
    for (let i = 1; i <= (opts.steps ?? 1); i++) {
      const [st] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: i, channel: "email", subjectTemplate: `Hi ${i}`, bodyTemplate: `Hello ${i}`, aiPersonalize: opts.aiPersonalize ?? false }).returning();
      steps.push(st);
    }
    return { org, acct, campaign, steps, step: steps[0] };
  }

  async function newContact(orgId: string, campaignId: string, patch: Record<string, unknown> = {}, leadPatch: Record<string, unknown> = {}) {
    const [lead] = await db.insert(schema.leads).values({ orgId, email: `p-${uid()}@example.com`, fullName: "P", emailStatus: "valid", ...leadPatch }).returning();
    const [cc] = await db.insert(schema.campaignContacts).values({ campaignId, leadId: lead.id, status: "active", currentStep: 0, ...patch }).returning();
    return { lead, cc };
  }

  const contact = (id: string) => db.query.campaignContacts.findFirst({ where: schema.eq(schema.campaignContacts.id, id) });
  const usageOf = async (orgId: string, metric: string) =>
    (await db.select().from(schema.usage).where(schema.and(schema.eq(schema.usage.orgId, orgId), schema.eq(schema.usage.metric, metric))))[0]?.count ?? 0;
  const setUsage = (orgId: string, metric: string, count: number) =>
    db.insert(schema.usage).values({ orgId, period: schema.currentPeriod(), metric, count }).onConflictDoUpdate({ target: [schema.usage.orgId, schema.usage.period, schema.usage.metric], set: { count } });

  // ── 2: a plan limit is terminal, and a retry does not do the work for free ──

  describe("quota refusals end the job instead of being retried for free", () => {
    it("a send over the monthly email limit waits for tomorrow with a reason, on every attempt", async () => {
      const { org, campaign, step } = await setup({ orgPatch: { planLimits: { emailsPerMonth: 1 } } });
      await setUsage(org.id, "emails", 1);
      const { cc } = await newContact(org.id, campaign.id);

      for (const attempt of [1, 2]) {
        const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt });
        expect(r.skipped).toBe("quota");
      }
      expect(mail.calls).toHaveLength(0);
      const after = await contact(cc.id);
      expect(after.status).toBe("queued");
      expect(after.lastError).toMatch(/monthly email limit/i);
      expect(after.nextSendAt.getTime()).toBeGreaterThan(Date.now());
      expect(await usageOf(org.id, "emails")).toBe(1);
    });

    it("lead.verify over the verification limit completes as skipped, and its retry does not verify free", async () => {
      const org = await newOrg("verify-quota", { planLimits: { verificationsPerMonth: 1 } });
      await setUsage(org.id, "verifications", 1);
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `v-${uid()}@example.com` }).returning();
      const spy = vi.spyOn(core, "verifyEmail");
      for (const attempts of [1, 2]) {
        const r = await jobHandlers["lead.verify"]({ id: randomUUID(), type: "lead.verify", payload: { leadId: lead.id }, attempts, maxAttempts: 3 }, { db, log: () => {} });
        expect(r.skipped).toBe("quota");
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it("lead.verify charges once across retries and records which verifier answered", async () => {
      const org = await newOrg("verify-once");
      const [lead] = await db.insert(schema.leads).values({ orgId: org.id, email: `v-${uid()}@example.com` }).returning();
      const [jobRow] = await db.insert(schema.jobs).values({ type: "lead.verify", payload: { leadId: lead.id }, status: "running" }).returning();
      let calls = 0;
      vi.spyOn(core, "verifyEmail").mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error("verifier timed out");
        return { email: lead.email, status: "valid", confidence: 0.95, checks: {}, reason: "reoon:safe", verifiedBy: "reoon:safe" } as never;
      });
      const job = { ...jobRow, attempts: 1, maxAttempts: 3 };
      await expect(jobHandlers["lead.verify"](job, { db, log: () => {} })).rejects.toThrow(/timed out/);
      // The retry is a fresh read of the row, as the queue would hand it over.
      const reread = await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, jobRow.id) });
      const r = await jobHandlers["lead.verify"]({ ...reread, attempts: 2, maxAttempts: 3 }, { db, log: () => {} });
      expect(r.status).toBe("valid");
      expect(await usageOf(org.id, "verifications")).toBe(1);
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(after.emailVerifiedBy).toBe("reoon:safe");
      expect(after.verifiedAt).not.toBeNull();
    });
  });

  // ── 3: the daily cap holds under concurrency, and the tick counts in-flight sends ──

  describe("the daily sending cap", () => {
    it("holds when nine sends race for a cap of three", async () => {
      const { org, acct, campaign, step } = await setup({ dailyLimit: 3 });
      const contacts = await Promise.all(Array.from({ length: 9 }, () => newContact(org.id, campaign.id)));
      const results = await Promise.all(contacts.map(({ cc }) => campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 })));
      expect(results.filter((r: any) => r.sent)).toHaveLength(3);
      expect(mail.calls).toHaveLength(3);
      const a = await db.query.emailAccounts.findFirst({ where: schema.eq(schema.emailAccounts.id, acct.id) });
      expect(a.sentToday).toBe(3);
      // The six that did not fit are waiting for tomorrow, uncharged.
      expect(results.filter((r: any) => r.skipped === "daily limit reached")).toHaveLength(6);
      expect(await usageOf(org.id, "emails")).toBe(3);
    });

    it("does not re-spend the budget on sends already queued", async () => {
      const { org, campaign } = await setup({ dailyLimit: 4 });
      for (let i = 0; i < 10; i++) await newContact(org.id, campaign.id, { status: "queued", nextSendAt: new Date(Date.now() - 1000) });
      const first = await campaignsSvc.tickCampaign(campaign.id);
      expect(first.sent).toBe(4);
      // Nothing has been sent yet - the four jobs are still queued. The old budget ignored
      // them and enqueued four more every tick.
      const second = await campaignsSvc.tickCampaign(campaign.id);
      expect(second.sent).toBe(0);
    });

    it("keys the cap on the campaign's local date", () => {
      // 2026-10-02 03:00 UTC is still Oct 1 in New York.
      const t = new Date("2026-10-02T03:00:00Z");
      expect(campaignsSvc.localDate("America/New_York", t)).toBe("2026-10-01");
      expect(campaignsSvc.localDate("UTC", t)).toBe("2026-10-02");
    });
  });

  // ── 4: only contacts still in the sequence, and only the campaign client's leads ──

  describe("who may be sent to", () => {
    it("does not send to a contact that is completed, failed or reassigned", async () => {
      const { org, campaign, step } = await setup();
      for (const status of ["completed", "failed", "reassigned"]) {
        const { cc } = await newContact(org.id, campaign.id, { status });
        const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
        expect(r.skipped).toBe(status);
      }
      expect(mail.calls).toHaveLength(0);
    });

    it("does not email a lead that now belongs to another client", async () => {
      const org = await newOrg("client-send");
      const [a] = await db.insert(schema.clients).values({ orgId: org.id, name: "A" }).returning();
      const [b] = await db.insert(schema.clients).values({ orgId: org.id, name: "B" }).returning();
      const acct = await newAccount(org.id);
      const [campaign] = await db.insert(schema.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active", clientId: a.id, settings: ALL_DAY }).returning();
      const [step] = await db.insert(schema.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello", aiPersonalize: false }).returning();
      const { cc } = await newContact(org.id, campaign.id, {}, { clientId: b.id });
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.skipped).toMatch(/another client/);
      expect(mail.calls).toHaveLength(0);
      expect((await contact(cc.id)).status).toBe("reassigned");
    });
  });

  // ── 5: nobody is left "active" with nothing to pick them up ──

  describe("stranded contacts", () => {
    it("puts a contact back in the queue when its send finds the campaign paused", async () => {
      const { org, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id, { status: "active", nextSendAt: null });
      await db.update(schema.campaigns).set({ status: "paused" }).where(schema.eq(schema.campaigns.id, campaign.id));
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.skipped).toMatch(/not active/);
      const after = await contact(cc.id);
      expect(after.status).toBe("queued");
      expect(after.nextSendAt).not.toBeNull();

      // Resumed: the next tick picks it up again.
      await db.update(schema.campaigns).set({ status: "active" }).where(schema.eq(schema.campaigns.id, campaign.id));
      const tick = await campaignsSvc.tickCampaign(campaign.id);
      expect(tick.sent).toBe(1);
    });

    it("requeues a contact whose send job is gone, but not one waiting on a person", async () => {
      const { org, campaign } = await setup();
      const { cc: lost } = await newContact(org.id, campaign.id, { status: "active", nextSendAt: null });
      const { cc: waiting, lead } = await newContact(org.id, campaign.id, { status: "active", nextSendAt: null });
      await db.insert(schema.tasks).values({ orgId: org.id, leadId: lead.id, campaignId: campaign.id, contactId: waiting.id, type: "call", title: "Call" });
      await db.execute(schema.sql`UPDATE campaign_contacts SET updated_at = now() - interval '10 minutes' WHERE campaign_id = ${campaign.id}`);

      const n = await campaignsSvc.requeueStrandedContacts(campaign.id);
      expect(n).toBe(1);
      expect((await contact(lost.id)).status).toBe("queued");
      expect((await contact(waiting.id)).status).toBe("active");
    });

    it("sends the template when AI personalization fails, instead of stranding the contact", async () => {
      const { org, campaign, step } = await setup({ aiPersonalize: true });
      const { cc } = await newContact(org.id, campaign.id);
      vi.spyOn(core, "generateOutreach").mockRejectedValue(new Error("model overloaded"));
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.sent).toBe(true);
      expect(mail.calls[0].subject).toBe("Hi 1");
      expect((await contact(cc.id)).lastError).toMatch(/AI personalization failed/);
    });
  });

  // ── 6: failed sends retry a bounded number of times and are not billed ──

  describe("failed sends", () => {
    it("stops a contact after three failures in a row, without charging for any of them", async () => {
      const { org, acct, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id);
      mail.impl = async () => ({ ok: false, provider: "test", error: "connection timed out" });
      for (let i = 1; i <= 3; i++) {
        const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
        expect(r.failed).toBe(true);
        const mid = await contact(cc.id);
        expect(mid.sendFailures).toBe(i);
        if (i < 3) {
          expect(mid.status).toBe("queued");
          // As the tick would: hand it to the next send.
          await db.update(schema.campaignContacts).set({ status: "active", nextSendAt: null }).where(schema.eq(schema.campaignContacts.id, cc.id));
        }
      }
      const after = await contact(cc.id);
      expect(after.status).toBe("failed");
      expect(after.lastError).toMatch(/timed out/);
      expect(await usageOf(org.id, "emails")).toBe(0);
      const a = await db.query.emailAccounts.findFirst({ where: schema.eq(schema.emailAccounts.id, acct.id) });
      expect(a.sentToday).toBe(0);
    });

    it("resets the failure count once a send goes through", async () => {
      const { org, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id, { sendFailures: 2, lastError: "earlier" });
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.sent).toBe(true);
      const after = await contact(cc.id);
      expect(after.sendFailures).toBe(0);
      expect(after.lastError).toBeNull();
      expect(await usageOf(org.id, "emails")).toBe(1);
    });

    it("sends one-click unsubscribe headers", async () => {
      const { org, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id);
      await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(mail.calls[0].headers?.["List-Unsubscribe"]).toMatch(/^<https?:\/\/.+\/t\/u\/.+>, <mailto:/);
      expect(mail.calls[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    });
  });

  // ── 7: bounces are recorded ──

  describe("bounces", () => {
    it("treats a permanent SMTP rejection as a hard bounce", async () => {
      const { org, campaign, step } = await setup();
      const { cc, lead } = await newContact(org.id, campaign.id);
      mail.impl = async () => ({ ok: false, provider: "smtp", error: "Can't send mail - all recipients were rejected: 550 5.1.1 <x>: user unknown" });
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.bounced).toBe(true);
      const msg = await db.query.messages.findFirst({ where: schema.eq(schema.messages.campaignId, campaign.id) });
      expect(msg.bouncedAt).not.toBeNull();
      expect((await contact(cc.id)).status).toBe("bounced");
      const sup = await db.query.suppressions.findFirst({ where: schema.and(schema.eq(schema.suppressions.orgId, org.id), schema.eq(schema.suppressions.email, lead.email)) });
      expect(sup?.reason).toBe("bounce");
      const l = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(l.emailStatus).toBe("invalid");
    });

    it("does not call a transient failure a bounce", () => {
      expect(campaignsSvc.isHardBounce("421 4.7.0 try again later")).toBe(false);
      expect(campaignsSvc.isHardBounce("connect ETIMEDOUT")).toBe(false);
      expect(campaignsSvc.isHardBounce("554 5.7.1 rejected")).toBe(true);
    });

    describe("the provider webhook", () => {
      const secretKey = Buffer.from("test-webhook-secret-key-123456").toString("base64");
      const secret = `whsec_${secretKey}`;
      const sign = (id: string, ts: string, body: string) => `v1,${createHmac("sha256", Buffer.from(secretKey, "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

      async function post(body: string, headers: Record<string, string>) {
        const { emailEventRoutes } = await import("./routes/emailEvents.js");
        return emailEventRoutes.request("/resend", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
      }

      it("refuses everything when no secret is configured, and a bad signature always", async () => {
        delete process.env.RESEND_WEBHOOK_SECRET;
        expect((await post("{}", {})).status).toBe(503);
        process.env.RESEND_WEBHOOK_SECRET = secret;
        const ts = String(Math.floor(Date.now() / 1000));
        expect((await post("{}", { "svix-id": "m1", "svix-timestamp": ts, "svix-signature": "v1,AAAA" })).status).toBe(401);
      });

      it("records a bounce reported after delivery", async () => {
        process.env.RESEND_WEBHOOK_SECRET = secret;
        const { org, campaign, step } = await setup();
        const { cc, lead } = await newContact(org.id, campaign.id);
        const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
        const msg = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, r.messageId) });
        const body = JSON.stringify({ type: "email.bounced", data: { email_id: msg.providerMessageId, to: [lead.email], bounce: { type: "Permanent", message: "mailbox does not exist" } } });
        const ts = String(Math.floor(Date.now() / 1000));
        const res = await post(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign("msg_1", ts, body) });
        expect(res.status).toBe(200);
        const after = await db.query.messages.findFirst({ where: schema.eq(schema.messages.id, msg.id) });
        expect(after.bouncedAt).not.toBeNull();
        const sup = await db.query.suppressions.findFirst({ where: schema.and(schema.eq(schema.suppressions.orgId, org.id), schema.eq(schema.suppressions.email, lead.email)) });
        expect(sup?.reason).toBe("bounce");
      });
    });
  });

  // ── 9: rediscovery does not overwrite what a person edited ──

  describe("rediscovering a lead", () => {
    let upsertLead: any;
    beforeAll(async () => {
      ({ upsertLead } = await import("./services/leads.js"));
    });

    it("merges tags and custom fields and keeps edited fields", async () => {
      const org = await newOrg("rediscover");
      const email = `r-${uid()}@example.com`;
      await upsertLead(org.id, { email, fullName: "Priya Sharma", title: "Head of Growth (edited)", tags: ["vip"], custom: { note: "met at conf" }, emailStatus: "valid" });
      const { lead, created } = await upsertLead(org.id, { email, fullName: "P. Sharma", title: "Growth", tags: ["search:abc"], custom: { signalId: "s1" }, emailStatus: "unknown" }, { fillOnly: true });
      expect(created).toBe(false);
      expect(lead.title).toBe("Head of Growth (edited)");
      expect(lead.fullName).toBe("Priya Sharma");
      expect(new Set(lead.tags)).toEqual(new Set(["vip", "search:abc"]));
      expect(lead.custom).toMatchObject({ note: "met at conf", signalId: "s1" });
      expect(lead.emailStatus).toBe("valid");
    });

    it("keeps a working email when a rediscovery carries a guess", async () => {
      const org = await newOrg("rediscover-email");
      const li = `https://www.linkedin.com/in/x-${uid()}`;
      const mine = `m-${uid()}@example.com`;
      await upsertLead(org.id, { email: mine, linkedinUrl: li, emailStatus: "valid", fullName: "A" });
      // A scrape matched by LinkedIn, carrying a guessed address: ignored.
      const a = await upsertLead(org.id, { linkedinUrl: li, email: `guess-${uid()}@example.com`, emailStatus: "risky" }, { fillOnly: true });
      expect(a.lead.email).toBe(mine);
      expect(a.lead.emailStatus).toBe("valid");
    });

    it("upgrades an unknown email only to a verified one", async () => {
      const org = await newOrg("rediscover-upgrade");
      const li = `https://www.linkedin.com/in/y-${uid()}`;
      await upsertLead(org.id, { email: `old-${uid()}@example.com`, linkedinUrl: li, emailStatus: "unknown", fullName: "A" });
      const better = `new-${uid()}@example.com`;
      const r = await upsertLead(org.id, { linkedinUrl: li, email: better, emailStatus: "valid" }, { fillOnly: true });
      expect(r.lead.email).toBe(better);
    });
  });

  // ── 10, 11: finding a replacement email ──

  describe("finding an email for a lead", () => {
    async function leadWithCompany(orgId: string, patch: Record<string, unknown>) {
      const [co] = await db.insert(schema.companies).values({ orgId, name: "Acme", domain: `acme-${uid()}.test`, enrichedAt: new Date() }).returning();
      const [lead] = await db.insert(schema.leads).values({ orgId, firstName: "Ann", lastName: "Lee", fullName: "Ann Lee", companyId: co.id, ...patch }).returning();
      return lead;
    }
    const run = (leadId: string, payload: Record<string, unknown> = {}) =>
      jobHandlers["lead.enrich"]({ id: randomUUID(), type: "lead.enrich", payload: { leadId, ...payload }, attempts: 1, maxAttempts: 3 }, { db, log: () => {} });

    it("never brings back an address already known bad, and passes the exclusions to the finder", async () => {
      const org = await newOrg("replace");
      const bad = `old-${uid()}@acme.test`;
      const lead = await leadWithCompany(org.id, { email: `cur-${uid()}@acme.test`, emailStatus: "invalid", custom: { invalidEmails: [bad] } });
      const spy = vi.spyOn(core, "findEmail").mockResolvedValue({ email: bad, status: "valid", confidence: 0.9, candidates: [], verifiedBy: "reoon:safe" } as never);
      await run(lead.id, { replaceInvalid: true });
      const opts = spy.mock.calls[0][1] as { exclude?: string[] };
      expect(opts.exclude).toEqual(expect.arrayContaining([bad, lead.email]));
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(after.email).toBe(lead.email);
      expect(after.custom.replacementResult).toBeTruthy();
    });

    it("does not stamp an unverified guess as verified", async () => {
      const org = await newOrg("replace-guess");
      const lead = await leadWithCompany(org.id, { email: `cur-${uid()}@acme.test`, emailStatus: "invalid" });
      const guess = `ann.lee-${uid()}@acme.test`;
      vi.spyOn(core, "findEmail").mockResolvedValue({ email: guess, status: "risky", confidence: 0.35, candidates: [] } as never);
      await run(lead.id, { replaceInvalid: true });
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(after.email).toBe(guess);
      expect(after.verifiedAt).toBeNull();
      expect(after.emailVerifiedBy).toBeNull();
    });

    it("does not crash when the found address belongs to another lead", async () => {
      const org = await newOrg("enrich-taken");
      const taken = `taken-${uid()}@acme.test`;
      await db.insert(schema.leads).values({ orgId: org.id, email: taken, fullName: "Other" });
      const lead = await leadWithCompany(org.id, {});
      vi.spyOn(core, "findEmail").mockResolvedValue({ email: taken, status: "valid", confidence: 0.9, candidates: [], verifiedBy: "smtp" } as never);
      const r = await run(lead.id);
      expect(r).toBeTruthy();
      const after = await db.query.leads.findFirst({ where: schema.eq(schema.leads.id, lead.id) });
      expect(after.email).toBeNull();
      expect(JSON.stringify(after.custom)).toMatch(/another lead/);
    });
  });

  // ── 13, 15: the queue ──

  describe("the job queue", () => {
    it("fails a stale job that has used its attempts instead of requeueing it forever", async () => {
      const old = new Date(Date.now() - 20 * 60_000);
      const [spent] = await db.insert(schema.jobs).values({ type: `t.${uid()}`, status: "running", attempts: 3, maxAttempts: 3, lockedAt: old, lockedBy: "dead" }).returning();
      const [fresh] = await db.insert(schema.jobs).values({ type: `t.${uid()}`, status: "running", attempts: 1, maxAttempts: 3, lockedAt: old, lockedBy: "dead" }).returning();
      await schema.reapStaleJobs(db);
      const a = await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, spent.id) });
      const b = await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, fresh.id) });
      expect(a.status).toBe("failed");
      expect(b.status).toBe("queued");
    });

    it("does not let a worker that lost its lock overwrite the new owner's run", async () => {
      const [j] = await db.insert(schema.jobs).values({ type: `t.${uid()}`, status: "running", attempts: 1, lockedAt: new Date(), lockedBy: "worker-b" }).returning();
      expect(await schema.completeJob(db, j.id, { from: "a" }, "worker-a")).toBe(false);
      const still = await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, j.id) });
      expect(still.status).toBe("running");
      expect(await schema.completeJob(db, j.id, { from: "b" }, "worker-b")).toBe(true);
    });

    it("refreshes the lock while a job runs, so a long job is not reaped mid-run", async () => {
      const type = `t.${uid()}`;
      const [j] = await db.insert(schema.jobs).values({ type, status: "running", attempts: 1, lockedAt: new Date(Date.now() - 14 * 60_000), lockedBy: "w1" }).returning();
      let seen: Date | null = null;
      const handlers = {
        [type]: async (_job: unknown, ctx: any) => {
          await ctx.progress(50);
          seen = (await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, j.id) })).lockedAt;
          return { ok: true };
        },
      };
      await schema.runJob(db, { ...j, lockedBy: "w1" }, handlers, () => {});
      expect(seen!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await db.query.jobs.findFirst({ where: schema.eq(schema.jobs.id, j.id) })).status).toBe("done");
    });

    it("claims a scheduler before a pile of higher-priority work", async () => {
      const busy = `busy.${uid()}`;
      const sched = `sched.${uid()}`;
      for (let i = 0; i < 3; i++) await schema.enqueue(db, busy, {}, { priority: 4 });
      await db.insert(schema.jobs).values({ type: sched, payload: { recurring: true }, priority: 0 });
      const claimed = await schema.claimJob(db, "w-test", [busy, sched]);
      expect(claimed.type).toBe(sched);
    });
  });

  // ── 16: out-of-office replies, and stopOnReply ──

  describe("replies", () => {
    it("does not stop a sequence for an out-of-office reply; it waits a few days", async () => {
      const { org, campaign } = await setup();
      const { cc, lead } = await newContact(org.id, campaign.id, { status: "active", nextSendAt: new Date() });
      await campaignsSvc.markReplied(org.id, lead.email, "other", { subject: "Automatic reply: Quick question", text: "I am out of the office until Monday." });
      const after = await contact(cc.id);
      expect(after.status).toBe("active");
      expect(after.nextSendAt.getTime()).toBeGreaterThan(Date.now() + 2.5 * 86_400_000);
      const c = await db.query.campaigns.findFirst({ where: schema.eq(schema.campaigns.id, campaign.id) });
      expect(c.stats.replied ?? 0).toBe(0);
    });

    it("honours stopOnReply: false, and still stops by default", async () => {
      const keepGoing = await setup({ campaignPatch: { settings: { ...ALL_DAY, stopOnReply: false } } });
      const a = await newContact(keepGoing.org.id, keepGoing.campaign.id, { status: "active", nextSendAt: new Date() });
      await campaignsSvc.markReplied(keepGoing.org.id, a.lead.email, "interested");
      expect((await contact(a.cc.id)).status).toBe("active");

      const stops = await setup();
      const b = await newContact(stops.org.id, stops.campaign.id, { status: "active", nextSendAt: new Date() });
      await campaignsSvc.markReplied(stops.org.id, b.lead.email, "interested");
      expect((await contact(b.cc.id)).status).toBe("replied");
    });
  });

  // ── 18, 20: lead charges ──

  function fakeLeads(n: number, prefix = uid()) {
    return Array.from({ length: n }, (_, i) => ({
      firstName: "F",
      lastName: `L${i}`,
      fullName: `F L${i}`,
      title: "VP Sales",
      email: `${prefix}-${i}@example.com`,
      emailStatus: "valid",
      emailConfidence: 0.9,
      linkedinUrl: `https://www.linkedin.com/in/${prefix}-${i}`,
      source: "web",
      score: 90,
      confidence: 0.8,
    }));
  }

  describe("charging for leads", () => {
    it("an autopilot is not billed again for people it found yesterday", async () => {
      const org = await newOrg("ap");
      const [ap] = await db.insert(schema.autopilots).values({ orgId: org.id, name: "A", query: { query: "x" }, dailyLeads: 10, minScore: 0, requireValidEmail: false }).returning();
      const found = fakeLeads(2);
      vi.spyOn(core, "runLeadPipelineDetailed").mockResolvedValue({ leads: found, providerFailures: [] } as never);
      const { runAutopilot } = await import("./services/autopilot.js");
      const first = await runAutopilot(ap);
      expect(first.saved).toBe(2);
      const second = await runAutopilot((await db.query.autopilots.findFirst({ where: schema.eq(schema.autopilots.id, ap.id) }))!);
      expect(second.saved).toBe(0);
      expect(await usageOf(org.id, "leads")).toBe(2);
    });

    it("a retried search does not charge again for the leads its first attempt saved", async () => {
      const org = await newOrg("search-retry");
      const [search] = await db.insert(schema.searches).values({ orgId: org.id, query: { query: "x" } }).returning();
      vi.spyOn(core, "runLeadPipelineDetailed").mockResolvedValue({ leads: fakeLeads(3), providerFailures: [] } as never);
      const job = (attempts: number) => ({ id: randomUUID(), orgId: org.id, type: "search.run", payload: { searchId: search.id, query: { query: "x" } }, attempts, maxAttempts: 3 });
      const ctx = { db, log: () => {}, progress: async () => {} };
      await jobHandlers["search.run"](job(1), ctx);
      const r = await jobHandlers["search.run"](job(2), ctx);
      expect(r.results).toBe(3);
      expect(await usageOf(org.id, "leads")).toBe(3);
    });

    it("says so when nothing came back because the sources could not answer", async () => {
      const org = await newOrg("search-blocked");
      const [search] = await db.insert(schema.searches).values({ orgId: org.id, query: { query: "x" } }).returning();
      vi.spyOn(core, "runLeadPipelineDetailed").mockResolvedValue({ leads: [], providerFailures: [{ provider: "web_search", message: "rate limited" }] } as never);
      await jobHandlers["search.run"]({ id: randomUUID(), orgId: org.id, type: "search.run", payload: { searchId: search.id, query: { query: "x" } }, attempts: 1, maxAttempts: 3 }, { db, log: () => {}, progress: async () => {} });
      const after = await db.query.searches.findFirst({ where: schema.eq(schema.searches.id, search.id) });
      expect(after.error).toMatch(/could not answer/);
    });
  });

  // ── 22: timezones ──

  describe("send windows", () => {
    const settings = (patch: Record<string, unknown>) => ({ dailyLimit: 50, timezone: "UTC", sendWindow: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }, stopOnReply: true, trackOpens: true, trackClicks: true, unsubscribeFooter: true, ...patch });
    const thu10 = new Date("2026-10-01T10:00:00Z");

    it("never sends around the clock because of a bad timezone", () => {
      expect(campaignsSvc.inSendWindow(settings({ timezone: "Mars/Olympus" }), thu10)).toBe(false);
    });

    it("compares times as times, so 9:00 without a leading zero works", () => {
      expect(campaignsSvc.inSendWindow(settings({ sendWindow: { start: "9:00", end: "18:00", days: [4] } }), thu10)).toBe(true);
      expect(campaignsSvc.inSendWindow(settings({ sendWindow: { start: "11:00", end: "18:00", days: [4] } }), thu10)).toBe(false);
    });

    it("pauses a campaign with an unknown timezone and says why", async () => {
      const { campaign } = await setup({ campaignPatch: { settings: { ...ALL_DAY, timezone: "Not/AZone" } } });
      const r = await campaignsSvc.tickCampaign(campaign.id);
      expect(r.reason).toMatch(/invalid timezone/);
      expect((await db.query.campaigns.findFirst({ where: schema.eq(schema.campaigns.id, campaign.id) })).status).toBe("paused");
    });
  });

  // ── 25: suspended orgs ──

  describe("suspended workspaces", () => {
    it("send nothing and run no ticks", async () => {
      const { org, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id, { status: "queued", nextSendAt: new Date(Date.now() - 1000) });
      await db.update(schema.organizations).set({ status: "deactivated" }).where(schema.eq(schema.organizations.id, org.id));
      expect((await campaignsSvc.tickCampaign(campaign.id)).reason).toMatch(/organization not active/);
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      expect(r.skipped).toMatch(/organization not active/);
      expect(mail.calls).toHaveLength(0);
      // Still queued for if the workspace is reactivated, not lost.
      expect((await contact(cc.id)).status).toBe("queued");
    });
  });

  // ── 26: signals stay in their org; job_change subscriptions match ──

  describe("signal subscriptions", () => {
    it("matches global signals and the org's own, never another org's", async () => {
      const a = await newOrg("sig-a");
      const b = await newOrg("sig-b");
      const [mine] = await db.insert(schema.signals).values({ orgId: a.id, type: "job_change", title: "Ann moved to Globex", companyName: "Globex", url: `scout:test/${uid()}` }).returning();
      const [theirs] = await db.insert(schema.signals).values({ orgId: b.id, type: "job_change", title: "Bob moved to Initech", companyName: "Initech", url: `scout:test/${uid()}` }).returning();
      const [global] = await db.insert(schema.signals).values({ orgId: null, type: "funding", title: "Acme raises Series A", companyName: "Acme", url: `https://news.test/${uid()}` }).returning();
      const scan = vi.spyOn(core, "scanSignals").mockResolvedValue([] as never);
      const [sub] = await db.insert(schema.signalSubscriptions).values({ orgId: a.id, name: "S", types: ["job_change", "funding"] }).returning();
      const { runSubscription } = await import("./services/signals.js");
      await runSubscription(sub);
      // The news scanner is asked only for what it can find.
      expect((scan.mock.calls[0][0] as { types: string[] }).types).toEqual(["funding"]);
      const matched = (await db.select().from(schema.signalMatches).where(schema.eq(schema.signalMatches.subscriptionId, sub.id))).map((m: any) => m.signalId);
      expect(matched).toContain(mine.id);
      expect(matched).toContain(global.id);
      expect(matched).not.toContain(theirs.id);
    });
  });
});
