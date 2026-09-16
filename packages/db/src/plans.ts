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

export function limitsFor(plan: string): PlanLimits {
  return PLANS[plan]?.limits ?? PLANS.free.limits;
}
