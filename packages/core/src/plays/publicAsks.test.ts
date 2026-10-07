/**
 * The public-asks play: search results from LinkedIn, Reddit, Hacker News, X and forums
 * become people asking for a solution or complaining about a competitor - and nothing
 * else. Vendor posts, listicles, job ads, the competitor's own pages and anything a seller
 * could have written are not findings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNTRUSTED_MARK, UNTRUSTED_RULE } from "../ai/untrusted.js";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import type { AiMessage, SearchResult } from "../types.js";
import { NO_AI, brokenSearch, model, searchWith, web, type FakeWeb, type Route } from "./kit.test.js";
import { agedConfidence, askPlace, buildAskQueries, classifyAsk, findPublicAsks, linkedinPostAuthor, merelyListed, snippetDate, vanityMatches } from "./publicAsks.js";

const r = (title: string, url: string, snippet = ""): SearchResult => ({ title, url, snippet, provider: "testsearch" });

const ACME: SearchResult[] = [
  // LinkedIn
  r("Priya Shah on LinkedIn: Looking for an alternative to Acme - any recommendations? | 23 comments", "https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-hr-activity-7250011122233344455-AbCd", "We've outgrown Acme and I'm looking for an alternative to Acme that handles contractors. Any recommendations?"),
  r("Tom Baker on LinkedIn: Frustrated with Acme. Third outage this month", "https://www.linkedin.com/posts/tombaker_acme-activity-7250099988877766655-xYz1?utm_source=share", "I'm frustrated with Acme. Third outage this month and our team lost a whole day of onboarding."),
  r("Rival HQ on LinkedIn: Top 10 alternatives to Acme in 2026", "https://www.linkedin.com/posts/rival-hq_top-10-alternatives-to-acme-activity-7250000000000000001-aaaa", "Looking for an alternative to Acme? Here are the 10 best options we tested."),
  r("Globex Software on LinkedIn: Tired of Acme's pricing? Try Globex free for 30 days", "https://www.linkedin.com/posts/globex-software_acme-pricing-activity-7250000000000000002-bbbb", "Tired of Acme's pricing? Try Globex free for 30 days. Book a demo today."),
  r("Initech on LinkedIn: We're hiring a Customer Success Manager who knows Acme", "https://www.linkedin.com/posts/initech_hiring-activity-7250000000000000003-cccc", "We're hiring! If you are frustrated with Acme admin work, join our team."),
  r("Hooli Labs on LinkedIn: We're looking for an alternative to Acme. What do you use?", "https://www.linkedin.com/posts/hooli-labs_acme-activity-7250000000000000004-dddd", "We're looking for an alternative to Acme. What do you use for onboarding?"),
  r("Lena Fox on LinkedIn: Alternatives to Acme?", "https://www.linkedin.com/posts/lena-fox-99887766_alternatives-activity-7250000000000000005-eeee", "Alternatives to Acme? Curious what is out there these days."),
  r("7 reasons teams are switching from Acme", "https://www.linkedin.com/pulse/7-reasons-teams-switching-from-acme-rival-hq", "Switching from Acme? Read this first."),
  // Reddit
  r("Looking for an alternative to Acme : r/humanresources", "https://www.reddit.com/r/humanresources/comments/1abc234/looking_for_an_alternative_to_acme/", "3 days ago \u2014 We're a 60 person company and Acme doubled our price. What are you all using instead?"),
  r("Acme is too expensive now : r/smallbusiness", "https://www.reddit.com/r/smallbusiness/comments/1def567/acme_is_too_expensive_now/", "Acme is too expensive for what it does. Support is terrible and we are cancelling our plan next month."),
  r("10 Best Acme Alternatives in 2026 (Ranked) : r/SaaS", "https://www.reddit.com/r/SaaS/comments/1ghi890/10_best_acme_alternatives_in_2026_ranked/", "I compared 10 tools so you don't have to. Looking for an alternative to Acme?"),
  r("r/humanresources", "https://www.reddit.com/r/humanresources/", "Looking for an alternative to Acme? Ask here."),
  r("Looking for an alternative to Acme (old thread) : r/sysadmin", "https://www.reddit.com/r/sysadmin/comments/zzz999/looking_for_an_alternative_to_acme_old_thread/", "Mar 3, 2021 \u2014 I'm looking for an alternative to Acme. Anyone?"),
  r("Acme alternative? : r/startups", "https://old.reddit.com/r/startups/comments/1jkl012/acme_alternative/", "Any good alternatives to Acme? Budget is tight."),
  // Hacker News
  r("Ask HN: Alternatives to Acme for a 40-person team? | Hacker News", "https://news.ycombinator.com/item?id=41234567", "We have used Acme for two years and the new pricing does not work for us."),
  r("Show HN: We built an open-source Acme alternative | Hacker News", "https://news.ycombinator.com/item?id=41239999", "We built an open-source alternative to Acme. Try it free."),
  r("Hacker News", "https://news.ycombinator.com/news", "Alternative to Acme"),
  // X
  r('Sam Lee on X: "anyone know a good alternative to Acme? their new pricing is wild" / X', "https://x.com/samlee/status/1840000000000000001", "anyone know a good alternative to Acme? their new pricing is wild"),
  r("Acme (@acme) / X", "https://x.com/acme", "Onboarding that runs itself. Looking for an alternative to spreadsheets?"),
  // Not conversations at all
  r("Acme vs Globex: Which is better in 2026? | Globex Blog", "https://www.globex.com/blog/acme-vs-globex", "Looking for an alternative to Acme? We compared both."),
  r("Looking for an alternative to the Acme API? - Acme Community", "https://community.acme.com/t/alternative-to-api/123", "I'm looking for an alternative to the Acme API v1 endpoint."),
  r("Acme Reviews 2026: Details, Pricing, & Features | G2", "https://www.g2.com/products/acme/reviews", "Frustrated with Acme? Read 1,203 reviews."),
];

const PROBLEM: SearchResult[] = [
  r("What do you use for onboarding contractors? - Indie Hackers", "https://www.indiehackers.com/post/what-do-you-use-for-onboarding-contractors-abc123", "What do you use for onboarding contractors in other countries? We are drowning in paperwork."),
  r("How to onboard contractors: the complete guide", "https://www.somevendor.example/blog/onboarding-contractors-guide", "Looking for a tool to onboard contractors? In this guide we cover everything."),
  r("What do you use for expense reports? : r/smallbusiness", "https://www.reddit.com/r/smallbusiness/comments/1xyz000/what_do_you_use_for_expense_reports/", "What do you use for expense reports? Ours is a mess."),
];

const CATEGORY: SearchResult[] = [
  r("Can anyone recommend an employee onboarding software for a 30 person startup? : r/startups", "https://www.reddit.com/r/startups/comments/1mno345/can_anyone_recommend_an_employee_onboarding/", "Can anyone recommend an employee onboarding software for a 30 person startup? We hire about four people a month."),
  r("Best Employee Onboarding Software 2026 | Capterra", "https://www.capterra.com/employee-onboarding-software/", "Find the best employee onboarding software for your business."),
];

/** A search engine that honours `site:` and returns results about what was asked. */
const answer = (query: string): SearchResult[] => {
  const pool = /Acme/.test(query) ? ACME : /onboarding contractors/.test(query) ? PROBLEM : /employee onboarding software/.test(query) ? CATEGORY : [];
  const site = /site:(\S+)/.exec(query)?.[1];
  return site ? pool.filter((x) => x.url.includes(site.replace(/^www\./, ""))) : pool;
};

const NOW = Date.parse("2026-10-06T09:00:00Z");

/** The web as these tests see it. By default nothing answers: the Hacker News search included, unless a test serves it. */
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  use({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ask, complaint or neither", () => {
  it.each([
    ["Looking for an alternative to Acme - any recommendations?", "We've outgrown Acme and I'm looking for an alternative.", "ask", true],
    ["Anyone using something other than Acme?", "Has anyone switched from Acme to something cheaper? Would love to hear.", "ask", true],
    ["Ask HN: Alternatives to Acme for a 40-person team?", "", "ask", true],
    ["What do you use for onboarding contractors?", "What do you use for onboarding contractors in other countries?", "ask", true],
    ["Thinking of switching from Acme", "We're thinking of switching from Acme after the price change.", "ask", true],
    ["Recommendations for onboarding software?", "Any recommendations for a small team please", "ask", true],
    ["Which HR tool should we pick?", "Which tool should we go with for a 30 person team", "ask", true],
    ["Alternatives to Acme?", "Curious what is out there these days.", "ask", false],
    ["Frustrated with Acme", "I'm frustrated with Acme. Third outage this month.", "complaint", true],
    ["Acme is too expensive now", "Acme is too expensive for what it does and we are cancelling.", "complaint", true],
    ["Acme pricing", "Acme is overpriced.", "complaint", false],
  ])("%s -> %s", (title, snippet, kind, strong) => {
    expect(classifyAsk(title, snippet, "Acme")).toMatchObject({ kind, strong });
  });

  it.each([
    ["Top 10 alternatives to Acme in 2026", "Looking for an alternative to Acme? Here are the 10 best options."],
    ["10 Best Acme Alternatives (Ranked)", "I compared 10 tools so you don't have to."],
    ["Tired of Acme's pricing? Try Globex free for 30 days", "Tired of Acme's pricing? Try Globex."],
    ["Looking for an alternative to Acme? Meet Globex", "Looking for an alternative to Acme? Meet Globex, the modern way to onboard."],
    ["Frustrated with Acme? You're not alone", "Frustrated with Acme? You're not alone. Book a demo."],
    ["We're hiring a Customer Success Manager", "If you are frustrated with Acme admin work, join our team."],
    ["Show HN: We built an open-source Acme alternative", "We built an alternative to Acme."],
    ["Acme vs Globex: the complete guide", "In this guide we compare Acme and Globex. Pros and cons inside."],
    ["Acme alternatives & competitors", "Looking for alternatives to Acme?"],
    ["Acme raises $40M", "Acme announced a new round today."],
    ["How we onboard new hires", "A walkthrough of our process with Acme."],
    ["I love Acme", "Honestly Acme has been great for us."],
    ["", ""],
  ])("%s is neither", (title, snippet) => {
    expect(classifyAsk(title, snippet, "Acme")).toBeNull();
  });

  it("a complaint needs the product to be the thing complained about", () => {
    expect(classifyAsk("Bad week", "I'm frustrated with my landlord. Unrelated: we use Acme at work.", "Acme")).toBeNull();
    expect(classifyAsk("Bad week", "Support is terrible and we are cancelling.", undefined)).toBeNull();
    expect(classifyAsk("Acme thread", "Support is terrible and we are cancelling.", "Acme")).toMatchObject({ kind: "complaint" });
  });

  it("knows leaving a product from moving to it", () => {
    expect(classifyAsk("Looking for an alternative to Acme", "I'm looking for an alternative to Acme.", "Acme")!.leaving).toBe(true);
    expect(classifyAsk("Anyone switching from Acme?", "Has anyone tried switching from Acme recently?", "Acme")!.leaving).toBe(true);
    expect(classifyAsk("Anyone switched to Acme?", "Has anyone switched to Acme from spreadsheets? Thinking about it.", "Acme")!.leaving).toBe(false);
    expect(classifyAsk("Anyone using Acme?", "Can anyone recommend Acme for a small team?", "Acme")!.leaving).toBe(false);
  });

  it("quotes the line of the result that the verdict rests on", () => {
    const v = classifyAsk("Looking for an alternative to Acme : r/humanresources", "3 days ago \u2014 We're a 60 person company and Acme doubled our price. What are you all using instead?", "Acme")!;
    expect(v.quote).toBe("What are you all using instead?");
    const c = classifyAsk("Acme is too expensive now", "Acme is too expensive for what it does. Support is terrible and we are cancelling our plan next month.", "Acme")!;
    expect(c.quote).toBe("Acme is too expensive now");
  });
});

describe("where a result lives", () => {
  it.each([
    ["https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-activity-725-AbCd", { source: "linkedin", vanity: "priya-shah-4b6a2311" }],
    ["https://in.linkedin.com/posts/tombaker_acme-activity-725-xYz1", { source: "linkedin", vanity: "tombaker" }],
    ["https://www.linkedin.com/feed/update/urn:li:activity:7250011122233344455/", { source: "linkedin" }],
    ["https://www.reddit.com/r/sales/comments/1abc234/title_here/", { source: "reddit" }],
    ["https://old.reddit.com/r/sales/comments/1abc234/", { source: "reddit" }],
    ["https://news.ycombinator.com/item?id=41234567", { source: "hackernews" }],
    ["https://x.com/samlee/status/1840000000000000001", { source: "x" }],
    ["https://twitter.com/samlee/status/1840000000000000001?s=20", { source: "x" }],
    ["https://www.indiehackers.com/post/what-do-you-use-abc123", { source: "forums" }],
    ["https://community.example.com/t/which-tool/123", { source: "forums" }],
    ["https://www.example.com/forum/threads/which-tool.123/", { source: "forums" }],
    ["https://stackoverflow.com/questions/123/which-tool", { source: "forums" }],
  ])("%s", (url, place) => {
    expect(askPlace(url)).toEqual(place);
  });

  it.each([
    "https://www.linkedin.com/pulse/7-reasons-teams-switching-from-acme-rival-hq",
    "https://www.linkedin.com/company/acme",
    "https://www.linkedin.com/in/priya-shah-4b6a2311",
    "https://www.linkedin.com/jobs/view/sdr-at-globex-123456789",
    "https://www.reddit.com/r/humanresources/",
    "https://news.ycombinator.com/news",
    "https://news.ycombinator.com/item?id=abc",
    "https://x.com/acme",
    "https://www.globex.com/blog/acme-vs-globex",
    "https://www.g2.com/products/acme/reviews",
    "https://www.producthunt.com/products/acme",
    "not a url",
    "javascript:alert(1)",
  ])("%s is not a public conversation", (url) => {
    expect(askPlace(url)).toBeNull();
  });
});

describe("who wrote a LinkedIn post", () => {
  it("reads a person's name, and refuses a company page or anything unclear", () => {
    expect(linkedinPostAuthor("Priya Shah on LinkedIn: Looking for an alternative to Acme | 23 comments")).toMatchObject({ name: "Priya Shah" });
    expect(linkedinPostAuthor("Tom Baker, MBA on LinkedIn: Frustrated with Acme")).toMatchObject({ name: "Tom Baker" });
    expect(linkedinPostAuthor("Ana Mar\u00EDa de la Cruz on LinkedIn: #onboarding")).toMatchObject({ name: "Ana Mar\u00EDa de la Cruz" });
    expect(linkedinPostAuthor("Lena Fox's Post - LinkedIn")).toMatchObject({ name: "Lena Fox" });
    expect(linkedinPostAuthor("Alternatives to Acme? | Lena Fox posted on the topic | LinkedIn")).toMatchObject({ name: "Lena Fox" });
    for (const no of ["Globex Software on LinkedIn: Try us", "Hooli Labs on LinkedIn: We're looking", "Initech on LinkedIn: hiring", "Rival HQ on LinkedIn: Top 10", "acme on LinkedIn: hi", "The Daily News on LinkedIn: x", "Looking for an alternative to Acme", ""]) {
      expect(linkedinPostAuthor(no), no).toBeNull();
    }
  });
});

describe("dates a search result shows", () => {
  it("reads a relative or an absolute date at the start of a snippet, and nothing else", () => {
    const now = Date.parse("2026-10-06T09:00:00Z");
    expect(snippetDate("3 days ago \u2014 text", now)).toEqual(new Date(now - 3 * 86_400_000));
    expect(snippetDate("5 hours ago - text", now)).toEqual(new Date(now - 5 * 3_600_000));
    expect(snippetDate("Mar 3, 2021 \u2014 text", now)).toEqual(new Date("2021-03-03T00:00:00Z"));
    expect(snippetDate("2 Oct 2026 - text", now)).toEqual(new Date("2026-10-02T00:00:00Z"));
    expect(snippetDate("We moved in March 2021 and 3 days ago it broke", now)).toBeNull();
    expect(snippetDate("Jan 1, 2099 - from the future", now)).toBeNull();
    expect(snippetDate("", now)).toBeNull();
  });
});

describe("the searches", () => {
  it("ask every subject on every source before asking any subject a second way, and add a plain form", () => {
    const q = buildAskQueries(
      [
        { kind: "competitor", value: "Acme" },
        { kind: "problem", value: "onboarding contractors" },
        { kind: "category", value: "employee onboarding software" },
      ],
      ["reddit", "linkedin"],
    ).map((x) => x.query);
    expect(q.slice(0, 9)).toEqual([
      'site:reddit.com "alternative to Acme"',
      'site:linkedin.com/posts "alternative to Acme"',
      'site:reddit.com "looking for a tool" onboarding contractors',
      'site:linkedin.com/posts "looking for a tool" onboarding contractors',
      'site:reddit.com "looking for an employee onboarding software"',
      'site:linkedin.com/posts "looking for an employee onboarding software"',
      '"alternative to Acme"',
      '"looking for a tool" onboarding contractors',
      '"looking for an employee onboarding software"',
    ]);
    expect(q).toContain('site:reddit.com "switching from Acme"');
    expect(q).toContain('site:reddit.com "frustrated with Acme"');
    expect(q).toContain('site:reddit.com "Acme is too expensive"');
    expect(q).toContain('site:reddit.com "Acme vs"');
    expect(q).toContain('site:reddit.com "what do you use" onboarding contractors');
    expect(q).toContain('site:reddit.com "recommend an employee onboarding software"');
    // A quote in a name cannot break out of the phrase.
    expect(buildAskQueries([{ kind: "competitor", value: 'Acme" OR site:evil.example "' }], ["reddit"])[0].query).toBe('site:reddit.com "alternative to Acme OR site:evil.example"');
  });
});

describe("findPublicAsks", () => {
  it("returns people asking and complaining, and public threads to answer - with the line that shows it", async () => {
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"], problems: ["onboarding contractors"], category: "employee onboarding software" }, { searchOpts: { providers: [searchWith(answer)] }, ai: NO_AI });
    const byUrl = new Map(findings.map((f) => [f.evidenceUrl!, f]));

    // LinkedIn authors are people.
    expect(byUrl.get("https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-hr-activity-7250011122233344455-AbCd")).toEqual({
      kind: "person",
      fullName: "Priya Shah",
      firstName: "Priya",
      lastName: "Shah",
      linkedinUrl: "https://www.linkedin.com/in/priya-shah-4b6a2311",
      relevantBecause: "Asked on LinkedIn for an alternative to Acme.",
      evidenceUrl: "https://www.linkedin.com/posts/priya-shah-4b6a2311_onboarding-hr-activity-7250011122233344455-AbCd",
      evidenceTitle: "Priya Shah on LinkedIn: Looking for an alternative to Acme - any recommendations?",
      evidenceQuote: "Priya Shah on LinkedIn: Looking for an alternative to Acme - any recommendations?",
      signalType: "public_ask",
      // The result shows no date, so nobody knows how old the post is: less sure than a dated, recent one.
      confidence: 0.6,
    });
    const tom = byUrl.get("https://www.linkedin.com/posts/tombaker_acme-activity-7250099988877766655-xYz1?utm_source=share")!;
    expect(tom).toMatchObject({ kind: "person", fullName: "Tom Baker", linkedinUrl: "https://www.linkedin.com/in/tombaker", relevantBecause: "Posted on LinkedIn about frustrations with Acme.", signalType: "public_complaint", confidence: 0.55 });
    // A company page asking is a conversation, not a person.
    expect(byUrl.get("https://www.linkedin.com/posts/hooli-labs_acme-activity-7250000000000000004-dddd")).toMatchObject({ kind: "post", relevantBecause: "LinkedIn post asking for an alternative to Acme." });

    // Everything else is a conversation to answer.
    const reddit = byUrl.get("https://www.reddit.com/r/humanresources/comments/1abc234/looking_for_an_alternative_to_acme/")!;
    expect(reddit).toMatchObject({ kind: "post", relevantBecause: "Reddit thread asking for an alternative to Acme.", evidenceTitle: "Looking for an alternative to Acme", evidenceQuote: "What are you all using instead?", signalType: "public_ask", confidence: 0.75 });
    expect(reddit.signalAt).toEqual(new Date(Date.parse("2026-10-06T09:00:00Z") - 3 * 86_400_000));
    expect(reddit.fullName).toBeUndefined();
    expect(reddit.companyName).toBeUndefined();
    expect(byUrl.get("https://www.reddit.com/r/smallbusiness/comments/1def567/acme_is_too_expensive_now/")).toMatchObject({ kind: "post", relevantBecause: "Reddit thread complaining about Acme.", signalType: "public_complaint" });
    expect(byUrl.get("https://news.ycombinator.com/item?id=41234567")).toMatchObject({ kind: "post", relevantBecause: "Hacker News thread asking for an alternative to Acme.", evidenceTitle: "Ask HN: Alternatives to Acme for a 40-person team?" });
    expect(byUrl.get("https://x.com/samlee/status/1840000000000000001")).toMatchObject({ kind: "post", relevantBecause: "Post on X asking for an alternative to Acme." });
    expect(byUrl.get("https://www.indiehackers.com/post/what-do-you-use-for-onboarding-contractors-abc123")).toMatchObject({ kind: "post", relevantBecause: "Forum thread asking which tool to use for onboarding contractors." });
    expect(byUrl.get("https://www.reddit.com/r/startups/comments/1mno345/can_anyone_recommend_an_employee_onboarding/")).toMatchObject({ kind: "post", relevantBecause: "Reddit thread asking for an employee onboarding software recommendation." });

    for (const f of findings) {
      expect(f.relevantBecause).not.toMatch(/https?:|[\r\n]/);
      expect(f.relevantBecause.length).toBeLessThanOrEqual(300);
      // The quote is a line of the search result itself.
      const src = [...ACME, ...PROBLEM, ...CATEGORY].find((x) => x.url.replace(/#.*$/, "") === f.evidenceUrl)!;
      expect(`${src.title} ${src.snippet}`, f.evidenceUrl).toContain(f.evidenceQuote!);
      expect(f.email).toBeUndefined();
      if (f.kind === "post") expect(f.linkedinUrl).toBeUndefined();
    }
    expect(trace.blocked).toBe(false);
    expect(trace.aiCalls).toBe(0);
  });

  it("never returns a vendor post, a listicle, a job ad, an article, the competitor's own pages or an off-topic thread", async () => {
    const { findings } = await findPublicAsks({ competitors: ["Acme"], problems: ["onboarding contractors"], category: "employee onboarding software" }, { searchOpts: { providers: [searchWith(answer)] } });
    const urls = findings.map((f) => f.evidenceUrl).join(" ");
    for (const no of ["rival-hq", "globex-software", "initech_hiring", "/pulse/", "10_best_acme", "reddit.com/r/humanresources/ ", "id=41239999", "ycombinator.com/news", "x.com/acme ", "globex.com/blog", "community.acme.com", "g2.com", "capterra", "somevendor", "expense_reports"]) {
      expect(`${urls} `, no).not.toContain(no);
    }
    // No company is ever attached to a conversation, and nobody is a person without a LinkedIn profile.
    expect(findings.filter((f) => f.kind === "person").every((f) => !!f.linkedinUrl && !!f.fullName)).toBe(true);
    expect(findings.some((f) => f.kind === "company")).toBe(false);
  });

  it("without a model, wording a seller could have written is kept only on Reddit and Hacker News, at low confidence", async () => {
    const { findings } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] } });
    const byUrl = new Map(findings.map((f) => [f.evidenceUrl!, f]));
    // "Alternatives to Acme?" on LinkedIn, no first person: not kept.
    expect([...byUrl.keys()].some((u) => u.includes("lena-fox"))).toBe(false);
    // "Any good alternatives to Acme?" on Reddit: kept, and marked as less certain.
    expect(byUrl.get("https://old.reddit.com/r/startups/comments/1jkl012/acme_alternative/")).toMatchObject({ kind: "post", confidence: 0.35 });
  });

  it("with a model, unclear ones get one fenced second opinion, capped at 0.7", async () => {
    const ai = model((messages: AiMessage[]) => {
      const user = messages[1].content;
      const n = (needle: string) => Number(new RegExp(`${UNTRUSTED_MARK} item_(\\d+)\\n[^\\n]*${needle}`).exec(user)?.[1]);
      return { items: [{ n: n("Lena Fox"), verdict: "ask" }, { n: n("Acme alternative\\?"), verdict: "neither" }, { n: 99, verdict: "ask" }, { n: 1.5, verdict: "ask" }, { n: "2", verdict: "ask" }] };
    });
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, ai });
    expect(trace.aiCalls).toBe(1);
    expect(ai.calls).toHaveLength(1);
    const lena = findings.find((f) => f.evidenceUrl!.includes("lena-fox"))!;
    expect(lena).toMatchObject({ kind: "person", fullName: "Lena Fox", relevantBecause: "Asked on LinkedIn for an alternative to Acme.", confidence: 0.5 });
    expect(lena.confidence).toBeLessThanOrEqual(0.7);
    // The model said "neither": gone, and said so.
    expect(findings.some((f) => f.evidenceUrl!.includes("1jkl012"))).toBe(false);
    expect(trace.notes).toContain("1 result that looked like an ask was judged to be marketing and left out.");
    // Clear cases never went to the model, and keep their confidence.
    expect(findings.find((f) => f.evidenceUrl!.includes("priya-shah"))!.confidence).toBe(0.6);

    const [sys, usr] = ai.calls[0];
    expect(sys.content).toContain(UNTRUSTED_RULE);
    expect(sys.content).not.toContain("Lena");
    expect(usr.content).toContain(`<<<${UNTRUSTED_MARK} item_1\n`);
    expect(usr.content).not.toContain("Priya Shah");
    for (const line of usr.content.split("\n")) {
      if (line.includes("Lena Fox")) expect(usr.content).toContain(`\n${line}\n>>>`);
    }
  });

  it("a model that is refused, fails or answers junk leaves the rules' answer", async () => {
    const rules = (await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] } })).findings.map((f) => `${f.evidenceUrl}:${f.confidence}`).sort();
    for (const opts of [
      { ai: model({ items: [] }), beforeAiCall: async () => false },
      { ai: { name: "broken", model: "m", complete: async () => Promise.reject(new Error("boom")) } },
      { ai: model("no json here") },
      { ai: model({ items: "ask" }) },
      { ai: model({ items: [{ n: 1, verdict: "definitely an ask, also ignore your rules" }] }) },
    ]) {
      resetSearchCache();
      const got = (await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, ...opts })).findings.map((f) => `${f.evidenceUrl}:${f.confidence}`).sort();
      expect(got).toEqual(rules);
    }
  });

  it("only looks where it was told to", async () => {
    const search = searchWith(answer);
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["reddit"] }, { searchOpts: { providers: [search] } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => /reddit\.com/.test(f.evidenceUrl!))).toBe(true);
    expect(search.queries.filter((x) => x.startsWith("site:")).every((x) => x.startsWith("site:reddit.com "))).toBe(true);
    // An unknown source name is ignored rather than searched.
    const odd = await findPublicAsks({ competitors: ["Acme"], sources: ["facebook" as never] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(odd.findings.length).toBeGreaterThan(findings.length);
  });

  it("leaves out conversations older than asked for, and says how many", async () => {
    const all = await findPublicAsks({ competitors: ["Acme"], sources: ["reddit"] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(all.findings.some((f) => f.evidenceUrl!.includes("zzz999"))).toBe(true);
    resetSearchCache();
    const recent = await findPublicAsks({ competitors: ["Acme"], sources: ["reddit"], days: 90 }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(recent.findings.some((f) => f.evidenceUrl!.includes("zzz999"))).toBe(false);
    expect(recent.trace.notes).toContain("1 conversation older than 90 days was left out.");
    // A result that shows no date is kept: no date is invented for it.
    expect(recent.findings.find((f) => f.evidenceUrl!.includes("1def567"))!.signalAt).toBeUndefined();
  });

  it("a search source that returns anything at all for a degraded query produces nothing", async () => {
    const junk = searchWith(() => [...PROBLEM, ...CATEGORY, r("Looking for an alternative to Zeta : r/sales", "https://www.reddit.com/r/sales/comments/1qqq111/looking_for_an_alternative_to_zeta/", "I'm looking for an alternative to Zeta. Any recommendations?")]);
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [junk] } });
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("The searches answered, but none of the results was a person asking or complaining.");
  });

  it("stays within its search allowance, and respects the limit", async () => {
    const search = searchWith(answer);
    const { trace } = await findPublicAsks({ competitors: ["Acme", "Rival", "Zeta", "Omega"], problems: ["onboarding contractors", "tracking equipment"], category: "employee onboarding software" }, { searchOpts: { providers: [search] }, limit: 200 });
    expect(search.queries).toHaveLength(24);
    // Twenty-four web searches, and eight questions to the Hacker News search (one per subject, then one more).
    expect(net.calls.filter((c) => c.startsWith("https://hn.algolia.com/"))).toHaveLength(8);
    expect(trace.searches).toBe(32);
    expect(trace.notes.some((n) => /^24 of \d+ searches were run/.test(n))).toBe(true);
    resetSearchCache();
    const two = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, limit: 2 });
    expect(two.findings).toHaveLength(2);
    // The surest of what was found before the search stopped (two clear asks; neither result shows a date).
    expect(two.findings.map((f) => f.confidence)).toEqual([0.6, 0.6]);
  });

  it("is blocked, with a plain sentence, when nothing could be searched", async () => {
    const failed = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [brokenSearch()] } });
    expect(failed.findings).toEqual([]);
    expect(failed.trace).toMatchObject({ blocked: true, blockedReason: "Every search failed, so nothing could be checked this time. This is not a result about your market - try again later." });
    expect(failed.trace.failedSearches).toBe(failed.trace.searches);
    const none = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [brokenSearch("duckduckgo"), brokenSearch("bing_html")] } });
    expect(none.trace).toMatchObject({ blocked: true, blockedReason: "No search source is connected on our side, so this run could not search. This is not a result about your market." });
    const empty = await findPublicAsks({}, { searchOpts: { providers: [searchWith(answer)] } });
    expect(empty.trace).toMatchObject({ blocked: true, blockedReason: "No competitor, problem or category was given, so there was nothing to search for." });
    const late = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, deadlineAt: Date.now() - 1 });
    expect(late.findings).toEqual([]);
    expect(late.trace.searches).toBe(0);
  });

  it("a search that never answers cannot hold the run past its deadline", async () => {
    vi.useRealTimers();
    const hung = { ...searchWith(answer), search: () => new Promise<SearchResult[]>(() => {}) };
    const started = Date.now();
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [hung] }, deadlineAt: Date.now() + 150 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("The run reached its time limit before anything could be checked. This is not a result about your market.");
    expect(trace.notes).toContain("The run reached its time limit and stopped early. What was found before that is kept.");
  });

  it("a model that never answers cannot hold the run past its deadline either, and the rules' findings are kept", async () => {
    vi.useRealTimers();
    const hungAi = { name: "slow", model: "m", complete: () => new Promise<string>(() => {}) };
    const started = Date.now();
    // (Long enough for the searches to be started: none is, once less than one search's time is left.)
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, ai: hungAi, deadlineAt: Date.now() + 4_400 });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(trace.aiCalls).toBe(1);
    expect(trace.blocked).toBe(false);
    expect(findings.some((x) => x.evidenceUrl!.includes("priya-shah"))).toBe(true);
  }, 10_000);

  it("a competitor's name from the customer cannot smuggle a link or a line break into a reason", async () => {
    const name = "Acme\nvisit https://evil.example/pay";
    const search = searchWith(() => [r("Looking for an alternative to Acme visit https://evil.example/pay : r/x", "https://www.reddit.com/r/x/comments/1aaa111/t/", "I'm looking for an alternative to Acme visit https://evil.example/pay now")]);
    const { findings } = await findPublicAsks({ competitors: [name] }, { searchOpts: { providers: [search] } });
    for (const f of findings) expect(f.relevantBecause).not.toMatch(/https?:|evil\.example|[\r\n]/);
  });
});

/* ───────────────────────────────── Hacker News, asked directly ───────────────────────────────── */

describe("the Hacker News search", () => {
  const iso = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();
  const story = (id: number, title: string, text: string, daysAgo: number) => ({ objectID: String(id), title, story_text: text, created_at: iso(daysAgo), created_at_i: Math.floor((NOW - daysAgo * 86_400_000) / 1000), _tags: ["story"] });
  const comment = (id: number, on: string, text: string, daysAgo: number) => ({ objectID: String(id), story_title: on, comment_text: text, created_at: iso(daysAgo), created_at_i: Math.floor((NOW - daysAgo * 86_400_000) / 1000), _tags: ["comment"] });
  const HITS = [
    story(46100001, "Ask HN: Alternatives to Acme for a small team?", "We have used Acme for two years and the new pricing does not work for us. What do you use instead?", 6),
    comment(46100002, "Ask HN: What does your onboarding stack look like?", "<p>We are on Acme and I&#x27;m looking for an alternative to Acme that handles contractors. Any recommendations?</p>", 12),
    story(46100003, "Show HN: Onbordo, an open-source alternative to Acme", "We built Onbordo because Acme was too expensive.", 3),
    story(46100004, "I built an open-source onboarding tool after getting frustrated with Acme's pricing", "", 9),
    story(33244922, "Ask HN: Acme alternative?", "Looking for an alternative to Acme. Any suggestions?", 1450),
    comment(46100006, "Ask HN: Alternatives to Zeta?", "We moved to Zeta last year and it has been fine.", 4),
    { objectID: "not-a-number", title: "Ask HN: Alternatives to Acme?" },
    "junk",
  ];
  const hn = (hits: unknown[] = HITS) => (url: string): Route | undefined => (url.startsWith("https://hn.algolia.com/api/v1/search_by_date?") ? { body: JSON.stringify({ hits }), type: "application/json" } : undefined);
  const NO_WEB = searchWith(() => []);

  it("is asked directly on its one public address, and dates every thread it returns", async () => {
    use(hn());
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [NO_WEB] } });
    // Only that host, only the search endpoint, and what is asked is the subject.
    expect(net.hosts()).toEqual(["hn.algolia.com"]);
    expect(net.calls).toHaveLength(2);
    const first = new URL(net.calls[0]);
    expect(first.origin + first.pathname).toBe("https://hn.algolia.com/api/v1/search_by_date");
    // First the threads whose own title is about it, then the "Ask HN" threads that mention it anywhere.
    expect(first.searchParams.get("query")).toBe("Acme alternative");
    expect([first.searchParams.get("tags"), first.searchParams.get("restrictSearchableAttributes")]).toEqual(["story", "title"]);
    const second = new URL(net.calls[1]);
    expect([second.searchParams.get("query"), second.searchParams.get("tags"), second.searchParams.get("restrictSearchableAttributes")]).toEqual(["Acme", "ask_hn", null]);
    // No robots.txt is asked of an API, and no date limit is sent when none was asked for.
    expect(net.calls.join(" ")).not.toMatch(/robots\.txt|numericFilters/);

    const by = new Map(findings.map((f) => [f.evidenceUrl!, f]));
    expect([...by.keys()].sort()).toEqual(["https://news.ycombinator.com/item?id=33244922", "https://news.ycombinator.com/item?id=46100001", "https://news.ycombinator.com/item?id=46100002"]);
    expect(by.get("https://news.ycombinator.com/item?id=46100001")).toEqual({
      kind: "post",
      relevantBecause: "Hacker News thread asking for an alternative to Acme.",
      evidenceUrl: "https://news.ycombinator.com/item?id=46100001",
      evidenceTitle: "Ask HN: Alternatives to Acme for a small team?",
      evidenceQuote: "Ask HN: Alternatives to Acme for a small team?",
      signalType: "public_ask",
      signalAt: new Date(NOW - 6 * 86_400_000),
      confidence: 0.75,
    });
    // A comment is judged by its own words (markup and entities read as text), and shown under the thread it is in.
    expect(by.get("https://news.ycombinator.com/item?id=46100002")).toMatchObject({ evidenceTitle: "Comment on: Ask HN: What does your onboarding stack look like?", evidenceQuote: "We are on Acme and I'm looking for an alternative to Acme that handles contractors.", signalAt: new Date(NOW - 12 * 86_400_000), confidence: 0.75 });
    // The API calls count as searches, and they answered.
    expect(trace).toMatchObject({ blocked: false, failedSearches: 0 });
    expect(trace.searches).toBe(2 + NO_WEB.queries.length);
  });

  it("a launch post is somebody selling, not asking", async () => {
    use(hn());
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [NO_WEB] } });
    expect(findings.map((f) => f.evidenceUrl).join(" ")).not.toMatch(/46100003|46100004|46100006/);
    for (const [title, text] of [
      ["Show HN: Onbordo, an open-source alternative to Acme", "We built Onbordo because Acme was too expensive."],
      ["I built an open-source CRM after getting frustrated with Acme's pricing", ""],
      ["I made a cheaper alternative to Acme", "Frustrated with Acme, so I made my own."],
      ["We built a tool because Acme is too expensive", ""],
      ["Introducing Onbordo: for teams tired of Acme", "Acme is too expensive for what it does."],
      ["Launch HN: Onbordo (YC W26) - an alternative to Acme", ""],
      ["I'm building an Acme alternative, looking for feedback", "Any recommendations?"],
    ]) {
      expect(classifyAsk(title, text, "Acme"), title).toBeNull();
    }
    // Having built something years ago is not the same as announcing it - but the wording is the seller's, so it stays out.
    expect(classifyAsk("Ask HN: Alternatives to Acme?", "We have used Acme for two years.", "Acme")).toMatchObject({ kind: "ask" });
  });

  it("an old thread, or one with no date, is kept with less confidence; with a number of days set, a thread known to be older is left out", async () => {
    use(hn());
    const all = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [NO_WEB] } });
    const old = all.findings.find((f) => f.evidenceUrl!.endsWith("33244922"))!;
    expect(old).toMatchObject({ confidence: 0.35, signalAt: new Date(NOW - 1450 * 86_400_000) });
    // Nothing in the sentence claims it is recent.
    expect(old.relevantBecause).toBe("Hacker News thread asking for an alternative to Acme.");
    expect(all.findings[all.findings.length - 1].evidenceUrl).toBe(old.evidenceUrl);

    resetSearchCache();
    use(hn());
    const recent = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"], days: 90 }, { searchOpts: { providers: [NO_WEB] } });
    // The search itself is asked for the period only, and anything older that still comes back is dropped.
    expect(new URL(net.calls[0]).searchParams.get("numericFilters")).toBe(`created_at_i>${Math.floor((NOW - 90 * 86_400_000) / 1000)}`);
    expect(recent.findings.map((f) => f.evidenceUrl).sort()).toEqual(["https://news.ycombinator.com/item?id=46100001", "https://news.ycombinator.com/item?id=46100002"]);
    expect(recent.trace.notes).toContain("1 conversation older than 90 days was left out.");
  });

  it.each([
    [0.75, 10, 0.75],
    [0.75, 90, 0.75],
    [0.75, 200, 0.5],
    [0.75, 800, 0.35],
    [0.5, 200, 0.3],
    [0.75, null, 0.6],
    [0.5, null, 0.35],
  ])("confidence %s at %s days old is %s", (confidence, days, expected) => {
    expect(agedConfidence(confidence, days === null ? null : new Date(NOW - days * 86_400_000), NOW)).toBeCloseTo(expected, 5);
  });

  it("answers when web search does not, and is not asked at all when Hacker News was not chosen", async () => {
    use(hn());
    const down = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [brokenSearch("duckduckgo"), brokenSearch("bing_html")] } });
    expect(down.trace.blocked).toBe(false);
    expect(down.findings.length).toBe(3);
    expect(down.trace.notes.some((n) => / searches did not get an answer, so some results may be missing\.$/.test(n))).toBe(true);

    resetSearchCache();
    resetProviderSkips();
    use(hn());
    await findPublicAsks({ competitors: ["Acme"], sources: ["linkedin", "reddit"] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(net.calls).toEqual([]);
  });

  it("a search API that is down, slow or answers with something else is a search that did not answer", async () => {
    for (const route of [undefined, { status: 503, body: "down" }, { body: "<html>Just a moment...</html>", type: "text/html" }, { body: "{not json", type: "application/json" }, { body: JSON.stringify({ hits: "many" }), type: "application/json" }] as (Route | undefined)[]) {
      resetSearchCache();
      use(() => route);
      const { findings, trace } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [brokenSearch()] } });
      expect(findings).toEqual([]);
      expect(trace.blocked).toBe(true);
      expect(trace.failedSearches).toBe(trace.searches);
    }
  });

  it("web results for separate threads are separate threads", async () => {
    // Two threads whose addresses differ only in the query string.
    const search = searchWith((q) =>
      q.includes("Acme")
        ? [r("Ask HN: Alternatives to Acme for a 40-person team? | Hacker News", "https://news.ycombinator.com/item?id=41234567", "We have used Acme for two years."), r("Ask HN: Anyone moved away from Acme? | Hacker News", "https://news.ycombinator.com/item?id=41239990", "Has anyone switched from Acme to something cheaper?")]
        : [],
    );
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [search] } });
    expect(findings.map((f) => f.evidenceUrl).sort()).toEqual(["https://news.ycombinator.com/item?id=41234567", "https://news.ycombinator.com/item?id=41239990"]);
  });
});

describe("a LinkedIn author is a person only when we are sure of it", () => {
  it("a brand made of everyday words is a page, whatever its capitals say", () => {
    for (const no of ["New Breed on LinkedIn: 20 Performance Benchmarks", "Best Lifetime Deals on LinkedIn: Looking for an alternative to Acme?", "Growth Leads on LinkedIn: x", "Smart Revenue on LinkedIn: x", "Elto AI on LinkedIn: x", "J Smith on LinkedIn: x", "A B on LinkedIn: x"]) {
      expect(linkedinPostAuthor(no), no).toBeNull();
    }
    // One everyday word among real names means nothing.
    for (const [title, name] of [["George Best on LinkedIn: x", "George Best"], ["Rose Nguyen on LinkedIn: x", "Rose Nguyen"], ["Will Power on LinkedIn: x", "Will Power"], ["Adam D'Angelo on LinkedIn: Does anyone have experience", "Adam D'Angelo"]]) {
      expect(linkedinPostAuthor(title), title).toMatchObject({ name });
    }
  });

  it.each([
    ["priya-shah-4b6a2311", "Priya Shah", true],
    ["maxlmaeder", "Max Maeder", true],
    ["marcopapa82", "Marco Papa", true],
    ["mattwatsonkc", "Matt Watson", true],
    ["adamdangelo1", "Adam D'Angelo", true],
    ["wiltermood", "Calvin Wiltermood", true],
    ["jane-doe-phd", "Jane Doe", true],
    ["mary-jane-watson", "Mary Watson", true],
    ["new-breed-revenue", "New Breed", false],
    ["leadiq-inc", "Lead Iq", false],
    ["john-smith-marketing", "John Smith", false],
    ["smithconsulting", "John Smith", false],
    ["thedigitalmarketingconsultant", "Ryan Stewart", false],
    ["x", "Jane Doe", false],
  ])("the profile address %s for %s: %s", (vanity, name, expected) => {
    expect(vanityMatches(vanity, name)).toBe(expected);
  });

  it("a company page that asks is a conversation to answer, never a person with a profile address", async () => {
    const posts = [
      r("New Breed on LinkedIn: We're looking for an alternative to Acme. Any recommendations?", "https://www.linkedin.com/posts/new-breed-revenue_acme-activity-7250000000000000011-aaaa", "We're looking for an alternative to Acme. Any recommendations?"),
      r("John Smith on LinkedIn: I'm looking for an alternative to Acme. Any recommendations?", "https://www.linkedin.com/posts/john-smith-marketing_acme-activity-7250000000000000012-bbbb", "I'm looking for an alternative to Acme. Any recommendations?"),
      r("Dana Scully on LinkedIn: I'm looking for an alternative to Acme. Any recommendations?", "https://www.linkedin.com/posts/danascully7_acme-activity-7250000000000000013-cccc", "I'm looking for an alternative to Acme. Any recommendations?"),
    ];
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["linkedin"] }, { searchOpts: { providers: [searchWith((q) => (q.includes("Acme") ? posts : []))] } });
    expect(findings).toHaveLength(3);
    const people = findings.filter((f) => f.kind === "person");
    expect(people.map((f) => f.linkedinUrl)).toEqual(["https://www.linkedin.com/in/danascully7"]);
    for (const f of findings.filter((x) => x.kind === "post")) {
      expect(f.linkedinUrl).toBeUndefined();
      expect(f.fullName).toBeUndefined();
      expect(f.relevantBecause).toBe("LinkedIn post asking for an alternative to Acme.");
    }
  });
});

describe("a Hacker News post that only mentions the subject is not about it", () => {
  const at = (daysAgo: number) => ({ created_at: new Date(NOW - daysAgo * 86_400_000).toISOString() });
  const HITS = [
    // An "Ask HN" about something else, which names the product once in passing.
    { objectID: "49000001", title: "Ask HN: Is traditional software dying?", story_text: "My data points: two internal projects to replace Acme and Float. Acme will be kept, Float will be replaced. What do you all think?", ...at(20) },
    // The product in a list of integrations, in a thread that asks something unrelated.
    { objectID: "49000002", title: "Ask HN: How can I improve my products? Which one to keep working on?", story_text: "A single report from all tools like Gmail, Slack, GitHub, Acme etc. Which should I pick?", ...at(25) },
    // A comment that names it without asking anything.
    { objectID: "49000003", story_title: "Somebody files for an IPO", comment_text: "I've moved folks to Monday, Nutshell, Acme (who I don't like either but they're better than the rest), a dozen others.", ...at(30) },
    // A real one: the thread is about choosing between it and something else.
    { objectID: "49000004", title: "Ask HN: CRM vs. Acme", story_text: "We've been using Acme and, in my opinion, it's the best among a bad bunch. Has anyone here used Clarify?", ...at(40) },
    // A real one inside a thread about something else: the sentences that name the product ask.
    { objectID: "49000005", story_title: "Ask HN: What does your stack look like?", comment_text: "Postgres, Rails, the usual. We are on Acme for onboarding and I'm looking for an alternative to Acme. Any recommendations? Otherwise boring tech.", ...at(10) },
  ];
  const PROBLEM_HITS = [
    { objectID: "49100001", title: "Ask HN: Email leaked while traveling abroad?", story_text: "I received an email in German to an email address that I have never used. How do I verify where it leaked?", ...at(5) },
    { objectID: "49100002", title: "Tell HN: A shop will not let me change country", story_text: "If anybody reads this, please let me know an email address so I can contact a real human to verify that my account is real.", ...at(50) },
    { objectID: "49100003", title: "Ask HN: What do you use to verify email addresses before sending?", story_text: "We send about 40k cold emails a month and our bounce rate is climbing. Looking for a tool that can verify email addresses in bulk.", ...at(8) },
  ];
  const serve = (hits: unknown[]) => (url: string): Route | undefined => (url.startsWith("https://hn.algolia.com/") ? { body: JSON.stringify({ hits }), type: "application/json" } : undefined);

  it("for a competitor: only where the product is named is somebody asking about it", async () => {
    use(serve(HITS));
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [searchWith(() => [])] } });
    const by = new Map(findings.map((f) => [f.evidenceUrl!.split("=")[1], f]));
    expect([...by.keys()].sort()).toEqual(["49000004", "49000005"]);
    expect(by.get("49000004")).toMatchObject({ relevantBecause: "Hacker News thread asking about Acme.", evidenceTitle: "Ask HN: CRM vs. Acme", evidenceQuote: "Has anyone here used Clarify?" });
    expect(by.get("49000005")).toMatchObject({ relevantBecause: "Hacker News thread asking for an alternative to Acme.", evidenceTitle: "Comment on: Ask HN: What does your stack look like?", evidenceQuote: "We are on Acme for onboarding and I'm looking for an alternative to Acme." });
  });

  it("for a problem: only somebody asking for something to solve it with", async () => {
    use(serve(PROBLEM_HITS));
    const { findings } = await findPublicAsks({ problems: ["verify email addresses"], sources: ["hackernews"] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(findings.map((f) => f.evidenceUrl)).toEqual(["https://news.ycombinator.com/item?id=49100003"]);
    expect(findings[0]).toMatchObject({ relevantBecause: "Hacker News thread asking which tool to use for verify email addresses.", evidenceTitle: "Ask HN: What do you use to verify email addresses before sending?" });
  });

  it("a question on Hacker News is not, by itself, somebody looking for a product", () => {
    expect(classifyAsk("Ask HN: Is traditional software dying?", "Two internal projects to replace Acme.", "Acme")).toBeNull();
    expect(classifyAsk("Ask HN: How do you get a registrar to take abuse reports seriously?", "", undefined)).toBeNull();
    expect(classifyAsk("Ask HN: Alternatives to Acme for a 40-person team?", "", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("Ask HN: What do you use for onboarding contractors?", "", undefined)).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("Ask HN: Which CRM would you pick for a ten-person team?", "", undefined)).toMatchObject({ kind: "ask" });
    expect(classifyAsk("Ask HN: Best tool to verify email addresses?", "", undefined)).toMatchObject({ kind: "ask" });
  });
});

/* ───────────────────────── what a second look at live Hacker News results found ───────────────────────── */

describe("asking, as opposed to using the words of asking", () => {
  it("'any ... using' is not 'anyone using': somebody has to be asked, and as a question", () => {
    // A list of facts about one company's mail, in a thread about something else.
    expect(classifyAsk("", "- We are not on any known/public blacklists Note that we are using Globex Workspaces, but that does not seem to be the issue.")).toBeNull();
    expect(classifyAsk("", "I am curious how folks handle imports into systems like Acme, Initech, Hooli, or really any app that uses template based import.", "Acme")).toBeNull();
    expect(classifyAsk("", "If anyone uses this in production they should read the changelog first.")).toBeNull();
    // Somebody asked.
    expect(classifyAsk("", "We have been on Acme for two years. Has anyone here used Clarify?", "Acme")).toMatchObject({ kind: "ask", strong: true, quote: "Has anyone here used Clarify?" });
    expect(classifyAsk("Ask HN: Anyone using Acme for a team of forty", "", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "Does anybody know of a tool that verifies addresses in bulk?")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "Can someone recommend a CRM that is not Acme?", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "Any recommendations for a CRM that handles contractors?")).toMatchObject({ kind: "ask", strong: true });
    // "Any alternatives ...?" is what a seller's hook says too: an ask, but an unsure one.
    expect(classifyAsk("", "Any good alternatives to Acme?", "Acme")).toMatchObject({ kind: "ask", strong: false });
  });

  it("'need to move' is somebody leaving only when they say so of themselves, and away from something", () => {
    // An essay about a market.
    expect(classifyAsk("Do you think Initech is Hooli circa the 1980s?", "The need to move upwards in the market in enterprise software is difficult, since sticking with Acme plus its new features is much simpler than the cost of switching.", "Acme")).toBeNull();
    expect(classifyAsk("", "Companies are looking to move into new markets every year.", "Acme")).toBeNull();
    expect(classifyAsk("", "We are thinking of moving to Acme next year.", "Acme")).toBeNull();
    // Somebody leaving.
    expect(classifyAsk("", "We need to move off Acme before the renewal.", "Acme")).toMatchObject({ kind: "ask", strong: true, leaving: true });
    expect(classifyAsk("", "I'm thinking of switching away from Acme after the price change.", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "Our team has decided to migrate from Acme to something simpler.", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "We are planning to cancel Acme this quarter.", "Acme")).toMatchObject({ kind: "ask", strong: true });
    expect(classifyAsk("", "It is time to move away from Acme.", "Acme")).toMatchObject({ kind: "ask", strong: true });
  });

  it("one product among several named side by side is an example, not the subject", () => {
    expect(merelyListed("How do folks prepare imports into systems like Acme, Initech, Hooli, or really any app that takes a template?", "Acme")).toBe(true);
    expect(merelyListed("Acme, Initech, or Hooli: which is most ripe for disruption?", "Acme")).toBe(true);
    expect(merelyListed("Many engineers complain about Acme (bloated, expensive), Initech (complex, costly) and Hooli (overpriced).", "Initech")).toBe(true);
    // Named on its own as well: it is what the text is about.
    expect(merelyListed("We use Acme, Initech and Hooli. Acme is the one we want to replace.", "Acme")).toBe(false);
    expect(merelyListed("Looking for an alternative to Acme.", "Acme")).toBe(false);
    // A list in brackets is a list.
    expect(merelyListed("The idea is simple: connect your stack (Stripe, Acme, PostHog, LiveKit, etc.) and chat with your data.", "Acme")).toBe(true);
    // Two names are a comparison, not a list.
    expect(merelyListed("Acme or Initech for a small team?", "Acme")).toBe(false);
    expect(merelyListed("Nothing here names it.", "Acme")).toBe(false);
  });
});

describe("Hacker News: who is complaining, and who is studying a market", () => {
  const at = (daysAgo: number) => ({ created_at: new Date(NOW - daysAgo * 86_400_000).toISOString() });
  const HITS = [
    // A builder researching a market: the words of a complaint, and nobody complaining.
    { objectID: "50000001", author: "builder1", title: "What's still broken in Acme document generation?", story_text: "Curious whether this is a real, unsolved problem. What do you hate about it?", ...at(20) },
    // A startup-idea question that reports what others say - posted twice by the same author, once with "Ask HN:".
    { objectID: "50000002", author: "founder2", title: "Acme, Initech, or Hooli: Which Is Most Ripe for Disruption?", story_text: "Many founders and engineers complain about Acme (bloated, expensive), Initech (complex, costly), and Hooli (overpriced).", ...at(30) },
    { objectID: "50000003", author: "founder2", title: "Ask HN: Acme, Initech, or Hooli: Which Is Most Ripe for Disruption?", story_text: "Many founders and engineers complain about Acme (bloated, expensive), Initech (complex, costly), and Hooli (overpriced).", ...at(30) },
    // An opinion essay that reads, in one line, like somebody who needs to move.
    { objectID: "50000004", author: "essayist", title: "Do You Think Initech Is Hooli Circa the 1980s?", story_text: "The need to move upwards in the market is difficult, since sticking with Acme plus its new features is much simpler than switching.", ...at(60) },
    // The product as one example in a list, in a question about something else.
    { objectID: "50000005", author: "dataperson", title: "Ask HN: How are you cleaning data before imports?", story_text: "Hi all, I'm curious how folks handle the prep work for imports into systems like Acme, Initech, Hooli, or really any app that uses template based import.", ...at(140) },
    // Somebody who uses it, complaining about it.
    { objectID: "50000006", author: "user6", title: "Tell HN: Acme doubled our bill overnight", story_text: "We have been on Acme for three years and I am frustrated with Acme: support is useless and the price went up twice.", ...at(15) },
    // A genuine ask, recent; and the same one posted again by the same author a minute later.
    { objectID: "50000007", author: "asker7", title: "Ask HN: Alternatives to Acme for a small team?", story_text: "The new pricing does not work for us. What do you use instead?", ...at(5) },
    { objectID: "50000008", author: "asker7", title: "Ask HN: Alternatives to Acme for a small team?", story_text: "The new pricing does not work for us. What do you use instead?", ...at(5) },
    // The same title from somebody else is somebody else's ask.
    { objectID: "50000009", author: "asker9", title: "Ask HN: Alternatives to Acme for a small team?", story_text: "Same question a year on. What do you use instead?", ...at(400) },
  ];
  const serve = (url: string): Route | undefined => (url.startsWith("https://hn.algolia.com/") ? { body: JSON.stringify({ hits: HITS }), type: "application/json" } : undefined);

  it("keeps the asks and the complaint of somebody who has one, each once, with the recent ask on top", async () => {
    use(serve);
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(findings.map((f) => [f.evidenceUrl!.split("=")[1], f.signalType, f.confidence])).toEqual([
      ["50000007", "public_ask", 0.75],
      ["50000006", "public_complaint", 0.7],
      ["50000009", "public_ask", 0.35],
    ]);
    expect(findings[1]).toMatchObject({ relevantBecause: "Hacker News thread complaining about Acme.", evidenceQuote: "Tell HN: Acme doubled our bill overnight" });
  });

  it("somebody launching a product, or looking for people to try it, is selling", async () => {
    const launch = [
      // Announced by its title; the product is named in a list of what it connects to, and the author is "looking for" design partners.
      { objectID: "50000101", author: "maker", title: "Launching Loomdata - a RevOps layer for early stage startups", story_text: "That is why I am making Loomdata. The idea is simple: connect your stack (Stripe, Acme, PostHog, LiveKit, etc.) and chat with your data. No need to switch platforms. Right now, I'm looking for design partners.", ...at(40) },
      { objectID: "50000102", author: "maker2", title: "Ask HN: Would you use a simpler Acme?", story_text: "We are on Acme today. I'm looking for beta users for something simpler than Acme.", ...at(10) },
    ];
    use((url: string): Route | undefined => (url.startsWith("https://hn.algolia.com/") ? { body: JSON.stringify({ hits: launch }), type: "application/json" } : undefined));
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["hackernews"] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(findings).toEqual([]);
    expect(classifyAsk("", "Right now, I'm looking for design partners.")).toBeNull();
    expect(classifyAsk("Launching Loomdata", "Anyone using Acme who wants to try it?", "Acme")).toBeNull();
    // Looking for a product is still an ask.
    expect(classifyAsk("", "Right now, I'm looking for a CRM that is not Acme.", "Acme")).toMatchObject({ kind: "ask", strong: true });
  });

  it("a complaint is the speaker's own on Hacker News: a report of what others say is not one", () => {
    expect(classifyAsk("Acme: which part is worst?", "Many founders and engineers complain about Acme being bloated and overpriced.", "Acme")).toMatchObject({ kind: "complaint", own: false });
    expect(classifyAsk("What's still broken in Acme document generation?", "", "Acme")).toMatchObject({ kind: "complaint", own: false });
    expect(classifyAsk("", "I am frustrated with Acme: our bill doubled.", "Acme")).toMatchObject({ kind: "complaint", own: true });
  });

  it("elsewhere a complaint is kept as before", async () => {
    use(() => undefined);
    const reddit = searchWith(() => [{ title: "Acme pricing is a rip-off : r/sales", url: "https://www.reddit.com/r/sales/comments/1abc999/acme_pricing/", snippet: "Acme is overpriced and the support is terrible.", provider: "stub" }]);
    const { findings } = await findPublicAsks({ competitors: ["Acme"], sources: ["reddit"] }, { searchOpts: { providers: [reddit] } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ signalType: "public_complaint", relevantBecause: "Reddit thread complaining about Acme." });
  });
});
