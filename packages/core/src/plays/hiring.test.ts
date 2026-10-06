/**
 * The hiring play: search results from the public job boards become companies with a
 * posting for the role - and only those. Listings, salary pages, other roles and closed
 * postings are not findings, "open" is only said of a posting that was opened, and no date
 * is ever claimed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import type { SearchResult } from "../types.js";
import { buildHiringQueries, findHiringCompanies, parseJobResult, roleMatches } from "./hiring.js";
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
  "https://jobs.lever.co/soylent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/apply": { body: posting("Soylent jobs"), finalUrl: "https://jobs.lever.co/soylent" },
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
    [SERP.ashby[0], { companyName: "Hooli", title: ROLE, board: "Ashby", checkable: false }],
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
    // Boards that cannot be opened by a visitor: a posting, never an "open" one.
    expect(byName.get("Stark Industries")).toMatchObject({ relevantBecause: "Hiring a Sales Development Representative - posting on LinkedIn.", confidence: 0.65 });
    expect(byName.get("Hooli")!.relevantBecause).toBe("Hiring a Sales Development Representative - posting on Ashby.");
    expect(byName.get("Tyrell Corp")!.relevantBecause).toBe("Hiring a Sales Development Representative - posting on Workable.");
    expect(byName.get("Wayne Enterprises")!.relevantBecause).toBe("Hiring a Sales Development Representative - posting on Wellfound.");
    // A board that refused the check: still a posting, still not called open.
    expect(byName.get("Vandelay Industries")).toMatchObject({ relevantBecause: "Hiring a Sales Development Representative - posting on Greenhouse.", confidence: 0.65 });
    expect(byName.get("Oscorp")).toMatchObject({ relevantBecause: "Hiring a Sales Development Representative - posting on their careers page.", companyDomain: "oscorp.com", evidenceUrl: "https://www.oscorp.com/careers/sales-development-representative" });

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
    // Five postings were opened: three answered (one of them with the company's list instead), one was gone, one refused.
    expect(trace).toMatchObject({ searches: 8, failedSearches: 0, pagesFetched: 3, pagesRefused: 1 });
  });

  it("opens only postings on boards that serve them to anyone, each once - never LinkedIn or the others", async () => {
    use(BOARDS);
    await findHiringCompanies({ roles: [ROLE] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(net.hosts().sort()).toEqual(["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co"]);
    expect(new Set(net.calls).size).toBe(net.calls.length);
    expect(net.calls.join(" ")).not.toMatch(/linkedin|ashbyhq|workable|wellfound|oscorp|indeed/);
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
