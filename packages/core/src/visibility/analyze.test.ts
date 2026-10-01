import { describe, expect, it } from "vitest";
import { analyzeAnswer } from "./analyze.js";

const brand = { name: "Scout", domain: "scout.mnbresearch.com" };

/**
 * "You were named first" is the headline claim of the whole AI-visibility product, so the
 * thing it must never do is manufacture a first place. A brand the engine merely linked to
 * in a sources block used to be given firstIndex 0 - prominence 1.0, position 1 - putting a
 * footnote ahead of every vendor the answer actually recommended.
 */
describe("AI answer analysis ranks by where a brand really appears", () => {
  it("does not put a cited-only brand ahead of the brands the answer names", () => {
    const answer = [
      "For outbound prospecting, Apollo is the usual starting point, and Clay is popular",
      "for enrichment workflows.",
      "",
      "Sources: https://scout.mnbresearch.com/blog/outbound-2026",
    ].join("\n");

    const r = analyzeAnswer(answer, { brand, competitors: [{ name: "Apollo" }, { name: "Clay" }] });
    expect(r.brand).not.toBeNull();
    expect(r.brand!.cited).toBe(true);
    expect(r.brand!.named).toBe(false);
    // The old behaviour reported position 1 and prominence 1 here.
    expect(r.brand!.position).toBe(3);
    expect(r.brand!.prominence).toBeLessThan(0.4);
    expect(r.orderedBrands).toEqual(["Apollo", "Clay", "Scout"]);
  });

  it("still gives first place to a brand the answer actually names first", () => {
    const answer = "Scout is a good fit for this, though Apollo is a common alternative.";
    const r = analyzeAnswer(answer, { brand, competitors: [{ name: "Apollo" }] });
    expect(r.brand!.named).toBe(true);
    expect(r.brand!.position).toBe(1);
    expect(r.brand!.prominence).toBeGreaterThan(0.9);
  });

  it("counts a citation as presence rather than discarding it", () => {
    const answer = "There are several options. Sources: https://scout.mnbresearch.com/pricing";
    const r = analyzeAnswer(answer, { brand });
    expect(r.brand).not.toBeNull();
    expect(r.brand!.cited).toBe(true);
    expect(r.brand!.citedUrls).toContain("https://scout.mnbresearch.com/pricing");
  });

  it("returns no hit when the brand is neither named nor linked", () => {
    const r = analyzeAnswer("Apollo and Clay are the main options.", { brand, competitors: [{ name: "Apollo" }] });
    expect(r.brand).toBeNull();
    expect(r.competitors[0].position).toBe(1);
  });

  it("marks a refusal as unusable rather than as the brand being absent", () => {
    const r = analyzeAnswer("I can't help with that request.", { brand });
    expect(r.refusal).toBe(true);
    expect(r.usable).toBe(false);
  });

  it("does not call a long answer a refusal because it hedges once", () => {
    const hedge = "I can't help with that specific comparison, but here is what I can say. " + "Scout is one option. ".repeat(30);
    const r = analyzeAnswer(hedge, { brand });
    expect(r.refusal).toBe(false);
    expect(r.usable).toBe(true);
  });
});

describe("starter questions read naturally", async () => {
  const { starterPack, categoryPhrase, pluralRole } = await import("./templates.js");
  it("turns a bare qualifier into a product phrase", () => {
    expect(categoryPhrase("B2B").product).toBe("B2B software");
    expect(categoryPhrase("").product).toBe("B2B software");
    expect(categoryPhrase("CRM").product).toBe("CRM");
    expect(categoryPhrase("lead generation platform").withArticle).toBe("a lead generation platform");
    expect(categoryPhrase("B2B").withArticle).toBe("B2B software");
  });
  it("pluralises the audience role", () => {
    expect(pluralRole("Founder")).toBe("founders");
    expect(pluralRole("CEO")).toBe("CEOs");
    expect(pluralRole("Head of Sales")).toBe("heads of Sales");
  });
  it("never asks 'What is the best B2B for ...'", () => {
    const pack = starterPack({ brand: "Scout", category: "B2B", audience: "founders at software companies" });
    expect(pack[0].text).toBe("What is the best B2B software for founders at software companies?");
    for (const p of pack) expect(p.text).not.toMatch(/best B2B for|choosing a B2B software/);
  });
});
