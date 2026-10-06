/**
 * Every function in the plays that is handed text from the web, against 1.5 MB of text
 * written to make a pattern slow.
 *
 * The sitemap reader's `<loc>` pattern had two unlimited runs of whitespace side by side:
 * one `<loc>` followed by 100,000 spaces took five seconds, and four times as long for
 * every doubling - sixteen minutes at the size a sitemap may have, during which the
 * process answers nobody. The rule these tests hold every such function to: 1.5 MB of
 * anything is dealt with in under a quarter of a second.
 *
 * Each input is one short piece repeated (the shapes that make a careless pattern go back
 * over the same characters again and again), on its own, with something after it that
 * makes a match fail at the last moment, and after the opening a pattern looks for first.
 */
import { describe, expect, it } from "vitest";
import { caseSlugOf, cleanLogoName, customerLinksFromSitemap, isCustomerPath, parseHeadline, slugCustomerName, storyKeyOf, storyWorthOpening, verifyAiCustomers } from "./extractCustomers.js";
import { engagersFromRows } from "./engagers.js";
import { fundingReason, headlineAmount, headlineRound, isFundingHeadline, publisherName } from "./funding.js";
import { buildHiringQueries, parseJobResult, readPostingPage, roleMatches } from "./hiring.js";
import { categoryFrom, competitorsInText, pickPersona } from "./plan.js";
import { askPlace, buildAskQueries, classifyAsk, linkedinPostAuthor, snippetDate, vanityMatches } from "./publicAsks.js";
import { article, cleanCompanyName, cleanList, finishFinding, hostOf, isAudienceWord, isDescriptorName, isGenericWord, isSameCompany, isVendorName, parseRobots, robotsAllows, safeHttpUrl, sameSite, slugToName, stripDescriptorPrefix } from "./shared.js";
import { cleanLine, cleanQuote, cutAtWord, mailSafeReason, normCompanyName, plainDashes, playDedupeKey, safeSentence } from "./util.js";

const SIZE = 1_500_000;
const LIMIT_MS = 250;
const fill = (unit: string, size = SIZE): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** The pieces: runs of one character, pairs that nearly match, and the words the patterns in these files look for. */
const UNITS = [
  " ", "\n", "\t", "a", "A", "1", "a.", "a-", "a/", "a@", "1.", "1,", "$1 ", "- ", "vs ", "Ab Cd ", "Acme, ", "alternative to ", "raises ", "How ", "x x",
  "\u201Cx", "\u2019s ", "\u200B", "<", "<a ", "<loc>", "<loc> ", "]]>", '"', "'", '="', "&amp;", "://", "www.", ".com ", "a.b/", "*", "/*a", "(", "[", "\\",
  "Disallow: /*a*\n", "<script ", '"company_name" ', ", VP at ", " | ", "logo ", "Series A ", "fund ", "1.5m ", "ago ", "hiring ", "Trusted by ", "customers/",
];
/** What is put after an opening a pattern looks for: the runs it can be made to go over again and again. */
const AFTER_AN_OPENING = [" ", "\n", "a", "1", "a.", "1.", "a-", "a/", "- ", "Ab Cd ", '"', '="', "\\", "<", "]]>", "/*a", "x x"];

/**
 * Milliseconds a piece of work keeps the process busy: the smaller of the time that passed
 * and the processor time this process used, and the best of a few goes when over the
 * limit. Other tests run at the same time and slow the clock; they do not make the code slower.
 */
function timed(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= LIMIT_MS; i++) {
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    try {
      run();
    } catch {
      // What a function makes of nonsense is not what is tested here: how long it takes is.
    }
    const used = process.cpuUsage(cpu);
    best = Math.min(best, performance.now() - t0, (used.user + used.system) / 1000);
  }
  return best;
}

const comp = { name: "Acme", domain: "acme.com" };
const finding = (s: string) => ({ kind: "company" as const, companyName: s, companyDomain: s, relevantBecause: s, evidenceUrl: `https://acme.com/${s.slice(0, 100)}`, evidenceTitle: s, evidenceQuote: s, signalType: "x", confidence: 0.5, personName: s, title: s, linkedinUrl: s });

/** Each function, called the way an engine calls it, with the text in every place web text can reach. */
const FUNCTIONS: [string, (s: string) => unknown, string[]?][] = [
  ["cleanLine", (s) => cleanLine(s, 4000)],
  ["cleanQuote", (s) => cleanQuote(s, 4000)],
  ["cutAtWord", (s) => cutAtWord(s, 300)],
  ["plainDashes", (s) => plainDashes(s), ["\u2014"]],
  ["safeSentence", (s) => safeSentence(s)],
  ["mailSafeReason", (s) => mailSafeReason(s)],
  ["normCompanyName", (s) => normCompanyName(s)],
  ["playDedupeKey", (s) => playDedupeKey(finding(s))],
  ["cleanList", (s) => cleanList([s, s], 10, 200)],
  ["safeHttpUrl", (s) => [safeHttpUrl(`https://acme.com/${s}`), safeHttpUrl(s)]],
  ["hostOf", (s) => hostOf(s)],
  ["sameSite", (s) => [sameSite(s, "acme.com"), sameSite("https://acme.com/", s)]],
  ["isVendorName", (s) => isVendorName(s)],
  ["isGenericWord", (s) => isGenericWord(s)],
  ["isAudienceWord", (s) => isAudienceWord(s)],
  ["isDescriptorName", (s) => isDescriptorName(s, s)],
  ["cleanCompanyName", (s) => cleanCompanyName(s, 6)],
  ["stripDescriptorPrefix", (s) => stripDescriptorPrefix(s)],
  ["slugToName", (s) => slugToName(s)],
  ["isSameCompany", (s) => [isSameCompany(s, comp), isSameCompany("Acme", { name: s, domain: s })]],
  ["article", (s) => article(s)],
  ["finishFinding", (s) => finishFinding(finding(s))],
  ["parseRobots and robotsAllows", (s) => [robotsAllows(parseRobots(s), `/customers/${"a".repeat(1900)}`), robotsAllows({ allow: [], disallow: Array.from({ length: 2000 }, () => s.slice(0, 500)) }, s.slice(0, 2000))], ["User-agent: *\nDisallow: /", "User-agent: ScoutBot\nAllow: /*"]],
  ["isCustomerPath and caseSlugOf", (s) => [isCustomerPath(s), caseSlugOf(s), caseSlugOf(`/customers/${s}`)]],
  ["parseHeadline", (s) => [parseHeadline(s, "Acme"), parseHeadline("How Globex cut costs", s)], ["How ", "Case study: "]],
  ["slugCustomerName", (s) => [slugCustomerName(s, "Acme"), slugCustomerName("globex", s)]],
  ["cleanLogoName", (s) => cleanLogoName(s)],
  ["storyWorthOpening and storyKeyOf", (s) => [storyWorthOpening(`https://acme.com/customers/${s}`, "Acme"), storyKeyOf(s), storyKeyOf(`https://acme.com/${s}`)]],
  // The pattern that was quadratic: an opening tag, then runs of whitespace it could split in any number of ways.
  ["customerLinksFromSitemap", (s) => customerLinksFromSitemap(s, "acme.com"), ["<loc>", "<loc><![CDATA[", "<loc>a", "<loc>a]]>", "<loc>a ]]>", "<sitemapindex><loc>", "<urlset><url><loc>https://acme.com/customers/x"]],
  ["verifyAiCustomers", (s) => verifyAiCustomers({ customers: [{ name: "Globex", quote: "Globex cut costs with Acme" }] }, s, comp)],
  ["roleMatches", (s) => [roleMatches(s, "Account Executive"), roleMatches("Account Executive", s)]],
  ["parseJobResult", (s) => [parseJobResult({ title: s, url: "https://boards.greenhouse.io/acme/jobs/123", snippet: s, provider: "x" }), parseJobResult({ title: "Account Executive - Acme", url: `https://jobs.lever.co/${s.slice(0, 1000)}`, snippet: s, provider: "x" })], ["Job Application for ", "Acme is hiring "]],
  ["buildHiringQueries", (s) => buildHiringQueries([s], [s], [s])],
  // Read as text for its JSON-LD and its "company_name", then parsed for its title.
  ["readPostingPage", (s) => readPostingPage(s, s.slice(0, 500), true), ['<script type="application/ld+json">', "<script ", '"company_name"', '"company_name":"', "<title>"]],
  ["buildAskQueries", (s) => buildAskQueries([{ kind: "competitor", value: s }, { kind: "problem", value: s }, { kind: "category", value: s }], ["linkedin", "reddit", "hackernews", "forums"])],
  ["askPlace", (s) => [askPlace(s), askPlace(`https://www.reddit.com/r/${s.slice(0, 1500)}`)]],
  ["classifyAsk", (s) => [classifyAsk(s, s, "Acme"), classifyAsk("Looking for an alternative to Acme", s, s)], ["Looking for ", "Ask HN: ", "alternative to Acme "]],
  ["linkedinPostAuthor", (s) => linkedinPostAuthor(s), ["Jane Doe on LinkedIn: "]],
  ["vanityMatches", (s) => vanityMatches(s, s)],
  ["snippetDate", (s) => snippetDate(s), ["3 days ago ", "Jan 5, 2026 "]],
  // "1.1.1.1..." used to hang this one: a number of any length before "m fund", tried from every digit.
  ["isFundingHeadline", (s) => isFundingHeadline(s), ["Acme raises $5M ", "Acme raises "]],
  ["headlineAmount", (s) => headlineAmount(s), ["$", "USD "]],
  ["headlineRound", (s) => headlineRound(s)],
  ["publisherName", (s) => publisherName(s)],
  ["fundingReason", (s) => fundingReason({ title: s, source: s, occurredAt: new Date(0) })],
  ["categoryFrom", (s) => categoryFrom(s), ["Acme is a ", "the "]],
  ["pickPersona", (s) => pickPersona({ description: s, headline: s, headings: [s, s], text: s })],
  ["competitorsInText", (s) => competitorsInText(s, { name: s, domain: "acme.com" }), ["Acme vs ", "alternative to "]],
  ["engagersFromRows", (s) => engagersFromRows([{ name: s, title: s, company: s, linkedinUrl: s, email: s, comment: s } as never], { engagement: "comment", postUrl: `https://www.linkedin.com/posts/${s.slice(0, 500)}`, postTitle: s, postAuthor: s } as never)],
];

describe("1.5 MB of text made to be slow", () => {
  /** "function, on what: how long" for everything over the limit. */
  const tooSlow: string[] = [];
  const measure = (name: string, call: (s: string) => unknown, on: string, text: string): void => {
    const ms = timed(() => call(text));
    if (ms >= LIMIT_MS) tooSlow.push(`${name}, on ${on}: ${Math.round(ms)} ms`);
  };

  it(`every one of the ${FUNCTIONS.length} functions deals with every piece, alone and with an ending no pattern expects, in under a quarter of a second`, () => {
    for (const unit of UNITS) {
      const alone = fill(unit);
      const odd = `${alone}\u0000x!`;
      for (const [name, call] of FUNCTIONS) {
        measure(name, call, JSON.stringify(unit), alone);
        measure(name, call, `${JSON.stringify(unit)} with an odd ending`, odd);
      }
    }
    expect(tooSlow).toEqual([]);
  }, 180_000);

  it("and with the piece after the opening a pattern looks for first", () => {
    for (const [name, call, openings] of FUNCTIONS) {
      for (const open of openings ?? []) for (const unit of AFTER_AN_OPENING) measure(name, call, `${JSON.stringify(open)} then ${JSON.stringify(unit)}`, `${open}${fill(unit)}`);
    }
    expect(tooSlow).toEqual([]);
  }, 180_000);

  it("the check itself catches a slow pattern: the sitemap reader's old one, on a fifteenth of the text", () => {
    const old = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]{1,2000})\s*(?:\]\]>)?\s*<\/loc>/gi;
    const t0 = performance.now();
    old.exec(`<urlset><loc>${" ".repeat(24_000)}</urlset>`);
    expect(performance.now() - t0).toBeGreaterThan(LIMIT_MS);
  });
});

describe("the sitemap reader", () => {
  it("still reads every way a sitemap writes an address", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://acme.com/customers/globex</loc></url>
      <url><loc>
         <![CDATA[ https://acme.com/case-studies/initech ]]>
      </loc></url>
      <url><loc><![CDATA[https://acme.com/customers/hooli]]></loc></url>
      <url><LOC>https://acme.com/customers/umbrella?utm=1&amp;x=2</LOC></url>
      <url><loc>https://other.example/customers/not-ours</loc></url>
      <url><loc>https://acme.com/pricing</loc></url>
    </urlset>`;
    expect(customerLinksFromSitemap(xml, "acme.com").links.map((l) => l.url)).toEqual([
      "https://acme.com/customers/globex",
      "https://acme.com/case-studies/initech",
      "https://acme.com/customers/hooli",
      "https://acme.com/customers/umbrella",
    ]);
    const index = `<sitemapindex><sitemap><loc> https://acme.com/sitemap-customers.xml </loc></sitemap><sitemap><loc>https://acme.com/sitemap-posts.xml</loc></sitemap></sitemapindex>`;
    expect(customerLinksFromSitemap(index, "acme.com")).toEqual({ links: [], children: ["https://acme.com/sitemap-customers.xml", "https://acme.com/sitemap-posts.xml"] });
  });

  // The verifier's measurements on the old pattern: 2,000 spaces 2 ms, 32,000 spaces 684 ms, 100,000 spaces 5 s.
  it.each([2_000, 32_000, 100_000, 1_400_000])("one <loc> followed by %d spaces is nothing to it", (spaces) => {
    const xml = `<urlset><loc>${" ".repeat(spaces)}</urlset>`;
    expect(timed(() => customerLinksFromSitemap(xml, "example.com"))).toBeLessThan(50);
    expect(customerLinksFromSitemap(xml, "example.com")).toEqual({ links: [], children: [] });
  });

  it.each([
    ["<loc> again and again", fill("<loc> ")],
    ["<loc> and 199 spaces, 7,000 times", fill(`<loc>${" ".repeat(199)}`)],
    ["<loc> and 1,999 letters, 700 times", fill(`<loc>${"a".repeat(1999)}`)],
    ["an address closed by 2,000 >", fill(`<loc>a${">".repeat(2000)}`)],
    ["CDATA opened and never closed", fill("<loc><![CDATA[ a ")],
    ["20,000 real addresses", fill("<url><loc>https://acme.com/customers/globex-corporation</loc></url>")],
  ])("%s", (_what, xml) => {
    expect(timed(() => customerLinksFromSitemap(xml, "acme.com"))).toBeLessThan(LIMIT_MS);
  });
});

describe("a robots.txt pattern", () => {
  it("is matched by hand: wildcards, an end mark, the longest rule wins", () => {
    const rules = { allow: ["/private/press-kit", "/*/public$"], disallow: ["/private/", "/*.pdf$", "/search?", "/a*b*c"] };
    for (const [path, open] of [
      ["/", true],
      ["/private/x", false],
      ["/private/press-kit/logo", true],
      ["/files/report.pdf", false],
      ["/files/report.pdf?x=1", true],
      ["/search?q=1", false],
      ["/search", true],
      ["/team/public", true],
      ["/team/public/more", true],
      ["/axxbxxc", false],
      ["/axxbxx", true],
      ["/xa-b-c", true],
    ] as const) {
      expect(robotsAllows(rules, path), path).toBe(open);
    }
  });

  it("built to make a matcher go back and forth costs a bounded amount of work, and closes the path", () => {
    // As a regular expression this is ^/.*a.*a.*a ... $ against a path of a's with a b at the end: it does not finish.
    const tangled = { allow: [], disallow: Array.from({ length: 2000 }, () => `/${"*a".repeat(240)}$`) };
    const path = `/${"a".repeat(1990)}b`;
    expect(timed(() => robotsAllows(tangled, path))).toBeLessThan(LIMIT_MS);
    // A file that cannot be worked out in the allowance is taken as closing the path: when in doubt, a page is not opened.
    expect(robotsAllows(tangled, path)).toBe(false);
    // The same rules decide an ordinary path at once.
    expect(robotsAllows({ allow: [], disallow: [`/${"*a".repeat(240)}$`] }, "/customers")).toBe(true);
  });
});
