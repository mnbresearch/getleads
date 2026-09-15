import { and, enqueue, eq, events, getDb, webhooks } from "@getleads/db";

/** Record an event and fan out to active webhooks (delivered by the job queue). */
export async function emitEvent(orgId: string, type: string, data: Record<string, unknown> = {}, entity?: { type: string; id: string }) {
  const { db } = getDb();
  const [ev] = await db.insert(events).values({ orgId, type, data, entityType: entity?.type, entityId: entity?.id }).returning();
  const hooks = await db.select().from(webhooks).where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true)));
  for (const h of hooks) {
    if (!h.events.includes("*") && !h.events.includes(type) && !h.events.some((e) => e.endsWith(".*") && type.startsWith(e.slice(0, -1)))) continue;
    await enqueue(db, "webhook.deliver", { webhookId: h.id, eventId: ev.id }, { orgId, maxAttempts: 5 });
  }
  return ev;
}
