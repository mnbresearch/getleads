import type { EmailFindResult, EmailStatus, EmailVerification } from "../types.js";
import { candidatesFor, inferPatternFromEmails, PATTERNS } from "./pattern.js";
import { hasVerifierConfigured, isCatchAll, isVerifierVerdict, resolveMxDetailed, smtpProbe, verifyEmail, type VerifyOptions } from "./verify.js";
import { hunterEmailVerdict } from "../providers/people.js";
import { fetchJson } from "../util/http.js";
import { searchDebugOn, webSearch } from "../search/index.js";
import { meter } from "../util/meter.js";

export interface FindEmailInput {
  firstName: string;
  lastName: string;
  domain: string;
  /** Known pattern for this domain, e.g. "{first}.{last}" */
  knownPattern?: string | null;
  /** Emails already seen at this domain (to infer pattern) */
  knownEmails?: string[];
}

export interface FindEmailOptions extends VerifyOptions {
  /**
   * Addresses already known to be bad (bounced, or verified invalid). Never returned and
   * never spent a verification on. Compared lowercased.
   */
  exclude?: string[];
  /**
   * How many pattern candidates a paid verifier may check when SMTP cannot. Default 3: the
   * first three patterns cover the large majority of real addresses, and each check costs
   * a credit, so this is the cost ceiling per lead.
   */
  maxVerifierChecks?: number;
  /**
   * Which verifiers this call may spend on. "any" (default) uses whatever is configured.
   * "payg-only" restricts checks to the pay-as-you-go verifiers (Reoon, MillionVerifier):
   * bulk discovery runs this for every lead, and a Hunter-only setup would otherwise burn
   * its small monthly verification allowance on pattern guesses.
   */
  verifierPolicy?: "any" | "payg-only";
}

/** Defaults for bulk callers (the pipeline): one check per lead, pay-as-you-go verifiers only. */
export const BULK_FIND_DEFAULTS: Pick<FindEmailOptions, "maxVerifierChecks" | "verifierPolicy"> = { maxVerifierChecks: 1, verifierPolicy: "payg-only" };

/**
 * Find a person's work email:
 * 1. Hunter.io (if key) - 25 free/month
 * 2. Web search for the literal address
 * 3. Pattern candidates, checked by SMTP probe where port 25 is open, otherwise by the
 *    configured verifier (Reoon / MillionVerifier / Hunter), otherwise returned as a guess.
 */
export async function findEmail(input: FindEmailInput, opts: FindEmailOptions = {}): Promise<EmailFindResult> {
  const { firstName, lastName, domain } = input;
  const candidates: EmailFindResult["candidates"] = [];
  const excluded = new Set((opts.exclude ?? []).map((e) => e.trim().toLowerCase()));
  const isExcluded = (e: string) => excluded.has(e.toLowerCase());
  // A PAYG verifier only; Hunter is the finder here and spending a second Hunter credit to
  // check its own answer would double the cost of every lead for no new information.
  const paygOpts: VerifyOptions = { reoonApiKey: opts.reoonApiKey, millionVerifierApiKey: opts.millionVerifierApiKey, smtp: false };
  const hasPayg = !!(opts.reoonApiKey || opts.millionVerifierApiKey);
  // What the verification steps below may spend on. Under "payg-only" Hunter and Abstract
  // never verify (Hunter may still FIND, above - that is its own step).
  const checkOpts: VerifyOptions = opts.verifierPolicy === "payg-only" ? { ...opts, hunterApiKey: undefined, abstractApiKey: undefined } : opts;

  if (opts.hunterApiKey) {
    meter("hunter");
    const h = await fetchJson<{ data?: { email?: string; score?: number; verification?: { status?: string | null } } }>(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${encodeURIComponent(opts.hunterApiKey)}`,
      { provider: "hunter" },
    );
    const found = h?.data?.email?.toLowerCase();
    if (found && !isExcluded(found)) {
      // Hunter's score is how well the address fits the domain's pattern, not whether the
      // mailbox exists. Mapping score >= 80 to "valid" labelled a pattern guess as verified,
      // which clears the send gate. hunterEmailVerdict reads verification.status instead.
      const verdict = hunterEmailVerdict(h!.data!.verification?.status ?? undefined, h!.data!.score);
      let status: EmailStatus = verdict.status;
      let confidence = verdict.confidence;
      let verifiedBy: string | undefined = verdict.status === "valid" || verdict.status === "invalid" || verdict.status === "catch_all" ? `hunter:${h!.data!.verification?.status}` : undefined;
      if (hasPayg) {
        // A configured verifier gets the last word before anything is called valid.
        const v = await verifyEmail(found, paygOpts);
        if (isVerifierVerdict(v)) {
          status = v.status;
          confidence = v.status === "valid" ? Math.max(v.confidence, confidence) : v.confidence;
          verifiedBy = v.verifiedBy;
        }
      }
      candidates.push({ email: found, status, confidence });
      if (status !== "invalid") return { email: found, status, confidence, pattern: patternOf(found, firstName, lastName), candidates, verifiedBy, source: "hunter" };
      excluded.add(found);
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
        if (isExcluded(e)) continue;
        if (looksLikePerson(e, firstName, lastName)) {
          const v = await verifyEmail(e, checkOpts);
          candidates.push({ email: e, status: v.status, confidence: Math.max(v.confidence, 0.75) });
          if (v.status !== "invalid") return { email: e, status: v.status, confidence: Math.max(v.confidence, 0.8), pattern: patternOf(e, firstName, lastName), candidates, verifiedBy: verifiedByOf(v), source: "web" };
          excluded.add(e);
        }
      }
    }
  } catch (e) {
    // Best-effort step: the pattern path below still runs. Logged so it is not invisible.
    // The domain is who the customer is prospecting, and the message can echo the search
    // text: both stay out of the log unless an operator turned search debugging on.
    console.warn(searchDebugOn() ? `[findEmail] web search step failed for ${domain}: ${(e as Error).message}` : `[findEmail] web search step failed: ${(e as Error)?.name ?? "Error"}`);
  }

  const { hosts: mx, answered: dnsAnswered } = await resolveMxDetailed(domain);
  if (!mx) {
    // Same distinction as verifyEmail: a resolver that never answered tells us nothing
    // about this domain, and reporting "invalid" at 0.9 off a DNS blip poisoned every lead
    // at that company for as long as the lookup stayed cached.
    if (!dnsAnswered) return { status: "unknown", confidence: 0, candidates };
    return { status: "invalid", confidence: 0.9, candidates };
  }
  const mxHost = mx[0].exchange;
  const preferred = input.knownPattern ?? inferPatternFromEmails(input.knownEmails ?? [])?.pattern ?? null;
  const list = candidatesFor(firstName, lastName, domain, preferred).filter((e) => !isExcluded(e));
  if (!list.length) return { status: "unknown", confidence: 0, candidates };
  const guessPattern = (e: string) => patternOf(e, firstName, lastName) ?? preferred ?? PATTERNS[0];

  /** The old answer when nothing could check: the best-ranked candidate, as a guess. */
  const guess = (from: string[] = list): EmailFindResult => {
    const best = from[0];
    if (!best) return { status: "unknown", confidence: 0.2, candidates };
    candidates.push({ email: best, status: "risky", confidence: preferred ? 0.6 : 0.35 });
    return { email: best, status: "risky", confidence: preferred ? 0.6 : 0.35, pattern: guessPattern(best), candidates, source: "pattern" };
  };

  /**
   * With SMTP unavailable (production: Render blocks port 25), check the top candidates with
   * whichever verifier is configured. This path used to return list[0] as "risky" without
   * asking the Reoon/MillionVerifier keys the operator was paying for.
   */
  const viaVerifier = async (): Promise<EmailFindResult> => {
    const max = Math.max(0, opts.maxVerifierChecks ?? 3);
    const vopts: VerifyOptions = { ...checkOpts, smtp: false };
    const rejected = new Set<string>();
    let fallback: { email: string; status: EmailStatus; confidence: number; verifiedBy?: string } | null = null;
    for (const e of list.slice(0, max)) {
      const v = await verifyEmail(e, vopts);
      if (!isVerifierVerdict(v)) {
        // No verifier answered (out of credit, cooling off, unknown). Stop spending: the next
        // candidate would get the same non-answer.
        break;
      }
      candidates.push({ email: e, status: v.status, confidence: v.confidence });
      if (v.status === "valid") return { email: e, status: "valid", confidence: v.confidence, pattern: guessPattern(e), candidates, verifiedBy: v.verifiedBy, source: "pattern" };
      // A catch-all verdict is about the domain: every other candidate would get the same
      // one, so stop here and say so rather than calling the first pattern verified.
      if (v.status === "catch_all") return { email: e, status: "catch_all", confidence: Math.min(v.confidence, preferred ? 0.65 : 0.45), pattern: guessPattern(e), candidates, verifiedBy: v.verifiedBy, source: "pattern" };
      if (v.status === "invalid") rejected.add(e);
      else if (!fallback) fallback = { email: e, status: v.status, confidence: v.confidence, verifiedBy: v.verifiedBy };
    }
    if (fallback) return { email: fallback.email, status: fallback.status, confidence: fallback.confidence, pattern: guessPattern(fallback.email), candidates, verifiedBy: fallback.verifiedBy, source: "pattern" };
    return guess(list.filter((e) => !rejected.has(e)));
  };

  const smtpEnabled = opts.smtp ?? process.env.SMTP_PROBE_ENABLED !== "false";
  if (!smtpEnabled) return hasVerifierConfigured(checkOpts) ? viaVerifier() : guess();

  const catchAll = await isCatchAll(domain, mxHost);
  if (catchAll === true) {
    const best = list[0];
    candidates.push({ email: best, status: "catch_all", confidence: preferred ? 0.65 : 0.45 });
    return { email: best, status: "catch_all", confidence: preferred ? 0.65 : 0.45, pattern: preferred ?? PATTERNS[0], candidates, verifiedBy: "smtp", source: "pattern" };
  }
  if (catchAll === null) {
    // SMTP blocked (port 25 unavailable) -> a verifier if there is one, else a pattern guess
    return hasVerifierConfigured(checkOpts) ? viaVerifier() : guess();
  }

  for (const e of list.slice(0, 8)) {
    const p = await smtpProbe(e, mxHost);
    if (p.result === "accepted") {
      candidates.push({ email: e, status: "valid", confidence: 0.92 });
      return { email: e, status: "valid", confidence: 0.92, pattern: patternOf(e, firstName, lastName), candidates, verifiedBy: "smtp", source: "pattern" };
    }
    candidates.push({ email: e, status: p.result === "rejected" ? "invalid" : "unknown", confidence: p.result === "rejected" ? 0.9 : 0.3 });
    if (p.result === "blocked" || p.result === "error") break;
  }
  return { status: "unknown", confidence: 0.2, candidates };
}

/** The verifier that vouched for a verification, or undefined for an unchecked one. */
function verifiedByOf(v: EmailVerification): string | undefined {
  return isVerifierVerdict(v) || v.verifiedBy === "smtp" ? v.verifiedBy : undefined;
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
