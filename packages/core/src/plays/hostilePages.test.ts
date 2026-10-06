/**
 * Pages built to keep a reader busy, given to every way an engine reads a page.
 *
 * A release check timed three of them: a 64 KB page of nested <header> took about 50 s to
 * read for customers (the reader searched upwards from every element), 320 KB of nested
 * <div> took 33 s in the parser alone, and 95 KB of unclosed <b id=N> 7 s. All of it on the
 * event loop, reached from planning a play and from every run - so one such page stopped
 * the whole process answering. What is held here: every entry point returns within a
 * second on each of those pages and on the others below, a page that is refused is counted
 * and noted like any other refused page, and ordinary pages are read exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import { findCompetitorCustomers } from "./competitorCustomers.js";
import { customerLinksFromSitemap, extractCustomers } from "./extractCustomers.js";
import { findHiringCompanies, readPostingPage } from "./hiring.js";
import { CUSTOMERS_PAGE, NO_AI, page, searchWith, web, type FakeWeb, type Route } from "./kit.test.js";
import { planPlays } from "./plan.js";
import { MAX_PAGE_CHARS, PlayRun } from "./shared.js";

const ACME = { name: "Acme", domain: "acme.com" };
const SECOND = 1_000;

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

const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const seq = (count: number, make: (i: number) => string): string => Array.from({ length: count }, (_, i) => make(i)).join("");
const chain = (tag: string, depth: number, attrs = "", inner = "x"): string => `<${tag}${attrs}>`.repeat(depth) + inner + `</${tag}>`.repeat(depth);
const body = (html: string): string => `<html><head><title>Customers | Acme</title></head><body>${html}</body></html>`;
const empties = (count: number): string => "<i></i>".repeat(count);

/** The verifier's pages, as its probes built them, at the sizes it timed and at the size a play reads. */
const REFUSED: [string, string][] = [
  ["8,000 nested <header> in main (64 KB: about 50 s before)", `<html><body><main>${"<header>".repeat(8_000)}x</main></body></html>`],
  ["64,000 nested <div> (320 KB: 33 s in the parser before)", `<html><body>${"<div>".repeat(64_000)}trusted by</body></html>`],
  ["7,000 unclosed <b id=N> (95 KB: 7 s before)", body(seq(7_000, (i) => `<b id=${i}>x`))],
  ["4,000 nested <div class=nav>", body("<div class=nav>x".repeat(4_000))],
  ["8,000 nested <span>", body(`${"<span>".repeat(8_000)}trusted by`)],
  ["50,000 unclosed <a href=N>", body(seq(50_000, (i) => `<a href=/c/${i}>x`))],
  ["800 KB of nested <div>", fill("<div>", MAX_PAGE_CHARS)],
  ["800 KB of nested <header>", `<main>${fill("<header>", MAX_PAGE_CHARS)}`],
  ["a tag with 100,000 attributes", body(`<a ${seq(100_000, (i) => `a${i.toString(36)} `)}>`)],
  ["61,000 elements", body(empties(61_000))],
  // Nothing in the text of these nests; the parser nests every one of them.
  ["list items and definitions in turn, which the parser nests", body(fill("<li><dd>", 40_000))],
  ["elements closed on themselves, which the parser does not close", body(fill("<br><div/>", 40_000))],
];

/** Pages inside every limit, aimed at the reader's own loops: what used to be read again for every element. */
const ACCEPTED: [string, string][] = [
  ["60 chains of 300 nested <header> in main (verifier)", body(`<main>${chain("header", 300).repeat(60)}</main>`)],
  ["60 chains of 300 nested <div class=nav> beside a long text (verifier)", body(`<p>${"long text ".repeat(4_000)}</p>${chain("div", 300, " class=nav").repeat(60)}`)],
  ["60 chains of 300 nested <span> (verifier)", body(chain("span", 300, "", "trusted by").repeat(60))],
  ["90 chains of 300 nested <footer>", body(chain("footer", 300).repeat(90))],
  ["520 logo walls (verifier)", body(`<section><h2>Trusted by teams</h2><div class="customers-logos">${'<img alt="Globex logo" src="/a.svg">'.repeat(40)}</div></section>`.repeat(520))],
  ["17,000 sibling .footer blocks (verifier)", body('<div class="footer"><p>some text here</p></div>'.repeat(17_000))],
  ["4,900 unclosed links", body(seq(4_900, (i) => `<a href=/c/${i}>x`))],
  ["390 nested <div> around 25,000 elements", body("<div>".repeat(390) + empties(25_000))],
  ["20,000 story links side by side", body(`<div>${seq(20_000, (i) => `<a href="/customers/co${i}">Co${i}</a>`)}</div>`)],
  ["3,000 story links that share one large block", body(`<div>${empties(450)}${seq(3_000, (i) => `<a href="/customers/co${i}">Co${i}</a>`)}${empties(20_000)}</div>`)],
  ["9,000 story cards: a link, a heading and a logo each", body(seq(7_000, (i) => `<div class=card><a href="/customers/co${i}"><h3>How Co${i} cut costs</h3><img alt="Co${i} logo" src=a.svg></a></div>`))],
  ["6,000 labels in one block", body(`<div><div><div><div>${seq(6_000, () => '<p>Trusted by</p><img alt="Globex logo" src=a.svg>')}</div></div></div></div>`)],
  ["300 labels, each four blocks above its logos", body(seq(300, (i) => `<div><p>Trusted by</p><div><div><div><div><img alt="Co${i} logo" src=a.svg><img alt="Dx${i} logo" src=b.svg>${empties(150)}</div></div></div></div></div>`))],
  ["5,000 attributions in one large testimonial", body(`<div class="testimonial"><blockquote>q</blockquote>${seq(5_000, (i) => `<cite>Jane Doe, VP Sales at Globex${i}</cite>`)}<p>${"word ".repeat(20_000)}</p></div>`)],
  ["5,000 attributions whose quote is four blocks up", body(`<div><blockquote>q</blockquote>${empties(20_000)}${seq(5_000, (i) => `<div><div><div><cite>Jane Doe, VP Sales at Globex${i}</cite></div></div></div>`)}</div>`)],
  ["190 headings inside each other, around 30,000 elements", body(`${"<h2><div>".repeat(190)}Case study: Globex${empties(30_000)}`)],
  ["5,000 main headings", body(seq(5_000, (i) => `<h1>How Globex${i} cut costs</h1>`) + empties(20_000))],
  ["390 nested <span> around a label and 25,000 elements", body(`${"<span>".repeat(390)}Trusted by${empties(25_000)}`)],
  ["390 blocks classed customers inside each other, 600 logos", body(`${'<div class="customers">'.repeat(390)}${seq(600, (i) => `<img alt="Co${i} logo" src=a.svg>`)}${empties(20_000)}`)],
  ["600 logos under a class of 300,000 characters", body(`<div class="customers"><div class="${"tok ".repeat(75_000)}">${seq(600, (i) => `<div class=x><img alt="Co${i} logo" src=a.svg></div>`)}</div></div>`)],
  ["6,000 attributions under a class of 300,000 characters", body(`<div class="${"tok ".repeat(75_000)}">${seq(6_000, (i) => `<cite>Jane Doe, VP Sales at Globex${i}</cite>`)}</div>`)],
  ["55,000 paragraphs", body(seq(55_000, (i) => `<p>line ${i}`))],
  ["40,000 links that lead nowhere of interest", body(seq(40_000, (i) => `<a href=/x${i}>y</a>`))],
  ["2,000 blocks of structured data", body(seq(2_000, (i) => `<script type="application/ld+json">{"@type":"Review","author":{"@type":"Organization","name":"Co${i}"},"review":[${"[".repeat(50)}${"]".repeat(50)}]}</script>`))],
  ["20,000 comparison links", body(seq(20_000, (i) => `<a href="/vs/rival${i}"><span>Acme vs Rival${i}</span><span>See how we compare</span></a>`))],
  ["60 chains of 300 nested headings with text", body(chain("h2", 1, "", chain("div", 300, "", "Acme vs Rival")).repeat(60))],
  ["an ordinary large page: 13,000 blocks", body("<div><p>hello</p><img src=x><br></div>".repeat(13_000))],
];

/** For the engines that read a page through the same reader as above: every refused page and the verifier's accepted ones. */
const SOME = [...REFUSED, ...ACCEPTED.filter(([what]) => /verifier|ordinary/.test(what))];
/** For planning, which reads a page its own way: every refused page, and the accepted ones that reach furthest into it. */
const ALL = [...REFUSED, ...ACCEPTED.filter(([what]) => /verifier|story links side by side|story cards|comparison links|nested headings|paragraphs|lead nowhere|ordinary/.test(what))];

/**
 * Milliseconds a piece of work keeps the process busy: the smaller of the time that passed
 * and the processor time this process used, and the best of a few goes when over the
 * limit. Other tests run at the same time and slow the clock; they do not make the code slower.
 */
async function timed(work: () => unknown): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= SECOND; i++) {
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    await work();
    const used = process.cpuUsage(cpu);
    best = Math.min(best, performance.now() - t0, (used.user + used.system) / 1000);
  }
  return best;
}

describe("reading a page for customers", () => {
  it.each(REFUSED)("refuses %s, at once", async (_what, html) => {
    for (const url of ["https://acme.com/customers", "https://acme.com/customers/globex"]) {
      let out: ReturnType<typeof extractCustomers> | undefined;
      expect(await timed(() => (out = extractCustomers(html, url, ACME)))).toBeLessThan(SECOND);
      expect(out).toEqual({ hits: [], links: [], text: "", title: "", customerPage: false, told: [], unreadable: true });
    }
  });

  it.each(ACCEPTED)("reads %s within a second", async (_what, html) => {
    // As a list of customers, and - where the page has headings, which is what a story is read by - as one customer's story.
    for (const url of ["https://acme.com/customers", ...(/<h[12]/.test(html) ? ["https://acme.com/customers/globex"] : [])]) {
      let out: ReturnType<typeof extractCustomers> | undefined;
      expect(await timed(() => (out = extractCustomers(html, url, ACME)))).toBeLessThan(SECOND);
      expect(out!.unreadable).toBeUndefined();
    }
  });

  it("still finds what such a page says: the bounds stop the repeated reading, not the reading", () => {
    const names = (html: string, url = "https://acme.com/customers"): string[] => extractCustomers(html, url, ACME).hits.map((h) => h.name);
    // 120 customers from 20,000 story links (a page reports at most 120), each under its own name.
    const links = names(ACCEPTED[8][1]);
    expect(links).toHaveLength(120);
    expect(links.slice(0, 3)).toEqual(["Co0", "Co1", "Co2"]);
    expect(names(ACCEPTED[10][1]).slice(0, 2)).toEqual(["Co0", "Co1"]);
    // Logos under a label, four blocks down, with 150 empty elements beside them.
    expect(names(ACCEPTED[12][1]).slice(0, 4)).toEqual(["Co0", "Dx0", "Co1", "Dx1"]);
    // 600 logos in a block classed "customers", however long the class beside it is.
    expect(names(ACCEPTED[19][1])).toHaveLength(120);
    // A heading that holds 30,000 empty elements after its words is still read by its words.
    expect(names(ACCEPTED[15][1])).toEqual(["Globex"]);
    // And the ordinary customers page gives what it always gave.
    expect(names(CUSTOMERS_PAGE).sort()).toEqual(["Globex", "Hooli", "Initech", "Oscorp", "Soylent", "Stark Industries", "Tyrell", "Umbrella Corp", "Wayne Enterprises"]);
  });
});

describe("what is taken out of a page before it is read", () => {
  const read = (html: string, url = "https://acme.com/customers"): string => extractCustomers(page("Customers | Acme", html), url, ACME).text;

  it("the site's header, navigation, sidebar and footer go; a header inside the content and a footer inside a quote stay", () => {
    const text = read(`
      <header><p>Site header words</p><nav><a href="/pricing">Nav words</a></nav></header>
      <div role="navigation">Role navigation words</div><div role="search">Role search words</div>
      <aside>Sidebar words</aside>
      <main>
        <header><h1>Main header words</h1></header>
        <section><header><p>Section header words</p></header><footer>Section footer words</footer></section>
        <article><header><p>Article header words</p></header><footer><p>Article footer words</p></footer></article>
        <blockquote>Quote words<footer>Jane Doe, VP Sales at Initech</footer></blockquote>
        <figure><figcaption>Figure words</figcaption><footer>Figure footer words</footer></figure>
        <script>var script_words = 1;</script><style>.style_words {}</style><noscript>Noscript words</noscript><template><p>Template words</p></template>
        <select><option>Select words</option></select><dialog>Dialog words</dialog><iframe>Iframe words</iframe>
      </main>
      <footer><p>Site footer words</p></footer>`);
    for (const kept of ["Main header words", "Section header words", "Article header words", "Article footer words", "Quote words", "Jane Doe, VP Sales at Initech", "Figure words", "Figure footer words"]) expect(text, kept).toContain(kept);
    for (const gone of ["Site header words", "Nav words", "Role navigation words", "Role search words", "Sidebar words", "Section footer words", "script_words", "style_words", "Noscript words", "Template words", "Select words", "Dialog words", "Iframe words", "Site footer words"]) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it("a block classed as navigation goes when it is a small part of the page, and stays when it wraps most of it", () => {
    const text = read(`
      <div class="page-wrapper nav-open"><p>${"The content of the page. ".repeat(40)}</p>
        <div class="navbar"><a href="/a">Navbar words</a></div>
        <div id="cookie-banner">Cookie words</div>
        <div class="content"><div class="breadcrumbs">Breadcrumb words</div><p>Inner content words</p></div>
      </div>
      <div class="footer-links">Footer links words</div>`);
    expect(text).toContain("The content of the page.");
    expect(text).toContain("Inner content words");
    for (const gone of ["Navbar words", "Cookie words", "Breadcrumb words", "Footer links words"]) expect(text, gone).not.toContain(gone);
  });

  it("a story's link in the site's navigation is somewhere to read next, not a customer", () => {
    const out = extractCustomers(page("Acme", `<header><nav><a href="/customers/hidden-co">Hidden Co</a></nav></header><main><h1>Welcome</h1><a href="/customers/globex"><h3>How Globex cut costs</h3></a></main>`), "https://acme.com/", ACME);
    expect(out.hits.map((h) => h.name)).toEqual(["Globex"]);
    expect(out.links.map((l) => l.url).sort()).toEqual(["https://acme.com/customers/globex", "https://acme.com/customers/hidden-co"]);
  });

  it("a page longer than a play reads keeps its content: its code, styles and drawings go first", () => {
    // 1.2 MB, with the customers at the very end - past the 800 KB a play reads, but most of the page is not content.
    const html = page(
      "Customers | Acme",
      `<style>${".x{color:red}".repeat(30_000)}</style><script>${"var a = 1;".repeat(30_000)}</script><svg><path d="${"M0 0L10 10 ".repeat(30_000)}"/></svg><div style="${"color:red;".repeat(20_000)}"></div>` +
        `<main><h2>Trusted by teams</h2><div class="customer-logos"><img alt="Globex logo" src="/g.svg"><img alt="Initech logo" src="/i.svg"><img alt="Hooli logo" src="/h.svg"></div></main>`,
    );
    expect(html.length).toBeGreaterThan(1_200_000);
    expect(extractCustomers(html, "https://acme.com/customers", ACME).hits.map((h) => h.name)).toEqual(["Globex", "Initech", "Hooli"]);
  });
});

describe("a run that meets such a page", () => {
  it("refuses it as an unreadable page: counted, noted, not retried", async () => {
    use({ "https://acme.com/deep": REFUSED[1][1], "https://acme.com/ok": "<p>fine</p>" });
    const run = new PlayRun({});
    expect(await run.fetchPage("https://acme.com/deep")).toEqual({ ok: false, kind: "refused", why: "unreadable page" });
    expect(run.trace.pagesRefused).toBe(1);
    expect(run.trace.pagesFetched).toBe(0);
    expect(run.trace.notes).toEqual(["A page on acme.com is built in a way that cannot be read quickly (far too many or too deeply nested elements), so it was skipped."]);
    expect(await run.fetchPage("https://acme.com/ok")).toEqual({ ok: true, url: "https://acme.com/ok", body: "<p>fine</p>" });
    expect(net.pages()).toEqual(["https://acme.com/deep", "https://acme.com/ok"]);
  });

  it.each(REFUSED)("is refused %s within a second", async (_what, html) => {
    use({ "https://acme.com/x": html });
    const run = new PlayRun({});
    let got: unknown;
    expect(await timed(async () => (got = await run.fetchPage("https://acme.com/x")))).toBeLessThan(SECOND);
    // Refused before parsing, or - where only the parser can see the nesting - handed on to be refused when it is parsed.
    if ((got as { ok: boolean }).ok) expect(extractCustomers((got as { body: string }).body, "https://acme.com/x", ACME).unreadable).toBe(true);
    else expect(got).toEqual({ ok: false, kind: "refused", why: "unreadable page" });
  });

  it("hands on at most 800 KB of a page, made smaller by what nothing reads; a sitemap is kept whole and not checked as a page", async () => {
    const long = `<html><body><p>start</p><script>${"var a = 1;".repeat(100_000)}</script>${"<p>word</p>".repeat(100)}<p>end</p></body></html>`;
    const longer = `<html><body>${`<p>${"word ".repeat(100)}</p>`.repeat(3_000)}</body></html>`;
    const sitemap = `<?xml version="1.0"?><urlset>${"<url><loc>https://acme.com/customers/globex</loc></url>".repeat(25_000)}</urlset>`;
    use({ "https://acme.com/long": long, "https://acme.com/longer": longer, "https://acme.com/sitemap.xml": { body: sitemap, type: "application/xml" }, "https://acme.com/map": { body: sitemap, type: "text/html" } });
    const run = new PlayRun({});
    const a = await run.fetchPage("https://acme.com/long");
    expect(a.ok && a.body.length < 2_000 && a.body.includes("<p>start</p>") && a.body.includes("<p>end</p>") && !a.body.includes("var a")).toBe(true);
    const b = await run.fetchPage("https://acme.com/longer");
    expect(b.ok && b.body.length).toBe(MAX_PAGE_CHARS);
    // A sitemap: 25,000 addresses are more elements than a page may have, and it is not a page.
    const c = await run.fetchPage("https://acme.com/sitemap.xml");
    expect(c.ok && c.body.length).toBe(sitemap.length);
    const d = await run.fetchPage("https://acme.com/map", { sitemap: true });
    expect(d.ok && d.body.length).toBe(sitemap.length);
    expect(customerLinksFromSitemap(sitemap, "acme.com").links).toHaveLength(1);
    expect(run.trace.pagesRefused).toBe(0);
  });
});

describe("the engines", () => {
  it.each(ALL)("planning from a site whose home page is %s takes under a second", async (_what, html) => {
    use({ "https://acme.com/": html });
    let plan: Awaited<ReturnType<typeof planPlays>> | undefined;
    expect(await timed(async () => (plan = await planPlays({ website: "acme.com" }, { ai: NO_AI })))).toBeLessThan(SECOND);
    expect(plan!.plays.length).toBeGreaterThan(0);
  });

  it("a plan says so when the site's page could not be read, whichever check refused it", async () => {
    for (const html of [REFUSED[1][1], REFUSED[10][1]]) {
      use({ "https://acme.com/": html });
      const plan = await planPlays({ website: "acme.com" }, { ai: NO_AI });
      expect(plan.trace.blocked).toBe(true);
      expect(plan.trace.blockedReason).toBe("acme.com could not be read (unreadable page), so these suggestions are general. Check the address and try again.");
      expect(plan.trace.pagesRefused).toBe(1);
      expect(plan.trace.pagesFetched).toBe(0);
      expect(plan.trace.notes).toContain("A page on acme.com is built in a way that cannot be read quickly (far too many or too deeply nested elements), so it was skipped.");
      expect(plan.plays.map((p) => p.type)).toEqual(["funding"]);
    }
  });

  it.each(SOME)("a competitor whose home page is %s is dealt with in under a second", async (_what, html) => {
    use({ "https://acme.com/": html });
    expect(await timed(() => findCompetitorCustomers({ competitors: [ACME] }, { ai: NO_AI }))).toBeLessThan(SECOND);
  });

  it("an unreadable home page does not end the reading of a competitor's site: its customers page is still read", async () => {
    for (const home of [REFUSED[1][1], REFUSED[10][1]]) {
      use({ "https://acme.com/": home, "https://acme.com/customers": CUSTOMERS_PAGE });
      const { findings, trace } = await findCompetitorCustomers({ competitors: [ACME] }, { ai: NO_AI });
      expect(findings.map((f) => f.companyName)).toContain("Globex");
      expect(trace.pagesRefused).toBeGreaterThanOrEqual(1);
      expect(trace.notes).toContain("A page on acme.com is built in a way that cannot be read quickly (far too many or too deeply nested elements), so it was skipped.");
      expect(trace.blocked).toBe(false);
    }
  });

  it("when no page of a competitor can be read, the run says nothing could be checked", async () => {
    use((url) => (/robots\.txt$|sitemap/.test(url) ? undefined : REFUSED[1][1]));
    const { findings, trace } = await findCompetitorCustomers({ competitors: [ACME] }, { ai: NO_AI });
    expect(findings).toEqual([]);
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toMatch(/^None of the pages could be read \(\d+ refused or not public\), so nothing could be checked\.$/);
    expect(trace.pagesFetched).toBe(0);
    expect(trace.pagesRefused).toBeGreaterThan(1);
  });

  it.each(SOME)("a posting's page that is %s is read in under a second", async (_what, html) => {
    expect(await timed(() => readPostingPage(html, "globex", false))).toBeLessThan(SECOND);
  });

  it("a posting whose page cannot be read stays unchecked: it is not called open", async () => {
    const posting = { title: "Sales Development Representative - Globex", url: "https://boards.greenhouse.io/globex/jobs/4012345", snippet: "Globex is hiring" };
    for (const html of [REFUSED[1][1], REFUSED[10][1]]) {
      resetSearchCache();
      use({ "https://boards.greenhouse.io/globex/jobs/4012345": html });
      const { findings, trace } = await findHiringCompanies({ roles: ["Sales Development Representative"] }, { searchOpts: { providers: [searchWith((q) => (q.includes("site:boards.greenhouse.io") ? [posting] : []))] } });
      expect(findings.map((f) => [f.companyName, f.relevantBecause, f.confidence])).toEqual([["Globex", "Has a posting for Sales Development Representative on Greenhouse.", 0.65]]);
      expect(trace.pagesRefused).toBe(1);
      expect(trace.notes).toContain("A page on boards.greenhouse.io is built in a way that cannot be read quickly (far too many or too deeply nested elements), so it was skipped.");
    }
  });

  it("a posting's page says who is hiring, read without a pattern that runs over the whole page", async () => {
    const ld = (data: unknown): string => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
    expect(readPostingPage(page("Jobs", ld({ "@type": "JobPosting", title: "Account Executive", hiringOrganization: { "@type": "Organization", name: "Globex" } })), "globex", false)).toEqual({ role: "Account Executive", company: "Globex" });
    // The data may come after other scripts, in capitals, with other attributes around its type.
    const html = page("Jobs", `<script>var x = "<script>";</script><SCRIPT id="a" TYPE='application/ld+json' data-x>${JSON.stringify({ "@graph": [{ "@type": "JobPosting", title: "SDR", hiringOrganization: "Initech" }] })}</SCRIPT>`);
    expect(readPostingPage(html, null, false)).toEqual({ role: "SDR", company: "Initech" });
    // Blocks that are not JSON, are empty or never end are passed over.
    expect(readPostingPage(page("Job Application for Account Executive at Hooli", `${ld("x").replace('"x"', "{not json")}<script type="application/ld+json"></script><script type="application/ld+json">{"@type":"JobPosting"`), null, false)).toEqual({ role: "Account Executive", company: "Hooli" });
    // The board's own record of the company's name, when nothing else gives it.
    expect(readPostingPage(`<html><head><title>Careers</title></head><body><script>window.__DATA__ = {"company_name"  :  "Wayne Enterprises"}</script></body></html>`, null, false)).toMatchObject({ company: "Wayne Enterprises" });
    // 100,000 opening tags that are never closed: one pass, not one per tag.
    const unclosed = '<script type="application/ld+json">'.repeat(20_000);
    expect(readPostingPage(unclosed, null, false)).toEqual({});
    expect(await timed(() => readPostingPage(unclosed, null, false))).toBeLessThan(250);
  });
});
