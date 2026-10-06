import { and, desc, effectiveLimits, eq, getDb, inArray, leads, pixels, signals, sql, withStatementTimeout, type Db, type Organization, type PlayType } from "@prospex/db";
import * as core from "@prospex/core";
import type { EngagerRow, Engagement, PlayEngineOptions, PlayEngineResult, PlayFinding, PlayPlan, PlayRunTrace } from "@prospex/core";
import { platformListed, workspaceListed } from "../lib/privacySuppression.js";

/**
 * Where a play's findings come from.
 *
 * Five engines live in @prospex/core (they search the public web and read public pages);
 * two live here, because what they read is the workspace's own data: the companies that
 * visited the customer's site, and the job changes already recorded for its leads.
 *
 * Every engine is reached through ONE seam (`playEngines()`), so a test - or a deployment
 * that wants to switch an engine off - replaces the functions in one place and nothing else
 * in the API knows the difference.
 */

/** A finding as the API stores it: a core finding, plus what only the API can know. */
export type ApiFinding = PlayFinding & {
  /** The lead this finding is about, when the engine started from one (job changes). */
  leadId?: string;
  /** Overrides the computed dedupe key (a job change is one candidate per move, not per person). */
  dedupeKey?: string;
};

export interface EngineOutcome {
  findings: ApiFinding[];
  trace: PlayRunTrace;
}

export interface PlayEngines {
  findCompetitorCustomers: typeof core.findCompetitorCustomers;
  findHiringCompanies: typeof core.findHiringCompanies;
  findFundedCompanies: typeof core.findFundedCompanies;
  findPublicAsks: typeof core.findPublicAsks;
  findPeopleForFinding: typeof core.findPeopleForFinding;
  engagersFromRows: typeof core.engagersFromRows;
  planPlays: typeof core.planPlays;
  playDedupeKey: typeof core.playDedupeKey;
  mailSafeReason: typeof core.mailSafeReason;
  /** The public page of a LinkedIn post (one guarded fetch; never a login). */
  linkedinPostEngagers: typeof core.linkedinPostEngagers;
}

/** Looked up on the core module at call time, so the functions are whatever core exports now. */
const coreEngines: PlayEngines = {
  findCompetitorCustomers: (cfg, opts) => core.findCompetitorCustomers(cfg, opts),
  findHiringCompanies: (cfg, opts) => core.findHiringCompanies(cfg, opts),
  findFundedCompanies: (cfg, opts) => core.findFundedCompanies(cfg, opts),
  findPublicAsks: (cfg, opts) => core.findPublicAsks(cfg, opts),
  findPeopleForFinding: (finding, cfg, opts) => core.findPeopleForFinding(finding, cfg, opts),
  engagersFromRows: (rows, ctx) => core.engagersFromRows(rows, ctx),
  planPlays: (input, opts) => core.planPlays(input, opts),
  playDedupeKey: (f) => core.playDedupeKey(f),
  mailSafeReason: (text) => core.mailSafeReason(text),
  linkedinPostEngagers: (url) => core.linkedinPostEngagers(url),
};

let active: PlayEngines = coreEngines;

/** The engines in use. Every caller goes through this - nothing imports an engine directly. */
export const playEngines = (): PlayEngines => active;

/** Replace some or all engines (tests). Returns a function that puts the real ones back. */
export function setPlayEngines(over: Partial<PlayEngines>): () => void {
  active = { ...coreEngines, ...over };
  return () => {
    active = coreEngines;
  };
}

// ── Text from outside ──

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** One bounded line of plain text, or null when nothing is left. Never rendered as HTML. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.slice(0, max * 4 + 200).replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s || null;
}

/**
 * The reason as it may go into an email: one line with no link, address, handle or markup.
 *
 * The reason shown to a reviewer is text on a page. Stored on the lead it becomes the
 * template variable `{{relevant_because}}`, and a template that uses it is sent with
 * nobody reading it first - so anything in it that a mail client would turn into a link is
 * taken out here, at approval, whatever the engine already did. Core's `mailSafeReason`
 * runs first; these rules are the last line and do not depend on it.
 */
export function mailSafe(text: unknown): string {
  let s = typeof text === "string" ? text.slice(0, 4_000) : "";
  try {
    const viaCore = playEngines().mailSafeReason(s);
    if (typeof viaCore === "string") s = viaCore;
  } catch {
    // The local rules below apply either way.
  }
  s = s
    .replace(INVISIBLE, " ")
    .replace(/<[^<>]{0,300}>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*/gi, " ")
    .replace(/\b(?:mailto|tel|javascript|data):\S*/gi, " ")
    .replace(/\S*@\S+/g, " ")
    .replace(/\bwww\.\S+/gi, " ")
    // host.tld/path - then any remaining host.tld: the dots go, the words stay ("Monday com").
    .replace(/\b(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}\/\S*/gi, " ")
    .replace(/\b((?:[a-z0-9-]{1,63}\.){1,8})([a-z]{2,24})\b/gi, (m) => m.replace(/\./g, " "))
    .replace(/[{}[\]`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 200).trim();
}

// ── Traces ──

export const newTrace = (): PlayRunTrace => ({ searches: 0, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [], blocked: false });

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Add the work of a follow-up step (finding people at a company) to a run's trace. Counters
 * add up and notes are kept; whether the RUN was blocked stays the main engine's verdict -
 * a people search that could not run does not turn a run that found companies into a
 * blocked one.
 */
export function addTrace(run: PlayRunTrace, step: Partial<PlayRunTrace> | null | undefined): PlayRunTrace {
  if (!step) return run;
  return {
    searches: count(run.searches) + count(step.searches),
    failedSearches: count(run.failedSearches) + count(step.failedSearches),
    pagesFetched: count(run.pagesFetched) + count(step.pagesFetched),
    pagesRefused: count(run.pagesRefused) + count(step.pagesRefused),
    aiCalls: count(run.aiCalls) + count(step.aiCalls),
    notes: [...(run.notes ?? []), ...(Array.isArray(step.notes) ? step.notes : [])].slice(0, 40),
    blocked: run.blocked === true,
    ...(run.blockedReason ? { blockedReason: run.blockedReason } : {}),
  };
}

/** An engine's answer as the API will read it, whatever shape came back. */
function outcomeOf(r: Partial<PlayEngineResult> | null | undefined): EngineOutcome {
  const t = (r?.trace ?? {}) as Partial<PlayRunTrace>;
  return {
    findings: Array.isArray(r?.findings) ? (r!.findings as ApiFinding[]) : [],
    trace: { ...addTrace(newTrace(), t), blocked: t.blocked === true, ...(typeof t.blockedReason === "string" && t.blockedReason ? { blockedReason: t.blockedReason } : {}) },
  };
}

// ── Website visitors (the customer's own pixel data) ──

/** At most this many companies per run: the queue is for review, not a dump of the table. */
const VISITOR_LIMIT = 200;
const ENGINE_STATEMENT_MS = 15_000;

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : Array.isArray((res as { rows?: unknown })?.rows) ? ((res as { rows: T[] }).rows) : []);
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const inLast = (days: number) => (days === 1 ? "in the last day" : `in the last ${days} days`);

/** The sentence for one visiting company, from what its visits in the window actually were. */
export function visitorReason(v: { total: number; pricing: number; demo: number }, days: number): string {
  if (v.pricing > 0) return `Visited your pricing page ${times(v.pricing)} ${inLast(days)}.`;
  if (v.demo > 0) return `Visited your demo or contact page ${times(v.demo)} ${inLast(days)}.`;
  return `Visited your website ${times(v.total)} ${inLast(days)}.`;
}

/**
 * Companies that visited the customer's site with intent, from `visitor_companies` and the
 * page views behind them.
 *
 * The counts in the reason are counted from the `visits` rows inside the window - not taken
 * from the company's all-time totals - so "3 times in the last 7 days" is what happened in
 * the last 7 days. A company the workspace marked as ignored is left out.
 */
export async function findWebsiteVisitors(orgId: string, cfg: { minIntentScore?: number; days?: number }, dbIn?: Db): Promise<EngineOutcome> {
  const db = dbIn ?? getDb().db;
  const trace = newTrace();
  const days = Math.min(90, Math.max(1, Math.floor(cfg.days ?? 14)));
  const minIntent = Math.min(100, Math.max(0, cfg.minIntentScore ?? 30));
  const [pixel] = await db.select({ id: pixels.id }).from(pixels).where(and(eq(pixels.orgId, orgId), eq(pixels.active, true))).limit(1);
  if (!pixel) {
    return {
      findings: [],
      trace: { ...trace, blocked: true, blockedReason: "There is no active tracking pixel on your website yet, so there were no visitors to look at. Add the pixel under Visitors, then run this play again." },
    };
  }
  const rows = rowsOf<{ domain: string; name: string | null; intent_score: number; total: number; pricing: number; demo: number; last_at: string | Date }>(
    await withStatementTimeout(db, ENGINE_STATEMENT_MS, (tx) =>
      tx.execute(sql`
        SELECT vc.domain, vc.name, vc.intent_score, v.total, v.pricing, v.demo, v.last_at
        FROM visitor_companies vc
        JOIN (
          SELECT company_domain,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE page ~* '(pricing|plans)')::int AS pricing,
                 count(*) FILTER (WHERE page ~* '(demo|contact|book|trial|quote)')::int AS demo,
                 max(visited_at) AS last_at
          FROM visits
          WHERE org_id = ${orgId} AND visited_at > now() - (${days} || ' days')::interval AND company_domain IS NOT NULL AND is_isp = false
          GROUP BY company_domain
        ) v ON v.company_domain = vc.domain
        WHERE vc.org_id = ${orgId} AND vc.intent_score >= ${minIntent} AND vc.status <> 'ignored'
        ORDER BY vc.intent_score DESC, v.last_at DESC
        LIMIT ${VISITOR_LIMIT}`),
    ),
  );
  const findings: ApiFinding[] = rows.map((r) => ({
    kind: "company" as const,
    companyName: r.name ?? undefined,
    companyDomain: r.domain,
    relevantBecause: visitorReason({ total: Number(r.total) || 0, pricing: Number(r.pricing) || 0, demo: Number(r.demo) || 0 }, days),
    evidenceTitle: "Your website visitors",
    signalType: "site_visit",
    signalAt: new Date(r.last_at),
    // Matching a visit to a company is an inference from a network address, never a certainty.
    confidence: Math.min(0.8, 0.4 + (Number(r.intent_score) || 0) / 250),
  }));
  if (!findings.length) trace.notes.push(`No identified company reached an intent score of ${minIntent} on your website ${inLast(days)}.`);
  return { findings, trace };
}

// ── Job changes (signals already recorded for this workspace's leads) ──

const JOB_CHANGE_LIMIT = 200;

/** Can this workspace's plan and the configured providers check anyone for a job change? */
export function jobChangeChecksAvailable(org: Pick<Organization, "plan" | "planLimits"> | null | undefined): boolean {
  const canEnrich = core.peopleProviders().some((p) => typeof p.enrich === "function");
  return canEnrich && (effectiveLimits(org ?? undefined).premiumLeadsPerMonth ?? 0) > 0;
}

/**
 * Known contacts who changed jobs, from the workspace's own `job_change` signals.
 *
 * Nothing is looked up here - the daily job-change check does that, within the plan's
 * provider budget. Each recorded move becomes one candidate that IS the existing lead: the
 * lead id travels with the finding, and the old address is not copied (it is probably
 * stale). A lead that has opted out, or whose address is on a do-not-contact list, is not
 * suggested for outreach at all.
 */
export async function findJobChanges(org: Pick<Organization, "id" | "plan" | "planLimits">, cfg: { days?: number }, dbIn?: Db): Promise<EngineOutcome> {
  const db = dbIn ?? getDb().db;
  const trace = newTrace();
  const days = Math.min(90, Math.max(1, Math.floor(cfg.days ?? 30)));
  const rows = await db
    .select({ id: signals.id, url: signals.url, summary: signals.summary, companyName: signals.companyName, companyDomain: signals.companyDomain, confidence: signals.confidence, occurredAt: signals.occurredAt, createdAt: signals.createdAt, raw: signals.raw })
    .from(signals)
    .where(and(eq(signals.orgId, org.id), eq(signals.type, "job_change"), sql`coalesce(${signals.occurredAt}, ${signals.createdAt}) > now() - (${days} || ' days')::interval`))
    .orderBy(desc(signals.createdAt))
    .limit(JOB_CHANGE_LIMIT);
  if (!rows.length) {
    if (!jobChangeChecksAvailable(org)) {
      return {
        findings: [],
        trace: { ...trace, blocked: true, blockedReason: "Job changes could not be checked: this needs a contact data provider, which this workspace's plan does not include yet. Nobody was checked - this is not a finding that nobody moved." },
      };
    }
    trace.notes.push(`No job change was recorded for your leads ${inLast(days)}.`);
    return { findings: [], trace };
  }
  const leadIds = [...new Set(rows.map((r) => (r.raw as { leadId?: unknown } | null)?.leadId).filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)))];
  // This workspace's own leads only: a signal naming any other id is not followed.
  const own = leadIds.length
    ? await db
        .select({ id: leads.id, fullName: leads.fullName, firstName: leads.firstName, lastName: leads.lastName, linkedinUrl: leads.linkedinUrl, email: leads.email, status: leads.status })
        .from(leads)
        .where(and(eq(leads.orgId, org.id), inArray(leads.id, leadIds)))
    : [];
  const byId = new Map(own.map((l) => [l.id, l]));
  const addresses = own.map((l) => l.email);
  const onPlatform = await platformListed(addresses, db);
  const onWorkspace = await workspaceListed(org.id, addresses, db);
  const findings: ApiFinding[] = [];
  let optedOut = 0;
  for (const s of rows) {
    const raw = (s.raw ?? {}) as { leadId?: unknown; to?: { title?: unknown; company?: unknown } };
    const lead = typeof raw.leadId === "string" ? byId.get(raw.leadId) : undefined;
    if (!lead || !s.summary) continue;
    const address = lead.email?.trim().toLowerCase();
    if (lead.status === "unsubscribed" || (address && (onPlatform.has(address) || onWorkspace.has(address)))) {
      optedOut++;
      continue;
    }
    findings.push({
      kind: "person",
      fullName: lead.fullName ?? undefined,
      firstName: lead.firstName ?? undefined,
      lastName: lead.lastName ?? undefined,
      // The NEW role and employer, as the check recorded them.
      title: typeof raw.to?.title === "string" ? raw.to.title : undefined,
      companyName: s.companyName ?? (typeof raw.to?.company === "string" ? raw.to.company : undefined),
      companyDomain: s.companyDomain ?? undefined,
      linkedinUrl: lead.linkedinUrl ?? undefined,
      relevantBecause: s.summary,
      evidenceTitle: "Job change check",
      signalType: "job_change",
      signalAt: s.occurredAt ?? s.createdAt,
      confidence: s.confidence,
      leadId: lead.id,
      // One candidate per recorded move. (The signal's own key names the lead and the destination.)
      dedupeKey: `job-change:${s.url}`,
    });
  }
  if (optedOut) trace.notes.push(`${optedOut === 1 ? "1 person was" : `${optedOut} people were`} left out because they are on a do-not-contact list.`);
  return { findings, trace };
}

// ── The dispatcher ──

export interface RunEngineInput {
  type: PlayType;
  /** Already validated for `type` by the caller (services/plays.ts, on every run). */
  config: Record<string, unknown>;
  org: Pick<Organization, "id" | "plan" | "planLimits">;
  opts: PlayEngineOptions;
}

/** Run the engine of one play type. Throws only when the engine itself threw. */
export async function runPlayEngine(input: RunEngineInput): Promise<EngineOutcome> {
  const e = playEngines();
  const cfg = input.config as never;
  switch (input.type) {
    case "competitor_customers":
      return outcomeOf(await e.findCompetitorCustomers(cfg, input.opts));
    case "hiring_role":
      return outcomeOf(await e.findHiringCompanies(cfg, input.opts));
    case "funding": {
      const country = typeof input.config.country === "string" ? input.config.country : undefined;
      return outcomeOf(await e.findFundedCompanies(cfg, { ...input.opts, ...(country ? { country } : {}) }));
    }
    case "public_asks":
      return outcomeOf(await e.findPublicAsks(cfg, input.opts));
    case "website_visitors":
      return findWebsiteVisitors(input.org.id, cfg);
    case "job_changes":
      return findJobChanges(input.org, cfg);
    case "engagers_upload":
      return { findings: [], trace: { ...newTrace(), blocked: true, blockedReason: "This play is fed by uploads - add people with Upload." } };
  }
}

export type { EngagerRow, Engagement, PlayEngineOptions, PlayFinding, PlayPlan, PlayRunTrace };
