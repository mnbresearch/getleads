import { describe, expect, it } from "vitest";
import { predictLeadScore } from "./predict.js";
import { learnFromOutcomes, type IcpLearning, type OutcomeSample } from "./learn.js";

/**
 * The failure mode of a predictive score is not being wrong. It is being wrong
 * CONFIDENTLY, on evidence too thin to support it, in a number that looks exactly like a
 * well-evidenced one - and then ranking someone's day by it.
 */
describe("predictive scoring refuses to predict from noise", () => {
  /** Build a history where `winnerIndustry` genuinely replies more often. */
  function history(n: number, winnerIndustry: string): OutcomeSample[] {
    const out: OutcomeSample[] = [];
    for (let i = 0; i < n; i++) {
      const isWinner = i % 2 === 0;
      out.push({
        attributes: { industry: isWinner ? winnerIndustry : "Construction", seniority: "vp" },
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

  it("damps a second correlated segment instead of counting it twice", () => {
    const learning = learnFromOutcomes(history(200, "Fintech"));
    const one = predictLeadScore(learning, { attributes: { industry: "Fintech" }, ruleScore: 50 });
    const two = predictLeadScore(learning, { attributes: { industry: "Fintech", seniority: "vp" }, ruleScore: 50 });
    // "Fintech VPs" is usually one population described twice; the second match may add,
    // but never as much as the first did.
    const firstGain = one.adjustment;
    const secondGain = two.adjustment - one.adjustment;
    expect(secondGain).toBeLessThan(firstGain);
  });
});
