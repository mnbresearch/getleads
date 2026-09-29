import { describe, expect, it } from "vitest";
import { scoreLeadRules, type IcpCriteria } from "./score.js";

const icp: IcpCriteria = {
  titles: ["VP Sales", "Head of Sales"],
  industries: ["fintech"],
  locations: ["Bengaluru"],
  companySizes: ["51-200"],
};

/**
 * The fit score decides what sits at the top of every lead list, so what it rewards is what
 * the user works on first. It used to reward not knowing: a criterion the ICP asked about
 * was dropped from the denominator whenever the LEAD had no data for it, so an unchecked
 * lead scored 100 while an identical lead with one known mismatch scored 60.
 */
describe("ICP scoring does not reward missing data", () => {
  it("ranks a fully-matching lead above one we know nothing else about", () => {
    const complete = scoreLeadRules(
      { title: "VP of Sales", location: "Bengaluru, India", emailStatus: "valid", company: { industry: "Fintech", size: "51-200" } },
      icp,
    );
    const thin = scoreLeadRules({ title: "VP of Sales" }, icp);

    expect(complete.score).toBeGreaterThan(thin.score);
    expect(complete.coverage).toBe(1);
    expect(thin.coverage).toBeLessThan(0.6);
    expect(thin.unknownCriteria).toContain("industry match");
  });

  it("does not let an unknown field beat a known mismatch by default", () => {
    const unknownIndustry = scoreLeadRules({ title: "VP of Sales", company: {} }, icp);
    const wrongIndustry = scoreLeadRules({ title: "VP of Sales", company: { industry: "Construction" } }, icp);

    // The unknown may still edge ahead - absence is not evidence of a bad fit - but the gap
    // must be a fraction of a criterion, not the 40 points it used to be.
    expect(unknownIndustry.score - wrongIndustry.score).toBeLessThan(15);
    // And it must not reach the top of the list on an empty record.
    expect(unknownIndustry.score).toBeLessThan(80);
  });

  it("keeps a perfect, fully-evidenced lead scoring high", () => {
    const s = scoreLeadRules(
      { title: "VP of Sales", location: "Bengaluru, India", emailStatus: "valid", company: { industry: "Fintech", size: "51-200", description: "payments" } },
      { ...icp, seniorities: ["vp", "c_level"] },
    );
    expect(s.score).toBeGreaterThan(90);
    expect(s.unknownCriteria).toEqual([]);
  });

  it("ignores criteria the ICP does not ask about", () => {
    // No techStack in the ICP, so a lead with no techStack is not penalised or flagged.
    const s = scoreLeadRules({ title: "VP of Sales", emailStatus: "valid", company: { industry: "Fintech", size: "51-200", location: "Bengaluru" } }, icp);
    expect(s.unknownCriteria).not.toContain("tech stack");
    expect(s.reasons.join(" ")).not.toMatch(/tech stack/);
  });

  it("still zeroes an excluded lead outright", () => {
    const s = scoreLeadRules({ title: "Sales Intern" }, { excludeKeywords: ["intern"] });
    expect(s.score).toBe(0);
    expect(s.reasons).toContain("- excluded keyword");
  });

  it("does not exclude a lead on text it does not have", () => {
    const s = scoreLeadRules({ company: { industry: "Fintech" } }, { industries: ["fintech"], excludeKeywords: ["intern"] });
    expect(s.score).toBeGreaterThan(0);
  });

  it("marks an unverified email as unknown rather than as a bad address", () => {
    const unverified = scoreLeadRules({ title: "VP of Sales" }, { titles: ["VP Sales"] });
    const bad = scoreLeadRules({ title: "VP of Sales", emailStatus: "invalid" }, { titles: ["VP Sales"] });
    expect(unverified.score).toBeGreaterThan(bad.score);
    expect(unverified.unknownCriteria).toContain("email status");
  });
});

describe("known mismatches are reported separately from unknowns", () => {
  const icp: IcpCriteria = { industries: ["fintech"], titles: ["vp growth"] };

  it("lists a criterion the data contradicts, even when the score clears a threshold", () => {
    const r = scoreLeadRules({ title: "VP Growth", emailStatus: "valid", company: { industry: "Retail" } }, icp);
    // Title outweighs industry, so a wrong-industry lead can still score well...
    expect(r.score).toBeGreaterThanOrEqual(60);
    // ...which is exactly why the contradiction has to be visible on its own.
    expect(r.mismatches).toEqual(["industry match"]);
  });

  it("does not call missing data a mismatch", () => {
    const r = scoreLeadRules({ title: "VP Growth" }, icp);
    expect(r.mismatches).toEqual([]);
    expect(r.unknownCriteria).toContain("industry match");
  });

  it("does not count email status as a fit mismatch", () => {
    const r = scoreLeadRules({ title: "VP Growth", emailStatus: "invalid", company: { industry: "Fintech" } }, icp);
    expect(r.mismatches).toEqual([]);
  });
});
