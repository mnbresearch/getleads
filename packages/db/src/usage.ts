import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { organizations, usage, type PlanLimits } from "./schema.js";
import { effectiveLimits } from "./plans.js";

export type Metric = "leads" | "searches" | "verifications" | "aiMessages" | "emails" | "premiumLeads";

/** Which plan limit each usage metric is measured against. */
export const metricToLimit: Record<Metric, keyof PlanLimits> = {
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
  // effectiveLimits, not a bare spread of plan_limits: a junk stored value ("lots", -1, null)
  // came out of `Number(...)` as NaN or a negative, which every caller reads as "no limit".
  const limits = effectiveLimits(org);
  const out: Record<string, { used: number; limit: number }> = {};
  for (const m of Object.keys(metricToLimit) as Metric[]) {
    const used = rows.find((r) => r.metric === m)?.count ?? 0;
    out[m] = { used, limit: limits[metricToLimit[m]] as number };
  }
  return { period, plan: org?.plan ?? "free", usage: out };
}

export class QuotaExceededError extends Error {
  constructor(public metric: Metric, public used: number, public limit: number) {
    super(`Monthly quota exceeded for ${metric}: ${used}/${limit}`);
  }
}

export interface ConsumeOptions {
  /**
   * Keep the increment even when it takes the org over its limit, and do not throw.
   *
   * For work that has ALREADY happened and must be recorded - a model call that was made, a
   * provider lead that was returned. The default rolls the increment back and throws, and
   * callers wrapped that in `.catch(() => {})`, so usage past the limit was simply never
   * written while comments claimed "the overage is recorded".
   */
  allowOverage?: boolean;
}

/** Increment usage; throws QuotaExceededError if over plan limit (unless `allowOverage`). */
export async function consume(db: Db, orgId: string, metric: Metric, amount = 1, opts: ConsumeOptions = {}) {
  const period = currentPeriod();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  // A stored limit that is not a whole number of zero or more is ignored (plan default), so a
  // damaged plan_limits value can never switch a quota off. 0 still means "no limit" here.
  const limit = effectiveLimits(org)[metricToLimit[metric]] as number;
  const [row] = await db
    .insert(usage)
    .values({ orgId, period, metric, count: amount })
    .onConflictDoUpdate({
      target: [usage.orgId, usage.period, usage.metric],
      set: { count: sql`${usage.count} + ${amount}` },
    })
    .returning();
  if (limit > 0 && row.count > limit && !opts.allowOverage) {
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
  const limit = effectiveLimits(org).premiumLeadsPerMonth;
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
    // Recorded even past the limit. Gating happened before the provider call (via
    // remainingPremiumBudget); this is the ledger of what was actually spent, and the old
    // `.catch(() => {})` around a rolling-back consume() meant any lead past the cap was
    // simply never written down.
    await consume(db, orgId, "premiumLeads", 1, { allowOverage: true });
  }
  return count;
}

/**
 * Charge a quota and answer yes/no, never throwing for a plan limit.
 *
 * A database fault still throws: "you are out of quota" and "we could not record usage"
 * are different answers, and only the first is the customer's. Callers that need the
 * distinction as data use `tryConsume` in apps/api/src/lib/quota.ts.
 */
export async function tryConsumeQuota(db: Db, orgId: string, metric: Metric, amount = 1): Promise<boolean> {
  try {
    await consume(db, orgId, metric, amount);
    return true;
  } catch (e) {
    if (e instanceof QuotaExceededError) return false;
    throw e;
  }
}

/** The largest value a usage counter can hold (the column is a 32-bit integer). */
const MAX_USAGE_COUNT = 2_147_483_647;

/**
 * Change a workspace's used-count for this period by hand (the admin "credits" action), and
 * report what it was and what it is.
 *
 * `{ delta }` adds to the count (negative gives usage back); `{ set }` pins it. Either way the
 * result is kept between 0 and what the column can hold.
 *
 * The arithmetic happens in ONE statement, on the row as it is at that moment. The admin route
 * used to read the count, compute the new value in JavaScript and write that absolute number,
 * so ten "give one back" requests arriving together each read the same count and the last
 * writer won: ten grants moved the counter by four. The inner SELECT ... FOR UPDATE is what
 * makes `before` trustworthy too - it is the value this statement actually changed, not one
 * read a moment earlier.
 */
export async function adjustUsage(db: Db, orgId: string, metric: Metric, change: { delta: number } | { set: number }): Promise<{ period: string; before: number; after: number }> {
  const period = currentPeriod();
  // A workspace that has used nothing this month has no row yet. Creating an empty one first
  // (a no-op when it exists) lets the statement below always find a row to lock.
  await db.insert(usage).values({ orgId, period, metric, count: 0 }).onConflictDoNothing({ target: [usage.orgId, usage.period, usage.metric] });
  const next = "set" in change ? sql`LEAST(${MAX_USAGE_COUNT}::bigint, GREATEST(0::bigint, ${change.set}::bigint))::int` : sql`LEAST(${MAX_USAGE_COUNT}::bigint, GREATEST(0::bigint, u.count::bigint + ${change.delta}::bigint))::int`;
  const rows = (await db.execute(sql`
    UPDATE usage u SET count = ${next}
    FROM (SELECT id, count AS before FROM usage WHERE org_id = ${orgId} AND period = ${period} AND metric = ${metric} FOR UPDATE) prev
    WHERE u.id = prev.id
    RETURNING prev.before AS before, u.count AS after`)) as unknown as { before: number; after: number }[];
  const row = rows[0];
  if (!row) throw new Error("usage row disappeared while it was being adjusted");
  return { period, before: Number(row.before), after: Number(row.after) };
}
