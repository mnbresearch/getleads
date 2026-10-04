import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { sslOption } from "./ssl.js";

export { chooseSsl, databaseTlsHint, isCertificateError, isTlsHandshakeFailure, sslOption, type SslChoice, type SslDecision } from "./ssl.js";

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
    // Decided per host and from DATABASE_SSL / sslmode: see ssl.ts. A remote database is never
    // silently downgraded to plaintext, and a provider with publicly trusted certificates has
    // its certificate checked.
    ssl: sslOption(url),
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export function getDb() {
  if (!cached) cached = createDb();
  return cached;
}

export async function closeDb(timeoutSeconds = 5) {
  if (cached) {
    const { sql } = cached;
    cached = null;
    await sql.end({ timeout: timeoutSeconds });
  }
}
