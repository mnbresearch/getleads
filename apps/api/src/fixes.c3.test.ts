/**
 * Fix round C3: find-email verification, AI-missing wording, visibility suggestions without a
 * category, the erased upgrade-request fingerprint and the OpenAPI drift.
 *
 * Through the real app and a real database, in its own Postgres schema (`fixes_c3`).
 * Outbound `fetch` is blocked; the email finder is replaced with a spy, and no AI key is set,
 * so the server has no AI engine at all ("platform" cause).
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.c3.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "fixes_c3";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.APP_URL = "https://app.scout.test";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "AI_PROVIDER", "REOON_API_KEY", "MILLIONVERIFIER_API_KEY"]) delete process.env[k];
  process.env.DDG_DISABLED = "true";
  process.env.BING_HTML_DISABLED = "true";
}

if (!TEST_DB) {
  process.stderr.write(`\n[!] "fixes C3" did NOT run: TEST_DATABASE_URL is not set.\n`);
}

const suite = TEST_DB ? describe : describe.skip;

suite("fixes C3", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let core: any;
  const realFetch = globalThis.fetch;
  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string };
  const OLD_WORDING = /switched on for this workspace/i;
  const PLATFORM_WORDING = /no AI engine is connected on our side/i;

  const u8 = () => randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

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

  async function signup(name: string): Promise<Org> {
    const r = await req("POST", "/v1/auth/signup", null, { email: `${name}-${u8()}@example.com`, password: PASSWORD, orgName: `${name} ${u8()}` });
    expect(r.status, r.text).toBe(201);
    const orgId = r.body.org.id as string;
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId };
  }
  const leadRow = async (id: string) => (await db.select().from(S.leads).where(S.eq(S.leads.id, id)))[0];
  async function mkLead(o: Org, body: Record<string, unknown>) {
    const r = await req("POST", "/v1/leads", o.token, body);
    expect(r.status, r.text).toBeLessThan(300);
    return r.body.lead as any;
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
    vi.stubGlobal("fetch", (async () => {
      throw new Error("fixes.c3.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    core = await import("@prospex/core");
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. Find email: the same address back never downgrades a verified one ──
  describe("POST /v1/leads/:id/find-email, same address", () => {
    const answer = (email: string, status: string, verifiedBy?: string) => ({ email, status, confidence: 0.5, pattern: "{first}.{last}", candidates: [], verifiedBy });

    async function verifiedLead(name: string) {
      const o = await signup(name);
      const domain = `${name}-${u8()}.example`;
      const lead = await mkLead(o, { firstName: "Ann", lastName: "Lee", email: `ann.lee@${domain}`, companyDomain: domain });
      const verifiedAt = new Date("2026-09-01T00:00:00Z");
      await db.update(S.leads).set({ emailStatus: "valid", emailConfidence: 0.97, verifiedAt, emailVerifiedBy: "reoon:safe" }).where(S.eq(S.leads.id, lead.id));
      return { o, lead, email: `ann.lee@${domain}`, verifiedAt };
    }

    it("an unchecked guess of the same address leaves the verified status and stamp alone", async () => {
      const { o, lead, email, verifiedAt } = await verifiedLead("fe-guess");
      vi.spyOn(core, "findEmail").mockResolvedValue(answer(email, "risky") as never);
      const r = await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ saved: true, replaced: false });
      const row = await leadRow(lead.id);
      expect(row).toMatchObject({ email, emailStatus: "valid", emailVerifiedBy: "reoon:safe" });
      expect(new Date(row.verifiedAt).toISOString()).toBe(verifiedAt.toISOString());
    });

    it("a blocked SMTP probe is not a verification either", async () => {
      const { o, lead, email } = await verifiedLead("fe-blocked");
      vi.spyOn(core, "findEmail").mockResolvedValue(answer(email, "risky", "smtp-blocked") as never);
      await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      const row = await leadRow(lead.id);
      expect(row).toMatchObject({ emailStatus: "valid", emailVerifiedBy: "reoon:safe" });
    });

    it("a real verifier answer for the same address is recorded", async () => {
      const { o, lead, email, verifiedAt } = await verifiedLead("fe-real");
      vi.spyOn(core, "findEmail").mockResolvedValue(answer(email, "catch_all", "millionverifier:catch_all") as never);
      await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      const row = await leadRow(lead.id);
      expect(row).toMatchObject({ emailStatus: "catch_all", emailVerifiedBy: "millionverifier:catch_all" });
      expect(new Date(row.verifiedAt).getTime()).toBeGreaterThan(verifiedAt.getTime());
    });

    it("filling an empty address from a blocked probe does not stamp it verified", async () => {
      const o = await signup("fe-empty");
      const domain = `empty-${u8()}.example`;
      const lead = await mkLead(o, { firstName: "Bo", lastName: "Kim", companyDomain: domain });
      vi.spyOn(core, "findEmail").mockResolvedValue(answer(`bo.kim@${domain}`, "risky", "smtp-blocked") as never);
      await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      const row = await leadRow(lead.id);
      expect(row.email).toBe(`bo.kim@${domain}`);
      expect(row.verifiedAt).toBeNull();
      expect(row.emailVerifiedBy).toBeNull();
    });
  });

  // ── 2. AI-missing wording names the real cause ──
  describe("AI-missing wording", () => {
    it("the company brief says the server has no engine, not that the workspace switched it off", async () => {
      const o = await signup("brief");
      const lead = await mkLead(o, { fullName: "Cy Ng", email: `cy-${u8()}@brief-${u8()}.example`, companyDomain: `brief-${u8()}.example` });
      const companyId = (await leadRow(lead.id)).companyId;
      expect(companyId).toBeTruthy();
      const r = await req("POST", `/v1/companies/${companyId}/brief`, o.token, {});
      expect(r.status, r.text).toBe(200);
      expect(r.body.brief).toBeNull();
      expect(r.body.error).toMatch(PLATFORM_WORDING);
      expect(r.body.error).not.toMatch(OLD_WORDING);
    });

    it("a workspace that switched AI off is told so on the brief", async () => {
      const o = await signup("brief-off");
      await db.update(S.organizations).set({ settings: { aiDisabled: true } }).where(S.eq(S.organizations.id, o.orgId));
      const lead = await mkLead(o, { fullName: "Di Oz", email: `di-${u8()}@off-${u8()}.example`, companyDomain: `off-${u8()}.example` });
      const r = await req("POST", `/v1/companies/${(await leadRow(lead.id)).companyId}/brief`, o.token, {});
      expect(r.body.error).toMatch(/turned off for this workspace/);
    });

    it("ICP chat answers 503 with the platform cause", async () => {
      const o = await signup("icpchat");
      const icp = await req("POST", "/v1/icps", o.token, { name: "Founders", buildWithAi: false });
      expect(icp.status, icp.text).toBeLessThan(300);
      const id = icp.body.icp?.id ?? icp.body.id;
      const r = await req("POST", `/v1/icps/${id}/chat`, o.token, { message: "narrow to fintech" });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("ai_unavailable");
      expect(r.body.error.message).toMatch(PLATFORM_WORDING);
      expect(r.body.error.message).not.toMatch(OLD_WORDING);
    });

    it("visibility sampling 503 names the server, not the workspace", async () => {
      const o = await signup("visrun");
      const p = await req("POST", "/v1/visibility/prompts", o.token, { text: "What is the best CRM for founders?" });
      expect(p.status, p.text).toBeLessThan(300);
      const id = p.body.prompt?.id ?? p.body.id;
      const r = await req("POST", `/v1/visibility/prompts/${id}/run`, o.token, {});
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("ai_not_configured");
      expect(r.body.error.message).toMatch(/^AI visibility can't be sampled: no AI engine is connected on our side/);
    });

    it("ICP score re-rank without AI carries the cause as a note", async () => {
      const o = await signup("rerank");
      const icp = await req("POST", "/v1/icps", o.token, { name: "Rerank", buildWithAi: false, criteria: { titles: ["CEO"] } });
      const id = icp.body.icp?.id ?? icp.body.id;
      await mkLead(o, { fullName: "Eve Ceo", title: "CEO", email: `eve-${u8()}@rr.example` });
      const r = await req("POST", `/v1/icps/${id}/score`, o.token, { aiRerankTop: 5 });
      expect(r.status, r.text).toBe(200);
      expect(r.body.aiRerank).toMatchObject({ skipped: "no_ai_provider" });
      expect(r.body.aiRerank.note).toMatch(PLATFORM_WORDING);
    });
  });

  // ── 3. Visibility suggestions without a category ──
  describe("POST /v1/visibility/prompts/suggest", () => {
    it("without a category returns no invented questions and asks for the category", async () => {
      const o = await signup("nocat");
      const r = await req("POST", "/v1/visibility/prompts/suggest", o.token, {});
      expect(r.status, r.text).toBe(200);
      expect(r.body.prompts).toEqual([]);
      expect(r.body.needsCategory).toBe(true);
      expect(r.body.note).toMatch(/product category/);
      expect(r.text).not.toMatch(/B2B software/);
    });

    it("asking for AI with no category and no engine says both", async () => {
      const o = await signup("nocat-ai");
      const r = await req("POST", "/v1/visibility/prompts/suggest", o.token, { ai: true });
      expect(r.body.prompts).toEqual([]);
      expect(r.body.needsCategory).toBe(true);
      expect(r.body.note).toMatch(PLATFORM_WORDING);
      expect(r.body.note).toMatch(/product category/);
    });

    it("with a category keeps the starter questions, and they read naturally", async () => {
      const o = await signup("cat");
      const r = await req("POST", "/v1/visibility/prompts/suggest", o.token, { category: "CRM" });
      expect(r.body.source).toBe("starter");
      expect(r.body.needsCategory).toBeUndefined();
      expect(r.body.prompts.length).toBeGreaterThanOrEqual(4);
      const texts = r.body.prompts.map((p: any) => p.text);
      expect(texts).toContain("What is the best CRM?");
      for (const t of texts) expect(t).not.toMatch(/without dedicated software/);
    });

    it("with AI asked for and no engine, the starter note names the platform cause", async () => {
      const o = await signup("cat-ai");
      const r = await req("POST", "/v1/visibility/prompts/suggest", o.token, { ai: true, category: "lead generation" });
      expect(r.body.prompts.length).toBeGreaterThan(0);
      expect(r.body.note).toMatch(PLATFORM_WORDING);
      expect(r.body.note).not.toMatch(OLD_WORDING);
    });
  });

  // ── 6. Erased upgrade requests keep a keyed fingerprint, not a plain sha256 ──
  describe("data-subject erase of upgrade requests", () => {
    it("stores a keyed fingerprint that a plain hash of the address does not reproduce", async () => {
      const { eraseDataSubject, erasedAddressFingerprint } = await import("./lib/privacyErase.js");
      const person = `gina-${u8()}@erase.example`;
      const [row] = await db.insert(S.upgradeRequests).values({ orgId: null, name: "Gina", email: person, mobile: "+100", country: "UK", planId: "growth", message: "call me" }).returning();
      const out = await eraseDataSubject(person);
      expect(out.upgradeRequestsAnonymised).toBe(1);
      const [after] = await db.select().from(S.upgradeRequests).where(S.eq(S.upgradeRequests.id, row.id));
      const plain = `sha256:${createHash("sha256").update(person, "utf8").digest("hex")}`;
      expect(after.email).not.toBe(plain);
      expect(after.email).not.toContain(createHash("sha256").update(person, "utf8").digest("hex"));
      expect(after.email).toBe(erasedAddressFingerprint(person));
      expect(after.email.startsWith("sha256:k1:")).toBe(true);
      expect(after).toMatchObject({ name: "(removed)", mobile: "(removed)", message: null });
    });
  });

  // ── 7. OpenAPI drift ──
  describe("OpenAPI", () => {
    let spec: any;
    beforeAll(async () => {
      const r = await req("GET", "/openapi.json");
      expect(r.status).toBe(200);
      spec = r.body;
    });
    const op = (path: string, method: string) => spec.paths[path]?.[method];

    it("public inbound documents 401/413/429 and not 404", () => {
      const o = op("/v1/public/inbound/{token}", "post");
      expect(o).toBeTruthy();
      for (const code of ["401", "413", "429"]) expect(o.responses[code]).toBeTruthy();
      expect(o.responses["404"]).toBeUndefined();
    });

    it("402 plan_limit on campaign create and integration connect", () => {
      expect(op("/v1/campaigns", "post").responses["402"]).toBeTruthy();
      expect(op("/v1/integrations/{provider}", "put").responses["402"]).toBeTruthy();
    });

    it("503 on visibility run and email-events resend", () => {
      expect(op("/v1/visibility/prompts/{id}/run", "post").responses["503"]).toBeTruthy();
      expect(op("/v1/email-events/resend", "post").responses["503"]).toBeTruthy();
    });

    it("forgot-password 200 carries emailUnavailable and message", () => {
      const schema = op("/v1/auth/password/forgot", "post").responses["200"].content["application/json"].schema;
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["ok", "emailUnavailable", "message"]));
    });

    it("audit-log actorEmail and targetId are nullable", () => {
      const json = JSON.stringify(op("/v1/audit-log", "get").responses["200"]);
      expect(json).toMatch(/"actorEmail":\{"type":\["string","null"\]/);
      expect(json).toMatch(/"targetId":\{"type":\["string","null"\]/);
    });

    it("signals subscription run documents the 202 job answer and ?wait=1", () => {
      const o = op("/v1/signals/subscriptions/{id}/run", "post");
      expect(o.responses["202"]).toBeTruthy();
      expect(o.responses["200"]).toBeTruthy();
      expect(o.parameters.map((p: any) => p.name)).toContain("wait");
    });

    it("automation discover documents the blocked 200 shape", () => {
      const json = JSON.stringify(op("/v1/automation/discover", "post").responses["200"]);
      expect(json).toMatch(/blocked/);
      expect(json).toMatch(/"note"/);
    });
  });
});
