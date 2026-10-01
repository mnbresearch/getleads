import { and, eq, lte, sql as dsql } from "drizzle-orm";
import { hostname } from "node:os";
import type { Db } from "./client.js";
import { jobs, type Job } from "./schema.js";

/**
 * Minimal, reliable Postgres job queue using SKIP LOCKED.
 * No Redis required - runs on any free Postgres (Supabase / Neon / Railway).
 */

export type JobHandler = (job: Job, ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface JobContext {
  db: Db;
  progress: (pct: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface EnqueueOptions {
  orgId?: string | null;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

export async function enqueue(db: Db, type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}) {
  const [row] = await db
    .insert(jobs)
    .values({
      type,
      payload,
      orgId: opts.orgId ?? null,
      runAt: opts.runAt ?? new Date(),
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .returning();
  return row;
}

export async function getJob(db: Db, id: string) {
  return db.query.jobs.findFirst({ where: eq(jobs.id, id) });
}

/** Atomically claim one runnable job. Returns null if none. */
export async function claimJob(db: Db, workerId: string, types?: string[]): Promise<Job | null> {
  const typeFilter = types && types.length ? dsql`AND type IN (${dsql.join(types.map((t) => dsql`${t}`), dsql`, `)})` : dsql``;
  const rows = await db.execute<Job>(dsql`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= now() ${typeFilter}
      -- Schedulers first, whatever their stored priority. They were enqueued at priority 0
      -- while every pageview enqueues a priority-4 visit.identify, so with a small worker
      -- pool a busy site starved campaign.tick (and with it all sending) indefinitely.
      -- The expression also covers scheduler rows enqueued before they were given a
      -- priority of their own.
      ORDER BY (CASE WHEN payload->>'recurring' = 'true' THEN 1 ELSE 0 END) DESC, priority DESC, run_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const r = (rows as unknown as { rows?: Job[] }).rows ?? (rows as unknown as Job[]);
  const job = Array.isArray(r) ? r[0] : undefined;
  return job ? normalizeJob(job) : null;
}

function normalizeJob(j: Record<string, unknown>): Job {
  // db.execute returns snake_case columns; map to camelCase for consumers
  return {
    id: j.id,
    orgId: j.org_id ?? j.orgId ?? null,
    type: j.type,
    payload: j.payload ?? {},
    status: j.status,
    priority: j.priority,
    attempts: j.attempts,
    maxAttempts: j.max_attempts ?? j.maxAttempts,
    runAt: j.run_at ?? j.runAt,
    lockedAt: j.locked_at ?? j.lockedAt ?? null,
    lockedBy: j.locked_by ?? j.lockedBy ?? null,
    progress: j.progress ?? 0,
    result: j.result ?? null,
    error: j.error ?? null,
    createdAt: j.created_at ?? j.createdAt,
    updatedAt: j.updated_at ?? j.updatedAt,
  } as Job;
}

/**
 * Mark a job done - only if this worker still holds it.
 *
 * `lockedBy` guards the double-run case: a job the reaper took back (because its worker
 * looked dead) and handed to someone else must not be completed or failed by the first
 * worker when it finally returns, overwriting the second run's state. Returns false when
 * the lock had already moved on.
 */
export async function completeJob(db: Db, id: string, result?: Record<string, unknown> | void, lockedBy?: string | null) {
  const rows = await db
    .update(jobs)
    .set({ status: "done", result: result ?? null, progress: 100, lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(lockedBy ? and(eq(jobs.id, id), eq(jobs.lockedBy, lockedBy), eq(jobs.status, "running")) : eq(jobs.id, id))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function failJob(db: Db, job: Job, err: unknown) {
  const message = err instanceof Error ? `${err.message}` : String(err);
  const retry = job.attempts < job.maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** (job.attempts - 1), 30 * 60_000);
  const rows = await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      error: message.slice(0, 4000),
      runAt: retry ? new Date(Date.now() + backoffMs) : job.runAt,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    // Same ownership check as completeJob: a stale worker must not requeue or fail a job
    // that has since been reaped and reclaimed by another.
    .where(job.lockedBy ? and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy), eq(jobs.status, "running")) : eq(jobs.id, job.id))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** How long a running job may go without a heartbeat before its worker is presumed dead. */
export const STALE_LOCK_MS = 15 * 60_000;
/** Heartbeat interval while a job runs. Far below STALE_LOCK_MS so a slow job is never reaped. */
export const HEARTBEAT_MS = 60_000;

/**
 * Release jobs whose worker died (no heartbeat for 15 min).
 *
 * A reaped job has already spent the attempt its claim counted, so one that has used them
 * all is FAILED, not requeued. Requeueing regardless meant a job that reliably killed its
 * worker (out of memory, a hang) was retried forever - a poison loop that also re-ran
 * whatever it had done before dying, every fifteen minutes.
 */
export async function reapStaleJobs(db: Db) {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const failed = await db
    .update(jobs)
    .set({ status: "failed", error: "worker stopped responding (no heartbeat for 15 minutes) on its final attempt", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff), dsql`${jobs.attempts} >= ${jobs.maxAttempts}`))
    .returning({ id: jobs.id });
  const requeued = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff), dsql`${jobs.attempts} < ${jobs.maxAttempts}`))
    .returning({ id: jobs.id });
  return { failed: failed.length, requeued: requeued.length };
}

export interface WorkerOptions {
  pollMs?: number;
  concurrency?: number;
  types?: string[];
  log?: (msg: string) => void;
}

/** Long-running worker loop. Returns a stop() function. */
export function startWorker(db: Db, handlers: Record<string, JobHandler>, opts: WorkerOptions = {}) {
  const pollMs = opts.pollMs ?? 1500;
  const concurrency = opts.concurrency ?? 4;
  const log = opts.log ?? ((m) => console.log(`[worker] ${m}`));
  const workerId = `${hostname()}:${process.pid}`;
  let running = true;
  let active = 0;

  const tick = async () => {
    while (running && active < concurrency) {
      const job = await claimJob(db, workerId, opts.types ?? Object.keys(handlers)).catch((e) => {
        log(`claim error: ${e.message}`);
        return null;
      });
      if (!job) break;
      active++;
      void runJob(db, job, handlers, log).finally(() => {
        active--;
      });
    }
  };

  const interval = setInterval(tick, pollMs);
  const reaper = setInterval(() => reapStaleJobs(db).catch(() => {}), 60_000);
  void tick();
  log(`started ${workerId} concurrency=${concurrency} types=${(opts.types ?? Object.keys(handlers)).join(",")}`);

  return async () => {
    running = false;
    clearInterval(interval);
    clearInterval(reaper);
    while (active > 0) await new Promise((r) => setTimeout(r, 100));
  };
}

export async function runJob(db: Db, job: Job, handlers: Record<string, JobHandler>, log = console.log) {
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(db, { ...job, attempts: job.maxAttempts }, new Error(`no handler for ${job.type}`));
    return;
  }
  // Refresh the lock while the job runs. Without a heartbeat, any job longer than the
  // reaper's 15 minutes (a big search, a job-change sweep) was declared dead mid-run and
  // handed to a second worker - running it twice, and billing it twice.
  const beat = async () => {
    await db
      .update(jobs)
      .set({ lockedAt: new Date() })
      .where(job.lockedBy ? and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy)) : eq(jobs.id, job.id));
  };
  const ctx: JobContext = {
    db,
    progress: async (pct) => {
      await db
        .update(jobs)
        .set({ progress: Math.max(0, Math.min(100, Math.round(pct))), lockedAt: new Date() })
        .where(job.lockedBy ? and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy)) : eq(jobs.id, job.id));
    },
    log: (m) => log(`[${job.type}:${job.id.slice(0, 8)}] ${m}`),
  };
  const heartbeat = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  const started = Date.now();
  try {
    const result = await handler(job, ctx);
    const owned = await completeJob(db, job.id, result ?? undefined, job.lockedBy);
    ctx.log(owned ? `done in ${Date.now() - started}ms` : `finished in ${Date.now() - started}ms, but the job had been reaped and reclaimed; result not recorded`);
  } catch (err) {
    ctx.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    await failJob(db, job, err);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Inline mode (serverless): run all runnable jobs right now, bounded by time. */
export async function drainJobs(db: Db, handlers: Record<string, JobHandler>, maxMs = 25_000) {
  const workerId = `inline:${process.pid}`;
  const started = Date.now();
  let processed = 0;
  while (Date.now() - started < maxMs) {
    const job = await claimJob(db, workerId, Object.keys(handlers));
    if (!job) break;
    await runJob(db, job, handlers);
    processed++;
  }
  return processed;
}
