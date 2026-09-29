import type { AttributeInsight, IcpLearning } from "./learn.js";

/**
 * Apply what the send history taught us to a lead nobody has contacted yet.
 *
 * `learnFromOutcomes` already works out which attributes correlate with a positive reply,
 * with Wilson bounds and a sufficiency gate - and nothing used the result. It was shown on
 * a dashboard and never applied, so the product knew which segments replied and still
 * ranked a new lead from those segments exactly like any other.
 *
 * This closes that loop. It is deliberately conservative, because the failure mode of a
 * predictive score is not being wrong - it is being wrong confidently, on evidence too thin
 * to support it, in a number that looks identical to a well-evidenced one.
 *
 * Three guards:
 *
 *  1. Nothing is predicted until the learning itself says it is sufficient. Below that, the
 *     rule score is returned unchanged and `applied` is false.
 *  2. A segment only counts when its confidence interval EXCLUDES the baseline. A segment
 *     that replies at 12% against a 10% baseline is not a better segment; it is the same
 *     segment, measured noisily, and lift alone cannot tell the difference.
 *  3. The adjustment is bounded. The learned signal moves a score by at most 20 points, so
 *     a thin correlation can never override an explicit ICP - the customer's own definition
 *     of a good lead outranks our inference about it.
 */

export interface PredictionInput {
  /** The same flat attribute bag the learning was built from. */
  attributes: Record<string, string | null | undefined>;
  /** The deterministic rule score, 0..100. */
  ruleScore: number;
}

export interface Prediction {
  /** The blended score, 0..100. Equals ruleScore when nothing could be applied. */
  score: number;
  ruleScore: number;
  /** True when learned evidence actually moved the score. */
  applied: boolean;
  /** Points added or removed - the final, clamped and rounded figure, so that
   * `ruleScore + adjustment` always equals `score` when no other stage has run. */
  adjustment: number;
  /** The segments that moved it, strongest first. */
  evidence: { attribute: string; value: string; lift: number; n: number; direction: AttributeInsight["direction"] }[];
  /** Plain-language account of what was applied and why - or why nothing was. */
  reason: string;
}

/** Most a learned correlation may move a score. The explicit ICP stays in charge. */
const MAX_ADJUSTMENT = 20;

/**
 * Minimum segment size before a correlation may move a real lead's rank.
 *
 * Higher than the threshold for DISPLAYING an insight, and that difference is the whole
 * point: a dashboard may say "fintech looks promising so far" from 8 leads, because a
 * person reads that with their own judgement attached. Reordering someone's working list
 * by it is a decision made on their behalf, and deserves more evidence.
 */
const MIN_N_TO_ACT = 15;

/**
 * Does this insight clear the bar for being used on a real lead?
 *
 * The interval check is deliberately re-asserted even though `learnFromOutcomes` already
 * enforces it - an earlier version of this comment claimed it was a second, independent
 * threshold, which was simply untrue: it re-tested exactly the condition learn.ts had
 * already applied, so it could never reject anything. The real second threshold is the
 * sample size, which is genuinely stricter here than for display.
 */
function usable(i: AttributeInsight): boolean {
  if (i.n < MIN_N_TO_ACT) return false;
  return i.direction === "outperforms" ? i.ci.lower > i.baseline : i.ci.upper < i.baseline;
}

export function predictLeadScore(learning: IcpLearning, input: PredictionInput): Prediction {
  const ruleScore = Math.max(0, Math.min(100, input.ruleScore));
  const base: Prediction = { score: ruleScore, ruleScore, applied: false, adjustment: 0, evidence: [], reason: "" };

  if (!learning.sufficient) {
    return {
      ...base,
      reason: `Not enough send history yet (${learning.sampleSize} contacted, ${learning.positives} positive). The rule score stands on its own until there is something real to learn from.`,
    };
  }

  const matched = learning.insights.filter((i) => {
    const v = input.attributes[i.attribute];
    return !!v && v.toLowerCase() === i.value.toLowerCase() && usable(i);
  });

  if (matched.length === 0) {
    return {
      ...base,
      reason: "Nothing in this lead matches a segment whose reply rate is measurably different from your baseline.",
    };
  }

  // Each segment contributes in proportion to how far its lift is from 1, damped so that a
  // second and third matching segment add less than the first: they are usually correlated
  // (fintech VPs at 51-200 companies are one population described three ways), and adding
  // them at full weight would triple-count a single piece of evidence.
  /**
   * Strength from the LOG of the lift, not from `lift - 1`.
   *
   * Lift is a ratio, so it is asymmetric around 1: outperformance runs to infinity while
   * underperformance is squeezed into [0, 1). A linear `lift - 1` therefore hit the +1 cap
   * at 2x but could only reach -1 at a lift of exactly zero - so a segment replying at
   * twice the baseline earned +20 while its exact inverse, replying at half, earned only
   * -10. Every score drifted upward, and a segment replying at a fifth of baseline - a
   * brutal signal - was penalised less than a merely-good segment was rewarded.
   *
   * log(lift) is symmetric: 2x and 0.5x are equal and opposite. Scaled so that a 3x segment
   * saturates the cap, which is about where a lift stops being worth more evidence.
   */
  const strengthOf = (lift: number) => {
    if (!(lift > 0)) return -1; // a segment that never replies is the strongest negative
    return Math.max(-1, Math.min(1, Math.log(lift) / Math.log(3)));
  };

  const ordered = [...matched].sort((a, b) => Math.abs(strengthOf(b.lift)) - Math.abs(strengthOf(a.lift)));
  let adjustment = 0;
  ordered.forEach((i, idx) => {
    adjustment += strengthOf(i.lift) * MAX_ADJUSTMENT * Math.pow(0.5, idx);
  });
  adjustment = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(adjustment)));

  const score = Math.max(0, Math.min(100, ruleScore + adjustment));
  const top = ordered[0];
  const verb = adjustment >= 0 ? "up" : "down";

  return {
    score,
    ruleScore,
    applied: adjustment !== 0,
    adjustment,
    evidence: ordered.map((i) => ({ attribute: i.attribute, value: i.value, lift: i.lift, n: i.n, direction: i.direction })),
    reason:
      adjustment === 0
        ? "Matching segments cancelled out - some reply more than your baseline, some less."
        : `Scored ${verb} ${Math.abs(adjustment)} from your own reply history: ${top.value} ${top.direction === "outperforms" ? "replies" : "replies less"} at ${top.lift.toFixed(1)}x your baseline across ${top.n} contacted leads${ordered.length > 1 ? `, plus ${ordered.length - 1} other matching segment${ordered.length > 2 ? "s" : ""}` : ""}.`,
  };
}
