/**
 * Reading a competitor's own pages for the companies it names as customers. Pure: HTML in,
 * candidates out, no network.
 *
 * The rule throughout is that a wrong customer is worse than a missed one. A name is only
 * reported when the page itself presents the company as a customer - a case-study link, a
 * case-study headline, a logo under a "trusted by" style label, a testimonial's
 * attribution - and every hit carries the words from the page that say so. Navigation,
 * footers, integration and partner walls, press and investor rows, review badges and the
 * competitor's own name are never customers.
 */
import * as cheerio from "cheerio";
import { plainString } from "../ai/untrusted.js";
import { isSocialOrAggregator, rootDomain } from "../util/domain.js";
import { isPublicHost } from "../util/publicHost.js";
import { cleanCompanyName, escapeRegExp, isAudienceWord, isGenericWord, isSameCompany, isVendorName, sameSite, slugToName } from "./shared.js";
import { cleanLine, cleanQuote, normCompanyName } from "./util.js";

export type CustomerVia = "case_study" | "logo" | "testimonial" | "structured_data" | "ai";

export interface CustomerHit {
  name: string;
  /** Verbatim from the page: the headline, link text, image description or attribution that names the company. */
  quote: string;
  via: CustomerVia;
  /** The case-study headline, when that is what named the company. */
  headline?: string;
  confidence: number;
  /** Only when the page itself links the name to the company's own site. */
  domain?: string;
}

export interface CrawlLink {
  url: string;
  /** 90 a customers or case-studies index, 60 one case study under such an index, lower for looser matches. */
  score: number;
}

export interface PageExtraction {
  hits: CustomerHit[];
  links: CrawlLink[];
  /** The page's readable text without navigation and footers: what a model is shown and what its quotes are checked against. */
  text: string;
  title: string;
  /** The page lives under a customers / case-studies style path. */
  customerPage: boolean;
}

interface Node {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
  parent?: Node | null;
}

/* ───────────────────────────────── paths ───────────────────────────────── */

const CUSTOMER_SEGMENT = /^(?:our-)?(?:customers?|clients?|case-stud(?:y|ies)|casestud(?:y|ies)|customer-stor(?:y|ies)|customer-success-stor(?:y|ies)|success-stor(?:y|ies)|client-stor(?:y|ies)|stories|testimonials?|customer-spotlights?|wall-of-love)$/i;
const KEYWORD_PATH = /customer|case-?stud|stories|success|client|testimonial/i;
const NOT_CUSTOMER_PATH = /customer-(?:support|service|portal|login|care|experience|data|engagement|success-(?:team|manager|platform|software))|success-(?:plan|team|manager)|client-(?:portal|login|area|librar)|(?:^|\/)(?:blog|news|press|careers?|jobs|legal|docs?|documentation|help|support|pricing|login|signin|signup|sign-up|register|privacy|terms|webinars?|events?|podcasts?|api|developers?|changelog|status|search|cart|checkout|account|tag|tags|category|author)(?:\/|$)/i;
const FILE_EXT = /\.(?:pdf|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mov|webm|mp3|wav|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|css|js|woff2?|ttf|eot)$/i;
const NOT_A_SLUG = /^(?:page|category|categories|tag|tags|industry|industries|all|index|feed|search|filter|type|types|topic|topics|region|regions|use-cases?|solutions?|products?|features?|roles?|teams?|size|segment|segments|by-industry|by-size|by-role|video|videos|\d+)$/i;

export function isCustomerPath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).some((s) => CUSTOMER_SEGMENT.test(s));
}

/** The last path segment of one case study (`/customers/globex` gives `globex`), or null for anything else. */
export function caseSlugOf(pathname: string): string | null {
  const segs = pathname.split("/").filter(Boolean);
  let idx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (CUSTOMER_SEGMENT.test(segs[i])) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const rest = segs.slice(idx + 1);
  let slug: string | undefined;
  if (rest.length === 1) slug = rest[0];
  else if (rest.length === 2 && /^(?:stories|story|case-stud(?:y|ies)|customers?|videos?|spotlights?)$/i.test(rest[0])) slug = rest[1];
  if (!slug) return null;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  slug = slug.replace(/\.(?:html?|php|aspx?)$/i, "");
  if (!slug || slug.length > 120 || NOT_A_SLUG.test(slug)) return null;
  return slug;
}

function crawlScore(u: URL): number {
  const path = u.pathname.toLowerCase();
  if (path.length > 200 || FILE_EXT.test(path)) return 0;
  if (!KEYWORD_PATH.test(path) || NOT_CUSTOMER_PATH.test(path)) return 0;
  const segs = path.split("/").filter(Boolean);
  if (!segs.length || segs.length > 5) return 0;
  let idx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (CUSTOMER_SEGMENT.test(segs[i])) {
      idx = i;
      break;
    }
  }
  if (idx === segs.length - 1) return 90;
  if (idx >= 0 && caseSlugOf(u.pathname)) return 60;
  if (idx >= 0) return 40;
  return 30;
}

function resolveLink(href: string | undefined, base: string): URL | null {
  if (!href || href.length > 2000 || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href.trim())) return null;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/* ───────────────────────────────── text ───────────────────────────────── */

const BLOCK = new Set("address article aside blockquote br cite dd div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table td th tr ul".split(" "));
const SPACED = new Set("a button label option img svg picture".split(" "));
const MAX_TEXT = 200_000;

/** Readable text of a subtree, with line breaks between blocks so words of neighbours never run together. */
function rawText(root: Node): string {
  const out: string[] = [];
  let size = 0;
  const stack: (Node | string)[] = [root];
  while (stack.length && size < MAX_TEXT) {
    const n = stack.pop()!;
    if (typeof n === "string") {
      out.push(n);
      continue;
    }
    if (n.type === "text") {
      const d = n.data ?? "";
      size += d.length;
      out.push(d);
      continue;
    }
    if (n.type !== "tag" && n.type !== "root") continue;
    const sep = n.type === "tag" && BLOCK.has(n.name ?? "") ? "\n" : n.type === "tag" && SPACED.has(n.name ?? "") ? " " : "";
    if (sep) stack.push(sep);
    const kids = n.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (sep) out.push(sep);
  }
  return out.join("");
}

const tidyLines = (s: string): string =>
  s
    .split("\n")
    .map((l) => cleanQuote(l, 4000))
    .filter(Boolean)
    .join("\n");

/** One element's text as a single line. */
const lineOf = (n: Node, max = 300): string => cleanQuote(rawText(n).replace(/\n+/g, " "), max);

const attr = (n: Node, name: string): string => (n.attribs?.[name] ?? "").trim();
const isTag = (n: Node | null | undefined, ...names: string[]): boolean => !!n && n.type === "tag" && names.includes(n.name ?? "");
const isHeading = (n: Node): boolean => n.type === "tag" && /^h[1-6]$/.test(n.name ?? "");

function ancestors(n: Node, max = 50): Node[] {
  const out: Node[] = [];
  let p = n.parent;
  while (p && p.type === "tag" && out.length < max) {
    out.push(p);
    p = p.parent;
  }
  return out;
}

const contains = (ancestor: Node, n: Node): boolean => {
  let p: Node | null | undefined = n;
  for (let i = 0; p && i < 200; i++) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
};

function descendants(n: Node, max = 5000): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [...(n.children ?? [])].reverse();
  while (stack.length && out.length < max) {
    const c = stack.pop()!;
    if (c.type !== "tag") continue;
    out.push(c);
    const kids = c.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/* ───────────────────────────────── headlines ───────────────────────────────── */

const VERBS = new Set(
  (
    "cut cuts reduced reduces saved saves increased increases grew grows scaled scales uses used use built builds boosted boosts improved improves " +
    "achieved achieves drives drove automated automates streamlined streamlines doubled doubles tripled triples quadrupled accelerated accelerates " +
    "closed closes launched launches migrated migrates switched switches moved moves replaced replaces consolidated consolidates transformed transforms " +
    "unlocked unlocks generated generates delivers delivered manages managed powers powered runs ran got gets went goes turned turns slashed slashes " +
    "eliminated eliminates shipped ships hit hits reached reaches booked books converts converted is was keeps kept made makes found finds wins won " +
    "leverages leveraged simplified simplifies optimized optimizes optimised optimises modernized modernizes onboarded onboards hired hires sped speeds " +
    "empowers empowered enabled enables tackled tackles solved solves handles handled stays stayed secures secured raised raises lowers lowered added adds " +
    "created creates brings brought meets met maintains maintained supports supported serves served expanded expands decreased decreases sends sent " +
    "tracks tracked measures measured trains trained personalizes personalized protects protected monitors monitored detects detected prevents prevented " +
    "recovers recovered processes processed ensures ensured lets saw sees took takes gained gains earns earned chose chooses picked picks selected selects " +
    "adopted adopts deployed deploys trusts trusted relies relied loves loved standardized standardizes rolled rolls supercharged supercharges " +
    "revamped revamps overhauled overhauls rebuilt rebuilds centralized centralizes unified unifies outgrew outgrows broke breaks beat beats exceeded exceeds " +
    "can could will has have had does did"
  ).split(/\s+/),
);

/** Bare forms ("helped Hooli scale ..."). Capitalised they are as likely part of a name ("Scale AI"), so they only count in lower case - or right after "helped". */
const BASE_VERBS = new Set(
  (
    "scale grow save reduce increase build boost improve achieve drive automate streamline double triple accelerate close launch migrate switch move replace " +
    "consolidate transform unlock generate deliver manage run get go turn slash eliminate ship reach book convert keep make find win leverage simplify optimize " +
    "optimise modernize onboard hire speed empower enable tackle solve handle stay secure raise lower add create bring meet maintain support serve expand " +
    "decrease send track measure train personalize protect monitor detect prevent recover process ensure see take gain earn choose pick select adopt deploy " +
    "trust rely standardize roll supercharge revamp overhaul rebuild centralize unify break beat exceed become stop start"
  ).split(/\s+/),
);

const word = (t: string): string => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const isVerb = (t: string, anyCase = false): boolean => {
  const w = word(t);
  if (VERBS.has(w) || /^\d+(?:\.\d+)?x(?:['\u2019]?d|ed)?$/.test(w)) return true;
  return BASE_VERBS.has(w) && (anyCase || !/^\p{Lu}/u.test(t));
};
const POSSESSIVE = /['\u2019]s$/;

const LABEL_PREFIX = /^(?:customer\s+(?:success\s+)?stor(?:y|ies)|(?:customer\s+)?case\s+stud(?:y|ies)|customer\s+spotlight|success\s+stor(?:y|ies)|client\s+stor(?:y|ies)|spotlight|story)\s*[:|\u2013\u2014-]\s*/i;
const LABEL_SUFFIX = /\s*(?:[:|\u2013\u2014-]\s*)?(?:customer\s+(?:success\s+)?story|(?:customer\s+)?case\s+study|success\s+story|customer\s+spotlight|client\s+story)$/i;

/** The words before the first verb (or up to a possessive), when they read as one company's name. */
function nameBeforeVerb(tokens: string[], opts: { stopAtTo?: boolean } = {}): string | null {
  let toks = tokens.slice();
  if (toks.length && word(toks[0]) === "the") toks = toks.slice(1);
  // "the team at Globex ..." names Globex.
  const at = toks.slice(0, 4).findIndex((t) => word(t) === "at");
  if (at > 0 && toks.slice(0, at).every((t) => isGenericWord(t) || isAudienceWord(t))) toks = toks.slice(at + 1);
  const name: string[] = [];
  let ended = false;
  for (let i = 0; i < toks.length && i <= 4; i++) {
    const t = toks[i];
    if (POSSESSIVE.test(t)) {
      name.push(t.replace(POSSESSIVE, ""));
      ended = true;
      break;
    }
    if (isVerb(t, i > 0 && !!opts.stopAtTo) || (opts.stopAtTo && word(t) === "to")) {
      ended = true;
      break;
    }
    name.push(t);
  }
  if (!ended || !name.length || name.length > 4) return null;
  if (!/^[\p{Lu}\p{N}]/u.test(name[0]) && !/\p{Lu}/u.test(name[0])) return null;
  while (name.length > 1 && /^teams?$/i.test(word(name[name.length - 1]))) name.pop();
  return cleanCompanyName(name.join(" "), 4);
}

/**
 * The company a case-study headline is about, or null.
 *
 * Only called on text that is already known to be a case study's headline (the text of a
 * link into a customers section, the title of a page under one). Recognises "How Globex
 * cut ...", "Why Globex chose ...", "How Acme helped Globex ...", "Globex case study",
 * "Case study: Globex", "Globex + Acme", "Globex cuts ... with Acme", "Globex chooses Acme".
 */
export function parseHeadline(raw: string, competitor: string): string | null {
  let t = cleanLine(raw, 220);
  if (t.length < 3) return null;
  const comp = escapeRegExp(cleanLine(competitor, 80));
  if (!comp) return null;
  // A trailing site name ("... | Acme", "... - Acme Customers") is not part of the headline.
  t = t.replace(new RegExp(`\\s*[|\\u2013\\u2014-]\\s*${comp}(?:\\s+(?:customers?|case studies|customer stories|stories|blog))?\\s*$`, "i"), "").trim();
  let labelled = false;
  const afterLabel = t.replace(LABEL_PREFIX, "");
  if (afterLabel !== t) {
    labelled = true;
    t = afterLabel.trim();
  }
  const beforeSuffix = t.replace(LABEL_SUFFIX, "");
  if (beforeSuffix !== t) {
    labelled = true;
    t = beforeSuffix.trim();
  }
  if (!t) return null;
  const tokens = t.split(" ");
  const lower = tokens.map(word);

  if ((lower[0] === "how" || lower[0] === "why") && tokens.length >= 3) {
    // "How Acme helped Globex cut ..." is about Globex.
    const helped = lower.findIndex((w, i) => i > 0 && i <= 4 && /^(?:help|helps|helped|helping|enabled|enables|empowered|empowers)$/.test(w));
    if (helped > 0) return nameBeforeVerb(tokens.slice(helped + 1), { stopAtTo: true });
    return nameBeforeVerb(tokens.slice(1));
  }
  if (labelled && tokens.length <= 4 && !tokens.some((x) => isVerb(x))) return cleanCompanyName(t, 4);

  const joiner = "(?:\\+|\\bx\\b|\\u00D7|<>|\\u2764\\uFE0F?|\\u2665)";
  const left = new RegExp(`^(.{2,60}?)\\s*(?:${joiner}|&|\\band\\b)\\s*${comp}$`, "i").exec(t);
  if (left) return cleanCompanyName(left[1], 3);
  const right = new RegExp(`^${comp}\\s*${joiner}\\s*(.{2,60})$`, "i").exec(t);
  if (right) return cleanCompanyName(right[1], 3);

  const chose = new RegExp(`^(.{2,60}?)\\s+(?:chooses|chose|selects|selected|switches to|switched to|picks|picked|adopts|adopted|deploys|deployed|goes with|went with|standardi[sz]es on|standardi[sz]ed on|moves to|moved to|trusts|relies on|rolls out|rolled out)\\s+${comp}\\b`, "i").exec(t);
  if (chose) return cleanCompanyName(chose[1], 4);

  // "Globex cuts onboarding time by 40% with Acme", "Globex doubles its pipeline".
  return nameBeforeVerb(tokens);
}

const SLUG_ACTION = new Set("become join get see view read watch contact request book start try learn meet share submit refer apply sign explore browse discover find download subscribe register login".split(" "));
const capitalised = (name: string): boolean => name.split(/[\s\-_.]+/).filter(Boolean).every((t) => /^[\p{Lu}\p{N}]/u.test(t));
/** Written the way a name is written: a capital or a digit first, or a capital inside ("eBay"). A lower-case word is a word. */
const writtenAsName = (name: string): boolean => /^[\p{Lu}\p{N}]/u.test(name) || /\p{Lu}/u.test(name);

const SLUG_FILLER = new Set("case study studies casestudy customer customers story stories success testimonial testimonials spotlight video pdf and x with on at the client clients interview webinar qa".split(" "));

/**
 * A company name read from a case-study URL slug, when the slug is short enough to be a
 * name rather than a headline. `weak` marks a slug containing an everyday word, which is
 * reported only if the page's own text spells the same name.
 */
export function slugCustomerName(slug: string, competitor: string): { name: string; tokens: string[]; weak: boolean } | null {
  const compTokens = new Set(cleanLine(competitor, 80).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let tokens = slug.toLowerCase().split(/[-_+.\s]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 8) return null;
  if (/^(?:how|why|what|when|where|the|a|an|our|your|\d+)$/.test(tokens[0])) return null;
  tokens = tokens.filter((t) => !SLUG_FILLER.has(t) && !compTokens.has(t));
  if (!tokens.length || tokens.length > 3) return null;
  if (tokens.some((t) => VERBS.has(t) || SLUG_ACTION.has(t)) || tokens.every((t) => /^\d+$/.test(t))) return null;
  if (tokens.some((t) => t.length > 30 || !/^[a-z0-9]+$/.test(t))) return null;
  const weak = tokens.some((t) => isGenericWord(t) || isAudienceWord(t));
  return { name: slugToName(tokens.join("-")), tokens, weak };
}

/** The slug's name as the page writes it ("GlobeX", "Globex Corp."), or null when the text does not contain it. */
function spelledIn(text: string, tokens: string[]): string | null {
  if (!text || !tokens.length) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${tokens.map(escapeRegExp).join("[\\s\\-_.]{0,2}")}(?![\\p{L}\\p{N}])`, "iu");
  const m = re.exec(text.slice(0, 2000));
  return m ? m[0] : null;
}

/* ───────────────────────────────── labels and logos ───────────────────────────────── */

const POSITIVE_LABEL = new RegExp(
  [
    "\\b(?:our|featured|happy|notable|some of our|meet our|select(?:ed)?|leading|top|global|enterprise)\\s+(?:customers|clients)\\b",
    "^(?:customers|clients)$",
    "\\btrusted by\\b",
    "\\bloved by\\b",
    "\\bused by\\b",
    "\\bchosen by\\b",
    "\\brelied (?:up)?on by\\b",
    "\\b(?:customers|clients|companies|teams|brands|businesses|organi[sz]ations|startups|enterprises)\\s+(?:like|such as|including|who (?:trust|use|love|rely)|that (?:trust|use|love|rely)|using|trust|love|rely on|of all sizes)\\b",
    "\\bjoin\\b.{0,60}\\b(?:customers|companies|teams|brands|businesses|organi[sz]ations)\\b",
    "\\b(?:customer|client)\\s+(?:stories|logos|spotlights?|case studies|wins|success)\\b",
    "\\b(?:case studies|success stories)\\b",
    "\\bwho(?:'s| is)? using\\b",
    "\\bpowering\\b.{0,40}\\b(?:teams|companies|brands|businesses)\\b",
    "\\bteams at\\b",
    "\\b\\d[\\d,.]*\\s*(?:k|m|thousand|million)?\\+?\\s+(?:customers|companies|teams|businesses|brands|organi[sz]ations)\\b",
    "\\b(?:companies|teams|brands|businesses|organi[sz]ations)\\b.{0,30}\\b(?:build|run|grow|scale|ship|sell|work|rely|count)\\b.{0,20}\\b(?:with|on)\\b",
    "\\bin good company\\b",
  ].join("|"),
  "i",
);

const STORY_LABEL = /\b(?:case studies|success stories|(?:customer|client)\s+(?:stories|spotlights?|case studies|wins|success))\b/i;

const NEGATIVE_LABEL =
  /\b(?:integrat\w*|partners?|partnerships?|investors?|backed by|funded by|as (?:seen|featured) (?:in|on)|featured (?:in|on)|in the (?:news|press)|press|media coverage|awards?|recogni[sz]ed by|certifi\w*|complian\w*|works with|connects? (?:with|to)|built (?:with|on)|powered by|tech(?:nology)? stack|sponsors?|sponsored|marketplace|plug-?ins?|add-?ons?|our team|leadership|advisors?|board of|members? of|accredit\w*|badges?|reviews? on|rated on|available on|download on|supported (?:platforms|tools|apps)|compatible with|ecosystem|alumni|speakers?|contributors?|resellers?|vendors?|suppliers?|data sources?|destinations?|connectors?)\b/i;

const POSITIVE_CLASS = /^(?:(?:our[-_]?)?(?:customers?|clients?)(?:[-_]?(?:logos?|list|grid|wall|strip|carousel|slider|section|marquee|row|bar|cloud))?|logos?[-_](?:customers?|clients?)|trusted[-_]?by[\w-]*|social[-_]?proof[\w-]*)$/i;
const LOGO_CLASS = /^(?:logos?|logo[-_]?(?:wall|cloud|grid|strip|bar|garden|list|carousel|slider|row|marquee|section|ticker|band)[\w-]*)$/i;
const NEGATIVE_CLASS = /partner|integrat|investor|press|media|award|badge|certif|security|complian|tech-?stack|sponsor|marketplace|app-?store|payment/i;

const CHROME_CLASS = /^(?:nav|header|masthead|navbar[\w-]*|navigation[\w-]*|main-nav[\w-]*|site-nav[\w-]*|top-?nav[\w-]*|menu|main-menu[\w-]*|mobile-menu[\w-]*|mega-?menu[\w-]*|footer[\w-]*|site-footer[\w-]*|site-header[\w-]*|page-footer[\w-]*|global-(?:header|footer|nav)[\w-]*|topbar|top-bar|announcement[\w-]*|cookie[\w-]*|consent[\w-]*|gdpr[\w-]*|breadcrumbs?|sidebar[\w-]*|socials?|social-(?:links?|icons?|media|share)[\w-]*|share-(?:buttons?|links?)[\w-]*|skip-link[\w-]*|modal[\w-]*|popup[\w-]*)$/i;

const classTokens = (n: Node): string[] => `${attr(n, "class")} ${attr(n, "id")}`.split(/\s+/).filter(Boolean);

/** Text of a short, picture-free element that can act as the label of what follows it. */
function labelText(n: Node): string {
  if (n.type !== "tag") return "";
  const name = n.name ?? "";
  if (!isHeading(n) && !["p", "span", "div", "strong", "small", "b", "em", "label", "figcaption", "caption"].includes(name)) return "";
  const kids = n.children ?? [];
  if (!isHeading(n)) {
    if (kids.filter((c) => c.type === "tag").length > 3) return "";
    if (kids.some((c) => c.type === "tag" && BLOCK.has(c.name ?? "") && c.name !== "br")) return "";
  }
  if (descendants(n, 40).some((d) => isTag(d, "img", "svg", "picture", "video", "ul", "ol", "table"))) return "";
  const t = lineOf(n, 200);
  return t.length >= 3 && t.length <= 140 ? t : "";
}

const PERSON_IMAGE = /avatar|headshot|portrait|author|profile|person|people|team-?member|speaker|founder|employee|staff|user-?(?:pic|photo|image)|rounded-full|testimonial-?(?:image|photo|avatar|img)/i;
const PERSON_ALT = /\b(?:photo|headshot|portrait|picture|avatar|image)\s+of\b|\bheadshot\b|\bprofile\s+(?:photo|picture|image)\b|\bportrait\b/i;
const NOT_A_CUSTOMER_ALT = /\b(?:partner|integration|investor|award|badge|certified|certification|press|sponsor|compliant|rating|stars?|review)\b/i;

interface LogoItem {
  node: Node;
  raw: string;
  explicit: boolean;
}

/** The description a logo carries (alt, aria-label, title), or null for anything that is not a nameable logo. */
function logoItem(n: Node): LogoItem | null {
  if (n.type !== "tag") return null;
  const up = ancestors(n, 2);
  const around = [n, ...up].map((a) => attr(a, "class")).join(" ");
  if (isTag(n, "img")) {
    const src = attr(n, "src") || attr(n, "data-src") || attr(n, "data-lazy-src") || attr(n, "srcset");
    let raw = attr(n, "alt") || attr(n, "aria-label") || attr(n, "title");
    if (!raw) {
      const link = up.find((a) => isTag(a, "a"));
      raw = link ? attr(link, "aria-label") || attr(link, "title") : "";
    }
    if (!raw) return null;
    const hint = `${raw} ${src.slice(0, 300)} ${around}`;
    const explicit = /logo|brand|wordmark/i.test(hint);
    if (!explicit && (PERSON_IMAGE.test(`${around} ${src.slice(0, 300)}`) || /\.jpe?g(?:[?#]|$)/i.test(src))) return null;
    if (PERSON_ALT.test(raw) || (PERSON_IMAGE.test(around) && !/logo/i.test(hint))) return null;
    return { node: n, raw, explicit };
  }
  if (isTag(n, "svg") || attr(n, "role") === "img") {
    let raw = attr(n, "aria-label") || attr(n, "title");
    if (!raw && isTag(n, "svg")) {
      const title = (n.children ?? []).find((c) => isTag(c, "title"));
      raw = title ? lineOf(title, 120) : "";
    }
    if (!raw) return null;
    return { node: n, raw, explicit: /logo|brand|wordmark/i.test(`${raw} ${around}`) };
  }
  return null;
}

/** "Globex logo", "logo of Globex", "globex-logo-white.svg" as the company's name, or null. */
export function cleanLogoName(raw: string): string | null {
  let s = cleanLine(raw, 160);
  if (!s || NOT_A_CUSTOMER_ALT.test(s)) return null;
  s = s.replace(/\.(?:svg|png|jpe?g|webp|gif|avif)$/i, "");
  if (!/\s/.test(s) && /[-_]/.test(s)) s = s.replace(/[-_]+/g, " ");
  s = s
    .replace(/^(?:the\s+)?(?:logo|logotype|image|icon)\s+(?:of|for)\s+/i, "")
    .replace(/^(?:customer|client|company)\s*(?:logo)?\s*[:\u2013-]\s*/i, "")
    .replace(/\b(?:company\s+|customer\s+|client\s+|brand\s+)?(?:logos?|logotype|wordmark|logomark)\b/gi, " ")
    .replace(/\s*\([^)]{0,40}\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s+(?:white|black|dark|light|colou?r|colou?red|gr[ae]yscale|gr[ae]y|mono(?:chrome)?|inverted|reversed|svg|png|icon|image|img|small|large|\dx)$/i, "").trim();
  if (!s) return null;
  if (s === s.toLowerCase() && !/[.]/.test(s)) s = slugToName(s);
  return cleanCompanyName(s, 4);
}

/* ───────────────────────────────── the page ───────────────────────────────── */

const MAX_HITS_PER_PAGE = 120;
const TITLE_WORDS = /\b(?:ceo|cto|cfo|coo|cmo|cro|cpo|cio|ciso|founder|co-?founder|director|head|vp|vice president|manager|lead|chief|president|officer|engineer|designer|owner|partner|principal|analyst|specialist|consultant|marketer|recruiter|developer|architect|administrator|coordinator|executive|strategist)\b/i;
const NOT_A_CUSTOMER_ROLE = /\b(?:investor|analyst at|journalist|editor|reporter|board member|advisor|adviser|venture partner|general partner)\b/i;

export function extractCustomers(html: string, pageUrl: string, competitor: { name: string; domain: string }): PageExtraction {
  const empty: PageExtraction = { hits: [], links: [], text: "", title: "", customerPage: false };
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return empty;
  }
  const $ = cheerio.load(String(html ?? "").slice(0, 1_500_000));
  const customerPage = isCustomerPath(base.pathname);
  const pageSlug = caseSlugOf(base.pathname);
  const hits = new Map<string, CustomerHit>();

  const add = (hit: CustomerHit): void => {
    if (hits.size >= MAX_HITS_PER_PAGE) return;
    const name = cleanCompanyName(hit.name);
    const quote = cleanQuote(hit.quote, 500);
    if (!name || !quote) return;
    if (isVendorName(name) || isSameCompany(name, competitor)) return;
    const key = normCompanyName(name);
    if (!key || key.length < 2) return;
    const have = hits.get(key);
    const next: CustomerHit = { ...hit, name, quote, ...(hit.headline ? { headline: cleanLine(hit.headline, 160) } : {}) };
    if (!have || next.confidence > have.confidence) hits.set(key, { ...next, domain: next.domain ?? have?.domain });
    else if (!have.domain && next.domain) have.domain = next.domain;
  };

  /** The customer's own site, only when the page links the name straight to it. */
  const linkedDomain = (n: Node, name: string): string | undefined => {
    const link = [n, ...ancestors(n, 3)].find((a) => isTag(a, "a") && attr(a, "href"));
    const u = link ? resolveLink(attr(link, "href"), base.href) : null;
    if (!u) return undefined;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".") || sameSite(u.href, competitor.domain) || !isPublicHost(host) || isSocialOrAggregator(host)) return undefined;
    const root = rootDomain(host);
    const label = root.split(".")[0].replace(/[^a-z0-9]/g, "");
    const key = normCompanyName(name);
    if (label.length < 3 || key.length < 3) return undefined;
    return label === key || (Math.min(label.length, key.length) >= 4 && (label.includes(key) || key.includes(label))) ? root : undefined;
  };

  /* Title, before anything is removed. */
  const title = cleanLine($('meta[property="og:title"]').attr("content") || $("title").first().text(), 200);

  /* Structured data, before scripts are removed. */
  const structured: { name: string; review: boolean }[] = [];
  $("script[type='application/ld+json']").each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).text().slice(0, 200_000));
    } catch {
      return;
    }
    const queue: unknown[] = [data];
    for (let seen = 0; queue.length && seen < 400; seen++) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node.slice(0, 100));
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const types = ([] as unknown[]).concat(o["@type"] ?? []).map((t) => String(t).toLowerCase());
      const orgName = (v: unknown): string | null => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        const r = v as Record<string, unknown>;
        const t = ([] as unknown[]).concat(r["@type"] ?? []).map((x) => String(x).toLowerCase());
        if (t.some((x) => x === "organization" || x === "corporation" || x === "localbusiness") && typeof r.name === "string") return r.name;
        return orgName(r.worksFor) ?? orgName(r.affiliation);
      };
      if (types.includes("review")) {
        const n = orgName(o.author);
        if (n) structured.push({ name: n, review: true });
      } else if (pageSlug && types.some((t) => t === "article" || t === "blogposting" || t === "newsarticle" || t === "webpage" || t === "creativework")) {
        for (const v of ([] as unknown[]).concat(o.about ?? [], o.mentions ?? []).slice(0, 20)) {
          const n = orgName(v);
          if (n) structured.push({ name: n, review: false });
        }
      }
      if (o["@graph"]) queue.push(o["@graph"]);
      for (const k of ["review", "reviews", "mainEntity", "hasPart", "itemListElement", "item"]) if (o[k]) queue.push(o[k]);
    }
  });

  /* Links worth reading next: navigation included, since that is where "Customers" lives. */
  const links = new Map<string, number>();
  $("a[href]").each((_, el) => {
    if (links.size >= 400) return;
    const u = resolveLink($(el).attr("href"), base.href);
    if (!u || !sameSite(u.href, competitor.domain)) return;
    u.search = "";
    const score = crawlScore(u);
    if (score <= 0) return;
    const key = u.toString().replace(/\/$/, "");
    if (key === base.toString().replace(/[?#].*$/, "").replace(/\/$/, "")) return;
    links.set(key, Math.max(links.get(key) ?? 0, score));
  });

  /* Everything that is not the page's own content goes before any name is read. */
  $("script, style, noscript, template, iframe, object, embed, select, dialog").remove();
  $("nav, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='dialog'], [role='search']").remove();
  $("header").filter((_, el) => $(el).closest("main, article, section").length === 0).remove();
  $("footer").filter((_, el) => $(el).closest("blockquote, figure, article").length === 0).remove();
  const bodyNode = ($("body").get(0) ?? $.root().get(0)) as unknown as Node | undefined;
  if (!bodyNode) return { ...empty, links: [...links].map(([url, score]) => ({ url, score })), title, customerPage };
  const fullLength = rawText(bodyNode).length || 1;
  $("[class], [id]").each((_, el) => {
    const n = el as unknown as Node;
    if (isTag(n, "body", "html", "main")) return;
    if (!classTokens(n).some((t) => CHROME_CLASS.test(t))) return;
    // A wrapper around most of the page that merely mentions "nav" in a class is not the navigation.
    if (rawText(n).length > fullLength * 0.5) return;
    $(el).remove();
  });

  const text = tidyLines(rawText(bodyNode)).slice(0, 60_000);
  const flat = text.replace(/\s+/g, " ");
  const all = descendants(bodyNode, 6000);
  const indexOf = new Map<Node, number>();
  all.forEach((n, i) => indexOf.set(n, i));

  /* 1. Case-study links: /customers/globex, with the card around them. */
  const caseLinks = new Map<string, Node[]>();
  for (const n of all) {
    if (!isTag(n, "a")) continue;
    const u = resolveLink(attr(n, "href"), base.href);
    if (!u || !sameSite(u.href, competitor.domain)) continue;
    const slug = caseSlugOf(u.pathname);
    if (!slug || NOT_CUSTOMER_PATH.test(u.pathname.toLowerCase())) continue;
    const key = u.pathname.replace(/\/$/, "").toLowerCase();
    caseLinks.set(key, [...(caseLinks.get(key) ?? []), n]);
  }
  const caseLinkCount = (scope: Node): number => {
    const seen = new Set<string>();
    for (const d of [scope, ...descendants(scope, 400)]) {
      if (!isTag(d, "a")) continue;
      const u = resolveLink(attr(d, "href"), base.href);
      if (u && sameSite(u.href, competitor.domain) && caseSlugOf(u.pathname)) seen.add(u.pathname.replace(/\/$/, "").toLowerCase());
    }
    return seen.size;
  };
  for (const [path, anchors] of caseLinks) {
    const slug = caseSlugOf(path);
    if (!slug) continue;
    const fromSlug = slugCustomerName(slug, competitor.name);
    // The link's own text, then the card it sits in (the smallest block holding only this story).
    // Headlines first: "How Globex cut onboarding time" says more to a reviewer than "Globex logo".
    const headlines: { text: string; node: Node }[] = [];
    const others: { text: string; node: Node }[] = [];
    for (const a of anchors.slice(0, 4)) {
      const own = lineOf(a, 300);
      for (const d of descendants(a, 60)) {
        if (isHeading(d)) headlines.push({ text: lineOf(d, 300), node: d });
        const item = logoItem(d);
        if (item) others.push({ text: cleanLine(item.raw, 160), node: d });
      }
      if (own) others.unshift({ text: own, node: a });
      let card: Node | null = null;
      for (const anc of ancestors(a, 3)) {
        if (isTag(anc, "body", "main", "html") || caseLinkCount(anc) > 1) break;
        card = anc;
      }
      if (card) {
        for (const d of descendants(card, 120)) {
          if (contains(a, d)) continue;
          if (isHeading(d) || /title|heading|headline|name/i.test(attr(d, "class"))) {
            const t = lineOf(d, 300);
            if (t && t.length <= 200) headlines.push({ text: t, node: d });
          }
          const item = logoItem(d);
          if (item) others.push({ text: cleanLine(item.raw, 160), node: d });
        }
      }
    }
    const texts = [...headlines, ...others].filter((t) => t.text);
    let done = false;
    // (a) the slug's name, spelled out by the page: the strongest reading.
    if (fromSlug) {
      for (const t of texts) {
        const spelled = spelledIn(t.text, fromSlug.tokens);
        // A slug made of everyday words ("/customers/remote-teams") only counts when the page capitalises it as a name.
        if (!spelled || !writtenAsName(spelled) || (fromSlug.weak && !capitalised(spelled))) continue;
        const headline = t.text.split(" ").length >= 3 && t.text.length > spelled.length + 6 ? t.text : undefined;
        add({ name: spelled, quote: t.text, via: "case_study", headline, confidence: 0.9, domain: linkedDomain(t.node, spelled) });
        done = true;
        break;
      }
    }
    // (b) a case-study headline that names the company.
    if (!done) {
      for (const t of texts) {
        const name = parseHeadline(t.text, competitor.name);
        if (!name) continue;
        add({ name, quote: t.text, via: "case_study", headline: t.text, confidence: fromSlug && normCompanyName(fromSlug.name) === normCompanyName(name) ? 0.9 : 0.75 });
        done = true;
        break;
      }
    }
    // (c) a short, distinctive slug alone. The quote is the link exactly as the page wrote it.
    // Only on a page that really is an index of stories (three or more of them): a lone link under /customers/ can be anything.
    if (!done && caseLinks.size >= 3 && fromSlug && !fromSlug.weak && fromSlug.tokens.length <= 2 && fromSlug.tokens.join("").length >= 3) {
      const href = cleanLine(attr(anchors[0], "href"), 300);
      if (href) add({ name: fromSlug.name, quote: href, via: "case_study", confidence: 0.55 });
    }
  }

  /* 2. The page is itself one case study: its main headline or title names the company. */
  if (pageSlug) {
    const fromSlug = slugCustomerName(pageSlug, competitor.name);
    const heads = [...all.filter((n) => isTag(n, "h1")).map((n) => lineOf(n, 300)), title].filter(Boolean).slice(0, 3);
    for (const h of heads) {
      const spelled = fromSlug ? spelledIn(h, fromSlug.tokens) : null;
      if (spelled && writtenAsName(spelled) && !(fromSlug?.weak && !capitalised(spelled))) {
        add({ name: spelled, quote: h, via: "case_study", headline: h.length > spelled.length + 6 ? h : undefined, confidence: 0.9 });
        break;
      }
      const name = parseHeadline(h, competitor.name);
      if (name) {
        add({ name, quote: h, via: "case_study", headline: h, confidence: 0.8 });
        break;
      }
    }
  }

  /* 3. Labelled headings on a customers page: "Case study: Globex", "Globex case study". */
  if (customerPage) {
    for (const n of all) {
      if (!isHeading(n)) continue;
      const t = lineOf(n, 240);
      if (!t || t.length > 200 || (!LABEL_PREFIX.test(t) && !LABEL_SUFFIX.test(t))) continue;
      const name = parseHeadline(t, competitor.name);
      if (name) add({ name, quote: t, via: "case_study", headline: t, confidence: 0.75 });
    }
  }

  /* 4. Logos under a label that says they are customers. */
  const takeLogos = (items: LogoItem[], label: string, confidence: number, declaredOnly = false): void => {
    const named = items.map((it) => ({ it, name: cleanLogoName(it.raw) })).filter((x): x is { it: LogoItem; name: string } => !!x.name);
    // A wall is several logos. Without the word "logo" anywhere, one or two pictures are not a wall -
    // and under a "customer stories" heading the pictures are story thumbnails, so only declared logos count.
    const wall = named.length >= 3 && !declaredOnly && !STORY_LABEL.test(label);
    for (const { it, name } of named) {
      if (!it.explicit && !wall) continue;
      // Pictures inside a testimonial are people unless they say "logo".
      if (!it.explicit && ancestors(it.node, 4).some((a) => isTag(a, "blockquote") || /testimonial|quote|review/i.test(attr(a, "class")))) continue;
      add({ name, quote: cleanLine(it.raw, 200), via: "logo", headline: label || undefined, confidence: it.explicit ? confidence : confidence - 0.15, domain: linkedDomain(it.node, name) });
    }
  };
  const sparse = (n: Node): boolean => {
    const logos = descendants(n, 600).filter((d) => logoItem(d)).length;
    return logos >= 1 && lineOf(n, 4000).length <= 30 * logos + 20;
  };
  const hasNegativeLabel = (n: Node): boolean => descendants(n, 300).some((d) => NEGATIVE_LABEL.test(labelText(d))) || classTokens(n).some((t) => NEGATIVE_CLASS.test(t));
  const negativeBetween = (item: Node, stop: Node): boolean => {
    for (const a of ancestors(item, 8)) {
      if (a === stop) return false;
      if (classTokens(a).some((t) => NEGATIVE_CLASS.test(t))) return true;
    }
    return false;
  };

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const label = labelText(el);
    if (!label || !POSITIVE_LABEL.test(label) || NEGATIVE_LABEL.test(label)) continue;
    let limit: Node = el;
    for (let k = 0; k < 4 && limit.parent && limit.parent.type === "tag" && limit.parent.name !== "html"; k++) limit = limit.parent;
    const limitEnd = isTag(limit, "body") ? all.length - 1 : (indexOf.get(limit) ?? i) + descendants(limit, 6000).length;
    const end = Math.min(all.length - 1, limitEnd, i + 500);
    const run: LogoItem[] = [];
    for (let j = i + descendants(el, 200).length + 1; j <= end; j++) {
      const e = all[j];
      if (isHeading(e)) break;
      const lt = labelText(e);
      if (lt && (NEGATIVE_LABEL.test(lt) || POSITIVE_LABEL.test(lt))) break;
      const item = logoItem(e);
      if (item) run.push(item);
    }
    if (!run.length) continue;
    // Start from the first picture that reads as a company, not a screenshot that happens to come first.
    const first = (run.find((it) => it.explicit && cleanLogoName(it.raw)) ?? run.find((it) => cleanLogoName(it.raw)) ?? run[0]).node;
    const chain: Node[] = [];
    let lca: Node | null = null;
    for (const a of ancestors(first, 12)) {
      if (contains(a, el)) {
        lca = a;
        break;
      }
      chain.push(a);
    }
    if (!lca) continue;
    let group: Node | null = null;
    for (const a of chain.slice(0, 4)) if (sparse(a)) group = a;
    let items: LogoItem[];
    if (group && !hasNegativeLabel(group)) {
      const members: Node[] = [group];
      // Further rows of the same wall: following siblings that are also nothing but logos.
      const siblings = (group.parent?.children ?? []).filter((c) => c.type === "tag");
      for (let s = siblings.indexOf(group) + 1; s > 0 && s < siblings.length && members.length < 12; s++) {
        const sib = siblings[s];
        if (isHeading(sib) || labelText(sib) || !sparse(sib) || hasNegativeLabel(sib)) break;
        members.push(sib);
      }
      items = members.flatMap((m) => [m, ...descendants(m, 600)].map((d) => logoItem(d)).filter((x): x is LogoItem => !!x));
    } else {
      items = run.filter((it) => {
        const depth = ancestors(it.node, 12).indexOf(lca!);
        return depth >= 0 && depth <= 3;
      });
    }
    takeLogos(items.filter((it) => !negativeBetween(it.node, lca!)), label, 0.8);
  }

  /* 5. Containers whose class says "customers" / "trusted by", when no label does. */
  for (const n of all) {
    const tokens = classTokens(n);
    if (!tokens.length || tokens.some((t) => NEGATIVE_CLASS.test(t))) continue;
    const positive = tokens.some((t) => POSITIVE_CLASS.test(t));
    const generic = !positive && customerPage && tokens.some((t) => LOGO_CLASS.test(t));
    if (!positive && !generic) continue;
    if (hasNegativeLabel(n)) continue;
    // The label just before the container decides too: "Our partners" above a .logos block is not customers.
    const before = (n.parent?.children ?? []).filter((c) => c.type === "tag");
    const prev = before[before.indexOf(n) - 1];
    const prevLabel = prev ? labelText(prev) || lineOf(prev, 160) : "";
    if (prevLabel && prevLabel.length <= 140 && NEGATIVE_LABEL.test(prevLabel)) continue;
    const items = descendants(n, 600)
      .map((d) => logoItem(d))
      .filter((x): x is LogoItem => !!x)
      .filter((it) => !negativeBetween(it.node, n));
    // A block merely classed "customers" can hold story thumbnails; only one whose class speaks of logos is a wall.
    const wallClass = tokens.some((t) => /logo|trusted|proof/i.test(t));
    takeLogos(items, "", positive ? 0.7 : 0.6, !wallClass);
  }

  /* 6. Testimonials: "Jane Doe, VP Sales at Globex" under a quote. */
  for (const n of all) {
    const cls = attr(n, "class");
    const attribution = isTag(n, "cite", "figcaption") || (isTag(n, "footer") && ancestors(n, 2).some((a) => isTag(a, "blockquote", "figure"))) || /author|attribution|byline|(?:testimonial|quote|review)[\w-]*(?:name|role|title|position|company|source|meta)/i.test(cls);
    if (!attribution) continue;
    const scope = ancestors(n, 4).find((a) => isTag(a, "blockquote", "figure") || /testimonial|quote|review/i.test(attr(a, "class")) || descendants(a, 80).some((d) => isTag(d, "blockquote", "q")));
    // The quote and its attribution form one small block; a whole article with a quote somewhere in it does not.
    if (!scope || lineOf(scope, 1300).length > 1200) continue;
    const t = lineOf(n, 240);
    if (!t || t.length > 180 || NOT_A_CUSTOMER_ROLE.test(t)) continue;
    let company: string | null = null;
    const at = /\s(?:at|@)\s+([^,|\u00B7\u2022]{2,60})$/i.exec(t);
    if (at && TITLE_WORDS.test(t.slice(0, at.index))) company = at[1];
    if (!company) {
      const parts = t.split(/\s*[,|\u00B7\u2022\u2013\u2014]\s*|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 3 && parts.slice(1, -1).some((p) => TITLE_WORDS.test(p)) && !TITLE_WORDS.test(parts[parts.length - 1])) company = parts[parts.length - 1];
    }
    const name = company ? cleanCompanyName(company, 4) : null;
    // "Partner at Benchmark Capital" is an investor speaking, not a customer.
    if (name && /\bpartner\b/i.test(t) && /\b(?:capital|ventures?|vc|partners|fund|equity|investments?)\b/i.test(name)) continue;
    if (name) add({ name, quote: t, via: "testimonial", confidence: 0.7 });
  }

  /* 7. Structured data, only for names the visible page also shows. */
  for (const s of structured.slice(0, 40)) {
    const name = cleanCompanyName(s.name, 4);
    if (!name || !flat.toLowerCase().includes(name.toLowerCase())) continue;
    add({ name, quote: name, via: "structured_data", confidence: s.review ? 0.7 : 0.65 });
  }

  return {
    hits: [...hits.values()],
    links: [...links].map(([url, score]) => ({ url, score })),
    text,
    title,
    customerPage,
  };
}

/** Customer-section URLs listed in a sitemap, plus child sitemaps when the file is an index. */
export function customerLinksFromSitemap(xml: string, domain: string): { links: CrawlLink[]; children: string[] } {
  const links = new Map<string, number>();
  const children: string[] = [];
  const index = /<sitemapindex[\s>]/i.test(xml.slice(0, 2000));
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]{1,2000})\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  for (let seen = 0; (m = re.exec(xml)) && seen < 20_000; seen++) {
    const u = resolveLink(m[1].replace(/&amp;/g, "&"), `https://${domain}/`);
    if (!u || !sameSite(u.href, domain)) continue;
    if (index) {
      if (children.length < 20) children.push(u.toString());
      continue;
    }
    u.search = "";
    const score = crawlScore(u);
    if (score > 0 && links.size < 300) links.set(u.toString().replace(/\/$/, ""), score);
  }
  return { links: [...links].map(([url, score]) => ({ url, score })), children };
}

/**
 * What a model returned for one page, kept only where the page backs it up: the quote must
 * appear in the page text exactly (whitespace aside), the name must appear on the page too,
 * and the name must pass the same rules as any other. Everything else is dropped.
 */
export function verifyAiCustomers(raw: unknown, pageText: string, competitor: { name: string; domain: string }): { hits: CustomerHit[]; dropped: number } {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { customers?: unknown }).customers) ? ((raw as { customers: unknown[] }).customers as unknown[]) : [];
  const flat = pageText.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const hits: CustomerHit[] = [];
  let dropped = 0;
  for (const item of list.slice(0, 40)) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const name = cleanCompanyName(plainString(o.name, 80), 4);
    const quote = plainString(o.quote, 500).replace(/\s+/g, " ").trim();
    // The quote must be on the page word for word, must itself name the organisation, and must not be a
    // sentence about integrations, partners, investors or press - those name companies that are not customers.
    const ok = !!name && quote.length >= 8 && flat.includes(quote) && lower.includes(name.toLowerCase()) && quote.toLowerCase().includes(name.toLowerCase()) && !NEGATIVE_LABEL.test(quote) && !isVendorName(name) && !isSameCompany(name, competitor);
    if (!ok || !name) {
      dropped++;
      continue;
    }
    if (!hits.some((h) => normCompanyName(h.name) === normCompanyName(name))) hits.push({ name, quote, via: "ai", confidence: 0.65 });
  }
  return { hits, dropped };
}
