/**
 * C1 fix round: signals, discovery quota, search decoys.
 *
 *  1. A signals run in which the people search could not really search says so ("could not
 *     run", with the customer sentence), never "nobody with the target titles was found".
 *  3. A discovery call that could not search gives its search unit back - every path that
 *     charges first: /v1/search (job), quick, people, companies, agent prospect, automation
 *     discover, tools colleagues and decision makers, saved-search and autopilot jobs. A call
 *     that did search (a keyed source answered, empty) is still charged.
 *  4. POST /v1/signals/subscriptions/:id/run is a job: 202 with a job id, progress and result
 *     through GET /v1/search/jobs/:jobId; `?wait=1` keeps the synchronous answer.
 *  5. Signals location: city-only company rows, "Trinidad and Tobago", publisher suffix only.
 *  6. /v1/automation/discover answers 200 `{ status: "blocked", note }` when nothing could
 *     search, and a Preview records no agent run.
 *
 * The setting is production's: no keyed search source, the keyless Bing scraper answering
 * with an empty page. Real app, real database, own schema (`c1_fixes`); nothing leaves the
 * machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.c1.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "c1_fixes";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.APP_URL = "https://app.scout.test";
  process.env.DDG_DISABLED = "true";
  process.env.BING_HTML_DISABLED = "false";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "AI_PROVIDER", "REOON_API_KEY", "MILLIONVERIFIER_API_KEY", "ABSTRACT_EMAIL_API_KEY"]) delete process.env[k];
}

vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: `t-${Date.now()}` })) };
});

if (!TEST_DB) process.stderr.write(`\n[!] "C1 fixes" did NOT run: TEST_DATABASE_URL is not set.\n`);

const suite = TEST_DB ? describe : describe.skip;

suite("C1 fixes: signals, discovery quota, search decoys", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let core: any;
  let NO_SOURCE: string;
  const realFetch = globalThis.fetch;
  const u8 = () => randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  /** When set, google.serper.dev answers with this organic list (a keyed source that answers). */
  let serperOrganic: unknown[] | null = null;

  async function req(method: string, path: string, token?: string | null, body?: unknown) {
    const res: Response = await app.request(path, {
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

  async function signup(name: string) {
    const r = await req("POST", "/v1/auth/signup", null, { email: `${name}-${u8()}@example.com`, password: "correct-horse-battery", orgName: `${name} ${u8()}` });
    expect(r.status, r.text).toBe(201);
    const orgId = r.body.org.id as string;
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token as string, orgId };
  }

  async function searchesUsed(orgId: string): Promise<number> {
    const rows = await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, orgId), S.eq(S.usage.metric, "searches"), S.eq(S.usage.period, S.currentPeriod())));
    return rows.reduce((n: number, r: { count: number }) => n + r.count, 0);
  }

  async function runJob(jobId: string) {
    const { handlers } = await import("./jobs.js");
    await S.runJobById(db, handlers, jobId);
  }

  beforeAll(async () => {
    try {
      const { default: postgres } = await import("postgres");
      const admin = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await admin.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB;
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as { url: string }).url);
      const host = new URL(url).hostname;
      if (host === "www.bing.com") return new Response("<html><body><ol id=b_results></ol></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      if (host === "google.serper.dev" && serperOrganic) return new Response(JSON.stringify({ organic: serperOrganic }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("fixes.c1.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    core = await import("@prospex/core");
    NO_SOURCE = core.NO_WEB_SEARCH_CONFIGURED;
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
    vi.restoreAllMocks();
  });

  // ── 3. A search that could not run is not charged ──

  describe("a discovery call that could not search gives its search back", () => {
    it("quick, people, companies, agent prospect: answered with the note, usage unchanged", async () => {
      const o = await signup("refund-sync");
      expect(await searchesUsed(o.orgId)).toBe(0);
      const q = await req("POST", "/v1/search/quick", o.token, { query: "CTO at fintech companies", limit: 3, findEmails: false });
      expect(q.status, q.text).toBe(200);
      expect(q.body.note).toBe(NO_SOURCE);
      expect(await searchesUsed(o.orgId)).toBe(0);
      const p = await req("POST", "/v1/search/people", o.token, { companyName: "Acme Logistics", titles: ["CEO"] });
      expect(p.body).toEqual({ people: [], note: NO_SOURCE });
      const c = await req("POST", "/v1/search/companies", o.token, { query: "logistics software", resolveDomains: false });
      expect(c.body).toEqual({ companies: [], note: NO_SOURCE });
      const a = await req("POST", "/v1/agent/prospect", o.token, { query: "Founders of D2C brands in Mumbai", limit: 3, findEmails: false });
      expect(a.status, a.text).toBe(200);
      expect(a.body.note).toBe(NO_SOURCE);
      expect(await searchesUsed(o.orgId)).toBe(0);
    });

    it("tools colleagues and decision makers", async () => {
      const o = await signup("refund-tools");
      const dm = await req("POST", "/v1/tools/decision-makers", o.token, { companyName: "Acme Logistics", save: false, findEmails: false });
      expect(dm.body.note).toBe(NO_SOURCE);
      const col = await req("POST", "/v1/tools/colleagues", o.token, { companyDomain: "acme-logistics.example", titles: ["CTO"] });
      expect(col.body.note).toBe(NO_SOURCE);
      expect(await searchesUsed(o.orgId)).toBe(0);
    });

    it("automation discover (a real run, not a preview)", async () => {
      const o = await signup("refund-auto");
      const r = await req("POST", "/v1/automation/discover", o.token, { query: "VP Sales at B2B SaaS companies", count: 5 });
      expect(r.body.status).toBe("blocked");
      expect(await searchesUsed(o.orgId)).toBe(0);
    });

    it("the async search job, the saved-search job and the autopilot job", async () => {
      const o = await signup("refund-jobs");
      const s = await req("POST", "/v1/search", o.token, { query: "Head of Sales at SaaS companies", findEmails: false, limit: 5 });
      expect(s.status, s.text).toBe(202);
      // Charged when queued...
      expect(await searchesUsed(o.orgId)).toBe(1);
      await runJob(s.body.jobId);
      const job = await req("GET", `/v1/search/jobs/${s.body.jobId}`, o.token);
      expect(job.body.result).toMatchObject({ note: NO_SOURCE, searchRefunded: true });
      // ...and given back when the run could not search.
      expect(await searchesUsed(o.orgId)).toBe(0);

      const ss = await req("POST", "/v1/tools/saved-searches", o.token, { name: "D2C founders", query: { query: "Founders of D2C brands", findEmails: false, limit: 5 } });
      const ssRun = await req("POST", `/v1/tools/saved-searches/${ss.body.id ?? ss.body.savedSearch?.id}/run`, o.token);
      expect(ssRun.status, ssRun.text).toBe(202);
      await runJob(ssRun.body.jobId);
      expect((await req("GET", `/v1/search/jobs/${ssRun.body.jobId}`, o.token)).body.result).toMatchObject({ note: NO_SOURCE, searchRefunded: true });
      expect(await searchesUsed(o.orgId)).toBe(0);

      const ap = await req("POST", "/v1/tools/autopilots", o.token, { name: "Daily founders", query: { query: "Founders of D2C brands", findEmails: false } });
      expect([200, 201]).toContain(ap.status);
      const apRun = await req("POST", `/v1/tools/autopilots/${ap.body.id ?? ap.body.autopilot?.id}/run`, o.token);
      expect([200, 202]).toContain(apRun.status);
      if (apRun.body.jobId) await runJob(apRun.body.jobId);
      expect(await searchesUsed(o.orgId)).toBe(0);
    });

    it("a search that did run (a keyed source answered, with nobody) is still charged, and has no note", async () => {
      const o = await signup("charged");
      process.env.SERPER_API_KEY = "test-serper-key";
      serperOrganic = [];
      try {
        const p = await req("POST", "/v1/search/people", o.token, { companyName: `Nobodyhere ${u8()}`, titles: ["CEO"] });
        expect(p.status, p.text).toBe(200);
        expect(p.body).toEqual({ people: [] });
        expect(await searchesUsed(o.orgId)).toBe(1);
      } finally {
        delete process.env.SERPER_API_KEY;
        serperOrganic = null;
      }
    });
  });

  // ── 6. Automation discover: 200 blocked, and Preview records nothing ──

  describe("/v1/automation/discover", () => {
    it("no source could search: 200 with status blocked, the note, and the error shape the UI reads", async () => {
      const o = await signup("auto-200");
      const r = await req("POST", "/v1/automation/discover", o.token, { query: "VP Sales at B2B SaaS companies", count: 5 });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ status: "blocked", note: NO_SOURCE, found: 0, created: 0, error: { code: "providers_unavailable", message: NO_SOURCE } });
      expect(r.body.runId).toBeTruthy();
      const runs = await req("GET", "/v1/automation/runs", o.token);
      expect(runs.body.runs).toHaveLength(1);
      expect(runs.body.runs[0]).toMatchObject({ status: "blocked" });
    });

    it("a Preview creates no agent-run row and charges nothing", async () => {
      const o = await signup("auto-preview");
      const r = await req("POST", "/v1/automation/discover", o.token, { query: "VP Sales at B2B SaaS companies", count: 5, preview: true });
      expect(r.status, r.text).toBe(200);
      expect(r.body.runId).toBeNull();
      const runs = await req("GET", "/v1/automation/runs", o.token);
      expect(runs.body.runs).toEqual([]);
      const rows = await db.select().from(S.agentRuns).where(S.eq(S.agentRuns.orgId, o.orgId));
      expect(rows).toEqual([]);
      expect(await searchesUsed(o.orgId)).toBe(0);
    });

    it("quota spent is still 402", async () => {
      const o = await signup("auto-quota");
      await db.insert(S.usage).values({ orgId: o.orgId, period: S.currentPeriod(), metric: "searches", count: 1_000_000 });
      const r = await req("POST", "/v1/automation/discover", o.token, { query: "founders at fintech startups" });
      expect(r.status).toBe(402);
    });
  });

  // ── 4 and 1. Subscription runs are jobs, and say why no leads were made ──

  describe("POST /v1/signals/subscriptions/:id/run", () => {
    async function subscription(o: { token: string }, extra: Record<string, unknown> = {}) {
      const r = await req("POST", "/v1/signals/subscriptions", o.token, { name: `Funded ${u8()}`, types: ["funding"], keywords: [], locations: [], targetTitles: ["CEO"], autoCreateLeads: true, ...extra });
      expect(r.status, r.text).toBe(201);
      return r.body.id as string;
    }

    it("answers 202 with a job id; a second press returns the same job; the job carries progress and the result", async () => {
      const o = await signup("sub-job");
      const id = await subscription(o);
      const r = await req("POST", `/v1/signals/subscriptions/${id}/run`, o.token);
      expect(r.status, r.text).toBe(202);
      expect(r.body).toMatchObject({ status: "queued", subscriptionId: id, poll: `/v1/search/jobs/${r.body.jobId}` });
      const again = await req("POST", `/v1/signals/subscriptions/${id}/run`, o.token);
      expect(again.status).toBe(202);
      expect(again.body).toMatchObject({ jobId: r.body.jobId, alreadyRunning: true });
      const before = await req("GET", `/v1/search/jobs/${r.body.jobId}`, o.token);
      expect(before.body).toMatchObject({ type: "signals.subscription", status: "queued" });
      await runJob(r.body.jobId);
      const after = await req("GET", `/v1/search/jobs/${r.body.jobId}`, o.token);
      expect(after.body).toMatchObject({ status: "done", progress: 100 });
      expect(after.body.result).toEqual(expect.objectContaining({ parsed: expect.any(Number), stored: expect.any(Number), matched: expect.any(Number), leadsCreated: expect.any(Number) }));
      // Another workspace cannot read that job, or run that subscription.
      const other = await signup("sub-other");
      expect((await req("GET", `/v1/search/jobs/${r.body.jobId}`, other.token)).status).toBe(404);
      expect((await req("POST", `/v1/signals/subscriptions/${id}/run`, other.token)).status).toBe(404);
    });

    it("?wait=1 keeps the synchronous answer", async () => {
      const o = await signup("sub-wait");
      const id = await subscription(o);
      const r = await req("POST", `/v1/signals/subscriptions/${id}/run?wait=1`, o.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toEqual(expect.objectContaining({ parsed: expect.any(Number), matched: expect.any(Number) }));
      expect(r.body.jobId).toBeUndefined();
    });

    it("Run now on a paused subscription still runs (as the synchronous route did)", async () => {
      const o = await signup("sub-paused");
      const id = await subscription(o, { active: false });
      const r = await req("POST", `/v1/signals/subscriptions/${id}/run`, o.token);
      await runJob(r.body.jobId);
      const job = await req("GET", `/v1/search/jobs/${r.body.jobId}`, o.token);
      expect(job.body.status).toBe("done");
      expect(job.body.result.skipped).toBeUndefined();
      expect(job.body.result).toHaveProperty("matched");
    });

    it("a match whose people search could not run says so, not 'nobody with the target titles'", async () => {
      const o = await signup("sub-why");
      const tag = u8();
      await db.insert(S.signals).values({ orgId: o.orgId, type: "funding", companyName: `Globex ${tag}`, title: `Globex ${tag} raises $5M seed round - Reuters`, summary: "Seed round.", url: `https://news.example/globex-${tag}`, source: "Reuters", confidence: 0.9, raw: {} });
      const id = await subscription(o);
      const r = await req("POST", `/v1/signals/subscriptions/${id}/run?wait=1`, o.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body.matched).toBeGreaterThanOrEqual(1);
      expect(r.body.leadsCreated).toBe(0);
      expect(r.body.note).toMatch(/the people search could not run for/);
      expect(r.body.note).toContain(NO_SOURCE);
      expect(r.body.note).not.toMatch(/nobody with the target titles/);
      const subs = await req("GET", "/v1/signals/subscriptions", o.token);
      const row = subs.body.subscriptions.find((s: { id: string }) => s.id === id);
      expect(row.stats).toMatchObject({ lastRunSearchFailed: 1, lastRunNoPerson: 0 });
    });
  });

  // ── 5. Location and publisher rules ──

  describe("signals location and publisher", () => {
    it("a company row with a city but no country lets the headline answer a country filter", async () => {
      const { locationMatches } = await import("./services/signals.js");
      // City-only row: the headline may name the country.
      expect(locationMatches(["india"], "bengaluru, karnataka", "bengaluru-based acme raises $5m in india's fintech boom", { companyHasCountry: false })).toBe(true);
      // A row that names its country decides on its own, as before.
      expect(locationMatches(["india"], "berlin germany", "acme expands to india", { companyHasCountry: true })).toBe(false);
      expect(locationMatches(["india"], "berlin germany", "india news")).toBe(false);
      // City-only row and a headline that says nothing about the country: no match.
      expect(locationMatches(["india"], "springfield", "acme raises $5m", { companyHasCountry: false })).toBe(false);
      expect(locationMatches(["bengaluru"], "bengaluru, karnataka", "", { companyHasCountry: false })).toBe(true);
    });

    it("plausibleLocation keeps place names with 'and' and still refuses headlines", async () => {
      const { plausibleLocation } = await import("./services/signals.js");
      expect(plausibleLocation("Trinidad and Tobago")).toBe("Trinidad and Tobago");
      expect(plausibleLocation("Port of Spain, Trinidad and Tobago")).toBe("Port of Spain, Trinidad and Tobago");
      expect(plausibleLocation("Jammu and Kashmir, India")).toBe("Jammu and Kashmir, India");
      expect(plausibleLocation("Head of Sales at Zed | India")).toBeUndefined();
      expect(plausibleLocation("Sales at Acme")).toBeUndefined();
    });

    it("ownText strips the publisher only as a trailing suffix", async () => {
      const { ownText } = await import("./services/signals.js");
      expect(ownText({ title: "Reuters cuts 200 jobs in India - Reuters", source: "Reuters" }).headline).toBe("reuters cuts 200 jobs in india");
      expect(ownText({ title: "Mint raises prices | Mint", source: "Mint" }).headline).toBe("mint raises prices");
      expect(ownText({ title: "Acme raises - Investing.com India", source: "Investing.com India" }).headline).toBe("acme raises");
      // Not at the end: left alone.
      expect(ownText({ title: "Investing.com India launches an app", source: "Investing.com India" }).headline).toBe("investing.com india launches an app");
      expect(ownText({ title: "Acme raises", summary: "Acme raised $5M.  Investing.com India", source: "Investing.com India" }).body).toBe("acme raised $5m.");
      expect(ownText({ title: "Acme raises", summary: "Investing.com India reports Acme raised", source: "Investing.com India" }).body).toBe("investing.com india reports acme raised");
    });
  });
});
