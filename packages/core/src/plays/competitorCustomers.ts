/**
 * Play: companies a competitor names as its customers.
 *
 * Reads the competitor's own public pages - home page, customers and case-study sections,
 * the sitemap - at most twelve requests per competitor, one request per page, and reports
 * a company only with the page and the words on it that name the company as a customer.
 */
import type { AiMessage } from "../types.js";
import { UNTRUSTED_RULE, fence, fenceBlock } from "../ai/untrusted.js";
import { resolveCompanyDomainDetailed } from "../discovery/companies.js";
import { extractDomain } from "../util/domain.js";
import { isPublicHost } from "../util/publicHost.js";
import { customerLinksFromSitemap, extractCustomers, isCustomerPath, verifyAiCustomers, type CustomerHit } from "./extractCustomers.js";
import { PlayRun, clampInt, findingLimit, finishFinding, rankFindings, sameSite } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, normCompanyName } from "./util.js";

const FIXED_PATHS = ["/customers", "/case-studies", "/customer-stories", "/success-stories", "/stories", "/clients", "/testimonials", "/resources/case-studies"];
/** Requests to one competitor's site, the sitemap included. */
const MAX_PAGES_PER_COMPETITOR = 12;
const MAX_AI_PAGES_PER_COMPETITOR = 3;
const MAX_COMPETITORS = 10;

interface Queued {
  url: string;
  score: number;
  kind: "page" | "sitemap";
}

const keyOf = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();

function reasonFor(hit: CustomerHit, competitor: string, customerPage: boolean): string {
  const headline = hit.headline ? cleanLine(hit.headline, 110).replace(/["\u201C\u201D]/g, "'") : "";
  if (hit.via === "case_study") {
    return headline ? `Named as a customer of ${competitor} in their case study "${headline}".` : `Has a customer story on ${competitor}'s website.`;
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
    const origin = `https://${site}`;
    push(`${origin}/`, 100);
    push(`${origin}/sitemap.xml`, 85, "sitemap");
    for (const p of FIXED_PATHS) push(`${origin}${p}`, 70);

    const hits = new Map<string, { hit: CustomerHit; url: string; title: string; customerPage: boolean }>();
    const keep = (hit: CustomerHit, url: string, title: string, customerPage: boolean): void => {
      const k = normCompanyName(hit.name);
      const have = hits.get(k);
      // Equally sure on two pages: the customers page is the better proof to show a reviewer.
      const better = !have || hit.confidence > have.hit.confidence || (hit.confidence === have.hit.confidence && customerPage && !have.customerPage);
      if (better) hits.set(k, { hit: { ...hit, domain: hit.domain ?? have?.hit.domain }, url, title, customerPage });
      else if (!have.hit.domain && hit.domain) have.hit.domain = hit.domain;
    };

    let requests = 0;
    let aiPages = 0;
    let droppedByCheck = 0;
    let examinedHere = 0;
    let homepageDone = false;
    /** Once the site has shown where its customer pages are, paths it did not list are only tried last. */
    const demoteGuesses = (): void => {
      for (const q of queue.values()) if (q.score === 70) q.score = 35;
    };
    while (requests < MAX_PAGES_PER_COMPETITOR && queue.size && !run.expired) {
      const next = [...queue.values()].sort((x, y) => y.score - x.score)[0];
      queue.delete(keyOf(next.url));
      done.add(keyOf(next.url));
      if (next.score < 30) break;
      requests++;
      const isHome = !homepageDone && next.score === 100;
      if (isHome) homepageDone = true;
      let page = await run.fetchPage(next.url);
      if (!page.ok && isHome && page.kind === "failed") {
        // https reached nothing: some small sites still answer on http only. One try, same page.
        requests++;
        page = await run.fetchPage(`http://${site}/`);
        if (!page.ok && page.kind !== "refused") run.note(`${site} could not be reached, so ${shownName} was not read.`);
        if (!page.ok) break;
      }
      if (!page.ok) {
        if (page.kind === "deadline") break;
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
      if (next.kind === "sitemap") {
        const map = customerLinksFromSitemap(page.body, site);
        for (const l of map.links.slice(0, 80)) push(l.url, l.score + 1);
        if (map.links.length) demoteGuesses();
        // An index of sitemaps: one child, the one most likely to list customer pages.
        const child = map.children.find((u) => /customer|case|stor|success|client/i.test(u)) ?? map.children.find((u) => /page|post|main|sitemap-?1|sitemap-0/i.test(u));
        if (child) push(child, 80, "sitemap");
        continue;
      }
      pagesExamined++;
      examinedHere++;
      const out = extractCustomers(page.body, page.url, competitor);
      for (const h of out.hits) keep(h, page.url, out.title, out.customerPage);
      for (const l of out.links) push(l.url, l.score);
      if (out.links.some((l) => l.score >= 90)) demoteGuesses();

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
        evidenceUrl: url,
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
