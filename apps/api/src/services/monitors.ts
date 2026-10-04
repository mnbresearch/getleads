import { consume, eq, getDb, monitorResults, monitors, type Monitor } from "@prospex/db";
import { companyNews, detectHiring, encodeURIComponentSafe, fetchGoogleNews, linkedinPostEngagers, webSearch } from "@prospex/core";
import { upsertLead } from "./leads.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";

/**
 * Monitor types:
 *  - linkedin_post : target = post URL → engagers become leads (public posts only)
 *  - keyword       : target = phrase → news mentions
 *  - competitor    : target = competitor name → news + "alternatives to X" discussions (buyers evaluating)
 *  - company_news  : target = company name → funding/hiring/leadership signals
 *  - jobs          : target = company domain → hiring changes (open roles by function)
 */
export async function runMonitor(m: Monitor, log: (s: string) => void = () => {}): Promise<{ added: number; error?: string; refused?: boolean }> {
  const { db } = getDb();
  let added = 0;
  const cfg = m.config as { titles?: string[]; createLeads?: boolean; companyDomain?: string };
  const insert = async (kind: string, title: string, url: string | null, snippet?: string, data: Record<string, unknown> = {}, leadId?: string) => {
    const r = await db.insert(monitorResults).values({ monitorId: m.id, orgId: m.orgId, kind, title, url, snippet, data, leadId }).onConflictDoNothing().returning();
    if (r.length) added++;
    return r[0];
  };

  let leadQuotaExhausted = false;
  if (m.type === "linkedin_post") {
    // The target is a free-text field a tenant filled in. linkedinPostEngagers only ever
    // fetches a linkedin.com URL (https, public addresses, redirects kept on LinkedIn); for
    // anything else it fetches nothing and says so. That used to be a plain fetch of
    // whatever was typed, every tick, from inside our network.
    //
    // A refusal is recorded ON the monitor, as an error, and returned to the caller. It
    // must not read as "ran fine, nobody engaged": that is a different fact.
    const r = await linkedinPostEngagers(m.target);
    if (r.refused) {
      log(`monitor target refused: ${r.refused}`);
      await db
        .update(monitors)
        .set({ lastRunAt: new Date(), lastResult: { publicPage: false, people: 0, refused: true, error: r.refused } })
        .where(eq(monitors.id, m.id));
      return { added: 0, error: r.refused, refused: true };
    }
    if (!r.publicPage) log("post not publicly accessible");
    for (const p of r.people) {
      let leadId: string | undefined;
      if (cfg.createLeads !== false && !leadQuotaExhausted) {
        // Charge for a lead only when one was actually CREATED. A monitor re-reads the
        // whole engager list every tick, so charging before the upsert billed the org for
        // the same forty people every six hours, forever, while `onConflictDoNothing` kept
        // the result table unchanged. A repeat costs nothing because it produces nothing.
        const { lead, created } = await upsertLead(m.orgId, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, source: "linkedin:post", tags: ["engager", `monitor:${m.id.slice(0, 8)}`] }, { fillOnly: true });
        leadId = lead.id;
        if (created) {
          const charge = await tryConsume(db, m.orgId, "leads", 1);
          // Out of plan quota: stop creating for the rest of this run. A database fault is
          // a different thing and must not be filed under the customer's plan limit.
          if (!charge.ok) {
            leadQuotaExhausted = true;
            log(charge.reason === "quota" ? `lead quota reached: ${charge.message}` : `could not record lead usage: ${charge.message}`);
          }
        }
      }
      await insert("person", p.fullName, p.linkedinUrl ?? null, p.title, { postText: r.postText }, leadId);
    }
    await db.update(monitors).set({ lastResult: { publicPage: r.publicPage, reactions: r.reactions, comments: r.comments, people: r.people.length } }).where(eq(monitors.id, m.id));
  } else if (m.type === "keyword") {
    const items = await fetchGoogleNews(`"${m.target}"`, { days: 3 });
    for (const it of items.slice(0, 30)) await insert("article", it.title, it.url, it.summary, { source: it.source, publishedAt: it.publishedAt });
  } else if (m.type === "competitor") {
    const items = await fetchGoogleNews(`"${m.target}"`, { days: 7 });
    for (const it of items.slice(0, 20)) await insert("article", it.title, it.url, it.summary, { source: it.source });
    const alts = await webSearch(`"${m.target}" alternative OR "switching from ${m.target}" OR "vs ${m.target}"`, { count: 20, minResults: 1 }).catch(() => []);
    for (const r of alts) await insert("mention", r.title, r.url, r.snippet, { provider: r.provider });
  } else if (m.type === "company_news") {
    const sigs = await companyNews(m.target, 14);
    for (const s of sigs) await insert(s.type === "news" ? "article" : "signal", s.title, s.url, s.summary, { type: s.type, amountUsd: s.amountUsd, round: s.round, source: s.source });
  } else if (m.type === "jobs") {
    const h = await detectHiring(m.target, cfg.companyDomain);
    const prev = (m.lastResult as { openRoles?: number } | null)?.openRoles ?? 0;
    if (!h.reached) {
      // Nothing answered. Recording 0 here would erase the baseline AND suppress the next
      // hiring-up alert, which requires prev > 0 - so the customer would quietly stop
      // getting the signal this monitor exists to send. Leave the count alone and say why.
      await db.update(monitors).set({ lastResult: { openRoles: prev, byFunction: (m.lastResult as { byFunction?: Record<string, number> } | null)?.byFunction ?? {}, source: "none", delta: 0, unreachable: true, reason: h.reason, ...(h.refused ? { refused: true, error: h.refused } : {}) } }).where(eq(monitors.id, m.id));
      if (h.refused) {
        // Not a public web address: nothing was fetched and nothing will be next tick
        // either. Said out loud, here and to the caller, rather than left as a quiet zero.
        log(`monitor target refused: ${h.refused}`);
        await db.update(monitors).set({ lastRunAt: new Date() }).where(eq(monitors.id, m.id));
        return { added, error: h.refused, refused: true };
      }
    } else {
      for (const t of h.titles) await insert("job", t, h.careersUrl ? `${h.careersUrl}#${encodeURIComponentSafe(t)}` : `job:${m.target}:${t}`, undefined, { function: Object.entries(h.byFunction).find(() => true)?.[0] });
      await db.update(monitors).set({ lastResult: { openRoles: h.openRoles, byFunction: h.byFunction, source: h.source, delta: h.openRoles - prev } }).where(eq(monitors.id, m.id));
      if (h.openRoles > prev && prev > 0) await emitEvent(m.orgId, "monitor.hiring_up", { monitorId: m.id, domain: m.target, openRoles: h.openRoles, delta: h.openRoles - prev });
    }
  }
  await db.update(monitors).set({ lastRunAt: new Date(), resultsCount: m.resultsCount + added }).where(eq(monitors.id, m.id));
  if (added) await emitEvent(m.orgId, "monitor.results", { monitorId: m.id, type: m.type, added }, { type: "monitor", id: m.id });
  return { added };
}
