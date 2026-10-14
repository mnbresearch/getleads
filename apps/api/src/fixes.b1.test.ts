/**
 * B1 fix round: every discovery path says, in one plain sentence, when no search source
 * could actually search - instead of returning an empty list that reads as "nobody matched".
 * Also: a blocked SMTP probe does not stamp a lead as verified.
 *
 * The setting is production's: no keyed search source, only the keyless Bing scraper, which
 * "answers" with an empty page. Through the real app and a real database, in its own schema
 * (`b1_fixes`). `fetch` answers only for bing.com (an empty results page); nothing leaves
 * the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.b1.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "b1_fixes";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.APP_URL = "https://app.scout.test";
  // Production's search setup: nothing keyed, the Bing scraper on, DuckDuckGo off.
  process.env.DDG_DISABLED = "true";
  process.env.BING_HTML_DISABLED = "false";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "AI_PROVIDER", "REOON_API_KEY", "MILLIONVERIFIER_API_KEY", "ABSTRACT_EMAIL_API_KEY"]) delete process.env[k];
}

vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: `t-${Date.now()}` })) };
});

if (!TEST_DB) process.stderr.write(`\n[!] "B1 fixes" did NOT run: TEST_DATABASE_URL is not set.\n`);

const suite = TEST_DB ? describe : describe.skip;

suite("B1 fixes: discovery says when nothing could search", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let NO_SOURCE: string;
  const realFetch = globalThis.fetch;
  const u8 = () => randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `203.0.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  let bingCalls = 0;

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
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as { url: string }).url);
      if (new URL(url).hostname === "www.bing.com") {
        bingCalls++;
        // What a blocked scraper usually gets: a page, with no results on it.
        return new Response("<html><body><ol id=b_results></ol></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error("fixes.b1.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    NO_SOURCE = (await import("@prospex/core")).NO_WEB_SEARCH_CONFIGURED;
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
    vi.restoreAllMocks();
  });

  it("POST /v1/search/quick: empty results carry the note and the failure", async () => {
    const o = await signup("quick");
    const r = await req("POST", "/v1/search/quick", o.token, { query: "CTO at fintech companies", limit: 3, findEmails: false });
    expect(r.status, r.text).toBe(200);
    expect(bingCalls).toBeGreaterThan(0);
    expect(r.body.results).toEqual([]);
    expect(r.body.note).toBe(NO_SOURCE);
    expect(r.body.providerFailures).toEqual([{ provider: "web_search", message: NO_SOURCE }]);
  });

  it("POST /v1/search/people and /companies: a `note` alongside the empty array", async () => {
    const o = await signup("pc");
    const p = await req("POST", "/v1/search/people", o.token, { companyName: "Acme Logistics", titles: ["CEO"] });
    expect(p.status, p.text).toBe(200);
    expect(p.body).toEqual({ people: [], note: NO_SOURCE });
    const c = await req("POST", "/v1/search/companies", o.token, { query: "logistics software", resolveDomains: false });
    expect(c.status, c.text).toBe(200);
    expect(c.body).toEqual({ companies: [], note: NO_SOURCE });
  });

  it("POST /v1/search (async job): the job result has the note, and the search row the error", async () => {
    const o = await signup("async");
    const r = await req("POST", "/v1/search", o.token, { query: "Head of Sales at SaaS companies", findEmails: false, limit: 5 });
    expect(r.status, r.text).toBe(202);
    const { handlers } = await import("./jobs.js");
    await S.runJobById(db, handlers, r.body.jobId);
    const job = await req("GET", `/v1/search/jobs/${r.body.jobId}`, o.token);
    expect(job.body.status).toBe("done");
    expect(job.body.result.note).toBe(NO_SOURCE);
    const s = await req("GET", `/v1/search/${r.body.search.id}`, o.token);
    expect(s.body.search).toMatchObject({ status: "done", resultCount: 0, error: NO_SOURCE });
  });

  it("POST /v1/agent/prospect: note set, and sender.signature is accepted", async () => {
    const o = await signup("agent");
    const r = await req("POST", "/v1/agent/prospect", o.token, { query: "Founders of D2C brands in Mumbai", limit: 3, findEmails: false, generateEmails: true, sender: { name: "Ann", company: "Scout", valueProp: "more leads", signature: "Ann\nScout" } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.count).toBe(0);
    expect(r.body.note).toBe(NO_SOURCE);
  });

  it("POST /v1/automation/discover: blocked (502) with the sentence, never 'every configured source answered'", async () => {
    const o = await signup("auto");
    const r = await req("POST", "/v1/automation/discover", o.token, { query: "VP Sales at B2B SaaS companies", count: 5 });
    expect(r.status, r.text).toBe(502);
    expect(r.body.status).toBe("blocked");
    expect(r.body.error).toMatchObject({ code: "providers_unavailable", message: NO_SOURCE });
    expect(r.text).not.toMatch(/Every configured source answered/);
    const runs = await req("GET", "/v1/automation/runs", o.token);
    expect(runs.body.runs[0]).toMatchObject({ status: "blocked", error: NO_SOURCE });
  });

  it("Tools: decision makers and colleagues say why the list is empty", async () => {
    const o = await signup("tools");
    const dm = await req("POST", "/v1/tools/decision-makers", o.token, { companyName: "Acme Logistics", save: false, findEmails: false });
    expect(dm.status, dm.text).toBe(200);
    expect(dm.body.people).toEqual([]);
    expect(dm.body.note).toBe(NO_SOURCE);
    const col = await req("POST", "/v1/tools/colleagues", o.token, { companyDomain: "acme-logistics.example", titles: ["CTO"] });
    expect(col.status, col.text).toBe(200);
    expect(col.body.people).toEqual([]);
    expect(col.body.note).toBe(NO_SOURCE);
  });

  it("a saved search run records the note in its job result", async () => {
    const o = await signup("saved");
    const ss = await req("POST", "/v1/tools/saved-searches", o.token, { name: "D2C founders", query: { query: "Founders of D2C brands", findEmails: false, limit: 5 } });
    expect([200, 201]).toContain(ss.status);
    const run = await req("POST", `/v1/tools/saved-searches/${ss.body.id ?? ss.body.savedSearch?.id}/run`, o.token);
    expect(run.status, run.text).toBe(202);
    const { handlers } = await import("./jobs.js");
    await S.runJobById(db, handlers, run.body.jobId);
    const job = await req("GET", `/v1/search/jobs/${run.body.jobId}`, o.token);
    expect(job.body.result).toMatchObject({ results: 0, fresh: 0, note: NO_SOURCE });
  });

  it("a blocked SMTP probe does not stamp verifiedAt; a real SMTP check does", async () => {
    const o = await signup("smtp");
    const { upsertLead } = await import("./services/leads.js");
    const blocked = await upsertLead(o.orgId, { fullName: "Bea Blocked", email: `bea-${u8()}@acme.example`, emailStatus: "risky", emailConfidence: 0.5, emailVerifiedBy: "smtp-blocked", source: "test" });
    expect(blocked.lead.verifiedAt).toBeNull();
    const checked = await upsertLead(o.orgId, { fullName: "Cy Checked", email: `cy-${u8()}@acme.example`, emailStatus: "valid", emailConfidence: 0.93, emailVerifiedBy: "smtp", source: "test" });
    expect(checked.lead.verifiedAt).not.toBeNull();
  });
});
