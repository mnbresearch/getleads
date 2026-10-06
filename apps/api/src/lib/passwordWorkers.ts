import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * bcrypt on worker threads.
 *
 * bcryptjs is pure JavaScript. Its "async" form only yields between rounds, so every hash and
 * every compare still spends its ~80 ms on the one thread that also answers every other
 * request. A burst of sign-ins therefore stalled the whole API: at 100-200 parallel sign-ins
 * the health check took 5-12 seconds, because the database replies of unrelated requests
 * waited in line behind password rounds.
 *
 * The work now runs on a small pool of worker threads; the main thread only posts a message
 * and waits. The hashes are the same bcrypt, made by the same library - every stored hash
 * verifies as before.
 *
 * How it stays robust:
 *  - The worker's code is a string in this file (`new Worker(code, { eval: true })`), so it
 *    does not depend on a sibling .js file existing. That is what makes it work the three
 *    ways this code runs: built (`node apps/api/dist/server.js`), under `tsx`, and under
 *    vitest on the TypeScript sources. bcryptjs is found by its absolute path, resolved here
 *    on the main thread.
 *  - A worker that cannot start, dies, or does not answer in time is dropped, and the task
 *    that was on it is done on the main thread instead (the old path). Sign-in never fails
 *    because of the pool. After a failure the pool is left alone for a minute before it is
 *    tried again, and the reason is logged once.
 *  - Idle workers are `unref`ed: they never keep the process alive. Graceful shutdown
 *    terminates them (`stopPasswordWorkers`).
 *
 * Concurrency is the caller's business (lib/auth.ts runs at most PASSWORD_HASH_CONCURRENCY
 * tasks at a time, with a bounded wait); this file only ever needs one idle worker per
 * running task, and starts them on demand up to `size`.
 */

export type BcryptTask = { op: "hash"; password: string; rounds: number } | { op: "compare"; password: string; hash: string };

/** Thrown when the pool could not do a task. The caller does it on the main thread. */
export class PasswordWorkerUnavailable extends Error {
  constructor(reason: string) {
    super(`password worker unavailable: ${reason}`);
    this.name = "PasswordWorkerUnavailable";
  }
}

const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const bcrypt = require(workerData.bcryptPath);
parentPort.on("message", (m) => {
  try {
    const out = m.op === "hash" ? bcrypt.hashSync(m.password, m.rounds) : bcrypt.compareSync(m.password, m.hash);
    parentPort.postMessage({ id: m.id, ok: true, out });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
});
`;

/** Far longer than any real hash (about 0.1 s); a worker this slow is stuck. */
const TASK_TIMEOUT_MS = 20_000;
/** After a failure the pool is not tried again for this long. */
const RETRY_AFTER_MS = 60_000;

interface Slot {
  worker: Worker;
  busy: boolean;
  settle?: { id: number; resolve: (v: string | boolean) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
}

const slots: Slot[] = [];
let seq = 0;
let disabledUntil = 0;
let logged = false;
let stopped = false;
let bcryptPath: string | null = null;
/** Counters, for tests and for the measurement in the round-6 report. */
export const passwordWorkerStats = { started: 0, tasks: 0, fallbacks: 0, failures: 0 };

function fail(reason: string): PasswordWorkerUnavailable {
  passwordWorkerStats.failures++;
  disabledUntil = Date.now() + RETRY_AFTER_MS;
  if (!logged) {
    logged = true;
    console.warn(`[auth] password hashing is running on the main thread for now: a worker thread could not be used (${reason}). Sign-in keeps working; it is slower under load.`);
  }
  return new PasswordWorkerUnavailable(reason);
}

function drop(slot: Slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  void slot.worker.terminate().catch(() => {});
}

function start(): Slot {
  bcryptPath ??= createRequire(import.meta.url).resolve("bcryptjs");
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath }, stdout: false, stderr: false });
  const slot: Slot = { worker, busy: false };
  const broken = (reason: string) => {
    // Already dropped (timed out, or shut down): nothing left to hand back.
    if (!slots.includes(slot)) return;
    const s = slot.settle;
    slot.settle = undefined;
    drop(slot);
    if (s) {
      clearTimeout(s.timer);
      s.reject(fail(reason));
    } else if (!stopped) {
      fail(reason);
    }
  };
  worker.on("message", (m: { id: number; ok: boolean; out?: string | boolean; error?: string }) => {
    const s = slot.settle;
    if (!s || s.id !== m.id) return;
    slot.settle = undefined;
    slot.busy = false;
    clearTimeout(s.timer);
    worker.unref(); // idle again: must not hold the process open
    // An error INSIDE bcrypt (a malformed stored hash, say) is the task's own answer, not a
    // broken worker: it is handed back as a plain error, exactly as the library would throw.
    if (m.ok) s.resolve(m.out as string | boolean);
    else s.reject(new Error(m.error ?? "bcrypt failed"));
  });
  worker.on("error", (e) => broken((e as Error)?.message ?? "worker error"));
  worker.on("exit", (code) => broken(`worker exited with code ${code}`));
  // An idle worker never holds the process open. AFTER the listeners: adding a "message"
  // listener makes a worker hold the process open again, so an unref() made before them is
  // silently undone (measured on Node 22: the process then never exits on its own).
  // While a task is in flight the worker IS ref'ed (see bcryptOnWorker): a one-off script
  // that only hashes a password must not exit before its answer arrives.
  worker.unref();
  slots.push(slot);
  passwordWorkerStats.started++;
  return slot;
}

/**
 * Do one bcrypt task on a worker thread. Rejects with PasswordWorkerUnavailable when the pool
 * cannot (the caller then uses the main thread); rejects with a plain Error when bcrypt
 * itself refused the input.
 */
export function bcryptOnWorker(task: BcryptTask, size: number): Promise<string | boolean> {
  if (stopped) return Promise.reject(new PasswordWorkerUnavailable("shutting down"));
  if (Date.now() < disabledUntil) return Promise.reject(new PasswordWorkerUnavailable("recently failed"));
  let slot = slots.find((s) => !s.busy);
  if (!slot) {
    if (slots.length >= Math.max(1, size)) return Promise.reject(new PasswordWorkerUnavailable("every worker is busy"));
    try {
      slot = start();
    } catch (e) {
      return Promise.reject(fail((e as Error)?.message ?? "could not start"));
    }
  }
  const s = slot;
  s.busy = true;
  passwordWorkerStats.tasks++;
  return new Promise<string | boolean>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (s.settle?.id !== id) return;
      s.settle = undefined;
      drop(s);
      reject(fail("no answer in time"));
    }, TASK_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    s.settle = { id, resolve, reject, timer };
    try {
      s.worker.ref();
      s.worker.postMessage({ id, ...task });
    } catch (e) {
      s.settle = undefined;
      clearTimeout(timer);
      drop(s);
      reject(fail((e as Error)?.message ?? "could not reach the worker"));
    }
  });
}

/** Terminate every worker (graceful shutdown). Tasks in flight finish on the main thread. */
export async function stopPasswordWorkers(): Promise<void> {
  stopped = true;
  const all = slots.splice(0);
  for (const s of all) {
    const pending = s.settle;
    s.settle = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new PasswordWorkerUnavailable("shutting down"));
    }
  }
  await Promise.all(all.map((s) => s.worker.terminate().catch(() => 0)));
}

/** Testing seam: forget failures and allow workers again (after stopPasswordWorkers, or a simulated failure). */
export function resetPasswordWorkers(): void {
  stopped = false;
  disabledUntil = 0;
  logged = false;
}

/** Testing seam: the live workers, so a test can kill one mid-task. */
export function passwordWorkerThreads(): Worker[] {
  return slots.map((s) => s.worker);
}
