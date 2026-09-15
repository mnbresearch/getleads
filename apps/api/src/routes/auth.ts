import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, apiKeys, desc, eq, getDb, limitsFor, organizations, users } from "@prospex/db";
import { env } from "../env.js";
import { checkPassword, generateApiKey, hashPassword, issueJwt } from "../lib/auth.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { rateLimit, requireAuth, requireUser, type Env } from "../middleware.js";
import { emitEvent } from "../lib/events.js";

export const authRoutes = new Hono<Env>();

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

authRoutes.post(
  "/signup",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1).max(80).optional(), orgName: z.string().min(1).max(80).optional(), inviteCode: z.string().optional() })),
  async (c) => {
    const body = c.req.valid("json");
    if (env.pilotInviteCode && body.inviteCode !== env.pilotInviteCode) throw new ApiError(403, "Invalid invite code", "invalid_invite");
    const { db } = getDb();
    const exists = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
    if (exists) throw badRequest("Email already registered");
    const orgName = body.orgName ?? `${body.name ?? body.email.split("@")[0]}'s workspace`;
    let slug = slugify(orgName);
    if (await db.query.organizations.findFirst({ where: eq(organizations.slug, slug) })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const plan = env.defaultPlan;
    const [org] = await db.insert(organizations).values({ name: orgName, slug, plan, planLimits: limitsFor(plan) }).returning();
    const [user] = await db.insert(users).values({ orgId: org.id, email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password), name: body.name ?? "", role: "owner", lastLoginAt: new Date() }).returning();
    const key = generateApiKey();
    await db.insert(apiKeys).values({ orgId: org.id, name: "Default", prefix: key.prefix, keyHash: key.hash });
    await emitEvent(org.id, "org.created", { orgId: org.id, email: user.email });
    return c.json({ token: await issueJwt(user), user: publicUser(user), org: publicOrg(org), apiKey: key.raw }, 201);
  },
);

authRoutes.post("/login", rateLimit({ perMinute: 20 }), zValidator("json", z.object({ email: z.string().email(), password: z.string() })), async (c) => {
  const { email, password } = c.req.valid("json");
  const { db } = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  if (!user || !(await checkPassword(password, user.passwordHash))) throw new ApiError(401, "Invalid email or password", "invalid_credentials");
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, user.orgId) });
  return c.json({ token: await issueJwt(user), user: publicUser(user), org: publicOrg(org!) });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const a = c.get("auth");
  return c.json({ user: a.user ? publicUser(a.user) : null, org: publicOrg(a.org), via: a.via, apiKey: a.apiKey ? { id: a.apiKey.id, name: a.apiKey.name, prefix: a.apiKey.prefix } : null });
});

authRoutes.patch("/org", requireAuth, requireUser, zValidator("json", z.object({ name: z.string().min(1).max(80).optional(), settings: z.record(z.unknown()).optional() })), async (c) => {
  const a = c.get("auth");
  const body = c.req.valid("json");
  const { db } = getDb();
  const [org] = await db
    .update(organizations)
    .set({ ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: { ...a.org.settings, ...body.settings } } : {}) })
    .where(eq(organizations.id, a.org.id))
    .returning();
  return c.json({ org: publicOrg(org) });
});

// ── API keys ──
authRoutes.get("/api-keys", requireAuth, requireUser, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, c.get("auth").org.id)).orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt })) });
});

authRoutes.post("/api-keys", requireAuth, requireUser, zValidator("json", z.object({ name: z.string().min(1).max(60) })), async (c) => {
  const { db } = getDb();
  const key = generateApiKey();
  const [row] = await db.insert(apiKeys).values({ orgId: c.get("auth").org.id, name: c.req.valid("json").name, prefix: key.prefix, keyHash: key.hash }).returning();
  return c.json({ id: row.id, name: row.name, prefix: row.prefix, key: key.raw, note: "Store this key now; it is not shown again." }, 201);
});

authRoutes.delete("/api-keys/:id", requireAuth, requireUser, async (c) => {
  const { db } = getDb();
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.orgId, c.get("auth").org.id)));
  return c.json({ ok: true });
});

export function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt };
}
export function publicOrg(o: typeof organizations.$inferSelect) {
  return { id: o.id, name: o.name, slug: o.slug, plan: o.plan, limits: { ...limitsFor(o.plan), ...o.planLimits }, settings: o.settings, createdAt: o.createdAt };
}
