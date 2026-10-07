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
import { plainString } from "../ai/untrusted.js";
import { isSocialOrAggregator, rootDomain } from "../util/domain.js";
import { loadHtml } from "../util/html.js";
import { isPublicHost } from "../util/publicHost.js";
import { MAX_PAGE_CHARS, cleanCompanyName, escapeRegExp, isAudienceWord, isDescriptorName, isGenericWord, isSameCompany, isVendorName, sameSite, slugToName } from "./shared.js";
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
  /** The case study this comes from: the story a link leads to, or the page itself when it is one. */
  storyUrl?: string;
  /** What the quote is when it is not a headline: a testimonial's attribution line, or a page title or label. */
  mention?: "attribution" | "title";
  /** The story's own address names this company, so the story is about it and nobody else. */
  dedicated?: boolean;
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
  /**
   * Stories (by `storyKeyOf`) this page already tells in full: its card names the customer
   * in words of the page. Opening such a story again adds nothing.
   */
  told: string[];
  /**
   * How many different pages of the same site this page links to outside its own section
   * (counted up to 40). A page of the site carries the site's navigation; something else
   * served at an address that was only guessed - a user's booking page, an app screen -
   * links to nothing but itself.
   */
  siteLinks: number;
  /** The page was refused before it was read: nested too deeply, too many elements, or a tag the parser cannot read quickly. */
  unreadable?: boolean;
}


interface Node {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
  parent?: Node | null;
  /**
   * Set (by `markBlank`) on an element with no words anywhere inside it: what it adds to the
   * text around it - a line break, a space or nothing. Reading text steps over such an
   * element instead of walking through it.
   */
  blank?: string;
  /**
   * Set (by `markBlank`) on an element with words and many children: its children with
   * every run of blank ones replaced by the gap the run leaves. Reading its text goes
   * through this list, so thousands of empty children are stepped over at once.
   */
  words?: (Node | string)[];
  /** Set (by `markBlank`) on an element with words: how many characters of them it holds, counted up to 1,000. */
  solid?: number;
}

/* ───────────────────────────────── paths ───────────────────────────────── */

const CUSTOMER_SEGMENT = /^(?:our-)?(?:customers?|clients?|case-stud(?:y|ies)|casestud(?:y|ies)|customer-stor(?:y|ies)|customer-success-stor(?:y|ies)|success-stor(?:y|ies)|client-stor(?:y|ies)|stories|testimonials?|customer-spotlights?|wall-of-love)$/i;
const KEYWORD_PATH = /customer|case-?stud|stories|success|client|testimonial/i;
const NOT_CUSTOMER_PATH = /customer-(?:support|service|portal|login|care|experience|data|engagement|success-(?:team|manager|platform|software))|success-(?:plan|team|manager)|client-(?:portal|login|area|librar)|(?:^|\/)(?:blog|news|press|careers?|jobs|legal|docs?|documentation|help|support|pricing|login|signin|signup|sign-up|register|privacy|terms|webinars?|events?|podcasts?|api|developers?|changelog|status|search|cart|checkout|account|tag|tags|category|author)(?:\/|$)/i;
const FILE_EXT = /\.(?:pdf|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mov|webm|mp3|wav|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|css|js|woff2?|ttf|eot)$/i;
const NOT_A_SLUG = /^(?:page|category|categories|tag|tags|industry|industries|all|index|feed|search|filter|type|types|topic|topics|region|regions|use-cases?|solutions?|products?|features?|roles?|teams?|size|segment|segments|by-industry|by-size|by-role|video|videos|\d+)$/i;

/** Addresses are at most 2,000 characters everywhere else in the plays; a path is a part of one. */
const MAX_PATH = 2000;

export function isCustomerPath(pathname: string): boolean {
  // A path longer than any address may be is not looked through.
  if (pathname.length > MAX_PATH) return false;
  return pathname.split("/").filter(Boolean).some((s) => CUSTOMER_SEGMENT.test(s));
}

/** The last path segment of one case study (`/customers/globex` gives `globex`), or null for anything else. */
export function caseSlugOf(pathname: string): string | null {
  if (pathname.length > MAX_PATH) return null;
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

/**
 * Readable text of a subtree, with line breaks between blocks so words of neighbours never
 * run together. Stops once `need` characters that are not line breaks have been gathered,
 * and takes an element's children one at a time, so asking for the first line of an
 * element with tens of thousands of children reads only its first few.
 */
function rawText(root: Node, need = Infinity): string {
  const out: string[] = [];
  let size = 0;
  let got = 0;
  // The lists of children being read, how far into each, and what closes each.
  const lists: (Node | string)[][] = [];
  const at: number[] = [];
  const closer: string[] = [];
  const read = (n: Node | string): void => {
    if (typeof n === "string") {
      out.push(n);
      if (n === " ") got++;
      return;
    }
    if (n.type === "text") {
      const d = n.data ?? "";
      size += d.length;
      got += d.length;
      if (need !== Infinity) for (let i = d.indexOf("\n"); i >= 0; i = d.indexOf("\n", i + 1)) got--;
      out.push(d);
      return;
    }
    if (n.type !== "tag" && n.type !== "root") return;
    if (n.blank !== undefined) {
      // Nothing to read in there: only the gap it leaves between its neighbours.
      if (n.blank) out.push(n.blank);
      if (n.blank === " ") got++;
      return;
    }
    const sep = n.type === "tag" && BLOCK.has(n.name ?? "") ? "\n" : n.type === "tag" && SPACED.has(n.name ?? "") ? " " : "";
    if (sep) out.push(sep);
    if (sep === " ") got++;
    lists.push(n.words ?? n.children ?? []);
    at.push(0);
    closer.push(sep);
  };
  read(root);
  while (lists.length && size < MAX_TEXT && got < need) {
    const top = lists.length - 1;
    if (at[top] < lists[top].length) {
      read(lists[top][at[top]++]);
      continue;
    }
    const sep = closer[top];
    lists.pop();
    at.pop();
    closer.pop();
    if (sep) out.push(sep);
    if (sep === " ") got++;
  }
  return out.join("");
}

const tidyLines = (s: string): string =>
  s
    .split("\n")
    .map((l) => cleanQuote(l, 4000))
    .filter(Boolean)
    .join("\n");

/** One element's text as a single line. Only as much of the element is read as the line can show (`cleanQuote` looks at four times `max` and a little more). */
const lineOf = (n: Node, max = 300): string => cleanQuote(rawText(n, max * 4 + 401).replace(/\n+/g, " "), max);

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

const NOT_CONTENT = new Set("script style noscript template iframe object embed select dialog nav aside".split(" "));
const NOT_CONTENT_ROLE = new Set(["navigation", "banner", "contentinfo", "dialog", "search"]);
/** A header inside one of these is the content's own heading block, not the site's. */
const CONTENT_ROOT = new Set(["main", "article", "section"]);
/** A footer inside one of these is an attribution, not the site's footer. */
const QUOTE_ROOT = new Set(["blockquote", "figure", "article"]);

/** The attributes this file reads, and the longest value any of them is read to. Real ones are a few hundred characters. */
const READ_ATTRIBUTES = ["class", "id", "role", "alt", "title", "aria-label", "src", "data-src", "data-lazy-src", "srcset", "href", "data-framer-name", "data-name", "data-framer-component-type"];
const MAX_ATTRIBUTE = 4000;

interface Measure {
  /** Characters of text inside the element. */
  text: number;
  /** The length `rawText` gives for it (text plus the breaks between blocks), when the text is under `MAX_TEXT`. */
  raw: number;
}

/**
 * Takes what is not the page's own content out of the tree: scripts and styles, navigation
 * and sidebars, the site's header and footer. A header inside the main content, and a
 * footer inside a quote or an article, belong to the content and stay.
 *
 * One walk from the top that carries down what each element is inside of, so no element
 * is ever searched upwards from (which, on a page of deeply nested elements, costs the
 * depth again for every one of them). Returns how much text every element left holds.
 */
function dropNonContent(root: Node): Map<Node, Measure> {
  const sizes = new Map<Node, Measure>();
  interface Frame {
    node: Node;
    kids: Node[];
    at: number;
    kept: Node[];
    inContent: boolean;
    inQuote: boolean;
    text: number;
    raw: number;
  }
  const frame = (node: Node, inContent: boolean, inQuote: boolean): Frame => ({ node, kids: node.children ?? [], at: 0, kept: [], inContent, inQuote, text: 0, raw: 0 });
  const stack: Frame[] = [frame(root, false, false)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.at < f.kids.length) {
      const c = f.kids[f.at++];
      if (c.type === "text") {
        const size = (c.data ?? "").length;
        f.text += size;
        f.raw += size;
        f.kept.push(c);
        continue;
      }
      const name = c.type === "tag" || c.type === "script" || c.type === "style" ? (c.name ?? "") : null;
      if (name === null) {
        f.kept.push(c);
        continue;
      }
      if (NOT_CONTENT.has(name) || NOT_CONTENT_ROLE.has(c.attribs?.role ?? "") || (name === "header" && !f.inContent) || (name === "footer" && !f.inQuote)) {
        c.parent = null;
        continue;
      }
      f.kept.push(c);
      // Attributes are read many times over (a class by every element under it), so one of absurd length is cut once here.
      const attribs = c.attribs;
      if (attribs) for (const key of READ_ATTRIBUTES) if (attribs[key] !== undefined && attribs[key].length > MAX_ATTRIBUTE) attribs[key] = attribs[key].slice(0, MAX_ATTRIBUTE);
      stack.push(frame(c, f.inContent || CONTENT_ROOT.has(name), f.inQuote || QUOTE_ROOT.has(name)));
      continue;
    }
    stack.pop();
    if (f.kept.length !== f.kids.length) f.node.children = f.kept;
    if (f.node.type === "tag" && (BLOCK.has(f.node.name ?? "") || SPACED.has(f.node.name ?? ""))) f.raw += 2;
    sizes.set(f.node, { text: f.text, raw: f.raw });
    const up = stack[stack.length - 1];
    if (up) {
      up.text += f.text;
      up.raw += f.raw;
    }
  }
  return sizes;
}

/**
 * Marks every element that has no words inside it (see `Node.blank`). One walk, children
 * before parents. Run once the tree has its final shape.
 */
function markBlank(root: Node): void {
  // What a subtree without words leaves behind: 0 nothing, 1 a space, 2 a line break. -1: it has words (`solid` of them).
  interface Frame {
    node: Node;
    at: number;
    gap: number;
    solid: number;
  }
  const stack: Frame[] = [{ node: root, at: 0, gap: 0, solid: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    const kids = f.node.children ?? [];
    if (f.at < kids.length) {
      const c = kids[f.at++];
      if (c.type === "text") {
        const d = c.data ?? "";
        if (/\S/.test(d)) {
          f.gap = -1;
          // Counted only while it can still matter: a thousand is already more than any label or name.
          if (f.solid < 1000) for (let i = 0; i < d.length && f.solid < 1000; i++) if (d.charCodeAt(i) > 32) f.solid++;
        } else if (f.gap >= 0 && d) f.gap = Math.max(f.gap, d.includes("\n") ? 2 : 1);
      } else if (c.type === "tag" || c.type === "root") stack.push({ node: c, at: 0, gap: 0, solid: 0 });
      continue;
    }
    stack.pop();
    const n = f.node;
    let gap = f.gap;
    if (gap >= 0 && n.type === "tag") gap = BLOCK.has(n.name ?? "") ? 2 : SPACED.has(n.name ?? "") ? Math.max(gap, 1) : gap;
    if (gap >= 0) n.blank = gap === 2 ? "\n" : gap === 1 ? " " : "";
    else n.solid = f.solid;
    if (gap < 0 && kids.length >= 16) {
      const words: (Node | string)[] = [];
      let run = "";
      for (const c of kids) {
        const between = c.type === "text" ? (/\S/.test(c.data ?? "") ? null : c.data?.includes("\n") ? "\n" : c.data ? " " : "") : c.type === "tag" || c.type === "root" ? (c.blank ?? null) : "";
        if (between === null) {
          if (run) words.push(run);
          run = "";
          words.push(c);
        } else if (between === "\n" || (between === " " && !run)) run = between;
      }
      if (run) words.push(run);
      n.words = words;
    }
    const up = stack[stack.length - 1];
    if (up) {
      up.gap = gap < 0 || up.gap < 0 ? -1 : Math.max(up.gap, gap);
      up.solid = Math.min(1000, up.solid + f.solid);
    }
  }
}

/** Takes out the elements `drop` names, each with everything inside it, in one walk from the top in page order. */
function dropWhere(root: Node, drop: (n: Node) => boolean): void {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const kids = n.children;
    if (!kids?.length) continue;
    let kept: Node[] | null = null;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type === "tag" && drop(c)) {
        kept ??= kids.slice(0, i);
        c.parent = null;
      } else {
        kept?.push(c);
        if (c.type === "tag" || c.type === "root") stack.push(c);
      }
    }
    if (kept) n.children = kept;
  }
}

/** The first `max` elements inside `n`, in page order. Children are taken one at a time, so a short list costs the same under an element with three children or thirty thousand. */
function descendants(n: Node, max = 5000): Node[] {
  const out: Node[] = [];
  const lists: Node[][] = [n.children ?? []];
  const at: number[] = [0];
  while (lists.length && out.length < max) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const c = lists[top][at[top]++];
    if (c.type !== "tag") continue;
    out.push(c);
    if (c.children?.length) {
      lists.push(c.children);
      at.push(0);
    }
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
    "engages engaged communicates communicated partnered redefined redefines reimagined reimagines resolves resolved debugs debugged " +
    "strengthens strengthened elevates elevated equips equipped embedded aligns aligned completed completes gave gives navigates navigated " +
    "connects connected rebuilds redesigned redesigns rethinks rethought reinvented reinvents revolutionized revolutionizes " +
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

const word = (t: string): string => t.slice(0, 100).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
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
    // "CoLearn, Indonesia's fastest growing EdTech, drove ...": a comma after the name starts a description of
    // the company, when the sentence goes on to say what the company did.
    if (/[\p{L}\p{N}],$/u.test(t) && toks.slice(i + 1, i + 14).some((x) => POSSESSIVE.test(x) || isVerb(x))) {
      name.push(t.slice(0, -1));
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

interface HeadlineShapes {
  siteName: RegExp;
  left: RegExp;
  right: RegExp;
  chose: RegExp;
}
let shapesFor = "";
let shapesBuilt: HeadlineShapes | null = null;
/** The headline patterns that mention the competitor by name. A page is read with one competitor in mind, so the last set is kept. */
function headlineShapes(competitor: string): HeadlineShapes | null {
  if (shapesBuilt && shapesFor === competitor) return shapesBuilt;
  const comp = escapeRegExp(cleanLine(competitor, 80));
  if (!comp) return null;
  const joiner = "(?:\\+|\\bx\\b|\\u00D7|<>|\\u2764\\uFE0F?|\\u2665)";
  shapesBuilt = {
    siteName: new RegExp(`\\s*[|\\u2013\\u2014-]\\s*${comp}(?:\\s+(?:customers?|case studies|customer stories|stories|blog))?\\s*$`, "i"),
    left: new RegExp(`^(.{2,60}?)\\s*(?:${joiner}|&|\\band\\b)\\s*${comp}$`, "i"),
    right: new RegExp(`^${comp}\\s*${joiner}\\s*(.{2,60})$`, "i"),
    chose: new RegExp(`^(.{2,60}?)\\s+(?:chooses|chose|selects|selected|switches to|switched to|picks|picked|adopts|adopted|deploys|deployed|goes with|went with|standardi[sz]es on|standardi[sz]ed on|moves to|moved to|trusts|relies on|rolls out|rolled out)\\s+${comp}\\b`, "i"),
  };
  shapesFor = competitor;
  return shapesBuilt;
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
  const shapes = headlineShapes(competitor);
  if (!shapes) return null;
  // A trailing site name ("... | Acme", "... - Acme Customers") is not part of the headline.
  t = t.replace(shapes.siteName, "").trim();
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

  const left = shapes.left.exec(t);
  if (left) return cleanCompanyName(left[1], 3);
  const right = shapes.right.exec(t);
  if (right) return cleanCompanyName(right[1], 3);

  const chose = shapes.chose.exec(t);
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
  // A story's slug is a few words (`caseSlugOf` gives none longer than 120 characters).
  if (slug.length > 200) return null;
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

const WORD_CHAR_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_CHAR_AFTER = /^[\p{L}\p{N}]/u;

/**
 * Finds a slug's name as a page writes it ("GlobeX", "Globex Corp."): given a text, returns
 * the name as spelled there, or null when the text does not contain it as a word of its
 * own. Built once per slug and used on every piece of text around its link. The pattern is
 * the slug's plain words (always a-z and digits); the letters around a match are checked
 * afterwards, which keeps the pattern cheap to build for a page with thousands of links.
 */
function speller(tokens: string[]): (text: string) => string | null {
  if (!tokens.length) return () => null;
  // "reed-and-mackay" is "Reed & Mackay" on the page: a joining word the address dropped may stand between the name's words.
  const re = new RegExp(tokens.map(escapeRegExp).join("(?:[\\s\\-_.]{0,2}|\\s{0,20}(?:&|\\+|and)\\s{0,20})"), "gi");
  return (text) => {
    if (!text) return null;
    const t = text.slice(0, 2000);
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const end = m.index + m[0].length;
      if (!WORD_CHAR_BEFORE.test(t.slice(Math.max(0, m.index - 2), m.index)) && !WORD_CHAR_AFTER.test(t.slice(end, end + 2))) return m[0];
      re.lastIndex = m.index + 1;
    }
    return null;
  };
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
    "\\b(?:customers|clients|companies|teams|brands|businesses|organi[sz]ations|startups|enterprises)\\s+(?:like|such as|including|who (?:trust|use|love|rely)|that (?:trust|use|love|rely)|using|trust|trusting|love|loving|rely on|relying on|of all sizes)\\b",
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

/** A heading over what customers say: "What our customers say", "Testimonials", "Wall of love", "People \u2764 Acme". */
const VOICES_LABEL =
  /\bwhat\s+(?:our\s+|your\s+)?(?:customers|clients|users|people|teams|they)\s+(?:say|are\s+saying|think|have\s+to\s+say)\b|\btestimonials?\b|\bwall\s+of\s+love\b|\b(?:customer|client|user)\s+(?:reviews|love|voices|feedback|quotes)\b|\bdon['\u2019]?t\s+(?:just\s+)?take\s+our\s+word\b|\bhear\s+(?:it\s+)?from\s+(?:our\s+)?(?:customers|clients|users)\b|\bin\s+their\s+(?:own\s+)?words\b|\b(?:people|customers|clients|teams|users|developers|founders|companies)\s*(?:love|loves|\u2764|\u2665|[\u{1F493}-\u{1F49F}]|\u{1F60D})/iu;

const NEGATIVE_LABEL =
  /\b(?:integrat\w*|partners?|partnerships?|investors?|backed by|funded by|as (?:seen|featured) (?:in|on)|featured (?:in|on)|in the (?:news|press)|press|media coverage|awards?|recogni[sz]ed by|certifi\w*|complian\w*|works with|connects? (?:with|to)|built (?:with|on)|powered by|tech(?:nology)? stack|sponsors?|sponsored|marketplace|plug-?ins?|add-?ons?|our team|leadership|advisors?|board of|members? of|accredit\w*|badges?|reviews? on|rated on|available on|download on|supported (?:platforms|tools|apps)|compatible with|ecosystem|alumni|speakers?|contributors?|resellers?|vendors?|suppliers?|data sources?|destinations?|connectors?)\b/i;

const POSITIVE_CLASS = /^(?:(?:our[-_]?)?(?:customers?|clients?)(?:[-_]?(?:logos?|list|grid|wall|strip|carousel|slider|section|marquee|row|bar|cloud))?|logos?[-_](?:customers?|clients?)|trusted[-_]?by[\w-]*|social[-_]?proof[\w-]*)$/i;
const LOGO_CLASS = /^(?:logos?|logo[-_]?(?:wall|cloud|grid|strip|bar|garden|list|carousel|slider|row|marquee|section|ticker|band)[\w-]*)$/i;
const NEGATIVE_CLASS = /partner|integrat|investor|press|media|award|badge|certif|security|complian|tech-?stack|sponsor|marketplace|app-?store|payment/i;

const CHROME_CLASS = /^(?:nav|header|masthead|navbar[\w-]*|navigation[\w-]*|main-nav[\w-]*|site-nav[\w-]*|top-?nav[\w-]*|menu|main-menu[\w-]*|mobile-menu[\w-]*|mega-?menu[\w-]*|footer[\w-]*|site-footer[\w-]*|site-header[\w-]*|page-footer[\w-]*|global-(?:header|footer|nav)[\w-]*|topbar|top-bar|announcement[\w-]*|cookie[\w-]*|consent[\w-]*|gdpr[\w-]*|breadcrumbs?|sidebar[\w-]*|socials?|social-(?:links?|icons?|media|share)[\w-]*|share-(?:buttons?|links?)[\w-]*|skip-link[\w-]*|modal[\w-]*|popup[\w-]*)$/i;

/** Asked of the same element again and again (by everything under it), so each is worked out once. */
const TOKENS = new WeakMap<Node, string[]>();
const classTokens = (n: Node): string[] => {
  let tokens = TOKENS.get(n);
  if (!tokens) TOKENS.set(n, (tokens = `${attr(n, "class")} ${attr(n, "id")}`.split(/\s+/).filter(Boolean)));
  return tokens;
};

const LABELS = new WeakMap<Node, string>();
/** Text of a short, picture-free element that can act as the label of what follows it. */
function labelText(n: Node): string {
  let label = LABELS.get(n);
  if (label === undefined) LABELS.set(n, (label = readLabel(n)));
  return label;
}
function readLabel(n: Node): string {
  if (n.type !== "tag") return "";
  // A label is 3 to 140 characters. An element with no words, one character of them, or far more than a label's worth is not read to find that out.
  if (n.blank !== undefined || (n.solid !== undefined && (n.solid < 2 || n.solid > 600))) return "";
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

/**
 * What a site builder calls the layer a logo is drawn on, when the logo is not an image
 * with a description: Framer writes it as `data-framer-name`, other tools as `data-name`.
 * Most layers are furniture ("Icon Wrapper", "Line", "64px", "Variant 1"); those are not names.
 */
const LAYER_FURNITURE =
  /^(?:icon|image|img|logo|logos|svg|vector|frame|group|rectangle|ellipse|circle|line|plus|minus|dot|divider|spacer|wrapper|container|row|column|item|card|default|variant|primary|secondary|desktop|tablet|phone|mobile|light|dark|bg|background|mask|shape|path|arrow|chevron|star|check|button|label|text|heading|header|footer|content|avatar|photo|picture|placeholder|ticker|slide|slider|carousel|marquee|open|closed|selected|unselected|hover|normal|highlight|highlighted|top|bottom|left|right|on|off|empty|main|section|layer|component|grid|stack|padding|margin|gap)(?:$|[\s_/-])|(?:wrapper|container|icon|icons|image|button|divider|grid|section|card|component|group|frame|layer|logos|background|box|block|list|stack)$|^\d|\d+px\b/i;
const layerName = (n: Node): string => attr(n, "data-framer-name") || attr(n, "data-name");
const isPicture = (n: Node): boolean =>
  isTag(n, "img", "svg", "picture", "canvas") || attr(n, "role") === "img" || /^(?:svg|image)$/i.test(attr(n, "data-framer-component-type")) || /background-image/i.test((n.attribs?.style ?? "").slice(0, 400));

const LOGOS = new WeakMap<Node, LogoItem | null>();
/** The description a logo carries (alt, aria-label, title), or null for anything that is not a nameable logo. */
function logoItem(n: Node): LogoItem | null {
  let item = LOGOS.get(n);
  if (item === undefined) LOGOS.set(n, (item = readLogo(n)));
  return item;
}
function readLogo(n: Node): LogoItem | null {
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
  // A named layer that holds a picture, no words and no other named layer: the layer's name is what the picture shows.
  const layer = layerName(n);
  if (layer && layer.length >= 2 && layer.length <= 60 && n.blank !== undefined && !LAYER_FURNITURE.test(layer)) {
    const inner = descendants(n, 14);
    if (inner.length > 12 || inner.some((d) => layerName(d))) return null;
    // A picture with a description of its own is read by that description, above.
    if (inner.some((d) => isTag(d, "img") && (attr(d, "alt") || attr(d, "aria-label") || attr(d, "title")))) return null;
    if (!isPicture(n) && !inner.some(isPicture)) return null;
    return { node: n, raw: layer, explicit: /logo|brand|wordmark/i.test(`${layer} ${around}`) };
  }
  return null;
}

/**
 * Words a picture's file name carries about the picture and not about the company: what it
 * is, its variant, its colour, its size, its format.
 */
const FILE_VARIANT = new Set(
  (
    "logo logos logotype logomark wordmark mark icon full dark light white black color colour colored coloured grey gray greyscale grayscale mono monochrome " +
    "inverted inverse reversed negative transparent svg png jpg jpeg webp gif avif img image small large sm md lg xl 1x 2x 3x 4x x2 x3 rgb cmyk horizontal " +
    "vertical stacked square primary secondary default new final copy min hd"
  ).split(" "),
);
const FILE_PREFIX = new Set("logo logos client clients customer customers company brand img image icon".split(" "));
/** A size or a version in a file name: "200", "120x40", "64px", "v2", "02". */
const FILE_NUMBER = /^(?:\d+|\d+x\d+|\d+px|\d+w|v\d+)$/;
/**
 * Everyday words that brands are made of in pairs. A file name gives no capitals and no
 * spaces: "angelone" is Angel One, "dropbox" is Dropbox, and nothing in the file name says
 * which. A single word of a file name that is two of these run together is not reported.
 */
const COMPOUND_WORDS = new Set(
  (
    "angel one two three first next credit bank capital pay money cash card fund loan trade market shop store cart sales force work works day time life " +
    "health care book face note page word press post mail snow flake cloud flare air table drop box hub spot zen desk zoom info mix panel sound data base " +
    "soft ware net web link site line point view vision sight light house home land sea sky sun moon star fire water rock stone wood tree leaf green blue " +
    "red gold silver bright smart quick fast easy simple clear pure true safe sure open free high big new good best top prime main core edge side way path " +
    "road bridge gate door key lock pass port ship boat car auto bike fly jet move run walk jump step lab labs tech logic mind brain think idea plan team " +
    "club group zone space place map guide scout pilot hero king queen master chief boss max plus ultra super mega micro mini nano grand great happy lucky " +
    "wise bold brave cool fresh clean bit byte code dev app apps cyber digital media news tube flix play game pixel photo video music radio cast stream " +
    "chat talk call voice text sign form sheet doc docs file drive sync stack flow grid chart graph metric count track trace watch guard shield secure " +
    "trust proof check mark stamp seal badge deal lead leads grow growth scale rise peak mount hill wave tide river lake ocean bay coast shore farm field " +
    "garden flower bloom seed root branch bird bee wolf fox bear lion tiger eagle hawk owl cat dog horse fish door wall roof floor room office school " +
    "college class course learn teach study tutor skill job hire talent people human person kid baby family friend buddy mate pal crowd tribe nation " +
    "world globe earth planet city town village metro urban local express rapid swift turbo power energy fuel charge volt spark flash glow shine beam ray"
  ).split(/\s+/),
);
/** Written like a file's name, not like a name: lower case, no spaces ("hdfc-securities-logo", "angelone_logo", "pw"). */
const writtenAsFileName = (s: string): boolean => /^[a-z0-9]+(?:[-_.+][a-z0-9]+)*$/.test(s);
/** An abbreviation spelled in a file name: a few consonants with no vowel between them ("hdfc", "tvs", "kpmg"). */
const isInitials = (t: string): boolean => /^[bcdfghjklmnpqrstvwxz]{2,5}$/.test(t);
const twoWordsRunTogether = (t: string): boolean => {
  if (t.length < 6 || t.length > 24 || !/^[a-z]+$/.test(t)) return false;
  for (let i = 3; i <= t.length - 3; i++) if (COMPOUND_WORDS.has(t.slice(0, i)) && COMPOUND_WORDS.has(t.slice(i))) return true;
  return false;
};

/**
 * The company a logo's description names, or null: "Globex logo", "logo of Globex",
 * "globex-logo-white.svg". `fromFileName` says the description was a file's name rather
 * than words somebody wrote: such a name is rebuilt without its capitals and spaces, so
 *
 * - what the file name says about the picture goes ("voltage-park-logo-full" is Voltage Park),
 * - an abbreviation gets its capitals back ("hdfc-securities" is HDFC Securities, "tvscredit" TVS Credit),
 * - fewer than four letters name nobody ("pw"),
 * - one word that is two everyday words run together is not guessed at ("angelone"),
 *
 * and whoever reports it ranks it below a name the page wrote out.
 */
export function readLogoName(raw: string): { name: string; fromFileName: boolean } | null {
  let s = cleanLine(raw, 160);
  if (!s || NOT_A_CUSTOMER_ALT.test(s)) return null;
  s = s.replace(/\.(?:svg|png|jpe?g|webp|gif|avif)$/i, "");
  if (writtenAsFileName(s)) {
    let tokens = s.split(/[-_.+]+/).filter(Boolean);
    while (tokens.length > 1 && FILE_PREFIX.has(tokens[0])) tokens = tokens.slice(1);
    while (tokens.length && (FILE_VARIANT.has(tokens[tokens.length - 1]) || FILE_NUMBER.test(tokens[tokens.length - 1]))) tokens = tokens.slice(0, -1);
    tokens = tokens.filter((t) => t !== "logo" && t !== "logos");
    if (!tokens.length || tokens.length > 5) return null;
    if (tokens.join("").replace(/[^a-z]/g, "").length < 4) return null;
    if (tokens.length === 1) {
      const t = tokens[0];
      if (twoWordsRunTogether(t)) return null;
      // "tvscredit": an abbreviation and a word.
      for (let i = 2; i <= 4 && i <= t.length - 4; i++) {
        if (isInitials(t.slice(0, i)) && COMPOUND_WORDS.has(t.slice(i))) {
          tokens = [t.slice(0, i), t.slice(i)];
          break;
        }
      }
    }
    const name = cleanCompanyName(tokens.map((t) => (isInitials(t) ? t.toUpperCase() : /^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t)).join(" "), 4);
    return name ? { name, fromFileName: true } : null;
  }
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
  const name = cleanCompanyName(s, 4);
  return name ? { name, fromFileName: false } : null;
}

/** The name alone (see `readLogoName`). */
export function cleanLogoName(raw: string): string | null {
  return readLogoName(raw)?.name ?? null;
}

/* ───────────────────────────────── cards and headlines ───────────────────────────────── */

const INLINE = new Set("b i em strong u mark small sup sub span abbr code br wbr font time".split(" "));
const TITLED_CLASS = /(?:^|[\s_-])(?:title|heading|headline)(?:$|[\s_-])/i;
const NAMED_CLASS = /(?:^|[\s_-])(?:name|company|customer-?name|client-?name)(?:$|[\s_-])/i;
const NOT_TEXT = new Set(["img", "svg", "picture", "video", "audio", "canvas", "style", "script", "noscript", "template"]);

interface Segment {
  text: string;
  node: Node;
  /** A heading element, or an element whose class calls it a title. */
  heading: boolean;
  /** An element whose class says it holds a name. */
  named: boolean;
}

/**
 * The separate pieces of text inside a card, each as the page wrote it.
 *
 * A card is a tag ("SaaS"), a headline, a date and a teaser side by side. Read as one line
 * they become "SaaS Olo's Recipe for Success ..." - a name and a headline nobody wrote. So
 * every element that carries words of its own is one piece (with its bold and italic
 * parts), and elements that only hold other elements are looked into, not read across.
 */
function segmentsOf(root: Node, max = 60): Segment[] {
  const out: Segment[] = [];
  // The lists of elements being looked into and how far into each (children are taken one at a time).
  const lists: Node[][] = [[root]];
  const at: number[] = [0];
  while (lists.length && out.length < max) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const n = lists[top][at[top]++];
    // An element with no words in it holds no piece of text.
    if (n.type !== "tag" || n.blank !== undefined || NOT_TEXT.has(n.name ?? "")) continue;
    const kids = n.children ?? [];
    const ownText = kids.some((c) => c.type === "text" && /\S/.test(c.data ?? ""));
    const structural = kids.some((c) => c.type === "tag" && !INLINE.has(c.name ?? ""));
    if (isHeading(n) || (ownText && !structural)) {
      const text = lineOf(n, 400);
      if (text) {
        const near = [n, ...ancestors(n, 2)];
        const heading = near.some((a) => isHeading(a)) || near.slice(0, 2).some((a) => TITLED_CLASS.test(attr(a, "class")));
        const named = near.slice(0, 2).some((a) => NAMED_CLASS.test(attr(a, "class")));
        out.push({ text, node: n, heading, named });
      }
      continue;
    }
    if (ownText) {
      for (const c of kids) {
        const text = c.type === "text" ? cleanQuote(c.data ?? "", 400) : "";
        if (text) out.push({ text, node: n, heading: false, named: false });
      }
    }
    lists.push(kids);
    at.push(0);
  }
  return out;
}

const TITLE_WORDS = /\b(?:ceo|cto|cfo|coo|cmo|cro|cpo|cio|ciso|founder|co-?founder|director|head|vp|vice president|manager|lead|chief|president|officer|engineer|designer|owner|partner|principal|analyst|specialist|consultant|marketer|recruiter|developer|architect|administrator|coordinator|executive|strategist)\b/i;

/** "Director of Business Development, Unipart": who said something, not what a story is called. */
function isAttributionLine(t: string): boolean {
  const tokens = t.split(" ");
  if (tokens.length > 14 || !TITLE_WORDS.test(t)) return false;
  if (/^(?:how|why)\b/i.test(t) || tokens.some((x) => isVerb(x))) return false;
  return /,\s|\s(?:at|@)\s|\s[-\u2013\u2014|\u00B7]\s/.test(t);
}

const SECTION_LABEL = "(?:customer\\s+(?:success\\s+)?stor(?:y|ies)|(?:customer\\s+)?case\\s+stud(?:y|ies)|customers|clients|success\\s+stor(?:y|ies)|client\\s+stor(?:y|ies)|testimonials?|customer\\s+spotlight|spotlight|story)";
/** "Globex - Customer Stories", "Case study: Globex", "Globex case study": a name with a label, not a headline. */
const TITLE_SHAPE = new RegExp(
  `^(?:${SECTION_LABEL}\\s*[:|\\u2013\\u2014-]\\s*.{2,80}|.{2,80}?\\s*[:|\\u00B7\\u2013\\u2014-]\\s*${SECTION_LABEL}(?:\\s*[|\\u00B7\\u2013\\u2014-]\\s*.{1,60})?|.{2,60}\\s+(?:customer\\s+(?:success\\s+)?story|(?:customer\\s+)?case\\s+study|success\\s+story|customer\\s+spotlight|client\\s+story))$`,
  "i",
);

const ENGLISH_WORDS = new Set(
  "the of to in for with and by on how why from their its is are at as into more than after using through over without up out our your that this it was be has have helps helped can will not all new".split(" "),
);
const FOREIGN_WORDS = new Set(
  (
    "de la le les des du et con com para por el los las da dos nas um uma und der mit f\u00FCr fuer von zu auf im bei wie comment c\u00F3mo como su sus sua seu " +
    "pour avec sur dans che della delle dei het een met voor och p\u00E5 f\u00F6r att til og ist sind est sont m\u00E1s mais pela pelo ao aos seus suas nach \u00FCber " +
    "durch ohne gr\u00E2ce gracias mediante entre sobre desde hasta e y"
  ).split(/\s+/),
);

/**
 * Is this headline written in English? A sentence built with it is English, so a headline
 * in another language is not quoted inside it. Counted, not guessed: the small words of
 * other languages against the small words of English, and letters of other scripts.
 */
function looksEnglish(t: string): boolean {
  const letters = t.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (latin / letters.length < 0.7) return false;
  let english = 0;
  let foreign = 0;
  for (const raw of t.split(/\s+/)) {
    const w = word(raw);
    if (!w) continue;
    if (ENGLISH_WORDS.has(w)) english++;
    else if (FOREIGN_WORDS.has(w)) foreign++;
    // An accented word in lower case is a word of another language; capitalised it may be a name.
    else if (/^\p{Ll}/u.test(raw) && /[^\u0000-\u007F]/.test(w) && /\p{L}/u.test(w)) foreign++;
  }
  return !(foreign >= 2 && foreign > english);
}

const CALL_TO_ACTION = /^(?:download|read|watch|view|see|learn|get|explore|discover|book|request|start|try|contact|sign up|subscribe|click|listen|meet|join|browse|check out)\b/i;
const FIRST_PERSON = /\b(?:we|our|us|i|my|me)\b|\b(?:we|i)['\u2019](?:ve|re|m|d|ll)\b/i;

type HeadKind = "headline" | "attribution" | "title" | null;

/**
 * What a piece of text is in a sentence about a case study.
 *
 * "headline": it can be quoted as the name of the case study - it is a heading on the
 * page, or loose text that reads like a headline about the company. "attribution": the
 * line under a quote. "title": a name with a section label. null: none of those (a tag, a
 * date, a teaser paragraph, a pull quote, a headline in another language).
 */
function headKind(text: string, opts: { heading: boolean; name?: string }): HeadKind {
  const t = cleanLine(text, 400);
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length < 2 || t.length > 200) return null;
  if (isAttributionLine(t)) return "attribution";
  const verbs = tokens.some((x) => isVerb(x));
  const opener = /^(?:how|why)\b/i.test(t);
  if (!verbs && !opener && TITLE_SHAPE.test(t)) return "title";
  if (tokens.length < 3 || t.length < 12) return null;
  if (/^["\u201C\u2018\u00AB]/.test(t) || !looksEnglish(t)) return null;
  // "Download the full Globex story", "Read more about ...": a button, whatever element it is in.
  if (CALL_TO_ACTION.test(t)) return null;
  if (opts.heading) return "headline";
  if (FIRST_PERSON.test(t) || /[.!?]\s+\p{Lu}/u.test(t) || /(?:\.\.\.|\u2026)$/.test(t)) return null;
  if (tokens.length < 4 || t.length > 160) return null;
  if (opener) return "headline";
  return verbs && !!opts.name && t.toLowerCase().includes(opts.name.toLowerCase()) ? "headline" : null;
}

const NOT_NAME_PART = /^(?:ceo|cto|cfo|coo|cmo|cro|cpo|cio|founder|co-?founder|president|vp|svp|evp|director|head|manager|gtm|sdr|sdrs|bdr|bdrs|ae|aes|hr|pr|b2b|b2c|saas|crm|revops|sales|marketing|team|teams|engineering|support|success|product|growth|ops|operations|customer|customers|case|story|logo|photo|image)$/i;
const FUNCTION_WORDS = new Set("with from into over that than their your while after before through without using across about when where which what this these those have been were they them then also only just more most some such very".split(" "));

/** Written like a sentence (most words in lower case) rather than In Title Case. */
function sentenceCase(tokens: string[]): boolean {
  let lower = 0;
  for (const t of tokens) {
    const w = word(t);
    if (w.length >= 4 && /^\p{Ll}/u.test(t) && !FUNCTION_WORDS.has(w)) lower++;
  }
  return lower >= 2;
}

/**
 * The rest of a company's name, when the text carries on after the part the story's address
 * gave: "Echo" in "How Echo Global Logistics saved 1,000 hours" is "Echo Global Logistics",
 * "Flo" in "Flo Health, makers of ..." is "Flo Health".
 *
 * Only when the text itself shows where the name ends: at a comma or the end of the text,
 * at a verb, or - in text written as a sentence - at the first word in lower case. In a
 * headline In Title Case every word has a capital, so only a known verb ends a name there.
 * At most two more words; anything less clear leaves the name as it was. In running text
 * (`commaOnly`) capitals are too common to trust - "the Golden State Consumer Products
 * team" - so only a comma right after the name counts there.
 */
function extendName(text: string, spelled: string, opts: { commaOnly?: boolean } = {}): string | null {
  const at = text.indexOf(spelled);
  if (at < 0) return null;
  const after = text.slice(at + spelled.length);
  if (!/^\s+\S/.test(after)) return null;
  const tokens = after.trim().split(/\s+/);
  const all = text.split(/\s+/);
  const asSentence = sentenceCase(all);
  const extra: string[] = [];
  let ended = false;
  for (let i = 0; i < tokens.length && i <= 3; i++) {
    const t = tokens[i];
    const bare = t.replace(/[,;:!?)\]]+$|\.$/, "");
    if (!bare || /^[-\u2013\u2014|\u00B7(&+/]/.test(t)) {
      ended = extra.length > 0 && asSentence;
      break;
    }
    if (isVerb(bare, true)) {
      ended = !opts.commaOnly;
      break;
    }
    if (!/^[\p{Lu}\p{N}]/u.test(bare)) {
      ended = asSentence && !opts.commaOnly;
      break;
    }
    // A job, a department or a figure after the name is about the company, not part of its name.
    if (isAudienceWord(bare) || POSSESSIVE.test(bare) || NOT_NAME_PART.test(bare) || !/^[\p{L}][\p{L}\p{N}.&'\u2019-]*$/u.test(bare)) return null;
    extra.push(bare);
    if (bare !== t) {
      // "Flo Health, makers of ...": a comma ends a name in a sentence. In A Title Case Headline, Commas Separate Anything.
      ended = asSentence;
      break;
    }
    if (i === tokens.length - 1) ended = all.length <= 6 && !opts.commaOnly;
  }
  if (!ended || !extra.length || extra.length > 2) return null;
  return cleanCompanyName(`${spelled} ${extra.join(" ")}`, 5);
}

/** The slug's words when the slug could be a name (no "how-...", no verbs, a handful of words), or null. */
function slugNameTokens(slug: string, competitor: string): string[] | null {
  const compTokens = new Set(cleanLine(competitor, 80).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let tokens = slug.toLowerCase().split(/[-_+.\s]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 8) return null;
  if (/^(?:how|why|what|when|where|the|a|an|our|your|\d+)$/.test(tokens[0])) return null;
  tokens = tokens.filter((t) => !SLUG_FILLER.has(t) && !compTokens.has(t));
  if (!tokens.length || tokens.length > 5) return null;
  if (tokens.some((t) => VERBS.has(t) || SLUG_ACTION.has(t) || t.length > 30 || !/^[a-z0-9]+$/.test(t))) return null;
  return tokens;
}

/**
 * A headline often shortens the name the story's address spells in full: "How Coca-Cola
 * drove change" under /customers/coca-cola-peninsula-beverages is about Coca-Cola Peninsula
 * Beverages, a different company from Coca-Cola. When the address starts with the
 * headline's name and goes on with words that are not page furniture, the longer name is
 * the one reported.
 */
function nameWithSlugRest(name: string, slug: string, competitor: string): string | null {
  const tokens = slugNameTokens(slug, competitor);
  const key = normCompanyName(name);
  if (!tokens || !key) return null;
  let joined = "";
  for (let i = 0; i < tokens.length - 1; i++) {
    joined += tokens[i];
    if (joined.length > key.length) return null;
    if (joined !== key) continue;
    const rest = tokens.slice(i + 1);
    if (rest.length > 3 || rest.every((t) => isGenericWord(t) || isAudienceWord(t))) return null;
    return cleanCompanyName(`${name} ${slugToName(rest.join("-"))}`, 6);
  }
  return null;
}

/**
 * A brand that writes itself in lower case ("How ivision transformed ...") is still a name
 * when the story's own address is that word and the headline uses it as its subject.
 */
function lowerCaseSubject(text: string, spelled: string, wholeSlug = false): boolean {
  // Four letters or more - or three when the word is the story's whole address ("How n8n built ..." under
  // /customers/n8n): no everyday word of three letters is a story's address by chance.
  if (spelled.length < (wholeSlug ? 3 : 4) || isGenericWord(spelled) || isAudienceWord(spelled)) return false;
  if (ENGLISH_WORDS.has(spelled.toLowerCase()) || FUNCTION_WORDS.has(spelled.toLowerCase())) return false;
  const m = new RegExp(`^(?:how|why)\\s+${escapeRegExp(spelled)}\\s+(\\S+)`, "i").exec(text);
  return !!m && isVerb(m[1], true);
}

/**
 * Does the story's address carry this name, or a word of it? "How Globex cut costs" on a
 * card that leads to /customers/globex is about Globex. "Volume increase supported" - a
 * figure's caption on a card that leads to /customers/n8n - reads the same way to
 * `parseHeadline` ("Volume" did something), and is about nobody.
 */
function slugCarries(slug: string, name: string): boolean {
  const flat = slug.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const key = normCompanyName(name);
  if (key.length >= 3 && flat.includes(key)) return true;
  const inSlug = new Set(slug.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const raw of words) {
    const t = raw.toLowerCase();
    if (t.length < 2 || isGenericWord(t) || isAudienceWord(t) || ENGLISH_WORDS.has(t)) continue;
    if (inSlug.has(t) || (t.length >= 4 && flat.includes(t))) return true;
  }
  // The address may be the name's initials: /customer-stories/csw for Central Storage & Warehouse.
  const initials = words.filter((w) => !CONNECTING_WORDS.has(w.toLowerCase())).map((w) => w[0].toLowerCase()).join("");
  return initials.length >= 3 && inSlug.has(initials);
}
const CONNECTING_WORDS = new Set(["and", "of", "the", "for", "de", "la"]);

/** Is this name written in the text as a word of its own (not as part of a longer word)? */
function saysName(text: string, name: string): boolean {
  const t = text.slice(0, 2_000).toLowerCase();
  const n = name.toLowerCase();
  for (let at = t.indexOf(n); at >= 0; at = t.indexOf(n, at + 1)) {
    if (!WORD_CHAR_BEFORE.test(t.slice(Math.max(0, at - 2), at)) && !WORD_CHAR_AFTER.test(t.slice(at + n.length, at + n.length + 2))) return true;
  }
  return false;
}

/** Does the story's address spell this name ("/customers/cloudflare" for Cloudflare, ".../olos-recipe" for Olo)? */
function slugNames(slug: string, name: string): boolean {
  const key = normCompanyName(name);
  if (key.length < 3) return false;
  const tokens = slug.toLowerCase().split(/[-_+.\s]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let j = i; j < tokens.length && joined.length < key.length + 1; j++) {
      joined += tokens[j];
      if (joined === key || joined === `${key}s`) return true;
    }
  }
  return false;
}

const storyKey = (url: string): string => url.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(?:www\.)?/i, "").toLowerCase();

/* ───────────────────────────────── the page ───────────────────────────────── */

const MAX_HITS_PER_PAGE = 120;
/** How sure a logo named only by its file's name is: less than the least sure logo named in words (0.45), whatever label it stands under. */
const FILE_NAME_CONFIDENCE = 0.4;
/** The same for a picture that does not say it is a logo. */
const FILE_NAME_CONFIDENCE_PLAIN = 0.35;
const NOT_A_CUSTOMER_ROLE = /\b(?:investor|analyst at|journalist|editor|reporter|board member|advisor|adviser|venture partner|general partner)\b/i;

/**
 * Is a story's address worth opening to learn who it is about? Yes when its last part
 * could be a company's name ("/customers/tyrell") or is a headline ("/customers/how-lative-
 * cut-..."). No when it is made of everyday words ("/customers/healthcare",
 * "/customers/remote-teams", "/customers/become-a-reference"): that is a category or a
 * form, and asking the site for it tells us nothing.
 */
export function storyWorthOpening(url: string, competitor: string): boolean {
  let slug: string | null;
  if (url.length > MAX_PATH) return false;
  try {
    slug = caseSlugOf(new URL(url).pathname);
  } catch {
    return false;
  }
  if (!slug) return true;
  const named = slugCustomerName(slug, competitor);
  // "gattaca-travel" has an everyday word in it and may still be a company; "trusted-health" is nothing but everyday words.
  if (named) return !named.tokens.every((t) => isGenericWord(t) || isAudienceWord(t));
  // Not a bare name: a headline then ("docusign-accelerates-growth"), unless every word of it is page furniture.
  const tokens = slug.toLowerCase().split(/[-_+.\s]+/).filter(Boolean);
  return !tokens.every((t) => t.length <= 2 || SLUG_ACTION.has(t) || VERBS.has(t) || isGenericWord(t) || isAudienceWord(t));
}

/** Of two sightings of one customer, the one to show: the surer, and of two equally sure the one with a headline. */
export function pickEvidence<T extends { confidence: number; headline?: string }>(have: T, next: T): T {
  if (next.confidence !== have.confidence) return next.confidence > have.confidence ? next : have;
  return !have.headline && next.headline ? next : have;
}

/** One story's address in the form two sightings of it are compared by. */
export const storyKeyOf = (url: string): string => storyKey(url);

export function extractCustomers(html: string, pageUrl: string, competitor: { name: string; domain: string }): PageExtraction {
  const empty: PageExtraction = { hits: [], links: [], text: "", title: "", customerPage: false, told: [], siteLinks: 0 };
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return empty;
  }
  const $ = loadHtml(String(html ?? ""), MAX_PAGE_CHARS);
  if (!$) return { ...empty, unreadable: true };
  const customerPage = isCustomerPath(base.pathname);
  const pageSlug = caseSlugOf(base.pathname);
  const hits = new Map<string, CustomerHit>();

  /** Which name each story is filed under: one story is about one customer. */
  const byStory = new Map<string, string>();
  /** Stories whose card on this page already says who the customer is. */
  const told = new Set<string>();
  let attempts = 0;

  const add = (hit: CustomerHit): void => {
    attempts++;
    if (hits.size >= MAX_HITS_PER_PAGE) return;
    const name = cleanCompanyName(hit.name);
    const quote = cleanQuote(hit.quote, 500);
    if (!name || !quote) return;
    if (isSameCompany(name, competitor)) return;
    // The never-a-customer list gives way only to a story whose own address names the company.
    if (isVendorName(name) && !hit.dedicated) return;
    // "Environmental Services Company", "A Pharmadata Company": a story about a customer the page does not name.
    if (isDescriptorName(name, quote)) return;
    const key = normCompanyName(name);
    if (!key || key.length < 2) return;
    let next: CustomerHit = { ...hit, name, quote, ...(hit.headline ? { headline: cleanLine(hit.headline, 200) } : {}) };
    const story = next.storyUrl ? storyKey(next.storyUrl) : "";
    const filed = story ? byStory.get(story) : undefined;
    if (filed && filed !== key && hits.has(filed)) {
      // The same story under a second name ("UNREAL", "UNREAL Snacks"): the fuller name is the
      // company's, and the better evidence is kept under it. Two unrelated names: the surer one stays.
      const other = hits.get(filed)!;
      const better = pickEvidence(other, next);
      if (key.startsWith(filed)) {
        hits.delete(filed);
        next = { ...better, name, domain: next.domain ?? other.domain, dedicated: next.dedicated || other.dedicated };
      } else if (filed.startsWith(key)) {
        hits.set(filed, { ...better, name: other.name, domain: other.domain ?? next.domain, dedicated: next.dedicated || other.dedicated });
        return;
      } else if (next.confidence > other.confidence) {
        hits.delete(filed);
      } else {
        return;
      }
    }
    if (story) byStory.set(story, key);
    const have = hits.get(key);
    if (!have) hits.set(key, next);
    else {
      const better = pickEvidence(have, next);
      hits.set(key, { ...better, domain: better.domain ?? have.domain ?? next.domain, storyUrl: better.storyUrl ?? have.storyUrl ?? next.storyUrl, dedicated: have.dedicated || next.dedicated || undefined });
    }
  };

  /** No more names are taken from this page: from here on reading it further changes nothing. */
  const full = (): boolean => hits.size >= MAX_HITS_PER_PAGE;

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
  const links = new Map<string, CrawlLink>();
  /** Pages of the same site, outside this page's own section, that it links to. */
  const elsewhere = new Set<string>();
  const ownPath = base.pathname.replace(/\/+$/, "").toLowerCase();
  $("a[href]").each((_, el) => {
    if (links.size >= 400 && elsewhere.size >= 40) return;
    const u = resolveLink($(el).attr("href"), base.href);
    if (!u || !sameSite(u.href, competitor.domain)) return;
    if (elsewhere.size < 40) {
      const path = u.pathname.replace(/\/+$/, "").toLowerCase();
      if (path !== ownPath && !(ownPath && path.startsWith(`${ownPath}/`))) elsewhere.add(path);
    }
    if (links.size >= 400) return;
    u.search = "";
    const score = crawlScore(u);
    if (score <= 0) return;
    const key = u.toString().replace(/\/$/, "");
    if (key === base.toString().replace(/[?#].*$/, "").replace(/\/$/, "")) return;
    // Kept as the page writes it (trailing slash and all), so reading it later is not answered with a redirect.
    const have = links.get(key);
    if (!have || score > have.score) links.set(key, { url: u.toString(), score });
  });

  /* Everything that is not the page's own content goes before any name is read. */
  const root = $.root().get(0) as unknown as Node;
  const bodyEl = $("body").get(0) as unknown as Node | undefined;
  const sizes = dropNonContent(root);
  let attached: Node | null | undefined = bodyEl;
  while (attached && attached !== root) attached = attached.parent;
  const bodyNode: Node = bodyEl && attached === root ? bodyEl : root;
  const whole = sizes.get(bodyNode);
  const fullLength = (whole && whole.text < MAX_TEXT ? whole.raw : rawText(bodyNode).length) || 1;
  dropWhere(root, (n) => {
    if (isTag(n, "body", "html", "main")) return false;
    if (!classTokens(n).some((t) => CHROME_CLASS.test(t))) return false;
    // A wrapper around most of the page that merely mentions "nav" in a class is not the navigation.
    const size = sizes.get(n);
    return !!size && size.text < MAX_TEXT && size.raw <= fullLength * 0.5;
  });
  markBlank(root);

  const text = tidyLines(rawText(bodyNode)).slice(0, 60_000);
  const flat = text.replace(/\s+/g, " ");
  const all = descendants(bodyNode, 6000);
  const indexOf = new Map<Node, number>();
  all.forEach((n, i) => indexOf.set(n, i));
  /** For each element of `all`, the place of the last element inside it: its descendants are the stretch in between. */
  const lastInside = all.map((_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const up = all[i].parent ? indexOf.get(all[i].parent as Node) : undefined;
    if (up !== undefined && lastInside[i] > lastInside[up]) lastInside[up] = lastInside[i];
  }
  /** Is `n` inside `ancestor` (or the same element)? Looked up, not walked, for everything in `all`. */
  const inside = (ancestor: Node, n: Node): boolean => {
    const a = indexOf.get(ancestor);
    const b = indexOf.get(n);
    return a !== undefined && b !== undefined ? a <= b && b <= lastInside[a] : contains(ancestor, n);
  };
  /** An element's child elements and where each stands among them, listed once per parent. */
  const kidsOf = new Map<Node, { list: Node[]; at: Map<Node, number> }>();
  const tagKids = (parent: Node | null | undefined): { list: Node[]; at: Map<Node, number> } => {
    if (!parent) return { list: [], at: new Map() };
    let k = kidsOf.get(parent);
    if (!k) {
      const list = (parent.children ?? []).filter((c) => c.type === "tag");
      const at = new Map<Node, number>();
      list.forEach((c, i) => at.set(c, i));
      kidsOf.set(parent, (k = { list, at }));
    }
    return k;
  };
  const logoReads = new Map<string, { name: string; fromFileName: boolean } | null>();
  const logoRead = (raw: string): { name: string; fromFileName: boolean } | null => {
    let read = logoReads.get(raw);
    if (read === undefined) logoReads.set(raw, (read = readLogoName(raw)));
    return read;
  };
  const logoName = (raw: string): string | null => logoRead(raw)?.name ?? null;

  /* 1. Case-study links: /customers/globex, with the card around them. */
  const caseLinks = new Map<string, { anchors: Node[]; url: string }>();
  /** Where each link leads, when that is one of the site's own stories. Worked out once per link: it is asked again for every card around it. */
  const storyOf = new Map<Node, { key: string; url: URL } | null>();
  const storyLink = (a: Node): { key: string; url: URL } | null => {
    let story = storyOf.get(a);
    if (story === undefined) {
      const u = resolveLink(attr(a, "href"), base.href);
      story = u && sameSite(u.href, competitor.domain) && caseSlugOf(u.pathname) ? { key: u.pathname.replace(/\/$/, "").toLowerCase(), url: u } : null;
      storyOf.set(a, story);
    }
    return story;
  };
  for (const n of all) {
    if (!isTag(n, "a")) continue;
    const story = storyLink(n);
    if (!story) continue;
    const u = story.url;
    // A download ("/assets/customer-stories/Globex.pdf") is a file about a story, not the story's page.
    if (NOT_CUSTOMER_PATH.test(u.pathname.toLowerCase()) || FILE_EXT.test(u.pathname)) continue;
    const have = caseLinks.get(story.key);
    if (have) have.anchors.push(n);
    else caseLinks.set(story.key, { anchors: [n], url: `${u.origin}${u.pathname}` });
  }
  const storyCounts = new Map<Node, number>();
  /** How many different stories the links in an element lead to (its first 400 elements are looked at). */
  const caseLinkCount = (scope: Node): number => {
    let count = storyCounts.get(scope);
    if (count === undefined) {
      const seen = new Set<string>();
      for (const d of [scope, ...descendants(scope, 400)]) {
        const story = isTag(d, "a") ? storyLink(d) : null;
        if (story) seen.add(story.key);
      }
      storyCounts.set(scope, (count = seen.size));
    }
    return count;
  };
  interface Piece {
    text: string;
    node: Node;
    heading: boolean;
    logo?: boolean;
    /** From an element whose class says it holds a name. */
    named?: boolean;
    /** A picture that calls itself a logo (as opposed to a photo with a description). */
    explicit?: boolean;
  }
  /** The fuller name a card gives for a story's company: its logo first, then its words. */
  const fullerName = (spelled: string, pieces: Piece[]): { name: string; from: Piece } | null => {
    const key = normCompanyName(spelled);
    for (const p of pieces) {
      if (!p.logo || !p.explicit) continue;
      const n = logoName(p.text);
      if (n && n.split(" ").length <= spelled.split(" ").length + 2 && n.toLowerCase().startsWith(`${spelled.toLowerCase()} `) && normCompanyName(n) !== key) return { name: n, from: p };
    }
    for (const p of pieces) {
      // A photo's description ("Posted CEO Steven ...") is not where a company's name is spelled out.
      if (p.logo && !p.explicit) continue;
      const n = extendName(p.text, spelled, { commaOnly: !p.heading && !p.logo && !p.named });
      if (n && normCompanyName(n) !== key) return { name: n, from: p };
    }
    return null;
  };
  const mentionOf = (kind: HeadKind): CustomerHit["mention"] => (kind === "attribution" || kind === "title" ? kind : undefined);
  /** The pieces of text and the pictures in an element. Read once per element: a block shared by many links is not read again for each. */
  const scopes = new Map<Node, { segments: Piece[]; logos: Piece[] }>();
  const scopeOf = (scope: Node): { segments: Piece[]; logos: Piece[] } => {
    let read = scopes.get(scope);
    if (!read) {
      const segments: Piece[] = segmentsOf(scope).map((seg) => ({ text: seg.text, node: seg.node, heading: seg.heading, named: seg.named }));
      const logos: Piece[] = [];
      for (const d of [scope, ...descendants(scope, 120)]) {
        const item = logoItem(d);
        if (item) logos.push({ text: cleanLine(item.raw, 160), node: d, heading: false, logo: true, explicit: item.explicit });
      }
      scopes.set(scope, (read = { segments, logos }));
    }
    return read;
  };

  for (const [path, entry] of caseLinks) {
    const slug = caseSlugOf(path);
    if (!slug) continue;
    const { anchors, url: storyUrl } = entry;
    const before = attempts;
    const fromSlug = slugCustomerName(slug, competitor.name);
    // What the card says, piece by piece: the link's own text and pictures, then the card it sits in
    // (the smallest block holding only this story).
    const heads: Piece[] = [];
    const named: Piece[] = [];
    const logos: Piece[] = [];
    const rest: Piece[] = [];
    const collect = (scope: Node, skip?: Node): void => {
      const read = scopeOf(scope);
      for (const seg of read.segments) {
        if (skip && inside(skip, seg.node)) continue;
        (seg.heading ? heads : seg.named ? named : rest).push(seg);
      }
      for (const logo of read.logos) if (!skip || !inside(skip, logo.node)) logos.push(logo);
    };
    for (const a of anchors.slice(0, 4)) {
      collect(a);
      let card: Node | null = null;
      for (const anc of ancestors(a, 3)) {
        if (isTag(anc, "body", "main", "html") || caseLinkCount(anc) > 1) break;
        card = anc;
      }
      if (card) collect(card, a);
    }
    // Headlines first: "How Globex cut onboarding time" says more to a reviewer than "Globex logo".
    const loose = rest.filter((r) => r.text.length <= 400).slice(0, 14);
    const texts = [...heads, ...named, ...logos, ...loose].filter((t) => t.text);
    /** The card's headline: a heading, else loose text that reads like a headline about this company. */
    const headlineFor = (name: string): string | undefined => {
      for (const h of heads) if (headKind(h.text, { heading: true }) === "headline") return h.text;
      for (const r of loose) if (headKind(r.text, { heading: false, name }) === "headline") return r.text;
      return undefined;
    };
    let done = false;
    // (a) the slug's name, spelled out by the page: the strongest reading.
    if (fromSlug) {
      const spelledIn = speller(fromSlug.tokens);
      for (const t of texts) {
        const spelled = spelledIn(t.text);
        // A brand written in lower case is a name when it is the headline's subject - in a heading, or, when
        // it is the story's whole address ("How n8n built ..." under /customers/n8n), in any line of the card.
        const whole = !!spelled && fromSlug.tokens.length === 1 && spelled.toLowerCase() === slug.toLowerCase();
        // A slug made of everyday words ("/customers/remote-teams") only counts when the page capitalises it as a name.
        if (!spelled || (!writtenAsName(spelled) && !(!fromSlug.weak && (t.heading || whole) && lowerCaseSubject(t.text, spelled, whole))) || (fromSlug.weak && !capitalised(spelled))) continue;
        const fuller = fullerName(spelled, [...logos, ...heads, ...named, ...loose]);
        const name = fuller?.name ?? spelled;
        // The words shown as proof name the company the way it is reported.
        const headline = headlineFor(name);
        const says = (text: string): boolean => text.toLowerCase().includes(name.toLowerCase());
        const proof = headline && says(headline) ? { text: headline } : fuller && !says(t.text) ? fuller.from : t;
        const mention = headline ? undefined : mentionOf(headKind(t.text, { heading: t.heading }));
        add({ name, quote: proof.text, via: "case_study", headline, mention, confidence: 0.9, domain: linkedDomain(t.node, name), storyUrl, dedicated: true });
        done = true;
        break;
      }
    }
    // (b) a case-study headline that names the company.
    if (!done) {
      for (const t of texts) {
        const read = parseHeadline(t.text, competitor.name);
        if (!read) continue;
        // A name read out of a line on the card is this story's customer only when the story's own address
        // carries it. Without that the line may be anything that reads like a headline: a figure's caption
        // ("Volume increase supported"), a teaser about somebody else. The story itself says who it is about.
        if (!slugCarries(slug, read)) continue;
        const longer = nameWithSlugRest(read, slug, competitor.name);
        const name = longer ?? read;
        const kind = headKind(t.text, { heading: t.heading, name: read });
        const headline = kind === "headline" ? t.text : headlineFor(read);
        const matches = !!fromSlug && normCompanyName(fromSlug.name) === normCompanyName(name);
        add({ name, quote: t.text, via: "case_study", headline, mention: headline ? undefined : mentionOf(kind), confidence: matches ? 0.9 : longer ? 0.85 : 0.75, storyUrl, dedicated: !!longer || slugNames(slug, name) });
        done = true;
        break;
      }
    }
    // (c) a short, distinctive slug alone. The quote is the link exactly as the page wrote it.
    // Only on a page that really is an index of stories (three or more of them): a lone link under /customers/ can be anything.
    if (!done && caseLinks.size >= 3 && fromSlug && !fromSlug.weak && fromSlug.tokens.length <= 2 && fromSlug.tokens.join("").length >= 3) {
      const href = cleanLine(attr(anchors[0], "href"), 300);
      if (href) add({ name: fromSlug.name, quote: href, via: "case_study", confidence: 0.55, storyUrl, dedicated: true });
    } else if (done && attempts > before) {
      // The card named somebody, reportable or not (an unnamed "Austrian Agency" is not): the story holds nothing more.
      told.add(storyKey(storyUrl));
    }
  }

  /* 2. The page is itself one case study: its main headline or title names the company. */
  if (pageSlug) {
    const storyUrl = `${base.origin}${base.pathname}`;
    const fromSlug = slugCustomerName(pageSlug, competitor.name);
    const h1s: Piece[] = [];
    for (const n of all) {
      if (h1s.length >= 2) break;
      const text = isTag(n, "h1") ? lineOf(n, 300) : "";
      if (text) h1s.push({ text, node: n, heading: true });
    }
    // The title without the site's name after a bar: "How Globex cut costs | Acme" is a headline, "Globex - Customer Stories" is not.
    const titleHead = cleanLine(title.split(/\s+[|\u00B7]\s+/)[0] ?? "", 200).replace(new RegExp(`\\s*[\\u2013\\u2014-]\\s*${escapeRegExp(cleanLine(competitor.name, 80))}\\s*$`, "i"), "");
    const pieces: Piece[] = [...h1s, ...(title ? [{ text: title, node: bodyNode, heading: false }] : [])];
    const pageHeadline = (name: string): string | undefined => {
      for (const h of h1s) if (headKind(h.text, { heading: true }) === "headline") return h.text;
      return titleHead && headKind(titleHead, { heading: false, name }) === "headline" ? titleHead : undefined;
    };
    const spelledIn = speller(fromSlug ? fromSlug.tokens : []);
    for (const h of pieces) {
      const spelled = spelledIn(h.text);
      const whole = !!spelled && fromSlug?.tokens.length === 1 && spelled.toLowerCase() === pageSlug.toLowerCase();
      if (spelled && (writtenAsName(spelled) || (!fromSlug?.weak && (h.heading || whole) && lowerCaseSubject(h.text, spelled, whole))) && !(fromSlug?.weak && !capitalised(spelled))) {
        const name = fullerName(spelled, pieces)?.name ?? spelled;
        const headline = pageHeadline(name);
        add({ name, quote: h.text, via: "case_study", headline, mention: headline ? undefined : mentionOf(headKind(h.text, { heading: h.heading })), confidence: 0.9, storyUrl, dedicated: true });
        break;
      }
      const read = parseHeadline(h.text, competitor.name);
      // The name a headline gives is the story's customer when the story's address carries it, or when the
      // page says it twice: in its main heading and in its title.
      if (read && (slugCarries(pageSlug, read) || pieces.some((other) => other !== h && saysName(other.text, read)))) {
        const longer = nameWithSlugRest(read, pageSlug, competitor.name);
        const name = longer ?? read;
        const headline = pageHeadline(read);
        add({ name, quote: h.text, via: "case_study", headline, mention: headline ? undefined : mentionOf(headKind(h.text, { heading: h.heading })), confidence: longer ? 0.85 : 0.8, storyUrl, dedicated: !!longer || slugNames(pageSlug, name) });
        break;
      }
    }
  }

  /* 3. Labelled headings on a customers page: "Case study: Globex", "Globex case study". */
  if (customerPage) {
    for (const n of all) {
      if (full()) break;
      if (!isHeading(n)) continue;
      const t = lineOf(n, 240);
      if (!t || t.length > 200 || (!LABEL_PREFIX.test(t) && !LABEL_SUFFIX.test(t))) continue;
      const name = parseHeadline(t, competitor.name);
      if (!name) continue;
      const kind = headKind(t, { heading: true });
      add({ name, quote: t, via: "case_study", headline: kind === "headline" ? t : undefined, mention: mentionOf(kind), confidence: 0.75 });
    }
  }

  /* 4. Logos under a label that says they are customers. */
  /** Pictures looked at so far as possible logos. A real page has a few hundred; this is where looking stops. */
  let logosSeen = 0;
  const MAX_LOGOS_SEEN = 20_000;
  const takeLogos = (items: LogoItem[], label: string, confidence: number, declaredOnly = false): void => {
    logosSeen += items.length;
    const named = items
      .map((it) => ({ it, read: logoRead(it.raw) }))
      .filter((x): x is { it: LogoItem; read: { name: string; fromFileName: boolean } } => !!x.read)
      .map(({ it, read }) => ({ it, name: read.name, fromFileName: read.fromFileName }));
    // One picture is not a wall of customers: a lone logo under "trusted by" is as often the site's own, a
    // badge or a stray image with a file name for a description. Two different names or nothing.
    if (new Set(named.map((x) => normCompanyName(x.name))).size < 2) return;
    // A wall is several logos. Without the word "logo" anywhere, one or two pictures are not a wall -
    // and under a "customer stories" heading the pictures are story thumbnails, so only declared logos count.
    const wall = named.length >= 3 && !declaredOnly && !STORY_LABEL.test(label);
    for (const { it, name, fromFileName } of named) {
      if (!it.explicit && !wall) continue;
      // Pictures inside a testimonial are people unless they say "logo".
      if (!it.explicit && ancestors(it.node, 4).some((a) => isTag(a, "blockquote") || /testimonial|quote|review/i.test(attr(a, "class")))) continue;
      // A name rebuilt from a file's name comes after every name the page wrote out: it fills what is left of a list, not the top of it.
      const sure = fromFileName ? (it.explicit ? FILE_NAME_CONFIDENCE : FILE_NAME_CONFIDENCE_PLAIN) : it.explicit ? confidence : confidence - 0.15;
      add({ name, quote: cleanLine(it.raw, 200), via: "logo", headline: label || undefined, confidence: sure, domain: linkedDomain(it.node, name) });
    }
  };
  /** Asked of the same blocks by every label near them, so each answer is kept. */
  const kept = <T>(read: (n: Node) => T): ((n: Node) => T) => {
    const known = new Map<Node, T>();
    return (n) => {
      if (!known.has(n)) known.set(n, read(n));
      return known.get(n) as T;
    };
  };
  const sparse = kept((n: Node): boolean => {
    const logos = descendants(n, 600).filter((d) => logoItem(d)).length;
    return logos >= 1 && lineOf(n, 4000).length <= 30 * logos + 20;
  });
  const hasNegativeLabel = kept((n: Node): boolean => descendants(n, 300).some((d) => NEGATIVE_LABEL.test(labelText(d))) || classTokens(n).some((t) => NEGATIVE_CLASS.test(t)));
  /** Is this the block a quote sits in: a quote element, one whose class says so, or one with a quote near its top? */
  const quoteBlock = kept((a: Node): boolean => isTag(a, "blockquote", "figure") || /testimonial|quote|review/i.test(attr(a, "class")) || descendants(a, 80).some((d) => isTag(d, "blockquote", "q")));
  /** A quote and who said it make one small block; this is whether a block is too long to be that. */
  const longBlock = kept((n: Node): boolean => lineOf(n, 1300).length > 1200);
  const negativeBetween = (item: Node, stop: Node): boolean => {
    for (const a of ancestors(item, 8)) {
      if (a === stop) return false;
      if (classTokens(a).some((t) => NEGATIVE_CLASS.test(t))) return true;
    }
    return false;
  };

  for (let i = 0; i < all.length; i++) {
    if (full() || logosSeen > MAX_LOGOS_SEEN) break;
    const el = all[i];
    const label = labelText(el);
    if (!label || !POSITIVE_LABEL.test(label) || NEGATIVE_LABEL.test(label)) continue;
    let limit: Node = el;
    for (let k = 0; k < 4 && limit.parent && limit.parent.type === "tag" && limit.parent.name !== "html"; k++) limit = limit.parent;
    const limitAt = indexOf.get(limit);
    const limitEnd = isTag(limit, "body") ? all.length - 1 : limitAt !== undefined ? lastInside[limitAt] : i + descendants(limit, 6000).length;
    const end = Math.min(all.length - 1, limitEnd, i + 500);
    const run: LogoItem[] = [];
    for (let j = i + Math.min(lastInside[i] - i, 200) + 1; j <= end; j++) {
      const e = all[j];
      if (isHeading(e)) break;
      const lt = labelText(e);
      if (lt && (NEGATIVE_LABEL.test(lt) || POSITIVE_LABEL.test(lt))) break;
      const item = logoItem(e);
      if (item) run.push(item);
    }
    if (!run.length) continue;
    logosSeen += run.length;
    // Start from the first picture that reads as a company, not a screenshot that happens to come first.
    const first = (run.find((it) => it.explicit && logoName(it.raw)) ?? run.find((it) => logoName(it.raw)) ?? run[0]).node;
    const chain: Node[] = [];
    let lca: Node | null = null;
    for (const a of ancestors(first, 12)) {
      if (inside(a, el)) {
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
      const { list: siblings, at } = tagKids(group.parent);
      for (let s = (at.get(group) ?? -1) + 1; s > 0 && s < siblings.length && members.length < 12; s++) {
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
    if (full() || logosSeen > MAX_LOGOS_SEEN) break;
    const tokens = classTokens(n);
    if (!tokens.length || tokens.some((t) => NEGATIVE_CLASS.test(t))) continue;
    const positive = tokens.some((t) => POSITIVE_CLASS.test(t));
    const generic = !positive && customerPage && tokens.some((t) => LOGO_CLASS.test(t));
    if (!positive && !generic) continue;
    if (hasNegativeLabel(n)) continue;
    // The label just before the container decides too: "Our partners" above a .logos block is not customers.
    const { list: before, at } = tagKids(n.parent);
    const prev = before[(at.get(n) ?? 0) - 1];
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
    if (full()) break;
    const cls = attr(n, "class");
    const attribution = isTag(n, "cite", "figcaption") || (isTag(n, "footer") && ancestors(n, 2).some((a) => isTag(a, "blockquote", "figure"))) || /author|attribution|byline|(?:testimonial|quote|review)[\w-]*(?:name|role|title|position|company|source|meta)/i.test(cls);
    if (!attribution) continue;
    const scope = ancestors(n, 4).find(quoteBlock);
    // The quote and its attribution form one small block; a whole article with a quote somewhere in it does not.
    if (!scope || longBlock(scope)) continue;
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

  /*
   * 6b. Testimonial cards with no quote markup: a line that says who is speaking and where they work
   * ("Co-founder and CEO at Globex") beside what they said. Only under a label that says these are
   * customers speaking - the same rule a wall of logos is held to - since the same line under "Our
   * speakers" or "Meet the team" names nobody's customer.
   */
  const SPEAKER = /^(.{2,90}?)\s(?:at|@)\s+([^,|\u00B7\u2022]{2,60})$/i;
  const speaks = (t: string): RegExpExecArray | null => {
    const at = t.length <= 160 ? SPEAKER.exec(t) : null;
    return at && TITLE_WORDS.test(at[1]) && !/[.!?]\s/.test(at[1]) ? at : null;
  };
  /**
   * The company a line names as its speaker's employer, with the card the line stands in: the smallest block
   * around it that also holds what was said (a sentence of its own) and nobody else's line. A grid of names
   * and job titles with nothing said is a list of people, not of customers. Asked once per element: the
   * stretches looked through after two labels overlap.
   */
  const speakerOf = kept((e: Node): { name: string; line: string; card: Node } | null => {
    // One line of its own: who is speaking.
    if (e.blank !== undefined || e.solid === undefined || e.solid < 8 || e.solid > 160) return null;
    if ((e.children ?? []).some((c) => c.type === "tag" && !INLINE.has(c.name ?? ""))) return null;
    const t = lineOf(e, 200);
    if (!t || NOT_A_CUSTOMER_ROLE.test(t)) return null;
    const at = speaks(t);
    if (!at) return null;
    let card: Node | null = null;
    for (const a of ancestors(e, 5)) {
      if (isTag(a, "body", "main", "html")) break;
      const pieces = segmentsOf(a, 14);
      // More than a card holds, or a second speaker: this is the row or the grid, not the card.
      if (pieces.length >= 14 || pieces.filter((p) => speaks(p.text)).length > 1) break;
      if (pieces.some((p) => p.text.length >= 30 && p.text !== t && !speaks(p.text))) {
        card = a;
        break;
      }
    }
    if (!card) return null;
    const name = cleanCompanyName(at[2], 4);
    // "Partner at Benchmark Capital" is an investor speaking, not a customer.
    if (!name || (/\bpartner\b/i.test(t) && /\b(?:capital|ventures?|vc|partners|fund|equity|investments?)\b/i.test(name))) return null;
    return { name, line: t, card };
  });
  for (let i = 0; i < all.length; i++) {
    if (full()) break;
    const el = all[i];
    const label = labelText(el);
    if (!label || NEGATIVE_LABEL.test(label) || !(POSITIVE_LABEL.test(label) || VOICES_LABEL.test(label))) continue;
    let limit: Node = el;
    for (let k = 0; k < 4 && limit.parent && limit.parent.type === "tag" && limit.parent.name !== "html"; k++) limit = limit.parent;
    const limitAt = indexOf.get(limit);
    const limitEnd = isTag(limit, "body") ? all.length - 1 : limitAt !== undefined ? lastInside[limitAt] : i;
    const end = Math.min(all.length - 1, limitEnd, i + 500);
    for (let j = i + Math.min(lastInside[i] - i, 200) + 1; j <= end; j++) {
      const e = all[j];
      // The next section ends this one; a small heading inside a card (a speaker's name) does not.
      if (isTag(e, "h1", "h2")) break;
      const other = labelText(e);
      if (other && (NEGATIVE_LABEL.test(other) || (j > i + 1 && isHeading(e) && (POSITIVE_LABEL.test(other) || VOICES_LABEL.test(other))))) break;
      const said = speakerOf(e);
      // (A card that holds the label too is the whole section.)
      if (!said || inside(said.card, el)) continue;
      add({ name: said.name, quote: said.line, via: "testimonial", confidence: 0.65 });
    }
  }

  /* 7. Structured data, only for names the visible page also shows. */
  for (const s of structured.slice(0, 40)) {
    if (full()) break;
    const name = cleanCompanyName(s.name, 4);
    if (!name || !flat.toLowerCase().includes(name.toLowerCase())) continue;
    add({ name, quote: name, via: "structured_data", confidence: s.review ? 0.7 : 0.65 });
  }

  return {
    hits: [...hits.values()],
    told: [...told],
    links: [...links.values()],
    text,
    title,
    customerPage,
    siteLinks: elsewhere.size,
  };
}

/** Customer-section URLs listed in a sitemap, plus child sitemaps when the file is an index. */
export function customerLinksFromSitemap(xml: string, domain: string): { links: CrawlLink[]; children: string[] } {
  const links = new Map<string, CrawlLink>();
  const children: string[] = [];
  const index = /<sitemapindex[\s>]/i.test(xml.slice(0, 2000));
  // Every run of spaces has a length limit and no two parts of the pattern can match the same characters, so each
  // "<loc>" costs at most a few thousand steps. (With unlimited runs side by side, one "<loc>" followed by a hundred
  // thousand spaces took seconds, and a megabyte of them minutes.)
  const re = /<loc>\s{0,200}(?:<!\[CDATA\[\s{0,200})?([^<\]\s]{1,2000})\s{0,200}(?:\]\]>\s{0,200})?<\/loc>/gi;
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
    if (score > 0 && links.size < 300) links.set(u.toString().replace(/\/$/, ""), { url: u.toString(), score });
  }
  return { links: [...links.values()], children };
}

/**
 * What a model returned for one page, kept only where the page backs it up: the quote must
 * appear in the page text exactly (whitespace aside), the name must appear on the page too,
 * and the name must pass the same rules as any other. Everything else is dropped.
 */
export function verifyAiCustomers(raw: unknown, pageText: string, competitor: { name: string; domain: string }): { hits: CustomerHit[]; dropped: number } {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { customers?: unknown }).customers) ? ((raw as { customers: unknown[] }).customers as unknown[]) : [];
  // The text a model was shown is a few thousand characters; nothing longer is searched for its quotes.
  const flat = String(pageText ?? "").slice(0, 60_000).replace(/\s+/g, " ");
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
