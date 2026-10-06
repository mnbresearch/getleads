/**
 * The final fix round, outside plays: the invite-link check for the join page, what a
 * session check answers when it fails for a reason that is not an outage, and what a
 * campaign preview costs when no model runs.
 *
 * Through the real app and a real database, in its own Postgres schema (`final_fixes`).
 * `fetch` answers only for a made-up AI provider (and only in the test that sets one);
 * mail is captured. Nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.final.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "final_fixes";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker";
  process.env.MAIL_FROM = "Scout <no-reply@platform.test>";
  process.env.APP_URL = "https://app.scout.test";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "AI_PROVIDER"]) delete process.env[k];
}

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text?: string }[] }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string; text?: string }) => {
      mail.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}-${Math.random()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(`\n[!] "final fixes" did NOT run: TEST_DATABASE_URL is not set.\n    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.final.test.ts\n`);
}

const suite = TEST_DB ? describe : describe.skip;

suite("final fixes", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let createApp: any;
  let db: any;
  let S: any;
  const realFetch = globalThis.fetch;
  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string; userId: string; email: string; name: string };

  const u8 = () => randomUUID().slice(0, 8);
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  /** AI calls made, and the answer to give; null means no model may be asked at all. */
  const ai = { calls: 0, answer: null as null | (() => unknown) };

  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}, on: any = app) {
    const res: Response = await on.request(path, {
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

  async function signup(name: string): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const orgName = `${name} ${u8()}`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName });
    expect(r.status, r.text).toBe(201);
    const orgId = r.body.org.id as string;
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId, userId: r.body.user.id, email, name: orgName };
  }
  const usageOf = async (orgId: string, metric: string) => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, orgId), S.eq(S.usage.metric, metric))))[0]?.count ?? 0;
  const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
  async function invite(o: Org, email = `joiner-${u8()}@invited.example`) {
    const r = await req("POST", "/v1/tools/team/invite", o.token, { email });
    expect(r.status, r.text).toBe(201);
    return { id: r.body.id as string, email, token: tokenOf(r.body.link), expiresAt: r.body.expiresAt as string };
  }
  const check = (token: unknown, on: any = app) => req("POST", "/v1/auth/join/check", null, { token }, {}, on);

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
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as { url: string }).url);
      if (new URL(url).hostname === "api.groq.com" && ai.answer) {
        ai.calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ai.answer()) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("fixes.final.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    ({ createApp } = await import("./app.js"));
    app = createApp();
  }, 120_000);

  afterEach(() => {
    mail.sent.length = 0;
    ai.calls = 0;
    ai.answer = null;
    delete process.env.GROQ_API_KEY;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── B14: the join page can ask whether its link is still good ──────────────────────
  describe("POST /v1/auth/join/check", () => {
    it("says a good link is good - with the workspace's name, the invited address masked, and when it expires - and uses nothing up", async () => {
      const o = await signup("check");
      const inv = await invite(o, `jordan-${u8()}@invited.example`);
      const r = await check(inv.token);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ valid: true, orgName: o.name, email: "j***@invited.example", expiresAt: inv.expiresAt });
      expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
      // The whole address is never in the answer.
      expect(r.text).not.toContain(inv.email);
      // Asking changes nothing: asked five times, the link still works, once.
      for (let i = 0; i < 4; i++) expect((await check(inv.token)).body.valid).toBe(true);
      const [row] = await db.select().from(S.invites).where(S.eq(S.invites.id, inv.id));
      expect([row.acceptedAt, row.revokedAt]).toEqual([null, null]);
      const joined = await req("POST", "/v1/auth/join", null, { token: inv.token, password: "member-password-1", name: "Jordan" });
      expect(joined.status, joined.text).toBe(200);
      // No sign-in is needed, and one that is sent is not looked at.
      expect((await req("POST", "/v1/auth/join/check", "not-a-token", { token: inv.token })).status).toBe(200);
    });

    it("says why a link cannot be used: used, cancelled, expired, or not a link at all", async () => {
      const o = await signup("check-reasons");
      const used = await invite(o);
      expect((await req("POST", "/v1/auth/join", null, { token: used.token, password: "member-password-1" })).status).toBe(200);
      expect((await check(used.token)).body).toEqual({ valid: false, reason: "used" });

      const revoked = await invite(o);
      expect((await req("DELETE", `/v1/tools/team/invites/${revoked.id}`, o.token)).status).toBe(200);
      expect((await check(revoked.token)).body).toEqual({ valid: false, reason: "revoked" });

      const expired = await invite(o);
      await db.update(S.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(S.eq(S.invites.id, expired.id));
      expect((await check(expired.token)).body).toEqual({ valid: false, reason: "expired" });
      // Re-sent: the old link is no longer a link, the new one is good.
      const resent = await req("POST", `/v1/tools/team/invites/${expired.id}/resend`, o.token);
      expect(resent.status).toBe(200);
      expect((await check(expired.token)).body).toEqual({ valid: false, reason: "not_found" });
      expect((await check(tokenOf(resent.body.link))).body.valid).toBe(true);
      // An invite from before expiry dates existed expires 14 days after it was made.
      const legacy = await invite(o);
      await db.execute(S.sql`UPDATE invites SET expires_at = NULL, created_at = now() - interval '15 days' WHERE id = ${legacy.id}`);
      expect((await check(legacy.token)).body).toEqual({ valid: false, reason: "expired" });
      await db.execute(S.sql`UPDATE invites SET created_at = now() - interval '13 days' WHERE id = ${legacy.id}`);
      expect((await check(legacy.token)).body.valid).toBe(true);

      for (const junk of [randomUUID(), "x", "a".repeat(200), "' OR 1=1 --", used.id]) expect((await check(junk)).body).toEqual({ valid: false, reason: "not_found" });
      // The hash that is stored is not a link either.
      const [stored] = await db.select().from(S.invites).where(S.eq(S.invites.id, legacy.id));
      expect((await check(stored.tokenHash)).body).toEqual({ valid: false, reason: "not_found" });

      // A workspace that is suspended accepts nobody; to the holder of the link there is no such invite.
      const closed = await signup("check-closed");
      const theirs = await invite(closed);
      await db.update(S.organizations).set({ status: "deactivated" }).where(S.eq(S.organizations.id, closed.orgId));
      expect((await check(theirs.token)).body).toEqual({ valid: false, reason: "not_found" });
    });

    it("never says whether an address has an account, and gives the same shape of answer whatever it finds", async () => {
      const o = await signup("check-quiet");
      // The invited address gets an account of its own elsewhere after the invite was sent.
      const inv = await invite(o);
      const elsewhere = await req("POST", "/v1/auth/signup", null, { email: inv.email, password: PASSWORD, orgName: `other ${u8()}` });
      expect(elsewhere.status).toBe(201);
      const fresh = await invite(o);
      const a = await check(inv.token);
      const b = await check(fresh.token);
      // Both are simply valid: only the join itself can say "an account with this email already exists".
      expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
      expect(a.body.valid).toBe(true);
      expect((await req("POST", "/v1/auth/join", null, { token: inv.token, password: "member-password-1" })).body.error.code).toBe("exists");
      // And the same lookups are made whether or not the token matches anything.
      const spyInvites = vi.spyOn(db.query.invites, "findFirst");
      const spyOrgs = vi.spyOn(db.query.organizations, "findFirst");
      const spyUsers = vi.spyOn(db.query.users, "findFirst");
      await check(fresh.token);
      const hit = [spyInvites.mock.calls.length, spyOrgs.mock.calls.length, spyUsers.mock.calls.length];
      await check(randomUUID());
      const miss = [spyInvites.mock.calls.length - hit[0], spyOrgs.mock.calls.length - hit[1], spyUsers.mock.calls.length - hit[2]];
      expect(hit).toEqual([1, 1, 0]);
      expect(miss).toEqual([1, 1, 0]);
    });

    it("refuses a body without a usable token, limits how often one address may ask, and writes the token nowhere", async () => {
      for (const body of [{}, { token: "" }, { token: "a".repeat(201) }, { token: 12 }, { token: null }]) {
        const r = await req("POST", "/v1/auth/join/check", null, body);
        expect([JSON.stringify(body).slice(0, 30), r.status, r.body.error.code]).toEqual([JSON.stringify(body).slice(0, 30), 400, "validation_error"]);
      }
      const o = await signup("check-log");
      const inv = await invite(o);
      // An app whose request log we can read, and every console stream.
      const lines: string[] = [];
      const logged = createApp({ accessLog: (line: string) => lines.push(line) });
      for (const stream of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
      const auditBefore = (await db.select({ n: S.sql`count(*)::int` }).from(S.auditLog))[0].n;
      const from = { "cf-connecting-ip": "203.0.113.77" };
      const ok = await req("POST", "/v1/auth/join/check", null, { token: inv.token }, from, logged);
      expect(ok.body.valid).toBe(true);
      await req("POST", "/v1/auth/join/check", null, { token: `${inv.token}x` }, from, logged);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(inv.token);
      expect(lines.join("\n")).not.toContain(inv.email);
      // Not an audited action, and nothing about it is stored.
      expect((await db.select({ n: S.sql`count(*)::int` }).from(S.auditLog))[0].n).toBe(auditBefore);
      // Ten a minute from one address; the eleventh is told to wait. Another address is not affected.
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) statuses.push((await req("POST", "/v1/auth/join/check", null, { token: inv.token }, from, logged)).status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(8);
      expect(statuses.slice(8)).toEqual([429, 429]);
      expect((await check(inv.token, logged)).status).toBe(200);
      // Being told to wait here does not stop the join itself.
      expect((await req("POST", "/v1/auth/join", null, { token: inv.token, password: "member-password-1" }, from, logged)).status).toBe(200);
    });
  });

  // ── B6: a session check that fails is not always an outage ─────────────────────────
  describe("a session check that fails", () => {
    it("answers 401 only for the credential, 503 only for a database that cannot be reached, and a fault as a fault", async () => {
      const o = await signup("auth-faults");
      const me = () => req("GET", "/v1/auth/me", o.token);
      expect((await me()).status).toBe(200);
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));

      // A bug in our own code (or a column that is not there): a fault, reported as one.
      const spy = vi.spyOn(db.query.users, "findFirst");
      spy.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'tokenVersion')"));
      const bug = await me();
      expect([bug.status, bug.body.error.code]).toEqual([500, "internal_error"]);
      expect(bug.headers.get("retry-after")).toBeNull();
      spy.mockRejectedValueOnce(Object.assign(new Error('Failed query: select ... params: secret'), { cause: Object.assign(new Error('column "token_version" does not exist'), { code: "42703", severity: "ERROR" }) }));
      const schema = await me();
      expect([schema.status, schema.body.error.code]).toEqual([500, "internal_error"]);
      expect(schema.text).not.toMatch(/temporarily unavailable/i);
      // Logged with what identifies it - never as "database unavailable".
      expect(errors.join("\n")).toMatch(/unhandled GET/);
      expect(errors.join("\n")).not.toMatch(/database unavailable/);

      // The database cannot be reached: try again, and stay signed in.
      spy.mockRejectedValueOnce(Object.assign(new Error("Failed query: select ..."), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
      const outage = await me();
      expect([outage.status, outage.body.error.code]).toEqual([503, "service_unavailable"]);
      expect(outage.headers.get("retry-after")).toBe("10");
      spy.mockRejectedValueOnce(Object.assign(new Error("too many clients already"), { code: "53300" }));
      expect((await me()).status).toBe(503);

      // A value in the token that the database cannot use: nobody we recognise.
      spy.mockRejectedValueOnce(Object.assign(new Error("Failed query: select ..."), { cause: Object.assign(new Error('invalid input syntax for type uuid: "abc"'), { code: "22P02", severity: "ERROR" }) }));
      const bad = await me();
      expect(bad.status).toBe(401);

      // The same three answers for an API key.
      const key = (await req("POST", "/v1/auth/api-keys", o.token, { name: "k" })).body.key as string;
      expect(key).toBeTruthy();
      const withKey = () => req("GET", "/v1/auth/me", null, undefined, { "x-api-key": key });
      expect((await withKey()).status).toBe(200);
      const keySpy = vi.spyOn(db.query.apiKeys, "findFirst");
      keySpy.mockRejectedValueOnce(new RangeError("Invalid array length"));
      expect((await withKey()).status).toBe(500);
      keySpy.mockRejectedValueOnce(Object.assign(new Error("Failed query: select ..."), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }));
      expect((await withKey()).status).toBe(503);
      expect((await withKey()).status).toBe(200);
      expect((await me()).status).toBe(200);
    });
  });

  // ── B12: a preview is charged only when a model runs ───────────────────────────────
  describe("POST /v1/campaigns/:id/preview", () => {
    async function campaignWithStep(o: Org) {
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound", settings: { senderCompany: "Scout", valueProp: "find buyers" } }).returning();
      await db.insert(S.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi {{first_name}}", bodyTemplate: "Hello {{first_name}}, a quick note.", aiPersonalize: true });
      await db.insert(S.sequenceSteps).values({ campaignId: campaign.id, stepNo: 2, channel: "email", subjectTemplate: "Again", bodyTemplate: "Hello again {{first_name}}.", aiPersonalize: false });
      const [lead] = await db.insert(S.leads).values({ orgId: o.orgId, email: `p-${u8()}@example.com`, firstName: "Pat", fullName: "Pat Prospect" }).returning();
      return { campaign, lead };
    }
    const preview = (o: Org, campaignId: string, leadId: string, stepNo = 1) => req("POST", `/v1/campaigns/${campaignId}/preview`, o.token, { leadId, stepNo });

    it("costs nothing when there is no AI engine: the preview is the rendered template", async () => {
      const o = await signup("preview-none");
      const { campaign, lead } = await campaignWithStep(o);
      const r = await preview(o, campaign.id, lead.id);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ subject: "Hi Pat", personalized: false });
      expect(r.body.body).toContain("Hello Pat, a quick note.");
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
      // Even with no AI allowance left, the template preview still answers.
      await db.update(S.organizations).set({ planLimits: { ...S.limitsFor("scale"), aiMessagesPerMonth: 1 } }).where(S.eq(S.organizations.id, o.orgId));
      await db.insert(S.usage).values({ orgId: o.orgId, period: S.currentPeriod(), metric: "aiMessages", count: 1 });
      expect((await preview(o, campaign.id, lead.id)).status).toBe(200);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      expect(ai.calls).toBe(0);
    });

    it("costs one AI message when a model writes it, nothing for a step that is not personalised, and nothing when AI is turned off", async () => {
      const o = await signup("preview-ai");
      const { campaign, lead } = await campaignWithStep(o);
      process.env.GROQ_API_KEY = "gsk_test_key_not_real";
      ai.answer = () => ({ subject: "Quick idea for Pat", body: "Hi Pat,\n\nA short note about finding buyers.\n\nAsha" });
      const r = await preview(o, campaign.id, lead.id);
      expect(r.status, r.text).toBe(200);
      expect(ai.calls).toBeGreaterThanOrEqual(1);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      // The step that is plain template text never asks a model.
      const calls = ai.calls;
      expect((await preview(o, campaign.id, lead.id, 2)).body.subject).toBe("Again");
      expect(ai.calls).toBe(calls);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      // AI turned off for the workspace: the template, a note that says why, and no charge.
      await db.update(S.organizations).set({ settings: { aiDisabled: true } }).where(S.eq(S.organizations.id, o.orgId));
      const off = await preview(o, campaign.id, lead.id);
      expect(off.body).toMatchObject({ aiOff: true, subject: "Hi Pat" });
      expect(ai.calls).toBe(calls);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      // No allowance left and a model that would run: refused before the model is asked.
      await db.update(S.organizations).set({ settings: {}, planLimits: { ...S.limitsFor("scale"), aiMessagesPerMonth: 1 } }).where(S.eq(S.organizations.id, o.orgId));
      const over = await preview(o, campaign.id, lead.id);
      expect([over.status, over.body.error.code]).toEqual([402, "quota_exceeded"]);
      expect(ai.calls).toBe(calls);
    });
  });
});
