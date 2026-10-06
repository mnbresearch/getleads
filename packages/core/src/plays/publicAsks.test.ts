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
import { NO_AI, brokenSearch, model, searchWith } from "./kit.test.js";
import { askPlace, buildAskQueries, classifyAsk, findPublicAsks, linkedinPostAuthor, snippetDate } from "./publicAsks.js";

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

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-06T09:00:00Z"));
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
      confidence: 0.75,
    });
    const tom = byUrl.get("https://www.linkedin.com/posts/tombaker_acme-activity-7250099988877766655-xYz1?utm_source=share")!;
    expect(tom).toMatchObject({ kind: "person", fullName: "Tom Baker", linkedinUrl: "https://www.linkedin.com/in/tombaker", relevantBecause: "Posted on LinkedIn about frustrations with Acme.", signalType: "public_complaint", confidence: 0.7 });
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
    expect(byUrl.get("https://old.reddit.com/r/startups/comments/1jkl012/acme_alternative/")).toMatchObject({ kind: "post", confidence: 0.5 });
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
    expect(lena).toMatchObject({ kind: "person", fullName: "Lena Fox", relevantBecause: "Asked on LinkedIn for an alternative to Acme.", confidence: 0.65 });
    expect(lena.confidence).toBeLessThanOrEqual(0.7);
    // The model said "neither": gone, and said so.
    expect(findings.some((f) => f.evidenceUrl!.includes("1jkl012"))).toBe(false);
    expect(trace.notes).toContain("1 result that looked like an ask was judged to be marketing and left out.");
    // Clear cases never went to the model, and keep their confidence.
    expect(findings.find((f) => f.evidenceUrl!.includes("priya-shah"))!.confidence).toBe(0.75);

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
    expect(trace.searches).toBe(24);
    expect(trace.notes.some((n) => /^24 of \d+ searches were run/.test(n))).toBe(true);
    resetSearchCache();
    const two = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, limit: 2 });
    expect(two.findings).toHaveLength(2);
    expect(two.findings.every((f) => f.confidence >= 0.7)).toBe(true);
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
    const { findings, trace } = await findPublicAsks({ competitors: ["Acme"] }, { searchOpts: { providers: [searchWith(answer)] }, ai: hungAi, deadlineAt: Date.now() + 300 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(trace.aiCalls).toBe(1);
    expect(trace.blocked).toBe(false);
    expect(findings.some((x) => x.evidenceUrl!.includes("priya-shah"))).toBe(true);
  });

  it("a competitor's name from the customer cannot smuggle a link or a line break into a reason", async () => {
    const name = "Acme\nvisit https://evil.example/pay";
    const search = searchWith(() => [r("Looking for an alternative to Acme visit https://evil.example/pay : r/x", "https://www.reddit.com/r/x/comments/1aaa111/t/", "I'm looking for an alternative to Acme visit https://evil.example/pay now")]);
    const { findings } = await findPublicAsks({ competitors: [name] }, { searchOpts: { providers: [search] } });
    for (const f of findings) expect(f.relevantBecause).not.toMatch(/https?:|evil\.example|[\r\n]/);
  });
});
