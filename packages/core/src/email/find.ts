import type { EmailFindResult, EmailStatus } from "../types.js";
import { candidatesFor, inferPatternFromEmails, PATTERNS } from "./pattern.js";
import { isCatchAll, resolveMx, smtpProbe, verifyEmail, type VerifyOptions } from "./verify.js";
import { fetchJson } from "../util/http.js";
import { webSearch } from "../search/index.js";

export interface FindEmailInput {
  firstName: string;
  lastName: string;
  domain: string;
  /** Known pattern for this domain, e.g. "{first}.{last}" */
  knownPattern?: string | null;
  /** Emails already seen at this domain (to infer pattern) */
  knownEmails?: string[];
}

/**
 * Find a person's work email:
 * 1. Hunter.io (if key) - 25 free/month
 * 2. Web search for the literal address
 * 3. Pattern candidates + MX + SMTP probe (free)
 */
export async function findEmail(input: FindEmailInput, opts: VerifyOptions = {}): Promise<EmailFindResult> {
  const { firstName, lastName, domain } = input;
  const candidates: EmailFindResult["candidates"] = [];

  if (opts.hunterApiKey) {
    const h = await fetchJson<{ data?: { email?: string; score?: number } }>(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${opts.hunterApiKey}`,
    );
    if (h?.data?.email) {
      const conf = (h.data.score ?? 60) / 100;
      const status: EmailStatus = conf >= 0.8 ? "valid" : "risky";
      candidates.push({ email: h.data.email.toLowerCase(), status, confidence: conf });
      return { email: h.data.email.toLowerCase(), status, confidence: conf, pattern: patternOf(h.data.email, firstName, lastName), candidates };
    }
  }

  // Web search for a literal published address
  try {
    const q = `"${firstName} ${lastName}" "@${domain}"`;
    const results = await webSearch(q, { count: 10, minResults: 1 });
    const re = new RegExp(`[a-z0-9._%+-]+@${domain.replace(/\./g, "\\.")}`, "gi");
    for (const r of results) {
      for (const m of `${r.title} ${r.snippet}`.match(re) ?? []) {
        const e = m.toLowerCase();
        if (looksLikePerson(e, firstName, lastName)) {
          const v = await verifyEmail(e, opts);
          candidates.push({ email: e, status: v.status, confidence: Math.max(v.confidence, 0.75) });
          if (v.status !== "invalid") return { email: e, status: v.status, confidence: Math.max(v.confidence, 0.8), pattern: patternOf(e, firstName, lastName), candidates };
        }
      }
    }
  } catch {}

  const mx = await resolveMx(domain);
  if (!mx) return { status: "invalid", confidence: 0.9, candidates };
  const mxHost = mx[0].exchange;
  const preferred = input.knownPattern ?? inferPatternFromEmails(input.knownEmails ?? [])?.pattern ?? null;
  const list = candidatesFor(firstName, lastName, domain, preferred);

  const smtpEnabled = opts.smtp ?? process.env.SMTP_PROBE_ENABLED !== "false";
  if (!smtpEnabled) {
    const best = list[0];
    candidates.push({ email: best, status: "risky", confidence: preferred ? 0.6 : 0.35 });
    return { email: best, status: "risky", confidence: preferred ? 0.6 : 0.35, pattern: preferred ?? PATTERNS[0], candidates };
  }

  const catchAll = await isCatchAll(domain, mxHost);
  if (catchAll === true) {
    const best = list[0];
    candidates.push({ email: best, status: "catch_all", confidence: preferred ? 0.65 : 0.45 });
    return { email: best, status: "catch_all", confidence: preferred ? 0.65 : 0.45, pattern: preferred ?? PATTERNS[0], candidates };
  }
  if (catchAll === null) {
    // SMTP blocked (port 25 unavailable) → pattern-only guess
    const best = list[0];
    candidates.push({ email: best, status: "risky", confidence: preferred ? 0.6 : 0.35 });
    return { email: best, status: "risky", confidence: preferred ? 0.6 : 0.35, pattern: preferred ?? PATTERNS[0], candidates };
  }

  for (const e of list.slice(0, 8)) {
    const p = await smtpProbe(e, mxHost);
    if (p.result === "accepted") {
      candidates.push({ email: e, status: "valid", confidence: 0.92 });
      return { email: e, status: "valid", confidence: 0.92, pattern: patternOf(e, firstName, lastName), candidates };
    }
    candidates.push({ email: e, status: p.result === "rejected" ? "invalid" : "unknown", confidence: p.result === "rejected" ? 0.9 : 0.3 });
    if (p.result === "blocked" || p.result === "error") break;
  }
  return { status: "unknown", confidence: 0.2, candidates };
}

function looksLikePerson(email: string, first: string, last: string) {
  const local = email.split("@")[0];
  const f = first.toLowerCase().replace(/[^a-z]/g, "");
  const l = last.toLowerCase().replace(/[^a-z]/g, "");
  return (f && local.includes(f)) || (l && local.includes(l)) || (f && l && local.startsWith(f[0] + l));
}

function patternOf(email: string, first: string, last: string) {
  const local = email.split("@")[0].toLowerCase();
  const f = first.toLowerCase().replace(/[^a-z]/g, "");
  const l = last.toLowerCase().replace(/[^a-z]/g, "");
  for (const p of PATTERNS) {
    const cand = p.replace("{first}", f).replace("{last}", l).replace("{f}", f[0] ?? "").replace("{l}", l[0] ?? "");
    if (cand === local) return p;
  }
  return undefined;
}
