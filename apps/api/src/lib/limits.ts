import { and, apiKeys, assertJobCapacity, count, eq, getDb, isNull, JobQueueFullError, sql, type Db } from "@prospex/db";
import { ApiError } from "./errors.js";

/**
 * Run `fn` holding a transaction-scoped advisory lock keyed on a workspace and a name, so
 * two requests that must not interleave for one workspace (accepting invites against a seat
 * limit, say) take turns instead of both reading the same count and both inserting. The lock
 * is released when the transaction ends, including on error. Keep `fn` short - no slow work
 * (hash the password first) - so the lock is held only across the check and the write.
 */
export async function withOrgLock<T>(db: Db, orgId: string, name: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await (tx as unknown as Db).execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${name}:${orgId}`}))`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Anti-abuse caps on how many of a thing one workspace may create, and a 429 guard for the
 * background-job queue. These are NOT the plan's feature limits (how many campaigns a tier
 * includes); they are generous ceilings that stop one workspace from creating hundreds of
 * thousands of rows and the background work attached to them. They sit far above honest use.
 *
 * Only NEW creation past the ceiling is refused, with a 403 and a plain message. Rows that
 * already exist are never touched, so no current workspace is suddenly blocked from its
 * normal work.
 */
export const ROW_CAPS = {
  lists: 2000,
  icps: 500,
  savedSearches: 1000,
  autopilots: 500,
  monitors: 500,
  signalSubscriptions: 500,
  tasks: 100_000,
  webhooks: 100,
  apiKeys: 100,
  clients: 5000,
  pixels: 200,
  visibilityPrompts: 1000,
  campaigns: 5000,
} as const;
export type RowCapKind = keyof typeof ROW_CAPS;

/**
 * The effective cap for a kind: the default, unless an operator has set `ROW_CAP_<KIND>` (an
 * integer >= 1) to raise or lower it. Read per call, not at module load, so it can be tuned
 * without a redeploy and so tests can exercise the mechanism without creating thousands of rows.
 */
export function capFor(kind: RowCapKind): number {
  const raw = process.env[`ROW_CAP_${kind.toUpperCase()}`];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : ROW_CAPS[kind];
}

const KIND_NOUN: Record<RowCapKind, string> = {
  lists: "lists",
  icps: "ICPs",
  savedSearches: "saved searches",
  autopilots: "autopilots",
  monitors: "monitors",
  signalSubscriptions: "signal subscriptions",
  tasks: "tasks",
  webhooks: "webhooks",
  apiKeys: "API keys",
  clients: "clients",
  pixels: "tracking pixels",
  visibilityPrompts: "tracked prompts",
  campaigns: "campaigns",
};

/** Max text length for free-form fields that had none. Generous; stops a row from holding megabytes. */
export const TEXT_CAPS = { taskTitle: 500, taskBody: 20_000, taskType: 60, name: 200, note: 2000 } as const;

/**
 * Refuse to create one more row of `kind` for this workspace once it is at the ceiling.
 *
 * `table` is the Drizzle table; it must have an `orgId` column. Counting is a cheap indexed
 * count, done only at create time. Existing rows are never removed - a workspace already
 * above a (newly introduced) ceiling keeps every row it has and simply cannot add more until
 * it is back under, which honest workspaces never reach.
 */
export async function assertRowCap(db: Db, table: { orgId: unknown }, orgId: string, kind: RowCapKind): Promise<void> {
  const cap = capFor(kind);
  const [{ n }] = await db.select({ n: count() }).from(table as never).where(eq((table as { orgId: never }).orgId, orgId as never));
  if (Number(n) >= cap) {
    throw new ApiError(
      403,
      `This workspace has reached the limit of ${cap.toLocaleString("en-US")} ${KIND_NOUN[kind]}. Delete some you no longer need, or contact support if you need more.`,
      "limit_reached",
    );
  }
}

/**
 * Throw a 429 (not a 500) when this workspace already has too many jobs waiting or running.
 * Platform/recurring work passes `exempt: true`. Call this right before `enqueue` on any
 * per-request path that creates background work.
 */
export async function guardJobCapacity(db: Db, orgId: string | null | undefined, type: string, exempt = false): Promise<void> {
  try {
    await assertJobCapacity(db, orgId, type, exempt);
  } catch (e) {
    if (e instanceof JobQueueFullError) {
      throw new ApiError(429, "Too much work is already queued for this workspace. Let it finish, then try again.", "queue_full", { retryAfterSeconds: 30 });
    }
    throw e;
  }
}

/** Convenience: current db handle plus a row-cap check. */
export async function assertRowCapHere(table: { orgId: unknown }, orgId: string, kind: RowCapKind): Promise<void> {
  return assertRowCap(getDb().db, table, orgId, kind);
}

/** Cap on LIVE (non-revoked) API keys. Revoked keys do not count, so rotating is never blocked. */
export async function assertActiveApiKeyCap(db: Db, orgId: string): Promise<void> {
  const cap = capFor("apiKeys");
  const [{ n }] = await db.select({ n: count() }).from(apiKeys).where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
  if (Number(n) >= cap) {
    throw new ApiError(403, `This workspace has reached the limit of ${cap} active API keys. Revoke one you no longer use, or contact support if you need more.`, "limit_reached");
  }
}
