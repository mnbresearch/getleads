import { and, enqueue, eq, events, getDb, webhooks } from "@prospex/db";

/** Record an event and fan out to active webhooks (delivered by the job queue). */
export async function emitEvent(orgId: string, type: string, data: Record<string, unknown> = {}, entity?: { type: string; id: string }) {
  const { db } = getDb();
  const [ev] = await db.insert(events).values({ orgId, type, data, entityType: entity?.type, entityId: entity?.id }).returning();
  const hooks = await db.select().from(webhooks).where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true)));
  for (const h of hooks) {
    if (!h.events.includes("*") && !h.events.includes(type) && !h.events.some((e) => e.endsWith(".*") && type.startsWith(e.slice(0, -1)))) continue;
    await enqueue(db, "webhook.deliver", { webhookId: h.id, eventId: ev.id }, { orgId, maxAttempts: 5 });
  }
  // Connections saved with autoSync on get new and changed leads pushed by themselves
  // (services/integrations.ts queueAutoSync). Never allowed to fail the event itself.
  if (entity?.type === "lead") {
    const { queueAutoSync } = await import("../services/integrations.js");
    await queueAutoSync(orgId, type, entity).catch((e) => console.warn(`[integrations] auto sync not queued: ${(e as Error)?.name ?? "error"}`));
  }
  return ev;
}
