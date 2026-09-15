import { and, companies, consume, eq, getDb, inArray, signalMatches, signalSubscriptions, signals, sql, type SignalSubscription } from "@getleads/db";
import { companyNews, domainHintFromUrl, findPeople, resolveCompanyDomain, scanSignals, scoreLeadRules, type IcpCriteria, type ParsedSignal, type SignalType } from "@getleads/core";
import { upsertCompany, upsertLead } from "./leads.js";
import { emitEvent } from "../lib/events.js";
import { enrollLeads } from "./campaigns.js";

/** Persist parsed signals (global scope unless orgId given). Returns inserted rows. */
export async function storeSignals(items: ParsedSignal[], orgId: string | null = null) {
  const { db } = getDb();
  const out = [];
  for (const s of items) {
    const [row] = await db
      .insert(signals)
      .values({ orgId, type: s.type, companyName: s.companyName, companyDomain: domainHintFromUrl(s.url) ?? undefined, title: s.title, summary: s.summary, url: s.url, source: s.source, amountUsd: s.amountUsd, round: s.round, confidence: s.confidence, occurredAt: s.occurredAt, raw: {} })
      .onConflictDoNothing()
      .returning();
    if (row) out.push(row);
  }
  return out;
}

/** Run one subscription: scan → store → match → (optionally) create decision-maker leads. */
export async function runSubscription(sub: SignalSubscription, log: (m: string) => void = () => {}) {
  const { db } = getDb();
  const types = sub.types as SignalType[];
  const parsed = await scanSignals({ types, keywords: sub.keywords, industries: sub.industries, locations: sub.locations, days: 7, maxPerQuery: 25 });
  const stored = await storeSignals(parsed, null);
  log(`${parsed.length} parsed, ${stored.length} new`);
  // Match: any signal (new or existing in last 7 days) of the right type and keyword context not yet matched to this sub
  const recent = await db
    .select()
    .from(signals)
    .where(and(inArray(signals.type, sub.types), sql`${signals.createdAt} > now() - interval '7 days'`, sql`${signals.id} NOT IN (SELECT signal_id FROM signal_matches WHERE subscription_id = ${sub.id})`))
    .limit(200);
  const kw = [...sub.keywords, ...sub.industries, ...sub.locations].map((k) => k.toLowerCase());
  let matched = 0;
  let leadsCreated = 0;
  for (const s of recent) {
    const text = `${s.title} ${s.summary ?? ""}`.toLowerCase();
    if (kw.length && !kw.some((k) => text.includes(k))) continue;
    if (!s.companyName) continue;
    await db.insert(signalMatches).values({ signalId: s.id, subscriptionId: sub.id, orgId: sub.orgId }).onConflictDoNothing();
    matched++;
    if (sub.autoCreateLeads && sub.targetTitles.length) {
      try {
        const n = await leadsFromSignal(sub, s.id, s.companyName, s.type);
        leadsCreated += n;
      } catch (e) {
        log(`lead creation failed for ${s.companyName}: ${(e as Error).message}`);
      }
    }
  }
  const stats = { ...(sub.stats ?? {}), matched: (sub.stats?.matched ?? 0) + matched, leadsCreated: (sub.stats?.leadsCreated ?? 0) + leadsCreated, lastRunMatched: matched };
  await db.update(signalSubscriptions).set({ lastRunAt: new Date(), stats }).where(eq(signalSubscriptions.id, sub.id));
  if (matched) await emitEvent(sub.orgId, "signals.matched", { subscriptionId: sub.id, matched, leadsCreated }, { type: "subscription", id: sub.id });
  return { parsed: parsed.length, stored: stored.length, matched, leadsCreated };
}

/** Find decision makers at a signal's company and save them as leads (tagged with the signal). */
export async function leadsFromSignal(sub: SignalSubscription, signalId: string, companyName: string, type: string) {
  const { db } = getDb();
  const domain = await resolveCompanyDomain(companyName).catch(() => null);
  if (domain) {
    await upsertCompany(sub.orgId, domain, { name: companyName });
    await db.update(companies).set({ signalsCount: sql`${companies.signalsCount} + 1`, lastSignalAt: new Date(), intentScore: sql`LEAST(100, ${companies.intentScore} + 20)` }).where(and(eq(companies.orgId, sub.orgId), eq(companies.domain, domain)));
    await db.update(signals).set({ companyDomain: domain }).where(and(eq(signals.id, signalId), sql`${signals.companyDomain} IS NULL`));
  }
  const people = await findPeople({ companyName, titles: sub.targetTitles, limit: 3 });
  let created = 0;
  const ids: string[] = [];
  const icp = sub.icpId ? await db.query.icps.findFirst({ where: (t, { eq: e }) => e(t.id, sub.icpId!) }) : null;
  for (const p of people) {
    const ok = await consume(db, sub.orgId, "leads", 1).then(() => true, () => false);
    if (!ok) break;
    const score = icp ? scoreLeadRules({ title: p.title, location: p.location, company: { name: companyName } }, icp.criteria as IcpCriteria).score : 70;
    const { lead, created: c } = await upsertLead(sub.orgId, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName, companyDomain: domain, source: `signal:${type}`, tags: [`signal:${type}`, `sub:${sub.id.slice(0, 8)}`], icpId: sub.icpId, score, custom: { signalId } });
    if (c) created++;
    ids.push(lead.id);
  }
  await db.update(signalMatches).set({ leadsCreated: created, status: created ? "leads_created" : "no_leads" }).where(and(eq(signalMatches.signalId, signalId), eq(signalMatches.subscriptionId, sub.id)));
  if (sub.campaignId && ids.length) {
    const cp = await db.query.campaigns.findFirst({ where: (t, { eq: e }) => e(t.id, sub.campaignId!) });
    if (cp) await enrollLeads(cp, ids);
  }
  return created;
}

/** Enrich a company row with fresh news signals + intent score (used by company.enrich job). */
export async function refreshCompanySignals(orgId: string, domain: string, name?: string | null) {
  const { db } = getDb();
  if (!name) return 0;
  const news = await companyNews(name, 60).catch(() => []);
  const stored = await storeSignals(news.filter((n) => n.type !== "news").map((n) => ({ ...n, companyName: name })), null);
  for (const s of stored) await db.update(signals).set({ companyDomain: domain }).where(eq(signals.id, s.id));
  const [{ n, last }] = await db.select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(created_at)` }).from(signals).where(eq(signals.companyDomain, domain));
  await db.update(companies).set({ signalsCount: n, lastSignalAt: last ?? undefined }).where(and(eq(companies.orgId, orgId), eq(companies.domain, domain)));
  return stored.length;
}
