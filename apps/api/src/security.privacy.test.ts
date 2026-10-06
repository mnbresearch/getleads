/**
 * Privacy regressions: what Scout keeps about people who never signed up for it, and whether
 * it does what its own Privacy Policy says.
 *
 *  - the visitor pixel honours do-not-track signals, keeps no raw IP at rest, stores a keyed
 *    hash, drops query strings, and looks addresses up over HTTPS only;
 *  - every email carries the unsubscribe footer (and the workspace's mailing address), and
 *    every channel - email, WhatsApp, manual tasks, the reply box - checks the workspace's
 *    AND the platform's do-not-contact list first;
 *  - deleting a lead removes its copies; a platform admin can find and erase a person
 *    everywhere; a purged workspace leaves nothing behind;
 *  - a workspace can turn AI off, and inbound mail from strangers never reaches a model;
 *  - retention: the cleanup job enforces the numbers the Privacy Policy states;
 *  - the SDK cannot be steered onto another API path and never sends a key over plain HTTP.
 *
 * Through the real app (createApp) and a real database, in its own Postgres schema
 * (`sec_privacy`) - the retention pass and the erasure act on whole tables. `fetch` is
 * stubbed and mail is captured: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "sec_privacy";
const ADMIN_TOKEN = randomBytes(24).toString("hex");

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
  process.env.API_URL = "https://api.scout.test";
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "OUTBOUND_SENDING_ENABLED"]) delete process.env[k];
}

type Sent = { to: string; from: string; subject: string; text: string; html?: string; headers?: Record<string, string> };
const mocks = vi.hoisted(() => ({ sent: [] as Sent[], platformMailer: false }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    systemMailerConfig: () => (mocks.platformMailer ? { provider: "resend" as const, resendApiKey: "re_test_platform_key" } : orig.systemMailerConfig()),
    sendMail: vi.fn(async (_cfg: unknown, input: Sent) => {
      mocks.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Math.random().toString(36).slice(2)}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] "privacy" did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    These are the tests for the visitor pixel, do-not-contact lists, lead erasure, the AI switch and retention.\n" +
      "    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

suite("privacy: pixel, do-not-contact, erasure, AI switch, retention", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let pv: typeof import("./lib/privacyVisitor.js");
  let ps: typeof import("./lib/privacySuppression.js");
  let pe: typeof import("./lib/privacyErase.js");
  let pr: typeof import("./lib/privacyRetention.js");
  let campaignsSvc: typeof import("./services/campaigns.js");
  let leadsSvc: typeof import("./services/leads.js");
  let visitorsSvc: typeof import("./services/visitors.js");
  let aiLib: typeof import("./lib/ai.js");
  let jobHandlers: any;
  let rateWindow: typeof import("./lib/rateWindow.js");

  const PASSWORD = "correct-horse-battery";
  const u8 = () => randomUUID().slice(0, 8);
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const realFetch = globalThis.fetch;
  const ctx = () => ({ db, progress: async () => {}, log: () => {} });
  const ALL_DAY = { timezone: "UTC", sendWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, dailyLimit: 500 };

  /** Every outbound request the code under test tried to make, and what the stub answers. */
  const net = { calls: [] as { url: string; body: string }[], answer: null as null | ((url: string, init?: RequestInit) => Response | null) };

  async function raw(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    return app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await raw(method, path, token, body, headers);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, headers: res.headers as Headers };
  }
  const admin = (method: string, path: string, body?: unknown) => req(method, `/v1/admin${path}`, null, body, { "x-admin-token": ADMIN_TOKEN });

  type Org = { token: string; orgId: string; orgName: string; userId: string; email: string; apiKey: string };
  async function signup(name: string): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const orgName = `${name} ${u8()}`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName });
    expect(r.status).toBe(201);
    const orgId = r.body.org.id as string;
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId, orgName, userId: r.body.user.id, email, apiKey: r.body.apiKey };
  }
  async function addMember(o: Org, role: "member" | "admin") {
    const email = `${role}-${u8()}@example.com`;
    const inv = await req("POST", "/v1/tools/team/invite", o.token, { email, role });
    expect(inv.status).toBe(201);
    const join = await req("POST", "/v1/auth/join", null, { token: new URL(inv.body.link).searchParams.get("token"), password: "member-password-1", name: role });
    expect(join.status).toBe(200);
    return { token: join.body.token as string, id: join.body.user.id as string, email };
  }

  async function newOrg(name = "p", patch: Record<string, unknown> = {}) {
    const [org] = await db.insert(S.organizations).values({ name: `${name} ${u8()}`, slug: `${name}-${u8()}`, plan: "scale", planLimits: S.limitsFor("scale"), ...patch }).returning();
    return org;
  }
  async function newAccount(orgId: string) {
    const [acct] = await db.insert(S.emailAccounts).values({ orgId, provider: "system", fromName: "Asha", fromEmail: `asha-${u8()}@tenantco.example`, dailyLimit: 500 }).returning();
    await db.execute(S.sql`UPDATE email_accounts SET created_at = now() - interval '120 days' WHERE id = ${acct.id}`);
    return (await db.query.emailAccounts.findFirst({ where: S.eq(S.emailAccounts.id, acct.id) }))!;
  }
  /** A workspace with a sender, an active campaign and one step on the given channel. */
  async function setup(opts: { channel?: string; settings?: Record<string, unknown>; orgSettings?: Record<string, unknown>; orgId?: string } = {}) {
    const org = opts.orgId ? (await db.query.organizations.findFirst({ where: S.eq(S.organizations.id, opts.orgId) }))! : await newOrg("send", opts.orgSettings ? { settings: opts.orgSettings } : {});
    const acct = await newAccount(org.id);
    const [campaign] = await db.insert(S.campaigns).values({ orgId: org.id, name: "C", emailAccountId: acct.id, status: "active", settings: { ...ALL_DAY, ...(opts.settings ?? {}) } }).returning();
    const [step] = await db.insert(S.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: opts.channel ?? "email", subjectTemplate: "Hello {{first_name}}", bodyTemplate: "Hi {{first_name}}, a quick note.", aiPersonalize: false }).returning();
    return { org, acct, campaign, step };
  }
  async function newContact(orgId: string, campaignId: string, leadPatch: Record<string, unknown> = {}) {
    const [lead] = await db.insert(S.leads).values({ orgId, email: `p-${u8()}@prospect.example`, fullName: "Priya Prospect", firstName: "Priya", emailStatus: "valid", ...leadPatch }).returning();
    const [cc] = await db.insert(S.campaignContacts).values({ campaignId, leadId: lead.id, status: "active", currentStep: 0, nextSendAt: new Date(Date.now() - 60_000) }).returning();
    return { lead, cc };
  }
  const contact = async (id: string) => (await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.id, id)))[0];
  const jobsOf = (orgId: string, type: string) => db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, orgId), S.eq(S.jobs.type, type)));

  /** Tables of this schema holding at least one row whose text contains `needle`. */
  async function tablesContaining(needle: string): Promise<Record<string, number>> {
    const tables = await q`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`;
    const out: Record<string, number> = {};
    for (const t of tables) {
      const [{ n }] = rows(await db.execute(S.sql.raw(`SELECT count(*)::int AS n FROM "${t.table_name}" x WHERE position(lower('${needle.replace(/'/g, "''")}') in lower(x::text)) > 0`)));
      if (n) out[t.table_name] = n;
    }
    return out;
  }

  beforeAll(async () => {
    try {
      const { default: postgres } = await import("postgres");
      const adminSql = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await adminSql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await adminSql.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB;
    }
    vi.stubGlobal("fetch", (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? input);
      net.calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      const res = net.answer?.(url, init);
      if (res) return res;
      throw new Error("security.privacy: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    pv = await import("./lib/privacyVisitor.js");
    ps = await import("./lib/privacySuppression.js");
    pe = await import("./lib/privacyErase.js");
    pr = await import("./lib/privacyRetention.js");
    campaignsSvc = await import("./services/campaigns.js");
    leadsSvc = await import("./services/leads.js");
    visitorsSvc = await import("./services/visitors.js");
    aiLib = await import("./lib/ai.js");
    rateWindow = await import("./lib/rateWindow.js");
    ({ handlers: jobHandlers } = await import("./jobs.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    mocks.sent.length = 0;
    mocks.platformMailer = false;
    net.calls.length = 0;
    net.answer = null;
    delete process.env.GROQ_API_KEY;
    delete process.env.PRIVACY_SWEEP;
    delete process.env.IP_LOOKUP_ALLOW_PLAIN_HTTP;
    rateWindow.resetWindows();
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. The visitor pixel ───────────────────────────────────────────────────────────
  describe("visitor pixel", () => {
    async function newPixel() {
      const org = await newOrg("pixel");
      const [pixel] = await db.insert(S.pixels).values({ orgId: org.id, key: `px_${randomBytes(9).toString("base64url")}`, name: "site" }).returning();
      return { org, pixel };
    }
    const hit = (key: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(`/px/${key}/collect`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (privacy test)", ...headers }, body: JSON.stringify(body) });
    const visitsOf = (pixelId: string) => db.select().from(S.visits).where(S.eq(S.visits.pixelId, pixelId));

    it("stores nothing and queues nothing for a browser that sends Global Privacy Control or Do Not Track", async () => {
      const { org, pixel } = await newPixel();
      for (const signal of [{ "sec-gpc": "1" }, { dnt: "1" }, { "Sec-GPC": "1", DNT: "1" }]) {
        const res = await hit(pixel.key, { sid: `s-${u8()}`, p: "/pricing", r: "", e: "view" }, { "cf-connecting-ip": "203.0.113.77", ...signal });
        // Answered exactly like a stored hit: the page cannot tell the difference.
        expect(res.status).toBe(204);
      }
      expect(await visitsOf(pixel.id)).toHaveLength(0);
      expect(await jobsOf(org.id, "visit.identify")).toHaveLength(0);
      expect(net.calls).toHaveLength(0);
      // "0" is not a request to be left alone: the same hit without the signal is stored.
      expect((await hit(pixel.key, { sid: "s-ok", p: "/pricing", e: "view" }, { "cf-connecting-ip": "203.0.113.77", "sec-gpc": "0", dnt: "0" })).status).toBe(204);
      expect(await visitsOf(pixel.id)).toHaveLength(1);
    });

    it("the script sends nothing for a do-not-track browser, and never sends a query string", () => {
      const js = visitorsSvc.pixelScript("px_abcdefgh1234");
      expect(js).toContain("globalPrivacyControl");
      expect(js).toContain("doNotTrack");
      // The signal is checked before the endpoint is even named.
      expect(js.indexOf("globalPrivacyControl")).toBeLessThan(js.indexOf("/collect"));
      expect(js).not.toContain("location.search");
      expect(js).toContain("p:location.pathname,");
      expect(js).toContain('split(/[?#]/)[0]');
      // A customer's own call to identify() must not throw when tracking is declined.
      expect(js).toMatch(/window\.prospex=\{identify:function\(\)\{\}\};return/);
    });

    it("keeps no raw IP and no query string: sealed job payload, keyed hash, bare page and referrer", async () => {
      const { org, pixel } = await newPixel();
      const visitorIp = "203.0.113.50";
      const sid = `s-${u8()}`;
      expect((await hit(pixel.key, { sid, p: "/reset-password?token=SECRETTOKEN123&email=jane.visitor@example.org#frag", r: "https://mail.example.com/inbox?q=jane.visitor#top", t: "Reset", d: 0, e: "view" }, { "cf-connecting-ip": visitorIp })).status).toBe(204);
      expect((await hit(pixel.key, { sid, e: "identify", id: { email: "jane.visitor@example.org", company: "Example Org", name: "Jane" } }, { "cf-connecting-ip": visitorIp })).status).toBe(204);

      const [visit] = await visitsOf(pixel.id);
      expect(visit.page).toBe("/reset-password");
      expect(visit.referrer).toBe("https://mail.example.com/inbox");
      // Keyed: not the old sha256(ip:pixel), which anyone holding the pixel id could reverse.
      expect(visit.ipHash).toMatch(/^k1_[0-9a-f]{64}$/);
      expect(visit.ipHash).not.toContain(sha256(`${visitorIp}:${pixel.id}`));
      expect(visit.ipHash).toBe(pv.visitorIpHash(visitorIp, pixel.id));
      // Per pixel: the same address on another customer's site hashes differently.
      expect(pv.visitorIpHash(visitorIp, randomUUID())).not.toBe(visit.ipHash);

      const queued = await jobsOf(org.id, "visit.identify");
      expect(queued).toHaveLength(2);
      for (const j of queued) {
        expect(Object.keys(j.payload).sort()).toEqual(["sealed", "visitId"]);
        expect(JSON.stringify(j)).not.toContain(visitorIp);
        expect(JSON.stringify(j)).not.toContain("jane.visitor");
      }
      // Nothing at rest names the address, the token or the visitor - in any table.
      for (const needle of [visitorIp, "SECRETTOKEN123", "jane.visitor"]) expect(await tablesContaining(needle), needle).toEqual({});
      // ...and the job can still read what it needs.
      expect(queued.map((j: any) => pv.openVisitorJob(j.payload).ip)).toEqual([visitorIp, visitorIp]);
      expect(queued.map((j: any) => pv.openVisitorJob(j.payload).identify?.email).filter(Boolean)).toEqual(["jane.visitor@example.org"]);

      // The customer's own view of the visits does not carry the hash either.
      const o = await signup("pixel-view");
      const [own] = await db.insert(S.pixels).values({ orgId: o.orgId, key: `px_${randomBytes(9).toString("base64url")}`, name: "site" }).returning();
      await db.insert(S.visits).values({ orgId: o.orgId, pixelId: own.id, sessionId: "s", ipHash: pv.visitorIpHash("203.0.113.9", own.id), companyDomain: "acme-visitor.example", page: "/pricing" });
      await db.insert(S.visitorCompanies).values({ orgId: o.orgId, domain: "acme-visitor.example", name: "Acme" });
      const list = await req("GET", "/v1/visitors/acme-visitor.example/visits", o.token);
      expect(list.status).toBe(200);
      expect(list.body.visits).toHaveLength(1);
      expect(list.body.visits[0]).toMatchObject({ page: "/pricing", companyDomain: "acme-visitor.example" });
      expect(JSON.stringify(list.body)).not.toMatch(/ipHash|ip_hash|k1_/);
    });

    it("the lookup job scrubs its payload when it ends, and still reads a payload queued by the previous release", async () => {
      const { org, pixel } = await newPixel();
      // A private address needs no outside lookup, so the job runs to its end with fetch blocked.
      expect((await hit(pixel.key, { sid: "s-private", p: "/", e: "view" }, { "cf-connecting-ip": "10.9.8.7" })).status).toBe(204);
      const [job] = await jobsOf(org.id, "visit.identify");
      const r = await jobHandlers["visit.identify"](job, ctx());
      expect(r).toMatchObject({ isp: true });
      expect((await jobsOf(org.id, "visit.identify"))[0].payload).toEqual({ visitId: job.payload.visitId });
      expect(net.calls).toHaveLength(0);

      // Queued before this release: the address is in clear. It is used, then removed.
      const [visit] = await visitsOf(pixel.id);
      const [legacy] = await db.insert(S.jobs).values({ orgId: org.id, type: "visit.identify", payload: { visitId: visit.id, ip: "10.1.1.1", identify: { email: "old@example.org" } }, status: "running", attempts: 1, maxAttempts: 2 }).returning();
      expect(await jobHandlers["visit.identify"](legacy, ctx())).toBeTruthy();
      expect((await db.select().from(S.jobs).where(S.eq(S.jobs.id, legacy.id)))[0].payload).toEqual({ visitId: visit.id });

      // Nothing left to read (already scrubbed): finished, not retried forever.
      const [empty] = await db.insert(S.jobs).values({ orgId: org.id, type: "visit.identify", payload: { visitId: visit.id }, status: "running", attempts: 1, maxAttempts: 2 }).returning();
      expect(await jobHandlers["visit.identify"](empty, ctx())).toMatchObject({ skipped: expect.stringMatching(/no longer available/) });
      // A payload sealed for something else, or tampered with, yields no address.
      expect(pv.openVisitorJob({ sealed: "v2.x.y.z.w" })).toEqual({ ip: null, identify: null });
    });

    it("existing visits keep matching: the legacy hash is converted in place to the value new visits get", async () => {
      const { org, pixel } = await newPixel();
      const visitorIp = "203.0.113.91";
      const legacy = sha256(`${visitorIp}:${pixel.id}`);
      await db.insert(S.visits).values([
        { orgId: org.id, pixelId: pixel.id, sessionId: "old-1", ipHash: legacy, page: "/pricing?utm_source=x&token=abc", referrer: "https://www.google.com/search?q=secret+search#x" },
        { orgId: org.id, pixelId: pixel.id, sessionId: "old-2", ipHash: legacy, page: "/docs#install", referrer: null },
      ]);
      await db.insert(S.events).values({ orgId: org.id, type: "visitor.identified", data: { domain: "acme.example", page: "/pricing?token=abc" } });
      // The same visitor comes back after the release.
      expect((await hit(pixel.key, { sid: "new-1", p: "/pricing", e: "view" }, { "cf-connecting-ip": visitorIp })).status).toBe(204);

      const report = await pr.runRetention(db);
      expect(report.failed).toEqual([]);
      const after = await visitsOf(pixel.id);
      expect(after).toHaveLength(3);
      // One visitor, one value: old rows and the new row agree, and none is the legacy hash.
      expect(new Set(after.map((v: any) => v.ipHash))).toEqual(new Set([pv.visitorIpHash(visitorIp, pixel.id)]));
      expect(after.map((v: any) => v.page).sort()).toEqual(["/docs", "/pricing", "/pricing"]);
      expect(after.map((v: any) => v.referrer).filter(Boolean)).toEqual(["https://www.google.com/search"]);
      const [ev] = await db.select().from(S.events).where(S.and(S.eq(S.events.orgId, org.id), S.eq(S.events.type, "visitor.identified")));
      expect(ev.data).toEqual({ domain: "acme.example", page: "/pricing" });
      // A second pass has nothing left to convert.
      const again = await pr.runRetention(db);
      expect(again.converted["visit address hashes keyed"]).toBeUndefined();
      expect(again.converted["visit addresses without query strings"]).toBeUndefined();
    });

    it("looks an address up over HTTPS only, never asks ip-api.com, and sends nothing for a value that is not an address", async () => {
      const core = await import("@prospex/core");
      net.answer = (url) => {
        if (url.startsWith("https://api.ipapi.is/")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        if (url.startsWith("https://ipinfo.io/")) return new Response(JSON.stringify({ org: "AS64500 Example Corp", country: "IN", city: "Pune", company: { name: "Example Corp", domain: "example-corp.com", type: "business" } }), { status: 200, headers: { "content-type": "application/json" } });
        return null;
      };
      const id = await core.identifyIp("203.0.113.201", { ipinfoToken: "tok_SECRET" });
      expect(id).toMatchObject({ resolved: true, provider: "ipinfo", orgName: "Example Corp", domainHint: "example-corp.com" });
      expect(net.calls.map((c) => c.url)).toEqual(["https://api.ipapi.is/?q=203.0.113.201", "https://ipinfo.io/203.0.113.201/json"]);
      // The token travels in a header, never in the address.
      expect(net.calls.map((c) => c.url).join(" ")).not.toContain("tok_SECRET");
      for (const c of net.calls) expect(c.url.startsWith("https://")).toBe(true);

      net.calls.length = 0;
      const bad = await core.identifyIp("1.2.3.4&key=x/../y", {});
      expect(bad).toMatchObject({ resolved: true, provider: "invalid" });
      expect(net.calls).toHaveLength(0);
    });
  });

  // ── 2. Sending ─────────────────────────────────────────────────────────────────────
  describe("sending: the footer and the do-not-contact lists", () => {
    it("every campaign email carries the unsubscribe footer - unsubscribeFooter:false is ignored - and the workspace's mailing address", async () => {
      const address = "Acme Outreach Pvt Ltd\n12 MG Road, <Bengaluru> 560001";
      const { org, campaign, step } = await setup({ settings: { unsubscribeFooter: false }, orgSettings: { mailingAddress: address } });
      const { cc } = await newContact(org.id, campaign.id);
      const r = await campaignsSvc.sendStep(campaign.id, cc.id, step.id);
      expect(r).toMatchObject({ sent: true });
      const mail = mocks.sent.at(-1)!;
      expect(mail.text).toMatch(/If you'd rather not hear from me, reply "unsubscribe" or click: https:\/\/api\.scout\.test\/t\/u\/[A-Za-z0-9_-]+\nAcme Outreach Pvt Ltd\n12 MG Road, <Bengaluru> 560001$/);
      expect(mail.html).toMatch(/unsubscribe here<\/a>\.<br>Acme Outreach Pvt Ltd<br>12 MG Road, &lt;Bengaluru&gt; 560001<\/p>$/);
      expect(mail.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.scout\.test\/t\/u\//);
      expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // No address set: the footer alone, with nothing after it.
      const plain = await setup({ settings: { unsubscribeFooter: false } });
      const c2 = await newContact(plain.org.id, plain.campaign.id);
      expect(await campaignsSvc.sendStep(plain.campaign.id, c2.cc.id, plain.step.id)).toMatchObject({ sent: true });
      expect(mocks.sent.at(-1)!.text).toMatch(/or click: https:\/\/api\.scout\.test\/t\/u\/[A-Za-z0-9_-]+$/);
    });

    it("the mailing address is plain text: control characters out, six lines, 300 characters", () => {
      expect(campaignsSvc.mailingAddressOf({ settings: { mailingAddress: "  Acme\r\n\r\n  1 Road\u0000  x  \n" } })).toBe("Acme\n1 Road x");
      expect(campaignsSvc.mailingAddressOf({ settings: { mailingAddress: "a\nb\nc\nd\ne\nf\ng\nh" } }).split("\n")).toHaveLength(6);
      expect(campaignsSvc.mailingAddressOf({ settings: { mailingAddress: "x".repeat(900) } })).toHaveLength(300);
      for (const bad of [undefined, null, 7, {}, []]) expect(campaignsSvc.mailingAddressOf({ settings: { mailingAddress: bad } })).toBe("");
      expect(campaignsSvc.mailingAddressOf(null)).toBe("");
      expect(campaignsSvc.unsubscribeFooter("https://x/u", "").html).not.toContain("<br>");
    });

    it("a WhatsApp step is not sent to someone who unsubscribed or is on the workspace's list", async () => {
      const { org, campaign, step } = await setup({ channel: "whatsapp" });
      const unsub = await newContact(org.id, campaign.id, { phone: "+919999900001", status: "unsubscribed" });
      const listed = await newContact(org.id, campaign.id, { phone: "+919999900002" });
      await db.insert(S.suppressions).values({ orgId: org.id, email: listed.lead.email, reason: "unsubscribe_link" });
      const fine = await newContact(org.id, campaign.id, { phone: "+919999900003" });

      expect(await campaignsSvc.sendStep(campaign.id, unsub.cc.id, step.id)).toMatchObject({ skipped: "suppressed", list: "lead" });
      expect(await campaignsSvc.sendStep(campaign.id, listed.cc.id, step.id)).toMatchObject({ skipped: "suppressed", list: "workspace" });
      for (const c of [unsub, listed]) expect(await contact(c.cc.id)).toMatchObject({ status: "unsubscribed", nextSendAt: null });
      expect((await contact(listed.cc.id)).lastError).toBe("Address is on the suppression list (unsubscribe_link)");
      // Nothing was written or handed to a person for either of them.
      expect(await db.select().from(S.messages).where(S.eq(S.messages.orgId, org.id))).toHaveLength(0);
      expect((await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, org.id))).map((t: any) => t.leadId)).toEqual([]);
      // The control: someone who may be contacted goes down the WhatsApp path as before
      // (no WhatsApp account is connected here, so it becomes a task for a person).
      await campaignsSvc.sendStep(campaign.id, fine.cc.id, step.id);
      expect((await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, org.id))).map((t: any) => t.leadId)).toEqual([fine.lead.id]);
    });

    it("no manual task (LinkedIn, call) is created for someone who may not be contacted", async () => {
      const { org, campaign } = await setup({ channel: "linkedin_message" });
      const unsub = await newContact(org.id, campaign.id, { status: "unsubscribed" });
      const platform = await newContact(org.id, campaign.id);
      await db.insert(S.globalSuppressions).values({ email: platform.lead.email, reason: "request" });
      const fine = await newContact(org.id, campaign.id);
      await campaignsSvc.tickCampaign(campaign.id);
      expect((await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, org.id))).map((t: any) => t.leadId)).toEqual([fine.lead.id]);
      expect((await contact(unsub.cc.id)).status).toBe("unsubscribed");
      expect(await contact(platform.cc.id)).toMatchObject({ status: "unsubscribed", lastError: expect.stringMatching(/asked not to be contacted through Scout/) });
    });

    it("the platform list stops a sequence email and a reply typed by hand, in every workspace", async () => {
      const person = `dnc-${u8()}@prospect.example`;
      await db.insert(S.globalSuppressions).values({ email: person, reason: "request" });

      const a = await setup();
      const ca = await newContact(a.org.id, a.campaign.id, { email: person });
      expect(await campaignsSvc.sendStep(a.campaign.id, ca.cc.id, a.step.id)).toMatchObject({ skipped: "suppressed", list: "platform" });
      expect(mocks.sent).toHaveLength(0);
      expect(await contact(ca.cc.id)).toMatchObject({ status: "unsubscribed" });

      // The reply box, in another workspace.
      const o = await signup("dnc-reply");
      const b = await setup({ orgId: o.orgId });
      const [lead] = await db.insert(S.leads).values({ orgId: o.orgId, email: person, fullName: "Dee", emailStatus: "valid" }).returning();
      const [inbound] = await db.insert(S.messages).values({ orgId: o.orgId, campaignId: b.campaign.id, leadId: lead.id, direction: "inbound", toEmail: person, subject: "Re: hi", bodyText: "tell me more", status: "received", intent: "interested" }).returning();
      const refused = await req("POST", `/v1/campaigns/messages/${inbound.id}/send-reply`, o.token, { subject: "Re: hi", body: "Happy to." });
      expect([refused.status, refused.body.error.code]).toEqual([409, "suppressed"]);
      expect(refused.body.error.message).toMatch(/asked not to be contacted through Scout/);
      expect(mocks.sent).toHaveLength(0);

      // The control: someone not on any list gets the reply, with the same footer and address.
      await db.execute(S.sql`UPDATE organizations SET settings = settings || '{"mailingAddress":"7 Lake View, Pune"}'::jsonb WHERE id = ${o.orgId}`);
      const [okLead] = await db.insert(S.leads).values({ orgId: o.orgId, email: `ok-${u8()}@prospect.example`, fullName: "Kay", emailStatus: "valid" }).returning();
      const [okInbound] = await db.insert(S.messages).values({ orgId: o.orgId, campaignId: b.campaign.id, leadId: okLead.id, direction: "inbound", toEmail: okLead.email, subject: "Re: hi", bodyText: "tell me more", status: "received", intent: "interested" }).returning();
      const sent = await req("POST", `/v1/campaigns/messages/${okInbound.id}/send-reply`, o.token, { subject: "Re: hi", body: "Happy to." });
      expect(sent.status).toBe(200);
      expect(mocks.sent.at(-1)!.text).toMatch(/^Happy to\.\n\n--\nIf you'd rather not hear from me, reply "unsubscribe" or click: \S+\n7 Lake View, Pune$/);
    });

    it("an unsubscribe goes on that workspace's list only - never on the platform list by itself", async () => {
      const { org, campaign, step } = await setup();
      const { lead, cc } = await newContact(org.id, campaign.id);
      await campaignsSvc.sendStep(campaign.id, cc.id, step.id);
      const [msg] = await db.select().from(S.messages).where(S.eq(S.messages.leadId, lead.id));
      // A GET (a mail scanner following the link) changes nothing; the POST unsubscribes.
      expect((await app.request(`/t/u/${msg.trackingToken}`)).status).toBe(200);
      expect(await db.select().from(S.suppressions).where(S.eq(S.suppressions.orgId, org.id))).toHaveLength(0);
      expect((await app.request(`/t/u/${msg.trackingToken}`, { method: "POST" })).status).toBe(200);
      expect((await db.select().from(S.suppressions).where(S.eq(S.suppressions.orgId, org.id))).map((s: any) => [s.email, s.reason])).toEqual([[lead.email, "unsubscribe_link"]]);
      expect(await db.select().from(S.globalSuppressions).where(S.eq(S.globalSuppressions.email, lead.email))).toHaveLength(0);
      // Another workspace is not affected by it.
      const other = await setup();
      const oc = await newContact(other.org.id, other.campaign.id, { email: lead.email });
      expect(await campaignsSvc.sendStep(other.campaign.id, oc.cc.id, other.step.id)).toMatchObject({ sent: true });
    });
  });

  // ── 3. Erasure ─────────────────────────────────────────────────────────────────────
  describe("deleting a person deletes the copies", () => {
    /** A lead with everything that used to outlive it. */
    async function seedPerson(orgId: string, campaignId: string, email: string) {
      const [lead] = await db.insert(S.leads).values({ orgId, email, fullName: "Priya Marker", firstName: "Priya", phone: "+15550001111", linkedinUrl: `https://www.linkedin.com/in/priya-${u8()}`, emailStatus: "valid", source: "provider:apollo" }).returning();
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId, leadId: lead.id, status: "active" }).returning();
      const token = randomBytes(12).toString("hex");
      await db.insert(S.messages).values([
        { orgId, campaignId, leadId: lead.id, direction: "outbound", toEmail: email, subject: "Quick question, Priya", bodyText: "Hi Priya Marker, a note.", bodyHtml: "<p>Hi Priya Marker</p>", status: "sent", sentAt: new Date(), trackingToken: token },
        { orgId, campaignId, leadId: lead.id, direction: "inbound", toEmail: email, subject: "Re: Quick question", bodyText: "Call me on +15550001111 - Priya Marker", status: "received", intent: "interested", draftReply: { subject: "Re", body: "Hi Priya Marker" } },
      ]);
      await db.insert(S.events).values([
        { orgId, type: "lead.created", entityType: "lead", entityId: lead.id, data: { id: lead.id, email, fullName: "Priya Marker" } },
        { orgId, type: "message.sent", entityType: "message", entityId: randomUUID(), data: { leadId: lead.id, to: email, subject: "Quick question, Priya" } },
        { orgId, type: "message.bounced", data: { leadId: null, email, detail: "550" } },
        { orgId, type: "campaign.started", entityType: "campaign", entityId: campaignId, data: { campaignId } },
      ]);
      const [monitor] = await db.insert(S.monitors).values({ orgId, type: "linkedin_post", name: "m", target: "https://www.linkedin.com/posts/x" }).returning();
      await db.insert(S.monitorResults).values({ monitorId: monitor.id, orgId, kind: "engager", title: "Priya Marker - VP Sales", url: lead.linkedinUrl, snippet: "Priya Marker liked this", leadId: lead.id, data: { name: "Priya Marker" } });
      await db.insert(S.jobs).values([
        { orgId, type: "lead.enrich", payload: { leadId: lead.id }, status: "done", result: { email } },
        { orgId, type: "campaign.tick", payload: { campaignId }, status: "done" },
      ]);
      await db.insert(S.tasks).values({ orgId, leadId: lead.id, type: "call", title: "Call Priya Marker", body: "x" });
      await db.insert(S.suppressions).values({ orgId, email: `kept-${u8()}@prospect.example`, reason: "unsubscribe_link" });
      await db.execute(S.sql`UPDATE organizations SET settings = settings || ${JSON.stringify({ aiReplyStyleExamples: [{ subject: "Re", body: "Hi Priya Marker, a note." }, { subject: "Re", body: "For Priya", leadId: lead.id }, { subject: "Re", body: "Unrelated reply to someone else" }] })}::jsonb WHERE id = ${orgId}`);
      return { lead, cc, token };
    }

    it("eraseLeads removes the content everywhere, keeps the counts, and touches no other workspace", async () => {
      const { org, campaign } = await setup();
      const other = await setup();
      const email = `priya.marker-${u8()}@prospectco.example`;
      const { lead, token } = await seedPerson(org.id, campaign.id, email);
      const theirs = await seedPerson(other.org.id, other.campaign.id, `someone-${u8()}@elsewhere.example`);
      const otherBefore = await db.select().from(S.messages).where(S.eq(S.messages.orgId, other.org.id));

      // Not this workspace's lead: nothing happens, and it is not reported as deleted.
      expect((await pe.eraseLeads(org.id, [theirs.lead.id, "not-an-id"])).deleted).toEqual([]);
      const r = await pe.eraseLeads(org.id, [lead.id, lead.id]);
      expect(r).toMatchObject({ deleted: [lead.id], messagesAnonymised: 2 });

      expect(await db.select().from(S.leads).where(S.eq(S.leads.id, lead.id))).toHaveLength(0);
      const msgs = await db.select().from(S.messages).where(S.eq(S.messages.orgId, org.id));
      // The rows stay (sending caps and the bounce-rate breaker count them); the content is gone.
      expect(msgs).toHaveLength(2);
      for (const m of msgs) expect(m).toMatchObject({ leadId: null, toEmail: ps.addressFingerprint(email), subject: "(removed)", bodyText: "(removed)", bodyHtml: null, draftReply: null });
      expect((await db.select().from(S.events).where(S.eq(S.events.orgId, org.id))).map((e: any) => e.type)).toEqual(["campaign.started"]);
      expect(await db.select().from(S.monitorResults).where(S.eq(S.monitorResults.orgId, org.id))).toHaveLength(0);
      expect((await db.select().from(S.jobs).where(S.eq(S.jobs.orgId, org.id))).map((j: any) => j.type)).toEqual(["campaign.tick"]);
      expect(await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, org.id))).toHaveLength(0);
      const [o] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, org.id));
      expect(o.settings.aiReplyStyleExamples).toEqual([{ subject: "Re", body: "Unrelated reply to someone else" }]);
      // The do-not-contact list is the one thing deliberately kept.
      expect(await db.select().from(S.suppressions).where(S.eq(S.suppressions.orgId, org.id))).toHaveLength(1);
      for (const needle of [email, "Priya Marker", "15550001111"]) {
        const where = await tablesContaining(needle);
        // The other workspace's own "Priya Marker" is still there; this one's address is nowhere.
        if (needle === email) expect(where).toEqual({});
      }
      expect(await db.select().from(S.messages).where(S.eq(S.messages.orgId, other.org.id))).toEqual(otherBefore);
      expect(await db.select().from(S.leads).where(S.eq(S.leads.id, theirs.lead.id))).toHaveLength(1);

      // The unsubscribe link in the email that was already sent still works: it records the
      // fingerprint, and the fingerprint stops a send to the same address if it is added again.
      expect((await app.request(`/t/u/${token}`, { method: "POST" })).status).toBe(200);
      expect((await db.select().from(S.suppressions).where(S.eq(S.suppressions.orgId, org.id))).map((s: any) => s.email)).toContain(ps.addressFingerprint(email));
      const { step } = { step: (await db.select().from(S.sequenceSteps).where(S.eq(S.sequenceSteps.campaignId, campaign.id)))[0] };
      const again = await newContact(org.id, campaign.id, { email });
      expect(await campaignsSvc.sendStep(campaign.id, again.cc.id, step.id)).toMatchObject({ skipped: "suppressed", list: "workspace" });
      expect(mocks.sent).toHaveLength(0);
    });

    it("a plain delete is caught by the cleanup sweep: messages lose their content, events about the lead go", async () => {
      const { org, campaign } = await setup();
      const email = `plain-${u8()}@prospectco.example`;
      const { lead } = await seedPerson(org.id, campaign.id, email);
      await db.delete(S.leads).where(S.eq(S.leads.id, lead.id));
      expect((await tablesContaining(email)).messages).toBe(2);

      // The sweep leaves the last hour alone (work still in flight); these rows are new, so nothing happens yet.
      expect((await pr.runRetention(db)).converted["messages of deleted leads"]).toBeUndefined();
      expect((await tablesContaining(email)).messages).toBe(2);
      await db.execute(S.sql`UPDATE messages SET created_at = now() - interval '2 hours' WHERE org_id = ${org.id}`);
      await db.execute(S.sql`UPDATE events SET created_at = now() - interval '2 hours' WHERE org_id = ${org.id}`);

      const report = await pr.runRetention(db);
      expect(report.failed).toEqual([]);
      expect(report.converted["messages of deleted leads"]).toBe(2);
      const msgs = await db.select().from(S.messages).where(S.eq(S.messages.orgId, org.id));
      for (const m of msgs) expect(m).toMatchObject({ toEmail: ps.addressFingerprint(email), subject: "(removed)", bodyText: "(removed)", bodyHtml: null });
      const left = (await db.select().from(S.events).where(S.eq(S.events.orgId, org.id))).map((e: any) => e.type).sort();
      // The lead's own events and the message event naming it are gone.
      expect(left).not.toContain("lead.created");
      expect(left).not.toContain("message.sent");
      expect(left).toContain("campaign.started");
    });

    it("an admin can find a person across workspaces, erase them everywhere, and they are not stored again", async () => {
      const email = `subject-${u8()}@prospectco.example`;
      const a = await setup();
      const b = await setup();
      const c = await setup();
      await seedPerson(a.org.id, a.campaign.id, email);
      await seedPerson(b.org.id, b.campaign.id, email.toUpperCase().toLowerCase());
      await db.insert(S.suppressions).values({ orgId: b.org.id, email, reason: "unsubscribe_link" });
      await seedPerson(c.org.id, c.campaign.id, `bystander-${u8()}@prospectco.example`);

      // Admin only.
      const customer = await signup("ds-auth");
      for (const [m, p, body] of [["GET", `/v1/admin/data-subject?email=${email}`, undefined], ["POST", "/v1/admin/data-subject/erase", { email, confirm: email }], ["GET", "/v1/admin/suppressions", undefined], ["POST", "/v1/admin/suppressions", { email }]] as const) {
        expect((await req(m, p, null, body)).status, `${m} ${p} anonymous`).toBe(401);
        expect((await req(m, p, customer.token, body)).status, `${m} ${p} customer`).toBe(401);
      }

      const found = await admin("GET", `/data-subject?email=${encodeURIComponent(`  ${email.toUpperCase()} `)}`);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ email, globallySuppressed: false, held: true });
      expect(found.body.workspaces.map((w: any) => [w.orgId, w.leads, w.campaignContacts, w.messages, w.anonymisedMessages, w.suppressed]).sort()).toEqual(
        [[a.org.id, 1, 1, 2, 0, false], [b.org.id, 1, 1, 2, 0, true]].sort(),
      );
      expect(found.body.workspaces.every((w: any) => typeof w.orgName === "string" && w.orgName)).toBe(true);
      expect((await admin("GET", "/data-subject?email=not-an-address")).status).toBe(400);

      // The address must be typed again, exactly.
      const wrong = await admin("POST", "/data-subject/erase", { email, confirm: `x${email}` });
      expect([wrong.status, wrong.body.error.code]).toEqual([400, "confirm_mismatch"]);
      expect(await db.select().from(S.leads).where(S.eq(S.leads.email, email))).toHaveLength(2);

      const erased = await admin("POST", "/data-subject/erase", { email, confirm: email });
      expect(erased.status).toBe(200);
      expect(erased.body).toMatchObject({ ok: true, workspaces: 2, leadsDeleted: 2, globallySuppressed: true });

      // The address survives in exactly two places: the platform list and the workspace's own list.
      expect(await tablesContaining(email)).toEqual({ global_suppressions: 1, suppressions: 1 });
      // The bystander and their workspace are untouched.
      expect(await db.select().from(S.leads).where(S.eq(S.leads.orgId, c.org.id))).toHaveLength(1);
      expect((await db.select().from(S.messages).where(S.eq(S.messages.orgId, c.org.id))).every((m: any) => m.subject !== "(removed)")).toBe(true);
      const after = await admin("GET", `/data-subject?email=${encodeURIComponent(email)}`);
      // Nobody holds the person any more. What is left is counted for what it is: message
      // records kept without content, and a do-not-contact entry - not "2 messages".
      expect(after.body).toMatchObject({ globallySuppressed: true, held: false });
      expect(after.body.workspaces.map((w: any) => [w.orgId, w.leads, w.campaignContacts, w.messages, w.anonymisedMessages, w.suppressed]).sort()).toEqual(
        [[a.org.id, 0, 0, 0, 2, false], [b.org.id, 0, 0, 0, 2, true]].sort(),
      );
      // Erasing again is safe.
      expect((await admin("POST", "/data-subject/erase", { email, confirm: email })).body).toMatchObject({ ok: true, leadsDeleted: 0 });

      // Recorded - by fingerprint, not by address.
      const log = await q`SELECT action, target_id, data FROM audit_log WHERE action LIKE 'admin.data_subject%' AND target_id = ${ps.addressFingerprint(email)} ORDER BY created_at`;
      expect(log.map((l: any) => l.action)).toEqual(expect.arrayContaining(["admin.data_subject_viewed", "admin.data_subject_erased"]));
      expect(JSON.stringify(log)).not.toContain(email);

      // An import or a search that finds the address again does not store it.
      const back = await leadsSvc.upsertLead(a.org.id, { email, fullName: "Priya Again", title: "VP", source: "import" });
      expect(back.created).toBe(true);
      expect(back.lead.email).toBeNull();
      expect(back.emailRejected).toMatch(/asked not to be contacted through Scout/);
      expect(JSON.stringify(back.lead)).not.toContain(email);
      // ...and importing the same row again finds that lead instead of adding the person twice.
      const twice = await leadsSvc.upsertLead(a.org.id, { email, fullName: "Priya Again", title: "VP Sales", source: "import" });
      expect([twice.created, twice.lead.id, twice.lead.email]).toEqual([false, back.lead.id, null]);
      expect(await tablesContaining(email)).toEqual({ global_suppressions: 1, suppressions: 1 });
    });

    it("the platform list: add (idempotent), search, remove - and each change is recorded without the address", async () => {
      const email = `list-${u8()}@prospect.example`;
      const add = await admin("POST", "/suppressions", { email: `  ${email.toUpperCase()}  `, reason: "regulator", note: "Case 42" });
      expect(add.status).toBe(201);
      expect(add.body.suppression).toMatchObject({ email, reason: "regulator", note: "Case 42" });
      expect(typeof add.body.suppression.id).toBe("string");
      expect(add.body.suppression.createdAt).toBeTruthy();
      const twice = await admin("POST", "/suppressions", { email, reason: "something else" });
      expect(twice.status).toBe(200);
      expect(twice.body.suppression).toMatchObject({ id: add.body.suppression.id, reason: "regulator" });
      for (const bad of ["nope", "a@b", "a@x.com, b@x.com", "<a@x.com>"]) expect((await admin("POST", "/suppressions", { email: bad })).status, bad).toBe(400);

      const all = await admin("GET", "/suppressions?limit=500");
      expect(all.status).toBe(200);
      expect(all.body.suppressions.find((s: any) => s.email === email)).toMatchObject({ id: add.body.suppression.id });
      const some = await admin("GET", `/suppressions?q=${encodeURIComponent(email.slice(0, 13).toUpperCase())}`);
      expect(some.body.suppressions.map((s: any) => s.email)).toEqual([email]);
      // "%" is a character in a search box, not a wildcard.
      expect((await admin("GET", "/suppressions?q=%25")).body.suppressions).toEqual([]);

      expect(await ps.onPlatformList(email)).toBe(true);
      expect((await admin("DELETE", `/suppressions/${add.body.suppression.id}`)).body).toEqual({ ok: true });
      expect(await ps.onPlatformList(email)).toBe(false);
      expect((await admin("DELETE", `/suppressions/${add.body.suppression.id}`)).status).toBe(404);
      expect((await admin("DELETE", "/suppressions/not-an-id")).status).toBe(400);

      const log = await q`SELECT action, data FROM audit_log WHERE target_id = ${add.body.suppression.id} ORDER BY created_at`;
      expect(log.map((l: any) => l.action)).toEqual(["admin.suppression_added", "admin.suppression_removed"]);
      expect(JSON.stringify(log)).not.toContain(email);
    });

    it("a purged workspace leaves nothing that names its people", async () => {
      const o = await signup("purge-me");
      const member = await addMember(o, "member");
      const { campaign } = await setup({ orgId: o.orgId });
      await seedPerson(o.orgId, campaign.id, `lead-${u8()}@purged-prospect.example`);
      // Rows that do not hang off the organization row.
      await db.insert(S.loginAttempts).values([{ subject: o.email.toLowerCase(), ip: "203.0.113.9", succeeded: true }, { subject: member.email.toLowerCase(), ip: "203.0.113.9", succeeded: false }]);
      // Wrong two-factor codes and wrong current-password attempts are keyed by the member's
      // id, not the address ("2fa:<id>", "pwchange:<id>"): they used to be left behind.
      await db.insert(S.loginAttempts).values([
        { subject: `2fa:${o.userId}`, ip: "203.0.113.9", succeeded: false },
        { subject: `pwchange:${o.userId}`, ip: "203.0.113.9", succeeded: false },
        { subject: `2fa:${member.id}`, ip: null, succeeded: true },
        { subject: `pwchange:${member.id}`, ip: "203.0.113.10", succeeded: false },
      ]);
      // Another workspace's rows of the same kinds must survive the purge.
      const bystander = await signup("purge-bystander");
      await db.insert(S.loginAttempts).values([{ subject: `2fa:${bystander.userId}`, ip: "203.0.113.11", succeeded: false }, { subject: `pwchange:${bystander.userId}`, ip: "203.0.113.11", succeeded: false }]);
      await db.insert(S.upgradeRequests).values([
        { orgId: o.orgId, name: "Owner", email: o.email, mobile: "+919999900000", country: "IN", planId: "growth" },
        { orgId: null, name: "Owner, signed out", email: o.email.toUpperCase(), mobile: "+919999900000", country: "IN", planId: "growth" },
      ]);
      await db.insert(S.auditLog).values([
        { orgId: null, actorType: "anonymous", action: "auth.login", result: "failed", ip: "203.0.113.9", data: { email: member.email } },
        { orgId: null, actorType: "user", actorUserId: o.userId, action: "auth.password_reset_requested", ip: "203.0.113.9", data: {} },
      ]);
      const scheduled = new Date(Date.now() - 1000);
      await db.insert(S.workspaceDeletionRequests).values({ orgId: o.orgId, requestedBy: o.userId, scheduledFor: scheduled });
      const { purgeDueWorkspaces } = await import("./services/accountDeletion.js");
      expect(await purgeDueWorkspaces({ onlyOrgIds: [o.orgId] })).toMatchObject({ reminded: [o.orgId], purged: [] });
      expect(await purgeDueWorkspaces({ onlyOrgIds: [o.orgId], now: new Date(Date.now() + 2 * 86_400_000) })).toMatchObject({ purged: [o.orgId], failed: [] });

      for (const needle of [o.email, member.email, o.userId, member.id, "purged-prospect.example", "+919999900000"]) expect(await tablesContaining(needle), needle).toEqual(needle === o.userId ? { audit_log: 1 } : {});
      expect((await q`SELECT count(*)::int AS n FROM login_attempts WHERE subject IN (${`2fa:${bystander.userId}`}, ${`pwchange:${bystander.userId}`})`)[0].n).toBe(2);
      // The one record kept: that it happened, with the workspace's name and counts - no person's address.
      expect(await tablesContaining(o.orgId)).toEqual({ audit_log: 1 });
      const [kept] = await q`SELECT action, org_id, data FROM audit_log WHERE target_id = ${o.orgId}`;
      expect(kept).toMatchObject({ action: "account.purged", org_id: null });
      expect(Object.keys(kept.data).sort()).toEqual(["counts", "hadSubscription", "name", "orgId", "plan", "requestId", "requestedAt", "requestedBy", "scheduledFor", "slug"]);
    });
  });

  // ── 4. AI ──────────────────────────────────────────────────────────────────────────
  describe("the workspace AI switch, and inbound mail", () => {
    const groq = () => {
      process.env.GROQ_API_KEY = "gsk_test_key";
      net.answer = (url) => (url.startsWith("https://api.groq.com/") ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "interested", confidence: 0.9, subject: "Re: hello", body: "Thanks - happy to share more." }) } }] }), { status: 200, headers: { "content-type": "application/json" } }) : null);
    };
    const aiCalls = () => net.calls.filter((c) => /groq|generativelanguage|anthropic/.test(c.url));

    it("GET/PATCH /v1/account/privacy: anyone reads, owner or admin changes, the address is cleaned, the change is recorded", async () => {
      const o = await signup("privacy");
      const member = await addMember(o, "member");
      const adminUser = await addMember(o, "admin");
      for (const t of [o.token, member.token, o.apiKey]) expect((await req("GET", "/v1/account/privacy", t)).body).toEqual({ aiAssist: true, mailingAddress: "" });
      expect((await req("GET", "/v1/account/privacy", null)).status).toBe(401);

      const denied = await req("PATCH", "/v1/account/privacy", member.token, { aiAssist: false });
      expect([denied.status, denied.body.error.code]).toEqual([403, "forbidden_role"]);
      expect((await req("PATCH", "/v1/account/privacy", o.apiKey, { aiAssist: false })).status).toBe(403);
      expect((await req("GET", "/v1/account/privacy", o.token)).body.aiAssist).toBe(true);

      const off = await req("PATCH", "/v1/account/privacy", adminUser.token, { aiAssist: false, mailingAddress: "  Acme Pvt Ltd\r\n12 MG Road\u0007, Bengaluru  " });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ aiAssist: false, mailingAddress: "Acme Pvt Ltd\n12 MG Road , Bengaluru" });
      // Only the two keys are written: a setting saved elsewhere is not lost.
      await db.execute(S.sql`UPDATE organizations SET settings = settings || '{"senderCompany":"Acme"}'::jsonb WHERE id = ${o.orgId}`);
      expect((await req("PATCH", "/v1/account/privacy", o.token, { aiAssist: true })).body).toEqual({ aiAssist: true, mailingAddress: "Acme Pvt Ltd\n12 MG Road , Bengaluru" });
      const [org] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      expect(org.settings).toMatchObject({ senderCompany: "Acme", aiDisabled: false, mailingAddress: "Acme Pvt Ltd\n12 MG Road , Bengaluru" });
      expect((await req("PATCH", "/v1/account/privacy", o.token, { mailingAddress: "" })).body).toEqual({ aiAssist: true, mailingAddress: "" });

      for (const bad of [{ mailingAddress: "x".repeat(301) }, { mailingAddress: "<b>Acme</b>" }, { aiAssist: "no" }, { surprise: true }]) expect((await req("PATCH", "/v1/account/privacy", o.token, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);

      const log = (await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, o.orgId))).filter((r: any) => r.action === "account.privacy_updated");
      expect(log.filter((r: any) => r.result === "ok")).toHaveLength(3);
      expect(log.filter((r: any) => r.result === "denied").length).toBeGreaterThanOrEqual(1);
      // What changed, not the address itself.
      expect(JSON.stringify(log)).not.toContain("MG Road");
    });

    it("with AI off, nothing of the workspace reaches a model: provider selection, preview and reply handling", async () => {
      groq();
      expect(aiLib.aiForOrg({ plan: "scale", settings: {} }).name).toBe("groq");
      expect(aiLib.aiForOrg({ plan: "scale", settings: { aiDisabled: true } }).name).toBe("none");
      // Only a literal true turns it off.
      for (const v of ["true", 1, "yes", null]) expect(aiLib.aiForOrg({ plan: "scale", settings: { aiDisabled: v } }).name).toBe("groq");

      const o = await signup("ai-off");
      const { campaign } = await setup({ orgId: o.orgId });
      await db.update(S.sequenceSteps).set({ aiPersonalize: true }).where(S.eq(S.sequenceSteps.campaignId, campaign.id));
      const [lead] = await db.insert(S.leads).values({ orgId: o.orgId, email: `known-${u8()}@prospect.example`, fullName: "Known Lead", firstName: "Known", emailStatus: "valid" }).returning();
      const usage = async () => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, o.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0;

      // AI on: a known lead's reply is classified by the model.
      const on = await req("POST", "/v1/campaigns/inbound", o.token, { from: `Known <${lead.email}>`, subject: "Re: hello", text: "Sounds interesting, tell me more about pricing." });
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ matched: true, intent: "interested" });
      expect(aiCalls().length).toBeGreaterThanOrEqual(1);
      expect(aiCalls()[0].body).toContain("tell me more about pricing");
      const usedOn = await usage();
      expect(usedOn).toBeGreaterThanOrEqual(1);

      // AI off.
      expect((await req("PATCH", "/v1/account/privacy", o.token, { aiAssist: false })).status).toBe(200);
      net.calls.length = 0;
      const offReply = await req("POST", "/v1/campaigns/inbound", o.token, { from: lead.email, subject: "Re: hello", text: "Could you send a quote? Also call me." });
      expect(offReply.status).toBe(200);
      expect(offReply.body).toMatchObject({ matched: true, skipped: "ai_off", note: expect.stringMatching(/AI assistance is turned off/) });
      const preview = await req("POST", `/v1/campaigns/${campaign.id}/preview`, o.token, { leadId: lead.id, stepNo: 1 });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ personalized: false, provider: "template", aiOff: true, note: expect.stringMatching(/AI assistance is turned off/) });
      const gen = await req("POST", "/v1/campaigns/generate", o.token, { leadId: lead.id, sender: { name: "A", company: "B", valueProp: "C" } });
      expect(gen.body).toMatchObject({ ai: false, note: expect.stringMatching(/turned off for this workspace/) });
      // A sequence step set to personalise sends the template, with no note of failure.
      const { cc } = { cc: (await db.insert(S.campaignContacts).values({ campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning())[0] };
      const step = (await db.select().from(S.sequenceSteps).where(S.eq(S.sequenceSteps.campaignId, campaign.id)))[0];
      expect(await campaignsSvc.sendStep(campaign.id, cc.id, step.id)).toMatchObject({ sent: true });
      expect(mocks.sent.at(-1)!.text.startsWith("Hi Known, a quick note.")).toBe(true);
      expect((await contact(cc.id)).lastError).toBeNull();
      // Not one request to a model, and nothing charged for AI.
      expect(aiCalls()).toEqual([]);
      expect(await usage()).toBe(usedOn);
    });

    it("mail from someone who is not a lead is never sent to AI - but an unsubscribe in it is still honoured by rule", async () => {
      groq();
      const o = await signup("ai-inbound");
      const stranger = await req("POST", "/v1/campaigns/inbound", o.token, { from: "Mum <mum@family.example>", subject: "Sunday", text: "Are you coming for lunch on Sunday? Dad's knee is better. Very interested to hear your news." });
      expect(stranger.status).toBe(200);
      expect(stranger.body).toMatchObject({ matched: false });
      expect(stranger.body.skipped).toBeUndefined();
      expect(aiCalls()).toEqual([]);
      expect(await tablesContaining("Dad's knee")).toEqual({});
      const usage = (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, o.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0;
      expect(usage).toBe(0);
      const optOut = await req("POST", "/v1/campaigns/inbound", o.token, { from: "someone@elsewhere.example", text: "Please unsubscribe me." });
      expect(optOut.body).toMatchObject({ matched: false, intent: "unsubscribe" });
      expect(aiCalls()).toEqual([]);
    });
  });

  // ── 5. Retention ───────────────────────────────────────────────────────────────────
  describe("retention", () => {
    it("the Privacy Policy states the numbers the cleanup job enforces", async () => {
      const legal = readFileSync(fileURLToPath(new URL("../../web/src/pages/Legal.tsx", import.meta.url)), "utf8");
      const block = legal.match(/const RETENTION = \{([\s\S]*?)\} as const;/);
      expect(block, "Legal.tsx must declare `const RETENTION = { ... } as const`").toBeTruthy();
      const stated = Object.fromEntries([...block![1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
      expect(stated).toEqual({ ...pr.RETENTION });
      // Each number is actually printed on the page, not just declared.
      for (const key of Object.keys(pr.RETENTION)) expect(legal, key).toContain(`{RETENTION.${key}}`);
      const { DELETION_GRACE_MS } = await import("./services/accountDeletion.js");
      expect(Number(legal.match(/const DELETION_GRACE_DAYS = (\d+);/)?.[1])).toBe(DELETION_GRACE_MS / 86_400_000);
      expect(legal).toContain("{DELETION_GRACE_DAYS}");
      // Claims the code does not make good on must not come back.
      expect(legal).not.toMatch(/do not use API inputs to train/);
      expect(legal).not.toMatch(/npx/);
      expect(legal).toMatch(/Global Privacy Control/);
      expect(legal).not.toContain("—");
    });

    it("removes what is past its date and keeps what is not", async () => {
      const o = await signup("retention");
      const [pixel] = await db.insert(S.pixels).values({ orgId: o.orgId, key: `px_${randomBytes(9).toString("base64url")}`, name: "site" }).returning();
      const R = pr.RETENTION;
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
      const tag = `ret-${u8()}`;
      const visit = (days: number) => ({ orgId: o.orgId, pixelId: pixel.id, sessionId: `${tag}-${days}`, ipHash: pv.visitorIpHash("203.0.113.5", pixel.id), page: "/", visitedAt: ago(days) });
      await db.insert(S.visits).values([visit(R.visitDays + 1), visit(R.visitDays - 1)]);
      await db.insert(S.loginAttempts).values([
        { subject: `${tag}-fail-old`, ip: "203.0.113.1", succeeded: false, createdAt: ago(R.loginFailureDays + 1) },
        { subject: `${tag}-fail-new`, ip: "203.0.113.1", succeeded: false, createdAt: ago(R.loginFailureDays - 1) },
        { subject: `${tag}-ok-old`, ip: "203.0.113.1", succeeded: true, createdAt: ago(R.loginSuccessDays + 1) },
        { subject: `${tag}-ok-new`, ip: "203.0.113.1", succeeded: true, createdAt: ago(R.loginSuccessDays - 1) },
      ]);
      await db.insert(S.passwordResetTokens).values([
        { userId: o.userId, tokenHash: `${tag}-reset-old`, expiresAt: ago(R.expiredTokenDays + 1) },
        { userId: o.userId, tokenHash: `${tag}-reset-new`, expiresAt: ago(R.expiredTokenDays - 1) },
      ]);
      await db.insert(S.emailVerificationTokens).values([
        { userId: o.userId, tokenHash: `${tag}-verify-old`, expiresAt: ago(R.expiredTokenDays + 1) },
        { userId: o.userId, tokenHash: `${tag}-verify-new`, expiresAt: ago(R.expiredTokenDays - 1) },
      ]);
      await db.insert(S.invites).values([
        { orgId: o.orgId, email: `${tag}-accepted-old@example.com`, tokenHash: `${tag}-i1`, acceptedAt: ago(R.closedInviteDays + 1), expiresAt: ago(R.closedInviteDays + 5) },
        { orgId: o.orgId, email: `${tag}-expired-old@example.com`, tokenHash: `${tag}-i2`, expiresAt: ago(R.closedInviteDays + 1) },
        { orgId: o.orgId, email: `${tag}-accepted-new@example.com`, tokenHash: `${tag}-i3`, acceptedAt: ago(R.closedInviteDays - 1), expiresAt: ago(R.closedInviteDays - 1) },
        { orgId: o.orgId, email: `${tag}-pending@example.com`, tokenHash: `${tag}-i4`, expiresAt: new Date(Date.now() + 86_400_000) },
      ]);
      await db.insert(S.auditLog).values([
        { orgId: o.orgId, action: `${tag}.old`, ip: "203.0.113.1", createdAt: ago(R.auditLogDays + 1) },
        { orgId: o.orgId, action: `${tag}.new`, ip: "203.0.113.1", createdAt: ago(R.auditLogDays - 1) },
      ]);
      await db.insert(S.upgradeRequests).values([
        { name: `${tag}-closed-old`, email: "a@example.com", mobile: "1", country: "IN", planId: "growth", status: "dismissed", createdAt: ago(R.closedUpgradeRequestDays + 1) },
        { name: `${tag}-open-old`, email: "a@example.com", mobile: "1", country: "IN", planId: "growth", status: "new", createdAt: ago(R.closedUpgradeRequestDays + 1) },
        { name: `${tag}-closed-new`, email: "a@example.com", mobile: "1", country: "IN", planId: "growth", status: "converted", createdAt: ago(R.closedUpgradeRequestDays - 1) },
      ]);
      const [v] = await db.select().from(S.visits).where(S.eq(S.visits.sessionId, `${tag}-${R.visitDays - 1}`));
      await db.insert(S.jobs).values([
        { orgId: o.orgId, type: "visit.identify", payload: { visitId: v.id, ip: "203.0.113.5", identify: { email: "x@example.org" } }, status: "failed", updatedAt: ago(0.5) },
        { orgId: o.orgId, type: "visit.identify", payload: { visitId: v.id }, status: "done", updatedAt: ago(2) },
      ]);

      const report = await pr.runRetention(db);
      expect(report.failed).toEqual([]);

      const names = async (table: string, col: string) => (await db.execute(S.sql.raw(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE '${tag}%' ORDER BY 1`))).map((r: any) => r.v);
      expect(await names("visits", "session_id")).toEqual([`${tag}-${R.visitDays - 1}`]);
      expect(await names("login_attempts", "subject")).toEqual([`${tag}-fail-new`, `${tag}-ok-new`]);
      expect(await names("password_reset_tokens", "token_hash")).toEqual([`${tag}-reset-new`]);
      expect(await names("email_verification_tokens", "token_hash")).toEqual([`${tag}-verify-new`]);
      expect(await names("invites", "email")).toEqual([`${tag}-accepted-new@example.com`, `${tag}-pending@example.com`]);
      expect(await names("audit_log", "action")).toEqual([`${tag}.new`]);
      expect(await names("upgrade_requests", "name")).toEqual([`${tag}-closed-new`, `${tag}-open-old`]);
      // The lookup that failed half a day ago is still there for diagnosis, without the address; the old one is gone.
      const left = await jobsOf(o.orgId, "visit.identify");
      expect(left.map((j: any) => [j.status, j.payload])).toEqual([["failed", { visitId: v.id }]]);
    });

    it("system.cleanup runs the retention pass and reports it", async () => {
      const [job] = await db.insert(S.jobs).values({ type: "system.cleanup", payload: {}, status: "running", attempts: 1, maxAttempts: 1 }).returning();
      const r = await jobHandlers["system.cleanup"](job, ctx());
      expect(r.retention).toMatchObject({ failed: [] });
      expect(typeof r.retention.deleted).toBe("object");
    });
  });

  // ── 6. The admin console sees a whitelist ──────────────────────────────────────────
  describe("admin org detail", () => {
    it("returns named fields only: no settings, no billing identifiers, no copies of customers' emails", async () => {
      const o = await signup("adm-detail");
      await db.execute(S.sql`UPDATE organizations SET stripe_customer_id = 'cus_SECRET123', stripe_subscription_id = 'sub_SECRET456',
        settings = ${JSON.stringify({ aiDisabled: true, mailingAddress: "9 Hidden Lane", valueProp: "INTERNAL-PITCH", aiReplyStyleExamples: [{ subject: "Re", body: "Dear Priya, PRIVATE-REPLY" }] })}::jsonb WHERE id = ${o.orgId}`);
      const r = await admin("GET", `/orgs/${o.orgId}`);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body.org).sort()).toEqual(["aiAssist", "createdAt", "hasSubscription", "id", "limits", "mailingAddressSet", "name", "overrides", "pendingDeletionAt", "plan", "planLimits", "slug", "status"]);
      expect(r.body.org).toMatchObject({ id: o.orgId, name: o.orgName, plan: "scale", status: "active", aiAssist: false, mailingAddressSet: true, hasSubscription: true });
      for (const secret of ["cus_SECRET123", "sub_SECRET456", "PRIVATE-REPLY", "INTERNAL-PITCH", "Hidden Lane", "settings", "password", "totp"]) expect(r.text, secret).not.toContain(secret);
      // What the console already read is still there.
      expect(r.body.users.map((u: any) => u.email)).toEqual([o.email]);
      expect(r.body).toHaveProperty("usage");
      expect(r.body).toHaveProperty("overrides");
    });
  });

  // ── 6b. Round 5: what the verifiers found on the release candidate ─────────────────
  describe("platform list: refused on create, skipped on import, plus-tagged variants", () => {
    it("POST /v1/leads refuses a listed address with 409 'suppressed' (not 201 with the address dropped); import skips and counts it", async () => {
      const o = await signup("r5-create");
      const listed = `listed-${u8()}@prospect.example`;
      await db.insert(S.globalSuppressions).values({ email: listed, reason: "request" });
      const leadsUsed = async () => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, o.orgId), S.eq(S.usage.metric, "leads"))))[0]?.count ?? 0;

      const refused = await req("POST", "/v1/leads", o.token, { email: listed, fullName: "Lee Listed" });
      expect([refused.status, refused.body.error.code]).toEqual([409, "suppressed"]);
      expect(refused.body.error.message).toBe("This person has asked not to be contacted through Scout, so their address cannot be stored.");
      expect(await db.select().from(S.leads).where(S.eq(S.leads.orgId, o.orgId))).toHaveLength(0);
      expect(await leadsUsed()).toBe(0);
      // Someone not on the list is saved as before.
      const fine = await req("POST", "/v1/leads", o.token, { email: `fine-${u8()}@prospect.example`, fullName: "Fay Fine" });
      expect(fine.status).toBe(201);

      const imp = await req("POST", "/v1/leads/import", o.token, [
        { email: `imp-${u8()}@prospect.example`, fullName: "Ina Imported" },
        { email: listed.toUpperCase(), fullName: "Lee Listed" },
        { email: listed.replace("@", "+promo@"), fullName: "Lee Listed Again" },
      ]);
      expect(imp.status).toBe(200);
      expect(imp.body).toMatchObject({ created: 1, updated: 0, skipped: 2, skippedDoNotContact: 2 });
      expect(imp.body.skippedRows.map((r: any) => [r.row, r.code])).toEqual([[2, "do_not_contact"], [3, "do_not_contact"]]);
      expect(imp.body.skippedRows[0].reason).toBe("This person has asked not to be contacted through Scout, so they were not imported.");
      expect((await db.select().from(S.leads).where(S.eq(S.leads.orgId, o.orgId))).map((l: any) => l.fullName).sort()).toEqual(["Fay Fine", "Ina Imported"]);
      expect(await tablesContaining("Lee Listed")).toEqual({});
      // Only the two that were created were charged.
      expect(await leadsUsed()).toBe(2);
    });

    it("a listed address blocks its plus-tagged variants - and a listed variant blocks the plain address - on lookup, send and store", async () => {
      const tag = u8();
      const plain = `jane-${tag}@prospect.example`;
      const variant = `jane-${tag}+news@prospect.example`;
      expect(ps.platformBase(variant)).toBe(plain);
      expect(ps.platformBase(`  ${plain.toUpperCase()} `)).toBe(plain);
      // Not a tag: a local part that starts with "+", and anything after the "@".
      expect(ps.platformBase("+odd@x.example")).toBe("+odd@x.example");
      expect(ps.platformBase("a@b+c.example")).toBe("a@b+c.example");
      // No provider-specific rules: dots are different people.
      expect(ps.platformBase("j.ane@x.example")).not.toBe(ps.platformBase("jane@x.example"));

      await db.insert(S.globalSuppressions).values({ email: plain, reason: "request" });
      // Lookup.
      for (const a of [plain, variant, `jane-${tag}+a+b@prospect.example`, variant.toUpperCase()]) expect(await ps.onPlatformList(a), a).toBe(true);
      for (const a of [`jane-${tag}x@prospect.example`, `jane-${tag}@other.example`, `ane-${tag}@prospect.example`]) expect(await ps.onPlatformList(a), a).toBe(false);
      expect([...(await ps.platformListed([variant, `nobody-${tag}@prospect.example`, plain]))].sort()).toEqual([plain, variant].sort());
      // Send.
      const { org, campaign, step } = await setup();
      const { cc } = await newContact(org.id, campaign.id, { email: variant });
      expect(await campaignsSvc.sendStep(campaign.id, cc.id, step.id)).toMatchObject({ skipped: "suppressed", list: "platform" });
      expect(mocks.sent).toHaveLength(0);
      // Store.
      const stored = await leadsSvc.upsertLead(org.id, { email: `jane-${tag}+sales@prospect.example`, fullName: "Jane Variant", source: "import" });
      expect(stored.lead.email).toBeNull();
      const o = await signup("r5-plus");
      const refused = await req("POST", "/v1/leads", o.token, { email: variant, fullName: "Jane Variant" });
      expect([refused.status, refused.body.error.code]).toEqual([409, "suppressed"]);

      // The other way round: listing a tagged address covers the mailbox.
      const other = `sam-${tag}@prospect.example`;
      await db.insert(S.globalSuppressions).values({ email: other.replace("@", "+list@"), reason: "request" });
      expect(await ps.onPlatformList(other)).toBe(true);
      expect(await ps.onPlatformList(other.replace("@", "+else@"))).toBe(true);

      // An erasure request by the plain address finds and removes the tagged record too.
      const { lead: tagged } = await newContact(org.id, campaign.id, { email: `erin-${tag}+promo@prospect.example`, fullName: "Erin Tagged" });
      const report = await admin("GET", `/data-subject?email=${encodeURIComponent(`erin-${tag}@prospect.example`)}`);
      expect(report.body).toMatchObject({ held: true });
      expect(report.body.workspaces.map((w: any) => [w.orgId, w.leads])).toEqual([[org.id, 1]]);
      const erased = await admin("POST", "/data-subject/erase", { email: `erin-${tag}@prospect.example`, confirm: `erin-${tag}@prospect.example` });
      expect(erased.body).toMatchObject({ ok: true, leadsDeleted: 1 });
      expect(await db.select().from(S.leads).where(S.eq(S.leads.id, tagged.id))).toHaveLength(0);
    });
  });

  describe("an anonymised message is never shown as a fingerprint", () => {
    it("message lists and the do-not-contact list answer toEmail/email null with recipientRemoved, and events do the same", async () => {
      const o = await signup("r5-shown");
      const { campaign, step } = await setup({ orgId: o.orgId });
      const gone = await newContact(o.orgId, campaign.id, { fullName: "Gone Soon" });
      const stays = await newContact(o.orgId, campaign.id, { fullName: "Stays Here" });
      for (const c of [gone, stays]) expect(await campaignsSvc.sendStep(campaign.id, c.cc.id, step.id)).toMatchObject({ sent: true });
      const [goneMsg] = await db.select().from(S.messages).where(S.eq(S.messages.leadId, gone.lead.id));
      await pe.eraseLeads(o.orgId, [gone.lead.id]);
      // The removed contact unsubscribes from the email they already had.
      expect((await app.request(`/t/u/${goneMsg.trackingToken}`, { method: "POST" })).status).toBe(200);

      const list = await req("GET", `/v1/campaigns/${campaign.id}/messages`, o.token);
      expect(list.status).toBe(200);
      const byRemoved = (flag: boolean) => list.body.messages.filter((m: any) => m.recipientRemoved === flag);
      expect(byRemoved(true)).toHaveLength(1);
      expect(byRemoved(true)[0]).toMatchObject({ toEmail: null, subject: "(removed)", bodyText: "(removed)", lead: null });
      expect(byRemoved(false)).toHaveLength(1);
      expect(byRemoved(false)[0]).toMatchObject({ toEmail: stays.lead.email, lead: { id: stays.lead.id } });

      const dnc = await req("GET", "/v1/leads/suppressions/all", o.token);
      expect(dnc.body.suppressions).toHaveLength(1);
      expect(dnc.body.suppressions[0]).toMatchObject({ email: null, recipientRemoved: true, reason: "unsubscribe_link" });
      const events = await req("GET", "/v1/events?type=lead.unsubscribed", o.token);
      expect(events.body.events[0].data).toMatchObject({ email: null, recipientRemoved: true });
      for (const r of [list, dnc, events]) expect(r.text).not.toContain("sha256:");
      // The workspace's own export follows the same rule: no fingerprint, the flag instead.
      const exported = await app.request("/v1/account/export", { headers: { authorization: `Bearer ${o.token}`, "x-confirm-password": PASSWORD, "cf-connecting-ip": `198.51.100.${1 + Math.floor(Math.random() * 250)}` } });
      expect(exported.status).toBe(200);
      const dump = await exported.text();
      expect(dump).not.toContain("sha256:");
      const doc = JSON.parse(dump);
      expect(doc.messages.filter((m: any) => m.recipientRemoved === true && m.toEmail === null)).toHaveLength(1);
      expect(doc.messages.filter((m: any) => m.recipientRemoved === false && m.toEmail === stays.lead.email)).toHaveLength(1);
      expect(doc.suppressions).toEqual([expect.objectContaining({ email: null, recipientRemoved: true })]);
      // A normal entry is unchanged, with the flag false.
      await req("POST", "/v1/leads/suppressions", o.token, { emails: [`plain-${u8()}@prospect.example`] });
      const dnc2 = await req("GET", "/v1/leads/suppressions/all", o.token);
      expect(dnc2.body.suppressions.filter((x: any) => x.recipientRemoved === false && typeof x.email === "string")).toHaveLength(1);
    });
  });

  describe("operator switches", () => {
    it("PRIVACY_SWEEP=off skips the deleted-lead sweep and nothing else", async () => {
      const { org, campaign } = await setup();
      const email = `sweepoff-${u8()}@prospect.example`;
      const [lead] = await db.insert(S.leads).values({ orgId: org.id, email, fullName: "Sweep Off" }).returning();
      await db.insert(S.messages).values({ orgId: org.id, campaignId: campaign.id, leadId: lead.id, toEmail: email, subject: "Hello Sweep", bodyText: "Body", status: "sent", createdAt: new Date(Date.now() - 2 * 3600_000) });
      const [pixel] = await db.insert(S.pixels).values({ orgId: org.id, key: `px_${randomBytes(9).toString("base64url")}`, name: "site" }).returning();
      await db.insert(S.visits).values({ orgId: org.id, pixelId: pixel.id, sessionId: `sw-${u8()}`, ipHash: pv.visitorIpHash("203.0.113.5", pixel.id), page: "/", visitedAt: new Date(Date.now() - (pr.RETENTION.visitDays + 2) * 86_400_000) });
      await db.delete(S.leads).where(S.eq(S.leads.id, lead.id));

      process.env.PRIVACY_SWEEP = "off";
      expect(pr.privacySweepEnabled()).toBe(false);
      const off = await pr.runRetention(db);
      expect(off.skipped).toEqual([expect.stringMatching(/copies of deleted leads/)]);
      expect(off.converted["messages of deleted leads"]).toBeUndefined();
      // The message is untouched; the rest of retention still ran (the old visit is gone).
      expect((await db.select().from(S.messages).where(S.eq(S.messages.orgId, org.id)))[0]).toMatchObject({ toEmail: email, subject: "Hello Sweep" });
      expect(await db.select().from(S.visits).where(S.eq(S.visits.pixelId, pixel.id))).toHaveLength(0);

      delete process.env.PRIVACY_SWEEP;
      expect(pr.privacySweepEnabled()).toBe(true);
      const on = await pr.runRetention(db);
      expect(on.skipped).toBeUndefined();
      expect((await db.select().from(S.messages).where(S.eq(S.messages.orgId, org.id)))[0]).toMatchObject({ toEmail: ps.addressFingerprint(email), subject: "(removed)" });
    });

    it("the plain-HTTP IP lookup is used only when switched on, and only after the HTTPS providers", async () => {
      const core = await import("@prospex/core");
      // No real reverse-DNS query leaves the machine either.
      const dns = await import("node:dns");
      const reverse = vi.spyOn(dns.promises, "reverse").mockRejectedValue(Object.assign(new Error("no record"), { code: "ENOTFOUND" }));
      const answer = (url: string) => (url.startsWith("http://ip-api.com/") ? new Response(JSON.stringify({ status: "success", org: "Example Corp Ltd", isp: "Example Corp Ltd", as: "AS64501 Example", country: "India", city: "Pune", hosting: true }), { status: 200, headers: { "content-type": "application/json" } }) : null);
      net.answer = answer;
      // Off (the default): the HTTPS providers are asked, and nothing travels in clear.
      const off = await core.identifyIp("203.0.113.211", { allowPlainHttp: false });
      expect(net.calls.map((c) => c.url).filter((u) => u.startsWith("http://"))).toEqual([]);
      expect(off.provider).not.toBe("ip-api");
      net.calls.length = 0;
      process.env.IP_LOOKUP_ALLOW_PLAIN_HTTP = "true";
      const on = await core.identifyIp("203.0.113.212");
      expect(on).toMatchObject({ resolved: true, provider: "ip-api", orgName: "Example Corp Ltd" });
      expect(net.calls.map((c) => new URL(c.url).host)).toEqual(["api.ipapi.is", "ipinfo.io", "ip-api.com"]);
      reverse.mockRestore();
    });
  });

  describe("AI switched off: the same sentence everywhere, and nothing charged when no AI runs", () => {
    it("company brief, ICP assistant, 'write with AI' and the search parser say AI is off and how to turn it on", async () => {
      process.env.GROQ_API_KEY = "gsk_test_key";
      net.answer = (url) => (url.startsWith("https://api.groq.com/") ? new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200, headers: { "content-type": "application/json" } }) : null);
      const o = await signup("r5-aioff");
      expect((await req("PATCH", "/v1/account/privacy", o.token, { aiAssist: false })).status).toBe(200);
      const [company] = await db.insert(S.companies).values({ orgId: o.orgId, domain: `acme-${u8()}.example`, name: "Acme" }).returning();
      const [icp] = await db.insert(S.icps).values({ orgId: o.orgId, name: "Buyers", criteria: {} }).returning();
      const used = async () => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, o.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0;
      const OFF = /^AI assistance is turned off for this workspace.* An owner or admin can turn it back on under Settings\.$/;

      const brief = await req("POST", `/v1/companies/${company.id}/brief`, o.token, {});
      expect(brief.status).toBe(200);
      expect(brief.body).toMatchObject({ brief: null, aiOff: true });
      expect(brief.body.error).toMatch(OFF);
      const chat = await req("POST", `/v1/icps/${icp.id}/chat`, o.token, { message: "Make it more specific" });
      expect([chat.status, chat.body.error.code]).toEqual([409, "ai_off"]);
      expect(chat.body.error.message).toMatch(OFF);
      const suggest = await req("POST", "/v1/visibility/prompts/suggest", o.token, { ai: true });
      expect(suggest.status).toBe(200);
      expect(suggest.body).toMatchObject({ source: "starter", aiOff: true });
      expect(suggest.body.note).toMatch(/AI assistance is turned off for this workspace.*turn it back on under Settings\.$/);
      const parse = await req("POST", "/v1/search/parse", o.token, { query: "heads of marketing at fintech companies in Pune" });
      expect(parse.status).toBe(200);
      expect(parse.body).toMatchObject({ aiOff: true, note: expect.stringMatching(OFF) });
      for (const r of [brief, chat, suggest, parse]) expect(r.text).not.toMatch(/contact support/i);
      // No model was called and no AI message was charged for any of it.
      expect(net.calls.filter((c) => /groq|generativelanguage|anthropic/.test(c.url))).toEqual([]);
      expect(await used()).toBe(0);

      // Back on: the parser uses (and charges for) the model again.
      expect((await req("PATCH", "/v1/account/privacy", o.token, { aiAssist: true })).status).toBe(200);
      const parseOn = await req("POST", "/v1/search/parse", o.token, { query: "heads of marketing at fintech companies in Pune" });
      expect(parseOn.body.aiOff).toBeUndefined();
      expect(net.calls.filter((c) => c.url.includes("groq")).length).toBeGreaterThanOrEqual(1);
      expect(await used()).toBe(1);
    });

    it("with no AI engine at all, the search parser charges nothing either", async () => {
      const o = await signup("r5-noai");
      const parse = await req("POST", "/v1/search/parse", o.token, { query: "CTOs at logistics companies in Delhi" });
      expect(parse.status).toBe(200);
      expect(parse.body.aiOff).toBeUndefined();
      expect((await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, o.orgId), S.eq(S.usage.metric, "aiMessages"))))[0]?.count ?? 0).toBe(0);
    });
  });

  describe("settings, limits and wording", () => {
    it("an ICP with more than 50 terms in a facet can be saved; the cap is 500", async () => {
      const o = await signup("r5-icp");
      const sixty = Array.from({ length: 60 }, (_, i) => `keyword ${i}`);
      const made = await req("POST", "/v1/icps", o.token, { name: "Wide", criteria: { keywords: sixty } });
      expect(made.status).toBe(201);
      const id = made.body.icp?.id ?? made.body.id;
      const saved = await req("PATCH", `/v1/icps/${id}`, o.token, { name: "Wide, renamed", criteria: { keywords: sixty, titles: ["CTO"] } });
      expect(saved.status).toBe(200);
      const tooMany = await req("POST", "/v1/icps", o.token, { name: "Too wide", criteria: { keywords: Array.from({ length: 501 }, (_, i) => `k${i}`) } });
      expect(tooMany.status).toBe(400);
    });

    it("a search text that is too long is named in words, not as 'Q'", async () => {
      const o = await signup("r5-q");
      for (const path of ["/v1/leads", "/v1/signals"]) {
        const r = await req("GET", `${path}?q=${"x".repeat(121)}`, o.token);
        expect(r.status, path).toBe(400);
        expect(r.body.error.message, path).toContain("Search text is too long (120 characters at most)");
        expect(r.body.error.message).not.toMatch(/\bQ is\b/);
      }
    });

    it("PATCH /v1/auth/org: a mailing address over 300 characters is refused, and saving other settings does not undo the AI switch", async () => {
      const o = await signup("r5-org");
      const long = await req("PATCH", "/v1/auth/org", o.token, { settings: { mailingAddress: "x".repeat(301) } });
      expect(long.status).toBe(400);
      expect(long.body.error.message).toMatch(/300 characters/);
      expect((await req("PATCH", "/v1/auth/org", o.token, { settings: { mailingAddress: "<b>x</b>" } })).status).toBe(400);
      expect((await req("PATCH", "/v1/auth/org", o.token, { settings: { aiDisabled: "yes" } })).status).toBe(400);
      const ok = await req("PATCH", "/v1/auth/org", o.token, { settings: { mailingAddress: " 1 Main Road\r\nPune ", senderCompany: "Acme" } });
      expect(ok.status).toBe(200);
      expect((await req("GET", "/v1/account/privacy", o.token)).body).toEqual({ aiAssist: true, mailingAddress: "1 Main Road\nPune" });

      // A colleague turns AI off. This session's copy of the settings is now stale...
      await db.execute(S.sql`UPDATE organizations SET settings = settings || '{"aiDisabled":true}'::jsonb WHERE id = ${o.orgId}`);
      // ...and saving something else from it must not turn AI back on.
      expect((await req("PATCH", "/v1/auth/org", o.token, { settings: { valueProp: "We cut onboarding time" } })).status).toBe(200);
      const { saveVisibilityConfig } = await import("./services/visibility.js");
      await saveVisibilityConfig(db, o.orgId, { brand: { name: "Acme", aliases: [], domain: null }, competitors: [] } as any);
      const [org] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      expect(org.settings).toMatchObject({ aiDisabled: true, senderCompany: "Acme", valueProp: "We cut onboarding time", mailingAddress: "1 Main Road\nPune", visibility: { brand: { name: "Acme" } } });
      expect((await req("GET", "/v1/account/privacy", o.token)).body.aiAssist).toBe(false);
    });
  });

  describe("account mail", () => {
    it("'Send again' ends the earlier confirmation links: only the newest works", async () => {
      const o = await signup("r5-verify");
      await db.update(S.users).set({ emailVerifiedAt: null }).where(S.eq(S.users.id, o.userId));
      const ev = await import("./lib/emailVerification.js");
      const first = await ev.issueVerificationToken(o.userId);
      const second = await ev.issueVerificationToken(o.userId);
      const third = await ev.issueVerificationToken(o.userId);
      for (const stale of [first, second]) {
        const r = await req("POST", "/v1/auth/verify/confirm", null, { token: stale });
        expect([r.status, r.body.error.code]).toEqual([400, "invalid_verification_token"]);
      }
      expect((await db.select().from(S.users).where(S.eq(S.users.id, o.userId)))[0].emailVerifiedAt).toBeNull();
      expect((await req("POST", "/v1/auth/verify/confirm", null, { token: third })).status).toBe(200);
      expect((await db.select().from(S.users).where(S.eq(S.users.id, o.userId)))[0].emailVerifiedAt).toBeTruthy();
      // Another person's link is not touched by someone else asking again.
      const other = await signup("r5-verify-other");
      await db.update(S.users).set({ emailVerifiedAt: null }).where(S.eq(S.users.id, other.userId));
      const theirs = await ev.issueVerificationToken(other.userId);
      await ev.issueVerificationToken(o.userId);
      expect((await req("POST", "/v1/auth/verify/confirm", null, { token: theirs })).status).toBe(200);
    });

    it("the 'new sign-in' notice goes out at most once per 24 hours per person - across restarts", async () => {
      mocks.platformMailer = true;
      const sm = await import("./lib/securityMail.js");
      const o = await signup("r5-notice");
      const user = { id: o.userId, orgId: o.orgId, email: o.email };
      mocks.sent.length = 0;
      expect(await sm.notifySecurity(user, "new_signin", { ip: "203.0.113.10", method: "your password" })).toBe(true);
      // An hour later, and after a restart (the in-memory window is gone): still not again.
      rateWindow.resetWindows();
      expect(await sm.notifySecurity(user, "new_signin", { ip: "203.0.113.11", method: "your password" })).toBe(false);
      expect(mocks.sent.filter((m) => m.to === o.email)).toHaveLength(1);
      // Someone else is not affected.
      const other = await signup("r5-notice-other");
      expect(await sm.notifySecurity({ id: other.userId, orgId: other.orgId, email: other.email }, "new_signin", { ip: "203.0.113.10", method: "your password" })).toBe(true);
      // Other kinds of notice are not held back by it.
      expect(await sm.notifySecurity(user, "password_changed", { ip: "203.0.113.10" })).toBe(true);
      // A day later it is sent again.
      await db.execute(S.sql`UPDATE audit_log SET created_at = now() - interval '25 hours' WHERE action = 'security.new_signin_notice' AND org_id = ${o.orgId}`);
      rateWindow.resetWindows();
      expect(await sm.notifySecurity(user, "new_signin", { ip: "203.0.113.12", method: "your password" })).toBe(true);
      // The record of it names no address.
      const log = await q`SELECT target_id, data FROM audit_log WHERE action = 'security.new_signin_notice' AND org_id = ${o.orgId}`;
      expect(log).toHaveLength(2);
      expect(JSON.stringify(log)).not.toContain(o.email);
    });
  });

  // ── 7. SDK ─────────────────────────────────────────────────────────────────────────
  describe("SDK: a path value is one path segment, and a key never travels over plain HTTP", () => {
    it("ids, domains and provider names are checked before any request is made", async () => {
      const sdk = await import("@prospex/sdk");
      const seen: string[] = [];
      const client = new sdk.Prospex({ apiKey: "px_live_SECRET", baseUrl: "https://api.scout.test", fetch: (async (url: any) => { seen.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch });
      const id = "3F2B8C1E-5D47-4A9B-9C0E-2F6A7B8C9D01";
      await client.leads.get(id);
      await client.outreach.start(id);
      await client.visitors.decisionMakers("Acme.COM");
      await client.account.syncToCrm("HubSpot", [id]);
      expect(seen).toEqual([
        `https://api.scout.test/v1/leads/${id.toLowerCase()}`,
        `https://api.scout.test/v1/campaigns/${id.toLowerCase()}/start`,
        "https://api.scout.test/v1/visitors/acme.com/decision-makers",
        "https://api.scout.test/v1/integrations/hubspot/sync",
      ]);
      seen.length = 0;
      const attacks: [() => Promise<unknown>, string][] = [
        [() => client.leads.get("export.csv"), "invalid_id"],
        [() => client.leads.get("suppressions/all"), "invalid_id"],
        [() => client.enrich.lead("../campaigns/x/start?"), "invalid_id"],
        [() => client.leads.get(".."), "invalid_id"],
        [() => client.leads.delete(`${id}/../../auth/api-keys`), "invalid_id"],
        [() => client.tools.setLeadStatus(`../../campaigns/${id}/start?`, "new"), "invalid_id"],
        [() => client.visitors.decisionMakers("../leads/bulk/delete?"), "invalid_domain"],
        [() => client.visitors.decisionMakers(".."), "invalid_domain"],
        [() => client.account.syncToCrm("../leads/bulk/delete?", [id]), "invalid_provider"],
        [() => client.account.configureIntegration("a/b", {}), "invalid_provider"],
      ];
      for (const [call, code] of attacks) {
        let err: any = null;
        try {
          await call();
        } catch (e) {
          err = e;
        }
        expect(err, code).toBeInstanceOf(sdk.ProspexError);
        expect(err.code).toBe(code);
        expect(String(err.message)).not.toContain("SECRET");
      }
      expect(seen).toEqual([]);
    });

    it("refuses to send a key to an http:// address that is not this machine", async () => {
      const sdk = await import("@prospex/sdk");
      expect(sdk.insecureBaseUrlReason("https://api.example.com")).toBeNull();
      for (const ok of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", "http://api.localhost:3000"]) expect(sdk.insecureBaseUrlReason(ok), ok).toBeNull();
      for (const bad of ["http://api.example.com", "http://192.168.1.5:8080", "http://localhost.evil.example", "ftp://api.example.com", "not a url", "http://127.0.0.1.evil.example"]) expect(sdk.insecureBaseUrlReason(bad), bad).toBeTruthy();
      const seen: string[] = [];
      // Constructing never throws; using it does, and nothing is sent.
      const client = new sdk.Prospex({ apiKey: "px_live_SECRET", baseUrl: "http://api.example.com", fetch: (async (url: any) => { seen.push(String(url)); return new Response("{}"); }) as typeof fetch });
      await expect(client.account.usage()).rejects.toMatchObject({ code: "insecure_base_url", status: 0 });
      expect(seen).toEqual([]);
    });
  });
});
