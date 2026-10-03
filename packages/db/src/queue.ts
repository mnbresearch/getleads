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

/**
 * Raw-SQL rows carry timestamps as strings (db.execute bypasses drizzle's column mapping).
 * Handing such a string back through a drizzle timestamp column throws inside the driver
 * ("value.toISOString is not a function"), so every timestamp is a real Date from here on.
 */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
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
    runAt: toDate(j.run_at ?? j.runAt) ?? new Date(),
    lockedAt: toDate(j.locked_at ?? j.lockedAt),
    lockedBy: j.locked_by ?? j.lockedBy ?? null,
    progress: j.progress ?? 0,
    result: j.result ?? null,
    error: j.error ?? null,
    createdAt: toDate(j.created_at ?? j.createdAt) ?? new Date(),
    updatedAt: toDate(j.updated_at ?? j.updatedAt) ?? new Date(),
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

/**
 * Mask credentials in a job's error before it is stored or logged.
 *
 * `jobs.error` is read back by tenants for some job types (a search, an agent run), and an
 * error is whatever the failing call threw: an upstream body that echoes the API key it was
 * given, a request URL with `?api_key=` in it, a connection string. This package cannot
 * depend on @prospex/core (which has the fuller `redact`), so the same rules live here in
 * small: configured secrets by value, then the shapes credentials take.
 */
const SECRET_ENV_NAME = /(_API_KEY|_KEY|_SECRET|_TOKEN|_PASS|_PASSWORD|^JWT_SECRET|^ENCRYPTION_KEY|^DATABASE_URL)$/;
export function redactJobError(text: unknown): string {
  let out = String(text ?? "");
  if (!out) return "";
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && SECRET_ENV_NAME.test(k) && out.includes(v)) out = out.split(v).join("[redacted-key]");
  }
  return out
    .replace(/([?&;\s](?:api_?key|apikey|key|token|access_token|refresh_token|api_token|auth|password|passwd|pass|secret|client_secret|signature|sig)=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/((?:authorization|proxy-authorization|x-api-key|api-key)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|zoho-oauthtoken\s+)?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:[redacted]@")
    .replace(/\b(?:org|proj|acct)[_-][A-Za-z0-9]{8,}\b/g, (m) => (/[0-9]/.test(m) ? "[provider-account-id]" : m))
    .replace(/\b(?:sk|pk|rk|px)_(?:live|test)_[A-Za-z0-9_-]{8,}|\bre_[A-Za-z0-9_]{16,}|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bkey-[A-Za-z0-9_-]{16,}|\bgsk_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "[redacted-key]")
    .replace(/\b[a-fA-F0-9]{32,}\b/g, "[redacted-hex]")
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[redacted-token]" : m));
}

export async function failJob(db: Db, job: Job, err: unknown) {
  const message = redactJobError(err instanceof Error ? `${err.message}` : String(err));
  const retry = job.attempts < job.maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** (job.attempts - 1), 30 * 60_000);
  // A final failure leaves run_at alone. Writing job.runAt back used to crash the whole
  // process when the row came from claimJob's raw SQL (a string, not a Date).
  const rows = await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      error: message.slice(0, 4000),
      ...(retry ? { runAt: new Date(Date.now() + backoffMs) } : {}),
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
      // runJob already contains its own failures; this catch is the last line so that a
      // DB fault while recording an outcome is logged, never an unhandled rejection that
      // takes the whole process (and the API embedded with it) down.
      void runJob(db, job, handlers, log)
        .catch((e) => log(`job ${job.id} bookkeeping error: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          active--;
        });
    }
  };

  const interval = setInterval(() => void tick().catch((e) => log(`tick error: ${e instanceof Error ? e.message : String(e)}`)), pollMs);
  const reaper = setInterval(() => reapStaleJobs(db).catch(() => {}), 60_000);
  void tick().catch((e) => log(`tick error: ${e instanceof Error ? e.message : String(e)}`));
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
    await failJob(db, { ...job, attempts: job.maxAttempts }, new Error(`no handler for ${job.type}`)).catch((e) =>
      log(`[${job.type}:${job.id.slice(0, 8)}] could not record failure: ${e instanceof Error ? e.message : String(e)}`),
    );
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
  let result: Record<string, unknown> | void = undefined;
  let failure: unknown = null;
  let threw = false;
  try {
    result = await handler(job, ctx);
  } catch (err) {
    threw = true;
    failure = err;
  }
  // Recording the outcome is its own step: a throw from completeJob/failJob (a dropped
  // connection, a bad value) must be logged, never escape - an escaped rejection here is
  // an unhandled rejection that kills the process. The job stays "running" and the reaper
  // returns it to the queue.
  try {
    if (!threw) {
      const owned = await completeJob(db, job.id, result ?? undefined, job.lockedBy);
      ctx.log(owned ? `done in ${Date.now() - started}ms` : `finished in ${Date.now() - started}ms, but the job had been reaped and reclaimed; result not recorded`);
    } else {
      ctx.log(`failed: ${redactJobError(failure instanceof Error ? failure.message : String(failure))}`);
      await failJob(db, job, failure);
    }
  } catch (e) {
    ctx.log(`could not record outcome: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Claim and run one specific queued job, now. For inline mode, where a request that just
 * enqueued its own job should not first wait behind every scheduler and backlog job due.
 * Returns false when the job was not claimable (already taken, not queued, not due).
 */
export async function runJobById(db: Db, handlers: Record<string, JobHandler>, jobId: string, workerId = `inline:${process.pid}`) {
  const rows = await db.execute<Job>(dsql`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs WHERE id = ${jobId} AND status = 'queued' AND run_at <= now()
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const r = (rows as unknown as { rows?: Job[] }).rows ?? (rows as unknown as Job[]);
  const job = Array.isArray(r) ? r[0] : undefined;
  if (!job) return false;
  await runJob(db, normalizeJob(job as unknown as Record<string, unknown>), handlers);
  return true;
}

/** Inline mode (serverless): run all runnable jobs right now, bounded by time. */
export async function drainJobs(db: Db, handlers: Record<string, JobHandler>, maxMs = 25_000) {
  const workerId = `inline:${process.pid}`;
  const started = Date.now();
  let processed = 0;
  while (Date.now() - started < maxMs) {
    let job: Job | null;
    try {
      job = await claimJob(db, workerId, Object.keys(handlers));
    } catch (e) {
      console.warn(`[queue] drain claim error: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    if (!job) break;
    // One bad job must not end the drain (or the request driving it).
    await runJob(db, job, handlers).catch((e) => console.warn(`[queue] job ${job!.id} bookkeeping error: ${e instanceof Error ? e.message : String(e)}`));
    processed++;
  }
  return processed;
}
