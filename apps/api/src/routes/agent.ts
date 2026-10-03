import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { QuotaExceededError, consume, consumeLead, getDb, remainingPremiumBudget } from "@prospex/db";
import { generateOutreach, runLeadPipelineDetailed } from "@prospex/core";
import { aiFor } from "../lib/ai.js";
import { blockedByProvidersNote } from "../services/notes.js";
import { env } from "../env.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { findExistingLead, pipelineLeadToInput, upsertLead } from "../services/leads.js";
import { tryConsume } from "../lib/quota.js";

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
    const ai = aiFor(c.get("auth"));
    const providerBudget = await remainingPremiumBudget(db, oid);
    // Detailed, so an agent (and the console) can tell "nobody matched" from "no source could answer".
    const { leads: results, providerFailures, notes } = await runLeadPipelineDetailed({ query: b.query, limit: b.limit, findEmails: b.findEmails }, { ai, verify: { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey }, country: b.country, maxProviderLeads: providerBudget });
    const out = [];
    /** Set when a quota or a fault stopped part of this run. Reported, not swallowed. */
    let emailSkipped: string | null = null;
    let saveSkipped: string | null = null;
    for (const r of results) {
      let leadId: string | undefined;
      if (b.save) {
        // consumeLead throws QuotaExceededError for a plan limit and anything else for a
        // fault; telling an agent it is out of quota when the database blipped sends it
        // off to ask the customer to upgrade.
        try {
          const input = pipelineLeadToInput(r, { tags: ["agent"] });
          // A lead the org already has is an update, not a new lead to bill.
          if (!(await findExistingLead(oid, input))) await consumeLead(db, oid, r.source);
          leadId = (await upsertLead(oid, input, { fillOnly: true })).lead.id;
        } catch (e) {
          if (!saveSkipped) saveSkipped = e instanceof QuotaExceededError ? e.message : `could not record usage: ${(e as Error).message}`;
        }
      }
      let email: { subject: string; body: string } | undefined;
      if (b.generateEmails && b.sender && r.email) {
        const charge = await tryConsume(db, oid, "aiMessages", 1);
        if (!charge.ok) emailSkipped = charge.reason === "quota" ? charge.message : `could not record usage: ${charge.message}`;
        if (charge.ok) {
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
    return c.json({
      query: b.query,
      count: out.length,
      leads: out,
      // An agent acting on this needs to know the difference between "that is everything"
      // and "we stopped early", and which of the two reasons it was.
      skipped: saveSkipped || emailSkipped ? { saving: saveSkipped ?? undefined, drafting: emailSkipped ?? undefined } : undefined,
      providerFailures: providerFailures.length ? providerFailures : undefined,
      note:
        out.length === 0 && providerFailures.length
          ? blockedByProvidersNote(providerFailures, "This is not the same as nobody matching.")
          : undefined,
      notes: notes?.length ? notes : undefined,
      next: "Use POST /v1/campaigns to sequence these leads, or POST /v1/integrations/{provider}/sync to push to a CRM.",
    });
  },
);

/** Capability discovery for agents. */
agentRoutes.get("/capabilities", (c) =>
  c.json({
    name: "Scout",
    version: "1.0.0",
    capabilities: ["prospect", "find_people", "find_companies", "enrich_company", "find_email", "verify_email", "score_icp", "generate_email", "run_sequence", "crm_sync", "webhooks"],
    openapi: `${env.apiUrl}/openapi.json`,
    mcp: "npx @prospex/mcp (set PROSPEX_API_KEY, PROSPEX_API_URL)",
  }),
);
