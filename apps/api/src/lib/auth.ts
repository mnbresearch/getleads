import bcrypt from "bcryptjs";
import { sign, verify } from "hono/jwt";
import { apiKeys, eq, getDb, organizations, users, type ApiKey, type Organization, type User } from "@prospex/db";
import { env } from "../env.js";
import { randomToken, sha256 } from "./crypto.js";

export interface AuthContext {
  org: Organization;
  user: User | null;
  apiKey: ApiKey | null;
  via: "jwt" | "api_key";
}

export async function hashPassword(p: string) {
  return bcrypt.hash(p, 10);
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
  return `${NO_PASSWORD_PREFIX}${await bcrypt.hash(`${seed}:${randomToken(32)}`, 10)}`;
}

export function hasUsablePassword(hash: string) {
  return !hash.startsWith(NO_PASSWORD_PREFIX);
}

export async function checkPassword(p: string, hash: string) {
  if (!hasUsablePassword(hash)) return false;
  return bcrypt.compare(p, hash);
}

/**
 * Token audiences. Every JWT this API signs says what it is for, and every verifier insists
 * on its own kind. Before this, the three token types (customer session, admin session,
 * Google OAuth `state`) were all "anything signed with JWT_SECRET", told apart only by which
 * fields happened to be present - so a 14-day session token was accepted as an OAuth state.
 */
export type TokenAudience = "session" | "admin" | "oauth_state";

/**
 * Customer session. `tv` is the user's token version at the moment of issue: a password
 * change, a password reset or "sign out everywhere" bumps the stored version, and every
 * token carrying an older one stops working at once.
 */
export async function issueJwt(user: Pick<User, "id" | "orgId"> & { tokenVersion?: number | null }, ttlSeconds = 60 * 60 * 24 * 14) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: user.id, org: user.orgId, tv: user.tokenVersion ?? 0, aud: "session" satisfies TokenAudience, iat: now, exp: now + ttlSeconds }, env.jwtSecret);
}

/** Admin dashboard session - a single shared super-admin account (ADMIN_EMAIL/ADMIN_PASSWORD),
 * not tied to any org or customer user. Separate audience ("admin"), separate shape (role:
 * "admin", no sub/org) and, when ADMIN_JWT_SECRET is set, a separate signing secret, so it can
 * never be confused with a customer JWT even if someone tries to replay one as the other. */
export async function issueAdminJwt(ttlSeconds = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ role: "admin", aud: "admin" satisfies TokenAudience, iat: now, exp: now + ttlSeconds }, env.adminJwtSecret);
}

export async function verifyAdminJwt(token: string): Promise<boolean> {
  try {
    const payload = (await verify(token, env.adminJwtSecret, "HS256")) as { role?: string; aud?: unknown; sub?: unknown };
    if (payload.role !== "admin") return false;
    // Tokens issued before `aud` existed carry none; they live 12 hours at most. Anything
    // that names another audience is refused outright.
    if (payload.aud !== undefined && payload.aud !== "admin") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * A fixed bcrypt hash of a random value, compared against when the account does not exist or
 * has no password. Without it a login for an unknown address returned in ~2ms and a known one
 * in ~100ms, which answers "is this person a customer?" for anyone who asks.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(p: string): Promise<void> {
  dummyHash ??= bcrypt.hash(randomToken(24), 10);
  await bcrypt.compare(p, await dummyHash).catch(() => false);
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

export async function authenticate(header: string | undefined): Promise<AuthContext | null> {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token) return null;
  const { db } = getDb();
  if (looksLikeApiKey(token)) {
    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.keyHash, sha256(token)) });
    if (!key || key.revokedAt) return null;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, key.orgId) });
    if (!org) return null;
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
    return { org, user: null, apiKey: key, via: "api_key" };
  }
  if (scheme.toLowerCase() !== "bearer") return null;
  try {
    const payload = (await verify(token, env.jwtSecret, "HS256")) as { sub?: unknown; org?: unknown; aud?: unknown; tv?: unknown; role?: unknown };
    // Only a session token is a session. A token issued before `aud` existed has none and is
    // treated as a session (so the deploy signs nobody out); one that names any other
    // audience - an admin session, an OAuth state - is not, whatever else it contains.
    if (payload.aud !== undefined && payload.aud !== "session") return null;
    if (payload.role === "admin" || typeof payload.sub !== "string" || !payload.sub) return null;
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
    if (!user) return null;
    // Revocation: the token must carry the user's current token version. A legacy token has
    // none and counts as version 0, so it keeps working until the user's version first moves.
    const tv = payload.tv === undefined ? 0 : payload.tv;
    if (typeof tv !== "number" || tv !== (user.tokenVersion ?? 0)) return null;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, user.orgId) });
    if (!org) return null;
    return { org, user, apiKey: null, via: "jwt" };
  } catch {
    return null;
  }
}

export function generateApiKey() {
  const raw = `px_live_${randomToken(24)}`;
  return { raw, prefix: raw.slice(0, 12), hash: sha256(raw) };
}
