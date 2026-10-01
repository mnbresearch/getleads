import { Hono } from "hono";
import { eq, getDb, messages, suppressions, campaignContacts, and, leads, type Message } from "@prospex/db";
import { bumpEngagement, bumpStat } from "../services/campaigns.js";
import { emitEvent } from "../lib/events.js";

/** Public tracking endpoints: open pixel, click redirect, unsubscribe. */
export const trackRoutes = new Hono();

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

trackRoutes.get("/o/:token", async (c) => {
  const token = c.req.param("token").replace(/\.gif$/, "");
  const { db } = getDb();
  const m = await db.query.messages.findFirst({ where: eq(messages.trackingToken, token) });
  if (m && !m.openedAt) {
    await db.update(messages).set({ openedAt: new Date(), status: m.status === "sent" ? "opened" : m.status }).where(eq(messages.id, m.id));
    if (m.campaignId) await bumpStat(m.campaignId, "opened");
    await bumpEngagement(m.leadId, "open");
    await emitEvent(m.orgId, "message.opened", { messageId: m.id, leadId: m.leadId, campaignId: m.campaignId }, { type: "message", id: m.id });
  }
  c.header("content-type", "image/gif");
  c.header("cache-control", "no-store");
  return c.body(GIF);
});

/**
 * May this tracked link redirect to `url`?
 *
 * The click redirect took any `u=` and redirected to it, with or without a valid token -
 * an open redirect on our domain, which is exactly what a phishing link wants to borrow.
 * It now redirects only to a URL that is actually in that message: the tracked href carries
 * the URL encoded, and the plain-text body carries it as-is.
 */
function linkInMessage(m: Pick<Message, "bodyHtml" | "bodyText">, url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  const html = m.bodyHtml ?? "";
  const text = m.bodyText ?? "";
  return html.includes(encodeURIComponent(url)) || html.includes(url) || html.includes(url.replace(/&/g, "&amp;")) || text.includes(url);
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#1e293b">${body}</body>`;

trackRoutes.get("/c/:token", async (c) => {
  const url = c.req.query("u") ?? "";
  const { db } = getDb();
  const m = await db.query.messages.findFirst({ where: eq(messages.trackingToken, c.req.param("token")) });
  if (!m || !linkInMessage(m, url)) {
    return c.html(page("Link unavailable", `<h2>This link is not available</h2><p>It may have expired or been copied incorrectly.</p>`), 404);
  }
  if (!m.clickedAt) {
    await db.update(messages).set({ clickedAt: new Date(), openedAt: m.openedAt ?? new Date(), status: "clicked" }).where(eq(messages.id, m.id));
    if (m.campaignId) await bumpStat(m.campaignId, "clicked");
    await bumpEngagement(m.leadId, "click");
    await emitEvent(m.orgId, "message.clicked", { messageId: m.id, leadId: m.leadId, url }, { type: "message", id: m.id });
  }
  return c.redirect(url);
});

/** Unsubscribe the recipient of a message: suppression, every sequence, and the lead itself. */
async function unsubscribe(m: Message) {
  const { db } = getDb();
  await db.insert(suppressions).values({ orgId: m.orgId, email: m.toEmail.toLowerCase(), reason: "unsubscribe_link" }).onConflictDoNothing();
  if (m.leadId) {
    await db.update(campaignContacts).set({ status: "unsubscribed", nextSendAt: null, updatedAt: new Date() }).where(eq(campaignContacts.leadId, m.leadId));
    // The lead's own status too: the hot list and the lead filters read leads.status, so an
    // unsubscribed person kept being suggested as someone to contact today.
    await db.update(leads).set({ status: "unsubscribed", updatedAt: new Date() }).where(and(eq(leads.id, m.leadId), eq(leads.orgId, m.orgId)));
  }
  await emitEvent(m.orgId, "lead.unsubscribed", { leadId: m.leadId, email: m.toEmail }, m.leadId ? { type: "lead", id: m.leadId } : undefined);
}

const UNSUBSCRIBED = page("Unsubscribed", `<h2>You're unsubscribed</h2><p>You won't receive further emails from this sender.</p>`);

/**
 * GET shows a confirmation; it no longer unsubscribes.
 *
 * Corporate mail scanners and link-preview bots fetch every URL in an email the moment it
 * arrives, so an unsubscribe-on-GET unsubscribed recipients who never clicked anything -
 * silently shrinking campaigns and suppressing interested prospects.
 */
trackRoutes.get("/u/:token", async (c) => {
  const token = c.req.param("token");
  return c.html(
    page(
      "Unsubscribe",
      `<h2>Unsubscribe from these emails?</h2><p>Confirm below and this sender will not email you again.</p>` +
        `<form method="post" action="/t/u/${encodeURIComponent(token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click">` +
        `<button type="submit" style="font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#0f172a;color:#fff;cursor:pointer">Unsubscribe</button></form>`,
    ),
  );
});

/**
 * POST unsubscribes, with no further confirmation. This is the RFC 8058 one-click endpoint:
 * mail clients POST `List-Unsubscribe=One-Click` to the List-Unsubscribe URL, and the
 * confirmation page above posts the same form. An unknown token gets the same page, so the
 * response says nothing about which tokens exist.
 */
trackRoutes.post("/u/:token", async (c) => {
  const { db } = getDb();
  const m = await db.query.messages.findFirst({ where: eq(messages.trackingToken, c.req.param("token")) });
  if (m) await unsubscribe(m);
  return c.html(UNSUBSCRIBED);
});
