import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Run `fn` with a cap on how long any one statement inside it may run.
 *
 * The cap is set with a transaction-local setting, so it works behind a transaction pooler
 * (PgBouncer, Neon and Supabase pooled URLs), where a session-level SET or a startup
 * parameter either leaks to other clients or is refused outright. When the cap is hit
 * Postgres cancels the statement and this rejects with an error `isStatementTimeout`
 * recognises; nothing done inside `fn` is kept.
 */
export async function withStatementTimeout<T>(db: Db, ms: number, fn: (tx: Db) => Promise<T>): Promise<T> {
  const capped = Math.max(1, Math.min(Math.floor(ms), 10 * 60_000));
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(capped)}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Was this error Postgres cancelling a statement that ran past its time limit? */
export function isStatementTimeout(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code === "57014") return true;
    if (typeof o.message === "string" && /statement timeout/i.test(o.message)) return true;
    cur = o.cause;
  }
  return false;
}
