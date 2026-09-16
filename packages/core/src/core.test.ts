import { describe, expect, it } from "vitest";
import { parseLinkedinTitle, extractPeopleFromResults } from "./discovery/people.js";
import { applyPattern, candidatesFor, inferPattern, inferPatternFromEmails } from "./email/pattern.js";
import { verifyEmail } from "./email/verify.js";
import { scoreLeadRules } from "./icp/score.js";
import { computeLeadPriority } from "./icp/priority.js";
import { learnFromOutcomes, wilsonInterval } from "./icp/learn.js";
import { evaluateSendingHealth, rampCapFor } from "./email/sendingHealth.js";
import { pickVariantWinner, allocateVariant } from "./outreach/experiment.js";
import { renderTemplate, leadVars } from "./outreach/template.js";
import { extractDomain, isSocialOrAggregator, normalizeLinkedinUrl, rootDomain } from "./util/domain.js";
import { inferDepartment, inferSeniority, splitName } from "./util/names.js";
import { extractCompaniesFromResults } from "./discovery/companies.js";

describe("names", () => {
  it("splits names and strips honorifics", () => {
    expect(splitName("Dr. Priya Sharma, PhD")).toEqual({ firstName: "Priya", lastName: "Sharma", fullName: "Priya Sharma" });
    expect(splitName("Madonna")).toEqual({ firstName: "Madonna", fullName: "Madonna" });
  });
  it("infers seniority and department", () => {
    expect(inferSeniority("Co-Founder & CEO")).toBe("c_level");
    expect(inferSeniority("VP of Sales")).toBe("vp");
    expect(inferSeniority("Senior Software Engineer")).toBe("senior");
    expect(inferDepartment("Head of Growth Marketing")).toBe("marketing");
    expect(inferDepartment("Account Executive")).toBe("sales");
  });
});

describe("domains", () => {
  it("extracts and normalizes", () => {
    expect(extractDomain("https://www.Acme.com/about")).toBe("acme.com");
    expect(extractDomain("acme.co.uk")).toBe("acme.co.uk");
    expect(rootDomain("mail.acme.co.uk")).toBe("acme.co.uk");
    expect(rootDomain("blog.acme.com")).toBe("acme.com");
    expect(isSocialOrAggregator("in.linkedin.com")).toBe(true);
    expect(normalizeLinkedinUrl("https://in.linkedin.com/in/Jane-Doe-123/?trk=x")).toBe("https://www.linkedin.com/in/jane-doe-123");
  });
});

describe("linkedin parsing", () => {
  it("parses title formats", () => {
    const p = parseLinkedinTitle("Jane Doe - Head of Growth - Acme Corp | LinkedIn");
    expect(p).toMatchObject({ firstName: "Jane", lastName: "Doe", title: "Head of Growth", companyName: "Acme Corp" });
    const q = parseLinkedinTitle("Rahul Verma – CTO at Fintech Labs | LinkedIn");
    expect(q).toMatchObject({ firstName: "Rahul", title: "CTO", companyName: "Fintech Labs" });
    expect(parseLinkedinTitle("Top 10 Sales Tools 2025 | LinkedIn")).toBeNull();
  });
  it("extracts people from SERP", () => {
    const people = extractPeopleFromResults([
      { title: "Amit Shah - VP Sales - Zeta | LinkedIn", url: "https://in.linkedin.com/in/amitshah", snippet: "Location: Mumbai, India", provider: "t" },
      { title: "Amit Shah - VP Sales - Zeta | LinkedIn", url: "https://www.linkedin.com/in/amitshah/", snippet: "", provider: "t" },
      { title: "Zeta | LinkedIn", url: "https://www.linkedin.com/company/zeta", snippet: "", provider: "t" },
    ]);
    expect(people).toHaveLength(1);
    expect(people[0].location).toBe("Mumbai, India");
  });
  it("extracts companies from SERP", () => {
    const cs = extractCompaniesFromResults([
      { title: "Acme Corp - Fintech infrastructure", url: "https://acme.com", snippet: "Acme builds...", provider: "t" },
      { title: "Acme Corp | LinkedIn", url: "https://www.linkedin.com/company/acme-corp", snippet: "", provider: "t" },
      { title: "Acme Corp on Crunchbase", url: "https://crunchbase.com/organization/acme", snippet: "", provider: "t" },
    ]);
    expect(cs.map((c) => c.domain || c.linkedinUrl)).toEqual(["acme.com", "https://www.linkedin.com/company/acme-corp"]);
  });
});

describe("email patterns", () => {
  it("applies patterns", () => {
    expect(applyPattern("{first}.{last}", "Jane", "Doe", "acme.com")).toBe("jane.doe@acme.com");
    expect(applyPattern("{f}{last}", "Jane", "Doe", "acme.com")).toBe("jdoe@acme.com");
    expect(applyPattern("{first}.{last}", "Jane", "", "acme.com")).toBeNull();
  });
  it("infers from samples", () => {
    const r = inferPattern([
      { firstName: "Jane", lastName: "Doe", email: "jane.doe@acme.com" },
      { firstName: "Bob", lastName: "Ray", email: "bob.ray@acme.com" },
    ]);
    expect(r?.pattern).toBe("{first}.{last}");
    expect(inferPatternFromEmails(["info@acme.com", "john.smith@acme.com"])?.pattern).toBe("{first}.{last}");
  });
  it("orders candidates by preferred pattern", () => {
    expect(candidatesFor("Jane", "Doe", "acme.com", "{f}{last}")[0]).toBe("jdoe@acme.com");
  });
});

describe("verify", () => {
  it("rejects bad syntax and disposable", async () => {
    expect((await verifyEmail("not-an-email")).status).toBe("invalid");
    expect((await verifyEmail("x@mailinator.com")).status).toBe("invalid");
  });
});

describe("scoring", () => {
  it("scores by ICP rules", () => {
    const s = scoreLeadRules(
      { title: "VP of Sales", location: "Bengaluru, India", emailStatus: "valid", company: { industry: "Fintech", size: "51-200", description: "payments" } },
      { titles: ["VP Sales", "Head of Sales"], industries: ["fintech"], locations: ["Bengaluru"], seniorities: ["vp", "c_level"] },
    );
    expect(s.score).toBeGreaterThan(80);
    expect(scoreLeadRules({ title: "Intern" }, { excludeKeywords: ["intern"] }).score).toBe(0);
  });
});

describe("priority", () => {
  it("ranks a strong-fit, engaged lead with a fresh funding signal above a cold perfect-fit lead", () => {
    const hot = computeLeadPriority({ score: 80, engagementScore: 60, status: "replied" }, [{ type: "funding", occurredAt: new Date() }]);
    const cold = computeLeadPriority({ score: 95, engagementScore: 0, status: "new" }, []);
    expect(hot.score).toBeGreaterThan(cold.score);
    expect(hot.reasons.some((r) => r.includes("funding"))).toBe(true);
    expect(hot.reasons.some((r) => r.includes("replied"))).toBe(true);
  });
  it("ignores signals older than 60 days and non-buying-trigger types", () => {
    const stale = computeLeadPriority({ score: 50, engagementScore: 0 }, [{ type: "funding", occurredAt: new Date(Date.now() - 90 * 86_400_000) }]);
    const irrelevant = computeLeadPriority({ score: 50, engagementScore: 0 }, [{ type: "news", occurredAt: new Date() }]);
    expect(stale.breakdown.signals).toBe(0);
    expect(irrelevant.breakdown.signals).toBe(0);
  });
  it("stays within 0..100 and never throws on empty input", () => {
    const r = computeLeadPriority({});
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("icp learning", () => {
  // 60 contacted leads, 12 positive => 20% baseline.
  // VPs in Fintech reply 10/20 (50%); Interns in Retail reply 2/40 (5%).
  const sample = (n: number, positives: number, attrs: Record<string, string>) =>
    Array.from({ length: n }, (_, i) => ({ attributes: { ...attrs, country: "IN" }, positive: i < positives }));
  const dataset = [...sample(20, 10, { title: "VP of Sales", industry: "Fintech" }), ...sample(40, 2, { title: "Intern", industry: "Retail" })];

  it("separates real segments from the baseline and reports lift", () => {
    const r = learnFromOutcomes(dataset);
    expect(r.sufficient).toBe(true);
    expect(r.sampleSize).toBe(60);
    expect(r.positives).toBe(12);
    expect(r.baseline).toBeCloseTo(0.2, 5);
    const vp = r.insights.find((i) => i.value === "VP of Sales");
    expect(vp?.direction).toBe("outperforms");
    expect(vp?.lift).toBeCloseTo(2.5, 5);
    expect(r.insights.find((i) => i.value === "Intern")?.direction).toBe("underperforms");
    expect(r.suggestions.add.title).toContain("VP of Sales");
    expect(r.suggestions.avoid.title).toContain("Intern");
  });

  it("ignores an attribute that covers the entire dataset", () => {
    // Every lead is country=IN, so it explains no variance and must not be reported.
    expect(learnFromOutcomes(dataset).insights.some((i) => i.attribute === "country")).toBe(false);
  });

  it("refuses to promote a tiny perfect-looking segment", () => {
    // 3/3 replies is a 100% rate and completely meaningless at n=3.
    const withFluke = [...dataset, ...sample(3, 3, { title: "Unicorn", industry: "Fintech" })];
    const r = learnFromOutcomes(withFluke);
    expect(r.insights.some((i) => i.value === "Unicorn")).toBe(false);
  });

  it("declines to conclude anything when history is thin, and says what it needs", () => {
    const r = learnFromOutcomes(sample(10, 1, { title: "VP of Sales" }));
    expect(r.sufficient).toBe(false);
    expect(r.insights).toHaveLength(0);
    expect(r.summary).toMatch(/more contacted lead/);
  });

  it("computes Wilson bounds that stay in range and tighten with n", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
    const small = wilsonInterval(1, 1);
    const large = wilsonInterval(500, 1000);
    expect(small.lower).toBeLessThan(0.9); // 1/1 is not evidence of a 100% rate
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
    expect(large.lower).toBeGreaterThan(0.45);
    expect(large.upper).toBeLessThan(0.55);
  });
});

describe("sending health", () => {
  it("halts sending once bounce rate hits the hard limit", () => {
    const h = evaluateSendingHealth({ sent: 200, bounced: 12 }, { configuredDailyCap: 100 });
    expect(h.status).toBe("halt");
    expect(h.recommendedDailyCap).toBe(0);
    expect(h.reasons.join(" ")).toMatch(/Bounce rate/);
  });

  it("warns and halves volume on an elevated but not fatal bounce rate", () => {
    const h = evaluateSendingHealth({ sent: 200, bounced: 6 }, { configuredDailyCap: 100 });
    expect(h.status).toBe("warn");
    expect(h.recommendedDailyCap).toBe(50);
  });

  it("halts on spam complaints well below the bounce threshold", () => {
    // 1 complaint in 300 is only 0.33% but is already reputation-damaging.
    const h = evaluateSendingHealth({ sent: 300, bounced: 0, complained: 1 }, { configuredDailyCap: 100 });
    expect(h.status).toBe("halt");
  });

  it("does not act on rates from a volume too small to be meaningful", () => {
    // 1 bounce in 5 is 20%, but 5 sends prove nothing.
    const h = evaluateSendingHealth({ sent: 5, bounced: 1 }, { configuredDailyCap: 100 });
    expect(h.status).toBe("ok");
    expect(h.recommendedDailyCap).toBe(100);
  });

  it("holds a cold sending identity to the warm-up ladder", () => {
    const d1 = evaluateSendingHealth({ sent: 0, bounced: 0 }, { domainAgeDays: 1, configuredDailyCap: 500 });
    expect(d1.recommendedDailyCap).toBe(20);
    expect(d1.rampDay).toBe(1);
    expect(evaluateSendingHealth({ sent: 0, bounced: 0 }, { domainAgeDays: 12, configuredDailyCap: 500 }).recommendedDailyCap).toBe(200);
    // Warmed identity is governed by the user's own cap again.
    expect(evaluateSendingHealth({ sent: 0, bounced: 0 }, { domainAgeDays: 60, configuredDailyCap: 500 }).recommendedDailyCap).toBe(500);
    expect(rampCapFor(null)).toBeNull();
  });

  it("never recommends more than the user configured", () => {
    const h = evaluateSendingHealth({ sent: 500, bounced: 1 }, { domainAgeDays: 90, configuredDailyCap: 30 });
    expect(h.status).toBe("ok");
    expect(h.recommendedDailyCap).toBe(30);
  });
});

describe("ab experiments", () => {
  it("does not call a winner while either variant is underpowered", () => {
    // 3/5 looks like a 60% reply rate. It is five sends.
    const r = pickVariantWinner([{ variant: 0, sent: 5, positives: 3 }, { variant: 1, sent: 5, positives: 0 }]);
    expect(r.confident).toBe(false);
    expect(r.winner).toBeNull();
    expect(r.allocation).toEqual({ 0: 0.5, 1: 0.5 });
    expect(r.summary).toMatch(/Too early/);
  });

  it("declares a winner only once the intervals separate", () => {
    const r = pickVariantWinner([{ variant: 0, sent: 400, positives: 80 }, { variant: 1, sent: 400, positives: 16 }]);
    expect(r.confident).toBe(true);
    expect(r.winner).toBe(0);
    expect(r.allocation[0]).toBeCloseTo(0.9, 5);
    // Losers keep a slice so drift is still detectable.
    expect(r.allocation[1]).toBeCloseTo(0.1, 5);
  });

  it("keeps the split even when a lead exists but is not separable from noise", () => {
    const r = pickVariantWinner([{ variant: 0, sent: 100, positives: 12 }, { variant: 1, sent: 100, positives: 10 }]);
    expect(r.confident).toBe(false);
    expect(r.allocation).toEqual({ 0: 0.5, 1: 0.5 });
    expect(r.summary).toMatch(/within noise/);
  });

  it("handles a single variant and clamps impossible inputs", () => {
    expect(pickVariantWinner([{ variant: 0, sent: 10, positives: 2 }]).confident).toBe(false);
    // positives above sent would poison the interval maths.
    const r = pickVariantWinner([{ variant: 0, sent: 5, positives: 99 }, { variant: 1, sent: 5, positives: 0 }]);
    expect(r.ranked[0].rate).toBeLessThanOrEqual(1);
  });

  it("allocates traffic by weight and falls back when empty", () => {
    expect(allocateVariant({ 0: 0.9, 1: 0.1 }, 7, () => 0.0)).toBe(0);
    expect(allocateVariant({ 0: 0.9, 1: 0.1 }, 7, () => 0.95)).toBe(1);
    expect(allocateVariant({}, 7)).toBe(7);
  });
});

describe("templates", () => {
  it("renders with fallbacks", () => {
    const vars = leadVars({ firstName: "Jane", company: { name: "Acme" } }, { name: "Mridul" });
    expect(renderTemplate('Hi {{first_name | fallback:"there"}} from {{company}} - {{sender_name}} {{missing | fallback:"x"}}', vars)).toBe("Hi Jane from Acme - Mridul x");
  });
});

describe("v2 signals", () => {
  it("classifies headlines and extracts company + amount", async () => {
    const { classifyHeadline, parseMoney, companyFromHeadline } = await import("./signals/news.js");
    const s = classifyHeadline({ title: "Bengaluru-based fintech Jar raises $50 Mn Series C led by Tiger Global", url: "https://x.example/a" });
    expect(s?.type).toBe("funding");
    expect(s?.companyName).toBe("Jar");
    expect(s?.amountUsd).toBe(50_000_000);
    expect(s?.round?.toLowerCase()).toBe("series c");
    expect(parseMoney("raises ₹100 crore")).toBe(12_000_000);
    expect(classifyHeadline({ title: "Ford Motor names Samir Singh as Director, Talent Acquisition", url: "u" })?.type).toBe("leadership");
    expect(companyFromHeadline("Zomato to acquire Paytm entertainment business")).toBe("Zomato");
  });
  it("identifies ISPs/hosting and page intent", async () => {
    const { cleanOrgName, pageIntentWeight } = await import("./visitors/identify.js");
    expect(cleanOrgName("ACME TECHNOLOGIES PRIVATE LIMITED")).toBe("ACME TECHNOLOGIES");
    expect(pageIntentWeight("/pricing")).toBe(3);
    expect(pageIntentWeight("/blog/post")).toBe(0.5);
  });
  it("normalizes phones for WhatsApp", async () => {
    const { normalizePhone } = await import("./channels/whatsapp.js");
    expect(normalizePhone("+91 98765 43210")).toBe("919876543210");
    expect(normalizePhone("9876543210")).toBe("919876543210");
  });
});
