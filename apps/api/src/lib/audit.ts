import type { Context } from "hono";
import { auditLog, getDb, sql } from "@prospex/db";
import { clientIp } from "../middleware.js";
import { ApiError, errorLine } from "./errors.js";

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
    console.warn(`[audit] could not record ${entry.action}: ${errorLine(e)}`);
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

/**
 * "At most N in a window", counted from the security log - so it holds across every API
 * instance and across a restart.
 *
 * The hourly allowances for mail the platform sends on someone's say-so (confirmation
 * emails, team invitations) are counted in the memory of one process (lib/rateWindow.ts).
 * A second instance on the same database had its own count, and a restart reset it: the
 * same person got a fourth confirmation email within the hour. Each of those sends already
 * writes a row here, so the rows are the shared count. The in-memory check stays in front
 * (it is what stops a burst arriving at the same instant); this is the backstop behind it.
 *
 * `where` selects the rows that count (it should start from an indexed column: org_id or
 * action). Throws the same 429 `rate_limited` the in-memory limiter throws. If the log
 * cannot be read the check is skipped, never failed: the in-memory limiter still applies.
 */
export async function enforceLoggedWindow(where: ReturnType<typeof sql>, limit: number, windowMs: number, message: string): Promise<void> {
  let times: Date[];
  try {
    const { db } = getDb();
    const rows = (await db.execute(
      sql`SELECT created_at FROM audit_log WHERE ${where} AND created_at > now() - ${`${Math.ceil(windowMs / 1000)} seconds`}::interval ORDER BY created_at DESC LIMIT ${limit}`,
    )) as unknown as { created_at: string | Date }[];
    times = [...rows].map((r) => new Date(r.created_at));
  } catch (e) {
    console.warn(`[audit] could not read the shared allowance (the per-instance one still applies): ${errorLine(e)}`);
    return;
  }
  if (times.length < limit) return;
  const oldest = times[times.length - 1].getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
  throw new ApiError(429, message, "rate_limited", { retryAfterSeconds });
}
