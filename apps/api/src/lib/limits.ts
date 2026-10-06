import { AsyncLocalStorage } from "node:async_hooks";
import { and, apiKeys, count, eq, getDb, isNull, jobOpenTotalCap, jobOpenTypeCap, openJobCount, sql, type Db } from "@prospex/db";
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
  plays: 200,
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
  plays: "plays",
};

/**
 * Reservations: what makes the ceilings hold when many requests arrive at the same moment.
 *
 * Every check below is "count the rows, then let the caller insert". Fifty parallel creates
 * all counted before any of them had inserted, all saw room, and all inserted: 50 rows
 * against a ceiling of 3. Taking a database lock in every create route would fix that at the
 * cost of restructuring each of them; instead a check that is about to count first writes
 * down, in this process, that it intends to add `weight` rows. A later check counts the
 * database rows PLUS the intentions written down before its own.
 *
 *  - A reservation is taken BEFORE the count is awaited (so parallel checks see each other)
 *    and is given back at once when the check refuses or fails.
 *  - It is given back when the request that made it has been answered (by then the insert
 *    has committed) - but not before every check that was still counting at that moment has
 *    its answer: such a check may have counted before the row landed, and the reservation
 *    is the only thing that tells it the row exists. In any case it is gone after
 *    RESERVATION_MS, so a create that fails after its check cannot hold a workspace back
 *    for longer than those few seconds.
 *  - A reservation whose row has already landed must not be counted twice. Each one records
 *    the count it saw; the rows expected once everything in flight has committed are
 *    max(rows now, lowest count seen by a live earlier reservation + what they reserved).
 *
 * This is per process. With several API instances the overshoot is bounded by the number of
 * instances times the creates each has in flight at that moment (each instance holds its own
 * line), not by the number of requests - and the next check on any instance sees the rows.
 */
const RESERVATION_MS = 5_000;
interface Reservation {
  seq: number;
  weight: number;
  expires: number;
  /** The database count this check saw; null while it is still counting. */
  seen: number | null;
  /**
   * Set when the request that made it has ended: the checks that were still counting then.
   * The reservation is dropped when the last of them has its answer.
   */
  heldFor?: Set<Reservation>;
}
const reservations = new Map<string, Reservation[]>();
let reservationSeq = 0;
/** Reservations made while answering the current request, so they can be given back with the answer. */
const requestReservations = new AsyncLocalStorage<Array<{ key: string; r: Reservation }>>();

function liveReservations(key: string, now = Date.now()): Reservation[] {
  const all = reservations.get(key);
  if (!all) return [];
  const live = all.filter((r) => r.expires > now);
  if (live.length === 0) reservations.delete(key);
  else if (live.length !== all.length) reservations.set(key, live);
  return live;
}

function reserve(key: string, weight: number): Reservation {
  const now = Date.now();
  // Keys of workspaces that stopped creating things are only pruned when looked at; clear
  // the expired ones now and then so the map cannot grow without bound.
  if (reservations.size > 2_000) for (const k of [...reservations.keys()]) liveReservations(k, now);
  const r: Reservation = { seq: ++reservationSeq, weight: Math.max(1, Math.floor(weight) || 1), expires: now + RESERVATION_MS, seen: null };
  const live = liveReservations(key, now);
  live.push(r);
  reservations.set(key, live);
  requestReservations.getStore()?.push({ key, r });
  return r;
}

function release(key: string, r: Reservation): void {
  const all = reservations.get(key);
  if (!all) return;
  const i = all.indexOf(r);
  if (i >= 0) all.splice(i, 1);
  // `r` is no longer counting (if it ever was): finished reservations waiting on it may go.
  settled(key, r);
  if (reservations.get(key)?.length === 0) reservations.delete(key);
}

/** `r` has its count (or has been given back): drop the finished reservations that were only waiting for it. */
function settled(key: string, r: Reservation): void {
  const all = reservations.get(key);
  if (!all) return;
  for (let i = all.length - 1; i >= 0; i--) {
    const held = all[i].heldFor;
    if (!held) continue;
    held.delete(r);
    if (held.size === 0) all.splice(i, 1);
  }
  if (all.length === 0) reservations.delete(key);
}

/** The request that made `r` has been answered: give it back as soon as nobody can still need it. */
function finish(key: string, r: Reservation): void {
  const all = reservations.get(key);
  if (!all || !all.includes(r)) return;
  const counting = all.filter((x) => x !== r && x.seen === null);
  if (counting.length === 0) release(key, r);
  else r.heldFor = new Set(counting);
}

/**
 * The rows `mine` must assume exist: the `n` the database reports now, or - if earlier
 * checks are still in flight - what there will be once their inserts commit.
 */
function expectedRows(key: string, mine: Reservation, n: number): number {
  let base = n;
  let pending = 0;
  for (const r of liveReservations(key)) {
    if (r.seq >= mine.seq) continue;
    pending += r.weight;
    if (r.seen !== null && r.seen < base) base = r.seen;
  }
  return Math.max(n, base + pending);
}

/**
 * Run `fn` (one request) and give back every reservation made inside it when it ends. Used
 * as middleware by the app; code that runs outside a request (jobs, scripts) simply relies
 * on the expiry.
 */
export async function withReservationScope<T>(fn: () => Promise<T>): Promise<T> {
  const mine: Array<{ key: string; r: Reservation }> = [];
  try {
    return await requestReservations.run(mine, fn);
  } finally {
    for (const { key, r } of mine) finish(key, r);
  }
}

/** Testing seam: how many rows are currently reserved under a key prefix. */
export function reservedCount(prefix = ""): number {
  let n = 0;
  for (const k of [...reservations.keys()]) if (k.startsWith(prefix)) for (const r of liveReservations(k)) n += r.weight;
  return n;
}

/** Testing seam: forget every reservation. */
export function resetReservations(): void {
  reservations.clear();
}

/** Max text length for free-form fields that had none. Generous; stops a row from holding megabytes. */
export const TEXT_CAPS = { taskTitle: 500, taskBody: 20_000, taskType: 60, name: 200, note: 2000 } as const;

/**
 * Refuse to create one more row of `kind` for this workspace once it is at the ceiling.
 *
 * `table` is the Drizzle table; it must have an `orgId` column. Counting is a cheap indexed
 * count, done only at create time. Existing rows are never removed - a workspace already
 * above a (newly introduced) ceiling keeps every row it has and simply cannot add more until
 * it is back under, which honest workspaces never reach.
 *
 * `rows` is how many the caller is about to insert (default 1): there must be room for all of
 * them, and all of them are reserved so that parallel requests see them (see "Reservations"
 * above). A request that adds several and would cross the ceiling is told how many still fit.
 */
export async function assertRowCap(db: Db, table: { orgId: unknown }, orgId: string, kind: RowCapKind, rows = 1): Promise<void> {
  const cap = capFor(kind);
  const key = `row:${kind}:${orgId}`;
  const mine = reserve(key, rows);
  let n: number;
  try {
    const [{ n: found }] = await db.select({ n: count() }).from(table as never).where(eq((table as { orgId: never }).orgId, orgId as never));
    n = Number(found);
  } catch (e) {
    release(key, mine);
    throw e;
  }
  mine.seen = n;
  // Read BEFORE telling the finished reservations that this check has its count: they were
  // being kept for exactly this line.
  const expected = expectedRows(key, mine, n);
  settled(key, mine);
  if (expected + mine.weight > cap) {
    release(key, mine);
    const room = cap - expected;
    throw new ApiError(
      403,
      room > 0
        ? `This workspace can hold ${cap.toLocaleString("en-US")} ${KIND_NOUN[kind]} and has room for ${room.toLocaleString("en-US")} more. Add fewer at once, delete some you no longer need, or contact support if you need more.`
        : `This workspace has reached the limit of ${cap.toLocaleString("en-US")} ${KIND_NOUN[kind]}. Delete some you no longer need, or contact support if you need more.`,
      "limit_reached",
    );
  }
}

/**
 * Throw a 429 (not a 500) when this workspace already has too many jobs waiting or running.
 * Platform/recurring work passes `exempt: true`. Call this right before `enqueue` on any
 * per-request path that creates background work - and BEFORE any row the request saves, so
 * a "try again" answer never leaves a half-made thing behind for the retry to duplicate.
 *
 * Same two ceilings as `assertJobCapacity` in @prospex/db (per type, and in total), with the
 * reservations described above so they also hold for requests that arrive together. `jobs`
 * is how many the caller is about to enqueue (default 1).
 */
export const QUEUE_FULL_RETRY_SECONDS = 30;
export async function guardJobCapacity(db: Db, orgId: string | null | undefined, type: string, exempt = false, jobs = 1): Promise<void> {
  if (!orgId || exempt) return;
  const full = () => new ApiError(429, "Too much work is already queued for this workspace. Let it finish, then try again.", "queue_full", { retryAfterSeconds: QUEUE_FULL_RETRY_SECONDS });
  const typeKey = `job:${orgId}:type:${type}`;
  const totalKey = `job:${orgId}:total`;
  const forType = reserve(typeKey, jobs);
  const forTotal = reserve(totalKey, jobs);
  try {
    const openForType = await openJobCount(db, orgId, type);
    forType.seen = openForType;
    // The rule is unchanged: refused once the workspace is AT a ceiling (a request that queues
    // several jobs may take it past, as before; the next request is then refused).
    const expectedForType = expectedRows(typeKey, forType, openForType);
    settled(typeKey, forType);
    if (expectedForType >= jobOpenTypeCap()) throw full();
    const openTotal = await openJobCount(db, orgId);
    forTotal.seen = openTotal;
    const expectedTotal = expectedRows(totalKey, forTotal, openTotal);
    settled(totalKey, forTotal);
    if (expectedTotal >= jobOpenTotalCap()) throw full();
  } catch (e) {
    release(typeKey, forType);
    release(totalKey, forTotal);
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
  const key = `row:apiKeys:${orgId}`;
  const mine = reserve(key, 1);
  let n: number;
  try {
    const [r] = await db.select({ n: count() }).from(apiKeys).where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
    n = Number(r.n);
  } catch (e) {
    release(key, mine);
    throw e;
  }
  mine.seen = n;
  const expected = expectedRows(key, mine, n);
  settled(key, mine);
  if (expected >= cap) {
    release(key, mine);
    throw new ApiError(403, `This workspace has reached the limit of ${cap} active API keys. Revoke one you no longer use, or contact support if you need more.`, "limit_reached");
  }
}
