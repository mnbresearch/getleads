import { Hono } from "hono";
import { AI_NOT_SWITCHED_ON } from "../services/visibility.js";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, clients, companies, consume, desc, inArray, enqueue, eq, getDb, icps, isNull, leads, or, sql } from "@prospex/db";
import { assertOwned } from "../lib/ownership.js";
import { scoreLeadRules, scoreLeadWithAi, hasAi, refineIcpWithAi, type IcpCriteria, type IcpChatMessage } from "@prospex/core";
import { ApiError, notFound, requireSomeFields } from "../lib/errors.js";
import { AI_OFF_UNAVAILABLE, aiDisabled, aiFor } from "../lib/ai.js";
import { assertQuotaAvailable, tryConsume } from "../lib/quota.js";
import { assertRowCap, guardJobCapacity } from "../lib/limits.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { scoreLeadsWithLearning } from "../services/insights.js";

export const icpRoutes = new Hono<Env>();
icpRoutes.use("*", requireAuth);

// Each facet is a bounded list of short terms: an ICP is a handful of each, and the lists
// are read into search queries and rule scoring, so an unbounded one was free storage and
// unbounded downstream work.
// 500, not 50: ICPs saved before this cap existed can hold more than 50 terms in a facet
// (the AI builder and pasted keyword lists produce them), and a cap below what is already
// stored made those ICPs impossible to save again - even to change their name.
const facet = z.array(z.string().max(200)).max(500);
const criteria = z.object({
  industries: facet.optional(),
  titles: facet.optional(),
  seniorities: facet.optional(),
  departments: facet.optional(),
  companySizes: facet.optional(),
  locations: facet.optional(),
  countries: facet.optional(),
  keywords: facet.optional(),
  excludeKeywords: facet.optional(),
  techStack: facet.optional(),
});
// description, seedDomains and clientId are nullable because GET returns null for them, and
// the edit form sends back what it read.
const icpInput = z.object({ name: z.string().min(1).max(200), description: z.string().max(5000).nullish(), criteria: criteria.optional(), seedDomains: z.array(z.string()).max(10).nullish(), product: z.string().max(5000).optional(), buildWithAi: z.boolean().default(true), clientId: z.string().uuid().nullish() });

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
  await assertRowCap(db, icps, oid, "icps");
  await assertOwned(clients, b.clientId, oid, "Client", c);
  // Checked before the insert: a "queue is full, try again" answer must not leave the ICP
  // saved, or the retry makes a second one.
  const build = !!(b.buildWithAi && (b.description || b.seedDomains?.length));
  if (build) await guardJobCapacity(db, oid, "icp.build");
  const [row] = await db.insert(icps).values({ orgId: oid, name: b.name, description: b.description ?? null, criteria: b.criteria ?? {}, seedDomains: b.seedDomains ?? [], clientId: b.clientId ?? null }).returning();
  let jobId: string | null = null;
  if (build) {
    jobId = (await enqueue(db, "icp.build", { icpId: row.id, product: b.product }, { orgId: oid })).id;
  }
  return c.json({ icp: row, jobId }, 201);
});

icpRoutes.get("/:id", async (c) => {
  const { db } = getDb();
  const row = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))) });
  if (!row) throw notFound("ICP");
  return c.json(row);
});

// `.partial()` keeps buildWithAi's default, so an empty body would still look non-empty.
icpRoutes.patch("/:id", zValidator("json", icpInput.omit({ buildWithAi: true }).partial().extend({ buildWithAi: z.boolean().optional() })), async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const b = c.req.valid("json");
  requireSomeFields(b);
  // clientId used to be accepted here and dropped, so moving an ICP to a client saved
  // nothing. It is applied now, after the same ownership check as on create.
  await assertOwned(clients, b.clientId, oid, "Client", c);
  const [row] = await db
    .update(icps)
    .set({ ...(b.name ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.criteria ? { criteria: b.criteria } : {}), ...(b.seedDomains !== undefined ? { seedDomains: b.seedDomains ?? [] } : {}), ...(b.clientId !== undefined ? { clientId: b.clientId } : {}), updatedAt: new Date() })
    .where(and(eq(icps.id, c.req.param("id")), eq(icps.orgId, oid)))
    .returning();
  if (!row) throw notFound("ICP");
  return c.json(row);
});

icpRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(icps).where(and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c)))).returning({ id: icps.id });
  if (!gone.length) throw notFound("ICP");
  return c.json({ ok: true });
});

/** Re-run AI profile build. */
icpRoutes.post("/:id/build", async (c) => {
  const { db } = getDb();
  const row = await db.query.icps.findFirst({ where: and(eq(icps.id, c.req.param("id")), eq(icps.orgId, orgId(c))) });
  if (!row) throw notFound("ICP");
  await guardJobCapacity(db, row.orgId, "icp.build");
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

  const ai = aiFor(c.get("auth"));
  // The workspace switched AI off itself: a 409 that says so and how to turn it back on.
  if (aiDisabled(c.get("auth").org)) throw new ApiError(409, AI_OFF_UNAVAILABLE, "ai_off");
  // 503, not 404: the ICP exists; the service it needs is not available.
  if (!hasAi(ai)) throw new ApiError(503, `The ICP assistant is unavailable: ${AI_NOT_SWITCHED_ON}`, "ai_unavailable");
  // Checked before the call and charged after it worked. The charge used to come after with
  // its error swallowed, so an org past its AI quota chatted on for free.
  await assertQuotaAvailable(db, oid, "aiMessages", 1);

  const history = (icp.chatHistory ?? []) as IcpChatMessage[];
  const summary = String((icp.aiProfile as { summary?: string } | null)?.summary ?? icp.description ?? "");
  const result = await refineIcpWithAi(ai, { criteria: (icp.criteria ?? {}) as IcpCriteria, summary, history, message: b.message });
  if (!result) throw new ApiError(502, "The AI did not return a usable answer. Try again.", "ai_no_response");
  await consume(db, oid, "aiMessages", 1);

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
  /**
   * Which leads this ICP may score.
   *
   * It used to take the first 5000 leads in the WORKSPACE, and with `assign` wrote this ICP's
   * score and id onto all of them - for an agency, overwriting every other client's scores
   * with one client's profile. A client's ICP scores that client's leads; a workspace ICP
   * scores the unassigned pool plus leads already on it. Explicit leadIds are still limited
   * to the same set, so a request cannot reach past it.
   */
  const scope = icp.clientId ? eq(leads.clientId, icp.clientId) : or(isNull(leads.clientId), eq(leads.icpId, icp.id))!;
  const rows = await db
    .select({ lead: leads, company: companies })
    .from(leads)
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(leads.orgId, oid), scope, b.leadIds ? inArray(leads.id, b.leadIds) : undefined))
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
  const ai = aiFor(c.get("auth"));
  // Each rerank is one AI call and is charged as one, before it is made. It used to be free.
  const rerank = { requested: Math.min(b.aiRerankTop, scored.length), done: 0, skipped: undefined as string | undefined };
  if (b.aiRerankTop > 0 && !hasAi(ai)) rerank.skipped = aiDisabled(c.get("auth").org) ? "ai_off" : "no_ai_provider";
  if (b.aiRerankTop > 0 && hasAi(ai)) {
    const summary = String((icp.aiProfile as { summary?: string } | null)?.summary ?? icp.description ?? icp.name);
    for (const s of scored.slice(0, b.aiRerankTop)) {
      const charge = await tryConsume(db, oid, "aiMessages", 1);
      if (!charge.ok) {
        rerank.skipped = charge.reason === "quota" ? "quota" : "error";
        break;
      }
      rerank.done++;
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
    for (const s of scored) await db.update(leads).set({ score: s.score, scoreReasons: s.reasons, icpId: icp.id, updatedAt: new Date() }).where(and(eq(leads.id, s.lead.id), eq(leads.orgId, oid)));
  }
  return c.json({
    counts: { scored: scored.length, assigned: b.assign ? scored.length : 0, requested: b.leadIds ? new Set(b.leadIds).size : undefined, outOfScope: b.leadIds ? new Set(b.leadIds).size - scored.length : undefined, scope: icp.clientId ? "client" : "pool_and_icp" },
    aiRerank: b.aiRerankTop > 0 ? rerank : undefined,
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
