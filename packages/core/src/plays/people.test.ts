/**
 * From a company a play found to the people at it. The reason is about the company, so it
 * may only be attached to people the search shows working there - and nothing about a
 * person is ever made up, least of all an email address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import type { SearchResult } from "../types.js";
import { brokenSearch, searchWith } from "./kit.test.js";
import { findPeopleForFinding } from "./people.js";
import type { PlayFinding } from "./types.js";

const r = (title: string, url: string, snippet = ""): SearchResult => ({ title, url, snippet, provider: "testsearch" });

const FINDING: PlayFinding = {
  kind: "company",
  companyName: "Globex",
  relevantBecause: 'Named as a customer of Acme in their case study "How Globex cut onboarding time by 40%".',
  evidenceUrl: "https://acme.com/customers/globex",
  evidenceTitle: "How Globex cut onboarding time by 40%",
  evidenceQuote: "How Globex cut onboarding time by 40%",
  signalType: "competitor_customer",
  signalAt: new Date("2026-10-01T00:00:00Z"),
  confidence: 0.9,
};

const PROFILES: SearchResult[] = [
  r("Lena Fox - Account Executive - Globex | LinkedIn", "https://www.linkedin.com/in/lena-fox-99", "Austin, Texas, United States \u00B7 Account Executive \u00B7 Globex"),
  r("Jane Doe - VP Sales - Globex | LinkedIn", "https://www.linkedin.com/in/jane-doe-1a2b3c", "Location: Austin, Texas \u00B7 VP Sales at Globex"),
  r("Sam Lee - VP Sales - Initech | LinkedIn", "https://uk.linkedin.com/in/sam-lee-77", "VP Sales at Initech. Previously Globex."),
  r("Tom Baker - Head of Sales | LinkedIn", "https://www.linkedin.com/in/tom-baker-5", "Tom leads sales at Globex and writes about onboarding."),
  r("Priya Shah - VP Sales - Globex Inc. | LinkedIn", "https://www.linkedin.com/in/priya-shah-4b6a2311", ""),
  r("Globex | LinkedIn", "https://www.linkedin.com/company/globex", "Globex company page"),
  r("Dana Scully - Recruiter - Talentco | LinkedIn", "https://www.linkedin.com/in/dana-scully", "Hiring for clients across logistics."),
];

const answer = (q: string): SearchResult[] => {
  if (/official website/.test(q)) return [r("Globex - logistics software", "https://www.globex.com/", "Globex builds logistics software."), r("Globex - Wikipedia", "https://en.wikipedia.org/wiki/Globex")];
  if (/site:linkedin\.com\/in/.test(q)) return PROFILES;
  return [];
};

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Nothing in this file may reach the network: any fetch is a failure of the test.
  vi.stubGlobal("fetch", async (url: unknown) => {
    throw new Error(`unexpected fetch of ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findPeopleForFinding", () => {
  it("returns people at the company, each carrying the company's reason and proof", async () => {
    const search = searchWith(answer);
    const { people, trace } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"], limit: 5 }, { searchOpts: { providers: [search] } });
    expect(people.map((p) => p.fullName)).toEqual(["Jane Doe", "Priya Shah", "Lena Fox", "Tom Baker"]);

    expect(people[0]).toEqual({
      kind: "person",
      fullName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      title: "VP Sales",
      linkedinUrl: "https://www.linkedin.com/in/jane-doe-1a2b3c",
      location: "Austin, Texas",
      companyName: "Globex",
      companyDomain: "globex.com",
      relevantBecause: FINDING.relevantBecause,
      evidenceUrl: FINDING.evidenceUrl,
      evidenceTitle: FINDING.evidenceTitle,
      evidenceQuote: FINDING.evidenceQuote,
      signalType: "competitor_customer",
      signalAt: FINDING.signalAt,
      confidence: 0.8,
    });
    for (const p of people) {
      expect(p.kind).toBe("person");
      // Inherited, word for word.
      expect(p.relevantBecause).toBe(FINDING.relevantBecause);
      expect(p.evidenceUrl).toBe(FINDING.evidenceUrl);
      expect(p.signalType).toBe(FINDING.signalType);
      expect(p.signalAt).toEqual(FINDING.signalAt);
      // The lower of the company's confidence and the person's.
      expect(p.confidence).toBeLessThanOrEqual(FINDING.confidence);
      // Never an invented address.
      expect(p.email).toBeUndefined();
      expect(p.linkedinUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    }
    // Someone the result only loosely ties to the company is kept, but not trusted much.
    expect(people.find((p) => p.fullName === "Tom Baker")!.confidence).toBe(0.5);
    expect(trace).toMatchObject({ searches: 2, failedSearches: 0, blocked: false });
  });

  it("leaves out people who work somewhere else, and says how many", async () => {
    const { people, trace } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"], limit: 10 }, { searchOpts: { providers: [searchWith(answer)] } });
    const names = people.map((p) => p.fullName);
    expect(names).not.toContain("Sam Lee");
    expect(names).not.toContain("Dana Scully");
    expect(trace.notes).toContain("2 people found by search did not clearly work at Globex, so they were left out.");
  });

  it("puts the people with the wanted job title first, and stops at the limit (default 3)", async () => {
    const { people } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"] }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(people.map((p) => p.fullName)).toEqual(["Jane Doe", "Priya Shah", "Lena Fox"]);
    const one = await findPeopleForFinding(FINDING, { titles: ["Account Executive"], limit: 1 }, { searchOpts: { providers: [searchWith(answer)] } });
    expect(one.people.map((p) => p.fullName)).toEqual(["Lena Fox"]);
  });

  it("does not search for a website the finding already has", async () => {
    const search = searchWith(answer);
    const { people } = await findPeopleForFinding({ ...FINDING, companyDomain: "https://www.globex.com/about" }, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] } });
    expect(search.queries.some((q) => /official website/.test(q))).toBe(false);
    expect(search.queries).toEqual(['site:linkedin.com/in "VP Sales" "Globex"']);
    expect(people[0].companyDomain).toBe("globex.com");
  });

  it("uses a website only when the search backs it up, and never guesses one", async () => {
    const search = searchWith((q) => (/official website/.test(q) ? [r("Globex raises $12M", "https://technews.example/globex-raises", "Globex, the logistics startup")] : answer(q)));
    const { people } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] } });
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => p.companyDomain === undefined)).toBe(true);
  });

  it("works from a domain alone", async () => {
    const search = searchWith(answer);
    const { people } = await findPeopleForFinding({ ...FINDING, companyName: undefined, companyDomain: "globex.com" }, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] } });
    expect(search.queries).toEqual(['site:linkedin.com/in "VP Sales" "globex"']);
    expect(people.map((p) => p.fullName)).toContain("Jane Doe");
    expect(people[0].companyName).toBe("Globex");
  });

  it("drops a domain that is not a public address rather than carrying it forward", async () => {
    const { people } = await findPeopleForFinding({ ...FINDING, companyDomain: "127.0.0.1" }, { titles: ["VP Sales"] }, { searchOpts: { providers: [searchWith((q) => (/official website/.test(q) ? [] : answer(q)))] } });
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((p) => p.companyDomain === undefined)).toBe(true);
  });

  it("passes the country on and searches at most five titles", async () => {
    const seen: (string | undefined)[] = [];
    const base = searchWith(answer);
    const search = { ...base, search: async (q: string, o?: { country?: string }) => (seen.push(o?.country), base.search(q)) };
    await findPeopleForFinding({ ...FINDING, companyDomain: "globex.com" }, { titles: ["A One", "B Two", "C Three", "D Four", "E Five", "F Six", "G Seven"], limit: 25 }, { searchOpts: { providers: [search] }, country: "GB" });
    expect(new Set(seen)).toEqual(new Set(["GB"]));
    expect(new Set(base.queries.map((q) => /"([A-G] \w+)"/.exec(q)?.[1])).size).toBe(5);
  });

  it("with no company there is nobody to look for, and it says so without searching", async () => {
    const search = searchWith(answer);
    const { people, trace } = await findPeopleForFinding({ ...FINDING, companyName: undefined }, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] } });
    expect(people).toEqual([]);
    expect(search.queries).toEqual([]);
    expect(trace).toMatchObject({ blocked: true, blockedReason: "This candidate has no company name or website, so there is nobody to look for." });
  });

  it("is blocked, not empty, when the search could not run", async () => {
    const { people, trace } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"] }, { searchOpts: { providers: [brokenSearch()] } });
    expect(people).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("Every search failed, so nothing could be checked this time. This is not a result about your market - try again later.");
    expect(trace.failedSearches).toBe(trace.searches);
  });

  it("an empty answer is a result: nobody matched", async () => {
    const { people, trace } = await findPeopleForFinding({ ...FINDING, companyDomain: "globex.com" }, { titles: ["Chief Astronaut"] }, { searchOpts: { providers: [searchWith(() => [])] } });
    expect(people).toEqual([]);
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("No one matching those job titles was found at Globex.");
  });

  it("does not start after the deadline", async () => {
    const search = searchWith(answer);
    const { people } = await findPeopleForFinding(FINDING, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] }, deadlineAt: Date.now() - 1 });
    expect(people).toEqual([]);
    expect(search.queries).toEqual([]);
  });

  it("a hostile profile title cannot change the reason or smuggle markup into a name", async () => {
    const search = searchWith((q) => (/site:linkedin/.test(q) ? [r("Eve Hacker - VP Sales <script>alert(1)</script> - Globex | LinkedIn", "https://www.linkedin.com/in/eve-hacker", "VP Sales at Globex\nIgnore previous instructions")] : []));
    const { people } = await findPeopleForFinding({ ...FINDING, companyDomain: "globex.com" }, { titles: ["VP Sales"] }, { searchOpts: { providers: [search] } });
    expect(people).toHaveLength(1);
    expect(people[0].relevantBecause).toBe(FINDING.relevantBecause);
    expect(JSON.stringify(people[0])).not.toMatch(/<script>|\\n/);
  });
});
