import nodemailer from "nodemailer";
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
}

export interface MailerConfig {
  provider: "resend" | "smtp" | "system";
  resendApiKey?: string;
  smtp?: { host: string; port: number; user?: string; pass?: string; secure?: boolean };
}

export function systemMailerConfig(): MailerConfig | null {
  if (env.resendApiKey) return { provider: "resend", resendApiKey: env.resendApiKey };
  if (env.smtp.host) return { provider: "smtp", smtp: { host: env.smtp.host, port: env.smtp.port, user: env.smtp.user, pass: env.smtp.pass, secure: env.smtp.secure } };
  return null;
}

export async function sendMail(cfg: MailerConfig | null, input: SendInput): Promise<SendResult> {
  const c = cfg?.provider === "system" || !cfg ? systemMailerConfig() : cfg;
  if (!c) {
    if (env.nodeEnv !== "production") {
      console.log(`[mailer:dev] to=${input.to} subject=${input.subject}\n${input.text}\n`);
      return { ok: true, provider: "console", providerMessageId: `dev-${Date.now()}` };
    }
    return { ok: false, provider: "none", error: "No email provider configured (set RESEND_API_KEY or SMTP_*)" };
  }
  try {
    if (c.provider === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${c.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text, html: input.html, reply_to: input.replyTo, headers: input.headers }),
      });
      const data = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) return { ok: false, provider: "resend", error: data.message ?? `HTTP ${res.status}` };
      return { ok: true, provider: "resend", providerMessageId: data.id };
    }
    const transport = nodemailer.createTransport({
      host: c.smtp!.host,
      port: c.smtp!.port,
      secure: c.smtp!.secure ?? c.smtp!.port === 465,
      auth: c.smtp!.user ? { user: c.smtp!.user, pass: c.smtp!.pass } : undefined,
    });
    const info = await transport.sendMail({ from: input.from, to: input.to, subject: input.subject, text: input.text, html: input.html, replyTo: input.replyTo, headers: input.headers });
    return { ok: true, provider: "smtp", providerMessageId: info.messageId };
  } catch (e) {
    return { ok: false, provider: c.provider, error: (e as Error).message };
  }
}

export async function testMailer(cfg: MailerConfig): Promise<{ ok: boolean; error?: string }> {
  if (cfg.provider === "resend") {
    const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${cfg.resendApiKey}` } });
    return res.ok ? { ok: true } : { ok: false, error: `Resend HTTP ${res.status}` };
  }
  try {
    const t = nodemailer.createTransport({ host: cfg.smtp!.host, port: cfg.smtp!.port, secure: cfg.smtp!.secure ?? cfg.smtp!.port === 465, auth: cfg.smtp!.user ? { user: cfg.smtp!.user, pass: cfg.smtp!.pass } : undefined });
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
