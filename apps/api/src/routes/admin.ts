import { Hono, type Context } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, currentPeriod, desc, eq, getDb, getToolsSummary, ilike, inArray, limitsFor, or, organizations, PLANS, recordProviderHealth, sql, updateToolLimit, upgradeRequests, usage, users } from "@prospex/db";
import { checkAllBalances, checkAllProviders } from "@prospex/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { issueAdminJwt } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { clientIp, rateLimit, requireAdmin, type Env } from "../middleware.js";
import { audit } from "../lib/audit.js";
import { lockedError, lockState, recordAttempt, serialised, shouldAuditLock } from "../lib/loginGuard.js";

export const adminRoutes = new Hono<Env>();

// ── Admin login (single shared super-admin account, ADMIN_EMAIL / ADMIN_PASSWORD) ──
//
// One account guards every customer's plan and status, so it gets the same per-account lock
// as a customer login (subject "admin"): five failures in fifteen minutes, from any mix of
// addresses, and the form answers 429 until the oldest ages out. The lock is on the password
// form only - the server-to-server ADMIN_API_TOKEN header is not affected, and neither is a
// dashboard session that is already signed in.
const ADMIN_SUBJECT = "admin";
adminRoutes.post(
  "/login",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().max(254).email(), password: z.string().min(1).max(4096) })),
  async (c) => {
    const { email, password } = c.req.valid("json");
    if (!env.adminEmail || !env.adminPassword) throw badRequest("Admin login is not configured (set ADMIN_EMAIL and ADMIN_PASSWORD)");
    return serialised(ADMIN_SUBJECT, async () => {
      const lock = await lockState(ADMIN_SUBJECT);
      if (lock.locked) {
        if (shouldAuditLock(ADMIN_SUBJECT)) await audit(c, "admin.login", { orgId: null, actorType: "anonymous", result: "denied", data: { reason: "locked", retryAfterSeconds: lock.retryAfterSeconds } });
        c.header("retry-after", String(lock.retryAfterSeconds));
        throw lockedError(lock, "the admin account");
      }
      // Compared as fixed-length hashes in constant time: `!==` on the raw password returns as
      // soon as a character differs, which leaks how much of a guess was right.
      const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
      const emailOk = same(email.toLowerCase(), env.adminEmail);
      const passwordOk = same(password, env.adminPassword);
      if (!(emailOk && passwordOk)) {
        await recordAttempt(ADMIN_SUBJECT, clientIp(c), false);
        // The address tried is recorded (it says who is knocking); the password never is.
        await audit(c, "admin.login", { orgId: null, actorType: "anonymous", result: "failed", data: { email: email.toLowerCase().slice(0, 254) } });
        throw badRequest("Invalid admin credentials");
      }
      await recordAttempt(ADMIN_SUBJECT, clientIp(c), true);
      await audit(c, "admin.login", { orgId: null, actorType: "admin", result: "ok" });
      return c.json({ token: await issueAdminJwt() });
    });
  },
);

adminRoutes.use("*", requireAdmin);

/**
 * Every change made through the admin API is recorded against the workspace it changed, with
 * what it was before and what it is now. An admin action used to leave no trace at all: a
 * plan could be changed, or a workspace suspended, and nothing anywhere said so.
 * `via` says whether it came from the dashboard (signed-in session) or the token header.
 */
async function adminAudit(c: Context<Env>, action: string, orgId: string | null, entry: { targetType?: string; targetId?: string | null; data?: Record<string, unknown> }) {
  const via = (c.get("adminVia" as never) as string | undefined) ?? "session";
  await audit(c, action, { orgId, actorType: "admin", actorUserId: null, targetType: entry.targetType, targetId: entry.targetId, result: "ok", data: { ...(entry.data ?? {}), via } });
}

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
  const before = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!before) throw notFound("Org");
  const [row] = await db
    .update(organizations)
    .set({ plan: b.plan, planLimits: { ...limitsFor(b.plan), ...(b.overrides ?? {}) } })
    .where(eq(organizations.id, c.req.param("id")))
    .returning();
  if (!row) throw notFound("Org");
  await adminAudit(c, "admin.plan_changed", row.id, { targetType: "organization", targetId: row.id, data: { before: { plan: before.plan, limits: before.planLimits }, after: { plan: row.plan, limits: row.planLimits } } });
  return c.json({ id: row.id, plan: row.plan, limits: row.planLimits });
});

const STATUS_SCHEMA = z.object({ status: z.enum(["active", "deactivated", "revoked"]) });
adminRoutes.patch("/orgs/:id/status", zValidator("json", STATUS_SCHEMA), async (c) => {
  const { db } = getDb();
  const before = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!before) throw notFound("Org");
  const [row] = await db.update(organizations).set({ status: c.req.valid("json").status }).where(eq(organizations.id, c.req.param("id"))).returning();
  if (!row) throw notFound("Org");
  await adminAudit(c, "admin.status_changed", row.id, { targetType: "organization", targetId: row.id, data: { before: { status: before.status }, after: { status: row.status } } });
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
  await adminAudit(c, "admin.credits_changed", orgIdParam, { targetType: "organization", targetId: orgIdParam, data: { metric: b.metric, period, action: b.action, amount: b.amount, before: { used: currentCount }, after: { used: row.count } } });
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
  const before = await db.query.upgradeRequests.findFirst({ where: eq(upgradeRequests.id, c.req.param("id")) });
  if (!before) throw notFound("Upgrade request");
  const [row] = await db.update(upgradeRequests).set({ status: c.req.valid("json").status }).where(eq(upgradeRequests.id, c.req.param("id"))).returning();
  if (!row) throw notFound("Upgrade request");
  await adminAudit(c, "admin.upgrade_request_status_changed", row.orgId ?? null, { targetType: "upgrade_request", targetId: row.id, data: { planId: row.planId, before: { status: before.status }, after: { status: row.status } } });
  return c.json(row);
});

// ── Tools & limits: every 3rd-party API Scout calls, its free-tier limit, and current usage,
// so the admin knows exactly which tool to upgrade before a free tier runs out. ──
/**
 * What is left on every paid provider, read from each provider's own free account endpoint.
 * Rate-limited because each call fans out to a dozen third parties.
 */
adminRoutes.get("/balances", rateLimit({ perMinute: 6 }), async (c) => c.json({ balances: await checkAllBalances(), checkedAt: new Date().toISOString() }));

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
  // Retired providers cannot pass and must not be counted as failures, or the summary line
  // reports a permanent problem after every single check.
  const registry = await getToolsSummary();
  const retired = new Set(registry.filter((t) => t.retired).map((t) => t.provider));
  const broken = results.filter((r) => r.configured && !r.ok && !retired.has(r.provider));
  await adminAudit(c, "admin.tools_checked", null, { targetType: "tools", data: { checked: results.filter((r) => r.configured).length, broken: broken.map((b) => b.provider) } });
  return c.json({
    results,
    checkedAt: new Date().toISOString(),
    retired: [...retired],
    summary:
      broken.length === 0
        ? `All configured providers responded successfully${retired.size ? ` (${retired.size} retired provider(s) skipped)` : ""}.`
        : `${broken.length} configured provider(s) did not: ${broken.map((b) => `${b.provider} (${b.outcome})`).join(", ")}.`,
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
  const provider = c.req.param("provider");
  const pick = (t: Record<string, unknown> | null | undefined) => (t ? { usageLimit: t.usageLimit ?? null, period: t.period ?? null, alertThresholdPct: t.alertThresholdPct ?? null, notes: t.notes ?? null } : null);
  const before = pick((await getToolsSummary().catch(() => [])).find((t) => t.provider === provider) as Record<string, unknown> | undefined);
  const updated = await updateToolLimit(provider, patch);
  if (!updated) throw notFound("Tool");
  await adminAudit(c, "admin.tool_limit_changed", null, { targetType: "tool", targetId: provider, data: { before, after: pick(updated as unknown as Record<string, unknown>) } });
  return c.json(updated);
});
