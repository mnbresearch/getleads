import net from "node:net";
import nodemailer from "nodemailer";
import { assertPublicHost, isSsrfBlocked, meter } from "@prospex/core";
import { env } from "../env.js";

export interface SendInput {
  from: string; // "Name <email>"
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  provider: string;
  error?: string;
  /**
   * The customer's SMTP settings were refused before any connection was made (a port that
   * is not a mail port, a host that is not public). `error` is then a sentence written for
   * the customer - safe to show as it is, and the only failure text that is.
   */
  refused?: boolean;
}

/**
 * What a failed send says when the PLATFORM has no mail provider set up. It reaches
 * customers (an invite that could not be emailed, a send's failure reason), so it names no
 * server setting; which settings are missing goes to the log.
 */
export const NO_PLATFORM_MAILER = "Email sending is not set up on our side";

export interface MailerConfig {
  provider: "resend" | "smtp" | "system";
  resendApiKey?: string;
  smtp?: { host: string; port: number; user?: string; pass?: string; secure?: boolean };
}

/**
 * Ports a customer's SMTP server may be on.
 *
 * 25 / 465 / 587 are the standard ones; 2525 is the usual alternative where 25 and 587 are
 * blocked (SendGrid, Mailgun, Postmark, Brevo); 2465 and 2587 are Amazon SES's documented
 * alternatives; 26 is what a lot of shared hosting (cPanel) offers for the same reason.
 *
 * Any port at all used to be accepted, which made "add a sender" - which connects straight
 * away and reports how it went - a way to probe any port of any host from our network.
 * `SMTP_ALLOWED_PORTS` (comma-separated) adds to this list for a deployment that needs to.
 */
const DEFAULT_SMTP_PORTS = [25, 26, 465, 587, 2465, 2525, 2587];

export function allowedSmtpPorts(): number[] {
  const extra = (process.env.SMTP_ALLOWED_PORTS ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return [...new Set([...DEFAULT_SMTP_PORTS, ...extra])];
}

/** A customer's SMTP settings were refused before any connection was made. `message` is safe to show them. */
export class SmtpTargetRefused extends Error {
  readonly code = "ESMTPTARGET" as const;
  constructor(message: string) {
    super(message);
    this.name = "SmtpTargetRefused";
  }
}

type SmtpSettings = NonNullable<MailerConfig["smtp"]>;

/**
 * Transport options for a CUSTOMER's SMTP server.
 *
 * The host is a string a tenant typed, and nodemailer resolves it itself when it connects.
 * A check made when the account was saved says nothing about where that name points an
 * hour later, on the send path - and the send path never checked at all. So, every time a
 * transport is built:
 *
 *   - the port must be a mail port;
 *   - the host is resolved here and EVERY address it has must be public (assertPublicHost);
 *   - nodemailer is given the ADDRESS that was checked, so it does no lookup of its own
 *     and there is no second answer for DNS rebinding to supply;
 *   - the original NAME is kept as the TLS servername, so the certificate is still
 *     verified against the name the customer typed, exactly as before.
 *
 * Throws SmtpTargetRefused, with a message that describes the customer's setting and not
 * our network.
 */
export async function tenantSmtpTransportOptions(smtp: SmtpSettings) {
  const host = String(smtp.host ?? "").trim();
  const port = Number(smtp.port);
  if (!host) throw new SmtpTargetRefused("SMTP host is missing.");
  const ports = allowedSmtpPorts();
  // These messages carry no value the tenant supplied (no port, no host). They end up in
  // send errors, and the bounce classifier reads send errors for "550"-style codes: a
  // refused setting must never be mistaken for a recipient who bounced.
  if (!ports.includes(port)) throw new SmtpTargetRefused(`That SMTP port is not allowed. Use one of the standard mail ports: ${ports.join(", ")}.`);
  let address: string;
  try {
    ({ address } = await assertPublicHost(host));
  } catch (e) {
    if (isSsrfBlocked(e)) throw new SmtpTargetRefused("SMTP host must be a public mail server address (for example smtp.gmail.com). Private, local and internal addresses are not allowed.");
    throw new SmtpTargetRefused("The SMTP host could not be found. Check the spelling.");
  }
  const named = net.isIP(host) === 0;
  return {
    host: address,
    port,
    secure: smtp.secure ?? port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    // Bounded. nodemailer's defaults are two minutes to connect and ten to idle: a host that
    // silently drops the connection held the "add sender" request (and a worker slot on every
    // send) for that long, and the form had already told the customer it timed out.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // SNI and certificate verification use the name, not the pinned address. An IP typed
    // as the host has no name to offer, which is how it behaved before too.
    ...(named ? { servername: host, tls: { servername: host } } : {}),
  };
}

export function systemMailerConfig(): MailerConfig | null {
  if (env.resendApiKey) return { provider: "resend", resendApiKey: env.resendApiKey };
  if (env.smtp.host) return { provider: "smtp", smtp: { host: env.smtp.host, port: env.smtp.port, user: env.smtp.user, pass: env.smtp.pass, secure: env.smtp.secure } };
  return null;
}

export async function sendMail(cfg: MailerConfig | null, input: SendInput): Promise<SendResult> {
  // The platform's own mailer (SMTP_HOST and friends in the environment) is configuration
  // we wrote and may legitimately be a relay on a private network. Only a customer's
  // settings go through the public-address check.
  const isSystem = cfg?.provider === "system" || !cfg;
  const c = isSystem ? systemMailerConfig() : cfg;
  if (!c) {
    if (env.nodeEnv !== "production") {
      console.log(`[mailer:dev] to=${input.to} subject=${input.subject}\n${input.text}\n`);
      return { ok: true, provider: "console", providerMessageId: `dev-${Date.now()}` };
    }
    console.warn("[mailer] no email provider configured (set RESEND_API_KEY or SMTP_*); nothing was sent");
    return { ok: false, provider: "none", error: NO_PLATFORM_MAILER };
  }
  try {
    if (c.provider === "resend") {
      meter("resend");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${c.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text, html: input.html, reply_to: input.replyTo, headers: input.headers }),
      });
      const data = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: "resend", error: data.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: "resend", providerMessageId: data.id };
    }
    const transport = nodemailer.createTransport(
      isSystem
        ? {
            host: c.smtp!.host,
            port: c.smtp!.port,
            secure: c.smtp!.secure ?? c.smtp!.port === 465,
            auth: c.smtp!.user ? { user: c.smtp!.user, pass: c.smtp!.pass } : undefined,
          }
        : await tenantSmtpTransportOptions(c.smtp!),
    );
    const info = await transport.sendMail({ from: input.from, to: input.to, subject: input.subject, text: input.text, html: input.html, replyTo: input.replyTo, headers: input.headers });
    return { ok: true, provider: "smtp", providerMessageId: info.messageId };
  } catch (e) {
    // A setting we would not connect to, as opposed to a server that turned us away: the
    // message is ours and says what to change, so callers may show it (see `refused`).
    if (e instanceof SmtpTargetRefused) return { ok: false, provider: c.provider, error: e.message, refused: true };
    return { ok: false, provider: c.provider, error: (e as Error).message };
  }
}

export async function testMailer(cfg: MailerConfig): Promise<{ ok: boolean; error?: string; unreachable?: boolean; refused?: boolean }> {
  if (cfg.provider === "resend") {
    // A network failure must come back as a failed test, not a thrown error: the account row
    // is already saved when this runs, and a throw turned that into a 500 with a saved sender.
    try {
      const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${cfg.resendApiKey}` }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? { ok: true } : { ok: false, error: `Resend HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, unreachable: true, error: `could not reach Resend: ${(e as Error).message}` };
    }
  }
  try {
    // testMailer is only ever called with a customer's settings (the system mailer is not
    // tested this way), so the target is always vetted and pinned.
    const t = nodemailer.createTransport(await tenantSmtpTransportOptions(cfg.smtp!));
    await t.verify();
    return { ok: true };
  } catch (e) {
    // `refused` marks a setting we would not connect to, as opposed to a server that did
    // not let us in; the message is written for the customer and is safe to show as is.
    if (e instanceof SmtpTargetRefused) return { ok: false, error: e.message, refused: true };
    return { ok: false, error: (e as Error).message };
  }
}
