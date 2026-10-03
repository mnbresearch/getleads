import { serve } from "@hono/node-server";
import { getDb, runMigrations, startWorker } from "@prospex/db";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { ensureRecurringJobs, handlers, startRecurringJobKeeper } from "./jobs.js";
import { migrateLegacyLinkTokens } from "./lib/linkTokens.js";

// One bad job or a stray promise must never take the process down: Node's default for an
// unhandled rejection is to exit, which turned a single failing webhook into a restart loop.
process.on("unhandledRejection", (reason) => {
  console.error("[api] unhandled rejection (kept running):", reason);
});

async function main() {
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations();
  const app = createApp();
  const { db } = getDb();
  await ensureRecurringJobs();
  // Report-link tokens still stored in plaintext are encrypted (and their plaintext column
  // cleared) once the schema is in place. Idempotent and safe with several instances; a
  // failure here must not stop the server from starting - legacy links keep working as they
  // are and the next start tries again.
  await migrateLegacyLinkTokens()
    .then((r) => {
      if (r.clientLinks || r.inviteHashes) console.log(`[api] link tokens: ${r.clientLinks} report link(s) moved out of plaintext, ${r.inviteHashes} invite(s) given a lookup hash`);
    })
    .catch((e) => console.warn(`[api] could not finish moving link tokens out of plaintext (will retry on next start): ${(e as Error).name}`));

  // In single-process deployments (Render free tier: one web service), run the worker in-process too.
  let stop: (() => Promise<void>) | null = null;
  let stopKeeper: (() => void) | null = null;
  if (process.env.EMBED_WORKER === "true" || (env.jobMode === "worker" && process.env.EMBED_WORKER !== "false" && env.nodeEnv !== "production")) {
    stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3) });
    // Only the process that actually runs jobs needs to keep the schedulers alive; a
    // web-only process reviving them would just create work nothing is draining.
    stopKeeper = startRecurringJobKeeper();
  }

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[api] Prospex API on http://localhost:${info.port}  (docs: /docs)  jobMode=${env.jobMode} embeddedWorker=${!!stop} trustedProxy=${env.trustedProxy} adminTokenAccess=${env.adminApiToken ? "on" : "off"}`);
  });
  const shutdown = async () => {
    console.log("[api] shutting down");
    server.close();
    if (stopKeeper) stopKeeper();
    if (stop) await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
