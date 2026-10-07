/**
 * Play: companies with a posting for a role the customer names.
 *
 * Searches the public job boards companies use (Greenhouse, Lever, Ashby, Workable,
 * Wellfound, LinkedIn Jobs) plus the open web, reads each result into company, posting
 * title and posting URL, keeps only postings whose title really is the role, and - for the
 * boards that serve their postings to anyone - opens the posting once to check it is still
 * there. Only a posting that was opened and found live is called hiring; one that could not
 * be checked is reported as a posting, and no date is ever claimed.
 *
 * The company's name comes from the posting itself (its title, or the employer in its
 * structured data), then from the search result's own words, and only last from the
 * address - and an address that is one run of letters ("paveakatroveinformationtechnologies")
 * is not a name, so that posting is left out rather than shown under a made-up one.
 */
import type { SearchResult } from "../types.js";
import { titleMatch } from "../icp/score.js";
import { detectHiring } from "../signals/hiring.js";
import { extractDomain, isSocialOrAggregator, rootDomain } from "../util/domain.js";
import { loadHtml } from "../util/html.js";
import { pMap } from "../util/http.js";
import { isPublicHost } from "../util/publicHost.js";
import { MAX_PAGE_CHARS, PlayRun, article, cleanCompanyName, cleanList, findingLimit, finishFinding, rankFindings, safeHttpUrl, slugToName } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, normCompanyName } from "./util.js";

/** Searches one run may fire, whatever the number of roles. */
const MAX_SEARCHES = 24;
const MAX_COMPANY_DOMAINS = 10;

interface Board {
  board: string;
  /** `site:` form used in the query. */
  site: string;
  host: RegExp;
  /** Matches the path of ONE posting and captures the company slug when the path has one. */
  posting: RegExp;
  /** The board serves postings to any visitor, so a posting can be opened once to see that it still exists. */
  checkable: boolean;
}

const BOARDS: Board[] = [
  { board: "Greenhouse", site: "boards.greenhouse.io", host: /^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/, posting: /^\/([a-z0-9_-]+)\/jobs\/\d+/i, checkable: true },
  { board: "Lever", site: "jobs.lever.co", host: /^jobs(?:\.eu)?\.lever\.co$/, posting: /^\/([a-z0-9_.-]+)\/[0-9a-f]{8}-[0-9a-f-]{20,}/i, checkable: true },
  { board: "Ashby", site: "jobs.ashbyhq.com", host: /^jobs\.ashbyhq\.com$/, posting: /^\/([a-z0-9_.%-]+)\/[0-9a-f]{8}-[0-9a-f-]{20,}/i, checkable: true },
  { board: "Workable", site: "apply.workable.com", host: /^apply\.workable\.com$/, posting: /^\/([a-z0-9_-]+)\/j\/[0-9a-z]{6,}/i, checkable: false },
  { board: "Wellfound", site: "wellfound.com/company", host: /^wellfound\.com$/, posting: /^\/(?:company\/([a-z0-9_-]+)\/jobs\/\d+|jobs\/\d+)/i, checkable: false },
  { board: "LinkedIn", site: "linkedin.com/jobs/view", host: /^(?:[a-z]{2,3}\.)?linkedin\.com$/, posting: /^\/jobs\/view\/(?:[^/]*?-at-([a-z0-9%-]+?)-)?\d{6,}/i, checkable: false },
];

/** Query order: the open web first (it works even where `site:` is refused), then boards by how many companies use them. */
const QUERY_SITES = ["", "boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "linkedin.com/jobs/view", "apply.workable.com", "job-boards.greenhouse.io", "wellfound.com/company"];

/** Sites that list other companies' jobs: a result there is a listing or a copy, not the company's own posting. */
const AGGREGATORS = /(?:^|\.)(?:indeed|glassdoor|ziprecruiter|simplyhired|monster|careerbuilder|talent|jooble|adzuna|neuvoo|jobrapido|naukri|shine|timesjobs|foundit|dice|builtin|themuse|flexjobs|remoteok|weworkremotely|otta|welcometothejungle|google|bing|salary|payscale|levels|comparably|reddit|quora|facebook|x|twitter|youtube|medium|wikipedia)\.[a-z.]{2,8}$/i;

const NOT_A_POSTING = /\b\d[\d,]*\+?\s+(?:jobs|positions|openings|roles|vacancies)\b|\bjobs?\s+in\b|\bjobs$|\bjobs\s*\(|\bsalar(?:y|ies)\b|\binterview questions\b|\bjob description\b|\bwhat (?:is|does)\b|\bhow to become\b|\bresume\b|\bcv template\b|\bcourse\b|\bcertification\b|\btraining program\b|\bcareer path\b|\bday in the life\b/i;

const CLOSED = /no longer (?:open|available|accepting|active|posted|taking)|not accepting (?:new )?applications|applications (?:are|have) (?:now )?closed|(?:position|job|role|posting|opening) (?:has been|is|was) (?:filled|closed|removed|expired)|(?:job|posting|page) (?:not found|has expired|is closed)|this job has (?:expired|closed)|we couldn(?:'|\u2019)t find (?:that|this) (?:job|page|posting)/i;

const ABBREVIATIONS: Record<string, string> = {
  sdr: "sales development representative",
  bdr: "business development representative",
  ae: "account executive",
  csm: "customer success manager",
  swe: "software engineer",
  sre: "site reliability engineer",
  pm: "product manager",
  cro: "chief revenue officer",
  cmo: "chief marketing officer",
  cto: "chief technology officer",
  cfo: "chief financial officer",
  coo: "chief operating officer",
  ceo: "chief executive officer",
  vp: "vice president",
  svp: "senior vice president",
};
const SHORT_FORMS: Record<string, string> = { rep: "representative", reps: "representative", sr: "senior", jr: "junior", mgr: "manager", dir: "director", eng: "engineer", dev: "developer", exec: "executive", assoc: "associate" };
const ROLE_STOP = new Set(["of", "the", "and", "a", "an", "for", "in", "at", "to", "ii", "iii", "i"]);

function roleTokens(text: string): string[] {
  const out: string[] = [];
  // A role or a job title is a line: only its first part is read, whatever a result sends as one.
  for (const raw of String(text ?? "").slice(0, 400).toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9+#.]+/)) {
    let t = raw.replace(/^\.+|\.+$/g, "");
    if (!t) continue;
    t = SHORT_FORMS[t] ?? t;
    const long = ABBREVIATIONS[t] ?? (t.endsWith("s") ? ABBREVIATIONS[t.slice(0, -1)] : undefined);
    for (let w of (long ?? t).split(" ")) {
      if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
      if (w && !ROLE_STOP.has(w)) out.push(w);
    }
  }
  return out;
}

/** Does a posting's title name this role? Every word of the role must be in the title ("SDR" and its long form count as the same). */
export function roleMatches(title: string, role: string): boolean {
  const need = roleTokens(role);
  if (!need.length) return false;
  const have = new Set(roleTokens(title));
  if (need.every((n) => have.has(n))) return true;
  return titleMatch(String(title ?? "").slice(0, 400), [String(role ?? "").slice(0, 400)]) === true;
}

export interface JobPosting {
  companyName: string;
  /** The posting's title as the result (or the posting page) gives it. */
  title: string;
  url: string;
  board: string;
  checkable: boolean;
  /** Only when the posting sits on the company's own site. */
  companyDomain?: string;
  /**
   * The name is only the address's slug, and the slug is one unbroken run of letters: not
   * something to show as a company's name. The posting's own page has to name the company.
   */
  unnamed?: boolean;
}

/** A slug that reads as a name: words with separators ("black-duck"), or one short word ("chalk"). */
function readableSlug(slug: string): boolean {
  const words = slug.split(/[-_.\s]+/).filter(Boolean);
  if (!words.length || words.some((w) => w.length > 15 || !/^[a-z0-9]+$/i.test(w))) return false;
  return words.length > 1 || words[0].length <= 10;
}

const SITE_SUFFIX = /\s*[|\u2013\u2014\u00B7-]\s*(?:greenhouse|lever|ashby|ashbyhq|workable|wellfound(?:\s*\(formerly angellist talent\))?|angellist|linkedin|jobs?|careers?|job board|apply now|hiring)\s*$/i;
const NOT_A_COMPANY = /^(?:we|we're|we\u2019re|we are|now|currently|who is|who's|is|are|they|they're|company|companies|startups?|employers?|everyone|anyone|team|teams)$/i;

function companyFrom(raw: string): string | null {
  const s = cleanLine(raw, 160)
    .replace(/\s+(?:[\u2022\u00B7|(\u2013\u2014]|-\s).*$/, "")
    .replace(/\s+in\s+\p{Lu}.*$/u, "")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!s || NOT_A_COMPANY.test(s)) return null;
  return cleanCompanyName(s, 5);
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A result's title as role and company. The slug decides which side of a dash is the company. */
function splitJobTitle(title: string, slug: string | null, leverStyle: boolean): { role: string; company: string | null } | null {
  let t = cleanLine(title, 240);
  for (let i = 0; i < 3; i++) t = t.replace(SITE_SUFFIX, "").trim();
  t = t.replace(/\s*\.\.\.$|\s*\u2026$/, "").trim();
  if (!t) return null;
  let m: RegExpExecArray | null;
  if ((m = /^job application for\s+(.+?)\s+at\s+(.+)$/i.exec(t))) return { role: m[1], company: companyFrom(m[2]) };
  if ((m = /^(.+?)\s+(?:is\s+)?hiring\s+(?:an?\s+)?(.+?)(?:\s+in\s+\p{Lu}.*)?$/u.exec(t)) && !/\bhiring\b/i.test(m[2])) {
    const company = companyFrom(m[1]);
    if (company) return { role: m[2], company };
  }
  if ((m = /^(.+)\s+(?:at|@)\s+(.+)$/i.exec(t))) {
    const company = companyFrom(m[2]);
    if (company) return { role: m[1], company };
  }
  const parts = t.split(/\s+[\u2013\u2014|-]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const s = slug ? squash(slug) : "";
    const hit = s ? parts.findIndex((p) => squash(p) === s || (Math.min(squash(p).length, s.length) >= 4 && (squash(p).startsWith(s) || s.startsWith(squash(p))))) : -1;
    if (hit >= 0) return { role: parts[hit === 0 ? 1 : 0], company: companyFrom(parts[hit]) };
    if (leverStyle) return { role: parts[1], company: companyFrom(parts[0]) };
    return { role: parts[0], company: null };
  }
  return { role: t, company: null };
}

const cleanRole = (role: string): string =>
  cleanLine(role, 160)
    .replace(/^(?:we(?:'re|\u2019re| are)\s+hiring\s+(?:an?\s+)?|now hiring[:\s-]*|hiring[:\s-]+|job opening[:\s-]+|careers?[:\s-]+)/i, "")
    .replace(/^[\s"'\u201C\u201D:-]+|[\s"'\u201C\u201D:,-]+$/g, "")
    .slice(0, 120)
    .trim();

/** One search result as a job posting, or null when it is a listing, an article, or anything that is not one company's posting. */
export function parseJobResult(r: SearchResult): JobPosting | null {
  const url = safeHttpUrl(r?.url);
  if (!url || typeof r.title !== "string") return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const board = BOARDS.find((b) => b.host.test(host));
  if (board) {
    const m = board.posting.exec(u.pathname);
    if (!m) return null;
    let slug: string | null = m[1] ?? null;
    if (slug) {
      try {
        slug = decodeURIComponent(slug);
      } catch {
        slug = null;
      }
    }
    const parsed = splitJobTitle(r.title, slug, board.board === "Lever");
    if (!parsed) return null;
    const role = cleanRole(parsed.role);
    const companyName = parsed.company ?? (slug ? cleanCompanyName(slugToName(slug), 5) : null);
    if (!role || !companyName || NOT_A_POSTING.test(role)) return null;
    // Named only by its address, and the address is not readable words: the posting's page must name the company.
    const unnamed = !parsed.company && !!slug && !readableSlug(slug);
    if (unnamed && !board.checkable) return null;
    u.search = "";
    u.hash = "";
    return { companyName, title: role, url: u.toString(), board: board.board, checkable: board.checkable, ...(unnamed ? { unnamed } : {}) };
  }
  // Anywhere else: only a page that names both the role and the employer, on a path that is a job.
  if (AGGREGATORS.test(host) || isSocialOrAggregator(host)) return null;
  if (!/\/(?:jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|join(?:-us)?|work-with-us|opportunit(?:y|ies)|roles?)(?:\/|$|-)/i.test(u.pathname)) return null;
  const parsed = splitJobTitle(r.title, rootDomain(host).split(".")[0], false);
  if (!parsed || !parsed.company) return null;
  const role = cleanRole(parsed.role);
  if (!role || NOT_A_POSTING.test(role) || NOT_A_POSTING.test(r.title)) return null;
  const label = squash(rootDomain(host).split(".")[0]);
  const name = normCompanyName(parsed.company);
  const own = label.length >= 3 && name.length >= 3 && (label === name || (Math.min(label.length, name.length) >= 4 && (label.includes(name) || name.includes(label))));
  // Someone else's page about a company's job (a repost, a recruiter, a blog) is not that company's posting.
  if (!own) return null;
  u.hash = "";
  return { companyName: parsed.company, title: role, url: u.toString(), board: "their careers page", checkable: false, companyDomain: rootDomain(host) };
}

/** Queries for the roles, ordered so every role gets its first source before any role gets its second. */
export function buildHiringQueries(roles: string[], keywords: string[] = [], locations: string[] = []): string[] {
  const extra = [keywords.slice(0, 2).map((k) => String(k ?? "").slice(0, 200)).join(" "), locations.length ? `(${locations.slice(0, 3).map((l) => `"${String(l ?? "").slice(0, 200).replace(/"/g, "")}"`).join(" OR ")})` : ""].filter(Boolean).join(" ");
  const out: string[] = [];
  for (const site of QUERY_SITES) {
    for (const role of roles) {
      const quoted = `"${String(role ?? "").slice(0, 200).replace(/"/g, " ").replace(/\s+/g, " ").trim()}"`;
      out.push((site ? `site:${site} ${quoted} ${extra}` : `${quoted} job opening ${extra}`).trim());
    }
  }
  return out;
}

/**
 * The sentence a reviewer reads. "Hiring" is said only of a posting that was opened and
 * found live (or read off the company's own careers page); anything else "has a posting".
 * A dash inside the role ("SDR - Outbound") becomes a comma, so the sentence has one dash.
 */
function reasonFor(p: { title: string; board: string }, state: "open" | "unchecked" | "careers"): string {
  const role = p.title.replace(/\s+[-\u2013\u2014]\s+/g, ", ");
  if (state === "careers") return `Hiring ${article(role)} ${role} - listed on their careers page.`;
  if (state === "open") return `Hiring ${article(role)} ${role} - open posting on ${p.board}.`;
  return `Has a posting for ${role} on ${p.board}.`;
}

const SCRIPT_OPEN = /<script(?=[\s>])/gi;
const SCRIPT_CLOSE = /<\/script>/gi;
const LD_JSON_TYPE = /type\s{0,5}=\s{0,5}["']application\/ld\+json["']/i;

interface TextNode {
  type?: string;
  data?: string;
  children?: TextNode[];
}

/**
 * The first `max` characters of the text of the elements a selector finds, in page order
 * (code and styles aside). Read one child at a time and stopped as soon as there is
 * enough, so headings that hold the rest of a large page are not each read to their end.
 */
function firstText($: NonNullable<ReturnType<typeof loadHtml>>, selector: string, max: number): string {
  const out: string[] = [];
  let size = 0;
  for (const el of $(selector).toArray() as unknown as TextNode[]) {
    const lists: TextNode[][] = [[el]];
    const at: number[] = [0];
    while (lists.length && size < max) {
      const top = lists.length - 1;
      if (at[top] >= lists[top].length) {
        lists.pop();
        at.pop();
        continue;
      }
      const n = lists[top][at[top]++];
      if (n.type === "text") {
        out.push(n.data ?? "");
        size += (n.data ?? "").length;
      } else if (n.children?.length && n.type !== "comment" && n.type !== "script" && n.type !== "style") {
        lists.push(n.children);
        at.push(0);
      }
    }
    if (size >= max) break;
  }
  return out.join("").slice(0, max);
}

/**
 * The contents of a page's JSON-LD blocks, found by plain search through its text. Each
 * search starts where the last one ended and a search that finds nothing ends the scan,
 * so a page of a hundred thousand unclosed `<script` tags costs one pass, not one per tag.
 */
function ldJsonBlocks(body: string): string[] {
  const out: string[] = [];
  SCRIPT_OPEN.lastIndex = 0;
  for (let m = SCRIPT_OPEN.exec(body); m; m = SCRIPT_OPEN.exec(body)) {
    const gt = body.indexOf(">", m.index);
    if (gt < 0) break;
    SCRIPT_OPEN.lastIndex = gt + 1;
    if (gt - m.index > 2000 || !LD_JSON_TYPE.test(body.slice(m.index, gt))) continue;
    SCRIPT_CLOSE.lastIndex = gt + 1;
    const close = SCRIPT_CLOSE.exec(body);
    if (!close) break;
    const size = close.index - gt - 1;
    if (size >= 2 && size <= 300_000) out.push(body.slice(gt + 1, close.index));
    SCRIPT_OPEN.lastIndex = close.index + close[0].length;
  }
  return out;
}

/**
 * What a posting's own page says: the role and the employer.
 *
 * In order: the employer in the page's structured data (a JobPosting's hiringOrganization),
 * the page title ("Job Application for X at Y", "X @ Y", "Y - X"), and the board's own
 * record of the company's name. Nothing is guessed: a page that names no employer returns none.
 */
export function readPostingPage(page: string, slug: string | null, leverStyle: boolean): { role?: string; company?: string } {
  let role: string | undefined;
  let company: string | undefined;
  const body = String(page ?? "").slice(0, MAX_PAGE_CHARS);
  for (const block of ldJsonBlocks(body)) {
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      continue;
    }
    const queue: unknown[] = [data];
    for (let seen = 0; queue.length && seen < 60 && !company; seen++) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node.slice(0, 20));
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["@graph"]) queue.push(o["@graph"]);
      const types = ([] as unknown[]).concat(o["@type"] ?? []).map((t) => String(t).toLowerCase());
      if (!types.includes("jobposting")) continue;
      const org = o.hiringOrganization;
      const name = org && typeof org === "object" && !Array.isArray(org) ? (org as Record<string, unknown>).name : org;
      const clean = typeof name === "string" ? cleanCompanyName(name, 6) : null;
      if (clean) company = clean;
      if (typeof o.title === "string" && cleanRole(o.title)) role = cleanRole(o.title);
    }
    if (company) break;
  }
  // The title sits at the top of the page. An unreadable page (see util/html.ts) has no title to go by.
  const $ = loadHtml(body, 300_000);
  const titles = $ ? [cleanLine($("title").first().text(), 240), cleanLine($('meta[property="og:title"]').attr("content"), 240)].filter(Boolean) : [];
  for (const t of titles) {
    const parsed = splitJobTitle(t, slug, leverStyle);
    if (!parsed) continue;
    if (parsed.company && !company) {
      company = parsed.company;
      role = role ?? (cleanRole(parsed.role) || undefined);
    }
  }
  if (!company) {
    const m = /"company_name"\s{0,20}:\s{0,20}"((?:[^"\\]|\\.){2,80})"/.exec(body);
    if (m) {
      try {
        company = cleanCompanyName(JSON.parse(`"${m[1]}"`), 6) ?? undefined;
      } catch {
        // not a JSON string after all
      }
    }
  }
  // A title that is only the role ("Sales Development Representative") still says what the posting is for.
  if (!role) {
    for (const t of titles) {
      const parsed = splitJobTitle(t, slug, leverStyle);
      const r = parsed ? cleanRole(parsed.role) : "";
      if (r && !NOT_A_POSTING.test(r)) {
        role = r;
        break;
      }
    }
  }
  return { ...(role ? { role } : {}), ...(company ? { company } : {}) };
}

/** What a customer is told when the job boards themselves could not be searched (an answer from the open web is not one about the boards). */
export const JOB_BOARDS_NOT_SEARCHED = "The job boards could not be searched this time, so no postings could be looked for. This is not a result about your market - try again later.";

export async function findHiringCompanies(cfg: { roles: string[]; keywords?: string[]; locations?: string[]; companyDomains?: string[] }, opts: PlayEngineOptions = {}): Promise<PlayEngineResult> {
  const run = new PlayRun(opts);
  const limit = findingLimit(opts);
  const roles = cleanList(cfg?.roles, 10, 100);
  const keywords = cleanList(cfg?.keywords, 10, 60);
  const locations = cleanList(cfg?.locations, 10, 80);
  const domains = cleanList(cfg?.companyDomains, 50, 255);
  const findings: PlayFinding[] = [];
  if (!roles.length) {
    run.block("No role was given, so there was nothing to search for.");
    return { findings: [], trace: run.trace };
  }

  /* Named companies first: their own careers pages. */
  let careersReached = 0;
  if (domains.length > MAX_COMPANY_DOMAINS) run.note(`Only the first ${MAX_COMPANY_DOMAINS} of ${domains.length} named companies were checked in this run.`);
  for (const raw of domains.slice(0, MAX_COMPANY_DOMAINS)) {
    if (run.expired) break;
    const domain = extractDomain(raw);
    if (!domain || (!opts.allowPrivateHosts && (!isPublicHost(domain) || !isPublicHost(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0])))) {
      run.trace.pagesRefused++;
      run.note(`${cleanLine(raw, 80)} is not a public web address, so it was not fetched.`);
      continue;
    }
    // No company name is passed, so this reads the company's own pages and never falls back to a search.
    const sig = await run.within(detectHiring(domain, undefined, { allowPrivateHosts: opts.allowPrivateHosts === true }).catch(() => null));
    if (!sig) continue;
    if (sig.refused) {
      run.trace.pagesRefused++;
      run.note(`${domain} is not a public web address, so it was not fetched.`);
      continue;
    }
    if (!sig.reached) {
      run.note(`No careers page on ${domain} could be read.`);
      continue;
    }
    careersReached++;
    run.trace.pagesFetched++;
    const evidenceUrl = safeHttpUrl(sig.careersUrl);
    if (!evidenceUrl) continue;
    const title = sig.titles.map((t) => cleanRole(t)).find((t) => t && roles.some((r) => roleMatches(t, r)));
    if (!title) continue;
    const f = finishFinding({
      kind: "company",
      companyDomain: domain,
      relevantBecause: reasonFor({ title, board: "" }, "careers"),
      evidenceUrl,
      evidenceTitle: title,
      evidenceQuote: title,
      signalType: "job_posting",
      confidence: 0.8,
    });
    if (f) findings.push(f);
  }

  /* The market: public job boards and the open web. */
  const queries = buildHiringQueries(roles, keywords, locations);
  const byCompany = new Map<string, JobPosting>();
  let asked = 0;
  /** Searches of one job board each (`site:`), and how many of them got an answer about that board. */
  let boardSearches = 0;
  let boardsAnswered = 0;
  for (const q of queries) {
    if (asked >= MAX_SEARCHES || run.expired || !run.canSearch || byCompany.size >= limit * 2) break;
    asked++;
    const before = { searches: run.trace.searches, failed: run.trace.failedSearches };
    const results = await run.search(q, 20);
    if (/^site:/i.test(q) && run.trace.searches > before.searches) {
      boardSearches++;
      // A search that failed - or whose results were all from somewhere else and had to be discarded - did not search the board.
      if (run.trace.failedSearches === before.failed) boardsAnswered++;
    }
    for (const r of results) {
      const p = parseJobResult(r);
      if (!p || !roles.some((role) => roleMatches(p.title, role))) continue;
      const key = normCompanyName(p.companyName);
      if (!key) continue;
      const have = byCompany.get(key);
      // One posting per company: a checkable board beats one that cannot be checked, and a posting whose
      // company the result itself names beats one known only by its address.
      if (!have || (p.checkable && !have.checkable) || (have.unnamed && !p.unnamed && p.checkable === have.checkable)) byCompany.set(key, p);
    }
  }
  if (queries.length > asked && !run.expired && byCompany.size < limit * 2) {
    run.note(`${asked} of ${queries.length} job-board searches were run, to keep this run within its search allowance. Fewer roles per play means each role is searched more widely.`);
  }

  /* Open each checkable posting once: gone means dropped, readable means its own title is the evidence. */
  let gone = 0;
  let nameless = 0;
  /** Postings on a board that can be checked, whose check could not be finished. */
  let unfinished = 0;
  const check = async (p: JobPosting): Promise<PlayFinding | null> => {
    let state: "open" | "unchecked" = "unchecked";
    let posting = p;
    // What the board said when it was asked for the posting: null when it was not asked, or would not say.
    let page: Awaited<ReturnType<PlayRun["fetchPage"]>> | null = null;
    if (p.checkable) {
      // A posting that can be checked and whose check did not finish - no time left, no requests left, the
      // board not answering, a page that could not be read - is not reported at all: "has a posting" was said of
      // one that had been taken down, because the check ran out of requests before it reached the page.
      if (run.expired) {
        unfinished++;
        return null;
      }
      // One page per posting (three requests: boards move a posting from one address to another), paced per board, and
      // only where the board's robots.txt allows it. Reading those rules is not taken out of the three.
      page = await run.fetchPage(p.url, { maxRequests: 3, robotsCharged: false });
      if (!page.ok && page.kind === "missing") {
        gone++;
        return null;
      }
      if (!page.ok && !(page.kind === "refused" && page.why !== "unreadable page")) {
        unfinished++;
        return null;
      }
      // (A board that refuses the check - its robots.txt, a 403 - has answered: the posting is as unknown as one
      // on a board that cannot be checked, and is reported as that: it "has a posting", nobody looked further.)
    }
    if (page?.ok) {
      const landed = new URL(page.url);
      const board = BOARDS.find((b) => b.host.test(landed.hostname.toLowerCase().replace(/^www\./, "")));
      // A closed posting sends the visitor back to the company's list of jobs.
      const at = board ? board.posting.exec(landed.pathname) : null;
      if (!board || !at || /[?&]error=/i.test(landed.search)) {
        gone++;
        return null;
      }
      const $ = loadHtml(page.body, 400_000);
      if (!$) {
        // Fetched but unreadable (see util/html.ts): nothing was learned from it, so the posting is not reported.
        run.unreadable(page.url);
        unfinished++;
        return null;
      }
      // Some boards answer for a closed posting with a page that says so.
      if (CLOSED.test(firstText($, "title, h1, h2, [role='alert'], .error, .message, .closed, .job-closed", 4000))) {
        gone++;
        return null;
      }
      const said = readPostingPage(page.body, at[1] ?? null, board.board === "Lever");
      // The page now advertises a different role: the result was out of date.
      if (said.role && !roles.some((role) => roleMatches(said.role!, role))) {
        gone++;
        return null;
      }
      posting = { ...p, title: said.role ?? p.title, ...(said.company ? { companyName: said.company, unnamed: false } : {}) };
      state = "open";
    }
    // Still known only by an address that is not a name: not shown under a made-up one.
    if (posting.unnamed) {
      nameless++;
      return null;
    }
    return finishFinding({
      kind: "company",
      companyName: posting.companyName,
      ...(posting.companyDomain ? { companyDomain: posting.companyDomain } : {}),
      relevantBecause: reasonFor(posting, state),
      evidenceUrl: posting.url,
      evidenceTitle: posting.title,
      evidenceQuote: posting.title,
      signalType: "job_posting",
      confidence: state === "open" ? 0.85 : 0.65,
    });
  };
  // Checkable postings first; a posting that turns out to be gone makes room for the next candidate.
  const postings = [...byCompany.values()].sort((a, b) => Number(b.checkable) - Number(a.checkable));
  let fromSearch = 0;
  for (let at = 0; at < postings.length && fromSearch < limit; at += 4) {
    const batch = postings.slice(at, at + Math.min(4, limit - fromSearch));
    at -= 4 - batch.length;
    for (const f of await pMap(batch, check, 4)) {
      if (f) {
        findings.push(f);
        fromSearch++;
      }
    }
  }
  if (nameless > 0) run.note(`${nameless} posting${nameless === 1 ? "" : "s"} ${nameless === 1 ? "was" : "were"} left out because the company behind ${nameless === 1 ? "it" : "them"} could not be named from the posting.`);
  if (gone > 0) run.note(`${gone} posting${gone === 1 ? "" : "s"} found by search ${gone === 1 ? "was" : "were"} no longer there when opened, so ${gone === 1 ? "it was" : "they were"} left out.`);
  if (unfinished > 0) run.note(`${unfinished} posting${unfinished === 1 ? "" : "s"} found by search could not be opened to check that ${unfinished === 1 ? "it is" : "they are"} still there, so ${unfinished === 1 ? "it was" : "they were"} left out.`);

  // Postings live on the job boards. When not one search of a board got an answer about that board, the boards were
  // not searched - whatever a search of the open web sent back - and with nothing found any other way, this run
  // did not look: that is said, instead of "nothing found".
  if (boardSearches > 0 && boardsAnswered === 0 && fromSearch === 0 && careersReached === 0 && run.searchAnswered && !run.trace.blocked) run.block(JOB_BOARDS_NOT_SEARCHED);

  const trace = run.finish(run.searchAnswered || careersReached > 0, "Nothing could be searched or read, so no postings could be checked.");
  return { findings: rankFindings(findings, limit), trace };
}
