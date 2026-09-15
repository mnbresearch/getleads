import { getDb, runMigrations, startWorker } from "@getleads/db";
import "./env.js";
import { ensureRecurringJobs, handlers } from "./jobs.js";

async function main() {
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations();
  const { db } = getDb();
  await ensureRecurringJobs();
  const stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
