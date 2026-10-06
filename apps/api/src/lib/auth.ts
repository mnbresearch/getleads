import bcrypt from "bcryptjs";
import { sign, verify } from "hono/jwt";
import { apiKeys, eq, getDb, organizations, sql, users, type ApiKey, type Organization, type User } from "@prospex/db";
import { env } from "../env.js";
import { ApiError, isClientDataError, isDatabaseUnavailable, logDatabaseUnavailable, temporarilyUnavailable } from "./errors.js";
import { randomToken, sha256 } from "./crypto.js";
import { bcryptOnWorker, PasswordWorkerUnavailable, passwordWorkerStats, type BcryptTask } from "./passwordWorkers.js";

/**
 * bcrypt gate: a small cap on how many password hashes/compares run at once, with a bounded
 * wait for a slot.
 *
 * bcryptjs is pure JavaScript on the one event loop. Its async form yields between rounds, so
 * a few in flight interleave with everything else - but nothing limited how many ran at once,
 * so a burst of sign-ins (or wrong-password attempts, each of which still costs one compare
 * to avoid leaking whether the account exists) pinned the loop and slowed every unrelated
 * request, the health check included. The cap keeps the loop responsive; the bounded wait
 * turns an overload into a quick, honest "busy, try again" (503) instead of an ever-growing
 * pile of pending hashes.
 *
 * The hashes themselves are unchanged bcrypt - every existing stored hash still verifies.
 *
 * The rounds themselves now run on worker threads (lib/passwordWorkers.ts), one
 * worker per slot of this gate, so they no longer take time from the thread that answers
 * every other request. The gate, the bounded wait and the "busy" answer are unchanged. If a
 * worker cannot be used, the task is done here on the main thread exactly as before.
 */
const HASH_CONCURRENCY = (() => {
  const n = Number(process.env.PASSWORD_HASH_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 2;
})();
const HASH_MAX_WAITERS = 200;
// 30 seconds: a small instance hashes a few passwords a second, and at about nine
// simultaneous sign-ins an 8-second wait was already answering "busy" to people who would
// have been served a moment later. Waiting is the better answer; the cap on waiters above
// is what keeps a flood from piling up.
const HASH_WAIT_MS = 30_000;
let hashActive = 0;
const hashWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }> = [];

export const PASSWORD_SERVICE_BUSY = "The service is busy right now. Wait a moment and try again.";
const busyError = () => new ApiError(503, PASSWORD_SERVICE_BUSY, "server_busy");

function releaseHashSlot() {
  const next = hashWaiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    hashActive--;
  }
}

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashActive < HASH_CONCURRENCY) {
    hashActive++;
  } else {
    if (hashWaiters.length >= HASH_MAX_WAITERS) throw busyError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = hashWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) hashWaiters.splice(i, 1);
        reject(busyError());
      }, HASH_WAIT_MS);
      if (typeof timer.unref === "function") timer.unref();
      hashWaiters.push({ resolve, reject, timer });
    });
    // granted a slot handed over by releaseHashSlot (hashActive was not decremented)
  }
  try {
    return await fn();
  } finally {
    releaseHashSlot();
  }
}

/**
 * One bcrypt task inside a gate slot: on a worker thread when the pool can take it, on the
 * main thread (the async form, which yields between rounds) when it cannot. A bcrypt error
 * about the input itself is passed on unchanged either way.
 */
async function runBcrypt(task: BcryptTask): Promise<string | boolean> {
  try {
    return await bcryptOnWorker(task, HASH_CONCURRENCY);
  } catch (e) {
    if (!(e instanceof PasswordWorkerUnavailable)) throw e;
    passwordWorkerStats.fallbacks++;
    return task.op === "hash" ? bcrypt.hash(task.password, task.rounds) : bcrypt.compare(task.password, task.hash);
  }
}

const bcryptHash = (password: string, rounds = 10) => withHashSlot(() => runBcrypt({ op: "hash", password, rounds }) as Promise<string>);
const bcryptCompare = (password: string, hash: string) => withHashSlot(() => runBcrypt({ op: "compare", password, hash }) as Promise<boolean>);

export interface AuthContext {
  org: Organization;
  user: User | null;
  apiKey: ApiKey | null;
  via: "jwt" | "api_key";
}

export async function hashPassword(p: string) {
  // Gated so a burst cannot pile up; the rounds run on a worker thread (see runBcrypt).
  return bcryptHash(p, 10);
}

/**
 * Prefix on the password hash of an account that has never chosen a password (created by
 * "Sign in with Google"). Never a valid bcrypt hash, so it can never match a password; it
 * lets password change know there is no current password to ask for. Accounts created by
 * Google before this marker existed hold a random bcrypt hash instead - they set one
 * through "forgot password", which works for every account.
 */
export const NO_PASSWORD_PREFIX = "!nopassword:";

export async function unusablePasswordHash(seed: string) {
  return `${NO_PASSWORD_PREFIX}${await bcryptHash(`${seed}:${randomToken(32)}`, 10)}`;
}

export function hasUsablePassword(hash: string) {
  return !hash.startsWith(NO_PASSWORD_PREFIX);
}

export async function checkPassword(p: string, hash: string) {
  if (!hasUsablePassword(hash)) return false;
  return bcryptCompare(p, hash);
}

/**
 * Token audiences. Every JWT this API signs says what it is for, and every verifier insists
 * on its own kind. Before this, the three token types (customer session, admin session,
 * Google OAuth `state`) were all "anything signed with JWT_SECRET", told apart only by which
 * fields happened to be present - so a 14-day session token was accepted as an OAuth state.
 */
export type TokenAudience = "session" | "admin" | "oauth_state" | "2fa";

/** How long a customer session lasts, and the oldest a session token may ever be. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

/**
 * Customer session. `tv` is the user's token version at the moment of issue: a password
 * change, a password reset or "sign out everywhere" bumps the stored version, and every
 * token carrying an older one stops working at once.
 */
export async function issueJwt(user: Pick<User, "id" | "orgId"> & { tokenVersion?: number | null }, ttlSeconds = SESSION_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: user.id, org: user.orgId, tv: user.tokenVersion ?? 0, aud: "session" satisfies TokenAudience, iat: now, exp: now + ttlSeconds }, env.jwtSecret);
}

/** How long the second step of a two-factor sign-in may take. */
export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * The token handed back by a sign-in whose password was right but whose account also needs a
 * code. It says "this person passed the password step" and nothing else: its audience is
 * "2fa", so authenticate() refuses it as a session, and it is only accepted by
 * POST /v1/auth/2fa/verify together with a valid code.
 *
 * It carries the user's token version, like a session does: a password reset or "sign out
 * everywhere" made in the meantime kills an outstanding challenge too.
 */
export async function issueTwoFactorChallenge(user: Pick<User, "id"> & { tokenVersion?: number | null }, ttlSeconds = TWO_FACTOR_CHALLENGE_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: user.id, tv: user.tokenVersion ?? 0, aud: "2fa" satisfies TokenAudience, jti: randomToken(12), iat: now, exp: now + ttlSeconds }, env.jwtSecret);
}

/** The user id and token version of a valid, unexpired two-factor challenge, or null. */
export async function readTwoFactorChallenge(token: unknown): Promise<{ userId: string; tokenVersion: number } | null> {
  if (typeof token !== "string" || !token || token.length > 2000) return null;
  try {
    const p = (await verify(token, env.jwtSecret, "HS256")) as { sub?: unknown; tv?: unknown; aud?: unknown };
    // Strict: a session token (aud "session", or a legacy one with no audience) is not a challenge.
    if (p.aud !== "2fa") return null;
    if (typeof p.sub !== "string" || !p.sub || typeof p.tv !== "number") return null;
    return { userId: p.sub, tokenVersion: p.tv };
  } catch {
    return null;
  }
}

/** Admin dashboard session - a single shared super-admin account (ADMIN_EMAIL/ADMIN_PASSWORD),
 * not tied to any org or customer user. Separate audience ("admin"), separate shape (role:
 * "admin", no sub/org) and, when ADMIN_JWT_SECRET is set, a separate signing secret, so it can
 * never be confused with a customer JWT even if someone tries to replay one as the other.
 *
 * `jti` is the token's own id: POST /v1/admin/logout records it as revoked, and the token
 * stops working then rather than twelve hours later. */
export async function issueAdminJwt(ttlSeconds = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ role: "admin", aud: "admin" satisfies TokenAudience, jti: randomToken(16), iat: now, exp: now + ttlSeconds }, env.adminJwtSecret);
}

interface AdminClaims {
  /** What a revocation is recorded under: the token's jti, or a hash of the token itself for one issued before jti existed. */
  revocationKey: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** The claims of a well-formed, unexpired admin token (revoked or not), or null. */
async function readAdminJwt(token: string): Promise<AdminClaims | null> {
  try {
    const payload = (await verify(token, env.adminJwtSecret, "HS256")) as { role?: string; aud?: unknown; sub?: unknown; jti?: unknown; exp?: unknown };
    if (payload.role !== "admin") return null;
    // Tokens issued before `aud` existed carry none; they live 12 hours at most. Anything
    // that names another audience is refused outright.
    if (payload.aud !== undefined && payload.aud !== "admin") return null;
    const exp = typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 60 * 60 * 12;
    // A token from before this release has no jti. It stays valid until it expires (the
    // deploy signs nobody out) and can still be signed out: it is revoked by its own hash.
    const revocationKey = typeof payload.jti === "string" && payload.jti ? `jti:${payload.jti.slice(0, 200)}` : `tok:${sha256(token)}`;
    return { revocationKey, exp };
  } catch {
    return null;
  }
}

/** Postgres "relation does not exist": the release migration that creates the table has not run. */
function isMissingTable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}
let warnedMissingTable = false;

/**
 * Is this a valid admin session token that has not been signed out?
 *
 * A database error here is thrown, not swallowed: answering "not valid" would sign the
 * operator out of the dashboard on a connection blip, and answering "valid" would let a
 * revoked token through. The one exception is the revocation table not existing yet (a
 * deploy with AUTO_MIGRATE=false that has not been migrated): no token can have been revoked
 * without the table, so the session is honoured and the gap is logged.
 */
export async function verifyAdminJwt(token: string): Promise<boolean> {
  const claims = await readAdminJwt(token);
  if (!claims) return false;
  const { db } = getDb();
  try {
    const rows = (await db.execute(sql`SELECT 1 AS revoked FROM admin_revoked_tokens WHERE jti = ${claims.revocationKey} LIMIT 1`)) as unknown as unknown[];
    return rows.length === 0;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    if (!warnedMissingTable) console.warn("[auth] admin_revoked_tokens does not exist yet (run the database migrations); admin sign-out cannot revoke sessions until it does.");
    warnedMissingTable = true;
    return true;
  }
}

/**
 * Sign an admin session out: the token is refused from now on, on every instance.
 *
 * "invalid" when the token is not a valid admin token (nothing to revoke); "unavailable" when
 * the revocation table does not exist yet. The row only has to outlive the token, so rows for
 * tokens that have expired anyway are removed here.
 */
export async function revokeAdminJwt(token: string): Promise<"revoked" | "invalid" | "unavailable"> {
  const claims = await readAdminJwt(token);
  if (!claims) return "invalid";
  const { db } = getDb();
  try {
    await db.execute(sql`INSERT INTO admin_revoked_tokens (jti, expires_at) VALUES (${claims.revocationKey}, to_timestamp(${claims.exp})) ON CONFLICT (jti) DO NOTHING`);
  } catch (e) {
    if (isMissingTable(e)) return "unavailable";
    throw e;
  }
  await db.execute(sql`DELETE FROM admin_revoked_tokens WHERE expires_at < now() - interval '1 hour'`).catch(() => {});
  return "revoked";
}

/**
 * Claim a time step of the ADMIN authenticator code, so the code that was just accepted
 * cannot be used again (by someone who saw it typed, or took it from a proxy log).
 *
 * There is no user row to keep "the last step" on - the admin account lives in the
 * environment - so the claim is a row in admin_revoked_tokens under `totp:<step>`, which the
 * session check never looks up (its keys start with `jti:` or `tok:`). Being in the database
 * it holds across restarts and instances. A step at or below one already claimed is refused.
 * If that table does not exist yet (migrations not run), the claim falls back to this
 * process's memory.
 */
let adminTotpLastStep = -1;
export async function claimAdminTotpStep(step: number): Promise<boolean> {
  if (!Number.isInteger(step) || step <= adminTotpLastStep) return false;
  const { db } = getDb();
  try {
    const rows = (await db.execute(sql`
      INSERT INTO admin_revoked_tokens (jti, expires_at)
      SELECT ${`totp:${step}`}, now() + interval '10 minutes'
      WHERE NOT EXISTS (
        SELECT 1 FROM admin_revoked_tokens WHERE jti LIKE 'totp:%' AND substring(jti from 6)::bigint >= ${step}
      )
      ON CONFLICT (jti) DO NOTHING
      RETURNING jti`)) as unknown as unknown[];
    if (rows.length === 0) return false;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  adminTotpLastStep = step;
  return true;
}

/**
 * A fixed bcrypt hash of a random value, compared against when the account does not exist or
 * has no password. Without it a login for an unknown address returned in ~2ms and a known one
 * in ~100ms, which answers "is this person a customer?" for anyone who asks.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(p: string): Promise<void> {
  // Made once, through the same gate and workers as every other hash. If that one attempt
  // fails (busy), it is forgotten so the next call makes it again.
  dummyHash ??= bcryptHash(randomToken(24), 10).catch((e) => {
    dummyHash = null;
    throw e;
  });
  try {
    const h = await dummyHash;
    await bcryptCompare(p, h);
  } catch {
    /* the result is never used; only the time spent matters */
  }
}

/** bcrypt reads at most 72 bytes; anything after that is silently ignored. */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

const TRIVIAL_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890", "87654321", "0987654321",
  "qwertyui", "qwertyuiop", "qwerty123", "qwerty1234", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "abcdefgh", "abcd1234", "abc12345", "iloveyou", "letmein1", "letmein123",
  "welcome1", "welcome123", "admin123", "admin1234", "changeme", "changeme1", "football", "baseball", "sunshine", "princess", "starwars", "trustno1", "11111111", "00000000",
]);

/**
 * Why a NEW password is not acceptable, or null when it is. Applied where a password is
 * chosen (signup, reset, change, invite) - never at login, so nobody is locked out of an
 * account by a rule that did not exist when they picked their password.
 *
 * The length floor stays at 8 (the web forms say 8). What this adds are the cases the floor
 * let through: eight spaces, "aaaaaaaa", "12345678", the account's own email address, and
 * anything past 72 bytes, which bcrypt truncates - two different long passwords with the same
 * first 72 bytes were the same password.
 */
export function passwordProblem(password: string, opts: { email?: string | null; name?: string | null } = {}): string | null {
  if (typeof password !== "string") return "Enter a password.";
  if (password.includes("\u0000")) return "The password contains a character that cannot be used.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `That password is too long. Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} plain characters).`;
  if (password.trim().length === 0) return "A password cannot be only spaces.";
  if (new Set(password).size < 3) return "That password is too easy to guess. Use a mix of different characters.";
  const lower = password.toLowerCase();
  if (TRIVIAL_PASSWORDS.has(lower) || TRIVIAL_PASSWORDS.has(lower.trim())) return "That password is one of the most commonly used. Choose something less guessable.";
  const email = opts.email?.toLowerCase().trim();
  if (email && (lower === email || lower === email.split("@")[0])) return "A password cannot be your email address.";
  return null;
}

/**
 * Every prefix an API key has ever been issued under.
 *
 * `generateApiKey` produced `gl_...` originally and `px_live_...` after the rebrand, but
 * this check was never updated, so from the rebrand onward EVERY key the product issued was
 * rejected: the key shown once at signup, every key created in Settings, and with them the
 * SDK and the MCP server, which have no other way to authenticate. The 401 even told people
 * to send a `gl_` key, which the product no longer hands out.
 *
 * A key is matched by its hash, so accepting several prefixes costs nothing and keeps every
 * key ever issued working. New prefixes get added here, not swapped in.
 */
const API_KEY_PREFIXES = ["px_live_", "px_test_", "gl_"];

export function looksLikeApiKey(token: string): boolean {
  return API_KEY_PREFIXES.some((p) => token.startsWith(p));
}

/**
 * Who is this request from? `null` means "nobody we recognise" (the caller answers 401).
 *
 * Only the CREDENTIAL can make this null: a token that does not verify, has expired, is of
 * the wrong kind or was revoked; an API key that does not exist or was revoked. A database
 * that cannot be asked is not an answer about the credential - it used to be reported as
 * one (every database error was swallowed here), so during an outage a valid session got a
 * 401 and the web app signed the person out. Now that case is a 503 that says to try again.
 */
export async function authenticate(header: string | undefined): Promise<AuthContext | null> {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token) return null;
  const { db } = getDb();
  /**
   * Run the database part. Three different failures, three different answers:
   *  - a value the token supplied that the database cannot use: still "not recognised" (401);
   *  - the database cannot be reached: "try again in a minute" (503);
   *  - anything else - a bug, a column that is not there - is a fault and is rethrown as one
   *    (500, logged with its detail). It used to be reported as "temporarily unavailable"
   *    too, so a broken deploy looked like an outage that would pass by itself.
   */
  const ask = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (isClientDataError(e)) return null;
      if (isDatabaseUnavailable(e)) {
        logDatabaseUnavailable("checking a session or API key", e);
        throw temporarilyUnavailable();
      }
      throw e;
    }
  };
  if (looksLikeApiKey(token)) {
    return ask(async () => {
      const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.keyHash, sha256(token)) });
      if (!key || key.revokedAt) return null;
      const org = await db.query.organizations.findFirst({ where: eq(organizations.id, key.orgId) });
      if (!org) return null;
      void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
      return { org, user: null, apiKey: key, via: "api_key" } satisfies AuthContext;
    });
  }
  if (scheme.toLowerCase() !== "bearer") return null;
  let payload: { sub?: unknown; org?: unknown; aud?: unknown; tv?: unknown; role?: unknown; iat?: unknown };
  try {
    payload = (await verify(token, env.jwtSecret, "HS256")) as typeof payload;
  } catch {
    // Bad signature, expired, not a token at all.
    return null;
  }
  // Only a session token is a session. A token issued before `aud` existed has none and is
  // treated as a session (so the deploy signs nobody out); one that names any other
  // audience - an admin session, an OAuth state, a two-factor challenge - is not, whatever
  // else it contains.
  if (payload.aud !== undefined && payload.aud !== "session") return null;
  if (payload.role === "admin" || typeof payload.sub !== "string" || !payload.sub) return null;
  // An absolute cap on a session's age, whatever its `exp` says: nothing signed with this
  // secret is a session for longer than a session is issued for. (Every token this API has
  // issued carries `iat`; one without it is judged on `exp` alone, as before.)
  if (sessionTooOld(payload.iat)) return null;
  const sub = payload.sub;
  return ask(async () => {
    const user = await db.query.users.findFirst({ where: eq(users.id, sub) });
    if (!user) return null;
    // Revocation: the token must carry the user's current token version. A legacy token has
    // none and counts as version 0, so it keeps working until the user's version first moves.
    const tv = payload.tv === undefined ? 0 : payload.tv;
    if (typeof tv !== "number" || tv !== (user.tokenVersion ?? 0)) return null;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, user.orgId) });
    if (!org) return null;
    return { org, user, apiKey: null, via: "jwt" } satisfies AuthContext;
  });
}

/**
 * Is `code` a valid second factor for this user right now (an authenticator code that has
 * not been used, or an unused recovery code)? The code is spent when it is. False when
 * two-factor is not on for the user. After five wrong codes in fifteen minutes this throws
 * 429 `too_many_attempts` rather than answering.
 *
 * The rules live in lib/twoFactor.ts; this is the same function, reachable from here for
 * callers that already import the sign-in helpers. Loaded on first use: twoFactor.ts depends
 * on the request helpers, which depend on this file.
 */
export async function verifySecondFactor(user: User, code: string, opts: { ip?: string | null; during?: string } = {}): Promise<boolean> {
  const m = await import("./twoFactor.js");
  return m.verifySecondFactor(user, code, opts);
}

/** Is a token issued at `iat` (seconds since the epoch) past the longest a session may live? */
export function sessionTooOld(iat: unknown, nowMs: number = Date.now()): boolean {
  if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
  // A minute of slack for clocks; the token's own `exp` is still checked by the verifier.
  return nowMs / 1000 - iat > SESSION_TTL_SECONDS + 60;
}

// ── API key scopes ──

export type ApiKeyScope = "full" | "read";

/** What is stored in api_keys.scopes for each scope. Keys created before scopes exist hold ["*"]. */
export function scopesFor(scope: ApiKeyScope): string[] {
  return scope === "read" ? ["read"] : ["*"];
}

/**
 * The scope of a stored key. Only "*" is full access; anything else - including a value
 * this code does not know - is read-only, so an unrecognised scope can never widen a key.
 */
export function apiKeyScope(key: Pick<ApiKey, "scopes">): ApiKeyScope {
  return Array.isArray(key.scopes) && key.scopes.includes("*") ? "full" : "read";
}

/** Methods that only read. A read-only key may use these and nothing else. */
const READ_METHODS = new Set(["GET", "HEAD"]);

/** May this caller make a request with this method? Sessions and full keys: always. */
export function scopeAllows(auth: AuthContext, method: string): boolean {
  if (auth.via !== "api_key" || !auth.apiKey) return true;
  return apiKeyScope(auth.apiKey) === "full" || READ_METHODS.has(method.toUpperCase());
}

export function generateApiKey() {
  const raw = `px_live_${randomToken(24)}`;
  return { raw, prefix: raw.slice(0, 12), hash: sha256(raw) };
}
