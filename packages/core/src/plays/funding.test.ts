/**
 * The funding play: news headlines become one finding per company, and the reason says an
 * amount or a round only when the headline itself does.
 *
 * The feed below is shaped like a Google News result: one round reported by three outlets,
 * a headline whose related-coverage blurb carries another company's amount, a fund raising
 * a fund, a contract win, and "raises concerns".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFundedCompanies, formatUsd, fundingReason, headlineAmount, headlineRound, isFundingHeadline, publisherName } from "./funding.js";
import { stripDescriptorPrefix } from "./shared.js";
import { mailSafeReason } from "./util.js";
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
    expect(headlineAmount("Globex raises $12M Series A")).toEqual({ usd: 12_000_000, inDollars: true, shown: "$12M" });
    expect(headlineAmount("Globex secures $12 million in funding")).toEqual({ usd: 12_000_000, inDollars: true, shown: "$12M" });
    expect(headlineAmount("Hooli closes $1.5 billion round")).toEqual({ usd: 1_500_000_000, inDollars: true, shown: "$1.5B" });
    expect(headlineAmount("Tyrell bags US$750K pre-seed")).toEqual({ usd: 750_000, inDollars: true, shown: "$750K" });
    // Another currency is shown as that currency, never as dollars; the dollar figure is only for comparing with a minimum.
    expect(headlineAmount("Hooli raises \u20B9100 crore")).toEqual({ usd: 12_000_000, inDollars: false, shown: "INR 100 crore" });
    expect(headlineAmount("Umbrella raises \u20AC2.5M")).toEqual({ usd: 2_700_000, inDollars: false, shown: "EUR 2.5M" });
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
    expect(fundingReason({ title: "Hooli raises \u20B9100 crore", source: "Mint" })).toBe("Raised INR 100 crore, reported by Mint.");
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
    // An amount in another currency is stated in that currency, not turned into dollars.
    expect(byName.get("Hooli")!.relevantBecause).toBe("Raised INR 100 crore pre-Series B, reported by The Economic Times on 4 Oct 2026.");
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

/* ───────────────────────────────── headlines as the news really writes them ───────────────────────────────── */

describe("a headline's description is not part of the company's name", () => {
  it.each([
    ["Nine-person Globex", "Globex"],
    ["Insurtech Initech", "Initech"],
    ["Space Insurer Hooli Space", "Hooli Space"],
    ["Ocular Disease Therapy Developer Tyrell", "Tyrell"],
    ["Korea's Wonka Robotics", "Wonka Robotics"],
    // Nothing that names a company is left.
    ["Korea's Dental Robotics", null],
    ["Basketball League", null],
    // A place or an everyday word inside a real name stays.
    ["Indian Walker", "Indian Walker"],
    ["Space Epoch", "Space Epoch"],
    ["Tiny Health", "Tiny Health"],
    ["Globex", "Globex"],
  ])("%s -> %s", (name, expected) => {
    expect(stripDescriptorPrefix(name)).toBe(expected);
  });
});

describe("what was raised, and what was not", () => {
  it("a valuation is not the amount raised", () => {
    expect(headlineAmount("Physical AI startup Globex raises seed round at $500M valuation")).toBeNull();
    expect(headlineAmount("Initech secures pre-seed funding at Rs 16.7 cr valuation")).toBeNull();
    expect(headlineAmount("Hooli, valued at $2B, raises new round")).toBeNull();
    expect(headlineAmount("Tyrell raises $97M Series B, valuing startup at $650M")).toMatchObject({ usd: 97_000_000, shown: "$97M" });
    expect(headlineAmount("Umbrella Secures $150M Series D at $2.3B Valuation")).toMatchObject({ shown: "$150M" });
    expect(headlineAmount("Wonka raises $1B Series C at a $10B valuation")).toMatchObject({ shown: "$1B" });
    expect(fundingReason({ title: "Physical AI startup Globex raises seed round at $500M valuation", source: "TechCrunch" })).toBe("Raised a seed round, reported by TechCrunch.");
  });

  it("a currency code after the number is that currency, not dollars", () => {
    expect(headlineAmount("Globex Secures $17M CAD in Funding")).toMatchObject({ inDollars: false, shown: "CAD 17M" });
    expect(headlineAmount("Initech raises A$5M seed")).toMatchObject({ inDollars: false, shown: "AUD 5M" });
    expect(headlineAmount("Hooli raises 8 million EUR")).toMatchObject({ inDollars: false, shown: "EUR 8M" });
    expect(headlineAmount("Tyrell secures \u00A38.30 million Series B")).toMatchObject({ shown: "GBP 8.3M" });
    expect(headlineAmount("Umbrella Raises \u20AC500,000 Pre-Seed Round")).toMatchObject({ shown: "EUR 500K" });
    expect(headlineAmount("Wonka bags Rs 1,750 Cr funding")).toMatchObject({ shown: "INR 1,750 crore" });
    expect(headlineAmount("Soylent Raises USD 16.7M Series B")).toMatchObject({ inDollars: true, shown: "$16.7M" });
    expect(headlineAmount("Oscorp raises $153-million in funding")).toMatchObject({ usd: 153_000_000, shown: "$153M" });
    // Two decimals in the headline are two decimals in the sentence: "$133.7M" is not what was reported.
    expect(headlineAmount("Stark Secures $133.65M Series A")).toMatchObject({ shown: "$133.65M" });
    expect(fundingReason({ title: "Globex Secures $17M CAD in Funding", source: "AI Insider" })).toBe("Raised CAD 17M, reported by AI Insider.");
    // A bare number is not money.
    expect(headlineAmount("Globex backs 18 new startups")).toBeNull();
    expect(headlineAmount("Globex closes Series C-1")).toBeNull();
  });

  it("a hyphen that is another character is still a hyphen: pre-seed is not seed", () => {
    expect(headlineRound("Globex secures pre\u2011seed funding")).toBe("pre-seed");
    expect(headlineRound("Globex secures pre\u2010seed funding")).toBe("pre-seed");
    expect(headlineRound("Globex secures pre\u2013seed funding")).toBe("pre-seed");
    expect(fundingReason({ title: "Globex secures pre\u2011seed funding at Rs 16.7 cr valuation" })).toBe("Raised a pre-seed round.");
  });

  it("an investor changing what it invests, and business won, are not rounds", () => {
    for (const no of [
      "Peak Capital Raises Surge Seed Cap to $5M, Backs 18 New Startups",
      "Globex Ventures backs 12 startups in its latest cohort",
      "Initech shares jump 5%: US arm bags record \u20B94,000 crore order; global order book hits \u20B945,000 crore",
      "Hooli Bags \u20B928.78 Crore Work Orders; Shares Fall 0.65%",
      "Tyrell hospitality arm bags Delhi Airport F&B licence, \u20B9109 crore fee in FY28",
      "Umbrella Wagons bags \u20B9100 crore BESS project in Uttarakhand; targets \u20B91,000 crore order book",
      "Wonka wins two projects across business worth \u20B91,840 crore",
    ]) {
      expect(isFundingHeadline(no), no).toBe(false);
    }
    // The same verbs with money raised are still rounds.
    for (const yes of ["EV two-wheeler maker Globex bags Rs 1,750 Cr funding", "Initech Bags Rs 4 Cr to Scale Early Childhood Screening Platform", "Hooli lands $20M Series A to build out its team"]) {
      expect(isFundingHeadline(yes), yes).toBe(true);
    }
  });
});

describe("who reported it", () => {
  it("an outlet the feed names by its web address is given its name, or left out", () => {
    expect(publisherName("app.dealroom.co")).toBe("Dealroom");
    expect(publisherName("siliconangle.com")).toBe("SiliconANGLE");
    expect(publisherName("Bloomberg.com")).toBe("Bloomberg");
    expect(publisherName("entrepreneur.economictimes.indiatimes.com")).toBe("The Economic Times");
    expect(publisherName("TechCrunch")).toBe("TechCrunch");
    expect(publisherName("The Globe and Mail")).toBe("The Globe and Mail");
    expect(publisherName("some-unknown-site.example")).toBe("");
    expect(publisherName(undefined)).toBe("");
    // A feed may give the address whole. It is read down to its host before it is looked up - and an address is never the name.
    expect(publisherName("https://techcrunch.com/")).toBe("TechCrunch");
    expect(publisherName("http://www.siliconangle.com/2026/10/06/a-story?utm=x")).toBe("SiliconANGLE");
    expect(publisherName("www.bloomberg.com/news")).toBe("Bloomberg");
    expect(publisherName("https://ascendants.example/")).toBe("");
    expect(publisherName("https://")).toBe("");
    expect(publisherName("//")).toBe("");
    expect(publisherName(" - ")).toBe("");
    // An address beside a name is dropped; the name stays.
    expect(publisherName("ET Now | economictimes.example")).toBe("ET Now");
    expect(publisherName("Read at https://x.example/a now")).toBe("Read at now");
    const at = new Date("2026-09-25T10:00:00Z");
    expect(fundingReason({ title: "Globex secures $16M Series B", source: "app.dealroom.co", occurredAt: at })).toBe("Raised $16M Series B, reported by Dealroom on 25 Sep 2026.");
    expect(fundingReason({ title: "Globex secures $16M Series B", source: "en.wowtale.example", occurredAt: at })).toBe("Raised $16M Series B, reported on 25 Sep 2026.");
    expect(fundingReason({ title: "Globex secures $16M Series B", source: "en.wowtale.example" })).toBe("Raised $16M Series B.");
  });

  it("a sentence made safe for an email keeps the part of an address that says who it is", () => {
    expect(mailSafeReason("Raised $16M Series B, reported by app.dealroom.co on 25 Sep 2026.")).toBe("Raised $16M Series B, reported by dealroom on 25 Sep 2026.");
    expect(mailSafeReason("Seen on news.example.co.uk and on Booking.com")).toBe("Seen on example and on Booking");
  });
});

describe("the feed, end to end", () => {
  const REAL_SHAPES = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>funding - Google News</title>
${item("Exclusive: Nine-person Globex raises $30 million, counts four top labs as customers", "Fortune", "CBMiA1", 3)}
${item("Insurtech Initech raises $34.5M just months after prior round", "TechCrunch", "CBMiA2", 4)}
${item("Space Insurer Hooli Space Raises $5M Seed Round", "Payload Space", "CBMiA3", 2)}
${item("Hooli Space raises $5M seed to insure the space economy", "app.dealroom.co", "CBMiA4", 3)}
${item("Peak Capital Raises Surge Seed Cap to $5M, Backs 18 New Startups", "The Tech Buzz", "CBMiA5", 2)}
${item("Tyrell Secures $17M CAD in Funding to Help Manufacturers Modernize Procurement", "AI Insider", "CBMiA6", 5)}
${item("Physical AI startup Umbrella Kaiwu raises seed round at $500M valuation", "app.dealroom.co", "CBMiA7", 6)}
${item("Wonka AI secures pre\u2011seed funding at Rs 16.7 cr valuation", "SaasRise", "CBMiA8", 1)}
${item("Soylent Corp shares jump 5%: US arm bags record \u20B94,000 crore order; global order book hits \u20B945,000 crore", "Upstox", "CBMiA9", 2)}
${item("Vandelay Bags \u20B928.78 Crore Work Orders; Shares Fall 0.65%", "hdfcsky.example", "CBMiA10", 2)}
${item("Korea's Dental Robotics raises seed round for self-driving suction robot", "app.dealroom.co", "CBMiA11", 2)}
${item("Oscorp secures $16M Series B led by Five Elms Capital", "some-unknown-site.example", "CBMiA12", 3)}
</channel></rss>`;

  it("names the company without its description, once, and says only what the headline says was raised", async () => {
    use(news(REAL_SHAPES));
    const { findings } = await findFundedCompanies({}, { limit: 100 });
    const by = new Map(findings.map((f) => [f.companyName, f.relevantBecause]));
    expect([...by.keys()].sort()).toEqual(["Globex", "Hooli Space", "Initech", "Oscorp", "Tyrell", "Umbrella Kaiwu", "Wonka AI"]);
    expect(by.get("Globex")).toBe("Raised $30M, reported by Fortune on 3 Oct 2026.");
    expect(by.get("Initech")).toBe("Raised $34.5M, reported by TechCrunch on 2 Oct 2026.");
    expect(by.get("Hooli Space")).toMatch(/^Raised \$5M seed, reported by (?:Payload Space on 4|Dealroom on 3) Oct 2026\.$/);
    expect(by.get("Tyrell")).toBe("Raised CAD 17M, reported by AI Insider on 1 Oct 2026.");
    expect(by.get("Umbrella Kaiwu")).toBe("Raised a seed round, reported by Dealroom on 30 Sep 2026.");
    expect(by.get("Wonka AI")).toBe("Raised a pre-seed round, reported by SaasRise on 5 Oct 2026.");
    expect(by.get("Oscorp")).toBe("Raised $16M Series B, reported on 3 Oct 2026.");
    for (const f of findings) {
      // The headline quoted as proof still names the company as reported.
      expect(f.evidenceQuote).toContain(f.companyName!);
      expect(f.relevantBecause).not.toMatch(/\.(?:com|co|example)\b/);
    }
  });
});

describe("what a second look at live feeds found", () => {
  const at = new Date("2026-10-06T08:00:00Z");

  it("a publisher given as a web address never leaves 'reported by' with nothing after it", () => {
    // The feed's own words for the outlet were its address; once made safe to send, the address is taken out of a sentence.
    expect(fundingReason({ title: "Globex Secures \u00A3425,000 to Scale Its Platform", source: "https://ascendants.example/", occurredAt: at })).toBe("Raised GBP 425K, reported on 6 Oct 2026.");
    expect(fundingReason({ title: "Globex Secures \u00A3425,000 to Scale Its Platform", source: "https://techcrunch.com/", occurredAt: at })).toBe("Raised GBP 425K, reported by TechCrunch on 6 Oct 2026.");
    expect(fundingReason({ title: "Globex raises $5M", source: "https://ascendants.example/" })).toBe("Raised $5M.");
    for (const source of ["https://ascendants.example/", "www.x.example/news", "x.example", "//", "-", "|", "https://", "ET Now | economictimes.example", "Tech.example", "", undefined]) {
      const sentence = mailSafeReason(fundingReason({ title: "Globex raises $5M seed", source, occurredAt: at }));
      expect(sentence, String(source)).not.toMatch(/reported by\s+(?:on\b|\.|$)/);
      expect(sentence, String(source)).toMatch(/^Raised \$5M seed, reported(?: by [\p{L}\p{N}][^,]*)? on 6 Oct 2026\.$/u);
    }
  });

  it("shows an amount as the headline writes it: two decimals stay, and a thousand million is a billion and a quarter, not 1.3", () => {
    expect(headlineAmount("Globex Secures $133.65M Series A")!.shown).toBe("$133.65M");
    expect(headlineAmount("Globex raises $1,250 million")!.shown).toBe("$1.25B");
    expect(headlineAmount("Globex raises $2.50 million")!.shown).toBe("$2.5M");
    expect(headlineAmount("Globex raises $2.00 million")!.shown).toBe("$2M");
    expect(headlineAmount("Globex raises $7.125M")!.shown).toBe("$7.13M");
    expect(headlineAmount("Globex raises \u20AC999,999")!.shown).toBe("EUR 1M");
    expect(headlineAmount("Globex raises $12M")!.shown).toBe("$12M");
    expect(headlineAmount("Globex raises $1.5 billion")!.shown).toBe("$1.5B");
    // A figure of ours (a minimum, a total) keeps one decimal.
    expect(formatUsd(133_650_000)).toBe("$133.7M");
    expect(fundingReason({ title: "Globex Secures $133.65M Series A to Produce Iron", source: "Business Wire", occurredAt: at })).toBe("Raised $133.65M Series A, reported by Business Wire on 6 Oct 2026.");
  });

  it("a round with a suffix is reported as the round, without the suffix and without becoming another round", () => {
    expect(headlineRound("Globex closes $100M Series C-1")).toBe("Series C");
    expect(headlineRound("Globex closes Series C-1 extension")).toBe("Series C");
    expect(headlineRound("Globex raises Series B2")).toBe("Series B2");
    expect(fundingReason({ title: "Globex Raises $100M Series C-1", source: "Reuters", occurredAt: at })).toBe("Raised $100M Series C, reported by Reuters on 6 Oct 2026.");
  });
});
