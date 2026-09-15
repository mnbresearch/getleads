import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;

let cached: { db: Db; sql: Sql } | null = null;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false, // works with PgBouncer / Supabase transaction pooler
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "prefer",
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export function getDb() {
  if (!cached) cached = createDb();
  return cached;
}

export async function closeDb() {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = null;
  }
}
