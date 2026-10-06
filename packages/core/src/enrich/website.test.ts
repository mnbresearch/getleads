import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { crawlCompanyWebsite } from "./website.js";

let server: Server | null = null;

async function site(html: Record<string, string>): Promise<string> {
  server = createServer((req, res) => {
    const body = html[(req.url ?? "/").replace(/\/$/, "") || ""];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("nope");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return `127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server) {
    const s = server;
    server = null;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/**
 * A crawl that reached nothing used to be indistinguishable from a company whose site has
 * nothing on it: both returned a profile with empty arrays. Callers wrote that to the
 * database and stamped `enrichedAt`, so one unreachable minute became the company's record
 * for the full thirty-day re-enrichment window.
 */
describe("a website crawl says whether it reached the site", () => {
  it("marks a crawl that fetched no page at all", async () => {
    // Port 1 on loopback: nothing listens, so every fetch fails fast over both schemes.
    const profile = await crawlCompanyWebsite("127.0.0.1:1", { maxPages: 2, timeoutMs: 500, allowPrivateHosts: true });
    expect(profile.crawlFailed).toBe(true);
    expect(profile.pagesFetched).toBe(0);
    expect(profile.pagesAttempted).toBe(2);
    // Still a well-formed profile: callers must not have to handle a null.
    expect(profile.emailsFound).toEqual([]);
    expect(profile.peopleFound).toEqual([]);
  });

  it("does not mark a reachable site that simply has little on it", async () => {
    const host = await site({ "": "<html><head><title>Quiet Co</title></head><body><p>Hello.</p></body></html>" });
    const profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 1, timeoutMs: 2000, allowPrivateHosts: true });
    expect(profile.crawlFailed).toBe(false);
    expect(profile.pagesFetched).toBe(1);
    expect(profile.name).toBe("Quiet Co");
    expect(profile.emailsFound).toEqual([]);
  });

  it("extracts what is actually on the page", async () => {
    const host = await site({
      "": `<html><head><title>Acme | Payments</title><meta name="description" content="We do payments."></head>
           <body><script src="/wp-content/x.js"></script>
           <a href="https://www.linkedin.com/company/acme-pay">LinkedIn</a>
           <p>Reach us at hello@127.0.0.1 or sales@acme.com</p></body></html>`,
      "/about": "<html><body>about</body></html>",
    });
    const profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 2, timeoutMs: 2000, allowPrivateHosts: true });
    expect(profile.name).toBe("Acme");
    expect(profile.description).toBe("We do payments.");
    expect(profile.techStack).toContain("WordPress");
    expect(profile.socials.linkedin).toBe("https://www.linkedin.com/company/acme-pay");
    expect(profile.linkedinUrl).toBe("https://www.linkedin.com/company/acme-pay");
    // Email harvesting is NOT meaningfully covered here, and saying so is better than an
    // assertion that looks like coverage. These fixtures are served from 127.0.0.1, the
    // address pattern requires a real TLD, and only addresses at the crawled domain are
    // kept - so no address on this page can be collected whether the filter works or not.
    // `expect(emailsFound).not.toContain("sales@acme.com")` would pass either way. What
    // IS covered here is everything the parser does with the page itself.
    expect(profile.emailsFound).toEqual([]);
  });

  it("falls back to http when https reaches nothing, rather than reporting no web presence", async () => {
    const host = await site({ "": "<html><head><title>Legacy Co</title></head><body>hi</body></html>" });
    // No scheme given, so https is tried first against a plain-http server and fails.
    const profile = await crawlCompanyWebsite(host, { maxPages: 1, timeoutMs: 2000, allowPrivateHosts: true });
    expect(profile.crawlFailed).toBe(false);
    expect(profile.insecureFallback).toBe(true);
    expect(profile.name).toBe("Legacy Co");
  });

  it("honours allowInsecureFallback: false", async () => {
    const host = await site({ "": "<html><head><title>Legacy Co</title></head><body>hi</body></html>" });
    const profile = await crawlCompanyWebsite(host, { maxPages: 1, timeoutMs: 2000, allowPrivateHosts: true, allowInsecureFallback: false });
    expect(profile.crawlFailed).toBe(true);
    expect(profile.insecureFallback).toBeUndefined();
  });
});

/**
 * A site somebody else wrote can be built to keep the parser busy for minutes (see
 * util/html.ts), and reading a team page asked every name-like element for the text of
 * its parent - the whole list again, once per name. Both ran on the event loop.
 */
/** Milliseconds the work kept this process busy: the smaller of the time that passed and the processor time used (other tests slow the clock, not the code). */
async function busy(work: () => unknown): Promise<number> {
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  await work();
  const used = process.cpuUsage(cpu);
  return Math.min(performance.now() - t0, (used.user + used.system) / 1000);
}

describe("a site built to keep a reader busy", () => {
  const people = (count: number): string => Array.from({ length: count }, (_, i) => `<h3>Jane Doe${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i / 26) % 26 | 0))}${String.fromCharCode(97 + ((i / 676) % 26 | 0))}</h3><p>Head of Sales</p>`).join("");

  it.each([
    ["64,000 nested <div>", `<html><body>${"<div>".repeat(64_000)}x</body></html>`],
    ["7,000 unclosed <b id=N>", `<html><body>${Array.from({ length: 7_000 }, (_, i) => `<b id=${i}>x`).join("")}</body></html>`],
    ["a tag with 100,000 attributes", `<html><body><a ${Array.from({ length: 100_000 }, (_, i) => `a${i.toString(36)}`).join(" ")}>x</a></body></html>`],
  ])("a home page of %s is not parsed, and the crawl is over in a second", async (_what, html) => {
    const host = await site({ "": html, "/about": "<html><head><title>About</title></head><body><a href='https://www.linkedin.com/company/acme-pay'>in</a></body></html>" });
    let profile!: Awaited<ReturnType<typeof crawlCompanyWebsite>>;
    expect(await busy(async () => (profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 2, timeoutMs: 2000, allowPrivateHosts: true })))).toBeLessThan(1_000);
    // The page was reached - this is not a dead site - but nothing was read from it; the next page still is.
    expect(profile.crawlFailed).toBe(false);
    expect(profile.pagesFetched).toBe(2);
    expect(profile.name).toBeUndefined();
    expect(profile.socials.linkedin).toBe("https://www.linkedin.com/company/acme-pay");
  });

  it("a team page is read as before: the name's own words, the title beside it or around it", async () => {
    const host = await site({
      "": "<html><head><title>Acme</title></head><body>home</body></html>",
      "/team": `<html><body><div class="grid">
        <div class="member"><h3>Jane Doe</h3><p>Chief Executive Officer</p></div>
        <div class="member"><h3>Sam Lee <span>(he/him)</span></h3>VP of Sales</div>
        <div class="member"><h3>Not A Person Here Really</h3><p>CEO</p></div>
        <div class="member"><h3>Ann Smith</h3><p>Loves hiking</p></div>
      </div></body></html>`,
    });
    const profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 4, timeoutMs: 2000, allowPrivateHosts: true });
    expect(profile.peopleFound.map((p) => [p.firstName, p.lastName, p.title])).toEqual([
      ["Jane", "Doe", "Chief Executive Officer"],
      ["Sam", "Lee", "(he/him)VP of Sales"],
    ]);
  });

  it("a team page with thousands of names under one parent is read once, not once per name", async () => {
    const host = await site({ "": "<html><head><title>Acme</title></head><body>home</body></html>", "/team": `<html><body><div class="team">${people(12_000)}</div></body></html>` });
    let profile!: Awaited<ReturnType<typeof crawlCompanyWebsite>>;
    expect(await busy(async () => (profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 4, timeoutMs: 4000, allowPrivateHosts: true })))).toBeLessThan(1_000);
    // The first two thousand names are looked at; a real team page has a few dozen.
    expect(profile.peopleFound).toHaveLength(2000);
    expect(profile.peopleFound[0]).toMatchObject({ firstName: "Jane", title: "Head of Sales" });
  });
});
