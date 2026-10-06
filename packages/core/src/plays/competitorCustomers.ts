/**
 * Play: companies a competitor names as its customers.
 *
 * Reads the competitor's own public pages - home page, customers and case-study sections,
 * the sitemap - and reports a company only with the page and the words on it that name the
 * company as a customer.
 *
 * At most twelve requests per competitor, everything counted: the site's robots.txt, every
 * redirect hop, the sitemap. One request at a time with a pause in between. Listing pages
 * come first; a story that a listing page already tells in full (who, and under which
 * headline) is not opened again, and its proof is the story's own address. The exception
 * is a connected model: it reads the prose of up to three pages, stories included.
 */
import type { AiMessage } from "../types.js";
import { UNTRUSTED_RULE, fence, fenceBlock } from "../ai/untrusted.js";
import { resolveCompanyDomainDetailed } from "../discovery/companies.js";
import { extractDomain } from "../util/domain.js";
import { isPublicHost } from "../util/publicHost.js";
import { caseSlugOf, customerLinksFromSitemap, extractCustomers, isCustomerPath, pickEvidence, storyKeyOf, storyWorthOpening, verifyAiCustomers, type CustomerHit } from "./extractCustomers.js";
import { PlayRun, clampInt, findingLimit, finishFinding, rankFindings, sameSite } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, cutAtWord, normCompanyName, plainDashes } from "./util.js";

const FIXED_PATHS = ["/customers", "/case-studies", "/customer-stories", "/success-stories", "/stories", "/clients", "/testimonials", "/resources/case-studies"];
/** Requests to one competitor's site: robots.txt, redirect hops and the sitemap included. */
const MAX_PAGES_PER_COMPETITOR = 12;
const MAX_AI_PAGES_PER_COMPETITOR = 3;
const MAX_COMPETITORS = 10;

/** "/de/case-studies", "/pt-br/clientes": the same pages again in another language. */
const inAnotherLanguage = (url: string): boolean => {
  try {
    return /^\/(?:de|fr|es|it|pt|nl|sv|da|no|nb|fi|pl|ja|jp|ko|kr|zh|cn|ru|tr|cs|hu|ro|el|he|ar|id|th|vi|br|mx)(?:-[a-z]{2,4})?\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** The same address without its language prefix ("/de/case-studies" as "/case-studies"). */
const withoutLanguage = (url: string): string => {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i, "");
    return u.toString();
  } catch {
    return url;
  }
};

interface Queued {
  url: string;
  score: number;
  kind: "page" | "sitemap";
}

const keyOf = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();

/**
 * The sentence a reviewer reads. Built from fixed words around the competitor's name and,
 * when the page has one, the case study's headline: in plain dashes, never cut inside a
 * word, and only when it is a headline (not the line under a quote, not a page title, not a
 * headline in another language).
 */
function reasonFor(hit: CustomerHit, competitor: string, customerPage: boolean): string {
  if (hit.via === "case_study") {
    // (A headline that ends in a full stop would put two in the sentence.)
    const headline = hit.headline ? cutAtWord(plainDashes(cleanLine(hit.headline, 200)).replace(/["\u201C\u201D]/g, "'").replace(/[.\s]+$/, ""), 110) : "";
    if (headline) return `Named as a customer of ${competitor} in their case study "${headline}".`;
    if (hit.mention === "attribution") return `Quoted as a customer of ${competitor} on their website.`;
    if (hit.mention === "title") return `Named as a customer of ${competitor} on their customers page.`;
    return `Has a customer story on ${competitor}'s website.`;
  }
  if (hit.via === "logo") return `Shown as a customer of ${competitor} on their ${customerPage ? "customers page" : "website"}.`;
  if (hit.via === "testimonial") return `Quoted as a customer of ${competitor} on their website.`;
  if (hit.via === "structured_data") return `Listed as a customer of ${competitor} on their website.`;
  return `Named as a customer of ${competitor} on their website.`;
}

function aiMessages(competitor: string, pageText: string): AiMessage[] {
  return [
    {
      role: "system",
      content:
        "You read the text of one web page from a company's own website and list the organisations that the page explicitly presents as customers or users of that company's product " +
        "(case studies, testimonials with the speaker's employer, 'trusted by' statements). Never list partners, integrations, investors, press outlets, technology vendors, " +
        "review sites or the company itself. Never guess: if the page does not say it, leave it out. For each organisation give its name as written on the page and a quote: " +
        "a passage copied character for character from the page text that contains the organisation's name and shows it is a customer. " +
        `${UNTRUSTED_RULE} Reply with JSON {"customers":[{"name": string, "quote": string}]} and nothing else; an empty list when there are none.`,
    },
    {
      role: "user",
      content: ["The company whose page this is:", fence("company_name", competitor, 120), "The page text:", fenceBlock("page_text", pageText, 6000), "Return JSON only."].join("\n"),
    },
  ];
}

export async function findCompetitorCustomers(cfg: { competitors: { name: string; domain?: string }[]; maxPerCompetitor?: number }, opts: PlayEngineOptions = {}): Promise<PlayEngineResult> {
  const run = new PlayRun(opts);
  const limit = findingLimit(opts);
  const perCompetitor = clampInt(cfg?.maxPerCompetitor, 25, 1, 50);
  const competitors = (Array.isArray(cfg?.competitors) ? cfg.competitors : [])
    .map((c) => ({ name: cleanLine(c?.name, 120), domain: typeof c?.domain === "string" ? c.domain.trim().slice(0, 300) : "" }))
    .filter((c) => c.name || c.domain)
    .slice(0, MAX_COMPETITORS);
  const findings: PlayFinding[] = [];
  let pagesExamined = 0;
  let sitesKnown = 0;

  if (!competitors.length) {
    run.block("No competitor was given, so there was nothing to read.");
    return { findings: [], trace: run.trace };
  }

  for (const c of competitors) {
    if (run.expired || findings.length >= limit) break;
    const shownName = c.name || c.domain;

    /* Where the competitor lives. A given domain is used as given; a missing one is searched for. */
    let domain: string | null = null;
    if (c.domain) {
      domain = extractDomain(c.domain.replace(/^\/\//, ""));
      const literal = c.domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
      if (!opts.allowPrivateHosts && (!domain || !isPublicHost(literal) || !isPublicHost(domain))) {
        run.trace.pagesRefused++;
        run.note(`${cleanLine(literal, 80) || "The address"} given for ${shownName} is not a public web address, so it was not fetched.`);
        continue;
      }
      if (!domain) domain = literal.toLowerCase();
    } else {
      const resolved = await run.within(resolveCompanyDomainDetailed(c.name, undefined, { providers: opts.searchOpts?.providers, onOutcome: run.recordOutcome }).catch(() => null));
      // Only a site whose own address carries the name: a wrong site would put someone else's customers under this competitor.
      if (resolved?.domain && /domain contains/.test(resolved.reason) && isPublicHost(resolved.domain)) domain = resolved.domain;
      else {
        run.note(`Could not confirm a website for ${shownName}, so it was skipped. Add its web address to the play.`);
        continue;
      }
    }
    const site = domain;
    sitesKnown++;
    const competitor = { name: c.name || site.split(".")[0], domain: site };

    const queue = new Map<string, Queued>();
    const done = new Set<string>();
    const push = (url: string, score: number, kind: Queued["kind"] = "page"): void => {
      const k = keyOf(url);
      if (done.has(k)) return;
      const have = queue.get(k);
      if (!have || score > have.score) queue.set(k, { url, score, kind });
    };
    push(`https://${site}/`, 100);
    push(`https://${site}/sitemap.xml`, 85, "sitemap");
    for (const p of FIXED_PATHS) push(`https://${site}${p}`, 70);

    interface Seen {
      hit: CustomerHit;
      url: string;
      title: string;
      customerPage: boolean;
    }
    const hits = new Map<string, Seen>();
    /** Which name each story is filed under: one story is about one customer, on whichever page it is met. */
    const byStory = new Map<string, string>();
    /** Stories a listing page already told in full: the company and words of the page that name it. */
    const covered = new Set<string>();
    const better = (a: Seen, b: Seen): Seen => {
      if (a.hit.confidence !== b.hit.confidence) return b.hit.confidence > a.hit.confidence ? b : a;
      // Equally sure on two pages: the customers page is the better proof to show a reviewer.
      if (a.customerPage !== b.customerPage) return b.customerPage ? b : a;
      return pickEvidence(a.hit, b.hit) === b.hit ? b : a;
    };
    const keep = (hit: CustomerHit, url: string, title: string, customerPage: boolean): void => {
      const k = normCompanyName(hit.name);
      if (!k) return;
      let rec: Seen = { hit, url, title, customerPage };
      const story = hit.storyUrl ? storyKeyOf(hit.storyUrl) : "";
      const filed = story ? byStory.get(story) : undefined;
      if (filed && filed !== k && hits.has(filed)) {
        // The same story under a second name ("UNREAL" on its own page, "UNREAL Snacks" on the listing):
        // one customer, under the fuller name, with the better of the two proofs.
        const other = hits.get(filed)!;
        const best = better(other, rec);
        if (k.startsWith(filed)) {
          hits.delete(filed);
          rec = { ...best, hit: { ...best.hit, name: hit.name, domain: hit.domain ?? other.hit.domain } };
        } else if (filed.startsWith(k)) {
          hits.set(filed, { ...best, hit: { ...best.hit, name: other.hit.name, domain: other.hit.domain ?? hit.domain } });
          return;
        } else if (hit.confidence > other.hit.confidence) {
          hits.delete(filed);
        } else {
          return;
        }
      }
      if (story) byStory.set(story, k);
      const have = hits.get(k);
      if (!have) {
        hits.set(k, rec);
        return;
      }
      const best = better(have, rec);
      hits.set(k, { ...best, hit: { ...best.hit, domain: best.hit.domain ?? have.hit.domain ?? hit.domain, storyUrl: best.hit.storyUrl ?? have.hit.storyUrl ?? hit.storyUrl } });
    };

    const firstRequest = run.requests;
    /** Requests still allowed for this competitor. Everything on the wire counts. */
    const left = (): number => MAX_PAGES_PER_COMPETITOR - (run.requests - firstRequest);
    let aiPages = 0;
    let droppedByCheck = 0;
    let examinedHere = 0;
    let homepageDone = false;
    let sitemapChildren = 0;
    /** Asking for a path without its final slash was answered with a redirect to the one with it. */
    let slashRedirects = false;
    /** Where the site really answers ("https://www.acme.com"), learned from the home page, so later requests are not redirected there one by one. */
    let canonical: URL | null = null;
    /** The site writes its addresses with a slash at the end, so guessed paths are asked for that way too. */
    let slashStyle = false;
    const asServed = (q: Queued): string => {
      try {
        const u = new URL(q.url);
        const bare = u.hostname.toLowerCase().replace(/^www\./, "");
        if (canonical && bare === site && canonical.hostname.toLowerCase().replace(/^www\./, "") === site) {
          u.protocol = canonical.protocol;
          u.host = canonical.host;
        }
        const guess = q.score === 70 || q.score === 35;
        if (q.kind === "page" && (slashRedirects || (slashStyle && guess)) && !u.pathname.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(u.pathname)) u.pathname += "/";
        return u.toString();
      } catch {
        return q.url;
      }
    };
    /** Customers named well enough to report as they are (a headline, a logo, a name on the page - not a bare address). */
    const named = (): number => [...hits.values()].filter((h) => h.hit.confidence >= 0.75).length;
    const isStory = (url: string): boolean => {
      try {
        return caseSlugOf(new URL(url).pathname) !== null;
      } catch {
        return false;
      }
    };
    /** Once the site has shown where its customer pages are, paths it did not list are only tried last. */
    const demoteGuesses = (): void => {
      for (const q of queue.values()) if (q.score === 70) q.score = 35;
    };
    while (left() > 0 && queue.size && !run.expired) {
      const next = [...queue.values()].sort((x, y) => y.score - x.score)[0];
      queue.delete(keyOf(next.url));
      done.add(keyOf(next.url));
      if (next.score < 30) break;
      // Paths the site never mentioned are only guessed at while it has shown few customers of its own accord.
      if (next.score === 35 && hits.size >= 5) break;
      // A page already read in one language is not read again in another.
      if (next.kind === "page" && inAnotherLanguage(next.url) && done.has(keyOf(withoutLanguage(next.url)))) continue;
      // A story a listing page already told in full is not opened again - unless a model is connected and
      // still has pages to read: the story's prose is what a model is for, and the listing does not carry it.
      if (next.kind === "page" && covered.has(storyKeyOf(next.url)) && !(run.aiUsable && aiPages < MAX_AI_PAGES_PER_COMPETITOR)) continue;
      // Nor is an address under the customers section that is a category or a form rather than a story.
      if (next.kind === "page" && next.score <= 61 && !storyWorthOpening(next.url, competitor.name)) continue;
      // Nor is one more story opened for its name once the listing pages have named as many customers as will be reported.
      if (next.kind === "page" && next.score <= 61 && isStory(next.url) && named() >= perCompetitor && !(run.aiUsable && aiPages < MAX_AI_PAGES_PER_COMPETITOR)) continue;
      const isHome = !homepageDone && next.score === 100;
      if (isHome) homepageDone = true;
      const asked = asServed(next);
      let page = await run.fetchPage(asked, { maxRequests: left() });
      if (!page.ok && isHome && page.kind === "failed" && left() > 0) {
        // https reached nothing: some small sites still answer on http only. One try, same page.
        page = await run.fetchPage(`http://${site}/`, { maxRequests: left() });
        if (!page.ok && page.kind !== "refused") run.note(`${site} could not be reached, so ${shownName} was not read.`);
        if (!page.ok) break;
      }
      if (!page.ok) {
        if (page.kind === "deadline" || page.kind === "budget") break;
        // The home page refusing settles it for the whole site: nothing else is asked for.
        if (isHome && page.kind === "refused") break;
        continue;
      }
      if (!sameSite(page.url, site)) {
        run.discardFetched();
        run.note(`${site} sent us to a different site (${cleanLine(page.url.replace(/^https?:\/\/(www\.)?/i, "").split(/[/?#]/)[0], 80)}), so it was not read. If that is ${shownName}'s site, add that address to the play.`);
        if (isHome) break;
        continue;
      }
      done.add(keyOf(page.url));
      try {
        const landed = new URL(page.url);
        if (isHome) canonical = landed;
        if (landed.pathname !== "/" && landed.pathname.endsWith("/") && page.url.replace(/\/$/, "") === asked.replace(/\/$/, "") && !asked.endsWith("/")) slashRedirects = true;
      } catch {
        // an address that does not parse changes nothing
      }
      if (next.kind === "sitemap") {
        const map = customerLinksFromSitemap(page.body, site);
        for (const l of map.links.slice(0, 80)) push(l.url, l.score + 1 - (inAnotherLanguage(l.url) ? 40 : 0));
        if (map.links.length) demoteGuesses();
        if (map.links.filter((l) => /\/$/.test(l.url)).length > map.links.length * 0.7) slashStyle = true;
        // An index of sitemaps: one child, the one most likely to list customer pages.
        const child = map.children.find((u) => /customer|case|stor|success|client/i.test(u)) ?? map.children.find((u) => /page|post|main|sitemap-?1|sitemap-0/i.test(u));
        if (child && ++sitemapChildren <= 1) push(child, 80, "sitemap");
        continue;
      }
      pagesExamined++;
      examinedHere++;
      const out = extractCustomers(page.body, page.url, competitor);
      for (const h of out.hits) keep(h, page.url, out.title, out.customerPage);
      for (const t of out.told) covered.add(t);
      for (const l of out.links) push(l.url, l.score - (inAnotherLanguage(l.url) ? 40 : 0));
      if (out.links.some((l) => l.score >= 90)) {
        demoteGuesses();
        // The site has shown its customer pages itself; the sitemap would mostly add single stories.
        for (const q of queue.values()) if (q.kind === "sitemap" && q.score > 50) q.score = 50;
      }
      if (out.links.length >= 3 && out.links.filter((l) => /\/$/.test(l.url)).length > out.links.length * 0.7) slashStyle = true;

      /* A model reads the prose of customer pages for names the rules cannot see. */
      const prose = out.text.length >= 200 && (out.customerPage || isHome || isCustomerPath(new URL(page.url).pathname));
      if (prose && run.aiUsable && aiPages < MAX_AI_PAGES_PER_COMPETITOR && !run.expired) {
        aiPages++;
        const shownText = out.text.slice(0, 6000);
        const raw = await run.askJson<{ customers?: unknown }>(aiMessages(competitor.name, shownText), { maxTokens: 900 });
        if (raw) {
          const checked = verifyAiCustomers(raw, shownText, competitor);
          droppedByCheck += checked.dropped;
          // A model-read name never outranks one the rules read; its confidence stays at or below 0.7.
          for (const h of checked.hits) keep({ ...h, confidence: Math.min(0.7, h.confidence) }, page.url, out.title, out.customerPage);
        }
      }
      if (hits.size >= perCompetitor * 2) break;
    }
    if (droppedByCheck > 0) run.note(`${droppedByCheck} name${droppedByCheck === 1 ? "" : "s"} suggested by AI for ${shownName} ${droppedByCheck === 1 ? "was" : "were"} left out because the page did not back ${droppedByCheck === 1 ? "it" : "them"} up.`);

    const own = [...hits.values()].sort((a, b) => b.hit.confidence - a.hit.confidence).slice(0, perCompetitor);
    for (const { hit, url, title, customerPage } of own) {
      const f = finishFinding({
        kind: "company",
        companyName: hit.name,
        ...(hit.domain ? { companyDomain: hit.domain } : {}),
        relevantBecause: reasonFor(hit, cleanLine(competitor.name, 60), customerPage),
        // A story's proof is the story itself, not whichever page happened to link to it.
        evidenceUrl: hit.via === "case_study" && hit.storyUrl ? hit.storyUrl : url,
        evidenceTitle: hit.headline || title || `${cleanLine(competitor.name, 60)} customers`,
        evidenceQuote: hit.quote,
        signalType: "competitor_customer",
        confidence: hit.confidence,
      });
      if (f && f.evidenceUrl && f.evidenceQuote) findings.push(f);
    }
    if (!own.length && examinedHere > 0 && !run.expired) run.note(`No customers were named on the pages of ${shownName} that could be read.`);
  }

  const trace = run.finish(
    pagesExamined > 0,
    sitesKnown === 0 ? "No website could be confirmed for the competitors given, so nothing was read. Add each competitor's web address to the play." : "None of the competitor pages could be read, so nothing could be checked.",
  );
  return { findings: rankFindings(findings, limit), trace };
}
