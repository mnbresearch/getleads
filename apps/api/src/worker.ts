import { databaseTlsHint, getDb, runMigrations, startWorker } from "@prospex/db";
import "./env.js";
import { ensureRecurringJobs, handlers, startRecurringJobKeeper } from "./jobs.js";
import { wireToolMeter } from "./lib/toolMeter.js";
import { describeError } from "./lib/errors.js";
import { gracefulShutdown, shutdownGraceMs } from "./shutdown.js";

/** Name, code and a redacted one-line message. Never the error object: an ORM error carries the statement and every bound value. */
const errLine = (e: unknown) => {
  const d = describeError(e);
  return `${d.name}${d.code ? ` [${d.code}]` : ""}: ${d.message}`;
};
/** Where it happened: the first few stack frames only (file and line - no message, so no data). */
const errWhere = (e: unknown) => {
  const stack = typeof (e as { stack?: unknown } | null)?.stack === "string" ? (e as { stack: string }).stack : "";
  const frames = stack.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 5);
  return frames.length ? `\n${frames.join("\n")}` : "";
};

// One bad job or a stray promise must never take the process down: Node's default for an
// unhandled rejection is to exit, which turned a single failing webhook into a restart loop.
process.on("unhandledRejection", (reason) => {
  console.error(`[worker] unhandled rejection (kept running): ${errLine(reason)}`);
});
// An uncaught exception still ends the process - with one safe line, not a dump of the error object.
process.on("uncaughtException", (e) => {
  console.error(`[worker] uncaught exception, exiting: ${errLine(e)}${errWhere(e)}`);
  process.exit(1);
});

async function main() {
  wireToolMeter();
  // See server.ts: an optional separate, schema-owning role for migrations.
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations(process.env.MIGRATION_DATABASE_URL || undefined);
  const { db } = getDb();
  await ensureRecurringJobs();
  const stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
  // Revive any scheduler whose chain died while the database was unreachable.
  const stopKeeper = startRecurringJobKeeper();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      if (signal === "SIGINT") {
        console.log("[worker] interrupted again, exiting now");
        process.exit(1);
      }
      return;
    }
    stopping = true;
    const graceMs = shutdownGraceMs();
    console.log(`[worker] ${signal}: shutting down (no new jobs; up to ${Math.round(graceMs / 1000)} s for the ones in progress)`);
    // Running jobs get the grace period; any still running after it are returned to the queue
    // rather than left locked for the reaper to find 15 minutes later.
    void gracefulShutdown({ stopWorker: stop, stopKeeper, graceMs })
      .then((r) => {
        console.log(`[worker] stopped in ${r.ms} ms (jobs finished: ${r.jobsDrained ? "yes" : `no, ${r.jobsReleased} returned to the queue`})`);
        process.exit(0);
      })
      .catch((e) => {
        console.error(`[worker] shutdown failed: ${errLine(e)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[worker] could not start: ${errLine(e)}${errWhere(e)}`);
  // When the reason is the database's TLS certificate (or TLS itself), the fix is one setting.
  const hint = databaseTlsHint(e);
  if (hint) console.error(hint);
  process.exit(1);
});
