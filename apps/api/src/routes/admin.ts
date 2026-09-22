import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, currentPeriod, desc, eq, getDb, getToolsSummary, ilike, inArray, limitsFor, or, organizations, PLANS, recordProviderHealth, sql, updateToolLimit, upgradeRequests, usage, users } from "@prospex/db";
import { checkAllProviders } from "@prospex/core";
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

  // Plain Drizzle query-builder calls only (no raw sql subqueries) - this is the style proven
  // reliable elsewhere in this file (see GET /orgs/:id). Fetch orgs, then fetch users + usage for
  // those org ids in two more queries, then merge in JS.
  const like = q ? `%${q}%` : null;
  const allOrgs = await db
    .select()
    .from(organizations)
    .where(
      like
        ? or(
            ilike(organizations.name, like),
            ilike(organizations.slug, like),
            inArray(
              organizations.id,
              db.select({ id: users.orgId }).from(users).where(ilike(users.email, like)),
            ),
          )
        : undefined,
    )
    .orderBy(desc(organizations.createdAt))
    .limit(1000);

  const orgIds = allOrgs.map((o) => o.id);

  const allUsers = orgIds.length
    ? await db
        .select({ id: users.id, orgId: users.orgId, email: users.email, name: users.name, createdAt: users.createdAt })
        .from(users)
        .where(inArray(users.orgId, orgIds))
    : [];

  const allUsage = orgIds.length
    ? await db
        .select()
        .from(usage)
        .where(and(inArray(usage.orgId, orgIds), eq(usage.period, period)))
    : [];

  const usersByOrg = new Map<string, typeof allUsers>();
  for (const u of allUsers) {
    const list = usersByOrg.get(u.orgId) ?? [];
    list.push(u);
    usersByOrg.set(u.orgId, list);
  }
  const usageByOrg = new Map<string, typeof allUsage>();
  for (const row of allUsage) {
    const list = usageByOrg.get(row.orgId) ?? [];
    list.push(row);
    usageByOrg.set(row.orgId, list);
  }

  const orgs = allOrgs.map((o) => {
    const orgUsers = (usersByOrg.get(o.id) ?? []).slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const orgUsage = usageByOrg.get(o.id) ?? [];
    const owner = orgUsers[0];
    const leadsUsed = orgUsage.find((r) => r.metric === "leads")?.count ?? 0;
    const premiumLeadsUsed = orgUsage.find((r) => r.metric === "premiumLeads")?.count ?? 0;
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      plan: o.plan,
      status: o.status,
      createdAt: o.createdAt,
      leadsUsed,
      premiumLeadsUsed,
      userCount: orgUsers.length,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
      limits: { ...limitsFor(o.plan), ...(o.planLimits ?? {}) },
    };
  });

  return c.json({ orgs });
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

// ── Tools & limits: every 3rd-party API Scout calls, its free-tier limit, and current usage,
// so the admin knows exactly which tool to upgrade before a free tier runs out. ──
adminRoutes.get("/tools", async (c) => {
  const tools = await getToolsSummary();
  return c.json({ tools });
});

/**
 * Test the configured keys for real.
 *
 * "Configured" has only ever meant the env var is non-empty, which is why a wrong key could
 * sit in production looking healthy. This makes one cheap call per provider and records the
 * result, so the page stops guessing. Rate limited because each run spends real quota on
 * providers whose free tiers are measured in tens of calls a month.
 */
adminRoutes.post("/tools/check", rateLimit({ perMinute: 3 }), async (c) => {
  const results = await checkAllProviders();
  await Promise.all(
    results
      .filter((r) => r.configured)
      .map((r) =>
        recordProviderHealth({ provider: r.provider, outcome: r.outcome, status: r.status, detail: r.detail }).catch(() => {}),
      ),
  );
  const broken = results.filter((r) => r.configured && !r.ok);
  return c.json({
    results,
    checkedAt: new Date().toISOString(),
    summary: broken.length === 0
      ? `All ${results.filter((r) => r.configured).length} configured providers responded successfully.`
      : `${broken.length} of ${results.filter((r) => r.configured).length} configured providers did not: ${broken.map((b) => `${b.provider} (${b.outcome})`).join(", ")}.`,
  });
});

const TOOL_LIMIT_SCHEMA = z.object({
  usageLimit: z.number().int().min(0).nullable().optional(),
  period: z.enum(["day", "month"]).optional(),
  alertThresholdPct: z.number().int().min(1).max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

adminRoutes.patch("/tools/:provider", zValidator("json", TOOL_LIMIT_SCHEMA), async (c) => {
  const patch = c.req.valid("json");
  const updated = await updateToolLimit(c.req.param("provider"), patch);
  if (!updated) throw notFound("Tool");
  return c.json(updated);
});
