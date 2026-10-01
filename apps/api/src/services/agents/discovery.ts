import { and, agentRuns, desc, eq, getDb, leads, organizations, remainingPremiumBudget, scrapedLeads, type Db } from "@prospex/db";
import { createAiProviderForPlan, runLeadPipelineDetailed, scoreLeadRules, type IcpCriteria, type PipelineLead } from "@prospex/core";
import { chargeNewLead, upsertLead } from "../leads.js";
import { tryConsume } from "../../lib/quota.js";
import { emitEvent } from "../../lib/events.js";
import { env } from "../../env.js";

/**
 * The scheduled discovery agent.
 *
 * WHAT THIS REPLACED, and why it matters more than what it does now.
 *
 * The first version of this file asked a model to "simulate finding LinkedIn profiles" and
 * to "create realistic but fictional profiles", then wrote those invented people - invented
 * names, invented companies, invented EMAIL ADDRESSES - into `scraped_leads`, stamped with
 * `intentScore: Math.random() * 0.5 + 0.5`. A GitHub Action ran it every morning.
 *
 * Nothing downstream could tell those rows from real ones. A customer working them would
 * email addresses that either bounce - destroying the sender reputation that
 * email/sendingHealth.ts exists to protect - or reach a real person who happens to own a
 * guessed address. The intent score, which feeds lead ranking, was a random number.
 *
 * This codebase's one rule is that a failure must never be indistinguishable from a result.
 * Manufacturing results from nothing is that rule inverted and automated on a cron.
 *
 * So this agent runs the discovery pipeline the product already has. Every lead it stores
 * came back from a search engine, a licensed data provider, or a page that was actually
 * fetched; every email was found and verified by the same code the rest of Scout uses; the
 * score comes from the org's own ICP criteria. When the pipeline finds nobody, this agent
 * records that it found nobody - and, crucially, says whether that was an empty answer or a
 * provider that could not answer.
 */

export interface DiscoveryOptions {
  /** ICP to score against, and to take criteria from when the query is left open. */
  icpId?: string | null;
  /** Hard ceiling on leads stored in one run. */
  limit?: number;
  /** Store nothing; report what would have happened. Used by the dry-run route. */
  preview?: boolean;
}

export interface DiscoveryResult {
  runId: string;
  /** "quota": not run because the workspace's searches quota is spent (HTTP 402), distinct
   * from "blocked" (every data source refused us). */
  status: "completed" | "failed" | "blocked" | "quota";
  query: string;
  /** Leads the pipeline returned, before quota and dedupe. */
  found: number;
  /** Rows written. */
  created: number;
  /** Already present, so not billed and not duplicated. */
  duplicates: number;
  /** Providers that could not answer. Non-empty with found === 0 means an outage, not absence. */
  providerFailures: { provider: string; message: string }[];
  /** Set when the plan's lead quota, not the data, ended the run. */
  quotaStopped?: string;
  error?: string;
  /** Why an empty result was empty, in words, for the run log. */
  note?: string;
}

/**
 * Run one discovery pass for an org.
 *
 * `query` is a plain-language description of who to find, the same input the Search page
 * takes. When an ICP is given its criteria drive the scoring, so what this agent calls a
 * good lead is what the customer defined as one.
 */
export async function runDiscoveryAgent(orgIdValue: string, query: string, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const { db } = getDb();
  const limit = Math.min(opts.limit ?? 25, 200);

  const [run] = await db
    .insert(agentRuns)
    .values({ orgId: orgIdValue, agentType: "discovery", status: "running", startedAt: new Date() })
    .returning();

  const finish = async (patch: Partial<DiscoveryResult> & { status: DiscoveryResult["status"] }, rows: number, note?: string) => {
    await db
      .update(agentRuns)
      .set({ status: patch.status, rowsCreated: rows, error: patch.error ?? note ?? null, completedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
  };

  try {
    const icp = opts.icpId
      ? await db.query.icps.findFirst({ where: (t, { eq: e, and: a }) => a(e(t.id, opts.icpId!), e(t.orgId, orgIdValue)) })
      : null;
    const criteria = (icp?.criteria as IcpCriteria | undefined) ?? undefined;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgIdValue) });

    // A run is a search, and is metered as one - it was the one discovery path that cost
    // nothing against the searches quota. A preview stores nothing and is not charged.
    if (!opts.preview) {
      const charge = await tryConsume(db, orgIdValue, "searches", 1);
      if (!charge.ok) {
        const note = charge.reason === "quota" ? `Not run: ${charge.message}` : `Not run: could not record search usage (${charge.message})`;
        // The run row keeps "blocked" (run history already shows it as "did not run"); the
        // result says "quota" so the route can answer 402 rather than "providers unavailable".
        await finish({ status: charge.reason === "quota" ? "blocked" : "failed", error: note }, 0);
        return { runId: run.id, status: charge.reason === "quota" ? "quota" : "failed", query, found: 0, created: 0, duplicates: 0, providerFailures: [], error: charge.reason === "error" ? note : undefined, quotaStopped: charge.reason === "quota" ? charge.message : undefined, note };
      }
    }

    const { leads: found, providerFailures } = await runLeadPipelineDetailed(
      { query, limit, findEmails: true },
      {
        // Plan-gated engine, and the paid-provider budget passed in so the provider call
        // itself is capped. Without it a free workspace drew unlimited Apollo leads here.
        ai: createAiProviderForPlan(org?.plan ?? "free"),
        icp: criteria,
        verify: { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey },
        maxProviderLeads: await remainingPremiumBudget(db, orgIdValue),
      },
    );

    // Nothing came back AND something refused us. That is a fact about our providers, not
    // about the customer's market, and it must never be filed as "no matches".
    if (found.length === 0 && providerFailures.length > 0) {
      const note = `No leads returned, and ${providerFailures.length} data source(s) could not answer: ${providerFailures
        .map((f) => `${f.provider} - ${f.message}`)
        .join("; ")}. This is not the same as nobody matching the query.`;
      await finish({ status: "blocked", error: note }, 0);
      return { runId: run.id, status: "blocked", query, found: 0, created: 0, duplicates: 0, providerFailures, note };
    }

    if (opts.preview) {
      await finish({ status: "completed" }, 0, `preview only: ${found.length} would have been stored`);
      return { runId: run.id, status: "completed", query, found: found.length, created: 0, duplicates: 0, providerFailures, note: "preview only - nothing stored" };
    }

    let created = 0;
    let duplicates = 0;
    let quotaStopped: string | undefined;

    for (const lead of found) {
      const stored = await storeDiscoveredLead(db, orgIdValue, lead, { icpId: icp?.id ?? null, criteria, runId: run.id, query });
      // Counted BEFORE the quota check. A lead that tripped the limit was still written -
      // charging happens after the row exists, so that a rediscovery costs nothing - and an
      // earlier version broke out without counting it. The run then reported one fewer
      // lead than it had stored, and told the customer a lead had been discarded that was
      // in fact sitting in their list.
      if (stored.created) created++;
      else duplicates++;
      if (stored.quotaStopped) {
        quotaStopped = stored.quotaStopped;
        break;
      }
    }

    const notSaved = found.length - created - duplicates;
    const note = quotaStopped
      ? notSaved > 0
        ? `Stopped at your plan's limit: ${notSaved} more were found but not saved. ${quotaStopped}`
        : `Stopped at your plan's limit after saving ${created}. ${quotaStopped}`
      : found.length === 0
        ? providerFailures.length
          ? `Nobody matched, and ${providerFailures.length} source(s) could not answer: ${providerFailures.map((f) => `${f.provider} - ${f.message}`).join("; ")}.`
          : "Every configured source answered, and nobody matched this query."
        : undefined;

    await finish({ status: "completed" }, created, note);
    // Best-effort, and deliberately outside the try below. emitEvent writes rows and can
    // enqueue webhook jobs, so it can throw - and it used to do so INSIDE the try, where
    // the catch rewrote a run that had genuinely completed to `failed, rows_created: 0`
    // while its leads sat committed in the database. A notification failing is not the run
    // failing, and must not be able to say that it was.
    await emitEvent(orgIdValue, "agent.discovery_completed", { runId: run.id, query, found: found.length, created, duplicates, quotaStopped }, { type: "agent_run", id: run.id }).catch(() => {});

    return { runId: run.id, status: "completed", query, found: found.length, created, duplicates, providerFailures, quotaStopped, note };
  } catch (e) {
    const error = (e as Error).message?.slice(0, 500) ?? "unknown error";
    await finish({ status: "failed", error }, 0);
    return { runId: run.id, status: "failed", query, found: 0, created: 0, duplicates: 0, providerFailures: [], error };
  }
}

/**
 * Store one discovered lead, with its provenance.
 *
 * The lead goes into `leads` - the real table - so it inherits everything the product
 * already does: dedupe by email and LinkedIn URL, org scoping, ICP scoring, campaign
 * enrolment, CRM sync, the quota ledger.
 *
 * `scraped_leads` becomes the provenance record rather than a second, parallel copy of the
 * lead. One row per (lead, run) saying where this lead came from and what the run was
 * looking for - which is what makes per-source performance answerable at all, and what
 * lets a lead of doubtful origin be found again later.
 */
async function storeDiscoveredLead(
  db: Db,
  orgIdValue: string,
  lead: PipelineLead,
  ctx: { icpId: string | null; criteria?: IcpCriteria; runId: string; query: string },
): Promise<{ created: boolean; quotaStopped?: string }> {
  const score = ctx.criteria
    ? scoreLeadRules(
        {
          title: lead.title,
          location: lead.location,
          country: lead.company?.country,
          emailStatus: lead.emailStatus,
          company: lead.company ? { name: lead.company.name, industry: lead.company.industry, size: lead.company.size, description: lead.company.description, techStack: lead.company.techStack } : null,
        },
        ctx.criteria,
      )
    : null;

  const { lead: row, created } = await upsertLead(orgIdValue, {
    firstName: lead.firstName,
    lastName: lead.lastName,
    fullName: lead.fullName,
    title: lead.title,
    email: lead.email,
    emailStatus: lead.emailStatus,
    emailConfidence: lead.emailConfidence,
    emailVerifiedBy: (lead as { emailVerifiedBy?: string }).emailVerifiedBy,
    linkedinUrl: lead.linkedinUrl,
    location: lead.location,
    country: lead.company?.country,
    companyName: lead.company?.name ?? lead.companyName,
    companyDomain: lead.companyDomain,
    icpId: ctx.icpId ?? undefined,
    score: score?.score,
    scoreReasons: score?.reasons,
    source: lead.source ?? "agent:discovery",
    tags: ["agent", `run:${ctx.runId.slice(0, 8)}`],
  }, { fillOnly: true });

  // Provenance, always - including for a lead we already had, because knowing that a source
  // keeps rediscovering the same people is itself a measurement of that source.
  await db
    .insert(scrapedLeads)
    .values({
      orgId: orgIdValue,
      leadId: row.id,
      // `name` is NOT NULL, and join() never returns nullish - so the fallback has to be on
      // the joined string being empty, not on it being null.
      name: row.fullName || [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "unknown",
      title: lead.title ?? null,
      company: lead.company?.name ?? lead.companyName ?? null,
      email: lead.email ?? null,
      linkedinUrl: lead.linkedinUrl ?? null,
      location: lead.location ?? null,
      // Only what was actually observed. No invented industry, no random intent score.
      enrichedData: {
        runId: ctx.runId,
        query: ctx.query,
        wasNew: created,
        emailStatus: lead.emailStatus ?? null,
        emailConfidence: lead.emailConfidence ?? null,
        ruleScore: score?.score ?? null,
        scoreCoverage: score?.coverage ?? null,
        techStack: lead.company?.techStack ?? null,
      },
      scrapeDate: new Date(),
      source: lead.source ?? "agent:discovery",
      agentRunId: ctx.runId,
    })
    .onConflictDoNothing();

  if (!created) return { created: false };

  // Charged only for a lead the org did not already have, and only after it exists - so a
  // source that keeps returning the same people costs nothing to re-check.
  // The premium sub-quota is recorded too (it used to be swallowed by a `.catch`), and a
  // database fault is thrown as a fault rather than read as the plan limit.
  const charge = await chargeNewLead(orgIdValue, lead.source ?? "agent:discovery");
  if (!charge.ok && charge.reason === "quota") return { created: true, quotaStopped: charge.message };
  if (!charge.ok) throw new Error(`could not record lead usage: ${charge.message}`);
  return { created: true };
}

/** Recent runs for this org, newest first. */
export async function recentAgentRuns(orgIdValue: string, limit = 25) {
  const { db } = getDb();
  return db.select().from(agentRuns).where(eq(agentRuns.orgId, orgIdValue)).orderBy(desc(agentRuns.startedAt)).limit(limit);
}

/**
 * Leads discovered by the agent, joined to the real lead row.
 *
 * Reads through to `leads` rather than serving the provenance copy, so a lead that has since
 * been verified, scored, corrected or enrolled shows its CURRENT state - not a snapshot of
 * what a scrape once thought.
 */
export async function discoveredLeads(orgIdValue: string, opts: { company?: string; runId?: string; limit?: number; offset?: number } = {}) {
  const { db } = getDb();
  const rows = await db
    .select({ provenance: scrapedLeads, lead: leads })
    .from(scrapedLeads)
    .innerJoin(leads, eq(scrapedLeads.leadId, leads.id))
    .where(
      and(
        eq(scrapedLeads.orgId, orgIdValue),
        opts.company ? eq(scrapedLeads.company, opts.company) : undefined,
        opts.runId ? eq(scrapedLeads.agentRunId, opts.runId) : undefined,
      ),
    )
    .orderBy(desc(scrapedLeads.createdAt))
    .limit(Math.min(opts.limit ?? 50, 500))
    .offset(opts.offset ?? 0);

  return rows.map((r) => ({
    ...r.lead,
    discoveredAt: r.provenance.createdAt,
    discoveredBy: r.provenance.source,
    discoveryQuery: (r.provenance.enrichedData as { query?: string } | null)?.query ?? null,
    agentRunId: r.provenance.agentRunId,
  }));
}
