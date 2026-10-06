/**
 * What every play engine shares and nothing outside this folder should need: the run
 * bookkeeping (searches, page fetches, model calls, notes, the "could not look" verdict)
 * and the rules for what may be called a company name.
 */
import type { AiMessage, SearchResult } from "../types.js";
import { completeJson, hasAi } from "../ai/provider.js";
import { webSearchDetailed, type WebSearchOutcome } from "../search/index.js";
import { fetchPublic, readCapped } from "../util/http.js";
import { extractDomain, normalizeLinkedinUrl, rootDomain } from "../util/domain.js";
import { isPublicHost, parseHttpUrl } from "../util/publicHost.js";
import type { PlayEngineOptions, PlayFinding, PlayRunTrace } from "./types.js";
import { cleanLine, emptyTrace, normCompanyName, playDedupeKey, safeSentence } from "./util.js";

export const DEFAULT_LIMIT = 40;
export const HARD_LIMIT = 200;
/** One page fetch never waits longer than this. */
export const PAGE_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 1_500_000;
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
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Same site in the sense that matters for following a link: the same registrable domain. */
export const sameSite = (url: string, domain: string): boolean => {
  const h = hostOf(url);
  return !!h && rootDomain(h) === rootDomain(domain.toLowerCase().replace(/^www\./, ""));
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
    "marketplace plans help search careers jobs store shop cart checkout demo tour quiz survey form contact-us about-us wins results impact"
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

const word = (t: string) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['\u2019]s$/, "");

export const isGenericWord = (t: string): boolean => GENERIC.has(word(t));
export const isAudienceWord = (t: string): boolean => AUDIENCE.has(word(t));

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
  const label = other.domain ? rootDomain(other.domain.toLowerCase().replace(/^www\./, "")).split(".")[0].replace(/[^a-z0-9]/g, "") : "";
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
  const quote = typeof f.evidenceQuote === "string" ? f.evidenceQuote.replace(/\s+/g, " ").trim().slice(0, 500).trim() : "";
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

/* ───────────────────────────────── the run ───────────────────────────────── */

export type PageResult =
  | { ok: true; url: string; body: string }
  | { ok: false; kind: "refused" | "missing" | "failed" | "deadline"; why: string };

const NO_SEARCH_SOURCE = "No search source is connected on our side, so this run could not search. This is not a result about your market.";
const EVERY_SEARCH_FAILED = "Every search failed, so nothing could be checked this time. This is not a result about your market - try again later.";

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
 * One engine run: counts what was tried, remembers what each search said, and at the end
 * decides whether anything was looked at at all.
 */
export class PlayRun {
  readonly trace: PlayRunTrace = emptyTrace();
  private readonly outcomes: WebSearchOutcome[] = [];
  private pagesFailed = 0;
  private aiStopped = false;
  private stoppedForTime = false;

  constructor(readonly opts: PlayEngineOptions) {}

  /** No new work is started once the deadline has passed. */
  get expired(): boolean {
    const over = this.opts.deadlineAt !== undefined && Date.now() >= this.opts.deadlineAt;
    if (over && !this.stoppedForTime) {
      this.stoppedForTime = true;
      this.note("The run reached its time limit and stopped early. What was found before that is kept.");
    }
    return over;
  }

  note(sentence: string): void {
    const s = cleanLine(sentence, MAX_NOTE);
    if (s && !this.trace.notes.includes(s) && this.trace.notes.length < MAX_NOTES) this.trace.notes.push(s);
  }

  /** Feed for `onOutcome` of helpers that run their own searches (domain resolution, people search). */
  readonly recordOutcome = (o: WebSearchOutcome): void => {
    this.outcomes.push(o);
    this.trace.searches++;
    if (o.everyProviderFailed) this.trace.failedSearches++;
  };

  /** True once at least one search got an answer from some provider (even an empty one). */
  get searchAnswered(): boolean {
    return this.outcomes.some((o) => !o.everyProviderFailed);
  }

  get searchesRun(): number {
    return this.outcomes.length;
  }

  /**
   * Wait for a piece of work, but not past the deadline. Work that is still running when
   * the deadline passes is abandoned (its own timeouts end it) and null is returned, so a
   * slow search, page or model cannot hold a run beyond the time it was given.
   */
  async within<T>(work: Promise<T>): Promise<T | null> {
    const at = this.opts.deadlineAt;
    if (at === undefined) return work;
    const left = at - Date.now();
    if (left <= 0) {
      work.catch(() => {});
      void this.expired;
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        work.catch(() => {});
        void this.expired;
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

  /** One web search. Never throws; a failure is counted and returns nothing. */
  async search(query: string, count = 20): Promise<SearchResult[]> {
    if (this.expired) return [];
    try {
      const o = await this.within(webSearchDetailed(query, { count, ...(this.opts.country ? { country: this.opts.country } : {}), ...(this.opts.searchOpts ?? {}) }));
      // Abandoned at the deadline: not an answer and not a failure of the search source.
      if (!o) return [];
      this.recordOutcome(o);
      return Array.isArray(o.results) ? o.results : [];
    } catch {
      this.recordOutcome({ results: [], attempts: [], everyProviderFailed: true, nothingConfigured: false });
      return [];
    }
  }

  /**
   * Fetch one page that a customer named or another page linked to.
   *
   * Always through the public-only fetcher: a private, loopback or internal address is
   * refused before any request, and again on every redirect hop. One request per call - a
   * refusal (a 401/403/429/451/999, a login wall, a bot check, a file that is not a page)
   * is counted, noted and never retried.
   */
  async fetchPage(url: string): Promise<PageResult> {
    const target = parseHttpUrl(url);
    const shown = target ? target.hostname.replace(/^www\./, "") : cleanLine(url, 80);
    if (!target) {
      this.trace.pagesRefused++;
      this.note(`${shown || "An address"} is not a web address, so it was not fetched.`);
      return { ok: false, kind: "refused", why: "not a web address" };
    }
    const allowPrivateHosts = this.opts.allowPrivateHosts === true;
    if (!allowPrivateHosts && !isPublicHost(target.href)) {
      this.trace.pagesRefused++;
      this.note(`${shown} is not a public web address, so it was not fetched.`);
      return { ok: false, kind: "refused", why: "not a public web address" };
    }
    if (this.expired) return { ok: false, kind: "deadline", why: "time limit" };
    const remaining = this.opts.deadlineAt !== undefined ? this.opts.deadlineAt - Date.now() : PAGE_TIMEOUT_MS;
    let res: Response | null;
    try {
      res = await fetchPublic(target.href, { publicOnly: true, allowPrivateHosts, timeoutMs: Math.max(1_000, Math.min(PAGE_TIMEOUT_MS, remaining)), maxBytes: MAX_PAGE_BYTES });
    } catch {
      this.pagesFailed++;
      return { ok: false, kind: "failed", why: "unreachable" };
    }
    if (!res) {
      this.trace.pagesRefused++;
      this.note(`${shown} did not lead to a public web address, so it was not read.`);
      return { ok: false, kind: "refused", why: "not a public web address" };
    }
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
    if (type && !/html|xml|text\/plain/i.test(type)) {
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
    const finalUrl = safeHttpUrl(res.url) ?? target.toString();
    const wall = wallOn(body, target, finalUrl);
    if (wall) {
      this.trace.pagesRefused++;
      this.note(`${shown} ${wall} instead of the page, so it was not read. It was not retried.`);
      return { ok: false, kind: "refused", why: wall };
    }
    this.trace.pagesFetched++;
    return { ok: true, url: finalUrl, body };
  }

  /** A page that was fetched but turned out not to be usable (a redirect to another site). */
  discardFetched(): void {
    if (this.trace.pagesFetched > 0) this.trace.pagesFetched--;
    this.trace.pagesRefused++;
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
    return this.outcomes.every((o) => o.nothingConfigured) ? NO_SEARCH_SOURCE : EVERY_SEARCH_FAILED;
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
    } else if (!this.trace.blocked && this.outcomes.length && this.outcomes.every((o) => o.nothingConfigured)) {
      this.note("No dependable search source is connected on our side, so these results come from a fallback search and may be thin.");
    }
    if (!this.trace.blocked && this.trace.failedSearches > 0) {
      this.note(`${this.trace.failedSearches} of ${this.trace.searches} searches did not get an answer, so some results may be missing.`);
    }
    return this.trace;
  }
}
