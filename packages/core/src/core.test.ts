import { describe, expect, it } from "vitest";
import { parseLinkedinTitle, extractPeopleFromResults } from "./discovery/people.js";
import { applyPattern, candidatesFor, inferPattern, inferPatternFromEmails } from "./email/pattern.js";
import { verifyEmail } from "./email/verify.js";
import { scoreLeadRules } from "./icp/score.js";
import { computeLeadPriority } from "./icp/priority.js";
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
