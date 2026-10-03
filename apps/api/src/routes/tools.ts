/**
 * Enrichment tools that mirror the Prospex.ai catalog:
 * LinkedIn URL → email, email → LinkedIn, colleagues, decision makers, batch enrich, domain health, saved searches, tasks, team, autopilot.
 */
import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { effectiveLimits } from "@prospex/db";
import { and, or, autopilots, campaignContacts, campaigns, clients, companies, consume, desc, enqueue, eq, getDb, icps, inArray, invites, leads, limitsFor, listLeads, lists, remainingPremiumBudget, savedSearches, sql, tasks, users, organizations, type Invite } from "@prospex/db";
import { checkDomainHealth, enrichWithProviders, extractDomain, findEmail, findLinkedinUrl, findPeople, pMap, redact, resolveCompanyDomain, resolveLinkedinUrl, verifyEmail, detectHiring, companyNews } from "@prospex/core";
import { env } from "../env.js";
import { hashPassword, issueJwt, passwordProblem } from "../lib/auth.js";
import { randomToken } from "../lib/crypto.js";
import { hashLinkToken } from "../lib/linkTokens.js";
import { requireVerifiedEmail, sendVerificationEmailWithin } from "../lib/emailVerification.js";
import { ApiError, badRequest, forbidden, notFound, requireSomeFields } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";
import { sendMail } from "../lib/mailer.js";
import { orgId, rateLimit, requireAuth, requireUser, type Env } from "../middleware.js";
import { companyDomainOrNull, findExistingLead, upsertCompany, upsertLead } from "../services/leads.js";
import { advanceContact } from "../services/campaigns.js";
import { runAutopilot } from "../services/autopilot.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";
import { audit } from "../lib/audit.js";
import { emailField } from "../lib/fields.js";
import { storedSearchQuerySchema } from "../lib/searchQuery.js";
import { safeHeaderText } from "../lib/sanitize.js";
import { enforceWindows } from "../lib/rateWindow.js";
import { orgMemberEmail } from "../lib/members.js";
import { roleGate } from "../lib/roles.js";

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

/**
 * Fields that explain HOW an answer was reached, for whoever is debugging a lookup: which
 * verifiers were tried, the name guessed from a URL slug, where a name came from, a
 * provider's raw payload. They were part of every tool response, and the Tools page prints
 * a row's keys as column headers - so customers saw VERIFIERATTEMPTS and GUESSEDNAME columns
 * full of `[]` and `null`. Left out unless the caller asks with `?debug=1`.
 */
const DIAGNOSTIC_FIELDS = new Set(["verifierAttempts", "guessedName", "nameSource", "raw"]);
const wantsDebug = (c: import("hono").Context<Env>) => ["1", "true"].includes(String(c.req.query("debug") ?? "").toLowerCase());

/** `value` without its diagnostic fields, on the row itself and one object level down (a row's `person`, `company`). */
function withoutDiagnostics<T>(value: T, depth = 0): T {
  if (Array.isArray(value)) return value.map((v) => withoutDiagnostics(v, depth)) as unknown as T;
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DIAGNOSTIC_FIELDS.has(k)) continue;
    out[k] = depth < 1 && v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? withoutDiagnostics(v, depth + 1) : v;
  }
  return out as T;
}
/** A tool's result rows as the caller should see them. */
const shown = <T>(c: import("hono").Context<Env>, rows: T): T => (wantsDebug(c) ? rows : withoutDiagnostics(rows));

/** LinkedIn URL(s) → person + work email. */
toolRoutes.post("/linkedin-to-email", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ urls: z.array(z.string().max(500)).min(1).max(25), save: z.boolean().default(false) })), async (c) => {
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
  return c.json({ results: shown(c, results), saveStopped, skipped: saveStopped ? "quota" : undefined, counts: { requested: b.urls.length, found, notFound: b.urls.length - found, saved, skipped } });
});

/** "Jane van Doe" -> first "Jane", last "van Doe". */
function splitFullName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

/** Email(s) → LinkedIn URL + name/title. */
toolRoutes.post("/email-to-linkedin", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ emails: z.array(emailField).min(1).max(25) })), async (c) => {
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
  return c.json({ results: shown(c, results) });
});

/** Colleagues of a lead (same company, optional titles). */
toolRoutes.post("/colleagues", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ leadId: z.string().uuid().optional(), companyDomain: z.string().max(300).optional(), titles: z.array(z.string().max(200)).max(25).optional(), limit: z.number().int().min(1).max(25).default(10), save: z.boolean().default(false) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  let domain = b.companyDomain ? extractDomain(b.companyDomain) : null;
  let name: string | undefined;
  if (b.leadId) {
    const l = await db.query.leads.findFirst({ where: and(eq(leads.id, b.leadId), eq(leads.orgId, oid)) });
    const co = l?.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, l.companyId), eq(companies.orgId, oid)) }) : null;
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
  return c.json({ company: { name, domain }, people: shown(c, people), savedLeadIds: saved, stopped });
});

/** Decision makers at a company by persona. */
toolRoutes.post("/decision-makers", rateLimit({ perMinute: 30 }), zValidator("json", z.object({ companyDomain: z.string().max(300).optional(), companyName: z.string().max(200).optional(), personas: z.array(z.string().max(200)).max(25).default(["CEO / Founder", "Sales leader", "CMO / Marketing"]), limit: z.number().int().min(1).max(20).default(6), findEmails: z.boolean().default(true), save: z.boolean().default(true) })), async (c) => {
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
  return c.json({ company: { name, domain }, people: shown(c, out), skipped: skipped ?? undefined, saveStopped: saveStopped ?? undefined });
});

/** Company intelligence: hiring + recent news signals + firmographics, persisted. */
toolRoutes.post("/company-intel", rateLimit({ perMinute: 20 }), zValidator("json", z.object({ domain: z.string().max(300) })), async (c) => {
  const oid = orgId(c);
  // A public company domain only: this crawls it, and writes what it finds to the company.
  const domain = companyDomainOrNull(c.req.valid("json").domain);
  if (!domain) throw badRequest("Invalid domain");
  const { db } = getDb();
  let company = await db.query.companies.findFirst({ where: and(eq(companies.orgId, oid), eq(companies.domain, domain)) });
  if (!company || !company.enrichedAt) {
    const { crawlCompanyWebsite } = await import("@prospex/core");
    const prof = await crawlCompanyWebsite(domain).catch(() => null);
    // The name comes from the company's own site, so it may replace a placeholder one.
    company = await upsertCompany(oid, domain, prof ?? {}, { rename: true });
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
  // Workspace-private: the name is this workspace's own (editable) company name.
  if (items.length) await storeSignals(items.filter((n) => n.type !== "news").map((n) => ({ ...n, companyName: company!.name ?? undefined })), oid);

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
  const { orgId: _org, raw: companyRaw, ...publicCompany } = company;
  // `raw` is everything the crawl kept (page text fragments, every address it saw). The one
  // part of it the result view shows is the company's social links, so that is what goes
  // out by default; the whole object is there with `?debug=1`.
  const socials = (companyRaw as { socials?: unknown } | null | undefined)?.socials;
  const rawShown = wantsDebug(c) ? companyRaw : socials && typeof socials === "object" ? { socials } : undefined;
  return c.json({
    company: { ...publicCompany, ...(rawShown !== undefined ? { raw: rawShown } : {}), openRoles: hiringOk ? hiring!.openRoles : company.openRoles, intentScore: scoreIsReal ? intent : company.intentScore },
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
toolRoutes.get("/domain-health", zValidator("query", z.object({ domain: z.string().max(300) })), async (c) => {
  const domain = extractDomain(c.req.valid("query").domain);
  if (!domain) throw badRequest("Invalid domain");
  return c.json(await checkDomainHealth(domain));
});

/** Batch verify + enrich a list of leads (or all unverified). */
toolRoutes.post("/batch-enrich", zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).optional(), listId: z.string().uuid().optional(), onlyMissingEmail: z.boolean().default(true), limit: z.number().int().min(1).max(2000).default(500) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  await assertOwned(lists, b.listId, oid, "List", c);
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
toolRoutes.post("/verify-batch", zValidator("json", z.object({ emails: z.array(z.string().max(320)).min(1).max(500) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const b = c.req.valid("json");
  await consume(db, oid, "verifications", b.emails.length);
  const results = await pMap(b.emails, (e) => verifyEmail(e, verifyOpts()), 6);
  const summary = results.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  return c.json({ results: shown(c, results), summary });
});

// ── Saved searches ──
toolRoutes.get("/saved-searches", async (c) => {
  const { db } = getDb();
  return c.json({ savedSearches: await db.select().from(savedSearches).where(eq(savedSearches.orgId, orgId(c))).orderBy(desc(savedSearches.createdAt)) });
});
/**
 * `query` is the search this will run, on a schedule, with nobody watching. It is validated
 * with the same schema as POST /v1/search (see lib/searchQuery.ts): the same ceilings, and
 * unknown keys dropped. It used to be `z.record(z.unknown())`, and the job spread it into
 * the pipeline as stored.
 */
toolRoutes.post("/saved-searches", zValidator("json", z.object({ name: z.string().min(1).max(200), query: storedSearchQuerySchema, alert: z.boolean().default(false), alertEmail: emailField.optional(), listId: z.string().uuid().optional(), clientId: z.string().uuid().optional() })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const { clientId, ...b } = c.req.valid("json");
  // Every id is checked against this workspace: the scheduled run writes into the list (and,
  // via the query, uses the ICP and client) by id alone, with no org predicate of its own.
  await assertOwned(lists, b.listId, oid, "List", c);
  const q = b.query;
  if (q.icpId) await assertOwned(icps, q.icpId, oid, "ICP", c);
  if (q.listId) await assertOwned(lists, q.listId, oid, "List", c);
  /**
   * Alerts go to people in this workspace.
   *
   * The alert is sent by Scout, from Scout's address, with the search's name in the subject.
   * `alertEmail` took any address, so a saved search named "URGENT: verify your account at
   * https://..." was a way to have the platform email a stranger that sentence. It must now
   * be the address of a member; with alerts on and no address given, it is the creator's.
   */
  let alertEmail: string | undefined = b.alertEmail;
  if (alertEmail) {
    const member = await orgMemberEmail(oid, alertEmail);
    if (!member) throw badRequest("Alerts can only be sent to a member of this workspace. Use the email address of someone on your team (invite them first if needed).");
    alertEmail = member;
  } else if (b.alert) {
    alertEmail = c.get("auth").user?.email?.toLowerCase();
  }
  // A saved search can run for a client. There is no column for it, so it travels in the
  // query - which is what the scheduled run reads - whether sent top-level or inside it.
  const cid = clientId ?? (typeof q.clientId === "string" ? q.clientId : undefined);
  if (cid) {
    const { requireClient } = await import("../services/clients.js");
    const client = await requireClient(oid, cid);
    if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before saving searches for it.");
  }
  const [row] = await db.insert(savedSearches).values({ orgId: oid, ...b, alertEmail, query: { ...b.query, ...(cid ? { clientId: cid } : {}) } }).returning();
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
  await assertOwned(leads, b.leadId, orgId(c), "Lead", c);
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

/**
 * What the inviter is told when the invite email did not go. The reason it did not is ours
 * (the platform's mail provider, or its configuration) and is logged; the provider's own
 * text - or a line naming server settings - is nothing a customer can act on, and the link
 * is right there to share by hand.
 */
const INVITE_EMAIL_NOT_SENT = "The email could not be sent from our side - copy the link below and share it yourself.";

/** Send (or re-send) an invite email. Reports whether it actually went, rather than assuming. */
async function sendInviteEmail(a: { orgName: string; inviter: string }, email: string, token: string) {
  const link = `${env.appUrl}/join?token=${token}`;
  // Both names are tenant-chosen text going into a platform email to an address the tenant
  // picked. Control characters and anything link-shaped are removed and the length capped,
  // so the subject cannot be made to read as (or link to) something else.
  const orgName = safeHeaderText(a.orgName, 80, "a workspace");
  const inviter = safeHeaderText(a.inviter, 80, "A teammate");
  const r = await sendMail(null, {
    from: env.mailFrom,
    to: email,
    subject: `${inviter} invited you to ${orgName} on Scout`,
    text: `${inviter} invited you to join ${orgName} on Scout.\n\nAccept the invite: ${link}\n\nThis link expires in 14 days.`,
  }).catch((e) => ({ ok: false, error: (e as Error).message }));
  if (!r.ok) console.warn(`[team] invite email could not be sent: ${redact(String(r.error ?? "unknown error"), { max: 300, maskEmails: true })}`);
  return { link, emailed: r.ok, emailError: r.ok ? undefined : INVITE_EMAIL_NOT_SENT };
}

/**
 * Invitation emails per hour: 20 from one workspace, 3 to one address (from anyone).
 *
 * Creating and re-sending an invite both send mail from the platform to an address the
 * workspace chose, and neither was limited: one invite re-sent 60 times was 60 emails to a
 * stranger. The per-address count is across all workspaces, so a fresh signup does not
 * reset it.
 */
const INVITE_WINDOW_MS = 3_600_000;
function limitInviteMail(orgIdValue: string, email: string) {
  enforceWindows(
    [
      { key: `invite:org:${orgIdValue}`, limit: 20, message: "This workspace has sent 20 invitation emails in the last hour. Wait a while before sending more." },
      { key: `invite:to:${email.toLowerCase()}`, limit: 3, message: "That address has already been sent 3 invitations in the last hour. Share the invite link with them directly, or try again later." },
    ],
    INVITE_WINDOW_MS,
  );
}

toolRoutes.get("/team", requireUser, async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const members = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.orgId, oid));
  // Revoked and accepted invites are history; expired ones are still listed (marked) so they
  // can be re-sent rather than silently vanishing.
  const pending = await db.select().from(invites).where(and(eq(invites.orgId, oid), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`)).orderBy(desc(invites.createdAt));
  const limits = effectiveLimits(c.get("auth").org);
  const now = Date.now();
  // Named fields only. An invite link is shown once, when it is created or re-sent: the list
  // carries neither the link nor anything it could be rebuilt from (no token, no token hash),
  // and a column added to the table later does not appear here by accident.
  const shaped = pending.map((i) => ({ id: i.id, email: i.email, role: i.role, invitedBy: i.invitedBy, createdAt: i.createdAt, expiresAt: inviteExpiry(i), expired: inviteExpiry(i).getTime() <= now }));
  return c.json({ members, invites: shaped, seats: { used: members.length, pending: shaped.filter((i) => !i.expired).length, limit: limits.seats } });
});
toolRoutes.post("/team/invite", requireUser, roleGate("team.invited", "owner", "admin"), zValidator("json", z.object({ email: emailField, role: z.enum(["admin", "member"]).default("member") })), async (c) => {
  const a = c.get("auth");
  if (!["owner", "admin"].includes(a.user!.role)) throw forbidden("Only owners/admins can invite");
  // An invitation is mail from the platform to an address the caller chose. An account that
  // has not confirmed its own address yet does not get to send it.
  await requireVerifiedEmail(c);
  const { db } = getDb();
  const b = c.req.valid("json");
  const email = b.email;
  const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existingUser) {
    throw new ApiError(409, existingUser.orgId === a.org.id ? `${email} is already a member of this workspace.` : `${email} already has a Scout account in another workspace, so it cannot be invited here. They would need to use a different email address.`, "already_registered");
  }
  const dupe = await db.query.invites.findFirst({ where: and(eq(invites.orgId, a.org.id), eq(invites.email, email), ACTIVE_INVITE) });
  if (dupe) throw new ApiError(409, `${email} already has a pending invite. Re-send it from the team list instead.`, "already_invited");
  const limits = effectiveLimits(a.org);
  const seats = await seatUsage(a.org.id);
  if (limits.seats > 0 && seats.members + seats.pending >= limits.seats) {
    throw badRequest(`Seat limit reached (${limits.seats}: ${seats.members} ${seats.members === 1 ? "member" : "members"} and ${seats.pending} pending ${seats.pending === 1 ? "invite" : "invites"}). Revoke a pending invite or upgrade the plan to add more.`);
  }
  // Checked last, so only an invite that is actually about to be sent uses the allowance.
  limitInviteMail(a.org.id, email);
  // Only the hash of the token is stored: the link exists in this response and in the email,
  // and a copy of the invites table is not a list of working links.
  const token = randomToken(24);
  const [inv] = await db.insert(invites).values({ orgId: a.org.id, email, role: b.role, token: null, tokenHash: hashLinkToken(token), invitedBy: a.user!.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).returning();
  // sendMail answers { ok: false } rather than throwing; that used to be ignored, so the UI
  // said "Invite sent" for mail that never left. The link is returned either way so it can
  // be shared by hand.
  const sent = await sendInviteEmail({ orgName: a.org.name, inviter: a.user!.name || a.user!.email }, email, token);
  await audit(c, "team.invited", { targetType: "invite", targetId: inv.id, data: { email, role: inv.role, emailed: sent.emailed } });
  return c.json({ id: inv.id, email: inv.email, role: inv.role, link: sent.link, expiresAt: inv.expiresAt, emailed: sent.emailed, emailError: sent.emailError }, 201);
});

/** Revoke a pending invite: its link stops working and its seat is freed. */
async function revokeInvite(c: import("hono").Context<Env>) {
  const { db } = getDb();
  const [row] = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, c.req.param("id")!), eq(invites.orgId, orgId(c)), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`))
    .returning({ id: invites.id, email: invites.email });
  if (!row) throw notFound("Pending invite");
  await audit(c, "team.invite_revoked", { targetType: "invite", targetId: row.id, data: { email: row.email } });
  return c.json({ ok: true, id: row.id });
}

/**
 * Re-send a pending invite, renewing its 14 days.
 *
 * A NEW link every time: the token is not stored, so the old link cannot be sent again -
 * and should not be, since "re-send" is also what someone does when the first email went to
 * the wrong place. The previous link stops working the moment this one is issued.
 */
async function resendInvite(c: import("hono").Context<Env>) {
  const a = c.get("auth");
  await requireVerifiedEmail(c);
  const { db } = getDb();
  const inv = await db.query.invites.findFirst({ where: and(eq(invites.id, c.req.param("id")!), eq(invites.orgId, a.org.id), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`) });
  if (!inv) throw notFound("Pending invite");
  // An expired invite no longer holds a seat, so renewing one has to fit under the limit.
  if (inviteExpiry(inv).getTime() <= Date.now()) {
    const limits = effectiveLimits(a.org);
    const seats = await seatUsage(a.org.id);
    if (limits.seats > 0 && seats.members + seats.pending >= limits.seats) throw badRequest(`Seat limit reached (${limits.seats}). Revoke another invite or upgrade the plan first.`);
  }
  limitInviteMail(a.org.id, inv.email);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const token = randomToken(24);
  // Still pending at the moment of writing: an invite accepted or revoked in between is not
  // handed a fresh link.
  const renewed = await db
    .update(invites)
    .set({ expiresAt, token: null, tokenHash: hashLinkToken(token) })
    .where(and(eq(invites.id, inv.id), eq(invites.orgId, a.org.id), sql`${invites.acceptedAt} IS NULL`, sql`${invites.revokedAt} IS NULL`))
    .returning({ id: invites.id });
  if (!renewed.length) throw notFound("Pending invite");
  const sent = await sendInviteEmail({ orgName: a.org.name, inviter: a.user?.name || a.user?.email || a.org.name }, inv.email, token);
  await audit(c, "team.invite_resent", { targetType: "invite", targetId: inv.id, data: { email: inv.email, emailed: sent.emailed } });
  return c.json({ id: inv.id, email: inv.email, link: sent.link, expiresAt, emailed: sent.emailed, emailError: sent.emailError });
}

// Registered before /team/:userId. Different segment counts, so no capture today - but a
// static path above a param path is the rule this codebase now follows everywhere.
toolRoutes.delete("/team/invites/:id", requireUser, roleGate("team.invite_revoked", "owner", "admin"), revokeInvite);
toolRoutes.post("/team/invites/:id/resend", requireUser, roleGate("team.invite_resent", "owner", "admin"), resendInvite);
// Short aliases.
toolRoutes.delete("/invites/:id", requireUser, roleGate("team.invite_revoked", "owner", "admin"), revokeInvite);
toolRoutes.post("/invites/:id/resend", requireUser, roleGate("team.invite_resent", "owner", "admin"), resendInvite);

toolRoutes.delete("/team/:userId", requireUser, async (c) => {
  const a = c.get("auth");
  if (a.user!.role !== "owner") {
    await audit(c, "team.member_removed", { result: "denied", targetType: "user", targetId: c.req.param("userId").slice(0, 64), data: { reason: "role", role: a.user!.role } });
    throw forbidden("Only the owner can remove members");
  }
  if (a.user!.id === c.req.param("userId")) throw badRequest("Cannot remove yourself");
  const { db } = getDb();
  const gone = await db.delete(users).where(and(eq(users.id, c.req.param("userId")), eq(users.orgId, a.org.id))).returning({ id: users.id, email: users.email, role: users.role });
  if (!gone.length) throw notFound("Member");
  await audit(c, "team.member_removed", { targetType: "user", targetId: gone[0].id, data: { email: gone[0].email, role: gone[0].role } });
  return c.json({ ok: true });
});

// ── Autopilot ──
// References are nullable: GET returns null for an unset one, and PATCH null detaches it.
// `query` runs unattended every night: validated like POST /v1/search (lib/searchQuery.ts).
const apInput = z.object({ name: z.string().min(1).max(200), query: storedSearchQuerySchema, icpId: z.string().uuid().nullish(), listId: z.string().uuid().nullish(), campaignId: z.string().uuid().nullish(), dailyLeads: z.number().int().min(1).max(200).default(10), minScore: z.number().int().min(0).max(100).default(60), requireValidEmail: z.boolean().default(true), autoEnroll: z.boolean().default(false), active: z.boolean().default(true), runHourUtc: z.number().int().min(0).max(23).default(3) });
toolRoutes.get("/autopilots", async (c) => {
  const { db } = getDb();
  return c.json({ autopilots: await db.select().from(autopilots).where(eq(autopilots.orgId, orgId(c))).orderBy(desc(autopilots.createdAt)) });
});
/**
 * An autopilot scores against its ICP, saves into its list and enrolls into its campaign by
 * id, every night, with no org predicate in the job. Each id must belong to this workspace -
 * a foreign campaign id would have enrolled our leads into someone else's sequence.
 */
async function assertAutopilotRefs(c: import("hono").Context<Env>, oid: string, b: { icpId?: string | null; listId?: string | null; campaignId?: string | null; query?: { clientId?: string; icpId?: string; listId?: string } }) {
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  await assertOwned(lists, b.listId, oid, "List", c);
  await assertOwned(campaigns, b.campaignId, oid, "Campaign", c);
  await assertOwned(clients, b.query?.clientId, oid, "Client", c);
  await assertOwned(icps, b.query?.icpId, oid, "ICP", c);
  await assertOwned(lists, b.query?.listId, oid, "List", c);
}
toolRoutes.post("/autopilots", zValidator("json", apInput), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertAutopilotRefs(c, orgId(c), b);
  const [row] = await db.insert(autopilots).values({ orgId: orgId(c), ...b }).returning();
  await audit(c, "autopilot.created", { targetType: "autopilot", targetId: row.id, data: { name: row.name, dailyLeads: row.dailyLeads, autoEnroll: row.autoEnroll, campaignId: row.campaignId } });
  return c.json(row, 201);
});
toolRoutes.patch("/autopilots/:id", zValidator("json", apInput.partial()), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  requireSomeFields(b);
  await assertAutopilotRefs(c, orgId(c), b);
  const [row] = await db.update(autopilots).set(b).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Autopilot");
  return c.json(row);
});
toolRoutes.delete("/autopilots/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(autopilots).where(and(eq(autopilots.id, c.req.param("id")), eq(autopilots.orgId, orgId(c)))).returning({ id: autopilots.id, name: autopilots.name });
  if (!gone.length) throw notFound("Autopilot");
  await audit(c, "autopilot.deleted", { targetType: "autopilot", targetId: gone[0].id, data: { name: gone[0].name } });
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
  await assertOwned(users, b.ownerUserId, orgId(c), "User", c);
  const [row] = await db.update(leads).set({ status: b.status, ...(b.ownerUserId ? { ownerUserId: b.ownerUserId } : {}), updatedAt: new Date() }).where(and(eq(leads.id, c.req.param("id")), eq(leads.orgId, orgId(c)))).returning();
  if (!row) throw notFound("Lead");
  await emitEvent(row.orgId, "lead.status_changed", { leadId: row.id, status: b.status }, { type: "lead", id: row.id });
  return c.json(row);
});

// ── Public: accept invite (mounted separately without auth) ──
export const joinRoutes = new Hono();
joinRoutes.post("/join", rateLimit({ perMinute: 10 }), zValidator("json", z.object({ token: z.string().max(200), password: z.string().min(8).max(200), name: z.string().max(80).optional() })), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  // Looked up by the hash of the token. The second arm is for an invite the previous release
  // created while both were running (plaintext token, no hash yet); the boot-time task gives
  // those their hash, after which only the first arm ever matches.
  const inv = b.token ? await db.query.invites.findFirst({ where: or(eq(invites.tokenHash, hashLinkToken(b.token)), and(sql`${invites.tokenHash} IS NULL`, eq(invites.token, b.token))) }) : undefined;
  if (!inv || inv.acceptedAt) return c.json({ error: { code: "invalid_invite", message: "Invite is invalid or already used" } }, 400);
  if (inv.revokedAt) return c.json({ error: { code: "invite_revoked", message: "This invite was cancelled by the workspace. Ask them to send a new one." } }, 400);
  if (inviteExpiry(inv).getTime() <= Date.now()) return c.json({ error: { code: "invite_expired", message: "This invite has expired. Ask the workspace to re-send it." } }, 400);
  const existing = await db.query.users.findFirst({ where: eq(users.email, inv.email) });
  if (existing) return c.json({ error: { code: "exists", message: "An account with this email already exists" } }, 400);
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, inv.orgId) });
  if (!org || org.status === "deactivated" || org.status === "revoked") return c.json({ error: { code: "account_suspended", message: "This workspace is suspended, so its invites cannot be accepted." } }, 403);
  // Seats are re-checked at the moment of joining. This invite's own seat is already counted
  // among the pending ones, so it is the members alone that must still leave room for it.
  const weak = passwordProblem(b.password, { email: inv.email, name: b.name });
  if (weak) return c.json({ error: { code: "weak_password", message: weak } }, 400);
  const limits = effectiveLimits(org);
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(users).where(eq(users.orgId, org.id));
  if (limits.seats > 0 && m >= limits.seats) return c.json({ error: { code: "seat_limit", message: `${org.name} has no free seats (${limits.seats}). Ask an owner to upgrade or free a seat.` } }, 400);
  const [user] = await db.insert(users).values({ orgId: inv.orgId, email: inv.email, passwordHash: await hashPassword(b.password), name: b.name ?? "", role: inv.role, lastLoginAt: new Date() }).returning();
  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
  // A new account, so it gets the same "confirm your address" email a signup gets. Accepting
  // an invite does not prove the mailbox (the link is also shown to the inviter). Nothing is
  // sent when the platform has no mail provider, and this never delays or fails the join.
  await sendVerificationEmailWithin(user).catch(() => ({ emailed: false }));
  await audit(c, "team.joined", { orgId: inv.orgId, actorType: "user", actorUserId: user.id, targetType: "invite", targetId: inv.id, data: { email: user.email, role: user.role, invitedBy: inv.invitedBy } });
  return c.json({ token: await issueJwt(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export { listLeads, campaignContacts };
