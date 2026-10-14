/**
 * The admin "System" view: what is running, on what database, with which settings, and how
 * the job queue is doing - plus requeueing one failed job.
 *
 * Every query here is cheap on a large database: the job queue is read through its status
 * index (jobs_poll_idx leads with status) and the finished rows it keeps are pruned to days,
 * table sizes come from the catalog (pg_class.reltuples is the planner's estimate, never a
 * count(*) of a big table), and each group runs under a statement time limit. A group that
 * runs out of time is named in `unavailable` instead of failing the whole page.
 */
import { getDb, jobErrorForLog, sql, withStatementTimeout, type Db } from "@prospex/db";
import { env } from "../env.js";
import { RECURRING_JOBS } from "../jobs.js";
import { configChecklist, embeddedWorkerOn, keepAwakeState } from "./adminConfig.js";

/** Per group of queries. Well under the two seconds a page of the console may take. */
export const ADMIN_READ_MS = 1200;

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => [...((r as Row[] | null) ?? [])];
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Run one group of reads under a time limit. A failure (a timeout, a table an older database
 * does not have yet) is recorded under `name` and answered with null, so one slow corner
 * cannot take the overview down with it.
 */
export async function guarded<T>(db: Db, name: string, unavailable: string[], fn: (tx: Db) => Promise<T>, ms = ADMIN_READ_MS): Promise<T | null> {
  try {
    // JIT compilation costs these short counting queries more (about 150 ms) than it saves.
    return await withStatementTimeout(db, ms, async (tx) => {
      await tx.execute(sql`SELECT set_config('jit', 'off', true)`);
      return fn(tx);
    });
  } catch (e) {
    unavailable.push(name);
    console.warn(`[admin] ${name} could not be read: ${jobErrorForLog(e).slice(0, 200)}`);
    return null;
  }
}

/** The commit this build came from, when the host says so. A hash, never anything else. */
export function buildCommit(e: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of ["RENDER_GIT_COMMIT", "SOURCE_VERSION", "GIT_COMMIT", "COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA", "GITHUB_SHA"]) {
    const v = (e[k] ?? "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase();
  }
  return null;
}

export function buildInfo() {
  const uptimeSeconds = Math.floor(process.uptime());
  return {
    commit: buildCommit(),
    node: process.version,
    startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    uptimeSeconds,
    nodeEnv: env.nodeEnv,
    jobMode: env.jobMode,
    embeddedWorker: embeddedWorkerOn(),
  };
}

const RECURRING_TYPES = Object.keys(RECURRING_JOBS);
const typeList = () => sql.join(RECURRING_TYPES.map((t) => sql`${t}`), sql`, `);
/** A scheduler whose next run is this late is not being picked up by any worker. */
export const OVERDUE_GRACE_SECONDS = 15 * 60;

export interface RecurringState {
  type: string;
  intervalSeconds: number;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
  running: boolean;
  healthy: boolean;
  problem: string | null;
}

/**
 * Each scheduler's state: when it last finished, when it runs next, and whether that next
 * run exists and is not overdue. `system` uses the full list; the overview only its alerts.
 */
export async function recurringStates(tx: Db): Promise<RecurringState[]> {
  const open = rowsOf(
    await tx.execute(sql`
      SELECT type, status, run_at
      FROM jobs
      WHERE status IN ('queued', 'running') AND type IN (${typeList()}) AND payload->>'recurring' = 'true'`),
  );
  // Finished runs are kept for days (system.cleanup), so this stays a small, recent set.
  const finished = rowsOf(
    await tx.execute(sql`
      SELECT DISTINCT ON (type) type, status, updated_at
      FROM jobs
      WHERE status IN ('done', 'failed') AND type IN (${typeList()}) AND payload->>'recurring' = 'true' AND updated_at > now() - interval '8 days'
      ORDER BY type, updated_at DESC`),
  );
  const now = Date.now();
  return RECURRING_TYPES.map((type) => {
    const mine = open.filter((r) => r.type === type);
    const running = mine.some((r) => r.status === "running");
    const queued = mine.filter((r) => r.status === "queued").map((r) => iso(r.run_at)).filter((v): v is string => !!v).sort();
    const nextRunAt = queued[0] ?? null;
    const last = finished.find((r) => r.type === type);
    let problem: string | null = null;
    if (!running && !nextRunAt) problem = "Not scheduled. The keeper re-seeds it within five minutes while a worker runs; if it stays missing, no worker is running.";
    else if (!running && nextRunAt && (now - new Date(nextRunAt).getTime()) / 1000 > OVERDUE_GRACE_SECONDS) problem = "Overdue: its next run is waiting and no worker has picked it up.";
    return {
      type,
      intervalSeconds: Math.round(RECURRING_JOBS[type] / 1000),
      lastFinishedAt: iso(last?.updated_at),
      lastStatus: (last?.status as string | undefined) ?? null,
      nextRunAt,
      running,
      healthy: !problem,
      problem,
    };
  });
}

/** One failed job's error as the console may show it: redacted, addresses masked, 200 characters. */
export const safeJobError = (raw: unknown): string | null => (raw ? jobErrorForLog(String(raw)).slice(0, 200) : null);

export async function systemReport() {
  const { db } = getDb();
  const unavailable: string[] = [];
  const [database, tables, open, finished, recurring, failures] = await Promise.all([
    guarded(db, "database", unavailable, async (tx) => {
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT (SELECT count(*)::int FROM _migrations) AS applied,
                 (SELECT max(name) FROM _migrations) AS latest,
                 pg_database_size(current_database())::bigint AS size`),
      );
      return r ?? null;
    }),
    guarded(db, "largestTables", unavailable, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT c.relname AS name, c.reltuples::bigint AS estimated_rows, pg_total_relation_size(c.oid)::bigint AS size
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 10`),
      ),
    ),
    guarded(db, "jobs", unavailable, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT type,
                 count(*) FILTER (WHERE status = 'queued')::int AS queued,
                 count(*) FILTER (WHERE status = 'running')::int AS running,
                 floor(extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())))::int AS oldest_queued_seconds
          FROM jobs
          WHERE status IN ('queued', 'running')
          GROUP BY type`),
      ),
    ),
    guarded(db, "jobs24h", unavailable, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT type,
                 count(*) FILTER (WHERE status = 'failed')::int AS failed,
                 count(*) FILTER (WHERE status = 'done')::int AS done
          FROM jobs
          WHERE status IN ('done', 'failed') AND updated_at > now() - interval '24 hours'
          GROUP BY type`),
      ),
    ),
    guarded(db, "recurring", unavailable, (tx) => recurringStates(tx)),
    guarded(db, "recentFailures", unavailable, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT j.id, j.type, j.org_id, o.name AS org_name, j.error, j.updated_at, j.attempts, j.max_attempts,
                 coalesce(j.payload->>'recurring', '') = 'true' AS recurring
          FROM jobs j LEFT JOIN organizations o ON o.id = j.org_id
          WHERE j.status = 'failed' AND j.updated_at > now() - interval '30 days'
          ORDER BY j.updated_at DESC
          LIMIT 20`),
      ),
    ),
  ]);

  const types = new Set<string>([...(open ?? []).map((r) => String(r.type)), ...(finished ?? []).map((r) => String(r.type))]);
  const byType = [...types]
    .map((type) => {
      const o = open?.find((r) => r.type === type);
      const f = finished?.find((r) => r.type === type);
      return { type, queued: num(o?.queued), running: num(o?.running), failed24h: num(f?.failed), done24h: num(f?.done), oldestQueuedSeconds: numOrNull(o?.oldest_queued_seconds) };
    })
    .sort((a, b) => b.failed24h - a.failed24h || b.queued + b.running - (a.queued + a.running) || a.type.localeCompare(b.type));

  return {
    serverTime: new Date().toISOString(),
    build: buildInfo(),
    database: database
      ? {
          migrationsApplied: num(database.applied),
          latestMigration: (database.latest as string | null) ?? null,
          sizeBytes: numOrNull(database.size),
          largestTables: (tables ?? []).map((t) => ({ name: String(t.name), estimatedRows: num(t.estimated_rows) >= 0 ? num(t.estimated_rows) : null, sizeBytes: num(t.size) })),
        }
      : { migrationsApplied: null, latestMigration: null, sizeBytes: null, largestTables: (tables ?? []).map((t) => ({ name: String(t.name), estimatedRows: num(t.estimated_rows) >= 0 ? num(t.estimated_rows) : null, sizeBytes: num(t.size) })) },
    config: configChecklist(),
    keepAwake: keepAwakeState(),
    jobs: {
      byType,
      recurring: recurring ?? [],
      recentFailures: (failures ?? []).map((r) => ({
        id: String(r.id),
        type: String(r.type),
        orgId: (r.org_id as string | null) ?? null,
        orgName: (r.org_name as string | null) ?? null,
        error: safeJobError(r.error),
        failedAt: iso(r.updated_at),
        attempts: num(r.attempts),
        maxAttempts: num(r.max_attempts),
        // A scheduler is never retried by hand: it re-runs on its own, and a second copy would run forever.
        retryable: r.recurring !== true,
      })),
    },
    unavailable,
  };
}

export type RetryOutcome =
  | { ok: true; id: string; type: string; orgId: string | null; previousError: string | null; note?: string }
  | { ok: false; reason: "not_found" | "not_failed" | "recurring"; status?: string };

/**
 * Put one failed job back in the queue for one more attempt.
 *
 * Only a job that is `failed`. A scheduler is refused: it has already scheduled its next run
 * (withReschedule), so retrying it would start a second copy of the chain that never ends.
 * Any charge the job carried was refunded when it finally failed, so the marker that says
 * "already charged" is removed: the retry pays for itself like a first attempt would.
 */
export async function retryFailedJob(id: string): Promise<RetryOutcome> {
  const { db } = getDb();
  const [row] = rowsOf(await db.execute(sql`SELECT id, type, org_id, status, error, coalesce(payload->>'recurring', '') = 'true' AS recurring FROM jobs WHERE id = ${id}`));
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "failed") return { ok: false, reason: "not_failed", status: String(row.status) };
  if (row.recurring === true) return { ok: false, reason: "recurring" };
  const updated = rowsOf(
    await db.execute(sql`
      UPDATE jobs SET
        status = 'queued',
        attempts = greatest(max_attempts - 1, 0),
        run_at = now(),
        locked_at = NULL,
        locked_by = NULL,
        error = NULL,
        result = NULL,
        progress = 0,
        updated_at = now(),
        payload = (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(payload) AS e(k, v) WHERE k NOT LIKE 'charged\\_%')
      WHERE id = ${id} AND status = 'failed'
      RETURNING id`),
  );
  // Someone else retried it between the read and the write.
  if (!updated.length) return { ok: false, reason: "not_failed", status: "queued" };
  const worker = env.jobMode === "worker" && embeddedWorkerOn();
  return {
    ok: true,
    id: String(row.id),
    type: String(row.type),
    orgId: (row.org_id as string | null) ?? null,
    previousError: safeJobError(row.error),
    ...(worker ? {} : { note: "Queued. This server process does not run jobs itself, so it runs when the job runner next drains the queue." }),
  };
}
