/**
 * Hardening regressions for the HTTP surface: tenancy on every reference, the shapes errors
 * come back in, what gets charged, and the account flows (invites, roles, password reset).
 *
 * Each test here pins a defect that shipped. They go through the real app (createApp) and a
 * real database, because every one of these bugs lived in a route or a query, not in a pure
 * function a unit test could reach.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
}

/** Every email the app tries to send in this file, captured instead of sent. */
const mocks = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], fail: false }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text: string }) => {
      mocks.sent.push(input);
      return mocks.fail ? { ok: false, provider: "test", error: "smtp down" } : { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("route hardening")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests that cover tenancy, error shapes, quotas and account flows.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("route hardening", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db

  type Org = { token: string; orgId: string; userId: string; email: string };
  let A: Org;
  let B: Org;

  /** A distinct client IP per call, so the per-IP signup/login limits do not couple tests. */
  const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

  async function req(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function signup(name: string, password = "correct-horse-battery"): Promise<Org> {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
    const r = await req("POST", "/v1/auth/signup", undefined, { email, password, orgName: `${name} Co` });
    expect(r.status).toBe(201);
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id, email };
  }

  async function lead(orgId: string, extra: Record<string, unknown> = {}) {
    const [l] = await db.insert(S.leads).values({ orgId, fullName: "Test Person", email: `p-${randomUUID().slice(0, 8)}@example.com`, ...extra }).returning();
    return l;
  }

  beforeAll(async () => {
    S = await import("@prospex/db");
    await S.runMigrations(TEST_DB);
    db = S.getDb().db;
    const { createApp } = await import("./app.js");
    app = createApp();
    A = await signup("hard-a");
    B = await signup("hard-b");
  }, 60_000);

  // ── 1. Tasks ──
  describe("tasks tenancy", () => {
    it("refuses a task on another workspace's lead, and never joins one in", async () => {
      const theirs = await lead(B.orgId, { phone: "+1 555 0100" });
      const r = await req("POST", "/v1/tools/tasks", A.token, { leadId: theirs.id, title: "Call" });
      expect(r.status).toBe(404);

      // A task row that already points across the boundary (written before the check) must
      // not leak the other org's lead through the list join, nor let completion write to it.
      const [t] = await db.insert(S.tasks).values({ orgId: A.orgId, leadId: theirs.id, type: "call", title: "legacy" }).returning();
      const list = await req("GET", "/v1/tools/tasks?status=all", A.token);
      expect(list.status).toBe(200);
      const row = list.body.tasks.find((x: any) => x.id === t.id);
      expect(row.lead).toBeNull();

      const done = await req("POST", `/v1/tools/tasks/${t.id}/complete`, A.token, { note: "pwned" });
      expect(done.status).toBe(200);
      const after = await db.query.leads.findFirst({ where: S.eq(S.leads.id, theirs.id) });
      expect(after.custom).toEqual({});
    });
  });

  // ── 2 & 3. Batch and bulk enrich ──
  describe("enrichment queues only this workspace's leads", () => {
    it("batch-enrich reports requested / queued / notFound and queues only owned ids", async () => {
      const mine = await lead(A.orgId);
      const theirs = await lead(B.orgId);
      const r = await req("POST", "/v1/tools/batch-enrich", A.token, { leadIds: [mine.id, theirs.id, randomUUID()] });
      expect(r.status).toBe(202);
      expect({ requested: r.body.requested, queued: r.body.queued, notFound: r.body.notFound }).toEqual({ requested: 3, queued: 1, notFound: 2 });
      const job = await db.query.jobs.findFirst({ where: S.eq(S.jobs.id, r.body.jobId) });
      expect(job.payload.leadIds).toEqual([mine.id]);
      await db.delete(S.jobs).where(S.eq(S.jobs.id, r.body.jobId));
    });

    it("POST /v1/leads/bulk/enrich is reachable (not captured by /:id/enrich) and filters ids", async () => {
      const mine = await lead(A.orgId);
      const theirs = await lead(B.orgId);
      const r = await req("POST", "/v1/leads/bulk/enrich", A.token, { ids: [mine.id, theirs.id] });
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ requested: 2, queued: 1, notFound: 1 });
      const job = await db.query.jobs.findFirst({ where: S.eq(S.jobs.id, r.body.jobId) });
      expect(job.payload.leadIds).toEqual([mine.id]);
      await db.delete(S.jobs).where(S.eq(S.jobs.id, r.body.jobId));
    });

    it("integration sync counts only leads it will actually sync", async () => {
      await db.insert(S.integrations).values({ orgId: A.orgId, provider: "custom", settings: {} }).onConflictDoNothing();
      const mine = await lead(A.orgId);
      const theirs = await lead(B.orgId);
      const r = await req("POST", "/v1/integrations/custom/sync", A.token, { leadIds: [mine.id, theirs.id] });
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ queued: 1, requested: 2, notFound: 1 });
      await db.delete(S.jobs).where(S.and(S.eq(S.jobs.orgId, A.orgId), S.eq(S.jobs.type, "integration.sync")));
    });
  });

  // ── 4. Saved searches & autopilots ──
  describe("saved searches and autopilots check every reference", () => {
    it("refuses another workspace's list, ICP and campaign", async () => {
      const [theirList] = await db.insert(S.lists).values({ orgId: B.orgId, name: "theirs" }).returning();
      const [theirIcp] = await db.insert(S.icps).values({ orgId: B.orgId, name: "theirs" }).returning();
      const [theirCampaign] = await db.insert(S.campaigns).values({ orgId: B.orgId, name: "theirs" }).returning();

      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "x", query: { query: "cto" }, listId: theirList.id })).status).toBe(404);
      expect((await req("POST", "/v1/tools/autopilots", A.token, { name: "x", query: {}, campaignId: theirCampaign.id })).status).toBe(404);

      const ap = await req("POST", "/v1/tools/autopilots", A.token, { name: "mine", query: {} });
      expect(ap.status).toBe(201);
      expect((await req("PATCH", `/v1/tools/autopilots/${ap.body.id}`, A.token, { icpId: theirIcp.id })).status).toBe(404);
      // GET returns null for unset references; sending that back (or null to detach) is fine.
      expect((await req("PATCH", `/v1/tools/autopilots/${ap.body.id}`, A.token, { icpId: null, listId: null })).status).toBe(200);
    });

    it("a saved search can carry a client, stored where the scheduled run reads it", async () => {
      const [client] = await db.insert(S.clients).values({ orgId: A.orgId, name: "Client X" }).returning();
      const r = await req("POST", "/v1/tools/saved-searches", A.token, { name: "for client", query: { query: "cto" }, clientId: client.id });
      expect(r.status).toBe(201);
      expect(r.body.clientId).toBe(client.id);
      expect(r.body.query.clientId).toBe(client.id);

      const [theirClient] = await db.insert(S.clients).values({ orgId: B.orgId, name: "Not yours" }).returning();
      expect((await req("POST", "/v1/tools/saved-searches", A.token, { name: "x", query: {}, clientId: theirClient.id })).status).toBe(404);
    });
  });

  // ── 5. Leads & ICP references ──
  describe("lead and ICP references", () => {
    it("refuses another workspace's ICP on lead create, lead edit and quick search", async () => {
      const [theirIcp] = await db.insert(S.icps).values({ orgId: B.orgId, name: "theirs" }).returning();
      expect((await req("POST", "/v1/leads", A.token, { fullName: "X", icpId: theirIcp.id })).status).toBe(404);
      const mine = await lead(A.orgId);
      expect((await req("PATCH", `/v1/leads/${mine.id}`, A.token, { icpId: theirIcp.id })).status).toBe(404);
      // Refused before anything is charged or searched.
      expect((await req("POST", "/v1/search/quick", A.token, { query: "cto", icpId: theirIcp.id })).status).toBe(404);
    });

    it("PATCH applies companyDomain (and refuses a bare companyName) instead of dropping them", async () => {
      const mine = await lead(A.orgId);
      const r = await req("PATCH", `/v1/leads/${mine.id}`, A.token, { companyDomain: "https://www.newco-test.io/about", companyName: "NewCo" });
      expect(r.status).toBe(200);
      const co = await db.query.companies.findFirst({ where: S.eq(S.companies.id, r.body.companyId) });
      expect(co).toMatchObject({ domain: "newco-test.io", orgId: A.orgId });
      const bare = await req("PATCH", `/v1/leads/${mine.id}`, A.token, { companyName: "Only a name" });
      expect(bare.status).toBe(400);
    });

    it("PATCH accepts the nulls GET returns, and null clears a field", async () => {
      const mine = await lead(A.orgId, { title: "CTO", phone: "123" });
      const r = await req("PATCH", `/v1/leads/${mine.id}`, A.token, { title: null, phone: "456" });
      expect(r.status).toBe(200);
      expect(r.body.title).toBeNull();
      expect(r.body.phone).toBe("456");
    });

    it("ICP PATCH applies clientId (ownership-checked) and accepts null description", async () => {
      const made = await req("POST", "/v1/icps", A.token, { name: "icp", buildWithAi: false });
      const [client] = await db.insert(S.clients).values({ orgId: A.orgId, name: "C" }).returning();
      const r = await req("PATCH", `/v1/icps/${made.body.icp.id}`, A.token, { clientId: client.id, description: null, seedDomains: null });
      expect(r.status).toBe(200);
      expect(r.body.clientId).toBe(client.id);
      const [theirClient] = await db.insert(S.clients).values({ orgId: B.orgId, name: "theirs" }).returning();
      expect((await req("PATCH", `/v1/icps/${made.body.icp.id}`, A.token, { clientId: theirClient.id })).status).toBe(404);
    });

    it("ICP scoring with assign stays inside the ICP's client", async () => {
      const [c1] = await db.insert(S.clients).values({ orgId: A.orgId, name: "One" }).returning();
      const [c2] = await db.insert(S.clients).values({ orgId: A.orgId, name: "Two" }).returning();
      const made = await req("POST", "/v1/icps", A.token, { name: "for one", clientId: c1.id, buildWithAi: false, criteria: { titles: ["CTO"] } });
      const inside = await lead(A.orgId, { clientId: c1.id, title: "CTO" });
      const other = await lead(A.orgId, { clientId: c2.id, title: "CTO", score: 42 });
      const r = await req("POST", `/v1/icps/${made.body.icp.id}/score`, A.token, { assign: true, useLearning: false });
      expect(r.status).toBe(200);
      const ids = r.body.scored.map((s: any) => s.leadId);
      expect(ids).toContain(inside.id);
      expect(ids).not.toContain(other.id);
      const untouched = await db.query.leads.findFirst({ where: S.eq(S.leads.id, other.id) });
      expect(untouched.score).toBe(42);
      expect(untouched.icpId).toBeNull();
    });
  });

  // ── 6. Lists ──
  it("adding leads to a list inserts only owned ids and accounts for every one", async () => {
    const list = await req("POST", "/v1/leads/lists", A.token, { name: "L" });
    const mine = await lead(A.orgId);
    const theirs = await lead(B.orgId);
    const r = await req("POST", `/v1/leads/lists/${list.body.id}/leads`, A.token, { ids: [mine.id, theirs.id, randomUUID()] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ requested: 3, added: 1, alreadyInList: 0, notFound: 2 });
    const again = await req("POST", `/v1/leads/lists/${list.body.id}/leads`, A.token, { ids: [mine.id] });
    expect(again.body).toMatchObject({ added: 0, alreadyInList: 1 });
  });

  // ── 7. Signals ──
  it("another workspace's private signals never reach this workspace's priority score", async () => {
    const domain = `sig-${randomUUID().slice(0, 8)}.test`;
    const [co] = await db.insert(S.companies).values({ orgId: A.orgId, domain, name: "Sig" }).returning();
    const l = await lead(A.orgId, { companyId: co.id });
    await db.insert(S.signals).values({ orgId: B.orgId, type: "funding", companyDomain: domain, title: "B private", url: `https://x.test/${randomUUID()}`, occurredAt: new Date() });
    const before = await req("GET", `/v1/leads/${l.id}/priority`, A.token);
    expect(before.status).toBe(200);
    expect(before.body.breakdown.signals).toBe(0);
    // A shared (orgId null) signal is everyone's and does count.
    await db.insert(S.signals).values({ orgId: null, type: "funding", companyDomain: domain, title: "public", url: `https://x.test/${randomUUID()}`, occurredAt: new Date() });
    const after = await req("GET", `/v1/leads/${l.id}/priority`, A.token);
    expect(after.body.breakdown.signals).toBeGreaterThan(0);
  });

  // ── 8. Rate limiter ──
  describe("rate limiter keying", () => {
    async function miniApp() {
      const { Hono } = await import("hono");
      const { rateLimit } = await import("./middleware.js");
      const { errorHandler } = await import("./lib/errors.js");
      const h = new Hono();
      h.onError(errorHandler);
      h.get("/a", rateLimit({ perMinute: 1 }) as any, (c) => c.text("a"));
      h.get("/b", rateLimit({ perMinute: 1 }) as any, (c) => c.text("b"));
      return h;
    }

    it("does not let a rotated X-Forwarded-For first entry reset the bucket", async () => {
      const h = await miniApp();
      const hit = (spoof: string) => h.request("/a", { headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` } });
      expect((await hit("1.1.1.1")).status).toBe(200);
      expect((await hit("2.2.2.2")).status).toBe(429);
    });

    it("prefers cf-connecting-ip over X-Forwarded-For", async () => {
      const h = await miniApp();
      expect((await h.request("/a", { headers: { "cf-connecting-ip": "203.0.113.20", "x-forwarded-for": "9.9.9.9" } })).status).toBe(200);
      expect((await h.request("/a", { headers: { "cf-connecting-ip": "203.0.113.21", "x-forwarded-for": "9.9.9.9" } })).status).toBe(200);
      expect((await h.request("/a", { headers: { "cf-connecting-ip": "203.0.113.20", "x-forwarded-for": "8.8.8.8" } })).status).toBe(429);
    });

    it("gives each limiter its own bucket", async () => {
      const h = await miniApp();
      const headers = { "cf-connecting-ip": "203.0.113.30" };
      expect((await h.request("/a", { headers })).status).toBe(200);
      expect((await h.request("/a", { headers })).status).toBe(429);
      expect((await h.request("/b", { headers })).status).toBe(200);
    });
  });

  // ── 9. Click redirect ──
  describe("click tracking redirect", () => {
    it("redirects only to a URL that is in that message", async () => {
      const token = `tk-${randomUUID()}`;
      const target = "https://example.com/pricing?a=1&b=2";
      await db.insert(S.messages).values({ orgId: A.orgId, toEmail: "x@example.com", subject: "s", bodyText: "b", bodyHtml: `<a href="https://api.test/t/c/${token}?u=${encodeURIComponent(target)}">x</a>`, trackingToken: token, status: "sent" });
      const ok = await app.request(`/t/c/${token}?u=${encodeURIComponent(target)}`);
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe(target);
      const evil = await app.request(`/t/c/${token}?u=${encodeURIComponent("https://evil.example/phish")}`);
      expect(evil.status).toBe(404);
      expect(evil.headers.get("location")).toBeNull();
      const noToken = await app.request(`/t/c/not-a-token?u=${encodeURIComponent("https://evil.example/")}`);
      expect(noToken.status).toBe(404);
    });
  });

  // ── 14. Postgres errors ──
  describe("database errors map to client errors", () => {
    it("a duplicate email on PATCH is a 409 conflict", async () => {
      const one = await lead(A.orgId);
      const two = await lead(A.orgId);
      const r = await req("PATCH", `/v1/leads/${two.id}`, A.token, { email: one.email });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("conflict");
      expect(r.body.error.message).toMatch(/already has that email/);
    });

    it("FK violation (wrapped in a cause) is a 400, not a 500", async () => {
      const { Hono } = await import("hono");
      const { errorHandler } = await import("./lib/errors.js");
      const h = new Hono();
      h.onError(errorHandler);
      h.get("/fk", () => {
        throw new Error("Failed query", { cause: { code: "23503", detail: "Key is not present" } });
      });
      const r = await h.request("/fk");
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("invalid_reference");
    });
  });

  // ── 15. Empty PATCH ──
  it("an empty PATCH body is a 400 'Nothing to update', not a 500", async () => {
    const ap = await req("POST", "/v1/tools/autopilots", A.token, { name: "e", query: {} });
    const [mon] = await db.insert(S.monitors).values({ orgId: A.orgId, type: "keyword", name: "m", target: "t" }).returning();
    const [prompt] = await db.insert(S.visibilityPrompts).values({ orgId: A.orgId, text: "best crm tools" }).returning();
    for (const path of ["/v1/auth/org", `/v1/tools/autopilots/${ap.body.id}`, `/v1/signals/monitors/${mon.id}`, `/v1/visibility/prompts/${prompt.id}`]) {
      const r = await req("PATCH", path, A.token, {});
      expect({ path, status: r.status }).toEqual({ path, status: 400 });
    }
  });

  // ── 16. Import body ──
  it("import rejects malformed or non-array JSON with a 400", async () => {
    for (const body of ["{not json", "null", '{"foo":1}', "[1,2]"]) {
      const r = await req("POST", "/v1/leads/import", A.token, body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
  });

  // ── 17. Bounded days ──
  it("bounds the days window instead of 500ing", async () => {
    expect((await req("GET", "/v1/signals?days=1000000", A.token)).status).toBe(400);
    expect((await req("GET", "/v1/visitors?days=0", A.token)).status).toBe(400);
    expect((await req("GET", "/v1/visitors?days=30", A.token)).status).toBe(200);
  });

  // ── 18. Validation shape ──
  it("a validation failure says which field, in the standard error shape", async () => {
    const r = await req("POST", "/v1/icps", A.token, { nope: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_error");
    expect(r.body.error.message).toMatch(/^Name is required/);
    expect(r.body.error.issues[0].path).toEqual(["name"]);
    expect(Array.isArray(r.body.error.issues)).toBe(true);
    expect(r.body.success).toBeUndefined();
  });

  // ── 19 & 20. Campaign editing ──
  describe("campaign editing", () => {
    async function makeCampaign() {
      const r = await req("POST", "/v1/campaigns", A.token, {
        name: "Edit me",
        settings: { timezone: "Asia/Kolkata", sendWindow: { start: "09:00", end: "17:30", days: [1, 2, 3, 4, 5] } },
        steps: [
          { subjectTemplate: "Hi", bodyTemplate: "Step one" },
          { delayDays: 3, subjectTemplate: "Re", bodyTemplate: "Step two" },
        ],
      });
      expect(r.status).toBe(201);
      return r.body;
    }

    it("a GET body sent straight back as a PATCH is accepted", async () => {
      const cp = await makeCampaign();
      const got = (await req("GET", `/v1/campaigns/${cp.id}`, A.token)).body;
      expect(got.steps[0].aiInstructions).toBeNull();
      const r = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { name: got.name, icpId: got.icpId, listId: got.listId, emailAccountId: got.emailAccountId, clientId: got.clientId, settings: got.settings, steps: got.steps });
      expect(r.status).toBe(200);
    });

    it("listId: null detaches the list", async () => {
      const list = await req("POST", "/v1/leads/lists", A.token, { name: "attach" });
      const cp = await makeCampaign();
      await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { listId: list.body.id });
      const r = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { listId: null });
      expect(r.status).toBe(200);
      expect(r.body.listId).toBeNull();
    });

    it("editing steps keeps their ids, so sent messages and queued sends still point at them", async () => {
      const cp = await makeCampaign();
      const [s1, s2] = cp.steps;
      await db.insert(S.messages).values({ orgId: A.orgId, campaignId: cp.id, stepId: s1.id, toEmail: "m@example.com", subject: "s", bodyText: "b", status: "sent" });

      // Edit both, one carrying its id and one matched by position.
      const r = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { steps: [{ id: s1.id, subjectTemplate: "Hi!", bodyTemplate: "Step one, edited" }, { delayDays: 4, subjectTemplate: "Re", bodyTemplate: "Step two, edited" }] });
      expect(r.status).toBe(200);
      expect(r.body.steps.map((s: any) => s.id)).toEqual([s1.id, s2.id]);
      expect(r.body.steps[0].bodyTemplate).toBe("Step one, edited");
      const msg = await db.query.messages.findFirst({ where: S.and(S.eq(S.messages.campaignId, cp.id), S.eq(S.messages.toEmail, "m@example.com")) });
      expect(msg.stepId).toBe(s1.id);

      // Removing step 1 deletes only it; step 2 keeps its id and becomes step 1.
      const r2 = await req("PATCH", `/v1/campaigns/${cp.id}`, A.token, { steps: [{ id: s2.id, subjectTemplate: "Re", bodyTemplate: "Now first" }] });
      expect(r2.body.steps).toHaveLength(1);
      expect(r2.body.steps[0]).toMatchObject({ id: s2.id, stepNo: 1 });
    });

    it("validates the send window and time zone", async () => {
      const bad1 = await req("POST", "/v1/campaigns", A.token, { name: "x", settings: { sendWindow: { start: "9:00", end: "17:00", days: [1] } } });
      expect(bad1.status).toBe(400);
      // Whole sentences, shown as written - not "Send window start: Use 24-hour HH:MM, e.g. 09:00".
      expect(bad1.body.error.message).toBe("Send window times must be 24-hour HH:MM, for example 09:00.");
      expect(bad1.body.error.issues[0].path).toEqual(["settings", "sendWindow", "start"]);
      const both = await req("POST", "/v1/campaigns", A.token, { name: "x", settings: { sendWindow: { start: "9:00", end: "5pm", days: [1] } } });
      expect(both.body.error.message).toBe("Send window times must be 24-hour HH:MM, for example 09:00.");
      expect(both.body.error.issues).toHaveLength(2);
      const bad2 = await req("POST", "/v1/campaigns", A.token, { name: "x", settings: { timezone: "Mars/Olympus_Mons" } });
      expect(bad2.status).toBe(400);
      expect(bad2.body.error).toMatchObject({ code: "validation_error", message: "Unknown time zone. Use a name like Asia/Kolkata or America/New_York." });
    });
  });

  // ── 24. Unsubscribe ──
  describe("unsubscribe", () => {
    it("GET only shows a confirmation; POST (one-click) unsubscribes and marks the lead", async () => {
      const l = await lead(A.orgId);
      const token = `u-${randomUUID()}`;
      await db.insert(S.messages).values({ orgId: A.orgId, leadId: l.id, toEmail: l.email, subject: "s", bodyText: "b", trackingToken: token, status: "sent" });

      const page = await app.request(`/t/u/${token}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/<form method="post"/);
      expect(await db.query.suppressions.findFirst({ where: S.and(S.eq(S.suppressions.orgId, A.orgId), S.eq(S.suppressions.email, l.email)) })).toBeUndefined();

      const post = await app.request(`/t/u/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      expect(post.status).toBe(200);
      expect(await db.query.suppressions.findFirst({ where: S.and(S.eq(S.suppressions.orgId, A.orgId), S.eq(S.suppressions.email, l.email)) })).toBeTruthy();
      const after = await db.query.leads.findFirst({ where: S.eq(S.leads.id, l.id) });
      expect(after.status).toBe("unsubscribed");
    });
  });

  // ── 26. Seats & invites ──
  describe("seats and invites", () => {
    let O: Org;
    beforeAll(async () => {
      O = await signup("seats");
      await db.update(S.organizations).set({ planLimits: { ...S.limitsFor("free"), seats: 2 } }).where(S.eq(S.organizations.id, O.orgId));
    });

    it("counts pending invites against seats, revokes, expires, re-sends, and re-checks at join", async () => {
      mocks.sent.length = 0;
      const x = await req("POST", "/v1/tools/team/invite", O.token, { email: `x-${randomUUID().slice(0, 6)}@example.com` });
      expect(x.status).toBe(201);
      expect(x.body.emailed).toBe(true);
      expect(mocks.sent.at(-1)!.subject).toMatch(/on Scout$/);
      expect(mocks.sent.at(-1)!.subject).not.toMatch(/Prospex/);

      // One member + one pending = the two seats.
      const yEmail = `y-${randomUUID().slice(0, 6)}@example.com`;
      expect((await req("POST", "/v1/tools/team/invite", O.token, { email: yEmail })).status).toBe(400);

      expect((await req("DELETE", `/v1/tools/team/invites/${x.body.id}`, O.token)).status).toBe(200);
      const xToken = new URL(x.body.link).searchParams.get("token");
      const joinRevoked = await req("POST", "/v1/auth/join", undefined, { token: xToken, password: "long-enough-pw" });
      expect(joinRevoked.status).toBe(400);
      expect(joinRevoked.body.error.code).toBe("invite_revoked");

      const y = await req("POST", "/v1/tools/team/invite", O.token, { email: yEmail });
      expect(y.status).toBe(201);
      const yToken = new URL(y.body.link).searchParams.get("token");
      await db.update(S.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.invites.id, y.body.id));
      const joinExpired = await req("POST", "/v1/auth/join", undefined, { token: yToken, password: "long-enough-pw" });
      expect(joinExpired.body.error.code).toBe("invite_expired");

      const resent = await req("POST", `/v1/tools/team/invites/${y.body.id}/resend`, O.token);
      expect(resent.status).toBe(200);
      expect(resent.body.emailed).toBe(true);
      // Re-sending issues a NEW link (only the hash of a token is stored, so the old link
      // cannot be sent again); the previous one stops working.
      const resentToken = new URL(resent.body.link).searchParams.get("token");
      expect(resentToken).not.toBe(yToken);
      expect((await req("POST", "/v1/auth/join", undefined, { token: yToken, password: "long-enough-pw" })).body.error.code).toBe("invalid_invite");
      const joined = await req("POST", "/v1/auth/join", undefined, { token: resentToken, password: "long-enough-pw" });
      expect(joined.status).toBe(200);
      expect(joined.body.token).toBeTruthy();
    });

    it("reports emailed:false when the mail did not go, and still returns the link", async () => {
      const P = await signup("seats-mail");
      await db.update(S.organizations).set({ planLimits: { ...S.limitsFor("free"), seats: 5 } }).where(S.eq(S.organizations.id, P.orgId));
      mocks.fail = true;
      try {
        const r = await req("POST", "/v1/tools/team/invite", P.token, { email: `z-${randomUUID().slice(0, 6)}@example.com` });
        expect(r.status).toBe(201);
        expect(r.body.emailed).toBe(false);
        expect(r.body.link).toMatch(/\/join\?token=/);
      } finally {
        mocks.fail = false;
      }
    });

    it("refuses to invite an address that already has an account, with a 409", async () => {
      const P = await signup("seats-dupe");
      await db.update(S.organizations).set({ planLimits: { ...S.limitsFor("free"), seats: 5 } }).where(S.eq(S.organizations.id, P.orgId));
      const r = await req("POST", "/v1/tools/team/invite", P.token, { email: B.email });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("already_registered");
    });
  });

  // ── 27. Roles ──
  describe("roles", () => {
    it("members cannot manage keys, settings, invites or webhooks", async () => {
      const { issueJwt, hashPassword } = await import("./lib/auth.js");
      const [member] = await db.insert(S.users).values({ orgId: A.orgId, email: `member-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await hashPassword("whatever-123"), role: "member" }).returning();
      const t = await issueJwt(member);
      const attempts: [string, string, unknown][] = [
        ["POST", "/v1/auth/api-keys", { name: "k" }],
        ["PATCH", "/v1/auth/org", { name: "renamed" }],
        ["POST", "/v1/tools/team/invite", { email: "n@example.com" }],
        ["POST", "/v1/webhooks", { url: "https://hooks.example.com/x" }],
        ["PUT", "/v1/integrations/custom", { config: {} }],
      ];
      for (const [m, p, b] of attempts) {
        const r = await req(m, p, t, b);
        expect({ p, status: r.status, code: r.body?.error?.code }).toEqual({ p, status: 403, code: "forbidden_role" });
      }
      // ...and can still do ordinary work.
      expect((await req("GET", "/v1/leads", t)).status).toBe(200);
    });
  });

  // ── 28. Password reset & change ──
  describe("password reset", () => {
    const tokenFrom = (text: string) => new URL(text.match(/https?:\/\/\S+reset-password\?token=\S+/)![0]).searchParams.get("token")!;

    it("forgot -> reset -> login, single use, no account enumeration", async () => {
      const U = await signup("pw", "old-password-1");
      mocks.sent.length = 0;
      const unknown = await req("POST", "/v1/auth/password/forgot", undefined, { email: `nobody-${randomUUID()}@example.com` });
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ ok: true });
      expect(mocks.sent).toHaveLength(0);

      const known = await req("POST", "/v1/auth/password/forgot", undefined, { email: U.email.toUpperCase() });
      expect(known.status).toBe(200);
      expect(known.body).toEqual({ ok: true });
      const mail = mocks.sent.find((m) => m.to === U.email)!;
      expect(mail).toBeTruthy();
      const token = tokenFrom(mail.text);
      // Only the hash is stored.
      const stored = await db.select().from(S.passwordResetTokens).where(S.eq(S.passwordResetTokens.userId, U.userId));
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).not.toBe(token);

      const reset = await req("POST", "/v1/auth/password/reset", undefined, { token, password: "new-password-2" });
      expect(reset.status).toBe(200);
      expect(reset.body.token).toBeTruthy();
      expect(reset.body.user.email).toBe(U.email);
      expect(reset.body.org.id).toBe(U.orgId);

      expect((await req("POST", "/v1/auth/login", undefined, { email: U.email, password: "new-password-2" })).status).toBe(200);
      expect((await req("POST", "/v1/auth/login", undefined, { email: U.email, password: "old-password-1" })).status).toBe(401);
      const again = await req("POST", "/v1/auth/password/reset", undefined, { token, password: "third-password-3" });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe("invalid_reset_token");
    });

    it("an expired token is refused", async () => {
      const U = await signup("pw-exp");
      const { sha256 } = await import("./lib/crypto.js");
      const raw = `expired-${randomUUID()}`;
      await db.insert(S.passwordResetTokens).values({ userId: U.userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() - 1000) });
      expect((await req("POST", "/v1/auth/password/reset", undefined, { token: raw, password: "new-password-2" })).status).toBe(400);
    });

    it("change requires the current password", async () => {
      const U = await signup("pw-change", "first-password-1");
      expect((await req("POST", "/v1/auth/password/change", U.token, { newPassword: "second-password-2" })).status).toBe(400);
      expect((await req("POST", "/v1/auth/password/change", U.token, { currentPassword: "wrong-one-xx", newPassword: "second-password-2" })).status).toBe(403);
      expect((await req("POST", "/v1/auth/password/change", U.token, { currentPassword: "first-password-1", newPassword: "second-password-2" })).status).toBe(200);
      expect((await req("POST", "/v1/auth/login", undefined, { email: U.email, password: "second-password-2" })).status).toBe(200);
    });

    it("an account with no password (Google sign-up) can set one without a current password", async () => {
      const { issueJwt, unusablePasswordHash } = await import("./lib/auth.js");
      const [g] = await db.insert(S.users).values({ orgId: A.orgId, email: `g-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await unusablePasswordHash("google:1"), role: "member" }).returning();
      const t = await issueJwt(g);
      expect((await req("GET", "/v1/auth/me", t)).body.user.hasPassword).toBe(false);
      expect((await req("POST", "/v1/auth/password/change", t, { newPassword: "brand-new-pass" })).status).toBe(200);
      expect((await req("POST", "/v1/auth/login", undefined, { email: g.email, password: "brand-new-pass" })).status).toBe(200);
    });

    it("login refuses a suspended workspace with account_suspended", async () => {
      const U = await signup("pw-susp", "suspended-pass-1");
      await db.update(S.organizations).set({ status: "deactivated" }).where(S.eq(S.organizations.id, U.orgId));
      const r = await req("POST", "/v1/auth/login", undefined, { email: U.email, password: "suspended-pass-1" });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("account_suspended");
    });
  });

  // ── 22. Pixel ──
  it("a pixel with allowed domains refuses hits from other sites", async () => {
    const key = `px_${randomUUID().slice(0, 12)}`;
    await db.insert(S.pixels).values({ orgId: A.orgId, key, name: "site", allowedDomains: ["acme-allowed.test"] });
    const r = await app.request(`/px/${key}/collect`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "cf-connecting-ip": "203.0.113.50" }, body: JSON.stringify({ p: "/" }) });
    expect(r.status).toBe(403);
    const none = await app.request(`/px/${key}/collect`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" }, body: "{}" });
    expect(none.status).toBe(403);
  });

  // ── 23. Reply sending ──
  it("sending a drafted reply refuses a suppressed address", async () => {
    const l = await lead(A.orgId);
    await db.insert(S.suppressions).values({ orgId: A.orgId, email: l.email, reason: "manual" });
    const [inbound] = await db.insert(S.messages).values({ orgId: A.orgId, leadId: l.id, direction: "inbound", toEmail: l.email, subject: "re", bodyText: "yes", status: "received", draftReply: { subject: "Great", body: "Let's talk" } }).returning();
    const r = await req("POST", `/v1/campaigns/messages/${inbound.id}/send-reply`, A.token, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("suppressed");
  });

  // ── 33. Polish ──
  describe("polish", () => {
    it("unknown ids answer 404 on pause and delete", async () => {
      expect((await req("POST", `/v1/campaigns/${randomUUID()}/pause`, A.token)).status).toBe(404);
      for (const p of [`/v1/leads/${randomUUID()}`, `/v1/campaigns/${randomUUID()}`, `/v1/icps/${randomUUID()}`, `/v1/webhooks/${randomUUID()}`, `/v1/tools/autopilots/${randomUUID()}`]) {
        expect({ p, status: (await req("DELETE", p, A.token)).status }).toEqual({ p, status: 404 });
      }
    });

    it("suppressions `added` counts only new addresses", async () => {
      const e = `sup-${randomUUID().slice(0, 8)}@example.com`;
      expect((await req("POST", "/v1/leads/suppressions", A.token, { emails: [e] })).body).toMatchObject({ added: 1, alreadySuppressed: 0 });
      expect((await req("POST", "/v1/leads/suppressions", A.token, { emails: [e, e.toUpperCase()] })).body).toMatchObject({ added: 0, alreadySuppressed: 1 });
    });

    it("CSV export defuses formulas and CSV import handles quoted line breaks", async () => {
      const tag = `csv-${randomUUID().slice(0, 6)}`;
      await lead(A.orgId, { title: "=HYPERLINK(\"http://evil\")", tags: [tag] });
      const csv = await app.request(`/v1/leads/export.csv?tag=${tag}`, { headers: { authorization: `Bearer ${A.token}` } });
      const text = await csv.text();
      expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);

      const e1 = `ml-${randomUUID().slice(0, 6)}@example.com`;
      const e2 = `ml2-${randomUUID().slice(0, 6)}@example.com`;
      const body = `name,email,title\n"Ann Lee",${e1},"Head of\nSales"\nBob Roe,${e2},CTO\n`;
      const r = await app.request("/v1/leads/import", { method: "POST", headers: { authorization: `Bearer ${A.token}`, "content-type": "text/csv" }, body });
      const j = await r.json();
      expect(j.created).toBe(2);
      const ann = await db.query.leads.findFirst({ where: S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.email, e1)) });
      expect(ann.title).toBe("Head of\nSales");
    });

    it("lead search q matches the company name", async () => {
      const name = `Zyx${randomUUID().slice(0, 6)}`;
      const [co] = await db.insert(S.companies).values({ orgId: A.orgId, domain: `${name.toLowerCase()}.test`, name }).returning();
      const l = await lead(A.orgId, { companyId: co.id, fullName: "Nobody Special" });
      const r = await req("GET", `/v1/leads?q=${name}`, A.token);
      expect(r.body.leads.map((x: any) => x.id)).toContain(l.id);
    });

    it("re-posting an existing lead does not charge the leads quota", async () => {
      const P = await signup("charge");
      const email = `dup-${randomUUID().slice(0, 6)}@example.com`;
      expect((await req("POST", "/v1/leads", P.token, { email, fullName: "D" })).status).toBe(201);
      expect((await req("POST", "/v1/leads", P.token, { email, fullName: "D2" })).status).toBe(200);
      const u = await S.getUsage(db, P.orgId);
      expect(u.usage.leads.used).toBe(1);
    });

    it("the public client report is gone for an archived client", async () => {
      const shareToken = `share-${randomUUID()}`;
      await db.insert(S.clients).values({ orgId: A.orgId, name: "Archived", status: "archived", shareToken });
      expect((await req("GET", `/v1/public/clients/report/${shareToken}`)).status).toBe(404);
    });
  });
  // ── Second pass: review and end-to-end findings ──
  describe("second pass", () => {
    const u8 = () => randomUUID().slice(0, 8);

    it("a Stripe renewal on the same plan keeps admin overrides; a plan change carries them over", async () => {
      const { env } = await import("./env.js");
      const Stripe = (await import("stripe")).default;
      const st = env.stripe as any;
      const saved = { secretKey: st.secretKey, webhookSecret: st.webhookSecret };
      st.secretKey = "sk_test_dummy";
      st.webhookSecret = "whsec_test_secret";
      process.env.STRIPE_PRICE_STARTER = "price_starter_t";
      process.env.STRIPE_PRICE_GROWTH = "price_growth_t";
      try {
        const cus = `cus_${u8()}`;
        const [org] = await db.insert(S.organizations).values({ name: "Stripe", slug: `stripe-${u8()}`, plan: "starter", planLimits: { ...S.limitsFor("starter"), leadsPerMonth: 99999 }, stripeCustomerId: cus }).returning();
        const send = async (price: string) => {
          const payload = JSON.stringify({ id: `evt_${u8()}`, object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1", object: "subscription", customer: cus, status: "active", items: { data: [{ price: { id: price } }] } } } });
          const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
          return req("POST", "/v1/billing/webhook", undefined, payload, { "stripe-signature": header, "content-type": "application/json" });
        };
        expect((await send("price_starter_t")).status).toBe(200);
        let row = await db.query.organizations.findFirst({ where: S.eq(S.organizations.id, org.id) });
        expect(row.planLimits.leadsPerMonth).toBe(99999);
        expect(row.stripeSubscriptionId).toBe("sub_1");
        expect((await send("price_growth_t")).status).toBe(200);
        row = await db.query.organizations.findFirst({ where: S.eq(S.organizations.id, org.id) });
        expect(row.plan).toBe("growth");
        expect(row.planLimits.leadsPerMonth).toBe(99999);
        expect(row.planLimits.searchesPerMonth).toBe(S.limitsFor("growth").searchesPerMonth);
      } finally {
        st.secretKey = saved.secretKey;
        st.webhookSecret = saved.webhookSecret;
        delete process.env.STRIPE_PRICE_STARTER;
        delete process.env.STRIPE_PRICE_GROWTH;
      }
    });

    it("discovery with the searches quota spent is a 402 quota_exceeded, not a 502 provider outage", async () => {
      const O = await signup("disc-quota");
      await db.insert(S.usage).values({ orgId: O.orgId, period: S.currentPeriod(), metric: "searches", count: 1_000_000 });
      const r = await req("POST", "/v1/automation/discover", O.token, { query: "founders at fintech startups" });
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe("quota_exceeded");
      expect(r.body.status).toBe("quota");
      expect(r.body.runId).toBeTruthy();
    });

    it("lead verify does not stamp verifiedAt for a DNS-only answer, and records a real verifier", async () => {
      const core = await import("@prospex/core");
      const l = await lead(A.orgId);
      const spy = vi.spyOn(core, "verifyEmail").mockResolvedValueOnce({ email: l.email, status: "risky", confidence: 0.5, checks: {}, reason: "probe disabled", verifiedBy: "mx-only" } as never);
      const r = await req("POST", `/v1/leads/${l.id}/verify`, A.token);
      expect(r.status).toBe(200);
      expect(r.body.lead.emailStatus).toBe("risky");
      expect(r.body.lead.verifiedAt).toBeNull();
      expect(r.body.lead.emailVerifiedBy).toBeNull();
      spy.mockResolvedValueOnce({ email: l.email, status: "valid", confidence: 0.95, checks: {}, reason: "reoon:safe", verifiedBy: "reoon:safe" } as never);
      const r2 = await req("POST", `/v1/leads/${l.id}/verify`, A.token);
      expect(r2.body.lead.verifiedAt).not.toBeNull();
      expect(r2.body.lead.emailVerifiedBy).toBe("reoon:safe");
      spy.mockRestore();
    });

    it("visibility sampling with no AI engine configured is a 503 ai_not_configured, and the scheduled job skips", async () => {
      const [prompt] = await db.insert(S.visibilityPrompts).values({ orgId: A.orgId, text: "What is the best B2B software for founders?" }).returning();
      const r = await req("POST", `/v1/visibility/prompts/${prompt.id}/run`, A.token, {});
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("ai_not_configured");
      // In the customer's words: no server environment variable is named.
      expect(r.body.error.message).toMatch(/AI drafting isn't switched on for this workspace yet/);
      expect(r.body.error.message).not.toMatch(/_API_KEY|SMTP_|\.env\b/);
      const { handlers } = await import("./jobs.js");
      const out = await handlers["visibility.run"]({ id: randomUUID(), type: "visibility.run", payload: { promptId: prompt.id }, attempts: 1, maxAttempts: 3 } as never, { db, log: () => {}, progress: async () => {} } as never);
      expect(out).toMatchObject({ skipped: true });
      expect(String((out as any).note)).toMatch(/AI drafting isn't switched on/);
    });

    it("refuses to save an integration with an empty or whitespace token", async () => {
      const r = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "   " } });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/access token/);
      const r2 = await req("PUT", "/v1/integrations/webhook", A.token, { config: { url: "" } });
      expect(r2.status).toBe(400);
      // Each provider by its own name (not its id), and what to type - in one sentence.
      const wording: [string, Record<string, string>, string][] = [
        ["hubspot", { accessToken: "   " }, "Enter the access token to connect HubSpot."],
        ["pipedrive", {}, "Enter the API token to connect Pipedrive."],
        ["zoho", { accessToken: "" }, "Enter the access token to connect Zoho."],
        ["sheets", { url: "" }, "Enter the URL to connect Google Sheets."],
        ["webhook", { url: " " }, "Enter the URL to connect your webhook."],
        ["whatsapp", {}, "Enter the phone number ID and access token to connect WhatsApp."],
        ["whatsapp", { phoneNumberId: "123" }, "Enter the access token to connect WhatsApp."],
        ["apollo", {}, "Enter the credentials for Apollo before saving the connection."],
        ["pdl", { apiKey: "" }, "Enter the credentials for People Data Labs before saving the connection."],
      ];
      for (const [provider, config, message] of wording) {
        const w = await req("PUT", `/v1/integrations/${provider}`, A.token, { config });
        expect(w.status, provider).toBe(400);
        expect(w.body.error, provider).toMatchObject({ code: "bad_request", message });
      }
      // The list of missing fields is still there for code.
      expect((await req("PUT", "/v1/integrations/whatsapp", A.token, { config: {} })).body.error.details).toEqual({ missing: ["phoneNumberId", "accessToken"] });
      const ok = await req("PUT", "/v1/integrations/hubspot", A.token, { config: { accessToken: "pat-123" } });
      expect(ok.status).toBe(200);
      await req("DELETE", "/v1/integrations/hubspot", A.token);
    });

    it("a draft with no AI engine says it is a template, and is not charged as an AI message", async () => {
      const l = await lead(A.orgId, { firstName: "Asha", lastName: "Rao" });
      const before = (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, A.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0;
      const r = await req("POST", "/v1/campaigns/generate", A.token, { leadId: l.id, sender: { name: "Me", company: "Us", valueProp: "We help." } });
      expect(r.status).toBe(200);
      expect(r.body.subject).toBeTruthy();
      expect(r.body.body).toBeTruthy();
      expect(r.body.ai).toBe(false);
      expect(r.body.note).toMatch(/AI drafting isn't switched on for this workspace yet, so this is a template/);
      const after = (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, A.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0;
      expect(after).toBe(before);
    });

    it("LinkedIn URL -> email does not report or save a person whose only data is the URL slug", async () => {
      const core = await import("@prospex/core");
      const slug = `another-ee-${u8()}`;
      const url = `https://www.linkedin.com/in/${slug}`;
      const r1 = vi.spyOn(core, "resolveLinkedinUrl").mockResolvedValue({ firstName: "Another", lastName: "Ee", fullName: "Another Ee", linkedinUrl: url, source: "linkedin:slug", confidence: 0.3 } as never);
      const r2 = vi.spyOn(core, "enrichWithProviders").mockResolvedValue(null as never);
      try {
        const r = await req("POST", "/v1/tools/linkedin-to-email", A.token, { urls: [url], save: true });
        expect(r.status).toBe(200);
        expect(r.body.results[0].found).toBe(false);
        expect(r.body.results[0].leadId).toBeUndefined();
        expect(r.body.counts).toMatchObject({ requested: 1, found: 0, saved: 0, skipped: 1 });
        const saved = await db.query.leads.findFirst({ where: S.and(S.eq(S.leads.orgId, A.orgId), S.eq(S.leads.linkedinUrl, url)) });
        expect(saved).toBeUndefined();
      } finally {
        r1.mockRestore();
        r2.mockRestore();
      }
    });

    it("CSV import skips a row that names nobody, reports it, and imports the rest", async () => {
      const csv = `title,email,name\nVP Sales,,\nCTO,imp-${u8()}@example.com,Real Person\n`;
      const r = await req("POST", "/v1/leads/import", A.token, csv, { "content-type": "text/csv" });
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(1);
      expect(r.body.skipped).toBe(1);
      expect(r.body.skippedRows[0]).toMatchObject({ row: 1 });
      expect(r.body.errors).toHaveLength(0);
    });

    it("refuses a webhook to a non-public address", async () => {
      const r = await req("POST", "/v1/webhooks", A.token, { url: "http://localhost:9/hook" });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/not a public address/);
      expect((await req("POST", "/v1/webhooks", A.token, { url: "http://10.0.0.5/hook" })).status).toBe(400);
    });

    it("caps free-text name lengths", async () => {
      expect((await req("POST", "/v1/leads", A.token, { fullName: "x".repeat(600), email: `long-${u8()}@example.com` })).status).toBe(400);
      expect((await req("POST", "/v1/icps", A.token, { name: "x".repeat(500), buildWithAi: false })).status).toBe(400);
      expect((await req("POST", "/v1/campaigns", A.token, { name: "x".repeat(300) })).status).toBe(400);
      // A long-but-real title is fine.
      expect((await req("POST", "/v1/leads", A.token, { fullName: "Long Title", title: "t".repeat(250), email: `lt-${u8()}@example.com` })).status).toBe(201);
    });

    it("validation messages name fields the way a person would", async () => {
      const r = await req("POST", "/v1/campaigns", A.token, { name: "x", settings: { dailyLimit: 0 } });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/^Daily limit must be 1 or more/);
      expect(r.body.error.issues[0].path).toEqual(["settings", "dailyLimit"]);
    });

    it("API create replaces tags rather than merging them (rediscovery still merges)", async () => {
      const email = `tags-${u8()}@example.com`;
      await req("POST", "/v1/leads", A.token, { email, fullName: "Tag Person", tags: ["a", "b"] });
      const r = await req("POST", "/v1/leads", A.token, { email, tags: ["c"] });
      expect(r.status).toBe(200);
      expect(r.body.lead.tags).toEqual(["c"]);
    });

    it("starting a sequence that has email steps with no sender attached says what to attach", async () => {
      const cp = await req("POST", "/v1/campaigns", A.token, { name: "No sender", steps: [{ subjectTemplate: "Hi", bodyTemplate: "Hello" }] });
      expect(cp.status).toBe(201);
      const r = await req("POST", `/v1/campaigns/${cp.body.id}/start`, A.token);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: "bad_request", message: "Attach a sender account first - this sequence has email steps." });
    });

    it("an import that runs into the plan's lead limit says so in a sentence that reads well after its lead-in", async () => {
      const u = await signup("import-quota");
      await db.update(S.organizations).set({ planLimits: { leadsPerMonth: 2 } }).where(S.eq(S.organizations.id, u.orgId));
      const tag = u8();
      const r = await req("POST", "/v1/leads/import", u.token, { leads: [1, 2, 3, 4].map((i) => ({ email: `q${i}-${tag}@example.com`, fullName: `Q ${i}` })) });
      expect(r.status, r.text).toBe(200);
      const quota = "You've used all 2 leads in your plan this month. Upgrade your plan, or wait until next month.";
      expect(r.body).toMatchObject({ created: 2, notProcessed: 1, stopped: `Stopped at row 3 of 4: ${quota}` });
      expect(r.body.errors).toEqual([{ row: 3, error: quota }]);
      // The single-lead route answers with the same sentence, and the same code, status and fields as before.
      const one = await req("POST", "/v1/leads", u.token, { email: `q9-${tag}@example.com` });
      expect(one.status).toBe(402);
      expect(one.body.error).toEqual({ code: "quota_exceeded", message: quota, metric: "leads", used: 2, limit: 2 });
    });

    it("starting a campaign with no contacts works but warns", async () => {
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: A.orgId, provider: "system", fromName: "T", fromEmail: `w-${u8()}@example.com` }).returning();
      const cp = await req("POST", "/v1/campaigns", A.token, { name: "Empty", emailAccountId: acct.id, steps: [{ subjectTemplate: "Hi", bodyTemplate: "Hello" }] });
      expect(cp.status).toBe(201);
      const r = await req("POST", `/v1/campaigns/${cp.body.id ?? cp.body.campaign?.id}/start`, A.token);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("active");
      expect(r.body.warning).toMatch(/no contacts yet/);
      await req("POST", `/v1/campaigns/${cp.body.id ?? cp.body.campaign?.id}/pause`, A.token);
    });

    it("CSV export does not prefix phone numbers but still defuses formulas", async () => {
      const { csvCell } = await import("./lib/csv.js");
      expect(csvCell("+14155550100")).toBe('"+14155550100"');
      expect(csvCell("+1 (415) 555-0100")).toBe('"+1 (415) 555-0100"');
      expect(csvCell("-5")).toBe('"-5"');
      expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
      expect(csvCell("+cmd|' /C calc'!A0")).toMatch(/^"'\+/);
      expect(csvCell("@SUM(1)")).toBe(`"'@SUM(1)"`);
    });
  });
});
