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
