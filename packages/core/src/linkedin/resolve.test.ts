import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache } from "../search/index.js";
import { linkedinPostEngagers, resolveLinkedinUrl } from "./resolve.js";

/**
 * What LinkedIn serves is parsed through the same guard as any other page (util/html.ts):
 * a page nested or crowded beyond any real page is not parsed, and is treated as no page.
 */
const POST = "https://www.linkedin.com/posts/jane-doe_launch-activity-7000000000000000000-abcd";
const serve = (html: string) => vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => (String(u).includes("linkedin.com") ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 503 }))));

beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  for (const k of ["GOOGLE_CSE_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY", "SERPER_API_KEY"]) vi.stubEnv(k, "");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a public LinkedIn page", () => {
  it("a post's page gives the people it shows, as before", async () => {
    serve(`<html><head><meta property="og:description" content="We launched."></head><body>
      <article><a href="https://www.linkedin.com/in/sam-lee-12345678">Sam Lee</a><p class="comment__headline">VP Sales at Globex</p></article>
      <li><a href="https://www.linkedin.com/in/ann-smith">Ann Smith</a><span class="entity__subtitle">Founder, Initech</span></li>
      <p>12 reactions 3 comments</p></body></html>`);
    const out = await linkedinPostEngagers(POST);
    expect(out.publicPage).toBe(true);
    expect(out.postText).toBe("We launched.");
    expect(out.people.map((p) => [p.firstName, p.lastName, p.title])).toEqual([
      ["Sam", "Lee", "VP Sales at Globex"],
      ["Ann", "Smith", "Founder, Initech"],
    ]);
    expect([out.reactions, out.comments]).toEqual([12, 3]);
  });

  it.each([
    ["64,000 nested <div>", `<html><body>${"<div>".repeat(64_000)}<a href="https://www.linkedin.com/in/sam-lee">Sam Lee</a></body></html>`],
    ["7,000 unclosed <b id=N>", `<html><head><meta property="og:title" content="Sam Lee - VP Sales - Globex | LinkedIn"></head><body>${Array.from({ length: 7_000 }, (_, i) => `<b id=${i}>x`).join("")}</body></html>`],
  ])("a page of %s is not parsed: no people from a post, and a profile falls back to its address", async (_what, html) => {
    serve(html);
    const cpu = process.cpuUsage();
    expect(await linkedinPostEngagers(POST)).toEqual({ people: [], publicPage: false });
    // Nothing is read from the page: the name comes from the profile's address, marked as a guess.
    expect(await resolveLinkedinUrl("https://www.linkedin.com/in/sam-lee")).toMatchObject({ firstName: "Sam", lastName: "Lee", source: "linkedin:slug", confidence: 0.3 });
    const used = process.cpuUsage(cpu);
    expect((used.user + used.system) / 1000).toBeLessThan(1_000);
  });
});
