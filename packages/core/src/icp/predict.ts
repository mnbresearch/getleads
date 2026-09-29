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
  /** Points added or removed, before clamping. */
  adjustment: number;
  /** The segments that moved it, strongest first. */
  evidence: { attribute: string; value: string; lift: number; n: number; direction: AttributeInsight["direction"] }[];
  /** Plain-language account of what was applied and why - or why nothing was. */
  reason: string;
}

/** Most a learned correlation may move a score. The explicit ICP stays in charge. */
const MAX_ADJUSTMENT = 20;

/**
 * Does this insight clear the bar for being used on a real lead?
 *
 * Displaying an insight and acting on one are different thresholds. The dashboard can show
 * "fintech replies more often, tentatively"; ranking a lead on it needs the interval to
 * actually exclude the baseline, or we are ranking on noise.
 */
function usable(i: AttributeInsight): boolean {
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
  const ordered = [...matched].sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1));
  let adjustment = 0;
  ordered.forEach((i, idx) => {
    const strength = Math.max(-1, Math.min(1, i.lift - 1));
    adjustment += strength * MAX_ADJUSTMENT * Math.pow(0.5, idx);
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
