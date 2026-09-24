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
export async function checkPassword(p: string, hash: string) {
  return bcrypt.compare(p, hash);
}

export async function issueJwt(user: User, ttlSeconds = 60 * 60 * 24 * 14) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: user.id, org: user.orgId, iat: now, exp: now + ttlSeconds }, env.jwtSecret);
}

/** Admin dashboard session - a single shared super-admin account (ADMIN_EMAIL/ADMIN_PASSWORD),
 * not tied to any org or customer user. Separate token shape (role: "admin", no sub/org) so it
 * can never be confused with a customer JWT even if someone tries to replay one as the other. */
export async function issueAdminJwt(ttlSeconds = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ role: "admin", iat: now, exp: now + ttlSeconds }, env.jwtSecret);
}

export async function verifyAdminJwt(token: string): Promise<boolean> {
  try {
    const payload = (await verify(token, env.jwtSecret, "HS256")) as { role?: string };
    return payload.role === "admin";
  } catch {
    return false;
  }
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
    const payload = (await verify(token, env.jwtSecret, "HS256")) as { sub: string; org: string };
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
    if (!user) return null;
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
