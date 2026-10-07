/**
 * What every play engine shares and nothing outside this folder should need: the run
 * bookkeeping (searches, page fetches, model calls, notes, the "could not look" verdict)
 * and the rules for what may be called a company name.
 */
import type { AiMessage, SearchResult } from "../types.js";
import { completeJson, hasAi } from "../ai/provider.js";
import { defaultProviders, webSearchDetailed, type WebSearchOutcome } from "../search/index.js";
import { fitHtml, unreadableHtml } from "../util/html.js";
import { CRAWLER_TOKEN, fetchPublic, readCapped } from "../util/http.js";
import { extractDomain, normalizeLinkedinUrl, rootDomain } from "../util/domain.js";
import { isPublicHost, parseHttpUrl } from "../util/publicHost.js";
import type { PlayEngineOptions, PlayFinding, PlayRunTrace } from "./types.js";
import { cleanLine, emptyTrace, normCompanyName, playDedupeKey, safeSentence } from "./util.js";

export const DEFAULT_LIMIT = 40;
export const HARD_LIMIT = 200;
/** One page fetch never waits longer than this. */
export const PAGE_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 1_500_000;
/** At most this much of a web page is kept and read. A customers page is a few hundred thousand characters; what a larger page says is said in its first part. */
export const MAX_PAGE_CHARS = 800_000;
const MAX_NOTE = 300;
const MAX_NOTES = 30;

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export const findingLimit = (opts: PlayEngineOptions): number => clampInt(opts.limit, DEFAULT_LIMIT, 1, HARD_LIMIT);

/** Strings from a config array: trimmed, cleaned, de-duplicated, bounded. Anything else is dropped. */
export function cleanList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = cleanLine(v, maxLen);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** An absolute http(s) URL of at most `max` characters, without credentials or fragment - or nothing. */
export function safeHttpUrl(url: unknown, max = 2000): string | undefined {
  if (typeof url !== "string") return undefined;
  const raw = url.trim();
  if (!raw || raw.length > max) return undefined;
  const u = parseHttpUrl(raw);
  if (!u) return undefined;
  const s = u.toString();
  return s.length <= max ? s : undefined;
}

export const hostOf = (url: string): string => {
  // An address longer than any real one is not an address: it is not parsed to find that out.
  if (typeof url !== "string" || url.length > 4000) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Same site in the sense that matters for following a link: the same registrable domain. */
export const sameSite = (url: string, domain: string): boolean => {
  const h = hostOf(url);
  return !!h && typeof domain === "string" && domain.length <= 300 && rootDomain(h) === rootDomain(domain.toLowerCase().replace(/^www\./, ""));
};

/* ───────────────────────────────── company names ───────────────────────────────── */

/**
 * Words that are never a company on their own: page furniture, calls to action, market
 * segments. A candidate made only of these is not a name.
 */
const GENERIC = new Set(
  (
    "logo logos logotype image images img icon icons photo photos picture graphic svg png jpg customer customers client clients company companies " +
    "partner partners team teams brand brands case study studies story stories success testimonial testimonials review reviews read more learn " +
    "view see all watch video videos play next previous prev arrow star stars quote quotes check close menu home about contact pricing blog " +
    "login signin sign signup up in demo free trial get started start our the your and for with of a an by to on at new featured enterprise " +
    "startup startups business businesses small medium mid market midmarket smb agency agencies industry industries solution solutions product " +
    "products platform features feature resources resource careers press news events event webinar webinars ebook guide report whitepaper " +
    "download healthcare health finance financial fintech retail ecommerce commerce saas software technology tech education manufacturing " +
    "logistics media marketing sales engineering security support operations legal hr it remote global placeholder default untitled " +
    "screenshot illustration hero banner background avatar user person people author headshot portrait badge badges award awards certified " +
    "rating ratings trusted loved used how why what who when where here this that these those we us you they them it its their one two three " +
    "top best leading modern fast growing fastest dashboard app application overview introduction summary results result challenge challenges " +
    "white black dark light color colour gray grey mono customer-story case-study read-more learn-more click link page section item slide " +
    "group frame vector rectangle mask layer shape asset copy alt title name text content block card tile wall cloud grid carousel slider " +
    "real estate insurance hospitality travel telecom energy automotive nonprofit government public sector b2b b2c d2c services service " +
    "professional consumer goods food beverage gaming games sports entertainment construction agriculture pharma biotech banking payments " +
    "data analytics ai ml cloud devops developer developers tools tool integration integrations community program programs partnerships " +
    "onboarding reporting automation compliance collaboration productivity billing scheduling hiring recruiting growth revenue everything " +
    "nothing something work time money costs cost roi efficiency performance quality speed simplicity innovation transformation " +
    "become join share submit refer apply explore browse discover find request book try reference references advocacy referral referrals " +
    "enterprises banks ambitious growing innovative forward-thinking high-growth world-class " +
    "portal faq faqs map love community feedback advocates champions council training academy university summit conference newsletter " +
    "calculator hub center centre directory gallery showcase list library archive latest popular recent rewards perks offers deals promo " +
    "discounts migration switch upgrade renewals invoices account accounts profile settings logout register welcome thanks error terms " +
    "privacy trust status docs documentation api resellers affiliates investors podcast ebooks guides reports whitepapers templates apps " +
    "marketplace plans help search careers jobs store shop cart checkout demo tour quiz survey form contact-us about-us wins results impact " +
    "main primary secondary header footer thumbnail thumb mockup desktop tablet"
  ).split(/\s+/),
);

/** Plural audience words: a phrase containing one describes a kind of customer, not a customer. */
const AUDIENCE = new Set(
  (
    "leaders teams marketers founders developers engineers managers recruiters agencies companies startups customers users businesses " +
    "retailers sellers creators operators professionals organizations organisations nonprofits hospitals schools " +
    "universities firms clients sales-teams marketing-teams teams' everyone anyone somebody someone nobody"
  ).split(/\s+/),
);

const CONNECTORS = new Set("of and the de la le van von der den du del di da y e for in at & + und et el los las".split(" "));

const LEADING_STOP = new Set(
  "how why what when where who read see view watch learn get our the a an your meet join more and or but with for from by to in on at if is are was we i you they this that these those it its their no not".split(" "),
);

/**
 * Names that show up on almost every software site as an integration, a payment option, a
 * review badge, a press mention, an investor or a social link. On a competitor's page they
 * are far more often one of those than a customer, so they are never reported as customers.
 * Missing a real customer here is the accepted cost.
 */
const VENDORS = new Set(
  (
    "google alphabet googlecloud googleworkspace googleanalytics googleads googleplay gmail gsuite gcp bigquery looker firebase youtube android chrome " +
    "microsoft azure microsoftazure microsoftteams office365 microsoft365 outlook bing linkedin github visualstudio dynamics365 powerbi " +
    "amazon aws amazonwebservices alexa apple appstore applepay ios macos icloud " +
    "meta facebook instagram whatsapp messenger twitter x tiktok snapchat pinterest reddit discord telegram twitch quora medium substack threads " +
    "slack stripe paypal square visa mastercard americanexpress amex razorpay adyen braintree klarna plaid " +
    "salesforce hubspot zapier make zendesk intercom segment twilio sendgrid mailchimp marketo pardot pipedrive zoho freshworks freshdesk " +
    "shopify woocommerce bigcommerce magento wordpress webflow wix squarespace " +
    "atlassian jira confluence trello bitbucket gitlab notion asana monday mondaycom clickup airtable figma canva miro dropbox box zoom calendly docusign " +
    "okta auth0 onelogin snowflake databricks datadog newrelic sentry pagerduty splunk elastic mongodb redis postgres postgresql mysql " +
    "mixpanel amplitude hotjar heap fullstory posthog optimizely tableau " +
    "cloudflare vercel netlify heroku digitalocean docker kubernetes terraform openai anthropic chatgpt claude gemini " +
    "g2 g2crowd capterra trustpilot trustradius getapp softwareadvice sourceforge producthunt gartner forrester idc crunchbase glassdoor " +
    "techcrunch forbes wired bloomberg reuters wsj wallstreetjournal theverge venturebeat businessinsider fastcompany inc cnbc bbc cnn " +
    "nytimes newyorktimes thenewyorktimes financialtimes ft theinformation mashable engadget zdnet techradar entrepreneur fortune economist " +
    "ycombinator sequoia sequoiacapital a16z andreessenhorowitz accel indexventures tigerglobal softbank lightspeed benchmark greylock " +
    "kleinerperkins khoslaventures generalcatalyst insightpartners bessemer foundersfund techstars 500startups 500global " +
    "soc2 soc iso iso27001 gdpr hipaa pci pcidss ccpa aicpa csa fedramp"
  ).split(/\s+/),
);

const VENDOR_FIRST = new Set("google microsoft amazon aws apple facebook meta linkedin twitter slack stripe salesforce hubspot zapier atlassian shopify paypal".split(" "));

export function isVendorName(name: string): boolean {
  const n = normCompanyName(name);
  if (!n) return false;
  if (VENDORS.has(n)) return true;
  const first = cleanLine(name, 80).toLowerCase().split(/[\s-]+/)[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  return VENDOR_FIRST.has(first);
}

const word = (t: string) => String(t ?? "").slice(0, 100).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['\u2019]s$/, "");

export const isGenericWord = (t: string): boolean => GENERIC.has(word(t));
export const isAudienceWord = (t: string): boolean => AUDIENCE.has(word(t));

/** Where an unnamed company is said to be from: "an Austrian agency", "a UK retailer", "a global bank". */
const PLACE_WORDS = new Set(
  (
    "american austrian australian belgian brazilian british canadian chinese czech danish dutch emirati english european finnish french german greek " +
    "indian irish israeli italian japanese korean mexican nordic norwegian polish portuguese scandinavian scottish singaporean spanish swedish swiss " +
    "turkish welsh african asian baltic latin uk us usa eu emea apac latam dach anz mena benelux nordics " +
    "global international national regional local multinational worldwide north south east west northern southern eastern western central"
  ).split(/\s+/),
);

/** What an unnamed company is said to do: "an environmental services company", "a trade org". */
const INDUSTRY_WORDS = new Set(
  (
    "accounting adtech advertising aerospace agritech agtech apparel aviation biotech broadband chemicals cleantech climate communications consulting " +
    "consumer creative crypto cyber cybersecurity defence defense dental digital edtech electronics engineering environmental events fashion fintech " +
    "fitness foodtech freight furniture govtech hardware healthtech hrtech industrial infrastructure insurtech internet investment legaltech " +
    "lending management maritime martech medical medtech mining mobility mortgage online outsourcing packaging pharmaceutical pharmaceuticals " +
    "proptech publishing recruitment regtech research robotics semiconductor shipping staffing supply chain sustainability telecoms " +
    "telecommunications trade trading training transport transportation utilities venture wealth web wellness wholesale workforce " +
    "mobile app apps e-commerce it-services life sciences science oil gas"
  ).split(/\s+/),
);

/** How big or how well known an unnamed company is said to be: "a Fortune 500 manufacturer", "a leading provider". */
const SIZE_WORDS = new Set(
  (
    "large larger largest big bigger biggest major mid mid-size mid-sized midsize midsized medium-sized small-sized sized size tier listed private " +
    "privately held fortune ftse nasdaq nyse series seed stage early late early-stage late-stage growth-stage fast-growing scaling scale-up scaleup " +
    "established well-known famous renowned anonymous confidential undisclosed unnamed stealth billion million multi-billion multi-million dollar " +
    "unicorn publicly traded independent family-owned award-winning premier prominent"
  ).split(/\s+/),
);

/** The noun an anonymised customer is called by: "... company", "... agency", "... org". */
const DESCRIPTOR_HEAD = new Set(
  (
    "company agency org organisation organization firm provider business startup start-up scaleup scale-up retailer bank manufacturer insurer lender " +
    "consultancy distributor supplier vendor brand institution association nonprofit non-profit charity corporation enterprise client customer"
  ).split(/\s+/),
);

/** Further nouns that end a description when the page itself opens it with "A" or "An": "a logistics leader". */
const LOOSE_HEAD = new Set(
  "leader platform marketplace giant unicorn team network group chain university hospital studio publisher broker carrier operator developer maker producer reseller builder player pioneer".split(" "),
);

/** A word that describes a kind of company rather than naming one. */
export const isDescribingWord = (t: string): boolean => {
  const w = word(t);
  return !!w && (GENERIC.has(w) || PLACE_WORDS.has(w) || INDUSTRY_WORDS.has(w) || SIZE_WORDS.has(w) || DESCRIPTOR_HEAD.has(w) || /^\d+$/.test(w));
};

/** "company", "agency", "org" and the like: the noun an unnamed company is called by. */
export const isDescriptorHead = (t: string): boolean => DESCRIPTOR_HEAD.has(word(t));

/**
 * Is this a description standing in for a name the page chose not to give?
 *
 * "Environmental Services Company", "Austrian Agency", "Polish Trade Org": a noun meaning
 * "a company" with nothing around it but words for where it is, what it does or how big it
 * is. And anything the page itself introduces with "A" or "An" ("A Pharmadata Company").
 * "Allica Bank" and "Ford Motor Company" are names: a word in them describes nothing.
 */
export function isDescriptorName(name: string, source?: string): boolean {
  const tokens = cleanLine(name, 160).split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const head = tokens[tokens.length - 1];
  if (tokens.length >= 2 && isDescriptorHead(head) && tokens.slice(0, -1).every(isDescribingWord)) return true;
  if (source) {
    const m = /^(?:an?|one)\s+(.{2,80})$/i.exec(cleanLine(source, 200));
    if (m) {
      const rest = m[1].toLowerCase();
      const shown = tokens.join(" ").toLowerCase();
      const named = rest === shown || rest.startsWith(`${shown} `) || rest.startsWith(`${shown},`);
      if (named && (isDescriptorHead(head) || LOOSE_HEAD.has(word(head)) || tokens.some(isDescribingWord))) return true;
    }
  }
  return false;
}

/**
 * A string taken from a web page as a company name, or null when it does not read as one.
 * Deliberately strict: a name that is refused costs one missed candidate, a wrong one puts
 * a company in front of a reviewer with a reason that is not true.
 */
export function cleanCompanyName(raw: unknown, maxWords = 5): string | null {
  let s = cleanLine(raw, 160);
  if (!s) return null;
  s = s
    .replace(/[\u00AE\u2122\u00A9]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'\u201C\u201D\u2018\u2019\u00AB\u00BB([{*#-]+|[\s"'\u201C\u201D\u2018\u2019\u00AB\u00BB)\]}*#,;:!?-]+$/g, "")
    .replace(/['\u2019]s$/, "")
    .trim();
  // A trailing full stop is punctuation unless it closes an abbreviation ("Inc.", "Co.").
  if (/\.$/.test(s) && !/\b(?:inc|co|corp|ltd|llc|plc|s\.a|b\.v)\.$/i.test(s)) s = s.replace(/\.+$/, "").trim();
  if (s.length < 2 || s.length > 60) return null;
  if (!/\p{L}/u.test(s)) return null;
  if (/https?:|www\.|[@<>{}\\|=\u2192\u00BB]|\.\.\.|\u2026/i.test(s)) return null;
  // "gusto.com/pay" is an address, not a name.
  if (/[\p{L}\p{N}]\.[\p{L}]{2,}[/:]/u.test(s) || /^\d{1,3}(?:\.\d{1,3}){3}/.test(s)) return null;
  if (/[.!?]\s+\p{L}/u.test(s) && !/\b(?:inc|co|corp|ltd|st|dr|mr|ms)\.\s/i.test(s)) return null;
  const tokens = s.split(" ");
  if (tokens.length > maxWords) return null;
  if (LEADING_STOP.has(word(tokens[0]))) return null;
  if (tokens.every(isGenericWord)) return null;
  if (tokens.some(isAudienceWord)) return null;
  // In a name of several words every word is capitalised, bar a few connectors ("Bank of
  // America"). A lower-case word in the middle means a phrase: "Read the story", "Globex cuts costs".
  if (tokens.length >= 2 && !tokens.every((t) => CONNECTORS.has(t.toLowerCase()) || !/^\p{Ll}/u.test(t) || /\p{Lu}/u.test(t))) return null;
  // Percentages and counts belong to headlines ("40% faster"), not names.
  if (/\d\s?%|\b\d+x\b/i.test(s)) return null;
  return s;
}

/** Nouns that say what kind of company follows: "Space Insurer Charter Space", "... Developer NexThera". */
const KIND_NOUN = new Set("insurer developer startup start-up maker provider firm company unicorn lender manufacturer retailer operator producer supplier vendor".split(" "));
const SECTOR_TECH = /^(?:insur|fin|health|med|ed|prop|legal|reg|agri|ag|food|clean|climate|bio|deep|mar|ad|hr|gov|space|defen[cs]e)-?tech$/i;
/** "Basketball League", "Trade Council": a body, not a company that raises a round. */
const BODY_NOUN = new Set("league federation council committee ministry department authority commission government association".split(" "));

/**
 * A company's name without the description a headline puts in front of it: "Nine-person
 * Halluminate" is Halluminate, "Insurtech Outmarket" is Outmarket, "Space Insurer Charter
 * Space" is Charter Space, "Korea's Dental Robotics" is - nobody: once the description is
 * gone nothing that names a company is left, and null says so.
 */
export function stripDescriptorPrefix(name: string): string | null {
  let tokens = cleanLine(name, 160).split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && /['\u2019]s$/.test(tokens[0])) tokens = tokens.slice(1);
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (KIND_NOUN.has(word(tokens[i]))) {
      tokens = tokens.slice(i + 1);
      break;
    }
  }
  while (tokens.length > 1 && (/^(?:\d+|[a-z]+)-(?:person|people|employee|member|year-old|month-old)$/i.test(tokens[0]) || SECTOR_TECH.test(tokens[0]))) tokens = tokens.slice(1);
  if (!tokens.length || tokens.every(isDescribingWord)) return null;
  if (tokens.length <= 2 && BODY_NOUN.has(word(tokens[tokens.length - 1]))) return null;
  return tokens.join(" ");
}

/** `globex-corp` as a readable name. Casing is a guess, so callers prefer a name the page spells out. */
export function slugToName(slug: string): string {
  return cleanLine(slug, 80)
    .split(/[-_.+\s]+/)
    .filter(Boolean)
    .map((t) => (/^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t))
    .join(" ");
}

/** Is this candidate the company whose page we are reading (its name, its domain, or its name plus a product word)? */
export function isSameCompany(name: string, other: { name?: string; domain?: string }): boolean {
  const n = normCompanyName(name);
  if (!n) return false;
  const o = normCompanyName(other.name ?? "");
  const label = other.domain ? rootDomain(other.domain.slice(0, 300).toLowerCase().replace(/^www\./, "")).split(".")[0].replace(/[^a-z0-9]/g, "") : "";
  if (o && (n === o || (o.length >= 4 && (n.startsWith(o) || n.endsWith(o))))) return true;
  if (label && (n === label || (label.length >= 5 && (n.startsWith(label) || n.endsWith(label))))) return true;
  return false;
}

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const article = (noun: string): string => (/^(?:[aeiou]|hr\b|mba\b|sdr\b|sre\b|seo\b|sql\b|ml\b|nlp\b|rn\b)/i.test(noun.trim()) && !/^(?:uni|use|user|ux\b|ui\b|eu)/i.test(noun.trim()) ? "an" : "a");

/* ───────────────────────────────── findings ───────────────────────────────── */

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 100) / 100)) : 0);

/**
 * The single place a finding is finalised: the reason goes through the sentence sanitiser,
 * every text field is cleaned and capped, the evidence URL must be an absolute http(s) URL,
 * and the confidence is clamped. Returns null when there is no reason left to show.
 */
export function finishFinding(f: PlayFinding): PlayFinding | null {
  const relevantBecause = safeSentence(f.relevantBecause, 300);
  if (!relevantBecause) return null;
  const text = (v: unknown, max: number) => cleanLine(v, max) || undefined;
  const quote = typeof f.evidenceQuote === "string" ? f.evidenceQuote.slice(0, 4000).replace(/\s+/g, " ").trim().slice(0, 500).trim() : "";
  const when = f.signalAt instanceof Date && Number.isFinite(f.signalAt.getTime()) ? f.signalAt : undefined;
  // Identifiers are kept only in their canonical form: a LinkedIn URL on linkedin.com, an email that is one, a public domain.
  const linkedin = typeof f.linkedinUrl === "string" ? normalizeLinkedinUrl(f.linkedinUrl.slice(0, 500)) : null;
  const rawEmail = typeof f.email === "string" ? f.email.trim().toLowerCase() : "";
  const email = rawEmail.length <= 254 && /^[^\s@<>"',;]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(rawEmail) ? rawEmail : "";
  const domain = typeof f.companyDomain === "string" ? extractDomain(f.companyDomain.trim().slice(0, 300)) : null;
  const out: PlayFinding = {
    kind: f.kind,
    fullName: text(f.fullName, 160),
    firstName: text(f.firstName, 80),
    lastName: text(f.lastName, 80),
    title: text(f.title, 200),
    linkedinUrl: linkedin ?? undefined,
    email: email || undefined,
    location: text(f.location, 160),
    companyName: text(f.companyName, 160),
    companyDomain: domain && isPublicHost(domain) ? domain : undefined,
    relevantBecause,
    evidenceUrl: safeHttpUrl(f.evidenceUrl),
    evidenceTitle: text(f.evidenceTitle, 200),
    evidenceQuote: quote || undefined,
    signalType: f.signalType,
    signalAt: when,
    confidence: clamp01(f.confidence),
  };
  for (const k of Object.keys(out) as (keyof PlayFinding)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Best first, one per candidate, at most `limit`. */
export function rankFindings(findings: PlayFinding[], limit: number): PlayFinding[] {
  const best = new Map<string, PlayFinding>();
  for (const f of findings) {
    const k = playDedupeKey(f);
    const have = best.get(k);
    if (!have || f.confidence > have.confidence) best.set(k, f);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

/* ───────────────────────────────── robots.txt ───────────────────────────────── */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

const NO_RULES: RobotsRules = { allow: [], disallow: [] };
/** The name this crawler answers to in a robots.txt group: the product token of the user-agent it sends. */
const ROBOTS_AGENT = CRAWLER_TOKEN.toLowerCase();

/** "ScoutBot/1.0" and "scoutbot" name the same crawler: a product token is letters, digits, "_" and "-", and what follows it is a version. */
const productToken = (value: string): string => /^[a-z0-9_-]*/.exec(value.toLowerCase())?.[0] ?? "";

/**
 * The rules of a robots.txt that apply to us: the groups that name this crawler by its
 * product token (in any case, with or without a version) when there are any, otherwise
 * the groups for `*`. Anything unreadable means no rules.
 */
export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").slice(0, 500_000).split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value === "*" ? "*" : productToken(value));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow" && value) current.disallow.push(value.slice(0, 500));
    else if (field === "allow" && value) current.allow.push(value.slice(0, 500));
  }
  const us = productToken(agent);
  const named = us ? groups.filter((g) => g.agents.includes(us)) : [];
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  return { allow: chosen.flatMap((g) => g.allow).slice(0, 2000), disallow: chosen.flatMap((g) => g.disallow).slice(0, 2000) };
}

/**
 * Does a robots.txt pattern match the start of a path? `*` stands for any run of
 * characters and a final `$` for the end of the path. Matched by hand, one character at a
 * time with a single place to go back to, so a pattern full of `*` costs at most its
 * length times the path's - a regular expression built from it could take forever.
 * `steps` counts the work and is shared by a whole check.
 */
function robotsMatch(pattern: string, path: string, steps: { left: number }): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  for (;;) {
    if (--steps.left < 0) return false;
    if (pi === p.length) {
      if (!anchored || si === path.length) return true;
    } else if (p[pi] === "*") {
      star = pi++;
      mark = si;
      continue;
    } else if (si < path.length && p[pi] === path[si]) {
      pi++;
      si++;
      continue;
    }
    // No match this way: let the last `*` take one more character and try again from there.
    if (star < 0 || mark >= path.length) return false;
    pi = star + 1;
    si = ++mark;
  }
}

/** The work one check of a path may take. A real robots.txt needs a few thousand steps. */
const MAX_ROBOTS_STEPS = 400_000;

/**
 * May this path be opened? The longest matching rule decides; a tie goes to "allow". A
 * file so tangled that it cannot be checked within the allowance closes the path: when
 * in doubt, a page is not opened.
 */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  const path = (pathAndQuery || "/").slice(0, 2000);
  const steps = { left: MAX_ROBOTS_STEPS };
  let best = -1;
  let allowed = true;
  const consider = (patterns: string[], verdict: boolean): void => {
    for (const p of patterns) {
      if (p.length < best || (p.length === best && !verdict)) continue;
      if (robotsMatch(p, path, steps)) {
        best = p.length;
        allowed = verdict;
      }
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return steps.left < 0 ? false : allowed;
}

/* ───────────────────────────────── the run ───────────────────────────────── */

export type PageResult =
  | { ok: true; url: string; body: string }
  | { ok: false; kind: "refused" | "missing" | "failed" | "deadline" | "budget"; why: string };

export interface FetchPageOptions {
  /** Wire requests this call may make at most (redirect hops and a robots.txt count). */
  maxRequests?: number;
  /** The body is a sitemap, read as text and never parsed as a page: it is kept whole and not checked as a page is. */
  sitemap?: boolean;
  /** False for a constant API endpoint that is built to be called. Default true. */
  robots?: boolean;
  /** Accept a JSON body (an API) instead of a page. */
  json?: boolean;
  /**
   * False when reading a host's robots.txt is not to be taken out of `maxRequests`: for a
   * call given a handful of requests to open one page, where the rules of the hosts on the
   * way would otherwise use them up before the page is reached. The reads still happen, are
   * still paced and still count as requests of the run. Default true.
   */
  robotsCharged?: boolean;
}

/** robots.txt requests one call may make when they are not taken out of its allowance: the page's host and the hosts it is sent on to. */
const MAX_UNCHARGED_ROBOTS = 4;

const NO_SEARCH_SOURCE = "No search source is connected on our side, so this run could not search. This is not a result about your market.";
const EVERY_SEARCH_FAILED = "Every search failed, so nothing could be checked this time. This is not a result about your market - try again later.";
const KEYLESS_SEARCH = new Set(["duckduckgo", "bing_html"]);

/** A run that was given no deadline still ends. */
const DEFAULT_RUN_MS = 240_000;
/** One search never holds a run longer than this, whatever the sources behind it do. */
const SEARCH_WAIT_MS = 12_000;
/** No search is started with less time left than one search can need. */
const MIN_SEARCH_MS = 4_000;
const MAX_HOPS = 5;

/**
 * The pause between two requests to the same host, in milliseconds.
 *
 * PLAYS_HOST_PAUSE_MS is the operator's knob for it: an environment variable, read when a
 * run starts, so changing it takes effect on the next run without a deploy of new code.
 *  - Unset, empty or not a number: 300 (at most about three requests a second to one site).
 *  - A number: used as given, kept between 0 and 5000 and rounded down to a whole number.
 *  - Raise it (1000 or more) when sites answer 429 or complain about being crawled; runs
 *    that read many pages of one site take that much longer per page, inside the same
 *    time limit, so fewer pages may be read.
 *  - 0 removes the pause (requests to one host still go out one at a time, never in
 *    parallel). Meant for tests, where the web exists only in memory; not for production.
 * It paces page and robots.txt requests of plays only - searches and other crawlers have
 * their own limits.
 */
export function hostPauseMs(): number {
  const raw = process.env.PLAYS_HOST_PAUSE_MS;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(5_000, Math.max(0, Math.floor(n))) : 300;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The note for a page that was fetched but not read because of how it is built. */
function unreadableNote(url: string): string {
  return `A page on ${hostOf(url) || "a site"} is built in a way that cannot be read quickly (far too many or too deeply nested elements), so it was skipped.`;
}

/** Is this body going to be parsed as a web page? (As opposed to a sitemap or a text file.) */
function isHtmlBody(type: string, body: string): boolean {
  if (/html/i.test(type)) return true;
  if (/xml|json|plain/i.test(type)) return false;
  return !/^\s*<\?xml/i.test(body.slice(0, 200));
}

/** A page that answered 200 with a login wall or a bot check instead of its content. */
function wallOn(body: string, requested: URL, finalUrl: string): string | null {
  const head = body.slice(0, 6000);
  let finalPath = "";
  try {
    finalPath = new URL(finalUrl).pathname;
  } catch {
    finalPath = "";
  }
  const gate = /\/(authwall|login|signin|sign-in|sso|checkpoint|uas\/login)(\/|$)/i;
  if (gate.test(finalPath) && !gate.test(requested.pathname)) return "asked for a login";
  if (/authwall/i.test(head) && /linkedin/i.test(head)) return "asked for a login";
  const title = /<title[^>]*>([^<]{0,160})/i.exec(head)?.[1]?.trim() ?? "";
  if (/^(just a moment|attention required|access denied|are you a robot|robot check|security check|pardon our interruption|verify (you are|that you are|you're) (a )?human|please verify|one more step|human verification)/i.test(title)) return "showed a bot check";
  if (/cf_chl_|challenge-platform\/|cf-browser-verification|captcha-delivery\.com|px-captcha|_Incapsula_Resource|datadome/i.test(head)) return "showed a bot check";
  return null;
}

/**
 * One engine run: counts what was tried, remembers what each search said, paces and
 * polices every page request, and at the end decides whether anything was looked at at all.
 */
export class PlayRun {
  readonly trace: PlayRunTrace = emptyTrace();
  /** Requests actually sent for pages: redirect hops and robots.txt included. */
  requests = 0;
  private readonly outcomes: WebSearchOutcome[] = [];
  private readonly direct = new WeakSet<WebSearchOutcome>();
  private readonly deadline: number;
  private readonly pause: number;
  private readonly hostQueue = new Map<string, Promise<void>>();
  private readonly hostLastDone = new Map<string, number>();
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private pagesFailed = 0;
  private sitesIgnored = 0;
  private aiStopped = false;
  private stoppedForTime = false;

  constructor(readonly opts: PlayEngineOptions) {
    this.deadline = typeof opts.deadlineAt === "number" && Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Date.now() + DEFAULT_RUN_MS;
    this.pause = hostPauseMs();
  }

  private outOfTime(): void {
    if (!this.stoppedForTime) {
      this.stoppedForTime = true;
      this.note("The run reached its time limit and stopped early. What was found before that is kept.");
    }
  }

  /** No new work is started once the deadline has passed. */
  get expired(): boolean {
    const over = Date.now() >= this.deadline;
    if (over) this.outOfTime();
    return over;
  }

  /** Is there time left for one more search? A search is not started when the answer is no. */
  get canSearch(): boolean {
    const ok = this.deadline - Date.now() >= MIN_SEARCH_MS;
    if (!ok) this.outOfTime();
    return ok;
  }

  note(sentence: string): void {
    const s = cleanLine(sentence, MAX_NOTE);
    if (s && !this.trace.notes.includes(s) && this.trace.notes.length < MAX_NOTES) this.trace.notes.push(s);
  }

  /**
   * Feed for `onOutcome` of helpers that run their own searches (domain resolution, people
   * search), and for `search` below.
   *
   * A `site:` search that came back empty because the engine ignored the site and everything
   * it sent was discarded did not search that site at all: it is counted as a search that
   * failed, so a run made of such searches says "could not search", not "found nobody".
   */
  readonly recordOutcome = (o: WebSearchOutcome, query?: string): void => {
    const ignoredSite = typeof query === "string" && /(?:^|\s)site:\S/i.test(query) && !o.everyProviderFailed && !(o.results?.length > 0) && (o.attempts ?? []).some((a) => (a.offSite ?? 0) > 0);
    if (ignoredSite) this.sitesIgnored++;
    const seen = ignoredSite ? { ...o, everyProviderFailed: true } : o;
    this.outcomes.push(seen);
    this.trace.searches++;
    if (seen.everyProviderFailed) this.trace.failedSearches++;
  };

  /** True once at least one search got an answer from some provider (even an empty one). */
  get searchAnswered(): boolean {
    return this.outcomes.some((o) => !o.everyProviderFailed);
  }

  get searchesRun(): number {
    return this.outcomes.length;
  }

  /** Count something that is a search in all but name (a public search API), and whether it answered. */
  countSearch(answered: boolean): void {
    const o: WebSearchOutcome = { results: [], attempts: [], everyProviderFailed: !answered, nothingConfigured: false };
    // Not a web search: it says nothing about which web search sources are connected.
    this.direct.add(o);
    this.recordOutcome(o);
  }

  /** The web searches among the outcomes (a public search API asked directly is not one). */
  private get webOutcomes(): WebSearchOutcome[] {
    return this.outcomes.filter((o) => !this.direct.has(o));
  }

  /**
   * Wait for a piece of work, but not past the deadline (or `capMs`, when that is sooner).
   * Work still running then is abandoned (its own timeouts end it) and null is returned, so
   * a slow search, page or model cannot hold a run beyond the time it was given.
   */
  async within<T>(work: Promise<T>, capMs?: number): Promise<T | null> {
    const toDeadline = this.deadline - Date.now();
    if (toDeadline <= 0) {
      work.catch(() => {});
      this.outOfTime();
      return null;
    }
    const capped = capMs !== undefined && capMs < toDeadline;
    const left = capped ? Math.max(1, capMs) : toDeadline;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        work.catch(() => {});
        if (!capped) this.outOfTime();
        resolve(null);
      }, left);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private get onlyKeylessSearch(): boolean {
    const providers = this.opts.searchOpts?.providers ?? defaultProviders();
    return !providers.some((p) => !KEYLESS_SEARCH.has(p.name) && p.available());
  }

  /** One web search. Never throws; a failure is counted and returns nothing. */
  async search(query: string, count = 20): Promise<SearchResult[]> {
    if (this.expired || !this.canSearch) return [];
    const outer = this.opts.searchOpts?.onOutcome;
    let recorded = false;
    try {
      const work = webSearchDetailed(query, {
        count,
        ...(this.opts.country ? { country: this.opts.country } : {}),
        ...(this.opts.searchOpts ?? {}),
        onOutcome: (o, q) => {
          recorded = true;
          this.recordOutcome(o, q);
          try {
            outer?.(o, q);
          } catch {
            // an observer never breaks the search it is watching
          }
        },
      });
      const started = Date.now();
      const o = await this.within(work, SEARCH_WAIT_MS);
      if (!o) {
        // Abandoned at the deadline: neither an answer nor a failure of the search source.
        // Abandoned for taking too long: a search that did not answer.
        if (!recorded && Date.now() - started >= SEARCH_WAIT_MS - 50 && Date.now() < this.deadline) {
          recorded = true;
          this.recordOutcome({ results: [], attempts: [], everyProviderFailed: true, nothingConfigured: this.onlyKeylessSearch });
        }
        return [];
      }
      return Array.isArray(o.results) ? o.results : [];
    } catch {
      if (!recorded) this.recordOutcome({ results: [], attempts: [], everyProviderFailed: true, nothingConfigured: false });
      return [];
    }
  }

  /**
   * One request on the wire: after the requests before it to the same host have finished,
   * and after a pause, so a site is never asked for two things at once or in a burst.
   */
  private async wire(target: URL, sent?: () => void): Promise<Response | null | "deadline"> {
    const host = target.host.toLowerCase();
    const before = this.hostQueue.get(host) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hostQueue.set(
      host,
      before.then(() => mine),
    );
    await before;
    try {
      const last = this.hostLastDone.get(host);
      if (last !== undefined && this.pause > 0) {
        const wait = last + this.pause - Date.now();
        if (wait > 0) {
          if (Date.now() + wait >= this.deadline) {
            this.outOfTime();
            return "deadline";
          }
          await sleep(Math.min(wait, this.pause));
        }
      }
      if (this.expired) return "deadline";
      this.requests++;
      sent?.();
      const remaining = this.deadline - Date.now();
      try {
        return await fetchPublic(target.href, { publicOnly: true, allowPrivateHosts: this.opts.allowPrivateHosts === true, timeoutMs: Math.max(1_000, Math.min(PAGE_TIMEOUT_MS, remaining)), maxBytes: MAX_PAGE_BYTES, maxRedirects: 0 });
      } finally {
        this.hostLastDone.set(host, Date.now());
      }
    } finally {
      release();
    }
  }

  /**
   * GET a URL, following redirects by hand: every hop is a request that is paced, counted
   * and checked. A hop that would leave https for plain http is not followed - the https
   * form of the same address is asked for instead.
   */
  private async get(start: URL, budget: () => number, sent: () => void, allowed?: (u: URL) => Promise<boolean>): Promise<{ res: Response; url: URL } | { stop: "refused" | "failed" | "deadline" | "budget" | "robots"; url?: URL }> {
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (budget() <= 0) return { stop: "budget" };
      // Every address is checked against its own host's robots.txt before it is asked for - the first and each hop.
      if (allowed && !(await allowed(current))) return { stop: "robots", url: current };
      if (this.expired) return { stop: "deadline" };
      if (budget() <= 0) return { stop: "budget" };
      let res: Response | null | "deadline";
      try {
        res = await this.wire(current, sent);
      } catch {
        return { stop: "failed" };
      }
      if (res === "deadline") return { stop: "deadline" };
      if (!res) return { stop: "refused" };
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return { res, url: current };
      await res.body?.cancel().catch(() => {});
      let next: URL | null;
      try {
        next = parseHttpUrl(new URL(location, current).toString());
      } catch {
        next = null;
      }
      if (!next) return { stop: "refused" };
      if (current.protocol === "https:" && next.protocol === "http:") {
        next.protocol = "https:";
        if (next.port === "80") next.port = "";
      }
      if (next.toString() === current.toString()) return { stop: "failed" };
      current = next;
    }
    return { stop: "failed" };
  }

  /** The robots.txt rules of a host, read once per run. Anything but a readable file means no rules. */
  private rulesFor(target: URL, budget: () => number, sent: () => void): Promise<RobotsRules> {
    const key = target.host.toLowerCase();
    const known = this.robots.get(key);
    if (known) return known;
    // Declared first: the work below refers to its own promise (after its first await).
    let loading!: Promise<RobotsRules>;
    loading = (async (): Promise<RobotsRules> => {
      let start: URL;
      try {
        start = new URL("/robots.txt", target.origin);
      } catch {
        return NO_RULES;
      }
      const got = await this.get(start, budget, sent);
      if ("stop" in got) {
        // Out of budget or time before it could be read: not remembered, so it is asked again later.
        if (got.stop === "budget" || got.stop === "deadline") this.robots.delete(key);
        return NO_RULES;
      }
      // Where the file really lives shares its rules, so that host is not asked again.
      const landed = got.url.host.toLowerCase();
      if (landed !== key && !this.robots.has(landed)) this.robots.set(landed, loading);
      if (!got.res.ok || !/text|plain/i.test(got.res.headers.get("content-type") ?? "text/plain")) {
        await got.res.body?.cancel().catch(() => {});
        return NO_RULES;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(await readCapped(got.res, 500_000));
        // An HTML page served for /robots.txt is not a robots file.
        return /^\s*</.test(text) ? NO_RULES : parseRobots(text);
      } catch {
        return NO_RULES;
      }
    })();
    this.robots.set(key, loading);
    return loading;
  }

  /**
   * Fetch one page that a customer named or another page linked to.
   *
   * Always through the public-only fetcher: a private, loopback or internal address is
   * refused before any request, and again on every redirect hop. The host's robots.txt is
   * read once and obeyed. Requests to one host go out one at a time with a pause between
   * them. A refusal (a 401/403/429/451/999, a login wall, a bot check, a file that is not a
   * page, a path robots.txt closes) is counted, noted and never retried.
   */
  async fetchPage(url: string, o: FetchPageOptions = {}): Promise<PageResult> {
    const target = parseHttpUrl(url);
    const shown = target ? target.hostname.replace(/^www\./, "") : cleanLine(url, 80);
    if (!target) {
      this.trace.pagesRefused++;
      this.note(`${shown || "An address"} is not a web address, so it was not fetched.`);
      return { ok: false, kind: "refused", why: "not a web address" };
    }
    if (this.opts.allowPrivateHosts !== true && !isPublicHost(target.href)) {
      this.trace.pagesRefused++;
      this.note(`${shown} is not a public web address, so it was not fetched.`);
      return { ok: false, kind: "refused", why: "not a public web address" };
    }
    if (this.expired) return { ok: false, kind: "deadline", why: "time limit" };
    // What this one call has sent: its own hops and a robots.txt it had to fetch. (Other pages being fetched at the same time have their own count.)
    let used = 0;
    const sent = (): void => {
      used++;
    };
    const budget = (): number => (o.maxRequests === undefined ? MAX_HOPS + 2 : o.maxRequests) - used;
    if (budget() <= 0) return { ok: false, kind: "budget", why: "request limit" };

    // Reads of robots.txt: out of this call's allowance, or - when the caller says so - out of a small one of their own.
    let rulesRead = 0;
    const rulesBudget = o.robotsCharged === false ? (): number => MAX_UNCHARGED_ROBOTS - rulesRead : budget;
    const rulesSent =
      o.robotsCharged === false
        ? (): void => {
            rulesRead++;
          }
        : sent;
    const allowed =
      o.robots === false
        ? undefined
        : async (u: URL): Promise<boolean> => robotsAllows(await this.rulesFor(u, rulesBudget, rulesSent), `${u.pathname}${u.search}`);
    const got = await this.get(target, budget, sent, allowed);
    if ("stop" in got) {
      if (got.stop === "deadline") return { ok: false, kind: "deadline", why: "time limit" };
      if (got.stop === "budget") return { ok: false, kind: "budget", why: "request limit" };
      if (got.stop === "robots") {
        const closed = (got.url ?? target).hostname.replace(/^www\./, "");
        this.trace.pagesRefused++;
        this.note(`${closed} asks automated readers not to open some of its pages (robots.txt), so those were skipped.`);
        return { ok: false, kind: "refused", why: "robots.txt" };
      }
      if (got.stop === "refused") {
        this.trace.pagesRefused++;
        this.note(`${shown} did not lead to a public web address, so it was not read.`);
        return { ok: false, kind: "refused", why: "not a public web address" };
      }
      this.pagesFailed++;
      return { ok: false, kind: "failed", why: "unreachable" };
    }
    const { res } = got;
    const finalUrl = got.url.toString();
    const status = res.status;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (status === 404 || status === 410) return { ok: false, kind: "missing", why: `status ${status}` };
      if ([401, 402, 403, 407, 429, 451, 999].includes(status)) {
        this.trace.pagesRefused++;
        this.note(`${shown} refused to show a page (it answered ${status}). It was not retried.`);
        return { ok: false, kind: "refused", why: `status ${status}` };
      }
      this.pagesFailed++;
      return { ok: false, kind: "failed", why: `status ${status}` };
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !(o.json ? /json/i : /html|xml|text\/plain/i).test(type)) {
      await res.body?.cancel().catch(() => {});
      this.trace.pagesRefused++;
      this.note(`A link on ${shown} led to a file that is not a web page, so it was skipped.`);
      return { ok: false, kind: "refused", why: "not a web page" };
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: false }).decode(await readCapped(res, MAX_PAGE_BYTES));
    } catch {
      this.pagesFailed++;
      return { ok: false, kind: "failed", why: "unreadable" };
    }
    if (!o.json) {
      const wall = wallOn(body, target, finalUrl);
      if (wall) {
        this.trace.pagesRefused++;
        this.note(`${shown} ${wall} instead of the page, so it was not read. It was not retried.`);
        return { ok: false, kind: "refused", why: wall };
      }
      if (!o.sitemap && isHtmlBody(type, body)) {
        // What a parser would be given, checked in one pass before any parser sees it (see util/html.ts).
        body = fitHtml(body, MAX_PAGE_CHARS);
        if (unreadableHtml(body)) {
          this.trace.pagesRefused++;
          this.note(unreadableNote(finalUrl));
          return { ok: false, kind: "refused", why: "unreadable page" };
        }
      }
      this.trace.pagesFetched++;
    }
    return { ok: true, url: finalUrl, body };
  }

  /**
   * Ask a public, keyless JSON API on a constant host (built to be called, so robots.txt
   * does not apply). Paced like any other host. Returns the parsed body, or null.
   */
  async fetchApi<T>(url: string): Promise<T | null> {
    const page = await this.fetchPage(url, { robots: false, json: true, maxRequests: 2 });
    if (!page.ok) return null;
    try {
      return JSON.parse(page.body) as T;
    } catch {
      return null;
    }
  }

  /** A page that was fetched but turned out not to be usable (a redirect to another site). */
  discardFetched(): void {
    if (this.trace.pagesFetched > 0) this.trace.pagesFetched--;
    this.trace.pagesRefused++;
  }

  /**
   * A page that was fetched and then refused by the parser's own limits (see util/html.ts):
   * counted as refused, with the same note `fetchPage` writes when it refuses one itself.
   */
  unreadable(url: string): void {
    this.discardFetched();
    this.note(unreadableNote(url));
  }

  /** Is a model available for the next call? Absent, the "none" provider, or stopped: no. */
  get aiUsable(): boolean {
    const ai = this.opts.ai;
    return !!ai && hasAi(ai) && !this.aiStopped;
  }

  /**
   * One model call returning JSON, or null. `beforeAiCall` is asked first; a "no" (or a
   * throw) ends model use for the rest of the run. A call is counted only when it is made.
   */
  async askJson<T extends object>(messages: AiMessage[], o: { maxTokens?: number } = {}): Promise<T | null> {
    const ai = this.opts.ai;
    if (!ai || !this.aiUsable || this.expired) return null;
    if (this.opts.beforeAiCall) {
      let go = false;
      try {
        go = (await this.opts.beforeAiCall()) === true;
      } catch {
        go = false;
      }
      if (!go) {
        this.aiStopped = true;
        this.note("AI checks were not used for the rest of this run because the allowance for them is used up. Rules were used instead.");
        return null;
      }
    }
    this.trace.aiCalls++;
    try {
      const res = await this.within(completeJson<T>(ai, messages, { maxTokens: o.maxTokens ?? 700, temperature: 0 }));
      return res && typeof res === "object" ? res : null;
    } catch {
      this.note("An AI check did not answer and was skipped. Rules were used instead.");
      return null;
    }
  }

  /** Mark the run as unable to look at anything, with the sentence a customer reads. */
  block(reason: string): void {
    this.trace.blocked = true;
    this.trace.blockedReason = cleanLine(reason, MAX_NOTE);
  }

  /** Why searching produced nothing to look at, or null when at least one search answered or none ran. */
  get searchFailure(): string | null {
    if (!this.outcomes.length || this.searchAnswered) return null;
    const web = this.webOutcomes;
    return web.length && web.every((o) => o.nothingConfigured) ? NO_SEARCH_SOURCE : EVERY_SEARCH_FAILED;
  }

  /**
   * Close the run. `examined` is the engine's own answer to "did we get to look at
   * anything?"; when it is false the run is blocked and says why, so an empty result is
   * never mistaken for a finding about the market.
   */
  finish(examined: boolean, fallbackReason: string): PlayRunTrace {
    if (!this.trace.blocked && !examined) {
      const parts = [this.trace.pagesRefused > 0 ? `${this.trace.pagesRefused} refused or not public` : "", this.pagesFailed > 0 ? `${this.pagesFailed} unreachable` : ""].filter(Boolean);
      const pagesSentence = parts.length && this.trace.pagesFetched === 0 ? `None of the pages could be read (${parts.join(", ")}), so nothing could be checked.` : null;
      const timeSentence = this.stoppedForTime ? "The run reached its time limit before anything could be checked. This is not a result about your market." : null;
      this.block(this.searchFailure ?? pagesSentence ?? timeSentence ?? fallbackReason);
    } else if (!this.trace.blocked && this.webOutcomes.length && this.webOutcomes.every((o) => o.nothingConfigured)) {
      this.note("No dependable search source is connected on our side, so these results come from a fallback search and may be thin.");
    }
    if (!this.trace.blocked && this.sitesIgnored > 0) {
      this.note(`${this.sitesIgnored} of ${this.trace.searches} searches were meant for one site each, but the search source in use ignored that and its results had to be discarded. Those sites were not searched.`);
    }
    const otherFailures = this.trace.failedSearches - this.sitesIgnored;
    if (!this.trace.blocked && otherFailures > 0) {
      this.note(`${otherFailures} of ${this.trace.searches} searches did not get an answer, so some results may be missing.`);
    }
    return this.trace;
  }
}
