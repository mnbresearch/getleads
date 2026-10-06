/**
 * Plays: the review queue between "found" and "lead".
 *
 * Through the real app (createApp), the real job handlers and a real database, in its own
 * Postgres schema (`plays_test`) so the scheduler and the retention pass - which act on
 * whole tables - are not raced by another test file.
 *
 * The engines are replaced at the one seam they are reached through
 * (services/playEngines.ts `setPlayEngines`), with fakes that return findings: nothing here
 * depends on what @prospex/core's play functions do, searches the web or fetches a page.
 * The two engines the API owns (website visitors, job changes) run for real, against rows
 * seeded here. `fetch` is stubbed to throw and mail is captured: nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/plays.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "plays_test";

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
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "ROW_CAP_PLAYS"]) delete process.env[k];
}

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string }) => {
      mail.sent.push(input);
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}-${Math.random()}` };
    }),
  };
});

if (!TEST_DB) {
  process.stderr.write(`\n[!] "plays" did NOT run: TEST_DATABASE_URL is not set.\n    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/plays.test.ts\n`);
}

const suite = TEST_DB ? describe : describe.skip;

suite("plays", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any; // @prospex/db
  let core: any;
  let handlers: any;
  let svc: typeof import("./services/plays.js");
  let engines: typeof import("./services/playEngines.js");
  let restoreEngines: () => void = () => {};

  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string; userId: string; email: string; apiKey: string };

  const u8 = () => randomUUID().slice(0, 8);
  const rows = (r: any): any[] => (Array.isArray(r) ? [...r] : (r?.rows ?? []));
  const q = async (strings: TemplateStringsArray, ...values: unknown[]) => rows(await db.execute(S.sql(strings, ...values)));
  let ipSeq = 0;
  const ip = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
  const realFetch = globalThis.fetch;

  async function req(method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const auth = token ? (token.startsWith("px_") ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) : {};
    const res: Response = await app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": ip(), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }

  async function signup(name: string, patch: Record<string, unknown> = {}): Promise<Org> {
    const email = `${name}-${u8()}@example.com`;
    const r = await req("POST", "/v1/auth/signup", null, { email, password: PASSWORD, orgName: `${name} ${u8()}` });
    expect(r.status).toBe(201);
    const orgId = r.body.org.id as string;
    // Roomy limits, so a quota never stands in for the behaviour under test (tests that are
    // about a quota set their own).
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale"), ...patch }).where(S.eq(S.organizations.id, orgId));
    return { token: r.body.token, orgId, userId: r.body.user.id, email, apiKey: r.body.apiKey };
  }

  const usageOf = async (orgId: string, metric: string) => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, orgId), S.eq(S.usage.metric, metric))))[0]?.count ?? 0;
  const setUsage = (orgId: string, metric: string, count: number) =>
    db.insert(S.usage).values({ orgId, period: S.currentPeriod(), metric, count }).onConflictDoUpdate({ target: [S.usage.orgId, S.usage.period, S.usage.metric], set: { count } });
  const setLimits = (orgId: string, limits: Record<string, number>) => db.update(S.organizations).set({ planLimits: { ...S.limitsFor("scale"), ...limits } }).where(S.eq(S.organizations.id, orgId));
  const leadsOf = (orgId: string) => db.select().from(S.leads).where(S.eq(S.leads.orgId, orgId));
  const candidatesOf = (playId: string) => db.select().from(S.playCandidates).where(S.eq(S.playCandidates.playId, playId)).orderBy(S.playCandidates.createdAt, S.playCandidates.id);
  const candidate = async (id: string) => (await db.select().from(S.playCandidates).where(S.eq(S.playCandidates.id, id)))[0];
  const playRow = async (id: string) => (await db.select().from(S.plays).where(S.eq(S.plays.id, id)))[0];
  const jobsOf = (orgId: string, type: string) => db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, orgId), S.eq(S.jobs.type, type)));
  const eventsOf = (orgId: string, type: string) => db.select().from(S.events).where(S.and(S.eq(S.events.orgId, orgId), S.eq(S.events.type, type)));
  const auditOf = async (orgId: string, action: string) => (await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, orgId))).filter((r: any) => r.action === action);
  const jobCtx = () => ({ db, log: () => {}, progress: async () => {} });

  // ── The fake engines ──

  const emptyTrace = () => ({ searches: 1, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [] as string[], blocked: false as boolean, blockedReason: undefined as string | undefined });
  const fake = {
    findings: [] as any[],
    trace: emptyTrace(),
    engineError: null as Error | null,
    calls: [] as { engine: string; cfg: any; opts: any }[],
    /** People returned for a company finding, by company name. */
    people: {} as Record<string, any[]>,
    peopleTrace: emptyTrace(),
    peopleError: null as Error | null,
    peopleCalls: [] as { finding: any; cfg: any; opts: any }[],
    /** Runs as a people search starts (before it answers). */
    onPeopleSearch: null as null | (() => void),
    plan: null as any,
    planError: null as Error | null,
    planCalls: [] as any[],
    post: { people: [] as any[], publicPage: false as boolean, refused: undefined as string | undefined },
    postCalls: [] as string[],
  };
  function resetFake() {
    fake.findings = [];
    fake.trace = emptyTrace();
    fake.engineError = null;
    fake.calls = [];
    fake.people = {};
    fake.peopleTrace = emptyTrace();
    fake.peopleError = null;
    fake.peopleCalls = [];
    fake.onPeopleSearch = null;
    fake.plan = null;
    fake.planError = null;
    fake.planCalls = [];
    fake.post = { people: [], publicPage: false, refused: undefined };
    fake.postCalls = [];
  }
  const engine = (name: string) => async (cfg: any, opts: any) => {
    fake.calls.push({ engine: name, cfg, opts });
    if (fake.engineError) throw fake.engineError;
    return { findings: fake.findings, trace: fake.trace };
  };
  /** The documented key rule, written here so the tests do not depend on core's. */
  const keyOf = (f: any): string => {
    const slug = f.linkedinUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
    if (slug) return `li:${slug}`.toLowerCase();
    if (f.email) return `em:${f.email}`.toLowerCase();
    if (f.kind === "person" && f.fullName && (f.companyDomain || f.companyName)) return `${f.fullName}@${f.companyDomain ?? f.companyName}`.toLowerCase();
    if (f.companyDomain) return String(f.companyDomain).toLowerCase();
    if (f.kind === "company" && f.companyName) return `co:${f.companyName}`.toLowerCase();
    return String(f.evidenceUrl ?? "").toLowerCase();
  };
  const fakeEngines = () => ({
    findCompetitorCustomers: engine("competitor_customers"),
    findHiringCompanies: engine("hiring_role"),
    findFundedCompanies: engine("funding"),
    findPublicAsks: engine("public_asks"),
    findPeopleForFinding: async (finding: any, cfg: any, opts: any) => {
      fake.peopleCalls.push({ finding, cfg, opts });
      fake.onPeopleSearch?.();
      if (fake.peopleError) throw fake.peopleError;
      return { people: (fake.people[finding.companyName] ?? []).slice(0, cfg.limit ?? 3), trace: fake.peopleTrace };
    },
    engagersFromRows: (list: any[], ctx: any) => {
      const findings: any[] = [];
      const rejected: { row: number; reason: string }[] = [];
      list.forEach((r, i) => {
        const name = r.fullName ?? [r.firstName, r.lastName].filter(Boolean).join(" ");
        if (!(r.linkedinUrl || r.email || (name && (r.companyName || r.companyDomain)))) return rejected.push({ row: i, reason: "Needs a profile link, an email or a name with a company." });
        findings.push({ kind: "person", ...r, fullName: name || undefined, relevantBecause: ctx.engagement === "commented" ? `Commented on the post "${ctx.postTitle ?? "your post"}".` : `Engaged with a post by ${ctx.postAuthor ?? "you"}.`, evidenceUrl: ctx.postUrl, evidenceTitle: ctx.postTitle, signalType: "post_engagement", signalAt: ctx.when, confidence: 0.6 });
      });
      return { findings, rejected };
    },
    planPlays: async (input: any, opts: any) => {
      fake.planCalls.push({ input, opts });
      if (fake.planError) throw fake.planError;
      return fake.plan;
    },
    playDedupeKey: keyOf,
    // Identity on purpose: what reaches a lead must be made mail-safe by the API itself.
    mailSafeReason: (t: string) => t,
    linkedinPostEngagers: async (url: string) => {
      fake.postCalls.push(url);
      return fake.post;
    },
  });

  const company = (name: string, over: Record<string, unknown> = {}) => ({
    kind: "company",
    companyName: name,
    relevantBecause: `Named as a customer of Acme in their case study "How ${name} cut onboarding time".`,
    evidenceUrl: `https://acme.example/customers/${name.toLowerCase().replace(/\W+/g, "-")}`,
    evidenceTitle: `How ${name} cut onboarding time`,
    evidenceQuote: `${name} cut onboarding time by half`,
    signalType: "competitor_customer",
    confidence: 0.8,
    ...over,
  });
  const person = (slug: string, over: Record<string, unknown> = {}) => ({
    kind: "person",
    fullName: `Pat ${slug}`,
    title: "Head of Sales",
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    companyName: "Globex",
    relevantBecause: "Hiring a Sales Development Representative - open posting on Greenhouse.",
    evidenceUrl: "https://boards.greenhouse.io/globex/jobs/1",
    evidenceTitle: "Sales Development Representative",
    signalType: "job_posting",
    confidence: 0.8,
    ...over,
  });
  const post = (id: string, over: Record<string, unknown> = {}) => ({
    kind: "post",
    title: "Which tool do you use for outbound?",
    relevantBecause: "Reddit thread asking which tool to use for outbound.",
    evidenceUrl: `https://www.reddit.com/r/sales/comments/${id}`,
    evidenceTitle: "Which tool do you use for outbound?",
    evidenceQuote: "Looking for an alternative to Acme",
    signalType: "public_ask",
    confidence: 0.7,
    ...over,
  });

  const COMPETITORS = { competitors: [{ name: "Acme", domain: "acme.example" }] };
  async function mkPlay(o: Org, body: Record<string, unknown> = {}) {
    const r = await req("POST", "/v1/plays", o.token, { name: "Acme customers", type: "competitor_customers", config: COMPETITORS, ...body });
    expect(r.status, r.text).toBe(201);
    return r.body.play as any;
  }
  /** Press Run, then do the job the route queued. Returns the finished run row. */
  async function run(o: Org, playId: string) {
    const r = await req("POST", `/v1/plays/${playId}/run`, o.token, {});
    expect(r.status, r.text).toBe(202);
    await S.runJobById(db, handlers, r.body.jobId);
    const [row] = await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, r.body.runId));
    return { run: row, jobId: r.body.jobId as string };
  }
  /** A play with these findings waiting in its queue. */
  async function queued(o: Org, findings: any[], body: Record<string, unknown> = {}) {
    const play = await mkPlay(o, body);
    fake.findings = findings;
    const { run: r } = await run(o, play.id);
    expect(r.status).toBe("done");
    return { play, candidates: await candidatesOf(play.id) };
  }
  const decide = (o: Org | string, decisions: any[], extra: Record<string, unknown> = {}) => req("POST", "/v1/plays/candidates/decide", typeof o === "string" ? o : o.token, { decisions, ...extra });
  const approve = (o: Org, ids: string[], extra: Record<string, unknown> = {}) => decide(o, ids.map((id) => ({ id, decision: "approve" })), extra);

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
      throw new Error("plays.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    core = await import("@prospex/core");
    engines = await import("./services/playEngines.js");
    svc = await import("./services/plays.js");
    ({ handlers } = await import("./jobs.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
    restoreEngines = engines.setPlayEngines(fakeEngines() as any);
  }, 120_000);

  afterEach(() => {
    resetFake();
    mail.sent.length = 0;
    delete process.env.ROW_CAP_PLAYS;
    delete process.env.APOLLO_API_KEY;
    vi.restoreAllMocks();
    // restoreAllMocks does not undo stubGlobal; the engines stay replaced for the whole file.
  });

  afterAll(() => {
    restoreEngines();
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. The catalogue ───────────────────────────────────────────────────────────────
  describe("play types", () => {
    it("lists the seven types with their fields, and says plainly which cannot work here yet", async () => {
      const o = await signup("types");
      const r = await req("GET", "/v1/plays/types", o.token);
      expect(r.status).toBe(200);
      const byType = Object.fromEntries(r.body.types.map((t: any) => [t.type, t]));
      expect(Object.keys(byType).sort()).toEqual([...S.PLAY_TYPES].sort());
      // No pixel, no contact data provider: those two say why, in words.
      expect(byType.website_visitors).toMatchObject({ available: false, finds: "companies" });
      expect(byType.website_visitors.unavailableReason).toMatch(/tracking pixel/);
      expect(byType.job_changes.available).toBe(false);
      expect(byType.job_changes.unavailableReason).toMatch(/contact data provider/);
      // A search-based type is still offered with no search source connected - with a hint.
      expect(byType.competitor_customers).toMatchObject({ available: true, needsSearch: true });
      expect(byType.competitor_customers.setupHint).toMatch(/public search/);
      expect(byType.funding.setupHint).toBeUndefined();
      expect(byType.competitor_customers.fields.find((f: any) => f.key === "competitors")).toMatchObject({ kind: "competitors", required: true, max: 10 });
      expect(byType.hiring_role.defaultTitles.length).toBeGreaterThan(0);
      // Nothing a customer reads names a server setting.
      expect(r.text).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);

      await db.insert(S.pixels).values({ orgId: o.orgId, key: `k-${u8()}`, name: "Site" });
      process.env.APOLLO_API_KEY = "apollo-test-key-not-real";
      const again = await req("GET", "/v1/plays/types", o.token);
      const now = Object.fromEntries(again.body.types.map((t: any) => [t.type, t]));
      expect(now.website_visitors).toMatchObject({ available: true });
      expect(now.website_visitors.unavailableReason).toBeUndefined();
      expect(now.job_changes.available).toBe(true);
    });
  });

  // ── 2. CRUD and validation ─────────────────────────────────────────────────────────
  describe("creating, editing and deleting plays", () => {
    it("creates a play of each type with its settings validated, unknown keys dropped and defaults applied", async () => {
      const o = await signup("crud");
      const good: Record<string, any> = {
        competitor_customers: { competitors: [{ name: "  Acme  ", domain: "https://www.Acme.example/customers" }, { name: "Initech", domain: "" }], maxPerCompetitor: 20, junk: "x" },
        hiring_role: { roles: ["Sales Development Representative"], keywords: ["saas"], companyDomains: ["globex.example"] },
        funding: { industries: ["fintech"], country: "us" },
        public_asks: { competitors: ["Acme"], sources: ["reddit", "linkedin"] },
        website_visitors: {},
        job_changes: {},
        engagers_upload: { anything: 1 },
      };
      const made: Record<string, any> = {};
      for (const type of S.PLAY_TYPES) {
        const r = await req("POST", "/v1/plays", o.token, { name: `P ${type}`, type, config: good[type], targetTitles: ["Head of Sales"] });
        expect(r.status, `${type}: ${r.text}`).toBe(201);
        made[type] = r.body.play;
        expect(r.body.play).toMatchObject({ type, status: "active", autoApprove: false, minScore: 0, runEveryHours: null, lastRunAt: null, lastResult: null, counts: { pending: 0, approved: 0, skipped: 0 } });
      }
      expect(made.competitor_customers.config).toEqual({ competitors: [{ name: "Acme", domain: "acme.example" }, { name: "Initech" }], maxPerCompetitor: 20 });
      expect(made.funding.config).toEqual({ industries: ["fintech"], days: 14, country: "US" });
      expect(made.website_visitors.config).toEqual({ minIntentScore: 30, days: 14 });
      expect(made.job_changes.config).toEqual({ days: 30 });
      expect(made.engagers_upload.config).toEqual({});
      expect((await auditOf(o.orgId, "play.created")).length).toBe(S.PLAY_TYPES.length);

      const list = await req("GET", "/v1/plays", o.token);
      expect(list.status).toBe(200);
      expect(list.body.plays.map((p: any) => p.type).sort()).toEqual([...S.PLAY_TYPES].sort());
      const one = await req("GET", `/v1/plays/${made.funding.id}`, o.token);
      expect(one.body.play.id).toBe(made.funding.id);
      expect(one.body.runs).toEqual([]);
      expect((await req("GET", `/v1/plays/${made.funding.id}/runs`, o.token)).body).toEqual({ runs: [] });
    });

    it("refuses settings that are missing, oversized or not what the type takes - with a sentence naming the field", async () => {
      const o = await signup("crud-bad");
      const bad: [string, Record<string, unknown>, RegExp?][] = [
        ["no competitors", { type: "competitor_customers", config: { competitors: [] } }, /competitors/i],
        ["a competitor website that is an internal address", { type: "competitor_customers", config: { competitors: [{ name: "X", domain: "127.0.0.1" }] } }, /public domain/],
        ["a competitor website that is an internal name", { type: "competitor_customers", config: { competitors: [{ name: "X", domain: "http://localhost:8080" }] } }, /public domain/],
        ["eleven competitors", { type: "competitor_customers", config: { competitors: Array.from({ length: 11 }, (_, i) => ({ name: `C${i}` })) } }],
        ["a competitor name of 121 characters", { type: "competitor_customers", config: { competitors: [{ name: "x".repeat(121) }] } }],
        ["no roles", { type: "hiring_role", config: { roles: [] } }, /roles/i],
        ["eleven roles", { type: "hiring_role", config: { roles: Array.from({ length: 11 }, (_, i) => `Role ${i}`) } }],
        ["51 company domains", { type: "hiring_role", config: { roles: ["SDR"], companyDomains: Array.from({ length: 51 }, (_, i) => `c${i}.example`) } }],
        ["funding over 60 days", { type: "funding", config: { days: 61 } }],
        ["asks with nothing to look for", { type: "public_asks", config: {} }, /at least one competitor, problem or category/],
        ["asks with an unknown source", { type: "public_asks", config: { category: "crm", sources: ["facebook"] } }],
        ["a problem of 161 characters", { type: "public_asks", config: { problems: ["p".repeat(161)] } }],
        ["visitors over 90 days", { type: "website_visitors", config: { days: 91 } }],
        ["an unknown type", { type: "linkedin_automation", config: {} }],
        ["a name of 121 characters", { name: "n".repeat(121) }],
        ["an empty name", { name: "   " }],
        ["21 target titles", { targetTitles: Array.from({ length: 21 }, (_, i) => `T${i}`) }],
        ["a title of 101 characters", { targetTitles: ["t".repeat(101)] }],
        ["a schedule under 6 hours", { runEveryHours: 3 }],
        ["a schedule over 30 days", { runEveryHours: 721 }],
        ["a score over 100", { minScore: 101 }],
        ["a status that does not exist", { status: "deleted" }],
        ["an id that is not an id", { icpId: "abc" }],
      ];
      for (const [what, patch, message] of bad) {
        const r = await req("POST", "/v1/plays", o.token, { name: "P", type: "competitor_customers", config: COMPETITORS, ...patch });
        expect([what, r.status, r.body?.error?.code]).toEqual([what, 400, "validation_error"]);
        if (message) expect(r.body.error.message, what).toMatch(message);
      }
      expect((await db.select().from(S.plays).where(S.eq(S.plays.orgId, o.orgId))).length).toBe(0);
    });

    it("edits a play, re-validating its settings against its own type, and refuses an empty edit or a change of type", async () => {
      const o = await signup("crud-edit");
      const play = await mkPlay(o);
      expect((await req("PATCH", `/v1/plays/${play.id}`, o.token, {})).body.error.code).toBe("nothing_to_update");
      const renamed = await req("PATCH", `/v1/plays/${play.id}`, o.token, { name: "Renamed", status: "paused", autoApprove: true, minScore: 70, targetTitles: ["CEO"], runEveryHours: 24 });
      expect(renamed.status).toBe(200);
      expect(renamed.body.play).toMatchObject({ name: "Renamed", status: "paused", autoApprove: true, minScore: 70, targetTitles: ["CEO"], runEveryHours: 24 });
      expect(renamed.body.play.nextRunAt).toBeTruthy();
      expect((await auditOf(o.orgId, "play.auto_approve_changed")).length).toBe(1);
      const manual = await req("PATCH", `/v1/plays/${play.id}`, o.token, { runEveryHours: null });
      expect(manual.body.play).toMatchObject({ runEveryHours: null, nextRunAt: null });

      // `config` replaces the whole config: what is left out is gone, not merged in.
      await req("PATCH", `/v1/plays/${play.id}`, o.token, { config: { competitors: [{ name: "Acme" }], maxPerCompetitor: 5 } });
      const cfg = await req("PATCH", `/v1/plays/${play.id}`, o.token, { config: { competitors: [{ name: "Initech" }], extra: true } });
      expect(cfg.body.play.config).toEqual({ competitors: [{ name: "Initech" }] });

      // null clears a reference; leaving it out leaves it alone.
      const [icp] = await db.insert(S.icps).values({ orgId: o.orgId, name: "ICP", criteria: {} }).returning();
      const [list] = await db.insert(S.lists).values({ orgId: o.orgId, name: "List" }).returning();
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Campaign" }).returning();
      const [client] = await db.insert(S.clients).values({ orgId: o.orgId, name: "Client" }).returning();
      const linked = await req("PATCH", `/v1/plays/${play.id}`, o.token, { icpId: icp.id, listId: list.id, campaignId: campaign.id, clientId: client.id });
      expect(linked.body.play).toMatchObject({ icpId: icp.id, listId: list.id, campaignId: campaign.id, clientId: client.id });
      expect((await req("PATCH", `/v1/plays/${play.id}`, o.token, { name: "Same links" })).body.play).toMatchObject({ icpId: icp.id, campaignId: campaign.id });
      const cleared = await req("PATCH", `/v1/plays/${play.id}`, o.token, { icpId: null, listId: null, campaignId: null, clientId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.play).toMatchObject({ icpId: null, listId: null, campaignId: null, clientId: null, name: "Same links" });
      const badCfg = await req("PATCH", `/v1/plays/${play.id}`, o.token, { config: { roles: ["SDR"] } });
      expect([badCfg.status, badCfg.body.error.code]).toEqual([400, "validation_error"]);
      expect(badCfg.body.error.message).toMatch(/competitors/i);
      const retype = await req("PATCH", `/v1/plays/${play.id}`, o.token, { type: "funding" });
      expect(retype.status).toBe(400);
      expect(retype.body.error.message).toMatch(/type cannot be changed/);
      expect((await playRow(play.id)).config).toEqual({ competitors: [{ name: "Initech" }] });

      // Malformed and unknown ids: a 400 that says nothing about the database, and a 404.
      const malformed = await req("GET", "/v1/plays/not-a-uuid", o.token);
      expect([malformed.status, malformed.body.error.code]).toEqual([400, "bad_request"]);
      expect((await req("GET", `/v1/plays/${randomUUID()}`, o.token)).status).toBe(404);
      expect((await req("PATCH", `/v1/plays/${randomUUID()}`, o.token, { name: "x" })).status).toBe(404);
      expect((await req("DELETE", `/v1/plays/${randomUUID()}`, o.token)).status).toBe(404);
    });

    it("deleting a play removes what is waiting in it and keeps the leads it created", async () => {
      const o = await signup("crud-del");
      const { play, candidates } = await queued(o, [person(`del-a-${u8()}`), person(`del-b-${u8()}`)]);
      const ok = await approve(o, [candidates[0].id]);
      expect(ok.body.leadsCreated).toBe(1);
      const gone = await req("DELETE", `/v1/plays/${play.id}`, o.token);
      expect(gone.body).toEqual({ ok: true });
      expect(await candidatesOf(play.id)).toEqual([]);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, play.id))).length).toBe(0);
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect((await auditOf(o.orgId, "play.deleted")).length).toBe(1);
    });

    it("holds the per-workspace ceiling on plays", async () => {
      const o = await signup("crud-cap");
      process.env.ROW_CAP_PLAYS = "1";
      await mkPlay(o);
      const second = await req("POST", "/v1/plays", o.token, { name: "Two", type: "funding", config: {} });
      expect([second.status, second.body.error.code]).toEqual([403, "limit_reached"]);
      expect(second.body.error.message).toMatch(/plays/);
    });

    it("an upload play has no schedule and cannot be run", async () => {
      const o = await signup("crud-upload");
      const play = await mkPlay(o, { type: "engagers_upload", config: {}, runEveryHours: 24 });
      expect(play).toMatchObject({ runEveryHours: null, nextRunAt: null });
      const r = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("This play is fed by uploads - add people with Upload.");
      expect(await usageOf(o.orgId, "searches")).toBe(0);
    });
  });

  // ── 3. Tenancy ─────────────────────────────────────────────────────────────────────
  describe("one workspace cannot reach another's plays or candidates", () => {
    it("B cannot read, edit, run, upload to, delete or decide anything of A's", async () => {
      const A = await signup("ten-a");
      const B = await signup("ten-b");
      const tag = `tenant-${u8()}`;
      const { play, candidates } = await queued(A, [company(`Globex ${tag}`), person(`ten-${tag}`, { email: `pat-${tag}@globex.example` }), post(tag)], { name: `A play ${tag}` });
      const upload = await mkPlay(A, { type: "engagers_upload", config: {}, name: `A upload ${tag}` });
      const before = JSON.stringify([await playRow(play.id), await candidatesOf(play.id)]);
      const [co, pe] = [candidates.find((c: any) => c.kind === "company"), candidates.find((c: any) => c.kind === "person")];

      const tries = [
        await req("GET", `/v1/plays/${play.id}`, B.token),
        await req("GET", `/v1/plays/${play.id}/runs`, B.token),
        await req("PATCH", `/v1/plays/${play.id}`, B.token, { name: "pwned", autoApprove: true }),
        await req("POST", `/v1/plays/${play.id}/run`, B.token, {}),
        await req("DELETE", `/v1/plays/${play.id}`, B.token),
        await req("POST", `/v1/plays/${upload.id}/upload`, B.token, { engagement: "commented", people: [{ email: "x@y.example" }] }),
        await req("GET", `/v1/plays/candidates?playId=${play.id}`, B.token),
        await req("POST", `/v1/plays/candidates/${co.id}/find-people`, B.token, { titles: ["CEO"] }),
      ];
      expect(tries.map((r) => r.status)).toEqual(tries.map(() => 404));
      for (const r of tries) expect(r.text).not.toContain(tag);

      // The queue, the list and the results are B's own: empty, and never A's.
      for (const path of ["/v1/plays", "/v1/plays/candidates", "/v1/plays/candidates?status=approved", "/v1/plays/performance"]) {
        const r = await req("GET", path, B.token);
        expect(r.status).toBe(200);
        expect(r.text).not.toContain(tag);
        expect(r.text).not.toContain(play.id);
      }

      // A decision naming A's candidates changes nothing and is reported as not applied.
      const d = await decide(B, [{ id: pe.id, decision: "approve" }, { id: co.id, decision: "skip", skipReason: "pwned" }], { enroll: true });
      expect(d.status).toBe(200);
      expect(d.body).toMatchObject({ approved: 0, skipped: 0, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, enrolled: 0, applied: [] });
      expect(d.body.notApplied).toEqual([
        { id: pe.id, reason: "Not found in this workspace." },
        { id: co.id, reason: "Not found in this workspace." },
      ]);
      expect((await leadsOf(B.orgId)).length).toBe(0);
      expect(await usageOf(B.orgId, "leads")).toBe(0);
      expect(JSON.stringify([await playRow(play.id), await candidatesOf(play.id)])).toBe(before);
      // Nothing was written to A's security log, and reading wrote nothing to B's either.
      expect((await auditOf(A.orgId, "reference.denied")).length).toBe(0);
    });

    it("every id in a body must be this workspace's own - on create and on edit", async () => {
      const A = await signup("ref-a");
      const B = await signup("ref-b");
      const [icp] = await db.insert(S.icps).values({ orgId: A.orgId, name: "A icp", criteria: {} }).returning();
      const [list] = await db.insert(S.lists).values({ orgId: A.orgId, name: "A list" }).returning();
      const [campaign] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "A campaign" }).returning();
      const [client] = await db.insert(S.clients).values({ orgId: A.orgId, name: "A client" }).returning();
      const mine = await mkPlay(B);
      for (const ref of [{ icpId: icp.id }, { listId: list.id }, { campaignId: campaign.id }, { clientId: client.id }]) {
        const made = await req("POST", "/v1/plays", B.token, { name: "x", type: "funding", config: {}, ...ref });
        expect([Object.keys(ref)[0], made.status]).toEqual([Object.keys(ref)[0], 404]);
        const edited = await req("PATCH", `/v1/plays/${mine.id}`, B.token, ref);
        expect([Object.keys(ref)[0], edited.status]).toEqual([Object.keys(ref)[0], 404]);
      }
      expect((await db.select().from(S.plays).where(S.eq(S.plays.orgId, B.orgId))).length).toBe(1);
      expect(await playRow(mine.id)).toMatchObject({ icpId: null, listId: null, campaignId: null, clientId: null });
      // Each refused reference is on B's own security log (never A's), without saying whose it is.
      const denied = await auditOf(B.orgId, "reference.denied");
      expect(denied.length).toBe(8);
      expect(JSON.stringify(denied)).not.toContain(A.orgId);
      expect((await auditOf(A.orgId, "reference.denied")).length).toBe(0);

      // A's own ids are accepted for A; an archived client is refused with a reason.
      const ok = await req("POST", "/v1/plays", A.token, { name: "x", type: "funding", config: {}, icpId: icp.id, listId: list.id, campaignId: campaign.id, clientId: client.id });
      expect(ok.status).toBe(201);
      await db.update(S.clients).set({ status: "archived" }).where(S.eq(S.clients.id, client.id));
      const archived = await req("POST", "/v1/plays", A.token, { name: "y", type: "funding", config: {}, clientId: client.id });
      expect(archived.status).toBe(400);
      expect(archived.body.error.message).toMatch(/archived/);
    });

    it("a queued job that names another workspace's play changes nothing", async () => {
      const A = await signup("job-a");
      const B = await signup("job-b");
      const play = await mkPlay(A);
      const [runRow] = await db.insert(S.playRuns).values({ orgId: A.orgId, playId: play.id, status: "running", trigger: "manual" }).returning();
      fake.findings = [company("Never Stored")];
      const r = await handlers["play.run"]({ id: randomUUID(), orgId: B.orgId, payload: { playId: play.id, runId: runRow.id, charged: true }, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect(r).toEqual({ skipped: "org mismatch" });
      expect(fake.calls).toEqual([]);
      expect(await candidatesOf(play.id)).toEqual([]);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, runRow.id)))[0].status).toBe("running");

      const [campaign] = await db.insert(S.campaigns).values({ orgId: A.orgId, name: "A campaign" }).returning();
      const [lead] = await db.insert(S.leads).values({ orgId: A.orgId, fullName: "A Lead", email: `a-${u8()}@example.com`, emailStatus: "valid" }).returning();
      const e = await handlers["play.enroll"]({ id: randomUUID(), orgId: B.orgId, payload: { playId: play.id, campaignId: campaign.id, leadIds: [lead.id] }, attempts: 1, maxAttempts: 3 }, jobCtx());
      expect(e).toEqual({ skipped: "org mismatch" });
      // The right org, but a campaign and a lead of another workspace: not followed either.
      const mine = await mkPlay(B);
      const cross = await handlers["play.enroll"]({ id: randomUUID(), orgId: B.orgId, payload: { playId: mine.id, campaignId: campaign.id, leadIds: [lead.id] }, attempts: 1, maxAttempts: 3 }, jobCtx());
      expect(cross).toEqual({ skipped: "campaign missing" });
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.campaignId, campaign.id))).length).toBe(0);
    });
  });

  // ── 4. Running a play ──────────────────────────────────────────────────────────────
  describe("a run puts what it found in the review queue, with the reason and the proof", () => {
    it("stores candidates with their reason and evidence, charges one search, and creates no lead", async () => {
      const o = await signup("run");
      const play = await mkPlay(o);
      const tag = u8();
      fake.findings = [company(`Globex ${tag}`), company(`Initech ${tag}`, { companyDomain: "initech.example" }), post(tag), person(`run-${tag}`, { email: `Pat.${tag}@Globex.example` })];
      const { run: r, jobId } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", trigger: "manual", found: 4, added: 4, duplicates: 0, error: null });
      // The job row holds ids and numbers only - never the play's settings or the run's note.
      const [job] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, jobId));
      expect(job).toMatchObject({ status: "done", orgId: o.orgId, maxAttempts: 1, payload: { playId: play.id, runId: r.id, charged: true } });
      expect(job.result).toEqual({ runId: r.id, status: "done", found: 4, added: 4, duplicates: 0 });
      expect(r.note).toMatch(/^Found 4: 4 new\./);
      expect(r.finishedAt).toBeTruthy();
      // The engine got this play's validated settings, a deadline about four minutes out, and no AI (none is configured).
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({ engine: "competitor_customers", cfg: COMPETITORS });
      expect(fake.calls[0].opts.ai).toBeUndefined();
      expect(fake.calls[0].opts.beforeAiCall).toBeUndefined();
      expect(fake.calls[0].opts.deadlineAt - Date.now()).toBeGreaterThan(3 * 60_000);
      expect(fake.calls[0].opts.deadlineAt - Date.now()).toBeLessThanOrEqual(4 * 60_000);

      const list = await req("GET", `/v1/plays/candidates?playId=${play.id}`, o.token);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ total: 4, counts: { pending: 4, approved: 0, skipped: 0 } });
      const co = list.body.candidates.find((c: any) => c.companyName === `Globex ${tag}`);
      expect(co).toMatchObject({
        playId: play.id,
        playName: "Acme customers",
        playType: "competitor_customers",
        kind: "company",
        status: "pending",
        relevantBecause: `Named as a customer of Acme in their case study "How Globex ${tag} cut onboarding time".`,
        evidenceTitle: `How Globex ${tag} cut onboarding time`,
        evidenceQuote: `Globex ${tag} cut onboarding time by half`,
        signalType: "competitor_customer",
        leadId: null,
        alreadyLead: false,
        decidedAt: null,
        score: null,
        scoreReasons: [],
      });
      expect(co.evidenceUrl).toMatch(/^https:\/\/acme\.example\/customers\//);
      const pe = list.body.candidates.find((c: any) => c.kind === "person");
      expect(pe).toMatchObject({ fullName: `Pat run-${tag}`, email: `pat.${tag}@globex.example`, emailStatus: "unknown", linkedinUrl: `https://www.linkedin.com/in/run-${tag}` });
      expect(list.body.candidates.find((c: any) => c.kind === "post")).toMatchObject({ fullName: null, email: null, companyName: null, title: "Which tool do you use for outbound?" });
      expect((await req("GET", `/v1/plays/candidates?playId=${play.id}&kind=post`, o.token)).body).toMatchObject({ total: 1, counts: { pending: 1 } });
      expect((await req("GET", `/v1/plays/candidates?playId=${play.id}&limit=2&offset=2`, o.token)).body.candidates).toHaveLength(2);

      // Nobody became a lead, and exactly one search was charged.
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      const after = await req("GET", `/v1/plays/${play.id}`, o.token);
      expect(after.body.play).toMatchObject({ counts: { pending: 4, approved: 0, skipped: 0 }, lastResult: { status: "done", found: 4, added: 4, duplicates: 0 }, nextRunAt: null });
      expect(after.body.play.lastRunAt).toBeTruthy();
      expect(after.body.runs).toHaveLength(1);
      expect((await eventsOf(o.orgId, "play.ran"))[0].data).toMatchObject({ playId: play.id, status: "done", found: 4, added: 4 });
    });

    it("the same person or company found again by the play is one candidate", async () => {
      const o = await signup("dedupe");
      const play = await mkPlay(o);
      const tag = u8();
      const first = [company(`Globex ${tag}`), person(`dd-${tag}`)];
      fake.findings = [...first, company(`Globex ${tag}`)]; // twice in one run, too
      expect((await run(o, play.id)).run).toMatchObject({ found: 3, added: 2, duplicates: 1 });
      fake.findings = [...first, company(`Hooli ${tag}`)];
      const second = (await run(o, play.id)).run;
      expect(second).toMatchObject({ status: "done", found: 3, added: 1, duplicates: 2 });
      expect(second.note).toMatch(/1 new, 2 already seen/);
      expect((await candidatesOf(play.id)).length).toBe(3);
      // A decided candidate is not offered again either.
      const all = await candidatesOf(play.id);
      await decide(o, [{ id: all[0].id, decision: "skip" }]);
      fake.findings = first;
      expect((await run(o, play.id)).run).toMatchObject({ added: 0, duplicates: 2 });
      // Another play of the same workspace keeps its own queue.
      const other = await mkPlay(o, { name: "Other" });
      fake.findings = first;
      expect((await run(o, other.id)).run).toMatchObject({ added: 2, duplicates: 0 });
    });

    it("marks someone who is already a lead, and links the lead", async () => {
      const o = await signup("already");
      const tag = u8();
      const [byEmail] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "Known Byemail", email: `known-${tag}@globex.example`, tags: ["mine"], custom: { note: "keep" } }).returning();
      const [byProfile] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "Known Byprofile", linkedinUrl: `www.linkedin.com/in/known-${tag}` }).returning();
      const other = await signup("already-other");
      await db.insert(S.leads).values({ orgId: other.orgId, fullName: "Someone Else's", email: `stranger-${tag}@globex.example` });
      const { candidates } = await queued(o, [
        person(`x-${tag}`, { email: `KNOWN-${tag}@globex.example` }),
        person(`known-${tag}`),
        person(`y-${tag}`, { email: `stranger-${tag}@globex.example` }),
      ]);
      const by = (slug: string) => candidates.find((c: any) => c.linkedinUrl.endsWith(slug));
      expect(by(`x-${tag}`)).toMatchObject({ alreadyLead: true, leadId: byEmail.id });
      expect(by(`known-${tag}`)).toMatchObject({ alreadyLead: true, leadId: byProfile.id });
      // Another workspace's lead with that address means nothing here.
      expect(by(`y-${tag}`)).toMatchObject({ alreadyLead: false, leadId: null });

      const r = await approve(o, [by(`x-${tag}`).id]);
      expect(r.body).toMatchObject({ approved: 1, leadsCreated: 0, leadsExisting: 1, notApplied: [] });
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      const [lead] = await db.select().from(S.leads).where(S.eq(S.leads.id, byEmail.id));
      // Merged, never replaced: what the workspace had stays.
      expect(lead.tags).toEqual(expect.arrayContaining(["mine", "play"]));
      expect(lead.custom).toMatchObject({ note: "keep", relevant_because: expect.any(String) });
      expect(lead.fullName).toBe("Known Byemail");
      expect(lead.source).toBe("manual");
    });

    it("refuses a second run while one is going, and a run with no searches left - leaving nothing behind", async () => {
      const o = await signup("busy");
      const play = await mkPlay(o);
      const [going] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "manual" }).returning();
      const busy = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      expect([busy.status, busy.body.error.code]).toEqual([409, "already_running"]);
      // The answer names the run that is going, and the play says it is running - in the list and on its own.
      expect(busy.body.error.details).toEqual({ runId: going.id });
      expect((await req("GET", `/v1/plays/${play.id}`, o.token)).body.play.running).toBe(true);
      const idle = await mkPlay(o, { name: "Idle" });
      expect(idle.running).toBe(false);
      expect(Object.fromEntries((await req("GET", "/v1/plays", o.token)).body.plays.map((p: any) => [p.id, p.running]))).toEqual({ [play.id]: true, [idle.id]: false });
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      // A run that has been "running" for over fifteen minutes no longer blocks.
      await q`UPDATE play_runs SET started_at = now() - interval '16 minutes' WHERE id = ${going.id}`;
      expect((await req("GET", `/v1/plays/${play.id}`, o.token)).body.play.running).toBe(false);
      const next = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      expect(next.status).toBe(202);
      // Queued and not yet picked up by a worker: it is running as far as anyone looking is concerned.
      expect((await req("PATCH", `/v1/plays/${play.id}`, o.token, { name: "Still going" })).body.play.running).toBe(true);
      const again = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      expect([again.status, again.body.error.details]).toEqual([409, { runId: next.body.runId }]);

      const p = await signup("no-searches");
      const play2 = await mkPlay(p);
      await setLimits(p.orgId, { searchesPerMonth: 1 });
      await setUsage(p.orgId, "searches", 1);
      const over = await req("POST", `/v1/plays/${play2.id}/run`, p.token, {});
      expect([over.status, over.body.error.code]).toEqual([402, "quota_exceeded"]);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, play2.id))).length).toBe(0);
      expect((await jobsOf(p.orgId, "play.run")).length).toBe(0);
      expect(await usageOf(p.orgId, "searches")).toBe(1);
    });

    it("where there is no worker (inline mode), Run does the run before it answers", async () => {
      const { env } = await import("./env.js");
      const o = await signup("inline");
      const play = await mkPlay(o);
      fake.findings = [company(`Inline ${u8()}`)];
      const was = env.jobMode;
      (env as any).jobMode = "inline";
      try {
        const r = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
        expect(r.status).toBe(200);
        expect(r.body.run).toMatchObject({ id: r.body.runId, status: "done", found: 1, added: 1 });
        expect((await candidatesOf(play.id)).length).toBe(1);
        // Inside a request the engine is given well under a minute, not four.
        expect(fake.calls[0].opts.deadlineAt - Date.now()).toBeLessThanOrEqual(40_000);
      } finally {
        (env as any).jobMode = was;
      }
    });

    it("cleans what an engine hands over: no control characters, bounded fields, http(s) links only, one address", async () => {
      const o = await signup("clean");
      const tag = u8();
      const { candidates } = await queued(o, [
        person(`clean-${tag}`, {
          fullName: `Evil\u0000 ‮Name\n${"n".repeat(400)}`,
          email: "Name <a@b.example>, c@d.example",
          relevantBecause: `Line one\nline two\t${"r".repeat(500)}`,
          evidenceUrl: "javascript:alert(1)",
          evidenceQuote: "q".repeat(900),
          signalType: "Job Posting <script>",
          confidence: 7,
          signalAt: new Date("not a date"),
        }),
        // Not candidates at all: no reason; a conversation with no page; a person nobody could identify; a company with no name.
        person(`noreason-${tag}`, { relevantBecause: "   " }),
        post(tag, { evidenceUrl: "ftp://example.com/thread" }),
        { kind: "person", fullName: "Only A Name", relevantBecause: "Reacted to a post.", signalType: "post_engagement", confidence: 0.5 },
        { kind: "company", relevantBecause: "Raised money.", signalType: "funding", confidence: 0.5 },
        { kind: "robot", companyName: "X", relevantBecause: "?", signalType: "x", confidence: 1 },
      ]);
      expect(candidates).toHaveLength(1);
      const c = candidates[0];
      expect(c.fullName).not.toMatch(/[\u0000-\u001f‮]/);
      expect(c.fullName.length).toBeLessThanOrEqual(200);
      expect(c.email).toBeNull();
      expect(c.relevantBecause).not.toMatch(/[\n\t]/);
      expect(c.relevantBecause.length).toBeLessThanOrEqual(300);
      expect(c.evidenceUrl).toBeNull();
      expect(c.evidenceQuote.length).toBe(500);
      expect(c.signalType).toBe("other");
      expect(c.confidence).toBe(1);
      expect(c.signalAt).toBeNull();
      const [r] = await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, c.playId));
      expect(r).toMatchObject({ found: 6, added: 1 });
      expect(r.note).toMatch(/5 results were left out for lack of a reason or a way to identify them/);
    });
  });

  // ── 5. Finding people at the companies a play surfaces ─────────────────────────────
  describe("people at the companies found", () => {
    it("turns company findings into people who carry the company's reason and proof - for at most 15 companies a run", async () => {
      const o = await signup("people");
      const tag = u8();
      const play = await mkPlay(o, { targetTitles: ["Head of Sales", "VP Sales"] });
      const names = Array.from({ length: 17 }, (_, i) => `Co${i} ${tag}`);
      fake.findings = names.map((n) => company(n));
      for (const n of names.slice(0, 16)) fake.people[n] = [{ kind: "person", fullName: `Lee at ${n}`, title: "Head of Sales", linkedinUrl: `https://www.linkedin.com/in/lee-${n.replace(/\W+/g, "-").toLowerCase()}`, relevantBecause: "INVENTED by the people search", evidenceUrl: "https://elsewhere.example/", signalType: "x", confidence: 0.99 }];
      fake.people[names[3]] = []; // nobody found here
      const { run: r } = await run(o, play.id);
      expect(fake.peopleCalls).toHaveLength(15);
      expect(fake.peopleCalls[0].cfg).toEqual({ titles: ["Head of Sales", "VP Sales"], limit: 3 });
      const all = await candidatesOf(play.id);
      const people = all.filter((c: any) => c.kind === "person");
      const companies = all.filter((c: any) => c.kind === "company");
      // 15 searched: 14 gave a person, one gave nobody and stays a company; the last two were not searched and stay companies.
      expect(people).toHaveLength(14);
      expect(companies.map((c: any) => c.companyName).sort()).toEqual([names[3], names[15], names[16]].sort());
      expect(r).toMatchObject({ status: "done", found: 17, added: 17 });
      expect(r.note).toContain("People were looked for at the first 15 new companies. The other 2 are listed as companies - press Find people on any of them.");
      const p0 = people.find((c: any) => c.fullName === `Lee at ${names[0]}`);
      // The reason and the proof are the company's - never something the people search made up.
      expect(p0).toMatchObject({
        companyName: names[0],
        relevantBecause: `Named as a customer of Acme in their case study "How ${names[0]} cut onboarding time".`,
        evidenceTitle: `How ${names[0]} cut onboarding time`,
        signalType: "competitor_customer",
        confidence: expect.closeTo(0.8, 5),
      });
      expect(p0.evidenceUrl).toMatch(/^https:\/\/acme\.example\/customers\//);

      // The next run does not search the same companies again: those with people are counted
      // as already seen, those waiting as companies are duplicates.
      fake.peopleCalls = [];
      const again = (await run(o, play.id)).run;
      expect(fake.peopleCalls).toHaveLength(0);
      expect(again).toMatchObject({ found: 17, added: 0, duplicates: 17 });
      expect((await candidatesOf(play.id)).length).toBe(17);
    });

    it("keeps part of the run's time for the people, stops looking when the time is up, and says how far it got", async () => {
      const o = await signup("people-time");
      const tag = u8();
      const play = await mkPlay(o, { targetTitles: ["CEO"] });
      const names = [`Aco ${tag}`, `Bco ${tag}`, `Cco ${tag}`, `Dco ${tag}`, `Eco ${tag}`];
      fake.findings = names.map((n) => company(n));
      for (const n of names) fake.people[n] = [{ kind: "person", fullName: `Lee at ${n}`, linkedinUrl: `https://www.linkedin.com/in/lee-${n.replace(/\W+/g, "-").toLowerCase()}`, relevantBecause: "x", signalType: "x", confidence: 0.9 }];
      // The first people search uses up the clock: when it starts, five minutes have gone by.
      const realNow = Date.now.bind(Date);
      fake.onPeopleSearch = () => void vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 60_000);
      const started = realNow();
      const { run: r } = await run(o, play.id);
      vi.restoreAllMocks();
      // The source engine was given about 60% of the four minutes; the people search the whole of it.
      const engineBudget = fake.calls[0].opts.deadlineAt - started;
      expect(engineBudget).toBeGreaterThan(2 * 60_000);
      expect(engineBudget).toBeLessThanOrEqual(0.6 * 4 * 60_000 + 2_000);
      const peopleBudget = fake.peopleCalls[0].opts.deadlineAt - started;
      expect(peopleBudget).toBeGreaterThan(3.5 * 60_000);
      expect(peopleBudget).toBeLessThanOrEqual(4 * 60_000 + 2_000);
      // One company was searched; nothing was started after the deadline, and nothing was lost.
      expect(fake.peopleCalls).toHaveLength(1);
      expect(r).toMatchObject({ status: "done", found: 5, added: 5 });
      expect(r.note).toContain("The run reached its time limit, so people were looked for at 1 of 5 companies. The other 4 are listed as companies - press Find people on any of them.");
      const all = await candidatesOf(play.id);
      expect(all.filter((c: any) => c.kind === "person").map((c: any) => c.fullName)).toEqual([`Lee at ${names[0]}`]);
      expect(all.filter((c: any) => c.kind === "company").map((c: any) => c.companyName).sort()).toEqual(names.slice(1).sort());
    });

    it("a people search that breaks leaves the company in the queue and says so", async () => {
      const o = await signup("people-fail");
      const play = await mkPlay(o, { targetTitles: ["CEO"] });
      fake.findings = [company(`Solo ${u8()}`)];
      fake.peopleError = new Error("search provider exploded");
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 1, added: 1 });
      expect(r.note).toMatch(/people search could not run for 1 company/);
      expect((await candidatesOf(play.id))[0].kind).toBe("company");
    });

    it("Find people on a company candidate adds its people to the same play, for one search", async () => {
      const o = await signup("find");
      const tag = u8();
      const name = `Globex ${tag}`;
      const { play, candidates } = await queued(o, [company(name), person(`fp-${tag}`)]);
      const co = candidates.find((c: any) => c.kind === "company");
      const pe = candidates.find((c: any) => c.kind === "person");
      const searchesBefore = await usageOf(o.orgId, "searches");

      expect((await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, {})).body.error.message).toBe("Say which job titles to look for.");
      expect((await req("POST", `/v1/plays/candidates/${pe.id}/find-people`, o.token, { titles: ["CEO"] })).body.error.message).toBe("People can only be looked up for a company.");
      expect((await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CEO"], limit: 6 })).status).toBe(400);
      expect((await req("POST", `/v1/plays/candidates/${randomUUID()}/find-people`, o.token, { titles: ["CEO"] })).status).toBe(404);
      expect(await usageOf(o.orgId, "searches")).toBe(searchesBefore);

      fake.people[name] = [
        { kind: "person", fullName: "Ann One", title: "CEO", linkedinUrl: `https://www.linkedin.com/in/ann-${tag}`, relevantBecause: "x", signalType: "x", confidence: 0.6 },
        { kind: "person", fullName: "Bob Two", title: "CEO", linkedinUrl: `https://www.linkedin.com/in/bob-${tag}`, relevantBecause: "x", signalType: "x", confidence: 0.9 },
        { kind: "person", fullName: "Cy Three", title: "CEO", linkedinUrl: `https://www.linkedin.com/in/cy-${tag}`, relevantBecause: "x", signalType: "x", confidence: 0.9 },
      ];
      const r = await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CEO"], limit: 2 });
      expect(r.status).toBe(200);
      expect(r.body.added).toBe(2);
      expect(r.body.candidates.map((c: any) => c.fullName).sort()).toEqual(["Ann One", "Bob Two"]);
      for (const c of r.body.candidates) expect(c).toMatchObject({ playId: play.id, kind: "person", status: "pending", companyName: name, relevantBecause: co.relevantBecause, evidenceUrl: co.evidenceUrl, signalType: "competitor_customer" });
      expect(r.body.candidates.find((c: any) => c.fullName === "Ann One").confidence).toBeCloseTo(0.6, 5);
      expect(await usageOf(o.orgId, "searches")).toBe(searchesBefore + 1);
      expect(await leadsOf(o.orgId)).toEqual([]);

      // Asking again adds nobody twice, and says so.
      const again = await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CEO"], limit: 2 });
      expect(again.body).toMatchObject({ added: 0, candidates: [] });
      expect(again.body.note).toMatch(/already in this play/);

      // Nobody found is said as that; a search that could not run is not charged and is not "nobody".
      fake.people[name] = [];
      const none = await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CFO"] });
      expect(none.body).toMatchObject({ added: 0 });
      expect(none.body.note).toBe(`Nobody with those titles was found at ${name}.`);
      const charged = await usageOf(o.orgId, "searches");
      fake.peopleTrace = { ...emptyTrace(), blocked: true, blockedReason: "No search source answered." };
      const blocked = await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CFO"] });
      expect(blocked.body.note).toBe("No search source answered.");
      expect(await usageOf(o.orgId, "searches")).toBe(charged);
      fake.peopleError = new Error("boom for Globex");
      const broke = await req("POST", `/v1/plays/candidates/${co.id}/find-people`, o.token, { titles: ["CFO"] });
      expect([broke.status, broke.body.error.code]).toEqual([502, "search_unavailable"]);
      expect(broke.text).not.toContain("boom");
      expect(await usageOf(o.orgId, "searches")).toBe(charged);
    });
  });

  // ── 6. Decisions ───────────────────────────────────────────────────────────────────
  describe("approving and skipping", () => {
    it("approving a person creates one lead with the play's marks, charges one lead, and is the same done twice", async () => {
      const o = await signup("approve");
      const tag = u8();
      const [list] = await db.insert(S.lists).values({ orgId: o.orgId, name: "Play list" }).returning();
      const [client] = await db.insert(S.clients).values({ orgId: o.orgId, name: "Client" }).returning();
      const { play, candidates } = await queued(o, [person(`ap-${tag}`, { email: `pat-${tag}@globex.example`, companyDomain: "globex.example", location: "Pune" })], { name: "Hiring SDRs", type: "hiring_role", config: { roles: ["SDR"] }, listId: list.id, clientId: client.id });
      const c = candidates[0];

      const r = await approve(o, [c.id]);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ approved: 1, skipped: 0, leadsCreated: 1, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [c.id] });
      const leads = await leadsOf(o.orgId);
      expect(leads).toHaveLength(1);
      const lead = leads[0];
      expect(lead).toMatchObject({
        fullName: `Pat ap-${tag}`,
        title: "Head of Sales",
        email: `pat-${tag}@globex.example`,
        linkedinUrl: `https://www.linkedin.com/in/ap-${tag}`,
        location: "Pune",
        source: "play:hiring_role",
        clientId: client.id,
      });
      expect(lead.tags).toEqual(["play", `play:${play.id.slice(0, 8)}`]);
      expect(lead.custom).toEqual({ relevant_because: "Hiring a Sales Development Representative - open posting on Greenhouse.", play_id: play.id, play_name: "Hiring SDRs", evidence_url: "https://boards.greenhouse.io/globex/jobs/1" });
      expect(lead.companyId).toBeTruthy();
      expect((await db.select().from(S.listLeads).where(S.eq(S.listLeads.listId, list.id))).map((x: any) => x.leadId)).toEqual([lead.id]);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      const after = await candidate(c.id);
      expect(after).toMatchObject({ status: "approved", leadId: lead.id, decidedBy: o.userId });
      expect(after.decidedAt).toBeTruthy();
      // The event about this person carries the lead id, so erasing the lead finds it.
      const ev = await eventsOf(o.orgId, "play.candidate_approved");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ entityType: "lead", entityId: lead.id, data: { leadId: lead.id, playId: play.id, candidateId: c.id } });
      expect((await auditOf(o.orgId, "play.candidates_approved")).length).toBe(1);

      // The same call again: nothing changes, nothing is charged, and it says why.
      const again = await approve(o, [c.id]);
      expect(again.body).toEqual({ approved: 0, skipped: 0, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 0, notApplied: [{ id: c.id, reason: "Already approved." }], applied: [] });
      expect((await decide(o, [{ id: c.id, decision: "skip" }])).body.notApplied).toEqual([{ id: c.id, reason: "Already approved." }]);
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect((await candidate(c.id)).status).toBe("approved");
      expect((await eventsOf(o.orgId, "play.candidate_approved")).length).toBe(1);
      expect((await req("GET", `/v1/plays/candidates?playId=${play.id}&status=approved`, o.token)).body.candidates[0]).toMatchObject({ id: c.id, status: "approved", leadId: lead.id });
    });

    it("the reason stored on the lead is safe to put in an email: no link, address, handle or markup", async () => {
      const o = await signup("mailsafe");
      const tag = u8();
      const nasty = `Named as a customer of <b>Acme</b> see https://evil.example/login?x=1 or www.evil.example or evil.example/path, mail bad@evil.example, ping @evilhandle, visit EvilCorp.io {{first_name}}​ today`;
      const { candidates } = await queued(o, [person(`ms-${tag}`, { relevantBecause: nasty, evidenceUrl: "https://acme.example/customers/globex" })]);
      // The reviewer sees the sentence as the engine wrote it (as text on a page)...
      expect(candidates[0].relevantBecause).toContain("https://evil.example/login");
      await approve(o, [candidates[0].id]);
      const [lead] = await leadsOf(o.orgId);
      const reason = lead.custom.relevant_because as string;
      // ...and what a template can send has nothing a mail client would turn into a link.
      expect(reason).not.toMatch(/https?:|www\.|\/|@|<|>|\{|\}|​/);
      expect(reason).not.toMatch(/evil\.example|EvilCorp\.io/i);
      expect(reason).toMatch(/^Named as a customer of Acme see/);
      expect(reason.length).toBeLessThanOrEqual(200);
      // The plain template variable works, and renders exactly that.
      const vars = core.leadVars({ ...lead, company: null }, { name: "Sam", company: "Scout" });
      expect(core.renderTemplate("Hi {{first_name}} - {{relevant_because}}", vars)).toBe(`Hi Pat - ${reason}`);
      // Only an http(s) page is kept as the evidence link.
      expect(lead.custom.evidence_url).toBe("https://acme.example/customers/globex");
    });

    it("a spent lead allowance stops the approvals cleanly: it says so, and the rest stay waiting", async () => {
      const o = await signup("quota");
      const tag = u8();
      const { candidates } = await queued(o, [person(`q1-${tag}`), person(`q2-${tag}`), person(`q3-${tag}`), company(`Globex ${tag}`)]);
      await setLimits(o.orgId, { leadsPerMonth: 2 });
      await setUsage(o.orgId, "leads", 1);
      const people = candidates.filter((c: any) => c.kind === "person");
      const co = candidates.find((c: any) => c.kind === "company");
      const r = await decide(o, [...people.map((c: any) => ({ id: c.id, decision: "approve" })), { id: co.id, decision: "skip" }]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ approved: 1, leadsCreated: 1, skipped: 0 });
      expect(r.body.stopped.reason).toBe("quota");
      expect(r.body.stopped.message).toMatch(/still waiting for review/);
      // Everything from the one that hit the limit onwards is named, and nothing about it changed.
      expect(r.body.notApplied.map((n: any) => n.id)).toEqual([people[1].id, people[2].id, co.id]);
      // ...and `applied` is exactly the one that went through.
      expect(r.body.applied).toEqual([people[0].id]);
      expect(r.body.notApplied[0].reason).toMatch(/lead allowance is used up/);
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect(await usageOf(o.orgId, "leads")).toBe(2);
      for (const c of [people[1], people[2], co]) expect(await candidate(c.id)).toMatchObject({ status: "pending", leadId: null, decidedAt: null, decidedBy: null });
      // With room again, the same people can be approved - the claim was released.
      await setLimits(o.orgId, { leadsPerMonth: 100 });
      const later = await approve(o, [people[1].id, people[2].id]);
      expect(later.body).toMatchObject({ approved: 2, leadsCreated: 2, notApplied: [] });
      expect(later.body.stopped).toBeUndefined();
      expect(await usageOf(o.orgId, "leads")).toBe(4);
    });

    it("skipping records the reason and touches nothing else", async () => {
      const o = await signup("skip");
      const tag = u8();
      const { candidates } = await queued(o, [person(`sk-${tag}`), company(`Globex ${tag}`)]);
      const r = await decide(o, [{ id: candidates[0].id, decision: "skip", skipReason: "  Not a fit\u0000 " }, { id: candidates[1].id, decision: "skip" }]);
      expect(r.body).toEqual({ approved: 0, skipped: 2, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [candidates[0].id, candidates[1].id] });
      expect(await candidate(candidates[0].id)).toMatchObject({ status: "skipped", skipReason: "Not a fit", decidedBy: o.userId, leadId: null });
      expect((await candidate(candidates[1].id)).skipReason).toBeNull();
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      const again = await decide(o, [{ id: candidates[0].id, decision: "skip", skipReason: "other" }, { id: candidates[0].id, decision: "approve" }]);
      expect(again.body.notApplied).toEqual([
        { id: candidates[0].id, reason: "Already skipped." },
        { id: candidates[0].id, reason: "Already skipped." },
      ]);
      expect((await candidate(candidates[0].id)).skipReason).toBe("Not a fit");
      expect((await req("GET", "/v1/plays/candidates?status=skipped", o.token)).body).toMatchObject({ total: 2, counts: { pending: 0, approved: 0, skipped: 2 } });
      // Bounds: no decisions, too many, a reason that is too long, an id that is not one.
      for (const body of [{ decisions: [] }, { decisions: Array.from({ length: 201 }, () => ({ id: randomUUID(), decision: "skip" })) }, { decisions: [{ id: randomUUID(), decision: "skip", skipReason: "x".repeat(201) }] }, { decisions: [{ id: "nope", decision: "skip" }] }, { decisions: [{ id: randomUUID(), decision: "maybe" }] }]) {
        expect((await req("POST", "/v1/plays/candidates/decide", o.token, body)).status).toBe(400);
      }
    });

    it("approving a conversation creates a task to answer it - never a lead", async () => {
      const o = await signup("post");
      const tag = u8();
      const { candidates } = await queued(o, [post(tag)], { type: "public_asks", config: { category: "outbound tool" } });
      const r = await approve(o, [candidates[0].id], { enroll: true });
      expect(r.body).toEqual({ approved: 1, skipped: 0, leadsCreated: 0, leadsExisting: 0, tasksCreated: 1, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [candidates[0].id] });
      const tasks = await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, o.orgId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "reply_public", title: "Answer this conversation", status: "pending", leadId: null, assigneeUserId: o.userId });
      expect(tasks[0].body).toBe(`Reddit thread asking which tool to use for outbound.\nhttps://www.reddit.com/r/sales/comments/${tag}`);
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      expect(await candidate(candidates[0].id)).toMatchObject({ status: "approved", leadId: null });
    });

    it("approving a company saves the company with the signal - never a lead", async () => {
      const o = await signup("company");
      const tag = u8();
      const domain = `globex-${tag}.example`;
      const { candidates } = await queued(o, [company(`Globex ${tag}`, { companyDomain: domain }), company(`Nodomain ${tag}`)]);
      const r = await approve(o, candidates.map((c: any) => c.id));
      expect(r.body).toMatchObject({ approved: 2, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, notApplied: [] });
      const cos = await db.select().from(S.companies).where(S.eq(S.companies.orgId, o.orgId));
      expect(cos).toHaveLength(1);
      expect(cos[0]).toMatchObject({ domain, name: `Globex ${tag}`, signalsCount: 1, intentScore: 20 });
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      for (const c of candidates) expect((await candidate(c.id)).status).toBe("approved");
    });

    it("a read-only API key can read the queue and cannot decide - and reading changes nothing", async () => {
      const o = await signup("readonly");
      const made = await req("POST", "/v1/auth/api-keys", o.token, { name: "Dashboard", scope: "read" });
      expect(made.status).toBe(201);
      const key = (made.body.key ?? made.body.apiKey) as string;
      const tag = u8();
      const { play, candidates: found } = await queued(o, [person(`ro-${tag}`), company(`Globex ${tag}`)]);
      const candidates = [found.find((c: any) => c.kind === "person"), found.find((c: any) => c.kind === "company")];
      const snapshot = async () => JSON.stringify([await playRow(play.id), await candidatesOf(play.id), await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, play.id)), await usageOf(o.orgId, "searches")]);
      const before = await snapshot();
      for (const path of ["/v1/plays/types", "/v1/plays", `/v1/plays/${play.id}`, `/v1/plays/${play.id}/runs`, "/v1/plays/candidates", `/v1/plays/candidates?playId=${play.id}&status=pending`, "/v1/plays/performance", "/v1/plays/performance?days=30"]) {
        expect([path, (await req("GET", path, key)).status]).toEqual([path, 200]);
      }
      expect(await snapshot()).toBe(before);
      const writes: [string, string, unknown][] = [
        ["POST", "/v1/plays/candidates/decide", { decisions: [{ id: candidates[0].id, decision: "approve" }] }],
        ["POST", "/v1/plays", { name: "x", type: "funding", config: {} }],
        ["PATCH", `/v1/plays/${play.id}`, { name: "x" }],
        ["DELETE", `/v1/plays/${play.id}`, undefined],
        ["POST", `/v1/plays/${play.id}/run`, {}],
        ["POST", `/v1/plays/${play.id}/upload`, { engagement: "commented", people: [] }],
        ["POST", `/v1/plays/candidates/${candidates[1].id}/find-people`, { titles: ["CEO"] }],
        ["POST", "/v1/plays/plan", { website: "example.com" }],
      ];
      for (const [method, path, body] of writes) expect([method, path, (await req(method, path, key, body)).status]).toEqual([method, path, 403]);
      expect(await snapshot()).toBe(before);
      expect(await leadsOf(o.orgId)).toEqual([]);
      // No credential at all: 401 everywhere.
      for (const [method, path, body] of [...writes, ["GET", "/v1/plays/candidates", undefined] as [string, string, unknown]]) expect([path, (await req(method, path, null, body)).status]).toEqual([path, 401]);
      // The full key the workspace was issued can decide.
      expect((await approve({ ...o, token: o.apiKey }, [candidates[0].id])).body).toMatchObject({ approved: 1, leadsCreated: 1 });
      expect((await candidate(candidates[0].id)).decidedBy).toBeNull();
    });
  });

  // ── 7. Two at once ─────────────────────────────────────────────────────────────────
  describe("concurrent decisions", () => {
    it("two approvals of the same candidate at the same moment create one lead and charge once", async () => {
      const o = await signup("race");
      const tag = u8();
      // A profile link and no address: there is no unique index to fall back on.
      const { candidates } = await queued(o, [person(`race-${tag}`)]);
      const id = candidates[0].id;
      const results = await Promise.all(Array.from({ length: 6 }, () => approve(o, [id])));
      expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
      expect(results.reduce((n, r) => n + r.body.approved, 0)).toBe(1);
      expect(results.reduce((n, r) => n + r.body.leadsCreated, 0)).toBe(1);
      expect(results.filter((r) => r.body.notApplied.length === 1)).toHaveLength(5);
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect((await eventsOf(o.orgId, "play.candidate_approved")).length).toBe(1);
    });

    it("the same person found by two plays, approved in two requests at once, is one lead and one charge", async () => {
      const o = await signup("race-two");
      const tag = u8();
      const a = await queued(o, [person(`same-${tag}`)], { name: "Play A" });
      const b = await queued(o, [person(`same-${tag}`)], { name: "Play B", type: "hiring_role", config: { roles: ["SDR"] } });
      const [ra, rb] = await Promise.all([approve(o, [a.candidates[0].id]), approve(o, [b.candidates[0].id])]);
      expect(ra.body.approved + rb.body.approved).toBe(2);
      expect(ra.body.leadsCreated + rb.body.leadsCreated).toBe(1);
      expect(ra.body.leadsExisting + rb.body.leadsExisting).toBe(1);
      const leads = await leadsOf(o.orgId);
      expect(leads).toHaveLength(1);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      // Both plays are on the lead: tags merge.
      expect(leads[0].tags).toEqual(expect.arrayContaining([`play:${a.play.id.slice(0, 8)}`, `play:${b.play.id.slice(0, 8)}`]));
    });

    it("a candidate another request has claimed is left alone - in the database, not only in this process", async () => {
      const o = await signup("claim");
      const tag = u8();
      const { candidates } = await queued(o, [person(`claim-${tag}`), person(`stale-${tag}`)]);
      const [fresh, stale] = candidates;
      // What an approval in flight on another instance looks like: waiting, claimed a moment ago.
      await q`UPDATE play_candidates SET decided_at = now() WHERE id = ${fresh.id}`;
      const r = await decide(o, [{ id: fresh.id, decision: "approve" }, { id: fresh.id, decision: "skip" }]);
      expect(r.body).toMatchObject({ approved: 0, skipped: 0, leadsCreated: 0 });
      expect(r.body.notApplied).toEqual([
        { id: fresh.id, reason: "Someone else is deciding this one right now. Try again in a moment." },
        { id: fresh.id, reason: "Someone else is deciding this one right now. Try again in a moment." },
      ]);
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      expect((await candidate(fresh.id)).status).toBe("pending");
      // Shown as waiting, with no decision time.
      expect((await req("GET", "/v1/plays/candidates", o.token)).body.candidates.find((c: any) => c.id === fresh.id)).toMatchObject({ status: "pending", decidedAt: null });
      // A claim whose request died is taken over after two minutes.
      await q`UPDATE play_candidates SET decided_at = now() - interval '3 minutes' WHERE id = ${stale.id}`;
      expect((await approve(o, [stale.id])).body).toMatchObject({ approved: 1, leadsCreated: 1, notApplied: [] });
    });

    it("a server that dies in the middle of an approval leaves nothing a retry cannot finish", async () => {
      const o = await signup("claim-crash");
      const tag = u8();
      const { play, candidates } = await queued(o, [person(`crash-${tag}`, { email: `crash-${tag}@globex.example` })]);
      const c = candidates[0];
      // As the dead request left it: the lead was created and paid for, the candidate is still
      // waiting with the claim on it, and no event was written.
      const leadsSvc = await import("./services/leads.js");
      expect((await leadsSvc.chargeNewLead(o.orgId, "play:competitor_customers")).ok).toBe(true);
      const { lead } = await leadsSvc.upsertLead(o.orgId, { fullName: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, source: "play:competitor_customers", tags: ["play"] }, { fillOnly: true });
      await q`UPDATE play_candidates SET decided_at = now(), decided_by = ${o.userId} WHERE id = ${c.id}`;
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      // Straight away the candidate is still held by the dead request's claim...
      expect((await approve(o, [c.id])).body).toMatchObject({ approved: 0, applied: [], notApplied: [{ id: c.id, reason: "Someone else is deciding this one right now. Try again in a moment." }] });
      // ...and two minutes on, the same approval finishes the job: the lead that exists is used, and nobody is charged twice.
      await q`UPDATE play_candidates SET decided_at = now() - interval '121 seconds' WHERE id = ${c.id}`;
      const retry = await approve(o, [c.id]);
      expect(retry.body).toMatchObject({ approved: 1, leadsCreated: 0, leadsExisting: 1, applied: [c.id], notApplied: [] });
      expect((await leadsOf(o.orgId)).map((l: any) => l.id)).toEqual([lead.id]);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect(await candidate(c.id)).toMatchObject({ status: "approved", leadId: lead.id });
      const [after] = await leadsOf(o.orgId);
      expect(after.tags).toEqual(expect.arrayContaining(["play", `play:${play.id.slice(0, 8)}`]));
      expect(after.custom).toMatchObject({ relevant_because: expect.any(String), play_id: play.id });
      expect((await eventsOf(o.orgId, "play.candidate_approved")).length).toBe(1);
    });
  });

  // ── 8. Campaign enrolment ──────────────────────────────────────────────────────────
  describe("adding approved people to the play's campaign", () => {
    async function withCampaign(name: string) {
      const o = await signup(name);
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound" }).returning();
      return { o, campaign };
    }
    const contactsOf = (campaignId: string) => db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.campaignId, campaignId));

    it("enrols people with a usable address now and hands the rest to a lookup job - and starts nothing", async () => {
      const { o, campaign } = await withCampaign("enroll");
      const tag = u8();
      const { play, candidates } = await queued(o, [person(`en-a-${tag}`, { email: `ann-${tag}@globex.example` }), person(`en-b-${tag}`), company(`Globex ${tag}`), post(tag)], { campaignId: campaign.id });
      const r = await approve(o, candidates.map((c: any) => c.id), { enroll: true });
      expect(r.body).toMatchObject({ approved: 4, leadsCreated: 2, tasksCreated: 1, enrolled: 1, queuedForEmail: 1, notApplied: [] });
      const leads = await leadsOf(o.orgId);
      const withAddress = leads.find((l: any) => l.email);
      const without = leads.find((l: any) => !l.email);
      const contacts = await contactsOf(campaign.id);
      expect(contacts.map((c: any) => c.leadId)).toEqual([withAddress.id]);
      expect(contacts[0]).toMatchObject({ status: "queued", currentStep: 0 });
      const queuedJobs = await jobsOf(o.orgId, "play.enroll");
      expect(queuedJobs).toHaveLength(1);
      expect(queuedJobs[0].payload).toEqual({ playId: play.id, campaignId: campaign.id, leadIds: [without.id] });
      // Enrolment never starts a campaign and never sends: still a draft, no message, no mail.
      expect((await db.select().from(S.campaigns).where(S.eq(S.campaigns.id, campaign.id)))[0].status).toBe("draft");
      expect((await db.select().from(S.messages).where(S.eq(S.messages.orgId, o.orgId))).length).toBe(0);
      expect(mail.sent.filter((m) => /globex/.test(m.to))).toEqual([]);

      // The job: nobody to look up (no name and company to look at), so the lead is not
      // enrolled and is counted as that.
      const done = await handlers["play.enroll"]({ ...queuedJobs[0], attempts: 1 }, jobCtx());
      expect(done).toEqual({ enrolled: 0, withoutAddress: 1, invalidAddress: 0, ownedByAnotherClient: 0 });
      expect((await contactsOf(campaign.id)).length).toBe(1);
      // Once the address is there, the same job enrols them.
      await db.update(S.leads).set({ email: `bob-${tag}@globex.example`, emailStatus: "valid" }).where(S.eq(S.leads.id, without.id));
      expect(await handlers["play.enroll"]({ ...queuedJobs[0], attempts: 1 }, jobCtx())).toMatchObject({ enrolled: 1, withoutAddress: 0 });
      expect((await contactsOf(campaign.id)).length).toBe(2);
    });

    it("the lookup job queues one ordinary enrichment per lead it can look up, then comes back to enrol", async () => {
      const { o, campaign } = await withCampaign("enroll-lookup");
      const play = await mkPlay(o, { campaignId: campaign.id });
      const [co] = await db.insert(S.companies).values({ orgId: o.orgId, domain: `globex-${u8()}.example`, name: "Globex" }).returning();
      const [canLookUp] = await db.insert(S.leads).values({ orgId: o.orgId, firstName: "Ann", lastName: "One", fullName: "Ann One", companyId: co.id }).returning();
      const [cannot] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "No Company" }).returning();
      const stranger = await signup("enroll-lookup-other");
      const [theirs] = await db.insert(S.leads).values({ orgId: stranger.orgId, firstName: "Not", lastName: "Mine", email: `x-${u8()}@example.com` }).returning();
      const payload = { playId: play.id, campaignId: campaign.id, leadIds: [canLookUp.id, cannot.id, theirs.id, "not-an-id"] };
      const root = { id: randomUUID(), orgId: o.orgId, payload, attempts: 1, maxAttempts: 3 };
      const first = await handlers["play.enroll"](root, jobCtx());
      expect(first).toEqual({ lookupsQueued: 1, lookupsAlreadyUnderWay: 0, toEnroll: 2 });
      // The job is retried when it fails part-way. Done again, it queues no second lookup (a
      // lookup can cost a verification) and no second visit for later.
      expect(await handlers["play.enroll"]({ ...root, attempts: 2 }, jobCtx())).toEqual({ lookupsQueued: 0, lookupsAlreadyUnderWay: 1, toEnroll: 2 });
      // The same people approved through another request: still one lookup each.
      expect(await handlers["play.enroll"]({ id: randomUUID(), orgId: o.orgId, payload, attempts: 1, maxAttempts: 3 }, jobCtx())).toMatchObject({ lookupsQueued: 0, lookupsAlreadyUnderWay: 1 });
      const lookups = await jobsOf(o.orgId, "lead.enrich");
      expect(lookups.map((j: any) => j.payload)).toEqual([{ leadId: canLookUp.id }]);
      const followUps = (await jobsOf(o.orgId, "play.enroll")).filter((j: any) => j.payload.follows === root.id);
      expect(followUps).toHaveLength(1);
      expect({ ...followUps[0].payload, leadIds: [...followUps[0].payload.leadIds].sort() }).toEqual({ playId: play.id, campaignId: campaign.id, leadIds: [canLookUp.id, cannot.id].sort(), lookedUp: true, waits: 0, follows: root.id });
      expect(followUps[0].runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
      // While the enrichment is still queued, the follow-up waits again instead of enrolling.
      expect(await handlers["play.enroll"]({ ...followUps[0], attempts: 1 }, jobCtx())).toEqual({ waitingForLookups: 1 });
      expect(await handlers["play.enroll"]({ ...followUps[0], attempts: 2 }, jobCtx())).toEqual({ waitingForLookups: 1 });
      // Waiting twice (a retry) schedules one next visit, not two.
      expect((await jobsOf(o.orgId, "play.enroll")).filter((j: any) => j.payload.follows === root.id && j.payload.waits === 1)).toHaveLength(1);
      expect((await contactsOf(campaign.id)).length).toBe(0);
      // Lookup finished (found an address for one): whoever is ready is enrolled, the other counted.
      await db.update(S.jobs).set({ status: "done" }).where(S.eq(S.jobs.id, lookups[0].id));
      await db.update(S.leads).set({ email: `ann-${u8()}@globex.example`, emailStatus: "valid" }).where(S.eq(S.leads.id, canLookUp.id));
      expect(await handlers["play.enroll"]({ ...followUps[0], attempts: 1 }, jobCtx())).toEqual({ enrolled: 1, withoutAddress: 1, invalidAddress: 0, ownedByAnotherClient: 0 });
      expect((await contactsOf(campaign.id)).map((c: any) => c.leadId)).toEqual([canLookUp.id]);
      // Enrolling again (a retry, or the second chain) enrols nobody twice.
      expect(await handlers["play.enroll"]({ ...followUps[0], attempts: 2 }, jobCtx())).toMatchObject({ enrolled: 0 });
      expect((await contactsOf(campaign.id)).length).toBe(1);
      expect((await jobsOf(o.orgId, "lead.enrich")).length).toBe(1);
      // Another workspace's lead was never touched.
      expect((await jobsOf(stranger.orgId, "lead.enrich")).length).toBe(0);
    });

    it("without `enroll`, or without a campaign on the play, nobody is enrolled", async () => {
      const { o, campaign } = await withCampaign("enroll-off");
      const tag = u8();
      const a = await queued(o, [person(`off-a-${tag}`, { email: `a-${tag}@globex.example` })], { campaignId: campaign.id });
      expect((await approve(o, [a.candidates[0].id])).body).toMatchObject({ approved: 1, enrolled: 0, queuedForEmail: 0 });
      const b = await queued(o, [person(`off-b-${tag}`, { email: `b-${tag}@globex.example` })], { name: "No campaign" });
      expect((await approve(o, [b.candidates[0].id], { enroll: true })).body).toMatchObject({ approved: 1, enrolled: 0, queuedForEmail: 0 });
      expect((await contactsOf(campaign.id)).length).toBe(0);
      expect((await jobsOf(o.orgId, "play.enroll")).length).toBe(0);
    });
  });

  // ── 9. Do-not-contact ──────────────────────────────────────────────────────────────
  describe("do-not-contact lists", () => {
    it("an address on the platform list, or on the workspace's own, is never stored as a candidate", async () => {
      const o = await signup("dnc");
      const tag = u8();
      const listed = `listed-${tag}@globex.example`;
      const own = `own-${tag}@globex.example`;
      await db.insert(S.globalSuppressions).values({ email: listed, reason: "request" });
      await db.insert(S.suppressions).values({ orgId: o.orgId, email: own, reason: "manual" });
      const play = await mkPlay(o);
      fake.findings = [
        person(`dnc-a-${tag}`, { email: listed.toUpperCase(), fullName: `Listed Person ${tag}` }),
        person(`dnc-b-${tag}`, { email: `listed-${tag}+news@globex.example`, fullName: `Plus Variant ${tag}` }),
        person(`dnc-c-${tag}`, { email: own, fullName: `Own List ${tag}` }),
        person(`dnc-d-${tag}`, { email: `fine-${tag}@globex.example` }),
      ];
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 4, added: 1 });
      expect(r.note).toMatch(/3 people were left out because they are on a do-not-contact list/);
      const stored = await candidatesOf(play.id);
      expect(stored.map((c: any) => c.email)).toEqual([`fine-${tag}@globex.example`]);
      // Not the address, not the name, not the profile: nothing of those three people is in the table.
      const table = JSON.stringify(await db.select().from(S.playCandidates).where(S.eq(S.playCandidates.orgId, o.orgId))).toLowerCase();
      for (const needle of [`listed-${tag}`, `own-${tag}`, `dnc-a-${tag}`, `dnc-b-${tag}`, `dnc-c-${tag}`, `listed person ${tag}`]) expect(table).not.toContain(needle);
    });

    it("the lists are checked again at approval: listed since found means not added", async () => {
      const o = await signup("dnc-late");
      const tag = u8();
      const onPlatform = `late-p-${tag}@globex.example`;
      const onWorkspace = `late-w-${tag}@globex.example`;
      const { candidates } = await queued(o, [person(`late-p-${tag}`, { email: onPlatform }), person(`late-w-${tag}`, { email: onWorkspace })]);
      await db.insert(S.globalSuppressions).values({ email: onPlatform, reason: "erasure_request" });
      await db.insert(S.suppressions).values({ orgId: o.orgId, email: onWorkspace, reason: "unsubscribe_link" });
      const [p, w] = [candidates.find((c: any) => c.email === onPlatform), candidates.find((c: any) => c.email === onWorkspace)];
      const r = await approve(o, [p.id, w.id], { enroll: true });
      expect(r.body).toMatchObject({ approved: 0, leadsCreated: 0, leadsExisting: 0, enrolled: 0 });
      expect(r.body.notApplied).toEqual([
        { id: p.id, reason: "This person has asked not to be contacted through Scout, so they were not added." },
        { id: w.id, reason: "This person is on your do-not-contact list, so they were not added." },
      ]);
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      // The platform-listed address is not kept at all; the workspace's own is marked skipped.
      expect(await candidate(p.id)).toBeUndefined();
      expect(await candidate(w.id)).toMatchObject({ status: "skipped", skipReason: "On your do-not-contact list.", leadId: null });
    });
  });

  // ── 10. Erasure, export, retention ─────────────────────────────────────────────────
  describe("candidates are personal data", () => {
    it("deleting a lead removes every candidate about that person, and the events about them", async () => {
      const o = await signup("erase");
      const tag = u8();
      const email = `gone-${tag}@globex.example`;
      const a = await queued(o, [person(`gone-${tag}`, { email }), person(`stays-${tag}`, { email: `stays-${tag}@globex.example` })], { name: "A" });
      const b = await queued(o, [{ kind: "person", fullName: "By Email", email: email.toUpperCase(), relevantBecause: "Reacted to a post.", signalType: "post_engagement", confidence: 0.5 }], { name: "B", type: "hiring_role", config: { roles: ["SDR"] } });
      const c = await queued(o, [person(`gone-${tag}`, { fullName: "By Profile" })], { name: "C", type: "funding", config: {} });
      const target = a.candidates.find((x: any) => x.email === email);
      await approve(o, [target.id]);
      const [lead] = (await leadsOf(o.orgId)).filter((l: any) => l.email === email);
      expect((await eventsOf(o.orgId, "play.candidate_approved")).length).toBe(1);

      const del = await req("DELETE", `/v1/leads/${lead.id}`, o.token);
      expect(del.status).toBe(200);
      const left = await db.select().from(S.playCandidates).where(S.eq(S.playCandidates.orgId, o.orgId));
      // The approved one, the one in another play with the same address, the one with the same profile: gone.
      expect(left.map((x: any) => x.email)).toEqual([`stays-${tag}@globex.example`]);
      expect(await candidatesOf(b.play.id)).toEqual([]);
      expect(await candidatesOf(c.play.id)).toEqual([]);
      expect(JSON.stringify(left).toLowerCase()).not.toContain(`gone-${tag}`);
      expect((await eventsOf(o.orgId, "play.candidate_approved")).length).toBe(0);
      // Bulk delete goes through the same routine.
      await approve(o, [left[0].id]);
      const [second] = await leadsOf(o.orgId);
      expect((await req("POST", "/v1/leads/bulk/delete", o.token, { ids: [second.id] })).status).toBe(200);
      expect((await db.select().from(S.playCandidates).where(S.eq(S.playCandidates.orgId, o.orgId))).length).toBe(0);
    });

    it("a data-subject erasure removes the person's candidates in every workspace", async () => {
      const A = await signup("subject-a");
      const B = await signup("subject-b");
      const tag = u8();
      const email = `subject-${tag}@globex.example`;
      const a = await queued(A, [person(`sub-a-${tag}`, { email }), person(`sub-keep-${tag}`, { email: `keep-${tag}@globex.example` })]);
      const b = await queued(B, [person(`sub-b-${tag}`, { email: `subject-${tag}+tag@globex.example` })]);
      // In A the person is already a lead (approved); in B they are only waiting in the queue.
      await approve(A, [a.candidates.find((x: any) => x.email === email).id]);
      const { eraseDataSubject, dataSubjectReport } = await import("./lib/privacyErase.js");
      // The admin's "where does this person appear" counts candidates, and a person who is only
      // waiting in a review queue is held.
      const report = await dataSubjectReport(email);
      expect(report.held).toBe(true);
      expect(report.workspaces.map((w) => [w.orgId, w.leads, w.candidates]).sort()).toEqual([[A.orgId, 1, 1], [B.orgId, 0, 1]].sort());
      const onlyQueued = await dataSubjectReport(`keep-${tag}@globex.example`);
      expect(onlyQueued).toMatchObject({ held: true, globallySuppressed: false });
      expect(onlyQueued.workspaces.map((w) => [w.orgId, w.leads, w.campaignContacts, w.messages, w.candidates])).toEqual([[A.orgId, 0, 0, 0, 1]]);
      expect((await dataSubjectReport(`nobody-${tag}@globex.example`)).held).toBe(false);

      const r = await eraseDataSubject(email);
      expect(r.leadsDeleted).toBe(1);
      expect(r.workspaces).toBe(2);
      expect((await candidatesOf(a.play.id)).map((x: any) => x.email)).toEqual([`keep-${tag}@globex.example`]);
      expect(await candidatesOf(b.play.id)).toEqual([]);
      const after = await dataSubjectReport(email);
      expect(after).toMatchObject({ held: false, globallySuppressed: true });
      expect(after.workspaces.every((w) => w.candidates === 0 && w.leads === 0)).toBe(true);
      // And no play stores the address again afterwards.
      fake.findings = [person(`sub-again-${tag}`, { email })];
      expect((await run(B, b.play.id)).run).toMatchObject({ found: 1, added: 0 });
      expect(await candidatesOf(b.play.id)).toEqual([]);
    });

    it("the workspace export contains its plays, runs and candidates - and nobody else's", async () => {
      const { EXPORT_TABLES } = await import("./services/accountExport.js");
      expect(EXPORT_TABLES.map((t: any) => t.key)).toEqual(expect.arrayContaining(["plays", "playRuns", "playCandidates"]));
      const o = await signup("export");
      const other = await signup("export-other");
      const tag = u8();
      const mine = await queued(o, [person(`exp-${tag}`, { email: `exp-${tag}@globex.example` })], { name: `Export play ${tag}` });
      await queued(other, [person(`exp-other-${tag}`, { email: `other-${tag}@globex.example` })], { name: `Other play ${tag}` });
      const r = await req("POST", "/v1/account/export", o.token, { password: PASSWORD });
      expect(r.status).toBe(200);
      expect(r.body.summary.complete).toBe(true);
      expect(r.body.plays.map((p: any) => p.id)).toEqual([mine.play.id]);
      expect(r.body.plays[0]).toMatchObject({ name: `Export play ${tag}`, type: "competitor_customers" });
      expect(r.body.playRuns).toHaveLength(1);
      expect(r.body.playRuns[0]).toMatchObject({ playId: mine.play.id, status: "done", added: 1 });
      expect(r.body.playCandidates).toHaveLength(1);
      expect(r.body.playCandidates[0]).toMatchObject({ email: `exp-${tag}@globex.example`, relevantBecause: expect.any(String), evidenceUrl: expect.any(String), status: "pending" });
      expect(r.text).not.toContain(`other-${tag}`);
      expect(r.text).not.toContain(`Other play ${tag}`);
    });

    it("candidates nobody approved are deleted after 180 days; approved ones stay while their lead exists", async () => {
      const { RETENTION, runRetention } = await import("./lib/privacyRetention.js");
      expect(RETENTION.playCandidateDays).toBe(180);
      const o = await signup("retention");
      const tag = u8();
      const { play, candidates } = await queued(o, [person(`r-old-pending-${tag}`), person(`r-old-skipped-${tag}`), person(`r-old-approved-${tag}`), person(`r-new-pending-${tag}`), person(`r-orphan-${tag}`), person(`r-fresh-orphan-${tag}`), company(`Old Co ${tag}`)]);
      const by = (slug: string) => candidates.find((c: any) => (c.linkedinUrl ?? "").endsWith(`${slug}-${tag}`));
      await decide(o, [{ id: by("r-old-skipped").id, decision: "skip" }]);
      await approve(o, [by("r-old-approved").id, by("r-orphan").id, by("r-fresh-orphan").id, candidates.find((c: any) => c.kind === "company").id]);
      const old = [by("r-old-pending").id, by("r-old-skipped").id, by("r-old-approved").id, by("r-orphan").id, candidates.find((c: any) => c.kind === "company").id];
      await db.execute(S.sql`UPDATE play_candidates SET created_at = now() - interval '181 days', decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE now() - interval '181 days' END WHERE id IN (${S.sql.join(old.map((id: string) => S.sql`${id}`), S.sql`, `)})`);
      // Two approved people lose their lead to a plain delete (no erasure routine): one long ago, one just now.
      const orphanLeads = [(await candidate(by("r-orphan").id)).leadId, (await candidate(by("r-fresh-orphan").id)).leadId];
      await db.delete(S.leads).where(S.inArray(S.leads.id, orphanLeads));
      const [oldRun] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "done", trigger: "manual" }).returning();
      await q`UPDATE play_runs SET started_at = now() - interval '181 days' WHERE id = ${oldRun.id}`;

      const report = await runRetention(db);
      expect(report.failed).toEqual([]);
      expect(report.deleted["play candidates"]).toBeGreaterThanOrEqual(2);
      expect(report.deleted["play candidates of deleted leads"]).toBeGreaterThanOrEqual(1);
      expect(report.deleted["play runs"]).toBeGreaterThanOrEqual(1);
      const left = (await candidatesOf(play.id)).map((c: any) => c.id).sort();
      expect(left).toEqual([by("r-old-approved").id, by("r-new-pending").id, by("r-fresh-orphan").id, candidates.find((c: any) => c.kind === "company").id].sort());
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, oldRun.id))).length).toBe(0);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, play.id))).length).toBe(1);
      // The lead a kept candidate points at was not touched.
      expect((await leadsOf(o.orgId)).length).toBe(1);
    });

    it("a deleted workspace takes its plays, runs and candidates with it", async () => {
      const o = await signup("cascade");
      const { play } = await queued(o, [person(`cas-${u8()}`)]);
      await db.delete(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      expect(await playRow(play.id)).toBeUndefined();
      expect(await candidatesOf(play.id)).toEqual([]);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, play.id))).length).toBe(0);
    });
  });

  // ── 11. A run that could not look ──────────────────────────────────────────────────
  describe("a run that could not look at anything is blocked, with a sentence - never an empty result", () => {
    it("records `blocked` with the reason, without server setting names or keys, and gives the search back", async () => {
      const o = await signup("blocked");
      const play = await mkPlay(o);
      fake.trace = { ...emptyTrace(), blocked: true, blockedReason: "Search could not run: SERPER_API_KEY rejected (key=sk_live_abcdefgh12345678ijkl). Every page refused us." };
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "blocked", found: 0, added: 0, duplicates: 0 });
      expect(r.note).toMatch(/Search could not run/);
      expect(r.note).not.toMatch(/SERPER_API_KEY|sk_live_abcdefgh12345678ijkl/);
      expect(r.note).not.toMatch(/Nothing was found/);
      const p = await req("GET", `/v1/plays/${play.id}`, o.token);
      expect(p.body.play.lastResult).toMatchObject({ status: "blocked", found: 0, note: r.note });
      expect(p.text).not.toMatch(/SERPER_API_KEY|sk_live_/);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect(await candidatesOf(play.id)).toEqual([]);

      // Blocked with no reason given still says it is not a result.
      fake.trace = { ...emptyTrace(), blocked: true };
      expect((await run(o, play.id)).run.note).toMatch(/not a result about your market/);
      // Found nothing, but did look: `done`, and the search is charged.
      fake.trace = { ...emptyTrace(), notes: ["Read 12 pages on acme.example."] };
      const empty = (await run(o, play.id)).run;
      expect(empty).toMatchObject({ status: "done", found: 0, added: 0 });
      expect(empty.note).toBe("Nothing was found this time. Read 12 pages on acme.example.");
      expect(await usageOf(o.orgId, "searches")).toBe(1);
    });

    it("an engine that breaks marks the run failed, gives the search back, and puts no customer text in a log or a job error", async () => {
      const o = await signup("broken");
      const secretName = `ZzCompetitor${u8()}`;
      const play = await mkPlay(o, { config: { competitors: [{ name: secretName }] } });
      const logged: string[] = [];
      for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
      fake.engineError = new Error(`search for "${secretName} customers" failed: BRAVE_SEARCH_API_KEY token=abcdef0123456789abcdef`);
      const started = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      expect(started.status).toBe(202);
      await S.runJobById(db, handlers, started.body.jobId);
      const [r] = await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, started.body.runId));
      expect(r.status).toBe("failed");
      expect(r.note).toBe("The run stopped because of a fault on our side. Run it again.");
      expect(r.error).not.toMatch(/BRAVE_SEARCH_API_KEY|abcdef0123456789abcdef/);
      expect((await playRow(play.id)).lastResult).toMatchObject({ status: "failed" });
      const [job] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, started.body.jobId));
      // One attempt: the job is failed, not waiting to run the whole search again.
      expect(job.status).toBe("failed");
      expect(job.error).not.toContain(secretName);
      expect(logged.join("\n")).not.toContain(secretName);
      expect(logged.join("\n")).not.toMatch(/abcdef0123456789abcdef/);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect(await candidatesOf(play.id)).toEqual([]);
      // The play is not left "running": it says it failed, and can be run again at once.
      vi.restoreAllMocks();
      const seen = await req("GET", `/v1/plays/${play.id}`, o.token);
      expect(seen.body.play).toMatchObject({ running: false, lastResult: { status: "failed", note: "The run stopped because of a fault on our side. Run it again." } });
      expect(seen.text).not.toMatch(/BRAVE_SEARCH_API_KEY|abcdef0123456789abcdef/);
      fake.engineError = null;
      fake.findings = [company(`After ${u8()}`)];
      expect((await run(o, play.id)).run).toMatchObject({ status: "done", added: 1 });
    });

    it("a play deleted or paused while its run was waiting does not run, and its search is given back", async () => {
      const o = await signup("queued-gone");
      // Deleted with a run queued: the job finds no play, and the workspace is not charged for it.
      const gone = await mkPlay(o);
      const started = await req("POST", `/v1/plays/${gone.id}/run`, o.token, {});
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      expect((await req("DELETE", `/v1/plays/${gone.id}`, o.token)).status).toBe(200);
      fake.findings = [company("Never")];
      await S.runJobById(db, handlers, started.body.jobId);
      const [job] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, started.body.jobId));
      expect(job).toMatchObject({ status: "done", result: { skipped: "missing" } });
      expect(fake.calls).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, started.body.runId))).length).toBe(0);

      // Paused after the schedule queued its run: a paused play is never run by the schedule.
      const paused = await mkPlay(o, { name: "Paused", runEveryHours: 24 });
      await db.update(S.plays).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(S.eq(S.plays.id, paused.id));
      await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: {}, attempts: 1, maxAttempts: 1 }, jobCtx());
      const [queuedJob] = (await jobsOf(o.orgId, "play.run")).filter((j: any) => j.payload.playId === paused.id);
      expect(queuedJob.status).toBe("queued");
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      expect((await req("PATCH", `/v1/plays/${paused.id}`, o.token, { status: "paused" })).status).toBe(200);
      await S.runJobById(db, handlers, queuedJob.id);
      expect((await db.select().from(S.jobs).where(S.eq(S.jobs.id, queuedJob.id)))[0]).toMatchObject({ status: "done", result: { skipped: "paused" } });
      expect(fake.calls).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      const after = await req("GET", `/v1/plays/${paused.id}`, o.token);
      expect(after.body.play).toMatchObject({ status: "paused", running: false, lastResult: { status: "skipped", found: 0, note: "Not run on schedule: the play was paused before its run started." } });
      expect(after.body.runs).toEqual([]);
      // The next tick leaves it alone.
      await db.update(S.plays).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(S.eq(S.plays.id, paused.id));
      await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: {}, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect((await jobsOf(o.orgId, "play.run")).filter((j: any) => j.payload.playId === paused.id && j.status === "queued")).toEqual([]);
      // A person pressing Run on a paused play is their own decision: it runs.
      fake.findings = [company(`Manual ${u8()}`)];
      expect((await run(o, paused.id)).run).toMatchObject({ status: "done", trigger: "manual", added: 1 });
    });

    it("a play whose ICP, list, campaign and client were deleted still runs and approves", async () => {
      const o = await signup("refs-gone");
      const tag = u8();
      const [icp] = await db.insert(S.icps).values({ orgId: o.orgId, name: "ICP", criteria: { titles: ["Head of Sales"] } }).returning();
      const [list] = await db.insert(S.lists).values({ orgId: o.orgId, name: "List" }).returning();
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Campaign" }).returning();
      const [client] = await db.insert(S.clients).values({ orgId: o.orgId, name: "Client" }).returning();
      const play = await mkPlay(o, { icpId: icp.id, listId: list.id, campaignId: campaign.id, clientId: client.id, targetTitles: [] });
      fake.findings = [person(`gone-a-${tag}`, { email: `a-${tag}@globex.example` })];
      expect((await run(o, play.id)).run).toMatchObject({ status: "done", added: 1 });
      // All four are deleted; the play keeps going with what is left.
      await db.delete(S.campaigns).where(S.eq(S.campaigns.id, campaign.id));
      await db.delete(S.lists).where(S.eq(S.lists.id, list.id));
      await db.delete(S.clients).where(S.eq(S.clients.id, client.id));
      await db.delete(S.icps).where(S.eq(S.icps.id, icp.id));
      expect((await req("GET", `/v1/plays/${play.id}`, o.token)).body.play).toMatchObject({ icpId: null, listId: null, campaignId: null, clientId: null });
      fake.findings = [person(`gone-b-${tag}`, { email: `b-${tag}@globex.example` })];
      const second = (await run(o, play.id)).run;
      expect(second).toMatchObject({ status: "done", added: 1 });
      const all = await candidatesOf(play.id);
      // Scored while the ICP existed; not scored once it was gone.
      expect(all.find((c: any) => c.email.startsWith("a-")).score).toBeGreaterThan(0);
      expect(all.find((c: any) => c.email.startsWith("b-")).score).toBeNull();
      const d = await approve(o, all.map((c: any) => c.id), { enroll: true });
      expect(d.body).toMatchObject({ approved: 2, leadsCreated: 2, enrolled: 0, queuedForEmail: 0, notApplied: [] });
      expect(d.body.stopped).toBeUndefined();
      expect((await leadsOf(o.orgId)).map((l: any) => [l.icpId, l.clientId])).toEqual([[null, null], [null, null]]);
      expect((await jobsOf(o.orgId, "play.enroll")).length).toBe(0);
    });

    it("a workspace that is not active does not run", async () => {
      const o = await signup("inactive");
      const play = await mkPlay(o);
      const [runRow] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "schedule" }).returning();
      await setUsage(o.orgId, "searches", 1);
      await db.update(S.organizations).set({ status: "deactivated" }).where(S.eq(S.organizations.id, o.orgId));
      fake.findings = [company("Never")];
      const r = await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: play.id, runId: runRow.id, charged: true }, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect(r).toMatchObject({ skipped: "organization not active" });
      expect(fake.calls).toEqual([]);
      expect((await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, runRow.id)))[0]).toMatchObject({ status: "failed", note: "This workspace is not active, so the play did not run." });
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      // Its people cannot use the routes either: nothing is decided, run or uploaded for a workspace that is switched off.
      for (const [method, path, body] of [["GET", "/v1/plays", undefined], ["POST", `/v1/plays/${play.id}/run`, {}], ["POST", "/v1/plays/candidates/decide", { decisions: [{ id: randomUUID(), decision: "skip" }] }]] as const) {
        expect([path, [401, 403].includes((await req(method, path, o.token, body)).status)]).toEqual([path, true]);
      }
      // The same job again finds the run finished and does nothing.
      expect(await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: play.id, runId: runRow.id }, attempts: 1, maxAttempts: 1 }, jobCtx())).toMatchObject({ skipped: "already finished" });
      expect(await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: "nope", runId: runRow.id }, attempts: 1, maxAttempts: 1 }, jobCtx())).toEqual({ skipped: "bad payload" });
    });

    it("stored settings are checked again on every run", async () => {
      const o = await signup("reclamp");
      const play = await mkPlay(o);
      // As a row written before the limits existed (or edited by hand) would look.
      await db.update(S.plays).set({ config: { competitors: Array.from({ length: 40 }, (_, i) => ({ name: `C${i}` })) } }).where(S.eq(S.plays.id, play.id));
      const { run: r } = await run(o, play.id);
      expect(r.status).toBe("failed");
      expect(r.note).toMatch(/settings are no longer valid/);
      expect(fake.calls).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
    });
  });

  // ── 12. AI is metered per call, and only when a model runs ─────────────────────────
  describe("AI metering", () => {
    it("charges one AI message per model call, stops at the allowance, and meters nothing without an engine", async () => {
      const o = await signup("ai");
      const [org] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, o.orgId));
      // No engine configured: rules only, nothing to meter.
      const none = svc.engineOptions(org, Date.now() + 1000);
      expect(none.ai).toBeUndefined();
      expect(none.beforeAiCall).toBeUndefined();
      // The workspace turned AI assistance off: the same, whatever engine exists.
      expect(svc.engineOptions({ ...org, settings: { aiDisabled: true } }, Date.now() + 1000).ai).toBeUndefined();

      await setLimits(o.orgId, { aiMessagesPerMonth: 2 });
      let modelCalls = 0;
      const model = {
        name: "fake-model",
        model: "fake",
        complete: async () => {
          modelCalls++;
          return "{}";
        },
      };
      const opts = svc.engineOptions(org, Date.now() + 1000, model as any);
      expect(opts.ai).toMatchObject({ name: "fake-model", model: "fake" });
      // Asking whether there is room costs nothing.
      expect(await opts.beforeAiCall!()).toBe(true);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
      // Every call that reaches the model is one AI message - whether or not the engine asked first.
      await opts.ai!.complete([{ role: "user", content: "x" }] as any);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      expect(await opts.beforeAiCall!()).toBe(true);
      await opts.ai!.complete([{ role: "user", content: "x" }] as any);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(2);
      expect(modelCalls).toBe(2);
      // Allowance spent: the engine is told so, the model is not called again, nothing more is charged.
      expect(await opts.beforeAiCall!()).toBe(false);
      await expect(opts.ai!.complete([{ role: "user", content: "x" }] as any)).rejects.toThrow(/allowance/);
      expect(modelCalls).toBe(2);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(2);

      // A model call that fails is not charged.
      const p = await signup("ai-fail");
      const [org2] = await db.select().from(S.organizations).where(S.eq(S.organizations.id, p.orgId));
      const failing = svc.engineOptions(org2, Date.now() + 1000, { name: "fake-model", model: "fake", complete: async () => Promise.reject(new Error("model overloaded")) } as any);
      await expect(failing.ai!.complete([{ role: "user", content: "x" }] as any)).rejects.toThrow(/overloaded/);
      expect(await usageOf(p.orgId, "aiMessages")).toBe(0);
    });
  });

  // ── 13. The API's own engines ──────────────────────────────────────────────────────
  describe("website visitors", () => {
    it("blocked with a reason when there is no pixel; with one, companies come from the visits inside the window", async () => {
      const o = await signup("visitors");
      const other = await signup("visitors-other");
      const play = await mkPlay(o, { type: "website_visitors", config: { minIntentScore: 30, days: 7 }, name: "Visitors" });
      const none = (await run(o, play.id)).run;
      expect(none.status).toBe("blocked");
      expect(none.note).toMatch(/no active tracking pixel/);
      expect(await usageOf(o.orgId, "searches")).toBe(0);

      const tag = u8();
      const [pixel] = await db.insert(S.pixels).values({ orgId: o.orgId, key: `k-${u8()}`, name: "Site" }).returning();
      const [theirPixel] = await db.insert(S.pixels).values({ orgId: other.orgId, key: `k-${u8()}`, name: "Site" }).returning();
      const visit = (orgId: string, pixelId: string, domain: string, page: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
        db.insert(S.visits).values({ orgId, pixelId, sessionId: u8(), ipHash: "h", companyDomain: domain, page, visitedAt: new Date(Date.now() - daysAgo * 86_400_000), ...extra });
      const vc = (orgId: string, domain: string, name: string, intentScore: number, extra: Record<string, unknown> = {}) => db.insert(S.visitorCompanies).values({ orgId, domain, name, intentScore, visits: 5, ...extra });
      await vc(o.orgId, `pricing-${tag}.example`, `Pricing Co ${tag}`, 80);
      for (const d of [1, 2, 3]) await visit(o.orgId, pixel.id, `pricing-${tag}.example`, "/pricing", d);
      await visit(o.orgId, pixel.id, `pricing-${tag}.example`, "/pricing", 30); // outside the window: not counted
      await visit(o.orgId, pixel.id, `pricing-${tag}.example`, "/blog/post", 1);
      await vc(o.orgId, `demo-${tag}.example`, `Demo Co ${tag}`, 50);
      await visit(o.orgId, pixel.id, `demo-${tag}.example`, "/book-a-demo", 2);
      await vc(o.orgId, `browse-${tag}.example`, `Browse Co ${tag}`, 40);
      for (const d of [1, 1]) await visit(o.orgId, pixel.id, `browse-${tag}.example`, "/features", d);
      await vc(o.orgId, `low-${tag}.example`, `Low Intent ${tag}`, 10);
      await visit(o.orgId, pixel.id, `low-${tag}.example`, "/pricing", 1);
      await vc(o.orgId, `ignored-${tag}.example`, `Ignored ${tag}`, 90, { status: "ignored" });
      await visit(o.orgId, pixel.id, `ignored-${tag}.example`, "/pricing", 1);
      await vc(o.orgId, `stale-${tag}.example`, `Stale ${tag}`, 90);
      await visit(o.orgId, pixel.id, `stale-${tag}.example`, "/pricing", 20);
      await vc(o.orgId, `isp-${tag}.example`, `An ISP ${tag}`, 90);
      await visit(o.orgId, pixel.id, `isp-${tag}.example`, "/pricing", 1, { isIsp: true });
      await vc(other.orgId, `theirs-${tag}.example`, `Their Visitor ${tag}`, 95);
      await visit(other.orgId, theirPixel.id, `theirs-${tag}.example`, "/pricing", 1);

      const r = (await run(o, play.id)).run;
      expect(r).toMatchObject({ status: "done", found: 3, added: 3 });
      const got = Object.fromEntries((await candidatesOf(play.id)).map((c: any) => [c.companyDomain, c]));
      expect(Object.keys(got).sort()).toEqual([`browse-${tag}.example`, `demo-${tag}.example`, `pricing-${tag}.example`]);
      expect(got[`pricing-${tag}.example`]).toMatchObject({ kind: "company", companyName: `Pricing Co ${tag}`, relevantBecause: "Visited your pricing page 3 times in the last 7 days.", evidenceTitle: "Your website visitors", evidenceUrl: null, signalType: "site_visit" });
      expect(got[`demo-${tag}.example`].relevantBecause).toBe("Visited your demo or contact page once in the last 7 days.");
      expect(got[`browse-${tag}.example`].relevantBecause).toBe("Visited your website twice in the last 7 days.");
      expect(got[`pricing-${tag}.example`].signalAt).toBeTruthy();
      // A pixel with nobody over the bar is a finished run that says so, not a blocked one.
      const strict = await mkPlay(o, { type: "website_visitors", config: { minIntentScore: 100, days: 7 }, name: "Strict" });
      const quiet = (await run(o, strict.id)).run;
      expect(quiet).toMatchObject({ status: "done", found: 0 });
      expect(quiet.note).toMatch(/No identified company reached an intent score of 100/);
    });
  });

  describe("job changes", () => {
    it("suggests the existing lead with the recorded reason; approving tags it and asks a person to reach out - no enrolment", async () => {
      const o = await signup("moves");
      const other = await signup("moves-other");
      const tag = u8();
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound" }).returning();
      const play = await mkPlay(o, { type: "job_changes", config: { days: 30 }, name: "Moves", campaignId: campaign.id });
      // Nothing recorded and nobody able to check: blocked, and not "nobody moved".
      const none = (await run(o, play.id)).run;
      expect(none.status).toBe("blocked");
      expect(none.note).toMatch(/this is not a finding that nobody moved/);

      const mk = (orgId: string, name: string, extra: Record<string, unknown> = {}) => db.insert(S.leads).values({ orgId, fullName: name, firstName: name.split(" ")[0], email: `${name.toLowerCase().replace(/\W+/g, ".")}-${tag}@oldco.example`, emailStatus: "valid", linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\W+/g, "-")}-${tag}`, tags: ["vip"], custom: { note: "keep" }, ...extra }).returning();
      const [moved] = await mk(o.orgId, "Mia Mover");
      const [optedOut] = await mk(o.orgId, "Uma Unsub", { status: "unsubscribed" });
      const [suppressed] = await mk(o.orgId, "Sam Suppressed");
      await db.insert(S.suppressions).values({ orgId: o.orgId, email: suppressed.email, reason: "manual" });
      const [theirs] = await mk(other.orgId, "Theo Theirs");
      const signal = (leadId: string, n: string, extra: Record<string, unknown> = {}) =>
        db.insert(S.signals).values({ orgId: o.orgId, type: "job_change", title: `${n} moved`, summary: `${n} moved from Oldco to Newco as VP Sales.`, url: `scout:job-change/${leadId}/company_change/newco-${tag}`, companyName: "Newco", companyDomain: "newco.example", confidence: 0.85, occurredAt: new Date(), raw: { leadId, kind: "company_change", to: { title: "VP Sales", company: "Newco" } }, ...extra });
      await signal(moved.id, "Mia Mover");
      await signal(optedOut.id, "Uma Unsub");
      await signal(suppressed.id, "Sam Suppressed");
      // A signal of this workspace that names another workspace's lead is not followed.
      await signal(theirs.id, "Theo Theirs");
      // Too old for the window.
      await signal(moved.id, "Mia Mover (old)", { url: `scout:job-change/${moved.id}/title_change/old-${tag}`, occurredAt: new Date(Date.now() - 60 * 86_400_000) });

      const r = (await run(o, play.id)).run;
      expect(r).toMatchObject({ status: "done", found: 1, added: 1 });
      expect(r.note).toMatch(/2 people were left out because they are on a do-not-contact list/);
      const [c] = await candidatesOf(play.id);
      expect(c).toMatchObject({ kind: "person", fullName: "Mia Mover", title: "VP Sales", companyName: "Newco", companyDomain: "newco.example", relevantBecause: "Mia Mover moved from Oldco to Newco as VP Sales.", evidenceTitle: "Job change check", evidenceUrl: null, signalType: "job_change", alreadyLead: true, leadId: moved.id });
      // The address on file is the old employer's: it is not copied onto the candidate.
      expect(c.email).toBeNull();
      // The same move is one candidate, however often the play runs.
      expect((await run(o, play.id)).run).toMatchObject({ found: 1, added: 0, duplicates: 1 });

      // Someone who opts out between being found and being approved is not handed to a person to contact.
      const [late] = await mk(o.orgId, "Lena Late");
      await signal(late.id, "Lena Late");
      await run(o, play.id);
      const lateCandidate = (await candidatesOf(play.id)).find((x: any) => x.leadId === late.id);
      await db.update(S.leads).set({ status: "unsubscribed" }).where(S.eq(S.leads.id, late.id));
      const refused = await approve(o, [lateCandidate.id]);
      expect(refused.body).toMatchObject({ approved: 0, tasksCreated: 0, notApplied: [{ id: lateCandidate.id, reason: "This person is on your do-not-contact list, so they were not added." }] });
      expect(await candidate(lateCandidate.id)).toMatchObject({ status: "skipped", skipReason: "On a do-not-contact list." });
      expect((await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, o.orgId))).length).toBe(0);

      const d = await approve(o, [c.id], { enroll: true });
      expect(d.body).toEqual({ approved: 1, skipped: 0, leadsCreated: 0, leadsExisting: 1, tasksCreated: 1, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [c.id] });
      expect(await usageOf(o.orgId, "leads")).toBe(0);
      const [lead] = await db.select().from(S.leads).where(S.eq(S.leads.id, moved.id));
      expect(lead.tags).toEqual(["vip", "play", `play:${play.id.slice(0, 8)}`]);
      expect(lead.custom).toMatchObject({ note: "keep", relevant_because: "Mia Mover moved from Oldco to Newco as VP Sales.", play_id: play.id });
      expect(lead.email).toBe(moved.email);
      const tasks = await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, o.orgId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ leadId: moved.id, type: "job_change", title: "Reach out about the move", body: "Mia Mover moved from Oldco to Newco as VP Sales." });
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.campaignId, campaign.id))).length).toBe(0);
      expect((await jobsOf(o.orgId, "play.enroll")).length).toBe(0);
      expect((await leadsOf(o.orgId)).length).toBe(4);
    });
  });

  // ── 14. Auto-approve ───────────────────────────────────────────────────────────────
  describe("auto-approve is the play's own explicit choice", () => {
    it("approves people at or above the play's score as they are found - and only people, and never enrols", async () => {
      const o = await signup("auto");
      const tag = u8();
      const [icp] = await db.insert(S.icps).values({ orgId: o.orgId, name: "Sales leaders", criteria: { titles: ["Head of Sales"] } }).returning();
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound" }).returning();
      const play = await mkPlay(o, { icpId: icp.id, campaignId: campaign.id, autoApprove: true, minScore: 60 });
      fake.findings = [person(`auto-fit-${tag}`, { email: `fit-${tag}@globex.example` }), person(`auto-miss-${tag}`, { title: "Intern" }), company(`Globex ${tag}`), post(tag)];
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 4, added: 4 });
      expect(r.note).toMatch(/1 person was approved automatically/);
      const all = await candidatesOf(play.id);
      const fit = all.find((c: any) => (c.linkedinUrl ?? "").includes("auto-fit"));
      const miss = all.find((c: any) => (c.linkedinUrl ?? "").includes("auto-miss"));
      expect(fit.score).toBeGreaterThanOrEqual(60);
      expect(fit.scoreReasons.length).toBeGreaterThan(0);
      expect(miss.score).toBeLessThan(60);
      expect(fit).toMatchObject({ status: "approved", decidedBy: null });
      expect(miss.status).toBe("pending");
      expect(all.filter((c: any) => c.kind !== "person").map((c: any) => c.status)).toEqual(["pending", "pending"]);
      const leads = await leadsOf(o.orgId);
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({ id: fit.leadId, icpId: icp.id, score: fit.score, source: "play:competitor_customers" });
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      // Approved by the play - not put in a campaign by it.
      expect((await db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.campaignId, campaign.id))).length).toBe(0);
      expect((await jobsOf(o.orgId, "play.enroll")).length).toBe(0);
      expect((await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, o.orgId))).length).toBe(0);
    });

    it("stops at the lead allowance and says so in the run's note, leaving the rest waiting", async () => {
      const o = await signup("auto-quota");
      const tag = u8();
      const play = await mkPlay(o, { autoApprove: true });
      await setLimits(o.orgId, { leadsPerMonth: 1 });
      fake.findings = [person(`aq-1-${tag}`), person(`aq-2-${tag}`), person(`aq-3-${tag}`)];
      const started = await req("POST", `/v1/plays/${play.id}/run`, o.token, {});
      await S.runJobById(db, handlers, started.body.jobId);
      const [r] = await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, started.body.runId));
      expect(r).toMatchObject({ status: "done", found: 3, added: 3 });
      expect(r.note).toMatch(/1 person was approved automatically/);
      expect(r.note).toMatch(/still waiting for review/);
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect((await candidatesOf(play.id)).map((c: any) => c.status).sort()).toEqual(["approved", "pending", "pending"]);
      // The job finished with a plan-limit result - it did not fail and will not be retried.
      const [job] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, started.body.jobId));
      expect(job.status).toBe("done");
      expect(job.result).toMatchObject({ skipped: "quota", autoApproved: 1 });
      // The next run - the schedule's, with the allowance still spent - finds the same people
      // already waiting: it approves nobody, charges nothing and does not try again and again.
      const [scheduled] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "schedule" }).returning();
      const next = await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: play.id, runId: scheduled.id }, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect(next).toMatchObject({ status: "done", found: 3, added: 0, duplicates: 3 });
      expect(next.autoApproved).toBeUndefined();
      expect((await leadsOf(o.orgId)).length).toBe(1);
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect((await candidatesOf(play.id)).map((c: any) => c.status).sort()).toEqual(["approved", "pending", "pending"]);
      // With room again, a NEW person is approved; the two left waiting stay for a person to decide.
      await setLimits(o.orgId, { leadsPerMonth: 100 });
      fake.findings = [...fake.findings, person(`aq-4-${tag}`)];
      const [third] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "schedule" }).returning();
      expect(await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: play.id, runId: third.id }, attempts: 1, maxAttempts: 1 }, jobCtx())).toMatchObject({ added: 1, autoApproved: 1 });
      expect((await candidatesOf(play.id)).map((c: any) => c.status).sort()).toEqual(["approved", "approved", "pending", "pending"]);
    });

    it("off by default: a run never creates a lead", async () => {
      const o = await signup("auto-off");
      const { play } = await queued(o, [person(`off-${u8()}`, { email: `off-${u8()}@globex.example` })]);
      expect((await playRow(play.id)).autoApprove).toBe(false);
      expect(await leadsOf(o.orgId)).toEqual([]);
    });
  });

  // ── 15. Uploads ────────────────────────────────────────────────────────────────────
  describe("uploading people who engaged", () => {
    const UP = (o: Org, id: string, body: unknown) => req("POST", `/v1/plays/${id}/upload`, o.token, body);

    it("adds usable rows to the queue with the post as proof, and lists the rows it could not use by number", async () => {
      const o = await signup("upload");
      const tag = u8();
      const play = await mkPlay(o, { type: "engagers_upload", config: {}, name: "Launch post" });
      await db.insert(S.globalSuppressions).values({ email: `never-${tag}@globex.example`, reason: "request" });
      const people = [
        { linkedinUrl: `linkedin.com/in/up-a-${tag}`, fullName: "Ann A" },
        { email: `Bob-${tag}@Globex.example` },
        { fullName: "Cy C", companyName: "Globex" },
        { fullName: "Only Name" },
        { email: `never-${tag}@globex.example`, fullName: "Asked Not To" },
        { linkedinUrl: `linkedin.com/in/up-a-${tag}` },
        {},
      ];
      const r = await UP(o, play.id, { engagement: "commented", postUrl: "https://www.linkedin.com/posts/acme_launch-123", postTitle: "We launched", postAuthor: "Acme", people });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ added: 3, duplicates: 1, rejectedCount: 3 });
      expect(r.body.rejected).toEqual([
        { row: 4, reason: "Needs a LinkedIn profile link, an email address, or a name with a company." },
        { row: 5, reason: "On a do-not-contact list, so not added." },
        { row: 7, reason: "Needs a LinkedIn profile link, an email address, or a name with a company." },
      ]);
      expect(r.body.run).toMatchObject({ status: "done", trigger: "upload", found: 7, added: 3, duplicates: 1 });
      expect(r.body.run.note).toBe("7 rows read: 3 added, 1 already in this play, 3 not usable.");
      const stored = await candidatesOf(play.id);
      expect(stored).toHaveLength(3);
      for (const c of stored) expect(c).toMatchObject({ kind: "person", status: "pending", relevantBecause: 'Commented on the post "We launched".', evidenceUrl: "https://www.linkedin.com/posts/acme_launch-123", evidenceTitle: "We launched", signalType: "post_engagement" });
      expect(stored.map((c: any) => c.email).filter(Boolean)).toEqual([`bob-${tag}@globex.example`]);
      expect(stored.map((c: any) => c.linkedinUrl).filter(Boolean)).toEqual([`https://linkedin.com/in/up-a-${tag}`]);
      expect(JSON.stringify(stored)).not.toContain(`never-${tag}`);
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect((await playRow(play.id)).lastResult).toMatchObject({ status: "done", found: 7, added: 3 });
      expect((await auditOf(o.orgId, "play.uploaded")).length).toBe(1);

      // The same list again: nobody twice.
      const again = await UP(o, play.id, { engagement: "commented", people: people.slice(0, 3) });
      expect(again.body).toMatchObject({ added: 0, duplicates: 3, rejectedCount: 0 });
    });

    it("reads a CSV through the import's column names, and refuses what is not an upload", async () => {
      const o = await signup("upload-csv");
      const tag = u8();
      const play = await mkPlay(o, { type: "engagers_upload", config: {} });
      const csv = [
        "Name,Job Title,Company,LinkedIn,Email",
        `Ann A,CEO,Globex,linkedin.com/in/csv-a-${tag},`,
        `Bob B,CTO,Globex,,bob-${tag}@globex.example`,
        `Cy C,,,,"a@x.example, b@x.example"`,
        `Dee D,,,,`,
      ].join("\n");
      const r = await UP(o, play.id, { engagement: "attended", postAuthor: "Acme", csv });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ added: 2, duplicates: 0, rejectedCount: 2 });
      expect(r.body.rejected.map((x: any) => x.row)).toEqual([3, 4]);
      expect(r.body.rejected[0].reason).toMatch(/not a single valid email address/);
      const stored = await candidatesOf(play.id);
      expect(stored.map((c: any) => [c.fullName, c.title, c.companyName]).sort()).toEqual([["Ann A", "CEO", "Globex"], ["Bob B", "CTO", "Globex"]]);
      expect(stored[0].relevantBecause).toBe("Engaged with a post by Acme.");

      const bad: [string, unknown, RegExp | null][] = [
        ["both a list and a CSV", { engagement: "commented", people: [], csv: "a,b\n1,2" }, /not both/],
        ["neither, and no post", { engagement: "commented" }, /list or a CSV, or give the link of a public LinkedIn post/],
        ["an engagement that does not exist", { engagement: "stalked", people: [] }, null],
        ["a post link that is not http", { engagement: "commented", postUrl: "javascript:alert(1)", people: [] }, null],
        ["more than 2,000 people", { engagement: "commented", people: Array.from({ length: 2001 }, (_, i) => ({ email: `p${i}@x.example` })) }, null],
        ["a CSV with a quote that never closes", { engagement: "commented", csv: 'name,email\n"Ann,ann@x.example\nBob,bob@x.example' }, /quote that is never closed/],
        ["a CSV of more than 2,000 rows", { engagement: "commented", csv: `email\n${Array.from({ length: 2001 }, (_, i) => `p${i}@x.example`).join("\n")}` }, /at most 2,000 people/],
        ["a cell that is not text", { engagement: "commented", people: [{ fullName: { $ne: "" } }] }, null],
      ];
      for (const [what, body, message] of bad) {
        const x = await UP(o, play.id, body);
        expect([what, x.status]).toEqual([what, 400]);
        if (message) expect(x.body.error.message, what).toMatch(message);
      }
      expect((await candidatesOf(play.id)).length).toBe(2);
      const other = await mkPlay(o);
      const wrong = await UP(o, other.id, { engagement: "commented", people: [{ email: "a@x.example" }] });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.message).toMatch(/takes uploads/);
    });

    it("allows a 2 MB upload on this route only", async () => {
      const { bodyLimitFor, BODY_LIMITS } = await import("./app.js");
      expect(BODY_LIMITS.playUpload).toBe(2 * 1024 * 1024);
      expect(bodyLimitFor("POST", `/v1/plays/${randomUUID()}/upload`)).toBe(BODY_LIMITS.playUpload);
      expect(bodyLimitFor("POST", "/v1/plays")).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("POST", "/v1/plays/candidates/decide")).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("PATCH", `/v1/plays/${randomUUID()}/upload`)).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("POST", `/v1/plays/${randomUUID()}/upload/extra`)).toBe(BODY_LIMITS.default);
      expect(bodyLimitFor("POST", "/v1/leads/import")).toBe(BODY_LIMITS.leadImport);

      const o = await signup("upload-size");
      const play = await mkPlay(o, { type: "engagers_upload", config: {} });
      const line = (i: number) => `Person ${i},p${i}-${"x".repeat(900)}@globex.example`;
      // About 1.5 MB: over the default limit, under this route's.
      const fits = `name,email\n${Array.from({ length: 1600 }, (_, i) => line(i)).join("\n")}`;
      expect(fits.length).toBeGreaterThan(1.2 * 1024 * 1024);
      expect((await UP(o, play.id, { engagement: "other", csv: fits })).status).toBe(200);
      const tooBig = await UP(o, play.id, { engagement: "other", csv: "x".repeat(2 * 1024 * 1024 + 10) });
      expect([tooBig.status, tooBig.body.error.code]).toEqual([413, "payload_too_large"]);
      // The same body is refused where the limit is 1 MB.
      const elsewhere = await req("POST", "/v1/plays/candidates/decide", o.token, { decisions: [], pad: "x".repeat(1024 * 1024 + 10) });
      expect(elsewhere.status).toBe(413);
    });

    it("with only a public LinkedIn post link, reads who the post page shows - and says plainly when it shows nobody", async () => {
      const o = await signup("upload-post");
      const tag = u8();
      const play = await mkPlay(o, { type: "engagers_upload", config: {} });
      const url = "https://www.linkedin.com/posts/acme_launch-activity-7000000000000000000-abcd";
      // LinkedIn answered with its sign-in wall.
      // A link that is not a LinkedIn post cannot be read at all: said plainly, as a run that could not look.
      const other = await UP(o, play.id, { engagement: "reacted", postUrl: "https://example.com/blog/our-launch" });
      expect(other.status).toBe(200);
      expect(other.body).toMatchObject({ added: 0, duplicates: 0, rejected: [], rejectedCount: 0, run: { status: "blocked", trigger: "upload", found: 0 } });
      expect(other.body.run.note).toMatch(/only be read from the link of a public LinkedIn post/);
      expect(fake.postCalls).toEqual([]);
      // An upload never uses a search unit, whatever it was given.
      expect(await usageOf(o.orgId, "searches")).toBe(0);

      const walled = await UP(o, play.id, { engagement: "reacted", postUrl: url });
      expect(walled.status).toBe(200);
      expect(walled.body).toMatchObject({ added: 0, duplicates: 0, rejected: [], rejectedCount: 0 });
      expect(walled.body.run).toMatchObject({ status: "blocked", found: 0 });
      expect(walled.body.run.note).toMatch(/did not show that post without signing in/);
      expect(fake.postCalls).toEqual([url]);

      fake.post = { publicPage: true, refused: undefined, people: [{ fullName: "Ann A", firstName: "Ann", lastName: "A", title: "CEO", linkedinUrl: `https://www.linkedin.com/in/post-a-${tag}`, source: "linkedin:post", confidence: 0.6 }] };
      const ok = await UP(o, play.id, { engagement: "reacted", postUrl: url, postAuthor: "Acme" });
      expect(ok.body).toMatchObject({ added: 1, rejectedCount: 0 });
      expect(ok.body.run.status).toBe("done");
      expect((await candidatesOf(play.id))[0]).toMatchObject({ fullName: "Ann A", linkedinUrl: `https://www.linkedin.com/in/post-a-${tag}`, evidenceUrl: url });
      // A list was given: the post is never fetched.
      fake.postCalls = [];
      await UP(o, play.id, { engagement: "reacted", postUrl: url, people: [{ email: `x-${tag}@globex.example` }] });
      expect(fake.postCalls).toEqual([]);
    });
  });

  // ── 16. Planning ───────────────────────────────────────────────────────────────────
  describe("planning from a website", () => {
    const plan = (over: Record<string, unknown> = {}) => ({
      product: { domain: "scout.example", name: "Scout\u0000", description: "Finds buyers." },
      icp: { titles: ["Head of Sales"], industries: ["SaaS"], junk: ["x"] },
      titles: ["Head of Sales", "VP Sales"],
      competitors: [{ name: "Acme", domain: "acme.example", source: "saved" }, { name: "Initech", source: "site" }, { name: "Hooli", domain: "10.0.0.1", source: "ai" }],
      plays: [
        { type: "funding", name: "Just raised", config: { industries: ["SaaS"] }, targetTitles: ["Head of Sales"], why: "Fresh budget." },
        { type: "competitor_customers", name: "Acme's customers", config: { competitors: [{ name: "Acme", domain: "acme.example" }] }, targetTitles: ["VP Sales"], why: "They already buy this." },
        { type: "hiring_role", name: "Broken suggestion", config: { roles: [] }, targetTitles: [], why: "Not creatable." },
        { type: "linkedin_automation", name: "Not a type", config: {}, targetTitles: [], why: "?" },
      ],
      trace: { ...emptyTrace(), notes: ["Read 4 pages of scout.example."] },
      ...over,
    });

    it("returns what was understood and plays that can be created as they are - and saves nothing", async () => {
      const o = await signup("plan");
      await db.update(S.organizations).set({ settings: { visibility: { competitors: [{ name: "Acme", domain: "acme.example" }, { name: "" }, { name: "Internal", domain: "localhost" }] } } }).where(S.eq(S.organizations.id, o.orgId));
      // The session's org is read fresh on each request.
      fake.plan = plan();
      const r = await req("POST", "/v1/plays/plan", o.token, { website: "https://www.Scout.example/pricing?x=1" });
      expect(r.status, r.text).toBe(200);
      expect(fake.planCalls).toHaveLength(1);
      expect(fake.planCalls[0].input).toEqual({ website: "scout.example", knownCompetitors: [{ name: "Acme", domain: "acme.example" }, { name: "Internal" }] });
      expect(r.body.product).toEqual({ domain: "scout.example", name: "Scout", description: "Finds buyers." });
      expect(r.body.icp).toEqual({ titles: ["Head of Sales"], industries: ["SaaS"] });
      expect(r.body.titles).toEqual(["Head of Sales", "VP Sales"]);
      expect(r.body.competitors).toEqual([{ name: "Acme", domain: "acme.example", source: "saved" }, { name: "Initech", source: "site" }, { name: "Hooli", source: "ai" }]);
      expect(r.body.notes).toEqual(["Read 4 pages of scout.example."]);
      // The suggestion that could not be created, and the type that does not exist, are not offered.
      expect(r.body.plays.map((p: any) => p.type)).toEqual(["funding", "competitor_customers"]);
      expect(r.body.plays[0]).toEqual({ type: "funding", name: "Just raised", config: { industries: ["SaaS"], days: 14 }, targetTitles: ["Head of Sales"], why: "Fresh budget.", available: true });
      // Each one can be created exactly as offered.
      for (const p of r.body.plays) expect((await req("POST", "/v1/plays", o.token, { name: p.name, type: p.type, config: p.config, targetTitles: p.targetTitles })).status).toBe(201);
      expect(await usageOf(o.orgId, "searches")).toBe(1);

      // With a pixel, the play that runs on the workspace's own visitors is suggested too.
      await db.insert(S.pixels).values({ orgId: o.orgId, key: `k-${u8()}`, name: "Site" });
      const withPixel = await req("POST", "/v1/plays/plan", o.token, { website: "scout.example" });
      expect(withPixel.body.plays.map((p: any) => p.type)).toEqual(["funding", "competitor_customers", "website_visitors"]);
      expect(withPixel.body.plays[2]).toMatchObject({ available: true, config: { minIntentScore: 30, days: 14 }, targetTitles: ["Head of Sales", "VP Sales"] });
    });

    it("saves nothing, refuses an address that is not a public website, and gives the search back when planning breaks", async () => {
      const strict = await signup("plan-address");
      fake.plan = plan();
      for (const website of ["localhost", "http://127.0.0.1:8080", "10.0.0.5", "not a website", "intranet"]) {
        const r = await req("POST", "/v1/plays/plan", strict.token, { website });
        expect([website, r.status]).toEqual([website, 400]);
      }
      expect(fake.planCalls).toEqual([]);
      expect(await usageOf(strict.orgId, "searches")).toBe(0);
      // Six a minute per workspace, whatever was asked.
      expect((await req("POST", "/v1/plays/plan", strict.token, { website: "scout.example" })).status).toBe(200);
      expect((await req("POST", "/v1/plays/plan", strict.token, { website: "scout.example" })).status).toBe(429);

      const o = await signup("plan-bad");

      await req("POST", "/v1/plays/plan", o.token, { website: "scout.example" });
      expect((await db.select().from(S.plays).where(S.eq(S.plays.orgId, o.orgId))).length).toBe(0);
      expect(await usageOf(o.orgId, "searches")).toBe(1);

      fake.planError = new Error("crawl of scout.example failed: GROQ_API_KEY invalid");
      const broke = await req("POST", "/v1/plays/plan", o.token, { website: "scout.example" });
      expect([broke.status, broke.body.error.code]).toEqual([502, "plan_unavailable"]);
      expect(broke.text).not.toMatch(/GROQ_API_KEY|crawl of/);
      expect(await usageOf(o.orgId, "searches")).toBe(1);

      // A site that could not be read still answers, and says so.
      fake.planError = null;
      fake.plan = plan({ plays: [], trace: { ...emptyTrace(), blocked: true, blockedReason: "scout.example did not answer." } });
      const unread = await req("POST", "/v1/plays/plan", o.token, { website: "scout.example" });
      expect(unread.status).toBe(200);
      expect(unread.body.notes[0]).toBe("scout.example did not answer.");
    });
  });

  // ── 17. Results per play ───────────────────────────────────────────────────────────
  describe("results per play", () => {
    /** Approved candidates with their leads, and what happened to the first `contacted` / `replied` / `positive` of them. */
    async function seedResults(orgId: string, playId: string, n: { approved: number; contacted: number; repliedMark: number; positive: number; inboundOnly?: number }) {
      const leadIds: string[] = [];
      for (let i = 0; i < n.approved; i++) {
        const tag = u8();
        const [lead] = await db.insert(S.leads).values({ orgId, fullName: `Lead ${i}`, email: `lead-${tag}@results.example`, emailStatus: "valid" }).returning();
        leadIds.push(lead.id);
        await db.insert(S.playCandidates).values({ orgId, playId, kind: "person", status: "approved", fullName: `Lead ${i}`, relevantBecause: "Seeded.", signalType: "job_posting", dedupeKey: `seed:${tag}`, leadId: lead.id, decidedAt: new Date(Date.now() - 3_600_000) });
        if (i < n.contacted) await db.insert(S.messages).values({ orgId, leadId: lead.id, direction: "outbound", toEmail: lead.email, subject: "Hi", bodyText: "Hello", status: "sent", sentAt: new Date(), repliedAt: i < n.repliedMark ? new Date() : null });
        if (i < n.contacted) await db.insert(S.messages).values({ orgId, leadId: lead.id, direction: "outbound", toEmail: lead.email, subject: "Re: Hi", bodyText: "Following up", status: "sent", sentAt: new Date() });
        if (i < n.positive) await db.insert(S.messages).values({ orgId, leadId: lead.id, direction: "inbound", toEmail: lead.email, subject: "Re: Hi", bodyText: "Tell me more", status: "received", intent: i % 2 ? "referral" : "interested" });
        if (i >= n.repliedMark && i < n.repliedMark + (n.inboundOnly ?? 0)) await db.insert(S.messages).values({ orgId, leadId: lead.id, direction: "inbound", toEmail: lead.email, subject: "Re: Hi", bodyText: "No thanks", status: "received", intent: "not_interested" });
      }
      return leadIds;
    }

    it("counts found, approved, contacted, replied and positive per play, with honest rates and a best play", async () => {
      const o = await signup("results");
      const other = await signup("results-other");
      const strong = await mkPlay(o, { name: "Strong" });
      const thin = await mkPlay(o, { name: "Thin", type: "funding", config: {} });
      const untouched = await mkPlay(o, { name: "Untouched", type: "hiring_role", config: { roles: ["SDR"] } });
      const theirs = await mkPlay(other, { name: "Theirs" });

      // Strong: 26 approved, 25 contacted, 6 marked replied (4 of them positive) + 1 who only wrote back "no thanks".
      await seedResults(o.orgId, strong.id, { approved: 26, contacted: 25, repliedMark: 6, positive: 4, inboundOnly: 1 });
      for (let i = 0; i < 2; i++) await db.insert(S.playCandidates).values({ orgId: o.orgId, playId: strong.id, kind: "person", status: "pending", relevantBecause: "Seeded.", signalType: "x", dedupeKey: `p:${u8()}` });
      await db.insert(S.playCandidates).values({ orgId: o.orgId, playId: strong.id, kind: "company", status: "skipped", companyName: "Skipped Co", relevantBecause: "Seeded.", signalType: "x", dedupeKey: `s:${u8()}` });
      // Found before the window: not this window's result.
      const [old] = await db.insert(S.playCandidates).values({ orgId: o.orgId, playId: strong.id, kind: "person", status: "pending", relevantBecause: "Seeded.", signalType: "x", dedupeKey: `old:${u8()}` }).returning();
      await q`UPDATE play_candidates SET created_at = now() - interval '120 days' WHERE id = ${old.id}`;
      // A lead the workspace was already talking to BEFORE the play found them: contacted and
      // positive then, nothing since - not the play's result.
      const [prior] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "Prior Contact", email: `prior-${u8()}@results.example` }).returning();
      await db.insert(S.playCandidates).values({ orgId: o.orgId, playId: strong.id, kind: "person", status: "approved", relevantBecause: "Seeded.", signalType: "x", dedupeKey: `prior:${u8()}`, leadId: prior.id, decidedAt: new Date(Date.now() - 3_600_000) });
      const [m1] = await db.insert(S.messages).values({ orgId: o.orgId, leadId: prior.id, direction: "outbound", toEmail: prior.email, subject: "Old", bodyText: "Old", status: "sent", sentAt: new Date(Date.now() - 86_400_000), repliedAt: new Date(Date.now() - 80_000_000) }).returning();
      const [m2] = await db.insert(S.messages).values({ orgId: o.orgId, leadId: prior.id, direction: "inbound", toEmail: prior.email, subject: "Re", bodyText: "Yes", status: "received", intent: "interested" }).returning();
      await db.execute(S.sql`UPDATE messages SET created_at = now() - interval '1 day' WHERE id IN (${m1.id}, ${m2.id})`);

      // Thin: 3 contacted, 1 positive - a rate, but not enough people behind it.
      await seedResults(o.orgId, thin.id, { approved: 3, contacted: 3, repliedMark: 1, positive: 1 });
      // Another workspace's play with spectacular numbers must not appear or win.
      await seedResults(other.orgId, theirs.id, { approved: 30, contacted: 30, repliedMark: 30, positive: 30 });

      const r = await req("GET", "/v1/plays/performance", o.token);
      expect(r.status).toBe(200);
      expect(r.body.days).toBe(90);
      const by = Object.fromEntries(r.body.plays.map((p: any) => [p.name, p]));
      expect(Object.keys(by).sort()).toEqual(["Strong", "Thin", "Untouched"]);
      expect(by.Strong).toEqual({ playId: strong.id, name: "Strong", type: "competitor_customers", found: 30, pending: 2, approved: 27, skipped: 1, leads: 27, contacted: 25, replied: 7, positive: 4, replyRate: 0.28, positiveRate: 0.16, sufficient: true });
      expect(by.Thin).toEqual({ playId: thin.id, name: "Thin", type: "funding", found: 3, pending: 0, approved: 3, skipped: 0, leads: 3, contacted: 3, replied: 1, positive: 1, replyRate: 0.3333, positiveRate: 0.3333, sufficient: false });
      expect(by.Untouched).toEqual({ playId: untouched.id, name: "Untouched", type: "hiring_role", found: 0, pending: 0, approved: 0, skipped: 0, leads: 0, contacted: 0, replied: 0, positive: 0, replyRate: null, positiveRate: null, sufficient: false });
      // Thin has the higher rate and is NOT the best: three people is an anecdote.
      expect(r.body.best).toMatchObject({ playId: strong.id, name: "Strong" });
      expect(r.body.best.why).toMatch(/4 of 25 \(16%\)/);
      expect(r.body.note).toBeUndefined();
      expect(r.text).not.toContain(theirs.id);

      // The window is by when the candidate was found.
      const wide = await req("GET", "/v1/plays/performance?days=365", o.token);
      expect(wide.body.plays.find((p: any) => p.name === "Strong")).toMatchObject({ found: 31, pending: 3 });
      for (const bad of ["days=6", "days=366", "days=abc"]) expect((await req("GET", `/v1/plays/performance?${bad}`, o.token)).status).toBe(400);
      expect((await req("GET", "/v1/plays/performance", other.token)).body.best).toMatchObject({ playId: theirs.id });
    });

    it("says when it is too early to name a best play, and when replies are not being recorded at all", async () => {
      const early = await signup("results-early");
      const play = await mkPlay(early);
      await seedResults(early.orgId, play.id, { approved: 3, contacted: 3, repliedMark: 1, positive: 1 });
      const a = await req("GET", "/v1/plays/performance", early.token);
      expect(a.body.best).toBeNull();
      expect(a.body.note).toMatch(/No play has 20 people contacted yet/);
      expect(a.body.note).toMatch(/More sends are needed/);

      const silent = await signup("results-silent");
      const play2 = await mkPlay(silent);
      await seedResults(silent.orgId, play2.id, { approved: 22, contacted: 22, repliedMark: 0, positive: 0 });
      const b = await req("GET", "/v1/plays/performance", silent.token);
      expect(b.body.plays[0]).toMatchObject({ contacted: 22, replied: 0, positive: 0, replyRate: 0, positiveRate: 0, sufficient: true });
      expect(b.body.best).toBeNull();
      expect(b.body.note).toMatch(/No reply has been recorded in this workspace yet/);
      // One reply on record anywhere in the workspace: replies do arrive, so the note changes.
      const [lead] = await db.insert(S.leads).values({ orgId: silent.orgId, fullName: "Elsewhere", email: `else-${u8()}@results.example` }).returning();
      await db.insert(S.messages).values({ orgId: silent.orgId, leadId: lead.id, direction: "inbound", toEmail: lead.email, subject: "Re", bodyText: "Hi", status: "received", intent: "question" });
      expect((await req("GET", "/v1/plays/performance", silent.token)).body.note).toBe("No play has a positive reply yet, so there is no best play to name.");
      // No plays at all.
      const none = await signup("results-none");
      expect((await req("GET", "/v1/plays/performance", none.token)).body).toMatchObject({ plays: [], best: null });
    });
  });

  // ── 18. The schedule ───────────────────────────────────────────────────────────────
  describe("the scheduler", () => {
    it("is one of the recurring jobs, with a handler, and reschedules itself", async () => {
      const { RECURRING_JOBS } = await import("./jobs.js");
      expect(RECURRING_JOBS["plays.tick"]).toBe(3600_000);
      for (const type of ["plays.tick", "play.run", "play.enroll"]) expect(typeof handlers[type]).toBe("function");
      const before = (await q`SELECT count(*)::int AS n FROM jobs WHERE type = 'plays.tick' AND status = 'queued'`)[0].n;
      await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: { recurring: true }, attempts: 1, maxAttempts: 1 }, jobCtx());
      const queuedTicks = await q`SELECT payload, run_at, max_attempts FROM jobs WHERE type = 'plays.tick' AND status = 'queued' ORDER BY created_at DESC`;
      expect(queuedTicks.length).toBe(before + 1);
      expect(queuedTicks[0].payload).toEqual({ recurring: true });
      expect(new Date(queuedTicks[0].run_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it("closes a run whose job never came back, instead of leaving it running for ever", async () => {
      const o = await signup("stale");
      const play = await mkPlay(o);
      const [lost] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "manual" }).returning();
      const [recent] = await db.insert(S.playRuns).values({ orgId: o.orgId, playId: play.id, status: "running", trigger: "manual" }).returning();
      await q`UPDATE play_runs SET started_at = now() - interval '7 hours' WHERE id = ${lost.id}`;
      await setUsage(o.orgId, "searches", 1);
      const r = await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: {}, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect(r.closedStale).toBeGreaterThanOrEqual(1);
      const runRow = async (id: string) => (await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, id)))[0];
      expect(await runRow(lost.id)).toMatchObject({ status: "failed", note: "This run did not finish. Run the play again." });
      expect((await runRow(lost.id)).finishedAt).toBeTruthy();
      expect((await runRow(recent.id)).status).toBe("running");
      expect((await playRow(play.id)).lastResult).toMatchObject({ status: "failed", note: "This run did not finish. Run the play again." });
      // The search it was charged did no work, and is given back - once.
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      // If its job does turn up later, it does nothing.
      fake.findings = [company("Too Late")];
      expect(await handlers["play.run"]({ id: randomUUID(), orgId: o.orgId, payload: { playId: play.id, runId: lost.id, charged: true }, attempts: 1, maxAttempts: 1 }, jobCtx())).toMatchObject({ skipped: "already finished" });
      expect(fake.calls).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
    });

    it("starts only the plays that are due, active, on a schedule, and whose workspace is active and has searches left", async () => {
      const o = await signup("tick");
      const off = await signup("tick-off");
      const broke = await signup("tick-broke");
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 3 * 3600_000);
      const mk = async (org: Org, name: string, patch: Record<string, unknown>, body: Record<string, unknown> = {}) => {
        const p = await mkPlay(org, { name, runEveryHours: 24, ...body });
        await db.update(S.plays).set(patch).where(S.eq(S.plays.id, p.id));
        return p;
      };
      const due = await mk(o, "due", { nextRunAt: past });
      const never = await mk(o, "never run, on a schedule", { nextRunAt: null });
      const notYet = await mk(o, "not yet", { nextRunAt: future });
      const paused = await mk(o, "paused", { nextRunAt: past, status: "paused" });
      const manual = await mk(o, "manual", { nextRunAt: past }, { runEveryHours: null });
      const upload = await mk(o, "upload", { nextRunAt: past, runEveryHours: 24 }, { type: "engagers_upload", config: {} });
      const busy = await mk(o, "busy", { nextRunAt: past });
      await db.insert(S.playRuns).values({ orgId: o.orgId, playId: busy.id, status: "running", trigger: "manual" });
      const inactive = await mk(off, "workspace off", { nextRunAt: past });
      await db.update(S.organizations).set({ status: "deactivated" }).where(S.eq(S.organizations.id, off.orgId));
      const noQuota = await mk(broke, "no searches", { nextRunAt: past });
      await setLimits(broke.orgId, { searchesPerMonth: 1 });
      await setUsage(broke.orgId, "searches", 1);

      const result = await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: {}, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect(result.queued).toBeGreaterThanOrEqual(2);
      expect(result.skippedQuota).toBeGreaterThanOrEqual(1);
      expect(result.skippedBusy).toBeGreaterThanOrEqual(1);

      const started = (await jobsOf(o.orgId, "play.run")).map((j: any) => j.payload.playId).sort();
      expect(started).toEqual([due.id, never.id].sort());
      expect((await jobsOf(off.orgId, "play.run")).length).toBe(0);
      expect((await jobsOf(broke.orgId, "play.run")).length).toBe(0);
      const runsOf = async (id: string) => db.select().from(S.playRuns).where(S.eq(S.playRuns.playId, id));
      for (const p of [notYet, paused, manual, upload, inactive, noQuota]) expect([p.name, (await runsOf(p.id)).length]).toEqual([p.name, 0]);
      expect((await runsOf(busy.id)).length).toBe(1);
      // One search each for the two that started; the next slot is stamped so they are not started twice.
      expect(await usageOf(o.orgId, "searches")).toBe(2);
      const dueRow = await playRow(due.id);
      expect(dueRow.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect((await runsOf(due.id))[0]).toMatchObject({ status: "running", trigger: "schedule" });
      // The workspace with no searches left is told why, and is not charged.
      const skipped = await playRow(noQuota.id);
      expect(skipped.lastResult).toMatchObject({ status: "skipped", found: 0 });
      expect(skipped.lastResult.note).toMatch(/^Not run on schedule: /);
      expect(skipped.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(await usageOf(broke.orgId, "searches")).toBe(1);
      // The deactivated workspace's play is simply left as it was.
      expect((await playRow(inactive.id)).lastResult).toBeNull();

      // A second tick straight away starts nothing more for this workspace.
      await handlers["plays.tick"]({ id: randomUUID(), orgId: null, payload: {}, attempts: 1, maxAttempts: 1 }, jobCtx());
      expect((await jobsOf(o.orgId, "play.run")).length).toBe(2);
      expect(await usageOf(o.orgId, "searches")).toBe(2);

      // The queued job does the run, and the play keeps its schedule.
      const [job] = (await jobsOf(o.orgId, "play.run")).filter((j: any) => j.payload.playId === due.id);
      expect(job).toMatchObject({ maxAttempts: 1, payload: { charged: true } });
      fake.findings = [company(`Scheduled ${u8()}`)];
      await S.runJobById(db, handlers, job.id);
      expect((await runsOf(due.id))[0]).toMatchObject({ status: "done", found: 1, added: 1 });
      const after = await playRow(due.id);
      expect(after.lastResult).toMatchObject({ status: "done", added: 1 });
      expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(await leadsOf(o.orgId)).toEqual([]);
    });
  });

  // ── 19. The reason reaches the opening line ────────────────────────────────────────
  describe("the reason is passed to outreach generation", () => {
    it("a lead a play found carries its reason into the draft; any other lead adds nothing at all", async () => {
      const o = await signup("reason");
      const campaigns = await import("./services/campaigns.js");
      const tag = u8();
      const { candidates } = await queued(o, [person(`rs-${tag}`, { email: `rs-${tag}@globex.example`, relevantBecause: "Named as a customer of Acme, see https://acme.example/customers/globex for more." })]);
      await approve(o, [candidates[0].id]);
      const [found] = await leadsOf(o.orgId);
      const [plain] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "Plain Lead", email: `plain-${tag}@globex.example`, emailStatus: "valid" }).returning();
      const [typed] = await db.insert(S.leads).values({ orgId: o.orgId, fullName: "Typed Reason", email: `typed-${tag}@globex.example`, custom: { relevant_because: "Click <a href='https://evil.example'>here</a> now" } }).returning();

      expect(campaigns.outreachReasonOf(found)).toBe(found.custom.relevant_because);
      expect(campaigns.outreachReasonOf(found)).not.toMatch(/https?:|acme\.example/);
      expect(campaigns.outreachReasonOf(plain)).toBeUndefined();
      expect(campaigns.outreachReasonOf({ custom: { relevant_because: 42 } })).toBeUndefined();
      expect(campaigns.outreachReasonOf({ custom: { relevant_because: "   " } })).toBeUndefined();
      // A custom field written by an import or an edit is made safe on the way out too.
      expect(campaigns.outreachReasonOf(typed)).toBe("Click here now");

      const seen: any[] = [];
      vi.spyOn(core, "generateOutreach").mockImplementation(async (_ai: any, input: any) => {
        seen.push(input);
        return { subject: "S", body: "B", personalized: false, provider: "none" };
      });
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound", status: "active" }).returning();
      const step = { id: randomUUID(), stepNo: 1, channel: "linkedin_message", subjectTemplate: "", bodyTemplate: "Hi {{first_name}}", aiPersonalize: true, aiInstructions: null };
      const [stepRow] = await db.insert(S.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "linkedin_message", subjectTemplate: "", bodyTemplate: "Hi {{first_name}}", aiPersonalize: true }).returning();
      for (const lead of [found, plain]) {
        const [cc] = await db.insert(S.campaignContacts).values({ campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning();
        await campaigns.createStepTask(campaign, cc.id, lead.id, { ...step, id: stepRow.id }, 1);
      }
      expect(seen).toHaveLength(2);
      expect(seen[0].reason).toBe(found.custom.relevant_because);
      expect("reason" in seen[1]).toBe(false);
    });

    it("an email step sent by the campaign passes the reason as well", async () => {
      const o = await signup("reason-send");
      const campaigns = await import("./services/campaigns.js");
      const tag = u8();
      const [acct] = await db.insert(S.emailAccounts).values({ orgId: o.orgId, provider: "system", fromName: "T", fromEmail: `t-${tag}@example.com`, dailyLimit: 500 }).returning();
      await q`UPDATE email_accounts SET created_at = now() - interval '120 days' WHERE id = ${acct.id}`;
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "C", emailAccountId: acct.id, status: "active", settings: { timezone: "UTC", sendWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, dailyLimit: 500 } }).returning();
      const [step] = await db.insert(S.sequenceSteps).values({ campaignId: campaign.id, stepNo: 1, channel: "email", subjectTemplate: "Hi", bodyTemplate: "Hello {{first_name}} - {{relevant_because}}", aiPersonalize: true }).returning();
      const { candidates } = await queued(o, [person(`send-${tag}`, { email: `send-${tag}@globex.example` })]);
      await approve(o, [candidates[0].id]);
      const [lead] = await leadsOf(o.orgId);
      await db.update(S.leads).set({ emailStatus: "valid" }).where(S.eq(S.leads.id, lead.id));
      const [cc] = await db.insert(S.campaignContacts).values({ campaignId: campaign.id, leadId: lead.id, status: "active", currentStep: 0 }).returning();
      const seen: any[] = [];
      vi.spyOn(core, "generateOutreach").mockImplementation(async (_ai: any, input: any) => {
        seen.push(input);
        // What generateOutreach returns with no engine: the rendered template.
        const vars = core.leadVars(input.lead, input.sender);
        return { subject: core.renderTemplate(input.subjectTemplate, vars), body: core.renderTemplate(input.bodyTemplate, vars), personalized: false, provider: "none" };
      });
      const r = await campaigns.sendStep(campaign.id, cc.id, step.id, { attempt: 1 });
      // Whether or not this environment lets the send itself go out, the draft was asked for with the reason.
      expect(seen.length, JSON.stringify(r)).toBe(1);
      expect(seen[0].reason).toBe("Hiring a Sales Development Representative - open posting on Greenhouse.");
      expect(seen[0].guard).toBe("enforce");
    });
  });
});
