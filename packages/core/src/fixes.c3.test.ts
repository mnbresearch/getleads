import { describe, expect, it } from "vitest";
import { starterPack } from "./visibility/templates.js";

/** Fix round C3: starter visibility questions without a category, and for product-like ones. */
describe("starterPack without a usable category", () => {
  it("returns no questions when there is no category, instead of inventing one", () => {
    expect(starterPack({ brand: "Scout", category: "" })).toEqual([]);
    expect(starterPack({ brand: "Scout", category: "   " })).toEqual([]);
  });

  it("never asks how teams handle software 'without dedicated software'", () => {
    for (const category of ["B2B", "B2B software", "CRM", "lead generation platform", "SaaS"]) {
      for (const p of starterPack({ brand: "Scout", category })) {
        expect(p.text, category).not.toMatch(/software without dedicated software|B2B without/);
        expect(p.text, category).not.toMatch(/handle (CRM|B2B|SaaS)\b/);
      }
    }
    const crm = starterPack({ brand: "Scout", category: "CRM" }).map((p) => p.text);
    expect(crm).toContain("How do teams manage without a CRM?");
    expect(crm).toContain("When does a team need a CRM?");
  });

  it("keeps the activity wording for an activity category", () => {
    const texts = starterPack({ brand: "Scout", category: "lead generation" }).map((p) => p.text);
    expect(texts).toContain("How do teams usually handle lead generation without dedicated software?");
    expect(texts).toContain("What tools help teams with lead generation?");
  });
});
