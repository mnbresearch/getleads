import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadEnv } from "./loadEnv.js";
import { sslOption } from "./ssl.js";
loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled)
const migrationsDir = join(here, "..", "migrations");

export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // NOTICEs ("relation already exists, skipping") are expected from IF NOT EXISTS and were
  // printed as raw objects on every boot.
  // Same TLS rules as the application pool (ssl.ts): the migration connection carries the same
  // credentials, so it must not be the one connection that can be downgraded to plaintext.
  const sql = postgres(url, { max: 1, ssl: sslOption(url), connect_timeout: 30, onnotice: () => {} });
  try {
    // Two processes starting at once (API + a worker, or a redeploy overlap) must not both
    // apply the same migration. Each migration takes a transaction-scoped advisory lock and
    // re-checks _migrations inside that transaction. A session-level lock was used before,
    // but behind PgBouncer transaction pooling (Neon/Supabase pooled URLs) the session lock
    // could stay held by a pooled backend forever and hang every later boot.
    // Under the same lock: two concurrent CREATE TABLE IF NOT EXISTS can still collide.
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(727274001)`;
      await tx`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    });
    const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name as string));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(migrationsDir, file), "utf8");
      const didApply = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(727274001)`;
        // Another process may have applied it while we waited for the lock.
        const already = await tx`SELECT 1 FROM _migrations WHERE name = ${file}`;
        if (already.length) return false;
        // A migration may legitimately run longer than any time limit the database role has
        // been given (ALTER ROLE ... SET statement_timeout). Lifted for this transaction only,
        // which is safe behind a transaction pooler; a session SET would not be.
        await tx`SELECT set_config('statement_timeout', '0', true)`;
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
        return true;
      });
      if (didApply) console.log(`[migrate] applied ${file}`);
    }
    console.log(`[migrate] up to date (${files.length} migrations)`);
  } finally {
    await sql.end();
  }
}

/**
 * One line that identifies a failure - class, SQLSTATE or system code, the driver's own short
 * message - without the statement, its parameters or a connection string.
 */
export function describeMigrationError(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const name = typeof err?.name === "string" ? err.name : "Error";
  const code = typeof err?.code === "string" ? ` [${err.code}]` : "";
  let msg = typeof err?.message === "string" ? err.message : String(e);
  const cut = msg.search(/Failed query:|\bparams:/i);
  if (cut >= 0) msg = `${msg.slice(0, cut).trim()} [query omitted]`.trim();
  msg = msg.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@").replace(/\s+/g, " ").slice(0, 300);
  return `${name}${code}: ${msg}`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations().catch((e) => {
    // Never the error object: the driver attaches the statement and its parameters to it.
    console.error(`[migrate] failed: ${describeMigrationError(e)}`);
    process.exit(1);
  });
}
