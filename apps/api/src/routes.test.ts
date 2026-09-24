/**
 * Route surface tests.
 *
 * The integration suite covers the queries behind individual features. This covers the
 * thing no unit test can: that every route the app actually registers can be reached,
 * that none of them crashes on a well-formed request, and that the ones behind auth are
 * genuinely behind auth.
 *
 * It walks `app.routes` rather than a hand-written list, so a route added later is
 * included the moment it is mounted - a checklist someone has to remember to update is a
 * checklist that goes stale, and a route nobody remembered to test is exactly where a 500
 * lives.
 *
 * Running them:
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.JOB_MODE = "inline";
  // Nothing in this file should be able to reach the open internet or bill a provider.
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
}

/**
 * Without a database these suites skip rather than fail, so `npm test` stays green on a
 * machine that has none. That is a deliberate trade - but a skipped suite that says nothing
 * trains people to read green as "everything passed", so it says something.
 */
if (!TEST_DB) {
  // stderr directly: vitest captures console output and prints it per-test, so a warning
  // about tests that are NOT running would itself never be shown.
  process.stderr.write(
    `\n[!] ${JSON.stringify("route surface")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests that cover SQL, auth, tenancy and the job pipeline.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("route surface", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let token = "";
  let apiKey = "";
  let orgId = "";

  /** A placeholder for each path parameter: a real uuid, so validation is exercised. */
  const PARAM = () => randomUUID();

  const fill = (path: string) =>
    path
      .replace(/:([A-Za-z0-9_]+)\??/g, (_m, name: string) => (/id$/i.test(name) ? PARAM() : "placeholder"))
      .replace(/\/\*$/, "/x")
      .replace(/\*/g, "x");

  /** Routes that are deliberately excluded, each with the reason it is excluded. */
  const SKIP: { match: RegExp; why: string }[] = [
    { match: /^\/docs$|^\/openapi\.json$/, why: "static documents, no behaviour to assert here" },
    { match: /^\/internal\/jobs\/run$/, why: "drains the real job queue; covered by the jobs suite" },
    { match: /^\/v1\/billing\/plans$/, why: "the public price list; the pricing page reads it before anyone signs in" },
  ];

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    ({ createApp: app } = await import("./app.js"));
    app = app();

    const email = `routes-${randomUUID()}@example.com`;
    const res = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Route Test", orgName: "Route Test Co" }),
    });
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    token = body.token;
    apiKey = body.apiKey ?? "";
    const me = await (await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${token}` } })).json();
    orgId = me.org?.id ?? "";
  });

  it("signs a new workspace up and issues a usable token", () => {
    expect(token).toBeTruthy();
    expect(orgId).toBeTruthy();
  });

  it("answers /health with the database it is actually using", async () => {
    const r = await app.request("/health");
    expect(r.status).toBe(200);
    expect((await r.json()).db).toBe("up");
  });

  it("registers every route group", () => {
    const paths = new Set(app.routes.map((r: any) => r.path));
    for (const p of ["/v1/leads", "/v1/campaigns", "/v1/icps", "/v1/visibility/overview", "/v1/signals", "/v1/companies", "/v1/visitors"]) {
      expect([...paths].some((x) => String(x).startsWith(p))).toBe(true);
    }
  });

  /**
   * No GET behind auth may crash, and none may answer without a token.
   *
   * Two failures in one pass, because they are the same mistake seen from either side: a
   * route that 500s tells the user their data is broken, and a route that answers without
   * a token tells someone else's user the same data.
   */
  it("every authenticated GET rejects an anonymous caller and survives a real one", async () => {
    const gets = app.routes.filter(
      (r: any) =>
        r.method === "GET" &&
        String(r.path).startsWith("/v1/") &&
        !String(r.path).startsWith("/v1/admin") &&
        !String(r.path).startsWith("/v1/auth") &&
        !SKIP.some((s) => s.match.test(String(r.path))),
    );
    expect(gets.length).toBeGreaterThan(15);

    const leaked: string[] = [];
    const crashed: string[] = [];

    for (const r of gets) {
      const path = fill(String(r.path));

      const anon = await app.request(path);
      if (anon.status !== 401 && anon.status !== 403) leaked.push(`${path} -> ${anon.status}`);

      const auth = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      if (auth.status >= 500) crashed.push(`${path} -> ${auth.status} ${(await auth.text()).slice(0, 200)}`);
    }

    expect(leaked).toEqual([]);
    expect(crashed).toEqual([]);
  }, 120_000);

  /**
   * API keys are the only credential the SDK and the MCP server have. The rebrand changed
   * the prefix keys are ISSUED with (gl_ -> px_live_) and left the prefix the server
   * ACCEPTS untouched, so every key the product handed out from that point on was rejected
   * - and the 401 told people to send a prefix the product no longer issues. Nothing in the
   * web app noticed, because the web app uses a JWT.
   */
  it("accepts the API key it just issued", async () => {
    expect(apiKey).toMatch(/^px_live_/);
    const r = await app.request("/v1/leads", { headers: { "x-api-key": apiKey } });
    expect(r.status).toBe(200);
  });

  it("accepts a key created from the Settings page", async () => {
    const made = await app.request("/v1/auth/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "From settings" }),
    });
    expect(made.status).toBeLessThan(300);
    const made_ = await made.json();
    const key = made_.key ?? made_.apiKey;
    expect(typeof key).toBe("string");
    const r = await app.request("/v1/leads", { headers: { "x-api-key": key } });
    expect(r.status).toBe(200);
  });

  it("still honours a key issued under the pre-rebrand prefix", async () => {
    const dbPkg = await import("@prospex/db");
    const { createHash, randomBytes } = await import("node:crypto");
    const raw = `gl_${randomBytes(24).toString("base64url")}`;
    await dbPkg.getDb().db.insert(dbPkg.apiKeys).values({
      orgId,
      name: "Legacy",
      prefix: raw.slice(0, 12),
      keyHash: createHash("sha256").update(raw).digest("hex"),
    });
    const r = await app.request("/v1/leads", { headers: { "x-api-key": raw } });
    expect(r.status).toBe(200);
  });

  it("rejects an unknown key rather than falling through to another workspace", async () => {
    const r = await app.request("/v1/leads", { headers: { "x-api-key": "px_live_definitelynotreal" } });
    expect(r.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const r = await app.request("/v1/leads", { headers: { authorization: "Bearer not.a.real.token" } });
    expect(r.status).toBe(401);
  });

  it("returns 404, not 500, for a well-formed id that does not exist", async () => {
    for (const path of [`/v1/leads/${randomUUID()}`, `/v1/campaigns/${randomUUID()}`, `/v1/icps/${randomUUID()}`]) {
      const r = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      // A random uuid belongs to nobody, so the only correct answer is 404. Accepting 200
      // as well - as this test used to - would also pass if the route ignored the id.
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
  });

  /**
   * `/v1/leads/abc` used to reach Postgres, which rejects "abc" for a uuid column, and came
   * back a 500: an on-call page, a real error buried in the log, and a user told their data
   * is broken when their URL was. Postgres rejecting a value the CLIENT sent is a 400.
   */
  it("returns 400, not 500, for a malformed id on every route that takes one", async () => {
    const results: { path: string; status: number; code?: string }[] = [];
    for (const path of ["/v1/leads/not-a-uuid", "/v1/icps/not-a-uuid", "/v1/campaigns/not-a-uuid", "/v1/companies/not-a-uuid"]) {
      const r = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      const body = await r.json().catch(() => ({}));
      results.push({ path, status: r.status, code: (body as any)?.error?.code });
    }
    // Asserted positively. An earlier version of this test accepted "anything under 500",
    // which passes for a 200 and for a 404 - so it would have gone on passing if the fix
    // it exists to protect were reverted to any other non-crashing behaviour.
    for (const r of results) {
      expect(r).toEqual({ path: r.path, status: 400, code: "bad_request" });
    }
  });

  /** A mutating route open to the world is worse than a readable one. */
  it("puts every mutating route behind authentication", async () => {
    const writes = app.routes.filter(
      (r: any) =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) &&
        String(r.path).startsWith("/v1/") &&
        !String(r.path).startsWith("/v1/auth") &&
        !String(r.path).startsWith("/v1/admin") &&
        // Public by design, each for a stated reason: inbound webhooks (signed), the
        // embeddable lead-capture form and tracking pixels (org token in the body), and
        // the pricing page's "contact me about upgrading" form, which is filled in by
        // people who by definition do not have an account yet.
        !/webhook|capture|track|unsubscribe|px|upgrade-requests/.test(String(r.path)),
    );
    expect(writes.length).toBeGreaterThan(10);

    const open: string[] = [];
    for (const r of writes) {
      const res = await app.request(fill(String(r.path)), {
        method: r.method,
        headers: { "content-type": "application/json" },
        body: r.method === "DELETE" ? undefined : "{}",
      });
      if (res.status !== 401 && res.status !== 403) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  }, 120_000);

  it("rejects a body that fails validation with a 400 and a readable message", async () => {
    const r = await app.request("/v1/icps", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(r.status).toBe(400);
    expect((await r.text()).length).toBeGreaterThan(0);
  });

  it("keeps one workspace's data out of another's", async () => {
    const other = `routes-${randomUUID()}@example.com`;
    const signup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: other, password: "correct-horse-battery", orgName: "Other Co" }),
    });
    const otherToken = (await signup.json()).token;

    const created = await app.request("/v1/icps", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Mine", criteria: { titles: ["VP Sales"] } }),
    });
    expect(created.status).toBeLessThan(300);
    const icp = (await created.json()).icp;

    const stolen = await app.request(`/v1/icps/${icp.id}`, { headers: { authorization: `Bearer ${otherToken}` } });
    expect(stolen.status).toBe(404);

    const list = await (await app.request("/v1/icps", { headers: { authorization: `Bearer ${otherToken}` } })).json();
    const rows = Array.isArray(list) ? list : (list.icps ?? []);
    expect(rows.some((r: any) => r.id === icp.id)).toBe(false);
  });

  /**
   * Reading was scoped consistently; REFERENCES were not. A field validated only as
   * `z.string().uuid()` could name a row in another workspace, and the write went through -
   * a campaign pointing at a foreign email account decrypts that tenant's SMTP credentials,
   * sends from their address and burns their daily cap; a signal subscription pointing at a
   * foreign campaign enrolls our leads into their sequence, which then emails them.
   */
  describe("cross-workspace references", () => {
    let otherToken = "";
    let otherEmailAccountId = "";
    let otherCampaignId = "";

    beforeAll(async () => {
      const signup = await app.request("/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `victim-${randomUUID()}@example.com`, password: "correct-horse-battery", orgName: "Victim Co" }),
      });
      otherToken = (await signup.json()).token;

      const dbPkg = await import("@prospex/db");
      const db = dbPkg.getDb().db;
      const me = await (await app.request("/v1/auth/me", { headers: { authorization: `Bearer ${otherToken}` } })).json();
      const victimOrg = me.org.id;

      const [acct] = await db
        .insert(dbPkg.emailAccounts)
        .values({ orgId: victimOrg, provider: "smtp", fromEmail: "victim@victim.test", fromName: "Victim", config: {} as never })
        .returning();
      otherEmailAccountId = acct.id;

      const made = await app.request("/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Victim campaign" }),
      });
      const created = await made.json();
      otherCampaignId = created.campaign?.id ?? created.id;
    });

    it("refuses a campaign that points at another workspace's email account", async () => {
      const r = await app.request("/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Borrowed sender", emailAccountId: otherEmailAccountId }),
      });
      expect(r.status).toBe(404);
    });

    it("refuses to move an existing campaign onto another workspace's email account", async () => {
      const mine = await app.request("/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Mine" }),
      });
      const mineBody = await mine.json();
      const id = mineBody.campaign?.id ?? mineBody.id;
      const r = await app.request(`/v1/campaigns/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ emailAccountId: otherEmailAccountId }),
      });
      expect(r.status).toBe(404);
    });

    it("refuses a signal subscription that enrolls into another workspace's campaign", async () => {
      expect(otherCampaignId).toBeTruthy();
      const r = await app.request("/v1/signals/subscriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Piggyback", types: ["funding"], autoCreateLeads: true, campaignId: otherCampaignId }),
      });
      expect(r.status).toBe(404);
    });

    it("refuses to remove a lead from another workspace's list", async () => {
      const made = await app.request("/v1/leads/lists", {
        method: "POST",
        headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Victim list" }),
      });
      const listId = (await made.json()).id;
      const r = await app.request(`/v1/leads/lists/${listId}/leads/${randomUUID()}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(404);
    });

    it("still accepts a reference to the caller's own row", async () => {
      const icp = await app.request("/v1/icps", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Own icp", buildWithAi: false }),
      });
      const icpId = (await icp.json()).icp.id;
      const r = await app.request("/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Own everything", icpId }),
      });
      expect(r.status).toBeLessThan(300);
    });
  });

  /**
   * The endpoints the UI now calls, exercised end to end.
   *
   * Wiring a button to a route proves nothing on its own - it has to be the right route,
   * with the right body, and the effect has to stick. These drive exactly what the pages
   * send, so a page that looks wired but is not fails here rather than in front of a user.
   */
  describe("the newly wired controls actually work", () => {
    async function makeLead() {
      const r = await app.request("/v1/leads", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Priya", lastName: "Sharma", email: `wired-${randomUUID().slice(0, 8)}@example.com`, title: "VP Sales" }),
      });
      const body = await r.json();
      return body.lead ?? body;
    }

    it("moves a lead through the pipeline and can filter by stage", async () => {
      const lead = await makeLead();
      expect(lead.id).toBeTruthy();

      const moved = await app.request(`/v1/tools/leads/${lead.id}/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "qualified" }),
      });
      expect(moved.status).toBeLessThan(300);
      expect((await moved.json()).status).toBe("qualified");

      // The filter the Leads page now sends. It did not exist before, so "show me everyone
      // I have qualified" was unaskable.
      const listed = await (await app.request("/v1/leads?status=qualified", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(listed.leads.some((l: any) => l.id === lead.id)).toBe(true);

      const other = await (await app.request("/v1/leads?status=lost", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(other.leads.some((l: any) => l.id === lead.id)).toBe(false);
    });

    it("rejects a stage the funnel does not have", async () => {
      const lead = await makeLead();
      const r = await app.request(`/v1/tools/leads/${lead.id}/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "extremely interested" }),
      });
      expect(r.status).toBe(400);
    });

    it("reads and writes the do-not-contact list", async () => {
      const email = `optout-${randomUUID().slice(0, 8)}@example.com`;
      const added = await app.request("/v1/leads/suppressions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ emails: [email], reason: "added by hand" }),
      });
      expect(added.status).toBeLessThan(300);

      const list = await (await app.request("/v1/leads/suppressions/all", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(list.suppressions.some((s: any) => s.email === email)).toBe(true);
    });

    it("deletes a list without deleting the leads in it", async () => {
      const lead = await makeLead();
      const made = await app.request("/v1/leads/lists", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Temp list" }),
      });
      const list = await made.json();
      await app.request(`/v1/leads/lists/${list.id}/leads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: [lead.id] }),
      });

      const gone = await app.request(`/v1/leads/lists/${list.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      expect(gone.status).toBeLessThan(300);

      const lists = await (await app.request("/v1/leads/lists/all", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(lists.lists.some((l: any) => l.id === list.id)).toBe(false);

      // The promise the confirmation makes: the leads survive.
      const still = await app.request(`/v1/leads/${lead.id}`, { headers: { authorization: `Bearer ${token}` } });
      expect(still.status).toBe(200);
    });

    it("removes a lead from a list without deleting the lead", async () => {
      const lead = await makeLead();
      const made = await app.request("/v1/leads/lists", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Membership list" }),
      });
      const list = await made.json();
      await app.request(`/v1/leads/lists/${list.id}/leads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: [lead.id] }),
      });

      const r = await app.request(`/v1/leads/lists/${list.id}/leads/${lead.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBeLessThan(300);

      const inList = await (await app.request(`/v1/leads?listId=${list.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
      expect(inList.leads.some((l: any) => l.id === lead.id)).toBe(false);
      expect((await app.request(`/v1/leads/${lead.id}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    });

    it("deletes a campaign, and the deleted campaign stops being listed", async () => {
      const made = await app.request("/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Throwaway" }),
      });
      const body = await made.json();
      const id = body.campaign?.id ?? body.id;

      expect((await app.request(`/v1/campaigns/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBeLessThan(300);
      const list = await (await app.request("/v1/campaigns", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(list.campaigns.some((c: any) => c.id === id)).toBe(false);
    });

    it("pauses and resumes a tracked visibility question", async () => {
      const made = await app.request("/v1/visibility/prompts", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "best b2b prospecting tools for india", samplesPerRun: 3 }),
      });
      const prompt = await made.json();
      expect(prompt.active).toBe(true);

      const paused = await app.request(`/v1/visibility/prompts/${prompt.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ active: false, samplesPerRun: 5 }),
      });
      const after = await paused.json();
      expect(after.active).toBe(false);
      expect(after.samplesPerRun).toBe(5);

      expect((await app.request(`/v1/visibility/prompts/${prompt.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBeLessThan(300);
    });

    it("serves the raw answers the landing page promises are kept", async () => {
      const r = await app.request("/v1/visibility/runs?limit=5", { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(Array.isArray((await r.json()).runs)).toBe(true);
    });

    it("refuses to sync to a CRM that is not connected, rather than silently doing nothing", async () => {
      const lead = await makeLead();
      const r = await app.request("/v1/integrations/hubspot/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ leadIds: [lead.id] }),
      });
      expect(r.status).toBe(404);
    });

    it("creates an ad-hoc task and lists it as pending", async () => {
      const made = await app.request("/v1/tools/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Call Priya back about the pilot", type: "call" }),
      });
      expect(made.status).toBeLessThan(300);
      const task = await made.json();

      const list = await (await app.request("/v1/tools/tasks?status=pending", { headers: { authorization: `Bearer ${token}` } })).json();
      expect(list.tasks.some((t: any) => t.id === task.id)).toBe(true);
    });

    it("serves the signal types the page now reads instead of hardcoding", async () => {
      const r = await app.request("/v1/signals/types", { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      const { types } = await r.json();
      expect(types).toContain("funding");
      expect(types.length).toBeGreaterThan(3);
    });

    it("rebuilds an ICP's profile on request, which editing used to only pretend to do", async () => {
      const made = await app.request("/v1/icps", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Rebuildable", description: "B2B SaaS founders in India", buildWithAi: false }),
      });
      const { icp } = await made.json();
      const r = await app.request(`/v1/icps/${icp.id}/build`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      // The route must EXIST and accept the call - a 404 would mean the Edit button is
      // calling nothing, which is the defect this covers. An earlier version of this test
      // listed 404 among the acceptable outcomes, so it would have passed with the route
      // missing entirely.
      expect(r.status).not.toBe(404);
      expect(r.status).toBeLessThan(400);
      // And it must actually queue the work, not just answer politely.
      const body = await r.json();
      expect(body.jobId ?? body.queued ?? body.ok).toBeTruthy();
    });
  });

  it("guards the admin surface", async () => {
    const admins = app.routes.filter((r: any) => r.method === "GET" && String(r.path).startsWith("/v1/admin"));
    expect(admins.length).toBeGreaterThan(0);
    for (const r of admins) {
      const res = await app.request(fill(String(r.path)), { headers: { authorization: `Bearer ${token}` } });
      // A normal workspace token must not be an admin token.
      expect([401, 403]).toContain(res.status);
    }
  });
});
