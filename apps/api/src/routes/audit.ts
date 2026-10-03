import { Hono } from "hono";
import { z } from "zod";
import { and, auditLog, desc, eq, getDb, sql, users } from "@prospex/db";
import { zValidator } from "../lib/validate.js";
import { badRequest } from "../lib/errors.js";
import { rateLimit, requireAuth, requireRole, requireUser, type Env } from "../middleware.js";

/**
 * GET /v1/audit-log - the workspace's security log (see lib/audit.ts for what is written).
 *
 * Owners and admins only, and only from a signed-in session: the log holds teammates' email
 * addresses and the IP addresses they signed in from, which an API key (a credential that
 * lives in scripts and CI) has no business reading.
 *
 * Rows written by the platform operator (actorType "admin": a plan change, a suspension) are
 * shown with `ip: null`. The address stays in the database for the operator's own records.
 *
 * Scoped to the caller's workspace by `org_id`. Rows with no workspace (a failed sign-in for
 * an address that has no account) belong to nobody and are never returned here.
 *
 * Newest first. Paginate by passing the previous page's `nextBefore` (the `createdAt` of its
 * last entry) as `before`.
 */
export const auditRoutes = new Hono<Env>();

auditRoutes.get(
  "/",
  requireAuth,
  requireUser,
  requireRole("owner", "admin"),
  rateLimit({ perMinute: 60, name: "audit-log" }),
  zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().max(40).optional() })),
  async (c) => {
    const q = c.req.valid("query");
    const limit = q.limit ?? 50;
    // Validated as a date here, compared in Postgres at full (microsecond) precision: a
    // millisecond cursor would skip rows written in the same millisecond as the last one shown.
    const before = q.before?.trim() || null;
    if (before && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(before) || Number.isNaN(new Date(before).getTime()))) {
      throw badRequest("`before` must be an ISO 8601 timestamp (use the previous page's nextBefore).");
    }
    const { db } = getDb();
    const orgId = c.get("auth").org.id;
    // One extra row tells us whether there is another page without a second query.
    const rows = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorUserId: auditLog.actorUserId,
        actorEmail: users.email,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        result: auditLog.result,
        ip: auditLog.ip,
        createdAt: auditLog.createdAt,
        data: auditLog.data,
        cursor: sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(auditLog)
      // The join is restricted to this workspace's users, so an actor id can never surface
      // another workspace's email address.
      .leftJoin(users, and(eq(users.id, auditLog.actorUserId), eq(users.orgId, orgId)))
      .where(and(eq(auditLog.orgId, orgId), before ? sql`${auditLog.createdAt} < ${before}::timestamptz` : undefined))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return c.json({
      entries: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actorEmail: r.actorEmail ?? null,
        targetType: r.targetType ?? null,
        targetId: r.targetId ?? null,
        result: r.result,
        // An admin row is the platform operator acting on this workspace. What they did is the
        // customer's business; the address they did it from is not, and it was being shown.
        ip: r.actorType === "admin" ? null : r.ip ?? null,
        createdAt: r.createdAt,
        data: r.data ?? {},
      })),
      hasMore,
      nextBefore: hasMore && page.length ? page[page.length - 1].cursor : null,
    });
  },
);
