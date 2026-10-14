import { getDb, sql, withStatementTimeout, type Db } from "@prospex/db";
import { evaluateSendingHealth, redact } from "@prospex/core";
import { systemSenderDailyCap } from "./campaigns.js";
import { INBOUND_PROVIDER } from "./inbound.js";

/**
 * The admin console's "Deliverability" tab and the richer workspace detail.
 *
 * Everything here reads across every workspace, so every query is written to stay cheap on a
 * large database:
 *   - message and event counts go through the per-workspace (org_id, created_at) indexes by
 *     joining each workspace LATERAL, and are always bounded by a time window, because a
 *     plain "created_at > x" over the whole messages table has no index to use;
 *   - table totals come from the planner's row estimate once a table is big
 *     (pg_class.reltuples), and an exact count only while it is small;
 *   - every statement runs under a short statement timeout. A section that runs out of time
 *     is reported empty and named in `timedOut`, so the page says so instead of hanging or
 *     failing as a whole.
 * No value of any secret is ever returned: configuration appears only as "set or not".
 */

/** Per-statement cap. Each section runs in parallel, so the endpoint stays well under 2 s. */
const STATEMENT_MS = 1_500;
/**
 * The workspaces that can have email traffic: those with a sender account or a campaign.
 * Most workspaces never send, and probing the message index once per workspace for all of
 * them was most of the cost on a database with tens of thousands of workspaces.
 */
const SENDING_ORGS = sql.raw(`(SELECT org_id AS id FROM email_accounts UNION SELECT org_id FROM campaigns)`);
/** Above this many rows a table is counted by estimate instead of count(*). */
const EXACT_COUNT_MAX = 200_000;

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const rows = (r as { rows?: unknown[] }).rows ?? (r as unknown[]);
  return Array.isArray(rows) ? (rows as Row[]) : [];
};
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0);
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : 0);
const SEVERITY = { ok: 0, warn: 1, halt: 2 } as const;

/** Error text from a provider or a delivery, safe to show an operator: no keys, no addresses, short. */
export const safeErrorText = (text: unknown, max = 200): string | null => {
  const s = String(text ?? "").trim();
  return s ? redact(s, { maskEmails: true, max }) : null;
};

/** Host of a URL, never its path, query or credentials (a webhook's path is often its secret). */
export const hostOnly = (url: unknown): string => {
  try {
    return new URL(String(url)).host || "(invalid address)";
  } catch {
    return "(invalid address)";
  }
};

/** Run one read under the statement cap; on any failure the fallback is used and the section is named. */
async function section<T>(db: Db, name: string, timedOut: string[], fallback: T, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await withStatementTimeout(db, STATEMENT_MS, async (tx) => {
      // These reads are many cheap index probes that the planner prices as one expensive
      // query, which switches JIT compilation on: measured at 400 ms of compiling for a
      // 200 ms query. Off for this transaction only.
      await tx.execute(sql`SELECT set_config('jit', 'off', true)`);
      return fn(tx);
    });
  } catch (e) {
    timedOut.push(name);
    if (process.env.NODE_ENV !== "test") console.warn(`[admin] ${name} section skipped: ${safeErrorText(((e as { cause?: Error })?.cause ?? (e as Error))?.message, 160)}`);
    return fallback;
  }
}

/** Exact count while the table is small, the planner's estimate once it is not. */
async function cheapCount(tx: Db, table: "global_suppressions" | "suppressions"): Promise<{ count: number; estimated: boolean }> {
  const [est] = rowsOf(await tx.execute(sql`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass(${table})`));
  const n = Number(est?.n ?? -1);
  if (n > EXACT_COUNT_MAX) return { count: n, estimated: true };
  // The table name is one of two constants, never input.
  const [r] = rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)));
  return { count: num(r?.n), estimated: false };
}

/** UTC calendar days, oldest first, ending today. */
function utcDays(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export interface DeliverabilityReport {
  days: number;
  daily: { day: string; sent: number; bounced: number; complained: number; replied: number }[];
  totals: { sent: number; bounced: number; complained: number; replied: number; bounceRate: number; complaintRate: number };
  senders: {
    orgId: string;
    orgName: string;
    accountId: string;
    account: string;
    provider: string;
    status: string;
    paused: boolean;
    circuitBreaker: "ok" | "warn" | "halt";
    circuitReason: string | null;
    sent7d: number;
    bounceRate7d: number;
    warmupDay: number | null;
    dailyLimit: number;
  }[];
  suppressions: { global: number; workspaceTotal: number; workspaceEstimated: boolean };
  bounceTracking: { resendWebhookConfigured: boolean; lastEventAt: string | null };
  integrations: {
    byProvider: { provider: string; connected: number; inError: number }[];
    errors: { orgId: string; orgName: string; provider: string; lastError: string | null; lastErrorAt: string | null; credentialsRejected: boolean }[];
  };
  webhooks: {
    total: number;
    active: number;
    disabled: number;
    failing: { webhookId: string; orgId: string; orgName: string; host: string; lastStatus: number | null; lastError: string | null; lastFailureAt: string | null; failures24h: number; consecutiveFailures: number; disabled: boolean }[];
  };
  inbound: { addressesCreated: number; repliesReceived7d: number };
  timedOut: string[];
  generatedAt: string;
}

/** The last number in a delivery error ("webhook https://x → 503 Service Unavailable"). */
function statusFromError(text: unknown): number | null {
  const m = String(text ?? "").match(/→\s*(\d{1,3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * GET /v1/admin/deliverability. `days` is 7 or 30 and applies to the daily series and the
 * totals; senders are judged on the last 7 (volume, bounce rate) and 14 days (the same
 * verdict the campaign scheduler enforces), and webhook failures on the last 24 hours.
 *
 * Bounced and replied are counted against the day the email was SENT (of what went out that
 * day, how much bounced or was answered), which is what a bounce rate means. Complaints are
 * not tied to one message, so they are counted on the day they were recorded.
 */
export async function deliverabilityReport(daysIn: number): Promise<DeliverabilityReport> {
  const days = daysIn === 30 ? 30 : 7;
  const { db } = getDb();
  const timedOut: string[] = [];
  const dayList = utcDays(days);
  const since = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - ${sql.raw(`interval '${days - 1} days'`)}`;

  const [daily, complaints, senderStats, accounts, suppressionCounts, lastEvent, integrationRows, webhookTotals, failingHooks, inbound] = await Promise.all([
    // Sent, bounced, replied per UTC day, one index range per workspace.
    section(db, "daily", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT x.day, sum(x.sent)::int AS sent, sum(x.bounced)::int AS bounced, sum(x.replied)::int AS replied
          FROM ${SENDING_ORGS} o
          CROSS JOIN LATERAL (
            SELECT to_char((m.sent_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
                   count(*) AS sent,
                   count(*) FILTER (WHERE m.bounced_at IS NOT NULL) AS bounced,
                   count(*) FILTER (WHERE m.replied_at IS NOT NULL) AS replied
            FROM messages m
            WHERE m.org_id = o.id
              AND m.created_at >= ${since} - interval '2 days'
              AND m.sent_at >= ${since}
              AND m.direction = 'outbound' AND m.channel = 'email'
            GROUP BY 1
          ) x
          GROUP BY x.day`),
      ),
    ),
    // Spam complaints per UTC day (from the workspaces' suppression lists).
    section(db, "complaints", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT x.day, sum(x.n)::int AS complained
          FROM ${SENDING_ORGS} o
          CROSS JOIN LATERAL (
            SELECT to_char((s.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*) AS n
            FROM suppressions s
            WHERE s.org_id = o.id AND s.created_at >= ${since} AND s.reason IN ('complaint', 'spam')
            GROUP BY 1
          ) x
          GROUP BY x.day`),
      ),
    ),
    // Per workspace and sender account, the last 14 days of outbound email, plus the
    // workspace's complaints and unsubscribes over the same window (the scheduler's inputs).
    section(db, "senders", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT o.id AS org_id, x.account_id, x.sent7, x.bounced7, x.sent14, x.bounced14, x.replied14, sup.complained14, sup.unsubscribed14
          FROM ${SENDING_ORGS} o
          CROSS JOIN LATERAL (
            SELECT c.email_account_id AS account_id,
                   count(*) FILTER (WHERE m.sent_at IS NOT NULL AND m.created_at > now() - interval '7 days')::int AS sent7,
                   count(*) FILTER (WHERE m.bounced_at IS NOT NULL AND m.created_at > now() - interval '7 days')::int AS bounced7,
                   count(*) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent14,
                   count(*) FILTER (WHERE m.bounced_at IS NOT NULL)::int AS bounced14,
                   count(*) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied14
            FROM messages m
            LEFT JOIN campaigns c ON c.id = m.campaign_id
            WHERE m.org_id = o.id AND m.created_at > now() - interval '14 days' AND m.direction = 'outbound' AND m.channel = 'email'
            GROUP BY c.email_account_id
          ) x
          CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE s.reason IN ('complaint', 'spam'))::int AS complained14,
                   count(*) FILTER (WHERE s.reason IN ('unsubscribe', 'unsubscribe_link', 'reply'))::int AS unsubscribed14
            FROM suppressions s
            WHERE s.org_id = o.id AND s.created_at > now() - interval '14 days'
          ) sup`),
      ),
    ),
    // Sender accounts with their workspace. The address is the customer's own sending
    // address, which the operator may see; the stored credentials are never selected.
    section(db, "accounts", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT a.id, a.org_id, o.name AS org_name, o.plan, o.plan_limits, a.from_email, a.provider, a.status, a.daily_limit, a.created_at
          FROM email_accounts a JOIN organizations o ON o.id = a.org_id
          ORDER BY a.created_at DESC
          LIMIT 5000`),
      ),
    ),
    section(db, "suppressions", timedOut, { global: 0, workspace: { count: 0, estimated: false } }, async (tx) => ({
      global: (await cheapCount(tx, "global_suppressions")).count,
      workspace: await cheapCount(tx, "suppressions"),
    })),
    // The latest bounce or complaint recorded anywhere in the last 30 days.
    section(db, "bounceTracking", timedOut, null as string | null, async (tx) => {
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT max(x.created_at) AS at
          FROM ${SENDING_ORGS} o
          CROSS JOIN LATERAL (
            SELECT e.created_at FROM events e
            WHERE e.org_id = o.id AND e.created_at > now() - interval '30 days' AND e.type IN ('message.bounced', 'message.complained')
            ORDER BY e.created_at DESC LIMIT 1
          ) x`),
      );
      return iso(r?.at);
    }),
    section(db, "integrations", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT i.org_id, o.name AS org_name, i.provider, i.status, i.settings->>'lastError' AS last_error, i.settings->>'lastErrorAt' AS last_error_at,
                 coalesce((i.settings->>'credentialsRejected')::boolean, false) AS credentials_rejected
          FROM integrations i JOIN organizations o ON o.id = i.org_id
          LIMIT 20000`),
      ),
    ),
    section(db, "webhookTotals", timedOut, { total: 0, active: 0, disabled: 0 }, async (tx) => {
      const [r] = rowsOf(await tx.execute(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS disabled FROM webhooks`));
      return { total: num(r?.total), active: num(r?.active), disabled: num(r?.disabled) };
    }),
    // Webhooks with a failed delivery attempt in the last 24 hours (a retry still waiting
    // counts: its error is set), or switched off after too many failures.
    section(db, "webhooks", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          WITH f AS (
            SELECT j.payload->>'webhookId' AS hook_id, count(*)::int AS failures24h, max(j.updated_at) AS last_at,
                   (array_agg(j.error ORDER BY j.updated_at DESC))[1] AS last_error
            FROM jobs j
            WHERE j.status IN ('failed', 'queued') AND j.type = 'webhook.deliver' AND j.error IS NOT NULL AND j.updated_at > now() - interval '24 hours'
            GROUP BY 1
          )
          SELECT w.id, w.org_id, o.name AS org_name, w.url, w.active, w.failures, f.failures24h, f.last_error, f.last_at
          FROM webhooks w
          JOIN organizations o ON o.id = w.org_id
          LEFT JOIN f ON f.hook_id = w.id::text
          WHERE f.hook_id IS NOT NULL OR NOT w.active
          ORDER BY w.active ASC, coalesce(f.failures24h, 0) DESC, f.last_at DESC NULLS LAST
          LIMIT 50`),
      ),
    ),
    section(db, "inbound", timedOut, { addresses: 0, replies: 0 }, async (tx) => {
      const [a] = rowsOf(await tx.execute(sql`SELECT count(*)::int AS n FROM integrations WHERE provider = ${INBOUND_PROVIDER}`));
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT coalesce(sum(x.n), 0)::int AS n
          FROM ${SENDING_ORGS} o
          CROSS JOIN LATERAL (SELECT count(*) AS n FROM messages m WHERE m.org_id = o.id AND m.created_at > now() - interval '7 days' AND m.direction = 'inbound') x`),
      );
      return { addresses: num(a?.n), replies: num(r?.n) };
    }),
  ]);

  // ── Daily series and totals ──
  const byDay = new Map(dayList.map((d) => [d, { day: d, sent: 0, bounced: 0, complained: 0, replied: 0 }]));
  for (const r of daily) {
    const d = byDay.get(String(r.day));
    if (d) Object.assign(d, { sent: num(r.sent), bounced: num(r.bounced), replied: num(r.replied) });
  }
  for (const r of complaints) {
    const d = byDay.get(String(r.day));
    if (d) d.complained = num(r.complained);
  }
  const series = [...byDay.values()];
  const sum = (k: "sent" | "bounced" | "complained" | "replied") => series.reduce((a, d) => a + d[k], 0);
  const totals = { sent: sum("sent"), bounced: sum("bounced"), complained: sum("complained"), replied: sum("replied"), bounceRate: 0, complaintRate: 0 };
  totals.bounceRate = rate(totals.bounced, totals.sent);
  totals.complaintRate = rate(totals.complained, totals.sent);

  // ── Senders ──
  // The shared platform sender is judged per workspace (every "system" account, and mail
  // whose account is gone, share one reputation), exactly as the scheduler does; a customer's
  // own sender is judged on its own messages.
  type Stats = { sent7: number; bounced7: number; sent14: number; bounced14: number; replied14: number };
  const zero = (): Stats => ({ sent7: 0, bounced7: 0, sent14: 0, bounced14: 0, replied14: 0 });
  const add = (a: Stats, r: Row) => {
    a.sent7 += num(r.sent7);
    a.bounced7 += num(r.bounced7);
    a.sent14 += num(r.sent14);
    a.bounced14 += num(r.bounced14);
    a.replied14 += num(r.replied14);
  };
  const perAccount = new Map<string, Stats>();
  const orgSuppr = new Map<string, { complained: number; unsubscribed: number }>();
  const orgUnattributed = new Map<string, Stats>();
  for (const r of senderStats) {
    const orgId = String(r.org_id);
    orgSuppr.set(orgId, { complained: num(r.complained14), unsubscribed: num(r.unsubscribed14) });
    if (r.account_id) {
      const s = perAccount.get(String(r.account_id)) ?? zero();
      add(s, r);
      perAccount.set(String(r.account_id), s);
    } else {
      const s = orgUnattributed.get(orgId) ?? zero();
      add(s, r);
      orgUnattributed.set(orgId, s);
    }
  }
  const systemByOrg = new Map<string, { stats: Stats; oldest: number }>();
  for (const a of accounts) {
    if (a.provider !== "system") continue;
    const orgId = String(a.org_id);
    const cur = systemByOrg.get(orgId) ?? { stats: { ...(orgUnattributed.get(orgId) ?? zero()) }, oldest: Infinity };
    const s = perAccount.get(String(a.id));
    if (s) add(cur.stats, s as unknown as Row);
    const created = new Date(String(a.created_at)).getTime();
    if (Number.isFinite(created)) cur.oldest = Math.min(cur.oldest, created);
    systemByOrg.set(orgId, cur);
  }
  const ageDays = (t: number) => (Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null);
  const senders = accounts
    .map((a) => {
      const orgId = String(a.org_id);
      const system = a.provider === "system";
      const own = perAccount.get(String(a.id)) ?? zero();
      const shared = system ? systemByOrg.get(orgId) : undefined;
      const judged = shared?.stats ?? own;
      const sup = orgSuppr.get(orgId) ?? { complained: 0, unsubscribed: 0 };
      let cap = num(a.daily_limit);
      if (system) {
        try {
          cap = systemSenderDailyCap({ plan: String(a.plan), planLimits: (a.plan_limits ?? {}) as never });
        } catch {
          /* the account's own limit stands */
        }
      }
      const health = evaluateSendingHealth(
        { sent: judged.sent14, bounced: judged.bounced14, complained: sup.complained, unsubscribed: sup.unsubscribed, replied: judged.replied14 },
        { domainAgeDays: ageDays(shared ? shared.oldest : new Date(String(a.created_at)).getTime()), configuredDailyCap: cap },
      );
      const status = String(a.status ?? "active");
      return {
        orgId,
        orgName: String(a.org_name ?? ""),
        accountId: String(a.id),
        account: String(a.from_email ?? ""),
        provider: String(a.provider ?? ""),
        status,
        paused: status !== "active" || health.status === "halt",
        circuitBreaker: health.status,
        // Every reason, not the first: a sender halted for complaints also carries a bounce
        // warning first in the list, and showing only that one hid why it stopped.
        circuitReason: health.status === "ok" ? null : health.reasons.filter((r) => !r.startsWith("Only ")).join(" ") || null,
        sent7d: own.sent7,
        bounceRate7d: rate(own.bounced7, own.sent7),
        warmupDay: health.rampDay,
        dailyLimit: num(a.daily_limit),
      };
    })
    // Busiest first; at equal volume a halted or warned sender comes before a healthy one.
    .sort((x, y) => y.sent7d - x.sent7d || SEVERITY[y.circuitBreaker] - SEVERITY[x.circuitBreaker])
    .slice(0, 50);

  // ── Integrations ──
  const providers = new Map<string, { provider: string; connected: number; inError: number }>();
  const errors: DeliverabilityReport["integrations"]["errors"] = [];
  for (const r of integrationRows) {
    const provider = String(r.provider);
    // The inbound-reply address is kept in the same table but is not a connection.
    if (provider === INBOUND_PROVIDER) continue;
    const p = providers.get(provider) ?? { provider, connected: 0, inError: 0 };
    p.connected++;
    if (r.status === "error") {
      p.inError++;
      errors.push({ orgId: String(r.org_id), orgName: String(r.org_name ?? ""), provider, lastError: safeErrorText(r.last_error), lastErrorAt: iso(r.last_error_at), credentialsRejected: r.credentials_rejected === true || r.credentials_rejected === "true" });
    }
    providers.set(provider, p);
  }
  errors.sort((a, b) => (b.lastErrorAt ?? "").localeCompare(a.lastErrorAt ?? ""));

  return {
    days,
    daily: series,
    totals,
    senders,
    suppressions: { global: suppressionCounts.global, workspaceTotal: suppressionCounts.workspace.count, workspaceEstimated: suppressionCounts.workspace.estimated },
    // Whether the signing secret is set; never its value.
    bounceTracking: { resendWebhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET, lastEventAt: lastEvent },
    integrations: { byProvider: [...providers.values()].sort((a, b) => b.connected - a.connected || a.provider.localeCompare(b.provider)), errors: errors.slice(0, 50) },
    webhooks: {
      ...webhookTotals,
      failing: failingHooks.map((r) => ({
        webhookId: String(r.id),
        orgId: String(r.org_id),
        orgName: String(r.org_name ?? ""),
        host: hostOnly(r.url),
        lastStatus: statusFromError(r.last_error),
        lastError: safeErrorText(String(r.last_error ?? "").replace(/^webhook\s+\S+\s+→\s*/, "")),
        lastFailureAt: iso(r.last_at),
        failures24h: num(r.failures24h),
        consecutiveFailures: num(r.failures),
        disabled: r.active === false,
      })),
    },
    inbound: { addressesCreated: inbound.addresses, repliesReceived7d: inbound.replies },
    timedOut,
    generatedAt: new Date().toISOString(),
  };
}

// ── Workspace detail (GET /v1/admin/orgs/:id, additive) ──

/** Counted exactly up to this many; beyond it the count says "at least" (`countsCapped`). */
const DETAIL_COUNT_CAP = 1_000_000;

export interface OrgInsights {
  counts: Record<"members" | "leads" | "companies" | "lists" | "campaigns" | "campaignsActive" | "plays" | "clients" | "apiKeysActive" | "webhooks" | "integrations" | "pixels" | "signalsSubscriptions" | "autopilots", number> | null;
  /** Counts that reached DETAIL_COUNT_CAP and are therefore "at least". */
  countsCapped: string[];
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  emailsSent30d: number | null;
  bounceRate30d: number | null;
  integrations: { provider: string; status: string; lastSyncAt: string | null; lastError: string | null }[];
  senders: { account: string; provider: string; status: string }[];
  recentAudit: { action: string; actorType: string; createdAt: string | null; result: string }[];
  insightsTimedOut: string[];
}

/**
 * The extra sections of one workspace's detail. Each part is a handful of indexed lookups on
 * one workspace; a part that runs out of time is left empty and named in `insightsTimedOut`.
 */
export async function orgInsights(orgId: string): Promise<OrgInsights> {
  const { db } = getDb();
  const timedOut: string[] = [];
  const cap = DETAIL_COUNT_CAP + 1;
  const [counts, activity, mail, integ, senders, audit] = await Promise.all([
    section(db, "counts", timedOut, null as Row | null, async (tx) => {
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT
            (SELECT count(*) FROM users WHERE org_id = ${orgId})::int AS members,
            (SELECT count(*) FROM (SELECT 1 FROM leads WHERE org_id = ${orgId} LIMIT ${cap}) x)::int AS leads,
            (SELECT count(*) FROM (SELECT 1 FROM companies WHERE org_id = ${orgId} LIMIT ${cap}) x)::int AS companies,
            (SELECT count(*) FROM lists WHERE org_id = ${orgId})::int AS lists,
            (SELECT count(*) FROM campaigns WHERE org_id = ${orgId})::int AS campaigns,
            (SELECT count(*) FROM campaigns WHERE org_id = ${orgId} AND status = 'active')::int AS campaigns_active,
            (SELECT count(*) FROM plays WHERE org_id = ${orgId})::int AS plays,
            (SELECT count(*) FROM clients WHERE org_id = ${orgId})::int AS clients,
            (SELECT count(*) FROM api_keys WHERE org_id = ${orgId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::int AS api_keys_active,
            (SELECT count(*) FROM webhooks WHERE org_id = ${orgId})::int AS webhooks,
            (SELECT count(*) FROM integrations WHERE org_id = ${orgId} AND provider <> ${INBOUND_PROVIDER})::int AS integrations,
            (SELECT count(*) FROM pixels WHERE org_id = ${orgId})::int AS pixels,
            (SELECT count(*) FROM signal_subscriptions WHERE org_id = ${orgId})::int AS signal_subscriptions,
            (SELECT count(*) FROM autopilots WHERE org_id = ${orgId})::int AS autopilots`),
      );
      return r ?? null;
    }),
    section(db, "activity", timedOut, { lastLoginAt: null as string | null, lastActiveAt: null as string | null }, async (tx) => {
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT
            (SELECT max(last_login_at) FROM users WHERE org_id = ${orgId}) AS last_login,
            (SELECT created_at FROM events WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1) AS last_event,
            (SELECT created_at FROM product_events WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1) AS last_product_event,
            (SELECT created_at FROM audit_log WHERE org_id = ${orgId} AND actor_type IN ('user', 'api_key') ORDER BY created_at DESC LIMIT 1) AS last_audit`),
      );
      const times = [r?.last_login, r?.last_event, r?.last_product_event, r?.last_audit].map(iso).filter((t): t is string => !!t).sort();
      return { lastLoginAt: iso(r?.last_login), lastActiveAt: times.length ? times[times.length - 1] : null };
    }),
    section(db, "email", timedOut, null as { sent: number; bounced: number } | null, async (tx) => {
      const [r] = rowsOf(
        await tx.execute(sql`
          SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent, count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced
          FROM messages
          WHERE org_id = ${orgId} AND created_at > now() - interval '30 days' AND direction = 'outbound' AND channel = 'email'`),
      );
      return { sent: num(r?.sent), bounced: num(r?.bounced) };
    }),
    section(db, "integrations", timedOut, [] as Row[], async (tx) =>
      rowsOf(await tx.execute(sql`SELECT provider, status, last_sync_at, settings->>'lastError' AS last_error FROM integrations WHERE org_id = ${orgId} AND provider <> ${INBOUND_PROVIDER} ORDER BY provider LIMIT 50`)),
    ),
    section(db, "senders", timedOut, [] as Row[], async (tx) =>
      rowsOf(await tx.execute(sql`SELECT from_email, provider, status FROM email_accounts WHERE org_id = ${orgId} ORDER BY created_at LIMIT 50`)),
    ),
    section(db, "audit", timedOut, [] as Row[], async (tx) =>
      rowsOf(await tx.execute(sql`SELECT action, actor_type, result, created_at FROM audit_log WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 10`)),
    ),
  ]);

  const countKeys = [
    ["members", "members"],
    ["leads", "leads"],
    ["companies", "companies"],
    ["lists", "lists"],
    ["campaigns", "campaigns"],
    ["campaignsActive", "campaigns_active"],
    ["plays", "plays"],
    ["clients", "clients"],
    ["apiKeysActive", "api_keys_active"],
    ["webhooks", "webhooks"],
    ["integrations", "integrations"],
    ["pixels", "pixels"],
    ["signalsSubscriptions", "signal_subscriptions"],
    ["autopilots", "autopilots"],
  ] as const;
  const countsOut = counts ? (Object.fromEntries(countKeys.map(([k, col]) => [k, Math.min(num(counts[col]), DETAIL_COUNT_CAP)])) as NonNullable<OrgInsights["counts"]>) : null;
  const capped = counts ? (["leads", "companies"] as const).filter((k) => num(counts[k]) > DETAIL_COUNT_CAP) : [];

  return {
    counts: countsOut,
    countsCapped: [...capped],
    lastLoginAt: activity.lastLoginAt,
    lastActiveAt: activity.lastActiveAt,
    emailsSent30d: mail ? mail.sent : null,
    bounceRate30d: mail ? rate(mail.bounced, mail.sent) : null,
    integrations: integ.map((r) => ({ provider: String(r.provider), status: String(r.status), lastSyncAt: iso(r.last_sync_at), lastError: safeErrorText(r.last_error) })),
    senders: senders.map((r) => ({ account: String(r.from_email ?? ""), provider: String(r.provider ?? ""), status: String(r.status ?? "") })),
    recentAudit: audit.map((r) => ({ action: String(r.action), actorType: String(r.actor_type), createdAt: iso(r.created_at), result: String(r.result) })),
    insightsTimedOut: timedOut,
  };
}

// ── Workspace list (GET /v1/admin/orgs, additive) ──

export interface OrgListExtras {
  lastActiveAt: string | null;
  membersCount: number;
  /** null when the count did not finish in time on a very large database. */
  leadsTotal: number | null;
}

/**
 * Last active, members and total leads for a page of workspaces, in three grouped queries
 * (never one query per workspace for the big tables). The lead count is the one that can be
 * slow on a huge database: it runs under its own time cap and is null when it does not finish.
 */
export async function orgListExtras(orgIds: string[]): Promise<Map<string, OrgListExtras>> {
  const out = new Map<string, OrgListExtras>();
  if (!orgIds.length) return out;
  const { db } = getDb();
  const timedOut: string[] = [];
  const ids = sql`ARRAY[${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
  const [members, activity, leadCounts] = await Promise.all([
    section(db, "members", timedOut, [] as Row[], async (tx) =>
      rowsOf(await tx.execute(sql`SELECT org_id, count(*)::int AS n, max(last_login_at) AS last_login FROM users WHERE org_id = ANY(${ids}) GROUP BY org_id`)),
    ),
    // Index lookups per workspace: the newest event and product event (both indexed on
    // org_id, created_at) and the newest sign-in or API action in the security log.
    section(db, "lastActive", timedOut, [] as Row[], async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT o.id AS org_id,
            (SELECT created_at FROM events e WHERE e.org_id = o.id ORDER BY created_at DESC LIMIT 1) AS last_event,
            (SELECT created_at FROM product_events p WHERE p.org_id = o.id ORDER BY created_at DESC LIMIT 1) AS last_product_event,
            (SELECT created_at FROM audit_log a WHERE a.org_id = o.id AND a.actor_type IN ('user', 'api_key') ORDER BY created_at DESC LIMIT 1) AS last_audit
          FROM organizations o WHERE o.id = ANY(${ids})`),
      ),
    ),
    section(db, "leadsTotal", timedOut, null as Row[] | null, async (tx) =>
      rowsOf(await tx.execute(sql`SELECT org_id, count(*)::int AS n FROM leads WHERE org_id = ANY(${ids}) GROUP BY org_id`)),
    ),
  ]);
  const mem = new Map(members.map((r) => [String(r.org_id), r]));
  const act = new Map(activity.map((r) => [String(r.org_id), r]));
  const leadsBy = leadCounts ? new Map(leadCounts.map((r) => [String(r.org_id), num(r.n)])) : null;
  for (const id of orgIds) {
    const m = mem.get(id);
    const a = act.get(id);
    const times = [m?.last_login, a?.last_event, a?.last_product_event, a?.last_audit].map(iso).filter((t): t is string => !!t).sort();
    out.set(id, { lastActiveAt: times.length ? times[times.length - 1] : null, membersCount: num(m?.n), leadsTotal: leadsBy ? (leadsBy.get(id) ?? 0) : null });
  }
  return out;
}
