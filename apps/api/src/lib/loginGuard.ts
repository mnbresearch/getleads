/**
 * Per-account sign-in lockout.
 *
 * The per-IP rate limiter stops one address hammering the login form. It does nothing against
 * the same guesses arriving from many addresses, which is what password guessing against one
 * account actually looks like: 60 wrong passwords for one account from 60 addresses all went
 * through. This counts failures per ACCOUNT, wherever they come from.
 *
 * Rule: 5 failed attempts within 15 minutes, with no successful sign-in since, locks the
 * account's password sign-in until the oldest of those five is 15 minutes old. Attempts made
 * while locked are refused before the password is looked at and are NOT recorded, so a lock
 * always expires on its own instead of being extended forever by whoever is guessing. A
 * completed password reset clears the lock at once (it proves control of the mailbox).
 *
 * The subject is the lowercased email as typed, whether or not an account exists for it, so a
 * lock does not reveal which addresses are customers. The admin dashboard login uses the
 * single subject "admin".
 */
import { and, desc, eq, getDb, loginAttempts, sql } from "@prospex/db";
import { ApiError } from "./errors.js";

export const LOCK_THRESHOLD = 5;
export const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_WINDOW_SQL = sql.raw(`interval '${LOCK_WINDOW_MS / 60_000} minutes'`);

export interface LockState {
  locked: boolean;
  /** Seconds until the lock lifts (0 when not locked). */
  retryAfterSeconds: number;
  /** Failures currently counted against the account. */
  failures: number;
}

export async function lockState(subject: string): Promise<LockState> {
  const { db } = getDb();
  const rows = await db
    .select({ at: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.subject, subject),
        eq(loginAttempts.succeeded, false),
        sql`${loginAttempts.createdAt} > now() - ${LOCK_WINDOW_SQL}`,
        sql`${loginAttempts.createdAt} > coalesce((select max(la.created_at) from login_attempts la where la.subject = ${subject} and la.succeeded), '-infinity'::timestamptz)`,
      ),
    )
    .orderBy(desc(loginAttempts.createdAt))
    .limit(LOCK_THRESHOLD);
  if (rows.length < LOCK_THRESHOLD) return { locked: false, retryAfterSeconds: 0, failures: rows.length };
  // The lock lifts when the oldest of the counted failures leaves the window.
  const oldest = rows[rows.length - 1].at.getTime();
  const retryAfterSeconds = Math.min(LOCK_WINDOW_MS / 1000, Math.max(1, Math.ceil((oldest + LOCK_WINDOW_MS - Date.now()) / 1000)));
  return { locked: true, retryAfterSeconds, failures: rows.length };
}

export async function recordAttempt(subject: string, ip: string | null, succeeded: boolean): Promise<void> {
  const { db } = getDb();
  await db.insert(loginAttempts).values({ subject, ip, succeeded });
  // Housekeeping, occasionally: nothing older than a day is ever read.
  if (Math.random() < 0.02) {
    void db
      .delete(loginAttempts)
      .where(sql`${loginAttempts.createdAt} < now() - interval '1 day'`)
      .catch(() => {});
  }
}

/** Lift a lock: a success marker makes every earlier failure stop counting. */
export async function clearLock(subject: string, ip: string | null = null): Promise<void> {
  await recordAttempt(subject, ip, true);
}

/** "in about 12 minutes" / "in under a minute". */
export function humanWait(seconds: number): string {
  if (seconds <= 60) return "in under a minute";
  const m = Math.ceil(seconds / 60);
  return `in about ${m} minutes`;
}

export function lockedError(state: LockState, what = "this account"): ApiError {
  return new ApiError(
    429,
    `Too many failed sign-in attempts for ${what}. Try again ${humanWait(state.retryAfterSeconds)}${what === "this account" ? ", or reset your password to sign in now" : ""}.`,
    "too_many_attempts",
    { retryAfterSeconds: state.retryAfterSeconds },
  );
}

/**
 * Whether to write a "locked" row to the audit log for this subject now. While an account is
 * locked every further attempt is refused, and each refusal would otherwise be a row: whoever
 * is guessing could fill the log (and the database) at will. One row a minute per account
 * says everything the hundredth would.
 */
const lockAudited = new Map<string, number>();
export function shouldAuditLock(subject: string, everyMs = 60_000): boolean {
  const now = Date.now();
  const last = lockAudited.get(subject);
  if (last !== undefined && now - last < everyMs) return false;
  if (lockAudited.size > 5000) lockAudited.clear();
  lockAudited.set(subject, now);
  return true;
}

/**
 * Run one sign-in attempt for `subject` with no other attempt for the same subject running
 * at the same time in this process.
 *
 * Check-then-record is a race: twenty parallel requests would each see "4 failures so far"
 * and each get a guess. Serialising per subject closes that on a single instance (which is
 * how the API is deployed); with several instances the overshoot is bounded by their number.
 * The queue is capped so a flood against one account cannot pile up bcrypt work.
 */
const MAX_WAITING = 8;
const chains = new Map<string, { tail: Promise<unknown>; waiting: number }>();
export async function serialised<T>(subject: string, fn: () => Promise<T>): Promise<T> {
  const entry = chains.get(subject) ?? { tail: Promise.resolve(), waiting: 0 };
  if (entry.waiting >= MAX_WAITING) {
    throw new ApiError(429, "Too many sign-in attempts for this account at once. Wait a moment and try again.", "too_many_attempts", { retryAfterSeconds: 5 });
  }
  entry.waiting++;
  chains.set(subject, entry);
  const run = entry.tail.then(fn, fn);
  entry.tail = run.catch(() => {});
  try {
    return await run;
  } finally {
    entry.waiting--;
    if (entry.waiting === 0) chains.delete(subject);
  }
}
