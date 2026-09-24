import * as cheerio from "cheerio";
import type { CompanyProfile, PersonCandidate } from "../types.js";
import { fetchText, pMap } from "../util/http.js";
import { rootDomain } from "../util/domain.js";
import { isPublicHost } from "../util/publicHost.js";
import { splitName } from "../util/names.js";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PAGES = ["", "/about", "/about-us", "/team", "/our-team", "/contact", "/contact-us", "/company", "/leadership", "/people"];

const TECH_SIGNATURES: [RegExp, string][] = [
  [/wp-content|wordpress/i, "WordPress"],
  [/shopify/i, "Shopify"],
  [/hubspot|hs-scripts/i, "HubSpot"],
  [/intercom/i, "Intercom"],
  [/segment\.com|analytics\.js/i, "Segment"],
  [/googletagmanager/i, "Google Tag Manager"],
  [/gtag\(|google-analytics/i, "Google Analytics"],
  [/stripe\.com/i, "Stripe"],
  [/razorpay/i, "Razorpay"],
  [/webflow/i, "Webflow"],
  [/wix\.com/i, "Wix"],
  [/next\/static|__next/i, "Next.js"],
  [/react/i, "React"],
  [/zendesk/i, "Zendesk"],
  [/freshdesk|freshworks/i, "Freshworks"],
  [/zoho/i, "Zoho"],
  [/salesforce|pardot/i, "Salesforce"],
  [/mailchimp/i, "Mailchimp"],
  [/hotjar/i, "Hotjar"],
  [/cloudflare/i, "Cloudflare"],
  [/tawk\.to/i, "Tawk.to"],
  [/drift\.com/i, "Drift"],
  [/calendly/i, "Calendly"],
];

const TITLE_WORDS = /\b(CEO|CTO|CFO|COO|CMO|Founder|Co-?Founder|Director|Head|VP|Vice President|Manager|Lead|Chief|President|Partner|Engineer|Designer|Officer)\b/i;

export interface CrawlOptions {
  maxPages?: number;
  timeoutMs?: number;
  /**
   * Try plain http when https reaches nothing. Default true.
   *
   * A surprising number of small-business sites - exactly the long tail this product is
   * built to find - still serve on http only, or have a certificate that node rejects.
   * Every one of those used to come back as a company with no website content at all. This
   * is a public marketing page being read, not a credential being sent, so falling back is
   * the difference between enriching that company and silently skipping it.
   */
  allowInsecureFallback?: boolean;
  /**
   * Permit loopback and private addresses. Off by default and only used by tests, which
   * serve their fixtures from 127.0.0.1.
   */
  allowPrivateHosts?: boolean;
}

export async function crawlCompanyWebsite(domain: string, opts: CrawlOptions = {}): Promise<CompanyProfile> {
  const profile: CompanyProfile = { domain, techStack: [], emailsFound: [], peopleFound: [], socials: {} };
  const paths = PAGES.slice(0, opts.maxPages ?? 6);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  /**
   * Crawl targets are user input - an ICP's seed domains, a domain typed into a tool - and
   * whatever a crawl harvests is written to the company record and shown back in the UI.
   * Pointing one at the machine doing the crawling has to be refused before the first
   * request, not after. `allowPrivateHosts` exists so the tests can serve from loopback.
   */
  const target = /^https?:\/\//i.test(domain) ? domain.slice(domain.indexOf("://") + 3) : domain;
  if (!opts.allowPrivateHosts && !isPublicHost(target)) {
    profile.pagesAttempted = 0;
    profile.pagesFetched = 0;
    profile.crawlFailed = true;
    profile.crawlRefused = `${target.split("/")[0]} is not a public web address, so it was not fetched`;
    return profile;
  }

  // publicOnly so the guard applies to every redirect hop, not just the address we were
  // handed. A pre-flight check alone is defeated by one 302.
  const attempt = (scheme: string) =>
    pMap(paths, async (p) => ({ path: p, html: await fetchText(`${scheme}://${domain}${p}`, { timeoutMs, publicOnly: true, allowPrivateHosts: opts.allowPrivateHosts }) }), 3);

  // A domain handed in with an explicit scheme is honoured as written rather than
  // double-prefixed into an unfetchable URL.
  const explicit = /^https?:\/\//i.test(domain);
  const scheme = explicit ? domain.split("://")[0].toLowerCase() : "https";
  if (explicit) {
    domain = domain.slice(domain.indexOf("://") + 3);
    profile.domain = domain;
  }

  let pages = await attempt(scheme);
  // https reached nothing at all: the site may be http-only or have a certificate node
  // rejects. Retrying over http turns "this company has no web presence" back into a crawl.
  if (!explicit && !pages.some((p) => p.html) && (opts.allowInsecureFallback ?? true)) {
    pages = await attempt("http");
    if (pages.some((p) => p.html)) profile.insecureFallback = true;
  }
  const emails = new Set<string>();
  const tech = new Set<string>();
  const people = new Map<string, PersonCandidate>();
  const rd = rootDomain(domain);

  for (const { path, html } of pages) {
    if (!html) continue;
    const $ = cheerio.load(html);
    if (path === "") {
      profile.name = clean($('meta[property="og:site_name"]').attr("content")) ?? clean($("title").text().split(/[|–-]/)[0]);
      profile.description =
        clean($('meta[name="description"]').attr("content")) ?? clean($('meta[property="og:description"]').attr("content"));
      $("script[type='application/ld+json']").each((_, el) => {
        try {
          const j = JSON.parse($(el).text());
          const org = Array.isArray(j) ? j.find((x) => x["@type"] === "Organization") : j["@type"] === "Organization" ? j : null;
          if (org) {
            profile.name = profile.name ?? org.name;
            if (org.foundingDate) profile.foundedYear = Number(String(org.foundingDate).slice(0, 4)) || undefined;
            if (org.address?.addressLocality) profile.location = [org.address.addressLocality, org.address.addressCountry].filter(Boolean).join(", ");
            if (org.address?.addressCountry) profile.country = org.address.addressCountry;
            for (const s of org.sameAs ?? []) socialFromUrl(String(s), profile.socials);
          }
        } catch {}
      });
      for (const [re, name] of TECH_SIGNATURES) if (re.test(html)) tech.add(name);
    }
    for (const m of html.match(EMAIL_RE) ?? []) {
      const e = m.toLowerCase();
      if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(e)) continue;
      if (e.endsWith(`@${rd}`) || e.endsWith(`.${rd}`)) emails.add(e);
    }
    $("a[href]").each((_, el) => socialFromUrl($(el).attr("href") ?? "", profile.socials));
    // Team pages: look for name + title pairs inside small blocks
    if (/team|about|leadership|people/.test(path)) {
      $("h2, h3, h4, .name, [class*=name], [class*=member], [class*=team]").each((_, el) => {
        const nameText = clean($(el).clone().children().remove().end().text());
        if (!nameText || nameText.length > 40 || nameText.split(" ").length < 2 || nameText.split(" ").length > 4) return;
        if (!/^[A-Z][a-z]+(\s[A-Z][a-z.'-]+){1,3}$/.test(nameText)) return;
        const next = clean($(el).next().text()) ?? "";
        const parentText = clean($(el).parent().text()) ?? "";
        const titleCand = TITLE_WORDS.test(next) ? next : parentText.replace(nameText, "").trim();
        const title = TITLE_WORDS.test(titleCand) ? titleCand.slice(0, 80) : undefined;
        if (!title) return;
        if (people.has(nameText)) return;
        people.set(nameText, { ...splitName(nameText), title, companyName: profile.name, source: `website:${domain}${path}`, confidence: 0.7 });
      });
    }
  }
  profile.emailsFound = [...emails];
  profile.techStack = [...tech];
  profile.peopleFound = [...people.values()];
  if (profile.socials.linkedin) profile.linkedinUrl = profile.socials.linkedin;
  // Say how much of the site we actually saw, so an empty profile can be told apart from a
  // crawl that never got off the ground. See CompanyProfile.crawlFailed.
  profile.pagesAttempted = paths.length;
  profile.pagesFetched = pages.filter((p) => p.html).length;
  profile.crawlFailed = profile.pagesFetched === 0;
  return profile;
}

function clean(s?: string | null) {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

function socialFromUrl(href: string, socials: Record<string, string>) {
  const m = href.match(/https?:\/\/(?:www\.)?(linkedin\.com\/company\/[^/?#]+|twitter\.com\/[^/?#]+|x\.com\/[^/?#]+|facebook\.com\/[^/?#]+|instagram\.com\/[^/?#]+|github\.com\/[^/?#]+|youtube\.com\/[^/?#]+)/i);
  if (!m) return;
  const key = m[1].split(".")[0].toLowerCase().replace("x", "twitter");
  if (!socials[key]) socials[key] = `https://www.${m[1]}`;
}
