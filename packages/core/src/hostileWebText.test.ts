/**
 * Every function outside the plays that is handed text from the web - a page, a feed, a
 * search result, a lookup service's answer - against 1.5 MB of text written to make a
 * pattern slow. (The plays have the same test of their own: plays/hostileText.test.ts.)
 *
 * What it found, before it was a test:
 *
 * - the website crawler looked for email addresses with `[A-Z0-9._%+-]+@...` over the whole
 *   page: 100,000 letters with no "@" took seven seconds, a full page a quarter of an hour;
 * - a LinkedIn post's page was searched for `(\d+)\s+reactions?`: a page of digits, the same;
 * - a search result's title and snippet were read by patterns written for a line
 *   (`\s*[|-]\s*LinkedIn\s*$` and a dozen like it): a "title" of a megabyte of spaces, the same;
 * - a news feed's items were searched for their fields anywhere beneath them: 399 unclosed
 *   <item> tags - 9 KB - took half a second.
 *
 * The rule: a function that reads text deals with 1.5 MB of anything in under a quarter of
 * a second; one that also parses the page it fetched, in under a second a page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractCompaniesFromResults } from "./discovery/companies.js";
import { extractPeopleFromResults, parseLinkedinTitle } from "./discovery/people.js";
import { crawlCompanyWebsite, emailsOnPage } from "./enrich/website.js";
import { linkedinPostEngagers, normalizeLinkedinPostUrl, resolveLinkedinUrl } from "./linkedin/resolve.js";
import { resetProviderSkips } from "./providers/health.js";
import { MAX_RESULT_SNIPPET, MAX_RESULT_TITLE, dedupe, resetSearchCache, resultKey, tidyResults, webSearchDetailed } from "./search/index.js";
import { bingHtmlProvider, duckDuckGoProvider, honorSiteOperator, isDuckDuckGoChallenge, resultsAnswerQuery } from "./search/providers.js";
import { detectHiring } from "./signals/hiring.js";
import { detectJobChange, normalizeCompany, normalizeTitle } from "./signals/jobChange.js";
import { classifyHeadline, companyFromHeadline, domainHintFromUrl, fetchGoogleNews, parseMoney, parseRss } from "./signals/news.js";
import type { SearchResult } from "./types.js";
import { extractDomain, normalizeLinkedinUrl, rootDomain } from "./util/domain.js";
import { inferDepartment, inferSeniority, splitName } from "./util/names.js";
import { cleanOrgName, identifyIp, pageIntentWeight } from "./visitors/identify.js";

const SIZE = 1_500_000;
const TEXT_MS = 250;
const PAGE_MS = 1_000;
const fill = (unit: string, size = SIZE): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** The pieces: runs of one character, pairs that nearly match, and the words the patterns in these files look for. */
const UNITS = [
  " ", "\n", "\t", "a", "A", "1", "a.", "a-", "a_", "a/", "a,", "a@", "@a", "a@a", "a@a.", "1.", "1,", "$1 ", "- ", " - ", " | ", "Ab Cd ", "Aa ", "A ", ", ", ". ", "\u00B7 ", "x x",
  "\u2013 ", "\u2019s ", "<", '"', "'", "&amp;", "://", "http://", "www.", ".com ", "a.b/", "(", "\\", "%", "%2", "uddg=", "linkedin.com/in/", "LinkedIn", " on LinkedIn", " at ", "Location: ",
  "startup ", "raises ", "Series ", "AS1 ", "pvt. ", "1 reactions", "9 ", "Jane Doe ",
];
/** What is put after an opening a pattern looks for: the runs it can be made to go over again and again. */
const AFTER_AN_OPENING = [" ", "\n", "a", "A", "1", "a.", "a-", " - ", "Aa ", "a@", ", ", "\u00B7"];

/**
 * Milliseconds a piece of work keeps the process busy: the smaller of the time that passed
 * and the processor time this process used, and the best of a few goes when over the
 * limit. Other tests run at the same time and slow the clock; they do not make the code slower.
 */
async function timed(run: () => unknown, limit: number): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= limit; i++) {
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    try {
      await run();
    } catch {
      // What a function makes of nonsense is not what is tested here: how long it takes is.
    }
    const used = process.cpuUsage(cpu);
    best = Math.min(best, performance.now() - t0, (used.user + used.system) / 1000);
  }
  return best;
}

const results = (s: string): SearchResult[] => [
  { title: s, url: "https://www.linkedin.com/in/jane-doe", snippet: s, provider: "x" },
  { title: s, url: "https://www.linkedin.com/company/acme", snippet: s, provider: "x" },
  { title: s, url: "https://acme.com/", snippet: s, provider: "x" },
  { title: "ok", url: s.slice(0, 3_000), snippet: "ok", provider: "x" },
];

/** Each function, called the way its caller calls it, with the text in every place web text can reach. */
const FUNCTIONS: [string, (s: string) => unknown, string[]?][] = [
  ["emailsOnPage", (s) => emailsOnPage(s), ["a@", "@", "a@a."]],
  ["parseLinkedinTitle", (s) => [parseLinkedinTitle(s, s), parseLinkedinTitle(`Jane Doe - ${s}`, s), parseLinkedinTitle("Jane Doe | LinkedIn", s)], ["Jane Doe -", "Jane Doe - CEO at", "Location:", "\u00B7"]],
  ["extractPeopleFromResults", (s) => extractPeopleFromResults(results(s))],
  ["extractCompaniesFromResults", (s) => extractCompaniesFromResults(results(s))],
  ["tidyResults", (s) => tidyResults(results(s))],
  ["honorSiteOperator", (s) => [honorSiteOperator("site:acme.com x", results(s)), honorSiteOperator(s.slice(0, 5_000), results("x"))]],
  ["resultsAnswerQuery", (s) => resultsAnswerQuery("best crm india", results(s))],
  ["isDuckDuckGoChallenge", (s) => isDuckDuckGoChallenge(s)],
  ["resultKey and dedupe", (s) => [resultKey(s), resultKey(`https://acme.com/?${s}`), dedupe(results(s))], ["http://", "https://acme.com/?"]],
  ["parseMoney", (s) => parseMoney(s), ["$", "Rs"]],
  ["companyFromHeadline", (s) => companyFromHeadline(s), ["Acme raises", "Acme", "startup"]],
  ["classifyHeadline", (s) => classifyHeadline({ title: s, url: "https://x.test/a", summary: s }), ["Acme raises"]],
  ["domainHintFromUrl", (s) => domainHintFromUrl(s), ["http://"]],
  ["normalizeCompany and normalizeTitle", (s) => [normalizeCompany(s), normalizeTitle(s)]],
  ["detectJobChange", (s) => detectJobChange({ previous: { companyName: s, title: s, companyDomain: s }, current: { companyName: `${s}x`, title: `${s}x`, companyDomain: s } })],
  ["cleanOrgName", (s) => cleanOrgName(s), ["AS1"]],
  ["pageIntentWeight", (s) => pageIntentWeight(s)],
  ["normalizeLinkedinPostUrl", (s) => normalizeLinkedinPostUrl(s)],
  ["extractDomain and rootDomain", (s) => [extractDomain(s), extractDomain(`https://${s}`), rootDomain(s.slice(0, 2_000))], ["http://"]],
  ["normalizeLinkedinUrl", (s) => normalizeLinkedinUrl(s), ["linkedin.com/in/"]],
  ["splitName", (s) => splitName(s)],
  ["inferSeniority and inferDepartment", (s) => [inferSeniority(s), inferDepartment(s)]],
];

describe("1.5 MB of text made to be slow, outside the plays", () => {
  /** "function, on what: how long" for everything over the limit. */
  const tooSlow: string[] = [];
  const measure = async (name: string, call: (s: string) => unknown, on: string, text: string, limit = TEXT_MS): Promise<void> => {
    const ms = await timed(() => call(text), limit);
    if (ms >= limit) tooSlow.push(`${name}, on ${on}: ${Math.round(ms)} ms`);
  };

  it(`every one of the ${FUNCTIONS.length} functions deals with every piece, alone and with an ending no pattern expects, in under a quarter of a second`, async () => {
    for (const unit of UNITS) {
      const alone = fill(unit);
      const odd = `${alone}\u0000x!`;
      for (const [name, call] of FUNCTIONS) {
        await measure(name, call, JSON.stringify(unit), alone);
        await measure(name, call, `${JSON.stringify(unit)} with an odd ending`, odd);
      }
    }
    expect(tooSlow).toEqual([]);
  }, 180_000);

  it("and with the piece after the opening a pattern looks for first", async () => {
    for (const [name, call, openings] of FUNCTIONS) {
      for (const open of openings ?? []) for (const unit of AFTER_AN_OPENING) await measure(name, call, `${JSON.stringify(open)} then ${JSON.stringify(unit)}`, `${open}${fill(unit)}!`);
    }
    expect(tooSlow).toEqual([]);
  }, 180_000);

  it("the check itself catches a slow pattern: the crawler's old one for email addresses, on a fortieth of the text", () => {
    const old = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const t0 = performance.now();
    fill("a", 36_000).match(old);
    expect(performance.now() - t0).toBeGreaterThan(TEXT_MS);
  });
});

describe("a fetched page or feed of 1.5 MB made to be slow", () => {
  let body = "";
  let type = "text/html";
  let fetched = 0;
  const page = (s: string, as = "text/html"): void => {
    body = s;
    type = as;
  };
  beforeEach(() => {
    resetSearchCache();
    resetProviderSkips();
    fetched = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      fetched++;
      return new Response(body, { status: 200, headers: { "content-type": type } });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const text = (s: string): string => s.replace(/[<&"]/g, "x");
  /** The pieces each kind of reader's own patterns look at. (Every run parses a page of 1.5 MB, so each reader gets the few that matter to it.) */
  const CRAWL = ["a", "a@", "a.", " ", "A "];
  const CAREERS = [" ", "a", "A ", "Senior Engineer "];
  const PROFILE = [" ", "a", " - ", "Jane Doe - CEO at Acme | LinkedIn "];
  const POST = ["1", "9 ", "1 reactions", " "];
  const RESULTS = [" ", "a", "<"];
  const FIELDS = [" ", "\n", "A ", " - "];
  const FEED = ["<item><title>a</title>", " ", "A ", "a"];
  const LOOKUP = [" ", ", ", "a."];
  /** Each reader, given what it asks for: the text as the whole page, and the text in the places of a page it reads. */
  const READERS: [string, (s: string) => Promise<unknown>, string[]][] = [
    ["the website crawler, on a home page", (s) => (page(s), crawlCompanyWebsite("acme.test", { maxPages: 1, allowPrivateHosts: true, allowInsecureFallback: false })), CRAWL],
    ["the website crawler, on a team page", (s) => (page(s), crawlCompanyWebsite("acme.test/team?", { maxPages: 1, allowPrivateHosts: true, allowInsecureFallback: false })), CRAWL],
    [
      "the website crawler, on a page with the text in its title, description, links and body",
      (s) => (
        page(`<html><head><title>${text(s.slice(0, 200_000))}</title><meta name=description content="${text(s.slice(0, 200_000))}"></head><body><h2>Jane Doe</h2><p>${text(s.slice(0, 300_000))}</p><a href="${text(s.slice(0, 200_000))}">x</a>${s.slice(0, 500_000)}</body></html>`),
        crawlCompanyWebsite("acme.test/team?", { maxPages: 1, allowPrivateHosts: true, allowInsecureFallback: false })
      ),
      CRAWL,
    ],
    ["the careers reader", (s) => (page(s), detectHiring("acme.test", undefined, { allowPrivateHosts: true })), CAREERS],
    ["the careers reader, on a page of job links", (s) => (page(`<html><body><ul>${fill(`<li><a href=/j>${text(s.slice(0, 60))}</a></li>`, 600_000)}</ul><p>${text(s.slice(0, 600_000))}</p></body></html>`), detectHiring("acme.test", undefined, { allowPrivateHosts: true })), CAREERS],
    ["the LinkedIn profile reader", (s) => (page(`og:title ${s}`), resolveLinkedinUrl("https://www.linkedin.com/in/jane-doe")), PROFILE],
    ["the LinkedIn profile reader, on a page with the text as its title", (s) => (page(`<html><head><meta property="og:title" content="${text(s.slice(0, 700_000))}"><meta name="description" content="${text(s.slice(0, 700_000))}"></head></html>`), resolveLinkedinUrl("https://www.linkedin.com/in/jane-doe")), PROFILE],
    ["the LinkedIn post reader", (s) => (page(s), linkedinPostEngagers("https://www.linkedin.com/posts/x")), POST],
    [
      "the LinkedIn post reader, on a page of commenters",
      (s) => (
        page(`<html><body><article>${fill(`<li class=comment><a href="https://www.linkedin.com/in/p">${text(s.slice(0, 50))}</a><span class=headline>${text(s.slice(0, 50))}</span></li>`, 500_000)}</article>${text(s.slice(0, 800_000))}</body></html>`),
        linkedinPostEngagers("https://www.linkedin.com/posts/x")
      ),
      POST,
    ],
    ["DuckDuckGo's results page", (s) => (page(`result__a ${s}`), duckDuckGoProvider().search("acme crm")), RESULTS],
    [
      "DuckDuckGo's results page, with the text in its results",
      (s) => (
        page(`<html><body>${fill(`<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://acme.com/")}&x=${text(s.slice(0, 200))}">${text(s.slice(0, 2_000))} crm</a><a class="result__snippet">${text(s.slice(0, 2_000))}</a></div>`, 1_400_000)}</body></html>`),
        duckDuckGoProvider().search("acme crm")
      ),
      RESULTS,
    ],
    ["DuckDuckGo's lite page", (s) => (page(`result-link ${s}`), duckDuckGoProvider().search("acme crm")), RESULTS],
    ["Bing's results page", (s) => (page(s), bingHtmlProvider().search("acme crm")), RESULTS],
    [
      "Bing's results page, with the text in its results",
      (s) => (
        page(`<html><body><ol>${fill(`<li class="b_algo"><h2><a href="https://acme.com/?u=a1${text(s.slice(0, 200))}">${text(s.slice(0, 2_000))} crm</a></h2><div class="b_caption"><p>${text(s.slice(0, 2_000))}</p></div></li>`, 1_400_000)}</ol></body></html>`),
        bingHtmlProvider().search("acme crm")
      ),
      RESULTS,
    ],
    [
      "a search whose provider sends the text as every title and snippet, read for people and companies",
      async (s) => {
        const o = await webSearchDetailed(`acme crm ${s.length}`, { providers: [{ name: "stub", available: () => true, search: async () => results(s) }] });
        return [extractPeopleFromResults(o.results), extractCompaniesFromResults(o.results)];
      },
      FIELDS,
    ],
    ["a news feed", (s) => (page(s, "application/rss+xml"), fetchGoogleNews("acme")), FEED],
    ["a news feed, as text", async (s) => parseRss(s), FEED],
    ["a news feed with the text as its title and description", async (s) => parseRss(`<rss><channel><item><title>${text(s)}</title><link>https://x.test/a</link><description>${text(s)}</description></item></channel></rss>`).map(classifyHeadline), FEED],
    ["a news feed of items with the text as their titles", async (s) => parseRss(`<rss><channel>${fill(`<item><title>${text(s.slice(0, 498))}</title><link>https://x.test/a</link><description>${text(s.slice(0, 300))}</description></item>`)}</channel></rss>`).map(classifyHeadline), FEED],
    [
      "an address lookup that answers with the text as every name",
      async (s) => {
        page(JSON.stringify({ company: { name: s.slice(0, 400_000), domain: s.slice(0, 400_000), type: "business" }, asn: { org: s.slice(0, 400_000) } }), "application/json");
        return cleanOrgName((await identifyIp(`8.8.${s.length % 250}.${s.charCodeAt(0) % 250}`)).orgName);
      },
      LOOKUP,
    ],
  ];
  it(`each of the ${READERS.length} readers answers in under a second a page`, async () => {
    const tooSlow: string[] = [];
    const filled = new Map<string, string>();
    for (const [name, read, pieces] of READERS) {
      for (const piece of pieces) {
        let whole = filled.get(piece);
        if (whole === undefined) filled.set(piece, (whole = fill(piece)));
        fetched = 0;
        const ms = await timed(() => read(whole as string), PAGE_MS);
        // A reader that asks for several pages (eight careers addresses) is given the same one each time.
        const pages = Math.max(1, Math.min(fetched, 8));
        if (ms / pages >= PAGE_MS) tooSlow.push(`${name}, on ${JSON.stringify(piece)}: ${Math.round(ms / pages)} ms a page`);
      }
    }
    expect(tooSlow).toEqual([]);
  }, 600_000);
});

describe("email addresses on a page", () => {
  it("are found as before: in text, in links, beside punctuation", () => {
    const html = `<p>Write to jane.doe@acme.com, or SALES+eu@mail.acme.co.uk.</p><a href="mailto:hello@acme.com?subject=Hi">hello@acme.com</a> "ops_team%x@acme.io" <bob@sub-domain.acme.com>; logo@2x.png x@y`;
    expect(emailsOnPage(html)).toEqual(["jane.doe@acme.com", "SALES+eu@mail.acme.co.uk", "hello@acme.com", "hello@acme.com", "ops_team%x@acme.io", "bob@sub-domain.acme.com", "logo@2x.png"]);
  });

  it("an address is read once: the next one does not start inside it", () => {
    expect(emailsOnPage("a@b.co@d.com")).toEqual(["a@b.co"]);
    expect(emailsOnPage("a@b.co c@d.com")).toEqual(["a@b.co", "c@d.com"]);
    // The ending is the last run of letters after a dot, as the old pattern read it.
    expect(emailsOnPage("x@mail.acme.com. Next")).toEqual(["x@mail.acme.com"]);
    expect(emailsOnPage("x@acme.co.uk2")).toEqual(["x@acme.co.uk"]);
  });

  it("gives what the old pattern gave on ordinary text", () => {
    const old = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const text = `Contact: jane@acme.com / +1 555 0100. Press: press@acme.com; careers@acme.com
      <a href="mailto:Founders@Acme.com">mail</a> @acme on social, a@b, @, user@host, first.last@dept.acme.co.in, img@2x.jpg, {"email":"api@acme.dev"}
      trailing dot bob@acme.com. and dash amy@acme-labs.io- and under x_y@z.org_ and 12@34.56 and q@w.e`;
    expect(emailsOnPage(text)).toEqual(text.match(old));
  });

  it("nothing is read past what an address can be: 64 characters before the @, 255 and an ending of 24 after", () => {
    expect(emailsOnPage(`${"a".repeat(100)}@acme.com`)).toEqual([`${"a".repeat(64)}@acme.com`]);
    expect(emailsOnPage(`x@${"a".repeat(300)}.com`)).toEqual([]);
    expect(emailsOnPage(null as unknown as string)).toEqual([]);
  });
});

describe("a search result is three lines", () => {
  it("only a line's worth of a title and a snippet is passed on, and a result with an address longer than any real one is left out", async () => {
    const long = fill("word ", 50_000);
    const sent: SearchResult[] = [
      { title: long, url: "https://acme.com/a", snippet: long, provider: "stub" },
      { title: "Acme", url: `https://acme.com/${"a".repeat(3_000)}`, snippet: "x", provider: "stub" },
      { title: "Globex", url: "https://globex.com/", snippet: "A fine company", provider: "stub" },
      { title: 7 as unknown as string, url: "https://initech.com/", snippet: null as unknown as string, provider: "stub" },
      { title: "No address", url: "", snippet: "x", provider: "stub" },
    ];
    const o = await webSearchDetailed("acme", { providers: [{ name: "stub", available: () => true, search: async () => sent }] });
    expect(o.results.map((r) => r.url)).toEqual(["https://acme.com/a", "https://globex.com/", "https://initech.com/"]);
    expect(o.results[0].title).toBe(long.slice(0, MAX_RESULT_TITLE));
    expect(o.results[0].snippet).toBe(long.slice(0, MAX_RESULT_SNIPPET));
    // An ordinary result is passed on as it came, the same object.
    expect(o.results[1]).toBe(sent[2]);
    expect(o.results[2]).toMatchObject({ title: "", snippet: "" });
  });

  it("a profile address that cannot be read is no profile, not an error", () => {
    expect(normalizeLinkedinUrl("https://www.linkedin.com/in/%zz")).toBeNull();
    expect(normalizeLinkedinUrl("https://www.linkedin.com/in/Jane-Doe-1a2b3c/")).toBe("https://www.linkedin.com/in/jane-doe-1a2b3c");
    expect(normalizeLinkedinUrl("https://in.linkedin.com/company/acme%20labs")).toBe("https://www.linkedin.com/company/acme labs");
    expect(() => extractPeopleFromResults([{ title: "Jane Doe - CEO - Acme | LinkedIn", url: "https://www.linkedin.com/in/%E0%A4%A", snippet: "", provider: "x" }])).not.toThrow();
  });
});

describe("a news feed whose items are written inside each other", () => {
  it("is read by each item's own fields, in the time it takes to read it", async () => {
    // 390 unclosed items (25 KB): over a second before, when every field was looked for anywhere beneath every item.
    const nested = "<rss><channel>" + "<item><title>Acme raises $5M</title><link>https://x.test/a</link>".repeat(390);
    let items: ReturnType<typeof parseRss> = [];
    expect(await timed(() => (items = parseRss(nested)), 100)).toBeLessThan(100);
    expect(items).toHaveLength(390);
    expect(items[0]).toMatchObject({ title: "Acme raises $5M", url: "https://x.test/a" });
  });

  it("an ordinary feed reads as before", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>News</title><link>https://news.test/</link>
      <item><title>Acme raises $12M Series A - TechCrunch</title><link>https://news.test/acme</link><guid>g1</guid><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><source url="https://techcrunch.com">TechCrunch</source><description>&lt;a href="x"&gt;Acme raises&lt;/a&gt; money</description></item>
      <item><title>No link here</title></item>
      <item><title>Globex acquires Initech</title><guid>https://news.test/globex</guid></item>
    </channel></rss>`;
    expect(parseRss(xml)).toEqual([
      { title: "Acme raises $12M Series A", url: "https://news.test/acme", source: "TechCrunch", publishedAt: new Date("2026-10-05T10:00:00Z"), summary: "Acme raises money" },
      { title: "Globex acquires Initech", url: "https://news.test/globex", source: undefined, publishedAt: undefined, summary: undefined },
    ]);
  });
});
