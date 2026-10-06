/**
 * Play: people asking in public for a solution, or complaining about a competitor.
 *
 * Searches public conversations (LinkedIn posts, Reddit, Hacker News, X, forums), and keeps
 * a result only when its own title or snippet shows a person asking or complaining - never
 * a vendor's article, a listicle, a job ad or the competitor's own page. The author of a
 * LinkedIn post becomes a person; everything else is a conversation to answer. The quote is
 * the line from the result that the verdict rests on.
 */
import type { AiMessage, SearchResult } from "../types.js";
import { UNTRUSTED_RULE, fence, plainString } from "../ai/untrusted.js";
import { rootDomain } from "../util/domain.js";
import { slugifyNamePart, splitName } from "../util/names.js";
import { PlayRun, article, cleanList, clampInt, escapeRegExp, findingLimit, finishFinding, rankFindings, safeHttpUrl } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, cleanQuote, normCompanyName } from "./util.js";

export type AskSource = "linkedin" | "reddit" | "hackernews" | "x" | "forums";

const ALL_SOURCES: AskSource[] = ["linkedin", "reddit", "hackernews", "x", "forums"];
const SITE: Record<AskSource, string> = { linkedin: "linkedin.com/posts", reddit: "reddit.com", hackernews: "news.ycombinator.com", x: "x.com", forums: "" };
const ON: Record<AskSource, string> = { linkedin: "LinkedIn", reddit: "Reddit", hackernews: "Hacker News", x: "X", forums: "a public forum" };
const THREAD: Record<AskSource, string> = { linkedin: "LinkedIn post", reddit: "Reddit thread", hackernews: "Hacker News thread", x: "Post on X", forums: "Forum thread" };

const MAX_SEARCHES = 24;
const MAX_AI_BATCHES = 2;
const AI_BATCH = 10;

export interface AskSubject {
  kind: "competitor" | "problem" | "category";
  value: string;
}

const q = (s: string): string => s.replace(/["\u201C\u201D]/g, "").trim();

function phrasesFor(s: AskSubject): string[] {
  const v = q(s.value);
  if (s.kind === "competitor") return [`"alternative to ${v}"`, `"switching from ${v}"`, `"frustrated with ${v}"`, `"${v} is too expensive"`, `"${v} vs"`];
  // A problem is the customer's own words; quoted whole it would match nothing.
  if (s.kind === "problem") return [`"looking for a tool" ${v}`, `"what do you use" ${v}`];
  return [`"looking for ${article(v)} ${v}"`, `"recommend ${article(v)} ${v}"`];
}

/**
 * The searches for a run, ordered so every subject is asked once on every source before
 * any subject is asked a second way. A plain form (no `site:`) follows the first round, for
 * search sources that refuse the operator.
 */
export function buildAskQueries(subjects: AskSubject[], sources: AskSource[]): { query: string; subject: AskSubject }[] {
  const out: { query: string; subject: AskSubject }[] = [];
  const seen = new Set<string>();
  const push = (query: string, subject: AskSubject): void => {
    if (!seen.has(query)) {
      seen.add(query);
      out.push({ query, subject });
    }
  };
  for (let round = 0; round < 5; round++) {
    for (const subject of subjects) {
      const phrase = phrasesFor(subject)[round];
      if (!phrase) continue;
      for (const source of sources) push(SITE[source] ? `site:${SITE[source]} ${phrase}` : phrase, subject);
    }
    if (round === 0) for (const subject of subjects) push(phrasesFor(subject)[0], subject);
  }
  return out;
}

/* ───────────────────────────────── where a result lives ───────────────────────────────── */

const FORUM_HOSTS = /(?:^|\.)(?:stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|quora\.com|indiehackers\.com|lobste\.rs|tildes\.net|warriorforum\.com|growthhackers\.com|spiceworks\.com|producthunt\.com|slashdot\.org|lemmy\.world|lemmy\.ml|community\.hubspot\.com|trailhead\.salesforce\.com)$/i;
const FORUM_HOST_LABEL = /^(?:community|communities|forum|forums|discuss|discussion|discourse|answers|ask|groups|talk|boards?)\./i;
const FORUM_PATH = /\/(?:forums?|community|communities|discussions?|threads?|topics?|questions?|t|board|boards|answers)\//i;

export interface AskPlace {
  source: AskSource;
  /** LinkedIn only: the profile part of a post URL, when it has one. */
  vanity?: string;
}

/** Which kind of public conversation a URL is, or null for anything that is not one. */
export function askPlace(url: string): AskPlace | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  if (host === "linkedin.com" || /^[a-z]{2,3}\.linkedin\.com$/.test(host)) {
    const post = /^\/posts\/([^/_]+)_/.exec(path);
    if (post) {
      let vanity = post[1];
      try {
        vanity = decodeURIComponent(vanity);
      } catch {
        return { source: "linkedin" };
      }
      return { source: "linkedin", vanity };
    }
    if (/^\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+/.test(path)) return { source: "linkedin" };
    return null;
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) return /^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(path) ? { source: "reddit" } : null;
  if (host === "news.ycombinator.com") return path === "/item" && /^\d+$/.test(u.searchParams.get("id") ?? "") ? { source: "hackernews" } : null;
  if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") return /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(path) ? { source: "x" } : null;
  if (FORUM_HOSTS.test(host) || FORUM_HOST_LABEL.test(host) || FORUM_PATH.test(path)) {
    if (host.endsWith("producthunt.com") && !/^\/(?:discussions|p)\//.test(path)) return null;
    return { source: "forums" };
  }
  return null;
}

/* ───────────────────────────────── ask, complaint or neither ───────────────────────────────── */

const JOB_AD = /\b(?:we(?:'re|\u2019re| are) hiring|is hiring|now hiring|hiring (?:an?|for)\b|job opening|apply now|join our team|open (?:role|position)s?|#hiring|vacancy|internship)\b/i;

/** A vendor, an author or an editor speaking - not a buyer. */
const MARKETING =
  /\b(?:top|best)\s+\d+\b|\b\d+\s+(?:best|top|great|free|powerful|proven|awesome|must-have)\b|\b\d+\s+(?:\w+\s+)?(?:alternatives|competitors|tools|platforms|apps|options)\b|\balternatives?\s+(?:&|and)\s+competitors\b|\bhere(?:'s|\u2019s| is| are)\s+(?:\d+|the top|my top|our|why|how|what|a list)\b|\bin this (?:post|article|guide|video|blog|review)\b|\b(?:we|i)\s+(?:compared|reviewed|tested|ranked|analy[sz]ed)\b|\b(?:ultimate|complete|definitive|comprehensive|in-depth)\s+(?:guide|comparison|review|list)\b|\bpros and cons\b|\b(?:full|detailed|honest|head-to-head)\s+(?:comparison|review)\b|\b(?:sign up|get started|book a demo|request a demo|start (?:your|a) free trial|free trial|link in (?:the )?(?:comments|bio)|dm me|comment\s+\S+\s+below|use code|limited time|% off)\b|\b(?:we|our team)\s+(?:built|created|made|launched|just launched|are building|offer|provide)\b|\bintroducing\b|\b(?:in|for)\s+20\d\d\b|\bsponsored\b|\bwebinar\b|\bcase study\b|\bpress release\b/i;

/** "Tired of Acme? Try Globex" - a question put to the reader by someone selling the answer. */
const VENDOR_HOOK =
  /\b(?:looking for|need|tired of|frustrated with|struggling with|sick of|still using|thinking of leaving|fed up with)\b[^?]{0,90}\?\s*(?:try|meet|check out|here(?:'s|\u2019s| is| are)|we (?:built|made|can help|have you covered|got you)|we(?:'ve|\u2019ve) (?:built|made|got you)|our (?:tool|platform|product|app|solution|team)|introducing|look no further|say hello|you(?:'re|\u2019re| are) not alone|switch to|read (?:this|on|our)|download|sign up|get started)/i;

const FIRST_PERSON = /(?:^|[^\p{L}])(?:i|i'm|i\u2019m|i've|i\u2019ve|we|we're|we\u2019re|we've|we\u2019ve|my|our|us|me|im)(?![\p{L}'\u2019])/iu;

const ASK_STRONG: RegExp[] = [
  /\b(?:i'?m|i\u2019m|i am|we'?re|we\u2019re|we are|i'?ve been|we'?ve been|am|currently)\s+(?:looking|searching|hunting|shopping)\s+(?:for|around)\b/i,
  /\b(?:any|anyone|anybody|does anyone|has anyone|can anyone|could anyone|can someone|could someone)\b[^.?!]{0,80}\b(?:recommend|suggest|know (?:of|a|an|any)|have experience|experience with|uses?|used|using|tried|switched|moved)\b/i,
  /\b(?:recommendations?|suggestions?|advice)\b[^.!]{0,60}(?:\?|\bplease\b|\bneeded\b|\bwanted\b|\bwelcome\b|\bappreciated\b)/i,
  /\bwhat\b[^.?!]{0,80}\b(?:do you|are you|does your team|is everyone|are people|are you all|would you|should (?:i|we))\b[^.?!]{0,60}\b(?:use|using|recommend|suggest|go with|choose|pick)\b/i,
  /\b(?:which|what)\b[^.?!]{0,60}\b(?:should (?:i|we)|would you (?:recommend|suggest|choose|pick|use))\b/i,
  /\b(?:thinking (?:of|about)|considering|planning (?:on|to)|want(?:ing)? to|looking to|about to|need to|trying to|time to|ready to|decided to)\s+(?:switch(?:ing)?|mov(?:e|ing)|migrat(?:e|ing)|leav(?:e|ing)|replac(?:e|ing)|ditch(?:ing)?|cancel(?:l?ing)?|drop(?:ping)?)\b/i,
  /\b(?:i|we)\s+(?:really\s+|just\s+|urgently\s+)?(?:need|want)\s+(?:an?|some|to find an?)\s+[^.?!]{0,50}\b(?:alternatives?|replacements?|tool|software|platform|solution|recommendations?)\b/i,
  /^ask hn:[^?]{0,140}(?:\?|\balternatives?\b|\brecommend|\bwhat do you use\b|\blooking for\b)/i,
];

const ASK_WEAK: RegExp[] = [
  /\b(?:looking|searching)\s+for\s+[^.?!]{0,60}\b(?:alternatives?|replacements?|tool|software|platform|solution|app|recommendations?|suggestions?|crm|system|service|vendor|provider)\b/i,
  /\balternatives?\s+to\b[^.!]{0,80}\?/i,
  /\b(?:any|good|best|better|cheaper|open[- ]source|free)\s+alternatives?\b[^.!]{0,80}\?/i,
  /\bwhat (?:do|does|are|is)\b[^.?!]{0,80}\buse\b[^.?!]{0,40}\?/i,
];

const COMPLAINT =
  /\b(?:frustrat\w+|fed up|sick of|tired of|done with|hate|hating|annoyed|annoying|disappointed|disappointing|unhappy|nightmare|terrible|awful|horrible|worst|unusable|buggy|broken|sucks?|garbage|trash|rip-?off|overpriced|too expensive|way too pricey|price (?:hike|increase|gouging)|raised (?:their|the) prices?|doubled (?:their|the|our) (?:price|prices|bill|cost)|cancel(?:l?ing|l?ed) (?:my|our)|support is (?:terrible|awful|non-?existent|slow|useless|a joke)|no support|poor support|keeps? (?:crashing|breaking|failing|going down)|doesn(?:'|\u2019)?t work|does not work|not worth|regret|constant (?:downtime|outages|bugs)|getting worse|gone downhill|bait and switch)\b/i;

/** Is the text about moving AWAY from this product? ("Has anyone switched to Acme?" is not.) */
function aboutLeaving(text: string, competitor: string): boolean {
  const c = escapeRegExp(competitor);
  return new RegExp(
    `\\balternatives?\\s+(?:to|for)\\s+(?:the\\s+)?${c}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${c}\\s+(?:alternatives?|replacements?)\\b|\\b(?:switch\\w*|mov\\w+|migrat\\w*|transition\\w*)\\s+(?:away\\s+|off\\s+)?(?:from|off)\\s+${c}(?![\\p{L}\\p{N}])|\\b(?:replac\\w*|leav\\w+|ditch\\w*|dropp?\\w*|cancel\\w*|instead of|other than|besides|get(?:ting)? off|get(?:ting)? rid of)\\s+(?:my\\s+|our\\s+|the\\s+)?${c}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

export interface AskVerdict {
  kind: "ask" | "complaint";
  /** The line of the result that shows it, verbatim. */
  quote: string;
  /** False when the wording could as easily be a vendor's hook: worth a second opinion. */
  strong: boolean;
  /** For an ask that mentions a competitor: is it about leaving it? */
  leaving: boolean;
}

function lines(text: string): string[] {
  return text
    .split(/(?<=[.?!\u2026])\s+|\s+\.\.\.\s*|\s+[\u00B7|]\s+|\s+[\u2014\u2013]\s+/)
    .map((s) => cleanQuote(s, 300))
    .filter((s) => s.length >= 8);
}

/**
 * Rules only: is this result a person asking, a person complaining, or neither?
 * `competitor` is needed for a complaint - a complaint about nothing in particular is noise.
 */
export function classifyAsk(title: string, snippet: string, competitor?: string): AskVerdict | null {
  const t = cleanQuote(title, 300);
  const s = cleanQuote(snippet, 600);
  const all = `${t} ${s}`;
  if (!all.trim() || JOB_AD.test(all) || MARKETING.test(all) || VENDOR_HOOK.test(all)) return null;
  const named = competitor ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(competitor)}(?![\\p{L}\\p{N}])`, "iu") : null;
  const firstPerson = FIRST_PERSON.test(all);
  const candidates = [...lines(t), ...lines(s)];
  if (!candidates.length) return null;
  const leaving = competitor ? aboutLeaving(all, competitor) : false;
  for (const line of candidates) {
    if (ASK_STRONG.some((re) => re.test(line))) return { kind: "ask", quote: line, strong: true, leaving };
  }
  for (const line of candidates) {
    if (ASK_WEAK.some((re) => re.test(line))) return { kind: "ask", quote: line, strong: firstPerson, leaving };
  }
  if (named) {
    // The complaint has to be about the product: the same line names it, or the title does.
    const titleNames = named.test(t);
    for (const line of candidates) {
      if (COMPLAINT.test(line) && (named.test(line) || titleNames)) return { kind: "complaint", quote: line, strong: firstPerson, leaving };
    }
  }
  return null;
}

/* ───────────────────────────────── people ───────────────────────────────── */

const BUSINESS_WORD = /^(?:labs?|tech|technologies|technology|software|solutions|systems|group|global|digital|media|studios?|agency|consulting|consultants|partners|ventures|capital|inc|llc|ltd|gmbh|co|corp|company|team|hq|ai|io|app|apps|cloud|data|analytics|marketing|sales|services|network|hub|works|academy|institute|university|club|community|official|news|daily|weekly|magazine|podcast|careers|jobs|recruiting|recruitment|staffing|insights|research|foundation|association|society|council|enterprises?|industries|holdings|bank|insurance|school|college)$/i;
const NAME_PARTICLE = /^(?:de|del|della|der|den|di|da|dos|du|van|von|bin|ibn|al|el|la|le|st\.?|mc|mac)$/i;

/** A personal name from a LinkedIn result title ("Jane Doe on LinkedIn: ..."), or null for a company page or anything unclear. */
export function linkedinPostAuthor(title: string): { name: string; text: string } | null {
  const t = cleanLine(title, 300).replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/\s*\|\s*\d[\d,.]*\+?\s*(?:comments?|reactions?|likes?)\s*$/i, "");
  let raw: string | null = null;
  let text = "";
  let m: RegExpExecArray | null;
  if ((m = /^(.{3,80}?)\s+on LinkedIn\s*:\s*(.*)$/i.exec(t))) {
    raw = m[1];
    text = m[2];
  } else if ((m = /^(.{3,80}?)['\u2019]s? Post\b/i.exec(t))) raw = m[1];
  else if ((m = /^(.*?)\s*\|\s*(.{3,80}?)\s+posted on the topic\b/i.exec(t))) {
    raw = m[2];
    text = m[1];
  } else if ((m = /^(.{3,80}?)\s+posted on LinkedIn\b/i.exec(t))) raw = m[1];
  if (!raw) return null;
  // Credentials and emoji after the name are not the name.
  const name = raw.split(/\s*[,|(\u2013\u2014]\s*/)[0].replace(/[^\p{L}\p{M}'\u2019.\- ]/gu, " ").replace(/\s+/g, " ").trim();
  const parts = name.split(" ").filter(Boolean);
  const given = parts.filter((p) => !NAME_PARTICLE.test(p));
  if (given.length < 2 || given.length > 4 || parts.length > 6 || name.length > 60) return null;
  if (parts.some((p) => BUSINESS_WORD.test(p.replace(/[.']/g, "")))) return null;
  if (!parts.every((p) => /^\p{Lu}/u.test(p) || NAME_PARTICLE.test(p))) return null;
  return { name, text: cleanQuote(text, 300) };
}

/** Does the profile part of a post URL belong to this person? It carries the name on a personal profile. */
function vanityMatches(vanity: string, name: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{2,99}$/i.test(vanity)) return false;
  const v = vanity.toLowerCase().replace(/[^a-z]/g, "");
  const tokens = name.split(" ").map((p) => slugifyNamePart(p)).filter((p) => p.length >= 3);
  return tokens.length > 0 && tokens.some((p) => v.includes(p));
}

/* ───────────────────────────────── dates ───────────────────────────────── */

const MONTH = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

/** The date a search result shows before its snippet ("3 days ago", "Oct 2, 2026"), when it shows one. */
export function snippetDate(snippet: string, now = Date.now()): Date | null {
  const s = snippet.trim().slice(0, 60);
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3})\s+(hour|day|week|month|year)s?\s+ago\b/i.exec(s))) {
    const unit = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 }[m[2].toLowerCase() as "hour"]!;
    return new Date(now - Number(m[1]) * unit);
  }
  if ((m = new RegExp(`^((?:${MONTH})[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${MONTH})[a-z]*\\.?,?\\s+\\d{4})\\b`, "i").exec(s))) {
    const d = new Date(`${m[1].replace(/\./g, "")} UTC`);
    if (Number.isFinite(d.getTime()) && d.getTime() <= now + 86_400_000 && d.getUTCFullYear() >= 2005) return d;
  }
  return null;
}

/* ───────────────────────────────── the engine ───────────────────────────────── */

const cleanThreadTitle = (title: string): string =>
  cleanLine(title, 200)
    .replace(/\s*[:|\u2013\u2014-]\s*(?:r\/[A-Za-z0-9_]+|reddit|hacker news|linkedin|x|twitter|quora|stack overflow|indie hackers)\s*$/i, "")
    .replace(/\s*\|\s*\d[\d,.]*\+?\s*(?:comments?|replies|points)\s*$/i, "")
    .trim();

function topicOverlap(text: string, topic: string): boolean {
  const stop = new Set("with that this from your their have what when where which will would should could about into over under more most some than then them they were been being also just like need want tool tools software platform best good".split(" "));
  const tokens = [...new Set(topic.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 4 && !stop.has(w)))];
  if (!tokens.length) return text.toLowerCase().includes(topic.toLowerCase());
  const hay = text.toLowerCase();
  const hit = tokens.filter((w) => hay.includes(w) || (w.endsWith("s") && hay.includes(w.slice(0, -1)))).length;
  return hit >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function reasonFor(kind: "ask" | "complaint", person: boolean, source: AskSource, subject: AskSubject, leaving: boolean): string {
  const v = cleanLine(subject.value, 120);
  if (person) {
    const on = ON[source];
    if (kind === "complaint") return `Posted on ${on} about frustrations with ${v}.`;
    if (subject.kind === "competitor") return leaving ? `Asked on ${on} for an alternative to ${v}.` : `Asked on ${on} about ${v}.`;
    if (subject.kind === "problem") return `Asked on ${on} which tool to use for ${v}.`;
    return `Asked on ${on} for ${article(v)} ${v} recommendation.`;
  }
  const thread = THREAD[source];
  if (kind === "complaint") return `${thread} complaining about ${v}.`;
  if (subject.kind === "competitor") return leaving ? `${thread} asking for an alternative to ${v}.` : `${thread} asking about ${v}.`;
  if (subject.kind === "problem") return `${thread} asking which tool to use for ${v}.`;
  return `${thread} asking for ${article(v)} ${v} recommendation.`;
}

function aiMessages(items: { title: string; snippet: string }[]): AiMessage[] {
  return [
    {
      role: "system",
      content:
        "You are given numbered search-result snippets from public conversations. For each one decide what its author is doing: " +
        '"ask" - personally asking for a product recommendation or an alternative to a product; "complaint" - personally complaining about a product they use; ' +
        '"neither" - anything else, including vendor marketing, a listicle or comparison article, a job advert, news, a tutorial, or a question a seller puts to the reader. ' +
        `Judge only what the snippet says; when unsure answer "neither". ${UNTRUSTED_RULE} Reply with JSON {"items":[{"n": number, "verdict": "ask"|"complaint"|"neither"}]} and nothing else.`,
    },
    { role: "user", content: [...items.map((it, i) => fence(`item_${i + 1}`, `${it.title} / ${it.snippet}`, 500)), "Return JSON only."].join("\n") },
  ];
}

interface Candidate {
  result: SearchResult;
  url: string;
  place: AskPlace;
  subject: AskSubject;
  verdict: AskVerdict;
  when: Date | null;
  aiChecked: boolean;
}

export async function findPublicAsks(cfg: { competitors?: string[]; problems?: string[]; category?: string; sources?: AskSource[]; days?: number }, opts: PlayEngineOptions = {}): Promise<PlayEngineResult> {
  const run = new PlayRun(opts);
  const limit = findingLimit(opts);
  const competitors = cleanList(cfg?.competitors, 10, 80);
  const problems = cleanList(cfg?.problems, 10, 160);
  const category = cleanLine(cfg?.category, 120);
  const chosen = (Array.isArray(cfg?.sources) ? cfg.sources : []).filter((s): s is AskSource => ALL_SOURCES.includes(s as AskSource));
  const sources = chosen.length ? [...new Set(chosen)] : ALL_SOURCES;
  const days = typeof cfg?.days === "number" && Number.isFinite(cfg.days) ? clampInt(cfg.days, 30, 1, 3650) : null;
  const subjects: AskSubject[] = [
    ...competitors.map((value): AskSubject => ({ kind: "competitor", value })),
    ...problems.map((value): AskSubject => ({ kind: "problem", value })),
    ...(category ? [{ kind: "category", value: category } as AskSubject] : []),
  ];
  if (!subjects.length) {
    run.block("No competitor, problem or category was given, so there was nothing to search for.");
    return { findings: [], trace: run.trace };
  }

  const queries = buildAskQueries(subjects, sources);
  const byUrl = new Map<string, Candidate>();
  let asked = 0;
  const tooOldSeen = new Set<string>();
  for (const { query, subject } of queries) {
    if (asked >= MAX_SEARCHES || run.expired || byUrl.size >= limit * 2) break;
    asked++;
    for (const r of await run.search(query, 20)) {
      const url = safeHttpUrl(r?.url);
      if (!url || typeof r.title !== "string") continue;
      const place = askPlace(url);
      if (!place || !sources.includes(place.source)) continue;
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      const snippet = typeof r.snippet === "string" ? r.snippet : "";
      const text = `${r.title} ${snippet}`;
      // The competitor's own community or site is its page, not a public ask.
      if (competitors.some((c) => normCompanyName(c).length >= 3 && rootDomain(host).split(".")[0].replace(/[^a-z0-9]/g, "") === normCompanyName(c))) continue;
      // The result must be about what was searched for: a degraded search returns anything.
      if (subject.kind === "competitor" ? !new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(subject.value)}(?![\\p{L}\\p{N}])`, "iu").test(text) : !topicOverlap(text, subject.value)) continue;
      const verdict = classifyAsk(r.title, snippet, subject.kind === "competitor" ? subject.value : undefined);
      if (!verdict) continue;
      const u = new URL(url);
      u.hash = "";
      const key = place.source === "hackernews" ? `hn:${u.searchParams.get("id")}` : `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
      const when = snippetDate(snippet);
      if (days !== null && when && when.getTime() < Date.now() - days * 86_400_000) {
        tooOldSeen.add(key);
        continue;
      }
      const have = byUrl.get(key);
      if (!have || (verdict.strong && !have.verdict.strong)) byUrl.set(key, { result: r, url: u.toString(), place, subject, verdict, when, aiChecked: false });
    }
  }
  if (queries.length > asked && !run.expired && byUrl.size < limit * 2) {
    run.note(`${asked} of ${queries.length} searches were run, to keep this run within its search allowance.`);
  }
  const tooOld = tooOldSeen.size;
  if (tooOld > 0) run.note(`${tooOld} conversation${tooOld === 1 ? "" : "s"} older than ${days} days ${tooOld === 1 ? "was" : "were"} left out.`);

  /* A second opinion on wording that a seller could have written just as well. */
  const kept: Candidate[] = [];
  const unsure: Candidate[] = [];
  for (const c of byUrl.values()) (c.verdict.strong ? kept : unsure).push(c);
  let droppedByAi = 0;
  const unanswered: Candidate[] = [];
  for (let b = 0; b < MAX_AI_BATCHES && unsure.length && run.aiUsable && !run.expired; b++) {
    const batch = unsure.splice(0, AI_BATCH);
    const res = await run.askJson<{ items?: unknown }>(aiMessages(batch.map((c) => ({ title: c.result.title, snippet: typeof c.result.snippet === "string" ? c.result.snippet : "" }))), { maxTokens: 300 });
    const verdicts = new Map<number, string>();
    for (const it of res && Array.isArray(res.items) ? (res.items as unknown[]).slice(0, AI_BATCH * 2) : []) {
      const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
      const n = typeof o.n === "number" ? o.n : Number.NaN;
      const v = plainString(o.verdict, 20).toLowerCase();
      if (Number.isInteger(n) && n >= 1 && n <= batch.length && (v === "ask" || v === "complaint" || v === "neither")) verdicts.set(n, v);
    }
    batch.forEach((c, i) => {
      const v = verdicts.get(i + 1);
      // No answer for this one: it goes back to the rules below.
      if (!v) unanswered.push(c);
      else if (v === "neither") droppedByAi++;
      else kept.push({ ...c, aiChecked: true });
    });
  }
  if (droppedByAi > 0) run.note(`${droppedByAi} result${droppedByAi === 1 ? "" : "s"} that looked like an ask ${droppedByAi === 1 ? "was" : "were"} judged to be marketing and left out.`);
  // Without a second opinion, unclear wording is kept only where sellers rarely post it.
  for (const c of [...unanswered, ...unsure]) if (c.place.source === "reddit" || c.place.source === "hackernews") kept.push(c);

  const findings: PlayFinding[] = [];
  for (const c of kept) {
    const author = c.place.source === "linkedin" && c.place.vanity ? linkedinPostAuthor(c.result.title) : null;
    const person = !!author && !!c.place.vanity && vanityMatches(c.place.vanity, author.name);
    const confidence = c.aiChecked ? 0.65 : c.verdict.strong ? (c.verdict.kind === "ask" ? 0.75 : 0.7) : 0.5;
    const base = {
      relevantBecause: reasonFor(c.verdict.kind, person, c.place.source, c.subject, c.verdict.leaving),
      evidenceUrl: c.url,
      evidenceTitle: cleanThreadTitle(c.result.title) || THREAD[c.place.source],
      evidenceQuote: c.verdict.quote,
      signalType: c.verdict.kind === "ask" ? "public_ask" : "public_complaint",
      ...(c.when ? { signalAt: c.when } : {}),
      // A fact a model helped establish never reads as more certain than 0.7.
      confidence: c.aiChecked ? Math.min(0.7, confidence) : confidence,
    };
    const f =
      person && author
        ? finishFinding({ kind: "person", fullName: author.name, ...pick(splitName(author.name)), linkedinUrl: `https://www.linkedin.com/in/${c.place.vanity!.toLowerCase()}`, ...base })
        : finishFinding({ kind: "post", ...base });
    if (f) findings.push(f);
  }
  if (run.searchAnswered && !findings.length) run.note("The searches answered, but none of the results was a person asking or complaining.");

  const trace = run.finish(run.searchAnswered, "Nothing could be searched, so no conversations could be checked.");
  return { findings: rankFindings(findings, limit), trace };
}

function pick(n: { firstName?: string; lastName?: string }): { firstName?: string; lastName?: string } {
  return { ...(n.firstName ? { firstName: n.firstName } : {}), ...(n.lastName ? { lastName: n.lastName } : {}) };
}
