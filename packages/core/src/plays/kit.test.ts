/**
 * Shared helpers for the play tests: a web that exists only in memory.
 *
 * Nothing in these tests reaches a real site. Pages come from `web()`, a stand-in for the
 * global `fetch`, and search results from `searchWith()`, a stand-in search provider. Both
 * record what was asked, so a test can assert that something was NOT fetched.
 *
 * (Named *.test.ts so it stays out of the published build; the suite at the bottom checks
 * the helpers themselves.)
 */
import { describe, expect, it } from "vitest";
import type { AiMessage, AiProvider, SearchResult } from "../types.js";
import { ProviderUnavailableError } from "../providers/health.js";
import type { SearchProvider } from "../search/index.js";

// Tests do not wait between requests to one host; the pacing tests set their own pause.
process.env.PLAYS_HOST_PAUSE_MS ??= "0";

/** A page. `location` with a 3xx status is a redirect, answered the way a server does: the engine decides whether to follow it. */
export type Route = string | { status?: number; body?: string; type?: string; location?: string; throws?: boolean };

export interface FakeWeb {
  fetch: typeof fetch;
  /** Every URL asked for, in order - robots.txt and redirect hops included. */
  calls: string[];
  /** When each of `calls` was made (milliseconds), for the tests about pacing. */
  at: number[];
  /** `calls` without the robots.txt requests: the pages themselves. */
  pages(): string[];
  hosts(): string[];
}

const keyOf = (url: string): string => url.replace(/#.*$/, "").replace(/\/$/, "");

/** A `fetch` that serves the given pages and answers 404 for everything else. */
export function web(routes: Record<string, Route> | ((url: string) => Route | undefined)): FakeWeb {
  const calls: string[] = [];
  const at: number[] = [];
  const table = typeof routes === "function" ? null : new Map(Object.entries(routes).map(([k, v]) => [keyOf(k), v]));
  const impl = async (input: unknown): Promise<Response> => {
    const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : (input as { url: string }).url);
    calls.push(url);
    at.push(Date.now());
    const route = table ? table.get(keyOf(url)) : (routes as (u: string) => Route | undefined)(url);
    const r: Exclude<Route, string> = route === undefined ? { status: 404, body: "Not found" } : typeof route === "string" ? { body: route } : route;
    if (r.throws) throw new TypeError("fetch failed");
    const status = r.status ?? 200;
    const headers = new Headers({ "content-type": r.type ?? "text/html; charset=utf-8" });
    if (r.location) headers.set("location", r.location);
    let res: Response;
    if (status < 200 || status > 599) {
      // LinkedIn's 999 cannot be built with the Response constructor.
      res = { ok: false, status, statusText: "", headers, body: null, url: "", text: async () => r.body ?? "" } as unknown as Response;
    } else {
      res = new Response(status === 204 || status === 304 ? null : (r.body ?? ""), { status, headers });
    }
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  return { fetch: impl as unknown as typeof fetch, calls, at, pages: () => calls.filter((c) => !/\/robots\.txt$/.test(c)), hosts: () => [...new Set(calls.map((c) => new URL(c).hostname))] };
}

export interface FakeSearch extends SearchProvider {
  queries: string[];
}

/** A search provider that answers from a function of the query. Counts as a configured (keyed) source. */
export function searchWith(answer: (query: string) => Partial<SearchResult>[] | undefined, name = "testsearch"): FakeSearch {
  const queries: string[] = [];
  return {
    name,
    queries,
    available: () => true,
    search: async (query: string) => {
      queries.push(query);
      return (answer(query) ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.snippet ?? "", provider: name }));
    },
  };
}

/** A search provider that always fails, the way a rate-limited or broken one does. */
export function brokenSearch(name = "testsearch"): FakeSearch {
  const queries: string[] = [];
  return {
    name,
    queries,
    available: () => true,
    search: async (query: string) => {
      queries.push(query);
      throw new ProviderUnavailableError(name, "server", `${name} is down`);
    },
  };
}

export interface FakeAi extends AiProvider {
  calls: AiMessage[][];
}

/** A model that answers with the given JSON (or whatever the function returns for the prompt). */
export function model(answer: unknown | ((messages: AiMessage[]) => unknown)): FakeAi {
  const calls: AiMessage[][] = [];
  return {
    name: "stub",
    model: "stub-1",
    calls,
    complete: async (messages: AiMessage[]) => {
      calls.push(messages);
      const out = typeof answer === "function" ? (answer as (m: AiMessage[]) => unknown)(messages) : answer;
      return typeof out === "string" ? out : JSON.stringify(out);
    },
  };
}

export const NO_AI: AiProvider = { name: "none", model: "none", complete: async () => "{}" };

/** A full HTML page around a body. */
export const page = (title: string, body: string, head = ""): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/* ───────────────────────────────── a competitor's site ───────────────────────────────── */

/**
 * The customers page of an invented competitor, Acme. Everything a real one has: a logo
 * wall, an integrations wall, partner, investor and press rows, case-study cards, a
 * testimonial, and a navigation bar and footer full of logos that are not customers.
 */
export const CUSTOMERS_PAGE = page(
  "Customers | Acme",
  `
<header class="site-header">
  <nav class="navbar">
    <a href="/"><img src="/img/acme-logo.svg" alt="Acme logo"></a>
    <a href="/product">Product</a>
    <a href="/customers">Customers</a>
    <a href="/customers/enterprise">Enterprise</a>
    <a href="/case-studies">Case studies</a>
    <a href="/integrations/slack"><img src="/i/slack.svg" alt="Slack logo"></a>
    <a href="/pricing">Pricing</a>
  </nav>
</header>
<main>
  <section class="hero">
    <h1>Our customers</h1>
    <p>More than 4,000 teams run their onboarding on Acme.</p>
  </section>

  <section class="logo-wall">
    <h2>Trusted by teams at</h2>
    <ul class="logos">
      <li><img src="/logos/globex.svg" alt="Globex logo"></li>
      <li><img src="/logos/initech.svg" alt="Initech"></li>
      <li><a href="https://www.umbrellacorp.com/?utm_source=acme"><img src="/logos/umbrella.svg" alt="Umbrella Corp logo"></a></li>
      <li><img src="/logos/google.svg" alt="Google logo"></li>
      <li><img src="/logos/stripe.svg" alt="Stripe"></li>
      <li><img src="/logos/aws.svg" alt="AWS logo"></li>
      <li><svg role="img" aria-label="Hooli logo" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></li>
      <li><img src="/logos/acme-white.svg" alt="Acme logo white"></li>
    </ul>
  </section>

  <section class="integrations">
    <h2>Integrates with the tools you already use</h2>
    <div class="logos">
      <img src="/i/slack.svg" alt="Slack logo"><img src="/i/salesforce.svg" alt="Salesforce logo">
      <img src="/i/zapier.svg" alt="Zapier logo"><img src="/i/piedpiper.svg" alt="Pied Piper logo">
    </div>
  </section>

  <section>
    <h2>Our partners</h2>
    <div class="partner-logos"><img src="/p/vandelay.svg" alt="Vandelay Industries logo"><img src="/p/wonka.svg" alt="Wonka Consulting logo"></div>
  </section>

  <section>
    <h2>Backed by</h2>
    <div class="logos"><img src="/inv/sequoia.svg" alt="Sequoia logo"><img src="/inv/massive.svg" alt="Massive Dynamic Ventures logo"></div>
  </section>

  <section>
    <h2>As seen in</h2>
    <div class="logos"><img src="/press/tc.svg" alt="TechCrunch logo"><img src="/press/cyberdyne.svg" alt="Cyberdyne Times logo"></div>
  </section>

  <section class="case-studies">
    <h2>Customer stories</h2>
    <article class="card">
      <img src="/logos/soylent.svg" alt="Soylent logo">
      <h3>How Soylent cut onboarding time by 40%</h3>
      <a href="/customers/soylent">Read the story</a>
    </article>
    <article class="card">
      <h3>Why Stark Industries chose Acme for 12,000 employees</h3>
      <a href="/customers/stark-industries-case-study">Read the story</a>
    </article>
    <a class="card" href="/customers/wayne-enterprises">
      <h3>Wayne Enterprises + Acme</h3>
      <p>Rolling out in 14 countries</p>
    </a>
    <a href="/customers/tyrell">Read story</a>
    <a href="/customers/remote-teams">Remote teams</a>
    <a href="/customers/healthcare">Healthcare</a>
    <a href="/customers/become-a-reference">Become a reference</a>
    <a href="/customers/page/2">Next page</a>
  </section>

  <section class="testimonials">
    <figure>
      <blockquote>Acme paid for itself in the first month.</blockquote>
      <figcaption>Dana Scully, VP Operations at Oscorp</figcaption>
    </figure>
    <figure class="testimonial">
      <blockquote>The team behind Acme ships faster than anyone we have backed.</blockquote>
      <img class="avatar rounded-full" src="/people/jane.jpg" alt="Jane Doe">
      <figcaption>Jane Doe, Partner at Benchmark Capital</figcaption>
    </figure>
    <figure class="testimonial">
      <blockquote>We love working here.</blockquote>
      <figcaption>Sam Lee, Engineer at Acme</figcaption>
    </figure>
  </section>
</main>
<footer class="site-footer">
  <a href="/customers/all">All customers</a>
  <a href="https://www.linkedin.com/company/acme"><img src="/i/li.svg" alt="LinkedIn"></a>
  <a href="https://twitter.com/acme"><img src="/i/tw.svg" alt="Twitter logo"></a>
  <a href="https://www.g2.com/products/acme"><img src="/i/g2.svg" alt="G2 Leader badge"></a>
  <img src="/i/soc2.svg" alt="SOC 2 logo">
  <p>(c) Acme Inc. Built in Lisbon.</p>
</footer>`,
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","sameAs":["https://twitter.com/acme"]}</script>`,
);


/** Acme's home page: a "trusted by" strip, a features grid, links to the customer pages in the navigation. */
export const ACME_HOME = page(
  "Acme - onboarding that runs itself",
  `
<header><nav class="navbar">
  <a href="/"><img src="/img/acme-logo.svg" alt="Acme logo"></a>
  <a href="/customers">Customers</a>
  <a href="/pricing">Pricing</a>
  <a href="https://status.acme.com/">Status</a>
  <a href="http://127.0.0.1/customers/secret">Internal</a>
  <a href="https://intranet.corp.local/case-studies/all">Intranet</a>
  <a href="https://www.umbrellacorp.com/customers/acme">Umbrella on us</a>
</nav></header>
<main>
  <section class="hero"><h1>Onboarding that runs itself</h1><img src="/img/dashboard.png" alt="Acme dashboard"></section>
  <div class="social-proof"><p>Trusted by 4,000+ teams</p>
    <div class="row"><img src="/a/1.svg" alt="Globex logo"><img src="/a/2.svg" alt="Massive Dynamic logo"><img src="/a/3.svg" alt="Slack logo"></div>
  </div>
  <section class="features"><h2>Everything in one place</h2><img src="/f/a.svg" alt="Analytics icon"><img src="/f/b.svg" alt="Workflow builder"></section>
</main>
<footer><a href="/customers/all">All customers</a><img src="/i/g2.svg" alt="G2 Leader badge"></footer>`,
);

/** One case study on Acme's site. */
export const CASE_STUDY = (company: string, headline: string): string =>
  page(`${headline} | Acme`, `<nav><a href="/customers">Customers</a></nav><main><article><header><h1>${headline}</h1></header><p>${company} had a problem with onboarding. Then it found a better way, and the numbers followed within a quarter.</p></article></main><footer>(c) Acme</footer>`);

// The suite below is registered only when this file itself is the one being run, not in
// every test file that imports the helpers. (Should the runner stop saying which file it is
// collecting, it is simply registered everywhere.)
const current = expect.getState().testPath;
const ownFile = typeof current !== "string" || /[\\/]kit\.test\.ts$/.test(current);

(ownFile ? describe : () => undefined)("the in-memory web used by the play tests", () => {
  it("serves what it was given, answers 404 for the rest, and records every request", async () => {
    const w = web({ "https://acme.test/": "<p>home</p>", "https://acme.test/gone": { status: 410 } });
    expect(await (await w.fetch("https://acme.test/")).text()).toBe("<p>home</p>");
    expect((await w.fetch("https://acme.test/missing")).status).toBe(404);
    expect((await w.fetch("https://acme.test/gone")).status).toBe(410);
    expect(w.calls).toEqual(["https://acme.test/", "https://acme.test/missing", "https://acme.test/gone"]);
    expect(w.at.length).toBe(3);
    expect(w.hosts()).toEqual(["acme.test"]);
    await w.fetch("https://acme.test/robots.txt");
    expect(w.pages()).toEqual(["https://acme.test/", "https://acme.test/missing", "https://acme.test/gone"]);
    // A redirect is answered, not followed: whoever asked decides.
    const moved = web({ "https://acme.test/old": { status: 302, location: "/new" } });
    const res = await moved.fetch("https://acme.test/old");
    expect([res.status, res.headers.get("location")]).toEqual([302, "/new"]);
  });

  it("the stand-in search provider records queries and can fail like a real one", async () => {
    const s = searchWith((q) => (q.includes("x") ? [{ title: "t", url: "https://a.test/" }] : []));
    expect(await s.search("x")).toEqual([{ title: "t", url: "https://a.test/", snippet: "", provider: "testsearch" }]);
    await expect(brokenSearch().search("x")).rejects.toThrow(/is down/);
    expect(s.queries).toEqual(["x"]);
  });
});
