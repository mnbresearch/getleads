import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { consume, consumeLead, getDb, remainingPremiumBudget } from "@getleads/db";
import { createAiProvider, generateOutreach, runLeadPipeline } from "@getleads/core";
import { env } from "../env.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { pipelineLeadToInput, upsertLead } from "../services/leads.js";

/**
 * Agent-first endpoints: single calls that do a whole workflow, with plain JSON in/out.
 * Designed for tool-calling LLMs (Claude, GPT, Cortex agents) and the MCP server.
 */
export const agentRoutes = new Hono<Env>();
agentRoutes.use("*", requireAuth);

agentRoutes.post(
  "/prospect",
  rateLimit({ perMinute: 10 }),
  zValidator(
    "json",
    z.object({
      query: z.string().min(3).max(500),
      limit: z.number().int().min(1).max(10).default(5),
      findEmails: z.boolean().default(true),
      generateEmails: z.boolean().default(false),
      sender: z.object({ name: z.string(), company: z.string(), title: z.string().optional(), valueProp: z.string(), tone: z.enum(["friendly", "direct", "formal", "casual"]).optional() }).optional(),
      save: z.boolean().default(true),
      country: z.string().length(2).optional(),
    }),
  ),
  async (c) => {
    const oid = orgId(c);
    const b = c.req.valid("json");
    const { db } = getDb();
    await consume(db, oid, "searches", 1);
    const ai = createAiProvider();
    const providerBudget = await remainingPremiumBudget(db, oid);
    const results = await runLeadPipeline({ query: b.query, limit: b.limit, findEmails: b.findEmails }, { ai, verify: { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey }, country: b.country, maxProviderLeads: providerBudget });
    const out = [];
    for (const r of results) {
      let leadId: string | undefined;
      if (b.save) {
        const okQuota = await consumeLead(db, oid, r.source).then(() => true, () => false);
        if (okQuota) leadId = (await upsertLead(oid, pipelineLeadToInput(r, { tags: ["agent"] }))).lead.id;
      }
      let email: { subject: string; body: string } | undefined;
      if (b.generateEmails && b.sender && r.email) {
        const okQuota = await consume(db, oid, "aiMessages", 1).then(() => true, () => false);
        if (okQuota) {
          const g = await generateOutreach(ai, { lead: { firstName: r.firstName, lastName: r.lastName, fullName: r.fullName, title: r.title, company: r.company ? { name: r.company.name, domain: r.company.domain, industry: r.company.industry, description: r.company.description } : null }, sender: b.sender });
          email = { subject: g.subject, body: g.body };
        }
      }
      out.push({
        leadId,
        name: r.fullName,
        title: r.title,
        company: r.company?.name ?? r.companyName,
        domain: r.companyDomain,
        location: r.location,
        linkedinUrl: r.linkedinUrl,
        email: r.email,
        emailStatus: r.emailStatus,
        emailConfidence: r.emailConfidence,
        score: r.score,
        scoreReasons: r.scoreReasons,
        companyDescription: r.company?.description,
        techStack: r.company?.techStack,
        draftEmail: email,
      });
    }
    return c.json({ query: b.query, count: out.length, leads: out, next: "Use POST /v1/campaigns to sequence these leads, or POST /v1/integrations/{provider}/sync to push to a CRM." });
  },
);

/** Capability discovery for agents. */
agentRoutes.get("/capabilities", (c) =>
  c.json({
    name: "GetLeads",
    version: "1.0.0",
    capabilities: ["prospect", "find_people", "find_companies", "enrich_company", "find_email", "verify_email", "score_icp", "generate_email", "run_sequence", "crm_sync", "webhooks"],
    openapi: `${env.apiUrl}/openapi.json`,
    mcp: "npx @getleads/mcp (set GETLEADS_API_KEY, GETLEADS_API_URL)",
  }),
);
