import { Hono } from "hono";
import { eq, getDb, messages, suppressions, campaignContacts, and } from "@getleads/db";
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

trackRoutes.get("/c/:token", async (c) => {
  const url = c.req.query("u") ?? "/";
  const { db } = getDb();
  const m = await db.query.messages.findFirst({ where: eq(messages.trackingToken, c.req.param("token")) });
  if (m && !m.clickedAt) {
    await db.update(messages).set({ clickedAt: new Date(), openedAt: m.openedAt ?? new Date(), status: "clicked" }).where(eq(messages.id, m.id));
    if (m.campaignId) await bumpStat(m.campaignId, "clicked");
    await bumpEngagement(m.leadId, "click");
    await emitEvent(m.orgId, "message.clicked", { messageId: m.id, leadId: m.leadId, url }, { type: "message", id: m.id });
  }
  return c.redirect(/^https?:\/\//.test(url) ? url : "/");
});

trackRoutes.get("/u/:token", async (c) => {
  const { db } = getDb();
  const m = await db.query.messages.findFirst({ where: eq(messages.trackingToken, c.req.param("token")) });
  if (m) {
    await db.insert(suppressions).values({ orgId: m.orgId, email: m.toEmail, reason: "unsubscribe_link" }).onConflictDoNothing();
    if (m.leadId) await db.update(campaignContacts).set({ status: "unsubscribed", nextSendAt: null, updatedAt: new Date() }).where(and(eq(campaignContacts.leadId, m.leadId)));
    await emitEvent(m.orgId, "lead.unsubscribed", { leadId: m.leadId, email: m.toEmail }, m.leadId ? { type: "lead", id: m.leadId } : undefined);
  }
  return c.html(`<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:system-ui;padding:40px;text-align:center"><h2>You're unsubscribed</h2><p>You won't receive further emails from this sender.</p></body>`);
});
