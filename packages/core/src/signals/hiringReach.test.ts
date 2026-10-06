import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectHiring } from "./hiring.js";
import { resetSearchCache } from "../search/index.js";
import { resetProviderSkips } from "../providers/health.js";

/**
 * webSearch never throws, so the old `res !== null` check counted a search in which every
 * provider failed as "answered", and an unreachable company was reported as reached with
 * zero open roles - which zeroes the stored count and suppresses the hiring alert.
 */
beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  for (const k of ["GOOGLE_CSE_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY"]) vi.stubEnv(k, "");
  vi.stubEnv("SERPER_API_KEY", "k");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectHiring when nothing could be reached", () => {
  it("does not claim the search answered when every provider failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const h = await detectHiring("acme.example", "Acme", { allowPrivateHosts: true });
    expect(h.reached).toBe(false);
  });

  it("counts a search that answered with nothing as reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => (String(u).includes("serper.dev") ? new Response(JSON.stringify({ organic: [] }), { status: 200 }) : new Response("down", { status: 503 }))));
    const h = await detectHiring("acme.example", "Acme", { allowPrivateHosts: true });
    expect(h.reached).toBe(true);
  });
});

/**
 * The careers page is the company's own: it can be built to keep the parser busy (see
 * util/html.ts). And every link and list item on it used to be copied, with everything
 * inside it, to read its text - the page again for each of them when they are nested.
 */
/** Milliseconds the work kept this process busy: the smaller of the time that passed and the processor time used (other tests slow the clock, not the code). */
async function busy(work: () => unknown): Promise<number> {
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  await work();
  const used = process.cpuUsage(cpu);
  return Math.min(performance.now() - t0, (used.user + used.system) / 1000);
}

describe("detectHiring on a careers page", () => {
  const careers = (html: string) =>
    vi.fn(async (u: string | URL) => (String(u) === "https://acme.example/careers" ? new Response(html, { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 })));

  it("reads job titles as before: a short line, without the location or badge beside it", async () => {
    vi.stubGlobal(
      "fetch",
      careers(`<html><body><ul>
        <li><a href="/jobs/1">Senior Software Engineer</a> <span>Remote</span></li>
        <li class="job">Account Executive<small>New</small><div>Berlin</div></li>
        <li><h3>Product Manager</h3></li>
        <li>We are a friendly team and we would love to hear from you even if nothing here fits what you are looking for.</li>
      </ul></body></html>`),
    );
    const h = await detectHiring("acme.example", undefined, { allowPrivateHosts: true });
    expect(h.source).toBe("careers_page");
    expect(h.careersUrl).toBe("https://acme.example/careers");
    expect(h.titles).toEqual(["Senior Software Engineer", "Account Executive", "Product Manager"]);
    expect(h.byFunction).toEqual({ engineering: 1, sales: 1, product: 1 });
  });

  it.each([
    ["64,000 nested <div>", `<html><body>${"<div>".repeat(64_000)}Software Engineer</body></html>`],
    ["7,000 unclosed <b id=N>", `<html><body>${Array.from({ length: 7_000 }, (_, i) => `<b id=${i}>Software Engineer`).join("")}</body></html>`],
    ["390 list items inside each other around 25,000 elements", `<html><body>${"<ul><li class=job>".repeat(195)}${"<i></i>".repeat(25_000)}Software Engineer</body></html>`],
    ["30,000 list items", `<html><body><ul>${Array.from({ length: 30_000 }, (_, i) => `<li class="job"><a href="/j/${i}">Software Engineer ${"x".repeat(1 + (i % 7))}</a></li>`).join("")}</ul></body></html>`],
  ])("a page of %s does not hold the process: it is refused or read within a second", async (_what, html) => {
    vi.stubGlobal("fetch", careers(html));
    let h!: Awaited<ReturnType<typeof detectHiring>>;
    expect(await busy(async () => (h = await detectHiring("acme.example", undefined, { allowPrivateHosts: true })))).toBeLessThan(1_000);
    // The page was reached either way: silence caused by us is not reported as the site being unreachable.
    expect(h.reached).toBe(true);
  });
});
