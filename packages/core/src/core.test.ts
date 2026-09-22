import { describe, expect, it } from "vitest";
import { parseLinkedinTitle, extractPeopleFromResults } from "./discovery/people.js";
import { applyPattern, candidatesFor, inferPattern, inferPatternFromEmails } from "./email/pattern.js";
import { verifyEmail } from "./email/verify.js";
import { scoreLeadRules } from "./icp/score.js";
import { computeLeadPriority } from "./icp/priority.js";
import { learnFromOutcomes, wilsonInterval } from "./icp/learn.js";
import { evaluateSendingHealth, rampCapFor } from "./email/sendingHealth.js";
import { pickVariantWinner, allocateVariant } from "./outreach/experiment.js";
import { analyzeAnswer } from "./visibility/analyze.js";
import { visibilityMetrics, competitorStandings, compareVisibility, visibilityGaps, metricsByEngine, engineDisagreement, type VisibilityObservation } from "./visibility/metrics.js";
import { availableAiProviders, availableAiProvidersForPlan, pickChatModel } from "./ai/provider.js";
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

describe("ai visibility: answer analysis", () => {
  const brand = { name: "Scout", aliases: ["Scout by MNB"], domain: "scout.mnbresearch.com" };
  const competitors = [{ name: "Apollo", domain: "apollo.io" }, { name: "Clay", domain: "clay.com" }];

  it("ranks brands by where they first appear, not by who was asked about", () => {
    const a = analyzeAnswer(
      "For B2B prospecting, Apollo is the most established option. Clay is strong for enrichment. Scout is a newer entrant.",
      { brand, competitors },
    );
    expect(a.brand?.position).toBe(3);
    expect(a.orderedBrands).toEqual(["Apollo", "Clay", "Scout"]);
    expect(a.competitors[0].name).toBe("Apollo");
  });

  it("does not match a brand name inside a longer word", () => {
    // "Apollo" must not match "Apollonia"; "Clay" must not match "Clayton".
    const a = analyzeAnswer("Apollonia Systems and Clayton Labs are unrelated companies.", { brand, competitors });
    expect(a.competitors).toHaveLength(0);
    expect(a.brand).toBeNull();
  });

  it("matches possessives and plurals but still respects boundaries", () => {
    const a = analyzeAnswer("Scout's pricing is simple. Compare with Apollo's tiers.", { brand, competitors });
    expect(a.brand?.mentions).toBe(1);
    expect(a.competitors.map((c) => c.name)).toContain("Apollo");
  });

  it("counts an alias as the same brand", () => {
    expect(analyzeAnswer("Scout by MNB handles outbound.", { brand, competitors }).brand?.mentions).toBe(1);
  });

  it("treats a link to your own domain as presence even when unnamed", () => {
    const a = analyzeAnswer("One option is documented at https://scout.mnbresearch.com/pricing for teams.", { brand, competitors });
    expect(a.brand).not.toBeNull();
    expect(a.brand?.cited).toBe(true);
    expect(a.brand?.citedUrls).toEqual(["https://scout.mnbresearch.com/pricing"]);
  });

  it("does not credit a citation to a lookalike domain", () => {
    const a = analyzeAnswer("See https://notscout.mnbresearch.com.evil.com/x", { brand, competitors });
    expect(a.brand?.cited ?? false).toBe(false);
  });

  it("ranks untracked brands too, because an unknown rival above you still wins", () => {
    const a = analyzeAnswer("Instantly leads the category. Scout is an alternative.", { brand, competitors, others: ["Instantly"] });
    expect(a.orderedBrands[0]).toBe("Instantly");
    expect(a.brand?.position).toBe(2);
  });

  it("treats a refusal as unusable, not as absence", () => {
    // Counting a refusal as "not mentioned" would invent a visibility drop.
    expect(analyzeAnswer("", { brand }).usable).toBe(false);
    const refused = analyzeAnswer("I cannot help with that request.", { brand });
    expect(refused.refusal).toBe(true);
    expect(refused.usable).toBe(false);
    // A real answer that merely omits us is usable, and genuinely counts as absence.
    const real = analyzeAnswer("The leading options here are Apollo and Clay, both well established in the category.", { brand, competitors });
    expect(real.usable).toBe(true);
    expect(real.brand).toBeNull();
  });
});

describe("ai visibility: metrics", () => {
  const obs = (n: number, mentioned: number, opts: Partial<VisibilityObservation> = {}): VisibilityObservation[] =>
    Array.from({ length: n }, (_, i) => ({
      engine: "chatgpt", promptId: "p1", mentioned: i < mentioned, cited: false,
      position: i < mentioned ? 2 : null, brands: i < mentioned ? ["Apollo", "Scout"] : ["Apollo"],
      at: new Date(), ...opts,
    }));

  it("refuses to report a rate from a handful of runs", () => {
    const m = visibilityMetrics(obs(3, 3), { brandName: "Scout" });
    expect(m.sufficient).toBe(false);
    expect(m.summary).toMatch(/a sample, not a measurement/);
  });

  it("reports a rate with an interval once there is enough history", () => {
    const m = visibilityMetrics(obs(40, 20), { brandName: "Scout" });
    expect(m.sufficient).toBe(true);
    expect(m.mentionRate.value).toBeCloseTo(0.5, 5);
    expect(m.mentionRate.ci.lower).toBeLessThan(0.5);
    expect(m.mentionRate.ci.upper).toBeGreaterThan(0.5);
    expect(m.summary).toMatch(/95% CI/);
  });

  it("computes share of voice over mention slots, not over answers", () => {
    // 20 answers, each naming Apollo; we appear in 10. 10 of 30 total slots.
    const m = visibilityMetrics(obs(20, 10), { brandName: "Scout" });
    expect(m.shareOfVoice.value).toBeCloseTo(10 / 30, 3);
  });

  it("distinguishes absence from a bad ranking", () => {
    const m = visibilityMetrics(obs(30, 0), { brandName: "Scout" });
    expect(m.avgPosition).toBeNull();
    expect(m.summary).toMatch(/an absence, not a ranking problem/);
  });

  it("surfaces rivals and counts answers they win while you are absent", () => {
    const s = competitorStandings(obs(20, 5), "Scout");
    expect(s[0].name).toBe("Apollo");
    expect(s[0].appearances).toBe(20);
    expect(s[0].beatsYou).toBe(15);
  });

  it("calls a week-on-week wobble flat rather than a trend", () => {
    // 50% to 40% on 20 runs each: the intervals overlap heavily.
    const c = compareVisibility(obs(20, 10), obs(20, 8));
    expect(c.significant).toBe(false);
    expect(c.direction).toBe("flat");
    expect(c.summary).toMatch(/No detectable change/);
  });

  it("calls a genuine collapse real once the intervals separate", () => {
    const c = compareVisibility(obs(200, 160), obs(200, 40));
    expect(c.significant).toBe(true);
    expect(c.direction).toBe("down");
  });

  it("prioritises prompts a rival owns over prompts nobody wins", () => {
    const winnable = obs(10, 0, { promptId: "winnable" }); // Apollo in every answer, we are absent
    const nobody = Array.from({ length: 10 }, () => ({
      engine: "chatgpt", promptId: "barren", mentioned: false, cited: false, position: null, brands: [] as string[], at: new Date(),
    }));
    const gaps = visibilityGaps([...winnable, ...nobody], "Scout");
    expect(gaps[0].promptId).toBe("winnable");
    expect(gaps[0].topRival).toBe("Apollo");
  });
});

describe("ai visibility: multi-engine", () => {
  const mk = (engine: string, n: number, mentioned: number): VisibilityObservation[] =>
    Array.from({ length: n }, (_, i) => ({
      engine, promptId: "p1", mentioned: i < mentioned, cited: false,
      position: i < mentioned ? 1 : null, brands: i < mentioned ? ["Scout"] : ["Apollo"], at: new Date(),
    }));

  it("splits metrics per engine instead of blending them into a number no engine has", () => {
    const rows = metricsByEngine([...mk("gemini", 40, 36), ...mk("groq", 40, 4)], "Scout");
    expect(rows.map((r) => r.engine).sort()).toEqual(["gemini", "groq"]);
    expect(rows.find((r) => r.engine === "gemini")!.metrics.mentionRate.value).toBeCloseTo(0.9, 5);
    expect(rows.find((r) => r.engine === "groq")!.metrics.mentionRate.value).toBeCloseTo(0.1, 5);
  });

  it("calls out a real engine-specific gap", () => {
    const d = engineDisagreement([...mk("gemini", 40, 36), ...mk("groq", 40, 4)], "Scout");
    expect(d?.disagree).toBe(true);
    expect(d?.best.engine).toBe("gemini");
    expect(d?.worst.engine).toBe("groq");
    expect(d?.summary).toMatch(/engine-specific gap/);
  });

  it("does not claim engines disagree when they are within noise", () => {
    const d = engineDisagreement([...mk("gemini", 40, 20), ...mk("groq", 40, 18)], "Scout");
    expect(d?.disagree).toBe(false);
    expect(d?.summary).toMatch(/within sampling noise/);
  });

  it("returns null unless at least two engines have enough data to compare", () => {
    // A single engine cannot disagree with anything.
    expect(engineDisagreement(mk("gemini", 40, 20), "Scout")).toBeNull();
    // Nor can one with a thin sample: 3 runs is not evidence, so it is excluded and the
    // comparison falls back to a single qualifying engine.
    expect(engineDisagreement([...mk("gemini", 40, 20), ...mk("groq", 3, 1)], "Scout")).toBeNull();
    // Two adequately sampled engines do compare.
    expect(engineDisagreement([...mk("gemini", 40, 20), ...mk("groq", 40, 10)], "Scout")).not.toBeNull();
  });

  it("enumerates every configured provider, not just the priority winner", () => {
    const cfg = { groqApiKey: "g", geminiApiKey: "x", anthropicApiKey: "a" };
    expect(availableAiProviders(cfg).map((p) => p.name).sort()).toEqual(["anthropic", "gemini", "groq"]);
    expect(availableAiProviders({ geminiApiKey: "x" }).map((p) => p.name)).toEqual(["gemini"]);
    expect(availableAiProviders({})).toHaveLength(0);
  });

  it("picks a chat model and skips the non-chat entries a /models list mixes in", () => {
    // Groq's real listing interleaves speech and guard models with chat models. Picking
    // one of those fails at runtime in a confusing way rather than an obvious one.
    const groqish = ["whisper-large-v3", "whisper-large-v3-turbo", "meta-llama/llama-guard-4-12b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"];
    const picked = pickChatModel(groqish)!;
    expect(picked).not.toMatch(/whisper|guard/);
    expect(["llama-3.1-8b-instant", "openai/gpt-oss-20b"]).toContain(picked);
  });

  it("returns null rather than a nonsense model when nothing usable is listed", () => {
    expect(pickChatModel(["whisper-large-v3", "text-embedding-3-small"])).toBeNull();
    expect(pickChatModel([])).toBeNull();
  });

  it("prefers a small fast model over a large one for high-volume sampling", () => {
    expect(pickChatModel(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"])).toBe("llama-3.1-8b-instant");
  });

  it("keeps paid engines off free-tier plans, same rule as single-provider selection", () => {
    const cfg = { groqApiKey: "g", geminiApiKey: "x", anthropicApiKey: "a" };
    expect(availableAiProvidersForPlan("free", cfg).map((p) => p.name)).not.toContain("anthropic");
    expect(availableAiProvidersForPlan("starter", cfg).map((p) => p.name)).not.toContain("anthropic");
    expect(availableAiProvidersForPlan("growth", cfg).map((p) => p.name)).toContain("anthropic");
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

describe("visibility prompt templates", () => {
  const ctx = { brand: "Scout", category: "B2B lead generation", competitors: ["Apollo", "Clay"], audience: "VP Sales", problem: "stale lead lists" };

  it("starter pack never names the brand being tracked", async () => {
    const { starterPack } = await import("./visibility/templates.js");
    // The whole measurement is invalid if the question names you: the engine will mention
    // you because you asked about you, not because a buyer would have found you.
    for (const p of starterPack(ctx)) expect(p.text.toLowerCase()).not.toContain("scout");
  });

  it("starter pack covers every intent, not just the flattering ones", async () => {
    const { starterPack, intentCoverage } = await import("./visibility/templates.js");
    for (const row of intentCoverage(starterPack(ctx))) expect(row.count).toBeGreaterThan(0);
  });

  it("starter pack degrades to category questions when no competitors are configured", async () => {
    const { starterPack } = await import("./visibility/templates.js");
    const p = starterPack({ brand: "Scout", category: "CRM" });
    expect(p.length).toBeGreaterThanOrEqual(4);
    expect(p.every((x) => x.text.trim().length > 0)).toBe(true);
  });

  it("rejects a generated question that names the brand", async () => {
    const { validatePrompts } = await import("./visibility/templates.js");
    const r = validatePrompts(
      [
        { text: "Is Scout better than Apollo for outbound?", topic: "x", intent: "comparison", rationale: "" },
        { text: "What is the best B2B prospecting tool?", topic: "x", intent: "category", rationale: "" },
      ],
      { brand: "Scout" },
    );
    expect(r.kept).toHaveLength(1);
    expect(r.rejected[0].reason).toContain("names Scout");
  });

  it("does not reject a question that merely contains the brand as a substring", async () => {
    const { validatePrompts } = await import("./visibility/templates.js");
    // "Scouting" is not "Scout"; a naive includes() check would drop a valid question.
    const r = validatePrompts([{ text: "What are the best talent scouting platforms?", topic: "x", intent: "category", rationale: "" }], { brand: "Scout" });
    expect(r.kept).toHaveLength(1);
  });

  it("collapses reworded duplicates and questions already tracked", async () => {
    const { validatePrompts } = await import("./visibility/templates.js");
    const r = validatePrompts(
      [
        { text: "What is the best B2B lead generation tool?", topic: "x", intent: "category", rationale: "" },
        { text: "The best B2B lead generation tool?", topic: "x", intent: "category", rationale: "" },
        { text: "Which CRM integrates with Slack?", topic: "x", intent: "category", rationale: "" },
      ],
      { brand: "Scout" },
      ["which crm integrates with slack?"],
    );
    expect(r.kept).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate of a question already tracked", "duplicate of a question already tracked"]);
  });

  it("parses model output wrapped in a code fence with a preamble", async () => {
    const { parseGeneratedPrompts } = await import("./visibility/templates.js");
    const raw = 'Here you go:\n```json\n[{"text":"What is the best CRM for startups?","topic":"category","intent":"category","rationale":"why"}]\n```';
    const p = parseGeneratedPrompts(raw);
    expect(p).toHaveLength(1);
    expect(p[0].intent).toBe("category");
  });

  it("returns nothing rather than guessing when output is not parseable", async () => {
    const { parseGeneratedPrompts } = await import("./visibility/templates.js");
    expect(parseGeneratedPrompts("I cannot help with that.")).toEqual([]);
    expect(parseGeneratedPrompts("[{broken json")).toEqual([]);
  });

  it("coerces a bogus intent instead of trusting the model's value", async () => {
    const { parseGeneratedPrompts } = await import("./visibility/templates.js");
    const p = parseGeneratedPrompts('[{"text":"What is the best CRM?","intent":"totally-made-up"}]');
    expect(p[0].intent).toBe("category");
    expect(p[0].topic).toBe("category");
  });
});

describe("provider health classification", () => {
  it("keeps a rejected key and a plan limit apart", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    // The distinction that matters: 401 means replace the key, 403 usually means the key is
    // fine and the plan excludes the endpoint. Collapsing them sends people to rotate a
    // working credential.
    expect(classifyHttp(401).outcome).toBe("auth");
    expect(classifyHttp(403).outcome).toBe("forbidden");
    expect(classifyHttp(401).outcome).not.toBe(classifyHttp(403).outcome);
  });

  it("maps the rest of the status space to distinct outcomes", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    expect(classifyHttp(200).outcome).toBe("ok");
    expect(classifyHttp(204).outcome).toBe("ok");
    expect(classifyHttp(429).outcome).toBe("rate_limit");
    expect(classifyHttp(404).outcome).toBe("not_found");
    expect(classifyHttp(500).outcome).toBe("server");
    expect(classifyHttp(503).outcome).toBe("server");
    expect(classifyHttp(418).outcome).toBe("bad_response");
  });

  it("pulls the provider's own message out of a JSON error body", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    expect(classifyHttp(403, '{"error":"This endpoint is not available on your plan"}').detail).toBe(
      "This endpoint is not available on your plan",
    );
    expect(classifyHttp(401, '{"message":"invalid api key"}').detail).toBe("invalid api key");
    expect(classifyHttp(422, '{"errors":["missing domain"]}').detail).toBe("missing domain");
  });

  it("falls back to the raw body when it is not JSON, and to a default when empty", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    expect(classifyHttp(500, "<html>  Gateway   Error </html>").detail).toBe("<html> Gateway Error </html>");
    expect(classifyHttp(401, "").detail).toContain("401");
  });

  it("reads a 403 that names a credential problem as a rejected key, not a plan limit", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    // Serper answers a bad key with 403 "Unauthorized." Reporting that as "your key is fine,
    // upgrade your plan" points the operator at a bill instead of at a one-line fix, which is
    // the same class of lie this module exists to prevent - just pointed the other way.
    expect(classifyHttp(403, "Unauthorized.").outcome).toBe("auth");
    expect(classifyHttp(403, '{"message":"Invalid API key"}').outcome).toBe("auth");
  });

  it("still reads a plain plan limit as forbidden, so nobody rotates a working key", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    // Apollo and Google both 403 with prose that mentions "API" without meaning the credential.
    expect(
      classifyHttp(403, '{"error":"The api/v1/people/match API is not included in your Free plan. All paid plans include full API access."}').outcome,
    ).toBe("forbidden");
    expect(classifyHttp(403, '{"error":{"message":"This project does not have the access to Custom Search JSON API."}}').outcome).toBe("forbidden");
    expect(classifyHttp(403).outcome).toBe("forbidden");
  });

  it("truncates a huge error body rather than storing it whole", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    expect(classifyHttp(500, "x".repeat(5000)).detail.length).toBeLessThanOrEqual(200);
  });

  it("treats a thrown fetch error as network, not as an auth problem", async () => {
    const { classifyThrown } = await import("./providers/health.js");
    // A timeout must never be reported as a bad key; that sends someone to rotate a
    // credential that was fine.
    expect(classifyThrown(new Error("The operation was aborted")).outcome).toBe("network");
  });

  it("marks only the outcomes an operator can act on", async () => {
    const { isActionable } = await import("./providers/health.js");
    expect(isActionable("auth")).toBe(true);
    expect(isActionable("forbidden")).toBe(true);
    expect(isActionable("rate_limit")).toBe(true);
    // Transient: alerting on these trains people to ignore alerts.
    expect(isActionable("server")).toBe(false);
    expect(isActionable("network")).toBe(false);
    expect(isActionable("ok")).toBe(false);
  });

  it("reports through the hook without letting a throwing hook break the caller", async () => {
    const { setProviderHealthHook, reportProviderCall } = await import("./providers/health.js");
    const seen: string[] = [];
    setProviderHealthHook((c) => seen.push(`${c.provider}:${c.outcome}`));
    reportProviderCall({ provider: "apollo", outcome: "auth" });
    expect(seen).toEqual(["apollo:auth"]);

    setProviderHealthHook(() => {
      throw new Error("reporting backend is down");
    });
    expect(() => reportProviderCall({ provider: "apollo", outcome: "ok" })).not.toThrow();
    setProviderHealthHook(() => {});
  });
});

describe("key status derivation", () => {
  it("does not round an unused key up to healthy", async () => {
    const { keyStatusFrom } = await import("@prospex/db");
    // The exact case this work exists for: a key nobody has called yet is unknown, not fine.
    expect(keyStatusFrom(true, null)).toBe("unverified");
    expect(keyStatusFrom(false, null)).toBe("not_configured");
  });

  it("maps outcomes to what the operator should do", async () => {
    const { keyStatusFrom } = await import("@prospex/db");
    expect(keyStatusFrom(true, "ok")).toBe("working");
    expect(keyStatusFrom(true, "auth")).toBe("rejected");
    expect(keyStatusFrom(true, "forbidden")).toBe("gated");
    expect(keyStatusFrom(true, "rate_limit")).toBe("rate_limited");
    expect(keyStatusFrom(true, "server")).toBe("erroring");
    // A probe that matched nobody proves the endpoint answered.
    expect(keyStatusFrom(true, "not_found")).toBe("working");
  });

  it("reports no key even when a stale outcome is still on the row", async () => {
    const { keyStatusFrom } = await import("@prospex/db");
    // Someone removing a key must not keep showing green from last week's successful call.
    expect(keyStatusFrom(false, "ok")).toBe("not_configured");
  });
});

describe("provider health: 400 that is really a bad key", () => {
  it("classifies Google's 400 'API key not valid' as a rejected key", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    // Verified against the live endpoint: Google Programmable Search answers an invalid key
    // with 400, not 401. Reporting that as "unexpected response" hid the most common
    // misconfiguration for that provider.
    const body = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}';
    const r = classifyHttp(400, body);
    expect(r.outcome).toBe("auth");
    expect(r.detail).toBe("API key not valid. Please pass a valid API key.");
  });

  it("leaves an ordinary 400 alone", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    // A malformed request must not be reported as a credential problem; that sends someone
    // to rotate a key that was working.
    expect(classifyHttp(400, '{"error":"missing required parameter: domain"}').outcome).toBe("bad_response");
    expect(classifyHttp(400, "").outcome).toBe("bad_response");
  });

  it("unwraps a nested error message from Hunter and Google shapes", async () => {
    const { classifyHttp } = await import("./providers/health.js");
    expect(classifyHttp(401, '{"errors":[{"id":"authentication_failed","code":401,"details":"No user found for this API key."}]}').detail).toBe(
      "No user found for this API key.",
    );
    expect(classifyHttp(500, '{"error":{"code":500,"message":"Backend error"}}').detail).toBe("Backend error");
  });
});

describe("provider checks: scoped credentials are not broken ones", () => {
  it("treats a Resend send-only key as working rather than rejected", async () => {
    const { checkResend } = await import("./providers/check.js");
    // Resend answers 401 on GET /domains for a send-only key, which is the recommended
    // production scope. Reporting that as "key rejected" sent an operator to replace a
    // correctly configured credential - a check that cries wolf is worse than no check.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "This API key is restricted to only send emails" }), { status: 401 })) as typeof fetch;
    try {
      const r = await checkResend("re_probe");
      expect(r.ok).toBe(true);
      expect(r.outcome).toBe("ok");
      expect(r.summary).toContain("send-only");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("still reports a genuinely invalid Resend key as rejected", async () => {
    const { checkResend } = await import("./providers/check.js");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "API key is invalid" }), { status: 401 })) as typeof fetch;
    try {
      const r = await checkResend("re_bad");
      expect(r.ok).toBe(false);
      expect(r.outcome).toBe("auth");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("scraped search: reject decoy result sets", () => {
  const R = (title: string, url = "https://example.com", snippet = "") => ({ title, url, snippet, provider: "bing_html" });

  it("rejects the exact decoy Bing served for a real query", async () => {
    const { resultsAnswerQuery } = await import("./search/providers.js");
    // Verified live 22 Sep 2026: Bing echoed the full query but returned results for "best".
    expect(
      resultsAnswerQuery("best CRM for small business", [
        R("Best Buy | Official Online Store"),
        R("BEST Definition & Meaning - Merriam-Webster"),
        R("Best - definition of best by The Free Dictionary"),
      ]),
    ).toBe(false);

    // Same shape, second case: everything about Razorpay, nothing about fintech or Bengaluru.
    expect(
      resultsAnswerQuery("Razorpay fintech Bengaluru", [
        R("Razorpay - Best Payment Solution for Online Payments"),
        R("Razorpay Sign Up & Login - Access Your Dashboard"),
      ]),
    ).toBe(false);
  });

  it("keeps a genuine result set", async () => {
    const { resultsAnswerQuery } = await import("./search/providers.js");
    expect(
      resultsAnswerQuery("best CRM for small business", [
        R("10 Best CRM Software of 2026"),
        R("Best Buy | Official Online Store"),
      ]),
    ).toBe(true);
    // One good result among noise is enough; the bar is deliberately low so real sets pass.
    expect(resultsAnswerQuery("Razorpay fintech Bengaluru", [R("Razorpay raises round"), R("Bengaluru startup news")])).toBe(true);
  });

  it("matches on snippet and url, not only title", async () => {
    const { resultsAnswerQuery } = await import("./search/providers.js");
    expect(resultsAnswerQuery("MNB Research automation", [R("Home", "https://x.com", "AI automation for SMEs")])).toBe(true);
    expect(resultsAnswerQuery("MNB Research automation", [R("Home", "https://automation.example.com", "")])).toBe(true);
  });

  it("never rejects when there is nothing to check", async () => {
    const { resultsAnswerQuery, distinctiveTerms } = await import("./search/providers.js");
    // A single-token query has no distinctive terms beyond the first, so it cannot be judged
    // this way; rejecting it would throw away good results.
    expect(distinctiveTerms("CRM")).toEqual([]);
    expect(resultsAnswerQuery("CRM", [R("Best Buy")])).toBe(true);
    expect(resultsAnswerQuery("best CRM for small business", [])).toBe(true);
  });

  it("ignores the site: operator and stopwords when picking terms", async () => {
    const { distinctiveTerms } = await import("./search/providers.js");
    expect(distinctiveTerms('site:linkedin.com/in "MNB Research" founder')).toEqual(["research", "founder"]);
    expect(distinctiveTerms("best CRM for small business")).toEqual(["crm", "small", "business"]);
  });
});

describe("search provider chain after Google closed Custom Search", () => {
  it("puts the cheapest provider first, because that ordering is what a search costs", async () => {
    const { defaultProviders } = await import("./search/providers.js");
    const order = defaultProviders().map((p) => p.name);
    // webSearch stops at the first provider returning enough results, so this order decides
    // the bill. Serper is ~30x cheaper per query than SerpAPI and must precede it.
    expect(order.indexOf("serper")).toBeLessThan(order.indexOf("serpapi"));
    expect(order.indexOf("serpapi")).toBeLessThan(order.indexOf("brave"));
    // The keyless scrapes are last resorts, never ahead of a provider that returns real data.
    expect(order.indexOf("brave")).toBeLessThan(order.indexOf("duckduckgo"));
  });

  it("only offers serper once a key exists", async () => {
    const { serperProvider } = await import("./search/providers.js");
    expect(serperProvider(undefined).available()).toBe(false);
    expect(serperProvider("k").available()).toBe(true);
  });

  it("stops calling a provider that just rejected the credential", async () => {
    const { reportProviderCall, providerRecentlyRejected, resetProviderSkips } = await import("./providers/health.js");
    resetProviderSkips();
    expect(providerRecentlyRejected("google_cse")).toBe(false);

    // Google's Custom Search closure is a permanent 403. Without this, every search pays a
    // round trip to a door that will never open again.
    reportProviderCall({ provider: "google_cse", outcome: "forbidden", status: 403 });
    expect(providerRecentlyRejected("google_cse")).toBe(true);

    reportProviderCall({ provider: "serper", outcome: "auth", status: 401 });
    expect(providerRecentlyRejected("serper")).toBe(true);
    resetProviderSkips();
  });

  it("does not cool off on a timeout, which deserves an immediate retry", async () => {
    const { reportProviderCall, providerRecentlyRejected, resetProviderSkips } = await import("./providers/health.js");
    resetProviderSkips();
    reportProviderCall({ provider: "serper", outcome: "network", detail: "aborted" });
    expect(providerRecentlyRejected("serper")).toBe(false);
    reportProviderCall({ provider: "serper", outcome: "server", status: 503 });
    expect(providerRecentlyRejected("serper")).toBe(false);
  });

  it("lets a provider back in once it succeeds, and once the window expires", async () => {
    const { reportProviderCall, providerRecentlyRejected, resetProviderSkips } = await import("./providers/health.js");
    resetProviderSkips();
    reportProviderCall({ provider: "serper", outcome: "forbidden", status: 403 });
    expect(providerRecentlyRejected("serper")).toBe(true);

    // A plan upgrade or a replaced key must not be hidden by a process that refuses to retry.
    reportProviderCall({ provider: "serper", outcome: "ok", status: 200 });
    expect(providerRecentlyRejected("serper")).toBe(false);

    reportProviderCall({ provider: "serper", outcome: "forbidden", status: 403 });
    expect(providerRecentlyRejected("serper", Date.now() + 31 * 60 * 1000)).toBe(false);
    resetProviderSkips();
  });

  it("skips a cooling-off provider when choosing who to search with", async () => {
    const { webSearch } = await import("./search/index.js");
    const { reportProviderCall, resetProviderSkips } = await import("./providers/health.js");
    resetProviderSkips();
    const called: string[] = [];
    const fake = (name: string, results: number) => ({
      name,
      available: () => true,
      search: async () => {
        called.push(name);
        return Array.from({ length: results }, (_, i) => ({ title: `${name} ${i}`, url: `https://${name}.example/${i}`, snippet: "", provider: name }));
      },
    });

    reportProviderCall({ provider: "dead", outcome: "forbidden", status: 403 });
    const out = await webSearch(`unique-${Math.random()}`, { providers: [fake("dead", 5), fake("live", 5)] });
    expect(called).toEqual(["live"]);
    expect(out.length).toBe(5);
    resetProviderSkips();
  });
});

describe("retired providers", () => {
  it("reports retirement rather than a fixable key problem", async () => {
    const { keyStatusFrom } = await import("@prospex/db");
    // Google closed Custom Search to new customers. The key still authenticates in the sense
    // that Google recognises it; there is simply no access. Calling that "gated" would tell
    // an operator to upgrade a plan that does not exist.
    expect(keyStatusFrom(true, "forbidden", true)).toBe("retired");
    expect(keyStatusFrom(true, "ok", true)).toBe("retired");
    expect(keyStatusFrom(false, null, true)).toBe("retired");
  });

  it("leaves every other provider's status untouched", async () => {
    const { keyStatusFrom } = await import("@prospex/db");
    expect(keyStatusFrom(true, "forbidden", false)).toBe("gated");
    expect(keyStatusFrom(true, "auth", false)).toBe("rejected");
    expect(keyStatusFrom(true, null)).toBe("unverified");
  });
});

describe("google sign-in: redirect safety", () => {
  it("refuses any redirect target that is not a path on our own app", async () => {
    const { safeNext } = await import("../../../apps/api/src/lib/googleAuth.js");
    // An open redirect on a sign-in flow is how phishing borrows your domain's credibility.
    expect(safeNext("https://evil.example/steal")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("keeps a genuine in-app path", async () => {
    const { safeNext } = await import("../../../apps/api/src/lib/googleAuth.js");
    expect(safeNext("/leads?sort=score")).toBe("/leads?sort=score");
    expect(safeNext("/visibility")).toBe("/visibility");
  });

  it("truncates rather than trusting an unbounded path", async () => {
    const { safeNext } = await import("../../../apps/api/src/lib/googleAuth.js");
    expect(safeNext("/" + "a".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
