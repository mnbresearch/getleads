import { and, eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { toolRegistry, toolUsage } from "./schema.js";

/** Period key for a tool's tracking window. "day" -> YYYY-MM-DD, "month" -> YYYY-MM (UTC). */
export function periodKeyFor(period: "day" | "month", d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (period === "day") return `${y}-${m}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${y}-${m}`;
}

/**
 * Record one call to an external tool/provider. Increments that provider's counter for its
 * current period (creating the row if needed). Unknown providers (not in tool_registry) are
 * ignored rather than throwing, so a typo'd meter() call in packages/core never breaks a request.
 * Returns the new count and whether this crossed the alert threshold for the first time this
 * period (so the caller can decide to send an alert email), or null if the provider is unknown.
 */
export async function recordToolUsage(
  provider: string,
): Promise<{ count: number; limit: number | null; thresholdCrossed: boolean; label: string } | null> {
  const { db } = getDb();
  const reg = await db.query.toolRegistry.findFirst({ where: eq(toolRegistry.provider, provider) });
  if (!reg) return null;

  const period = periodKeyFor((reg.period as "day" | "month") ?? "month");
  const existing = await db.query.toolUsage.findFirst({
    where: and(eq(toolUsage.provider, provider), eq(toolUsage.period, period)),
  });
  const nextCount = (existing?.count ?? 0) + 1;

  await db
    .insert(toolUsage)
    .values({ provider, period, count: nextCount })
    .onConflictDoUpdate({ target: [toolUsage.provider, toolUsage.period], set: { count: nextCount, updatedAt: new Date() } });

  let thresholdCrossed = false;
  if (reg.usageLimit && reg.usageLimit > 0) {
    const pct = (nextCount / reg.usageLimit) * 100;
    if (pct >= reg.alertThresholdPct && reg.lastAlertPeriod !== period) {
      thresholdCrossed = true;
      await db.update(toolRegistry).set({ lastAlertPeriod: period, updatedAt: new Date() }).where(eq(toolRegistry.provider, provider));
    }
  }

  return { count: nextCount, limit: reg.usageLimit, thresholdCrossed, label: reg.label };
}

/**
 * Record what a provider actually said.
 *
 * Only ever writes to a provider already in tool_registry, so an unknown id from a typo is
 * ignored rather than throwing - health reporting must never break the call it describes.
 * `lastOkAt` is only advanced on success, so a provider that has started failing still shows
 * when it last worked, which is the first thing you want to know when something breaks.
 */
export async function recordProviderHealth(call: { provider: string; outcome: string; status?: number; detail?: string }): Promise<void> {
  const { db } = getDb();
  const now = new Date();
  const set: Record<string, unknown> = {
    lastOutcome: call.outcome,
    lastStatus: call.status ?? null,
    lastDetail: call.detail?.slice(0, 500) ?? null,
    lastSeenAt: now,
    updatedAt: now,
  };
  if (call.outcome === "ok") set.lastOkAt = now;
  await db.update(toolRegistry).set(set).where(eq(toolRegistry.provider, call.provider));
}

/**
 * What an operator should do about a provider, derived from its last real outcome.
 *
 * Deliberately distinguishes "rejected" from "gated": a new key fixes the first and does
 * nothing for the second, and telling someone to rotate a working key is worse than telling
 * them nothing. "unverified" is its own state rather than being rounded up to healthy,
 * because a key nothing has called yet is exactly the case this whole change exists for.
 */
export type KeyStatus = "not_configured" | "unverified" | "working" | "rejected" | "gated" | "rate_limited" | "erroring";

export function keyStatusFrom(configured: boolean, lastOutcome: string | null): KeyStatus {
  if (!configured) return "not_configured";
  switch (lastOutcome) {
    case "ok":
      return "working";
    case "auth":
      return "rejected";
    case "forbidden":
      return "gated";
    case "rate_limit":
      return "rate_limited";
    case "server":
    case "network":
    case "bad_response":
      return "erroring";
    default:
      // Includes not_found, which on a probe usually means the endpoint worked and matched
      // nothing, and null, which means nothing has called this provider yet.
      return lastOutcome ? "working" : "unverified";
  }
}

export const KEY_STATUS_LABEL: Record<KeyStatus, string> = {
  not_configured: "No key set",
  unverified: "Key set, never used",
  working: "Working",
  rejected: "Key rejected",
  gated: "Not on this plan",
  rate_limited: "Rate limited",
  erroring: "Erroring",
};

export interface ToolSummary {
  provider: string;
  label: string;
  category: string;
  keyEnvVar: string | null;
  configured: boolean; // whether the key env var is set (always true for keyless tools)
  hasFreeTier: boolean;
  freeTierNote: string | null;
  usageLimit: number | null;
  period: string;
  alertThresholdPct: number;
  notes: string | null;
  currentPeriodKey: string;
  used: number;
  percentUsed: number | null;
  status: "ok" | "warning" | "critical" | "unmetered";
  keyStatus: KeyStatus;
  keyStatusLabel: string;
  lastOutcome: string | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
  lastSeenAt: string | null;
  lastOkAt: string | null;
}

/** All registered tools with their current-period usage, for the admin "Tools & limits" tab. */
export async function getToolsSummary(): Promise<ToolSummary[]> {
  const { db } = getDb();
  const registry = await db.query.toolRegistry.findMany({ orderBy: (t, { asc }) => [asc(t.category), asc(t.label)] });

  const out: ToolSummary[] = [];
  for (const reg of registry) {
    const period = periodKeyFor((reg.period as "day" | "month") ?? "month");
    const row = await db.query.toolUsage.findFirst({ where: and(eq(toolUsage.provider, reg.provider), eq(toolUsage.period, period)) });
    const used = row?.count ?? 0;
    const configured = reg.keyEnvVar ? !!process.env[reg.keyEnvVar] : true;
    const percentUsed = reg.usageLimit && reg.usageLimit > 0 ? Math.round((used / reg.usageLimit) * 1000) / 10 : null;
    let status: ToolSummary["status"] = "unmetered";
    if (percentUsed !== null) {
      status = percentUsed >= 100 ? "critical" : percentUsed >= reg.alertThresholdPct ? "warning" : "ok";
    } else if (reg.usageLimit === null) {
      status = "unmetered";
    }
    out.push({
      provider: reg.provider,
      label: reg.label,
      category: reg.category,
      keyEnvVar: reg.keyEnvVar,
      configured,
      hasFreeTier: reg.hasFreeTier,
      freeTierNote: reg.freeTierNote,
      usageLimit: reg.usageLimit,
      period: reg.period,
      alertThresholdPct: reg.alertThresholdPct,
      notes: reg.notes,
      currentPeriodKey: period,
      used,
      percentUsed,
      keyStatus: keyStatusFrom(configured, reg.lastOutcome ?? null),
      keyStatusLabel: KEY_STATUS_LABEL[keyStatusFrom(configured, reg.lastOutcome ?? null)],
      lastOutcome: reg.lastOutcome ?? null,
      lastStatusCode: reg.lastStatus ?? null,
      lastDetail: reg.lastDetail ?? null,
      lastSeenAt: reg.lastSeenAt ? new Date(reg.lastSeenAt).toISOString() : null,
      lastOkAt: reg.lastOkAt ? new Date(reg.lastOkAt).toISOString() : null,
      status,
    });
  }
  return out;
}

export async function updateToolLimit(
  provider: string,
  patch: { usageLimit?: number | null; period?: "day" | "month"; alertThresholdPct?: number; notes?: string | null },
): Promise<ToolSummary | null> {
  const { db } = getDb();
  const reg = await db.query.toolRegistry.findFirst({ where: eq(toolRegistry.provider, provider) });
  if (!reg) return null;
  await db
    .update(toolRegistry)
    .set({
      ...(patch.usageLimit !== undefined ? { usageLimit: patch.usageLimit } : {}),
      ...(patch.period !== undefined ? { period: patch.period } : {}),
      ...(patch.alertThresholdPct !== undefined ? { alertThresholdPct: patch.alertThresholdPct } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      // Changing the limit/threshold means a past alert may no longer apply; let it re-fire.
      lastAlertPeriod: null,
      updatedAt: new Date(),
    })
    .where(eq(toolRegistry.provider, provider));
  const summaries = await getToolsSummary();
  return summaries.find((s) => s.provider === provider) ?? null;
}
