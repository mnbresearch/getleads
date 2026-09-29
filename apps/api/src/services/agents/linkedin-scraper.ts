/**
 * Kept as a thin shim, because its name is referenced by a route and a scheduled workflow.
 *
 * What used to live here asked a model to "simulate finding LinkedIn profiles" and to
 * "create realistic but fictional profiles", then wrote those invented people - invented
 * names, invented companies, invented EMAIL ADDRESSES - into the database with
 * `intentScore: Math.random() * 0.5 + 0.5`, every morning on a cron.
 *
 * Nothing downstream could tell those rows from real ones. A customer working them emails
 * addresses that either bounce, destroying the sender reputation that
 * email/sendingHealth.ts exists to protect, or reach a real person who happens to own a
 * guessed address. It also did not scrape LinkedIn, or anything else; there was no source.
 *
 * It now delegates to the discovery agent, which runs the pipeline this product already
 * has: real search, real licensed providers where they are keyed, real email finding and
 * verification, and scoring against the org's own ICP. See services/agents/discovery.ts.
 */
import { runDiscoveryAgent, discoveredLeads, type DiscoveryResult } from "./discovery.js";

/**
 * @deprecated Call `runDiscoveryAgent` directly. This name is kept so the existing route
 * and the scheduled workflow keep working; it no longer has anything to do with scraping
 * LinkedIn, and never did.
 */
export async function runLinkedInScraper(orgId: string, query: string, count = 25): Promise<DiscoveryResult> {
  return runDiscoveryAgent(orgId, query, { limit: count });
}

/** @deprecated Use `discoveredLeads`, which reads the current lead rather than a snapshot. */
export async function getScrapedLeads(orgId: string, opts: { company?: string; limit?: number; offset?: number } = {}) {
  return discoveredLeads(orgId, opts);
}
