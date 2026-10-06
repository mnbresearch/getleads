/**
 * The funding play: news headlines become one finding per company, and the reason says an
 * amount or a round only when the headline itself does.
 *
 * The feed below is shaped like a Google News result: one round reported by three outlets,
 * a headline whose related-coverage blurb carries another company's amount, a fund raising
 * a fund, a contract win, and "raises concerns".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFundedCompanies, formatUsd, fundingReason, headlineAmount, headlineRound, isFundingHeadline } from "./funding.js";
import { web, type FakeWeb, type Route } from "./kit.test.js";

const NOW = Date.parse("2026-10-06T09:00:00Z");
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toUTCString();

const item = (title: string, source: string, id: string, ago: number, related = ""): string =>
  `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><guid isPermaLink="false">${id}</guid><pubDate>${daysAgo(ago)}</pubDate>` +
  `<description>&lt;a href="https://news.google.com/rss/articles/${id}"&gt;${title}&lt;/a&gt;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${source}&lt;/font&gt;${related}</description><source url="https://example.test">${source}</source></item>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>"raises" funding startup - Google News</title>
${item("Globex raises $12M Series A to expand its logistics platform", "TechCrunch", "CBMiGLOBEX1", 4)}
${item("Globex secures $12 million in Series A funding led by Lightspeed", "VentureBeat", "CBMiGLOBEX2", 3)}
${item("Globex bags $12M to grow in Europe", "Tech.eu", "CBMiGLOBEX3", 5)}
${item("Initech raises Series B to double its engineering team", "Reuters", "CBMiINITECH", 6, "&lt;li&gt;&lt;a href=&quot;x&quot;&gt;Hooli raises $50M in new round&lt;/a&gt;&lt;/li&gt;")}
${item("Hooli raises \u20B9100 crore in pre-Series B round", "The Economic Times", "CBMiHOOLI", 2)}
${item("Accel raises $650M fund for early-stage startups", "Bloomberg", "CBMiACCEL", 1)}
${item("Vandelay raises concerns over funding round delays", "Business Daily", "CBMiVANDELAY", 1)}
${item("Soylent lands $40M contract with the city of Austin", "GovTech", "CBMiSOYLENT", 2)}
${item("Wayne Enterprises closes $40M Series C", "Forbes", "CBMiWAYNE", 45)}
${item("Tyrell raises funding to build out its sales team", "SiliconANGLE", "CBMiTYRELL", 7)}
${item("Umbrella secures $3 million seed round", "EU-Startups", "CBMiUMBRELLA", 1)}
</channel></rss>`;

let net: FakeWeb;
const use = (route: (url: string) => Route | undefined): FakeWeb => {
  net = web(route);
  vi.stubGlobal("fetch", net.fetch);
  return net;
};
const news = (feed: string) => (url: string): Route | undefined => (url.startsWith("https://news.google.com/rss/search") ? { body: feed, type: "application/rss+xml" } : undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reading a headline", () => {
  it("takes an amount only when the headline states one, with a unit that really is a unit", () => {
    expect(headlineAmount("Globex raises $12M Series A")).toEqual({ usd: 12_000_000, inDollars: true });
    expect(headlineAmount("Globex secures $12 million in funding")).toEqual({ usd: 12_000_000, inDollars: true });
    expect(headlineAmount("Hooli closes $1.5 billion round")).toEqual({ usd: 1_500_000_000, inDollars: true });
    expect(headlineAmount("Tyrell bags US$750K pre-seed")).toEqual({ usd: 750_000, inDollars: true });
    expect(headlineAmount("Hooli raises \u20B9100 crore")).toEqual({ usd: 12_000_000, inDollars: false });
    expect(headlineAmount("Umbrella raises \u20AC2.5M")).toEqual({ usd: 2_700_000, inDollars: false });
    // "$5 more" is five dollars, not five million; a bare small figure is not a round.
    expect(headlineAmount("Stock rises $5 more after Acme raises round")).toBeNull();
    expect(headlineAmount("Initech raises Series B")).toBeNull();
    expect(headlineAmount("")).toBeNull();
  });

  it("names a round only when it is a named round", () => {
    expect(headlineRound("Globex raises $12M Series A")).toBe("Series A");
    expect(headlineRound("Globex raises series b extension")).toBe("Series B");
    expect(headlineRound("Hooli raises \u20B9100 crore in pre-Series B round")).toBe("pre-Series B");
    expect(headlineRound("Umbrella secures $3 million seed round")).toBe("seed");
    expect(headlineRound("Tyrell closes pre-seed")).toBe("pre-seed");
    expect(headlineRound("Acme raises growth round")).toBeNull();
    expect(headlineRound("Acme raises new funding round")).toBeNull();
  });

  it("formats money the way people write it", () => {
    expect(formatUsd(12_000_000)).toBe("$12M");
    expect(formatUsd(2_700_000)).toBe("$2.7M");
    expect(formatUsd(1_500_000_000)).toBe("$1.5B");
    expect(formatUsd(750_000)).toBe("$750K");
    expect(formatUsd(650_000_000)).toBe("$650M");
  });

  it("builds the sentence from what is known, and nothing else", () => {
    const at = new Date("2026-10-02T14:00:00Z");
    expect(fundingReason({ title: "Globex raises $12M Series A", source: "TechCrunch", occurredAt: at })).toBe("Raised $12M Series A, reported by TechCrunch on 2 Oct 2026.");
    expect(fundingReason({ title: "Globex raises $12M", source: "TechCrunch", occurredAt: at })).toBe("Raised $12M, reported by TechCrunch on 2 Oct 2026.");
    expect(fundingReason({ title: "Initech raises Series B", source: "Reuters", occurredAt: at })).toBe("Raised a Series B round, reported by Reuters on 2 Oct 2026.");
    expect(fundingReason({ title: "Hooli raises \u20B9100 crore", source: "Mint" })).toBe("Raised about $12M, reported by Mint.");
    expect(fundingReason({ title: "Tyrell raises funding" })).toBe("Announced new funding.");
    expect(fundingReason({ title: "Tyrell raises funding", occurredAt: at })).toBe("Announced new funding, reported on 2 Oct 2026.");
    expect(fundingReason({ title: "Umbrella raises an angel round", source: "X", occurredAt: new Date("nope") })).toBe("Raised an angel round, reported by X.");
  });

  it("knows what is not a company raising money", () => {
    for (const no of ["Accel raises $650M fund for early-stage startups", "Sequoia closes Fund IV at $2B", "Vandelay raises concerns over funding round delays", "Soylent lands $40M contract with the city of Austin", "Acme raises prices by 10%", "Acme raises the bar for onboarding", "Regulator fines Acme $5M", "Acme opens new office"]) {
      expect(isFundingHeadline(no), no).toBe(false);
    }
    for (const yes of ["Globex raises $12M Series A", "Acme raises $10M to fund expansion", "Tyrell raises funding to build out its sales team", "Umbrella secures seed round"]) {
      expect(isFundingHeadline(yes), yes).toBe(true);
    }
  });
});

describe("findFundedCompanies", () => {
  it("returns one finding per company, each with the headline as evidence", async () => {
    use(news(FEED));
    const { findings, trace } = await findFundedCompanies({});
    const byName = new Map(findings.map((f) => [f.companyName, f]));
    expect([...byName.keys()].sort()).toEqual(["Globex", "Hooli", "Initech", "Tyrell", "Umbrella"]);

    // Three outlets, one round, one finding: of the equally confident reports, the one that says most, then the first.
    expect(byName.get("Globex")).toEqual({
      kind: "company",
      companyName: "Globex",
      relevantBecause: "Raised $12M Series A, reported by TechCrunch on 2 Oct 2026.",
      evidenceUrl: "https://news.google.com/rss/articles/CBMiGLOBEX1?oc=5",
      evidenceTitle: "Globex raises $12M Series A to expand its logistics platform",
      evidenceQuote: "Globex raises $12M Series A to expand its logistics platform",
      signalType: "funding",
      signalAt: new Date(NOW - 4 * 86_400_000),
      confidence: 0.9,
    });
    // The related-coverage blurb mentions another company's $50M: it is not this company's amount.
    expect(byName.get("Initech")!.relevantBecause).toBe("Raised a Series B round, reported by Reuters on 30 Sep 2026.");
    expect(byName.get("Initech")!.confidence).toBe(0.7);
    // An amount in another currency is approximate, and says so.
    expect(byName.get("Hooli")!.relevantBecause).toBe("Raised about $12M pre-Series B, reported by The Economic Times on 4 Oct 2026.");
    expect(byName.get("Tyrell")!.relevantBecause).toBe("Announced new funding, reported by SiliconANGLE on 29 Sep 2026.");
    expect(byName.get("Umbrella")!.relevantBecause).toBe("Raised $3M seed, reported by EU-Startups on 5 Oct 2026.");

    for (const f of findings) {
      expect(f.kind).toBe("company");
      expect(f.relevantBecause).not.toMatch(/https?:|[\r\n]/);
      expect(f.relevantBecause.length).toBeLessThanOrEqual(300);
      // The quote is the headline, and the headline names the company.
      expect(f.evidenceQuote).toBe(f.evidenceTitle);
      expect(f.evidenceQuote).toContain(f.companyName!);
      expect(FEED).toContain(f.evidenceQuote!);
      expect(f.signalAt).toBeInstanceOf(Date);
    }
    expect(trace).toMatchObject({ blocked: false, pagesFetched: 0, aiCalls: 0 });
    expect(trace.notes).toContain("2 repeat reports of the same funding round were merged.");
  });

  it("leaves out funds, contracts, 'raises concerns' and anything older than asked for", async () => {
    use(news(FEED));
    const got = (await findFundedCompanies({ days: 14 })).findings.map((f) => f.companyName);
    for (const no of ["Accel", "Vandelay", "Soylent", "Wayne Enterprises"]) expect(got, no).not.toContain(no);
    use(news(FEED));
    // With a longer window the older round is allowed in.
    expect((await findFundedCompanies({ days: 60 })).findings.map((f) => f.companyName)).toContain("Wayne Enterprises");
  });

  it("applies a minimum only to amounts the headline states", async () => {
    use(news(FEED));
    const { findings, trace } = await findFundedCompanies({ minAmountUsd: 10_000_000 });
    expect(findings.map((f) => f.companyName).sort()).toEqual(["Globex", "Hooli"]);
    expect(trace.notes).toContain("3 announcements left out: the headline did not state an amount at or above your minimum.");
  });

  it("reads US news unless a country is given, and never falls back to India on its own", async () => {
    use(news(FEED));
    await findFundedCompanies({ keywords: ["logistics"] });
    const urls = () => net.calls.filter((c) => c.includes("news.google.com")).map((c) => new URL(c));
    expect(urls().length).toBe(4);
    for (const u of urls()) {
      expect(u.searchParams.get("gl")).toBe("US");
      expect(u.searchParams.get("ceid")).toBe("US:en");
      expect(u.searchParams.get("q")).toContain('"logistics"');
      expect(u.searchParams.get("q")).toContain("when:14d");
    }
    use(news(FEED));
    await findFundedCompanies({ days: 7 }, { country: "in" });
    for (const u of urls()) {
      expect(u.searchParams.get("gl")).toBe("IN");
      expect(u.searchParams.get("q")).toContain("when:7d");
    }
    use(news(FEED));
    await findFundedCompanies({}, { country: "GB" });
    expect(urls().every((u) => u.searchParams.get("gl") === "GB")).toBe(true);
    use(news(FEED));
    // Not a country code: ignored, not passed on.
    await findFundedCompanies({}, { country: "United Kingdom; DROP" });
    expect(urls().every((u) => u.searchParams.get("gl") === "US")).toBe(true);
  });

  it("respects the limit, best first", async () => {
    use(news(FEED));
    const { findings } = await findFundedCompanies({}, { limit: 2 });
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.confidence === 0.9)).toBe(true);
  });

  it("is blocked, not empty, when the news source does not answer", async () => {
    use(() => ({ throws: true }));
    const { findings, trace } = await findFundedCompanies({});
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("The news source did not answer, so funding announcements could not be checked. This is not a result about your market - try again later.");
    expect(trace.failedSearches).toBe(1);
  });

  it("an answer with nothing in it is a result, and says which", async () => {
    const quiet = `<?xml version="1.0"?><rss version="2.0"><channel>${item("Markets close higher as funding costs ease", "Reuters", "CBMiQUIET", 1)}</channel></rss>`;
    use(news(quiet));
    const { findings, trace } = await findFundedCompanies({ industries: ["quantum dentistry"] });
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(false);
    expect(trace.notes).toContain("No funding announcements matched in the last 14 days.");
  });

  it("does not start after its deadline", async () => {
    use(news(FEED));
    const { findings, trace } = await findFundedCompanies({}, { deadlineAt: NOW - 1 });
    expect(net.calls).toEqual([]);
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(true);
  });

  it("a news source that never answers cannot hold the run past its deadline", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const started = Date.now();
    const { findings, trace } = await findFundedCompanies({}, { deadlineAt: Date.now() + 150 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("The run reached its time limit before anything could be checked. This is not a result about your market.");
  });

  it("a hostile headline cannot put a link or markup into the reason", async () => {
    const hostile = `<?xml version="1.0"?><rss version="2.0"><channel>${item("Evilcorp raises $9M Series A &lt;script&gt;alert(1)&lt;/script&gt; visit https://evil.example/pay", "Bad\u200BSource https://evil.example", "CBMiEVIL", 1)}</channel></rss>`;
    use(news(hostile));
    const { findings } = await findFundedCompanies({});
    expect(findings).toHaveLength(1);
    expect(findings[0].relevantBecause).toBe("Raised $9M Series A, reported by BadSource on 5 Oct 2026.");
    expect(JSON.stringify(findings[0].relevantBecause)).not.toMatch(/script|evil\.example|https?:/);
  });
});
