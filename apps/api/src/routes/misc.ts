import { Hono, type Context } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import Stripe from "stripe";
import { isPublicHost } from "@prospex/core";
import { and, checkoutSessions, desc, emailAccounts, enqueue, eq, events, getDb, getUsage, inArray, integrations, isPlanId, leads, limitsFor, messages, organizations, planOverrides, PLANS, sql, webhooks, companies, campaigns } from "@prospex/db";
import { sendingHealthForAccount, systemSenderHealthForOrg } from "../services/campaigns.js";
import { icpLearningFor } from "../services/insights.js";
import { env } from "../env.js";
import { campaignAttribution, leadFunnel, sourcePerformance } from "../services/analytics.js";
import { sealOrgJson } from "../lib/credentials.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import { orgId, rateLimit, requireAuth, requireUser, type Env } from "../middleware.js";
import { INTEGRATION_PROVIDERS, integrationName, OWN_KEY_UNSUPPORTED, validateIntegrationConfig, verifyIntegrationCredentials } from "../services/integrations.js";
import { INBOUND_PROVIDER, inboundStatus, ingestInbound, inboundAiFor, orgForInboundToken, removeInboundToken, rotateInboundToken, touchInboundToken } from "../services/inbound.js";
import { parseSender } from "./campaigns.js";
import { enforceWindows } from "../lib/rateWindow.js";
import { audit } from "../lib/audit.js";
import { ownerOrAdmin } from "../lib/roles.js";
import { newWebhookSecret, publicWebhook } from "../lib/webhookSecret.js";
import { assertPlanIntegrations, assertRowCap, guardJobCapacity, withOrgLock } from "../lib/limits.js";
import { sanitizeProductPath, trackProduct } from "../lib/productEvents.js";
import { FOLLOWUP_KIND, recordOptOut, verifyOptOutSignature } from "../services/checkoutFollowup.js";
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
  const sendOrg = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
  const out = [];
  for (const a of accounts) {
    out.push({
      account: { id: a.id, fromEmail: a.fromEmail, dailyLimit: a.dailyLimit, status: a.status },
      // The shared platform sender is judged per workspace, not per account; showing the
      // per-account verdict would read "healthy" while sending is paused workspace-wide.
      health: a.provider === "system" && sendOrg ? await systemSenderHealthForOrg(db, sendOrg) : await sendingHealthForAccount(db, oid, a),
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
/**
 * The list never carries a signing secret. It used to return every hook's secret in full to
 * any member of the workspace - people who cannot create a webhook could read the key that
 * authenticates its deliveries. `secretPreview` (the first six characters) is enough to
 * tell hooks apart; the secret itself is shown once, when it is created or rotated.
 */
miscRoutes.get("/webhooks", requireAuth, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(webhooks).where(eq(webhooks.orgId, orgId(c))).orderBy(desc(webhooks.createdAt));
  return c.json({ webhooks: rows.map(publicWebhook) });
});
/**
 * The full signing secret is in this response - shown once at creation, as with API keys.
 * It is stored encrypted, and deliveries are signed with a real HMAC (signature v2, header
 * `x-prospex-signature: v2=<hex>`).
 */
miscRoutes.post("/webhooks", requireAuth, ownerOrAdmin("webhook.created"), zValidator("json", z.object({ url: z.string().url().max(2000), events: z.array(z.string().max(100)).max(50).default(["*"]) })), async (c) => {
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
  await assertRowCap(db, webhooks, orgId(c), "webhooks");
  const fresh = newWebhookSecret(orgId(c));
  const [row] = await db.insert(webhooks).values({ orgId: orgId(c), url, events: c.req.valid("json").events, ...fresh.columns }).returning();
  await audit(c, "webhook.created", { targetType: "webhook", targetId: row.id, data: { host: hostOf(url), events: row.events, signatureVersion: row.signatureVersion } });
  const pub = { ...publicWebhook(row), secret: fresh.secret };
  return c.json(warning ? { ...pub, warning } : pub, 201);
});
miscRoutes.delete("/webhooks/:id", requireAuth, ownerOrAdmin("webhook.deleted"), async (c) => {
  const { db } = getDb();
  const gone = await db.delete(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c)))).returning({ id: webhooks.id, url: webhooks.url });
  if (!gone.length) throw notFound("Webhook");
  await audit(c, "webhook.deleted", { targetType: "webhook", targetId: gone[0].id, data: { host: hostOf(gone[0].url) } });
  return c.json({ ok: true });
});
/**
 * Replace a webhook's signing secret.
 *
 * The new secret is returned once and the old one stops working immediately. Rotating also
 * moves a legacy hook to signature v2 (a real HMAC-SHA256, sent as `v2=<hex>`), so the
 * receiver's verification code has to be updated together with the secret.
 */
miscRoutes.post("/webhooks/:id/rotate-secret", requireAuth, ownerOrAdmin("webhook.secret_rotated"), async (c) => {
  const { db } = getDb();
  const hook = await db.query.webhooks.findFirst({ where: and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c))) });
  if (!hook) throw notFound("Webhook");
  // Serialised per workspace so two rotations cannot interleave and leave a caller holding a
  // secret that was already replaced before it even read the response.
  const fresh = newWebhookSecret(hook.orgId);
  await withOrgLock(db, hook.orgId, "webhook-rotate", (tx) => tx.update(webhooks).set(fresh.columns).where(and(eq(webhooks.id, hook.id), eq(webhooks.orgId, hook.orgId))));
  await audit(c, "webhook.secret_rotated", { targetType: "webhook", targetId: hook.id, data: { host: hostOf(hook.url), fromSignatureVersion: hook.signatureVersion, signatureVersion: 2 } });
  return c.json({ id: hook.id, secret: fresh.secret, signatureVersion: 2 });
});
/** Host of a URL for the audit trail: never the path, query or userinfo, which can carry tokens. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
/**
 * Send a test event to THIS webhook.
 *
 * It used to emit a `webhook.test` event to the whole org, which went to every hook
 * subscribed to "*" - and to none at all for the hook being tested if it listened to, say,
 * `lead.*` only. The Test button reported "queued" either way. Now it is delivered to the
 * one hook asked about, whatever its event filter.
 */
miscRoutes.post("/webhooks/:id/test", requireAuth, ownerOrAdmin("webhook.tested"), async (c) => {
  const { db } = getDb();
  const hook = await db.query.webhooks.findFirst({ where: and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, orgId(c))) });
  if (!hook) throw notFound("Webhook");
  await guardJobCapacity(db, hook.orgId, "webhook.deliver");
  const [ev] = await db.insert(events).values({ orgId: hook.orgId, type: "webhook.test", data: { hello: "world", webhookId: hook.id } }).returning();
  const job = await enqueue(db, "webhook.deliver", { webhookId: hook.id, eventId: ev.id }, { orgId: hook.orgId, maxAttempts: 1 });
  await audit(c, "webhook.tested", { targetType: "webhook", targetId: hook.id, data: { host: hostOf(hook.url) } });
  const base = { queued: true, webhookId: hook.id, eventId: ev.id, jobId: job.id, active: hook.active, note: hook.active ? undefined : "This webhook is disabled (too many failures); the test is sent anyway." };
  // `?wait=1` (what the Settings page sends): deliver now and say what the endpoint answered,
  // instead of "queued". Without it the answer is unchanged, for existing API callers.
  if (c.req.query("wait") !== "1" && c.req.query("wait") !== "true") return c.json(base);
  return c.json({ ...base, ...(await deliverTestNow(job.id, hook.orgId)) });
});

/**
 * Run one queued test delivery inside the request, with the delivery's own 10-second
 * timeout, and report the outcome. The job is claimed the way a worker claims one (so a
 * worker cannot run it a second time) and finished through the same completeJob/failJob, so
 * it appears in the delivery log like any other delivery. If a worker claimed it first, its
 * result is waited for (briefly) instead.
 */
async function deliverTestNow(jobId: string, oid: string): Promise<{ delivered: boolean; status?: number; error?: string; pending?: boolean }> {
  const { db } = getDb();
  const { completeJob, failJob, jobs } = await import("@prospex/db");
  const lockedBy = `api:webhook-test:${jobId.slice(0, 8)}`;
  const claimed = await db
    .update(jobs)
    .set({ status: "running", lockedAt: new Date(), lockedBy, attempts: sql`${jobs.attempts} + 1`, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.orgId, oid), eq(jobs.status, "queued")))
    .returning();
  if (claimed.length) {
    const job = claimed[0];
    const { handlers } = await import("../jobs.js");
    try {
      const result = await handlers["webhook.deliver"](job, { db, progress: async () => {}, log: () => {} });
      await completeJob(db, job.id, result, lockedBy);
    } catch (e) {
      await failJob(db, job, e);
    }
  } else {
    // A worker has it: wait for its answer, at most 12 seconds.
    for (let i = 0; i < 24; i++) {
      const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
      if (!row || row.status === "done" || row.status === "failed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const [row] = await db.select({ status: jobs.status, result: jobs.result, error: jobs.error }).from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.orgId, oid)));
  return deliveryOutcome(row);
}

/** One delivery job, as the customer reads it: delivered or not, the endpoint's status code, the reason. */
function deliveryOutcome(row: { status: string; result: Record<string, unknown> | null; error: string | null } | undefined): { delivered: boolean; status?: number; error?: string; pending?: boolean } {
  if (!row) return { delivered: false, error: "The test delivery could not be found." };
  if (row.status === "queued" || row.status === "running") return { delivered: false, pending: true };
  const result = row.result ?? {};
  if (row.status === "done") {
    if (typeof result.skipped === "string") return { delivered: false, error: result.skipped };
    if (result.skipped) return { delivered: false, error: "The webhook or event no longer exists, so nothing was sent." };
    return { delivered: true, ...(typeof result.status === "number" ? { status: result.status } : {}) };
  }
  // A failed delivery's error reads "webhook <origin> → <code> <text>".
  const text = String(row.error ?? "delivery failed");
  const m = text.match(/→\s*(\d{1,3})\b\s*(.*)$/);
  const code = m ? Number(m[1]) : undefined;
  return { delivered: false, ...(code ? { status: code } : {}), error: (m ? m[2] || `HTTP ${code}` : text).slice(0, 300) || (code ? `HTTP ${code}` : "delivery failed") };
}

/**
 * The last 20 delivery attempts to one webhook: when, which event, and what came back.
 * Read from the delivery jobs themselves (one per event and hook), scoped to the workspace.
 * Owner/admin, like everything else about webhooks except the list.
 */
miscRoutes.get("/webhooks/:id/deliveries", requireAuth, ownerOrAdmin("webhook.deliveries_viewed"), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const hook = await db.query.webhooks.findFirst({ where: and(eq(webhooks.id, c.req.param("id")), eq(webhooks.orgId, oid)) });
  if (!hook) throw notFound("Webhook");
  const r = await db.execute(sql`
    SELECT j.id, j.status, j.attempts, j.max_attempts AS "maxAttempts", j.result, j.error, j.created_at AS "createdAt", j.updated_at AS "updatedAt", e.type AS event
    FROM jobs j
    LEFT JOIN events e ON e.org_id = j.org_id AND e.id::text = j.payload->>'eventId'
    WHERE j.org_id = ${oid} AND j.type = 'webhook.deliver' AND j.payload->>'webhookId' = ${hook.id}
    ORDER BY j.created_at DESC
    LIMIT 20`);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as { id: string; status: string; attempts: number; maxAttempts: number; result: Record<string, unknown> | null; error: string | null; createdAt: string; updatedAt: string; event: string | null }[];
  return c.json({
    deliveries: rows.map((d) => ({ id: d.id, at: d.updatedAt ?? d.createdAt, createdAt: d.createdAt, event: d.event, state: d.status, attempts: d.attempts, maxAttempts: d.maxAttempts, ...deliveryOutcome(d) })),
  });
});

// ── Integrations (CRM) ──
miscRoutes.get("/integrations", requireAuth, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(integrations).where(eq(integrations.orgId, orgId(c)));
  // The inbound-reply address is kept in this table too (services/inbound.ts) but is not a
  // connection; it has its own routes (/v1/inbound-address) and its token hash is never listed.
  // `lastError` / `lastErrorAt` in settings, and status "error", say why the last check or sync failed.
  return c.json({ integrations: rows.filter((r) => r.provider !== INBOUND_PROVIDER).map(({ configEncrypted: _x, ...r }) => r), providers: INTEGRATION_PROVIDERS, channelProviders: CHANNEL_PROVIDERS, unsupportedOwnKeys: Object.keys(OWN_KEY_UNSUPPORTED) });
});
miscRoutes.put("/integrations/:provider", requireAuth, ownerOrAdmin("integration.connected"), zValidator("json", z.object({ config: z.record(z.string().max(4000)), settings: z.record(z.unknown()).optional(), autoSync: z.boolean().default(false) })), async (c) => {
  const provider = c.req.param("provider");
  if (!INTEGRATION_PROVIDERS.includes(provider) && !CHANNEL_PROVIDERS.includes(provider)) throw badRequest(`Unknown provider. Supported: ${[...INTEGRATION_PROVIDERS, ...CHANNEL_PROVIDERS].join(", ")}`);
  const b = c.req.valid("json");
  // Credentials are checked before anything is saved. An empty token used to be stored and
  // reported "Connected", and every sync after that failed with nothing pointing at why.
  const config = Object.fromEntries(Object.entries(b.config).map(([k, v]) => [k, v.trim()]));
  const required = REQUIRED_CREDENTIALS[provider] ?? [];
  const missing = required.filter((k) => !config[k]);
  // "Enter the access token to connect HubSpot." - the provider by its own name, not its id.
  if (missing.length) {
    const labels = missing.map((k) => CREDENTIAL_LABELS[k] ?? k);
    const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0];
    throw badRequest(`Enter the ${list} to connect ${integrationName(provider)}.`, { missing });
  }
  if (!required.length && !Object.values(config).some(Boolean)) throw badRequest(`Enter the credentials for ${integrationName(provider)} before saving the connection.`);
  // A workspace key for a provider that runs through the shared connection would be saved
  // and never used (services/integrations.ts OWN_KEY_UNSUPPORTED): refused, in words.
  if (Object.hasOwn(OWN_KEY_UNSUPPORTED, provider)) throw new ApiError(400, OWN_KEY_UNSUPPORTED[provider], "own_key_unsupported");
  if (config.url && !/^https?:\/\/[^\s]+$/i.test(config.url)) throw badRequest("URL must be a full http(s):// address.");
  // Per-provider rules: which keys a provider takes, and that any base URL or host in them
  // (Zoho's apiDomain, Pipedrive's companyDomain, a webhook/Cortex/Sheets url) is a public
  // address of the expected shape. Without it a tenant could point a sync at an internal
  // service and read the answer back through the job's error. Unknown keys are dropped.
  const validated = validateIntegrationConfig(provider, config);
  if (!validated.ok) throw badRequest(validated.message);
  b.config = validated.config;
  if (JSON.stringify(b.settings ?? {}).length > 10_000) throw badRequest("Integration settings are too large.");
  const { db } = getDb();
  // The plan must include integrations to connect a new one (Free does not). A connection
  // the workspace already has can still be updated - a rotated token must be savable.
  const existing = await db.query.integrations.findFirst({ where: and(eq(integrations.orgId, orgId(c)), eq(integrations.provider, provider)), columns: { id: true } });
  if (!existing) assertPlanIntegrations(c.get("auth").org);
  // One cheap read-only call to the provider where it has one: wrong credentials are saved
  // with status "error" and the reason, instead of "active" and failing every sync after.
  const check = await verifyIntegrationCredentials(provider, b.config);
  const failed = check.checked && !check.ok && !check.unreachable;
  const status = failed ? "error" : "active";
  // Server-managed keys are never taken from the request.
  const { lastError: _le, lastErrorAt: _lea, ...userSettings } = (b.settings ?? {}) as Record<string, unknown>;
  const settings: Record<string, unknown> = { ...userSettings, autoSync: b.autoSync, ...(failed ? { lastError: check.error, lastErrorAt: new Date().toISOString() } : {}) };
  // Bound to this workspace: the stored blob does not open on another workspace's row.
  const configEncrypted = sealOrgJson(orgId(c), "integration", b.config);
  const [row] = await db
    .insert(integrations)
    .values({ orgId: orgId(c), provider, configEncrypted, settings, status })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: { configEncrypted, settings, status } })
    .returning();
  const { configEncrypted: _x, ...pub } = row;
  // Field NAMES only: the values are the credentials.
  await audit(c, "integration.connected", { targetType: "integration", targetId: row.id, data: { provider, fields: Object.keys(b.config).sort(), autoSync: b.autoSync, status } });
  // `verified`: true (the provider accepted the credentials), false (it refused them, or could
  // not be reached - `verifyNote` says which), absent (this provider is not checked).
  return c.json({ ...pub, ...(check.checked ? { verified: check.ok, ...(check.ok ? {} : { verifyNote: check.unreachable ? `${check.error} The connection was saved; it will be tried on the next sync.` : check.error }) } : {}) });
});
miscRoutes.delete("/integrations/:provider", requireAuth, ownerOrAdmin("integration.disconnected"), async (c) => {
  const { db } = getDb();
  const gone = await db.delete(integrations).where(and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, orgId(c)))).returning({ id: integrations.id, provider: integrations.provider });
  if (!gone.length) throw notFound("Integration");
  await audit(c, "integration.disconnected", { targetType: "integration", targetId: gone[0].id, data: { provider: gone[0].provider } });
  return c.json({ ok: true });
});
// Owner/admin only: a sync pushes lead data out of the workspace into another system.
miscRoutes.post("/integrations/:provider/sync", requireAuth, ownerOrAdmin("integration.synced"), zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).min(1).max(500) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.provider, c.req.param("provider")), eq(integrations.orgId, oid)) });
  if (!integ || integ.provider === INBOUND_PROVIDER) throw notFound("Integration");
  // Only this workspace's leads are queued. The job rejects any other id, so counting them
  // as queued reported work that was never going to happen.
  const requested = [...new Set(c.req.valid("json").leadIds)];
  const owned = (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, requested)))).map((r) => r.id);
  // One job per lead: all of them are counted against the ceiling for requests arriving together.
  if (owned.length) await guardJobCapacity(db, oid, "integration.sync", false, owned.length);
  for (const leadId of owned) await enqueue(db, "integration.sync", { integrationId: integ.id, leadId }, { orgId: oid, maxAttempts: 3 });
  await audit(c, "integration.synced", { targetType: "integration", targetId: integ.id, data: { provider: integ.provider, requested: requested.length, queued: owned.length } });
  return c.json({ queued: owned.length, requested: requested.length, notFound: requested.length - owned.length }, 202);
});

// ── Inbound replies: the workspace's secret address (services/inbound.ts) ──
/** Whether the address exists, when it was made and last used. The token is never shown again. */
miscRoutes.get("/inbound-address", requireAuth, ownerOrAdmin("inbound.viewed"), async (c) => c.json(await inboundStatus(orgId(c))));
/**
 * Make the address, or replace it (the old one stops working at once). The token is in this
 * answer only. Not an integration in the plan sense: replies are part of campaigns, so no plan
 * gate applies.
 */
miscRoutes.post("/inbound-address", requireAuth, ownerOrAdmin("inbound.rotated"), async (c) => {
  const oid = orgId(c);
  const r = await rotateInboundToken(oid);
  await audit(c, "inbound.rotated", { targetType: "organization", targetId: oid });
  return c.json({ ...r, configured: true }, 201);
});
miscRoutes.delete("/inbound-address", requireAuth, ownerOrAdmin("inbound.removed"), async (c) => {
  const oid = orgId(c);
  if (!(await removeInboundToken(oid))) throw notFound("Inbound address");
  await audit(c, "inbound.removed", { targetType: "organization", targetId: oid });
  return c.json({ ok: true });
});

/**
 * POST /v1/public/inbound/:token - where a forwarding service (Zapier, Make, a Gmail or
 * Outlook forwarding rule through such a service) posts each reply as JSON
 * {from, subject, text}. No sign-in: the token in the path is the credential.
 *
 *  - Body: at most 256 KB (the limit for unauthenticated POSTs, app.ts), fields as the
 *    signed-in route (/v1/campaigns/inbound) accepts them.
 *  - Rate: 60 a minute per calling address, and 300 an hour per workspace address.
 *  - An unknown token is a 401 that says nothing about whether any address exists.
 *  - Otherwise exactly the signed-in route's work: services/inbound.ts ingestInbound.
 */
const inboundPublicLimiter = rateLimit({ perMinute: 60, name: "public-inbound" });
const inboundPublicBody = z.object({ from: z.string().max(1000), text: z.string().max(200_000).default(""), subject: z.string().max(1000).optional() });
miscRoutes.post("/public/inbound/:token", inboundPublicLimiter, async (c) => {
  const token = c.req.param("token");
  const org = await orgForInboundToken(token);
  // The token is the credential: an unknown one is a 401, the same answer whether or not
  // any address exists.
  if (!org) throw new ApiError(401, "This inbound address is not valid. Make a new one under Settings > Integrations.", "invalid_token");
  enforceWindows([{ key: `inbound:${org.id}`, limit: 300, message: "Too many replies posted to this address in the last hour. Try again later." }], 3600_000);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Send JSON: {\"from\": \"Jane <jane@example.com>\", \"subject\": \"...\", \"text\": \"...\"}.");
  }
  const parsed = inboundPublicBody.safeParse(raw);
  if (!parsed.success) throw badRequest("Send JSON with `from` (the sender's address), and optionally `subject` and `text`.");
  const email = parseSender(parsed.data.from);
  if (!email) throw badRequest("`from` must be the sender's address: either a bare address (jane@example.com) or Name <jane@example.com>.");
  const out = await ingestInbound(org.id, org, { email, text: parsed.data.text, subject: parsed.data.subject }, inboundAiFor(org));
  await touchInboundToken(org.id);
  return c.json(out);
});

// ── Billing (optional Stripe; pilot is free) ──
miscRoutes.get("/billing/plans", (c) => {
  const stripeEnabled = !!env.stripe.secretKey;
  // The plans that can actually be bought online: Stripe is on AND the plan has a price id.
  // The web app sends every other Upgrade to the request form instead of to a checkout that
  // would only answer "isn't set up for this plan".
  const checkoutPlans = stripeEnabled ? Object.keys(PLANS).filter((id) => PLANS[id].priceUsd > 0 && !!env.stripe.priceForPlan(id)) : [];
  return c.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), stripeEnabled, checkoutPlans, pilotMode: env.pilotMode });
});

miscRoutes.post("/billing/checkout", requireAuth, requireUser, ownerOrAdmin("billing.checkout"), zValidator("json", z.object({ plan: z.string().max(100) })), async (c) => {
  if (!env.stripe.secretKey) throw badRequest("Stripe is not configured");
  const stripe = new Stripe(env.stripe.secretKey);
  const a = c.get("auth");
  const requestedPlan = c.req.valid("json").plan;
  // isPlanId, not `PLANS[x]`: inherited names ("toString", "constructor") are truthy there.
  if (!isPlanId(requestedPlan)) throw badRequest(`Unknown plan "${requestedPlan.slice(0, 40)}"`);
  const price = env.stripe.priceForPlan(requestedPlan);
  if (!price) {
    console.warn(`[billing] no Stripe price id for plan "${requestedPlan}" (set STRIPE_PRICE_${requestedPlan.toUpperCase()})`);
    throw badRequest("Online checkout isn't set up for this plan yet. Use the upgrade request form and we will set it up with you.");
  }
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
  // Every started checkout is remembered, so one that is never finished can be noticed (and,
  // if the operator turns it on, followed up once - services/checkoutFollowup.ts). A failure
  // here must not cost the customer their checkout link: logged without data and carried on.
  await db
    .insert(checkoutSessions)
    .values({ orgId: a.org.id, userId: a.user!.id, plan: requestedPlan, provider: "stripe", providerSessionId: session.id, status: "open" })
    .onConflictDoNothing()
    .catch((e) => console.warn(`[billing] could not record checkout session: ${(e as Error)?.name ?? "error"}`));
  await trackProduct("checkout_started", { orgId: a.org.id, userId: a.user!.id, props: { plan: requestedPlan } });
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
   * `{ ...limitsFor(plan), ...overrides }`), so they are whatever differs from the plan's
   * defaults - `planOverrides`, which also drops any stored value that is not a usable limit,
   * so junk is never carried onto the new plan.
   */
  const planForPrice = (priceId: string | undefined | null) => (priceId ? Object.keys(PLANS).find((p) => env.stripe.priceForPlan(p) === priceId) : undefined);
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const orgId = s.metadata?.orgId;
    const plan = s.metadata?.plan;
    await recordCheckoutOutcome(s.id, "completed", orgId, plan);
    if (orgId && plan && isPlanId(plan)) {
      await db.update(organizations).set({ plan, planLimits: limitsFor(plan), stripeSubscriptionId: String(s.subscription ?? "") }).where(eq(organizations.id, orgId));
    } else if (orgId) {
      console.error(`[billing] checkout ${s.id} for org ${orgId} names unknown plan ${JSON.stringify(plan)}; plan NOT changed`);
      await db.update(organizations).set({ stripeSubscriptionId: String(s.subscription ?? "") }).where(eq(organizations.id, orgId));
    }
  }
  if (event.type === "checkout.session.expired") {
    const s = event.data.object as Stripe.Checkout.Session;
    await recordCheckoutOutcome(s.id, "expired", s.metadata?.orgId, s.metadata?.plan);
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
          await db.update(organizations).set({ plan, planLimits: { ...limitsFor(plan), ...planOverrides(org) }, stripeSubscriptionId: sub.id }).where(eq(organizations.id, org.id));
        }
      } else console.error(`[billing] subscription ${sub.id} has price ${priceId} that maps to no STRIPE_PRICE_<PLAN>; plan NOT changed`);
    }
    // past_due and incomplete: Stripe is still retrying payment; nothing changes yet.
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const cancelled = await db.update(organizations).set({ plan: "free", planLimits: limitsFor("free"), stripeSubscriptionId: null }).where(eq(organizations.stripeCustomerId, String(sub.customer))).returning({ id: organizations.id });
    for (const o of cancelled) await trackProduct("subscription_cancelled", { orgId: o.id, props: { plan: planForPrice(sub.items?.data?.[0]?.price?.id) ?? null } });
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

/**
 * A Stripe checkout finished or lapsed: its checkout_sessions row says so. Only a row that is
 * still open moves, so a replayed webhook records nothing twice. A completed checkout whose
 * row is missing (started before rows were kept, or the insert failed) is still counted.
 */
async function recordCheckoutOutcome(sessionId: string | undefined, status: "completed" | "expired", orgId: string | undefined | null, plan: string | undefined | null) {
  if (!sessionId) return;
  try {
    const { db } = getDb();
    const moved = await db
      .update(checkoutSessions)
      .set(status === "completed" ? { status, completedAt: new Date() } : { status })
      .where(and(eq(checkoutSessions.providerSessionId, sessionId), status === "completed" ? inArray(checkoutSessions.status, ["open", "expired"]) : eq(checkoutSessions.status, "open")))
      .returning({ orgId: checkoutSessions.orgId, userId: checkoutSessions.userId, plan: checkoutSessions.plan });
    if (status !== "completed") return;
    const row = moved[0];
    if (row) await trackProduct("checkout_completed", { orgId: row.orgId, userId: row.userId, props: { plan: row.plan } });
    else if (orgId && plan && isPlanId(plan)) {
      // No row moved: either it was already completed (a replayed event - count nothing) or
      // there never was one (started before rows were kept). Creating the missing row as
      // completed, once, is what makes a replay of THAT event count nothing too.
      const created = await db
        .insert(checkoutSessions)
        .values({ orgId, plan, providerSessionId: sessionId, status: "completed", completedAt: new Date() })
        .onConflictDoNothing({ target: checkoutSessions.providerSessionId })
        .returning({ id: checkoutSessions.id });
      if (created.length) await trackProduct("checkout_completed", { orgId, props: { plan } });
    }
  } catch (e) {
    console.warn(`[billing] could not record the checkout outcome: ${(e as Error)?.name ?? "error"}`);
  }
}

// ── Public page-view beacon ──
/**
 * Counts visits to the public site (landing, pricing, sign-up) for the admin funnel.
 *
 * Nothing identifies the visitor: no IP, no cookie, no id, no user agent is stored - only the
 * path (no query string), the host of the referring site and any utm_* tags. A browser that
 * sends Do Not Track or Global Privacy Control is not counted at all. The answer is always an
 * empty 204, whether the view was counted, ignored, malformed or over the rate limit, so the
 * page learns nothing from it and never retries.
 */
const PV_MAX_BYTES = 2048;
// The only pages the site counts (apps/web/src/lib/pageview.ts). Anything else is not a
// visit to us, so a script cannot invent paths to fill the table.
const PV_PATHS: ReadonlySet<string> = new Set(["/", "/pricing", "/signup", "/login"]);
// A ceiling for the whole process, on top of the per-address limit: a script rotating
// through many addresses still cannot write more than this many rows a minute.
const PV_GLOBAL_PER_MINUTE = 600;
let pvWindowStart = 0;
let pvWindowCount = 0;
const pvGlobalAllows = (nowMs = Date.now()) => {
  if (nowMs - pvWindowStart >= 60_000) {
    pvWindowStart = nowMs;
    pvWindowCount = 0;
  }
  pvWindowCount++;
  return pvWindowCount <= PV_GLOBAL_PER_MINUTE;
};
const pvLimiter = rateLimit({ perMinute: 30, burst: 30, name: "public-pv" });
const ownHosts = () => {
  const out = new Set<string>();
  for (const u of [env.appUrl, env.apiUrl]) {
    try {
      out.add(new URL(u).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {}
  }
  return out;
};
/** The referring site's host, lower-case; null for our own pages, a non-web URL or junk. */
export function referrerHost(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref || ref.length > 2000) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!host || ownHosts().has(host.replace(/^www\./, ""))) return null;
    return host.slice(0, 80);
  } catch {
    return null;
  }
}
const utm = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) || null : null);

miscRoutes.post("/public/pv", async (c) => {
  const empty = () => c.body(null, 204);
  if (c.req.header("dnt") === "1" || c.req.header("sec-gpc") === "1") return empty();
  let limited = false;
  try {
    await pvLimiter(c, async () => {});
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) limited = true;
    else throw e;
  }
  if (limited) return empty();
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > PV_MAX_BYTES) return empty();
  let body: Record<string, unknown>;
  try {
    const text = await c.req.text();
    if (text.length > PV_MAX_BYTES) return empty();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty();
    body = parsed as Record<string, unknown>;
  } catch {
    return empty();
  }
  const path = sanitizeProductPath(body.path);
  if (!path || !PV_PATHS.has(path)) return empty();
  if (!pvGlobalAllows()) return empty();
  const props: Record<string, string | null> = {};
  const host = referrerHost(body.ref);
  if (host) props.referrer_host = host;
  for (const [from, to] of [["utm_source", "source"], ["utm_medium", "medium"], ["utm_campaign", "campaign"]] as const) {
    const v = utm(body[from]);
    if (v) props[to] = v;
  }
  // The pricing section being seen is its own funnel step; the web sends "/pricing" for it.
  await trackProduct(path === "/pricing" ? "pricing_viewed" : "page_view", { path, props });
  return empty();
});

// ── One-click email opt-out (checkout reminders) ──
const OPT_OUT_KINDS: ReadonlySet<string> = new Set([FOLLOWUP_KIND]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const optOutPage = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#1e293b">${body}</body>`;
const optOutLimiter = rateLimit({ perMinute: 20, name: "email-opt-out" });

/**
 * The unsubscribe link in a checkout reminder: `?u=<userId>&k=<kind>&s=<signature>`. The
 * signature is an HMAC of the user id and kind under a key derived from JWT_SECRET, so a link
 * only opts out the person it was sent to. A bad or missing signature is a 400 that changes
 * nothing. POST opts out (the mail client's RFC 8058 one-click, or the button on the page).
 * GET only shows that button: mail security scanners open every link in a message before
 * the person does, and a GET that unsubscribed would unsubscribe people who never clicked.
 * Doing it twice is fine.
 */
const handleOptOut = async (c: Context<Env>) => {
  c.header("content-security-policy", PAGE_CSP);
  const u = c.req.query("u") ?? "";
  const k = c.req.query("k") ?? "";
  const s = c.req.query("s") ?? "";
  if (!UUID_RE.test(u) || !OPT_OUT_KINDS.has(k) || !verifyOptOutSignature(u, k, s)) {
    return c.html(optOutPage("Link not valid", "<h2>This link is not valid</h2><p>It may have been copied incorrectly. Nothing was changed.</p>"), 400);
  }
  if (c.req.method !== "POST") {
    // u, k and s were checked above (a uuid, a known kind, a hex signature), so they are safe in the form.
    const action = `?u=${encodeURIComponent(u)}&k=${encodeURIComponent(k)}&s=${encodeURIComponent(s)}`;
    return c.html(
      optOutPage(
        "Unsubscribe",
        `<h2>Stop checkout reminders?</h2><p>We will not send you reminders about unfinished upgrades again.</p><form method="post" action="${action}"><button type="submit" style="font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer">Unsubscribe</button></form>`,
      ),
    );
  }
  await recordOptOut(u, k);
  return c.html(optOutPage("Unsubscribed", "<h2>You're unsubscribed</h2><p>We won't send you checkout reminders again.</p>"));
};
miscRoutes.get("/public/email-opt-out", optOutLimiter, handleOptOut);
miscRoutes.post("/public/email-opt-out", optOutLimiter, handleOptOut);

// Admin org management now lives in routes/admin.ts, mounted at /v1/admin.
