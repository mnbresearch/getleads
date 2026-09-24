import { and, autopilots, campaigns, companies, consume, consumeLead, enqueue, eq, events, getDb, icps, integrations, jobs, leads, monitors, remainingPremiumBudget, savedSearches, searches, signalSubscriptions, visibilityPrompts, webhooks, sql as dsql, type JobHandler } from "@prospex/db";
import { buildIcpWithAi, crawlCompanyWebsite, createAiProvider, findEmail, runLeadPipeline, scoreLeadRules, verifyEmail, type CompanyProfile, type IcpCriteria } from "@prospex/core";
import { env } from "./env.js";
import { hmacSign } from "./lib/crypto.js";
import { pipelineLeadToInput, upsertCompany, upsertLead } from "./services/leads.js";
import { knownBrands, sampleAcrossEngines } from "./services/visibility.js";
import { sendStep, tickCampaign } from "./services/campaigns.js";
import { syncLead } from "./services/integrations.js";
import { emitEvent } from "./lib/events.js";
import { identifyVisit } from "./services/visitors.js";
import { refreshCompanySignals, runSubscription } from "./services/signals.js";
import { runMonitor } from "./services/monitors.js";
import { runAutopilot } from "./services/autopilot.js";
import { sendMail } from "./lib/mailer.js";

const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });

/**
 * The six self-perpetuating schedulers, and how long each waits before its next run.
 *
 * Named in one place so the boot seeder, the periodic re-seeder and the handlers cannot
 * drift apart - a scheduler missing from any one of the three stops running with no error.
 */
export const RECURRING_JOBS: Record<string, number> = {
  "campaign.tick": 60_000,
  "signals.scan": 6 * 3600_000,
  "monitors.tick": 30 * 60_000,
  "visibility.tick": 3600_000,
  "autopilots.tick": 3600_000,
  "system.cleanup": 6 * 3600_000,
};

/**
 * Run a scheduler's body and enqueue its successor WHATEVER HAPPENS.
 *
 * These jobs keep themselves alive: each run's last act is to schedule the next one. They
 * are enqueued with maxAttempts: 1, so `failJob`'s `attempts < maxAttempts` is `1 < 1` -
 * false - and a failed run goes straight to `failed` with no retry. Previously the
 * reschedule was the last statement of the handler body, which meant ANY error before it
 * - one dropped pool connection in the `select` that opens each of these handlers - killed
 * that scheduler permanently. Campaign sending, monitors, autopilots, visibility sampling
 * and job cleanup would all simply stop, silently, until someone redeployed. Nothing
 * reported it, because a job that fails once and is never retried looks like an ordinary
 * failed job.
 *
 * Putting the reschedule in `finally` makes the chain survive its own body failing, which
 * is the common case. The rarer case - the database itself being unreachable, so even the
 * enqueue fails - is covered by the periodic re-seed in `startRecurringJobKeeper`.
 *
 * The error is rethrown, so a genuinely broken scheduler still records its failure.
 */
export async function withReschedule<T>(
  db: Parameters<typeof enqueue>[0],
  job: { payload: Record<string, unknown> },
  type: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    if (job.payload?.recurring) {
      const delayMs = RECURRING_JOBS[type] ?? 3600_000;
      // Best-effort: a failure to reschedule must not replace the body's error, which is
      // the more informative one. The keeper below is what recovers from this case.
      await enqueue(db, type, { recurring: true }, { runAt: new Date(Date.now() + delayMs), maxAttempts: 1 }).catch(() => {});
    }
  }
}


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
      /** Set when the plan's lead quota, not the data, ended the run. */
      let quotaStopped: string | null = null;
      for (const r of results) {
        try {
          await consumeLead(db, orgId, r.source);
        } catch (e) {
          quotaStopped = (e as Error).message;
          ctx.log(`quota hit: ${quotaStopped}`);
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
      // A search cut short by quota used to be written as plainly "done", so a customer who
      // hit their limit saw a completed search with fewer leads and no reason. The pipeline
      // found more; the plan would not let them have them. Saying so is the difference
      // between an upgrade prompt and a silent quality complaint.
      const truncated = quotaStopped !== null && results.length > ids.length;
      await db
        .update(searches)
        .set({
          status: "done",
          resultCount: ids.length,
          error: truncated ? `Stopped at your plan's limit: ${results.length - ids.length} more matching leads were found but not saved. ${quotaStopped}` : null,
          completedAt: new Date(),
        })
        .where(eq(searches.id, searchId));
      await emitEvent(
        orgId,
        "search.completed",
        { searchId, results: ids.length, created, found: results.length, quotaTruncated: truncated },
        { type: "search", id: searchId },
      );
      return { results: ids.length, created, leadIds: ids, found: results.length, quotaTruncated: truncated };
    } catch (e) {
      await db.update(searches).set({ status: "failed", error: (e as Error).message, completedAt: new Date() }).where(eq(searches.id, searchId));
      throw e;
    }
  },

  /** Enrich one lead: crawl company site, find + verify email, rescore. payload: { leadId } */
  "lead.enrich": async (job, ctx) => {
    const { db } = ctx;
    // Charged on the first attempt only. Enrichment is retried up to three times, and
    // billing each attempt charged an org three verifications for one lookup.
    const firstAttempt = job.attempts <= 1;
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)) });
    if (!lead) return { skipped: "missing" };
    let company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
    let profile: CompanyProfile | null = null;
    if (company && (!company.enrichedAt || Date.now() - company.enrichedAt.getTime() > 30 * 86_400_000)) {
      profile = await crawlCompanyWebsite(company.domain).catch(() => null);
      // A crawl that fetched nothing is not an enrichment. Writing it would stamp
      // `enrichedAt` and lock the company out of re-enrichment for thirty days on the
      // strength of one bad minute.
      if (profile && !profile.crawlFailed) company = await upsertCompany(lead.orgId, company.domain, { ...profile, name: profile.name ?? company.name ?? undefined });
    }
    const patch: Record<string, unknown> = {};
    const knownPattern = company?.emailPattern ?? undefined;
    if (!lead.email && company && lead.firstName && lead.lastName) {
      if (firstAttempt) await consume(db, lead.orgId, "verifications", 1);
      const r = await findEmail({ firstName: lead.firstName, lastName: lead.lastName, domain: company.domain, knownPattern, knownEmails: (company.raw as { emailsFound?: string[] })?.emailsFound }, verifyOpts());
      if (r.email) Object.assign(patch, { email: r.email, emailStatus: r.status, emailConfidence: r.confidence, verifiedAt: new Date() });
      if (r.pattern && !company.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, company.id));
    } else if (lead.email && lead.emailStatus === "unknown") {
      if (firstAttempt) await consume(db, lead.orgId, "verifications", 1);
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
      if (p && !p.crawlFailed) {
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
    return withReschedule(db, job, "campaign.tick", async () => {
      const active = await db.select().from(campaigns).where(eq(campaigns.status, "active"));
      const out: Record<string, unknown> = {};
      for (const c of active) out[c.id] = await tickCampaign(c.id).catch((e) => ({ error: (e as Error).message }));
      return out;
    });
  },

  "message.send": async (job) =>
    // The attempt number reaches sendStep so a retried send is not billed twice.
    sendStep(String(job.payload.campaignId), String(job.payload.contactId), String(job.payload.stepId), { attempt: job.attempts }),

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
    const crawled = !!prof && !prof.crawlFailed;
    if (crawled) await upsertCompany(co.orgId, co.domain, { ...prof!, name: prof!.name ?? co.name ?? undefined });
    const { detectHiring } = await import("@prospex/core");
    const h = await detectHiring(co.domain, prof?.name ?? co.name ?? undefined).catch(() => null);
    if (h) await db.update(companies).set({ openRoles: h.openRoles, hiring: { byFunction: h.byFunction, source: h.source, careersUrl: h.careersUrl } }).where(eq(companies.id, co.id));
    const n = await refreshCompanySignals(co.orgId, co.domain, prof?.name ?? co.name).catch(() => 0);
    return {
      crawled,
      // Not the same as "nothing to find": say which it was, in the job result the admin
      // page shows, rather than reporting a failed crawl as a completed one.
      crawlError: crawled ? undefined : prof ? `no page on ${co.domain} could be fetched (${prof.pagesAttempted ?? 0} tried)` : "crawl threw",
      openRoles: h?.openRoles ?? 0,
      newSignals: n,
    };
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
    return withReschedule(db, job, "signals.scan", async () => {
      const subs = await db.select().from(signalSubscriptions).where(and(eq(signalSubscriptions.active, true), dsql`(${signalSubscriptions.lastRunAt} IS NULL OR ${signalSubscriptions.lastRunAt} < now() - interval '5 hours')`));
      for (const s of subs) await enqueue(db, "signals.subscription", { subscriptionId: s.id }, { orgId: s.orgId, priority: 1 });
      return { queued: subs.length };
    });
  },

  "monitor.run": async (job, ctx) => {
    const m = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, String(job.payload.monitorId)) });
    if (!m || !m.active) return { skipped: true };
    return runMonitor(m, ctx.log);
  },

  /** Scheduler: run due monitors every 30 min. */
  "monitors.tick": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "monitors.tick", async () => {
      const due = await db.select().from(monitors).where(and(eq(monitors.active, true), dsql`(${monitors.lastRunAt} IS NULL OR ${monitors.lastRunAt} < now() - (${monitors.intervalMinutes} || ' minutes')::interval)`));
      for (const m of due) await enqueue(db, "monitor.run", { monitorId: m.id }, { orgId: m.orgId, priority: 1 });
      return { queued: due.length };
    });
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
    // Every configured engine, not just the priority winner: engines disagree, so one of
    // them is not an answer to "what does AI say about us".
    const r = await sampleAcrossEngines(db, prompt.orgId, prompt, { others });
    return { engines: r.engines, samplesPerEngine: r.samplesPerEngine, total: r.total, usable: r.usable };
  },

  /** Scheduler: daily, sample every active visibility prompt not run in the last 20 hours. */
  "visibility.tick": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "visibility.tick", async () => {
      const due = await db
        .select()
        .from(visibilityPrompts)
        .where(and(eq(visibilityPrompts.active, true), dsql`(${visibilityPrompts.lastRunAt} IS NULL OR ${visibilityPrompts.lastRunAt} < now() - interval '20 hours')`));
      for (const p of due) await enqueue(db, "visibility.run", { promptId: p.id }, { orgId: p.orgId, priority: 3 });
      return { queued: due.length };
    });
  },

  "autopilot.run": async (job, ctx) => {
    const ap = await ctx.db.query.autopilots.findFirst({ where: eq(autopilots.id, String(job.payload.autopilotId)) });
    if (!ap || !ap.active) return { skipped: true };
    return runAutopilot(ap, ctx.log);
  },

  /** Scheduler: hourly, run autopilots whose hour matches and haven't run today. */
  "autopilots.tick": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "autopilots.tick", async () => {
      const hour = new Date().getUTCHours();
      const due = await db.select().from(autopilots).where(and(eq(autopilots.active, true), eq(autopilots.runHourUtc, hour), dsql`(${autopilots.lastRunAt} IS NULL OR ${autopilots.lastRunAt} < now() - interval '20 hours')`));
      for (const ap of due) await enqueue(db, "autopilot.run", { autopilotId: ap.id }, { orgId: ap.orgId, priority: 1 });
      // saved-search alerts run daily at 02:00 UTC
      if (hour === 2) {
        const ss = await db.select().from(savedSearches).where(and(eq(savedSearches.alert, true), dsql`(${savedSearches.lastRunAt} IS NULL OR ${savedSearches.lastRunAt} < now() - interval '20 hours')`));
        for (const s of ss) await enqueue(db, "savedsearch.run", { savedSearchId: s.id }, { orgId: s.orgId, priority: 1 });
      }
      return { queued: due.length };
    });
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
    return withReschedule(db, job, "system.cleanup", async () => {
      const { lt, sql, ne } = await import("@prospex/db");
      // Only jobs whose result nothing still points at. A finished `search.run` holds the
      // lead ids that GET /v1/search/:id reads back out of job.result, and searches.jobId
      // carries no foreign key, so deleting the job left that endpoint returning an empty
      // result set for every search older than a week - indistinguishable from a search
      // that genuinely found nothing. Keeping them is cheap; the lie was not.
      await db
        .delete(jobs)
        .where(and(eq(jobs.status, "done"), ne(jobs.type, "search.run"), lt(jobs.updatedAt, new Date(Date.now() - 7 * 86_400_000))));
      // Failed jobs were never pruned at all and grew without bound. They are worth keeping
      // longer than successes, because they are what someone reads when diagnosing.
      await db.execute(sql`DELETE FROM jobs WHERE status = 'failed' AND updated_at < now() - interval '30 days'`);
      await db.execute(sql`DELETE FROM events WHERE created_at < now() - interval '90 days'`);
      return {};
    });
  },
};

/**
 * Ensure the recurring scheduler jobs exist exactly once.
 *
 * Returns the types it had to (re)create, so a caller can tell "everything was already
 * running" from "a dead scheduler was just revived" - the second is worth a log line.
 *
 * The advisory lock matters because this runs in BOTH the web process and the worker
 * process (server.ts and worker.ts both call it at boot), which on Render start together.
 * Without it, two concurrent SELECT-then-INSERT pairs both see zero rows and both insert,
 * and from then on every scheduler runs twice per cycle forever - doubling campaign ticks,
 * monitor runs and every bill attached to them. The lock is transaction-scoped, so it is
 * released even if this throws.
 */
export async function ensureRecurringJobs(): Promise<string[]> {
  const { db, sql } = getDb();
  const revived: string[] = [];
  await sql.begin(async (tx) => {
    // One arbitrary but stable key; only this function contends for it.
    await tx`SELECT pg_advisory_xact_lock(hashtext('prospex:ensure-recurring'))`;
    for (const type of Object.keys(RECURRING_JOBS)) {
      const rows = await tx`SELECT 1 FROM jobs WHERE type = ${type} AND status IN ('queued','running') AND (payload->>'recurring')::boolean = true LIMIT 1`;
      if (rows.length === 0) {
        await enqueue(db, type, { recurring: true }, { maxAttempts: 1 });
        revived.push(type);
      }
    }
  });
  return revived;
}

/**
 * Re-seed dead schedulers periodically, not just at boot.
 *
 * `withReschedule` keeps a chain alive when the body fails, which is the common case. It
 * cannot help when the database itself was unreachable at that moment, because the
 * reschedule is a database write too. Before this existed, that window killed a scheduler
 * until the next deploy - and nothing said so, because one failed job among thousands is
 * not a signal anyone sees.
 *
 * Checking every few minutes turns "silently stopped until someone notices" into "stopped
 * for at most one interval". Returns a stop function.
 */
export function startRecurringJobKeeper(opts: { intervalMs?: number; log?: (m: string) => void } = {}) {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const log = opts.log ?? ((m: string) => console.log(`[jobs] ${m}`));
  const timer = setInterval(() => {
    void ensureRecurringJobs()
      .then((revived) => {
        // Only speak when something was actually wrong. A heartbeat that logs every tick
        // is a heartbeat nobody reads.
        if (revived.length) log(`revived dead scheduler(s): ${revived.join(", ")}`);
      })
      .catch((e) => log(`keeper failed: ${(e as Error).message}`));
  }, intervalMs);
  // Do not hold the process open for this alone.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
