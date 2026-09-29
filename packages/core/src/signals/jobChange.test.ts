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

  it("normalises legal suffixes away but keeps the discriminating words", () => {
    // "Technologies" stays. Stripping descriptive words collapsed distinct employers.
    expect(normalizeCompany("Acme Technologies Private Limited")).toBe("acme technologies");
    expect(normalizeCompany("Acme Pvt. Ltd.")).toBe("acme");
    expect(normalizeTitle("Vice President of Sales")).toBe("vp sales");
  });

  /**
   * The false negatives a too-eager normaliser produces. Losing a real move is the
   * expensive error here - a duplicate alert is merely annoying - and a first version
   * stripped Solutions, Systems, Labs and Group, collapsing distinct employers to one
   * string and reporting the move as "no change" at 0.9 confidence.
   */
  it("does not collapse two different companies that share a word", () => {
    for (const [a, b] of [
      ["Acme Solutions", "Acme Systems"],
      ["Zoho Corporation", "Zoho Labs"],
      ["Infosys Technologies", "Infosys BPM"],
    ]) {
      const r = detectJobChange({ previous: { companyName: a, title: "VP Sales" }, current: { companyName: b, title: "VP Sales" } });
      expect({ a, b, kind: r.kind }).toEqual({ a, b, kind: "company_change" });
    }
  });

  /**
   * "Razorpay Software Pvt Ltd" and "Razorpay" may be one employer written two ways, or a
   * parent and a subsidiary. From names alone that is genuinely undecidable, and both
   * confident answers are wrong: calling it "no change" silently loses a real move, and
   * calling it a confirmed departure sends someone to write off a live deal. So it surfaces
   * as a change the user can glance at, carrying its own uncertainty.
   */
  it("surfaces an undecidable name relationship as a low-confidence change", () => {
    const r = detectJobChange({
      previous: { companyName: "Razorpay Software Pvt Ltd", title: "VP Sales" },
      current: { companyName: "Razorpay", title: "VP Sales" },
    });
    expect(r.kind).toBe("company_change");
    expect(r.confidence).toBeLessThan(0.6);
    expect(r.reason).toMatch(/may not be a move/i);
  });

  it("does not treat a name that merely starts with another as the same employer", () => {
    const r = detectJobChange({
      previous: { companyName: "Meta", title: "PM" },
      current: { companyName: "Metabase", title: "PM" },
    });
    expect(r.kind).toBe("company_change");
  });

  it("keeps an employer whose name is entirely generic comparable", () => {
    // "Systems Limited" normalised to "" under the old rules, making it permanently
    // uncomparable - so a move away from it could never be detected.
    expect(normalizeCompany("Systems Limited")).not.toBe("");
    const r = detectJobChange({
      previous: { companyName: "Systems Limited", title: "CTO" },
      current: { companyName: "Razorpay", title: "CTO" },
    });
    expect(r.kind).toBe("company_change");
  });

  /**
   * A rebrand changes the domain too, so differing domains are not proof of a departure.
   * Claiming 0.92 that a champion left would send someone to write off a live deal.
   */
  it("treats a likely rename as uncertain, even when the domain changed", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "acme.com", title: "VP Sales" },
      current: { companyName: "Acme Global", companyDomain: "acmeglobal.io", title: "VP Sales" },
    });
    expect(r.kind).toBe("company_change");
    expect(r.confidence).toBeLessThan(0.6);
    expect(r.reason).toMatch(/renamed|restructured|may not be a move/i);
  });

  it("still calls an unrelated move confirmed when the domains differ", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "acme.com", title: "VP Sales" },
      current: { companyName: "Globex", companyDomain: "globex.io", title: "VP Sales" },
    });
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  /**
   * The distinction a caller needs to decide whether it may record "checked, no change".
   */
  it("says whether the employer could actually be compared", () => {
    const bothKnown = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "acme.com", title: "VP Sales" },
      current: { companyName: "Acme", companyDomain: "acme.com", title: "VP Sales" },
    });
    expect(bothKnown.kind).toBe("none");
    expect(bothKnown.comparedCompany).toBe(true);

    const oneMissing = detectJobChange({
      previous: { title: "VP Sales" },
      current: { companyName: "Acme", title: "VP Sales" },
    });
    expect(oneMissing.kind).toBe("none");
    // Same verdict, very different basis - and the caller must not stamp this as checked.
    expect(oneMissing.comparedCompany).toBe(false);
  });

  /**
   * The false negative that matters most, because the move it hides is the valuable one.
   *
   * A shared first word is how an enormous number of unrelated companies are named, and
   * treating it as evidence of a rename reported a genuine move between two of them at
   * 0.45 confidence with the words "may not be a move at all".
   */
  /**
   * A shared first word is how an enormous number of unrelated companies are named, and how
   * an enormous number of sibling brands are named too. It is not a rename and it is not
   * nothing.
   *
   * Both previous versions picked one and were wrong about the other: calling it a rename
   * swallowed a genuine move as "may not be a move at all", and calling it unrelated
   * announced an internal transfer at 0.92 as "confirmed by company domain".
   */
  it.each([
    ["Tata Motors", "Tata Steel"],
    ["Reliance Retail", "Reliance Jio"],
    ["Acme India", "Acme Global"],
    ["American Express", "American Airlines"],
  ])("reports a change between %s and %s, without claiming the domain confirms it", (from, to) => {
    const r = detectJobChange({
      previous: { companyName: from, companyDomain: "tatamotors.com", title: "VP Sales" },
      current: { companyName: to, companyDomain: "tatasteel.com", title: "VP Sales" },
    });
    expect(r.kind).toBe("company_change");
    // Reported as a change - not swallowed as a probable rename...
    expect(r.confidence).toBe(0.7);
    expect(r.reason).not.toMatch(/may not be a move/i);
    // ...and not asserted as confirmed, because a rebrand moves the domain too.
    expect(r.reason).not.toMatch(/confirmed by company domain/i);
    expect(r.reason).toMatch(/same group|renamed/i);
  });

  it("keeps the confirmed claim for names with nothing in common", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "acme.com", title: "VP Sales" },
      current: { companyName: "Globex", companyDomain: "globex.io", title: "VP Sales" },
    });
    expect(r.confidence).toBe(0.92);
    expect(r.reason).toMatch(/confirmed by company domain/i);
  });

  /**
   * A LinkedIn company page is not an employer.
   *
   * Providers fill website fields with linkedin.com/company/<slug> constantly. Parsing the
   * URL properly - which is what the previous fix did - reduces two entirely different
   * employers to "linkedin.com" on both sides, which reads as the same company at 0.9 and
   * then suppresses the next real check for a month. Before the parse fix this was
   * accidentally safe because the raw strings differed.
   */
  it.each([
    ["linkedin.com/company/acme", "https://www.linkedin.com/company/globex"],
    ["https://sites.google.com/acme", "https://sites.google.com/globex"],
  ])("refuses to read %s and %s as the same employer", (a, b) => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: a, title: "VP Sales" },
      current: { companyName: "Globex", companyDomain: b, title: "VP Sales" },
    });
    expect(r.kind).toBe("company_change");
    expect(r.reason).not.toMatch(/confirmed by company domain/i);
  });

  it("separates a probable rename from a same-group move", () => {
    const renamed = detectJobChange({
      previous: { companyName: "Acme", title: "VP Sales" },
      current: { companyName: "Acme Global", title: "VP Sales" },
    });
    const family = detectJobChange({
      previous: { companyName: "Acme India", title: "VP Sales" },
      current: { companyName: "Acme Global", title: "VP Sales" },
    });
    // Both are changes. One name beginning with the other is likeliest a rebrand; two
    // siblings under a shared parent is likeliest a real move within the group. The two
    // used to be graded identically, in one direction and then the other.
    expect(renamed.confidence).toBe(0.45);
    expect(family.confidence).toBe(0.7);
    expect(renamed.reason).toMatch(/may not be a move/i);
    expect(family.reason).not.toMatch(/may not be a move/i);
  });

  /**
   * Providers hand us whatever they have. People Data Labs' `job_company_website` carries a
   * scheme routinely and a path sometimes, and string-comparing that against a bare host
   * invented a domain-confirmed departure for someone who had not moved.
   */
  it.each([
    ["https://acme.com", "acme.com"],
    ["https://www.acme.com/careers", "acme.com"],
    ["  HTTP://Acme.com  ", "www.acme.com"],
  ])("treats %s and %s as the same employer", (a, b) => {
    const r = detectJobChange({
      previous: { companyName: "Acme Inc", companyDomain: a, title: "VP Sales" },
      current: { companyName: "Acme", companyDomain: b, title: "VP Sales" },
    });
    expect(r.kind).toBe("none");
    expect(r.sameEmployer).toBe(true);
    expect(r.comparedCompany).toBe(true);
  });

  it("falls back to names when a domain field holds nothing parseable", () => {
    const r = detectJobChange({
      previous: { companyName: "Acme", companyDomain: "n/a", title: "VP Sales" },
      current: { companyName: "Globex", companyDomain: "globex.io", title: "VP Sales" },
    });
    // Name-only evidence: reported, but not at domain-confirmed confidence.
    expect(r.kind).toBe("company_change");
    expect(r.confidence).toBeCloseTo(0.7);
  });
});
