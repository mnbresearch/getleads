import { and, autopilots, campaigns, consume, consumeLead, eq, getDb, listLeads, remainingPremiumBudget, type Autopilot } from "@prospex/db";
import { createAiProvider, runLeadPipeline, type IcpCriteria } from "@prospex/core";
import { env } from "../env.js";
import { pipelineLeadToInput, upsertLead } from "./leads.js";
import { enrollLeads } from "./campaigns.js";
import { emitEvent } from "../lib/events.js";

/**
 * Autopilot: an autonomous prospecting agent. Every day it finds N fresh leads for a saved query,
 * enriches + verifies them, scores against the ICP, saves to a list, and optionally enrolls
 * qualified ones in a campaign. This is the "set and forget" mode competitors do not offer for free.
 */
export async function runAutopilot(ap: Autopilot, log: (s: string) => void = () => {}) {
  const { db } = getDb();
  const icp = ap.icpId ? await db.query.icps.findFirst({ where: (t, { eq: e }) => e(t.id, ap.icpId!) }) : null;
  const ok = await consume(db, ap.orgId, "searches", 1).then(() => true, (e) => (log(String((e as Error).message)), false));
  if (!ok) return { skipped: "search quota" };
  // Ask for extra so filtering by score/email still yields dailyLeads
  const providerBudget = await remainingPremiumBudget(db, ap.orgId);
  const results = await runLeadPipeline({ ...(ap.query as Record<string, unknown>), limit: Math.min(200, ap.dailyLeads * 3), findEmails: true }, {
    ai: createAiProvider(),
    verify: { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey },
    icp: (icp?.criteria as IcpCriteria | undefined) ?? undefined,
    maxProviderLeads: providerBudget,
    onProgress: (p, m) => log(`${p}% ${m}`),
  });
  const qualified = results.filter((r) => (r.score ?? 0) >= ap.minScore && (!ap.requireValidEmail || r.emailStatus === "valid" || r.emailStatus === "catch_all"));
  let saved = 0;
  const ids: string[] = [];
  for (const r of qualified) {
    if (saved >= ap.dailyLeads) break;
    const quota = await consumeLead(db, ap.orgId, r.source).then(() => true, () => false);
    if (!quota) break;
    const { lead, created } = await upsertLead(ap.orgId, pipelineLeadToInput(r, { icpId: ap.icpId, tags: ["autopilot", `ap:${ap.id.slice(0, 8)}`], source: r.source }));
    if (!created) continue; // only count fresh leads
    saved++;
    ids.push(lead.id);
    if (ap.listId) await db.insert(listLeads).values({ listId: ap.listId, leadId: lead.id }).onConflictDoNothing();
  }
  let enrolled = 0;
  if (ap.autoEnroll && ap.campaignId && ids.length) {
    const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, ap.campaignId), eq(campaigns.orgId, ap.orgId)) });
    if (cp) enrolled = await enrollLeads(cp, ids);
  }
  const stats = { ...(ap.stats ?? {}), runs: (ap.stats?.runs ?? 0) + 1, found: (ap.stats?.found ?? 0) + results.length, saved: (ap.stats?.saved ?? 0) + saved, enrolled: (ap.stats?.enrolled ?? 0) + enrolled, lastSaved: saved };
  await db.update(autopilots).set({ lastRunAt: new Date(), stats }).where(eq(autopilots.id, ap.id));
  await emitEvent(ap.orgId, "autopilot.ran", { autopilotId: ap.id, found: results.length, saved, enrolled }, { type: "autopilot", id: ap.id });
  return { found: results.length, qualified: qualified.length, saved, enrolled };
}
