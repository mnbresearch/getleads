/**
 * Fix round B2: leads, signals, ICPs, play approvals, AI visibility and client pace.
 *
 * Through the real app and a real database, in its own Postgres schema (`fixes_b2`).
 * Outbound `fetch` is blocked; the finders and searches these routes call are replaced with
 * spies, so nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/fixes.b2.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "fixes_b2";

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
  process.stderr.write(`\n[!] "fixes B2" did NOT run: TEST_DATABASE_URL is not set.\n`);
}

const suite = TEST_DB ? describe : describe.skip;

suite("fixes B2", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let core: any;
  let handlers: any;
  const realFetch = globalThis.fetch;
  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string };

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
      throw new Error("fixes.b2.test: outbound fetch is blocked in this test");
    }) as typeof fetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    core = await import("@prospex/core");
    ({ handlers } = await import("./jobs.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  // ── 1. find-email never writes a guess over an address the lead has ──
  describe("POST /v1/leads/:id/find-email", () => {
    const found = (email: string, status: string) => ({ email, status, confidence: status === "valid" ? 0.95 : 0.4, pattern: "{first}.{last}", candidates: [], verifiedBy: status === "valid" ? "reoon:safe" : undefined });

    it("keeps an existing address and offers the found one as a suggestion", async () => {
      const o = await signup("fe-keep");
      const lead = await mkLead(o, { firstName: "Ann", lastName: "Lee", email: "ann@keep.example", companyDomain: "keep.example" });
      vi.spyOn(core, "findEmail").mockResolvedValue(found("ann.lee@keep.example", "risky") as never);
      const r = await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ saved: false, replaced: false, suggestion: "ann.lee@keep.example" });
      expect(r.body.note).toMatch(/already has ann@keep\.example/);
      expect((await leadRow(lead.id)).email).toBe("ann@keep.example");
    });

    it("fills an empty address", async () => {
      const o = await signup("fe-fill");
      const lead = await mkLead(o, { firstName: "Bo", lastName: "Kim", companyDomain: "fill.example" });
      vi.spyOn(core, "findEmail").mockResolvedValue(found("bo.kim@fill.example", "risky") as never);
      const r = await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      expect(r.body).toMatchObject({ saved: true, replaced: false });
      expect(r.body.suggestion).toBeUndefined();
      const row = await leadRow(lead.id);
      expect(row.email).toBe("bo.kim@fill.example");
      // A guess is not a verification.
      expect(row.verifiedAt).toBeNull();
    });

    it("replaces an address verified invalid with one that checked out valid, and says so", async () => {
      const o = await signup("fe-fix");
      const lead = await mkLead(o, { firstName: "Cy", lastName: "Ng", email: "cy@fix.example", companyDomain: "fix.example" });
      await db.update(S.leads).set({ emailStatus: "invalid" }).where(S.eq(S.leads.id, lead.id));
      vi.spyOn(core, "findEmail").mockResolvedValue(found("cy.ng@fix.example", "valid") as never);
      const r = await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      expect(r.body).toMatchObject({ saved: true, replaced: true, previousEmail: "cy@fix.example" });
      expect(r.body.note).toMatch(/invalid/);
      expect((await leadRow(lead.id)).email).toBe("cy.ng@fix.example");
    });

    it("does not replace an invalid address with another unverified guess", async () => {
      const o = await signup("fe-noguess");
      const lead = await mkLead(o, { firstName: "Di", lastName: "Oz", email: "di@ng.example", companyDomain: "ng.example" });
      await db.update(S.leads).set({ emailStatus: "invalid" }).where(S.eq(S.leads.id, lead.id));
      vi.spyOn(core, "findEmail").mockResolvedValue(found("di.oz@ng.example", "risky") as never);
      const r = await req("POST", `/v1/leads/${lead.id}/find-email`, o.token);
      expect(r.body).toMatchObject({ saved: false, suggestion: "di.oz@ng.example" });
      expect((await leadRow(lead.id)).email).toBe("di@ng.example");
    });
  });

  // ── 9. A changed title recomputes seniority and department ──
  describe("PATCH /v1/leads/:id title", () => {
    it("re-derives seniority and department, and clears them with the title", async () => {
      const o = await signup("title");
      const lead = await mkLead(o, { fullName: "Eve Intern", title: "Marketing Intern", email: `eve-${u8()}@t.example` });
      expect(lead.seniority).toBe("entry");
      expect(lead.department).toBe("marketing");
      const r = await req("PATCH", `/v1/leads/${lead.id}`, o.token, { title: "VP of Sales" });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ title: "VP of Sales", seniority: "vp", department: "sales" });
      const cleared = await req("PATCH", `/v1/leads/${lead.id}`, o.token, { title: null });
      expect(cleared.body).toMatchObject({ title: null, seniority: null, department: null });
      // Other edits leave them alone.
      await req("PATCH", `/v1/leads/${lead.id}`, o.token, { title: "Head of Growth" });
      const other = await req("PATCH", `/v1/leads/${lead.id}`, o.token, { phone: "+1 555 0100" });
      expect(other.body).toMatchObject({ seniority: "director", department: "marketing" });
    });
  });

  // ── 7. CSV export: stage, client, lists and custom fields at the end ──
  describe("GET /v1/leads/export.csv", () => {
    it("appends stage, client, lists and custom fields after the original columns", async () => {
      const o = await signup("csv");
      const lead = await mkLead(o, { fullName: "Fay Csv", email: `fay-${u8()}@csv.example`, custom: { region: "North, East", tier: 2 } });
      await mkLead(o, { fullName: "Gus Csv", email: `gus-${u8()}@csv.example` });
      const client = await req("POST", "/v1/clients", o.token, { name: "Client One" });
      expect(client.status, client.text).toBe(201);
      const clientId = client.body.client?.id ?? client.body.id;
      expect((await req("POST", `/v1/clients/${clientId}/assign`, o.token, { leadIds: [lead.id] })).status).toBe(200);
      const list = await req("POST", "/v1/leads/lists", o.token, { name: "Hot list" });
      await req("POST", `/v1/leads/lists/${list.body.id}/leads`, o.token, { ids: [lead.id] });
      await req("POST", `/v1/tools/leads/${lead.id}/status`, o.token, { status: "contacted" });

      const r = await req("GET", "/v1/leads/export.csv?sort=name&order=asc", o.token);
      expect(r.status).toBe(200);
      const [header, ...rows] = r.text.split("\n");
      expect(header).toBe("first_name,last_name,title,email,email_status,email_confidence,linkedin_url,phone,location,company,company_domain,industry,company_size,score,tags,created_at,stage,client,lists,custom_region,custom_tier");
      const fay = rows.find((l) => l.includes("fay-"))!;
      expect(fay.endsWith(`"contacted","Client One","Hot list","North, East","2"`)).toBe(true);
      const gus = rows.find((l) => l.includes("gus-"))!;
      expect(gus.endsWith(`"new","","","",""`)).toBe(true);
    });
  });

  // ── 7. Remove from list and tag removal (the routes the UI now calls) ──
  describe("list and tag removal", () => {
    it("removes one lead from a list and one tag from a lead", async () => {
      const o = await signup("unlist");
      const lead = await mkLead(o, { fullName: "Hal List", email: `hal-${u8()}@l.example`, tags: ["keep", "drop"] });
      const list = await req("POST", "/v1/leads/lists", o.token, { name: "L" });
      await req("POST", `/v1/leads/lists/${list.body.id}/leads`, o.token, { ids: [lead.id] });
      expect((await req("DELETE", `/v1/leads/lists/${list.body.id}/leads/${lead.id}`, o.token)).status).toBe(200);
      expect((await req("GET", `/v1/leads?listId=${list.body.id}`, o.token)).body.total).toBe(0);
      await req("POST", "/v1/leads/bulk/tag", o.token, { ids: [lead.id], remove: ["drop"] });
      expect((await leadRow(lead.id)).tags).toEqual(["keep"]);
    });
  });

  // ── 2 & 3. Signal subscriptions ──
  describe("signal subscriptions", () => {
    const sig = async (over: Record<string, unknown>) => (await db.insert(S.signals).values({ orgId: null, type: "funding", url: `https://news.test/${u8()}`, ...over }).returning())[0];

    it("refuses a subscription with no signal types, in words", async () => {
      const o = await signup("sub-types");
      for (const body of [{ name: "None" }, { name: "Empty", types: [] }]) {
        const r = await req("POST", "/v1/signals/subscriptions", o.token, body);
        expect(r.status).toBe(400);
        expect(r.text).toMatch(/Choose at least one signal type/);
      }
      expect((await req("GET", "/v1/signals/subscriptions", o.token)).body.subscriptions).toEqual([]);
    });

    it("matches a location on the company or the headline, never on the publisher's name", async () => {
      const o = await signup("sub-loc");
      const tag = u8();
      vi.spyOn(core, "scanSignals").mockResolvedValue([] as never);
      const publisher = await sig({ title: `Ludo ${tag} raises $5M - Investing.com India`, summary: "Investing.com India", source: "Investing.com India", companyName: `Ludo ${tag}` });
      const headline = await sig({ title: `Bengaluru-based Zed ${tag} raises funding in India`, source: "Some Paper", companyName: `Zed ${tag}` });
      const elsewhere = await sig({ title: `Kay ${tag} enters India after Series B`, source: "Wire", companyName: `Kay ${tag}`, companyDomain: `kay-${tag}.example` });
      await db.insert(S.companies).values({ orgId: o.orgId, domain: `kay-${tag}.example`, name: `Kay ${tag}`, location: "Berlin", country: "Germany" });
      const [sub] = await db.insert(S.signalSubscriptions).values({ orgId: o.orgId, name: "India", types: ["funding"], locations: ["India"] }).returning();
      const { runSubscription } = await import("./services/signals.js");
      const r = await runSubscription(sub);
      const matched = (await db.select().from(S.signalMatches).where(S.eq(S.signalMatches.subscriptionId, sub.id))).map((m: any) => m.signalId);
      expect(matched).toContain(headline.id);
      expect(matched).not.toContain(publisher.id);
      expect(matched).not.toContain(elsewhere.id);
      expect(r.skippedLocation).toBeGreaterThanOrEqual(2);
    });

    it("keywords are matched against what happened, not the publisher", async () => {
      const o = await signup("sub-kw");
      const tag = u8();
      vi.spyOn(core, "scanSignals").mockResolvedValue([] as never);
      const pub = await sig({ title: `Mo ${tag} raises seed`, summary: "via Fintech Weekly", source: "Fintech Weekly", companyName: `Mo ${tag}` });
      const real = await sig({ title: `No ${tag} fintech app raises seed`, source: "Wire", companyName: `No ${tag}` });
      const [sub] = await db.insert(S.signalSubscriptions).values({ orgId: o.orgId, name: "kw", types: ["funding"], keywords: ["fintech"] }).returning();
      const { runSubscription } = await import("./services/signals.js");
      await runSubscription(sub);
      const matched = (await db.select().from(S.signalMatches).where(S.eq(S.signalMatches.subscriptionId, sub.id))).map((m: any) => m.signalId);
      expect(matched).toContain(real.id);
      expect(matched).not.toContain(pub.id);
    });

    it("with no ICP gives no made-up score, keeps a headline out of location, and says why nothing was created", async () => {
      const o = await signup("sub-leads");
      const tag = u8();
      vi.spyOn(core, "scanSignals").mockResolvedValue([] as never);
      vi.spyOn(core, "resolveCompanyDomain").mockResolvedValue(null as never);
      const people = vi.spyOn(core, "findPeopleDetailed").mockResolvedValue({ people: [{ firstName: "Ivy", lastName: "Q", fullName: "Ivy Q", title: "Head of Sales", linkedinUrl: `https://www.linkedin.com/in/ivy-${tag}`, location: "Head of Sales at Zed | Fintech | India", source: "web", confidence: 0.7 }], everySearchFailed: false } as never);
      await sig({ title: `Pax ${tag} raises Series A`, source: "Wire", companyName: `Pax ${tag}` });
      const [sub] = await db.insert(S.signalSubscriptions).values({ orgId: o.orgId, name: "auto", types: ["funding"], keywords: [tag], autoCreateLeads: true, targetTitles: ["Head of Sales"] }).returning();
      const { runSubscription } = await import("./services/signals.js");
      const first = await runSubscription(sub);
      expect(first.leadsCreated).toBe(1);
      const [lead] = await db.select().from(S.leads).where(S.eq(S.leads.orgId, o.orgId));
      expect(lead.score).toBe(0);
      expect(lead.scoreReasons.join(" ")).not.toMatch(/ICP fit/i);
      expect(lead.location).toBeNull();

      // Second signal, same person: nothing new, and the answer says why.
      await sig({ title: `Pax ${tag} opens office`, source: "Wire", companyName: `Pax ${tag}` });
      const [sub2] = await db.select().from(S.signalSubscriptions).where(S.eq(S.signalSubscriptions.id, sub.id));
      const second = await runSubscription(sub2);
      expect(second.leadsCreated).toBe(0);
      expect(second.note).toMatch(/already leads/);

      // And a company where nobody is found.
      people.mockResolvedValue({ people: [], everySearchFailed: false } as never);
      await sig({ title: `Rho ${tag} raises again`, source: "Wire", companyName: `Rho ${tag}` });
      const [sub3] = await db.select().from(S.signalSubscriptions).where(S.eq(S.signalSubscriptions.id, sub.id));
      const third = await runSubscription(sub3);
      expect(third.note).toMatch(/nobody with the target titles was found/);
      const [after] = await db.select().from(S.signalSubscriptions).where(S.eq(S.signalSubscriptions.id, sub.id));
      expect(after.stats.lastRunNoPerson).toBe(1);
    });

    it("helpers: publisher text, location matching and plausible locations", async () => {
      const { ownText, locationMatches, plausibleLocation } = await import("./services/signals.js");
      expect(ownText({ title: "Acme raises - Investing.com India", source: "Investing.com India" }).headline).not.toContain("india");
      expect(ownText({ title: "Acme raises - Investing.com India", source: null }).headline).toBe("acme raises");
      expect(locationMatches(["india"], undefined, "a startup in indiana")).toBe(false);
      expect(locationMatches(["india"], "berlin germany", "india news")).toBe(false);
      expect(locationMatches(["india"], "pune, india", "")).toBe(true);
      expect(plausibleLocation("Bengaluru, Karnataka, India")).toBe("Bengaluru, Karnataka, India");
      expect(plausibleLocation("Head of Sales at Zed | India")).toBeUndefined();
      expect(plausibleLocation("Founder")).toBeUndefined();
    });
  });

  // ── 4. ICP build without AI says so ──
  describe("ICP build without AI", () => {
    it("records that AI is not available instead of 'building' for ever", async () => {
      const o = await signup("icp-noai");
      const r = await req("POST", "/v1/icps", o.token, { name: "Desc", description: "B2B SaaS founders in India", criteria: { titles: ["Founder"] } });
      expect(r.status, r.text).toBe(201);
      expect(r.body).toMatchObject({ aiAvailable: false, aiBuild: "skipped" });
      expect(r.body.note).toMatch(/AI not available - using your criteria as written/);
      expect(r.body.icp.aiProfile).toMatchObject({ status: "skipped", reason: "no_ai" });
      // The job still runs, and leaves the outcome in place rather than nothing.
      await S.runJobById(db, handlers, r.body.jobId);
      const [row] = await db.select().from(S.icps).where(S.eq(S.icps.id, r.body.icp.id));
      expect(row.aiProfile).toMatchObject({ status: "skipped" });
      expect(row.criteria.titles).toEqual(["Founder"]);

      const rebuilt = await req("POST", `/v1/icps/${r.body.icp.id}/build`, o.token, {});
      expect(rebuilt.status).toBe(202);
      expect(rebuilt.body).toMatchObject({ aiBuild: "skipped", aiAvailable: false });
      expect(rebuilt.body.jobId).toBeTruthy();
    });

    it("says the workspace switched AI off when it did", async () => {
      const o = await signup("icp-off");
      await db.update(S.organizations).set({ settings: { aiDisabled: true } }).where(S.eq(S.organizations.id, o.orgId));
      const r = await req("POST", "/v1/icps", o.token, { name: "Off", description: "Retail chains" });
      expect(r.body.icp.aiProfile).toMatchObject({ status: "skipped", reason: "ai_off" });
      expect(r.body.note).toMatch(/turned off/);
    });

    it("a job that finds no AI writes the outcome on an ICP that had none", async () => {
      const o = await signup("icp-job");
      const [icp] = await db.insert(S.icps).values({ orgId: o.orgId, name: "Raw", description: "Anything" }).returning();
      const job = await S.enqueue(db, "icp.build", { icpId: icp.id }, { orgId: o.orgId });
      await S.runJobById(db, handlers, job.id);
      const [row] = await db.select().from(S.icps).where(S.eq(S.icps.id, icp.id));
      expect(row.aiProfile).toMatchObject({ status: "skipped", reason: "no_ai" });
    });
  });

  // ── 5. A play approval with a company name links the company ──
  describe("approving an uploaded person with a company name", () => {
    it("links the workspace's company of that name, so the lead has a company", async () => {
      const o = await signup("play-co");
      const tag = u8();
      await db.insert(S.companies).values({ orgId: o.orgId, domain: `widgets-${tag}.example`, name: `Acme Widgets ${tag}` });
      const play = await req("POST", "/v1/plays", o.token, { name: "Engaged", type: "engagers_upload", config: {} });
      expect(play.status, play.text).toBe(201);
      const up = await req("POST", `/v1/plays/${play.body.play.id}/upload`, o.token, { engagement: "commented", people: [{ fullName: "Jo Upload", companyName: `acme widgets ${tag}`, linkedinUrl: `https://www.linkedin.com/in/jo-${tag}` }, { fullName: "Lu Nowhere", companyName: `Unknown Co ${tag}`, linkedinUrl: `https://www.linkedin.com/in/lu-${tag}` }] });
      expect(up.status, up.text).toBe(200);
      const cands = await db.select().from(S.playCandidates).where(S.eq(S.playCandidates.playId, play.body.play.id));
      const pending = cands.filter((c: any) => c.status === "pending").map((c: any) => ({ id: c.id, decision: "approve" }));
      if (pending.length) expect((await req("POST", "/v1/plays/candidates/decide", o.token, { decisions: pending })).status).toBe(200);
      const leads = await db.select().from(S.leads).where(S.eq(S.leads.orgId, o.orgId));
      const jo = leads.find((l: any) => l.fullName === "Jo Upload");
      const [co] = await db.select().from(S.companies).where(S.eq(S.companies.id, jo.companyId));
      expect(co.domain).toBe(`widgets-${tag}.example`);
      // A name that cannot be placed (the lookup is offline here) keeps the name for templates.
      const lu = leads.find((l: any) => l.fullName === "Lu Nowhere");
      expect(lu.companyId).toBeNull();
      expect(lu.custom.company_name).toBe(`Unknown Co ${tag}`);
    });
  });

  // ── 6. Visibility suggestions without AI ──
  describe("visibility suggestions without AI", () => {
    it("never pastes the ICP description into a question, and says what the questions are", async () => {
      const o = await signup("vis");
      const desc = "B2B SaaS founders in India with 20-200 employees";
      await db.insert(S.icps).values({ orgId: o.orgId, name: "Main", description: desc, criteria: { titles: ["Founder"], industries: ["Fintech"] } });
      for (const ai of [false, true]) {
        const r = await req("POST", "/v1/visibility/prompts/suggest", o.token, { ai, category: "CRM software" });
        expect(r.status, r.text).toBe(200);
        expect(r.body.source).toBe("starter");
        expect(r.body.prompts.length).toBeGreaterThan(3);
        for (const p of r.body.prompts) expect(p.text).not.toContain(desc);
        expect(r.body.note).toBeTruthy();
      }
    });
  });

  // ── 8. Client pace from the day the client was added ──
  describe("client pace", () => {
    it("counts from the client's start day this month, and from the 1st otherwise", async () => {
      const { targetProgress } = await import("./services/clients.js");
      const stats = { deliveredThisMonth: 0 } as any;
      const now = new Date(Date.UTC(2026, 9, 14, 12));
      expect(targetProgress({ monthlyLeadTarget: 40, createdAt: new Date(Date.UTC(2026, 9, 14, 9)) }, stats, now)).toMatchObject({ expectedByNow: 0, onTrack: true });
      // 18 days from the 14th to the 31st; 4 of them gone by the 18th.
      expect(targetProgress({ monthlyLeadTarget: 36, createdAt: new Date(Date.UTC(2026, 9, 14)) }, stats, new Date(Date.UTC(2026, 9, 18)))!.expectedByNow).toBe(8);
      expect(targetProgress({ monthlyLeadTarget: 31, createdAt: new Date(Date.UTC(2026, 8, 3)) }, stats, now)!.expectedByNow).toBe(14);
      expect(targetProgress({ monthlyLeadTarget: 31 }, stats, now)!.expectedByNow).toBe(14);
    });

    it("a client created today is not behind", async () => {
      const o = await signup("pace");
      const r = await req("POST", "/v1/clients", o.token, { name: "New Client", monthlyLeadTarget: 100 });
      expect(r.status, r.text).toBe(201);
      const list = await req("GET", "/v1/clients", o.token);
      const c = list.body.clients.find((x: any) => x.name === "New Client");
      if (new Date().getUTCDate() > 1) expect(c.target).toMatchObject({ expectedByNow: 0, onTrack: true });
    });
  });
});
