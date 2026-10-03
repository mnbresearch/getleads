import type { PlanLimits } from "./schema.js";

/**
 * Plan economics, Sept 2026 (see docs/PRICING.md for the full derivation).
 *
 * Two sourcing paths for a lead, gated by `premiumLeadsPerMonth`:
 *  - Standard (the bulk of leadsPerMonth): web search discovery + our own site-crawl
 *    enrichment + pattern-based email finding + MX/SMTP verification. No paid API touches
 *    a customer's request. Marginal cost is ~$0 (a fraction of a cent of search-query cost).
 *  - Premium (capped by premiumLeadsPerMonth, a SUB-quota of leadsPerMonth, not additive):
 *    resolved through a paid data provider (Apollo/Hunter/PDL) for a verified email and a
 *    much higher hit rate. This is what actually costs us money.
 *
 * free/pilot: premiumLeadsPerMonth = 0. These orgs only ever get scraped/crawled leads -
 * exactly "whatever we can find for free" - so they cost us effectively nothing to run.
 *
 * The same free-tier-first principle applies to AI features (account briefs, reply-triage
 * auto-draft, conversational ICP assistant - see createAiProviderForPlan() in
 * packages/core/src/ai/provider.ts): free/pilot/starter plans are only ever routed to free
 * AI providers (Groq/Gemini), never the paid Anthropic provider, regardless of AI_PROVIDER
 * env config. Growth+ plans get the best configured provider. All AI calls across every
 * plan are still metered against aiMessagesPerMonth below, so usage stays bounded either way.
 *
 * Paid tiers (starter/growth/scale/enterprise) are priced for >=85% gross margin against
 * real paid-provider costs at moderate volume:
 *   Apollo Professional  $79/user/mo,  2,000 export credits  -> ~$0.04/premium lead
 *   Hunter Growth (ann.) $104/mo,      10,000 credits        -> ~$0.01/verification
 *   Brave Search API     $5/1,000 queries (no free tier since Feb 2026) -> ~$0.005/search
 *   AI (Groq/Gemini free tiers first)  -> ~$0 marginal at these volumes
 *   Resend Pro            $20/mo/50k emails -> ~$0.0004/email
 * Standard (web-discovery) leads are costed inside the `searchesPerMonth` line, not
 * double-counted separately.
 */
export const PLANS: Record<string, { name: string; priceUsd: number; limits: PlanLimits }> = {
  free: {
    name: "Free",
    priceUsd: 0,
    limits: {
      leadsPerMonth: 50,
      premiumLeadsPerMonth: 0,
      searchesPerMonth: 20,
      verificationsPerMonth: 100,
      aiMessagesPerMonth: 50,
      emailsPerMonth: 100,
      campaigns: 1,
      seats: 1,
      apiAccess: true,
      integrations: false,
    },
  },
  pilot: {
    name: "Pilot",
    priceUsd: 0,
    limits: {
      leadsPerMonth: 1000,
      premiumLeadsPerMonth: 0,
      searchesPerMonth: 300,
      verificationsPerMonth: 2000,
      aiMessagesPerMonth: 1000,
      emailsPerMonth: 1500,
      campaigns: 5,
      seats: 3,
      apiAccess: true,
      integrations: true,
    },
  },

  // ── Paid, provider-backed tiers. COGS shown assumes moderate blended usage (not every
  // customer uses their full quota - real average utilization is well under 100%, which is
  // the other reason these margins hold up in practice, not just on paper). ──

  // COGS ~= 150 premium * $0.04 + 500 verif * $0.01 + 500 search * $0.005 + ai/email negligible
  //        = $6.00 + $5.00 + $2.50 + ~$1.30 = ~$14.80  ->  margin (109 - 14.8) / 109 = 86.4%
  starter: {
    name: "Starter",
    priceUsd: 109,
    limits: {
      leadsPerMonth: 1500,
      premiumLeadsPerMonth: 150,
      searchesPerMonth: 500,
      verificationsPerMonth: 500,
      aiMessagesPerMonth: 500,
      emailsPerMonth: 2000,
      campaigns: 3,
      seats: 2,
      apiAccess: true,
      integrations: true,
    },
  },

  // COGS ~= 500 premium * $0.04 + 1,500 verif * $0.01 + 2,000 search * $0.005 + ai/email ~$4.7
  //        = $20 + $15 + $10 + $4.70 = ~$49.70  ->  margin (359 - 49.7) / 359 = 86.2%
  growth: {
    name: "Growth",
    priceUsd: 359,
    limits: {
      leadsPerMonth: 6000,
      premiumLeadsPerMonth: 500,
      searchesPerMonth: 2000,
      verificationsPerMonth: 1500,
      aiMessagesPerMonth: 1500,
      emailsPerMonth: 8000,
      campaigns: 15,
      seats: 5,
      apiAccess: true,
      integrations: true,
    },
  },

  // COGS ~= 1,500 premium * $0.04 + 5,000 verif * $0.01 + 8,000 search * $0.005 + ai/email ~$28
  //        = $60 + $50 + $40 + $28 = ~$178  ->  margin (1199 - 178) / 1199 = 85.2%
  scale: {
    name: "Scale",
    priceUsd: 1199,
    limits: {
      leadsPerMonth: 20000,
      premiumLeadsPerMonth: 1500,
      searchesPerMonth: 8000,
      verificationsPerMonth: 5000,
      aiMessagesPerMonth: 8000,
      emailsPerMonth: 40000,
      campaigns: 100,
      seats: 15,
      apiAccess: true,
      integrations: true,
    },
  },

  // Enterprise: usually custom-quoted, but priced here as a real default. Volume tiers
  // (Apollo Organization, Hunter Scale, negotiated Brave/PDL) run ~20% cheaper per unit than
  // the mid-tier assumptions above, which is where the extra margin cushion at this size
  // comes from, not a thinner cost basis.
  // COGS ~= 5,000 premium * $0.032 + 15,000 verif * $0.008 + 25,000 search * $0.004 + ai/email ~$93
  //        = $160 + $120 + $100 + $93 = ~$473  ->  margin (3199 - 473) / 3199 = 85.2%
  enterprise: {
    name: "Enterprise",
    priceUsd: 3199,
    limits: {
      leadsPerMonth: 60000,
      premiumLeadsPerMonth: 5000,
      searchesPerMonth: 25000,
      verificationsPerMonth: 15000,
      aiMessagesPerMonth: 25000,
      emailsPerMonth: 120000,
      campaigns: 1000,
      seats: 50,
      apiAccess: true,
      integrations: true,
    },
  },
};

/** Every plan id that exists, in display order. */
export const PLAN_IDS: string[] = Object.keys(PLANS);

/**
 * Is this one of the real plan ids?
 *
 * `PLANS[x]` alone is not that question: PLANS is an ordinary object, so `PLANS["toString"]`,
 * `PLANS["constructor"]` and `PLANS["__proto__"]` are all truthy (they are inherited from
 * Object.prototype). A plan id taken from a request passed the `if (!PLANS[x])` check with any
 * of those names and was stored on the workspace. Only own keys are plans.
 */
export function isPlanId(plan: unknown): boolean {
  return typeof plan === "string" && Object.hasOwn(PLANS, plan);
}

/** A plan's default limits. Anything that is not a real plan id gets the free plan's. */
export function limitsFor(plan: string | null | undefined): PlanLimits {
  return isPlanId(plan) ? PLANS[plan as string].limits : PLANS.free.limits;
}

// ── Per-workspace limits (organizations.plan_limits) ──

/** Limits that are counts. Whole numbers, zero or more. */
export const NUMERIC_LIMIT_KEYS = ["leadsPerMonth", "premiumLeadsPerMonth", "searchesPerMonth", "verificationsPerMonth", "aiMessagesPerMonth", "emailsPerMonth", "campaigns", "seats"] as const;
/** Limits that are switches. */
export const BOOLEAN_LIMIT_KEYS = ["apiAccess", "integrations"] as const;
/**
 * Limits a workspace may carry that are not part of any plan's defaults.
 * `emailsPerDay` sets the workspace's daily sending ceiling explicitly (see
 * orgDailySendCeiling in apps/api); it must be at least 1.
 */
export const EXTRA_LIMIT_KEYS = ["emailsPerDay"] as const;
/** The largest count a limit may hold. Usage counters are 32-bit, so nothing above this means anything. */
export const MAX_PLAN_LIMIT = 1_000_000_000;

export type PlanOverrides = Partial<PlanLimits> & { emailsPerDay?: number };
export type EffectiveLimits = PlanLimits & { emailsPerDay?: number };

const isCount = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_PLAN_LIMIT;

/**
 * Keep only the entries of a stored `plan_limits` value that are real limits holding usable
 * values, and say which keys were dropped.
 *
 * The column is free-form JSON and the admin API used to store whatever it was sent, so a row
 * can hold `{"leadsPerMonth":"lots","seats":-1,"campaigns":null,"evil":{}}`. Read naively,
 * each of those turned a limit OFF: `Number("lots")` is NaN and `NaN > 0` is false, which the
 * quota code reads as "no limit". A value that is not a whole number of zero or more (or, for
 * a switch, not a boolean) is not an override at all - the plan's default applies.
 */
export function sanitizePlanLimits(raw: unknown): { limits: PlanOverrides; rejected: string[] } {
  const limits: Record<string, number | boolean> = {};
  const rejected: string[] = [];
  if (raw === null || raw === undefined) return { limits: limits as PlanOverrides, rejected };
  if (typeof raw !== "object" || Array.isArray(raw)) return { limits: limits as PlanOverrides, rejected: ["(not an object)"] };
  for (const key of Object.keys(raw as object)) {
    let v = (raw as Record<string, unknown>)[key];
    // A count stored as a plain digit string ("5000") was honoured before this check existed
    // (it went through Number()), so it still is. Nothing else in a string is.
    if (typeof v === "string" && /^\d{1,10}$/.test(v)) v = Number(v);
    if ((NUMERIC_LIMIT_KEYS as readonly string[]).includes(key) && isCount(v)) limits[key] = v;
    else if ((BOOLEAN_LIMIT_KEYS as readonly string[]).includes(key) && typeof v === "boolean") limits[key] = v;
    else if ((EXTRA_LIMIT_KEYS as readonly string[]).includes(key) && isCount(v, 1)) limits[key] = v;
    else rejected.push(key);
  }
  return { limits: limits as PlanOverrides, rejected };
}

/**
 * The limits a workspace actually has: its plan's defaults, with the usable entries of its
 * stored `plan_limits` on top. Use this everywhere a limit is read - never
 * `{ ...limitsFor(org.plan), ...org.planLimits }`, which lets a junk stored value through.
 * Every count in the result is a whole number of zero or more; every switch is a boolean.
 */
export function effectiveLimits(org: { plan?: string | null; planLimits?: unknown } | null | undefined): EffectiveLimits {
  return { ...limitsFor(org?.plan), ...sanitizePlanLimits(org?.planLimits).limits };
}

/**
 * What an operator changed for this workspace: the usable stored limits that differ from its
 * plan's defaults. (`plan_limits` holds the whole merged set, so the overrides are the
 * difference.) Empty when the workspace simply has its plan's limits.
 */
export function planOverrides(org: { plan?: string | null; planLimits?: unknown } | null | undefined): PlanOverrides {
  const defaults = limitsFor(org?.plan) as unknown as Record<string, unknown>;
  const stored = sanitizePlanLimits(org?.planLimits).limits as Record<string, unknown>;
  return Object.fromEntries(Object.entries(stored).filter(([k, v]) => defaults[k] !== v)) as PlanOverrides;
}
