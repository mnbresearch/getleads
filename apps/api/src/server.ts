import { serve } from "@hono/node-server";
import { databaseTlsHint, getDb, runMigrations, startWorker } from "@prospex/db";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { ensureRecurringJobs, handlers, startRecurringJobKeeper } from "./jobs.js";
import { migrateLegacyLinkTokens } from "./lib/linkTokens.js";
import { describeError } from "./lib/errors.js";
import { gracefulShutdown, httpTimeouts, shutdownGraceMs } from "./shutdown.js";

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
  console.error(`[api] unhandled rejection (kept running): ${errLine(reason)}`);
});
// An uncaught exception still ends the process (its state can no longer be trusted) - but
// with one safe line instead of Node's dump of the whole error object.
process.on("uncaughtException", (e) => {
  console.error(`[api] uncaught exception, exiting: ${errLine(e)}${errWhere(e)}`);
  process.exit(1);
});

async function main() {
  // MIGRATION_DATABASE_URL lets migrations run as a role that owns the schema while the
  // application connects as one that can only read and write rows. Unset: DATABASE_URL.
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations(process.env.MIGRATION_DATABASE_URL || undefined);
  const app = createApp();
  const { db } = getDb();
  await ensureRecurringJobs();
  // Report-link tokens from before the upgrade get a lookup hash and an encrypted copy once
  // the schema is in place. Their readable copy is removed only when
  // LINK_TOKENS_CLEAR_PLAINTEXT=true: left in place (the default), the previous release can
  // still serve those links after a rollback. Idempotent and safe with several instances; a
  // failure here must not stop the server from starting - legacy links keep working as they
  // are and the next start tries again.
  const clearsPlaintext = String(process.env.LINK_TOKENS_CLEAR_PLAINTEXT ?? "").trim().toLowerCase() === "true";
  await migrateLegacyLinkTokens()
    .then((r) => {
      if (r.clientLinks || r.inviteHashes) {
        console.log(
          `[api] link tokens: ${r.clientLinks} report link(s) given a lookup hash and an encrypted copy (${clearsPlaintext ? "readable copy removed" : "readable copy kept, so a rollback can still serve them"}), ${r.inviteHashes} invite(s) given a lookup hash`,
        );
      }
    })
    .catch((e) => console.warn(`[api] could not finish preparing link tokens (will retry on next start): ${(e as Error).name}`));

  // In single-process deployments (Render free tier: one web service), run the worker in-process too.
  let stop: (() => Promise<void>) | null = null;
  let stopKeeper: (() => void) | null = null;
  if (process.env.EMBED_WORKER === "true" || (env.jobMode === "worker" && process.env.EMBED_WORKER !== "false" && env.nodeEnv !== "production")) {
    stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3) });
    // Only the process that actually runs jobs needs to keep the schedulers alive; a
    // web-only process reviving them would just create work nothing is draining.
    stopKeeper = startRecurringJobKeeper();
  }

  const timeouts = httpTimeouts();
  const server = serve({ fetch: app.fetch, port: env.port, serverOptions: timeouts }, (info) => {
    console.log(`[api] Prospex API on http://localhost:${info.port}  (docs: /docs)  jobMode=${env.jobMode} embeddedWorker=${!!stop} trustedProxy=${env.trustedProxy} adminTokenAccess=${env.adminApiToken ? "on" : "off"}`);
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      // A second Ctrl-C means "now". A repeated SIGTERM from a platform must not cut the drain short.
      if (signal === "SIGINT") {
        console.log("[api] interrupted again, exiting now");
        process.exit(1);
      }
      return;
    }
    stopping = true;
    const graceMs = shutdownGraceMs();
    console.log(`[api] ${signal}: shutting down (no new connections; up to ${Math.round(graceMs / 1000)} s for requests and jobs in progress)`);
    void gracefulShutdown({ server, stopWorker: stop, stopKeeper, graceMs })
      .then((r) => {
        console.log(`[api] stopped in ${r.ms} ms (requests finished: ${r.httpDrained ? "yes" : "no"}, jobs finished: ${r.jobsDrained ? "yes" : `no, ${r.jobsReleased} returned to the queue`})`);
        process.exit(0);
      })
      .catch((e) => {
        console.error(`[api] shutdown failed: ${errLine(e)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[api] could not start: ${errLine(e)}${errWhere(e)}`);
  // When the reason is the database's TLS certificate (or TLS itself), the fix is one setting.
  const hint = databaseTlsHint(e);
  if (hint) console.error(hint);
  process.exit(1);
});
