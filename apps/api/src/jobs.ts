import { and, autopilots, campaigns, companies, consume, drainJobs, enqueue, eq, events, getDb, icps, inArray, integrations, jobs, leads, lists, monitors, ne, organizations, plays, reapStaleJobs, remainingPremiumBudget, savedSearches, searches, signalSubscriptions, sql as dsql, type Db, type Job, type JobHandler, visibilityPrompts, visits, webhooks } from "@prospex/db";
import { buildIcpWithAi, clampLeadQuery, crawlCompanyWebsite, createAiProviderForPlan, fetchPublic, findEmail, parseHttpUrl, redact, runLeadPipelineDetailed, scoreLeadRules, verifyEmail, type CompanyProfile, type IcpCriteria } from "@prospex/core";
import { env } from "./env.js";
import { orgMemberEmail } from "./lib/members.js";
import { safeHeaderText } from "./lib/sanitize.js";
import { hmacSign, hmacSignV2 } from "./lib/crypto.js";
import { clampSearchQuery } from "./lib/searchQuery.js";
import { webhookSecret } from "./lib/webhookSecret.js";
import { chargeNewLead, findExistingLead, pipelineLeadToInput, upsertCompany, upsertLead, verifierOf } from "./services/leads.js";
import { AiNotConfiguredError, knownBrands, sampleAcrossEngines } from "./services/visibility.js";
import { enrollEligibleLeads, sendStep, tickCampaign } from "./services/campaigns.js";
import { appsScriptOutputUrl, fetchAppsScriptOutput, syncLead } from "./services/integrations.js";
import { emitEvent } from "./lib/events.js";
import { aiForOrg } from "./lib/ai.js";
import { RETENTION, runRetention } from "./lib/privacyRetention.js";
import { onPlatformList } from "./lib/privacySuppression.js";

/** What an email lookup records when the only address it found is on the platform do-not-contact list. */
const DO_NOT_CONTACT_FOUND = "found an address whose owner has asked not to be contacted through Scout; it was not stored";
import { tryConsume, type QuotaOutcome } from "./lib/quota.js";
import { scanJobChanges } from "./services/jobChanges.js";
import { identifyVisit, openVisitorJob } from "./services/visitors.js";
import { refreshCompanySignals, runSubscription } from "./services/signals.js";
import { runMonitor } from "./services/monitors.js";
import { runAutopilot } from "./services/autopilot.js";
import { runPlay, tickPlays } from "./services/plays.js";
import { blockedByProvidersNote, plural } from "./services/notes.js";
import { sendMail } from "./lib/mailer.js";
import { purgeDueWorkspaces } from "./services/accountDeletion.js";
import { migrateLegacyLinkTokens } from "./lib/linkTokens.js";
import { errorLine } from "./lib/errors.js";

/** Org's plan, for plan-gated features. A missing org is treated as free. */
async function planOf(db: Db, orgId: string | null | undefined): Promise<string> {
  if (!orgId) return "free";
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  return org?.plan ?? "free";
}

/**
 * The AI engine a background job may use for this workspace: none when the workspace has
 * turned AI assistance off (or no longer exists), otherwise the one its plan pays for.
 * `createAiProvider()` picks Anthropic whenever it is configured, so every background job
 * gave free workspaces the paid model.
 */
async function aiFor(db: Db, orgId: string | null | undefined) {
  if (!orgId) return createAiProviderForPlan("free");
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { plan: true, settings: true } });
  return aiForOrg(org ?? { plan: "free" });
}

/**
 * The second lock on every handler that loads a row by an id from its payload.
 *
 * The routes that enqueue these jobs check ownership first, so no tenant can name another
 * org's id today. But the handlers then acted in the ROW's org without ever comparing it
 * with the org the job was enqueued for - so one forgotten ownership check at any future
 * enqueue site would have been a cross-tenant read or write (lead.verify charged and
 * rewrote another org's lead; webhook.deliver sent one org's event to another org's hook).
 * A job that names a row from a different org now changes nothing.
 *
 * Jobs with no org (system jobs, rows enqueued before orgId was recorded) are not judged.
 */
function foreign(job: Pick<Job, "orgId">, rowOrgId: string | null | undefined): boolean {
  return !!job.orgId && !!rowOrgId && rowOrgId !== job.orgId;
}
const ORG_MISMATCH = { skipped: "org mismatch" } as const;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** scheme://host of a URL: what may be said about a webhook address where others can read it. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** How much of a webhook endpoint's response is read before the rest is discarded. */
const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

/** Only orgs that are allowed to run: a suspended workspace's schedules must not fire. */
const orgIsActive = (col: unknown) => dsql`${col} IN (SELECT id FROM organizations WHERE status = 'active')`;

// verifierOf lives in services/leads.ts now (the verify route uses it too); re-exported
// here for existing importers.
export { verifierOf };

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
 * The self-perpetuating schedulers, and how long each waits before its next run.
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
  // Hourly: starts the plays whose own interval (6 hours to 30 days) has come round.
  "plays.tick": 3600_000,
  // Daily. A job change is a slow event and each check costs a provider call, so scanning
  // more often would spend credits to learn the same thing.
  "jobchanges.tick": 24 * 3600_000,
  "system.cleanup": 6 * 3600_000,
  // Daily: reminds the owners of a workspace that is about to be deleted, and deletes the
  // ones whose grace period has ended (services/accountDeletion.ts).
  "org.purge": 24 * 3600_000,
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
  // Same org as the lead, not just the same id: a reference written across a workspace
  // boundary before the ownership checks existed must not be followed.
  let company = lead.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, lead.companyId), eq(companies.orgId, lead.orgId)) }) : null;
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
      // An address whose owner asked never to be contacted through Scout is not stored -
      // not even in the note about what the lookup found.
      if (await onPlatformList(r.email, db)) {
        custom.emailLookup = { at: new Date().toISOString(), result: DO_NOT_CONTACT_FOUND };
        Object.assign(patch, { custom });
      } else if (await takenByOther(r.email)) {
        // The same "taken" check replaceInvalid has. Writing an address another lead
        // already holds hit the unique index, and the job failed three times over it.
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
    const listed = r.email ? await onPlatformList(r.email, db) : false;
    const usable = r.email && !listed && r.email.toLowerCase() !== lead.email.toLowerCase() && (r.status === "valid" || r.status === "catch_all" || r.status === "risky");
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
      custom.replacementResult = listed ? DO_NOT_CONTACT_FOUND : taken ? "found an address another lead already has" : r.email ? `only found ${r.status} candidates` : "no candidate found";
      Object.assign(patch, { custom });
    }
  }
  const icp = lead.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, lead.icpId), eq(icps.orgId, lead.orgId)) }) : null;
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

/**
 * Make this attempt the job's last. The queue retries a thrown job while
 * `attempts < maxAttempts`, reading both off the job object the handler was given - so a
 * failure that retrying cannot change (the endpoint answers every POST with the same
 * redirect) is thrown once, recorded as failed, and not repeated four more times.
 */
function noMoreAttempts(job: Pick<Job, "attempts" | "maxAttempts">) {
  job.attempts = Math.max(job.attempts, job.maxAttempts);
}

/**
 * Where a redirect from a webhook endpoint may be followed to (by repeating the POST), or null.
 *
 * 307 and 308 mean "repeat this exact request there". They are followed ONCE and only when
 * "there" is the address the customer typed in all but spelling: the same hostname, and
 * either the same origin (a trailing slash, a canonical path) or the plain-http address
 * upgraded to https on the default ports. Another host, another port, or a downgrade from
 * https is somewhere the customer did not address, and the event is not sent to it.
 *
 * 301 and 302 do not say "repeat the request", so they are followed in two cases only - the
 * two redirects an ordinary web server (nginx) adds by itself in front of a working endpoint:
 *   - http -> https and nothing else: same hostname, same path, same query, default ports;
 *   - a trailing slash added or removed and nothing else: same origin, same query.
 * Every such endpoint used to fail each event once and was switched off after ten, where the
 * code before that "delivered" (as a GET without the payload). Any other 301/302, and every
 * 303 ("fetch that with GET"), is not followed.
 */
function sameEndpointRedirect(posted: URL, status: number, location: string | null): URL | null {
  const repeat = status === 307 || status === 308;
  const moved = status === 301 || status === 302;
  if (!repeat && !moved) return null;
  if (!location) return null;
  let next: URL | null;
  try {
    // Resolved against the address without its credentials: a relative Location would
    // otherwise inherit them, and a URL carrying credentials is refused by the parser.
    next = parseHttpUrl(new URL(location, `${posted.origin}${posted.pathname}${posted.search}`).toString());
  } catch {
    return null;
  }
  if (!next || next.hostname !== posted.hostname) return null;
  const sameOrigin = next.protocol === posted.protocol && next.port === posted.port;
  const upgraded = posted.protocol === "http:" && next.protocol === "https:" && posted.port === "" && next.port === "";
  if (!sameOrigin && !upgraded) return null;
  if (moved) {
    if (next.search !== posted.search) return null;
    const samePath = next.pathname === posted.pathname;
    const slashOnly = next.pathname === `${posted.pathname}/` || posted.pathname === `${next.pathname}/`;
    // Exactly one of the two: the scheme alone changed, or the trailing slash alone did.
    if (upgraded ? !samePath : !slashOnly) return null;
  }
  // Basic-auth credentials in the configured URL belong to this endpoint: they go along.
  next.username = posted.username;
  next.password = posted.password;
  return next;
}

export const handlers: Record<string, JobHandler> = {
  /** Run a lead search end-to-end and persist results. payload: { searchId, query, icpId?, listId? } */
  "search.run": async (job, ctx) => {
    const { db } = ctx;
    const orgId = job.orgId!;
    const searchId = String(job.payload.searchId);
    const searchRow = await db.query.searches.findFirst({ where: eq(searches.id, searchId) });
    if (searchRow && foreign(job, searchRow.orgId)) return ORG_MISMATCH;
    // Only the pipeline INPUT comes from the payload, and only its known keys, bounded.
    // Every option below is built here.
    const query = clampLeadQuery(clampSearchQuery(job.payload.query));
    await db.update(searches).set({ status: "running" }).where(and(eq(searches.id, searchId), eq(searches.orgId, orgId)));
    // The ICP and the list are the job org's own or they are not used.
    const icpRow = job.payload.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, String(job.payload.icpId)), eq(icps.orgId, orgId)) }) : null;
    const icp = icpRow ?? null;
    const icpId = icpRow?.id ?? null;
    const listRow = job.payload.listId ? await db.query.lists.findFirst({ where: and(eq(lists.id, String(job.payload.listId)), eq(lists.orgId, orgId)) }) : null;
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
      if (listRow && ids.length) {
        const { listLeads } = await import("@prospex/db");
        for (const leadId of ids) await db.insert(listLeads).values({ listId: listRow.id, leadId }).onConflictDoNothing();
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
          clientClaim = { claimed: 0, ownedByAnotherClient: 0, error: redact((e as Error).message, { max: 200 }) };
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
      const providerNote = blockedByProviders ? blockedByProvidersNote(providerFailures, "This is not the same as nobody matching your criteria.") : null;

      await db
        .update(searches)
        .set({
          status: "done",
          resultCount: ids.length,
          error: truncated
            ? quotaStopped !== null
              ? `Stopped at your plan's limit: ${plural(results.length - ids.length, "more matching lead was", "more matching leads were")} found but not saved. ${quotaStopped}`
              : `Stopped early: ${plural(results.length - ids.length, "more matching lead was", "more matching leads were")} found but not saved, because usage could not be recorded (${chargeError}). This is a fault on our side, not your plan limit.`
            : providerNote,
          clientClaim: clientClaim ?? undefined,
          completedAt: new Date(),
        })
        .where(and(eq(searches.id, searchId), eq(searches.orgId, orgId)));
      await emitEvent(
        orgId,
        "search.completed",
        { searchId, results: ids.length, created, found: results.length, quotaTruncated: truncated, providerFailures },
        { type: "search", id: searchId },
      );
      return { results: ids.length, created, leadIds: ids, found: results.length, quotaTruncated: truncated, clientClaim };
    } catch (e) {
      // searches.error is shown to the customer: upstream text is masked before it is stored.
      await db.update(searches).set({ status: "failed", error: redact((e as Error).message, { max: 1000 }), completedAt: new Date() }).where(and(eq(searches.id, searchId), eq(searches.orgId, orgId)));
      throw e;
    }
  },

  /** Enrich one lead: crawl company site, find + verify email, rescore. payload: { leadId } */
  "lead.enrich": async (job, ctx) => {
    const { db } = ctx;
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)) });
    if (!lead) return { skipped: "missing" };
    if (foreign(job, lead.orgId)) return ORG_MISMATCH;
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
    // Before the charge and before any write: a lead from another org is not ours to bill or change.
    if (lead && foreign(job, lead.orgId)) return ORG_MISMATCH;
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
    if (foreign(job, icp.orgId)) return ORG_MISMATCH;
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
      for (const c of active) out[c.id] = await tickCampaign(c.id).catch((e) => ({ error: redact((e as Error).message, { max: 300 }) }));
      return out;
    });
  },

  "message.send": async (job, ctx) => {
    // The campaign must be the job org's own. sendStep then checks that the contact and the
    // step belong to that campaign, and the lead and the sender to its org.
    const cp = await ctx.db.query.campaigns.findFirst({ where: eq(campaigns.id, String(job.payload.campaignId)), columns: { id: true, orgId: true } });
    if (cp && foreign(job, cp.orgId)) return ORG_MISMATCH;
    // The attempt number reaches sendStep so a retried send is not billed twice.
    return sendStep(String(job.payload.campaignId), String(job.payload.contactId), String(job.payload.stepId), { attempt: job.attempts });
  },

  /**
   * Deliver one event to one webhook, signed.
   *
   * v1 hooks (created before signature v2) keep the legacy scheme and header format exactly:
   * `x-prospex-signature: <hex sha256(secret + "." + ts + "." + body)>`. v2 hooks (new and
   * rotated) are signed with a real HMAC-SHA256 over the same `${ts}.${body}` and send
   * `x-prospex-signature: v2=<hex>`.
   */
  "webhook.deliver": async (job, ctx) => {
    const { db } = ctx;
    const hook = await db.query.webhooks.findFirst({ where: eq(webhooks.id, String(job.payload.webhookId)) });
    const ev = await db.query.events.findFirst({ where: eq(events.id, String(job.payload.eventId)) });
    if (!hook || !ev || !hook.active) return { skipped: true };
    // An event is only ever delivered to a hook of the SAME org. Loaded independently by id,
    // any hook could be paired with any event - one org's data posted to another org's URL.
    if (hook.orgId !== ev.orgId || foreign(job, hook.orgId)) return ORG_MISMATCH;
    const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.data, entity: { type: ev.entityType, id: ev.entityId } });
    const ts = String(Date.now());
    // A hook's address is often itself the credential (Slack and Zapier style: the secret is
    // the path). Log lines and the job's stored error name the origin only; the hook's id is
    // what identifies it.
    const safeUrl = originOf(hook.url);
    /** Any text that may echo the address (a network error can) with the address cut to its origin. */
    const withoutHookPath = (text: string) => {
      let out = hook.url.length > safeUrl.length ? text.split(hook.url).join(safeUrl) : text;
      // Also the path on its own, however the rest of the address was spelled in the message.
      try {
        const u = new URL(hook.url);
        const path = `${u.pathname}${u.search}`;
        if (path.length >= 6) out = out.split(path).join("");
        if (u.pathname.length >= 6) out = out.split(u.pathname).join("");
      } catch {
        /* not a URL: nothing more to strip */
      }
      return out;
    };

    /** Record a delivery that will not be retried against the hook, and disable it past the limit. */
    const countFailure = async (lastError: string) => {
      const [row] = await db.update(webhooks).set({ failures: dsql`${webhooks.failures} + 1` }).where(eq(webhooks.id, hook.id)).returning({ failures: webhooks.failures });
      if ((row?.failures ?? 0) >= WEBHOOK_DISABLE_AFTER) {
        const [disabled] = await db.update(webhooks).set({ active: false }).where(and(eq(webhooks.id, hook.id), eq(webhooks.active, true))).returning({ id: webhooks.id });
        if (disabled) {
          ctx.log(`webhook ${hook.id} disabled after ${row!.failures} consecutive failed deliveries`);
          console.warn(`[webhooks] disabled ${hook.id} (${safeUrl}) for org ${hook.orgId}: ${row!.failures} consecutive deliveries failed`);
          // Recorded where the org can see it. The hook is inactive now, so this event
          // is not delivered to it.
          // The event goes to the workspace's OTHER webhooks and into its event feed. A hook's
          // address is often itself a credential (a token in the path or query, a password
          // in the userinfo), so only its origin is named; `webhookId` identifies the hook.
          await emitEvent(hook.orgId, "webhook.disabled", { webhookId: hook.id, url: originOf(hook.url), consecutiveFailures: row!.failures, lastError }).catch(() => {});
        }
      }
    };

    let outcome: { ok: boolean; status: number; statusText: string };
    let refused = false;
    /** A redirect we will not follow: the same answer every time, so it is not retried. */
    let redirected = false;
    /** Set when the delivery counted as made through a redirect, for the job result. */
    let via: string | undefined;
    try {
      // The hook's own secret and scheme. A hook with no usable secret cannot be signed, and
      // an unsigned (or empty-key) delivery is worse than a failed one.
      const secret = webhookSecret(hook, { upgrade: true });
      const signature = hook.signatureVersion >= 2 ? `v2=${hmacSignV2(secret, `${ts}.${body}`)}` : hmacSign(secret, `${ts}.${body}`);
      // A customer-supplied URL, called from inside our network, carrying event data.
      // fetchPublic refuses a private address both by name and at connect time (so a public
      // name that resolves to 10.x is refused too), and with maxRedirects: 0 a 3xx is handed
      // back instead of followed - the payload is never re-sent to wherever a redirect points.
      const post = (url: string) =>
        fetchPublic(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-prospex-signature": signature, "x-prospex-timestamp": ts, "x-prospex-event": ev.type },
          body,
          timeoutMs: 10_000,
          maxRedirects: 0,
          maxBytes: WEBHOOK_MAX_RESPONSE_BYTES,
          allowUserinfo: true,
          noDefaultHeaders: true,
        });
      const NOT_FOLLOWED = "redirects are not followed - set the webhook to the final address of your endpoint";
      const res = await post(hook.url);
      if (!res) {
        refused = true;
        outcome = { ok: false, status: 0, statusText: "not a public address" };
      } else {
        // The response body is never needed; it is dropped rather than buffered.
        await res.body?.cancel().catch(() => {});
        if (res.status >= 300 && res.status < 400) {
          /**
           * A redirect is not followed with the event - with two exceptions, each of which
           * is still the endpoint the customer typed:
           *
           *  - Google Apps Script. Its web apps answer EVERY successful POST with a 302 to
           *    script.googleusercontent.com: the script has already run. Treating that as a
           *    failure retried it five times - five rows in the customer's sheet per event -
           *    and then switched their webhook off. The POST is delivered; the output is
           *    fetched with one payload-free GET confined to Google's script hosts (the same
           *    step the Sheets integration takes), and whatever that GET does, the event is
           *    not sent again.
           *  - 307/308 to the same hostname (http -> https, a trailing slash): "repeat this
           *    request there". The POST is replayed once, through the same guarded fetch.
           *    A 301/302 gets the same treatment only when it is exactly the http -> https
           *    upgrade or exactly a trailing slash (see sameEndpointRedirect).
           *
           * Anything else stays a failed delivery, and is not retried: the endpoint will
           * give the same answer every time.
           */
          const posted = parseHttpUrl(hook.url, { allowUserinfo: true });
          const location = res.headers.get("location");
          const scriptOutput = posted ? appsScriptOutputUrl(posted, res.status, location) : null;
          const replayAt = posted ? sameEndpointRedirect(posted, res.status, location) : null;
          if (scriptOutput) {
            const out = await fetchAppsScriptOutput(scriptOutput, 10_000).catch(() => null);
            await out?.body?.cancel().catch(() => {});
            via = `apps script (${out ? `output HTTP ${out.status}` : "output not fetched"})`;
            outcome = { ok: true, status: res.status, statusText: "delivered to Google Apps Script" };
          } else if (replayAt) {
            const again = await post(replayAt.toString());
            if (!again) {
              redirected = true;
              outcome = { ok: false, status: res.status, statusText: `redirected (HTTP ${res.status}) to an address that is not public; ${NOT_FOLLOWED}` };
            } else {
              await again.body?.cancel().catch(() => {});
              if (again.status >= 300 && again.status < 400) {
                redirected = true;
                outcome = { ok: false, status: again.status, statusText: `redirected twice; ${NOT_FOLLOWED}` };
              } else {
                via = `HTTP ${res.status} to the same host`;
                outcome = { ok: again.ok, status: again.status, statusText: again.statusText };
              }
            }
          } else {
            redirected = true;
            outcome = { ok: false, status: res.status, statusText: NOT_FOLLOWED };
          }
        } else outcome = { ok: res.ok, status: res.status, statusText: res.statusText };
      }
    } catch (e) {
      outcome = { ok: false, status: 0, statusText: redact(withoutHookPath((e as Error).message ?? ""), { max: 200 }) };
    }

    if (refused) {
      // Retrying cannot help, so this attempt is final: counted against the hook (which is
      // how the org learns of it, through webhook.disabled) and not thrown into a retry.
      await countFailure("the URL does not point at a public address");
      return { skipped: `${safeUrl} is not a public address` };
    }
    if (redirected) {
      // Deterministic: the endpoint answers this way every time, so four more attempts would
      // only be four more requests. Counted against the hook once and failed for good, with
      // a message that says what to change.
      await countFailure(`${outcome.status} ${outcome.statusText}`);
      noMoreAttempts(job);
      throw new Error(`webhook ${safeUrl} → ${outcome.status} ${outcome.statusText}`);
    }
    if (!outcome.ok) {
      // Only a delivery that has used up its retries counts against the hook. Counting
      // every attempt meant four events during one short outage (5 attempts each) disabled
      // a customer's webhook for good. Ten events that finally failed in a row is a dead
      // endpoint; a blip is not.
      if (job.attempts >= job.maxAttempts) await countFailure(`${outcome.status} ${outcome.statusText}`);
      throw new Error(`webhook ${safeUrl} → ${outcome.status} ${outcome.statusText}`);
    }
    if (hook.failures) await db.update(webhooks).set({ failures: 0 }).where(eq(webhooks.id, hook.id));
    return { status: outcome.status, ...(via ? { via } : {}) };
  },

  /** Push a lead to a CRM integration. payload: { integrationId, leadId } */
  "integration.sync": async (job, ctx) => {
    const { db } = ctx;
    const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.id, String(job.payload.integrationId)), eq(integrations.status, "active")) });
    if (!integ) return { skipped: "integration missing/inactive" };
    if (foreign(job, integ.orgId)) return ORG_MISMATCH;
    // The lead must be the integration org's own before its data is pushed to their CRM.
    const syncLeadRow = await db.query.leads.findFirst({ where: eq(leads.id, String(job.payload.leadId)), columns: { id: true, orgId: true } });
    if (syncLeadRow && syncLeadRow.orgId !== integ.orgId) return ORG_MISMATCH;
    const r = await syncLead(integ, String(job.payload.leadId));
    if (!r.ok) throw new Error(redact(r.error ?? "sync failed", { max: 500 }));
    return r;
  },

  /** Bulk enqueue enrich for many leads. payload: { leadIds } */
  "leads.bulk_enrich": async (job, ctx) => {
    const all = Array.isArray(job.payload.leadIds) ? (job.payload.leadIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    // Only leads of the org this job was enqueued for are fanned out. Handed any id, this
    // used to queue an enrichment of another org's lead under the caller's org.
    let ids = all;
    if (job.orgId && all.length) {
      const own = new Set<string>();
      for (let i = 0; i < all.length; i += 500) {
        const rows = await ctx.db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, job.orgId), inArray(leads.id, all.slice(i, i + 500).filter(isUuid))));
        for (const r of rows) own.add(r.id);
      }
      ids = all.filter((id) => own.has(id));
    }
    for (const id of ids) await enqueue(ctx.db, "lead.enrich", { leadId: id }, { orgId: job.orgId });
    return { enqueued: ids.length, ...(ids.length !== all.length ? { skippedOrgMismatch: all.length - ids.length } : {}) };
  },

  // ── v2 ──
  "visit.identify": async (job, ctx) => {
    // The raw IP is needed to identify the visit and for nothing after. It is dropped from
    // the job row once identification is done - or once the last attempt has failed - so
    // the jobs table does not keep a log of visitors' addresses.
    const forget = () => ctx.db.execute(dsql`UPDATE jobs SET payload = payload - 'sealed' - 'ip' - 'identify' WHERE id = ${job.id}`).catch(() => {});
    const visitId = String(job.payload.visitId);
    const visit = isUuid(visitId) ? await ctx.db.query.visits.findFirst({ where: eq(visits.id, visitId), columns: { id: true, orgId: true } }) : null;
    if (visit && foreign(job, visit.orgId)) {
      await forget();
      return ORG_MISMATCH;
    }
    // The address (and anything identify() said) is carried encrypted. Jobs queued by the
    // release before this one carry it in clear; both are read, and both are scrubbed.
    const sealed = openVisitorJob(job.payload);
    if (!sealed.ip) {
      // Nothing readable is left: already scrubbed, or sealed under a key this server no
      // longer holds. Retrying cannot bring the address back.
      await forget();
      return { skipped: "the visitor's address is no longer available for this visit" };
    }
    try {
      const r = await identifyVisit(String(job.payload.visitId), sealed.ip, sealed.identify);
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
    if (foreign(job, co.orgId)) return ORG_MISMATCH;
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
    if (foreign(job, sub.orgId)) return ORG_MISMATCH;
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
          ctx.log(`job change scan failed for ${org.id}: ${errorLine(e)}`);
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
    if (foreign(job, m.orgId)) return ORG_MISMATCH;
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
    if (foreign(job, prompt.orgId)) return ORG_MISMATCH;
    const others = await knownBrands(db, prompt.orgId);
    // Every configured engine, not just the priority winner: engines disagree, so one of
    // them is not an answer to "what does AI say about us".
    // The plan decides which engines are sampled. Without it the scheduled path defaulted
    // to the free-tier set for paying orgs - and the manual path, which passed it, did not
    // agree with the scheduled one.
    let r: Awaited<ReturnType<typeof sampleAcrossEngines>>;
    try {
      r = await sampleAcrossEngines(db, prompt.orgId, prompt, { others, plan: await planOf(db, prompt.orgId) });
    } catch (e) {
      // No engine configured is a setup state, not a failure: retrying cannot fix it, and a
      // failed job every hour per prompt buried real errors. Skip with the reason.
      if (e instanceof AiNotConfiguredError) return { skipped: true, note: e.message };
      throw e;
    }
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
    if (foreign(job, ap.orgId)) return ORG_MISMATCH;
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
    if (foreign(job, ss.orgId)) return ORG_MISMATCH;
    // The stored query is free jsonb written by the tenant (and, for older rows, never
    // validated). It is re-clamped every time it runs: known keys only, limit <= 200,
    // companyDomains <= 50, ten of each list. Only the pipeline INPUT comes from it.
    const stored = clampSearchQuery(ss.query);
    const input = clampLeadQuery({ ...stored, limit: stored.limit ?? 25 });
    // The list new leads are added to must be this org's own.
    const ssList = ss.listId ? await db.query.lists.findFirst({ where: and(eq(lists.id, ss.listId), eq(lists.orgId, ss.orgId)), columns: { id: true } }) : null;
    // Charged once per run, not once per retry, and a database fault is reported as a
    // database fault rather than as the customer's plan limit. lastRunAt is stamped below
    // either way, so misfiling this silently cancelled that day's alert digest.
    if (job.attempts <= 1) {
      const charge = await tryConsume(db, ss.orgId, "searches", 1);
      if (!charge.ok && charge.reason === "quota") return { skipped: "quota", detail: charge.message };
      if (!charge.ok) throw new Error(`could not record search usage: ${charge.message}`);
    }
    const providerBudget = await remainingPremiumBudget(db, ss.orgId);
    // Every option is built here, from server configuration and the org's plan.
    const { leads: results, providerFailures } = await runLeadPipelineDetailed(input, { ai: await aiFor(db, ss.orgId), verify: verifyOpts(), maxProviderLeads: providerBudget });
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
          stoppedBecause = charge.reason === "quota" ? `Stopped early: ${charge.message}` : `Stopped: could not record lead usage (${charge.message})`;
          break;
        }
      }
      const { lead, created } = await upsertLead(ss.orgId, pipelineLeadToInput(r, { tags: [`saved:${ss.id.slice(0, 8)}`] }), { fillOnly: true });
      if (created) {
        fresh++;
        freshIds.push(lead.id);
        names.push(`${lead.fullName ?? ""} - ${lead.title ?? ""}`);
        if (ssList) {
          const { listLeads } = await import("@prospex/db");
          await db.insert(listLeads).values({ listId: ssList.id, leadId: lead.id }).onConflictDoNothing();
        }
      }
    }
    // "0 new" because the sources could not answer is not "nothing new matched". The saved
    // search row has no note column, so the reason goes in the job result (shown by the
    // admin job view) and the digest says it instead of staying silent.
    const blocked = results.length === 0 && providerFailures.length > 0;
    const note = blocked ? blockedByProvidersNote(providerFailures, "This is not the same as nothing new matching.") : stoppedBecause;
    // A saved search made for a client delivers its new leads to that client, the same way a
    // one-off search does - otherwise every daily re-run would pile leads into the pool.
    // claimSearchLeads re-checks the client (deleted/archived) and never steals another
    // client's lead.
    const ssClientId = stored.clientId;
    let clientClaim: Awaited<ReturnType<typeof import("./services/clients.js").claimSearchLeads>> | null = null;
    if (typeof ssClientId === "string" && freshIds.length) {
      try {
        const { claimSearchLeads } = await import("./services/clients.js");
        clientClaim = await claimSearchLeads(db, ss.orgId, ssClientId, freshIds);
      } catch (e) {
        clientClaim = { claimed: 0, ownedByAnotherClient: 0, skipped: `error: ${redact((e as Error).message, { max: 200 })}` };
      }
    }
    await db.update(savedSearches).set({ lastRunAt: new Date(), lastNewCount: fresh }).where(eq(savedSearches.id, ss.id));
    // Platform mail goes to people in the workspace only. Rows saved before that rule existed
    // can still carry an outside address; those are not mailed.
    const alertTo = ss.alert && ss.alertEmail ? await orgMemberEmail(ss.orgId, ss.alertEmail) : null;
    const ssName = safeHeaderText(ss.name, 80, "your saved search");
    if (ss.alert && fresh > 0 && alertTo) await sendMail(null, { from: env.mailFrom, to: alertTo, subject: `${plural(fresh, "new lead")} for "${ssName}"`, text: `Scout found ${plural(fresh, "new lead")} matching "${ssName}":\n\n${names.join("\n")}${stoppedBecause ? `\n\n${stoppedBecause}` : ""}\n\nOpen ${env.appUrl}/leads?tag=saved:${ss.id.slice(0, 8)}` });
    else if (ss.alert && blocked && alertTo) await sendMail(null, { from: env.mailFrom, to: alertTo, subject: `Could not check "${ssName}" today`, text: `${note}\n\nThe search will run again tomorrow.` });
    return { results: results.length, fresh, providerFailures, note, clientClaim };
  },

  /**
   * Run one play and put what it finds in the review queue. payload: { playId, runId, charged? }
   *
   * Creates no lead unless the play itself is set to approve automatically. The search unit
   * was charged by whoever queued the run (`charged`), and is given back when the run could
   * not look at anything. Enqueued with one attempt: see POST /v1/plays/:id/run.
   */
  "play.run": async (job, ctx) => {
    const playId = job.payload.playId;
    const runId = job.payload.runId;
    if (!isUuid(playId) || !isUuid(runId)) return { skipped: "bad payload" };
    const play = await ctx.db.query.plays.findFirst({ where: eq(plays.id, playId) });
    if (!play) return { skipped: "missing" };
    if (foreign(job, play.orgId)) return ORG_MISMATCH;
    return runPlay(play, runId, { log: ctx.log, charged: job.payload.charged === true });
  },

  /** Scheduler: hourly, start the plays that are due (active plays of active workspaces, at most 50 a tick). */
  "plays.tick": async (job, ctx) => {
    return withReschedule(ctx.db, job, "plays.tick", () => tickPlays());
  },

  /**
   * Put approved people who had no usable address into the play's campaign, once an address
   * has been looked for. payload: { playId, campaignId, leadIds (<= 200), lookedUp?, waits? }
   *
   * The lookup is the ordinary `lead.enrich` job, one per lead, so each is metered, retried
   * and timed like any other enrichment. This job queues those, comes back a little later,
   * and enrols whoever has an address by then through the same filters as the enroll route.
   * A lead whose address was not found is simply not enrolled, and is counted in the result.
   * Enrolling never starts a campaign.
   */
  "play.enroll": async (job, ctx) => {
    const { db } = ctx;
    const playId = job.payload.playId;
    const campaignId = job.payload.campaignId;
    if (!isUuid(playId) || !isUuid(campaignId)) return { skipped: "bad payload" };
    const play = await db.query.plays.findFirst({ where: eq(plays.id, playId), columns: { id: true, orgId: true } });
    if (!play) return { skipped: "missing" };
    if (foreign(job, play.orgId)) return ORG_MISMATCH;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, play.orgId), columns: { status: true } });
    if (!org || org.status !== "active") return { skipped: "organization not active" };
    // The campaign and the leads are the play org's own, not merely rows with those ids.
    const campaign = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, campaignId), eq(campaigns.orgId, play.orgId)) });
    if (!campaign) return { skipped: "campaign missing" };
    const asked = [...new Set((Array.isArray(job.payload.leadIds) ? (job.payload.leadIds as unknown[]) : []).filter(isUuid))].slice(0, 200);
    const own = asked.length
      ? await db.select({ id: leads.id, email: leads.email, firstName: leads.firstName, lastName: leads.lastName, companyId: leads.companyId }).from(leads).where(and(eq(leads.orgId, play.orgId), inArray(leads.id, asked)))
      : [];
    const ids = own.map((l) => l.id);
    if (!ids.length) return { enrolled: 0, asked: asked.length };
    const later = (payload: Record<string, unknown>) => enqueue(db, "play.enroll", { playId, campaignId, leadIds: ids, ...payload }, { orgId: play.orgId, priority: 1, runAt: new Date(Date.now() + 2 * 60_000) });
    if (job.payload.lookedUp !== true) {
      // Only leads an enrichment can find an address for: a name and a company to look at.
      const lookups = own.filter((l) => !l.email && l.companyId && l.firstName && l.lastName);
      if (lookups.length) {
        for (const l of lookups) await enqueue(db, "lead.enrich", { leadId: l.id }, { orgId: play.orgId });
        await later({ lookedUp: true, waits: 0 });
        return { lookupsQueued: lookups.length, toEnroll: ids.length };
      }
    } else {
      const waits = Number(job.payload.waits) || 0;
      const [{ n: open }] = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(jobs)
        .where(and(eq(jobs.orgId, play.orgId), eq(jobs.type, "lead.enrich"), inArray(jobs.status, ["queued", "running"]), inArray(dsql`${jobs.payload}->>'leadId'`, ids)));
      // Still looking: come back, at most ten times (twenty minutes), then enrol whoever is ready.
      if (Number(open) > 0 && waits < 10) {
        await later({ lookedUp: true, waits: waits + 1 });
        return { waitingForLookups: Number(open) };
      }
    }
    const r = await enrollEligibleLeads(campaign, ids);
    return { enrolled: r.enrolled, withoutAddress: r.skippedNoEmail, invalidAddress: r.skippedInvalidEmail, ownedByAnotherClient: r.skippedOtherClient };
  },

  /**
   * Workspace deletion, once a day: remind the owners of workspaces about to be deleted and
   * delete the ones that are due. The rules (a reminder always precedes a deletion by a day,
   * a cancelled request is never acted on) live in services/accountDeletion.ts.
   */
  "org.purge": async (job, ctx) => {
    const { db } = ctx;
    return withReschedule(db, job, "org.purge", async () => {
      const r = await purgeDueWorkspaces();
      if (r.purged.length || r.reminded.length || r.failed.length) ctx.log(`org.purge: ${r.purged.length} deleted, ${r.reminded.length} reminded, ${r.failed.length} failed`);
      // Counts only: the ids of deleted workspaces are on the audit trail, not in a job result.
      return { purged: r.purged.length, reminded: r.reminded.length, waiting: r.waiting.length, failed: r.failed.length };
    });
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
      // The numbers are RETENTION's (lib/privacyRetention.ts), which the Privacy Policy states.
      await db
        .delete(jobs)
        .where(and(eq(jobs.status, "done"), ne(jobs.type, "search.run"), lt(jobs.updatedAt, new Date(Date.now() - RETENTION.finishedJobDays * 86_400_000))));
      // Failed jobs were never pruned at all and grew without bound. They are worth keeping
      // longer than successes, because they are what someone reads when diagnosing.
      await db.execute(sql`DELETE FROM jobs WHERE status = 'failed' AND updated_at < now() - ${sql.raw(`interval '${RETENTION.failedJobDays} days'`)}`);
      await db.execute(sql`DELETE FROM events WHERE created_at < now() - ${sql.raw(`interval '${RETENTION.eventDays} days'`)}`);
      // Everything else with a lifetime: visitor rows, sign-in attempts, expired tokens, the
      // audit log - and the copies a deleted lead left behind. Each step is time-limited and
      // reports rather than throws, so one slow table never stops the housekeeping.
      const retention = await runRetention(db).catch((e) => {
        console.warn(`[jobs] the retention pass did not run: ${(e as Error).name}`);
        return null;
      });
      // Link tokens still in plaintext are moved out of it at server start; repeated here
      // for deployments with no long-running server process (the job runner endpoint) and
      // for rows an older instance wrote during a rolling deploy. Does nothing once done.
      await migrateLegacyLinkTokens().catch((e) => console.warn(`[jobs] could not finish moving link tokens out of plaintext: ${(e as Error).name}`));
      return retention ? { retention } : {};
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
    console.warn(`[jobs] ensureRecurringJobs failed: ${errorLine(e)}`);
    return [] as string[];
  });
  const reaped = await reapStaleJobs(db).catch((e) => {
    console.warn(`[jobs] reapStaleJobs failed: ${errorLine(e)}`);
    return { failed: 0, requeued: 0 };
  });
  const processed = await drainJobs(db, handlers, opts.maxMs ?? 25_000);
  return { revived, reaped, processed };
}
