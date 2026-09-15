/**
 * Enrichment tools that mirror the GetLeads.ai catalog:
 * LinkedIn URL → email, email → LinkedIn, colleagues, decision makers, batch enrich, domain health, saved searches, tasks, team, autopilot.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, autopilots, campaignContacts, companies, consume, desc, enqueue, eq, getDb, invites, leads, limitsFor, listLeads, remainingPremiumBudget, savedSearches, sql, tasks, users } from "@getleads/db";
import { checkDomainHealth, enrichWithProviders, extractDomain, findEmail, findLinkedinUrl, findPeople, pMap, resolveCompanyDomain, resolveLinkedinUrl, verifyEmail, detectHiring, companyNews } from "@getleads/core";
import { env } from "../env.js";
import { hashPassword, issueJwt } from "../lib/auth.js";
import { randomToken } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { sendMail } from "../lib/mailer.js";
import { orgId, rateLimit, requireAuth, requireUser, type Env } from "../middleware.js";
import { upsertCompany, upsertLead } from "../services/leads.js";
import { advanceContact } from "../services/campaigns.js";
import { runAutopilot } from "../services/autopilot.js";
import { emitEvent } from "../lib/events.js";

export const toolRoutes = new Hono<Env>();
toolRoutes.use("*", requireAuth);
const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });

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
  const results = await pMap(b.urls, async (url) => {
    const p = await resolveLinkedinUrl(url).catch(() => null);
    if (!p) return { url, found: false };
    let viaProvider = null as Awaited<ReturnType<typeof enrichWithProviders>> | null;
    if (providerBudget > 0) {
      providerBudget--;
      viaProvider = await enrichWithProviders({ linkedinUrl: url }).catch(() => null);
      if (viaProvider) await consume(db, oid, "premiumLeads", 1).catch(() => {});
    }
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
    let leadId: string | undefined;
    if (b.save) leadId = (await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title ?? viaProvider?.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: p.companyName ?? viaProvider?.companyName, companyDomain: domain, email, emailStatus: status, emailConfidence: confidence, source: "linkedin_url" })).lead.id;
    return { url, found: true, person: { ...p, companyDomain: domain }, email, emailStatus: status, confidence, leadId };
  }, 3);
  return c.json({ results });
});

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
      if (viaProvider) await consume(db, oid, "premiumLeads", 1).catch(() => {});
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
  if (b.save) for (const p of people) {
    const ok = await consume(db, oid, "leads", 1).then(() => true, () => false);
    if (!ok) break;
    saved.push((await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: name, companyDomain: domain, source: "colleagues" })).lead.id);
  }
  return c.json({ company: { name, domain }, people, savedLeadIds: saved });
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
  for (const p of people) {
    let email: string | undefined, status: string | undefined, confidence = 0;
    if (b.findEmails && domain && p.firstName && p.lastName) {
      const ok = await consume(db, oid, "verifications", 1).then(() => true, () => false);
      if (ok) {
        const r = await findEmail({ firstName: p.firstName, lastName: p.lastName, domain }, verifyOpts()).catch(() => null);
        if (r) { email = r.email; status = r.status; confidence = r.confidence; }
      }
    }
    let leadId: string | undefined;
    if (b.save) {
      const ok = await consume(db, oid, "leads", 1).then(() => true, () => false);
      if (ok) leadId = (await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName: name, companyDomain: domain, email, emailStatus: status, emailConfidence: confidence, source: "decision_makers" })).lead.id;
    }
    out.push({ ...p, email, emailStatus: status, confidence, leadId });
  }
  return c.json({ company: { name, domain }, people: out });
});

/** Company intelligence: hiring + recent news signals + firmographics, persisted. */
toolRoutes.post("/company-intel", rateLimit({ perMinute: 20 }), zValidator("json", z.object({ domain: z.string() })), async (c) => {
  const oid = orgId(c);
  const domain = extractDomain(c.req.valid("json").domain);
  if (!domain) throw badRequest("Invalid domain");
  const { db } = getDb();
  let company = await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) });
  if (!company || !company.enrichedAt) {
    const { crawlCompanyWebsite } = await import("@getleads/core");
    const prof = await crawlCompanyWebsite(domain).catch(() => null);
    company = await upsertCompany(oid, domain, prof ?? {});
  }
  const [hiring, news] = await Promise.all([detectHiring(domain, company.name ?? undefined).catch(() => null), company.name ? companyNews(company.name, 60).catch(() => []) : Promise.resolve([])]);
  const { storeSignals } = await import("../services/signals.js");
  if (news.length) await storeSignals(news.filter((n) => n.type !== "news").map((n) => ({ ...n, companyName: company!.name ?? undefined })), null);
  const intent = Math.min(100, (hiring?.openRoles ?? 0) * 3 + news.filter((n) => n.type === "funding").length * 25 + news.filter((n) => n.type !== "news").length * 5);
  await db.update(companies).set({ openRoles: hiring?.openRoles ?? company.openRoles, hiring: hiring ? { byFunction: hiring.byFunction, source: hiring.source, careersUrl: hiring.careersUrl, titles: hiring.titles.slice(0, 20) } : company.hiring, signalsCount: news.filter((n) => n.type !== "news").length, lastSignalAt: news[0]?.occurredAt ?? company.lastSignalAt, intentScore: intent, updatedAt: new Date() }).where(eq(companies.id, company.id));
  return c.json({ company: { ...company, openRoles: hiring?.openRoles, intentScore: intent }, hiring, news: news.slice(0, 20) });
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
  let ids = b.leadIds ?? [];
  if (!ids.length) {
    const rows = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), b.listId ? sql`${leads.id} IN (SELECT lead_id FROM list_leads WHERE list_id = ${b.listId})` : sql`true`, b.onlyMissingEmail ? sql`(${leads.email} IS NULL OR ${leads.emailStatus} = 'unknown')` : sql`true`)).limit(b.limit);
    ids = rows.map((r) => r.id);
  }
  const job = await enqueue(db, "leads.bulk_enrich", { leadIds: ids }, { orgId: oid });
  return c.json({ queued: ids.length, jobId: job.id }, 202);
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
toolRoutes.post("/saved-searches", zValidator("json", z.object({ name: z.string().min(1), query: z.record(z.unknown()), alert: z.boolean().default(false), alertEmail: z.string().email().optional(), listId: z.string().uuid().optional() })), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(savedSearches).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  return c.json(row, 201);
});
toolRoutes.delete("/saved-searches/:id", async (c) => {
  const { db } = getDb();
  await db.delete(savedSearches).where(and(eq(savedSearches.id, c.req.param("id")), eq(savedSearches.orgId, orgId(c))));
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
    .leftJoin(leads, eq(tasks.leadId, leads.id))
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(tasks.orgId, orgId(c)), q.status === "all" ? sql`true` : eq(tasks.status, q.status)))
    .orderBy(tasks.dueAt)
    .limit(q.limit);
  return c.json({ tasks: rows.map((r) => ({ ...r.task, lead: r.lead ? { ...r.lead, company: r.company } : null })) });
});
toolRoutes.post("/tasks", zValidator("json", z.object({ leadId: z.string().uuid().optional(), type: z.string().default("task"), title: z.string().min(1), body: z.string().optional(), dueAt: z.string().datetime().optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
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
  if (t.leadId && b.note) await db.update(leads).set({ custom: sql`custom || ${JSON.stringify({ [`task_${t.type}_note`]: b.note })}::jsonb` }).where(eq(leads.id, t.leadId));
  await emitEvent(t.orgId, "task.completed", { taskId: t.id, type: t.type, outcome: b.outcome, leadId: t.leadId }, { type: "task", id: t.id });
  return c.json({ ok: true });
});

// ── Team ──
toolRoutes.get("/team", requireUser, async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const members = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.orgId, oid));
  const pending = await db.select().from(invites).where(and(eq(invites.orgId, oid), sql`${invites.acceptedAt} IS NULL`));
  const limits = { ...limitsFor(c.get("auth").org.plan), ...c.get("auth").org.planLimits };
  return c.json({ members, invites: pending.map(({ token: _t, ...i }) => i), seats: { used: members.length, limit: limits.seats } });
});
toolRoutes.post("/team/invite", requireUser, zValidator("json", z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") })), async (c) => {
  const a = c.get("auth");
  if (!["owner", "admin"].includes(a.user!.role)) throw forbidden("Only owners/admins can invite");
  const { db } = getDb();
  const limits = { ...limitsFor(a.org.plan), ...a.org.planLimits };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.orgId, a.org.id));
  if (n >= limits.seats) throw badRequest(`Seat limit reached (${limits.seats}). Upgrade the plan to add more.`);
  const b = c.req.valid("json");
  const token = randomToken(24);
  const [inv] = await db.insert(invites).values({ orgId: a.org.id, email: b.email.toLowerCase(), role: b.role, token, invitedBy: a.user!.id }).returning();
  const link = `${env.appUrl}/join?token=${token}`;
  await sendMail(null, { from: env.mailFrom, to: b.email, subject: `${a.user!.name || a.user!.email} invited you to ${a.org.name} on GetLeads`, text: `Join ${a.org.name} on GetLeads: ${link}` });
  return c.json({ id: inv.id, email: inv.email, role: inv.role, link }, 201);
});
toolRoutes.delete("/team/:userId", requireUser, async (c) => {
  const a = c.get("auth");
  if (a.user!.role !== "owner") throw forbidden("Only the owner can remove members");
  if (a.user!.id === c.req.param("userId")) throw badRequest("Cannot remove yourself");
  const { db } = getDb();
  await db.delete(users).where(and(eq(users.id, c.req.param("userId")), eq(users.orgId, a.org.id)));
  return c.json({ ok: true });
});

// ── Autopilot ──
const apInput = z.object({ name: z.string().min(1), query: z.record(z.unknown()), icpId: z.string().uuid().optional(), listId: z.string().uuid().optional(), campaignId: z.string().uuid().optional(), dailyLeads: z.number().int().min(1).max(200).default(10), minScore: z.number().int().min(0).max(100).default(60), requireValidEmail: z.boolean().default(true), autoEnroll: z.boolean().default(false), active: z.boolean().default(true), runHourUtc: z.number().int().min(0).max(23).default(3) });
toolRoutes.get("/autopilots", async (c) => {
  const { db } = getDb();
  return c.json({ autopilots: await db.select().from(autopilots).where(eq(autopilots.orgId, orgId(c))).orderBy(desc(autopilots.createdAt)) });
});
toolRoutes.post("/autopilots", zValidator("json", apInput), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(autopilots).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  return c.json(row, 201);
});
toolRoutes.patch("/autopilots/:id", zValidator("json", apInput.partial()), async (c) => {
  const { db } = getDb();
  const [row] = await db.update(autopilots).set(c.req.valid("json")).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Autopilot");
  return c.json(row);
});
toolRoutes.delete("/autopilots/:id", async (c) => {
  const { db } = getDb();
  await db.delete(autopilots).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c))));
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
  const [row] = await db.update(leads).set({ status: b.status, ...(b.ownerUserId ? { ownerUserId: b.ownerUserId } : {}), updatedAt: new Date() }).where(and(eq(leads.id, c.req.param("id")), eq(leads.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Lead");
  await emitEvent(row.orgId, "lead.status_changed", { leadId: row.id, status: b.status }, { type: "lead", id: row.id });
  return c.json(row);
});

// ── Public: accept invite (mounted separately without auth) ──
export const joinRoutes = new Hono();
joinRoutes.post("/join", zValidator("json", z.object({ token: z.string(), password: z.string().min(8), name: z.string().optional() })), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  const inv = await db.query.invites.findFirst({ where: eq(invites.token, b.token) });
  if (!inv || inv.acceptedAt) return c.json({ error: { code: "invalid_invite", message: "Invite is invalid or already used" } }, 400);
  const existing = await db.query.users.findFirst({ where: eq(users.email, inv.email) });
  if (existing) return c.json({ error: { code: "exists", message: "An account with this email already exists" } }, 400);
  const [user] = await db.insert(users).values({ orgId: inv.orgId, email: inv.email, passwordHash: await hashPassword(b.password), name: b.name ?? "", role: inv.role, lastLoginAt: new Date() }).returning();
  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
  return c.json({ token: await issueJwt(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export { listLeads, campaignContacts };
