import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, getDb, messages, sql } from "@prospex/db";
import { recordBounce } from "../services/campaigns.js";

/**
 * Delivery events from the email provider (mounted at /v1/email-events).
 *
 * Without this, a bounce reported AFTER the provider accepted the message - which is how
 * most bounces arrive - was never recorded anywhere. The deliverability gate read an
 * always-empty bounce column, bounced addresses stayed in every sequence, and spam
 * complaints were never suppressed.
 */
export const emailEventRoutes = new Hono();

/** Signatures older than this are refused, so a captured request cannot be replayed later. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verify a Svix-signed webhook (Resend signs with Svix).
 *
 * signed content: `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 with the
 * base64-decoded part of the secret after "whsec_", base64 encoded. The header carries one
 * or more space-separated `v1,<signature>` entries (several during a secret rotation).
 */
export function verifySvixSignature(secret: string, headers: { id?: string | null; timestamp?: string | null; signature?: string | null }, body: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

emailEventRoutes.post("/resend", async (c) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Refused, not accepted unverified: an open endpoint that suppresses addresses and marks
  // leads invalid would let anyone stop any org's outreach.
  // Plain, internals-free message: the provider event hook is not set up on this deployment.
  if (!secret) return c.json({ error: { code: "not_configured", message: "Delivery event handling is not set up on this server." } }, 503);
  const body = await c.req.text();
  const ok = verifySvixSignature(secret, { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") }, body);
  if (!ok) return c.json({ error: "invalid signature" }, 401);

  let ev: ResendEvent;
  try {
    ev = JSON.parse(body) as ResendEvent;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const kind = ev.type === "email.bounced" ? "bounce" : ev.type === "email.complained" ? "complaint" : null;
  // Other event types are acknowledged so the provider does not keep retrying them.
  if (!kind) return c.json({ ok: true, ignored: ev.type ?? "unknown" });
  // A soft bounce (mailbox full, greylisting) is not a reason to drop an address forever.
  if (kind === "bounce" && /transient|soft/i.test(ev.data?.bounce?.type ?? "")) return c.json({ ok: true, ignored: "transient bounce" });

  const to = (Array.isArray(ev.data?.to) ? ev.data?.to[0] : ev.data?.to)?.trim().toLowerCase();
  const { db } = getDb();
  // The provider's own id first; otherwise the most recent send to that address, which is
  // what the event is about in all but pathological cases.
  let msg = ev.data?.email_id ? await db.query.messages.findFirst({ where: eq(messages.providerMessageId, ev.data.email_id) }) : undefined;
  if (!msg && to) {
    msg = await db.query.messages.findFirst({
      where: and(eq(messages.toEmail, to), eq(messages.direction, "outbound"), sql`${messages.sentAt} > now() - interval '30 days'`),
      orderBy: desc(messages.sentAt),
    });
  }
  if (!msg) return c.json({ ok: true, matched: false });
  const r = await recordBounce(msg.orgId, { email: to ?? msg.toEmail, messageId: msg.id, kind, detail: ev.data?.bounce?.message ?? ev.type });
  return c.json({ ok: true, matched: true, kind, ...r });
});
