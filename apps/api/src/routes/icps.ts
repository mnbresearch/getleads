import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, companies, consume, desc, inArray, enqueue, eq, getDb, icps, leads, organizations, sql } from "@prospex/db";
import { createAiProvider, createAiProviderForPlan, scoreLeadRules, scoreLeadWithAi, hasAi, refineIcpWithAi, type IcpCriteria, type IcpChatMessage } from "@prospex/core";
import { notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { scoreLeadsWithLearning } from "../services/insights.js";

export const icpRoutes = new Hono<Env>();
icpRoutes.use("*", requireAuth);

const criteria = z.object({
  industries: z.array(z.string()).optional(),
  titles: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  departments: z.array(z.string()).optional(),
  companySizes: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
  techStack: z.array(z.string()).optional(),
});
const icpInput = z.object({ name: z.string().min(1), description: z.string().optional(), criteria: criteria.optional(), seedDomains: z.array(z.string()).max(10).optional(), product: z.string().optional(), buildWithAi: z.boolean().default(true) });

icpRoutes.get("/", async (c) => {
  const { db } = getDb();
  const rows = await db
    .select({ icp: icps, leadCount: sql<number>`(SELECT count(*)::int FROM leads WHERE icp_id = ${icps.id})` })
    .from(icps)
    .where(eq(icps.orgId, orgId(c)))
    .orderBy(desc(icps.createdAt));
  return c.json({ icps: rows.map((r) => ({ ...r.icp, leadCount: r.leadCount })) });
});

icpRoutes.post("/", zValidator("json", icpInput), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const [row] = await db.insert(icps).values({ orgId: oid, name: b.name, description: b.description, criteria: b.criteria ?? {}, seedDomains: b.seedDomains ?? [] }).returning();
  let jobId: string | null = null;
  if (b.buildWithAi && (b.description || b.seedDomains?.length)) jobId = (await enqueue(db, "icp.build", { icpId: row.id, product: b.product }, { orgId: oid })).id;
  return c.json({ icp: row, jobId }, 201);
});

icpRoutes.get("/:id", async (c) => {
  const { db } = getDb();
  const row = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))) });
  if (!row) throw notFound("ICP");
  return c.json(row);
});

icpRoutes.patch("/:id", zValidator("json", icpInput.partial()), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  const [row] = await db
    .update(icps)
    .set({ ...(b.name ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.criteria ? { criteria: b.criteria } : {}), ...(b.seedDomains ? { seedDomains: b.seedDomains } : {}), updatedAt: new Date() })
    .where(and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))))
    .returning();
  if (!row) throw notFound("ICP");
  return c.json(row);
});

icpRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  await db.delete(icps).where(and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))));
  return c.json({ ok: true });
});

/** Re-run AI profile build. */
icpRoutes.post("/:id/build", async (c) => {
  const { db } = getDb();
  const row = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))) });
  if (!row) throw notFound("ICP");
  const job = await enqueue(db, "icp.build", { icpId: row.id }, { orgId: row.orgId });
  return c.json({ jobId: job.id }, 202);
});

/**
 * Conversational ICP assistant: chat to refine targeting criteria in plain language.
 * Persists the transcript (capped to the last 20 turns) and the updated criteria on the ICP.
 */
icpRoutes.post("/:id/chat", zValidator("json", z.object({ message: z.string().min(1).max(2000) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const icp = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, oid)) });
  if (!icp) throw notFound("ICP");
  const b = c.req.valid("json");

  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
  const ai = createAiProviderForPlan(org?.plan ?? "free");
  if (!hasAi(ai)) throw notFound("No AI provider configured");

  const history = (icp.chatHistory ?? []) as IcpChatMessage[];
  const summary = String((icp.aiProfile as { summary?: string } | null)?.summary ?? icp.description ?? "");
  const result = await refineIcpWithAi(ai, { criteria: (icp.criteria ?? {}) as IcpCriteria, summary, history, message: b.message });
  if (!result) throw notFound("AI did not return a response - try again");
  await consume(db, oid, "aiMessages", 1).catch(() => {});

  const nextHistory = [...history, { role: "user" as const, content: b.message }, { role: "assistant" as const, content: result.reply }].slice(-20);
  const [row] = await db
    .update(icps)
    .set({ chatHistory: nextHistory, criteria: result.criteria, updatedAt: new Date() })
    .where(and(eq(icps.id, icp.id), eq(icps.orgId, oid)))
    .returning();
  return c.json({ reply: result.reply, criteria: row.criteria, chatHistory: row.chatHistory });
});

/** Score all (or given) leads against this ICP. Rule-based; optional AI re-rank of top N. */
icpRoutes.post("/:id/score", zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).optional(), assign: z.boolean().default(false), aiRerankTop: z.number().int().min(0).max(50).default(0), useLearning: z.boolean().default(true) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const icp = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, oid)) });
  if (!icp) throw notFound("ICP");
  const b = c.req.valid("json");
  const rows = await db
    .select({ lead: leads, company: companies })
    .from(leads)
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(b.leadIds ? and(eq(leads.orgId, oid), inArray(leads.id, b.leadIds)) : eq(leads.orgId, oid))
    .limit(5000);
  const scored = rows.map(({ lead, company }) => ({ lead, company, ...scoreLeadRules({ title: lead.title, location: lead.location, country: lead.country, emailStatus: lead.emailStatus, company }, icp.criteria as IcpCriteria) }));
  /**
   * Apply what the send history taught us, on top of the declared rules.
   *
   * icp/learn.ts has always worked out which segments actually reply; nothing applied it,
   * so a lead from a segment with three times the baseline reply rate ranked exactly like
   * one from a segment that never replies. The adjustment is bounded and gated on the
   * learning's own sufficiency check, so a new workspace with no history sees the rule
   * score unchanged - see packages/core/src/icp/predict.ts.
   */
  const learningApplied = b.useLearning
    ? await scoreLeadsWithLearning(
        db,
        oid,
        scored.map((s) => ({
          id: s.lead.id,
          seniority: s.lead.seniority,
          department: s.lead.department,
          country: s.lead.country,
          emailStatus: s.lead.emailStatus,
          company: s.company ? { industry: s.company.industry, size: s.company.size } : null,
          ruleScore: s.score,
        })),
      )
    : null;

  const predictionById = new Map((learningApplied?.scored ?? []).map((p) => [p.id, p.prediction]));

  scored.sort((a, b2) => b2.score - a.score);
  const ai = createAiProvider();
  if (b.aiRerankTop > 0 && hasAi(ai)) {
    const summary = String((icp.aiProfile as { summary?: string } | null)?.summary ?? icp.description ?? icp.name);
    for (const s of scored.slice(0, b.aiRerankTop)) {
      const r = await scoreLeadWithAi(ai, { fullName: s.lead.fullName, title: s.lead.title, location: s.lead.location, company: s.company }, summary).catch(() => null);
      if (r) {
        s.score = Math.round(s.score * 0.5 + r.score * 0.5);
        s.reasons = [...s.reasons, ...r.reasons.map((x) => `ai: ${x}`)];
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
  }

  /**
   * The learned adjustment is applied LAST, after any AI rerank.
   *
   * Applied before it, the rerank's `0.5 * score + 0.5 * aiScore` silently halved the
   * learned signal for the top N leads and left it at full weight for everyone else - so
   * the head of the list was scored by a different formula from its tail, and the reported
   * `ruleScore + learningAdjustment` no longer equalled the score shown. Last means the
   * chain is rule -> (optional AI) -> learning, every component is reported, and they add up.
   */
  const scoreBeforeLearning = new Map(scored.map((s) => [s.lead.id, s.score]));
  for (const s of scored) {
    const p = predictionById.get(s.lead.id);
    if (!p?.applied) continue;
    s.score = Math.max(0, Math.min(100, s.score + p.adjustment));
    s.reasons = [...s.reasons, `~ ${p.reason}`];
  }
  scored.sort((a, b2) => b2.score - a.score);

  if (b.assign) {
    for (const s of scored) await db.update(leads).set({ score: s.score, scoreReasons: s.reasons, icpId: icp.id, updatedAt: new Date() }).where(eq(leads.id, s.lead.id));
  }
  return c.json({
    scored: scored.map((s) => ({
      leadId: s.lead.id,
      fullName: s.lead.fullName,
      title: s.lead.title,
      company: s.company?.name,
      score: s.score,
      reasons: s.reasons,
      // Every stage named separately, so the final number can be reconstructed:
      // ruleScore -> scoreBeforeLearning (after any AI rerank) -> + learningAdjustment.
      ruleScore: predictionById.get(s.lead.id)?.ruleScore,
      scoreBeforeLearning: scoreBeforeLearning.get(s.lead.id),
      // The adjustment AS APPLIED, after the 0..100 clamp - so the three numbers reported
      // here always reconstruct `score`. Reporting the model's raw adjustment instead made
      // them stop adding up exactly where the model was most confident: a lead at 95 with a
      // +20 adjustment was shown as 95, +20, score 100.
      learningAdjustment: predictionById.get(s.lead.id)?.applied ? s.score - (scoreBeforeLearning.get(s.lead.id) ?? s.score) : 0,
      // And what the model actually said, when the clamp ate some of it. A lead already at
      // 100 with a +20 verdict reports an applied adjustment of 0, which reads exactly like
      // a lead the model had nothing to say about - while `reasons` and the learning note
      // both insist it was adjusted. Both numbers, so neither has to stand in for the other.
      learningAdjustmentRaw: predictionById.get(s.lead.id)?.applied ? predictionById.get(s.lead.id)?.adjustment : 0,
      learningAdjustmentClamped:
        predictionById.get(s.lead.id)?.applied && s.score - (scoreBeforeLearning.get(s.lead.id) ?? s.score) !== predictionById.get(s.lead.id)?.adjustment ? true : undefined,
    })),
    // Said out loud, because "the model is not being applied yet" and "the model found
    // nothing to say about these leads" are different answers and both look like silence.
    learning: learningApplied
      ? {
          applied: learningApplied.learning.sufficient,
          sampleSize: learningApplied.learning.sampleSize,
          positives: learningApplied.learning.positives,
          note: learningApplied.learning.sufficient
            ? `Adjusted using ${learningApplied.learning.sampleSize} contacted leads from your own history.`
            : `Rule scores only: ${learningApplied.learning.sampleSize} contacted leads and ${learningApplied.learning.positives} positive replies so far, which is not enough to learn from yet.`,
        }
      : undefined,
  });
});
