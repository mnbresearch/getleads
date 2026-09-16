import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, currentPeriod, desc, eq, getDb, limitsFor, organizations, PLANS, sql, upgradeRequests, usage, users } from "@prospex/db";
import { env } from "../env.js";
import { issueAdminJwt } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { rateLimit, requireAdmin, type Env } from "../middleware.js";

export const adminRoutes = new Hono<Env>();

// ── Admin login (single shared super-admin account, ADMIN_EMAIL / ADMIN_PASSWORD) ──
adminRoutes.post(
  "/login",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().email(), password: z.string().min(1) })),
  async (c) => {
    const { email, password } = c.req.valid("json");
    if (!env.adminEmail || !env.adminPassword) throw badRequest("Admin login is not configured (set ADMIN_EMAIL and ADMIN_PASSWORD)");
    if (email.toLowerCase() !== env.adminEmail || password !== env.adminPassword) throw badRequest("Invalid admin credentials");
    return c.json({ token: await issueAdminJwt() });
  },
);

adminRoutes.use("*", requireAdmin);

adminRoutes.get("/session", (c) => c.json({ ok: true }));

// ── Orgs / customers ──
adminRoutes.get("/orgs", zValidator("query", z.object({ q: z.string().optional() })), async (c) => {
  const { q } = c.req.valid("query");
  const { db } = getDb();
  const period = currentPeriod();
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
      planLimits: organizations.planLimits,
      status: organizations.status,
      createdAt: organizations.createdAt,
      leadsUsed: sql<number>`coalesce((SELECT count::int FROM usage WHERE org_id = ${organizations.id} AND period = ${period} AND metric = 'leads'), 0)`,
      premiumLeadsUsed: sql<number>`coalesce((SELECT count::int FROM usage WHERE org_id = ${organizations.id} AND period = ${period} AND metric = 'premiumLeads'), 0)`,
      userCount: sql<number>`(SELECT count(*)::int FROM users WHERE org_id = ${organizations.id})`,
      ownerEmail: sql<string | null>`(SELECT email FROM users WHERE org_id = ${organizations.id} ORDER BY created_at ASC LIMIT 1)`,
      ownerName: sql<string | null>`(SELECT name FROM users WHERE org_id = ${organizations.id} ORDER BY created_at ASC LIMIT 1)`,
    })
    .from(organizations)
    .where(q ? sql`(${organizations.name} ilike ${"%" + q + "%"} OR ${organizations.slug} ilike ${"%" + q + "%"} OR exists (select 1 from users where org_id = ${organizations.id} and email ilike ${"%" + q + "%"}))` : sql`true`)
    .orderBy(desc(organizations.createdAt))
    .limit(1000);
  return c.json({ orgs: rows.map((r) => ({ ...r, limits: { ...limitsFor(r.plan), ...(r.planLimits ?? {}) } })) });
});

adminRoutes.get("/orgs/:id", async (c) => {
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!org) throw notFound("Org");
  const orgUsers = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt }).from(users).where(eq(users.orgId, org.id));
  const period = currentPeriod();
  const usageRows = await db.select().from(usage).where(and(eq(usage.orgId, org.id), eq(usage.period, period)));
  return c.json({
    org: { ...org, limits: { ...limitsFor(org.plan), ...(org.planLimits ?? {}) } },
    users: orgUsers,
    usage: Object.fromEntries(usageRows.map((r) => [r.metric, r.count])),
    period,
  });
});

const PLAN_SCHEMA = z.object({ plan: z.string(), overrides: z.record(z.unknown()).optional() });
adminRoutes.patch("/orgs/:id/plan", zValidator("json", PLAN_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  if (!PLANS[b.plan]) throw badRequest(`Unknown plan "${b.plan}". Valid plans: ${Object.keys(PLANS).join(", ")}`);
  const { db } = getDb();
  const [row] = await db
    .update(organizations)
    .set({ plan: b.plan, planLimits: { ...limitsFor(b.plan), ...(b.overrides ?? {}) } })
    .where(eq(organizations.id, c.req.param("id")))
    .returning();
  if (!row) throw notFound("Org");
  return c.json({ id: row.id, plan: row.plan, limits: row.planLimits });
});

const STATUS_SCHEMA = z.object({ status: z.enum(["active", "deactivated", "revoked"]) });
adminRoutes.patch("/orgs/:id/status", zValidator("json", STATUS_SCHEMA), async (c) => {
  const { db } = getDb();
  const [row] = await db.update(organizations).set({ status: c.req.valid("json").status }).where(eq(organizations.id, c.req.param("id"))).returning();
  if (!row) throw notFound("Org");
  return c.json({ id: row.id, status: row.status });
});

/** Manually grant/set an org's usage for the current billing period - this is "credits" in
 * this product: there's no separate wallet, usage vs. plan limit IS the credit balance, so
 * granting credits means giving the org more room against that limit for this period. */
const CREDITS_SCHEMA = z.object({
  metric: z.enum(["leads", "premiumLeads", "searches", "verifications", "aiMessages", "emails"]),
  action: z.enum(["grant", "set"]),
  amount: z.number().int(),
});
adminRoutes.patch("/orgs/:id/credits", zValidator("json", CREDITS_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  const orgIdParam = c.req.param("id");
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgIdParam) });
  if (!org) throw notFound("Org");
  const period = currentPeriod();
  const existing = await db.query.usage.findFirst({ where: and(eq(usage.orgId, orgIdParam), eq(usage.period, period), eq(usage.metric, b.metric)) });
  const currentCount = existing?.count ?? 0;
  // "grant" gives the org more room by lowering how much of their quota looks used;
  // "set" pins the used-count to an exact value (e.g. reset to 0 for a fresh grant).
  const nextCount = Math.max(0, b.action === "grant" ? currentCount - b.amount : b.amount);
  const [row] = await db
    .insert(usage)
    .values({ orgId: orgIdParam, period, metric: b.metric, count: nextCount })
    .onConflictDoUpdate({ target: [usage.orgId, usage.period, usage.metric], set: { count: nextCount } })
    .returning();
  return c.json({ metric: row.metric, period: row.period, used: row.count });
});

// ── Plans reference (read-only - prices/limits live in code, see packages/db/src/plans.ts) ──
adminRoutes.get("/plans", (c) => c.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })) }));

// ── Upgrade-request leads captured from the pricing page ──
adminRoutes.get("/upgrade-requests", zValidator("query", z.object({ status: z.string().optional() })), async (c) => {
  const { status } = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select()
    .from(upgradeRequests)
    .where(status ? eq(upgradeRequests.status, status) : sql`true`)
    .orderBy(desc(upgradeRequests.createdAt))
    .limit(1000);
  return c.json({ requests: rows });
});

adminRoutes.patch("/upgrade-requests/:id", zValidator("json", z.object({ status: z.enum(["new", "contacted", "converted", "dismissed"]) })), async (c) => {
  const { db } = getDb();
  const [row] = await db.update(upgradeRequests).set({ status: c.req.valid("json").status }).where(eq(upgradeRequests.id, c.req.param("id"))).returning();
  if (!row) throw notFound("Upgrade request");
  return c.json(row);
});
