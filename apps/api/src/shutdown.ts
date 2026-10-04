import { hostname } from "node:os";
import { closeDb, getDb, sql, type Db } from "@prospex/db";
import { describeError } from "./lib/errors.js";

/**
 * Stopping without dropping work.
 *
 * A deploy or a restart sends SIGTERM. The process used to call `server.close()` without
 * waiting for it and exit as soon as the worker loop was idle - which, for a web-only
 * process, was immediately: a request in flight got a closed socket and no answer. A job that
 * outlived the platform's kill timer was killed with its lock still held, and sat "running"
 * for 15 minutes until the reaper noticed.
 *
 * Now, in order: stop listening; let requests already being served finish; let the jobs
 * already running finish; wait for both at most `graceMs`; hand back any job that is still
 * running (so the next process picks it up at once instead of in 15 minutes); close the
 * database pool; return. The caller exits.
 */

/** The part of a Node HTTP server this needs (also satisfied by a test double). */
export interface ClosableServer {
  close(cb?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownParts {
  server?: ClosableServer | null;
  /** Stops the worker loop claiming new jobs and resolves when the running ones are done. */
  stopWorker?: (() => Promise<void>) | null;
  /** Stops the recurring-job keeper. */
  stopKeeper?: (() => void) | null;
  /** How long requests and jobs get to finish. */
  graceMs?: number;
  /** Lock owner of this process's jobs, as written by the worker loop. */
  workerId?: string;
  /** Returns how many jobs were handed back. Defaults to `releaseJobLocks` on the shared pool. */
  releaseLocks?: (workerId: string) => Promise<number>;
  /** Defaults to closing the shared pool. */
  closePool?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface ShutdownResult {
  /** Every request in flight got its answer. */
  httpDrained: boolean;
  /** Every running job finished. */
  jobsDrained: boolean;
  /** Jobs still running at the deadline, returned to the queue. */
  jobsReleased: number;
  ms: number;
}

/** Default time for requests and jobs to finish: under the 30 seconds most platforms allow before SIGKILL. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;

/** SHUTDOWN_GRACE_MS, clamped to 1 s - 10 min; the default when unset or unusable. */
export function shutdownGraceMs(raw: string | undefined = process.env.SHUTDOWN_GRACE_MS): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_SHUTDOWN_GRACE_MS;
  return Math.min(Math.max(Math.floor(n), 1_000), 10 * 60_000);
}

/**
 * The lock owner the worker loop in @prospex/db writes into jobs.locked_by for this process
 * (`<hostname>:<pid>`, see startWorker in packages/db/src/queue.ts). Kept in step with it by
 * a test.
 */
export function localWorkerId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * Hand this process's still-running jobs back to the queue.
 *
 * Only called after the worker loop has stopped claiming, at the moment the process is about
 * to exit, so nothing here is still going to finish them. The attempt the claim counted is
 * given back: the job did not fail, the process was told to stop. A handler that is repeated
 * must already be safe to repeat - the reaper has always re-queued the jobs of a dead worker -
 * and the send path in particular refuses to send a message it may already have sent.
 */
export async function releaseJobLocks(db: Db, workerId: string): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
      attempts = GREATEST(attempts - 1, 0), updated_at = now()
    WHERE status = 'running' AND locked_by = ${workerId}
    RETURNING id
  `);
  const r = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return Array.isArray(r) ? r.length : 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `p`, or `fallback` if it has not settled within `ms`. Never rejects. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function gracefulShutdown(parts: ShutdownParts): Promise<ShutdownResult> {
  const started = Date.now();
  const log = parts.log ?? ((l: string) => console.log(l));
  const graceMs = parts.graceMs ?? shutdownGraceMs();
  const safe = (what: string, e: unknown) => {
    const d = describeError(e);
    log(`[shutdown] ${what}: ${d.name}${d.code ? ` [${d.code}]` : ""}: ${d.message}`);
  };

  try {
    parts.stopKeeper?.();
  } catch (e) {
    safe("could not stop the recurring-job keeper", e);
  }

  // 1. Stop listening. close() resolves once every connection has ended; connections that
  //    are merely being kept alive are closed now, and again as each in-flight request
  //    finishes and its connection goes idle.
  let httpDrained = !parts.server;
  let sweep: ReturnType<typeof setInterval> | undefined;
  const httpDone = parts.server
    ? new Promise<void>((resolve) => {
        const server = parts.server!;
        try {
          server.close(() => {
            httpDrained = true;
            resolve();
          });
          server.closeIdleConnections?.();
          sweep = setInterval(() => server.closeIdleConnections?.(), 200);
        } catch (e) {
          // ERR_SERVER_NOT_RUNNING: it never started listening, so there is nothing to drain.
          httpDrained = true;
          resolve();
          if ((e as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") safe("could not close the HTTP server", e);
        }
      })
    : Promise.resolve();

  // 2. Stop claiming jobs; wait for the ones already running.
  let jobsDrained = !parts.stopWorker;
  const jobsDone = parts.stopWorker
    ? parts
        .stopWorker()
        .then(() => {
          jobsDrained = true;
        })
        .catch((e) => safe("the worker did not stop cleanly", e))
    : Promise.resolve();

  // 3. Both, but not for ever.
  await within(Promise.all([httpDone, jobsDone]).then(() => true), graceMs, false);
  if (sweep) clearInterval(sweep);
  // What had finished BY THE DEADLINE is the result. Forcing the rest closed below makes the
  // callbacks fire too, and must not be reported as "everything finished".
  const httpFinished = httpDrained;
  const jobsFinished = jobsDrained;

  if (!httpFinished) {
    log(`[shutdown] some requests were still in flight after ${Math.round(graceMs / 1000)} s; closing their connections`);
    try {
      parts.server?.closeAllConnections?.();
    } catch (e) {
      safe("could not close the remaining connections", e);
    }
  }

  // 4. A job still running now will not be finished by this process. Give it back.
  let jobsReleased = 0;
  if (!jobsFinished) {
    const workerId = parts.workerId ?? localWorkerId();
    const release = parts.releaseLocks ?? ((id: string) => releaseJobLocks(getDb().db, id));
    jobsReleased = await within(
      release(workerId).catch((e) => {
        safe("could not return the running jobs to the queue (the reaper will, in 15 minutes)", e);
        return 0;
      }),
      5_000,
      0,
    );
    log(`[shutdown] ${jobsReleased} job(s) were still running after ${Math.round(graceMs / 1000)} s and were returned to the queue`);
  }

  // 5. Close the pool, so the database sees clean disconnects rather than dropped sockets.
  const closePool = parts.closePool ?? (() => closeDb(3));
  await within(
    closePool().catch((e) => safe("could not close the database pool", e)),
    6_000,
    undefined,
  );
  // Let the final log lines flush.
  await sleep(10);
  return { httpDrained: httpFinished, jobsDrained: jobsFinished, jobsReleased, ms: Date.now() - started };
}

/** A positive number of milliseconds from the environment, within [min, max]; otherwise the default. */
function msFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * HTTP server timeouts. Node's defaults suit a server on the open internet with nothing in
 * front of it; this one sits behind a reverse proxy, which changes two of them:
 *
 *  - keepAliveTimeout (default 5 s) must be LONGER than the proxy's idle timeout. With 5 s the
 *    server closes an idle connection the proxy still believes is open, and the next request
 *    the proxy sends down it comes back to the visitor as a 502. 75 s is above the 60 s that
 *    common load balancers use.
 *  - requestTimeout (default 300 s) is how long one request may take to ARRIVE. Five minutes
 *    lets a client hold a connection open by sending a body one byte at a time; two minutes
 *    still leaves room for a 10 MB import on a slow line. It does not limit how long a
 *    response may take.
 *  - headersTimeout (default 60 s): 30 s is ample for request headers.
 */
export function httpTimeouts() {
  const keepAliveTimeout = msFromEnv("HTTP_KEEPALIVE_TIMEOUT_MS", 75_000, 1_000, 10 * 60_000);
  const requestTimeout = msFromEnv("HTTP_REQUEST_TIMEOUT_MS", 120_000, 5_000, 30 * 60_000);
  // Node refuses a headersTimeout above requestTimeout.
  const headersTimeout = Math.min(msFromEnv("HTTP_HEADERS_TIMEOUT_MS", 30_000, 1_000, 5 * 60_000), requestTimeout);
  // Node checks for overdue connections on a timer (30 s by default), so a limit is enforced
  // up to one interval late. 10 s keeps the limits above close to what they say.
  return { keepAliveTimeout, requestTimeout, headersTimeout, connectionsCheckingInterval: 10_000 };
}
