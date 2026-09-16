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

export async function resolveMx(domain: string) {
  const c = mxCache.get(domain);
  if (c && Date.now() - c.at < TTL) return c.hosts;
  let hosts: { exchange: string; priority: number }[] | null = null;
  try {
    hosts = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    if (hosts.length === 0) hosts = null;
  } catch {
    try {
      // Fallback: A record means mail may still be accepted per RFC 5321
      const a = await dns.resolve4(domain);
      hosts = a.length ? [{ exchange: domain, priority: 0 }] : null;
    } catch {
      hosts = null;
    }
  }
  mxCache.set(domain, { at: Date.now(), hosts });
  return hosts;
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

export async function isCatchAll(domain: string, mxHost: string): Promise<boolean | null> {
  const c = catchAllCache.get(domain);
  if (c && Date.now() - c.at < TTL) return c.value;
  const rand = `zq${Math.random().toString(36).slice(2, 10)}x${Date.now().toString(36)}@${domain}`;
  const r = await smtpProbe(rand, mxHost);
  const value = r.result === "accepted" ? true : r.result === "rejected" ? false : null;
  catchAllCache.set(domain, { at: Date.now(), value });
  return value;
}

export interface VerifyOptions {
  smtp?: boolean;
  hunterApiKey?: string;
  abstractApiKey?: string;
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

  const mx = await resolveMx(domain);
  checks.mx = !!mx;
  if (!mx) return result("invalid", 0.95, "no MX / A record");
  const mxHost = mx[0].exchange;

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
    const ca = await isCatchAll(domain, mxHost);
    if (ca) {
      checks.smtp = "catch_all";
      return result("catch_all", 0.6, "domain accepts all addresses", mxHost);
    }
    return result(checks.roleAccount ? "risky" : "valid", checks.roleAccount ? 0.7 : 0.93, "SMTP accepted", mxHost);
  }
  if (probe.result === "rejected") return result("invalid", 0.9, `SMTP rejected: ${probe.detail?.slice(0, 80)}`, mxHost);
  return result("risky", 0.5, `SMTP ${probe.result}: ${probe.detail?.slice(0, 80) ?? ""}`, mxHost);
}
