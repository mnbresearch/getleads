/**
 * Plays end to end with the REAL engines.
 *
 * plays.test.ts replaces the engines to pin what the API does with findings. This file
 * replaces nothing: the engines in @prospex/core run as they are, through the real job
 * handler and the real routes, and the two halves have to agree - on what a finding looks
 * like, on the dedupe key, on what "blocked" means, on who meters a model call.
 *
 * Only the network is not real. `fetch` is a web that exists in memory:
 *   - a search provider (the Serper API, with a test key) answering from fixture results;
 *   - a competitor's site, job-board postings, a product site, a news feed;
 *   - an AI provider (the Groq API, only in the tests that set a key);
 * and anything else is "not found". Every request is recorded, so a test can say what was
 * NOT asked for. Nothing leaves the machine.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/plays.engines.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "plays_engines";

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
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_BASE_URL", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "APOLLO_API_KEY", "PDL_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE", "AI_PROVIDER", "DEBUG_SEARCH"]) delete process.env[k];
  // A keyed search source, so the search layer takes its ordinary path. The key is not real
  // and the host it would be sent to is answered below.
  process.env.SERPER_API_KEY = "serper-test-key-not-real";
}

vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: `t-${Date.now()}-${Math.random()}` })) };
});

if (!TEST_DB) {
  process.stderr.write(`\n[!] "plays with the real engines" did NOT run: TEST_DATABASE_URL is not set.\n    Run them with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npx vitest run src/plays.engines.test.ts\n`);
}

// ── The web that exists only in memory ──────────────────────────────────────────────────

type Hit = { title: string; url: string; snippet?: string };
const hit = (title: string, url: string, snippet = ""): Hit => ({ title, url, snippet });
const page = (title: string, body: string, head = ""): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** Acme, a competitor: a home page, a customers page with a logo wall, stories and a testimonial, and two case studies. */
const ACME_HOME = page("Acme - onboarding that runs itself", `<header><nav class="navbar"><a href="/"><img src="/img/acme-logo.svg" alt="Acme logo"></a><a href="/customers">Customers</a><a href="/pricing">Pricing</a></nav></header><main><section class="hero"><h1>Onboarding that runs itself</h1></section></main><footer>(c) Acme</footer>`);
const ACME_CUSTOMERS = page(
  "Customers | Acme",
  `
<header class="site-header"><nav class="navbar"><a href="/"><img src="/img/acme-logo.svg" alt="Acme logo"></a><a href="/product">Product</a><a href="/customers">Customers</a><a href="/pricing">Pricing</a></nav></header>
<main>
  <section class="hero"><h1>Our customers</h1><p>More than 4,000 teams run their onboarding on Acme.</p></section>
  <section class="logo-wall"><h2>Trusted by teams at</h2><ul class="logos">
    <li><img src="/logos/globex.svg" alt="Globex logo"></li>
    <li><img src="/logos/initech.svg" alt="Initech"></li>
    <li><a href="https://www.umbrellacorp.com/?utm_source=acme"><img src="/logos/umbrella.svg" alt="Umbrella Corp logo"></a></li>
    <li><img src="/logos/google.svg" alt="Google logo"></li>
  </ul></section>
  <section class="integrations"><h2>Integrates with the tools you already use</h2><div class="logos"><img src="/i/slack.svg" alt="Slack logo"><img src="/i/piedpiper.svg" alt="Pied Piper logo"></div></section>
  <section class="case-studies"><h2>Customer stories</h2>
    <article class="card"><img src="/logos/soylent.svg" alt="Soylent logo"><h3>How Soylent cut onboarding time by 40%</h3><a href="/customers/soylent">Read the story</a></article>
    <article class="card"><h3>Why Stark Industries chose Acme for 12,000 employees</h3><a href="/customers/stark-industries-case-study">Read the story</a></article>
  </section>
  <section class="testimonials"><figure><blockquote>Acme paid for itself in the first month.</blockquote><figcaption>Dana Scully, VP Operations at Oscorp</figcaption></figure></section>
</main>
<footer class="site-footer"><a href="https://www.linkedin.com/company/acme"><img src="/i/li.svg" alt="LinkedIn"></a><p>(c) Acme Inc.</p></footer>`,
);
/** A sentence only a reader of the prose would find a customer in - what the model is for. */
const PROSE_ONLY = "Cyberdyne Systems moved its 300 engineers onto Acme in the same quarter.";
const CASE_STUDY = (company: string, headline: string): string =>
  page(`${headline} | Acme`, `<nav><a href="/customers">Customers</a></nav><main><article><header><h1>${headline}</h1></header><p>${company} had a problem with onboarding. Then it found a better way, and the numbers followed within a quarter. ${PROSE_ONLY}</p></article></main><footer>(c) Acme</footer>`);

const ACME_SITE: Record<string, string> = {
  "https://acme.com": ACME_HOME,
  "https://acme.com/customers": ACME_CUSTOMERS,
  "https://acme.com/customers/soylent": CASE_STUDY("Soylent", "How Soylent cut onboarding time by 40%"),
  "https://acme.com/customers/stark-industries-case-study": CASE_STUDY("Stark Industries", "Why Stark Industries chose Acme for 12,000 employees"),
};

/** Onbordo, the customer's own product site: says what it is and who it compares itself with. */
const ONBORDO_SITE: Record<string, string> = {
  "https://onbordo.com": page(
    "Onbordo - Employee onboarding that runs itself",
    `<header><nav><a href="/">Onbordo</a><a href="/compare/onbordo-vs-acme">Onbordo vs Acme</a></nav></header><main><h1>Onboarding employees should not take a week</h1><p>Onbordo collects documents, orders equipment and schedules training for every new hire.</p><h2>The best alternative to Workbright</h2></main>`,
    `<meta name="description" content="Onbordo is an employee onboarding platform for fast-growing teams. Automate paperwork, equipment and training."><meta property="og:site_name" content="Onbordo">`,
  ),
  "https://onbordo.com/compare/onbordo-vs-acme": page("Onbordo vs Acme", `<main><h1>Onbordo vs Acme</h1><p>An honest comparison.</p></main>`),
};

const ROLE = "Sales Development Representative";
const POSTINGS: Record<string, string> = {
  "https://boards.greenhouse.io/globex/jobs/4012345": page(`Job Application for ${ROLE} at Globex`, `<main><h1>Job Application for ${ROLE} at Globex</h1><p>About the role.</p></main>`),
  "https://jobs.lever.co/umbrellacorp/1b2c3d4e-5f60-7a8b-9c0d-112233445566": page(`Umbrella Corp - ${ROLE} (Remote)`, `<main><h1>${ROLE} (Remote)</h1></main>`),
};

/** What a search engine returns, by what was asked. */
const SERP = {
  globexSite: [hit("Globex - logistics software", "https://www.globex.com/", "Globex builds logistics software."), hit("Globex - Wikipedia", "https://en.wikipedia.org/wiki/Globex")],
  globexPeople: [
    hit("Lena Fox - Account Executive - Globex | LinkedIn", "https://www.linkedin.com/in/lena-fox-99", "Austin, Texas, United States · Account Executive · Globex"),
    hit("Jane Doe - VP Sales - Globex | LinkedIn", "https://www.linkedin.com/in/jane-doe-1a2b3c", "Location: Austin, Texas · VP Sales at Globex"),
    hit("Sam Lee - VP Sales - Initech | LinkedIn", "https://uk.linkedin.com/in/sam-lee-77", "VP Sales at Initech. Previously Globex."),
    hit("Priya Shah - VP Sales - Globex Inc. | LinkedIn", "https://www.linkedin.com/in/priya-shah-4b6a2311", ""),
  ],
  greenhouse: [
    hit(`Job Application for ${ROLE} at Globex`, "https://boards.greenhouse.io/globex/jobs/4012345?gh_src=abc", "Globex is hiring an SDR to join our growing sales team in Austin."),
    hit("Jobs at Globex", "https://boards.greenhouse.io/globex", "Current openings at Globex"),
    hit("Job Application for Staff Accountant at Hooli", "https://boards.greenhouse.io/hooli/jobs/777123", "Hooli finance team"),
  ],
  lever: [hit(`Umbrella Corp - ${ROLE} (Remote)`, "https://jobs.lever.co/umbrellacorp/1b2c3d4e-5f60-7a8b-9c0d-112233445566", "Umbrella Corp is looking for...")],
  asks: [
    hit("Priya Shah on LinkedIn: Looking for an alternative to Acme - any recommendations? | 23 comments", "https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-hr-activity-7250011122233344455-AbCd", "We've outgrown Acme and I'm looking for an alternative to Acme that handles contractors. Any recommendations?"),
    hit("Rival HQ on LinkedIn: Top 10 alternatives to Acme in 2026", "https://www.linkedin.com/posts/rival-hq_top-10-alternatives-to-acme-activity-7250000000000000001-aaaa", "Looking for an alternative to Acme? Here are the 10 best options we tested."),
    hit("Looking for an alternative to Acme : r/humanresources", "https://www.reddit.com/r/humanresources/comments/1abc234/looking_for_an_alternative_to_acme/", "We're a 60 person company and Acme doubled our price. What are you all using instead?"),
    hit("Acme is too expensive now : r/smallbusiness", "https://www.reddit.com/r/smallbusiness/comments/1def567/acme_is_too_expensive_now/", "Acme is too expensive for what it does. Support is terrible and we are cancelling our plan next month."),
    hit("Acme Reviews 2026: Details, Pricing, & Features | G2", "https://www.g2.com/products/acme/reviews", "Frustrated with Acme? Read 1,203 reviews."),
  ],
};
const searchAnswer = (q: string): Hit[] => {
  if (/official website/i.test(q)) return /Globex/.test(q) ? SERP.globexSite : [];
  if (/site:linkedin\.com\/in\b/.test(q)) return /Globex/.test(q) ? SERP.globexPeople : [];
  if (/greenhouse\.io/.test(q)) return SERP.greenhouse;
  if (/jobs\.lever\.co/.test(q)) return SERP.lever;
  if (/Acme/.test(q)) {
    const site = /site:(\S+)/.exec(q)?.[1];
    return site ? SERP.asks.filter((x) => x.url.includes(site.replace(/^www\./, ""))) : SERP.asks;
  }
  return [];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ago = (days: number): Date => new Date(Date.now() - days * 86_400_000);
const newsItem = (title: string, source: string, id: string, days: number): string =>
  `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><guid isPermaLink="false">${id}</guid><pubDate>${ago(days).toUTCString()}</pubDate>` +
  `<description>&lt;a href="https://news.google.com/rss/articles/${id}"&gt;${title}&lt;/a&gt;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${source}&lt;/font&gt;</description><source url="https://example.test">${source}</source></item>`;
/** A news feed: one round reported twice, a round with no amount, and a headline that only sounds like funding. */
const newsFeed = (): string => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>news</title>
${newsItem("Globex raises $12M Series A to expand its logistics platform", "TechCrunch", "CBMiGLOBEX1", 4)}
${newsItem("Globex secures $12 million in Series A funding led by Lightspeed", "VentureBeat", "CBMiGLOBEX2", 3)}
${newsItem("Initech raises Series B to double its engineering team", "Reuters", "CBMiINITECH", 6)}
${newsItem("Vandelay raises concerns over funding round delays", "Business Daily", "CBMiVANDELAY", 1)}
</channel></rss>`;

const net = {
  calls: [] as { url: string; host: string; body: string }[],
  pages: {} as Record<string, string>,
  /** False: the search source answers 503, and the fallback sources cannot be reached. */
  searchUp: true,
  queries: [] as string[],
  feed: null as string | null,
  /** The model's answer for a prompt; null means no AI provider should ever be asked. */
  ai: null as null | ((prompt: string) => unknown),
};
const resetNet = () => {
  net.calls = [];
  net.pages = {};
  net.searchUp = true;
  net.queries = [];
  net.feed = null;
  net.ai = null;
};
const keyOf = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");
const html = (body: string, status = 200, type = "text/html; charset=utf-8", url?: string): Response => {
  const res = new Response(body, { status, headers: { "content-type": type } });
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
};
const fakeFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as { url: string }).url);
  const host = new URL(url).hostname;
  const body = typeof init?.body === "string" ? init.body : "";
  net.calls.push({ url, host, body });
  if (host === "google.serper.dev") {
    if (!net.searchUp) return html("upstream unavailable", 503, "text/plain");
    const q = String((JSON.parse(body) as { q?: unknown }).q ?? "");
    net.queries.push(q);
    return html(JSON.stringify({ organic: searchAnswer(q).map((r) => ({ title: r.title, link: r.url, snippet: r.snippet })) }), 200, "application/json");
  }
  if (host === "api.groq.com") {
    if (!net.ai) throw new Error("plays.engines: an AI provider was called in a test that has none");
    return html(JSON.stringify({ choices: [{ message: { content: JSON.stringify(net.ai(body)) } }] }), 200, "application/json");
  }
  if (host === "news.google.com") return net.feed ? html(net.feed, 200, "application/rss+xml", url) : html("Not found", 404, "text/plain", url);
  // The keyless fallbacks (and anything else that is not part of this web) are unreachable.
  if (/duckduckgo\.com$|bing\.com$/.test(host)) throw new TypeError("fetch failed");
  const found = net.pages[keyOf(url)];
  return found === undefined ? html("Not found", 404, "text/plain", url) : html(found, 200, "text/html; charset=utf-8", url);
}) as typeof fetch;

const suite = TEST_DB ? describe : describe.skip;

suite("plays with the real engines", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let db: any;
  let S: any;
  let core: any;
  let handlers: any;
  const realFetch = globalThis.fetch;
  const PASSWORD = "correct-horse-battery";
  type Org = { token: string; orgId: string; userId: string };

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
  async function signup(name: string, patch: Record<string, unknown> = {}): Promise<Org> {
    const r = await req("POST", "/v1/auth/signup", null, { email: `${name}-${u8()}@example.com`, password: PASSWORD, orgName: `${name} ${u8()}` });
    expect(r.status).toBe(201);
    await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale"), ...patch }).where(S.eq(S.organizations.id, r.body.org.id));
    return { token: r.body.token, orgId: r.body.org.id, userId: r.body.user.id };
  }
  const usageOf = async (orgId: string, metric: string) => (await db.select().from(S.usage).where(S.and(S.eq(S.usage.orgId, orgId), S.eq(S.usage.metric, metric))))[0]?.count ?? 0;
  const setLimits = (orgId: string, limits: Record<string, number>) => db.update(S.organizations).set({ planLimits: { ...S.limitsFor("scale"), ...limits } }).where(S.eq(S.organizations.id, orgId));
  const leadsOf = (orgId: string) => db.select().from(S.leads).where(S.eq(S.leads.orgId, orgId));
  const candidatesOf = (playId: string) => db.select().from(S.playCandidates).where(S.eq(S.playCandidates.playId, playId));
  const jobsOf = (orgId: string, type: string) => db.select().from(S.jobs).where(S.and(S.eq(S.jobs.orgId, orgId), S.eq(S.jobs.type, type)));
  const jobCtx = () => ({ db, log: () => {}, progress: async () => {} });
  const aiCalls = () => net.calls.filter((c) => /groq|generativelanguage|anthropic|openai/.test(c.host));
  const hosts = () => [...new Set(net.calls.map((c) => c.host))].sort();
  /** Hosts asked for a PAGE: everything except the search source and the fallbacks it tries when a search comes back thin. */
  const pageHosts = () => hosts().filter((h) => !/^google\.serper\.dev$|duckduckgo\.com$|bing\.com$/.test(h));

  async function mkPlay(o: Org, body: Record<string, unknown>) {
    const r = await req("POST", "/v1/plays", o.token, body);
    expect(r.status, r.text).toBe(201);
    return r.body.play as any;
  }
  /** Press Run, then do the job the route queued - the real handler, the real engine. */
  async function run(o: Org, playId: string) {
    const r = await req("POST", `/v1/plays/${playId}/run`, o.token, {});
    expect(r.status, r.text).toBe(202);
    await S.runJobById(db, handlers, r.body.jobId);
    const [row] = await db.select().from(S.playRuns).where(S.eq(S.playRuns.id, r.body.runId));
    const [job] = await db.select().from(S.jobs).where(S.eq(S.jobs.id, r.body.jobId));
    return { run: row, job };
  }
  const ACME = { competitors: [{ name: "Acme", domain: "acme.com" }] };

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
    vi.stubGlobal("fetch", fakeFetch);
    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    db = S.getDb().db;
    core = await import("@prospex/core");
    ({ handlers } = await import("./jobs.js"));
    const { createApp } = await import("./app.js");
    app = createApp();
  }, 120_000);

  beforeEach(() => {
    resetNet();
    // What the search layer remembers between calls: answers, and sources it is avoiding.
    core.resetSearchCache();
    core.resetProviderSkips();
    core.resetSerperQueryRestriction();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    vi.restoreAllMocks();
  });
  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  it("uses the engines @prospex/core exports - nothing is replaced in this file", async () => {
    const engines = await import("./services/playEngines.js");
    // The seam's functions call straight through to core: a finding made by core's own
    // helper comes back with core's key, prefix and all.
    expect(engines.playEngines().playDedupeKey({ kind: "company", companyName: "Globex Inc.", relevantBecause: "x", signalType: "x", confidence: 1 })).toBe(core.playDedupeKey({ kind: "company", companyName: "Globex Inc.", relevantBecause: "x", signalType: "x", confidence: 1 }));
    expect(core.playDedupeKey({ kind: "company", companyName: "Globex Inc.", relevantBecause: "x", signalType: "x", confidence: 1 })).toBe("cn:globex");
    expect(engines.playEngines().mailSafeReason("Customer of Booking.com, see https://x.example/a")).toBe(core.mailSafeReason("Customer of Booking.com, see https://x.example/a"));
  });

  // ── 1. A competitor's customers, all the way to a campaign ─────────────────────────
  describe("competitor customers", () => {
    it("reads the competitor's site into company candidates with the page that shows each one - then people, a lead, and the campaign", async () => {
      const o = await signup("eng-competitor");
      net.pages = { ...ACME_SITE };
      const [campaign] = await db.insert(S.campaigns).values({ orgId: o.orgId, name: "Outbound" }).returning();
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME, campaignId: campaign.id });

      const { run: r, job } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 6, added: 6, duplicates: 0, error: null });
      expect(job).toMatchObject({ status: "done", result: { status: "done", found: 6, added: 6, duplicates: 0 } });
      // Only the competitor's own site was asked for anything: no search, no model, no other host.
      expect(hosts()).toEqual(["acme.com"]);
      expect(net.calls.length).toBeLessThanOrEqual(12);
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
      expect(await leadsOf(o.orgId)).toEqual([]);

      const list = await req("GET", `/v1/plays/candidates?playId=${play.id}`, o.token);
      expect(list.body).toMatchObject({ total: 6, counts: { pending: 6, approved: 0, skipped: 0 } });
      const by = Object.fromEntries(list.body.candidates.map((c: any) => [c.companyName, c]));
      expect(Object.keys(by).sort()).toEqual(["Globex", "Initech", "Oscorp", "Soylent", "Stark Industries", "Umbrella Corp"]);
      expect(by.Soylent).toMatchObject({
        kind: "company",
        status: "pending",
        relevantBecause: 'Named as a customer of Acme in their case study "How Soylent cut onboarding time by 40%".',
        evidenceUrl: "https://acme.com/customers",
        evidenceTitle: "How Soylent cut onboarding time by 40%",
        evidenceQuote: "How Soylent cut onboarding time by 40%",
        signalType: "competitor_customer",
        leadId: null,
        alreadyLead: false,
      });
      expect(by.Soylent.confidence).toBeCloseTo(0.9, 5);
      expect(by.Globex).toMatchObject({ relevantBecause: "Shown as a customer of Acme on their customers page.", evidenceUrl: "https://acme.com/customers", evidenceTitle: "Trusted by teams at", evidenceQuote: "Globex logo", companyDomain: null });
      expect(by["Umbrella Corp"]).toMatchObject({ companyDomain: "umbrellacorp.com", evidenceQuote: "Umbrella Corp logo" });
      expect(by.Oscorp).toMatchObject({ relevantBecause: "Quoted as a customer of Acme on their website.", evidenceQuote: "Dana Scully, VP Operations at Oscorp" });
      // Every reason is one line with no link; every proof is a page that was actually read.
      for (const c of list.body.candidates) {
        expect(c.relevantBecause).not.toMatch(/https?:|www\.|[\r\n]/);
        expect(net.calls.map((x) => x.url)).toContain(c.evidenceUrl);
      }
      // The keys are core's: a company by its domain, or by its name when no domain is known.
      const keys = Object.fromEntries((await candidatesOf(play.id)).map((c: any) => [c.companyName, c.dedupeKey]));
      expect(keys).toMatchObject({ Globex: "cn:globex", "Umbrella Corp": "co:umbrellacorp.com", "Stark Industries": "cn:starkindustries" });

      // Run it again: the same site, nobody twice.
      expect((await run(o, play.id)).run).toMatchObject({ status: "done", found: 6, added: 0, duplicates: 6 });

      // ── Find people at one company: the search finds the company's site, then its people ──
      net.calls = [];
      const fp = await req("POST", `/v1/plays/candidates/${by.Globex.id}/find-people`, o.token, { titles: ["VP Sales"], limit: 2 });
      expect(fp.status, fp.text).toBe(200);
      expect(net.queries).toEqual(['"Globex"  official website', 'site:linkedin.com/in "VP Sales" "Globex"']);
      // Search only: no profile, no company site and no other page was fetched to find them.
      expect(pageHosts()).toEqual([]);
      expect(fp.body.added).toBe(2);
      expect(fp.body.candidates.map((c: any) => c.fullName).sort()).toEqual(["Jane Doe", "Priya Shah"]);
      const jane = fp.body.candidates.find((c: any) => c.fullName === "Jane Doe");
      // The person carries the COMPANY's reason and proof; nothing about her is made up (no address).
      expect(jane).toMatchObject({
        playId: play.id,
        kind: "person",
        status: "pending",
        firstName: "Jane",
        lastName: "Doe",
        title: "VP Sales",
        linkedinUrl: "https://www.linkedin.com/in/jane-doe-1a2b3c",
        location: "Austin, Texas",
        email: null,
        companyName: "Globex",
        companyDomain: "globex.com",
        relevantBecause: "Shown as a customer of Acme on their customers page.",
        evidenceUrl: "https://acme.com/customers",
        evidenceQuote: "Globex logo",
        signalType: "competitor_customer",
      });
      expect((await candidatesOf(play.id)).find((c: any) => c.id === jane.id).dedupeKey).toBe("li:jane-doe-1a2b3c");
      expect(await usageOf(o.orgId, "searches")).toBe(3);
      // Asking again adds nobody twice.
      expect((await req("POST", `/v1/plays/candidates/${by.Globex.id}/find-people`, o.token, { titles: ["VP Sales"], limit: 2 })).body).toMatchObject({ added: 0 });

      // ── Approve her: a lead with the play's marks and the reason, safe for an email ──
      const d = await req("POST", "/v1/plays/candidates/decide", o.token, { decisions: [{ id: jane.id, decision: "approve" }, { id: by.Soylent.id, decision: "skip", skipReason: "Already a customer" }], enroll: true });
      expect(d.body).toMatchObject({ approved: 1, skipped: 1, leadsCreated: 1, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 1, notApplied: [], applied: [jane.id, by.Soylent.id] });
      const [lead] = await leadsOf(o.orgId);
      expect(lead).toMatchObject({ fullName: "Jane Doe", title: "VP Sales", linkedinUrl: "https://www.linkedin.com/in/jane-doe-1a2b3c", email: null, source: "play:competitor_customers" });
      expect(lead.tags).toEqual(["play", `play:${play.id.slice(0, 8)}`]);
      expect(lead.custom).toEqual({ relevant_because: "Shown as a customer of Acme on their customers page.", play_id: play.id, play_name: "Acme's customers", evidence_url: "https://acme.com/customers" });
      const [company] = await db.select().from(S.companies).where(S.eq(S.companies.id, lead.companyId));
      expect(company).toMatchObject({ domain: "globex.com", name: "Globex" });
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect(core.renderTemplate("{{first_name}}, {{relevant_because}}", core.leadVars({ ...lead, company: null }, { name: "Sam", company: "Onbordo" }))).toBe("Jane, Shown as a customer of Acme on their customers page.");

      // ── The campaign: she has no address yet, so a lookup is queued; with one, she is enrolled ──
      const contacts = () => db.select().from(S.campaignContacts).where(S.eq(S.campaignContacts.campaignId, campaign.id));
      expect(await contacts()).toEqual([]);
      const [enrolJob] = await jobsOf(o.orgId, "play.enroll");
      expect(enrolJob.payload).toEqual({ playId: play.id, campaignId: campaign.id, leadIds: [lead.id] });
      expect(await handlers["play.enroll"]({ ...enrolJob, attempts: 1 }, jobCtx())).toEqual({ lookupsQueued: 1, lookupsAlreadyUnderWay: 0, toEnroll: 1 });
      const lookups = await jobsOf(o.orgId, "lead.enrich");
      expect(lookups.map((j: any) => j.payload)).toEqual([{ leadId: lead.id }]);
      // (The lookup itself is the ordinary enrichment job, with its own tests. Here: it found her address.)
      await db.update(S.jobs).set({ status: "done" }).where(S.eq(S.jobs.id, lookups[0].id));
      await db.update(S.leads).set({ email: `jane.doe-${u8()}@globex.com`, emailStatus: "valid" }).where(S.eq(S.leads.id, lead.id));
      const followUp = (await jobsOf(o.orgId, "play.enroll")).find((j: any) => j.payload.lookedUp === true);
      expect(await handlers["play.enroll"]({ ...followUp, attempts: 1 }, jobCtx())).toEqual({ enrolled: 1, withoutAddress: 0, invalidAddress: 0, ownedByAnotherClient: 0 });
      expect((await contacts()).map((c: any) => [c.leadId, c.status])).toEqual([[lead.id, "queued"]]);
      // Enrolled, not sent: the campaign is still a draft and no message exists.
      expect((await db.select().from(S.campaigns).where(S.eq(S.campaigns.id, campaign.id)))[0].status).toBe("draft");
      expect((await db.select().from(S.messages).where(S.eq(S.messages.orgId, o.orgId))).length).toBe(0);
      expect(aiCalls()).toEqual([]);
    });

    it("a play that names who to look for turns its companies into people within the run, and never searches a company twice", async () => {
      const o = await signup("eng-people");
      net.pages = { ...ACME_SITE };
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME, targetTitles: ["VP Sales"] });
      const { run: r } = await run(o, play.id);
      expect(r.status).toBe("done");
      const all = await candidatesOf(play.id);
      const people = all.filter((c: any) => c.kind === "person");
      // Globex is the one company the search could place people at; they carry Globex's reason and proof.
      expect(people.map((c: any) => c.fullName).sort()).toEqual(["Jane Doe", "Lena Fox", "Priya Shah"]);
      for (const p of people) expect(p).toMatchObject({ companyName: "Globex", companyDomain: "globex.com", relevantBecause: "Shown as a customer of Acme on their customers page.", evidenceUrl: "https://acme.com/customers", signalType: "competitor_customer", email: null });
      // The others stay companies a reviewer can press "Find people" on - and Globex itself is not also listed.
      expect(all.filter((c: any) => c.kind === "company").map((c: any) => c.companyName).sort()).toEqual(["Initech", "Oscorp", "Soylent", "Stark Industries", "Umbrella Corp"]);
      expect(r).toMatchObject({ found: 8, added: 8 });
      // Six companies, each searched: a site lookup where none was known, then one search per title.
      expect(net.queries.filter((q) => /site:linkedin\.com\/in/.test(q)).length).toBe(6);
      expect(net.queries.length).toBeLessThanOrEqual(6 * 11);
      // One search unit for the run, however many searches it took.
      expect(await usageOf(o.orgId, "searches")).toBe(1);

      // The next run reads the site again and asks the search for nothing: every company is known.
      net.queries = [];
      const again = (await run(o, play.id)).run;
      expect(again).toMatchObject({ status: "done", added: 0 });
      expect(net.queries).toEqual([]);
      expect((await candidatesOf(play.id)).length).toBe(8);
    });

    it("when the people search cannot run, the companies are kept and the note says so - it is not a blocked run", async () => {
      const o = await signup("eng-people-down");
      net.pages = { ...ACME_SITE };
      net.searchUp = false;
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME, targetTitles: ["VP Sales"] });
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 6, added: 6 });
      expect(r.note).toContain("The people search could not run for 6 companies; they are listed as companies instead.");
      expect((await candidatesOf(play.id)).every((c: any) => c.kind === "company")).toBe(true);
      // The site was read, so the run did look: the search unit is kept.
      expect(await usageOf(o.orgId, "searches")).toBe(1);
    });

    it("a site that cannot be read is a blocked run with a sentence, and costs nothing", async () => {
      const o = await signup("eng-unread");
      // No pages at all: every address on acme.com answers "not found".
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME });
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "blocked", found: 0, added: 0 });
      expect(r.note).toMatch(/could not be read|could be read/);
      expect(r.note).not.toMatch(/Nothing was found/);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect((await req("GET", `/v1/plays/${play.id}`, o.token)).body.play).toMatchObject({ running: false, lastResult: { status: "blocked", found: 0 } });
    });
  });

  // ── 2. Hiring ──────────────────────────────────────────────────────────────────────
  describe("hiring for a role", () => {
    it("finds companies with an open posting, each with the posting as proof", async () => {
      const o = await signup("eng-hiring");
      net.pages = { ...POSTINGS };
      const play = await mkPlay(o, { name: "Hiring SDRs", type: "hiring_role", config: { roles: [ROLE] } });
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 2, added: 2 });
      const by = Object.fromEntries((await candidatesOf(play.id)).map((c: any) => [c.companyName, c]));
      expect(by.Globex).toMatchObject({
        kind: "company",
        relevantBecause: `Hiring a ${ROLE} - open posting on Greenhouse.`,
        evidenceUrl: "https://boards.greenhouse.io/globex/jobs/4012345",
        evidenceTitle: ROLE,
        evidenceQuote: ROLE,
        signalType: "job_posting",
        signalAt: null,
        dedupeKey: "cn:globex",
      });
      expect(by["Umbrella Corp"]).toMatchObject({ relevantBecause: `Hiring a ${ROLE} (Remote) - open posting on Lever.`, evidenceUrl: "https://jobs.lever.co/umbrellacorp/1b2c3d4e-5f60-7a8b-9c0d-112233445566" });
      // "Open" is only said of a posting that was opened: each one was fetched, once.
      for (const url of Object.keys(POSTINGS)) expect(net.calls.filter((c) => c.url === url).length).toBe(1);
      // The job boards were searched; the role is in every query and nothing else of the play is.
      expect(net.queries.length).toBeGreaterThan(3);
      for (const q of net.queries) expect(q).toContain(ROLE);
      expect(aiCalls()).toEqual([]);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
    });

    it("when no search source answers, the run is blocked with a sentence - never an empty result - and the search unit is given back", async () => {
      const o = await signup("eng-search-down");
      net.searchUp = false;
      const play = await mkPlay(o, { name: "Hiring SDRs", type: "hiring_role", config: { roles: [ROLE] } });
      const { run: r, job } = await run(o, play.id);
      expect(r).toMatchObject({ status: "blocked", found: 0, added: 0, duplicates: 0 });
      expect(r.note).toBe("Every search failed, so nothing could be checked this time. This is not a result about your market - try again later.");
      expect(job.status).toBe("done");
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      expect(await candidatesOf(play.id)).toEqual([]);
      const seen = await req("GET", `/v1/plays/${play.id}`, o.token);
      expect(seen.body.play.lastResult).toEqual({ status: "blocked", found: 0, added: 0, duplicates: 0, note: r.note });
      expect(seen.text).not.toMatch(/SERPER|serper-test-key|503/);

      // The same for conversations, which are search and nothing else.
      const asks = await mkPlay(o, { name: "Leaving Acme", type: "public_asks", config: { competitors: ["Acme"] } });
      const blockedAsks = (await run(o, asks.id)).run;
      expect(blockedAsks.status).toBe("blocked");
      expect(blockedAsks.note.startsWith(r.note)).toBe(true);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
      // And once the source is back, the same play finds what is there.
      net.searchUp = true;
      net.pages = { ...POSTINGS };
      core.resetProviderSkips();
      expect((await run(o, play.id)).run).toMatchObject({ status: "done", added: 2 });
    });
  });

  // ── 3. Funding ─────────────────────────────────────────────────────────────────────
  describe("just raised funding", () => {
    it("turns headlines into one finding per company, saying an amount and a round only when the headline does", async () => {
      const o = await signup("eng-funding");
      net.feed = newsFeed();
      const play = await mkPlay(o, { name: "Just raised", type: "funding", config: {} });
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 2, added: 2 });
      expect(r.note).toContain("1 repeat report of the same funding round was merged.");
      const by = Object.fromEntries((await candidatesOf(play.id)).map((c: any) => [c.companyName, c]));
      expect(Object.keys(by).sort()).toEqual(["Globex", "Initech"]);
      const on = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      expect(by.Globex).toMatchObject({
        kind: "company",
        relevantBecause: `Raised $12M Series A, reported by TechCrunch on ${on(ago(4))}.`,
        evidenceUrl: "https://news.google.com/rss/articles/CBMiGLOBEX1?oc=5",
        evidenceTitle: "Globex raises $12M Series A to expand its logistics platform",
        evidenceQuote: "Globex raises $12M Series A to expand its logistics platform",
        signalType: "funding",
      });
      expect(Math.abs(by.Globex.signalAt.getTime() - ago(4).getTime())).toBeLessThan(120_000);
      // No amount in the headline: none in the reason.
      expect(by.Initech.relevantBecause).toBe(`Raised a Series B round, reported by Reuters on ${on(ago(6))}.`);
      expect(hosts()).toEqual(["news.google.com"]);
      // The play's default country is passed through to the news source.
      expect(net.calls.every((c) => /[?&]gl=US(&|$)/.test(c.url))).toBe(true);
      expect(aiCalls()).toEqual([]);
    });

    it("a news source that does not answer is a blocked run, not 'no funding this week'", async () => {
      const o = await signup("eng-funding-down");
      const play = await mkPlay(o, { name: "Just raised", type: "funding", config: {} });
      const { run: r } = await run(o, play.id);
      expect(r.status).toBe("blocked");
      expect(r.note).toMatch(/news source did not answer/);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
    });
  });

  // ── 4. Public asks ─────────────────────────────────────────────────────────────────
  describe("asking in public", () => {
    it("a LinkedIn author becomes a person and a Reddit thread a conversation; approving gives a lead and a task", async () => {
      const o = await signup("eng-asks");
      const play = await mkPlay(o, { name: "Leaving Acme", type: "public_asks", config: { competitors: ["Acme"], sources: ["linkedin", "reddit"] } });
      const { run: r } = await run(o, play.id);
      expect(r).toMatchObject({ status: "done", found: 3, added: 3 });
      // Search results only: no post, profile or thread was fetched, and no site was signed in to.
      expect(pageHosts()).toEqual([]);
      expect(net.calls.some((c) => /linkedin\.com$|reddit\.com$/.test(c.host))).toBe(false);

      const all = await candidatesOf(play.id);
      const priya = all.find((c: any) => c.kind === "person");
      expect(priya).toMatchObject({
        fullName: "Priya Shah",
        firstName: "Priya",
        lastName: "Shah",
        linkedinUrl: "https://www.linkedin.com/in/priya-shah-4b6a2311",
        email: null,
        relevantBecause: "Asked on LinkedIn for an alternative to Acme.",
        evidenceUrl: "https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-hr-activity-7250011122233344455-AbCd",
        signalType: "public_ask",
        dedupeKey: "li:priya-shah-4b6a2311",
      });
      const posts = all.filter((c: any) => c.kind === "post");
      const thread = posts.find((c: any) => c.signalType === "public_ask");
      expect(thread).toMatchObject({
        fullName: null,
        linkedinUrl: null,
        email: null,
        companyName: null,
        relevantBecause: "Reddit thread asking for an alternative to Acme.",
        evidenceUrl: "https://www.reddit.com/r/humanresources/comments/1abc234/looking_for_an_alternative_to_acme/",
        evidenceTitle: "Looking for an alternative to Acme",
        evidenceQuote: "What are you all using instead?",
        dedupeKey: "ev:reddit.com/r/humanresources/comments/1abc234/looking_for_an_alternative_to_acme",
      });
      expect(posts.find((c: any) => c.signalType === "public_complaint")).toMatchObject({ relevantBecause: "Reddit thread complaining about Acme." });
      // The vendor's listicle and the review site are not conversations: not candidates.
      expect(JSON.stringify(all)).not.toMatch(/rival-hq|g2\.com/);

      const d = await req("POST", "/v1/plays/candidates/decide", o.token, { decisions: [{ id: priya.id, decision: "approve" }, { id: thread.id, decision: "approve" }] });
      expect(d.body).toMatchObject({ approved: 2, leadsCreated: 1, leadsExisting: 0, tasksCreated: 1, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [priya.id, thread.id] });
      const leads = await leadsOf(o.orgId);
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({ fullName: "Priya Shah", linkedinUrl: "https://www.linkedin.com/in/priya-shah-4b6a2311", source: "play:public_asks", email: null });
      expect(leads[0].custom).toMatchObject({ relevant_because: "Asked on LinkedIn for an alternative to Acme.", play_id: play.id, evidence_url: priya.evidenceUrl });
      const tasks = await db.select().from(S.tasks).where(S.eq(S.tasks.orgId, o.orgId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "reply_public", title: "Answer this conversation", leadId: null, body: `Reddit thread asking for an alternative to Acme.\n${thread.evidenceUrl}` });
      expect(await usageOf(o.orgId, "leads")).toBe(1);
      expect(aiCalls()).toEqual([]);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
    });
  });

  // ── 4b. An uploaded list ───────────────────────────────────────────────────────────
  describe("people who engaged", () => {
    it("an uploaded list becomes candidates with the post as proof; unusable rows come back by number with the engine's own reason", async () => {
      const o = await signup("eng-upload");
      const tag = u8();
      const play = await mkPlay(o, { name: "Launch post", type: "engagers_upload", config: {} });
      const postUrl = "https://www.linkedin.com/posts/onbordo_launch-activity-7250000000000000009-zzzz";
      const r = await req("POST", `/v1/plays/${play.id}/upload`, o.token, {
        engagement: "commented",
        postUrl,
        postTitle: "Why onboarding takes too long",
        people: [
          { linkedinUrl: `linkedin.com/in/ann-${tag}`, fullName: "Ann Lee", title: "Head of People", companyName: "Globex" },
          { email: `Bob.${tag}@Initech.example` },
          { fullName: "Cy Young", companyName: "Hooli", note: "Great point about paperwork." },
          { linkedinUrl: "https://www.linkedin.com/company/globex" },
          { email: "not an address" },
          { fullName: "Only A Name" },
          { linkedinUrl: `https://www.linkedin.com/in/ann-${tag}/` },
        ],
      });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ added: 3, duplicates: 1, rejectedCount: 3 });
      // Row numbers are the uploader's own (the first row is 1), and the reason is the one the engine gave.
      expect(r.body.rejected).toEqual([
        { row: 4, reason: "The LinkedIn link is not a profile link (it should look like linkedin.com/in/name)." },
        { row: 5, reason: "The email address is not valid." },
        { row: 6, reason: "Needs a LinkedIn profile link, an email address, or a name with a company." },
      ]);
      expect(r.body.run).toMatchObject({ status: "done", trigger: "upload", found: 7, added: 3, duplicates: 1 });
      const all = await candidatesOf(play.id);
      for (const c of all) expect(c).toMatchObject({ kind: "person", status: "pending", relevantBecause: 'Commented on the post "Why onboarding takes too long".', evidenceUrl: postUrl, evidenceTitle: "Why onboarding takes too long", signalType: "post_engagement" });
      const by = Object.fromEntries(all.map((c: any) => [c.dedupeKey, c]));
      expect(Object.keys(by).sort()).toEqual([`em:bob.${tag}@initech.example`, `li:ann-${tag}`, "pn:cy young@hooli"].sort());
      expect(by[`li:ann-${tag}`]).toMatchObject({ fullName: "Ann Lee", title: "Head of People", companyName: "Globex", linkedinUrl: `https://www.linkedin.com/in/ann-${tag}` });
      expect(by["pn:cy young@hooli"].evidenceQuote).toBe("Great point about paperwork.");
      // Nothing was fetched or searched, nobody became a lead, and no search unit was used.
      expect(net.calls).toEqual([]);
      expect(await leadsOf(o.orgId)).toEqual([]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);

      // Only the post link: Scout asks LinkedIn for the public page once, without signing in.
      // Here it is not publicly readable, and the answer says so instead of pretending nobody engaged.
      const only = await req("POST", `/v1/plays/${play.id}/upload`, o.token, { engagement: "reacted", postUrl });
      expect(only.status).toBe(200);
      expect(only.body).toMatchObject({ added: 0, rejectedCount: 0, run: { status: "blocked", found: 0 } });
      expect(only.body.run.note).toMatch(/did not show that post without signing in/);
      expect(net.calls.map((c) => c.host)).toEqual(["www.linkedin.com"]);
      expect(await usageOf(o.orgId, "searches")).toBe(0);
    });
  });

  // ── 5. Planning ────────────────────────────────────────────────────────────────────
  describe("planning from a website", () => {
    it("reads the product's own site and suggests plays that can be created as offered - with no model, by rules", async () => {
      const o = await signup("eng-plan");
      net.pages = { ...ONBORDO_SITE };
      const r = await req("POST", "/v1/plays/plan", o.token, { website: "https://www.onbordo.com/pricing?x=1" });
      expect(r.status, r.text).toBe(200);
      expect(r.body.product).toEqual({ domain: "onbordo.com", name: "Onbordo", description: "Onbordo is an employee onboarding platform for fast-growing teams. Automate paperwork, equipment and training." });
      expect(r.body.competitors).toEqual([{ name: "Acme", source: "site" }, { name: "Workbright", source: "site" }]);
      expect(r.body.titles).toEqual(["Chief People Officer", "VP People", "Head of HR", "Head of Talent", "HR Director"]);
      expect(r.body.icp).toEqual({ titles: r.body.titles });
      expect(r.body.notes).toEqual([]);
      expect(r.body.plays.map((p: any) => p.type)).toEqual(["competitor_customers", "hiring_role", "public_asks", "funding"]);
      const by = Object.fromEntries(r.body.plays.map((p: any) => [p.type, p]));
      expect(by.competitor_customers).toMatchObject({ name: "Customers of Acme and Workbright", config: { competitors: [{ name: "Acme" }, { name: "Workbright" }] }, available: true });
      expect(by.hiring_role.config).toEqual({ roles: ["Recruiter", "HR Manager", "People Operations Manager"] });
      expect(by.public_asks.config).toEqual({ competitors: ["Acme", "Workbright"], category: "employee onboarding platform", sources: ["linkedin", "reddit", "hackernews", "forums"] });
      expect(by.funding.config).toEqual({ days: 14 });
      for (const p of r.body.plays) {
        expect(p.why.length).toBeGreaterThan(20);
        expect(p.targetTitles).toEqual(r.body.titles);
      }
      // Only the product's own site was read; nothing was saved; one search unit; no model.
      expect(hosts()).toEqual(["onbordo.com"]);
      expect((await db.select().from(S.plays).where(S.eq(S.plays.orgId, o.orgId))).length).toBe(0);
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
      expect(aiCalls()).toEqual([]);
      // Each suggestion is accepted by POST /v1/plays exactly as it was offered.
      for (const p of r.body.plays) expect([p.type, (await req("POST", "/v1/plays", o.token, { name: p.name, type: p.type, config: p.config, targetTitles: p.targetTitles })).status]).toEqual([p.type, 201]);
    });

    it("a site that cannot be read still answers, says so, and offers only what needs no site", async () => {
      const o = await signup("eng-plan-unread");
      const r = await req("POST", "/v1/plays/plan", o.token, { website: "nowhere-onbordo.com" });
      expect(r.status).toBe(200);
      expect(r.body.notes[0]).toMatch(/could not be read/);
      expect(r.body.product).toEqual({ domain: "nowhere-onbordo.com" });
      expect(r.body.plays.map((p: any) => p.type)).toEqual(["funding"]);
    });
  });

  // ── 6. AI: never without a provider, and one charge per call with one ───────────────
  describe("AI", () => {
    /** The model: answers the customers question with one name the page backs up and one it does not. */
    const customersModel = () => ({ customers: [{ name: "Cyberdyne Systems", quote: PROSE_ONLY }, { name: "Phantom Corp", quote: "Phantom Corp loves Acme" }] });

    it("with a provider, each model call is one AI message - and a name the page does not back up is dropped", async () => {
      const o = await signup("eng-ai");
      process.env.GROQ_API_KEY = "gsk_test_key_not_real";
      net.pages = { ...ACME_SITE };
      net.ai = customersModel;
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME });
      const { run: r } = await run(o, play.id);
      expect(r.status).toBe("done");
      const calls = aiCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.length).toBeLessThanOrEqual(3);
      // One AI message per call that reached the model: no more, no fewer.
      expect(await usageOf(o.orgId, "aiMessages")).toBe(calls.length);
      // What the page says goes to the model fenced as data; the play's own settings are not instructions either.
      expect(calls[0].body).toContain("UNTRUSTED_DATA");
      const by = Object.fromEntries((await candidatesOf(play.id)).map((c: any) => [c.companyName, c]));
      expect(by["Cyberdyne Systems"]).toMatchObject({ kind: "company", evidenceQuote: PROSE_ONLY, signalType: "competitor_customer" });
      // A fact a model helped establish is never shown as more certain than 0.7.
      expect(by["Cyberdyne Systems"].confidence).toBeLessThanOrEqual(0.7);
      expect(by["Phantom Corp"]).toBeUndefined();
      expect(r.note).toMatch(/suggested by AI for Acme (was|were) left out because the page did not back/);
      // The rules still found what the rules find.
      expect(by.Globex.evidenceQuote).toBe("Globex logo");
      expect(await usageOf(o.orgId, "searches")).toBe(1);
    });

    it("stops at the workspace's AI allowance: the model is not asked again, nothing more is charged, and the run finishes by rules", async () => {
      const o = await signup("eng-ai-cap");
      process.env.GROQ_API_KEY = "gsk_test_key_not_real";
      await setLimits(o.orgId, { aiMessagesPerMonth: 1 });
      net.pages = { ...ACME_SITE };
      net.ai = customersModel;
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME });
      const { run: r } = await run(o, play.id);
      expect(r.status).toBe("done");
      expect(aiCalls().length).toBe(1);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      expect(r.note).toMatch(/AI checks were not used for the rest of this run because the allowance/);
      expect((await candidatesOf(play.id)).length).toBeGreaterThanOrEqual(6);
    });

    it("a workspace that turned AI assistance off is never sent to a model, whatever is configured", async () => {
      const o = await signup("eng-ai-off", { settings: { aiDisabled: true } });
      process.env.GROQ_API_KEY = "gsk_test_key_not_real";
      net.pages = { ...ACME_SITE, ...ONBORDO_SITE };
      net.ai = customersModel;
      const play = await mkPlay(o, { name: "Acme's customers", type: "competitor_customers", config: ACME });
      expect((await run(o, play.id)).run).toMatchObject({ status: "done", found: 6 });
      expect((await req("POST", "/v1/plays/plan", o.token, { website: "onbordo.com" })).status).toBe(200);
      expect(aiCalls()).toEqual([]);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(0);
    });

    it("planning with a provider asks the model once, charges one AI message, and takes only clean answers from it", async () => {
      const o = await signup("eng-ai-plan");
      process.env.GROQ_API_KEY = "gsk_test_key_not_real";
      net.pages = { ...ONBORDO_SITE };
      net.ai = () => ({ buyerTitles: ["Head of People", "VP HR", "see https://evil.example/x"], teamRoles: ["People Operations Lead"], category: "employee onboarding software", problems: ["onboarding contractors in other countries"], industries: ["Technology"], competitors: ["Zeta HR", "Onbordo"] });
      const r = await req("POST", "/v1/plays/plan", o.token, { website: "onbordo.com" });
      expect(r.status, r.text).toBe(200);
      expect(aiCalls().length).toBe(1);
      expect(await usageOf(o.orgId, "aiMessages")).toBe(1);
      expect(await usageOf(o.orgId, "searches")).toBe(1);
      expect(r.body.titles).toEqual(["Head of People", "VP HR"]);
      expect(r.body.competitors).toEqual([{ name: "Acme", source: "site" }, { name: "Workbright", source: "site" }, { name: "Zeta HR", source: "ai" }]);
      const by = Object.fromEntries(r.body.plays.map((p: any) => [p.type, p]));
      expect(by.hiring_role.config).toEqual({ roles: ["People Operations Lead"] });
      expect(by.public_asks.config).toMatchObject({ category: "employee onboarding software", problems: ["onboarding contractors in other countries"] });
      expect(r.text).not.toContain("evil.example");
      for (const p of r.body.plays) expect([p.type, (await req("POST", "/v1/plays", o.token, { name: p.name, type: p.type, config: p.config, targetTitles: p.targetTitles })).status]).toEqual([p.type, 201]);
    });
  });
});
