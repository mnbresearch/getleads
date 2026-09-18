/**
 * Visibility metrics: turning a pile of individual AI answers into a number you can act on,
 * and refusing to pretend you can act on numbers that are still noise.
 *
 * This is the part of AI visibility most tools get wrong, so it is worth being explicit.
 *
 * An LLM answer is a sample, not a measurement. Ask the same engine the same question
 * twice and you can get different brands, in a different order, with different links.
 * Temperature, model updates, personalisation and retrieval all move the result. A tool
 * that runs a prompt once, finds you missing, and reports "your visibility dropped to 0%"
 * has measured nothing except variance.
 *
 * So everything here is built on repeated sampling:
 *
 *  - A rate is always reported with a Wilson confidence interval, never as a bare point
 *    estimate. 1 mention out of 2 runs is not a 50% mention rate in any useful sense.
 *  - A change over time is only called real when the intervals do not overlap. Otherwise
 *    it is reported as "no detectable change", which is usually the truthful answer.
 *  - Sample size is surfaced everywhere, so a thin number always looks thin.
 *
 * The same standard already governs ICP learning and A/B winner selection in this
 * codebase. It is a product philosophy, not a one-off: do not report noise as signal.
 */

import { wilsonInterval } from "../icp/learn.js";

/** One analyzed answer, reduced to what the metrics care about. */
export interface VisibilityObservation {
  /** Which engine produced it, e.g. "chatgpt", "perplexity", "gemini". */
  engine: string;
  /** Identifier of the tracked prompt. */
  promptId: string;
  /** Was the tracked brand present at all (named or cited)? */
  mentioned: boolean;
  /** Was the brand's own domain linked? */
  cited: boolean;
  /** Rank among brands named, 1 = first. null when absent. */
  position: number | null;
  /** Brands named in this answer, in order, for share-of-voice. */
  brands: string[];
  /** When the run happened. */
  at: Date | string;
}

export interface Rate {
  value: number;
  ci: { lower: number; upper: number };
  n: number;
  positives: number;
}

export interface VisibilityMetrics {
  runs: number;
  /** Fraction of answers naming or citing the brand, with interval. */
  mentionRate: Rate;
  /** Fraction of answers linking the brand's own domain. */
  citationRate: Rate;
  /** Mean rank when present. null when never present. Lower is better. */
  avgPosition: number | null;
  /** Fraction of answers where the brand was named first. */
  topSpotRate: Rate;
  /** Share of all brand mentions across answers that were yours. */
  shareOfVoice: Rate;
  /** Whether there is enough here to say anything. */
  sufficient: boolean;
  minRuns: number;
  summary: string;
}

/** Per-competitor standing, ranked by how often each appears. */
export interface CompetitorStanding {
  name: string;
  appearances: number;
  appearanceRate: number;
  avgPosition: number | null;
  /** Answers where they appear and you do not. The list of answers you are losing. */
  beatsYou: number;
}

const DEFAULT_MIN_RUNS = 20;

function rate(positives: number, n: number): Rate {
  return { value: n > 0 ? positives / n : 0, ci: wilsonInterval(positives, n), n, positives };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Aggregate observations into metrics for one brand.
 *
 * `sufficient` is false below `minRuns`, and the summary says what is still needed rather
 * than dressing up a thin sample.
 */
export function visibilityMetrics(
  observations: VisibilityObservation[],
  opts: { brandName: string; minRuns?: number } = { brandName: "your brand" },
): VisibilityMetrics {
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const runs = observations.length;
  const mentioned = observations.filter((o) => o.mentioned);
  const positions = mentioned.map((o) => o.position).filter((p): p is number => typeof p === "number" && p > 0);

  const mentionRate = rate(mentioned.length, runs);
  const citationRate = rate(observations.filter((o) => o.cited).length, runs);
  const topSpotRate = rate(observations.filter((o) => o.position === 1).length, runs);

  // Share of voice is over mention slots, not over answers: an answer naming five
  // competitors and you once is not "100% visibility" for that answer.
  const totalBrandMentions = observations.reduce((a, o) => a + (o.brands?.length ?? 0), 0);
  const shareOfVoice = rate(mentioned.length, totalBrandMentions);

  const avgPosition = positions.length ? Number((positions.reduce((a, p) => a + p, 0) / positions.length).toFixed(2)) : null;
  const sufficient = runs >= minRuns;

  let summary: string;
  if (runs === 0) {
    summary = "No runs yet.";
  } else if (!sufficient) {
    summary = `Only ${runs} run${runs === 1 ? "" : "s"}. Need ${minRuns - runs} more before these numbers mean anything, because a single answer is a sample, not a measurement.`;
  } else if (mentioned.length === 0) {
    summary = `${opts.brandName} did not appear in any of ${runs} answers. Nothing to tune yet: this is an absence, not a ranking problem.`;
  } else {
    const ci = mentionRate.ci;
    summary =
      `${opts.brandName} appears in ${pct(mentionRate.value)} of answers ` +
      `(95% CI ${pct(ci.lower)} to ${pct(ci.upper)}, n=${runs})` +
      (avgPosition ? `, typically at position ${avgPosition}` : "") +
      (citationRate.value > 0 ? `, and is linked directly in ${pct(citationRate.value)}` : ", but is never linked directly") +
      ".";
  }

  return { runs, mentionRate, citationRate, avgPosition, topSpotRate, shareOfVoice, sufficient, minRuns, summary };
}

/** Who else owns these answers, and how often they win when you are absent. */
export function competitorStandings(observations: VisibilityObservation[], brandName: string, limit = 10): CompetitorStanding[] {
  const runs = observations.length;
  const tally = new Map<string, { appearances: number; positions: number[]; beatsYou: number }>();
  for (const o of observations) {
    const seen = new Set<string>();
    (o.brands ?? []).forEach((b, i) => {
      if (b === brandName || seen.has(b)) return;
      seen.add(b);
      const t = tally.get(b) ?? { appearances: 0, positions: [], beatsYou: 0 };
      t.appearances += 1;
      t.positions.push(i + 1);
      if (!o.mentioned) t.beatsYou += 1;
      tally.set(b, t);
    });
  }
  return Array.from(tally.entries())
    .map(([name, t]) => ({
      name,
      appearances: t.appearances,
      appearanceRate: runs > 0 ? t.appearances / runs : 0,
      avgPosition: t.positions.length ? Number((t.positions.reduce((a, p) => a + p, 0) / t.positions.length).toFixed(2)) : null,
      beatsYou: t.beatsYou,
    }))
    .sort((a, b) => b.appearances - a.appearances || (a.avgPosition ?? 99) - (b.avgPosition ?? 99))
    .slice(0, limit);
}

export interface EngineMetrics {
  engine: string;
  metrics: VisibilityMetrics;
}

/**
 * Metrics split per engine.
 *
 * This is not a nicety, it is the more correct view. ChatGPT, Gemini and Groq are trained
 * and retrieved differently and routinely disagree about who they recommend, so a single
 * blended "AI visibility" number describes no engine that actually exists. Worse, when
 * engines are sampled unevenly the blend silently weights toward whichever one ran most.
 *
 * Report the blend for a headline if you must, but act on the per-engine rows.
 */
export function metricsByEngine(observations: VisibilityObservation[], brandName: string, minRuns?: number): EngineMetrics[] {
  const byEngine = new Map<string, VisibilityObservation[]>();
  for (const o of observations) {
    const arr = byEngine.get(o.engine) ?? [];
    arr.push(o);
    byEngine.set(o.engine, arr);
  }
  return Array.from(byEngine.entries())
    .map(([engine, obs]) => ({ engine, metrics: visibilityMetrics(obs, { brandName, minRuns }) }))
    .sort((a, b) => b.metrics.runs - a.metrics.runs);
}

/**
 * Do engines disagree more than sampling noise explains?
 *
 * Returns null when fewer than two engines have enough data to compare. When they do
 * disagree, that is a real finding: it means your visibility problem is engine-specific
 * rather than general, and the fix differs accordingly.
 */
export function engineDisagreement(
  observations: VisibilityObservation[],
  brandName: string,
): { disagree: boolean; best: EngineMetrics; worst: EngineMetrics; summary: string } | null {
  const rows = metricsByEngine(observations, brandName).filter((r) => r.metrics.sufficient);
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => b.metrics.mentionRate.value - a.metrics.mentionRate.value);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const disagree = best.metrics.mentionRate.ci.lower > worst.metrics.mentionRate.ci.upper;
  return {
    disagree,
    best,
    worst,
    summary: disagree
      ? `${best.engine} mentions you in ${pct(best.metrics.mentionRate.value)} of answers but ${worst.engine} only ${pct(worst.metrics.mentionRate.value)}, and the intervals separate. This is an engine-specific gap, not a general one.`
      : `Engines are within sampling noise of each other (${rows.map((r) => `${r.engine} ${pct(r.metrics.mentionRate.value)}`).join(", ")}). Treat visibility as general rather than engine-specific.`,
  };
}

export interface VisibilityChange {
  /** True only when the two intervals do not overlap. */
  significant: boolean;
  direction: "up" | "down" | "flat";
  before: Rate;
  after: Rate;
  /** Percentage points, point estimate. Meaningless unless `significant`. */
  deltaPoints: number;
  summary: string;
}

/**
 * Did visibility actually change between two periods?
 *
 * Deliberately conservative. Two Wilson intervals that overlap are not distinguishable
 * at this sample size, and reporting that overlap as a trend is how these tools generate
 * false alarms. Most week-on-week wobble in AI answers is exactly that.
 */
export function compareVisibility(before: VisibilityObservation[], after: VisibilityObservation[]): VisibilityChange {
  const b = rate(before.filter((o) => o.mentioned).length, before.length);
  const a = rate(after.filter((o) => o.mentioned).length, after.length);
  const deltaPoints = Number(((a.value - b.value) * 100).toFixed(1));

  const separated = a.ci.lower > b.ci.upper || a.ci.upper < b.ci.lower;
  const direction: VisibilityChange["direction"] = !separated ? "flat" : a.value > b.value ? "up" : "down";

  let summary: string;
  if (before.length === 0 || after.length === 0) {
    summary = "Not enough history in one of the two periods to compare.";
  } else if (!separated) {
    summary =
      `No detectable change: ${pct(b.value)} to ${pct(a.value)}, but the confidence intervals overlap ` +
      `(n=${before.length} then n=${after.length}). Treat this as flat, not as a trend.`;
  } else {
    summary = `Visibility moved ${direction} from ${pct(b.value)} to ${pct(a.value)}, and the intervals separate, so this one is real.`;
  }
  return { significant: separated, direction, before: b, after: a, deltaPoints, summary };
}

/**
 * Where to spend effort next: the prompts where you are weakest but a competitor proves
 * the answer is winnable.
 *
 * Prompts nobody wins are deprioritised over prompts a rival owns, because the second
 * kind is evidence that an answer slot exists and is simply not yours.
 */
export function visibilityGaps(
  observations: VisibilityObservation[],
  brandName: string,
  opts: { minRunsPerPrompt?: number; limit?: number } = {},
): { promptId: string; runs: number; mentionRate: number; topRival: string | null; rivalRate: number }[] {
  const minRuns = opts.minRunsPerPrompt ?? 5;
  const byPrompt = new Map<string, VisibilityObservation[]>();
  for (const o of observations) {
    const arr = byPrompt.get(o.promptId) ?? [];
    arr.push(o);
    byPrompt.set(o.promptId, arr);
  }
  const out = [];
  for (const [promptId, obs] of byPrompt) {
    if (obs.length < minRuns) continue;
    const mine = obs.filter((o) => o.mentioned).length / obs.length;
    const rivals = competitorStandings(obs, brandName, 1);
    const topRival = rivals[0] ?? null;
    out.push({
      promptId,
      runs: obs.length,
      mentionRate: Number(mine.toFixed(3)),
      topRival: topRival?.name ?? null,
      rivalRate: topRival ? Number(topRival.appearanceRate.toFixed(3)) : 0,
    });
  }
  // Biggest winnable gap first: a rival dominating where you are absent.
  return out
    .sort((a, b) => b.rivalRate - b.mentionRate - (a.rivalRate - a.mentionRate))
    .slice(0, opts.limit ?? 10);
}
