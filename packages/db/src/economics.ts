import { PLANS } from "./plans.js";
import type { PlanLimits } from "./schema.js";

/**
 * What a plan costs us to serve when a customer uses ALL of it, and what we keep.
 *
 * docs/PRICING.md sized the plans on "moderate blended usage". Hosted MCP changes that
 * assumption: an AI assistant runs loops, so a workspace connected to Claude Code or Cursor
 * can reach every monthly limit, every month. A plan that carries MCP therefore has to hold
 * its margin at 100% use of every limit, after payment fees - not on an average.
 *
 * This is a GROSS margin: provider and payment costs per unit of what the plan sells. Hosting
 * (Render, Neon, Vercel) is a fixed cost shared by every customer and is not in it.
 *
 * Unit costs, and where each comes from (re-check before changing a price):
 *  - premium lead      $0.04   Apollo Professional, $79 / 2,000 export credits
 *  - verification      $0.01   Hunter Growth (annual), $104 / 10,000 credits
 *  - search query      $0.005  Brave Search API, $5 / 1,000
 *  - email sent        $0.0004 Resend Pro, $20 / 50,000
 *  - AI message (paid) $0.006  Anthropic Claude Haiku 3.5 ($0.80 in / $4 out per MTok), taking
 *                              every message at 2,000 tokens in and the full 1,024 out. Growth and
 *                              above use it first when a key is set (createAiProviderForPlan);
 *                              free, pilot and starter never do, so theirs costs $0.
 *  - MCP tool call     $0.0001 compute for one tools/call and the /v1 requests it makes in
 *                              process. Whatever the tool does that costs money (a search, a
 *                              verification, a lead) is already metered against the limits above.
 *  - payment           2.9% + $0.30 per monthly charge (Stripe, card), rounded up to 3%.
 * Enterprise assumes ~20% cheaper data units from volume contracts, as PRICING.md does.
 */
export const UNIT_COST_USD = {
  premiumLead: 0.04,
  verification: 0.01,
  search: 0.005,
  email: 0.0004,
  aiMessagePaid: 0.006,
  mcpCall: 0.0001,
} as const;

export const PAYMENT_FEE = { percent: 0.03, fixedUsd: 0.3 } as const;

/** Plans whose AI never reaches a paid engine (packages/core/src/ai/provider.ts FREE_TIER_ONLY_PLANS). */
export const FREE_AI_PLANS = new Set(["free", "pilot", "starter"]);

/** Data units bought on volume contracts. */
const VOLUME_DISCOUNT: Record<string, number> = { enterprise: 0.8 };

/** The floor every paid plan is held to at full use (economics.test.ts). */
export const MIN_GROSS_MARGIN = 0.8;

export interface PlanEconomics {
  plan: string;
  priceUsd: number;
  cogsUsd: number;
  paymentFeeUsd: number;
  grossMarginUsd: number;
  /** 0..1, or null for a free plan (no revenue to take a margin of). */
  grossMargin: number | null;
  lines: Record<string, number>;
  mcp: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A plan's month at 100% use of every limit it sells. */
export function fullUseEconomics(planId: string, limits: PlanLimits = PLANS[planId].limits, priceUsd = PLANS[planId].priceUsd): PlanEconomics {
  const d = VOLUME_DISCOUNT[planId] ?? 1;
  const mcpCalls = Math.max(0, limits.mcpCallsPerMonth ?? 0);
  const lines = {
    premiumLeads: Math.max(0, limits.premiumLeadsPerMonth) * UNIT_COST_USD.premiumLead * d,
    verifications: limits.verificationsPerMonth * UNIT_COST_USD.verification * d,
    searches: limits.searchesPerMonth * UNIT_COST_USD.search * d,
    emails: limits.emailsPerMonth * UNIT_COST_USD.email,
    aiMessages: FREE_AI_PLANS.has(planId) ? 0 : limits.aiMessagesPerMonth * UNIT_COST_USD.aiMessagePaid,
    mcpCalls: mcpCalls * UNIT_COST_USD.mcpCall,
  };
  const cogs = Object.values(lines).reduce((a, b) => a + b, 0);
  const fee = priceUsd > 0 ? priceUsd * PAYMENT_FEE.percent + PAYMENT_FEE.fixedUsd : 0;
  const kept = priceUsd - cogs - fee;
  return {
    plan: planId,
    priceUsd,
    cogsUsd: round(cogs),
    paymentFeeUsd: round(fee),
    grossMarginUsd: round(kept),
    grossMargin: priceUsd > 0 ? Math.round((kept / priceUsd) * 1000) / 1000 : null,
    lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, round(v)])),
    mcp: mcpCalls > 0,
  };
}

/** Every plan, at full use. */
export function planEconomics(): PlanEconomics[] {
  return Object.keys(PLANS).map((id) => fullUseEconomics(id));
}
