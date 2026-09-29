import { describe, expect, it } from "vitest";
import { predictLeadScore } from "./predict.js";
import { learnFromOutcomes, type IcpLearning, type OutcomeSample } from "./learn.js";

/**
 * The failure mode of a predictive score is not being wrong. It is being wrong
 * CONFIDENTLY, on evidence too thin to support it, in a number that looks exactly like a
 * well-evidenced one - and then ranking someone's day by it.
 */
describe("predictive scoring refuses to predict from noise", () => {
  /**
   * Build a history where `winnerIndustry` genuinely replies more often.
   *
   * `seniority` deliberately VARIES. A first version set it to "vp" on every sample, which
   * makes that group cover the whole population - and learn.ts drops any group whose size
   * equals the sample size, because a segment that is everybody explains nothing. So no
   * test could ever match two segments at once, and the damping test below passed against
   * a version with the damping deleted.
   */
  function history(n: number, winnerIndustry: string): OutcomeSample[] {
    const out: OutcomeSample[] = [];
    for (let i = 0; i < n; i++) {
      const isWinner = i % 2 === 0;
      // Seniority tracks industry with ~10% crossover, so both are real signals and they
      // are correlated with each other - which is precisely the situation damping exists
      // for: "fintech" and "vp" are largely one population described two ways.
      const crossover = i % 10 === 7;
      out.push({
        attributes: {
          industry: isWinner ? winnerIndustry : "Construction",
          seniority: (isWinner ? !crossover : crossover) ? "vp" : "director",
        },
        // Winner segment replies ~60% of the time, the other ~5%.
        positive: isWinner ? i % 10 < 6 : i % 20 === 0,
      });
    }
    return out;
  }

  it("does not touch the score before there is enough history", () => {
    const learning = learnFromOutcomes(history(6, "Fintech"));
    expect(learning.sufficient).toBe(false);

    const p = predictLeadScore(learning, { attributes: { industry: "Fintech" }, ruleScore: 60 });
    expect(p.applied).toBe(false);
    expect(p.score).toBe(60);
    expect(p.reason).toMatch(/not enough send history/i);
  });

  it("raises the score for a segment that measurably outperforms", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    expect(learning.sufficient).toBe(true);

    const p = predictLeadScore(learning, { attributes: { industry: "Fintech", seniority: "vp" }, ruleScore: 50 });
    expect(p.applied).toBe(true);
    expect(p.score).toBeGreaterThan(50);
    expect(p.evidence[0].attribute).toBe("industry");
    expect(p.reason).toMatch(/your own reply history/i);
  });

  it("lowers it for a segment that measurably underperforms", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    const p = predictLeadScore(learning, { attributes: { industry: "Construction" }, ruleScore: 50 });
    expect(p.score).toBeLessThan(50);
  });

  it("leaves a lead alone when it matches no measurable segment", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    const p = predictLeadScore(learning, { attributes: { industry: "Aerospace" }, ruleScore: 50 });
    expect(p.applied).toBe(false);
    expect(p.score).toBe(50);
    expect(p.reason).toMatch(/measurably different/i);
  });

  /**
   * The guard that separates this from lift-chasing. A segment replying at 12% against a
   * 10% baseline is not a better segment - it is the same segment measured noisily, and
   * lift alone cannot tell those apart.
   */
  it("ignores a segment whose interval still contains the baseline", () => {
    const fabricated: IcpLearning = {
      sampleSize: 200,
      positives: 40,
      baseline: 0.2,
      sufficient: true,
      requirements: { minSamples: 40, minPositives: 5, minGroupSize: 8 },
      insights: [
        {
          attribute: "industry",
          value: "Fintech",
          n: 20,
          positives: 5,
          rate: 0.25,
          baseline: 0.2,
          lift: 1.25,
          // Wide interval straddling the baseline: this is noise wearing a lift.
          ci: { lower: 0.11, upper: 0.47 },
          direction: "outperforms",
          reason: "tentative",
        },
      ],
      suggestions: { add: {}, avoid: {} },
      summary: "",
    };

    const p = predictLeadScore(fabricated, { attributes: { industry: "Fintech" }, ruleScore: 50 });
    expect(p.applied).toBe(false);
    expect(p.score).toBe(50);
  });

  it("never lets a learned correlation override the customer's own ICP", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    // A lead the ICP rules scored near zero must not be lifted into the top of the list by
    // a correlation, however strong.
    const low = predictLeadScore(learning, { attributes: { industry: "Fintech", seniority: "vp" }, ruleScore: 5 });
    expect(low.score).toBeLessThanOrEqual(25);
    expect(Math.abs(low.adjustment)).toBeLessThanOrEqual(20);

    // And a strong ICP match is not destroyed by one either.
    const high = predictLeadScore(learning, { attributes: { industry: "Construction" }, ruleScore: 95 });
    expect(high.score).toBeGreaterThanOrEqual(75);
  });

  it("stays inside 0..100", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    for (const ruleScore of [0, 100]) {
      const p = predictLeadScore(learning, { attributes: { industry: ruleScore === 0 ? "Construction" : "Fintech" }, ruleScore });
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
    }
  });

  /**
   * Two modest lifts, deliberately well under the cap.
   *
   * A first version used the strong synthetic history, where a single segment already
   * saturated the +20 ceiling - so removing the damping entirely changed nothing and the
   * test passed against it. The clamp was doing the work the assertion was claiming for
   * the damping. With lifts this size the sum stays in range and the two are separable.
   */
  it("damps a second correlated segment instead of counting it twice", () => {
    const insight = (attribute: string, value: string) => ({
      attribute,
      value,
      n: 100,
      positives: 39,
      rate: 0.39,
      baseline: 0.3,
      lift: 1.3,
      ci: { lower: 0.34, upper: 0.44 },
      direction: "outperforms" as const,
      reason: "",
    });
    const learning = {
      sampleSize: 400,
      positives: 120,
      baseline: 0.3,
      sufficient: true as const,
      requirements: { minSamples: 40, minPositives: 5, minGroupSize: 8 },
      insights: [insight("industry", "Fintech"), insight("seniority", "vp")],
      suggestions: { add: {}, avoid: {} },
      summary: "",
    };

    const one = predictLeadScore(learning, { attributes: { industry: "Fintech" }, ruleScore: 50 });
    const two = predictLeadScore(learning, { attributes: { industry: "Fintech", seniority: "vp" }, ruleScore: 50 });

    expect(one.evidence.length).toBe(1);
    expect(two.evidence.length).toBe(2);
    expect(one.adjustment).toBeGreaterThan(0);
    expect(one.adjustment).toBeLessThan(20); // not saturated, so damping is observable

    const firstGain = one.adjustment;
    const secondGain = two.adjustment - one.adjustment;
    // Halved, not repeated: the second segment is largely the same population.
    expect(secondGain).toBeGreaterThan(0);
    expect(secondGain).toBeLessThan(firstGain);
    expect(two.adjustment).toBeLessThan(firstGain * 2);
  });

  /**
   * Lift is a ratio, so it is asymmetric around 1: outperformance runs to infinity while
   * underperformance is squeezed into [0, 1). A linear `lift - 1` rewarded a 2x segment
   * twice as hard as it punished its exact inverse, biasing every score upward.
   */
  it("treats a segment and its exact inverse as equal and opposite", () => {
    const learning = learnFromOutcomes(history(400, "Fintech"));
    const base = { sufficient: true as const };
    void base;

    const mk = (lift: number, n = 100) =>
      predictLeadScore(
        {
          sampleSize: 400,
          positives: 120,
          baseline: 0.3,
          sufficient: true,
          requirements: { minSamples: 40, minPositives: 5, minGroupSize: 8 },
          insights: [
            {
              attribute: "industry",
              value: "X",
              n,
              positives: Math.round(0.3 * lift * n),
              rate: 0.3 * lift,
              baseline: 0.3,
              lift,
              // Tight interval, comfortably clear of the baseline in the right direction.
              ci: lift > 1 ? { lower: 0.3 * lift - 0.02, upper: 0.3 * lift + 0.02 } : { lower: 0.3 * lift - 0.02, upper: 0.3 * lift + 0.02 },
              direction: lift > 1 ? "outperforms" : "underperforms",
              reason: "test",
            },
          ],
          suggestions: { add: {}, avoid: {} },
          summary: "",
        },
        { attributes: { industry: "X" }, ruleScore: 50 },
      );

    const up = mk(2);
    const down = mk(0.5);
    expect(up.adjustment).toBeGreaterThan(0);
    expect(down.adjustment).toBeLessThan(0);
    // Equal and opposite, give or take rounding.
    expect(Math.abs(up.adjustment + down.adjustment)).toBeLessThanOrEqual(1);
    void learning;
  });

  it("will not act on a segment too small to reorder someone's day by", () => {
    // Clears the interval test but has only 9 leads behind it: enough to mention on a
    // dashboard, not enough to silently move a lead up someone's list.
    const thin = predictLeadScore(
      {
        sampleSize: 200,
        positives: 60,
        baseline: 0.3,
        sufficient: true,
        requirements: { minSamples: 40, minPositives: 5, minGroupSize: 8 },
        insights: [
          { attribute: "industry", value: "Fintech", n: 9, positives: 8, rate: 0.89, baseline: 0.3, lift: 2.9, ci: { lower: 0.6, upper: 0.98 }, direction: "outperforms", reason: "" },
        ],
        suggestions: { add: {}, avoid: {} },
        summary: "",
      },
      { attributes: { industry: "Fintech" }, ruleScore: 50 },
    );
    expect(thin.applied).toBe(false);
    expect(thin.score).toBe(50);
  });
});
