import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import Stripe from "stripe";
import { isPublicHost } from "@prospex/core";
import { and, desc, emailAccounts, enqueue, eq, events, getDb, getUsage, inArray, integrations, leads, limitsFor, messages, organizations, PLANS, sql, webhooks, companies, campaigns } from "@prospex/db";
import { sendingHealthForAccount } from "../services/campaigns.js";
import { icpLearningFor } from "../services/insights.js";
import { env } from "../env.js";
import { campaignAttribution, leadFunnel, sourcePerformance } from "../services/analytics.js";
import { encryptJson, randomToken } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { orgId, requireAuth, requireRole, requireUser, type Env } from "../middleware.js";
import { INTEGRATION_PROVIDERS } from "../services/integrations.js";
/** Channel/data providers configured via the same integrations table (config-only, no lead sync). */
const CHANNEL_PROVIDERS = ["whatsapp", "apollo", "hunter", "pdl", "ipinfo"];
/** Credential fields each provider cannot work without (what its sync/send reads). */
const REQUIRED_CREDENTIALS: Record<string, string[]> = {
  hubspot: ["accessToken"],
  pipedrive: ["apiToken"],
  zoho: ["accessToken"],
  cortex: ["url"],
  webhook: ["url"],
  sheets: ["url"],
  whatsapp: ["phoneNumberId", "accessToken"],
};
const CREDENTIAL_LABELS: Record<string, string> = { accessToken: "access token", apiToken: "API token", url: "URL", phoneNumberId: "phone number ID" };

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

/**
 * Where leads stall.
 *
 * Stage-to-stage conversion, plus the single biggest drop-off, which is the only
 * actionable thing in a funnel. Below 20 leads in the window the rates are withheld rather
 * than printed, because at that size one lead moves a rate by five points.
 */
miscRoutes.get("/analytics/funnel", requireAuth, zValidator("query", z.object({ days: z.coerce.number().min(1).max(365).default(90) })), async (c) =>
  c.json(await leadFunnel(orgId(c), c.req.valid("query").days)),
);

/** Which sources produce leads that go somewhere - and which just produce volume. */
miscRoutes.get("/analytics/sources", requireAuth, zValidator("query", z.object({ days: z.coerce.number().min(1).max(365).default(90) })), async (c) =>
  c.json(await sourcePerformance(orgId(c), c.req.valid("query").days)),
);

/** Which campaign, and which step within it, produced the reply. */
miscRoutes.get("/analytics/attribution", requireAuth, zValidator("query", z.object({ days: z.coerce.number().min(1).max(365).default(90) })), async (c) =>
  c.json(await campaignAttribution(orgId(c), c.req.valid("query").days)),
);

/**
 * What your send history says your ICP actually is, as opposed to what you declared.
 *
 * Buckets deliberately use the inferred/normalized attributes (seniority, department,
 * industry, size, country) rather than raw job titles: raw titles are too high-cardinality
 * to ever reach a statistically meaningful group size.
 */
miscRoutes.get("/analytics/icp-learning", requireAuth, async (c) => {
  return c.json(await icpLearningFor(getDb().db, orgId(c)));
});

/**
 * Live deliverability verdict per sending identity. `status: "halt"` is enforced by the
 * campaign scheduler, not just displayed here.
 */
miscRoutes.get("/analytics/sending-health", requireAuth, async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.orgId, oid));
  const out = [];
  for (const a of accounts) {
    out.push({
      account: { id: a.id, fromEmail: a.fromEmail, dailyLimit: a.dailyLimit, status: a.status },
      health: await sendingHealthForAccount(db, oid, a),
    });
  }
  return c.json({ accounts: out });
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
/** The full signing secret is in this response - shown once at creation, as with API keys. */
miscRoutes.post("/webhooks", requireAuth, requireRole("owner", "admin"), zValidator("json", z.object({ url: z.string().url(), events: z.array(z.string()).default(["*"]) })), async (c) => {
  const url = c.req.valid("json").url;
  // Deliveries to a non-public address are always skipped (SSRF guard in webhook.deliver),
  // so accepting one created a webhook that silently never fired. Refused up front; in local
  // development it is allowed, with a warning saying deliveries will be skipped.
  let warning: string | undefined;
  if (!/^https?:\/\//i.test(url)) throw badRequest("Webhook URL must start with http:// or https://");
  if (!isPublicHost(url, { allowUserinfo: true })) {
    const msg = `${url} is not a public address (localhost, private network or internal host), so Scout cannot deliver to it.`;
    if (env.nodeEnv !== "development") throw badRequest(`${msg} Use a URL reachable from the internet.`);
    warning = `${msg} Saved because this server runs in development mode, but deliveries to it will be skipped.`;
  }
  const { db } = getDb();
  const [row] = await db.insert(webhooks).values({ orgId: orgId(c), url, events: c.req.valid("json").events, secret: randomToken(24) }).returning();
  return c.json(warning ? { ...row, warning } : row, 201);
});
miscRoutes.delete("/webhooks/:id", requireAuth, requireRole("owner", "admin"), async (c) => {
  const { db } = getDb();
  const gone = await db.delete(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c)))).returning({ id: webhooks.id });
  if (!gone.length) throw notFound("Webhook");
  return c.json({ ok: true });
});
/**
 * Send a test event to THIS webhook.
 *
 * It used to emit a `webhook.test` event to the whole org, which went to every hook
 * subscribed to "*" - and to none at all for the hook being tested if it listened to, say,
 * `lead.*` only. The Test button reported "queued" either way. Now it is delivered to the
 * one hook asked about, whatever its event filter.
 */
miscRoutes.post("/webhooks/:id/test", requireAuth, requireRole("owner", "admin"), async (c) => {
  const { db } = getDb();
  const hook = await db.query.webhooks.findFirst({ where: and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c))) });
  if (!hook) throw notFound("Webhook");
  const [ev] = await db.insert(events).values({ orgId: hook.orgId, type: "webhook.test", data: { hello: "world", webhookId: hook.id } }).returning();
  const job = await enqueue(db, "webhook.deliver", { webhookId: hook.id, eventId: ev.id }, { orgId: hook.orgId, maxAttempts: 1 });
  return c.json({ queued: true, webhookId: hook.id, eventId: ev.id, jobId: job.id, active: hook.active, note: hook.active ? undefined : "This webhook is disabled (too many failures); the test is sent anyway." });
});

// ── Integrations (CRM) ──
miscRoutes.get("/integrations", requireAuth, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(integrations).where(eq(integrations.orgId, orgId(c)));
  return c.json({ integrations: rows.map(({ configEncrypted: _x, ...r }) => r), providers: INTEGRATION_PROVIDERS, channelProviders: CHANNEL_PROVIDERS });
});
miscRoutes.put("/integrations/:provider", requireAuth, requireRole("owner", "admin"), zValidator("json", z.object({ config: z.record(z.string()), settings: z.record(z.unknown()).optional(), autoSync: z.boolean().default(false) })), async (c) => {
  const provider = c.req.param("provider");
  if (!INTEGRATION_PROVIDERS.includes(provider) && !CHANNEL_PROVIDERS.includes(provider)) throw badRequest(`Unknown provider. Supported: ${[...INTEGRATION_PROVIDERS, ...CHANNEL_PROVIDERS].join(", ")}`);
  const b = c.req.valid("json");
  // Credentials are checked before anything is saved. An empty token used to be stored and
  // reported "Connected", and every sync after that failed with nothing pointing at why.
  const config = Object.fromEntries(Object.entries(b.config).map(([k, v]) => [k, v.trim()]));
  const required = REQUIRED_CREDENTIALS[provider] ?? [];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) throw badRequest(`Missing ${missing.map((k) => CREDENTIAL_LABELS[k] ?? k).join(", ")}: fill in ${missing.length === 1 ? "this field" : "these fields"} to connect ${provider}.`, { missing });
  if (!required.length && !Object.values(config).some(Boolean)) throw badRequest(`Enter the credentials for ${provider} before saving the connection.`);
  if (config.url && !/^https?:\/\/[^\s]+$/i.test(config.url)) throw badRequest("URL must be a full http(s):// address.");
  b.config = config;
  const { db } = getDb();
  const [row] = await db
    .insert(integrations)
    .values({ orgId: orgId(c), provider, configEncrypted: encryptJson(b.config), settings: { ...(b.settings ?? {}), autoSync: b.autoSync }, status: "active" })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: { configEncrypted: encryptJson(b.config), settings: { ...(b.settings ?? {}), autoSync: b.autoSync }, status: "active" } })
    .returning();
  const { configEncrypted: _x, ...pub } = row;
  return c.json(pub);
});
miscRoutes.delete("/integrations/:provider", requireAuth, requireRole("owner", "admin"), async (c) => {
  const { db } = getDb();
  const gone = await db.delete(integrations).where(and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, orgId(c)))).returning({ id: integrations.id });
  if (!gone.length) throw notFound("Integration");
  return c.json({ ok: true });
});
miscRoutes.post("/integrations/:provider/sync", requireAuth, zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).min(1).max(500) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, oid)) });
  if (!integ) throw notFound("Integration");
  // Only this workspace's leads are queued. The job rejects any other id, so counting them
  // as queued reported work that was never going to happen.
  const requested = [...new Set(c.req.valid("json").leadIds)];
  const owned = (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, requested)))).map((r) => r.id);
  for (const leadId of owned) await enqueue(db, "integration.sync", { integrationId: integ.id, leadId }, { orgId: oid, maxAttempts: 3 });
  return c.json({ queued: owned.length, requested: requested.length, notFound: requested.length - owned.length }, 202);
});

// ── Billing (optional Stripe; pilot is free) ──
miscRoutes.get("/billing/plans", (c) => c.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), stripeEnabled: !!env.stripe.secretKey, pilotMode: env.pilotMode }));

miscRoutes.post("/billing/checkout", requireAuth, requireUser, requireRole("owner", "admin"), zValidator("json", z.object({ plan: z.string() })), async (c) => {
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
  /**
   * Plan changes only ever land on a plan that exists. The old fallback to "pro" for a
   * session with no plan in its metadata set a plan id that is not in PLANS, so the org got
   * `limitsFor("pro")` - whatever that resolves to - and an admin page that could not name
   * its plan. An unknown plan is logged and left alone, for a person to sort out.
   */
  /**
   * Admin overrides are stored merged into planLimits (admin.ts PATCH /orgs/:id/plan writes
   * `{ ...limitsFor(plan), ...overrides }`), so they are whatever differs from the plan's defaults.
   */
  const adminOverrides = (oldPlan: string, current: unknown): Record<string, unknown> => {
    const defaults = limitsFor(oldPlan) as unknown as Record<string, unknown>;
    const cur = (current ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(cur).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])));
  };
  const planForPrice = (priceId: string | undefined | null) => (priceId ? Object.keys(PLANS).find((p) => env.stripe.priceForPlan(p) === priceId) : undefined);
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const orgId = s.metadata?.orgId;
    const plan = s.metadata?.plan;
    if (orgId && plan && PLANS[plan]) {
      await db.update(organizations).set({ plan, planLimits: limitsFor(plan), stripeSubscriptionId: String(s.subscription ?? "") }).where(eq(organizations.id, orgId));
    } else if (orgId) {
      console.error(`[billing] checkout ${s.id} for org ${orgId} names unknown plan ${JSON.stringify(plan)}; plan NOT changed`);
      await db.update(organizations).set({ stripeSubscriptionId: String(s.subscription ?? "") }).where(eq(organizations.id, orgId));
    }
  }
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const customer = String(sub.customer);
    if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
      await db.update(organizations).set({ plan: "free", planLimits: limitsFor("free"), stripeSubscriptionId: null }).where(eq(organizations.stripeCustomerId, customer));
    } else if (sub.status === "active" || sub.status === "trialing") {
      // A plan switch made in the Stripe portal arrives here, as a new price on the item.
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planForPrice(priceId);
      if (plan) {
        // This event fires on every renewal, not just plan switches. Rewriting planLimits
        // each time wiped whatever an admin had granted. Same plan: only the subscription id
        // is refreshed. New plan: the new plan's limits, with admin overrides carried over.
        const orgs = await db.query.organizations.findMany({ where: eq(organizations.stripeCustomerId, customer) });
        for (const org of orgs) {
          if (org.plan === plan) {
            if (org.stripeSubscriptionId !== sub.id) await db.update(organizations).set({ stripeSubscriptionId: sub.id }).where(eq(organizations.id, org.id));
            continue;
          }
          await db.update(organizations).set({ plan, planLimits: { ...limitsFor(plan), ...adminOverrides(org.plan, org.planLimits) }, stripeSubscriptionId: sub.id }).where(eq(organizations.id, org.id));
        }
      } else console.error(`[billing] subscription ${sub.id} has price ${priceId} that maps to no STRIPE_PRICE_<PLAN>; plan NOT changed`);
    }
    // past_due and incomplete: Stripe is still retrying payment; nothing changes yet.
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    await db.update(organizations).set({ plan: "free", planLimits: limitsFor("free"), stripeSubscriptionId: null }).where(eq(organizations.stripeCustomerId, String(sub.customer)));
  }
  if (event.type === "invoice.payment_failed") {
    // Not a downgrade: Stripe retries, and the subscription events above carry the outcome.
    // Recorded as an event so the workspace (and its webhooks) can see it happened.
    const inv = event.data.object as Stripe.Invoice;
    const org = inv.customer ? await db.query.organizations.findFirst({ where: eq(organizations.stripeCustomerId, String(inv.customer)) }) : null;
    if (org) {
      const { emitEvent } = await import("../lib/events.js");
      await emitEvent(org.id, "billing.payment_failed", { invoiceId: inv.id, amountDue: inv.amount_due, attemptCount: inv.attempt_count, nextAttempt: inv.next_payment_attempt });
    } else console.error(`[billing] payment failed for unknown customer ${String(inv.customer)}`);
  }
  return c.json({ received: true });
});

// Admin org management now lives in routes/admin.ts, mounted at /v1/admin.
