import { and, companies, desc, eq, getDb, inArray, isNull, or, signalMatches, signalSubscriptions, signals, sql, type SignalSubscription } from "@prospex/db";
import { companyNews, domainHintFromUrl, findPeopleDetailed, resolveCompanyDomain, scanSignals, scoreLeadRules, searchDebugOn, type IcpCriteria, type ParsedSignal, type SignalType } from "@prospex/core";
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
    // The workspace's own signals first, then the newest. With no order, a busy week of
    // public news filled all 200 places and the workspace's own job changes - the ones only
    // it has - were never matched.
    .orderBy(sql`(${signals.orgId} IS NULL)`, desc(signals.createdAt))
    .limit(200);
  const terms = [...sub.keywords, ...sub.industries].map((k) => k.toLowerCase().trim()).filter(Boolean);
  const places = sub.locations.map((k) => k.toLowerCase().trim()).filter(Boolean);
  // The workspace's own company rows hold the only real location data a signal has. Read
  // once for every domain in this batch rather than per signal.
  const domains = [...new Set(recent.map((s) => s.companyDomain).filter((d): d is string => !!d))];
  const companyPlace = new Map<string, string>();
  if (places.length && domains.length) {
    const rows = await db.select({ domain: companies.domain, location: companies.location, country: companies.country }).from(companies).where(and(eq(companies.orgId, sub.orgId), inArray(companies.domain, domains)));
    for (const r of rows) {
      const where = [r.location, r.country].filter(Boolean).join(" ").toLowerCase();
      if (where) companyPlace.set(r.domain, where);
    }
  }
  let matched = 0;
  let leadsCreated = 0;
  let skippedLocation = 0;
  const why: NoLeadReasons = { noTitles: 0, noPerson: 0, alreadyLeads: 0, searchFailed: 0, stopped: 0, failed: 0 };
  for (const s of recent) {
    const { headline, body } = ownText(s);
    // The org's own job changes are about people it already tracks; keyword filters are
    // written for news headlines and would drop most of them.
    const ownJobChange = s.type === "job_change" && s.orgId === sub.orgId;
    // Keywords and industries are about what happened, so they are looked for in the
    // signal's own words - with the publisher's name taken out first.
    if (!ownJobChange && terms.length && !terms.some((k) => `${headline} ${body}`.includes(k))) continue;
    // Locations are a separate condition, not one more keyword. Mixed in with the keywords,
    // "India" matched every item published by "Investing.com India" whatever it was about.
    if (!ownJobChange && places.length && !locationMatches(places, s.companyDomain ? companyPlace.get(s.companyDomain) : undefined, headline)) {
      skippedLocation++;
      continue;
    }
    if (!s.companyName && !ownJobChange) continue;
    await db.insert(signalMatches).values({ signalId: s.id, subscriptionId: sub.id, orgId: sub.orgId }).onConflictDoNothing();
    matched++;
    if (sub.autoCreateLeads && !sub.targetTitles.length) why.noTitles++;
    if (sub.autoCreateLeads && sub.targetTitles.length && s.companyName) {
      try {
        const r = await leadsFromSignalDetailed(sub, s.id, s.companyName, s.type);
        leadsCreated += r.created;
        if (!r.created) why[r.reason]++;
      } catch (e) {
        why.failed++;
        log(`lead creation failed for ${s.companyName}: ${(e as Error).message}`);
      }
    }
  }
  const note = sub.autoCreateLeads && matched > 0 && leadsCreated === 0 ? noLeadsNote(matched, why) : undefined;
  const stats = {
    ...(sub.stats ?? {}),
    matched: (sub.stats?.matched ?? 0) + matched,
    leadsCreated: (sub.stats?.leadsCreated ?? 0) + leadsCreated,
    lastRunMatched: matched,
    lastRunLeadsCreated: leadsCreated,
    lastRunSkippedLocation: skippedLocation,
    lastRunNoPerson: why.noPerson,
    lastRunAlreadyLeads: why.alreadyLeads,
    lastRunSearchFailed: why.searchFailed,
  };
  await db.update(signalSubscriptions).set({ lastRunAt: new Date(), stats }).where(eq(signalSubscriptions.id, sub.id));
  if (matched) await emitEvent(sub.orgId, "signals.matched", { subscriptionId: sub.id, matched, leadsCreated }, { type: "subscription", id: sub.id });
  return { parsed: parsed.length, stored: stored.length, matched, leadsCreated, skippedLocation, ...(note ? { note } : {}) };
}

type NoLeadReason = "noPerson" | "alreadyLeads" | "searchFailed" | "stopped";
type NoLeadReasons = Record<NoLeadReason | "noTitles" | "failed", number>;

/**
 * A signal's own words, with the publisher taken out.
 *
 * News feeds put the outlet in the headline ("Acme raises $5M - Investing.com India") and in
 * the summary. Matching against that text made the publisher's name count as what the news
 * was about, so a subscription for "India" matched everything a publisher with India in its
 * name wrote.
 */
export function ownText(s: { title: string; summary?: string | null; source?: string | null }): { headline: string; body: string } {
  let headline = s.title ?? "";
  let body = s.summary ?? "";
  const src = (s.source ?? "").trim();
  if (src) {
    const re = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    headline = headline.replace(re, " ");
    body = body.replace(re, " ");
  }
  // With no source recorded, the trailing " - Outlet" Google News adds is the publisher.
  else headline = headline.replace(/\s+[-|]\s+[^-|]{2,60}$/, "");
  return { headline: headline.toLowerCase(), body: body.toLowerCase() };
}

/** Whole-word containment, so "india" does not match "indiana" and "uk" does not match "ukraine". */
function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * Does a signal fall in one of the subscription's locations?
 *
 * The company's own location fields decide when the workspace has them (a known company
 * elsewhere is not let through by a headline mentioning the place). Without them, the only
 * statement about where the company is comes from the headline itself ("Bengaluru-based
 * Acme raises ..."), with the publisher already removed. The summary and the publisher name
 * are never read for this.
 */
export function locationMatches(places: string[], companyWhere: string | undefined, headline: string): boolean {
  if (!places.length) return true;
  if (companyWhere) return places.some((p) => hasWord(companyWhere, p));
  return places.some((p) => hasWord(headline, p));
}

/**
 * A location as search snippets give it, or nothing.
 *
 * Snippets often open with the person's headline ("Head of Sales at Acme | SaaS | India"),
 * and the parser can take that whole line as the location. A lead's location is a place,
 * so a value that reads like a headline (a job title, "at", separators, too many words) is
 * dropped rather than stored.
 */
export function plausibleLocation(loc: string | null | undefined, title?: string | null): string | undefined {
  const v = (loc ?? "").trim();
  if (!v || v.length > 80) return undefined;
  if (/[|@·•]|\s(?:at|and)\s|https?:/i.test(v)) return undefined;
  if (title && title.trim() && v.toLowerCase().includes(title.toLowerCase().trim())) return undefined;
  if (/\b(head|director|manager|founder|ceo|cto|cfo|coo|vp|president|engineer|developer|consultant|officer|lead|sales|marketing|executive|specialist|analyst)\b/i.test(v)) return undefined;
  if (v.split(/\s+/).length > 6) return undefined;
  return v;
}

function noLeadsNote(matched: number, why: NoLeadReasons): string {
  const parts: string[] = [];
  if (why.noTitles) parts.push("the subscription has no target titles to look for");
  if (why.noPerson) parts.push(`nobody with the target titles was found at ${why.noPerson} ${why.noPerson === 1 ? "company" : "companies"}`);
  if (why.alreadyLeads) parts.push(`the people found at ${why.alreadyLeads} ${why.alreadyLeads === 1 ? "company were" : "companies were"} already leads`);
  if (why.searchFailed) parts.push(`the people search could not run for ${why.searchFailed} ${why.searchFailed === 1 ? "company" : "companies"}`);
  if (why.stopped) parts.push("the plan's lead limit was reached");
  if (why.failed) parts.push(`saving failed for ${why.failed} ${why.failed === 1 ? "company" : "companies"}`);
  const head = `${matched} ${matched === 1 ? "signal" : "signals"} matched but no leads were created`;
  return parts.length ? `${head}: ${parts.join("; ")}.` : `${head}.`;
}

/** Find decision makers at a signal's company and save them as leads (tagged with the signal). */
export async function leadsFromSignal(sub: SignalSubscription, signalId: string, companyName: string, type: string) {
  return (await leadsFromSignalDetailed(sub, signalId, companyName, type)).created;
}

/** As leadsFromSignal, and when nobody was created, why. */
export async function leadsFromSignalDetailed(sub: SignalSubscription, signalId: string, companyName: string, type: string): Promise<{ created: number; reason: NoLeadReason }> {
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
  // The company's name and the providers' own words (which can echo the search) stay out of
  // the log unless an operator turned search debugging on; the signal id finds the company.
  if (searchFailed) console.warn(searchDebugOn() ? `[signals] subscription ${sub.id}: people search failed for ${companyName}: ${found.failureMessage ?? "every search failed"}` : `[signals] subscription ${sub.id}: people search failed for the company of signal ${signalId}`);
  let created = 0;
  let stoppedBecause: string | null = null;
  const ids: string[] = [];
  // The subscription org's own ICP, not merely a row with that id.
  const icp = sub.icpId ? await db.query.icps.findFirst({ where: (t, { eq: e, and: a }) => a(e(t.id, sub.icpId!), e(t.orgId, sub.orgId)) }) : null;
  for (const p of people) {
    const location = plausibleLocation(p.location, p.title);
    // Scored only against a real ICP. With none there is nothing to fit, and the flat 70 this
    // used to give read as "strong ICP fit" for a person nobody had judged.
    const scored = icp ? scoreLeadRules({ title: p.title, location, company: { name: companyName } }, icp.criteria as IcpCriteria) : null;
    const { lead, created: c } = await upsertLead(sub.orgId, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location, companyName, companyDomain: domain, source: `signal:${type}`, tags: [`signal:${type}`, `sub:${sub.id.slice(0, 8)}`], icpId: icp?.id ?? null, ...(scored ? { score: scored.score, scoreReasons: scored.reasons } : {}), custom: { signalId } }, { fillOnly: true });
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
  const reason: NoLeadReason = stoppedBecause ? "stopped" : searchFailed ? "searchFailed" : people.length === 0 ? "noPerson" : "alreadyLeads";
  return { created, reason };
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
