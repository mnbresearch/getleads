import { serve } from "@hono/node-server";
import { getDb, runMigrations, startWorker } from "@getleads/db";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { ensureRecurringJobs, handlers } from "./jobs.js";

async function main() {
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations();
  const app = createApp();
  const { db } = getDb();
  await ensureRecurringJobs();

  // In single-process deployments (Render free tier: one web service), run the worker in-process too.
  let stop: (() => Promise<void>) | null = null;
  if (process.env.EMBED_WORKER === "true" || (env.jobMode === "worker" && process.env.EMBED_WORKER !== "false" && env.nodeEnv !== "production")) {
    stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3) });
  }

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[api] GetLeads API on http://localhost:${info.port}  (docs: /docs)  jobMode=${env.jobMode} embeddedWorker=${!!stop}`);
  });
  const shutdown = async () => {
    console.log("[api] shutting down");
    server.close();
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
