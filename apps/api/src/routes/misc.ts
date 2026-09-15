import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import Stripe from "stripe";
import { and, desc, enqueue, eq, events, getDb, getUsage, integrations, leads, limitsFor, messages, organizations, PLANS, sql, webhooks, companies, campaigns } from "@getleads/db";
import { env } from "../env.js";
import { encryptJson, randomToken } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { orgId, requireAuth, requireUser, type Env } from "../middleware.js";
import { INTEGRATION_PROVIDERS } from "../services/integrations.js";
/** Channel/data providers configured via the same integrations table (config-only, no lead sync). */
const CHANNEL_PROVIDERS = ["whatsapp", "apollo", "hunter", "pdl", "ipinfo"];

export const miscRoutes = new Hono<Env>();

// ── Usage + analytics ──
miscRoutes.get("/usage", requireAuth, async (c) => c.json(await getUsage(getDb().db, orgId(c))));

miscRoutes.get("/analytics/overview", requireAuth, async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const [l] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(*) FILTER (WHERE email IS NOT NULL)::int`,
      verified: sql<number>`count(*) FILTER (WHERE email_status = 'valid')::int`,
      last7d: sql<number>`count(*) FILTER (WHERE created_at > now() - interval '7 days')::int`,
      avgScore: sql<number>`coalesce(round(avg(score))::int, 0)`,
    })
    .from(leads)
    .where(eq(leads.orgId, oid));
  const [m] = await db
    .select({
      sent: sql<number>`count(*) FILTER (WHERE direction='outbound' AND sent_at IS NOT NULL)::int`,
      opened: sql<number>`count(*) FILTER (WHERE opened_at IS NOT NULL)::int`,
      clicked: sql<number>`count(*) FILTER (WHERE clicked_at IS NOT NULL)::int`,
      replied: sql<number>`count(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
    })
    .from(messages)
    .where(eq(messages.orgId, oid));
  const [co] = await db.select({ n: sql<number>`count(*)::int` }).from(companies).where(eq(companies.orgId, oid));
  const [cp] = await db.select({ active: sql<number>`count(*) FILTER (WHERE status='active')::int`, total: sql<number>`count(*)::int` }).from(campaigns).where(eq(campaigns.orgId, oid));
  const daily = await db.execute(sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM leads WHERE org_id = ${oid} AND created_at::date = d)::int AS leads,
      (SELECT count(*) FROM messages WHERE org_id = ${oid} AND sent_at::date = d)::int AS sent,
      (SELECT count(*) FROM messages WHERE org_id = ${oid} AND replied_at::date = d)::int AS replied
    FROM generate_series((now() - interval '29 days')::date, now()::date, '1 day') d ORDER BY d`);
  const byStatus = await db.select({ status: leads.emailStatus, n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.orgId, oid)).groupBy(leads.emailStatus);
  const topCompanies = await db
    .select({ name: companies.name, domain: companies.domain, n: sql<number>`count(${leads.id})::int` })
    .from(companies)
    .leftJoin(leads, eq(leads.companyId, companies.id))
    .where(eq(companies.orgId, oid))
    .groupBy(companies.id)
    .orderBy(desc(sql`count(${leads.id})`))
    .limit(10);
  return c.json({ leads: l, messages: m, companies: co.n, campaigns: cp, daily: (daily as unknown as { rows?: unknown[] }).rows ?? daily, emailStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), topCompanies, usage: await getUsage(db, oid) });
});

miscRoutes.get("/events", requireAuth, zValidator("query", z.object({ type: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(50) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db.select().from(events).where(and(eq(events.orgId, orgId(c)), q.type ? eq(events.type, q.type) : sql`true`)).orderBy(desc(events.createdAt)).limit(q.limit);
  return c.json({ events: rows });
});

// ── Webhooks ──
miscRoutes.get("/webhooks", requireAuth, async (c) => {
  const { db } = getDb();
  return c.json({ webhooks: await db.select().from(webhooks).where(eq(webhooks.orgId, orgId(c))).orderBy(desc(webhooks.createdAt)) });
});
miscRoutes.post("/webhooks", requireAuth, zValidator("json", z.object({ url: z.string().url(), events: z.array(z.string()).default(["*"]) })), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(webhooks).values({ orgId: orgId(c), url: c.req.valid("json").url, events: c.req.valid("json").events, secret: randomToken(24) }).returning();
  return c.json(row, 201);
});
miscRoutes.delete("/webhooks/:id", requireAuth, async (c) => {
  const { db } = getDb();
  await db.delete(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c))));
  return c.json({ ok: true });
});
miscRoutes.post("/webhooks/:id/test", requireAuth, async (c) => {
  const { db } = getDb();
  const hook = await db.query.webhooks.findFirst({ where: and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c))) });
  if (!hook) throw notFound("Webhook");
  const { emitEvent } = await import("../lib/events.js");
  await emitEvent(hook.orgId, "webhook.test", { hello: "world" });
  return c.json({ queued: true });
});

// ── Integrations (CRM) ──
miscRoutes.get("/integrations", requireAuth, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(integrations).where(eq(integrations.orgId, orgId(c)));
  return c.json({ integrations: rows.map(({ configEncrypted: _x, ...r }) => r), providers: INTEGRATION_PROVIDERS, channelProviders: CHANNEL_PROVIDERS });
});
miscRoutes.put("/integrations/:provider", requireAuth, zValidator("json", z.object({ config: z.record(z.string()), settings: z.record(z.unknown()).optional(), autoSync: z.boolean().default(false) })), async (c) => {
  const provider = c.req.param("provider");
  if (!INTEGRATION_PROVIDERS.includes(provider) && !CHANNEL_PROVIDERS.includes(provider)) throw badRequest(`Unknown provider. Supported: ${[...INTEGRATION_PROVIDERS, ...CHANNEL_PROVIDERS].join(", ")}`);
  const b = c.req.valid("json");
  const { db } = getDb();
  const [row] = await db
    .insert(integrations)
    .values({ orgId: orgId(c), provider, configEncrypted: encryptJson(b.config), settings: { ...(b.settings ?? {}), autoSync: b.autoSync }, status: "active" })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: { configEncrypted: encryptJson(b.config), settings: { ...(b.settings ?? {}), autoSync: b.autoSync }, status: "active" } })
    .returning();
  const { configEncrypted: _x, ...pub } = row;
  return c.json(pub);
});
miscRoutes.delete("/integrations/:provider", requireAuth, async (c) => {
  const { db } = getDb();
  await db.delete(integrations).where(and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, orgId(c))));
  return c.json({ ok: true });
});
miscRoutes.post("/integrations/:provider/sync", requireAuth, zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).min(1).max(500) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, oid)) });
  if (!integ) throw notFound("Integration");
  for (const leadId of c.req.valid("json").leadIds) await enqueue(db, "integration.sync", { integrationId: integ.id, leadId }, { orgId: oid, maxAttempts: 3 });
  return c.json({ queued: c.req.valid("json").leadIds.length }, 202);
});

// ── Billing (optional Stripe; pilot is free) ──
miscRoutes.get("/billing/plans", (c) => c.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), stripeEnabled: !!env.stripe.secretKey, pilotMode: env.pilotMode }));

miscRoutes.post("/billing/checkout", requireAuth, requireUser, zValidator("json", z.object({ plan: z.string() })), async (c) => {
  if (!env.stripe.secretKey) throw badRequest("Stripe is not configured");
  const stripe = new Stripe(env.stripe.secretKey);
  const a = c.get("auth");
  const requestedPlan = c.req.valid("json").plan;
  if (!PLANS[requestedPlan]) throw badRequest(`Unknown plan "${requestedPlan}"`);
  const price = env.stripe.priceForPlan(requestedPlan);
  if (!price) throw badRequest(`Stripe price id not configured for plan "${requestedPlan}" (set STRIPE_PRICE_${requestedPlan.toUpperCase()})`);
  const { db } = getDb();
  let customer = a.org.stripeCustomerId;
  if (!customer) {
    const cu = await stripe.customers.create({ email: a.user!.email, name: a.org.name, metadata: { orgId: a.org.id } });
    customer = cu.id;
    await db.update(organizations).set({ stripeCustomerId: customer }).where(eq(organizations.id, a.org.id));
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    success_url: `${env.appUrl}/settings/billing?success=1`,
    cancel_url: `${env.appUrl}/settings/billing?canceled=1`,
    metadata: { orgId: a.org.id, plan: c.req.valid("json").plan },
  });
  return c.json({ url: session.url });
});

miscRoutes.post("/billing/webhook", async (c) => {
  if (!env.stripe.secretKey || !env.stripe.webhookSecret) return c.json({ ignored: true });
  const stripe = new Stripe(env.stripe.secretKey);
  const sig = c.req.header("stripe-signature") ?? "";
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await c.req.text(), sig, env.stripe.webhookSecret);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { db } = getDb();
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const orgId = s.metadata?.orgId;
    const plan = s.metadata?.plan ?? "pro";
    if (orgId) await db.update(organizations).set({ plan, planLimits: limitsFor(plan), stripeSubscriptionId: String(s.subscription ?? "") }).where(eq(organizations.id, orgId));
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    await db.update(organizations).set({ plan: "free", planLimits: limitsFor("free"), stripeSubscriptionId: null }).where(eq(organizations.stripeCustomerId, String(sub.customer)));
  }
  return c.json({ received: true });
});

/** Admin: set an org's plan directly (for pilot management). Requires INTERNAL_TOKEN. */
miscRoutes.post("/admin/orgs/:id/plan", zValidator("json", z.object({ plan: z.string(), overrides: z.record(z.unknown()).optional() })), async (c) => {
  if (!env.internalToken || c.req.header("x-internal-token") !== env.internalToken) return c.json({ error: { code: "forbidden", message: "internal token required" } }, 403);
  const b = c.req.valid("json");
  const { db } = getDb();
  const [row] = await db.update(organizations).set({ plan: b.plan, planLimits: { ...limitsFor(b.plan), ...(b.overrides ?? {}) } }).where(eq(organizations.id, c.req.param("id"))).returning();
  if (!row) throw notFound("Org");
  return c.json({ id: row.id, plan: row.plan, limits: row.planLimits });
});

miscRoutes.get("/admin/orgs", async (c) => {
  if (!env.internalToken || c.req.header("x-internal-token") !== env.internalToken) return c.json({ error: { code: "forbidden", message: "internal token required" } }, 403);
  const { db } = getDb();
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan, createdAt: organizations.createdAt, leads: sql<number>`(SELECT count(*)::int FROM leads WHERE org_id = ${organizations.id})`, users: sql<number>`(SELECT count(*)::int FROM users WHERE org_id = ${organizations.id})` })
    .from(organizations)
    .orderBy(desc(organizations.createdAt))
    .limit(500);
  return c.json({ orgs: rows });
});
