import { getDb, runMigrations, startWorker } from "@prospex/db";
import "./env.js";
import { ensureRecurringJobs, handlers, startRecurringJobKeeper } from "./jobs.js";
import { wireToolMeter } from "./lib/toolMeter.js";

async function main() {
  wireToolMeter();
  if (process.env.AUTO_MIGRATE !== "false") await runMigrations();
  const { db } = getDb();
  await ensureRecurringJobs();
  const stop = startWorker(db, handlers, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
  // Revive any scheduler whose chain died while the database was unreachable.
  const stopKeeper = startRecurringJobKeeper();
  const shutdown = async () => {
    stopKeeper();
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
