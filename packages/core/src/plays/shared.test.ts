/**
 * What every engine relies on from a run: it obeys robots.txt, it never lets one search or
 * one slow page hold it past its time, it does not start a search it has no time for, and
 * it counts a search that never looked where it was asked to as a search that failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderSkips } from "../providers/health.js";
import { resetSearchCache, type SearchProvider } from "../search/index.js";
import { honorSiteOperator } from "../search/providers.js";
import type { SearchResult } from "../types.js";
import { searchWith, web, type FakeWeb, type Route } from "./kit.test.js";
import { PlayRun, hostPauseMs, parseRobots, robotsAllows } from "./shared.js";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("robots.txt", () => {
  const FILE = `# comments are ignored
User-agent: *
Disallow: /private/
Disallow: /customers/secret-story
Allow: /private/press-kit
Disallow: /*.pdf$
Disallow: /search?

User-agent: Googlebot
User-agent: bingbot
Disallow: /

User-agent: ScoutBot
Disallow: /only-for-us
`;

  it("follows the group written for everyone, unless one names this reader", () => {
    const everyone = parseRobots(FILE, "somebodyelse");
    expect(everyone.disallow).toEqual(["/private/", "/customers/secret-story", "/*.pdf$", "/search?"]);
    expect(everyone.allow).toEqual(["/private/press-kit"]);
    // A group that names us replaces the general one, as the standard says.
    expect(parseRobots(FILE)).toEqual({ allow: [], disallow: ["/only-for-us"] });
    // A group for another crawler is never ours.
    expect(parseRobots("User-agent: Googlebot\nDisallow: /\n")).toEqual({ allow: [], disallow: [] });
  });

  it.each([
    ["/", true],
    ["/customers", true],
    ["/customers/globex", true],
    ["/customers/secret-story", false],
    ["/customers/secret-story/more", false],
    ["/private/", false],
    ["/private/notes", false],
    // The longer rule wins, and "allow" wins a tie.
    ["/private/press-kit", true],
    ["/files/report.pdf", false],
    ["/files/report.pdf.html", true],
    ["/search?q=x", false],
    ["/search", true],
  ])("%s may be opened: %s", (path, expected) => {
    expect(robotsAllows(parseRobots(FILE, "somebodyelse"), path)).toBe(expected);
  });

  it("anything that is not a robots file closes nothing", () => {
    for (const junk of ["", "<html><body>Not found</body></html>", "Disallow: /\n", "User-agent\nDisallow /", "\u0000\u0001"]) {
      expect(robotsAllows(parseRobots(junk), "/customers")).toBe(true);
    }
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/anything")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\n"), "/anything")).toBe(false);
  });

  it("is read once per host, before the first page, and a page it serves as HTML is not a robots file", async () => {
    use({ "https://acme.com/robots.txt": "<!doctype html><html><body>Disallow: / (this is our 404 page)</body></html>", "https://acme.com/a": "<p>a</p>", "https://acme.com/b": "<p>b</p>" });
    const run = new PlayRun({});
    expect((await run.fetchPage("https://acme.com/a")).ok).toBe(true);
    expect((await run.fetchPage("https://acme.com/b")).ok).toBe(true);
    expect(net.calls).toEqual(["https://acme.com/robots.txt", "https://acme.com/a", "https://acme.com/b"]);
    expect(run.trace.notes).toEqual([]);
    expect(run.requests).toBe(3);
  });

  it("a closed path is refused before any request for it, counted and noted once", async () => {
    use({ "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /customers/\n", type: "text/plain" }, "https://acme.com/customers/globex": "<p>x</p>" });
    const run = new PlayRun({});
    expect(await run.fetchPage("https://acme.com/customers/globex")).toEqual({ ok: false, kind: "refused", why: "robots.txt" });
    expect(await run.fetchPage("https://acme.com/customers/initech")).toMatchObject({ ok: false, kind: "refused" });
    expect(net.calls).toEqual(["https://acme.com/robots.txt"]);
    expect(run.trace).toMatchObject({ pagesRefused: 2, pagesFetched: 0 });
    expect(run.trace.notes).toEqual(["acme.com asks automated readers not to open some of its pages (robots.txt), so those were skipped."]);
  });

  it("a redirect into a closed path, or onto a host that closes it, is not followed", async () => {
    use({
      "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /members/\n", type: "text/plain" },
      "https://acme.com/stories": { status: 302, location: "/members/stories" },
      "https://acme.com/members/stories": "<p>secret</p>",
      "https://acme.com/blog": { status: 301, location: "https://blog.acme.com/" },
      "https://blog.acme.com/robots.txt": { body: "User-agent: *\nDisallow: /\n", type: "text/plain" },
      "https://blog.acme.com/": "<p>blog</p>",
    });
    const run = new PlayRun({});
    expect(await run.fetchPage("https://acme.com/stories")).toMatchObject({ ok: false, kind: "refused", why: "robots.txt" });
    expect(await run.fetchPage("https://acme.com/blog")).toMatchObject({ ok: false, kind: "refused", why: "robots.txt" });
    expect(net.calls).toEqual(["https://acme.com/robots.txt", "https://acme.com/stories", "https://acme.com/blog", "https://blog.acme.com/robots.txt"]);
  });

  it("a public search API is asked without it, and what it answers is not counted as a page", async () => {
    use({ "https://api.example/search?q=x": { body: JSON.stringify({ hits: [1, 2] }), type: "application/json" } });
    const run = new PlayRun({});
    expect(await run.fetchApi<{ hits: number[] }>("https://api.example/search?q=x")).toEqual({ hits: [1, 2] });
    expect(await run.fetchApi("https://api.example/search?q=missing")).toBeNull();
    expect(net.calls).toEqual(["https://api.example/search?q=x", "https://api.example/search?q=missing"]);
    expect(run.trace.pagesFetched).toBe(0);
  });
});

describe("requests to one host", () => {
  it("go out one at a time, however many are asked for at once", async () => {
    let inFlight = 0;
    let most = 0;
    const inner = web(() => "<p>ok</p>");
    vi.stubGlobal("fetch", async (url: string) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return inner.fetch(url);
    });
    const run = new PlayRun({});
    await Promise.all(["a", "b", "c", "d"].map((p) => run.fetchPage(`https://acme.com/${p}`)));
    expect(most).toBe(1);
    // Another host is not held up by this one.
    most = 0;
    await Promise.all([run.fetchPage("https://acme.com/e"), run.fetchPage("https://other.example/e")]);
    expect(most).toBe(2);
  });

  it("the pause is 300 ms unless the operator says otherwise, within reason", () => {
    const before = process.env.PLAYS_HOST_PAUSE_MS;
    try {
      delete process.env.PLAYS_HOST_PAUSE_MS;
      expect(hostPauseMs()).toBe(300);
      for (const [raw, ms] of [["0", 0], ["750", 750], ["999999", 5000], ["-5", 0], ["soon", 300], ["", 300]] as const) {
        process.env.PLAYS_HOST_PAUSE_MS = raw;
        expect(hostPauseMs(), raw).toBe(ms);
      }
    } finally {
      if (before === undefined) delete process.env.PLAYS_HOST_PAUSE_MS;
      else process.env.PLAYS_HOST_PAUSE_MS = before;
    }
  });

  it("a page is given a number of requests and no more: its hops and a robots.txt it had to fetch", async () => {
    use((url) => {
      const n = Number(/\/hop(\d+)$/.exec(url)?.[1] ?? Number.NaN);
      return Number.isFinite(n) ? (n < 4 ? { status: 302, location: `/hop${n + 1}` } : "<p>end</p>") : undefined;
    });
    const run = new PlayRun({});
    expect(await run.fetchPage("https://acme.com/hop0", { maxRequests: 3 })).toEqual({ ok: false, kind: "budget", why: "request limit" });
    // robots.txt and two hops: three requests, and the third hop was never asked for.
    expect(net.calls).toEqual(["https://acme.com/robots.txt", "https://acme.com/hop0", "https://acme.com/hop1"]);
    expect(run.requests).toBe(3);
    expect((await run.fetchPage("https://acme.com/hop0", { maxRequests: 6 })).ok).toBe(true);
    expect(await run.fetchPage("https://acme.com/hop0", { maxRequests: 0 })).toMatchObject({ kind: "budget" });
  });
});

describe("time", () => {
  const hanging = (): SearchProvider & { queries: string[] } => {
    const queries: string[] = [];
    return { name: "testsearch", queries, available: () => true, search: (q: string) => (queries.push(q), new Promise<SearchResult[]>(() => {})) };
  };

  it("one search never holds a run longer than twelve seconds, and is then a search that did not answer", async () => {
    vi.useFakeTimers();
    const provider = hanging();
    const run = new PlayRun({ searchOpts: { providers: [provider] }, deadlineAt: Date.now() + 120_000 });
    let done: SearchResult[] | null = null;
    void run.search("anything").then((x) => (done = x));
    await vi.advanceTimersByTimeAsync(11_900);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toEqual([]);
    expect(run.trace).toMatchObject({ searches: 1, failedSearches: 1 });
    expect(run.searchAnswered).toBe(false);
  });

  it("no search is started with less time left than one search can need", async () => {
    vi.useFakeTimers();
    const provider = hanging();
    const run = new PlayRun({ searchOpts: { providers: [provider] }, deadlineAt: Date.now() + 30_000 });
    const all = (async () => {
      const got: number[] = [];
      for (let i = 0; i < 10; i++) {
        if (!run.canSearch) break;
        got.push((await run.search(`q${i}`)).length);
      }
      return got;
    })();
    await vi.advanceTimersByTimeAsync(31_000);
    // 12 s, 12 s, and the third is cut off by the deadline at 30 s: three were started, the other seven never were.
    expect(await all).toEqual([0, 0, 0]);
    expect(provider.queries).toEqual(["q0", "q1", "q2"]);
    expect(run.canSearch).toBe(false);
    expect(run.trace.notes).toContain("The run reached its time limit and stopped early. What was found before that is kept.");
    // And once that is so, asking anyway starts nothing.
    expect(await run.search("late")).toEqual([]);
    expect(provider.queries).toHaveLength(3);
  });

  it("a run with no deadline of its own still has one", async () => {
    vi.useFakeTimers();
    const provider = hanging();
    const run = new PlayRun({ searchOpts: { providers: [provider] } });
    const all = (async () => {
      let n = 0;
      while (run.canSearch && n < 100) {
        await run.search(`q${n++}`);
      }
      return n;
    })();
    await vi.advanceTimersByTimeAsync(241_000);
    // Four minutes of searches that never answer: twenty of them, not a hundred.
    expect(await all).toBe(20);
  });
});

describe("a search that never looked where it was asked to", () => {
  /** An engine that ignores `site:` - what comes back is from anywhere, and is thrown away by the provider. */
  const ignoresSite = (): SearchProvider => ({
    name: "bing_html",
    available: () => true,
    search: async (q: string) => honorSiteOperator(q, [{ title: "The best alternative to Acme", url: "https://vendor.example/alternative-to-acme", snippet: "", provider: "bing_html" }]),
  });

  it("is counted as a search that failed, and the run says which searches those were", async () => {
    const run = new PlayRun({ searchOpts: { providers: [ignoresSite()] } });
    expect(await run.search('site:reddit.com "alternative to Acme"')).toEqual([]);
    expect(await run.search('site:news.ycombinator.com "alternative to Acme"')).toEqual([]);
    expect(run.trace).toMatchObject({ searches: 2, failedSearches: 2 });
    expect(run.searchAnswered).toBe(false);
    const trace = run.finish(run.searchAnswered, "Nothing could be searched.");
    expect(trace.blocked).toBe(true);
    expect(trace.blockedReason).toBe("No search source is connected on our side, so this run could not search. This is not a result about your market.");
  });

  it("alongside searches that did answer, it is said in a note - and not counted twice", async () => {
    const run = new PlayRun({ searchOpts: { providers: [ignoresSite()] } });
    await run.search('site:reddit.com "alternative to Acme"');
    expect((await run.search('"alternative to Acme"')).length).toBe(1);
    const trace = run.finish(run.searchAnswered, "x");
    expect(trace).toMatchObject({ blocked: false, searches: 2, failedSearches: 1 });
    expect(trace.notes).toContain("1 of 2 searches were meant for one site each, but the search source in use ignored that and its results had to be discarded. Those sites were not searched.");
    expect(trace.notes.some((n) => /did not get an answer/.test(n))).toBe(false);
  });

  it("a site that was searched and had nothing is an answer", async () => {
    const run = new PlayRun({ searchOpts: { providers: [searchWith(() => [])] } });
    await run.search('site:reddit.com "alternative to Acme"');
    expect(run.trace).toMatchObject({ searches: 1, failedSearches: 0 });
    expect(run.searchAnswered).toBe(true);
  });

  it("a public search API asked directly says nothing about which web search sources are connected", async () => {
    const run = new PlayRun({ searchOpts: { providers: [ignoresSite()] } });
    await run.search('"alternative to Acme"');
    run.countSearch(true);
    run.countSearch(false);
    const trace = run.finish(run.searchAnswered, "x");
    expect(trace).toMatchObject({ searches: 3, failedSearches: 1, blocked: false });
    // The web results still came from a fallback search, and that is still said.
    expect(trace.notes).toContain("No dependable search source is connected on our side, so these results come from a fallback search and may be thin.");
  });
});
