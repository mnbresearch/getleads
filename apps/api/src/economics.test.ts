/**
 * Every paid plan keeps at least 80% gross margin at FULL use of everything it sells, after
 * payment fees (packages/db/src/economics.ts). Hosted MCP is why "full use" is the bar: an
 * AI assistant can drive every monthly limit to its cap, every month.
 *
 * If a limit, a price or a unit cost changes, this is the check that says whether the plan
 * still pays for itself. Fix the plan, never the floor.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FREE_AI_PLANS, fullUseEconomics, MIN_GROSS_MARGIN, PLANS, planEconomics, UNIT_COST_USD } from "@prospex/db";

describe("plan economics at full use", () => {
  const all = planEconomics();

  it("keeps every paid plan at or above the floor, after payment fees", () => {
    expect(MIN_GROSS_MARGIN).toBe(0.8);
    const paid = all.filter((e) => e.priceUsd > 0);
    expect(paid.length).toBeGreaterThanOrEqual(4);
    for (const e of paid) expect(e.grossMargin, `${e.plan}: ${JSON.stringify(e)}`).toBeGreaterThanOrEqual(MIN_GROSS_MARGIN);
  });

  it("puts hosted MCP on Growth and above, and on no free or entry plan", () => {
    const mcp = all.filter((e) => e.mcp).map((e) => e.plan).sort();
    expect(mcp).toEqual(["enterprise", "growth", "scale"]);
    for (const id of ["free", "pilot", "starter"]) expect(PLANS[id].limits.mcpCallsPerMonth ?? 0).toBe(0);
  });

  it("charges the paid AI engine to every plan that can reach it", () => {
    // The guard against an optimistic model: a plan routed to Anthropic must carry its cost.
    const core = readFileSync(resolve(__dirname, "../../../packages/core/src/ai/provider.ts"), "utf8");
    const m = /FREE_TIER_ONLY_PLANS = new Set\(\[([^\]]*)\]\)/.exec(core);
    expect(m).toBeTruthy();
    const freeInCore = new Set([...m![1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]));
    expect([...freeInCore].sort()).toEqual([...FREE_AI_PLANS].sort());
    const growth = fullUseEconomics("growth");
    expect(growth.lines.aiMessages).toBeCloseTo(PLANS.growth.limits.aiMessagesPerMonth * UNIT_COST_USD.aiMessagePaid, 2);
  });

  it("would fail a plan that sold more than it can pay for (the check can bite)", () => {
    const greedy = { ...PLANS.growth.limits, premiumLeadsPerMonth: 5000 };
    expect(fullUseEconomics("growth", greedy).grossMargin!).toBeLessThan(MIN_GROSS_MARGIN);
  });
});
