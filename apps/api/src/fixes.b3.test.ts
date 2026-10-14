/**
 * Fix round B3: campaigns, replies, integrations, webhooks, plan limits and the wording of
 * "there is no AI". Each test pins one behaviour that the audit found missing or wrong.
 *
 * Real app (createApp) and a real database; no request leaves the process: `fetch` is
 * stubbed per test and `fetchPublic` (webhook delivery) is replaced by a recorder.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.b3.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

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
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "INTEGRATION_VERIFY"]) delete process.env[k];
}

const mocks = vi.hoisted(() => ({
  posts: [] as { url: string; headers: Record<string, string>; body: string }[],
  hookStatus: 200,
}));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: `t-${Date.now()}` })) };
});
// Webhook deliveries go through fetchPublic: recorded here, answered with mocks.hookStatus.
vi.mock("@prospex/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@prospex/core")>();
  return {
    ...orig,
    fetchPublic: vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      mocks.posts.push({ url, headers: { ...(init?.headers ?? {}) }, body: String(init?.body ?? "") });
      return new Response("ok", { status: mocks.hookStatus });
    }),
  };
});

const suite = TEST_DB ? describe : describe.skip;

suite("fix round B3", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  const realFetch = globalThis.fetch;
  const ip = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  const u8 = () => randomUUID().slice(0, 8);

  async function req(method: string, path: string, token?: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip() },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }

  async function signup(name: string, plan?: string) {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password: "correct-horse-battery", orgName: `${name} Co` });
    expect(r.status).toBe(201);
    const o = { token: r.body.token as string, orgId: r.body.org.id as string, email };
    if (plan) await db.update(S.organizations).set({ plan, planLimits: S.limitsFor(plan) }).where(S.eq(S.organizations.id, o.orgId));
    return o;
  }

  async function lead(orgId: string, extra: Record<string, unknown> = {}) {
    const [l] = await db.insert(S.leads).values({ orgId, fullName: "Asha Rao", firstName: "Asha", email: `p-${u8()}@prospect.example`, emailStatus: "valid", ...extra }).returning();
    return l;
  }

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 60_000);

  afterEach(() => {
    vi.stubGlobal("fetch", realFetch);
    delete process.env.INTEGRATION_VERIFY;
    mocks.hookStatus = 200;
  });

  // ── 1. Replies through the workspace's secret inbound address ──
  describe("inbound address", () => {
    it("is made once, stored only as a hash, records a reply without sign-in, and stops the sequence", async () => {
      const A = await signup("b3-inbound", "growth");
      const made = await req("POST", "/v1/inbound-address", A.token, {});
      expect(made.status).toBe(201);
      const token = made.body.token as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.body.url).toBe(`https://api.scout.test/v1/public/inbound/${token}`);
      // Only the hash is stored, never listed with the integrations, never shown again.
      const rows = await db.select().from(S.integrations).where(S.eq(S.integrations.orgId, A.orgId));
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0].settings.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      const list = await req("GET", "/v1/integrations", A.token);
      expect(list.body.integrations).toEqual([]);
      const status = await req("GET", "/v1/inbound-address", A.token);
      expect(status.body).toMatchObject({ configured: true, lastUsedAt: null });
      expect(status.text).not.toContain(token);
      expect(status.text).not.toContain(rows[0].settings.tokenHash);

      const l = await lead(A.orgId);
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "Seq", status: "active" }).returning();
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: l.id, status: "active", currentStep: 0, nextSendAt: new Date(Date.now() + 86_400_000) }).returning();
      const r = await req("POST", `/v1/public/inbound/${token}`, undefined, { from: `Asha <${l.email}>`, subject: "Re: hello", text: "Sounds interesting, can we talk Thursday?" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ matched: true, intent: "interested" });
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.id, cc.id)))[0]).toMatchObject({ status: "replied", nextSendAt: null });
      const [msg] = await db.select().from(S.messages).where(S.and(S.eq(S.messages.orgId, A.orgId), S.eq(S.messages.leadId, l.id), S.eq(S.messages.direction, "inbound")));
      expect(msg.intent).toBe("interested");
      expect((await req("GET", "/v1/inbound-address", A.token)).body.received).toBe(1);

      // Bad input is a 400 in words; an unknown or malformed token is a plain 401.
      expect((await req("POST", `/v1/public/inbound/${token}`, undefined, "not json")).status).toBe(400);
      expect((await req("POST", `/v1/public/inbound/${token}`, undefined, { from: "nobody", text: "x" })).status).toBe(400);
      expect((await req("POST", `/v1/public/inbound/${"A".repeat(43)}`, undefined, { from: l.email, text: "x" })).status).toBe(401);
      expect((await req("POST", "/v1/public/inbound/short", undefined, { from: l.email, text: "x" })).status).toBe(401);

      // Replacing it retires the old one at once; removing it switches it off.
      const again = await req("POST", "/v1/inbound-address", A.token, {});
      expect((await req("POST", `/v1/public/inbound/${token}`, undefined, { from: l.email, text: "hi" })).status).toBe(401);
      expect((await req("POST", `/v1/public/inbound/${again.body.token}`, undefined, { from: l.email, text: "hi" })).status).toBe(200);
      expect((await req("DELETE", "/v1/inbound-address", A.token)).status).toBe(200);
      expect((await req("POST", `/v1/public/inbound/${again.body.token}`, undefined, { from: l.email, text: "hi" })).status).toBe(401);
    });

    it("one workspace's address never touches another workspace's leads", async () => {
      const A = await signup("b3-in-a");
      const B = await signup("b3-in-b");
      const theirs = await lead(B.orgId);
      const tok = (await req("POST", "/v1/inbound-address", A.token, {})).body.token;
      const r = await req("POST", `/v1/public/inbound/${tok}`, undefined, { from: theirs.email, text: "Please unsubscribe me" });
      expect(r.status).toBe(200);
      expect(r.body.matched).toBe(false);
      expect((await db.select().from(S.suppressions).where(S.eq(S.suppressions.orgId, B.orgId))).length).toBe(0);
    });

    it("a contact can be marked as replied (and positive) by hand", async () => {
      const A = await signup("b3-mark", "growth");
      const l = await lead(A.orgId);
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "Seq", status: "active" }).returning();
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId: cp.id, leadId: l.id, status: "active", currentStep: 1, nextSendAt: new Date(Date.now() + 86_400_000) }).returning();
      const r = await req("POST", `/v1/campaigns/${cp.id}/contacts/${cc.id}/replied`, A.token, { positive: true });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ intent: "interested", status: "replied" });
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.id, cc.id)))[0].status).toBe("replied");
      expect((await db.select().from(S.leads).where(S.eq(S.leads.id, l.id)))[0].tags).toContain("replied:interested");
      // Another workspace's campaign or contact is a 404.
      const B = await signup("b3-mark-b");
      expect((await req("POST", `/v1/campaigns/${cp.id}/contacts/${cc.id}/replied`, B.token, {})).status).toBe(404);
    });
  });

  // ── 2. Rule-based reply classification ──
  describe("reply rules", () => {
    it("reads meetings, yeses, nos, referrals, questions and auto-replies", async () => {
      const { classifyReplyByRules: k } = await import("./services/replyRules.js");
      const cases: [string, string][] = [
        ["Sounds interesting, can we talk Thursday?", "interested"],
        ["Sure - send me a calendar invite for next week.", "interested"],
        ["Here's my calendly: calendly.com/asha/30min", "interested"],
        ["Yes please, tell me more", "interested"],
        ["Not interested, thanks.", "not_interested"],
        ["We already use HubSpot for this, so we're all set.", "not_interested"],
        ["I'm not the right person - please reach out to my colleague Sam.", "referral"],
        ["How much does it cost per seat?", "question"],
        ["I am out of the office until Monday with limited access to email.", "out_of_office"],
        ["Please stop emailing me.", "unsubscribe"],
        ["Please don't call me again", "unsubscribe"],
        ["Mail delivery failed: address not found", "bounce"],
        ["ok", "other"],
      ];
      for (const [text, intent] of cases) expect(k(text).intent, text).toBe(intent);
      // Quoted history is not read as this reply.
      expect(k("Thanks for the note.\n\nOn Mon, Jan 1, Sam wrote:\n> can we talk Thursday?").intent).toBe("other");
    });

    it("the signed-in inbound route uses them when no model runs", async () => {
      const A = await signup("b3-rules");
      const l = await lead(A.orgId);
      const r = await req("POST", "/v1/campaigns/inbound", A.token, { from: l.email, text: "Sounds interesting, can we talk Thursday?" });
      expect(r.body).toMatchObject({ matched: true, intent: "interested" });
    });
  });

  // ── 3. Template variables ──
  describe("template variables", () => {
    it("refuses unknown variables on save and in preview, and lets stored steps keep working", async () => {
      const A = await signup("b3-vars", "growth");
      const bad = await req("POST", "/v1/campaigns", A.token, { name: "x", steps: [{ subjectTemplate: "Hi {{firstName}}", bodyTemplate: "About {{companyName}} and {{company}}" }] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("unknown_variables");
      expect(bad.body.error.details.unknown).toEqual(["firstName", "companyName"]);
      expect(bad.body.error.details.allowed).toContain("first_name");
      expect(bad.body.error.message).toMatch(/\{\{firstName\}\}, \{\{companyName\}\}/);
      // A fallback never renders blank; a custom field a lead has is a real variable.
      await lead(A.orgId, { custom: { budget_band: "mid" } });
      const ok = await req("POST", "/v1/campaigns", A.token, { name: "ok", steps: [{ subjectTemplate: "Hi {{nick | fallback:\"there\"}}", bodyTemplate: "{{first_name}} - {{budget_band}} {{relevant_because | fallback:\"\"}}" }] });
      expect(ok.status, ok.text).toBe(201);

      // A step stored before the check: editing the campaign without touching it still works,
      // changing its text to something still unknown does not, and preview says why.
      const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "old" }).returning();
      const [st] = await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, subjectTemplate: "Hi", bodyTemplate: "Hello {{firstName}}", aiPersonalize: false }).returning();
      const same = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { name: "renamed", steps: [{ id: st.id, subjectTemplate: "Hi", bodyTemplate: "Hello {{firstName}}", aiPersonalize: false }] });
      expect(same.status, same.text).toBe(200);
      const changed = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { steps: [{ id: st.id, subjectTemplate: "Hi", bodyTemplate: "Hello {{firstName}}!", aiPersonalize: false }] });
      expect(changed.status).toBe(400);
      const l = await lead(A.orgId);
      const pv = await req("POST", `/v1/campaigns/${cp.id}/preview`, A.token, { leadId: l.id, stepNo: 1 });
      expect(pv.status).toBe(400);
      expect(pv.body.error.code).toBe("unknown_variables");
    });
  });

  // ── 4. Preview sign-off ──
  it("preview signs off with the workspace sender name, then the user's name - not 'Me'", async () => {
    const A = await signup("b3-sign", "growth");
    const [cp] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "No sender" }).returning();
    await db.insert(S.sequenceSteps).values({ campaignId: cp.id, stepNo: 1, subjectTemplate: "Hi", bodyTemplate: "Thanks,\n{{sender_name}}", aiPersonalize: false });
    const l = await lead(A.orgId);
    // No workspace default yet: the person previewing.
    await db.update(S.users).set({ name: "Ravi Kumar" }).where(S.eq(S.users.orgId, A.orgId));
    const named = await req("POST", `/v1/campaigns/${cp.id}/preview`, A.token, { leadId: l.id, stepNo: 1 });
    expect(named.status).toBe(200);
    expect(named.body.body).toBe("Thanks,\nRavi Kumar");
    await db.update(S.organizations).set({ settings: { senderName: "Priya from Acme" } }).where(S.eq(S.organizations.id, A.orgId));
    const ws = await req("POST", `/v1/campaigns/${cp.id}/preview`, A.token, { leadId: l.id, stepNo: 1 });
    expect(ws.body.body).toBe("Thanks,\nPriya from Acme");
  });

  // ── 5. Integrations ──
  describe("integrations", () => {
    it("wrong credentials are saved as 'error' with the reason; right ones as active and verified", async () => {
      const A = await signup("b3-verify", "growth");
      process.env.INTEGRATION_VERIFY = "true";
      const seen: string[] = [];
      vi.stubGlobal("fetch", (async (u: unknown) => {
        seen.push(String(u));
        return new Response(JSON.stringify({ message: "bad token" }), { status: 401 });
      }) as typeof fetch);
      const bad = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-wrong" } });
      expect(bad.status).toBe(200);
      expect(bad.body).toMatchObject({ status: "error", verified: false });
      expect(bad.body.settings.lastError).toMatch(/HubSpot rejected these credentials \(HTTP 401\)/);
      expect(seen[0]).toMatch(/^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\?limit=1/);
      vi.stubGlobal("fetch", (async () => new Response("{}", { status: 200 })) as typeof fetch);
      const good = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-right" } });
      expect(good.body).toMatchObject({ status: "active", verified: true });
      expect(good.body.settings.lastError).toBeUndefined();
      // Unreachable is not held against the customer.
      vi.stubGlobal("fetch", (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch);
      const down = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-right" } });
      expect(down.body).toMatchObject({ status: "active", verified: false });
      expect(down.body.verifyNote).toMatch(/Could not reach HubSpot/);
    });

    it("a failed sync marks the connection (status, lastError) and a later success clears it", async () => {
      const A = await signup("b3-sync", "growth");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-1" } });
      const [integ] = await db.select().from(S.integrations).where(S.and(S.eq(S.integrations.orgId, A.orgId), S.eq(S.integrations.provider, "hubspot")));
      const l = await lead(A.orgId);
      const { handlers } = await import("./jobs.js");
      const run = () => handlers["integration.sync"]({ id: randomUUID(), type: "integration.sync", orgId: A.orgId, payload: { integrationId: integ.id, leadId: l.id }, attempts: 1, maxAttempts: 3 } as never, { db, log: () => {}, progress: async () => {} } as never);
      vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ message: "Internal error" }), { status: 500 })) as typeof fetch);
      await expect(run()).rejects.toThrow();
      let [row] = await db.select().from(S.integrations).where(S.eq(S.integrations.id, integ.id));
      expect(row.status).toBe("error");
      expect(row.settings.lastError).toMatch(/Internal error|HubSpot HTTP 500/);
      expect(row.settings.lastErrorAt).toBeTruthy();
      expect(row.settings.autoSync).toBe(false);
      // Still tried while in "error"; a success puts it back.
      vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ id: "901" }), { status: 201 })) as typeof fetch);
      await run();
      [row] = await db.select().from(S.integrations).where(S.eq(S.integrations.id, integ.id));
      expect(row.status).toBe("active");
      expect(row.settings.lastError).toBeUndefined();
    });

    it("own data-provider keys: Hunter and IPinfo are used, Apollo and PDL are refused in words", async () => {
      const A = await signup("b3-keys", "growth");
      const ap = await req("PUT", "/v1/integrations/apollo", A.token, { config: { apiKey: "apollo-key" } });
      expect(ap.status).toBe(400);
      expect(ap.body.error.code).toBe("own_key_unsupported");
      expect(ap.body.error.message).toMatch(/Apollo/);
      expect((await req("PUT", "/v1/integrations/pdl", A.token, { config: { apiKey: "k" } })).status).toBe(400);
      expect((await req("PUT", "/v1/integrations/hunter", A.token, { config: { apiKey: "hunter-own-key" } })).status).toBe(200);
      expect((await req("PUT", "/v1/integrations/ipinfo", A.token, { config: { token: "ipinfo-own" } })).status).toBe(200);
      const { orgDataKeys } = await import("./services/integrations.js");
      expect(await orgDataKeys(A.orgId)).toEqual({ hunterApiKey: "hunter-own-key", ipinfoToken: "ipinfo-own" });
      const B = await signup("b3-keys-b");
      expect(await orgDataKeys(B.orgId)).toEqual({});
    });

    it("autoSync queues a push for new and changed leads; without it nothing is queued", async () => {
      const A = await signup("b3-auto", "growth");
      await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat" }, autoSync: true });
      const made = await req("POST", "/v1/leads", A.token, { fullName: "Auto Sync", email: `auto-${u8()}@prospect.example` });
      expect(made.status).toBeLessThan(300);
      const leadId = made.body.lead?.id ?? made.body.id;
      // Updated in fix round C2: auto sync queues one batch job per connection (it pushes every
      // lead changed since its cursor), not one job per lead.
      const jobs = async () => (await db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, A.orgId), S.eq(S.jobs.type, "integration.sync")))).filter((j: any) => j.payload.batch === true);
      expect((await jobs()).length).toBe(1);
      // A second event while one is still waiting does not queue a duplicate.
      const { emitEvent } = await import("./lib/events.js");
      await emitEvent(A.orgId, "lead.updated", { id: leadId }, { type: "lead", id: leadId });
      expect((await jobs()).length).toBe(1);

      const B = await signup("b3-noauto", "growth");
      await req("PUT", "/v1/integrations/hubspot", B.token, { config: { accessToken: "pat" } });
      const m2 = await req("POST", "/v1/leads", B.token, { fullName: "No Auto", email: `noauto-${u8()}@prospect.example` });
      expect(m2.status).toBeLessThan(300);
      expect((await db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, B.orgId), S.eq(S.jobs.type, "integration.sync")))).length).toBe(0);
    });
  });

  // ── 6. Plan limits ──
  describe("plan limits", () => {
    it("Free: one campaign and no new integrations, in words that name the plan; existing ones keep working", async () => {
      const F = await signup("b3-free");
      expect((await req("POST", "/v1/campaigns", F.token, { name: "First" })).status).toBe(201);
      const second = await req("POST", "/v1/campaigns", F.token, { name: "Second" });
      expect(second.status).toBe(402);
      expect(second.body.error.code).toBe("plan_limit");
      expect(second.body.error.message).toMatch(/The Free plan includes 1 campaign/);
      const integ = await req("PUT", "/v1/integrations/hubspot", F.token, { config: { accessToken: "pat" } });
      expect(integ.status).toBe(402);
      expect(integ.body.error.message).toMatch(/not included in the Free plan/);
      // Upgraded: allowed. Back on Free: what exists still works and can be updated.
      await db.update(S.organizations).set({ plan: "starter", planLimits: S.limitsFor("starter") }).where(S.eq(S.organizations.id, F.orgId));
      expect((await req("POST", "/v1/campaigns", F.token, { name: "Second" })).status).toBe(201);
      expect((await req("PUT", "/v1/integrations/hubspot", F.token, { config: { accessToken: "pat" } })).status).toBe(200);
      await db.update(S.organizations).set({ plan: "free", planLimits: S.limitsFor("free") }).where(S.eq(S.organizations.id, F.orgId));
      expect((await req("PUT", "/v1/integrations/hubspot", F.token, { config: { accessToken: "pat-rotated" } })).status).toBe(200);
      const list = await req("GET", "/v1/campaigns", F.token);
      expect(list.body.campaigns.length).toBe(2);
      expect((await req("PATCH", `/v1/campaigns/${list.body.campaigns[0].id}`, F.token, { name: "Still editable" })).status).toBe(200);
    });
  });

  // ── 7. Webhooks ──
  describe("webhooks", () => {
    it("Test with wait=1 reports the delivery, sends x-scout-* and x-prospex-* headers, and the log shows it", async () => {
      const A = await signup("b3-hook", "growth");
      const hook = (await req("POST", "/v1/webhooks", A.token, { url: `https://hooks.example.com/b3/${u8()}` })).body;
      mocks.posts.length = 0;
      const ok = await req("POST", `/v1/webhooks/${hook.id}/test?wait=1`, A.token, {});
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ queued: true, delivered: true, status: 200 });
      const sent = mocks.posts.at(-1)!;
      expect(sent.headers["x-scout-signature"]).toMatch(/^v2=[0-9a-f]{64}$/);
      expect(sent.headers["x-scout-signature"]).toBe(sent.headers["x-prospex-signature"]);
      expect(sent.headers["x-scout-timestamp"]).toBe(sent.headers["x-prospex-timestamp"]);
      expect(sent.headers["x-scout-event"]).toBe("webhook.test");

      mocks.hookStatus = 500;
      const bad = await req("POST", `/v1/webhooks/${hook.id}/test?wait=1`, A.token, {});
      expect(bad.body).toMatchObject({ delivered: false, status: 500 });
      // Without wait the answer is what it always was.
      const plain = await req("POST", `/v1/webhooks/${hook.id}/test`, A.token, {});
      expect(plain.body.queued).toBe(true);
      expect(plain.body.delivered).toBeUndefined();

      const log = await req("GET", `/v1/webhooks/${hook.id}/deliveries`, A.token);
      expect(log.status).toBe(200);
      expect(log.body.deliveries.length).toBe(3);
      const [latest, failed, first] = log.body.deliveries;
      expect(latest).toMatchObject({ event: "webhook.test", pending: true });
      expect(failed).toMatchObject({ event: "webhook.test", delivered: false, status: 500, state: "failed" });
      expect(first).toMatchObject({ event: "webhook.test", delivered: true, status: 200, state: "done" });
      // Another workspace's hook is a 404.
      const B = await signup("b3-hook-b");
      expect((await req("GET", `/v1/webhooks/${hook.id}/deliveries`, B.token)).status).toBe(404);
    });
  });

  // ── 8. Why there is no AI ──
  describe("AI-missing wording", () => {
    it("names the real cause: platform, plan or the workspace's own switch", async () => {
      const ai = await import("./lib/ai.js");
      expect(ai.aiMissingReason({ plan: "growth", settings: {} })).toBe("platform");
      expect(ai.aiMissingReason({ plan: "growth", settings: { aiDisabled: true } })).toBe("workspace_off");
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-only";
      try {
        expect(ai.aiMissingReason({ plan: "free", settings: {} })).toBe("plan");
        expect(ai.aiMissingReason({ plan: "growth", settings: {} })).toBeNull();
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
      const A = await signup("b3-noai");
      const l = await lead(A.orgId);
      const gen = await req("POST", "/v1/campaigns/generate", A.token, { leadId: l.id, sender: { name: "A", company: "B", valueProp: "C" } });
      expect(gen.body.ai).toBe(false);
      expect(gen.body.note).toBe("AI drafting isn't available yet - no AI engine is connected on our side, so this is a template, not a personalised draft. This is not a setting in your workspace; contact support if you need it.");
      expect(gen.body.note).not.toMatch(/for this workspace yet/);
    });
  });
});
