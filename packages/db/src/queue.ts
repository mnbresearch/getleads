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
      ORDER BY priority DESC, run_at ASC
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

export async function completeJob(db: Db, id: string, result?: Record<string, unknown> | void) {
  await db
    .update(jobs)
    .set({ status: "done", result: result ?? null, progress: 100, lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(eq(jobs.id, id));
}

export async function failJob(db: Db, job: Job, err: unknown) {
  const message = err instanceof Error ? `${err.message}` : String(err);
  const retry = job.attempts < job.maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** (job.attempts - 1), 30 * 60_000);
  await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      error: message.slice(0, 4000),
      runAt: retry ? new Date(Date.now() + backoffMs) : job.runAt,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
}

/** Release jobs whose worker died (locked > 15 min). */
export async function reapStaleJobs(db: Db) {
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, new Date(Date.now() - 15 * 60_000))));
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
  const ctx: JobContext = {
    db,
    progress: async (pct) => {
      await db.update(jobs).set({ progress: Math.max(0, Math.min(100, Math.round(pct))) }).where(eq(jobs.id, job.id));
    },
    log: (m) => log(`[${job.type}:${job.id.slice(0, 8)}] ${m}`),
  };
  const started = Date.now();
  try {
    const result = await handler(job, ctx);
    await completeJob(db, job.id, result ?? undefined);
    ctx.log(`done in ${Date.now() - started}ms`);
  } catch (err) {
    ctx.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    await failJob(db, job, err);
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
