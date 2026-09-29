import { describe, expect, it } from "vitest";
import { detectJobChange, normalizeCompany, normalizeTitle } from "./jobChange.js";

/**
 * A champion who moves is the strongest buying trigger in B2B. The value of detecting it
 * depends entirely on one distinction: a person who HAS moved must not look like a person
 * we simply failed to re-check. Enrichment returns partial records constantly, and reading
 * a missing company as "they left" would invent a resignation out of a timeout.
 */
describe("job change detection", () => {
  it("does not invent a move out of a failed lookup", () => {
    const r = detectJobChange({
      previous: { companyName: "Razorpay", companyDomain: "razorpay.com", title: "VP Sales" },
      current: {}, // enrichment returned nothing at all
    });
    expect(r.kind).toBe("unknown");
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/not checked/i);
  });

  it("does not report a move when only the company is missing on one side", () => {
    const r = detectJobChange({
      previous: { companyName: "Razorpay", title: "VP Sales" },
      current: { title: "VP Sales" },
    });
    expect(r.kind).toBe("none");
  });

  it("confirms a real move by domain, with high confidence", () => {
    const r = detectJobChange({
      previous: { companyName: "Razorpay", companyDomain: "razorpay.com", title: "VP Sales" },
      current: { companyName: "Zerodha", companyDomain: "zerodha.com", title: "VP Sales" },
    });
    expect(r.kind).toBe("company_change");
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.sameEmployer).toBe(false);
    expect(r.from?.company).toBe("Razorpay");
    expect(r.to?.company).toBe("Zerodha");
  });

  it("is less certain when only names differ, because that may be a rebrand", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme Logistics", title: "Head of Ops" },
      current: { companyName: "Blue Dart", title: "Head of Ops" },
    });
    expect(r.kind).toBe("company_change");
    expect(r.confidence).toBeLessThan(0.8);
    expect(r.reason).toMatch(/rebrand|acquisition/i);
  });

  /**
   * The failure mode that would make this feature worse than useless: firing a "they moved!"
   * alert every time a provider spells the employer differently.
   */
  it("treats legal-suffix spellings as the same employer", () => {
    for (const [a, b] of [
      ["Acme Technologies Private Limited", "Acme Technologies"],
      ["Acme Technologies Pvt. Ltd.", "Acme Technologies Private Limited"],
      ["Razorpay Software Pvt Ltd", "Razorpay"],
      ["Tata Consultancy Services Limited", "Tata Consultancy Services"],
    ]) {
      const r = detectJobChange({ previous: { companyName: a, title: "VP Sales" }, current: { companyName: b, title: "VP Sales" } });
      expect({ a, b, kind: r.kind }).toEqual({ a, b, kind: "none" });
    }
  });

  it("trusts the domain over the name when both are present", () => {
    // Same employer, two very different spellings - the domain settles it.
    const r = detectJobChange({
      previous: { companyName: "TCS", companyDomain: "tcs.com", title: "Director" },
      current: { companyName: "Tata Consultancy Services Ltd", companyDomain: "www.tcs.com", title: "Director" },
    });
    expect(r.kind).toBe("none");
    expect(r.sameEmployer).toBe(true);
  });

  it("reports a promotion as a title change at the same employer, not a move", () => {
    const r = detectJobChange({
      previous: { companyName: "Razorpay", companyDomain: "razorpay.com", title: "Director of Sales" },
      current: { companyName: "Razorpay", companyDomain: "razorpay.com", title: "VP Sales" },
    });
    expect(r.kind).toBe("title_change");
    expect(r.sameEmployer).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("does not call a reworded title a promotion", () => {
    for (const [a, b] of [
      ["Vice President of Sales", "VP Sales"],
      ["Head of Sales, EMEA", "Head of Sales"],
      ["Sr. Director, Marketing", "Senior Director"],
      ["Co-Founder & CEO", "Founder CEO"],
    ]) {
      const r = detectJobChange({
        previous: { companyName: "Acme", companyDomain: "acme.com", title: a },
        current: { companyName: "Acme", companyDomain: "acme.com", title: b },
      });
      expect({ a, b, kind: r.kind }).toEqual({ a, b, kind: "none" });
    }
  });

  it("catches a move and a promotion together", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "acme.com", title: "Director of Sales" },
      current: { companyName: "Globex", companyDomain: "globex.com", title: "VP Sales" },
    });
    expect(r.kind).toBe("both");
  });

  it("normalises the way the comparisons rely on", () => {
    expect(normalizeCompany("Acme Technologies Private Limited")).toBe("acme");
    expect(normalizeTitle("Vice President of Sales")).toBe("vp sales");
  });
});
