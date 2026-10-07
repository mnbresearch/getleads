/**
 * The hiring play: search results from the public job boards become companies with a
 * posting for the role - and only those. Listings, salary pages, other roles and closed
 * postings are not findings, "hiring" is only said of a posting that was opened and found
 * live, the company is named by the posting itself and never by a made-up reading of its
 * address, and no date is ever claimed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import { honorSiteOperator, type SearchProvider } from "../search/providers.js";
import type { SearchResult } from "../types.js";
import { JOB_BOARDS_NOT_SEARCHED, buildHiringQueries, findHiringCompanies, parseJobResult, readPostingPage, roleMatches } from "./hiring.js";
import { brokenSearch, page, searchWith, web, type FakeWeb, type Route } from "./kit.test.js";

const ROLE = "Sales Development Representative";
const r = (title: string, url: string, snippet = ""): SearchResult => ({ title, url, snippet, provider: "testsearch" });

/** What a search engine returns for job-board queries: postings, and plenty that are not. */
const SERP = {
  greenhouse: [
    r("Job Application for Sales Development Representative at Globex", "https://boards.greenhouse.io/globex/jobs/4012345?gh_src=abc", "Globex is hiring an SDR to join our growing sales team in Austin."),
    r("Sales Development Representative - Initech", "https://job-boards.greenhouse.io/initech/jobs/5550001004", "About Initech. We build TPS reporting software."),
    r("Jobs at Globex", "https://boards.greenhouse.io/globex", "Current openings at Globex"),
    r("Job Application for Staff Accountant at Hooli", "https://boards.greenhouse.io/hooli/jobs/777123", "Hooli finance team"),
    r("Job Application for Sales Development Representative at Vandelay Industries", "https://boards.greenhouse.io/vandelay/jobs/8800123", "Importer-exporter"),
  ],
  lever: [
    r("Umbrella Corp - Sales Development Representative (Remote)", "https://jobs.lever.co/umbrellacorp/1b2c3d4e-5f60-7a8b-9c0d-112233445566", "Umbrella Corp is looking for..."),
    r("Soylent - Senior SDR", "https://jobs.lever.co/soylent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/apply", "Apply for this job"),
    r("Soylent jobs", "https://jobs.lever.co/soylent", "Open roles"),
  ],
  ashby: [r("Sales Development Representative @ Hooli", "https://jobs.ashbyhq.com/hooli/0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9", "Hooli - San Francisco")],
  workable: [r("Sales Development Representative - Tyrell Corp", "https://apply.workable.com/tyrell-corp/j/ABC123DEF4/", "Tyrell Corp is hiring")],
  wellfound: [r("Sales Development Representative at Wayne Enterprises \u2022 Remote | Wellfound", "https://wellfound.com/company/wayne-enterprises/jobs/2890011-sales-development-representative", "Wayne Enterprises")],
  linkedin: [
    r("Stark Industries hiring Sales Development Representative in Austin, Texas, United States | LinkedIn", "https://www.linkedin.com/jobs/view/sales-development-representative-at-stark-industries-3891002211?refId=x", "Posted 2 days ago"),
    r("1,000+ Sales Development Representative jobs in United States (87 new)", "https://www.linkedin.com/jobs/sales-development-representative-jobs", "Today's top jobs"),
    r("Globex hiring Sales Development Representative in Austin, TX | LinkedIn", "https://www.linkedin.com/jobs/view/sales-development-representative-at-globex-3891009999", ""),
  ],
  plain: [
    r("Sales Development Representative at Oscorp - Careers", "https://www.oscorp.com/careers/sales-development-representative", "Join Oscorp"),
    r("Sales Development Representative Jobs, Employment | Indeed", "https://www.indeed.com/q-sales-development-representative-jobs.html", "12,345 jobs"),
    r("What Is a Sales Development Representative? Salary, Skills", "https://www.coursera.org/articles/sales-development-representative", "An SDR is..."),
    r("Sales Development Representative Salary | Glassdoor", "https://www.glassdoor.com/Salaries/sdr-salary-SRCH_KO0,3.htm", "$58k"),
    r("We're hiring a Sales Development Representative at Massive Dynamic", "https://blog.thirdparty.example/jobs/sdr-massive-dynamic", "Guest post"),
    r("Sales Development Representative interview questions", "https://www.cyberdyne.example/careers/sdr-interview-questions", "Top 20"),
  ],
};

const answer = (query: string): SearchResult[] => {
  if (query.includes("site:boards.greenhouse.io") || query.includes("site:job-boards.greenhouse.io")) return SERP.greenhouse;
  if (query.includes("site:jobs.lever.co")) return SERP.lever;
  if (query.includes("site:jobs.ashbyhq.com")) return SERP.ashby;
  if (query.includes("site:apply.workable.com")) return SERP.workable;
  if (query.includes("site:wellfound.com")) return SERP.wellfound;
  if (query.includes("site:linkedin.com/jobs/view")) return SERP.linkedin;
  return SERP.plain;
};

const posting = (title: string): string => page(title, `<main><h1>${title}</h1><p>About the role.</p></main>`);

/** The job boards as they answer a visitor: an open posting, one that is gone, one that sends you back to the list. */
const BOARDS: Record<string, Route> = {
  "https://boards.greenhouse.io/globex/jobs/4012345": posting("Job Application for Sales Development Representative at Globex"),
  "https://job-boards.greenhouse.io/initech/jobs/5550001004": { status: 404 },
  "https://boards.greenhouse.io/vandelay/jobs/8800123": { status: 403 },
  "https://jobs.lever.co/umbrellacorp/1b2c3d4e-5f60-7a8b-9c0d-112233445566": posting("Umbrella Corp - Sales Development Representative (Remote)"),
  // A closed posting sends the visitor back to the company's list of jobs.
  "https://jobs.lever.co/soylent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/apply": { status: 302, location: "https://jobs.lever.co/soylent" },
  "https://jobs.lever.co/soylent": posting("Soylent jobs"),
  // Ashby: the role and the employer in the title, and the employer again in the posting's structured data.
  "https://jobs.ashbyhq.com/hooli/0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9": page(
    "Sales Development Representative @ Hooli",
    `<div id="root"></div>`,
    `<script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Sales Development Representative","hiringOrganization":{"@type":"Organization","name":"Hooli"}}</script>`,
  ),
};

let net: FakeWeb;
const use = (routes: Record<string, Route> | ((url: string) => Route | undefined)): FakeWeb => {
  net = web(routes);
  vi.stubGlobal("fetch", net.fetch);
  return net;
};

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reading one search result as a posting", () => {
  it.each([
    [SERP.greenhouse[0], { companyName: "Globex", title: ROLE, board: "Greenhouse", url: "https://boards.greenhouse.io/globex/jobs/4012345", checkable: true }],
    [SERP.greenhouse[1], { companyName: "Initech", title: ROLE, board: "Greenhouse", checkable: true }],
    [SERP.lever[0], { companyName: "Umbrella Corp", title: "Sales Development Representative (Remote)", board: "Lever", checkable: true }],
    [SERP.lever[1], { companyName: "Soylent", title: "Senior SDR", board: "Lever" }],
    [SERP.ashby[0], { companyName: "Hooli", title: ROLE, board: "Ashby", checkable: true }],
    [SERP.workable[0], { companyName: "Tyrell Corp", title: ROLE, board: "Workable", checkable: false }],
    [SERP.wellfound[0], { companyName: "Wayne Enterprises", title: ROLE, board: "Wellfound", checkable: false }],
    [SERP.linkedin[0], { companyName: "Stark Industries", title: ROLE, board: "LinkedIn", url: "https://www.linkedin.com/jobs/view/sales-development-representative-at-stark-industries-3891002211", checkable: false }],
    [SERP.plain[0], { companyName: "Oscorp", title: ROLE, board: "their careers page", companyDomain: "oscorp.com", checkable: false }],
  ])("%j", (result, expected) => {
    expect(parseJobResult(result)).toMatchObject(expected);
  });

  it("falls back to the board's company slug when the title does not name the company", () => {
    expect(parseJobResult(r("Sales Development Representative", "https://boards.greenhouse.io/globex-corp/jobs/123456"))).toMatchObject({ companyName: "Globex Corp", title: ROLE });
    expect(parseJobResult(r("Senior Account Executive, EMEA - Apply", "https://jobs.ashbyhq.com/pied-piper/0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9"))).toMatchObject({ companyName: "Pied Piper" });
  });

  it.each([SERP.greenhouse[2], SERP.lever[2], SERP.linkedin[1], SERP.plain[1], SERP.plain[2], SERP.plain[3], SERP.plain[5], r("Sales Development Representative", "https://www.reddit.com/r/sales/comments/abc/sdr_jobs/"), r("SDR at Globex", "javascript:alert(1)"), r("SDR at Globex", "https://www.linkedin.com/in/someone")])(
    "is not a posting: %j",
    (result) => {
      expect(parseJobResult(result)).toBeNull();
    },
  );
});

describe("does the posting's title name the role?", () => {
  it.each([
    ["Sales Development Representative", ROLE, true],
    ["Senior Sales Development Representative (Remote, EMEA)", ROLE, true],
    ["SDR", ROLE, true],
    ["Senior SDR - Enterprise", ROLE, true],
    ["Sales Development Representatives", ROLE, true],
    ["Sales Development Rep", ROLE, true],
    [ROLE, "SDR", true],
    ["Account Executive", "AE", true],
    ["Sr. Account Executive", "Senior Account Executive", true],
    ["VP of Sales", "Vice President Sales", true],
    ["Manager, Sales Development", ROLE, false],
    ["Business Development Representative", ROLE, false],
    ["Staff Accountant", ROLE, false],
    ["Sales Engineer", ROLE, false],
    ["Engineering Manager", "Software Engineer", false],
    ["", ROLE, false],
    [ROLE, "", false],
  ])("%s vs %s -> %s", (title, role, expected) => {
    expect(roleMatches(title, role)).toBe(expected);
  });
});

describe("the searches", () => {
  it("ask the open web first, then one board at a time, every role before any second source", () => {
    const q = buildHiringQueries(["SDR", "Account Executive"], ["fintech"], ["Austin", "Remote"]);
    expect(q.slice(0, 6)).toEqual([
      '"SDR" job opening fintech ("Austin" OR "Remote")',
      '"Account Executive" job opening fintech ("Austin" OR "Remote")',
      'site:boards.greenhouse.io "SDR" fintech ("Austin" OR "Remote")',
      'site:boards.greenhouse.io "Account Executive" fintech ("Austin" OR "Remote")',
      'site:jobs.lever.co "SDR" fintech ("Austin" OR "Remote")',
      'site:jobs.lever.co "Account Executive" fintech ("Austin" OR "Remote")',
    ]);
    expect(q).toHaveLength(16);
    for (const site of ["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com", "wellfound.com/company", "linkedin.com/jobs/view"]) {
      expect(q.some((x) => x.startsWith(`site:${site} `)), site).toBe(true);
    }
    // A quote in a role cannot break out of the phrase.
    expect(buildHiringQueries(['SDR" OR site:evil.example "'])[0]).toBe('"SDR OR site:evil.example" job opening');
  });
});

describe("findHiringCompanies", () => {
  it("returns one company per posting that matches the role, with the posting as evidence", async () => {
    use(BOARDS);
    const search = searchWith(answer);
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [search] } });
    const byName = new Map(findings.map((f) => [f.companyName, f]));
    expect([...byName.keys()].sort()).toEqual(["Globex", "Hooli", "Oscorp", "Stark Industries", "Tyrell Corp", "Umbrella Corp", "Vandelay Industries", "Wayne Enterprises"]);

    // Opened and still there: "open posting", with the posting's own title as the quote.
    expect(byName.get("Globex")).toEqual({
      kind: "company",
      companyName: "Globex",
      relevantBecause: "Hiring a Sales Development Representative - open posting on Greenhouse.",
      evidenceUrl: "https://boards.greenhouse.io/globex/jobs/4012345",
      evidenceTitle: ROLE,
      evidenceQuote: ROLE,
      signalType: "job_posting",
      confidence: 0.85,
    });
    expect(byName.get("Umbrella Corp")).toMatchObject({ relevantBecause: "Hiring a Sales Development Representative (Remote) - open posting on Lever.", confidence: 0.85 });
    expect(byName.get("Hooli")).toMatchObject({ relevantBecause: "Hiring a Sales Development Representative - open posting on Ashby.", confidence: 0.85 });
    // Boards that cannot be opened by a visitor: it has a posting - nobody looked whether it is still hiring.
    expect(byName.get("Stark Industries")).toMatchObject({ relevantBecause: "Has a posting for Sales Development Representative on LinkedIn.", confidence: 0.65 });
    expect(byName.get("Tyrell Corp")!.relevantBecause).toBe("Has a posting for Sales Development Representative on Workable.");
    expect(byName.get("Wayne Enterprises")!.relevantBecause).toBe("Has a posting for Sales Development Representative on Wellfound.");
    // A board that refused the check: still a posting, still not called hiring.
    expect(byName.get("Vandelay Industries")).toMatchObject({ relevantBecause: "Has a posting for Sales Development Representative on Greenhouse.", confidence: 0.65 });
    expect(byName.get("Oscorp")).toMatchObject({ relevantBecause: "Has a posting for Sales Development Representative on their careers page.", companyDomain: "oscorp.com", evidenceUrl: "https://www.oscorp.com/careers/sales-development-representative" });
    // "Hiring" is said only of a posting that was opened and found live.
    for (const f of findings) expect(/^Hiring /.test(f.relevantBecause)).toBe(f.confidence === 0.85);

    for (const f of findings) {
      expect(f.kind).toBe("company");
      // No date is claimed anywhere, even though one result said "Posted 2 days ago".
      expect(f.signalAt).toBeUndefined();
      expect(f.relevantBecause).not.toMatch(/ago|today|yesterday|\d{4}/);
      expect(f.relevantBecause).not.toMatch(/https?:|[\r\n]/);
      expect(f.evidenceUrl).toMatch(/^https:\/\//);
    }
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("2 postings found by search were no longer there when opened, so they were left out.");
    expect(trace.notes).toContain("boards.greenhouse.io refused to show a page (it answered 403). It was not retried.");
    // Six postings were opened: four answered (one of them with the company's list instead), one was gone, one refused.
    expect(trace).toMatchObject({ searches: 8, failedSearches: 0, pagesFetched: 4, pagesRefused: 1 });
  });

  it("opens only postings on boards that serve them to anyone, each once - never LinkedIn or the others", async () => {
    use(BOARDS);
    await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(net.hosts().sort()).toEqual(["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co"]);
    expect(new Set(net.calls).size).toBe(net.calls.length);
    expect(net.calls.join(" ")).not.toMatch(/linkedin|workable|wellfound|oscorp|indeed/);
    // Each board's robots.txt was read once, before anything else was asked of it.
    for (const host of net.hosts()) expect(net.calls.filter((c) => new URL(c).hostname === host)[0]).toBe(`https://${host}/robots.txt`);
  });

  it("drops a closed posting, a posting that now advertises another role, and every non-posting", async () => {
    use({ ...BOARDS, "https://boards.greenhouse.io/globex/jobs/4012345": posting("Job Application for Office Manager at Globex") });
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith((q) => (q.includes("greenhouse") ? SERP.greenhouse : q.startsWith("site:") ? [] : SERP.plain))] } });
    const got = findings.map((f) => f.companyName).sort();
    expect(got).toEqual(["Oscorp", "Vandelay Industries"]);
    // A third party's page about a company's job is not that company's posting.
    for (const no of ["Initech", "Hooli", "Globex", "Massive Dynamic", "Indeed", "Glassdoor", "Coursera"]) expect(got).not.toContain(no);
  });

  it("a board that answers for a closed posting with a page saying so does not make it open", async () => {
    use({ "https://boards.greenhouse.io/globex/jobs/4012345": page("Globex jobs", `<main><h1>The job you are looking for is no longer open.</h1></main>`) });
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith((q) => (q.includes("site:boards.greenhouse.io") ? [SERP.greenhouse[0]] : []))] } });
    expect(findings).toEqual([]);
    expect(trace.notes).toContain("1 posting found by search was no longer there when opened, so it was left out.");
  });

  it("one company, one finding: the posting that could be checked wins", async () => {
    use(BOARDS);
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith(answer)] } });
    const globex = findings.filter((f) => f.companyName === "Globex");
    expect(globex).toHaveLength(1);
    expect(globex[0].evidenceUrl).toContain("greenhouse");
  });

  it("stays within its search allowance however many roles are given, and says so", async () => {
    use({});
    const search = searchWith(() => []);
    const roles = ["SDR", "Account Executive", "Sales Manager", "Head of Sales", "Revenue Operations Manager", "Sales Engineer", "Customer Success Manager", "Account Manager", "Sales Director", "VP Sales"];
    const { trace } = await findHiringCompanies({ roles }, { searchOpts: { providers: [search] } });
    expect(search.queries).toHaveLength(24);
    // Every role was asked on the open web and on the two largest boards before the allowance ran out.
    for (const role of roles) expect(search.queries.filter((x) => x.includes(`"${role}"`)).length).toBeGreaterThanOrEqual(2);
    expect(trace.searches).toBe(24);
    expect(trace.notes.join(" ")).toContain("24 of 80 job-board searches were run");
    expect(trace.blocked).toBe(false);
  });

  it("passes the country and respects the limit", async () => {
    use(BOARDS);
    const seen: (string | undefined)[] = [];
    const search = { ...searchWith(answer), search: async (q: string, o?: { country?: string }) => (seen.push(o?.country), answer(q)) };
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [search] }, country: "GB", limit: 2 });
    expect(new Set(seen)).toEqual(new Set(["GB"]));
    // A posting that was gone made room for the next candidate: the limit is still filled.
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ companyName: "Globex", confidence: 0.85 });
  });

  it("is blocked, with a plain sentence, when every search failed", async () => {
    use({});
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [brokenSearch()] } });
    expect(findings).toEqual([]);
    expect(trace).toMatchObject({ blocked: true, searches: 8, failedSearches: 8 });
    expect(trace.blockedReason).toBe("Every search failed, so nothing could be checked this time. This is not a result about your market - try again later.");
  });

  it("is blocked when no search source is connected at all", async () => {
    use({});
    const { trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [brokenSearch("duckduckgo"), brokenSearch("bing_html")] } });
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("No search source is connected on our side, so this run could not search. This is not a result about your market.");
  });

  it("answers from a fallback search are kept, with a warning that they may be thin", async () => {
    use(BOARDS);
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith(answer, "duckduckgo")] } });
    expect(findings.length).toBeGreaterThan(3);
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("No dependable search source is connected on our side, so these results come from a fallback search and may be thin.");
  });

  it("some searches failing is not a block, but it is said", async () => {
    use(BOARDS);
    let n = 0;
    const flaky = { ...searchWith(answer), search: async (q: string) => (n++ % 2 ? Promise.reject(new Error("boom")) : answer(q)) };
    const { trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [flaky] } });
    expect(trace.blocked).toBe(false);
    expect(trace.failedSearches).toBe(4);
    expect(trace.notes).toContain("4 of 8 searches did not get an answer, so some results may be missing.");
  });

  it("does nothing after its deadline, and nothing without a role", async () => {
    use(BOARDS);
    const search = searchWith(answer);
    const late = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [search] }, deadlineAt: Date.now() - 1 });
    expect(search.queries).toEqual([]);
    expect(net.calls).toEqual([]);
    expect(late.findings).toEqual([]);
    expect(late.trace.notes).toContain("The run reached its time limit and stopped early. What was found before that is kept.");
    const none = await findHiringCompanies({ roles: [] }, { searchOpts: { providers: [search] } });
    expect(none.trace).toMatchObject({ blocked: true, blockedReason: "No role was given, so there was nothing to search for." });
  });
});

describe("named companies: their own careers pages", () => {
  const CAREERS = page(
    "Careers at Globex",
    `<main><h1>Open roles</h1><ul class="jobs">
      <li><a href="/careers/sdr">Sales Development Representative</a><span>Austin</span></li>
      <li><a href="/careers/ae">Account Executive</a></li>
      <li><a href="/careers/swe">Senior Software Engineer</a></li>
    </ul></main>`,
  );

  it("keeps a company whose careers page lists the role, with that page as evidence", async () => {
    use({ "https://globex.com/careers": CAREERS, "https://initech.com/careers": page("Careers", `<main><ul><li>Senior Software Engineer</li><li>Product Designer</li><li>Backend Developer</li></ul></main>`) });
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE], companyDomains: ["globex.com", "https://www.initech.com/about"] }, { searchOpts: { providers: [searchWith(() => [])] }, allowPrivateHosts: true });
    expect(findings).toEqual([
      {
        kind: "company",
        companyDomain: "globex.com",
        relevantBecause: "Hiring a Sales Development Representative - listed on their careers page.",
        evidenceUrl: "https://globex.com/careers",
        evidenceTitle: ROLE,
        evidenceQuote: ROLE,
        signalType: "job_posting",
        confidence: 0.8,
      },
    ]);
    expect(trace.blocked).toBe(false);
  });

  it.each(["127.0.0.1", "localhost", "intranet.corp.local", "http://169.254.169.254/latest", "10.1.2.3:8080", "[::1]"])("a company 'domain' of %s is refused and reported, never fetched", async (domain) => {
    use(() => ({ body: CAREERS }));
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE], companyDomains: [domain] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(net.calls).toEqual([]);
    expect(findings).toEqual([]);
    expect(trace.pagesRefused).toBe(1);
    expect(trace.notes.join(" ")).toMatch(/is not a public web address, so it was not fetched\./);
  });
});

/* ───────────────────────────────── who is hiring, and is it still ───────────────────────────────── */

describe("the company's name comes from the posting, not from a reading of its address", () => {
  const SLUG = "globexakatroveinformationtechnologies";
  const GH = `https://job-boards.greenhouse.io/${SLUG}/jobs/4719664005`;
  const one = (results: SearchResult[]) => searchWith((q) => (q.startsWith('"') ? results : []));

  it("reads the employer from the posting's title when the result and the address do not give it", async () => {
    // The result is the role alone; the posting's own title says "at Globex" (its social title is the role alone, too).
    use({ [GH]: page("Job Application for Sales Development Representative at Globex", `<main><h1>Sales Development Representative</h1></main>`, `<meta property="og:title" content="Sales Development Representative">`) });
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [one([r(ROLE, GH)])] } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ companyName: "Globex", relevantBecause: "Hiring a Sales Development Representative - open posting on Greenhouse.", evidenceUrl: GH });
  });

  it("an address that is one run of letters is never shown as a name: with nothing better, the posting is left out", async () => {
    use({ [GH]: { status: 403 } });
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [one([r(ROLE, GH)])] } });
    expect(findings).toEqual([]);
    expect(trace.notes).toContain("1 posting was left out because the company behind it could not be named from the posting.");
    // On a board that cannot be opened there is nothing to ask, so it is not a posting we can name at all.
    expect(parseJobResult(r(ROLE, "https://apply.workable.com/tyrellcorporationjobsboardinternational/j/ABC123DEF4/"))).toBeNull();
    expect(JSON.stringify(findings)).not.toMatch(/Globexakatrove/i);
  });

  it("the result's own words for the company come before the address", async () => {
    const url = "https://job-boards.greenhouse.io/hooliusa/jobs/7797762";
    use({ [url]: { status: 403 } });
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [one([r("Sales Development Representative - Hooli", url)])] } });
    expect(findings.map((f) => f.companyName)).toEqual(["Hooli"]);
  });

  it("an address that reads as words is still a last resort", () => {
    expect(parseJobResult(r(ROLE, "https://boards.greenhouse.io/black-duck/jobs/5373816008"))).toMatchObject({ companyName: "Black Duck" });
    expect(parseJobResult(r(ROLE, "https://jobs.ashbyhq.com/chalk/1f394b94-e22d-4594-acb9-7d44474d0105"))).toMatchObject({ companyName: "Chalk" });
    expect(parseJobResult(r(ROLE, "https://job-boards.greenhouse.io/superpaymentsltd/jobs/4880693101"))).toMatchObject({ unnamed: true });
  });

  it("reads the employer from structured data, a title in any of the boards' forms, or the board's own record", () => {
    const filler = `<p>${"About the role. ".repeat(30_000)}</p>`;
    // Far down a long page, as one board writes it.
    expect(readPostingPage(page("Customer Success Manager", `<main>${filler}</main><script type="application/ld+json">{"@context" : "http://schema.org","@type" : "JobPosting","title" : "Customer Success Manager","hiringOrganization" : {"@type" : "Organization","name": "Initech"}}</script>`), "initech", true)).toEqual({ role: "Customer Success Manager", company: "Initech" });
    expect(readPostingPage(page("Sales Development Representative - Outbound (US) @ Hooli", "<div></div>"), "hooli", false)).toEqual({ role: "Sales Development Representative - Outbound (US)", company: "Hooli" });
    expect(readPostingPage(page("Umbrella Corp - Customer Success Manager", "<div></div>"), "umbrellacorp", true)).toEqual({ role: "Customer Success Manager", company: "Umbrella Corp" });
    expect(readPostingPage(page("Job Application for Data Engineer at Soylent", "<div></div>"), "soylentjobs", false)).toEqual({ role: "Data Engineer", company: "Soylent" });
    expect(readPostingPage(page("Careers", `<div></div><script>window.__data = {"public_url":"https://x.example/1","company_name":"Wonka Industries","title":"x"}</script>`), "wonkaind", false)).toMatchObject({ company: "Wonka Industries" });
    // A page that names no employer names none.
    expect(readPostingPage(page("Sales Development Representative", "<div></div>"), "x", false)).toEqual({ role: ROLE });
    expect(readPostingPage(page("Jobs", `<script type="application/ld+json">{not json</script>`), "x", false)).toEqual({});
  });
});

describe("only a posting that was opened and found live is called hiring", () => {
  const ASHBY = "https://jobs.ashbyhq.com/hooli/0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9";
  const only = (result: SearchResult) => searchWith((q) => (q.startsWith('"') ? [result] : []));

  it("a page that says it no longer takes applications is dropped", async () => {
    for (const body of [
      page("Sales Development Representative @ Hooli", `<main><h2>This job is no longer accepting applications</h2></main>`),
      page("Job not found", `<main><h1>Job not found</h1></main>`),
      page("Sales Development Representative @ Hooli", `<main><div role="alert">Applications are now closed.</div></main>`),
    ]) {
      resetSearchCache();
      use({ [ASHBY]: body });
      const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [only(r("Sales Development Representative @ Hooli", ASHBY))] } });
      expect(findings).toEqual([]);
      expect(trace.notes).toContain("1 posting found by search was no longer there when opened, so it was left out.");
    }
  });

  it("a dash inside the role does not make a sentence with two dashes", async () => {
    use({ [ASHBY]: page("Sales Development Representative - Outbound (US) @ Hooli", `<div id="root"></div>`) });
    const open = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [only(r("Sales Development Representative - Outbound (US) @ Hooli", ASHBY))] } });
    expect(open.findings[0].relevantBecause).toBe("Hiring a Sales Development Representative, Outbound (US) - open posting on Ashby.");
    expect(open.findings[0].evidenceQuote).toBe("Sales Development Representative - Outbound (US)");
    use({});
    resetSearchCache();
    const unchecked = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [only(r("Sales Development Representative - Outbound (US) at Tyrell Corp", "https://apply.workable.com/tyrell-corp/j/ABC123DEF4/"))] } });
    expect(unchecked.findings[0].relevantBecause).toBe("Has a posting for Sales Development Representative, Outbound (US) on Workable.");
  });

  it("a posting the board's robots.txt closes is not opened, and so not called hiring", async () => {
    use({ "https://jobs.ashbyhq.com/robots.txt": { body: "User-agent: *\nDisallow: /hooli/\n", type: "text/plain" }, [ASHBY]: page("Sales Development Representative @ Hooli", "<div></div>") });
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [only(r("Sales Development Representative @ Hooli", ASHBY))] } });
    expect(net.calls).toEqual(["https://jobs.ashbyhq.com/robots.txt"]);
    expect(findings[0]).toMatchObject({ companyName: "Hooli", relevantBecause: "Has a posting for Sales Development Representative on Ashby.", confidence: 0.65 });
    expect(trace.notes).toContain("jobs.ashbyhq.com asks automated readers not to open some of its pages (robots.txt), so those were skipped.");
  });

  it("postings on one board are opened one at a time, with a pause between them", async () => {
    const before = process.env.PLAYS_HOST_PAUSE_MS;
    process.env.PLAYS_HOST_PAUSE_MS = "300";
    try {
      const urls = ["globex", "initech", "hooli"].map((c, i) => `https://boards.greenhouse.io/${c}/jobs/40123${i}`);
      use(Object.fromEntries(urls.map((u, i) => [u, posting(`Job Application for Sales Development Representative at ${["Globex", "Initech", "Hooli"][i]}`)])));
      const results = urls.map((u, i) => r(`Job Application for Sales Development Representative at ${["Globex", "Initech", "Hooli"][i]}`, u));
      const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith((q) => (q.startsWith('"') ? results : []))] } });
      expect(findings).toHaveLength(3);
      expect(net.calls).toHaveLength(4);
      for (let i = 1; i < net.at.length; i++) expect(net.at[i] - net.at[i - 1]).toBeGreaterThanOrEqual(290);
    } finally {
      if (before === undefined) delete process.env.PLAYS_HOST_PAUSE_MS;
      else process.env.PLAYS_HOST_PAUSE_MS = before;
    }
  }, 15_000);
});

describe("a search that never answers", () => {
  it("cannot hold the run past its deadline: no further search is started once less than one search's time is left", async () => {
    use({});
    const hanging = { ...searchWith(() => []), search: (q: string) => (hanging.queries.push(q), new Promise<never>(() => {})) };
    const started = Date.now();
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [hanging] }, deadlineAt: Date.now() + 4_500 });
    expect(Date.now() - started).toBeLessThan(5_500);
    // One search fitted; the other seven were never started.
    expect(hanging.queries).toHaveLength(1);
    expect(findings).toEqual([]);
    expect(trace.notes).toContain("The run reached its time limit and stopped early. What was found before that is kept.");
  }, 10_000);
});

/* ───────────────────────── what a second look at live runs found ───────────────────────── */

describe("a posting that can be checked is reported checked, or not at all", () => {
  const GLOBEX = "https://boards.greenhouse.io/globex/jobs/6578883";
  const NEW_HOME = "https://job-boards.greenhouse.io/globex/jobs/6578883";
  const result: SearchResult = { title: "Sales Development Representative - Globex", url: GLOBEX, snippet: "Globex is hiring", provider: "stub" };
  const found = searchWith((q) => (q.includes("site:boards.greenhouse.io") ? [result] : []));
  const ROBOTS: Route = { body: "User-agent: *\nAllow: /\n", type: "text/plain" };

  it("reading each board's robots.txt is not taken out of the three requests a posting gets", async () => {
    // The board has moved the posting: one robots.txt and a redirect, then another robots.txt, then the page.
    use({
      "https://boards.greenhouse.io/robots.txt": ROBOTS,
      [GLOBEX]: { status: 301, location: NEW_HOME },
      "https://job-boards.greenhouse.io/robots.txt": ROBOTS,
      [NEW_HOME]: posting("Job Application for Sales Development Representative at Globex"),
    });
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } });
    expect(net.calls).toEqual(["https://boards.greenhouse.io/robots.txt", GLOBEX, "https://job-boards.greenhouse.io/robots.txt", NEW_HOME]);
    expect(findings.map((f) => [f.companyName, f.relevantBecause, f.confidence])).toEqual([["Globex", "Hiring a Sales Development Representative - open posting on Greenhouse.", 0.85]]);
  });

  it("the same for one that has been taken down: it is found gone, where it used to be reported unchecked", async () => {
    // What a closed posting does on this board: on to its new address, and from there back to the company's list.
    use({
      "https://boards.greenhouse.io/robots.txt": ROBOTS,
      [GLOBEX]: { status: 301, location: NEW_HOME },
      "https://job-boards.greenhouse.io/robots.txt": ROBOTS,
      [NEW_HOME]: { status: 302, location: "https://job-boards.greenhouse.io/globex?error=true" },
      "https://job-boards.greenhouse.io/globex?error=true": posting("Jobs at Globex"),
    });
    resetSearchCache();
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } });
    expect(findings).toEqual([]);
    expect(trace.notes).toContain("1 posting found by search was no longer there when opened, so it was left out.");
  });

  it("a check that could not finish - too many hops, a board that does not answer - leaves the posting out, and says so", async () => {
    // Four addresses deep: more than a posting's three requests.
    const hop = (n: number): string => `https://boards.greenhouse.io/globex/jobs/6578883?step=${n}`;
    use({ [GLOBEX]: { status: 302, location: hop(1) }, [hop(1)]: { status: 302, location: hop(2) }, [hop(2)]: { status: 302, location: hop(3) }, [hop(3)]: posting("Job Application for Sales Development Representative at Globex") });
    const deep = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } });
    expect(deep.findings).toEqual([]);
    expect(deep.trace.notes).toContain("1 posting found by search could not be opened to check that it is still there, so it was left out.");
    expect(net.pages()).toHaveLength(3);

    use({ [GLOBEX]: { throws: true } });
    resetSearchCache();
    const down = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } });
    expect(down.findings).toEqual([]);
    expect(down.trace.notes).toContain("1 posting found by search could not be opened to check that it is still there, so it was left out.");

    use({ [GLOBEX]: { status: 500 } });
    resetSearchCache();
    expect((await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } })).findings).toEqual([]);
  });

  it("a board that refuses the check has answered: the posting is reported as one nobody could look at, as before", async () => {
    use({ [GLOBEX]: { status: 403 } });
    const { findings } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [found] } });
    expect(findings.map((f) => [f.companyName, f.relevantBecause, f.confidence])).toEqual([["Globex", "Has a posting for Sales Development Representative on Greenhouse.", 0.65]]);
  });
});

describe("when the job boards themselves could not be searched", () => {
  /** An engine that ignores `site:`: what it sends for a board is from anywhere, and is discarded. For the open web it answers. */
  const ignoresSite = (openWeb: SearchResult[]): SearchProvider => ({
    name: "bing_html",
    available: () => true,
    search: async (q: string) => honorSiteOperator(q, q.startsWith("site:") ? [{ title: "Sales jobs near you", url: "https://jobs.example/sales", snippet: "", provider: "bing_html" }] : openWeb),
  });
  const UNRELATED: SearchResult[] = [{ title: "What does a sales development representative do?", url: "https://blog.example/what-is-an-sdr", snippet: "A guide to the role.", provider: "bing_html" }];

  it("the run is blocked and says so, even though a search of the open web answered with something unrelated", async () => {
    use({});
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [ignoresSite(UNRELATED)] } });
    expect(findings).toEqual([]);
    expect(trace).toMatchObject({ searches: 8, failedSearches: 7, blocked: true, blockedReason: JOB_BOARDS_NOT_SEARCHED });
    expect(JOB_BOARDS_NOT_SEARCHED).toBe("The job boards could not be searched this time, so no postings could be looked for. This is not a result about your market - try again later.");
  });

  it("it is not blocked when the open web gave a posting: something was found, and what could not be searched is said in a note", async () => {
    use({});
    // A company's own careers page, as the open web returns it.
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [ignoresSite(SERP.plain)] } });
    expect(findings.map((f) => f.companyName)).toEqual(["Oscorp"]);
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("7 of 8 searches were meant for one site each, but the search source in use ignored that and its results had to be discarded. Those sites were not searched.");
  });

  it("boards that were searched and had nothing are an answer: nothing found, not blocked", async () => {
    use({});
    const { findings, trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(findings).toEqual([]);
    expect(trace).toMatchObject({ blocked: false, failedSearches: 0 });
  });

  it("when no search answered at all, the reason is the one every play gives for that", async () => {
    use({});
    const { trace } = await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [brokenSearch()] } });
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).not.toBe(JOB_BOARDS_NOT_SEARCHED);
  });
});
