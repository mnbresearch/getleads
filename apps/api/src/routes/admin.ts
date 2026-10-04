import { Hono, type Context } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import {
  adjustUsage,
  and,
  auditLog,
  currentPeriod,
  desc,
  effectiveLimits,
  eq,
  getDb,
  getToolsSummary,
  globalSuppressions,
  ilike,
  inArray,
  isNull,
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
  workspaceDeletionRequests,
} from "@prospex/db";
import { checkAllBalances, checkAllProviders, UNTESTED_PROVIDERS } from "@prospex/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { claimAdminTotpStep, issueAdminJwt, revokeAdminJwt } from "../lib/auth.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { clientIp, rateLimit, requireAdmin, type Env } from "../middleware.js";
import { audit } from "../lib/audit.js";
import { ADMIN_LOCK_POLICY, attemptQueue, isNewAddressFor, lockedError, lockState, recordAttempt, serialised, shouldAuditLock } from "../lib/loginGuard.js";
import { isValidTotpSecret, verifyTotp } from "../lib/totp.js";
import { clearTwoFactor, twoFactorEnabled } from "../lib/twoFactor.js";
import { notifySecurity } from "../lib/securityMail.js";
import { aiDisabled } from "../lib/ai.js";
import { canonicalEmail } from "../services/leads.js";
import { mailingAddressOf } from "../services/campaigns.js";
import { addressFingerprint } from "../lib/privacySuppression.js";
import { dataSubjectReport, eraseDataSubject } from "../lib/privacyErase.js";

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
//
// Second factor (optional): with ADMIN_TOTP_SECRET set, the form also needs the current
// 6-digit code from the operator's authenticator app.
//   - no `code` in the request: 401 `totp_required`, whatever the password was. The answer is
//     the same for a right and a wrong password, so asking for the code gives nothing away
//     (a wrong password is still counted and logged);
//   - a wrong, expired or already-used code with the right password: 401 `invalid_totp`,
//     counted towards the lock like a wrong password;
//   - the server-to-server token header is a different credential and is not affected.
// Unset, the form works exactly as it did.
const ADMIN_SUBJECT = "admin";
const adminTotpOn = () => !!env.adminTotpSecret;
adminRoutes.post(
  "/login",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ email: z.string().max(254).email(), password: z.string().min(1).max(4096), code: z.string().max(20).optional() })),
  async (c) => {
    const { email, password } = c.req.valid("json");
    const code = c.req.valid("json").code?.trim() || undefined;
    const ip = clientIp(c);
    if (!env.adminEmail || !env.adminPassword) throw badRequest("Admin sign-in is not set up on this server yet. Set the admin email and password in your hosting dashboard and redeploy.");
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
      /** Count a failure; when it is the one that locks the form, tell the operator by email. */
      const failed = async (data: Record<string, unknown>) => {
        await recordAttempt(ADMIN_SUBJECT, ip, false);
        await audit(c, "admin.login", { orgId: null, actorType: "anonymous", result: "failed", data });
        const now = await lockState(ADMIN_SUBJECT, ip, ADMIN_LOCK_POLICY).catch(() => null);
        if (now?.locked) void notifySecurity(null, "admin_locked", { ip, retryAfterSeconds: now.retryAfterSeconds });
      };
      const codeRequired = () => new ApiError(401, "Enter the 6-digit code from your authenticator app.", "totp_required");
      if (!(emailOk && passwordOk)) {
        // The address tried is recorded (it says who is knocking); the password never is.
        await failed({ email: email.toLowerCase().slice(0, 254) });
        if (adminTotpOn() && !code) throw codeRequired();
        throw badRequest("Invalid admin credentials");
      }
      if (adminTotpOn()) {
        if (!code) throw codeRequired();
        // Set but unusable: nothing can match it. Refuse (the operator asked for a second
        // factor; quietly skipping it would be the wrong way to fail) and say what to fix.
        if (!isValidTotpSecret(env.adminTotpSecret)) {
          throw new ApiError(503, "Admin two-factor sign-in is misconfigured: ADMIN_TOTP_SECRET is not a valid base32 secret. Fix it or remove it on the server.", "not_configured");
        }
        const step = verifyTotp(env.adminTotpSecret, code);
        // A step is claimed once: the same code a second time is refused like a wrong one.
        if (step === null || !(await claimAdminTotpStep(step))) {
          await failed({ email: email.toLowerCase().slice(0, 254), reason: "invalid_totp" });
          throw new ApiError(401, "That code is not correct. Enter the current 6-digit code from your authenticator app.", "invalid_totp");
        }
      }
      // Asked before the success is recorded: afterwards this address is known by definition.
      const newAddress = await isNewAddressFor(ADMIN_SUBJECT, ip).catch(() => false);
      await recordAttempt(ADMIN_SUBJECT, ip, true);
      await audit(c, "admin.login", { orgId: null, actorType: "admin", result: "ok", data: { ...(adminTotpOn() ? { secondFactor: "totp" } : {}), ...(newAddress ? { newAddress: true } : {}) } });
      if (newAddress) void notifySecurity(null, "admin_new_signin", { ip });
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

/** `totpEnabled`: whether the admin login asks for an authenticator code (ADMIN_TOTP_SECRET is set). */
adminRoutes.get("/session", (c) => c.json({ ok: true, totpEnabled: adminTotpOn() }));

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

  // Workspaces whose owner has asked for deletion: the date the data goes, while the request
  // is still pending (not cancelled, not carried out).
  const pendingDeletions = orgIds.length
    ? await db
        .select({ orgId: workspaceDeletionRequests.orgId, scheduledFor: workspaceDeletionRequests.scheduledFor })
        .from(workspaceDeletionRequests)
        .where(and(inArray(workspaceDeletionRequests.orgId, orgIds), isNull(workspaceDeletionRequests.cancelledAt), isNull(workspaceDeletionRequests.completedAt)))
    : [];
  const deletionByOrg = new Map<string, Date>();
  for (const d of pendingDeletions) {
    const seen = deletionByOrg.get(d.orgId);
    if (!seen || d.scheduledFor.getTime() < seen.getTime()) deletionByOrg.set(d.orgId, d.scheduledFor);
  }

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
      // When this workspace's data is due to be deleted at its owner's request, or null.
      pendingDeletionAt: deletionByOrg.get(o.id) ?? null,
    };
  });

  return c.json({ orgs });
});

adminRoutes.get("/orgs/:id", async (c) => {
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, c.req.param("id")) });
  if (!org) throw notFound("Org");
  // twoFactorEnabled / emailVerified are yes-or-no answers: the secret itself never leaves the database.
  const orgUsers = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      twoFactorEnabled: sql<boolean>`(${users.totpEnabledAt} IS NOT NULL AND ${users.totpSecretEncrypted} IS NOT NULL)`,
      emailVerified: sql<boolean>`(${users.emailVerifiedAt} IS NOT NULL)`,
    })
    .from(users)
    .where(eq(users.orgId, org.id));
  const [pendingDeletion] = await db
    .select({ scheduledFor: workspaceDeletionRequests.scheduledFor })
    .from(workspaceDeletionRequests)
    .where(and(eq(workspaceDeletionRequests.orgId, org.id), isNull(workspaceDeletionRequests.cancelledAt), isNull(workspaceDeletionRequests.completedAt)))
    .orderBy(workspaceDeletionRequests.scheduledFor)
    .limit(1);
  const period = currentPeriod();
  const usageRows = await db.select().from(usage).where(and(eq(usage.orgId, org.id), eq(usage.period, period)));
  // What an operator set for this workspace on top of its plan: the limits that differ from
  // the plan's defaults. Nothing showed these before, so an override was invisible once made.
  const overrides = planOverrides(org);
  // A whitelist, not the row. The row carries the workspace's free-form settings - which
  // include copies of replies its people wrote to prospects - and its billing identifiers;
  // spreading it here put all of that in front of the operator (and into anything that
  // logged the response) for no purpose the console has. New columns are not exposed until
  // someone decides they should be.
  return c.json({
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      planLimits: org.planLimits,
      status: org.status,
      createdAt: org.createdAt,
      limits: effectiveLimits(org),
      overrides,
      pendingDeletionAt: pendingDeletion?.scheduledFor ?? null,
      hasSubscription: !!org.stripeSubscriptionId,
      // The workspace's privacy switches, as yes-or-no answers (not the address itself).
      aiAssist: !aiDisabled(org),
      mailingAddressSet: !!mailingAddressOf(org),
    },
    overrides,
    users: orgUsers,
    usage: Object.fromEntries(usageRows.map((r) => [r.metric, r.count])),
    period,
  });
});

/**
 * Turn a user's two-factor sign-in off, for support.
 *
 * This is the only way back in for someone who has lost both their authenticator and their
 * recovery codes: after it, their password alone signs them in, and they can set two-factor
 * up again. The operator should be satisfied that the person asking is the account's owner
 * BEFORE doing this - it removes the protection the owner chose. It is written to the
 * workspace's security log (the customer can see that support did it) and the user is told
 * by email, so a reset nobody asked for is noticed.
 *
 * Nothing else changes: not the password, not the sessions, not the API keys.
 */
adminRoutes.post("/orgs/:id/users/:userId/reset-2fa", async (c) => {
  const { db } = getDb();
  const user = await db.query.users.findFirst({ where: and(eq(users.id, c.req.param("userId")), eq(users.orgId, c.req.param("id"))) });
  if (!user) throw notFound("User");
  const wasEnabled = twoFactorEnabled(user);
  // Nothing set up and nothing half set up: nothing to reset, and nothing to log.
  if (!user.totpSecretEncrypted && !user.totpEnabledAt) {
    return c.json({ userId: user.id, twoFactorEnabled: false, changed: false, note: "Two-factor sign-in was not on for this user." });
  }
  await clearTwoFactor(user.id);
  await adminAudit(c, "admin.2fa_reset", user.orgId, { targetType: "user", targetId: user.id, data: { email: user.email, wasEnabled } });
  if (wasEnabled) void notifySecurity(user, "twofa_reset_by_support", {});
  return c.json({ userId: user.id, twoFactorEnabled: false, changed: true });
});

// ── Platform security view ──

/** An empty query value (`?orgId=&action=`) means "no filter", not "an invalid value". */
const blank = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const AUDIT_QUERY = z.object({
  orgId: blank(z.string().uuid()),
  /** Exact action name, or a prefix ending in `*` ("auth.*", "admin.*"). */
  action: blank(z.string().max(100)),
  result: blank(z.enum(["ok", "denied", "failed"])),
  actorType: blank(z.enum(["user", "api_key", "admin", "system", "anonymous"])),
  limit: blank(z.coerce.number().int().min(1).max(200)),
  before: blank(z.string().max(40)),
});

/**
 * GET /v1/admin/audit-log - the security log across EVERY workspace, newest first.
 *
 * The same rows a workspace's owner sees under /v1/audit-log, plus the ones that belong to
 * no workspace (admin sign-ins, sign-in attempts against the admin form), with the
 * workspace's name and the acting user's email joined in. Unlike the customer's view, the
 * address is shown on every row: this is the operator's own record.
 *
 * Filters combine (AND). Paginate by passing the previous page's `nextBefore` as `before`.
 */
adminRoutes.get("/audit-log", zValidator("query", AUDIT_QUERY), async (c) => {
  const q = c.req.valid("query");
  const limit = q.limit ?? 50;
  // Validated as a date here, compared in Postgres at full (microsecond) precision: a
  // millisecond cursor would skip rows written in the same millisecond as the last one shown.
  const before = q.before?.trim() || null;
  if (before && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(before) || Number.isNaN(new Date(before).getTime()))) {
    throw badRequest("`before` must be an ISO 8601 timestamp (use the previous page's nextBefore).");
  }
  const action = q.action?.trim();
  const { db } = getDb();
  // One extra row tells us whether there is another page without a second query.
  const rows = await db
    .select({
      id: auditLog.id,
      orgId: auditLog.orgId,
      orgName: organizations.name,
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorEmail: users.email,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      result: auditLog.result,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      data: auditLog.data,
      cursor: sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(auditLog)
    .leftJoin(organizations, eq(organizations.id, auditLog.orgId))
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        q.orgId ? eq(auditLog.orgId, q.orgId) : undefined,
        action ? (action.endsWith("*") ? sql`${auditLog.action} LIKE ${`${escapeLike(action.slice(0, -1))}%`}` : eq(auditLog.action, action)) : undefined,
        q.result ? eq(auditLog.result, q.result) : undefined,
        q.actorType ? eq(auditLog.actorType, q.actorType) : undefined,
        before ? sql`${auditLog.createdAt} < ${before}::timestamptz` : undefined,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return c.json({
    entries: page.map((r) => ({
      id: r.id,
      orgId: r.orgId ?? null,
      orgName: r.orgName ?? null,
      action: r.action,
      actorType: r.actorType,
      actorEmail: r.actorEmail ?? null,
      targetType: r.targetType ?? null,
      targetId: r.targetId ?? null,
      result: r.result,
      ip: r.ip ?? null,
      createdAt: r.createdAt,
      data: r.data ?? {},
    })),
    hasMore,
    nextBefore: hasMore && page.length ? page[page.length - 1].cursor : null,
  });
});

/**
 * GET /v1/admin/security/summary - the last 24 hours at a glance.
 *
 *   failedLogins      sign-in attempts that failed (customer accounts and the admin form)
 *   lockedAccounts    accounts whose sign-in was refused because of a lock ("admin" counts as one)
 *   deniedActions     actions refused by a permission check (a role, a read-only key, a lock)
 *   adminLogins       successful admin console sign-ins
 *   newWorkspaces     workspaces created
 *   exports           data exports (lead exports and whole-workspace exports)
 *   bulkDeletes       bulk deletions
 *   pendingDeletions  workspaces currently waiting out the grace period before deletion (not limited to 24 hours)
 *   topFailingIps     the five addresses with the most failed sign-ins
 *
 * Five aggregate queries, each over an indexed time range, run together.
 */
adminRoutes.get("/security/summary", async (c) => {
  const { db } = getDb();
  const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  // Wrong guesses at a signed-in user's own password or code are kept under their own
  // subjects (`pwchange:<id>`, `2fa:<id>`); they are not sign-in attempts.
  const signIn = sql`subject NOT LIKE 'pwchange:%' AND subject NOT LIKE '2fa:%'`;
  const [audits, attempts, topIps, orgs, deletions] = await Promise.all([
    one<{ denied: number; admin_logins: number; exports: number; bulk_deletes: number; locked: number }>(sql`
      SELECT
        count(*) FILTER (WHERE result = 'denied')::int AS denied,
        count(*) FILTER (WHERE action = 'admin.login' AND result = 'ok')::int AS admin_logins,
        count(*) FILTER (WHERE action LIKE '%.exported' AND result = 'ok')::int AS exports,
        count(*) FILTER (WHERE action LIKE '%bulk_deleted' AND result = 'ok')::int AS bulk_deletes,
        count(DISTINCT CASE
          WHEN action = 'auth.login_locked' THEN coalesce(target_id, data->>'email')
          WHEN action = 'admin.login' AND result = 'denied' AND data->>'reason' = 'locked' THEN 'admin'
        END)::int AS locked
      FROM audit_log
      WHERE created_at > now() - interval '24 hours'`),
    one<{ failed: number }>(sql`SELECT count(*)::int AS failed FROM login_attempts WHERE NOT succeeded AND created_at > now() - interval '24 hours' AND ${signIn}`),
    db.execute(sql`
      SELECT ip, count(*)::int AS count
      FROM login_attempts
      WHERE NOT succeeded AND created_at > now() - interval '24 hours' AND ip IS NOT NULL AND ip <> 'unknown' AND ${signIn}
      GROUP BY ip
      ORDER BY count(*) DESC, ip
      LIMIT 5`) as unknown as Promise<{ ip: string; count: number }[]>,
    one<{ created: number }>(sql`SELECT count(*)::int AS created FROM organizations WHERE created_at > now() - interval '24 hours'`),
    one<{ pending: number }>(sql`SELECT count(*)::int AS pending FROM workspace_deletion_requests WHERE cancelled_at IS NULL AND completed_at IS NULL`),
  ]);
  return c.json({
    window: "24h",
    failedLogins: attempts?.failed ?? 0,
    lockedAccounts: audits?.locked ?? 0,
    deniedActions: audits?.denied ?? 0,
    adminLogins: audits?.admin_logins ?? 0,
    newWorkspaces: orgs?.created ?? 0,
    exports: audits?.exports ?? 0,
    bulkDeletes: audits?.bulk_deletes ?? 0,
    pendingDeletions: deletions?.pending ?? 0,
    topFailingIps: [...topIps].map((r) => ({ ip: r.ip, count: Number(r.count) })),
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

// ── Platform-wide do-not-contact list ──
//
// A workspace's own list stops that workspace. This one is for people who told US - not one
// customer - that they never want to hear from anyone using Scout, and for erasure requests.
// Every send path of every workspace checks it (lib/privacySuppression.ts).

const emailInput = z.string().max(320);
/** The address as both lists store it, or a 400 that says what is wrong. */
function oneAddress(raw: string): string {
  const email = canonicalEmail(raw);
  if (!email) throw badRequest("Enter one email address, like jane@example.com.");
  return email;
}
const suppressionOut = (r: { id: string; email: string; reason: string; note: string | null; createdAt: Date }) => ({ id: r.id, email: r.email, reason: r.reason, note: r.note, createdAt: r.createdAt });

adminRoutes.get("/suppressions", zValidator("query", z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })), async (c) => {
  const { q, limit } = c.req.valid("query");
  const { db } = getDb();
  const term = q?.trim().toLowerCase();
  const rows = await db
    .select()
    .from(globalSuppressions)
    .where(term ? ilike(globalSuppressions.email, `%${escapeLike(term)}%`) : undefined)
    .orderBy(desc(globalSuppressions.createdAt))
    .limit(limit);
  return c.json({ suppressions: rows.map(suppressionOut) });
});

adminRoutes.post("/suppressions", zValidator("json", z.object({ email: emailInput, reason: z.string().max(100).optional(), note: z.string().max(500).optional() })), async (c) => {
  const b = c.req.valid("json");
  const email = oneAddress(b.email);
  const { db } = getDb();
  // Idempotent on the address: adding one that is already listed returns the existing entry
  // unchanged, so a double click (or a second request about the same person) is not an error.
  const inserted = await db
    .insert(globalSuppressions)
    .values({ email, reason: b.reason?.trim() || "request", note: b.note?.trim() || null })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0] ?? (await db.query.globalSuppressions.findFirst({ where: eq(globalSuppressions.email, email) }));
  if (!row) throw new ApiError(500, "The address could not be added to the list. Try again.", "internal_error");
  // The log names the entry and a fingerprint of the address, not the address: this log is
  // kept for a long time, and the list itself is where the address belongs.
  if (inserted.length) await adminAudit(c, "admin.suppression_added", null, { targetType: "global_suppression", targetId: row.id, data: { address: addressFingerprint(email), reason: row.reason } });
  return c.json({ suppression: suppressionOut(row), created: inserted.length > 0 }, inserted.length ? 201 : 200);
});

adminRoutes.delete("/suppressions/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badRequest("That is not a valid id.");
  const { db } = getDb();
  const gone = await db.delete(globalSuppressions).where(eq(globalSuppressions.id, id)).returning();
  if (!gone.length) throw notFound("Suppression");
  await adminAudit(c, "admin.suppression_removed", null, { targetType: "global_suppression", targetId: id, data: { address: addressFingerprint(gone[0].email), reason: gone[0].reason } });
  return c.json({ ok: true });
});

// ── Data-subject requests: where does this person appear, and erase them ──

/** Counts per workspace - never the content. Looking someone up is itself recorded. */
adminRoutes.get("/data-subject", rateLimit({ perMinute: 30, name: "admin-data-subject" }), zValidator("query", z.object({ email: emailInput })), async (c) => {
  const email = oneAddress(c.req.valid("query").email);
  const report = await dataSubjectReport(email);
  await adminAudit(c, "admin.data_subject_viewed", null, { targetType: "data_subject", targetId: addressFingerprint(email), data: { workspaces: report.workspaces.length, globallySuppressed: report.globallySuppressed } });
  return c.json(report);
});

/**
 * Erase a person everywhere: their lead records and every copy of their personal data in
 * every workspace (the same routine a lead deletion runs), and their address onto the
 * platform list so no workspace can add or contact them again. `confirm` must repeat the
 * address - this cannot be undone.
 */
adminRoutes.post("/data-subject/erase", rateLimit({ perMinute: 10, name: "admin-data-subject-erase" }), zValidator("json", z.object({ email: emailInput, confirm: z.string().max(320) })), async (c) => {
  const b = c.req.valid("json");
  const email = oneAddress(b.email);
  if (canonicalEmail(b.confirm) !== email) throw new ApiError(400, "The confirmation does not match the address. Type the same address again to confirm.", "confirm_mismatch");
  const r = await eraseDataSubject(email);
  await adminAudit(c, "admin.data_subject_erased", null, { targetType: "data_subject", targetId: addressFingerprint(email), data: { workspaces: r.workspaces, leadsDeleted: r.leadsDeleted, messagesAnonymised: r.messagesAnonymised, eventsDeleted: r.eventsDeleted } });
  return c.json({ ok: true, workspaces: r.workspaces, leadsDeleted: r.leadsDeleted, messagesAnonymised: r.messagesAnonymised, globallySuppressed: true });
});
