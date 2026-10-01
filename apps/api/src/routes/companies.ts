import { Hono } from "hono";
import { and, companies, consume, count, desc, eq, getDb, isNull, leads, or, signals } from "@prospex/db";
import { generateAccountBrief, hasAi } from "@prospex/core";
import { aiFor } from "../lib/ai.js";
import { assertQuotaAvailable } from "../lib/quota.js";
import { notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";

export const companyRoutes = new Hono<Env>();
companyRoutes.use("*", requireAuth);

companyRoutes.get("/:id", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const company = await db.query.companies.findFirst({ where: and(eq(companies.id, c.req.param("id")), eq(companies.orgId, oid)) });
  if (!company) throw notFound("Company");
  const [{ n: leadCount }] = await db.select({ n: count() }).from(leads).where(and(eq(leads.orgId, oid), eq(leads.companyId, company.id)));
  return c.json({ company, leadCount });
});

/**
 * Generate (or return the cached) AI account intelligence brief for a company: a short
 * "who they are / why reach out now / talking points" summary a rep can act on. Cached on
 * companies.aiBrief so repeat views don't re-spend an AI call; pass {"refresh": true} to
 * regenerate. Uses the same free-tier-first AI provider gating as the rest of the platform -
 * Growth+ plans get the best available provider, lower plans stay on free providers only.
 */
companyRoutes.post("/:id/brief", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const company = await db.query.companies.findFirst({ where: and(eq(companies.id, c.req.param("id")), eq(companies.orgId, oid)) });
  if (!company) throw notFound("Company");

  const body = await c.req.json().catch(() => ({}));
  const refresh = body?.refresh === true;
  const cached = company.aiBrief as { summary: string; whyNow: string; angles: string[] } | null;
  if (cached && !refresh) return c.json({ brief: cached, cached: true, generatedAt: company.aiBriefAt });

  const ai = aiFor(c.get("auth"));
  if (!hasAi(ai)) return c.json({ brief: null, cached: false, error: "No AI provider configured" }, 200);
  // Refuse before the AI call when the plan has no room; charge after it succeeds. Charging
  // only after meant an over-quota org got the brief (the paid part) and then a 402.
  await assertQuotaAvailable(db, oid, "aiMessages", 1);

  const companySignals = await db
    .select()
    .from(signals)
    // Shared signals plus this org's own. Private job-change signals belong to the org that
    // tracks the person; reading by domain alone put another workspace's in this brief.
    .where(and(eq(signals.companyDomain, company.domain), or(isNull(signals.orgId), eq(signals.orgId, oid))))
    .orderBy(desc(signals.occurredAt))
    .limit(8);

  const brief = await generateAccountBrief(
    ai,
    {
      name: company.name,
      domain: company.domain,
      industry: company.industry,
      size: company.size,
      location: company.location,
      description: company.description,
      techStack: company.techStack,
      headcount: company.headcount,
      fundingTotalUsd: company.fundingTotalUsd,
      lastFundingRound: company.lastFundingRound,
      openRoles: company.openRoles,
    },
    companySignals.map((s) => ({ type: s.type, title: s.title, summary: s.summary, occurredAt: s.occurredAt })),
  );
  if (!brief) return c.json({ brief: null, cached: false, error: "No AI provider configured" }, 200);

  await consume(db, oid, "aiMessages", 1);
  await db.update(companies).set({ aiBrief: brief, aiBriefAt: new Date() }).where(eq(companies.id, company.id));
  return c.json({ brief, cached: false, generatedAt: new Date() });
});
