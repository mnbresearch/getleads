import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, consume, consumeLead, desc, drainJobs, enqueue, eq, getDb, getJob, jobs, remainingPremiumBudget, searches } from "@prospex/db";
import { crawlCompanyWebsite, extractDomain, findCompanies, findEmail, findPeople, resolveCompanyDomain, runLeadPipeline, createAiProvider, verifyEmail, parseQuery, pMap } from "@prospex/core";
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
});

const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });

/** Async lead search (recommended). Returns a search + job id to poll. */
searchRoutes.post("/", rateLimit({ perMinute: 30 }), zValidator("json", searchInput), async (c) => {
  const oid = orgId(c);
  const body = c.req.valid("json");
  if (!body.query && !body.titles?.length && !body.companyDomains?.length) throw badRequest("Provide `query`, `titles` or `companyDomains`");
  const { db } = getDb();
  await consume(db, oid, "searches", 1);
  const [search] = await db.insert(searches).values({ orgId: oid, query: body, status: "queued" }).returning();
  const job = await enqueue(db, "search.run", { searchId: search.id, query: body, icpId: body.icpId, listId: body.listId }, { orgId: oid, priority: 2 });
  await db.update(searches).set({ jobId: job.id }).where(eq(searches.id, search.id));
  if (env.jobMode === "inline") {
    // serverless: run now, bounded
    await drainJobs(db, handlers, 25_000);
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
  await consume(db, oid, "searches", 1);
  const providerBudget = await remainingPremiumBudget(db, oid);
  const results = await runLeadPipeline(body, { ai: createAiProvider(), verify: verifyOpts(), country: body.country, maxProviderLeads: providerBudget });
  if (body.save) {
    const { upsertLead, pipelineLeadToInput } = await import("../services/leads.js");
    for (const r of results) {
      await consumeLead(db, oid, r.source).catch(() => null);
      await upsertLead(oid, pipelineLeadToInput(r, { icpId: body.icpId ?? null }));
    }
  }
  return c.json({ results });
});

/** Parse a natural-language prospecting query into filters (AI-backed). */
searchRoutes.post("/parse", zValidator("json", z.object({ query: z.string().min(3).max(500) })), async (c) => {
  return c.json(await parseQuery(createAiProvider(), { query: c.req.valid("json").query }));
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
