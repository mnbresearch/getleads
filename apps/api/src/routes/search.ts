import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, consume, consumeLead, desc, runJobById, enqueue, eq, getDb, getJob, icps, jobs, listLeads, lists, QuotaExceededError, remainingPremiumBudget, searches } from "@prospex/db";
import { assertOwned } from "../lib/ownership.js";
import { crawlCompanyWebsite, extractDomain, findCompanies, findEmail, findPeople, resolveCompanyDomain, runLeadPipeline, verifyEmail, parseQuery, pMap } from "@prospex/core";
import { aiFor, NO_AI } from "../lib/ai.js";
import { tryConsume } from "../lib/quota.js";
import { env } from "../env.js";
import { badRequest, notFound } from "../lib/errors.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { upsertCompany } from "../services/leads.js";
import { handlers } from "../jobs.js";

export const searchRoutes = new Hono<Env>();
searchRoutes.use("*", requireAuth);

const searchInput = z.object({
  query: z.string().max(500).optional(),
  titles: z.array(z.string()).max(10).optional(),
  industries: z.array(z.string()).max(10).optional(),
  locations: z.array(z.string()).max(10).optional(),
  companySizes: z.array(z.string()).max(10).optional(),
  keywords: z.array(z.string()).max(10).optional(),
  companyDomains: z.array(z.string()).max(50).optional(),
  limit: z.number().int().min(1).max(200).default(25),
  findEmails: z.boolean().default(true),
  icpId: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
  country: z.string().length(2).optional(),
  /** Run this search for a client: its leads are delivered to that client. */
  clientId: z.string().uuid().optional(),
});

const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });

/** Async lead search (recommended). Returns a search + job id to poll. */
searchRoutes.post("/", rateLimit({ perMinute: 30 }), zValidator("json", searchInput), async (c) => {
  const oid = orgId(c);
  const body = c.req.valid("json");
  if (!body.query && !body.titles?.length && !body.companyDomains?.length) throw badRequest("Provide `query`, `titles` or `companyDomains`");
  const { db } = getDb();
  // Checked before anything is charged: a search for a client that is not in this workspace
  // must fail, not run unattributed.
  // Every id in the body names a row this org must own. The ICP and list were not checked
  // before, and the job reads the ICP and writes into list_leads by id alone - so a caller
  // who knew another workspace's list id could write their leads into it.
  await assertOwned(icps, body.icpId, oid, "ICP");
  await assertOwned(lists, body.listId, oid, "List");
  let icpId = body.icpId;
  if (body.clientId) {
    const { requireClient } = await import("../services/clients.js");
    const client = await requireClient(oid, body.clientId);
    if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before running searches for it.");
    // With no ICP given, a client search is scored against that client's own ICP - which is
    // the point of running it for them.
    icpId = icpId ?? client.icpId ?? undefined;
  }
  await consume(db, oid, "searches", 1);
  const [search] = await db.insert(searches).values({ orgId: oid, query: body, status: "queued", clientId: body.clientId ?? null }).returning();
  const job = await enqueue(db, "search.run", { searchId: search.id, query: body, icpId, listId: body.listId, clientId: body.clientId }, { orgId: oid, priority: 2 });
  await db.update(searches).set({ jobId: job.id }).where(eq(searches.id, search.id));
  if (env.jobMode === "inline") {
    // serverless: run this search's own job now. Draining the whole queue made the user's
    // search wait behind every scheduler and backlog job that happened to be due.
    await runJobById(db, handlers, job.id);
    const s = await db.query.searches.findFirst({ where: eq(searches.id, search.id) });
    return c.json({ search: s, jobId: job.id }, 200);
  }
  return c.json({ search, jobId: job.id, poll: `/v1/search/${search.id}` }, 202);
});

searchRoutes.get("/", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(searches).where(eq(searches.orgId, orgId(c))).orderBy(desc(searches.createdAt)).limit(50);
  return c.json({ searches: rows });
});

searchRoutes.get("/:id", async (c) => {
  const { db } = getDb();
  const s = await db.query.searches.findFirst({ where: and(eq(searches.id, c.req.param("id")), eq(searches.orgId, orgId(c))) });
  if (!s) throw notFound("Search");
  const job = s.jobId ? await getJob(db, s.jobId) : null;
  const leadIds = (job?.result as { leadIds?: string[] } | null)?.leadIds ?? [];
  return c.json({ search: s, job: job ? { id: job.id, status: job.status, progress: job.progress, error: job.error } : null, leadIds });
});

/**
 * Synchronous "quick prospect" for agents and demos - bounded to 10 results, no persistence unless save=true.
 * Slower request (5-40s) but a single call.
 */
searchRoutes.post("/quick", rateLimit({ perMinute: 10 }), zValidator("json", searchInput.extend({ limit: z.number().int().min(1).max(10).default(5), save: z.boolean().default(false) })), async (c) => {
  const oid = orgId(c);
  const body = c.req.valid("json");
  const { db } = getDb();
  // The same ownership checks as the async search. This route took icpId on trust and
  // ignored clientId and listId entirely, so a "saved" quick search landed nowhere it said.
  await assertOwned(icps, body.icpId, oid, "ICP");
  await assertOwned(lists, body.listId, oid, "List");
  let icpId = body.icpId;
  if (body.clientId) {
    const { requireClient } = await import("../services/clients.js");
    const client = await requireClient(oid, body.clientId);
    if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before running searches for it.");
    icpId = icpId ?? client.icpId ?? undefined;
  }
  await consume(db, oid, "searches", 1);
  const providerBudget = await remainingPremiumBudget(db, oid);
  const results = await runLeadPipeline(body, { ai: aiFor(c.get("auth")), verify: verifyOpts(), country: body.country, maxProviderLeads: providerBudget });
  let saved: { leadId: string; created: boolean }[] | undefined;
  let skipped: string | undefined;
  let stopped: string | undefined;
  if (body.save) {
    const { upsertLead, pipelineLeadToInput, findExistingLead } = await import("../services/leads.js");
    saved = [];
    for (const r of results) {
      const input = pipelineLeadToInput(r, { icpId: icpId ?? null });
      // Charged only for a lead this creates, and BEFORE creating it, so the limit actually
      // stops the save. It used to charge every result (duplicates included) and swallow the
      // quota error, which saved over-limit leads anyway.
      const isNew = !(await findExistingLead(oid, input));
      if (isNew) {
        try {
          await consumeLead(db, oid, r.source);
        } catch (e) {
          if (!(e instanceof QuotaExceededError)) throw e;
          skipped = "quota";
          stopped = `Saved ${saved.length} of ${results.length}: ${e.message}`;
          break;
        }
      }
      const { lead, created } = await upsertLead(oid, input, { fillOnly: true });
      saved.push({ leadId: lead.id, created });
    }
    const ids = saved.map((x) => x.leadId);
    if (ids.length && body.listId) await db.insert(listLeads).values(ids.map((leadId) => ({ listId: body.listId!, leadId }))).onConflictDoNothing();
    if (ids.length && body.clientId) {
      const { assignLeads } = await import("../services/clients.js");
      await assignLeads(oid, body.clientId, ids);
    }
  }
  return c.json({
    results,
    saved,
    skipped,
    stopped,
    note: !body.save && (body.listId || body.clientId) ? "listId and clientId apply only with save: true; nothing was saved." : undefined,
  });
});

/** Parse a natural-language prospecting query into filters (AI-backed). */
searchRoutes.post("/parse", zValidator("json", z.object({ query: z.string().min(3).max(500) })), async (c) => {
  const { db } = getDb();
  // One AI call, metered like every other. Over quota the rule-based parser answers instead,
  // and the response says so.
  const charge = await tryConsume(db, orgId(c), "aiMessages", 1);
  const parsed = await parseQuery(charge.ok ? aiFor(c.get("auth")) : NO_AI, { query: c.req.valid("json").query });
  return c.json(charge.ok ? parsed : { ...parsed, skipped: charge.reason === "quota" ? "quota" : "error" });
});

/** Find people at a specific company. */
searchRoutes.post("/people", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ companyName: z.string().optional(), companyDomain: z.string().optional(), titles: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).default(10) })), async (c) => {
  const b = c.req.valid("json");
  if (!b.companyName && !b.companyDomain) throw badRequest("companyName or companyDomain required");
  const { db } = getDb();
  await consume(db, orgId(c), "searches", 1);
  let name = b.companyName;
  if (!name && b.companyDomain) name = (await crawlCompanyWebsite(b.companyDomain, { maxPages: 1 }).catch(() => null))?.name ?? b.companyDomain.split(".")[0];
  const people = await findPeople({ companyName: name, titles: b.titles, locations: b.locations, limit: b.limit });
  return c.json({ people });
});

/** Find companies matching a description. */
searchRoutes.post("/companies", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ query: z.string().optional(), industries: z.array(z.string()).optional(), locations: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).default(20), resolveDomains: z.boolean().default(true) })), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  await consume(db, orgId(c), "searches", 1);
  let companies = await findCompanies(b);
  if (b.resolveDomains) {
    companies = await pMap(companies, async (co) => (co.domain || !co.name ? co : { ...co, domain: (await resolveCompanyDomain(co.name).catch(() => null)) ?? "" }), 4);
  }
  return c.json({ companies });
});

/** Enrich a company by domain (crawl website: description, emails, tech, people, socials). Persists. */
searchRoutes.post("/company/enrich", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ domain: z.string() })), async (c) => {
  const domain = extractDomain(c.req.valid("json").domain);
  if (!domain) throw badRequest("Invalid domain");
  const profile = await crawlCompanyWebsite(domain);
  const company = await upsertCompany(orgId(c), domain, profile);
  return c.json({ company, profile });
});

/** Verify one or many emails synchronously. */
searchRoutes.post("/verify", rateLimit({ perMinute: 60 }), zValidator("json", z.object({ email: z.string().optional(), emails: z.array(z.string()).max(100).optional() })), async (c) => {
  const b = c.req.valid("json");
  const list = b.emails ?? (b.email ? [b.email] : []);
  if (!list.length) throw badRequest("email or emails required");
  const { db } = getDb();
  await consume(db, orgId(c), "verifications", list.length);
  const results = await pMap(list, (e) => verifyEmail(e, verifyOpts()), 5);
  return c.json(b.emails ? { results } : results[0]);
});

/** Find an email from name + domain. */
searchRoutes.post("/find-email", rateLimit({ perMinute: 60 }), zValidator("json", z.object({ firstName: z.string(), lastName: z.string(), domain: z.string() })), async (c) => {
  const b = c.req.valid("json");
  const domain = extractDomain(b.domain);
  if (!domain) throw badRequest("Invalid domain");
  const { db } = getDb();
  await consume(db, orgId(c), "verifications", 1);
  return c.json(await findEmail({ firstName: b.firstName, lastName: b.lastName, domain }, verifyOpts()));
});

/** Job status (any job type owned by org). */
searchRoutes.get("/jobs/:jobId", async (c) => {
  const { db } = getDb();
  const j = await db.query.jobs.findFirst({ where: and(eq(jobs.id, c.req.param("jobId")), eq(jobs.orgId, orgId(c))) });
  if (!j) throw notFound("Job");
  return c.json({ id: j.id, type: j.type, status: j.status, progress: j.progress, result: j.result, error: j.error, createdAt: j.createdAt, updatedAt: j.updatedAt });
});
