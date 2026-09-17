import { and, autopilots, campaigns, companies, consume, consumeLead, enqueue, eq, events, getDb, icps, integrations, jobs, leads, monitors, remainingPremiumBudget, savedSearches, searches, signalSubscriptions, visibilityPrompts, webhooks, sql as dsql, type JobHandler } from "@prospex/db";
import { buildIcpWithAi, crawlCompanyWebsite, createAiProvider, findEmail, runLeadPipeline, scoreLeadRules, verifyEmail, type CompanyProfile, type IcpCriteria } from "@prospex/core";
import { env } from "./env.js";
import { hmacSign } from "./lib/crypto.js";
import { pipelineLeadToInput, upsertCompany, upsertLead } from "./services/leads.js";
import { knownBrands, runVisibilityPrompt } from "./services/visibility.js";
import { sendStep, tickCampaign } from "./services/campaigns.js";
import { syncLead } from "./services/integrations.js";
import { emitEvent } from "./lib/events.js";
import { identifyVisit } from "./services/visitors.js";
import { refreshCompanySignals, runSubscription } from "./services/signals.js";
import { runMonitor } from "./services/monitors.js";
import { runAutopilot } from "./services/autopilot.js";
import { sendMail } from "./lib/mailer.js";

const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });

export const handlers: Record<string, JobHandler> = {
  /** Run a lead search end-to-end and persist results. payload: { searchId, query, icpId?, listId? } */
  "search.run": async (job, ctx) => {
    const { db } = ctx;
    const orgId = job.orgId!;
    const searchId = String(job.payload.searchId);
    const query = job.payload.query as Parameters<typeof runLeadPipeline>[0];
    await db.update(searches).set({ status: "running" }).where(eq(searches.id, searchId));
    const icpId = job.payload.icpId ? String(job.payload.icpId) : null;
    const icp = icpId ? await db.query.icps.findFirst({ where: eq(icps.id, icpId) }) : null;
    try {
      const providerBudget = await remainingPremiumBudget(db, orgId);
      const results = await runLeadPipeline(query, {
        ai: createAiProvider(),
        verify: verifyOpts(),
        icp: (icp?.criteria as IcpCriteria | undefined) ?? undefined,
        maxProviderLeads: providerBudget,
        onProgress: (pct, msg) => {
          ctx.log(`${pct}% ${msg}`);
          void ctx.progress(pct);
        },
      });
      let created = 0;
      const ids: string[] = [];
      for (const r of results) {
        try {
          await consumeLead(db, orgId, r.source);
        } catch (e) {
          ctx.log(`quota hit: ${(e as Error).message}`);
          break;
        }
        const { lead, created: c } = await upsertLead(orgId, pipelineLeadToInput(r, { icpId, source: r.source, tags: [`search:${searchId.slice(0, 8)}`] }));
        if (c) created++;
        ids.push(lead.id);
      }
      if (job.payload.listId && ids.length) {
        const { listLeads } = await import("@prospex/db");
        for (const leadId of ids) await db.insert(listLeads).values({ listId: String(job.payload.listId), leadId }).onConflictDoNothing();
      }
      await db.update(searches).set({ status: "done", resultCount: ids.length, completedAt: new Date() }).where(eq(searches.id, searchId));
      await emitEvent(orgId, "search.completed", { searchId, results: ids.length, created }, { type: "search", id: searchId });
      return { results: ids.length, created, leadIds: ids };
    } catch (e) {
      await db.update(searches).set({ status: "failed", error: (e as Error).message, completedAt: new Date() }).where(eq(searches.id, searchId));
      throw e;
    }
  },

  /** Enrich one lead: crawl company site, find + verify email, rescore. payload: { leadId } */
  "lead.enrich": async (job, ctx) => {
    const { db } = ctx;
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)) });
    if (!lead) return { skipped: "missing" };
    let company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
    let profile: CompanyProfile | null = null;
    if (company && (!company.enrichedAt || Date.now() - company.enrichedAt.getTime() > 30 * 86_400_000)) {
      profile = await crawlCompanyWebsite(company.domain).catch(() => null);
      if (profile) company = await upsertCompany(lead.orgId, company.domain, { ...profile, name: profile.name ?? company.name ?? undefined });
    }
    const patch: Record<string, unknown> = {};
    const knownPattern = company?.emailPattern ?? undefined;
    if (!lead.email && company && lead.firstName && lead.lastName) {
      await consume(db, lead.orgId, "verifications", 1);
      const r = await findEmail({ firstName: lead.firstName, lastName: lead.lastName, domain: company.domain, knownPattern, knownEmails: (company.raw as { emailsFound?: string[] })?.emailsFound }, verifyOpts());
      if (r.email) Object.assign(patch, { email: r.email, emailStatus: r.status, emailConfidence: r.confidence, verifiedAt: new Date() });
      if (r.pattern && !company.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, company.id));
    } else if (lead.email && lead.emailStatus === "unknown") {
      await consume(db, lead.orgId, "verifications", 1);
      const v = await verifyEmail(lead.email, verifyOpts());
      Object.assign(patch, { emailStatus: v.status, emailConfidence: v.confidence, verifiedAt: new Date() });
    }
    const icp = lead.icpId ? await db.query.icps.findFirst({ where: eq(icps.id, lead.icpId) }) : null;
    if (icp) {
      const s = scoreLeadRules({ title: lead.title, location: lead.location, country: lead.country, emailStatus: String(patch.emailStatus ?? lead.emailStatus), company }, icp.criteria as IcpCriteria);
      Object.assign(patch, { score: s.score, scoreReasons: s.reasons });
    }
    await db.update(leads).set({ ...patch, enrichedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id));
    await emitEvent(lead.orgId, "lead.enriched", { leadId: lead.id, ...patch }, { type: "lead", id: lead.id });
    return patch;
  },

  /** Verify a lead's email. payload: { leadId } */
  "lead.verify": async (job, ctx) => {
    const { db } = ctx;
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)) });
    if (!lead?.email) return { skipped: "no email" };
    await consume(db, lead.orgId, "verifications", 1);
    const v = await verifyEmail(lead.email, verifyOpts());
    await db.update(leads).set({ emailStatus: v.status, emailConfidence: v.confidence, verifiedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id));
    await emitEvent(lead.orgId, "lead.verified", { leadId: lead.id, email: lead.email, status: v.status, confidence: v.confidence }, { type: "lead", id: lead.id });
    return { status: v.status, confidence: v.confidence };
  },

  /** Build AI ICP profile from description + seed domains. payload: { icpId } */
  "icp.build": async (job, ctx) => {
    const { db } = ctx;
    const icp = await db.query.icps.findFirst({ where: eq(icps.id, String(job.payload.icpId)) });
    if (!icp) return { skipped: "missing" };
    const seeds: { domain: string; name?: string; description?: string; industry?: string }[] = [];
    for (const d of icp.seedDomains.slice(0, 5)) {
      const p = await crawlCompanyWebsite(d, { maxPages: 2 }).catch(() => null);
      if (p) {
        await upsertCompany(icp.orgId, d, p);
        seeds.push({ domain: d, name: p.name, description: p.description });
      } else seeds.push({ domain: d });
    }
    const profile = await buildIcpWithAi(createAiProvider(), { description: icp.description ?? undefined, seedCompanies: seeds, product: String(job.payload.product ?? "") });
    if (!profile) return { skipped: "no AI provider configured" };
    const merged: IcpCriteria = {
      ...(icp.criteria as IcpCriteria),
      industries: (icp.criteria as IcpCriteria).industries?.length ? (icp.criteria as IcpCriteria).industries : profile.industries,
      titles: (icp.criteria as IcpCriteria).titles?.length ? (icp.criteria as IcpCriteria).titles : profile.titles,
      seniorities: (icp.criteria as IcpCriteria).seniorities?.length ? (icp.criteria as IcpCriteria).seniorities : profile.seniorities,
      companySizes: (icp.criteria as IcpCriteria).companySizes?.length ? (icp.criteria as IcpCriteria).companySizes : profile.companySizes,
      locations: (icp.criteria as IcpCriteria).locations?.length ? (icp.criteria as IcpCriteria).locations : profile.locations,
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
    };
    await db.update(icps).set({ criteria: merged, aiProfile: profile as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(icps.id, icp.id));
    return { profile };
  },

  /** Scheduler: tick every active campaign. Self-reschedules every 60s. */
  "campaign.tick": async (job, ctx) => {
    const { db } = ctx;
    const active = await db.select().from(campaigns).where(eq(campaigns.status, "active"));
    const out: Record<string, unknown> = {};
    for (const c of active) out[c.id] = await tickCampaign(c.id).catch((e) => ({ error: (e as Error).message }));
    if (job.payload.recurring) await enqueue(db, "campaign.tick", { recurring: true }, { runAt: new Date(Date.now() + 60_000), maxAttempts: 1 });
    return out;
  },

  "message.send": async (job) => sendStep(String(job.payload.campaignId), String(job.payload.contactId), String(job.payload.stepId)),

  /** Deliver one event to one webhook with HMAC signature. */
  "webhook.deliver": async (job, ctx) => {
    const { db } = ctx;
    const hook = await db.query.webhooks.findFirst({ where: eq(webhooks.id, String(job.payload.webhookId)) });
    const ev = await db.query.events.findFirst({ where: eq(events.id, String(job.payload.eventId)) });
    if (!hook || !ev || !hook.active) return { skipped: true };
    const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.data, entity: { type: ev.entityType, id: ev.entityId } });
    const ts = String(Date.now());
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prospex-signature": hmacSign(hook.secret, `${ts}.${body}`), "x-prospex-timestamp": ts, "x-prospex-event": ev.type },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => ({ ok: false, status: 0, statusText: (e as Error).message }));
    if (!res.ok) {
      const failures = hook.failures + 1;
      await db.update(webhooks).set({ failures, active: failures < 20 }).where(eq(webhooks.id, hook.id));
      throw new Error(`webhook ${hook.url} → ${res.status} ${res.statusText}`);
    }
    if (hook.failures) await db.update(webhooks).set({ failures: 0 }).where(eq(webhooks.id, hook.id));
    return { status: res.status };
  },

  /** Push a lead to a CRM integration. payload: { integrationId, leadId } */
  "integration.sync": async (job, ctx) => {
    const { db } = ctx;
    const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.id, String(job.payload.integrationId)), eq(integrations.status, "active")) });
    if (!integ) return { skipped: "integration missing/inactive" };
    const r = await syncLead(integ, String(job.payload.leadId));
    if (!r.ok) throw new Error(r.error ?? "sync failed");
    return r;
  },

  /** Bulk enqueue enrich for many leads. payload: { leadIds } */
  "leads.bulk_enrich": async (job, ctx) => {
    const ids = (job.payload.leadIds as string[]) ?? [];
    for (const id of ids) await enqueue(ctx.db, "lead.enrich", { leadId: id }, { orgId: job.orgId });
    return { enqueued: ids.length };
  },

  // ── v2 ──
  "visit.identify": async (job) => identifyVisit(String(job.payload.visitId), String(job.payload.ip), (job.payload.identify as Record<string, unknown> | null) ?? null),

  /** Enrich a company row (crawl + hiring + news). payload: { companyId } */
  "company.enrich": async (job, ctx) => {
    const { db } = ctx;
    const co = await db.query.companies.findFirst({ where: eq(companies.id, String(job.payload.companyId)) });
    if (!co) return { skipped: true };
    const prof = await crawlCompanyWebsite(co.domain, { maxPages: 4 }).catch(() => null);
    if (prof) await upsertCompany(co.orgId, co.domain, { ...prof, name: prof.name ?? co.name ?? undefined });
    const { detectHiring } = await import("@prospex/core");
    const h = await detectHiring(co.domain, prof?.name ?? co.name ?? undefined).catch(() => null);
    if (h) await db.update(companies).set({ openRoles: h.openRoles, hiring: { byFunction: h.byFunction, source: h.source, careersUrl: h.careersUrl } }).where(eq(companies.id, co.id));
    const n = await refreshCompanySignals(co.orgId, co.domain, prof?.name ?? co.name).catch(() => 0);
    return { crawled: !!prof, openRoles: h?.openRoles ?? 0, newSignals: n };
  },

  /** Run one signal subscription. payload: { subscriptionId } */
  "signals.subscription": async (job, ctx) => {
    const sub = await ctx.db.query.signalSubscriptions.findFirst({ where: eq(signalSubscriptions.id, String(job.payload.subscriptionId)) });
    if (!sub || !sub.active) return { skipped: true };
    return runSubscription(sub, ctx.log);
  },

  /** Scheduler: run all active subscriptions every 6h. */
  "signals.scan": async (job, ctx) => {
    const { db } = ctx;
    const subs = await db.select().from(signalSubscriptions).where(and(eq(signalSubscriptions.active, true), dsql`(${signalSubscriptions.lastRunAt} IS NULL OR ${signalSubscriptions.lastRunAt} < now() - interval '5 hours')`));
    for (const s of subs) await enqueue(db, "signals.subscription", { subscriptionId: s.id }, { orgId: s.orgId, priority: 1 });
    if (job.payload.recurring) await enqueue(db, "signals.scan", { recurring: true }, { runAt: new Date(Date.now() + 6 * 3600_000), maxAttempts: 1 });
    return { queued: subs.length };
  },

  "monitor.run": async (job, ctx) => {
    const m = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, String(job.payload.monitorId)) });
    if (!m || !m.active) return { skipped: true };
    return runMonitor(m, ctx.log);
  },

  /** Scheduler: run due monitors every 30 min. */
  "monitors.tick": async (job, ctx) => {
    const { db } = ctx;
    const due = await db.select().from(monitors).where(and(eq(monitors.active, true), dsql`(${monitors.lastRunAt} IS NULL OR ${monitors.lastRunAt} < now() - (${monitors.intervalMinutes} || ' minutes')::interval)`));
    for (const m of due) await enqueue(db, "monitor.run", { monitorId: m.id }, { orgId: m.orgId, priority: 1 });
    if (job.payload.recurring) await enqueue(db, "monitors.tick", { recurring: true }, { runAt: new Date(Date.now() + 30 * 60_000), maxAttempts: 1 });
    return { queued: due.length };
  },

  /**
   * Sample one tracked visibility prompt several times.
   *
   * Runs `samplesPerRun` times rather than once on purpose. One LLM answer is a sample,
   * not a measurement, and the whole product depends on having enough of them to put a
   * confidence interval around the result.
   */
  "visibility.run": async (job, ctx) => {
    const { db } = ctx;
    const prompt = await db.query.visibilityPrompts.findFirst({ where: eq(visibilityPrompts.id, String(job.payload.promptId)) });
    if (!prompt || !prompt.active) return { skipped: true };
    const others = await knownBrands(db, prompt.orgId);
    let usable = 0;
    for (let i = 0; i < prompt.samplesPerRun; i++) {
      const { run } = await runVisibilityPrompt(db, prompt.orgId, prompt, { others });
      if (run.usable) usable++;
    }
    return { samples: prompt.samplesPerRun, usable };
  },

  /** Scheduler: daily, sample every active visibility prompt not run in the last 20 hours. */
  "visibility.tick": async (job, ctx) => {
    const { db } = ctx;
    const due = await db
      .select()
      .from(visibilityPrompts)
      .where(and(eq(visibilityPrompts.active, true), dsql`(${visibilityPrompts.lastRunAt} IS NULL OR ${visibilityPrompts.lastRunAt} < now() - interval '20 hours')`));
    for (const p of due) await enqueue(db, "visibility.run", { promptId: p.id }, { orgId: p.orgId, priority: 3 });
    if (job.payload.recurring) await enqueue(db, "visibility.tick", { recurring: true }, { runAt: new Date(Date.now() + 3600_000), maxAttempts: 1 });
    return { queued: due.length };
  },

  "autopilot.run": async (job, ctx) => {
    const ap = await ctx.db.query.autopilots.findFirst({ where: eq(autopilots.id, String(job.payload.autopilotId)) });
    if (!ap || !ap.active) return { skipped: true };
    return runAutopilot(ap, ctx.log);
  },

  /** Scheduler: hourly, run autopilots whose hour matches and haven't run today. */
  "autopilots.tick": async (job, ctx) => {
    const { db } = ctx;
    const hour = new Date().getUTCHours();
    const due = await db.select().from(autopilots).where(and(eq(autopilots.active, true), eq(autopilots.runHourUtc, hour), dsql`(${autopilots.lastRunAt} IS NULL OR ${autopilots.lastRunAt} < now() - interval '20 hours')`));
    for (const ap of due) await enqueue(db, "autopilot.run", { autopilotId: ap.id }, { orgId: ap.orgId, priority: 1 });
    // saved-search alerts run daily at 02:00 UTC
    if (hour === 2) {
      const ss = await db.select().from(savedSearches).where(and(eq(savedSearches.alert, true), dsql`(${savedSearches.lastRunAt} IS NULL OR ${savedSearches.lastRunAt} < now() - interval '20 hours')`));
      for (const s of ss) await enqueue(db, "savedsearch.run", { savedSearchId: s.id }, { orgId: s.orgId, priority: 1 });
    }
    if (job.payload.recurring) await enqueue(db, "autopilots.tick", { recurring: true }, { runAt: new Date(Date.now() + 3600_000), maxAttempts: 1 });
    return { queued: due.length };
  },

  /** Re-run a saved search, add new leads to its list, email a digest if alerting. payload: { savedSearchId } */
  "savedsearch.run": async (job, ctx) => {
    const { db } = ctx;
    const ss = await db.query.savedSearches.findFirst({ where: eq(savedSearches.id, String(job.payload.savedSearchId)) });
    if (!ss) return { skipped: true };
    const ok = await consume(db, ss.orgId, "searches", 1).then(() => true, () => false);
    if (!ok) return { skipped: "quota" };
    const providerBudget = await remainingPremiumBudget(db, ss.orgId);
    const results = await runLeadPipeline({ ...(ss.query as Record<string, unknown>), limit: Number((ss.query as { limit?: number }).limit ?? 25) }, { ai: createAiProvider(), verify: verifyOpts(), maxProviderLeads: providerBudget });
    let fresh = 0;
    const names: string[] = [];
    for (const r of results) {
      const q = await consumeLead(db, ss.orgId, r.source).then(() => true, () => false);
      if (!q) break;
      const { lead, created } = await upsertLead(ss.orgId, pipelineLeadToInput(r, { tags: [`saved:${ss.id.slice(0, 8)}`] }));
      if (created) {
        fresh++;
        names.push(`${lead.fullName ?? ""} - ${lead.title ?? ""}`);
        if (ss.listId) {
          const { listLeads } = await import("@prospex/db");
          await db.insert(listLeads).values({ listId: ss.listId, leadId: lead.id }).onConflictDoNothing();
        }
      }
    }
    await db.update(savedSearches).set({ lastRunAt: new Date(), lastNewCount: fresh }).where(eq(savedSearches.id, ss.id));
    if (ss.alert && fresh > 0 && ss.alertEmail) await sendMail(null, { from: env.mailFrom, to: ss.alertEmail, subject: `${fresh} new leads for "${ss.name}"`, text: `Prospex found ${fresh} new leads matching "${ss.name}":\n\n${names.join("\n")}\n\nOpen ${env.appUrl}/leads?tag=saved:${ss.id.slice(0, 8)}` });
    return { results: results.length, fresh };
  },

  /** Housekeeping: prune old done jobs, reset nothing else. */
  "system.cleanup": async (job, ctx) => {
    const { db } = ctx;
    const { lt, sql } = await import("@prospex/db");
    await db.delete(jobs).where(and(eq(jobs.status, "done"), lt(jobs.updatedAt, new Date(Date.now() - 7 * 86_400_000))));
    await db.execute(sql`DELETE FROM events WHERE created_at < now() - interval '90 days'`);
    if (job.payload.recurring) await enqueue(db, "system.cleanup", { recurring: true }, { runAt: new Date(Date.now() + 6 * 3600_000), maxAttempts: 1 });
    return {};
  },
};

/** Ensure the recurring scheduler jobs exist exactly once. */
export async function ensureRecurringJobs() {
  const { db, sql } = getDb();
  for (const type of ["campaign.tick", "system.cleanup", "signals.scan", "monitors.tick", "autopilots.tick", "visibility.tick"]) {
    const rows = await sql`SELECT 1 FROM jobs WHERE type = ${type} AND status IN ('queued','running') AND (payload->>'recurring')::boolean = true LIMIT 1`;
    if (rows.length === 0) await enqueue(db, type, { recurring: true }, { maxAttempts: 1 });
  }
}
