/**
 * A/B variant winner selection for sequence steps.
 *
 * Sequence steps can carry variants, but round-robin assignment alone means a losing
 * subject line keeps getting sent forever. This decides when one variant has actually
 * beaten the others and should take the remaining traffic.
 *
 * Uses the same conservative standard as ICP learning: a winner is only declared when the
 * lower bound of its Wilson interval clears the upper bound of every rival, so a variant
 * that is 3-for-5 does not get to shut down a rival that is 40-for-200. Until then traffic
 * stays split, because stopping an experiment early is how you lock in noise.
 */

import { wilsonInterval } from "../icp/learn.js";

export interface VariantStats {
  variant: number;
  sent: number;
  /** Positive outcomes for this variant, normally replies. */
  positives: number;
}

export interface RankedVariant extends VariantStats {
  rate: number;
  ci: { lower: number; upper: number };
}

export interface ExperimentResult {
  /** Index of the winning variant, or null while the result is still inconclusive. */
  winner: number | null;
  confident: boolean;
  ranked: RankedVariant[];
  totalSent: number;
  /** Share of new sends each variant should receive, keyed by variant index. Sums to 1. */
  allocation: Record<number, number>;
  summary: string;
  requirements: { minSentPerVariant: number; minTotalPositives: number };
}

export interface ExperimentOptions {
  /** A variant needs this many sends before it can win or lose. Default 30. */
  minSentPerVariant?: number;
  /** The experiment needs this many positives overall before it can be called. Default 5. */
  minTotalPositives?: number;
  /** Traffic kept on non-winners after a decision, as insurance against drift. Default 0.1. */
  explorationShare?: number;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x >= 0.1 ? 0 : 1)}%`;
}

/**
 * Decide whether an A/B test has a winner, and how to split traffic either way.
 *
 * Always returns a usable `allocation`, so the caller never has to special-case the
 * inconclusive state.
 */
export function pickVariantWinner(stats: VariantStats[], opts: ExperimentOptions = {}): ExperimentResult {
  const minSentPerVariant = opts.minSentPerVariant ?? 30;
  const minTotalPositives = opts.minTotalPositives ?? 5;
  const exploration = Math.min(0.5, Math.max(0, opts.explorationShare ?? 0.1));
  const requirements = { minSentPerVariant, minTotalPositives };

  const ranked: RankedVariant[] = stats
    .map((s) => {
      const sent = Math.max(0, s.sent ?? 0);
      const positives = Math.max(0, Math.min(sent, s.positives ?? 0));
      return { variant: s.variant, sent, positives, rate: sent > 0 ? positives / sent : 0, ci: wilsonInterval(positives, sent) };
    })
    .sort((a, b) => b.ci.lower - a.ci.lower || b.rate - a.rate);

  const totalSent = ranked.reduce((a, v) => a + v.sent, 0);
  const totalPositives = ranked.reduce((a, v) => a + v.positives, 0);
  const evenSplit = () => {
    const alloc: Record<number, number> = {};
    if (ranked.length === 0) return alloc;
    const share = 1 / ranked.length;
    for (const v of ranked) alloc[v.variant] = share;
    return alloc;
  };

  if (ranked.length < 2) {
    return { winner: ranked[0]?.variant ?? null, confident: false, ranked, totalSent, allocation: evenSplit(), summary: "Only one variant in play, nothing to compare.", requirements };
  }

  const underpowered = ranked.some((v) => v.sent < minSentPerVariant) || totalPositives < minTotalPositives;
  if (underpowered) {
    const thinnest = Math.min(...ranked.map((v) => v.sent));
    const need: string[] = [];
    if (thinnest < minSentPerVariant) need.push(`${minSentPerVariant - thinnest} more sends on the thinnest variant`);
    if (totalPositives < minTotalPositives) need.push(`${minTotalPositives - totalPositives} more repl${minTotalPositives - totalPositives === 1 ? "y" : "ies"}`);
    return {
      winner: null,
      confident: false,
      ranked,
      totalSent,
      allocation: evenSplit(),
      summary: need.length ? `Too early to call. Need ${need.join(" and ")}. Traffic stays evenly split.` : "Too early to call.",
      requirements,
    };
  }

  const [lead, ...rest] = ranked;
  const confident = rest.every((v) => lead.ci.lower > v.ci.upper);
  if (!confident) {
    return {
      winner: null,
      confident: false,
      ranked,
      totalSent,
      allocation: evenSplit(),
      summary: `No clear winner yet across ${totalSent} sends. Variant ${lead.variant} leads at ${pct(lead.rate)} but the difference is still within noise.`,
      requirements,
    };
  }

  // Keep a slice on the losers: reply rates drift, and a permanently frozen split
  // would never notice.
  const allocation: Record<number, number> = {};
  allocation[lead.variant] = 1 - exploration;
  const share = rest.length > 0 ? exploration / rest.length : 0;
  for (const v of rest) allocation[v.variant] = share;

  const runnerUp = rest[0];
  return {
    winner: lead.variant,
    confident: true,
    ranked,
    totalSent,
    allocation,
    summary: `Variant ${lead.variant} wins at ${pct(lead.rate)} reply rate vs ${pct(runnerUp.rate)} for variant ${runnerUp.variant} (${lead.positives}/${lead.sent} against ${runnerUp.positives}/${runnerUp.sent}). Sending ${pct(1 - exploration)} of new traffic to it.`,
    requirements,
  };
}

/** Choose a variant index for one send, given an allocation. `rnd` is injectable for tests. */
export function allocateVariant(allocation: Record<number, number>, fallback: number, rnd: () => number = Math.random): number {
  const entries = Object.entries(allocation).map(([k, v]) => [Number(k), v] as const).filter(([, v]) => v > 0);
  if (entries.length === 0) return fallback;
  const total = entries.reduce((a, [, v]) => a + v, 0);
  let r = rnd() * total;
  for (const [variant, weight] of entries) {
    r -= weight;
    if (r <= 0) return variant;
  }
  return entries[entries.length - 1][0];
}
