import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, companies, consume, desc, inArray, enqueue, eq, getDb, icps, leads, organizations, sql } from "@prospex/db";
import { createAiProvider, createAiProviderForPlan, scoreLeadRules, scoreLeadWithAi, hasAi, refineIcpWithAi, type IcpCriteria, type IcpChatMessage } from "@prospex/core";
import { notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";

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
icpRoutes.post("/:id/score", zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).optional(), assign: z.boolean().default(false), aiRerankTop: z.number().int().min(0).max(50).default(0) })), async (c) => {
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
  if (b.assign) {
    for (const s of scored) await db.update(leads).set({ score: s.score, scoreReasons: s.reasons, icpId: icp.id, updatedAt: new Date() }).where(eq(leads.id, s.lead.id));
  }
  return c.json({ scored: scored.map((s) => ({ leadId: s.lead.id, fullName: s.lead.fullName, title: s.lead.title, company: s.company?.name, score: s.score, reasons: s.reasons })) });
});
