import { Hono, type Context } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import {
  adjustUsage,
  and,
  currentPeriod,
  desc,
  effectiveLimits,
  eq,
  getDb,
  getToolsSummary,
  ilike,
  inArray,
  isPlanId,
  limitsFor,
  MAX_PLAN_LIMIT,
  metricToLimit,
  or,
  organizations,
  PLAN_IDS,
  planOverrides,
  PLANS,
  recordProviderHealth,
  sanitizePlanLimits,
  sql,
  updateToolLimit,
  upgradeRequests,
  usage,
  users,
} from "@prospex/db";
import { checkAllBalances, checkAllProviders, UNTESTED_PROVIDERS } from "@prospex/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { issueAdminJwt, revokeAdminJwt } from "../lib/auth.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { clientIp, rateLimit, requireAdmin, type Env } from "../middleware.js";
import { audit } from "../lib/audit.js";
import { ADMIN_LOCK_POLICY, attemptQueue, lockedError, lockState, recordAttempt, serialised, shouldAuditLock } from "../lib/loginGuard.js";

export const adminRoutes = new Hono<Env>();

// ── Admin login (single shared super-admin account, ADMIN_EMAIL / ADMIN_PASSWORD) ──
//
// One account guards every customer's plan and status, and it has ONE subject for the whole
// platform - so the customer lock rule (five failures from anywhere lock the account) let any
// stranger lock the operator out with five guesses. The admin form has its own thresholds
// (ADMIN_LOCK_POLICY): five failures from one address lock THAT address for fifteen minutes;
// the account as a whole (for addresses that have not signed in before) locks only after
// fifty failures in fifteen minutes. The lock is on the password form only - the
// server-to-server ADMIN_API_TOKEN header is not affected, and neither is a dashboard session
// that is already signed in.
const ADMIN_SUBJECT = "admin";
adminRoutes.post(
  "/login",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().max(254).email(), password: z.string().min(1).max(4096) })),
  async (c) => {
    const { email, password } = c.req.valid("json");
    if (!env.adminEmail || !env.adminPassword) throw badRequest("Admin login is not configured (set ADMIN_EMAIL and ADMIN_PASSWORD)");
    // One queue per address: every address has its own allowance here, and a stranger filling
    // a shared queue must not be able to make the operator's attempt bounce off it.
    return serialised(await attemptQueue("admin-login", ADMIN_SUBJECT, clientIp(c), { perAddress: true }), async () => {
      const lock = await lockState(ADMIN_SUBJECT, clientIp(c), ADMIN_LOCK_POLICY);
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
 *
 * Only CHANGES are recorded. A request that leaves everything as it was (the same plan again,
 * a grant of zero, an empty tool update) answers `changed: false` and writes no row: a log
 * full of "changed A to A" hides the rows that matter.
 */
async function adminAudit(c: Context<Env>, action: string, orgId: string | null, entry: { targetType?: string; targetId?: string | null; data?: Record<string, unknown> }) {
  const via = (c.get("adminVia" as never) as string | undefined) ?? "session";
  await audit(c, action, { orgId, actorType: "admin", actorUserId: null, targetType: entry.targetType, targetId: entry.targetId, result: "ok", data: { ...(entry.data ?? {}), via } });
}

adminRoutes.get("/session", (c) => c.json({ ok: true }));

/**
 * Sign the admin session out, for real.
 *
 * "Sign out" used to be the browser forgetting its token; the token itself kept working for
 * the rest of its twelve hours, so a copy of it (a shared screen, a browser profile, a proxy
 * log) was still a key to every workspace. This records the presented token as revoked, and
 * it is refused from the next request on.
 *
 * The server-to-server token header is not a session: there is nothing to sign out, and the
 * answer says so instead of pretending.
 */
adminRoutes.post("/logout", async (c) => {
  const header = c.req.header("authorization");
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const outcome = token ? await revokeAdminJwt(token) : "invalid";
  if (outcome === "unavailable") {
    throw new ApiError(503, "Sign-out could not be recorded because the database has not been upgraded for this release yet. This session will still expire on its own within 12 hours.", "not_available");
  }
  if (outcome === "invalid") {
    return c.json({ ok: true, revoked: false, note: "This request was authenticated with the server-to-server admin token, which is not a session and cannot be signed out. Rotate that token to revoke it." });
  }
  await adminAudit(c, "admin.logout", null, { targetType: "admin_session" });
  return c.json({ ok: true, revoked: true });
});

// ── Orgs / customers ──

/** `%`, `_` and `\` mean something to LIKE. Typed into a search box they are just characters. */
const escapeLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

adminRoutes.get("/orgs", zValidator("query", z.object({ q: z.string().max(200).optional() })), async (c) => {
  const q = c.req.valid("query").q?.trim();
  const { db } = getDb();
  const period = currentPeriod();

  // Plain Drizzle query-builder calls only (no raw sql subqueries) - this is the style proven
  // reliable elsewhere in this file (see GET /orgs/:id). Fetch orgs, then fetch users + usage for
  // those org ids in two more queries, then merge in JS.
  //
  // The search text is escaped: searching for "%" or "_" used to match every workspace,
  // because those are LIKE wildcards (Postgres's default escape character is the backslash).
  const like = q ? `%${escapeLike(q)}%` : null;
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
      // Always numbers and booleans, whatever is stored: the list showed "3/NaN" for a
      // workspace whose stored limit was a string.
      limits: effectiveLimits(o),
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
  // What an operator set for this workspace on top of its plan: the limits that differ from
  // the plan's defaults. Nothing showed these before, so an override was invisible once made.
  const overrides = planOverrides(org);
  return c.json({
    org: { ...org, limits: effectiveLimits(org), overrides },
    overrides,
    users: orgUsers,
    usage: Object.fromEntries(usageRows.map((r) => [r.metric, r.count])),
    period,
  });
});

/** A limit that is a count: a whole number from 0 up. (0 means "no limit" for the monthly metrics.) */
const countLimit = z.number().int().min(0).max(MAX_PLAN_LIMIT);
/**
 * Plan limits that are part of every plan's definition but that NOTHING in the server reads
 * when deciding what a workspace may do: no route counts a workspace's campaigns against
 * `campaigns`, and no route checks `apiAccess` or `integrations` before serving the API or
 * connecting an integration. An override for one of them was accepted, stored and shown in
 * the console - and changed nothing (a customer set to `apiAccess: false` kept using the
 * API). An override that cannot take effect is refused, with the reason.
 *
 * Enforced, and so overridable: the six monthly metrics (consume / remainingPremiumBudget in
 * packages/db usage.ts), `seats` (the invite and join routes) and `emailsPerDay`
 * (orgDailySendCeiling). When one of the three below gains real enforcement, give it its
 * value schema in OVERRIDES_SCHEMA and remove it from here.
 */
const UNENFORCED_LIMITS = { campaigns: "The campaigns limit", apiAccess: "API access", integrations: "Integrations access" } as const;
const notEnforced = (what: string) =>
  z.unknown().superRefine((_v, ctx) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} is not enforced by the server yet, so it cannot be overridden.` });
  });
/**
 * Overrides are a strict partial of the plan limits the server enforces. They used to be
 * `z.record(z.unknown())`, stored verbatim: `{"leadsPerMonth":"lots","seats":-1,"evil":{}}`
 * was accepted, and the string switched that customer's lead quota off. An unknown key or a
 * value of the wrong kind is now a 400 that names it.
 */
const OVERRIDES_SCHEMA = z
  .object({
    leadsPerMonth: countLimit,
    premiumLeadsPerMonth: countLimit,
    searchesPerMonth: countLimit,
    verificationsPerMonth: countLimit,
    aiMessagesPerMonth: countLimit,
    emailsPerMonth: countLimit,
    seats: countLimit,
    /** The workspace's daily sending ceiling, when it should differ from the computed one. */
    emailsPerDay: z.number().int().min(1).max(MAX_PLAN_LIMIT),
    campaigns: notEnforced(UNENFORCED_LIMITS.campaigns),
    apiAccess: notEnforced(UNENFORCED_LIMITS.apiAccess),
    integrations: notEnforced(UNENFORCED_LIMITS.integrations),
  })
  .partial()
  .strict();
/** Limit names as the console shows them (the same words as its "Custom limits" list). */
const LIMIT_LABELS: Record<string, string> = {
  leadsPerMonth: "leads/month",
  premiumLeadsPerMonth: "premium leads/month",
  searchesPerMonth: "searches/month",
  verificationsPerMonth: "verifications/month",
  aiMessagesPerMonth: "AI messages/month",
  emailsPerMonth: "emails/month",
  emailsPerDay: "emails/day",
  campaigns: "campaigns",
  seats: "seats",
  apiAccess: "API access",
  integrations: "integrations",
};
const limitText = (k: string, v: unknown) => `${LIMIT_LABELS[k] ?? k} ${typeof v === "boolean" ? (v ? "on" : "off") : String(v)}`;
const PLAN_SCHEMA = z.object({ plan: z.string().max(100), overrides: OVERRIDES_SCHEMA.optional() });

/** Key order does not matter when comparing two sets of limits (jsonb reorders keys anyway). */
const canonical = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

adminRoutes.patch("/orgs/:id/plan", zValidator("json", PLAN_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  // isPlanId, not `PLANS[b.plan]`: "toString", "constructor" and "__proto__" are all truthy
  // on a plain object, and each of them was accepted and stored as a workspace's plan.
  if (!isPlanId(b.plan)) throw badRequest(`Unknown plan "${b.plan.slice(0, 40)}". Valid plans: ${PLAN_IDS.join(", ")}`);
  const { db } = getDb();
  const before = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!before) throw notFound("Org");

  // Overrides belong to the workspace, not to the plan it happens to be on. Changing only the
  // plan used to rewrite plan_limits from the new plan's defaults, silently discarding
  // whatever had been granted. They are kept unless the request says otherwise: `overrides`
  // replaces them, and an explicit `{}` clears them.
  const explicit = b.overrides !== undefined;
  const overrides = (explicit ? b.overrides! : planOverrides(before)) as Record<string, number | boolean>;
  const nextLimits = { ...limitsFor(b.plan), ...overrides };
  // Stored values that are not usable limits (written before overrides were validated).
  const junk = sanitizePlanLimits(before.planLimits).rejected;
  const unchanged = before.plan === b.plan && junk.length === 0 && canonical(effectiveLimits(before) as unknown as Record<string, unknown>) === canonical(nextLimits as unknown as Record<string, unknown>);
  const shownOverrides = planOverrides({ plan: b.plan, planLimits: nextLimits });
  if (unchanged) {
    return c.json({ id: before.id, plan: before.plan, limits: effectiveLimits(before), overrides: shownOverrides, changed: false });
  }

  const [row] = await db
    .update(organizations)
    .set({ plan: b.plan, planLimits: nextLimits as typeof before.planLimits })
    .where(eq(organizations.id, before.id))
    .returning();
  if (!row) throw notFound("Org");
  await adminAudit(c, "admin.plan_changed", row.id, {
    targetType: "organization",
    targetId: row.id,
    data: { before: { plan: before.plan, limits: before.planLimits }, after: { plan: row.plan, limits: row.planLimits }, overrides: shownOverrides, overridesFrom: explicit ? "request" : "kept" },
  });
  const kept = !explicit && before.plan !== b.plan ? Object.entries(shownOverrides) : [];
  const notes = [
    // Shown as it is in the console, so it names the limits and the control the way the page does.
    kept.length ? `Custom limits were kept: ${kept.map(([k, v]) => limitText(k, v)).join(", ")}. Tick 'Clear custom limits' to remove them.` : "",
    junk.length ? `Removed stored limit values that were not usable: ${junk.slice(0, 10).join(", ")}.` : "",
  ].filter(Boolean);
  return c.json({ id: row.id, plan: row.plan, limits: effectiveLimits(row), overrides: shownOverrides, changed: true, ...(notes.length ? { note: notes.join(" ") } : {}) });
});

const STATUS_SCHEMA = z.object({ status: z.enum(["active", "deactivated", "revoked"]) });
adminRoutes.patch("/orgs/:id/status", zValidator("json", STATUS_SCHEMA), async (c) => {
  const { db } = getDb();
  const next = c.req.valid("json").status;
  const before = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!before) throw notFound("Org");
  if (before.status === next) return c.json({ id: before.id, status: before.status, changed: false });
  const [row] = await db.update(organizations).set({ status: next }).where(eq(organizations.id, before.id)).returning();
  if (!row) throw notFound("Org");
  await adminAudit(c, "admin.status_changed", row.id, { targetType: "organization", targetId: row.id, data: { before: { status: before.status }, after: { status: row.status } } });
  return c.json({ id: row.id, status: row.status, changed: true });
});

/** Manually grant/set an org's usage for the current billing period - this is "credits" in
 * this product: there's no separate wallet, usage vs. plan limit IS the credit balance, so
 * granting credits means giving the org more room against that limit for this period.
 *
 * `action` (also accepted as `mode`): "grant" lowers the used-count by `amount` (a negative
 * amount takes usage away, i.e. raises the used-count); "set" pins the used-count.
 *
 * The amount is bounded. "Set used to 2147483647" was accepted, and the customer's next
 * search then failed inside the database with an error that said nothing about a quota. */
const MAX_CREDIT_AMOUNT = 1_000_000;
const CREDIT_ACTIONS = ["grant", "set"] as const;
const CREDITS_SCHEMA = z
  .object({
    metric: z.enum(["leads", "premiumLeads", "searches", "verifications", "aiMessages", "emails"]),
    action: z.enum(CREDIT_ACTIONS).optional(),
    mode: z.enum(CREDIT_ACTIONS).optional(),
    amount: z.number().int().min(-MAX_CREDIT_AMOUNT).max(MAX_CREDIT_AMOUNT),
  })
  .superRefine((v, ctx) => {
    if (!v.action && !v.mode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "Required" });
    else if (v.action && v.mode && v.action !== v.mode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: "Does not match `action`; send one of them" });
  });
const METRIC_LABEL: Record<string, string> = { leads: "leads", premiumLeads: "premium leads", searches: "searches", verifications: "verifications", aiMessages: "AI messages", emails: "emails" };

adminRoutes.patch("/orgs/:id/credits", zValidator("json", CREDITS_SCHEMA), async (c) => {
  const b = c.req.valid("json");
  const action = (b.action ?? b.mode)!;
  const { db } = getDb();
  const orgIdParam = c.req.param("id");
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgIdParam) });
  if (!org) throw notFound("Org");
  const what = METRIC_LABEL[b.metric] ?? b.metric;
  // The allowance this usage is measured against. null = no limit (a stored 0 for the monthly
  // metrics); premium leads are the exception, where 0 means none at all.
  const rawLimit = effectiveLimits(org)[metricToLimit[b.metric]] as number;
  const limit = b.metric === "premiumLeads" || rawLimit > 0 ? rawLimit : null;

  if (action === "grant" && b.amount === 0) {
    const row = await db.query.usage.findFirst({ where: and(eq(usage.orgId, org.id), eq(usage.period, currentPeriod()), eq(usage.metric, b.metric)) });
    return c.json({ metric: b.metric, period: currentPeriod(), used: row?.count ?? 0, limit, changed: false, note: "The amount was 0." });
  }

  // One statement in the database, on the row as it is at that moment (see adjustUsage). The
  // old read-then-write let ten parallel "take one more" requests land as four.
  // "grant" gives the org more room by lowering how much of their quota looks used;
  // "set" pins the used-count to an exact value (e.g. reset to 0 for a fresh grant).
  const r = await adjustUsage(db, org.id, b.metric, action === "grant" ? { delta: -b.amount } : { set: b.amount });
  const changed = r.before !== r.after;

  // One sentence, and never "Nothing changed": the console writes that itself for
  // `changed: false` and puts this after it.
  let note: string | undefined;
  if (action === "grant" && b.amount > 0) {
    const givenBack = r.before - r.after;
    if (r.before === 0) {
      // Said plainly: this used to answer "saved" and do nothing.
      note =
        limit === null
          ? `This workspace has used 0 ${what} this month, so there was nothing to give back, and its plan has no limit on ${what} to raise.`
          : `This workspace has used 0 ${what} this month, so there was nothing to give back: a grant only returns usage, and raising the allowance of ${limit.toLocaleString("en-US")} takes a custom limit (a plan override).`;
    } else if (givenBack < b.amount) {
      note = `Usage cannot go below zero, so only ${givenBack} ${givenBack === 1 ? "was" : "were"} granted back.`;
    }
  } else if (action === "grant" && b.amount < 0) {
    const added = r.after - r.before;
    if (added < -b.amount) note = `The usage counter is at its maximum, so only ${added} ${added === 1 ? "was" : "were"} added.`;
  } else if (action === "set") {
    if (b.amount < 0) note = "Usage cannot go below zero, so used was set to 0.";
    else if (!changed) note = `The used count was already ${r.after.toLocaleString("en-US")}.`;
  }

  if (changed) {
    await adminAudit(c, "admin.credits_changed", org.id, { targetType: "organization", targetId: org.id, data: { metric: b.metric, period: r.period, action, amount: b.amount, before: { used: r.before }, after: { used: r.after } } });
  }
  return c.json({ metric: b.metric, period: r.period, used: r.after, limit, changed, ...(note ? { note } : {}) });
});

// ── Plans reference (read-only - prices/limits live in code, see packages/db/src/plans.ts) ──
adminRoutes.get("/plans", (c) => c.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })) }));

// ── Upgrade-request leads captured from the pricing page ──
adminRoutes.get("/upgrade-requests", zValidator("query", z.object({ status: z.string().max(40).optional() })), async (c) => {
  const { status } = c.req.valid("query");
  const { db } = getDb();
  // Joined to the workspace the request came from (when the person was signed in), so the
  // list can name it and link to it instead of showing a request with no context.
  const rows = await db
    .select({
      id: upgradeRequests.id,
      orgId: upgradeRequests.orgId,
      orgName: organizations.name,
      name: upgradeRequests.name,
      email: upgradeRequests.email,
      mobile: upgradeRequests.mobile,
      country: upgradeRequests.country,
      planId: upgradeRequests.planId,
      message: upgradeRequests.message,
      status: upgradeRequests.status,
      createdAt: upgradeRequests.createdAt,
    })
    .from(upgradeRequests)
    .leftJoin(organizations, eq(organizations.id, upgradeRequests.orgId))
    .where(status ? eq(upgradeRequests.status, status) : sql`true`)
    .orderBy(desc(upgradeRequests.createdAt))
    .limit(1000);
  return c.json({ requests: rows.map((r) => ({ ...r, orgId: r.orgId ?? null, orgName: r.orgName ?? null })) });
});

adminRoutes.patch("/upgrade-requests/:id", zValidator("json", z.object({ status: z.enum(["new", "contacted", "converted", "dismissed"]) })), async (c) => {
  const { db } = getDb();
  const next = c.req.valid("json").status;
  const before = await db.query.upgradeRequests.findFirst({ where: eq(upgradeRequests.id, c.req.param("id")) });
  if (!before) throw notFound("Upgrade request");
  if (before.status === next) return c.json({ ...before, changed: false });
  const [row] = await db.update(upgradeRequests).set({ status: next }).where(eq(upgradeRequests.id, before.id)).returning();
  if (!row) throw notFound("Upgrade request");
  await adminAudit(c, "admin.upgrade_request_status_changed", row.orgId ?? null, { targetType: "upgrade_request", targetId: row.id, data: { planId: row.planId, before: { status: before.status }, after: { status: row.status } } });
  return c.json({ ...row, changed: true });
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
 *
 * The summary says what was tested and what was not. With no key configured at all it used to
 * read "All configured providers responded successfully" - true of an empty list, and exactly
 * the reassurance an operator with nothing configured should not get. And a provider that has
 * a key but no free, side-effect-free call to test it with (see UNTESTED_PROVIDERS) is named
 * in `notTested` with the reason, so "all" never quietly means "all the ones we could".
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
  const tested = results.filter((r) => r.configured && !retired.has(r.provider));
  const broken = tested.filter((r) => !r.ok);
  const skippedRetired = results.filter((r) => r.configured && retired.has(r.provider));

  // Providers holding a key that no check exercises: the ones deliberately left out, and any
  // registry row with a key that simply has no check yet. (Infrastructure rows - the
  // database, the hosts - are not API keys; /health covers the database.)
  const checked = new Set(results.map((r) => r.provider));
  const notTested = registry
    .filter((t) => t.keyEnvVar && t.configured && !t.retired && t.category !== "Infrastructure" && !checked.has(t.provider))
    .map((t) => ({ provider: t.provider, label: t.label, reason: UNTESTED_PROVIDERS[t.provider]?.reason ?? "There is no test call for this provider yet." }));

  const notTestedText = notTested.length ? ` Not tested: ${notTested.map((n) => n.label).join(", ")} (no free test call exists for ${notTested.length === 1 ? "it" : "them"}).` : "";
  const retiredText = skippedRetired.length ? ` ${skippedRetired.length} retired provider(s) skipped.` : "";
  let summary: string;
  if (tested.length === 0 && notTested.length === 0) summary = "No provider keys are configured, so nothing was tested.";
  else if (tested.length === 0) summary = `No provider key that can be tested is configured, so nothing was tested.${notTestedText}${retiredText}`;
  else if (broken.length === 0) summary = `All ${tested.length} tested provider key(s) responded successfully.${retiredText}${notTestedText}`;
  else summary = `${broken.length} of ${tested.length} tested provider key(s) did not respond successfully: ${broken.map((b) => `${(b as { label?: string }).label ?? b.provider} (${b.outcome})`).join(", ")}.${retiredText}${notTestedText}`;

  // Nothing was called, so there is nothing to record.
  if (tested.length + skippedRetired.length > 0) {
    await adminAudit(c, "admin.tools_checked", null, { targetType: "tools", data: { checked: results.filter((r) => r.configured).length, broken: broken.map((b) => b.provider), notTested: notTested.map((n) => n.provider) } });
  }
  return c.json({
    // `retired` marks a row that was called but is not part of the count: a retired provider
    // cannot pass, so it is neither "tested" nor a failure.
    results: results.map((r) => ({ ...r, retired: retired.has(r.provider) })),
    checkedAt: new Date().toISOString(),
    retired: [...retired],
    // The number the summary sentence uses. Counting `results` rows that have a key gives a
    // different one (it includes retired providers): the page said "4 providers tested"
    // under a summary that said 3. `tested` has always been this number; `testedCount` is
    // the same value under a name that cannot be mistaken for a list.
    tested: tested.length,
    testedCount: tested.length,
    passed: tested.length - broken.length,
    skippedRetired: skippedRetired.map((r) => r.provider),
    notTested,
    summary,
  });
});

/** One sentence for every way the number can be wrong, naming the largest value it may hold. */
const USAGE_LIMIT_RULE = `Usage limit must be a whole number from 0 to ${MAX_PLAN_LIMIT.toLocaleString("en-US")}.`;
const TOOL_LIMIT_SCHEMA = z.object({
  // Bounded: the column is a 32-bit integer, and a larger number used to reach the database
  // and come back as a generic "value not usable" error that did not name the field.
  usageLimit: z
    .number({ invalid_type_error: USAGE_LIMIT_RULE })
    .int(USAGE_LIMIT_RULE)
    .min(0, USAGE_LIMIT_RULE)
    .max(MAX_PLAN_LIMIT, USAGE_LIMIT_RULE)
    .nullable()
    .optional(),
  period: z.enum(["day", "month"]).optional(),
  alertThresholdPct: z.number().int().min(1).max(100).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

adminRoutes.patch("/tools/:provider", zValidator("json", TOOL_LIMIT_SCHEMA), async (c) => {
  const patch = c.req.valid("json");
  const provider = c.req.param("provider");
  const pick = (t: Record<string, unknown> | null | undefined) => (t ? { usageLimit: t.usageLimit ?? null, period: t.period ?? null, alertThresholdPct: t.alertThresholdPct ?? null, notes: t.notes ?? null } : null);
  const current = (await getToolsSummary()).find((t) => t.provider === provider);
  if (!current) throw notFound("Tool");
  const before = pick(current as unknown as Record<string, unknown>)!;
  // An empty body, or one that repeats what is already stored, changes nothing: no write (a
  // write also re-arms the usage alert) and no audit row.
  const differs = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== undefined && (patch[k] ?? null) !== (before[k] ?? null));
  if (!differs) return c.json({ ...current, changed: false });
  const updated = await updateToolLimit(provider, patch);
  if (!updated) throw notFound("Tool");
  await adminAudit(c, "admin.tool_limit_changed", null, { targetType: "tool", targetId: provider, data: { before, after: pick(updated as unknown as Record<string, unknown>) } });
  return c.json({ ...updated, changed: true });
});
