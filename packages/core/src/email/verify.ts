import { promises as dns } from "node:dns";
import net from "node:net";
import type { EmailStatus, EmailVerification } from "../types.js";
import { fetchJson } from "../util/http.js";
import { meter } from "../util/meter.js";

const FREE_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com", "protonmail.com", "proton.me", "rediffmail.com", "zoho.com", "mail.com", "gmx.com", "yandex.com",
]);
const DISPOSABLE = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "getnada.com", "sharklasers.com", "dispostable.com", "fakeinbox.com", "throwawaymail.com", "maildrop.cc", "mohmal.com",
]);
const ROLE_LOCALS = new Set([
  "info", "contact", "hello", "sales", "support", "admin", "team", "hr", "careers", "jobs", "press", "media", "help", "office", "mail", "marketing", "billing", "noreply", "no-reply", "webmaster", "postmaster", "abuse", "security", "enquiries", "inquiries", "accounts", "finance", "legal",
]);

const EMAIL_SYNTAX = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const mxCache = new Map<string, { at: number; hosts: { exchange: string; priority: number }[] | null }>();
const catchAllCache = new Map<string, { at: number; value: boolean | null }>();
const TTL = 12 * 60 * 60 * 1000;

/**
 * Codes the resolver returns when the DOMAIN has no mail, as opposed to when WE could not ask.
 *
 * NXDOMAIN means no such domain. NODATA/ENODATA means the domain exists and has no record of
 * that type. Both are answers. SERVFAIL, REFUSED, TIMEOUT, ECONNREFUSED and friends are not
 * answers - they are the resolver failing - and must never be read as "this address is bad".
 */
const DNS_SAYS_NO = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "NODATA"]);

export interface MxLookup {
  hosts: { exchange: string; priority: number }[] | null;
  /**
   * True when the resolver actually answered, whatever it said.
   *
   * This is the whole point of the type. Before it existed, `resolveMx` returned `null` for
   * "this domain accepts no mail" AND for "the resolver timed out", the caller returned
   * status "invalid" at 0.95 confidence, and the result was cached for twelve hours. One
   * resolver blip therefore marked every lead at every affected domain as a confidently
   * invalid address, and the cache made the blip outlive itself by half a day. A false
   * negative written with high confidence is worse than no answer at all, because nothing
   * downstream can tell it was a guess.
   */
  answered: boolean;
}

/**
 * The DNS calls, behind a seam.
 *
 * Injectable purely so the distinction above can be tested. The bug this module guards
 * against only appears when the resolver misbehaves, and a test that cannot make the
 * resolver misbehave cannot prove the guard works - which is how the bug survived in the
 * first place. Production always uses the real resolver.
 */
export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
}

const REAL_RESOLVER: MxResolver = {
  resolveMx: (d) => dns.resolveMx(d),
  resolve4: (d) => dns.resolve4(d),
};

let resolver: MxResolver = REAL_RESOLVER;

/** Testing seam. Passing null restores the real resolver. */
export function setMxResolver(r: MxResolver | null) {
  resolver = r ?? REAL_RESOLVER;
}

/** Testing seam: forget every cached lookup. */
export function resetMxCache() {
  mxCache.clear();
  catchAllCache.clear();
}

export async function resolveMxDetailed(domain: string): Promise<MxLookup> {
  const c = mxCache.get(domain);
  // Only a real answer is ever cached, so a cache hit is always `answered`.
  if (c && Date.now() - c.at < TTL) return { hosts: c.hosts, answered: true };

  let hosts: { exchange: string; priority: number }[] | null = null;
  let answered = false;
  try {
    hosts = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    if (hosts.length === 0) hosts = null;
    answered = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    try {
      // Fallback: an A record means mail may still be accepted per RFC 5321.
      const a = await resolver.resolve4(domain);
      hosts = a.length ? [{ exchange: domain, priority: 0 }] : null;
      answered = true;
    } catch (e2) {
      const code2 = (e2 as NodeJS.ErrnoException)?.code ?? "";
      // Both lookups failed. Only call it an answer when the resolver said "no such thing".
      answered = DNS_SAYS_NO.has(code) && DNS_SAYS_NO.has(code2);
      hosts = null;
    }
  }

  if (answered) mxCache.set(domain, { at: Date.now(), hosts });
  return { hosts, answered };
}

/** Back-compatible shape: the hosts alone, for callers that do not need the distinction. */
export async function resolveMx(domain: string) {
  return (await resolveMxDetailed(domain)).hosts;
}

export interface SmtpProbeResult {
  result: "accepted" | "rejected" | "catch_all" | "blocked" | "error";
  detail?: string;
}

/**
 * SMTP handshake (no email sent): HELO → MAIL FROM → RCPT TO.
 * Needs outbound port 25, which many PaaS block; returns "blocked" then.
 */
let smtpBlockedUntil = 0;
let consecutiveTimeouts = 0;

/** True when outbound port 25 looks blocked (auto-detected after repeated timeouts). */
export function isSmtpBlocked() {
  return Date.now() < smtpBlockedUntil;
}

export async function smtpProbe(email: string, mxHost: string, opts: { timeoutMs?: number; heloDomain?: string; from?: string } = {}): Promise<SmtpProbeResult> {
  if (isSmtpBlocked()) return { result: "blocked", detail: "port 25 blocked (cached)" };
  const r = await smtpProbeRaw(email, mxHost, opts);
  if (r.result === "blocked" && r.detail === "timeout") {
    if (++consecutiveTimeouts >= 2) smtpBlockedUntil = Date.now() + 10 * 60_000;
  } else consecutiveTimeouts = 0;
  return r;
}

async function smtpProbeRaw(email: string, mxHost: string, opts: { timeoutMs?: number; heloDomain?: string; from?: string } = {}): Promise<SmtpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const helo = opts.heloDomain ?? "mail.prospex.dev";
  const from = opts.from ?? `verify@${helo}`;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    let stage = 0;
    let buf = "";
    let done = false;
    const finish = (r: SmtpProbeResult) => {
      if (done) return;
      done = true;
      try {
        socket.write("QUIT\r\n");
      } catch {}
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ result: "blocked", detail: "timeout" }), timeoutMs);
    socket.on("error", (e) => {
      clearTimeout(timer);
      finish({ result: (e as NodeJS.ErrnoException).code === "ECONNREFUSED" || (e as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "blocked" : "error", detail: e.message });
    });
    socket.on("data", (d) => {
      buf += d.toString();
      if (!/\r?\n$/.test(buf)) return;
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      buf = "";
      if (!/^\d{3} /.test(last)) return; // multi-line continuation
      const code = Number(last.slice(0, 3));
      if (stage === 0) {
        if (code !== 220) return finish({ result: "error", detail: last });
        socket.write(`EHLO ${helo}\r\n`);
        stage = 1;
      } else if (stage === 1) {
        if (code !== 250) return finish({ result: "error", detail: last });
        socket.write(`MAIL FROM:<${from}>\r\n`);
        stage = 2;
      } else if (stage === 2) {
        if (code !== 250) return finish({ result: "error", detail: last });
        socket.write(`RCPT TO:<${email}>\r\n`);
        stage = 3;
      } else if (stage === 3) {
        clearTimeout(timer);
        if (code === 250 || code === 251) return finish({ result: "accepted", detail: last });
        if (code === 550 || code === 551 || code === 553 || code === 554 || (code === 450 && /user|mailbox|recipient/i.test(last))) return finish({ result: "rejected", detail: last });
        if (code >= 400 && code < 500) return finish({ result: "blocked", detail: last }); // greylisting
        return finish({ result: "error", detail: last });
      }
    });
  });
}

/**
 * Does this domain accept mail for any address at all?
 *
 * `null` means the probe could not answer - greylisted, blocked, reset - and callers must
 * treat that as unknown rather than as "no". An inconclusive probe is not cached, because a
 * twelve-hour memory of one blocked minute would turn every address at a catch-all domain
 * into a confidently verified one for the rest of the working day.
 */
export async function isCatchAll(domain: string, mxHost: string): Promise<boolean | null> {
  const c = catchAllCache.get(domain);
  if (c && Date.now() - c.at < TTL) return c.value;
  const rand = `zq${Math.random().toString(36).slice(2, 10)}x${Date.now().toString(36)}@${domain}`;
  const r = await smtpProbe(rand, mxHost);
  const value = r.result === "accepted" ? true : r.result === "rejected" ? false : null;
  if (value !== null) catchAllCache.set(domain, { at: Date.now(), value });
  return value;
}

export interface VerifyOptions {
  smtp?: boolean;
  hunterApiKey?: string;
  abstractApiKey?: string;
  /** Reoon Email Verifier. Pay-as-you-go credits that never expire; tried first. */
  reoonApiKey?: string;
  /** MillionVerifier. Pay-as-you-go credits that never expire; tried second. */
  millionVerifierApiKey?: string;
}

export async function verifyEmail(emailRaw: string, opts: VerifyOptions = {}): Promise<EmailVerification> {
  const email = emailRaw.trim().toLowerCase();
  const [local, domain] = email.split("@");
  const checks: EmailVerification["checks"] = { syntax: false, disposable: false, roleAccount: false, freeProvider: false, mx: null, smtp: "skipped" };
  const result = (status: EmailStatus, confidence: number, reason?: string, mxHost?: string): EmailVerification => ({ email, status, confidence, checks, reason, mxHost });

  checks.syntax = EMAIL_SYNTAX.test(email) && local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
  if (!checks.syntax) return result("invalid", 0.99, "bad syntax");
  checks.disposable = DISPOSABLE.has(domain);
  if (checks.disposable) return result("invalid", 0.95, "disposable domain");
  checks.roleAccount = ROLE_LOCALS.has(local);
  checks.freeProvider = FREE_PROVIDERS.has(domain);

  const { hosts: mx, answered: dnsAnswered } = await resolveMxDetailed(domain);
  checks.mx = !!mx;
  if (!mx) {
    // The resolver never answered, so we know nothing about this address. Saying "invalid"
    // here used to write a 0.95-confidence false negative off a transient DNS failure.
    if (!dnsAnswered) return result("unknown", 0, "could not resolve DNS for this domain - not checked, rather than bad");
    return result("invalid", 0.95, "no MX / A record");
  }
  const mxHost = mx[0].exchange;

  // Dedicated verifiers first, cheapest first.
  //
  // Order is a cost decision. A dedicated verifier costs about a tenth of a cent per check
  // on pay-as-you-go credits that never expire; a Hunter verification costs a Hunter credit,
  // which is far better spent FINDING an address than checking one. Before these existed,
  // every verification in the product drew down the same Hunter balance as email finding.
  //
  // Each verifier only answers when it has a real verdict. "unknown", an error body, an
  // exhausted balance or a timeout all fall through to the next one, so running out of
  // credits with one provider degrades to the next rather than to a wrong answer.
  if (opts.reoonApiKey) {
    meter("reoon");
    const r = await fetchJson<{ status?: string; is_catch_all?: boolean; overall_score?: number }>(
      `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(opts.reoonApiKey)}&mode=power`,
      { timeoutMs: 30_000, provider: "reoon" },
    );
    const map: Record<string, EmailStatus> = {
      safe: "valid",
      invalid: "invalid",
      disabled: "invalid",
      disposable: "invalid",
      spamtrap: "invalid",
      catch_all: "catch_all",
      // Deliverable in principle, but not a person, or not accepting mail right now.
      role_account: "risky",
      inbox_full: "risky",
    };
    const status = r?.status ? map[r.status] : undefined;
    if (status) {
      checks.smtp = status === "valid" ? "accepted" : status === "invalid" ? "rejected" : status === "catch_all" ? "catch_all" : "error";
      const conf = typeof r?.overall_score === "number" ? Math.max(0, Math.min(1, r.overall_score / 100)) : status === "valid" ? 0.95 : status === "invalid" ? 0.95 : 0.6;
      return result(status, conf, `reoon:${r!.status}`, mxHost);
    }
  }
  if (opts.millionVerifierApiKey) {
    meter("millionverifier");
    const m = await fetchJson<{ result?: string; error?: string; role?: boolean; quality?: string }>(
      `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(opts.millionVerifierApiKey)}&email=${encodeURIComponent(email)}&timeout=20`,
      { timeoutMs: 25_000, provider: "millionverifier" },
    );
    // MillionVerifier answers HTTP 200 with an `error` field for a bad key or an empty
    // balance. That is not a verdict about the address and must not be read as one.
    if (m && !m.error && m.result) {
      const map: Record<string, EmailStatus> = { ok: "valid", catch_all: "catch_all", invalid: "invalid", disposable: "invalid" };
      const status = map[m.result];
      if (status) {
        const finalStatus: EmailStatus = status === "valid" && m.role ? "risky" : status;
        checks.smtp = finalStatus === "valid" ? "accepted" : finalStatus === "invalid" ? "rejected" : finalStatus === "catch_all" ? "catch_all" : "error";
        return result(finalStatus, finalStatus === "valid" ? 0.95 : finalStatus === "invalid" ? 0.95 : 0.6, `millionverifier:${m.result}`, mxHost);
      }
    }
  }

  // Optional external verifiers (free tiers) take precedence when configured
  if (opts.hunterApiKey) {
    meter("hunter");
    const h = await fetchJson<{ data?: { status: string; score: number } }>(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${opts.hunterApiKey}`,
    );
    if (h?.data) {
      const map: Record<string, EmailStatus> = { valid: "valid", invalid: "invalid", accept_all: "catch_all", webmail: "valid", disposable: "invalid", unknown: "unknown" };
      checks.smtp = h.data.status === "valid" ? "accepted" : h.data.status === "invalid" ? "rejected" : h.data.status === "accept_all" ? "catch_all" : "error";
      return result(map[h.data.status] ?? "unknown", (h.data.score ?? 50) / 100, `hunter:${h.data.status}`, mxHost);
    }
  }
  if (opts.abstractApiKey) {
    meter("abstract_email");
    const a = await fetchJson<{ deliverability?: string; is_catchall_email?: { value: boolean }; quality_score?: string }>(
      `https://emailvalidation.abstractapi.com/v1/?api_key=${opts.abstractApiKey}&email=${encodeURIComponent(email)}`,
    );
    if (a?.deliverability) {
      const catchAll = a.is_catchall_email?.value;
      checks.smtp = a.deliverability === "DELIVERABLE" ? (catchAll ? "catch_all" : "accepted") : a.deliverability === "UNDELIVERABLE" ? "rejected" : "error";
      const status: EmailStatus = a.deliverability === "DELIVERABLE" ? (catchAll ? "catch_all" : "valid") : a.deliverability === "UNDELIVERABLE" ? "invalid" : "risky";
      return result(status, Number(a.quality_score ?? 0.5), `abstract:${a.deliverability}`, mxHost);
    }
  }

  const smtpEnabled = opts.smtp ?? process.env.SMTP_PROBE_ENABLED !== "false";
  if (!smtpEnabled) {
    checks.smtp = "skipped";
    return result(checks.roleAccount ? "risky" : "risky", 0.55, "MX ok, SMTP probe disabled", mxHost);
  }

  const probe = await smtpProbe(email, mxHost);
  checks.smtp = probe.result;
  if (probe.result === "accepted") {
    // isCatchAll is deliberately tri-state: true, false, or null when the probe itself was
    // blocked or errored. `if (ca)` folded that null into false, so a genuine catch-all
    // domain whose random-address probe hit a greylist came back as a VERIFIED VALID
    // address at 0.93 - which earns the scoring credit for a checked address, suppresses
    // re-verification, and clears the send gate. findEmail handles the same tri-state
    // explicitly, which is what makes this a slip rather than a convention.
    const ca = await isCatchAll(domain, mxHost);
    if (ca === true) {
      checks.smtp = "catch_all";
      return result("catch_all", 0.6, "domain accepts all addresses", mxHost);
    }
    if (ca === null) {
      checks.smtp = "catch_all";
      return result("risky", 0.5, "SMTP accepted, but the catch-all check could not complete - this may accept every address", mxHost);
    }
    return result(checks.roleAccount ? "risky" : "valid", checks.roleAccount ? 0.7 : 0.93, "SMTP accepted", mxHost);
  }
  if (probe.result === "rejected") return result("invalid", 0.9, `SMTP rejected: ${probe.detail?.slice(0, 80)}`, mxHost);
  return result("risky", 0.5, `SMTP ${probe.result}: ${probe.detail?.slice(0, 80) ?? ""}`, mxHost);
}
