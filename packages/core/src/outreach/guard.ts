/**
 * Output guard for anything a model wrote that may be SENT to a person.
 *
 * AI-personalised emails go out automatically. The prompt is built from text outsiders
 * control (a scraped page, a CSV column, an earlier reply), so the model's answer has to be
 * treated as attacker-influenced: before this existed, whatever came back was stored and
 * sent verbatim - HTML, a payment link, header-looking lines, the prompt itself, a 50,000
 * character body, or `[object Object]` when the model returned the wrong shape.
 *
 * `guardOutreach` decides whether a draft may go out as written. It never repairs: a draft
 * that fails is rejected whole and the caller sends the tenant's own template instead. A
 * false rejection costs one personalised email; a false acceptance sends a stranger's text
 * under the customer's name.
 */
import { SECRET_RE } from "../ai/redact.js";
import { UNTRUSTED_MARK } from "../ai/untrusted.js";

export interface GuardContext {
  /**
   * Hosts a link may point at: the tenant's own domain(s) (sender address domain, website)
   * plus every host already present in the tenant-authored template text.
   */
  allowedHosts?: string[];
  /** The prospect's own company domain: may be NAMED (bare, no path) but not linked with a path. */
  leadDomain?: string | null;
  /** Addresses that may appear in the text (the sender's from/reply-to, the lead's own). */
  allowedEmails?: (string | null | undefined)[];
  maxBody?: number;
  minBody?: number;
  maxSubject?: number;
  minSubject?: number;
  /** false for channels with no subject line (a LinkedIn note, a call script). Default true. */
  requireSubject?: boolean;
}

export type GuardResult = { ok: true; subject: string; body: string; reasons: [] } | { ok: false; reasons: string[] };

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// At most 8 labels: an unbounded repeat made this quadratic on "a.a.a.a...".
const BARE_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}([a-z]{2,24}))\b(\/[^\s<>"')\]]*)?/gi;
// Bounded quantifiers throughout: this runs on model output, and an unbounded `[\w.+-]+@`
// is quadratic on a long run with no "@" in it (a 50,000-character body took seconds).
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const TAG_RE = /<\/?[a-z!][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;
const HEADER_RE = /^\s*(?:bcc|cc|to|from|reply-to|subject|sender|return-path|content-type|content-transfer-encoding|mime-version|x-[\w-]+)\s*:/im;
const PLACEHOLDER_RE =
  /\[(?:your|my|first|last|full|company|recipient|sender|insert|name|title|product|value)[^\]\n]{0,40}\]|\{\{[^}\n]*\}\}|\{[a-z_]{2,30}\}|<\s*insert[^>]*>|lorem ipsum/i;
/** Case-sensitive on purpose: "on your todo list" is prose, "TODO" is a remnant. */
const PLACEHOLDER_CS_RE = /\bTODO\b|\bXXX+\b/;
/** The prompt, or a refusal, coming back as the "email". */
const LEAK_RE = new RegExp(
  [
    "system prompt",
    UNTRUSTED_MARK,
    "<<<|>>>",
    "you write high-converting",
    "you draft short, human",
    "value proposition\\s*:",
    "sender'?s offer\\s*:",
    "sender'?s instructions\\s*:",
    "extra instructions\\s*:",
    "base template to adapt",
    "reply with json",
    "return json only",
    // "As an AI, I ..." / "as an AI language model" - not "as an AI company".
    "\\bas an ai(?: language| text)?(?: model| assistant|,| i\\b)",
    "as a (?:large )?language model",
    "i (?:cannot|can't|am unable to|'m unable to) (?:help|assist|comply)",
  ].join("|"),
  "i",
);
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i;
const KEY_ASSIGN_RE = /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[=:]\s*[^\s"']{8,}/i;
const LONG_HEX_RE = /\b[a-fA-F0-9]{32,}\b/;
const LONG_B64_RE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/**
 * Top-level domains a mail client turns into a link when it sees `name.tld` in plain text.
 * Bare-domain detection is limited to these so "Node.js" or "end.The" is not read as a link.
 */
const LINKABLE_TLDS = new Set(
  (
    "com net org io co ai app dev info biz me xyz online site tech store shop cloud club top live link click page pro work " +
    "agency digital email solutions services systems group company media news blog one world today life space website zone " +
    "finance capital money pay bank support help download win vip icu cc tv to ly gg sh so gl fm im is it in id us uk ca au de fr es nl be ch at " +
    "se no dk fi ie pt pl cz ru ua tr gr ro hu bg il ae sa qa eg za ng ke br mx ar cl pe jp cn hk tw kr sg my th vn ph pk bd lk np nz edu gov mil int eu asia test example invalid localhost"
  ).split(" "),
);

/**
 * Domains that are shared by everyone, so "the sender's own domain" proves nothing about a
 * link on them: free mailbox providers, and big hosts that carry open redirectors, file
 * shares and form builders. A tenant sending from a yahoo.com address would otherwise have
 * allowlisted r.search.yahoo.com/...RU=<anywhere>. Links on these never pass the guard; the
 * tenant's own template (sent unchanged when a draft is rejected) can still carry them.
 */
const SHARED_HOSTS = new Set(
  (
    "gmail.com googlemail.com google.com googleusercontent.com goo.gl yahoo.com yahoo.co.in yahoo.co.uk ymail.com rocketmail.com " +
    "outlook.com hotmail.com live.com msn.com microsoft.com office.com sharepoint.com onedrive.com icloud.com me.com mac.com apple.com " +
    "aol.com proton.me protonmail.com pm.me zoho.com zohomail.com zoho.in yandex.com yandex.ru mail.ru gmx.com gmx.net gmx.de mail.com " +
    "rediffmail.com fastmail.com hey.com tutanota.com facebook.com fb.com fb.me instagram.com linkedin.com lnkd.in twitter.com x.com t.co " +
    "youtube.com youtu.be bit.ly tinyurl.com ow.ly is.gd buff.ly rebrand.ly cutt.ly t.ly rb.gy shorturl.at dropbox.com box.com wetransfer.com " +
    "github.io githubusercontent.com vercel.app netlify.app pages.dev web.app firebaseapp.com herokuapp.com blogspot.com wordpress.com " +
    "notion.site notion.so typeform.com jotform.com airtable.com docs.google.com forms.gle sites.google.com amazonaws.com cloudfront.net windows.net"
  ).split(" "),
);
const isSharedHost = (h: string) => [...SHARED_HOSTS].some((d) => h === d || h.endsWith(`.${d}`));

/** A dotted-quad (optionally with port/path): a link to an address, never to a site of the tenant's. */
const IP_LINK_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s<>"')\]]*)?/g;

const hostOf = (u: string) => {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * Hosts mentioned in tenant-authored text (step templates and variants, the sender's
 * signature, value proposition, company name): both full URLs and bare domains.
 */
/**
 * How much of one tenant-authored text is scanned for hosts and addresses. The patterns
 * below are not linear on adversarial input ("a." repeated), and these texts come from
 * request bodies; a real template or signature is far shorter than this.
 */
const MAX_HOST_SCAN = 8_000;

export function hostsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const s = String(t ?? "").slice(0, MAX_HOST_SCAN);
    if (!s) continue;
    for (const m of s.matchAll(URL_RE)) {
      const h = bareHost(hostOf(m[0]));
      if (h) out.add(h);
    }
    for (const m of s.replace(EMAIL_RE, " ").replace(URL_RE, " ").matchAll(BARE_RE)) {
      if (LINKABLE_TLDS.has(m[2].toLowerCase())) out.add(bareHost(m[1]));
    }
  }
  return [...out];
}

/** Email addresses present in tenant-authored text. */
export function emailsIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of String(t ?? "").slice(0, MAX_HOST_SCAN).matchAll(EMAIL_RE)) out.add(m[0].toLowerCase());
  return [...out];
}

/** The domain part of an address, for building the allowlist from a sender's From address. */
export function domainOfEmail(email: string | null | undefined): string | null {
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,24})$/i.exec(String(email ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * May this model-written draft be sent as it is?
 *
 * Rejects: a subject or body that is not a string; control characters or a line break in
 * the subject; HTML; header-looking lines; a body outside 20-1800 characters or a subject
 * outside 3-150; unreplaced placeholders; the prompt or a refusal echoed back; anything
 * shaped like a credential; an email address that is neither the sender's nor the lead's;
 * and any link whose host is not on the allowlist.
 */
export function guardOutreach(draft: { subject?: unknown; body?: unknown } | null | undefined, ctx: GuardContext = {}): GuardResult {
  if (!draft || typeof draft.body !== "string" || (typeof draft.subject !== "string" && (ctx.requireSubject ?? true))) {
    return { ok: false, reasons: ["non_string_output"] };
  }
  const requireSubject = ctx.requireSubject ?? true;
  const reasons: string[] = [];
  const rawSubject = typeof draft.subject === "string" ? draft.subject : "";
  const subject = rawSubject.trim();
  const body = draft.body.replace(/\r\n?/g, "\n").trim();
  const maxBody = ctx.maxBody ?? 1800;
  const minBody = ctx.minBody ?? 20;
  const maxSubject = ctx.maxSubject ?? 150;
  const minSubject = ctx.minSubject ?? 3;

  if (requireSubject ? subject.length < minSubject || subject.length > maxSubject : subject.length > maxSubject) reasons.push("subject_length");
  // Checked on the untrimmed value: "Hello\r\nBcc: x" must not be rescued by a trim.
  // NEL and the Unicode line/paragraph separators break a line in some clients as well.
  if (/[\r\n\u0085\u2028\u2029]/.test(subject) || CTRL.test(rawSubject)) reasons.push("subject_control_chars");
  if (body.length < minBody || body.length > maxBody) reasons.push("body_length");
  if (CTRL.test(body)) reasons.push("body_control_chars");
  // Far over the limit: rejected on length alone. Nothing below needs to read 50,000
  // characters to reach the same verdict.
  if (body.length > maxBody * 4 || subject.length > maxSubject * 4) return { ok: false, reasons: [...new Set(reasons)] };

  const allowed = (ctx.allowedHosts ?? []).map(bareHost).filter((d) => !!d && !isSharedHost(d));
  const lead = ctx.leadDomain ? bareHost(ctx.leadDomain) : null;
  const mails = new Set((ctx.allowedEmails ?? []).filter((e): e is string => typeof e === "string" && !!e).map((e) => e.toLowerCase()));
  const hostAllowed = (h: string) => allowed.some((d) => under(h, d));

  for (const [where, s] of [["subject", subject], ["body", body]] as const) {
    if (TAG_RE.test(s)) reasons.push(`${where}_html`);
    if (PLACEHOLDER_RE.test(s) || PLACEHOLDER_CS_RE.test(s)) reasons.push(`${where}_placeholder`);
    if (LEAK_RE.test(s)) reasons.push(`${where}_prompt_echo`);
    // A long token inside a link the tenant's own template already carries is not a leak.
    const withoutOwnLinks = s.replace(URL_RE, (u) => (hostAllowed(bareHost(hostOf(u))) ? " " : u));
    if (
      SECRET_RE.test(s) ||
      BEARER_RE.test(s) ||
      KEY_ASSIGN_RE.test(s) ||
      LONG_HEX_RE.test(withoutOwnLinks) ||
      [...withoutOwnLinks.matchAll(LONG_B64_RE)].some((m) => /[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0]))
    ) {
      reasons.push(`${where}_secret_pattern`);
    }
  }
  if (HEADER_RE.test(body)) reasons.push("body_header_line");

  const text = `${subject}\n${body}`;
  for (const m of text.matchAll(EMAIL_RE)) if (!mails.has(m[0].toLowerCase())) reasons.push("foreign_email_address");
  const noMail = text.replace(EMAIL_RE, " ");
  for (const m of noMail.matchAll(URL_RE)) {
    const h = bareHost(hostOf(m[0]));
    if (!h || !hostAllowed(h)) reasons.push(`link_host_not_allowed:${(h || "unparseable").slice(0, 80)}`);
  }
  for (const m of noMail.replace(URL_RE, " ").matchAll(BARE_RE)) {
    // name.tld on a TLD mail clients do not auto-link is prose ("Node.js") - unless it has
    // a path, which makes it an address whatever the TLD (.zip, .tk, .cfd ...).
    if (!LINKABLE_TLDS.has(m[2].toLowerCase()) && !m[3]) continue;
    const h = bareHost(m[1]);
    if (hostAllowed(h)) continue;
    // Naming the prospect's own site is fine; a path makes it a link somewhere specific.
    if (lead && h === lead && !m[3]) continue;
    reasons.push(`link_host_not_allowed:${h.slice(0, 80)}`);
  }
  // A bare IP address with a port or path is a link to a machine, not to anybody's website.
  for (const m of noMail.replace(URL_RE, " ").matchAll(IP_LINK_RE)) if (/[:/]/.test(m[0])) reasons.push("link_host_not_allowed:ip-address");
  const unique = [...new Set(reasons)];
  return unique.length ? { ok: false, reasons: unique } : { ok: true, subject, body, reasons: [] };
}

// ───────── inbound replies ─────────

export const REPLY_INTENTS = ["interested", "not_interested", "out_of_office", "unsubscribe", "referral", "question", "other"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

/** Is this one of the intents we act on? Anything else a model returns is not an intent. */
export function isReplyIntent(v: unknown): v is ReplyIntent {
  return typeof v === "string" && (REPLY_INTENTS as readonly string[]).includes(v);
}

/** Model output -> one of the enum values and a confidence in 0..1. Never throws. */
export function coerceIntent(raw: unknown): { intent: ReplyIntent; confidence: number } {
  const r = (raw && typeof raw === "object" ? raw : {}) as { intent?: unknown; confidence?: unknown };
  const intent: ReplyIntent = isReplyIntent(r.intent) ? r.intent : "other";
  const c = typeof r.confidence === "number" ? r.confidence : NaN;
  return { intent, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5 };
}

/**
 * Only what the person wrote this time: quoted history and our own unsubscribe footer are
 * dropped before any rule runs.
 *
 * Without this, "Sounds great, let's talk Tuesday" was classified as an unsubscribe -
 * because the reply quoted our own footer, which contains the word.
 */
export function stripQuoted(text: string): string {
  // Bounded: an inbound email body is attacker-supplied and every line is pattern-matched.
  const lines = String(text ?? "").slice(0, 60_000).replace(/\r\n?/g, "\n").split("\n").map((l) => l.slice(0, 2_000));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Outlook-style blocks quote without a prefix: everything after is history.
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(l) || /^_{5,}\s*$/.test(l)) break;
    if (/^\s*(From|Sent|Von|De|Gesendet|Envoy[eé]):\s.+/i.test(l) && out.some((x) => x.trim())) break;
    if (/^\s*On .{0,200}wrote:\s*$/i.test(l)) {
      // Followed by ">" lines: a prefixed quote. Skip it and keep whatever is written
      // underneath (bottom-posting). Followed by plain text: an unprefixed quote, so the
      // rest is history.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && !/^\s*>/.test(lines[j])) break;
      continue;
    }
    if (/^\s*>/.test(l)) continue;
    if (/If you'd rather not hear from me/i.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** RFC 5322: the address is the LAST <...>; never "the first thing that looks like an email". */
export function senderAddress(from: string): string | null {
  const s = String(from ?? "").slice(-400);
  const angle = s.match(/<\s*([^<>\s]+)\s*>\s*$/);
  const raw = (angle ? angle[1] : s.trim()).toLowerCase();
  return /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(raw) ? raw : null;
}
