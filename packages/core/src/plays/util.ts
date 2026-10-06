import { ZERO_WIDTH_CLASS } from "../ai/untrusted.js";
import { extractDomain, normalizeLinkedinUrl } from "../util/domain.js";
import type { PlayFinding, PlayRunTrace } from "./types.js";

/**
 * Control characters (line breaks and tabs included), the C1 block, the Unicode line and
 * paragraph separators, and every character that takes no space on screen. A value that
 * came from a web page or an upload is shown to a reviewer and may reach an email, so none
 * of these survive.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
/** Characters with no width are deleted, not spaced out: "Goo<ZWSP>gle" is "Google", and "evil<ZWSP>.example/pay" is a link. */
const ZERO_WIDTH = new RegExp(`[${ZERO_WIDTH_CLASS}]`, "g");
const visible = (s: string): string => s.replace(ZERO_WIDTH, "").replace(CONTROL, " ");

/** How much of any one value is ever scanned, so no regex below runs over an unbounded string. */
const MAX_SCAN = 8_000;

/**
 * One clean line of text taken from the web or an upload: no control or invisible
 * characters, no markup, single spaces, bounded. Not a sentence builder - see `safeSentence`.
 */
export function cleanLine(value: unknown, max = 200): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return visible(String(value).slice(0, Math.min(MAX_SCAN, max * 4 + 400)))
    .replace(/<\/?[a-z!][^<>]{0,200}>/gi, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * A verbatim quote from a page: only what cannot be shown is removed (control and invisible
 * characters, runs of whitespace). Angle brackets stay - the text is rendered as text.
 */
export function cleanQuote(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  return visible(value.slice(0, Math.min(MAX_SCAN, max * 4 + 400))).replace(/\s+/g, " ").trim().slice(0, max).trim();
}

const SCHEME_URL = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"')\]]*/gi;
const WWW_URL = /\bwww\.[^\s<>"')\]]+/gi;
/** `name.tld/path`, `name.tld:8080` - a link however it is written. */
const HOST_WITH_PATH = /(?<![\p{L}\p{N}.@-])(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,24}(?:\/\S*|:\d+\S*)/gu;
const IP_ADDRESS = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/\S*)?/g;
const EMAIL = /[^\s<>()@,;:]+@[^\s<>()@,;:]+\.[^\s<>()@,;:]+/g;
const HANDLE = /(^|[\s(\["'])@[\p{L}\p{N}_.-]{1,40}/gu;
/** `Booking.com`, `evil.example`: a bare name with a dotted ending, which a mail client turns into a link. */
const BARE_DOMAIN = /(?<![\p{L}\p{N}.@/-])([\p{L}\p{N}][\p{L}\p{N}-]*)(?:\.[\p{L}][\p{L}\p{N}-]*)*\.[\p{L}]{2,24}(?![\p{L}\p{N}])/gu;

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 3);
  const at = head.lastIndexOf(" ");
  return `${(at > max * 0.6 ? head.slice(0, at) : head).replace(/[\s,;:([-]+$/, "")}...`;
}

/**
 * The shared sanitiser behind every reason sentence.
 *
 * `strict` is for text that may be placed in an email: bare domain names lose their ending
 * ("Booking.com" becomes "Booking") and @handles go, because a mail client makes links of
 * both. Without it only real links are removed, so a reviewer still reads the company's
 * name the way the page wrote it.
 */
function sanitiseSentence(value: unknown, max: number, strict: boolean): string {
  if (typeof value !== "string") return "";
  let s = visible(value.slice(0, MAX_SCAN))
    .replace(/<\/?[a-z!][^<>]{0,200}>/gi, " ")
    .replace(/[<>{}`\\]/g, " ")
    .replace(SCHEME_URL, " ")
    .replace(WWW_URL, " ")
    .replace(EMAIL, " ")
    .replace(HOST_WITH_PATH, " ")
    .replace(IP_ADDRESS, " ");
  if (strict) {
    s = s.replace(HANDLE, "$1").replace(BARE_DOMAIN, "$1").replace(/@/g, " at ");
  }
  s = s
    // What a removed link leaves behind: "[text]()", "( )".
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return cutAtWord(s, max);
}

/** A reason sentence for a reviewer: one line, no links, no markup, at most 300 characters. */
export function safeSentence(text: string, max = 300): string {
  return sanitiseSentence(text, Math.min(Math.max(max, 20), 300), false);
}

/**
 * A reason made safe to place in an email: one line, no URLs, email addresses, @handles,
 * markup, template braces, control or invisible characters, at most 200 characters.
 * Applying it twice changes nothing.
 */
export function mailSafeReason(text: string): string {
  return sanitiseSentence(text, 200, true);
}

export function emptyTrace(): PlayRunTrace {
  return { searches: 0, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [], blocked: false };
}

const MAX_NOTES = 40;

function untouched(t: PlayRunTrace): boolean {
  return !t.blocked && !t.searches && !t.failedSearches && !t.pagesFetched && !t.pagesRefused && !t.aiCalls && !t.notes.length;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Two traces as one. Counts add up and notes are kept in order without repeats. The result
 * is blocked only when every part that did any work was blocked - one part that looked at
 * something means the run as a whole did look.
 */
export function mergeTrace(a: PlayRunTrace, b: PlayRunTrace): PlayRunTrace {
  const notes: string[] = [];
  for (const n of [...(a.notes ?? []), ...(b.notes ?? [])]) {
    if (typeof n === "string" && n && !notes.includes(n) && notes.length < MAX_NOTES) notes.push(n);
  }
  const blocked = untouched(a) ? !!b.blocked : untouched(b) ? !!a.blocked : !!a.blocked && !!b.blocked;
  const blockedReason = blocked ? (a.blocked ? a.blockedReason : undefined) ?? b.blockedReason ?? a.blockedReason : undefined;
  return {
    searches: count(a.searches) + count(b.searches),
    failedSearches: count(a.failedSearches) + count(b.failedSearches),
    pagesFetched: count(a.pagesFetched) + count(b.pagesFetched),
    pagesRefused: count(a.pagesRefused) + count(b.pagesRefused),
    aiCalls: count(a.aiCalls) + count(b.aiCalls),
    notes,
    blocked,
    ...(blocked && blockedReason ? { blockedReason } : {}),
  };
}

const CORPORATE_SUFFIX = /\s+(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|s\.?a|b\.?v|n\.?v|pty|pvt|private|sas|srl|oy|ab|kk|lp|llp)\.?$/i;

/** A company name reduced to what identifies it: case, punctuation, "The" and "Inc." do not. */
export function normCompanyName(name: unknown): string {
  let s = cleanLine(name, 200).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036F]/g, "").replace(/&/g, " and ");
  s = s.replace(/^the\s+/, "");
  for (let i = 0; i < 2; i++) s = s.replace(/[.,]+$/, "").replace(CORPORATE_SUFFIX, "");
  return s.replace(/[^\p{L}\p{N}]+/gu, "");
}

function normPersonName(f: PlayFinding): string {
  const name = cleanLine(f.fullName, 160) || cleanLine([f.firstName, f.lastName].filter(Boolean).join(" "), 160);
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036F]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normEvidenceUrl(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  try {
    const u = new URL(url.slice(0, 2000));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|trk$)/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const query = u.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}

/**
 * What makes two findings the same candidate, so a play never queues one twice.
 *
 * In order: the LinkedIn profile, the email address, the person's name at the company's
 * domain, the company's domain, the person's name at the company's name, the company's
 * name, and last the evidence page. The company's name comes before the evidence page on
 * purpose: one customers page names many companies, and each of them is its own candidate.
 * Lower-cased, at most 300 characters.
 */
export function playDedupeKey(f: PlayFinding): string {
  const cap = (s: string) => s.toLowerCase().slice(0, 300);
  const profile = typeof f.linkedinUrl === "string" ? normalizeLinkedinUrl(f.linkedinUrl) : null;
  if (profile && profile.includes("/in/")) return cap(`li:${profile.split("/in/")[1]}`);
  const email = typeof f.email === "string" ? f.email.trim().toLowerCase() : "";
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return cap(`em:${email}`);
  const evidence = normEvidenceUrl(f.evidenceUrl);
  // A public conversation is the page it lives on, whoever is named in it.
  if (f.kind === "post" && evidence) return cap(`ev:${evidence}`);
  const person = f.kind === "company" ? "" : normPersonName(f);
  const domain = typeof f.companyDomain === "string" ? (extractDomain(f.companyDomain.trim()) ?? "") : "";
  const company = normCompanyName(f.companyName);
  if (person && domain) return cap(`pn:${person}@${domain}`);
  if (!person && domain) return cap(`co:${domain}`);
  if (person && company) return cap(`pn:${person}@${company}`);
  if (!person && company) return cap(`cn:${company}`);
  if (evidence) return cap(`ev:${evidence}${person ? `#${person}` : ""}`);
  return cap(`tx:${person || cleanLine(f.relevantBecause, 280)}`);
}
