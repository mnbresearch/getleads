import type { Context } from "hono";
import { auditLog, getDb } from "@prospex/db";
import { clientIp } from "../middleware.js";

/**
 * Security audit log.
 *
 * The `events` table records what happened to a workspace's data and feeds webhooks. It was
 * never a record of who did it: it has no actor, no address and no result, and nothing
 * security-relevant was written to it - no sign-in, no password change, no API key, no export,
 * no admin plan change. After an incident there was nothing to read.
 *
 * This is that record. It is deliberately separate from `events` so that it is never fanned
 * out to customer webhooks and can carry an IP address without that address leaving the
 * platform.
 *
 * Rules for callers:
 *  - never put a secret, token, password or full request body in `data`;
 *  - PII in `data` is limited to what identifies the action (an email address for a login);
 *  - writing an audit row must never fail the request it describes, so this never throws.
 */
export type AuditResult = "ok" | "denied" | "failed";

export interface AuditEntry {
  action: string;
  orgId?: string | null;
  actorType?: "user" | "api_key" | "admin" | "system" | "anonymous";
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string | null;
  result?: AuditResult;
  data?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const { db } = getDb();
    await db.insert(auditLog).values({
      orgId: entry.orgId ?? null,
      actorType: entry.actorType ?? "system",
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      result: entry.result ?? "ok",
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,
      data: entry.data ?? {},
    });
  } catch (e) {
    console.warn(`[audit] could not record ${entry.action}: ${(e as Error).message}`);
  }
}

/**
 * Record an action taken through an HTTP request. Actor, workspace, IP and request id are
 * read from the request; anything passed in `over` wins (a login has no auth context yet,
 * so it passes orgId/actorUserId itself).
 */
export async function audit(c: Context, action: string, over: Omit<AuditEntry, "action"> = {}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auth = (c as any).get?.("auth") as { org?: { id: string }; user?: { id: string } | null; apiKey?: unknown } | undefined;
  await writeAudit({
    action,
    orgId: over.orgId !== undefined ? over.orgId : auth?.org?.id ?? null,
    actorType: over.actorType ?? (auth?.user ? "user" : auth ? "api_key" : "anonymous"),
    actorUserId: over.actorUserId !== undefined ? over.actorUserId : auth?.user?.id ?? null,
    targetType: over.targetType,
    targetId: over.targetId,
    result: over.result,
    data: over.data,
    ip: over.ip ?? clientIp(c),
    requestId: over.requestId ?? c.req.header("x-request-id") ?? c.req.header("cf-ray") ?? null,
  });
}
