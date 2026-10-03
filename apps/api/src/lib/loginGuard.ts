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
 * single subject "admin" and its own thresholds (ADMIN_LOCK_POLICY below).
 *
 * A lock anyone can trigger is also a way to shut the real owner out: five wrong guesses from
 * a stranger, repeated every fifteen minutes, and the customer (or the operator, on the admin
 * login) never gets in. So an address that has signed in to this account successfully in the
 * last 90 days is judged on ITS OWN failures only: guesses from elsewhere do not lock it out,
 * and it still locks itself after five wrong passwords of its own. Guessing from a new
 * address stays locked account-wide, which is the case the lock exists for.
 *
 * What clears a failure, exactly: a later success FROM THE SAME ADDRESS (the person got it
 * right in the end), or a later password reset (a row with no address - the old guesses were
 * at a password that no longer exists). A success from some other address clears nothing of
 * anyone else's: if the owner signing in from home wiped the count, a stranger mid-attack
 * would get five fresh guesses every time the owner signed in.
 *
 * An address can only become "known" by presenting the right password (or completing an
 * emailed reset, which needs the mailbox). Nothing an attacker can do without one of those
 * writes a success row, so they cannot promote themselves out of the account-wide lock. And
 * "known" does not outlive the credential that earned it: when the account is claimed through
 * Google, or its password is reset or changed, every other address is forgotten
 * (forgetOtherKnownAddresses).
 *
 * "Address" is what clientIp() reports, so it is as trustworthy as TRUSTED_PROXY is correct:
 * behind Cloudflare (Render) or a real reverse proxy the client cannot choose it. If the
 * header were spoofable, a guesser who also knew one of the owner's addresses could borrow
 * its separate allowance - five more guesses per fifteen minutes per such address, still a
 * limit, never a bypass - and random spoofed addresses are simply unknown and stay locked.
 * The literal "unknown" (no usable header) is never treated as a known address. IPv6
 * addresses are compared by their /64, because one device changes the other half daily.
 */
import { isIP } from "node:net";
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

/** How long a successful sign-in keeps an address "known" for an account. */
export const KNOWN_IP_DAYS = 90;

/**
 * The form of an address used for matching and stored in login_attempts.
 *
 * IPv4 as is. IPv6 as its /64 prefix: a phone or laptop on IPv6 keeps its network prefix but
 * rotates the rest (privacy addresses), so comparing whole addresses would make the owner a
 * stranger again every day. Anything that is not an address (including "unknown") is null.
 */
export function ipKey(ip: string | null | undefined): string | null {
  const raw = (ip ?? "").trim().toLowerCase();
  if (!raw || raw === "unknown") return null;
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind !== 6) return null;
  // IPv4-mapped (::ffff:1.2.3.4) is an IPv4 client.
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail = ""] = raw.split("%")[0].split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = raw.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (g.includes(".") ? "0" : g.replace(/^0+(?=.)/, ""))).join(":")}::/64`;
}

const KNOWN_WINDOW_SQL = sql.raw(`interval '${KNOWN_IP_DAYS} days'`);

/** Has this address signed in to this account successfully before (recently)? */
export async function isKnownIp(subject: string, ip: string | null | undefined): Promise<boolean> {
  const key = ipKey(ip);
  if (!key) return false;
  const { db } = getDb();
  const [row] = await db
    .select({ id: loginAttempts.id })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.subject, subject), eq(loginAttempts.ip, key), eq(loginAttempts.succeeded, true), sql`${loginAttempts.createdAt} > now() - ${KNOWN_WINDOW_SQL}`))
    .limit(1);
  return !!row;
}

/**
 * Has ANY address signed in to this account successfully (recently)?
 *
 * "A sign-in from a new address" only means something when there are old ones to compare
 * with. An account with no history at all (it last signed in before sign-ins were recorded)
 * has no known addresses, and telling its owner that today's ordinary sign-in is "new" would
 * be a false alarm sent to every existing customer on the day this shipped.
 */
export async function hasKnownIps(subject: string): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db
    .select({ id: loginAttempts.id })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.subject, subject), eq(loginAttempts.succeeded, true), sql`${loginAttempts.ip} IS NOT NULL`, sql`${loginAttempts.createdAt} > now() - ${KNOWN_WINDOW_SQL}`))
    .limit(1);
  return !!row;
}

/**
 * Is this a sign-in from an address the account has not used before? True only when the
 * address is usable, is not known for the account, and the account has other known addresses.
 * Call it BEFORE recording the success - afterwards every address is known.
 */
export async function isNewAddressFor(subject: string, ip: string | null | undefined): Promise<boolean> {
  if (!ipKey(ip)) return false;
  if (await isKnownIp(subject, ip)) return false;
  return hasKnownIps(subject);
}

/**
 * How a subject is locked.
 *
 * `accountWide`: failures from ALL addresses (within the window, not since cleared) at which
 * the account is locked for every address that is not known for it.
 * `perAddress`: when set, failures from ONE address at which that address is locked, whether
 * or not it is known - and the only thing a known address is judged on.
 */
export interface LockPolicy {
  accountWide: number;
  perAddress?: number;
}

/** Customer accounts: five failures from anywhere; a known address is judged on its own five. */
export const CUSTOMER_LOCK_POLICY: LockPolicy = { accountWide: LOCK_THRESHOLD };

/**
 * The admin sign-in.
 *
 * It has ONE subject ("admin") for the whole platform, so the customer rule made the operator
 * lockable by anyone: five anonymous wrong guesses and the operator, arriving from an address
 * that had not signed in before (a new office, a phone, the first sign-in after a deploy), was
 * shut out - repeatable every fifteen minutes, for ever. Here each address gets its own five
 * attempts, and the account as a whole is only locked (for addresses not already known) after
 * fifty failures in the window, which is what a spread-out guessing run looks like. Fifty
 * guesses per fifteen minutes against a long random password is no meaningful attack; fifty
 * is also far beyond what an operator mistyping could produce.
 */
export const ADMIN_LOCK_THRESHOLD = 50;
export const ADMIN_LOCK_POLICY: LockPolicy = { accountWide: ADMIN_LOCK_THRESHOLD, perAddress: LOCK_THRESHOLD };

/** The counted failures for a subject (optionally one address), newest first, at most `limit`. */
async function countedFailures(subject: string, limit: number, address?: string) {
  const { db } = getDb();
  return db
    .select({ at: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.subject, subject),
        eq(loginAttempts.succeeded, false),
        address !== undefined ? eq(loginAttempts.ip, address) : undefined,
        sql`${loginAttempts.createdAt} > now() - ${LOCK_WINDOW_SQL}`,
        // Still counts unless something cleared it: a later success from the same address, or
        // a later reset marker (success row with no address). Never a success from elsewhere.
        sql`not exists (select 1 from login_attempts s where s.subject = ${subject} and s.succeeded and s.created_at > ${loginAttempts.createdAt} and (s.ip is null or s.ip = ${loginAttempts.ip}))`,
      ),
    )
    .orderBy(desc(loginAttempts.createdAt))
    .limit(limit);
}

function lockFrom(rows: { at: Date }[], threshold: number): LockState {
  if (rows.length < threshold) return { locked: false, retryAfterSeconds: 0, failures: rows.length };
  // The lock lifts when the oldest of the counted failures leaves the window.
  const oldest = rows[rows.length - 1].at.getTime();
  const retryAfterSeconds = Math.min(LOCK_WINDOW_MS / 1000, Math.max(1, Math.ceil((oldest + LOCK_WINDOW_MS - Date.now()) / 1000)));
  return { locked: true, retryAfterSeconds, failures: rows.length };
}

export async function lockState(subject: string, ip?: string | null, policy: LockPolicy = CUSTOMER_LOCK_POLICY): Promise<LockState> {
  const key = ipKey(ip);
  const known = await isKnownIp(subject, ip);
  if (policy.perAddress !== undefined) {
    // This address's own failures first. An attempt with no usable address is stored as
    // "unknown" (see recordAttempt), so all such attempts share one allowance.
    const own = lockFrom(await countedFailures(subject, policy.perAddress, key ?? "unknown"), policy.perAddress);
    if (own.locked || known) return own;
    const all = lockFrom(await countedFailures(subject, policy.accountWide), policy.accountWide);
    return all.locked ? all : own;
  }
  // A known address is judged on its own failures; anything else on the account's.
  return lockFrom(await countedFailures(subject, policy.accountWide, known ? key! : undefined), policy.accountWide);
}

/**
 * Record an attempt. A failure with no usable address is stored as "unknown" (it still counts
 * account-wide); a success is what makes its address known for the account.
 */
export async function recordAttempt(subject: string, ip: string | null, succeeded: boolean): Promise<void> {
  const { db } = getDb();
  await db.insert(loginAttempts).values({ subject, ip: ipKey(ip) ?? "unknown", succeeded });
  // Housekeeping, occasionally. Failures are only read for 15 minutes; successes are what
  // make an address "known" for an account, so those are kept for that long.
  if (Math.random() < 0.02) {
    void db
      .delete(loginAttempts)
      .where(sql`(${loginAttempts.succeeded} = false AND ${loginAttempts.createdAt} < now() - interval '1 day') OR ${loginAttempts.createdAt} < now() - ${KNOWN_WINDOW_SQL}`)
      .catch(() => {});
  }
}

/**
 * Lift every lock on the account. Called when a password reset completes: the failures so
 * far were guesses at a password that has just been replaced. Writes a marker with no
 * address (which clears failures from everywhere) and, when the caller's address is usable,
 * a success for it - completing a reset takes control of the mailbox, which is at least as
 * strong a proof as the password, so that address becomes known for the account.
 */
export async function clearLock(subject: string, ip: string | null = null): Promise<void> {
  const { db } = getDb();
  const key = ipKey(ip);
  await db.insert(loginAttempts).values([{ subject, ip: null, succeeded: true }, ...(key ? [{ subject, ip: key, succeeded: true }] : [])]);
}

/**
 * Forget which addresses are "known" for an account, except the one acting now.
 *
 * An address becomes known by signing in with the account's password, and a known address
 * keeps its own private allowance of guesses whatever the rest of the world does. That is
 * right while the credential it proved is still the credential. It is wrong after the
 * credential changes hands: someone who registered a victim's address stayed "known" for the
 * victim's account after the victim claimed it through Google, reset the password or changed
 * it - five guesses every fifteen minutes that no account-wide lock could ever touch.
 *
 * Called when an unverified account is claimed by Google, when a password reset completes and
 * when a password is changed. Reset markers (rows with no address) are kept: they are what
 * clears old failures.
 */
export async function forgetOtherKnownAddresses(subject: string, actorIp: string | null | undefined): Promise<void> {
  const { db } = getDb();
  const actor = ipKey(actorIp);
  await db
    .delete(loginAttempts)
    .where(and(eq(loginAttempts.subject, subject), eq(loginAttempts.succeeded, true), sql`${loginAttempts.ip} IS NOT NULL`, actor ? sql`${loginAttempts.ip} <> ${actor}` : undefined));
}

/**
 * The queue an attempt waits in (see `serialised`). An address known for the account is
 * judged on its own failures, so it queues on its own: a stranger flooding the account's
 * queue cannot make the owner's attempt bounce off a full one. With `perAddress` (the admin
 * sign-in, where every address has its own allowance) every address queues on its own.
 */
export async function attemptQueue(prefix: string, subject: string, ip: string | null | undefined, opts: { perAddress?: boolean } = {}): Promise<string> {
  if (opts.perAddress) return `${prefix}:${subject}|${ipKey(ip) ?? "unknown"}`;
  return (await isKnownIp(subject, ip)) ? `${prefix}:${subject}|${ipKey(ip)}` : `${prefix}:${subject}`;
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
 * Run one sign-in attempt with no other attempt in the same queue running at the same time
 * in this process. The queue is the account for an unknown address and account + address for
 * a known one (`attemptQueue`), matching what each is judged on.
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
