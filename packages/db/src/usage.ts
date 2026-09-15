import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { organizations, usage, type PlanLimits } from "./schema.js";
import { limitsFor } from "./plans.js";

export type Metric = "leads" | "searches" | "verifications" | "aiMessages" | "emails" | "premiumLeads";

const metricToLimit: Record<Metric, keyof PlanLimits> = {
  leads: "leadsPerMonth",
  searches: "searchesPerMonth",
  verifications: "verificationsPerMonth",
  aiMessages: "aiMessagesPerMonth",
  emails: "emailsPerMonth",
  premiumLeads: "premiumLeadsPerMonth",
};

export function currentPeriod(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getUsage(db: Db, orgId: string) {
  const period = currentPeriod();
  const rows = await db.select().from(usage).where(and(eq(usage.orgId, orgId), eq(usage.period, period)));
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  const limits = { ...limitsFor(org?.plan ?? "free"), ...(org?.planLimits ?? {}) };
  const out: Record<string, { used: number; limit: number }> = {};
  for (const m of Object.keys(metricToLimit) as Metric[]) {
    const used = rows.find((r) => r.metric === m)?.count ?? 0;
    out[m] = { used, limit: Number(limits[metricToLimit[m]] ?? 0) };
  }
  return { period, plan: org?.plan ?? "free", usage: out };
}

export class QuotaExceededError extends Error {
  constructor(public metric: Metric, public used: number, public limit: number) {
    super(`Monthly quota exceeded for ${metric}: ${used}/${limit}`);
  }
}

/** Increment usage; throws QuotaExceededError if over plan limit. */
export async function consume(db: Db, orgId: string, metric: Metric, amount = 1) {
  const period = currentPeriod();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  const limits = { ...limitsFor(org?.plan ?? "free"), ...(org?.planLimits ?? {}) };
  const limit = Number(limits[metricToLimit[metric]] ?? 0);
  const [row] = await db
    .insert(usage)
    .values({ orgId, period, metric, count: amount })
    .onConflictDoUpdate({
      target: [usage.orgId, usage.period, usage.metric],
      set: { count: sql`${usage.count} + ${amount}` },
    })
    .returning();
  if (limit > 0 && row.count > limit) {
    // roll back the increment so the org isn't stuck over-limit
    await db.update(usage).set({ count: sql`${usage.count} - ${amount}` }).where(eq(usage.id, row.id));
    throw new QuotaExceededError(metric, row.count - amount, limit);
  }
  return row.count;
}

/**
 * Remaining budget for provider-sourced (Apollo/Hunter/PDL) leads this billing period.
 * Deliberately NOT reusing consume()'s generic "limit <= 0 means unlimited" convention:
 * for this metric specifically, <= 0 means zero budget (free/pilot orgs get none by
 * design - see plans.ts), so it is computed explicitly rather than via consume()/getUsage().
 * Call this BEFORE running a search that may hit paid providers, and pass the result as
 * `maxProviderLeads` to runLeadPipeline() so the provider call itself is capped, not just
 * penalized after the fact.
 */
export async function remainingPremiumBudget(db: Db, orgId: string): Promise<number> {
  const period = currentPeriod();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  const limits = { ...limitsFor(org?.plan ?? "free"), ...(org?.planLimits ?? {}) };
  const limit = Number(limits.premiumLeadsPerMonth ?? 0);
  if (limit <= 0) return 0;
  const rows = await db.select().from(usage).where(and(eq(usage.orgId, orgId), eq(usage.period, period)));
  const used = rows.find((r) => r.metric === "premiumLeads")?.count ?? 0;
  return Math.max(0, limit - used);
}

/**
 * Record one persisted lead against the "leads" quota, and - when it was sourced from a
 * paid data provider (source starting "provider:", e.g. "provider:apollo") - also against
 * the separate "premiumLeads" sub-quota. Use this instead of a bare consume(db, orgId,
 * "leads", 1) anywhere a PipelineLead/ProviderPerson result is being persisted, so paid
 * provider usage is metered independently of free web-discovery usage.
 */
export async function consumeLead(db: Db, orgId: string, source?: string) {
  const count = await consume(db, orgId, "leads", 1);
  if (source?.startsWith("provider:")) {
    // Best-effort: gating already happened via remainingPremiumBudget() before the provider
    // call was made, so this should essentially never throw in practice.
    await consume(db, orgId, "premiumLeads", 1).catch(() => {});
  }
  return count;
}
