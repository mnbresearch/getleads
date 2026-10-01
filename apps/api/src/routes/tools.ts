/**
 * Enrichment tools that mirror the Prospex.ai catalog:
 * LinkedIn URL → email, email → LinkedIn, colleagues, decision makers, batch enrich, domain health, saved searches, tasks, team, autopilot.
 */
import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, autopilots, campaignContacts, campaigns, clients, companies, consume, desc, enqueue, eq, getDb, icps, inArray, invites, leads, limitsFor, listLeads, lists, remainingPremiumBudget, savedSearches, sql, tasks, users, organizations, type Invite } from "@prospex/db";
import { checkDomainHealth, enrichWithProviders, extractDomain, findEmail, findLinkedinUrl, findPeople, pMap, resolveCompanyDomain, resolveLinkedinUrl, verifyEmail, detectHiring, companyNews } from "@prospex/core";
import { env } from "../env.js";
import { hashPassword, issueJwt } from "../lib/auth.js";
import { randomToken } from "../lib/crypto.js";
import { ApiError, badRequest, forbidden, notFound, requireSomeFields } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";
import { sendMail } from "../lib/mailer.js";
import { orgId, rateLimit, requireAuth, requireRole, requireUser, type Env } from "../middleware.js";
import { findExistingLead, upsertCompany, upsertLead } from "../services/leads.js";
import { advanceContact } from "../services/campaigns.js";
import { runAutopilot } from "../services/autopilot.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";

export const toolRoutes = new Hono<Env>();
toolRoutes.use("*", requireAuth);
const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });

const PERSONAS: Record<string, string[]> = {
  "CEO / Founder": ["CEO", "Founder", "Co-Founder", "Managing Director", "President"],
  "CTO / Engineering": ["CTO", "VP Engineering", "Head of Engineering", "Chief Technology Officer"],
  "CMO / Marketing": ["CMO", "VP Marketing", "Head of Marketing", "Marketing Director", "Head of Growth"],
  "Sales leader": ["VP Sales", "Head of Sales", "Chief Revenue Officer", "Sales Director", "Head of Business Development"],
  "CFO / Finance": ["CFO", "Finance Director", "Head of Finance", "Controller"],
  "COO / Operations": ["COO", "Head of Operations", "VP Operations", "Operations Director"],
  "HR / People": ["CHRO", "Head of HR", "VP People", "HR Director", "Talent Acquisition"],
  "Product": ["CPO", "VP Product", "Head of Product", "Product Director"],
  "IT / Security": ["CIO", "CISO", "Head of IT", "IT Director"],
  "Procurement": ["Head of Procurement", "Procurement Manager", "Purchasing Manager"],
};
toolRoutes.get("/personas", (c) => c.json({ personas: PERSONAS }));

/** LinkedIn URL(s) → person + work email. */
toolRoutes.post("/linkedin-to-email", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ urls: z.array(z.string()).min(1).max(25), save: z.boolean().default(false) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  await consume(db, oid, "verifications", b.urls.length);
  // Provider credit budget shared across this batch - reserved synchronously per item so
  // concurrent pMap iterations can't overspend it (JS has no true parallelism between awaits).
  let providerBudget = await remainingPremiumBudget(db, oid);
  /** Set once saving has to stop; the lookups still run, nothing more is stored. */
  let saveStopped: string | undefined;
  let saved = 0;
  let skipped = 0;
  const results = await pMap(b.urls, async (url) => {
    const resolved = await resolveLinkedinUrl(url).catch(() => null);
    if (!resolved) return { url, found: false, reason: "Could not read this profile." };
    let viaProvider = null as Awaited<ReturnType<typeof enrichWithProviders>> | null;
    if (providerBudget > 0) {
      providerBudget--;
      viaProvider = await enrichWithProviders({ linkedinUrl: url }).catch(() => null);
      // The provider call already happened, so it is recorded even past the cap (the cap was
      // enforced by providerBudget before the call). `.catch(() => {})` here meant any call
      // past the limit was simply never written down.
      if (viaProvider) await consume(db, oid, "premiumLeads", 1, { allowOverage: true });
    }
    // A name read off the URL slug ("another-ee-1a2b3c" -> "Another Ee") is a guess, not a
    // person. It is only good enough to search for an email with; on its own it is not a
    // result and never a lead. A provider's name, or the profile page's, replaces it.
    const slugOnly = resolved.source === "linkedin:slug";
    const providerName = viaProvider?.fullName?.trim() ? viaProvider.fullName.trim() : null;
    const p = providerName && slugOnly ? { ...resolved, ...splitFullName(providerName), fullName: providerName } : resolved;
    const nameResolved = !slugOnly || !!providerName;
    let domain = viaProvider?.companyDomain ?? (p.companyName ? await resolveCompanyDomain(p.companyName).catch(() => null) : null);
    let email = viaProvider?.email;
    let status = viaProvider?.emailStatus;
    let confidence = viaProvider?.email ? 0.9 : 0;
    if (!email && domain && p.firstName && p.lastName) {
      const r = await findEmail({ firstName: p.firstName, lastName: p.lastName, domain }, verifyOpts());
      email = r.email;
      status = r.status;
      confidence = r.confidence;
    }
    if (!nameResolved && !email) {
      if (b.save) skipped++;
      return { url, found: false, reason: "Profile not readable and no email found; the name in the URL alone is not enough to identify the person.", guessedName: p.fullName };
    }
    let leadId: string | undefined;
    let saveSkipped: string | undefined;
    if (b.save && !saveStopped) {
      // `save` used to store every lead without charging the leads quota at all. A new lead
      // is charged before it is stored; one the org already has is a free update.
      const input = { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title ?? viaProvider?.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: p.companyName ?? viaProvider?.companyName, companyDomain: domain, email, emailStatus: status, emailConfidence: confidence, source: "linkedin_url" };
      const isNew = !(await findExistingLead(oid, input));
      const charge = isNew ? await tryConsume(db, oid, "leads", 1) : ({ ok: true } as const);
      if (charge.ok) {
        leadId = (await upsertLead(oid, input, { fillOnly: true })).lead.id;
        saved++;
      } else saveStopped = charge.reason === "quota" ? `Saving stopped: ${charge.message}` : `Saving stopped: could not record usage (${charge.message})`;
    }
    if (b.save && !leadId) {
      skipped++;
      saveSkipped = saveStopped ?? "not saved";
    }
    return { url, found: true, person: { ...p, companyDomain: domain }, nameSource: slugOnly ? (providerName ? "provider" : "url") : "profile", email, emailStatus: status, confidence, leadId, ...(saveSkipped ? { saveSkipped } : {}) };
  }, 3);
  const found = results.filter((r) => r.found).length;
  return c.json({ results, saveStopped, skipped: saveStopped ? "quota" : undefined, counts: { requested: b.urls.length, found, notFound: b.urls.length - found, saved, skipped } });
});

/** "Jane van Doe" -> first "Jane", last "van Doe". */
function splitFullName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

/** Email(s) → LinkedIn URL + name/title. */
toolRoutes.post("/email-to-linkedin", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ emails: z.array(z.string().email()).min(1).max(25) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  await consume(db, oid, "verifications", b.emails.length);
  let providerBudget = await remainingPremiumBudget(db, oid);
  const results = await pMap(b.emails, async (email) => {
    let viaProvider = null as Awaited<ReturnType<typeof enrichWithProviders>> | null;
    if (providerBudget > 0) {
      providerBudget--;
      viaProvider = await enrichWithProviders({ email }).catch(() => null);
      // The provider call already happened, so it is recorded even past the cap (the cap was
      // enforced by providerBudget before the call). `.catch(() => {})` here meant any call
      // past the limit was simply never written down.
      if (viaProvider) await consume(db, oid, "premiumLeads", 1, { allowOverage: true });
    }
    if (viaProvider?.linkedinUrl) return { email, linkedinUrl: viaProvider.linkedinUrl, fullName: viaProvider.fullName, title: viaProvider.title, company: viaProvider.companyName, confidence: 0.9 };
    const [local, domain] = email.toLowerCase().split("@");
    const parts = local.split(/[._-]/).filter((x) => x.length > 1);
    const first = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : undefined;
    const last = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : undefined;
    const company = (await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) }))?.name ?? domain.split(".")[0];
    const r = first && last ? await findLinkedinUrl({ firstName: first, lastName: last, companyName: company, email }) : null;
    if (!r) return { email, linkedinUrl: null, confidence: 0 };
    const p = await resolveLinkedinUrl(r.url).catch(() => null);
    return { email, linkedinUrl: r.url, fullName: p?.fullName, title: p?.title, company: p?.companyName ?? company, confidence: r.confidence };
  }, 3);
  return c.json({ results });
});

/** Colleagues of a lead (same company, optional titles). */
toolRoutes.post("/colleagues", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ leadId: z.string().uuid().optional(), companyDomain: z.string().optional(), titles: z.array(z.string()).optional(), limit: z.number().int().min(1).max(25).default(10), save: z.boolean().default(false) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  let domain = b.companyDomain ? extractDomain(b.companyDomain) : null;
  let name: string | undefined;
  if (b.leadId) {
    const l = await db.query.leads.findFirst({ where: and(eq(leads.id, b.leadId), eq(leads.orgId, oid)) });
    const co = l?.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, l.companyId) }) : null;
    domain = co?.domain ?? domain;
    name = co?.name ?? undefined;
  }
  if (!domain && !name) throw badRequest("leadId or companyDomain required");
  await consume(db, oid, "searches", 1);
  if (!name && domain) name = (await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) }))?.name ?? domain.split(".")[0];
  const people = await findPeople({ companyName: name!, titles: b.titles, limit: b.limit });
  const saved: string[] = [];
  let stopped: string | undefined;
  if (b.save) for (const p of people) {
    // Upsert first, charge only for a lead this org did not already have, and say why the
    // list stopped short rather than returning a truncated one that reads as complete.
    const { lead, created } = await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: name, companyDomain: domain, source: "colleagues" }, { fillOnly: true });
    saved.push(lead.id);
    if (!created) continue;
    const charge = await tryConsume(db, oid, "leads", 1);
    if (!charge.ok) {
      stopped = charge.reason === "quota" ? `Stopped at ${saved.length}: ${charge.message}` : `Stopped at ${saved.length}: could not record usage (${charge.message})`;
      break;
    }
  }
  return c.json({ company: { name, domain }, people, savedLeadIds: saved, stopped });
});

/** Decision makers at a company by persona. */
toolRoutes.post("/decision-makers", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ companyDomain: z.string().optional(), companyName: z.string().optional(), personas: z.array(z.string()).default(["CEO / Founder", "Sales leader", "CMO / Marketing"]), limit: z.number().int().min(1).max(20).default(6), findEmails: z.boolean().default(true), save: z.boolean().default(true) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const domain = b.companyDomain ? extractDomain(b.companyDomain) : null;
  if (!domain && !b.companyName) throw badRequest("companyDomain or companyName required");
  await consume(db, oid, "searches", 1);
  const titles = [...new Set(b.personas.flatMap((p) => PERSONAS[p] ?? [p]))];
  const name = b.companyName ?? (domain ? ((await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) }))?.name ?? domain.split(".")[0]) : "");
  const people = await findPeople({ companyName: name, titles, limit: b.limit });
  const out = [];
  /** Why something in this run did less than asked. Reported, not swallowed. */
  let skipped: string | null = null;
  /** Set once saving must stop, so the limit is enforced rather than merely noted. */
  let saveStopped: string | null = null;
  for (const p of people) {
    let email: string | undefined, status: string | undefined, confidence = 0;
    if (b.findEmails && domain && p.firstName && p.lastName) {
      // Keep WHY the lookup was skipped. Collapsing it back to a boolean here would
      // reintroduce, one call away, the defect lib/quota.ts exists to fix: a dropped
      // connection silently skipping the lookup with no record anywhere.
      const charge = await tryConsume(db, oid, "verifications", 1);
      if (charge.ok) {
        const r = await findEmail({ firstName: p.firstName, lastName: p.lastName, domain }, verifyOpts()).catch(() => null);
        if (r) { email = r.email; status = r.status; confidence = r.confidence; }
      } else if (!skipped) skipped = charge.reason === "quota" ? `Email lookup stopped: ${charge.message}` : `Email lookup stopped: could not record usage (${charge.message})`;
    }
    let leadId: string | undefined;
    if (b.save && !saveStopped) {
      const { lead, created } = await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: name, companyDomain: domain, email, emailStatus: status, emailConfidence: confidence, source: "decision_makers" }, { fillOnly: true });
      leadId = lead.id;
      if (created) {
        const charge = await tryConsume(db, oid, "leads", 1);
        if (!charge.ok) {
          // Charging after the upsert is what stops a repeat being billed - but it also
          // means the limit is enforced by STOPPING here, not by skipping this one row.
          // Without the flag, an org at its limit had every remaining person saved anyway,
          // over quota, with a soft note in the response. One row over is the unavoidable
          // cost of not billing for repeats; the rest of the page is not.
          saveStopped = charge.reason === "quota" ? `Saving stopped at ${out.length + 1}: ${charge.message}` : `Saving stopped at ${out.length + 1}: could not record usage (${charge.message})`;
        }
      }
    }
    out.push({ ...p, email, emailStatus: status, confidence, leadId });
  }
  // Both, separately. Folding them into one field meant that when the email lookup failed
  // first, the fact that SAVING also stopped was discarded - so people came back with no
  // leadId and no explanation anywhere, which is the exact silence this field exists to
  // break.
  return c.json({ company: { name, domain }, people: out, skipped: skipped ?? undefined, saveStopped: saveStopped ?? undefined });
});

/** Company intelligence: hiring + recent news signals + firmographics, persisted. */
toolRoutes.post("/company-intel", rateLimit({ perMinute: 20 }), zValidator("json", z.object({ domain: z.string() })), async (c) => {
  const oid = orgId(c);
  const domain = extractDomain(c.req.valid("json").domain);
  if (!domain) throw badRequest("Invalid domain");
  const { db } = getDb();
  let company = await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) });
  if (!company || !company.enrichedAt) {
    const { crawlCompanyWebsite } = await import("@prospex/core");
    const prof = await crawlCompanyWebsite(domain).catch(() => null);
    company = await upsertCompany(oid, domain, prof ?? {});
  }
  // Both lookups can fail, and both used to collapse failure into empty. `intentScore` and
  // `signalsCount` were then ASSIGNED from those empties, so one news-search outage wrote
  // 0 over a company that scored 90 the day before and reported the zero as a finding. A
  // score is only rewritten when the inputs behind it actually arrived.
  const [hiring, news] = await Promise.all([
    detectHiring(domain, company.name ?? undefined).catch(() => null),
    company.name ? companyNews(company.name, 60).catch(() => null) : Promise.resolve([]),
  ]);
  const newsOk = news !== null;
  const items = news ?? [];
  const hiringOk = !!hiring && hiring.reached;

  const { storeSignals } = await import("../services/signals.js");
  if (items.length) await storeSignals(items.filter((n) => n.type !== "news").map((n) => ({ ...n, companyName: company!.name ?? undefined })), null);

  const nonNews = items.filter((n) => n.type !== "news").length;
  const intent = Math.min(100, (hiring?.openRoles ?? 0) * 3 + items.filter((n) => n.type === "funding").length * 25 + nonNews * 5);
  const scoreIsReal = newsOk && hiringOk;

  await db
    .update(companies)
    .set({
      openRoles: hiringOk ? hiring!.openRoles : company.openRoles,
      hiring: hiringOk ? { byFunction: hiring!.byFunction, source: hiring!.source, careersUrl: hiring!.careersUrl, titles: hiring!.titles.slice(0, 20) } : company.hiring,
      signalsCount: newsOk ? nonNews : company.signalsCount,
      lastSignalAt: items[0]?.occurredAt ?? company.lastSignalAt,
      intentScore: scoreIsReal ? intent : company.intentScore,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, company.id));

  // orgId is internal bookkeeping, not something a tool result should show; the company's
  // own id stays (it is how /v1/companies/:id addresses it).
  const { orgId: _org, ...publicCompany } = company;
  return c.json({
    company: { ...publicCompany, openRoles: hiringOk ? hiring!.openRoles : company.openRoles, intentScore: scoreIsReal ? intent : company.intentScore },
    hiring,
    news: items.slice(0, 20),
    // Say which inputs were actually gathered, so a caller is never left reading a stale
    // number as though it were fresh, or a zero as though it were a measurement.
    sources: {
      hiring: hiringOk ? "ok" : hiring ? "unreachable" : "failed",
      news: newsOk ? "ok" : "failed",
      intentScoreUpdated: scoreIsReal,
    },
  });
});

/** Sender domain health (SPF/DKIM/DMARC/MX). */
toolRoutes.get("/domain-health", zValidator("query", z.object({ domain: z.string() })), async (c) => {
  const domain = extractDomain(c.req.valid("query").domain);
  if (!domain) throw badRequest("Invalid domain");
  return c.json(await checkDomainHealth(domain));
});

/** Batch verify + enrich a list of leads (or all unverified). */
toolRoutes.post("/batch-enrich", zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).optional(), listId: z.string().uuid().optional(), onlyMissingEmail: z.boolean().default(true), limit: z.number().int().min(1).max(2000).default(500) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  await assertOwned(lists, b.listId, oid, "List");
  let ids: string[];
  let requested: number;
  if (b.leadIds?.length) {
    // Explicit ids are filtered to this workspace before they go on the job. They used to be
    // queued as given, so another org's leads could be enriched on (and billed to) this one.
    const asked = [...new Set(b.leadIds)];
    requested = asked.length;
    ids = (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, asked)))).map((r) => r.id);
  } else {
    const rows = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), b.listId ? sql`${leads.id} IN (SELECT lead_id FROM list_leads WHERE list_id = ${b.listId})` : sql`true`, b.onlyMissingEmail ? sql`(${leads.email} IS NULL OR ${leads.emailStatus} = 'unknown')` : sql`true`)).limit(b.limit);
    ids = rows.map((r) => r.id);
    requested = ids.length;
  }
  if (!ids.length) return c.json({ queued: 0, requested, notFound: requested, jobId: null });
  const job = await enqueue(db, "leads.bulk_enrich", { leadIds: ids }, { orgId: oid });
  return c.json({ queued: ids.length, requested, notFound: requested - ids.length, jobId: job.id }, 202);
});

/** Quick verify of arbitrary emails with CSV-ish output convenience. */
toolRoutes.post("/verify-batch", zValidator("json", z.object({ emails: z.array(z.string()).min(1).max(500) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const b = c.req.valid("json");
  await consume(db, oid, "verifications", b.emails.length);
  const results = await pMap(b.emails, (e) => verifyEmail(e, verifyOpts()), 6);
  const summary = results.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  return c.json({ results, summary });
});

// ── Saved searches ──
toolRoutes.get("/saved-searches", async (c) => {
  const { db } = getDb();
  return c.json({ savedSearches: await db.select().from(savedSearches).where(eq(savedSearches.orgId, orgId(c))).orderBy(desc(savedSearches.createdAt)) });
});
toolRoutes.post("/saved-searches", zValidator("json", z.object({ name: z.string().min(1).max(200), query: z.record(z.unknown()), alert: z.boolean().default(false), alertEmail: z.string().email().optional(), listId: z.string().uuid().optional(), clientId: z.string().uuid().optional() })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const { clientId, ...b } = c.req.valid("json");
  // Every id is checked against this workspace: the scheduled run writes into the list (and,
  // via the query, uses the ICP and client) by id alone, with no org predicate of its own.
  await assertOwned(lists, b.listId, oid, "List");
  const q = b.query as { icpId?: unknown; clientId?: unknown; listId?: unknown };
  if (typeof q.icpId === "string") await assertOwned(icps, q.icpId, oid, "ICP");
  // A saved search can run for a client. There is no column for it, so it travels in the
  // query - which is what the scheduled run reads - whether sent top-level or inside it.
  const cid = clientId ?? (typeof q.clientId === "string" ? q.clientId : undefined);
  if (cid) {
    const { requireClient } = await import("../services/clients.js");
    const client = await requireClient(oid, cid);
    if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before saving searches for it.");
  }
  const [row] = await db.insert(savedSearches).values({ orgId: oid, ...b, query: { ...b.query, ...(cid ? { clientId: cid } : {}) } }).returning();
  return c.json({ ...row, clientId: cid ?? null }, 201);
});
toolRoutes.delete("/saved-searches/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(savedSearches).where(and(eq(savedSearches.id, c.req.param("id")), eq(savedSearches.orgId, orgId(c)))).returning({ id: savedSearches.id });
  if (!gone.length) throw notFound("Saved search");
  return c.json({ ok: true });
});
toolRoutes.post("/saved-searches/:id/run", async (c) => {
  const { db } = getDb();
  const ss = await db.query.savedSearches.findFirst({ where: and(eq(savedSearches.id, c.req.param("id")), eq(savedSearches.orgId, orgId(c))) });
  if (!ss) throw notFound("Saved search");
  const job = await enqueue(db, "savedsearch.run", { savedSearchId: ss.id }, { orgId: ss.orgId, priority: 2 });
  return c.json({ jobId: job.id }, 202);
});

// ── Tasks (manual sequence steps + ad-hoc) ──
toolRoutes.get("/tasks", zValidator("query", z.object({ status: z.string().default("pending"), limit: z.coerce.number().max(500).default(100) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select({ task: tasks, lead: leads, company: companies })
    .from(tasks)
    // The join is scoped too. A task could point at another org's lead (the create route
    // took any leadId), and this join then returned that lead's name, email and phone.
    .leftJoin(leads, and(eq(tasks.leadId, leads.id), eq(leads.orgId, orgId(c))))
    .leftJoin(companies, and(eq(leads.companyId, companies.id), eq(companies.orgId, orgId(c))))
    .where(and(eq(tasks.orgId, orgId(c)), q.status === "all" ? sql`true` : eq(tasks.status, q.status)))
    .orderBy(tasks.dueAt)
    .limit(q.limit);
  return c.json({ tasks: rows.map((r) => ({ ...r.task, lead: r.lead ? { ...r.lead, company: r.company } : null })) });
});
toolRoutes.post("/tasks", zValidator("json", z.object({ leadId: z.string().uuid().optional(), type: z.string().default("task"), title: z.string().min(1), body: z.string().optional(), dueAt: z.string().datetime().optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertOwned(leads, b.leadId, orgId(c), "Lead");
  const [row] = await db.insert(tasks).values({ orgId: orgId(c), leadId: b.leadId, type: b.type, title: b.title, body: b.body, dueAt: b.dueAt ? new Date(b.dueAt) : new Date(), assigneeUserId: c.get("auth").user?.id }).returning();
  return c.json(row, 201);
});
toolRoutes.post("/tasks/:id/complete", zValidator("json", z.object({ outcome: z.enum(["done", "skipped"]).default("done"), note: z.string().optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  const t = await db.query.tasks.findFirst({ where: and(eq(tasks.id, c.req.param("id")), eq(tasks.orgId, orgId(c))) });
  if (!t) throw notFound("Task");
  await db.update(tasks).set({ status: b.outcome, completedAt: new Date() }).where(eq(tasks.id, t.id));
  if (t.contactId) await advanceContact(t.contactId); // sequence continues after the human step
  if (t.leadId && b.note) await db.update(leads).set({ custom: sql`custom || ${JSON.stringify({ [`task_${t.type}_note`]: b.note })}::jsonb` }).where(and(eq(leads.id, t.leadId), eq(leads.orgId, t.orgId)));
  await emitEvent(t.orgId, "task.completed", { taskId: t.id, type: t.type, outcome: b.outcome, leadId: t.leadId }, { type: "task", id: t.id });
  return c.json({ ok: true });
});

// ── Team ──
/** Invites last 14 days. A link that never expires is a standing key to the workspace. */
const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;
/** Invites created before expiry existed have no expiresAt; they expire 14 days after creation. */
const inviteExpiry = (i: Pick<Invite, "expiresAt" | "createdAt">) => i.expiresAt ?? new Date(i.createdAt.getTime() + INVITE_TTL_MS);
/** Unaccepted, unrevoked and unexpired: an invite that still holds a seat. */
const ACTIVE_INVITE = sql`${invites.acceptedAt} IS NULL AND ${invites.revokedAt} IS NULL AND coalesce(${invites.expiresAt}, ${invites.createdAt} + interval '14 days') > now()`;

/**
 * Seats in use: members plus invites that could still be accepted.
 *
 * Only members were counted, so a one-seat workspace could send any number of invites and
 * every one of them could be accepted - the limit was checked at invite time against a
 * number the invites themselves never changed.
 */
async function seatUsage(orgIdValue: string) {
  const { db } = getDb();
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(users).where(eq(users.orgId, orgIdValue));
  const [{ p }] = await db.select({ p: sql<number>`count(*)::int` }).from(invites).where(and(eq(invites.orgId, orgIdValue), ACTIVE_INVITE));
  return { members: m, pending: p };
}

/** Send (or re-send) an invite email. Reports whether it actually went, rather than assuming. */
async function sendInviteEmail(a: { orgName: string; inviter: string }, email: string, token: string) {
  const link = `${env.appUrl}/join?token=${token}`;
  const r = await sendMail(null, {
    from: env.mailFrom,
    to: email,
    subject: `${a.inviter} invited you to ${a.orgName} on Scout`,
    text: `${a.inviter} invited you to join ${a.orgName} on Scout.\n\nAccept the invite: ${link}\n\nThis link expires in 14 days.`,
  }).catch((e) => ({ ok: false, error: (e as Error).message }));
  return { link, emailed: r.ok, emailError: r.ok ? undefined : r.error };
}

toolRoutes.get("/team", requireUser, async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const members = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.orgId, oid));
  // Revoked and accepted invites are history; expired ones are still listed (marked) so they
  // can be re-sent rather than silently vanishing.
  const pending = await db.select().from(invites).where(and(eq(invites.orgId, oid), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`)).orderBy(desc(invites.createdAt));
  const limits = { ...limitsFor(c.get("auth").org.plan), ...c.get("auth").org.planLimits };
  const now = Date.now();
  const shaped = pending.map(({ token: _t, ...i }) => ({ ...i, expiresAt: inviteExpiry(i), expired: inviteExpiry(i).getTime() <= now }));
  return c.json({ members, invites: shaped, seats: { used: members.length, pending: shaped.filter((i) => !i.expired).length, limit: limits.seats } });
});
toolRoutes.post("/team/invite", requireUser, requireRole("owner", "admin"), zValidator("json", z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") })), async (c) => {
  const a = c.get("auth");
  if (!["owner", "admin"].includes(a.user!.role)) throw forbidden("Only owners/admins can invite");
  const { db } = getDb();
  const b = c.req.valid("json");
  const email = b.email.toLowerCase();
  const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existingUser) {
    throw new ApiError(409, existingUser.orgId === a.org.id ? `${email} is already a member of this workspace.` : `${email} already has a Scout account in another workspace, so it cannot be invited here. They would need to use a different email address.`, "already_registered");
  }
  const dupe = await db.query.invites.findFirst({ where: and(eq(invites.orgId, a.org.id), eq(invites.email, email), ACTIVE_INVITE) });
  if (dupe) throw new ApiError(409, `${email} already has a pending invite. Re-send it from the team list instead.`, "already_invited");
  const limits = { ...limitsFor(a.org.plan), ...a.org.planLimits };
  const seats = await seatUsage(a.org.id);
  if (limits.seats > 0 && seats.members + seats.pending >= limits.seats) {
    throw badRequest(`Seat limit reached (${limits.seats}: ${seats.members} member(s) and ${seats.pending} pending invite(s)). Revoke a pending invite or upgrade the plan to add more.`);
  }
  const token = randomToken(24);
  const [inv] = await db.insert(invites).values({ orgId: a.org.id, email, role: b.role, token, invitedBy: a.user!.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).returning();
  // sendMail answers { ok: false } rather than throwing; that used to be ignored, so the UI
  // said "Invite sent" for mail that never left. The link is returned either way so it can
  // be shared by hand.
  const sent = await sendInviteEmail({ orgName: a.org.name, inviter: a.user!.name || a.user!.email }, email, token);
  return c.json({ id: inv.id, email: inv.email, role: inv.role, link: sent.link, expiresAt: inv.expiresAt, emailed: sent.emailed, emailError: sent.emailError }, 201);
});

/** Revoke a pending invite: its link stops working and its seat is freed. */
async function revokeInvite(c: import("hono").Context<Env>) {
  const { db } = getDb();
  const [row] = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, c.req.param("id")!), eq(invites.orgId, orgId(c)), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`))
    .returning({ id: invites.id });
  if (!row) throw notFound("Pending invite");
  return c.json({ ok: true, id: row.id });
}

/** Re-send a pending invite, renewing its 14 days. Same link, so a forwarded copy still works. */
async function resendInvite(c: import("hono").Context<Env>) {
  const a = c.get("auth");
  const { db } = getDb();
  const inv = await db.query.invites.findFirst({ where: and(eq(invites.id, c.req.param("id")!), eq(invites.orgId, a.org.id), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`) });
  if (!inv) throw notFound("Pending invite");
  // An expired invite no longer holds a seat, so renewing one has to fit under the limit.
  if (inviteExpiry(inv).getTime() <= Date.now()) {
    const limits = { ...limitsFor(a.org.plan), ...a.org.planLimits };
    const seats = await seatUsage(a.org.id);
    if (limits.seats > 0 && seats.members + seats.pending >= limits.seats) throw badRequest(`Seat limit reached (${limits.seats}). Revoke another invite or upgrade the plan first.`);
  }
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.update(invites).set({ expiresAt }).where(eq(invites.id, inv.id));
  const sent = await sendInviteEmail({ orgName: a.org.name, inviter: a.user?.name || a.user?.email || a.org.name }, inv.email, inv.token);
  return c.json({ id: inv.id, email: inv.email, link: sent.link, expiresAt, emailed: sent.emailed, emailError: sent.emailError });
}

// Registered before /team/:userId. Different segment counts, so no capture today - but a
// static path above a param path is the rule this codebase now follows everywhere.
toolRoutes.delete("/team/invites/:id", requireUser, requireRole("owner", "admin"), revokeInvite);
toolRoutes.post("/team/invites/:id/resend", requireUser, requireRole("owner", "admin"), resendInvite);
// Short aliases.
toolRoutes.delete("/invites/:id", requireUser, requireRole("owner", "admin"), revokeInvite);
toolRoutes.post("/invites/:id/resend", requireUser, requireRole("owner", "admin"), resendInvite);

toolRoutes.delete("/team/:userId", requireUser, async (c) => {
  const a = c.get("auth");
  if (a.user!.role !== "owner") throw forbidden("Only the owner can remove members");
  if (a.user!.id === c.req.param("userId")) throw badRequest("Cannot remove yourself");
  const { db } = getDb();
  const gone = await db.delete(users).where(and(eq(users.id, c.req.param("userId")), eq(users.orgId, a.org.id))).returning({ id: users.id });
  if (!gone.length) throw notFound("Member");
  return c.json({ ok: true });
});

// ── Autopilot ──
// References are nullable: GET returns null for an unset one, and PATCH null detaches it.
const apInput = z.object({ name: z.string().min(1).max(200), query: z.record(z.unknown()), icpId: z.string().uuid().nullish(), listId: z.string().uuid().nullish(), campaignId: z.string().uuid().nullish(), dailyLeads: z.number().int().min(1).max(200).default(10), minScore: z.number().int().min(0).max(100).default(60), requireValidEmail: z.boolean().default(true), autoEnroll: z.boolean().default(false), active: z.boolean().default(true), runHourUtc: z.number().int().min(0).max(23).default(3) });
toolRoutes.get("/autopilots", async (c) => {
  const { db } = getDb();
  return c.json({ autopilots: await db.select().from(autopilots).where(eq(autopilots.orgId, orgId(c))).orderBy(desc(autopilots.createdAt)) });
});
/**
 * An autopilot scores against its ICP, saves into its list and enrolls into its campaign by
 * id, every night, with no org predicate in the job. Each id must belong to this workspace -
 * a foreign campaign id would have enrolled our leads into someone else's sequence.
 */
async function assertAutopilotRefs(oid: string, b: { icpId?: string | null; listId?: string | null; campaignId?: string | null; query?: Record<string, unknown> }) {
  await assertOwned(icps, b.icpId, oid, "ICP");
  await assertOwned(lists, b.listId, oid, "List");
  await assertOwned(campaigns, b.campaignId, oid, "Campaign");
  const qc = b.query?.clientId;
  if (typeof qc === "string") await assertOwned(clients, qc, oid, "Client");
}
toolRoutes.post("/autopilots", zValidator("json", apInput), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertAutopilotRefs(orgId(c), b);
  const [row] = await db.insert(autopilots).values({ orgId: orgId(c), ...b }).returning();
  return c.json(row, 201);
});
toolRoutes.patch("/autopilots/:id", zValidator("json", apInput.partial()), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  requireSomeFields(b);
  await assertAutopilotRefs(orgId(c), b);
  const [row] = await db.update(autopilots).set(b).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Autopilot");
  return c.json(row);
});
toolRoutes.delete("/autopilots/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(autopilots).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c)))).returning({ id: autopilots.id });
  if (!gone.length) throw notFound("Autopilot");
  return c.json({ ok: true });
});
toolRoutes.post("/autopilots/:id/run", async (c) => {
  const { db } = getDb();
  const ap = await db.query.autopilots.findFirst({ where: and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c))) });
  if (!ap) throw notFound("Autopilot");
  const job = await enqueue(db, "autopilot.run", { autopilotId: ap.id }, { orgId: ap.orgId, priority: 2 });
  return c.json({ jobId: job.id }, 202);
});

// ── Lead pipeline status / ownership ──
toolRoutes.post("/leads/:id/status", zValidator("json", z.object({ status: z.enum(["new", "contacted", "engaged", "replied", "qualified", "customer", "lost"]), ownerUserId: z.string().uuid().optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertOwned(users, b.ownerUserId, orgId(c), "User");
  const [row] = await db.update(leads).set({ status: b.status, ...(b.ownerUserId ? { ownerUserId: b.ownerUserId } : {}), updatedAt: new Date() }).where(and(eq(leads.id, c.req.param("id")), eq(leads.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Lead");
  await emitEvent(row.orgId, "lead.status_changed", { leadId: row.id, status: b.status }, { type: "lead", id: row.id });
  return c.json(row);
});

// ── Public: accept invite (mounted separately without auth) ──
export const joinRoutes = new Hono();
joinRoutes.post("/join", rateLimit({ perMinute: 10 }), zValidator("json", z.object({ token: z.string(), password: z.string().min(8), name: z.string().optional() })), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  const inv = await db.query.invites.findFirst({ where: eq(invites.token, b.token) });
  if (!inv || inv.acceptedAt) return c.json({ error: { code: "invalid_invite", message: "Invite is invalid or already used" } }, 400);
  if (inv.revokedAt) return c.json({ error: { code: "invite_revoked", message: "This invite was cancelled by the workspace. Ask them to send a new one." } }, 400);
  if (inviteExpiry(inv).getTime() <= Date.now()) return c.json({ error: { code: "invite_expired", message: "This invite has expired. Ask the workspace to re-send it." } }, 400);
  const existing = await db.query.users.findFirst({ where: eq(users.email, inv.email) });
  if (existing) return c.json({ error: { code: "exists", message: "An account with this email already exists" } }, 400);
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, inv.orgId) });
  if (!org || org.status === "deactivated" || org.status === "revoked") return c.json({ error: { code: "account_suspended", message: "This workspace is suspended, so its invites cannot be accepted." } }, 403);
  // Seats are re-checked at the moment of joining. This invite's own seat is already counted
  // among the pending ones, so it is the members alone that must still leave room for it.
  const limits = { ...limitsFor(org.plan), ...org.planLimits };
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(users).where(eq(users.orgId, org.id));
  if (limits.seats > 0 && m >= limits.seats) return c.json({ error: { code: "seat_limit", message: `${org.name} has no free seats (${limits.seats}). Ask an owner to upgrade or free a seat.` } }, 400);
  const [user] = await db.insert(users).values({ orgId: inv.orgId, email: inv.email, passwordHash: await hashPassword(b.password), name: b.name ?? "", role: inv.role, lastLoginAt: new Date() }).returning();
  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
  return c.json({ token: await issueJwt(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export { listLeads, campaignContacts };
