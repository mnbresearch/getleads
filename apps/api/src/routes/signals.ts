import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, campaigns, desc, enqueue, eq, getDb, icps, inArray, monitorResults, monitors, or, remainingPremiumBudget, signalMatches, signalSubscriptions, signals, sql } from "@prospex/db";
import { ApiError, notFound, requireSomeFields } from "../lib/errors.js";
import { normalizeLinkedinPostUrl } from "@prospex/core";
import { assertOwned } from "../lib/ownership.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { boundedCsv, boundedRead, likeContains, LIST_SEARCH_MAX } from "../lib/listSearch.js";
import { assertRowCap, guardJobCapacity } from "../lib/limits.js";
import { scanJobChanges } from "../services/jobChanges.js";
import { runSubscription } from "../services/signals.js";
import { runMonitor } from "../services/monitors.js";

export const signalRoutes = new Hono<Env>();
signalRoutes.use("*", requireAuth);

// `job_change` is a lead-level signal rather than a company-level one: it fires when a
// person we already track moves employer or is promoted. A champion who moves is the
// strongest buying trigger there is - they arrive somewhere new with budget, a mandate and
// a tool they already like - and the same event tells you a live deal just lost its sponsor.
const SIGNAL_TYPES = ["funding", "acquisition", "hiring", "leadership", "expansion", "launch", "partnership", "job_change", "news"] as const;

/** Signal feed: global signals + matches for this org. */
signalRoutes.get("/", zValidator("query", z.object({ type: z.string().max(400).optional(), q: z.string().max(LIST_SEARCH_MAX).optional(), matched: z.enum(["true", "false"]).optional(), days: z.coerce.number().int().min(1).max(365).default(14), limit: z.coerce.number().int().min(1).max(500).default(100) })), async (c) => {
  const q = c.req.valid("query");
  const oid = orgId(c);
  const { db } = getDb();
  const p = q.q ? likeContains(q.q) : null;
  const where = and(or(sql`${signals.orgId} IS NULL`, eq(signals.orgId, oid)), q.type ? inArray(signals.type, boundedCsv(q.type)) : sql`true`, p ? sql`(${signals.title} ILIKE ${p} OR ${signals.companyName} ILIKE ${p})` : sql`true`, q.matched === "true" ? sql`${signalMatches.signalId} IS NOT NULL` : sql`true`, sql`${signals.createdAt} > now() - (${q.days} || ' days')::interval`);
  const rows = await boundedRead(db, (tx) =>
    tx
      .select({ s: signals, match: signalMatches })
      .from(signals)
      .leftJoin(signalMatches, and(eq(signalMatches.signalId, signals.id), eq(signalMatches.orgId, oid)))
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.limit),
  );
  return c.json({ signals: rows.map((r) => ({ ...r.s, match: r.match })) });
});

signalRoutes.get("/types", (c) => c.json({ types: SIGNAL_TYPES }));

/**
 * Re-check tracked leads for a job change.
 *
 * Rate-limited because it spends a provider enrichment call per lead. Only leads the org
 * has actually engaged, or that score well against the ICP, are re-checked - and only if
 * they have not been confirmed recently.
 */
signalRoutes.post(
  "/job-changes/scan",
  rateLimit({ perMinute: 4 }),
  zValidator("json", z.object({ limit: z.coerce.number().min(1).max(500).default(50), minScore: z.coerce.number().min(0).max(100).default(70), staleDays: z.coerce.number().min(1).max(365).default(30), retryDays: z.coerce.number().min(1).max(365).default(3) }).optional()),
  async (c) => {
    const b = c.req.valid("json") ?? {};
    // Each re-check is a paid provider lookup, so it is held to the plan's premium budget
    // like every other paid lookup. A zero budget answers planLimited without calling anyone.
    const r = await scanJobChanges(orgId(c), { ...b, premiumBudget: await remainingPremiumBudget(getDb().db, orgId(c)) });
    // 502 when nothing answered: "nobody moved" and "we could not ask" are different
    // answers and only one of them is about the customer's market.
    return c.json(r, r.blocked ? 502 : 200);
  },
);

/** The job-change feed: who moved, from where to where, and what it means. */
signalRoutes.get("/job-changes", zValidator("query", z.object({ days: z.coerce.number().min(1).max(365).default(90), limit: z.coerce.number().min(1).max(200).default(50) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select()
    .from(signals)
    .where(and(eq(signals.orgId, orgId(c)), eq(signals.type, "job_change"), sql`${signals.createdAt} > now() - (${q.days} || ' days')::interval`))
    .orderBy(desc(signals.createdAt))
    .limit(q.limit);
  return c.json({ changes: rows });
});

/** Trigger a global scan now (no subscription needed) - useful for demos and agents. */
// The scan searches news, and job_change is not discoverable that way - it is derived by
// re-checking leads we already track. It stays out of this endpoint's enum while remaining
// a valid filter and subscription type elsewhere.
const SCANNABLE_TYPES = ["funding", "acquisition", "hiring", "leadership", "expansion", "launch", "partnership", "news"] as const;

signalRoutes.post("/scan", rateLimit({ perMinute: 6, name: "signal-scan" }), zValidator("json", z.object({ types: z.array(z.enum(SCANNABLE_TYPES)).max(SCANNABLE_TYPES.length).default(["funding", "acquisition"]), keywords: z.array(z.string().max(200)).max(50).default([]), industries: z.array(z.string().max(200)).max(50).default([]), locations: z.array(z.string().max(200)).max(50).default([]), days: z.number().int().min(1).max(30).default(7) })), async (c) => {
  const b = c.req.valid("json");
  const { scanSignals } = await import("@prospex/core");
  const { storeSignals } = await import("../services/signals.js");
  const parsed = await scanSignals({ ...b, maxPerQuery: 20 });
  const stored = await storeSignals(parsed, null);
  return c.json({ parsed: parsed.length, stored: stored.length, signals: parsed.slice(0, 100) });
});

// ── Subscriptions ──
const sigTerms = z.array(z.string().max(200)).max(50);
const subInput = z.object({ name: z.string().min(1).max(200), types: z.array(z.enum(SIGNAL_TYPES)).min(1).max(SIGNAL_TYPES.length), keywords: sigTerms.default([]), industries: sigTerms.default([]), locations: sigTerms.default([]), icpId: z.string().uuid().nullish(), targetTitles: sigTerms.default(["CEO", "Founder", "Head of Sales", "Head of Marketing"]), autoCreateLeads: z.boolean().default(false), campaignId: z.string().uuid().nullish(), active: z.boolean().default(true) });

signalRoutes.get("/subscriptions", async (c) => {
  const { db } = getDb();
  return c.json({ subscriptions: await db.select().from(signalSubscriptions).where(eq(signalSubscriptions.orgId, orgId(c))).orderBy(desc(signalSubscriptions.createdAt)) });
});
signalRoutes.post("/subscriptions", zValidator("json", subInput), async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const b = c.req.valid("json");
  await assertRowCap(db, signalSubscriptions, oid, "signalSubscriptions");
  // A subscription with autoCreateLeads enrolls into this campaign. Without this check a
  // foreign campaign id would put our leads into someone else's sequence, which emails them.
  await assertOwned(campaigns, b.campaignId, oid, "Campaign", c);
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  const [row] = await db.insert(signalSubscriptions).values({ orgId: oid, ...b }).returning();
  await guardJobCapacity(db, oid, "signals.subscription");
  await enqueue(db, "signals.subscription", { subscriptionId: row.id }, { orgId: row.orgId, priority: 2 });
  return c.json(row, 201);
});
signalRoutes.patch("/subscriptions/:id", zValidator("json", subInput.partial()), async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const b = c.req.valid("json");
  requireSomeFields(b);
  await assertOwned(campaigns, b.campaignId, oid, "Campaign", c);
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  const [row] = await db.update(signalSubscriptions).set(b).where(and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, oid))).returning();
  if (!row) throw notFound("Subscription");
  return c.json(row);
});
signalRoutes.delete("/subscriptions/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(signalSubscriptions).where(and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, orgId(c)))).returning({ id: signalSubscriptions.id });
  if (!gone.length) throw notFound("Subscription");
  return c.json({ ok: true });
});
signalRoutes.post("/subscriptions/:id/run", rateLimit({ perMinute: 6, name: "subscription-run" }), async (c) => {
  const { db } = getDb();
  const sub = await db.query.signalSubscriptions.findFirst({ where: and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, orgId(c))) });
  if (!sub) throw notFound("Subscription");
  return c.json(await runSubscription(sub));
});

// ── Monitors ──
/** A monitor's free-form options: small, and without keys that reach a prototype. */
const monitorConfig = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= 5000, { message: "Monitor options are too large" })
  .transform((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !["__proto__", "constructor", "prototype"].includes(k))));
const monitorInput = z.object({ type: z.enum(["linkedin_post", "keyword", "competitor", "company_news", "jobs"]), name: z.string().min(1).max(200), target: z.string().min(1).max(2000), config: monitorConfig.default({}), intervalMinutes: z.number().int().min(30).max(10080).default(360), active: z.boolean().default(true) });

signalRoutes.get("/monitors", async (c) => {
  const { db } = getDb();
  return c.json({ monitors: await db.select().from(monitors).where(eq(monitors.orgId, orgId(c))).orderBy(desc(monitors.createdAt)) });
});
/** A linkedin_post monitor fetches its target, so the target must be a LinkedIn post URL. */
function assertMonitorTarget(type: string | undefined, target: string | undefined) {
  if (type === "linkedin_post" && target !== undefined && !normalizeLinkedinPostUrl(target)) {
    throw new ApiError(400, "A LinkedIn post monitor needs a linkedin.com post URL (https://www.linkedin.com/posts/... or /feed/update/...).", "bad_request");
  }
}

signalRoutes.post("/monitors", zValidator("json", monitorInput), async (c) => {
  const { db } = getDb();
  await assertRowCap(db, monitors, orgId(c), "monitors");
  assertMonitorTarget(c.req.valid("json").type, c.req.valid("json").target);
  const [row] = await db.insert(monitors).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  await guardJobCapacity(db, orgId(c), "monitor.run");
  await enqueue(db, "monitor.run", { monitorId: row.id }, { orgId: row.orgId, priority: 2 });
  return c.json(row, 201);
});
signalRoutes.patch("/monitors/:id", zValidator("json", monitorInput.partial()), async (c) => {
  const { db } = getDb();
  requireSomeFields(c.req.valid("json"));
  {
    // The target is judged against the type it will have AFTER this patch.
    const patch = c.req.valid("json");
    if (patch.type !== undefined || patch.target !== undefined) {
      const cur = await db.query.monitors.findFirst({ where: and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c))) });
      if (!cur) throw notFound("Monitor");
      assertMonitorTarget(patch.type ?? cur.type, patch.target ?? cur.target);
    }
  }
  const [row] = await db.update(monitors).set(c.req.valid("json")).where(and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Monitor");
  return c.json(row);
});
signalRoutes.delete("/monitors/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(monitors).where(and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c)))).returning({ id: monitors.id });
  if (!gone.length) throw notFound("Monitor");
  return c.json({ ok: true });
});
signalRoutes.post("/monitors/:id/run", rateLimit({ perMinute: 6, name: "monitor-run" }), async (c) => {
  const { db } = getDb();
  const m = await db.query.monitors.findFirst({ where: and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c))) });
  if (!m) throw notFound("Monitor");
  return c.json(await runMonitor(m));
});
signalRoutes.get("/monitors/:id/results", async (c) => {
  const { db } = getDb();
  // A monitor that is not this workspace's is a 404, like every other monitor route. It
  // used to be a 200 with an empty list - "this monitor found nothing" about a monitor the
  // caller cannot see.
  const m = await db.query.monitors.findFirst({ where: and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c))) });
  if (!m) throw notFound("Monitor");
  const rows = await db.select().from(monitorResults).where(and(eq(monitorResults.monitorId, m.id), eq(monitorResults.orgId, orgId(c)))).orderBy(desc(monitorResults.foundAt)).limit(300);
  return c.json({ results: rows });
});
