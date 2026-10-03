import { and, autopilots, campaigns, eq, getDb, icps, listLeads, lists, organizations, remainingPremiumBudget, type Autopilot } from "@prospex/db";
import { clampLeadQuery, createAiProviderForPlan, runLeadPipelineDetailed, type IcpCriteria } from "@prospex/core";
import { env } from "../env.js";
import { clampSearchQuery } from "../lib/searchQuery.js";
import { chargeNewLead, findExistingLead, pipelineLeadToInput, upsertLead } from "./leads.js";
import { enrollEligibleLeads } from "./campaigns.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";
import { blockedByProvidersNote } from "./notes.js";

/**
 * Autopilot: an autonomous prospecting agent. Every day it finds N fresh leads for a saved query,
 * enriches + verifies them, scores against the ICP, saves to a list, and optionally enrolls
 * qualified ones in a campaign. This is the "set and forget" mode competitors do not offer for free.
 */
export async function runAutopilot(ap: Autopilot, log: (s: string) => void = () => {}) {
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, ap.orgId) });
  if (!org || org.status !== "active") return { skipped: "organization not active" };
  // The ICP and the list are this org's own, not merely rows with those ids: a reference
  // written across a workspace boundary before the ownership checks existed must not be
  // followed (another org's criteria scored our leads; our leads landed on their list).
  const icp = ap.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, ap.icpId), eq(icps.orgId, ap.orgId)) }) : null;
  const list = ap.listId ? await db.query.lists.findFirst({ where: and(eq(lists.id, ap.listId), eq(lists.orgId, ap.orgId)), columns: { id: true } }) : null;
  // A plan limit skips the run; a database fault is a fault and is thrown, not filed as
  // the customer's quota.
  const search = await tryConsume(db, ap.orgId, "searches", 1);
  if (!search.ok && search.reason === "quota") {
    log(search.message);
    await recordRun(ap, { found: 0, saved: 0, enrolled: 0, note: `Skipped: ${search.message}` });
    return { skipped: "search quota", detail: search.message };
  }
  if (!search.ok) throw new Error(`could not record search usage: ${search.message}`);
  // Ask for extra so filtering by score/email still yields dailyLeads
  const providerBudget = await remainingPremiumBudget(db, ap.orgId);
  // The stored query is tenant-written jsonb. It is re-clamped on every run (known keys
  // only, companyDomains <= 50, ten of each list) and supplies the pipeline INPUT alone;
  // every option in the second argument is built here.
  const stored = clampSearchQuery(ap.query);
  const input = clampLeadQuery({ ...stored, limit: Math.min(200, Math.max(1, ap.dailyLeads * 3)), findEmails: true });
  const { leads: results, providerFailures } = await runLeadPipelineDetailed(input, {
    // The plan decides the engine: free workspaces never reach the paid model.
    ai: createAiProviderForPlan(org.plan),
    verify: { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey },
    icp: (icp?.criteria as IcpCriteria | undefined) ?? undefined,
    maxProviderLeads: providerBudget,
    onProgress: (p, m) => log(`${p}% ${m}`),
  });
  const qualified = results.filter((r) => (r.score ?? 0) >= ap.minScore && (!ap.requireValidEmail || r.emailStatus === "valid" || r.emailStatus === "catch_all"));
  let saved = 0;
  const ids: string[] = [];
  let stoppedBecause: string | null = null;
  for (const r of qualified) {
    if (saved >= ap.dailyLeads) break;
    // Only a lead the org does not already have is charged, and only once it is saved.
    // Charging before the upsert billed every daily re-find of the same people, and any
    // database error in the charge was read as "out of quota".
    const existing = await findExistingLead(ap.orgId, { email: r.email, linkedinUrl: r.linkedinUrl });
    if (existing) {
      // Still merged (fill-only), never counted: only fresh leads count.
      await upsertLead(ap.orgId, pipelineLeadToInput(r, { icpId: icp?.id ?? null, tags: ["autopilot", `ap:${ap.id.slice(0, 8)}`], source: r.source }), { fillOnly: true });
      continue;
    }
    const charge = await chargeNewLead(ap.orgId, r.source);
    if (!charge.ok) {
      stoppedBecause = charge.reason === "quota" ? `Stopped at your plan's lead limit: ${charge.message}` : `Stopped: could not record lead usage (${charge.message})`;
      break;
    }
    const { lead, created } = await upsertLead(ap.orgId, pipelineLeadToInput(r, { icpId: icp?.id ?? null, tags: ["autopilot", `ap:${ap.id.slice(0, 8)}`], source: r.source }), { fillOnly: true });
    if (!created) continue;
    saved++;
    ids.push(lead.id);
    if (list) await db.insert(listLeads).values({ listId: list.id, leadId: lead.id }).onConflictDoNothing();
  }
  let enrolled = 0;
  let enrollNote: Record<string, number> = {};
  if (ap.autoEnroll && ap.campaignId && ids.length) {
    const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, ap.campaignId), eq(campaigns.orgId, ap.orgId)) });
    if (cp) {
      // The same filters as the enroll route: a usable address, and the campaign's client.
      const r = await enrollEligibleLeads(cp, ids);
      enrolled = r.enrolled;
      enrollNote = { skippedNoEmail: r.skippedNoEmail, skippedInvalidEmail: r.skippedInvalidEmail, skippedOtherClient: r.skippedOtherClient };
    }
  }
  // Found nothing because the sources could not answer is not "nothing matched today".
  const blocked = results.length === 0 && providerFailures.length > 0;
  const note = blocked ? blockedByProvidersNote(providerFailures, "This is not the same as nobody matching.") : stoppedBecause;
  await recordRun(ap, { found: results.length, saved, enrolled, note });
  await emitEvent(ap.orgId, "autopilot.ran", { autopilotId: ap.id, found: results.length, saved, enrolled, note, providerFailures }, { type: "autopilot", id: ap.id });
  return { found: results.length, qualified: qualified.length, saved, enrolled, ...enrollNote, providerFailures, note };
}

/**
 * Stamp the run on the autopilot row, with the reason when it did not do its job.
 *
 * `lastNote` lives in `stats` (the only free-form field the row has) so the page that
 * shows runs and counts can also show why a run produced nothing. Cleared on a clean run.
 */
async function recordRun(ap: Autopilot, r: { found: number; saved: number; enrolled: number; note: string | null }) {
  const { db } = getDb();
  const prev = (ap.stats ?? {}) as Record<string, unknown>;
  const num = (k: string) => Number(prev[k] ?? 0) || 0;
  const stats = { ...prev, runs: num("runs") + 1, found: num("found") + r.found, saved: num("saved") + r.saved, enrolled: num("enrolled") + r.enrolled, lastSaved: r.saved, lastNote: r.note ?? null };
  await db.update(autopilots).set({ lastRunAt: new Date(), stats: stats as unknown as Record<string, number> }).where(eq(autopilots.id, ap.id));
}
