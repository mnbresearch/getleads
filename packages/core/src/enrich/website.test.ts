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
    const profile = await crawlCompanyWebsite("127.0.0.1:1", { maxPages: 2, timeoutMs: 500 });
    expect(profile.crawlFailed).toBe(true);
    expect(profile.pagesFetched).toBe(0);
    expect(profile.pagesAttempted).toBe(2);
    // Still a well-formed profile: callers must not have to handle a null.
    expect(profile.emailsFound).toEqual([]);
    expect(profile.peopleFound).toEqual([]);
  });

  it("does not mark a reachable site that simply has little on it", async () => {
    const host = await site({ "": "<html><head><title>Quiet Co</title></head><body><p>Hello.</p></body></html>" });
    const profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 1, timeoutMs: 2000 });
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
           <p>Reach us at hello@${"127.0.0.1"} or sales@acme.com</p></body></html>`,
      "/about": "<html><body>about</body></html>",
    });
    const profile = await crawlCompanyWebsite(`http://${host}`, { maxPages: 2, timeoutMs: 2000 });
    expect(profile.name).toBe("Acme");
    expect(profile.description).toBe("We do payments.");
    expect(profile.techStack).toContain("WordPress");
    expect(profile.socials.linkedin).toBe("https://www.linkedin.com/company/acme-pay");
    expect(profile.linkedinUrl).toBe("https://www.linkedin.com/company/acme-pay");
    // Only addresses at the company's own domain are collected, so sales@acme.com is not
    // picked up from a site served at another host.
    expect(profile.emailsFound).not.toContain("sales@acme.com");
  });

  it("falls back to http when https reaches nothing, rather than reporting no web presence", async () => {
    const host = await site({ "": "<html><head><title>Legacy Co</title></head><body>hi</body></html>" });
    // No scheme given, so https is tried first against a plain-http server and fails.
    const profile = await crawlCompanyWebsite(host, { maxPages: 1, timeoutMs: 2000 });
    expect(profile.crawlFailed).toBe(false);
    expect(profile.insecureFallback).toBe(true);
    expect(profile.name).toBe("Legacy Co");
  });

  it("honours allowInsecureFallback: false", async () => {
    const host = await site({ "": "<html><head><title>Legacy Co</title></head><body>hi</body></html>" });
    const profile = await crawlCompanyWebsite(host, { maxPages: 1, timeoutMs: 2000, allowInsecureFallback: false });
    expect(profile.crawlFailed).toBe(true);
    expect(profile.insecureFallback).toBeUndefined();
  });
});
