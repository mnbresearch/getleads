import { and, autopilots, campaigns, companies, consume, drainJobs, enqueue, eq, events, getDb, icps, integrations, jobs, leads, monitors, ne, organizations, reapStaleJobs, remainingPremiumBudget, savedSearches, searches, signalSubscriptions, sql as dsql, type Db, type Job, type JobHandler, visibilityPrompts, webhooks } from "@prospex/db";
import { buildIcpWithAi, crawlCompanyWebsite, createAiProviderForPlan, findEmail, isPublicHost, runLeadPipeline, runLeadPipelineDetailed, scoreLeadRules, verifyEmail, type CompanyProfile, type IcpCriteria } from "@prospex/core";
import { env } from "./env.js";
import { hmacSign } from "./lib/crypto.js";
import { chargeNewLead, findExistingLead, pipelineLeadToInput, upsertCompany, upsertLead } from "./services/leads.js";
import { knownBrands, sampleAcrossEngines } from "./services/visibility.js";
import { sendStep, tickCampaign } from "./services/campaigns.js";
import { syncLead } from "./services/integrations.js";
import { emitEvent } from "./lib/events.js";
import { tryConsume, type QuotaOutcome } from "./lib/quota.js";
import { scanJobChanges } from "./services/jobChanges.js";
import { identifyVisit } from "./services/visitors.js";
import { refreshCompanySignals, runSubscription } from "./services/signals.js";
import { runMonitor } from "./services/monitors.js";
import { runAutopilot } from "./services/autopilot.js";
import { sendMail } from "./lib/mailer.js";

/** Org's plan, for the plan-gated AI factory. A missing org is treated as free. */
async function planOf(db: Db, orgId: string | null | undefined): Promise<string> {
  if (!orgId) return "free";
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  return org?.plan ?? "free";
}

/**
 * The AI engine this org's plan pays for. `createAiProvider()` picks Anthropic whenever it
 * is configured, so every background job gave free workspaces the paid model.
 */
async function aiFor(db: Db, orgId: string | null | undefined) {
  return createAiProviderForPlan(await planOf(db, orgId));
}

/** Only orgs that are allowed to run: a suspended workspace's schedules must not fire. */
const orgIsActive = (col: unknown) => dsql`${col} IN (SELECT id FROM organizations WHERE status = 'active')`;

/**
 * Which verifier gave this verdict, for leads.email_verified_by. Null when no external
 * verifier or SMTP probe actually answered (a syntax rule or "probe disabled" is not a
 * verification, and must not be stamped as one).
 */
export function verifierOf(v: { reason?: string | null; verifiedBy?: string | null }): string | null {
  const by = v.verifiedBy ?? "";
  if (/^(reoon|millionverifier|hunter|abstract):/i.test(by) || by === "smtp") return by.slice(0, 80);
  if (by) return null; // a local check ("syntax", "dns", "mx-only") is not a verification
  const r = v.reason ?? "";
  if (/^(reoon|millionverifier|hunter|abstract):/i.test(r)) return r.slice(0, 80);
  if (/^SMTP (accepted|rejected)/.test(r)) return "smtp";
  return null;
}

/**
 * Charge one unit for this job exactly once, across all its attempts.
 *
 * Gating on `attempts <= 1` let a retry do the work free whenever the first attempt was
 * refused for quota (or failed to record the charge). The charge is instead marked on the
 * job itself, so a retry knows whether it has been paid for - and a plan limit is
 * returned as an answer, for the caller to end the job with, not thrown into a retry.
 */
async function chargeJobOnce(db: Db, job: Job, orgId: string, metric: "verifications"): Promise<QuotaOutcome> {
  const key = `charged_${metric}`;
  if (job.payload?.[key]) return { ok: true };
  const r = await tryConsume(db, orgId, metric, 1);
  if (r.ok) {
    await db.execute(dsql`UPDATE jobs SET payload = payload || ${JSON.stringify({ [key]: true })}::jsonb WHERE id = ${job.id}`);
    job.payload = { ...(job.payload ?? {}), [key]: true };
  }
  return r;
}

/** Give back a job's charge when its last attempt failed: no work was delivered. */
async function refundJobCharge(db: Db, job: Job, orgId: string, metric: "verifications") {
  if (!job.payload?.[`charged_${metric}`] || job.attempts < job.maxAttempts) return;
  await consume(db, orgId, metric, -1, { allowOverage: true }).catch(() => {});
}

const verifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });

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
  // Daily. A job change is a slow event and each check costs a provider call, so scanning
  // more often would spend credits to learn the same thing.
  "jobchanges.tick": 24 * 3600_000,
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
/**
 * Schedulers outrank all work. They were priority 0 while each pageview enqueued a
 * priority-4 visit.identify, so a busy site starved campaign.tick - and with it sending.
 * claimJob also orders recurring jobs first, which covers rows enqueued before this.
 */
export const SCHEDULER_PRIORITY = 100;

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
      await enqueue(db, type, { recurring: true }, { runAt: new Date(Date.now() + delayMs), maxAttempts: 1, priority: SCHEDULER_PRIORITY }).catch(() => {});
    }
  }
}


/** Result of findEmail, including what C1's core change adds when present. */
type FoundEmail = Awaited<ReturnType<typeof findEmail>> & { verifiedBy?: string | null };

/** findEmail with addresses it must never return (known bad, or the one being replaced). */
async function findEmailExcluding(input: Parameters<typeof findEmail>[0], exclude: string[]): Promise<FoundEmail> {
  const ex = new Set(exclude.map((e) => e.toLowerCase()));
  // `exclude` tells the core finder to skip those candidates (and not spend a verification
  // on them); the check below enforces it here too, so a bad address can never come back.
  const opts: Parameters<typeof findEmail>[1] & { exclude?: string[] } = { ...verifyOpts(), exclude: [...ex] };
  const r = (await findEmail(input, opts)) as FoundEmail;
  if (r.email && ex.has(r.email.toLowerCase())) return { ...r, email: undefined, status: "unknown", confidence: 0, verifiedBy: undefined };
  return r;
}

async function enrichLead(db: Db, job: Job, lead: typeof leads.$inferSelect) {
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
  const custom = { ...(lead.custom ?? {}) } as Record<string, unknown>;
  const priorBad = Array.isArray(custom.invalidEmails) ? (custom.invalidEmails as string[]) : [];
  /** Is this address already another lead's in the org? The (org, email) index is unique. */
  const takenByOther = async (email: string) => {
    const other = await db.query.leads.findFirst({ where: and(eq(leads.orgId, lead.orgId), eq(leads.email, email.toLowerCase())) });
    return !!other && other.id !== lead.id;
  };
  /** A plan limit ends the job as skipped; nothing below is done for free on a retry. */
  const charge = async () => {
    const c = await chargeJobOnce(db, job, lead.orgId, "verifications");
    if (!c.ok && c.reason === "error") throw new Error(`could not record verification usage: ${c.message}`);
    return c;
  };

  if (!lead.email && company && lead.firstName && lead.lastName) {
    const c = await charge();
    if (!c.ok) return { skipped: "quota", detail: c.message };
    const r = await findEmailExcluding({ firstName: lead.firstName, lastName: lead.lastName, domain: company.domain, knownPattern, knownEmails: (company.raw as { emailsFound?: string[] })?.emailsFound }, priorBad);
    if (r.email) {
      // The same "taken" check replaceInvalid has. Writing an address another lead
      // already holds hit the unique index, and the job failed three times over it.
      if (await takenByOther(r.email)) {
        custom.emailLookup = { at: new Date().toISOString(), result: `found ${r.email.toLowerCase()}, which another lead already has` };
        Object.assign(patch, { custom });
      } else {
        const by = r.verifiedBy ?? null;
        Object.assign(patch, { email: r.email.toLowerCase(), emailStatus: r.status, emailConfidence: r.confidence, ...(by ? { verifiedAt: new Date(), emailVerifiedBy: by } : { emailVerifiedBy: null }) });
      }
    }
    if (r.pattern && !company.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, company.id));
  } else if (lead.email && lead.emailStatus === "unknown") {
    const c = await charge();
    if (!c.ok) return { skipped: "quota", detail: c.message };
    const v = await verifyEmail(lead.email, verifyOpts());
    const by = verifierOf(v);
    Object.assign(patch, { emailStatus: v.status, emailConfidence: v.confidence, ...(by ? { verifiedAt: new Date(), emailVerifiedBy: by } : {}) });
  } else if (job.payload.replaceInvalid && lead.email && lead.emailStatus === "invalid" && company && lead.firstName && lead.lastName) {
    // Asked for explicitly ("find a working address"): the person may be right and only
    // the address wrong. Look for a replacement; keep the bad one on record rather than
    // throwing it away, so it is never tried again and never silently resurrected.
    const c = await charge();
    if (!c.ok) return { skipped: "quota", detail: c.message };
    // Every address already known bad, and the current one, are excluded - the finder
    // used to hand back an address from invalidEmails as the "replacement".
    const r = await findEmailExcluding({ firstName: lead.firstName, lastName: lead.lastName, domain: company.domain, knownPattern, knownEmails: (company.raw as { emailsFound?: string[] })?.emailsFound }, [...priorBad, lead.email]);
    const usable = r.email && r.email.toLowerCase() !== lead.email.toLowerCase() && (r.status === "valid" || r.status === "catch_all" || r.status === "risky");
    const taken = usable ? await takenByOther(r.email!) : false;
    if (usable && !taken) {
      custom.invalidEmails = [...new Set([...priorBad, lead.email])];
      const by = r.verifiedBy ?? null;
      // verifiedAt only when a verifier actually answered. A pattern guess with the SMTP
      // probe off is "risky" and unverified, and must not be shown as verified.
      Object.assign(patch, { email: r.email!.toLowerCase(), emailStatus: r.status, emailConfidence: r.confidence, ...(by ? { verifiedAt: new Date(), emailVerifiedBy: by } : { verifiedAt: null, emailVerifiedBy: null }), custom });
    } else {
      // Recorded, so the next look at this lead can tell "tried, nothing better" from
      // "never tried" - and the dashboard is not asked to repeat the same lookup.
      custom.replacementSearchedAt = new Date().toISOString();
      custom.replacementResult = taken ? "found an address another lead already has" : r.email ? `only found ${r.status} candidates` : "no candidate found";
      Object.assign(patch, { custom });
    }
  }
  const icp = lead.icpId ? await db.query.icps.findFirst({ where: eq(icps.id, lead.icpId) }) : null;
  if (icp) {
    const s = scoreLeadRules({ title: lead.title, location: lead.location, country: lead.country, emailStatus: String(patch.emailStatus ?? lead.emailStatus), company }, icp.criteria as IcpCriteria);
    Object.assign(patch, { score: s.score, scoreReasons: s.reasons });
  }
  await db.update(leads).set({ ...patch, enrichedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await emitEvent(lead.orgId, "lead.enriched", { leadId: lead.id, ...patch }, { type: "lead", id: lead.id });
  return patch;
}

/** Consecutive finally-failed deliveries after which a webhook is switched off. */
export const WEBHOOK_DISABLE_AFTER = 10;

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
      const { leads: results, providerFailures } = await runLeadPipelineDetailed(query, {
        ai: await aiFor(db, orgId),
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
      /** Set when usage could not be recorded at all - a fault, not the customer's limit. */
      let chargeError: string | null = null;
      for (const r of results) {
        // Charged only for a lead the org does not have yet. A retry of this job re-runs
        // the pipeline and finds the leads its earlier attempt already saved (and paid
        // for): those now exist, so they are not charged again. Charging every result
        // before the upsert billed rediscoveries and re-billed every lead on each retry.
        const existing = await findExistingLead(orgId, { email: r.email, linkedinUrl: r.linkedinUrl });
        if (!existing) {
          const charge = await chargeNewLead(orgId, r.source);
          if (!charge.ok) {
            if (charge.reason === "quota") quotaStopped = charge.message;
            else chargeError = charge.message;
            ctx.log(`stopped: ${charge.message}`);
            break;
          }
        }
        // fillOnly: a rediscovery fills gaps and never overwrites what the user edited.
        const { lead, created: c } = await upsertLead(orgId, pipelineLeadToInput(r, { icpId, source: r.source, tags: [`search:${searchId.slice(0, 8)}`] }), { fillOnly: true });
        if (c) created++;
        ids.push(lead.id);
      }
      if (job.payload.listId && ids.length) {
        const { listLeads } = await import("@prospex/db");
        for (const leadId of ids) await db.insert(listLeads).values({ listId: String(job.payload.listId), leadId }).onConflictDoNothing();
      }
      // A search run for a client delivers to that client. People another client already
      // owns stay with that client and are counted, never silently taken.
      //
      // Its own try: the search itself has succeeded and its leads are saved (and charged)
      // by this point. Letting a claim failure throw marked a finished search failed, and
      // the retry re-ran the whole pipeline and charged for the same leads again.
      let clientClaim: { claimed: number; ownedByAnotherClient: number; skipped?: string; error?: string } | null = null;
      if (job.payload.clientId && ids.length) {
        try {
          const { claimSearchLeads } = await import("./services/clients.js");
          clientClaim = await claimSearchLeads(db, orgId, String(job.payload.clientId), ids);
        } catch (e) {
          clientClaim = { claimed: 0, ownedByAnotherClient: 0, error: (e as Error).message.slice(0, 200) };
          ctx.log(`client claim failed: ${clientClaim.error}`);
        }
      }
      // A search cut short by quota used to be written as plainly "done", so a customer who
      // hit their limit saw a completed search with fewer leads and no reason. The pipeline
      // found more; the plan would not let them have them. Saying so is the difference
      // between an upgrade prompt and a silent quality complaint.
      const truncated = (quotaStopped !== null || chargeError !== null) && results.length > ids.length;

      // A search that found nothing because a configured provider refused us is not a
      // search that found nothing. Reporting `resultCount: 0, error: null` asserts "no
      // leads match your ICP", which is a claim about the customer's market made out of a
      // billing or credential problem on our side.
      const blockedByProviders = ids.length === 0 && providerFailures.length > 0;
      const providerNote = blockedByProviders
        ? `No leads were returned, and ${providerFailures.length === 1 ? "the data source we tried could not answer" : `${providerFailures.length} data sources could not answer`}: ${providerFailures.map((f) => `${f.provider} - ${f.message}`).join("; ")}. This is not the same as nobody matching your criteria.`
        : null;

      await db
        .update(searches)
        .set({
          status: "done",
          resultCount: ids.length,
          error: truncated
            ? quotaStopped !== null
              ? `Stopped at your plan's limit: ${results.length - ids.length} more matching leads were found but not saved. ${quotaStopped}`
              : `Stopped early: ${results.length - ids.length} more matching leads were found but not saved, because usage could not be recorded (${chargeError}). This is a fault on our side, not your plan limit.`
            : providerNote,
          clientClaim: clientClaim ?? undefined,
          completedAt: new Date(),
        })
        .where(eq(searches.id, searchId));
      await emitEvent(
        orgId,
        "search.completed",
        { searchId, results: ids.length, created, found: results.length, quotaTruncated: truncated, providerFailures },
        { type: "search", id: searchId },
      );
      return { results: ids.length, created, leadIds: ids, found: results.length, quotaTruncated: truncated, clientClaim };
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
    try {
      return await enrichLead(db, job, lead);
    } catch (e) {
      await refundJobCharge(db, job, lead.orgId, "verifications");
      throw e;
    }
  },

  /** Verify a lead's email. payload: { leadId } */
  "lead.verify": async (job, ctx) => {
    const { db } = ctx;
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)) });
    if (!lead?.email) return { skipped: "no email" };
    // One lookup, one charge, however many times the job is retried. A plan limit ends the
    // job (no retry does the lookup for free); a fault is thrown and retried.
    const charge = await chargeJobOnce(db, job, lead.orgId, "verifications");
    if (!charge.ok && charge.reason === "quota") return { skipped: "quota", detail: charge.message };
    if (!charge.ok) throw new Error(`could not record verification usage: ${charge.message}`);
    try {
      const v = await verifyEmail(lead.email, verifyOpts());
      const by = verifierOf(v);
      // verifiedAt means "a verifier answered". A "probe disabled" guess stamped it too,
      // and the UI then showed an unchecked address as verified.
      await db
        .update(leads)
        .set({ emailStatus: v.status, emailConfidence: v.confidence, ...(by ? { verifiedAt: new Date(), emailVerifiedBy: by } : {}), updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      await emitEvent(lead.orgId, "lead.verified", { leadId: lead.id, email: lead.email, status: v.status, confidence: v.confidence, verifiedBy: by }, { type: "lead", id: lead.id });
      return { status: v.status, confidence: v.confidence, verifiedBy: by };
    } catch (e) {
      await refundJobCharge(db, job, lead.orgId, "verifications");
      throw e;
    }
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
    const profile = await buildIcpWithAi(await aiFor(db, icp.orgId), { description: icp.description ?? undefined, seedCompanies: seeds, product: String(job.payload.product ?? "") });
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
      const active = await db.select().from(campaigns).where(and(eq(campaigns.status, "active"), orgIsActive(campaigns.orgId)));
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
    // Same reasoning as the CRM webhook: a customer-supplied URL, called from inside our
    // network, carrying event data. A private address is ours, not theirs.
    if (!isPublicHost(hook.url, { allowUserinfo: true })) return { skipped: `${hook.url} is not a public address` };
    const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.data, entity: { type: ev.entityType, id: ev.entityId } });
    const ts = String(Date.now());
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prospex-signature": hmacSign(hook.secret, `${ts}.${body}`), "x-prospex-timestamp": ts, "x-prospex-event": ev.type },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => ({ ok: false, status: 0, statusText: (e as Error).message }));
    if (!res.ok) {
      // Only a delivery that has used up its retries counts against the hook. Counting
      // every attempt meant four events during one short outage (5 attempts each) disabled
      // a customer's webhook for good. Ten events that finally failed in a row is a dead
      // endpoint; a blip is not.
      if (job.attempts >= job.maxAttempts) {
        const [row] = await db.update(webhooks).set({ failures: dsql`${webhooks.failures} + 1` }).where(eq(webhooks.id, hook.id)).returning({ failures: webhooks.failures });
        if ((row?.failures ?? 0) >= WEBHOOK_DISABLE_AFTER) {
          const [disabled] = await db.update(webhooks).set({ active: false }).where(and(eq(webhooks.id, hook.id), eq(webhooks.active, true))).returning({ id: webhooks.id });
          if (disabled) {
            ctx.log(`webhook ${hook.id} disabled after ${row!.failures} consecutive failed deliveries`);
            console.warn(`[webhooks] disabled ${hook.id} (${hook.url}) for org ${hook.orgId}: ${row!.failures} consecutive deliveries failed`);
            // Recorded where the org can see it. The hook is inactive now, so this event
            // is not delivered to it.
            await emitEvent(hook.orgId, "webhook.disabled", { webhookId: hook.id, url: hook.url, consecutiveFailures: row!.failures, lastError: `${res.status} ${res.statusText}` }).catch(() => {});
          }
        }
      }
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
  "visit.identify": async (job, ctx) => {
    // The raw IP is needed to identify the visit and for nothing after. It is dropped from
    // the job row once identification is done - or once the last attempt has failed - so
    // the jobs table does not keep a log of visitors' addresses.
    const forget = () => ctx.db.execute(dsql`UPDATE jobs SET payload = payload - 'ip' WHERE id = ${job.id}`).catch(() => {});
    try {
      const r = await identifyVisit(String(job.payload.visitId), String(job.payload.ip), (job.payload.identify as Record<string, unknown> | null) ?? null);
      await forget();
      return r;
    } catch (e) {
      if (job.attempts >= job.maxAttempts) await forget();
      throw e;
    }
  },

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
    // `reached: false` means nothing answered, not that nobody is hiring. Writing its 0
    // over a real count both loses the number and suppresses the next hiring-up alert,
    // which requires a previous count above zero.
    const hiringOk = !!h && h.reached;
    if (hiringOk) await db.update(companies).set({ openRoles: h!.openRoles, hiring: { byFunction: h!.byFunction, source: h!.source, careersUrl: h!.careersUrl } }).where(eq(companies.id, co.id));
    const n = await refreshCompanySignals(co.orgId, co.domain, prof?.name ?? co.name).catch(() => 0);
    return {
      crawled,
      // Not the same as "nothing to find": say which it was, in the job result the admin
      // page shows, rather than reporting a failed crawl as a completed one.
      crawlError: crawled ? undefined : prof ? `no page on ${co.domain} could be fetched (${prof.pagesAttempted ?? 0} tried)` : "crawl threw",
      openRoles: hiringOk ? h!.openRoles : co.openRoles,
      hiringError: hiringOk ? undefined : h?.reason ?? "hiring check threw",
      newSignals: n,
    };
  },

  /** Run one signal subscription. payload: { subscriptionId } */
  "signals.subscription": async (job, ctx) => {
    const sub = await ctx.db.query.signalSubscriptions.findFirst({ where: eq(signalSubscriptions.id, String(job.payload.subscriptionId)) });
    if (!sub || !sub.active) return { skipped: true };
    return runSubscription(sub, ctx.log);
  },

  /**
   * Scheduler: re-check engaged and high-scoring leads for a job change, daily.
   *
   * Runs per org rather than globally so one org's provider outage or quota does not stop
   * the others, and so the per-org limit means what it says.
   */
  "jobchanges.tick": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "jobchanges.tick", async () => {
      /**
       * Bounded, and only for orgs that can actually log in.
       *
       * `ne(status, "deactivated")` let `revoked` orgs through - both are blocked at auth,
       * so that spent enrichment credits on workspaces nobody can reach. And there was no
       * cap of any kind: every org, sequentially, up to 50 serial provider round trips
       * each. At a few thousand orgs that is tens of thousands of serial HTTP calls in one
       * invocation, which exceeds any job timeout and is then retried from the beginning,
       * forever, getting no further.
       *
       * So: active orgs only, a budget per tick, and the least-recently-scanned orgs first
       * so the rotation covers everyone over a few days instead of starving the tail.
       */
      const ORGS_PER_TICK = 25;
      const LEADS_PER_ORG = 50;
      const DEADLINE_MS = 10 * 60_000;
      /**
       * Budgeting cost of one lead, taken from what one can actually cost.
       *
       * `enrichWithProviders` walks providers serially until one answers, and the slowest
       * configured timeout is 20s, so a lead every provider misses costs that or more. A
       * comment previously asserted 2s, which made the budget a best-case figure and the
       * deadline a suggestion. The hard bound is `deadlineAt`, passed into the scan and
       * checked per lead; this number only decides how many leads are worth starting.
       */
      const MS_PER_LEAD = 20_000;
      const startedAt = Date.now();

      /**
       * Ordered by the org's own rotation cursor, not by a derived one.
       *
       * This used to order by `(SELECT max(job_checked_at) FROM leads ...) NULLS FIRST`,
       * which starved permanently: `job_checked_at` is deliberately only written when an
       * employer could be compared on both sides, so an org with no leads, no provider
       * coverage or nothing comparable never gets one, its max stays NULL, and it sits at
       * the head of NULLS FIRST every tick while the orgs behind it are never reached at
       * all. It was also a correlated aggregate over `leads` per org per tick with no
       * index behind it.
       *
       * The cursor is stamped below for every org we ATTEMPT, so the rotation advances
       * whatever the outcome.
       */
      const orgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.status, "active"))
        .orderBy(dsql`${organizations.jobCheckTickAt} ASC NULLS FIRST`)
        .limit(ORGS_PER_TICK);

      let scanned = 0;
      let changed = 0;
      let blocked = 0;
      let alreadyKnown = 0;
      let failed = 0;
      let backedOff = 0;
      let planLimited = 0;
      let stoppedEarly = false;
      for (const org of orgs) {
        const remaining = DEADLINE_MS - (Date.now() - startedAt);
        // Enough budget left to be worth starting? The deadline was previously only
        // checked BETWEEN orgs, so a tick with nine minutes gone would still start a
        // fifty-lead scan and run minutes past its own limit.
        if (remaining < 10 * MS_PER_LEAD) {
          stoppedEarly = true;
          break;
        }
        const budget = Math.min(LEADS_PER_ORG, Math.floor(remaining / MS_PER_LEAD));

        // Stamped before the scan, not after: an org whose scan throws must still move
        // down the rotation, or one org failing loudly blocks everyone behind it forever.
        await db.update(organizations).set({ jobCheckTickAt: new Date() }).where(eq(organizations.id, org.id));

        // Paid provider lookups, so bounded by the org's premium budget like every other
        // paid call. A free plan has none and is not scanned at all.
        const premiumBudget = await remainingPremiumBudget(db, org.id).catch(() => 0);
        const r = await scanJobChanges(org.id, { limit: budget, deadlineAt: startedAt + DEADLINE_MS, premiumBudget }).catch((e) => {
          ctx.log(`job change scan failed for ${org.id}: ${(e as Error).message}`);
          return null;
        });
        // Counted, not just logged. A tick where all 25 orgs threw used to return exactly
        // what a tick of 25 healthy orgs with nothing due returns, and the only trace was a
        // log line - the same failure-looks-like-emptiness substitution this job reports on.
        if (!r) {
          failed++;
          continue;
        }
        scanned += r.checked;
        changed += r.changed;
        alreadyKnown += r.alreadyKnown;
        backedOff += r.skippedRecentlyAttempted;
        if (r.blocked) blocked++;
        if (r.planLimited) planLimited++;
      }
      // `blocked` is reported separately from `changed: 0`, because an org where no
      // provider answered has not been told that nobody moved.
      return { orgs: orgs.length, scanned, changed, alreadyKnown, leadsLeftForNextRun: backedOff, orgsWhereScanThrew: failed, orgsWhereNothingAnswered: blocked, orgsWithoutProviderBudget: planLimited, stoppedEarly };
    });
  },

  /** Scheduler: run all active subscriptions every 6h. */
  "signals.scan": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "signals.scan", async () => {
      const subs = await db.select().from(signalSubscriptions).where(and(eq(signalSubscriptions.active, true), orgIsActive(signalSubscriptions.orgId), dsql`(${signalSubscriptions.lastRunAt} IS NULL OR ${signalSubscriptions.lastRunAt} < now() - interval '5 hours')`));
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
      const due = await db.select().from(monitors).where(and(eq(monitors.active, true), orgIsActive(monitors.orgId), dsql`(${monitors.lastRunAt} IS NULL OR ${monitors.lastRunAt} < now() - (${monitors.intervalMinutes} || ' minutes')::interval)`));
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
    // The plan decides which engines are sampled. Without it the scheduled path defaulted
    // to the free-tier set for paying orgs - and the manual path, which passed it, did not
    // agree with the scheduled one.
    const r = await sampleAcrossEngines(db, prompt.orgId, prompt, { others, plan: await planOf(db, prompt.orgId) });
    return { engines: r.engines, samplesPerEngine: r.samplesPerEngine, total: r.total, usable: r.usable };
  },

  /** Scheduler: daily, sample every active visibility prompt not run in the last 20 hours. */
  "visibility.tick": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "visibility.tick", async () => {
      const due = await db
        .select()
        .from(visibilityPrompts)
        .where(and(eq(visibilityPrompts.active, true), orgIsActive(visibilityPrompts.orgId), dsql`(${visibilityPrompts.lastRunAt} IS NULL OR ${visibilityPrompts.lastRunAt} < now() - interval '20 hours')`));
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
      // At or after the target hour and not yet run today (UTC), rather than an exact hour
      // match: a tick that ran late, a worker that was down for that hour, or a starved
      // scheduler skipped the whole day. Not-run-today keeps it to once a day.
      const notToday = (col: unknown) => dsql`(${col} IS NULL OR ${col} < date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
      const due = await db
        .select()
        .from(autopilots)
        .where(and(eq(autopilots.active, true), orgIsActive(autopilots.orgId), dsql`${autopilots.runHourUtc} <= ${hour}`, notToday(autopilots.lastRunAt)));
      for (const ap of due) await enqueue(db, "autopilot.run", { autopilotId: ap.id }, { orgId: ap.orgId, priority: 1 });
      // saved-search alerts run daily from 02:00 UTC
      let savedQueued = 0;
      if (hour >= 2) {
        const ss = await db.select().from(savedSearches).where(and(eq(savedSearches.alert, true), orgIsActive(savedSearches.orgId), notToday(savedSearches.lastRunAt)));
        for (const s of ss) await enqueue(db, "savedsearch.run", { savedSearchId: s.id }, { orgId: s.orgId, priority: 1 });
        savedQueued = ss.length;
      }
      return { queued: due.length, savedSearchesQueued: savedQueued };
    });
  },

  /** Re-run a saved search, add new leads to its list, email a digest if alerting. payload: { savedSearchId } */
  "savedsearch.run": async (job, ctx) => {
    const { db } = ctx;
    const ss = await db.query.savedSearches.findFirst({ where: eq(savedSearches.id, String(job.payload.savedSearchId)) });
    if (!ss) return { skipped: true };
    // Charged once per run, not once per retry, and a database fault is reported as a
    // database fault rather than as the customer's plan limit. lastRunAt is stamped below
    // either way, so misfiling this silently cancelled that day's alert digest.
    if (job.attempts <= 1) {
      const charge = await tryConsume(db, ss.orgId, "searches", 1);
      if (!charge.ok && charge.reason === "quota") return { skipped: "quota", detail: charge.message };
      if (!charge.ok) throw new Error(`could not record search usage: ${charge.message}`);
    }
    const providerBudget = await remainingPremiumBudget(db, ss.orgId);
    const { leads: results, providerFailures } = await runLeadPipelineDetailed(
      { ...(ss.query as Record<string, unknown>), limit: Number((ss.query as { limit?: number }).limit ?? 25) } as Parameters<typeof runLeadPipeline>[0],
      { ai: await aiFor(db, ss.orgId), verify: verifyOpts(), maxProviderLeads: providerBudget },
    );
    let fresh = 0;
    const names: string[] = [];
    const freshIds: string[] = [];
    let stoppedBecause: string | null = null;
    for (const r of results) {
      // Charged for new leads only, after a plan/fault distinction - not for every result
      // before the upsert, which billed the same people again at every daily re-run.
      const existing = await findExistingLead(ss.orgId, { email: r.email, linkedinUrl: r.linkedinUrl });
      if (!existing) {
        const charge = await chargeNewLead(ss.orgId, r.source);
        if (!charge.ok) {
          stoppedBecause = charge.reason === "quota" ? `Stopped at your plan's lead limit: ${charge.message}` : `Stopped: could not record lead usage (${charge.message})`;
          break;
        }
      }
      const { lead, created } = await upsertLead(ss.orgId, pipelineLeadToInput(r, { tags: [`saved:${ss.id.slice(0, 8)}`] }), { fillOnly: true });
      if (created) {
        fresh++;
        freshIds.push(lead.id);
        names.push(`${lead.fullName ?? ""} - ${lead.title ?? ""}`);
        if (ss.listId) {
          const { listLeads } = await import("@prospex/db");
          await db.insert(listLeads).values({ listId: ss.listId, leadId: lead.id }).onConflictDoNothing();
        }
      }
    }
    // "0 new" because the sources could not answer is not "nothing new matched". The saved
    // search row has no note column, so the reason goes in the job result (shown by the
    // admin job view) and the digest says it instead of staying silent.
    const blocked = results.length === 0 && providerFailures.length > 0;
    const note = blocked
      ? `No leads were returned, and ${providerFailures.length} data source(s) could not answer: ${providerFailures.map((f) => `${f.provider} - ${f.message}`).join("; ")}. This is not the same as nothing new matching.`
      : stoppedBecause;
    // A saved search made for a client delivers its new leads to that client, the same way a
    // one-off search does - otherwise every daily re-run would pile leads into the pool.
    // claimSearchLeads re-checks the client (deleted/archived) and never steals another
    // client's lead.
    const ssClientId = (ss.query as { clientId?: unknown }).clientId;
    let clientClaim: Awaited<ReturnType<typeof import("./services/clients.js").claimSearchLeads>> | null = null;
    if (typeof ssClientId === "string" && freshIds.length) {
      try {
        const { claimSearchLeads } = await import("./services/clients.js");
        clientClaim = await claimSearchLeads(db, ss.orgId, ssClientId, freshIds);
      } catch (e) {
        clientClaim = { claimed: 0, ownedByAnotherClient: 0, skipped: `error: ${(e as Error).message}` };
      }
    }
    await db.update(savedSearches).set({ lastRunAt: new Date(), lastNewCount: fresh }).where(eq(savedSearches.id, ss.id));
    if (ss.alert && fresh > 0 && ss.alertEmail) await sendMail(null, { from: env.mailFrom, to: ss.alertEmail, subject: `${fresh} new leads for "${ss.name}"`, text: `Scout found ${fresh} new leads matching "${ss.name}":\n\n${names.join("\n")}${stoppedBecause ? `\n\n${stoppedBecause}` : ""}\n\nOpen ${env.appUrl}/leads?tag=saved:${ss.id.slice(0, 8)}` });
    else if (ss.alert && blocked && ss.alertEmail) await sendMail(null, { from: env.mailFrom, to: ss.alertEmail, subject: `Could not check "${ss.name}" today`, text: `${note}\n\nThe search will run again tomorrow.` });
    return { results: results.length, fresh, providerFailures, note, clientClaim };
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
        await enqueue(db, type, { recurring: true }, { maxAttempts: 1, priority: SCHEDULER_PRIORITY });
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

/**
 * Everything a long-running worker does in the background, as one call - for inline mode.
 *
 * On Vercel (JOB_MODE=inline) there is no worker process: an external cron hits
 * /internal/jobs/run and that request drains the queue. Draining alone never re-seeded a
 * dead scheduler and never reaped a job whose function invocation was killed mid-run, so
 * one timeout left a job "running" forever and one dropped reschedule stopped campaign
 * sending for good. This does all three, in the order that matters: revive schedulers,
 * release dead locks, then run what is due.
 */
export async function runMaintenanceTick(opts: { maxMs?: number } = {}): Promise<{ revived: string[]; reaped: { failed: number; requeued: number }; processed: number }> {
  const { db } = getDb();
  const revived = await ensureRecurringJobs().catch((e) => {
    console.warn(`[jobs] ensureRecurringJobs failed: ${(e as Error).message}`);
    return [] as string[];
  });
  const reaped = await reapStaleJobs(db).catch((e) => {
    console.warn(`[jobs] reapStaleJobs failed: ${(e as Error).message}`);
    return { failed: 0, requeued: 0 };
  });
  const processed = await drainJobs(db, handlers, opts.maxMs ?? 25_000);
  return { revived, reaped, processed };
}
