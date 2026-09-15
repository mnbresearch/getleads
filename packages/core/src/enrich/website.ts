import * as cheerio from "cheerio";
import type { CompanyProfile, PersonCandidate } from "../types.js";
import { fetchText, pMap } from "../util/http.js";
import { rootDomain } from "../util/domain.js";
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
}

export async function crawlCompanyWebsite(domain: string, opts: CrawlOptions = {}): Promise<CompanyProfile> {
  const base = `https://${domain}`;
  const profile: CompanyProfile = { domain, techStack: [], emailsFound: [], peopleFound: [], socials: {} };
  const paths = PAGES.slice(0, opts.maxPages ?? 6);
  const pages = await pMap(paths, async (p) => ({ path: p, html: await fetchText(`${base}${p}`, { timeoutMs: opts.timeoutMs ?? 10_000 }) }), 3);
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
