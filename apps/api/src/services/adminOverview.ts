/**
 * The admin "Overview": the whole platform on one page, and the list of things an operator
 * should fix first.
 *
 * Built for a large database. Counting rows of a big table in a time window is done per
 * workspace through its (org_id, created_at) index (a LATERAL join over organizations), so
 * the cost follows the rows inside the window, never the size of the table; small tables
 * (organizations, users, campaigns, plays, webhooks, integrations) are counted directly.
 * Each group runs under a statement time limit, and a group that runs out of time is named
 * in `unavailable` with its numbers left null, instead of failing the page.
 *
 * Nothing here returns a setting's value: only whether something is set.
 */
import { currentPeriod, getDb, sql, type Db } from "@prospex/db";
import { createAiProvider, hasAi } from "@prospex/core";
import { env } from "../env.js";
import { outboundSendingEnabled } from "./campaigns.js";
import { systemMailerConfig } from "../lib/mailer.js";
import { embeddedWorkerOn, keepAwakeState } from "./adminConfig.js";
import { guarded, OVERDUE_GRACE_SECONDS, recurringStates, type RecurringState } from "./adminSystem.js";

type Row = Record<string, unknown>;
const first = async (tx: Db, q: ReturnType<typeof sql>): Promise<Row> => ([...((await tx.execute(q)) as unknown as Row[])][0] ?? {});
const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const obj = (v: unknown): Record<string, number> => {
  const parsed = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  const out: Record<string, number> = {};
  if (parsed && typeof parsed === "object") for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) out[k] = n(val);
  return out;
};

export type AlertLevel = "critical" | "warning" | "info";
export interface Alert {
  level: AlertLevel;
  /** Stable id, so the page and tests can tell alerts apart without reading their words. */
  id: string;
  title: string;
  detail: string;
  fix: string;
}

/** Everything the alert rules look at. Kept separate so the rules can be tested without a database. */
export interface AlertFacts {
  nodeEnv: string;
  searchKeys: number;
  aiEngine: boolean;
  mailer: boolean;
  mailFromSet: boolean;
  resendWebhookSecret: boolean;
  adminTotp: boolean;
  stripe: boolean;
  stripeWebhook: boolean;
  outboundSending: boolean;
  encryptionKey: boolean;
  workerInProcess: boolean;
  jobMode: string;
  keepAwake: { configured: boolean; window: string | null; timeZone: string | null; onRender: boolean };
  campaignsActive: number | null;
  failedJobs24h: number | null;
  stuckJobs: number | null;
  oldestDueSeconds: number | null;
  integrationsInError: number | null;
  webhooksFailing: number | null;
  openUpgradeRequests: number | null;
  pendingDeletion: number | null;
  bounces7d: number | null;
  sent7d: number | null;
  complaints7d: number | null;
  schedulers: Pick<RecurringState, "type" | "healthy" | "problem">[] | null;
}

const plural = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
const TZ_SHORT: Record<string, string> = { "Asia/Kolkata": "IST", "Asia/Calcutta": "IST", UTC: "UTC", "Etc/UTC": "UTC" };

/** The alert rules. Critical first, then warnings, then information; each says how to fix it. */
export function deriveAlerts(f: AlertFacts): Alert[] {
  const out: Alert[] = [];
  const add = (level: AlertLevel, id: string, title: string, detail: string, fix: string) => out.push({ level, id, title, detail, fix });

  if (!f.outboundSending) add("critical", "sending_paused", "Sending is paused platform-wide", "OUTBOUND_SENDING_ENABLED is off, so no campaign email goes out for any workspace. Contacts stay queued.", "Remove OUTBOUND_SENDING_ENABLED (or set it to true) in the hosting dashboard when sending should resume.");
  if (f.searchKeys === 0) add("critical", "no_search", "No search provider key", "No web search or data provider key is set, so discovery only has the keyless DuckDuckGo/Bing pages, which are slow and often blocked. Searches can come back empty.", "Set SERPER_API_KEY (or SERPAPI_KEY, BRAVE_SEARCH_API_KEY, GOOGLE_CSE_API_KEY with GOOGLE_CSE_CX, APOLLO_API_KEY) and redeploy.");
  if (!f.mailer) add(f.nodeEnv === "production" ? "critical" : "warning", "no_mailer", "No platform mail provider", "Neither RESEND_API_KEY nor SMTP_HOST is set, so sign-up confirmations, password resets, invites and security notices are not sent.", "Set RESEND_API_KEY (or SMTP_HOST with SMTP_USER and SMTP_PASS) and MAIL_FROM, then redeploy.");
  if (!f.resendWebhookSecret) {
    const sending = (f.campaignsActive ?? 0) > 0;
    add(sending ? "critical" : "warning", "bounce_tracking_off", "Bounce tracking is off - RESEND_WEBHOOK_SECRET is not set", `Bounces and spam complaints are never reported back, so bad addresses stay in sequences and keep hurting sender reputation.${sending ? ` ${plural(f.campaignsActive ?? 0, "campaign is", "campaigns are")} sending right now.` : ""}`, "In Resend, add a webhook to <API_URL>/v1/email-events/resend for email.bounced and email.complained, and put its signing secret in RESEND_WEBHOOK_SECRET.");
  }
  if ((f.stuckJobs ?? 0) > 0) add("critical", "stuck_jobs", `${plural(f.stuckJobs ?? 0, "job has", "jobs have")} been running for over 30 minutes`, "A job that runs this long is usually waiting on a provider that never answers, or its worker died.", "Open the System tab: the queue table shows which job type. A dead worker's jobs are returned to the queue after 15 minutes without a heartbeat.");
  if (f.oldestDueSeconds !== null && f.oldestDueSeconds > OVERDUE_GRACE_SECONDS) {
    const mins = Math.round(f.oldestDueSeconds / 60);
    add("critical", "queue_not_draining", "The job queue is not draining", `The oldest job that is due has waited ${plural(mins, "minute")}.${f.workerInProcess ? "" : " This process does not run a worker."}`, f.workerInProcess ? "Check the worker log lines ([worker]) for errors, and the stuck and failed jobs on the System tab." : "Run a worker (EMBED_WORKER=true on the API, or a separate worker process) and check the System tab.");
  }
  const deadSchedulers = (f.schedulers ?? []).filter((s) => !s.healthy);
  if (deadSchedulers.length) add("critical", "schedulers", `${plural(deadSchedulers.length, "scheduler is", "schedulers are")} not running`, `${deadSchedulers.map((s) => s.type).join(", ")}: ${deadSchedulers[0].problem ?? "not scheduled"}`, "Make sure a worker runs (System tab, Build). The keeper re-seeds missing schedulers every five minutes while one does.");
  if ((f.failedJobs24h ?? 0) > 0) {
    const k = f.failedJobs24h ?? 0;
    add(k >= 50 ? "critical" : "warning", "failed_jobs", `${plural(k, "job")} failed in the last 24 hours`, "Failed jobs did not deliver their work (a search, a send, a sync).", "Open the System tab, read the recent failures and retry the ones whose cause is fixed.");
  }
  if (!f.aiEngine) add("warning", "no_ai", "No AI engine", "No AI key is set, so ICP building, personalisation, reply triage and AI visibility fall back to rules or say AI is not available.", "Set GROQ_API_KEY or GEMINI_API_KEY (both have free tiers), or ANTHROPIC_API_KEY, and redeploy.");
  if (!f.adminTotp) add("warning", "admin_2fa_off", "Admin two-factor is off", "The admin password alone opens every workspace's plan, status and data-subject tools.", "Set ADMIN_TOTP_SECRET to a base32 secret, add it to an authenticator app, and redeploy. See DEPLOY.md, 'Admin two-factor sign-in'.");
  if (f.mailer && !f.mailFromSet) add("warning", "mail_from", "MAIL_FROM is not set", "Platform mail is sent from no-reply@localhost, which most inboxes reject or mark as spam.", "Set MAIL_FROM to an address on a domain verified with your mail provider, e.g. Scout <no-reply@yourdomain.com>.");
  if (!f.encryptionKey && f.nodeEnv === "production") add("warning", "encryption_key", "ENCRYPTION_KEY is not set", "Stored mail and CRM credentials are encrypted with a key derived from JWT_SECRET; rotating JWT_SECRET would make them unreadable.", "Set ENCRYPTION_KEY to a long random value (openssl rand -hex 32).");
  if ((f.integrationsInError ?? 0) > 0) add("warning", "integrations_error", `${plural(f.integrationsInError ?? 0, "CRM integration is", "CRM integrations are")} failing`, "Their last sync failed; leads are not reaching those workspaces' CRMs.", "Usually the customer's credentials: they reconnect under Settings > Integrations. The Deliverability tab lists them.");
  if ((f.webhooksFailing ?? 0) > 0) add("warning", "webhooks_failing", `${plural(f.webhooksFailing ?? 0, "webhook is", "webhooks are")} failing or disabled`, "Their endpoints did not accept recent deliveries; a webhook is switched off after repeated failures.", "The customer fixes the endpoint and re-enables it under Settings > Webhooks.");
  const sent = f.sent7d ?? 0;
  const bounces = f.bounces7d ?? 0;
  if (sent >= 50 && bounces / sent > 0.05) add("warning", "bounce_rate", `Bounce rate is ${((bounces / sent) * 100).toFixed(1)}% this week`, `${plural(bounces, "bounce")} out of ${plural(sent, "email")} sent in 7 days. Above 5% mailbox providers start filtering.`, "Find the senders with the most bounces (Deliverability tab) and make sure their lists are verified before sending.");
  if ((f.complaints7d ?? 0) > 0) add("warning", "complaints", `${plural(f.complaints7d ?? 0, "spam complaint")} this week`, "People marked campaign email as spam. Those addresses are suppressed automatically.", "Look at which workspaces they came from and review their copy and targeting.");
  if (f.keepAwake.configured) {
    const tz = f.keepAwake.timeZone ? TZ_SHORT[f.keepAwake.timeZone] ?? f.keepAwake.timeZone : "";
    add("info", "keep_awake", `Free Render instance sleeps outside ${f.keepAwake.window} ${tz} (keep-awake)`.trim(), "Outside the window the instance sleeps after 15 idle minutes: no campaign sends, schedules or plays run until the next visit wakes it.", "For round-the-clock sending, move to a paid instance and set KEEP_AWAKE=off.");
  } else if (f.keepAwake.onRender) {
    add("warning", "render_sleeps", "This Render instance may sleep", "Keep-awake is off. A free Render instance stops after 15 idle minutes, and with it every background job.", "Use a paid instance, or set KEEP_AWAKE_URL (or leave RENDER_EXTERNAL_URL) and KEEP_AWAKE_HOURS.");
  }
  if (!f.stripe) add("info", "stripe_off", "Stripe not configured - upgrades arrive as requests", `There is no online checkout. Customers ask to upgrade through the request form${(f.openUpgradeRequests ?? 0) > 0 ? `, and ${plural(f.openUpgradeRequests ?? 0, "request is", "requests are")} waiting` : ""}.`, "Handle requests on the Upgrade requests tab, or set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the STRIPE_PRICE_<PLAN> values.");
  else if (!f.stripeWebhook) add("warning", "stripe_webhook", "Stripe billing events are not set up", "STRIPE_WEBHOOK_SECRET is missing, so a paid checkout does not change the customer's plan.", "Add a Stripe webhook to <API_URL>/v1/billing/webhook and put its signing secret in STRIPE_WEBHOOK_SECRET.");
  if (f.stripe && (f.openUpgradeRequests ?? 0) > 0) add("info", "upgrade_requests", `${plural(f.openUpgradeRequests ?? 0, "upgrade request is", "upgrade requests are")} waiting`, "People asked to upgrade and nobody has marked them contacted yet.", "Open the Upgrade requests tab.");
  if ((f.pendingDeletion ?? 0) > 0) add("info", "pending_deletion", `${plural(f.pendingDeletion ?? 0, "workspace is", "workspaces are")} scheduled for deletion`, "Their owners asked for deletion; the data goes when the grace period ends.", "Nothing to do unless an owner contacts you; the Users & workspaces tab shows the dates.");

  const rank: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };
  return out.map((a, i) => ({ a, i })).sort((x, y) => rank[x.a.level] - rank[y.a.level] || x.i - y.i).map((x) => x.a);
}

const has = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
/** Search keys the discovery chain can use (Google CSE needs both of its values). */
export function searchKeyCount(e: NodeJS.ProcessEnv = process.env): number {
  return [has(e.SERPER_API_KEY), has(e.SERPAPI_KEY), has(e.BRAVE_SEARCH_API_KEY), has(e.GOOGLE_CSE_API_KEY) && has(e.GOOGLE_CSE_CX), has(e.APOLLO_API_KEY), has(e.PDL_API_KEY)].filter(Boolean).length;
}

export async function platformOverview() {
  const { db } = getDb();
  const unavailable: string[] = [];
  const period = currentPeriod();

  const [base, active, usage, mail, plays, health, schedulers] = await Promise.all([
    guarded(db, "workspaces", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT
          (SELECT count(*)::int FROM organizations) AS total,
          (SELECT coalesce(json_object_agg(plan, c), '{}'::json) FROM (SELECT plan, count(*)::int AS c FROM organizations GROUP BY plan) p) AS by_plan,
          (SELECT coalesce(json_object_agg(status, c), '{}'::json) FROM (SELECT status, count(*)::int AS c FROM organizations GROUP BY status) s) AS by_status,
          (SELECT count(*)::int FROM organizations WHERE created_at > now() - interval '7 days') AS new7,
          (SELECT count(*)::int FROM organizations WHERE created_at > now() - interval '30 days') AS new30,
          (SELECT count(DISTINCT org_id)::int FROM workspace_deletion_requests WHERE cancelled_at IS NULL AND completed_at IS NULL) AS pending_deletion,
          (SELECT count(*)::int FROM organizations WHERE plan NOT IN ('free', 'pilot')) AS paid,
          (SELECT count(*)::int FROM upgrade_requests WHERE status = 'new') AS open_upgrades,
          (SELECT count(*)::int FROM users) AS users,
          (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS users7,
          (SELECT count(*)::int FROM users WHERE created_at > now() - interval '30 days') AS users30,
          (SELECT count(*)::int FROM users WHERE totp_enabled_at IS NOT NULL AND totp_secret_encrypted IS NOT NULL) AS twofa,
          (SELECT count(*)::int FROM campaigns WHERE status = 'active') AS campaigns_active`,
      ),
    ),
    // Active: a sign-in, a product event or a new lead in seven days. Each probe stops at its first row.
    guarded(db, "active7d", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT count(*)::int AS active FROM organizations o
          WHERE o.id IN (SELECT org_id FROM users WHERE last_login_at > now() - interval '7 days')
             OR EXISTS (SELECT 1 FROM product_events pe WHERE pe.org_id = o.id AND pe.created_at > now() - interval '7 days')
             OR EXISTS (SELECT 1 FROM leads l WHERE l.org_id = o.id AND l.created_at > now() - interval '7 days')`,
      ),
    ),
    guarded(db, "usage30d", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT
          (SELECT coalesce(sum(x.c), 0)::bigint FROM organizations o CROSS JOIN LATERAL (SELECT count(*) AS c FROM leads l WHERE l.org_id = o.id AND l.created_at > now() - interval '30 days') x) AS leads,
          (SELECT count(*)::int FROM searches WHERE created_at > now() - interval '30 days') AS searches,
          (SELECT coalesce(sum(count), 0)::bigint FROM usage WHERE period = ${period} AND metric = 'verifications') AS verifications,
          (SELECT coalesce(sum(count), 0)::bigint FROM usage WHERE period = ${period} AND metric = 'aiMessages') AS ai_messages`,
      ),
    ),
    // Messages per workspace through (org_id, created_at). 45 days back so a reply or bounce in
    // the last week to a message sent up to five weeks earlier is still seen.
    guarded(db, "outreach", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT
          coalesce(sum(x.sent30), 0)::bigint AS sent30,
          coalesce(sum(x.sent7), 0)::bigint AS sent7,
          coalesce(sum(x.replies7), 0)::bigint AS replies7,
          coalesce(sum(x.bounces7), 0)::bigint AS bounces7,
          (SELECT count(*)::int FROM suppressions WHERE reason = 'complaint' AND created_at > now() - interval '7 days') AS complaints7
          FROM organizations o CROSS JOIN LATERAL (
            SELECT
              count(*) FILTER (WHERE m.direction = 'outbound' AND m.sent_at > now() - interval '30 days') AS sent30,
              count(*) FILTER (WHERE m.direction = 'outbound' AND m.sent_at > now() - interval '7 days') AS sent7,
              count(*) FILTER (WHERE m.direction = 'outbound' AND m.replied_at > now() - interval '7 days') AS replies7,
              count(*) FILTER (WHERE m.bounced_at > now() - interval '7 days') AS bounces7
            FROM messages m WHERE m.org_id = o.id AND m.created_at > now() - interval '45 days'
          ) x`,
      ),
    ),
    guarded(db, "plays", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT
          (SELECT count(*)::int FROM plays) AS total,
          (SELECT count(*)::int FROM plays WHERE status = 'active') AS active,
          (SELECT coalesce(sum(r.c), 0)::bigint FROM plays p CROSS JOIN LATERAL (SELECT count(*) AS c FROM play_runs pr WHERE pr.play_id = p.id AND pr.started_at > now() - interval '7 days') r) AS runs7,
          (SELECT coalesce(sum(q.c), 0)::bigint FROM organizations o CROSS JOIN LATERAL (SELECT count(*) AS c FROM play_candidates pc WHERE pc.org_id = o.id AND pc.status = 'pending') q) AS pending`,
      ),
    ),
    guarded(db, "health", unavailable, (tx) =>
      first(
        tx,
        sql`SELECT
          (SELECT count(*)::int FROM jobs WHERE status = 'failed' AND updated_at > now() - interval '24 hours') AS failed24,
          (SELECT count(*)::int FROM jobs WHERE status = 'running' AND updated_at < now() - interval '30 minutes') AS stuck,
          (SELECT count(*)::int FROM jobs WHERE status IN ('queued', 'running')) AS open,
          (SELECT floor(extract(epoch FROM now() - min(run_at)))::int FROM jobs WHERE status = 'queued' AND run_at <= now()) AS oldest_due,
          (SELECT count(*)::int FROM integrations WHERE status = 'error') AS integrations_error,
          (SELECT count(*)::int FROM webhooks w WHERE NOT w.active OR w.failures > 0
             OR w.id::text IN (SELECT payload->>'webhookId' FROM jobs WHERE status = 'failed' AND type = 'webhook.deliver' AND updated_at > now() - interval '24 hours')) AS webhooks_failing`,
      ),
    ),
    guarded(db, "schedulers", unavailable, (tx) => recurringStates(tx)),
  ]);

  const v = (r: Row | null, k: string): number | null => (r ? n(r[k]) : null);
  const ka = keepAwakeState();
  const workerInProcess = embeddedWorkerOn();
  const facts: AlertFacts = {
    nodeEnv: env.nodeEnv,
    searchKeys: searchKeyCount(),
    aiEngine: (() => {
      try {
        return hasAi(createAiProvider());
      } catch {
        return false;
      }
    })(),
    mailer: !!systemMailerConfig(),
    mailFromSet: has(process.env.MAIL_FROM),
    resendWebhookSecret: has(process.env.RESEND_WEBHOOK_SECRET),
    adminTotp: !!env.adminTotpSecret,
    stripe: !!env.stripe.secretKey,
    stripeWebhook: !!env.stripe.webhookSecret,
    outboundSending: outboundSendingEnabled(),
    encryptionKey: has(process.env.ENCRYPTION_KEY),
    workerInProcess,
    jobMode: env.jobMode,
    keepAwake: ka,
    campaignsActive: v(base, "campaigns_active"),
    failedJobs24h: v(health, "failed24"),
    stuckJobs: v(health, "stuck"),
    oldestDueSeconds: health && health.oldest_due !== null && health.oldest_due !== undefined ? n(health.oldest_due) : null,
    integrationsInError: v(health, "integrations_error"),
    webhooksFailing: v(health, "webhooks_failing"),
    openUpgradeRequests: v(base, "open_upgrades"),
    pendingDeletion: v(base, "pending_deletion"),
    bounces7d: v(mail, "bounces7"),
    sent7d: v(mail, "sent7"),
    complaints7d: v(mail, "complaints7"),
    // Without a worker in this process (inline mode, or a separate worker) the schedulers are
    // judged only when they exist at all; their timing belongs to whichever process runs them.
    schedulers: schedulers ? (env.jobMode === "inline" ? [] : schedulers) : null,
  };

  return {
    generatedAt: new Date().toISOString(),
    workspaces: {
      total: v(base, "total"),
      byPlan: base ? obj(base.by_plan) : {},
      byStatus: base ? obj(base.by_status) : {},
      new7d: v(base, "new7"),
      new30d: v(base, "new30"),
      active7d: v(active, "active"),
      pendingDeletion: v(base, "pending_deletion"),
    },
    users: { total: v(base, "users"), new7d: v(base, "users7"), new30d: v(base, "users30"), twoFactorOn: v(base, "twofa") },
    usage30d: {
      leads: v(usage, "leads"),
      searches: v(usage, "searches"),
      verifications: v(usage, "verifications"),
      aiMessages: v(usage, "ai_messages"),
      emailsSent: v(mail, "sent30"),
      // Leads, searches and emails are counted over the last 30 days. Verifications and AI
      // messages are only metered per calendar month, so those two are this month so far.
      basis: { leads: "30d", searches: "30d", emailsSent: "30d", verifications: "month", aiMessages: "month" },
      period,
    },
    outreach: {
      campaignsActive: v(base, "campaigns_active"),
      emailsSent7d: v(mail, "sent7"),
      replies7d: v(mail, "replies7"),
      bounces7d: v(mail, "bounces7"),
      complaints7d: v(mail, "complaints7"),
    },
    plays: { total: v(plays, "total"), active: v(plays, "active"), runs7d: v(plays, "runs7"), candidatesPending: v(plays, "pending") },
    revenue: { stripeEnabled: facts.stripe, paidWorkspaces: v(base, "paid"), openUpgradeRequests: v(base, "open_upgrades") },
    health: {
      failedJobs24h: facts.failedJobs24h,
      stuckJobs: facts.stuckJobs,
      integrationsInError: facts.integrationsInError,
      webhooksFailing: facts.webhooksFailing,
      queueOpen: v(health, "open"),
      oldestDueSeconds: facts.oldestDueSeconds,
    },
    alerts: deriveAlerts(facts),
    unavailable,
  };
}
