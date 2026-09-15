import { consume, eq, getDb, monitorResults, monitors, type Monitor } from "@getleads/db";
import { companyNews, detectHiring, fetchGoogleNews, linkedinPostEngagers, webSearch } from "@getleads/core";
import { upsertLead } from "./leads.js";
import { emitEvent } from "../lib/events.js";

/**
 * Monitor types:
 *  - linkedin_post : target = post URL → engagers become leads (public posts only)
 *  - keyword       : target = phrase → news mentions
 *  - competitor    : target = competitor name → news + "alternatives to X" discussions (buyers evaluating)
 *  - company_news  : target = company name → funding/hiring/leadership signals
 *  - jobs          : target = company domain → hiring changes (open roles by function)
 */
export async function runMonitor(m: Monitor, log: (s: string) => void = () => {}) {
  const { db } = getDb();
  let added = 0;
  const cfg = m.config as { titles?: string[]; createLeads?: boolean; companyDomain?: string };
  const insert = async (kind: string, title: string, url: string | null, snippet?: string, data: Record<string, unknown> = {}, leadId?: string) => {
    const r = await db.insert(monitorResults).values({ monitorId: m.id, orgId: m.orgId, kind, title, url, snippet, data, leadId }).onConflictDoNothing().returning();
    if (r.length) added++;
    return r[0];
  };

  if (m.type === "linkedin_post") {
    const r = await linkedinPostEngagers(m.target);
    if (!r.publicPage) log("post not publicly accessible");
    for (const p of r.people) {
      let leadId: string | undefined;
      if (cfg.createLeads !== false) {
        const ok = await consume(db, m.orgId, "leads", 1).then(() => true, () => false);
        if (ok) leadId = (await upsertLead(m.orgId, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, source: "linkedin:post", tags: ["engager", `monitor:${m.id.slice(0, 8)}`] })).lead.id;
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
    for (const t of h.titles) await insert("job", t, h.careersUrl ? `${h.careersUrl}#${encodeURIComponent(t)}` : `job:${m.target}:${t}`, undefined, { function: Object.entries(h.byFunction).find(() => true)?.[0] });
    await db.update(monitors).set({ lastResult: { openRoles: h.openRoles, byFunction: h.byFunction, source: h.source, delta: h.openRoles - prev } }).where(eq(monitors.id, m.id));
    if (h.openRoles > prev && prev > 0) await emitEvent(m.orgId, "monitor.hiring_up", { monitorId: m.id, domain: m.target, openRoles: h.openRoles, delta: h.openRoles - prev });
  }
  await db.update(monitors).set({ lastRunAt: new Date(), resultsCount: m.resultsCount + added }).where(eq(monitors.id, m.id));
  if (added) await emitEvent(m.orgId, "monitor.results", { monitorId: m.id, type: m.type, added }, { type: "monitor", id: m.id });
  return { added };
}
