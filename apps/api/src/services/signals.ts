import { and, companies, eq, getDb, inArray, isNull, or, signalMatches, signalSubscriptions, signals, sql, type SignalSubscription } from "@prospex/db";
import { companyNews, domainHintFromUrl, findPeopleDetailed, resolveCompanyDomain, scanSignals, scoreLeadRules, type IcpCriteria, type ParsedSignal, type SignalType } from "@prospex/core";
import { upsertCompany, upsertLead } from "./leads.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";
import { enrollEligibleLeads } from "./campaigns.js";

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
  // job_change is not something the news scanner can find: those signals are written by
  // the org's own job-change scan (services/jobChanges.ts). Asking the scanner for them
  // returned nothing, so a job_change subscription never matched anything at all.
  const scanTypes = sub.types.filter((t) => t !== "job_change") as SignalType[];
  const parsed = scanTypes.length ? await scanSignals({ types: scanTypes, keywords: sub.keywords, industries: sub.industries, locations: sub.locations, days: 7, maxPerQuery: 25 }) : [];
  const stored = await storeSignals(parsed, null);
  log(`${parsed.length} parsed, ${stored.length} new`);
  // Match: any signal (new or existing in last 7 days) of the right type and keyword context not yet matched to this sub.
  //
  // Global signals (orgId null, from the news scan) or this org's own. Without the org
  // condition, one org's private signals - job changes derived from its own pipeline -
  // were matched, and their leads created, in every other org's subscriptions.
  const recent = await db
    .select()
    .from(signals)
    .where(
      and(
        inArray(signals.type, sub.types),
        or(isNull(signals.orgId), eq(signals.orgId, sub.orgId)),
        sql`${signals.createdAt} > now() - interval '7 days'`,
        sql`${signals.id} NOT IN (SELECT signal_id FROM signal_matches WHERE subscription_id = ${sub.id})`,
      ),
    )
    .limit(200);
  const kw = [...sub.keywords, ...sub.industries, ...sub.locations].map((k) => k.toLowerCase());
  let matched = 0;
  let leadsCreated = 0;
  for (const s of recent) {
    const text = `${s.title} ${s.summary ?? ""}`.toLowerCase();
    // The org's own job changes are about people it already tracks; keyword filters are
    // written for news headlines and would drop most of them.
    const ownJobChange = s.type === "job_change" && s.orgId === sub.orgId;
    if (!ownJobChange && kw.length && !kw.some((k) => text.includes(k))) continue;
    if (!s.companyName && !ownJobChange) continue;
    await db.insert(signalMatches).values({ signalId: s.id, subscriptionId: sub.id, orgId: sub.orgId }).onConflictDoNothing();
    matched++;
    if (sub.autoCreateLeads && sub.targetTitles.length && s.companyName) {
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
  // Detailed, so "the search could not run" is recorded as that and not as "nobody works there".
  const found = await findPeopleDetailed({ companyName, titles: sub.targetTitles, limit: 3 });
  const people = found.people;
  const searchFailed = people.length === 0 && found.everySearchFailed;
  if (searchFailed) console.warn(`[signals] subscription ${sub.id}: people search failed for ${companyName}: ${found.failureMessage ?? "every search failed"}`);
  let created = 0;
  let stoppedBecause: string | null = null;
  const ids: string[] = [];
  // The subscription org's own ICP, not merely a row with that id.
  const icp = sub.icpId ? await db.query.icps.findFirst({ where: (t, { eq: e, and: a }) => a(e(t.id, sub.icpId!), e(t.orgId, sub.orgId)) }) : null;
  for (const p of people) {
    const score = icp ? scoreLeadRules({ title: p.title, location: p.location, company: { name: companyName } }, icp.criteria as IcpCriteria).score : 70;
    const { lead, created: c } = await upsertLead(sub.orgId, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyName, companyDomain: domain, source: `signal:${type}`, tags: [`signal:${type}`, `sub:${sub.id.slice(0, 8)}`], icpId: icp?.id ?? null, score, custom: { signalId } }, { fillOnly: true });
    // Charged for a lead the org did not already have. A subscription re-reads the same
    // people whenever a signal matches again; billing before the upsert charged for those
    // repeats, which produce nothing.
    if (c) {
      created++;
      const charge = await tryConsume(db, sub.orgId, "leads", 1);
      if (!charge.ok) {
        ids.push(lead.id);
        // A plan limit and a database fault both stop the loop, but they are not the same
        // thing and the run record must not file one as the other.
        stoppedBecause = charge.reason === "quota" ? `lead quota reached: ${charge.message}` : `could not record lead usage: ${charge.message}`;
        break;
      }
    }
    ids.push(lead.id);
  }
  // "stopped" is deliberately distinct from "no_leads": one means the signal produced
  // nobody, the other means we stopped part-way and there may be more. No new column for
  // the reason - it goes to the log, where the admin job view already reads.
  if (stoppedBecause) console.warn(`[signals] subscription ${sub.id} stopped after ${created} leads: ${stoppedBecause}`);
  await db
    .update(signalMatches)
    .set({ leadsCreated: created, status: stoppedBecause ? "stopped" : searchFailed ? "search_failed" : created ? "leads_created" : "no_leads" })
    .where(and(eq(signalMatches.signalId, signalId), eq(signalMatches.subscriptionId, sub.id)));
  if (sub.campaignId && ids.length) {
    // Same org as the subscription, not just the same id: enrolling into a foreign campaign
    // would hand our leads to another tenant's sequence, which then emails them.
    const cp = await db.query.campaigns.findFirst({ where: (t, { eq: e, and: a }) => a(e(t.id, sub.campaignId!), e(t.orgId, sub.orgId)) });
    // The enroll route's filters, not a bare insert: leads with no usable address were
    // enrolled only to fail at the first send, and a client campaign took other clients' leads.
    if (cp) await enrollEligibleLeads(cp, ids);
  }
  return created;
}

/** Enrich a company row with fresh news signals + intent score (used by company.enrich job). */
export async function refreshCompanySignals(orgId: string, domain: string, name?: string | null) {
  const { db } = getDb();
  if (!name) return 0;
  const news = await companyNews(name, 60).catch(() => []);
  // Stored for THIS workspace. The company name comes from the workspace's own company row,
  // which its users can edit; writing that into the global pool let one workspace choose the
  // company a public news item is attributed to for everyone.
  const stored = await storeSignals(news.filter((n) => n.type !== "news").map((n) => ({ ...n, companyName: name })), orgId);
  for (const s of stored) await db.update(signals).set({ companyDomain: domain }).where(eq(signals.id, s.id));
  const [{ n, last }] = await db.select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(created_at)` }).from(signals).where(and(eq(signals.companyDomain, domain), or(isNull(signals.orgId), eq(signals.orgId, orgId))));
  await db.update(companies).set({ signalsCount: n, lastSignalAt: last ?? undefined }).where(and(eq(companies.orgId, orgId), eq(companies.domain, domain)));
  return stored.length;
}
