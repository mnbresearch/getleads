import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { loadEnv } from "./loadEnv.js";
loadEnv();

const here = dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled)
const migrationsDir = join(here, "..", "migrations");

export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, ssl: url.includes("localhost") ? false : "prefer" });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name as string));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      console.log(`[migrate] applied ${file}`);
    }
    console.log(`[migrate] up to date (${files.length} migrations)`);
  } finally {
    await sql.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
