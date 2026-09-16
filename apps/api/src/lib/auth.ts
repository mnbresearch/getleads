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

export async function authenticate(header: string | undefined): Promise<AuthContext | null> {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token) return null;
  const { db } = getDb();
  if (token.startsWith("gl_")) {
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
