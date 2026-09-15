import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, enqueue, eq, getDb, inArray, monitorResults, monitors, or, signalMatches, signalSubscriptions, signals, sql } from "@prospex/db";
import { notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { runSubscription } from "../services/signals.js";
import { runMonitor } from "../services/monitors.js";

export const signalRoutes = new Hono<Env>();
signalRoutes.use("*", requireAuth);

const SIGNAL_TYPES = ["funding", "acquisition", "hiring", "leadership", "expansion", "launch", "partnership", "news"] as const;

/** Signal feed: global signals + matches for this org. */
signalRoutes.get("/", zValidator("query", z.object({ type: z.string().optional(), q: z.string().optional(), matched: z.enum(["true", "false"]).optional(), days: z.coerce.number().default(14), limit: z.coerce.number().max(500).default(100) })), async (c) => {
  const q = c.req.valid("query");
  const oid = orgId(c);
  const { db } = getDb();
  const rows = await db
    .select({ s: signals, match: signalMatches })
    .from(signals)
    .leftJoin(signalMatches, and(eq(signalMatches.signalId, signals.id), eq(signalMatches.orgId, oid)))
    .where(and(or(sql`${signals.orgId} IS NULL`, eq(signals.orgId, oid)), q.type ? inArray(signals.type, q.type.split(",")) : sql`true`, q.q ? sql`(${signals.title} ILIKE ${"%" + q.q + "%"} OR ${signals.companyName} ILIKE ${"%" + q.q + "%"})` : sql`true`, q.matched === "true" ? sql`${signalMatches.signalId} IS NOT NULL` : sql`true`, sql`${signals.createdAt} > now() - (${q.days} || ' days')::interval`))
    .orderBy(desc(signals.createdAt))
    .limit(q.limit);
  return c.json({ signals: rows.map((r) => ({ ...r.s, match: r.match })) });
});

signalRoutes.get("/types", (c) => c.json({ types: SIGNAL_TYPES }));

/** Trigger a global scan now (no subscription needed) - useful for demos and agents. */
signalRoutes.post("/scan", zValidator("json", z.object({ types: z.array(z.enum(SIGNAL_TYPES)).default(["funding", "acquisition"]), keywords: z.array(z.string()).default([]), industries: z.array(z.string()).default([]), locations: z.array(z.string()).default([]), days: z.number().int().min(1).max(30).default(7) })), async (c) => {
  const b = c.req.valid("json");
  const { scanSignals } = await import("@prospex/core");
  const { storeSignals } = await import("../services/signals.js");
  const parsed = await scanSignals({ ...b, maxPerQuery: 20 });
  const stored = await storeSignals(parsed, null);
  return c.json({ parsed: parsed.length, stored: stored.length, signals: parsed.slice(0, 100) });
});

// ── Subscriptions ──
const subInput = z.object({ name: z.string().min(1), types: z.array(z.enum(SIGNAL_TYPES)).min(1), keywords: z.array(z.string()).default([]), industries: z.array(z.string()).default([]), locations: z.array(z.string()).default([]), icpId: z.string().uuid().optional(), targetTitles: z.array(z.string()).default(["CEO", "Founder", "Head of Sales", "Head of Marketing"]), autoCreateLeads: z.boolean().default(false), campaignId: z.string().uuid().optional(), active: z.boolean().default(true) });

signalRoutes.get("/subscriptions", async (c) => {
  const { db } = getDb();
  return c.json({ subscriptions: await db.select().from(signalSubscriptions).where(eq(signalSubscriptions.orgId, orgId(c))).orderBy(desc(signalSubscriptions.createdAt)) });
});
signalRoutes.post("/subscriptions", zValidator("json", subInput), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(signalSubscriptions).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  await enqueue(db, "signals.subscription", { subscriptionId: row.id }, { orgId: row.orgId, priority: 2 });
  return c.json(row, 201);
});
signalRoutes.patch("/subscriptions/:id", zValidator("json", subInput.partial()), async (c) => {
  const { db } = getDb();
  const [row] = await db.update(signalSubscriptions).set(c.req.valid("json")).where(and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Subscription");
  return c.json(row);
});
signalRoutes.delete("/subscriptions/:id", async (c) => {
  const { db } = getDb();
  await db.delete(signalSubscriptions).where(and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, orgId(c))));
  return c.json({ ok: true });
});
signalRoutes.post("/subscriptions/:id/run", async (c) => {
  const { db } = getDb();
  const sub = await db.query.signalSubscriptions.findFirst({ where: and(eq(signalSubscriptions.id, c.req.param("id")), eq(signalSubscriptions.orgId, orgId(c))) });
  if (!sub) throw notFound("Subscription");
  return c.json(await runSubscription(sub));
});

// ── Monitors ──
const monitorInput = z.object({ type: z.enum(["linkedin_post", "keyword", "competitor", "company_news", "jobs"]), name: z.string().min(1), target: z.string().min(1), config: z.record(z.unknown()).default({}), intervalMinutes: z.number().int().min(30).max(10080).default(360), active: z.boolean().default(true) });

signalRoutes.get("/monitors", async (c) => {
  const { db } = getDb();
  return c.json({ monitors: await db.select().from(monitors).where(eq(monitors.orgId, orgId(c))).orderBy(desc(monitors.createdAt)) });
});
signalRoutes.post("/monitors", zValidator("json", monitorInput), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(monitors).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  await enqueue(db, "monitor.run", { monitorId: row.id }, { orgId: row.orgId, priority: 2 });
  return c.json(row, 201);
});
signalRoutes.patch("/monitors/:id", zValidator("json", monitorInput.partial()), async (c) => {
  const { db } = getDb();
  const [row] = await db.update(monitors).set(c.req.valid("json")).where(and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Monitor");
  return c.json(row);
});
signalRoutes.delete("/monitors/:id", async (c) => {
  const { db } = getDb();
  await db.delete(monitors).where(and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c))));
  return c.json({ ok: true });
});
signalRoutes.post("/monitors/:id/run", async (c) => {
  const { db } = getDb();
  const m = await db.query.monitors.findFirst({ where: and(eq(monitors.id, c.req.param("id")), eq(monitors.orgId, orgId(c))) });
  if (!m) throw notFound("Monitor");
  return c.json(await runMonitor(m));
});
signalRoutes.get("/monitors/:id/results", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(monitorResults).where(and(eq(monitorResults.monitorId, c.req.param("id")), eq(monitorResults.orgId, orgId(c)))).orderBy(desc(monitorResults.foundAt)).limit(300);
  return c.json({ results: rows });
});
