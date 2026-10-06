import { adjustUsage, and, campaigns, companies, consume, currentPeriod, desc, enqueue, eq, events, getDb, icps, inArray, leads, listLeads, lists, organizations, pixels, PLAY_TYPES, playCandidates, playRuns, plays, QuotaExceededError, sql, tasks, withStatementTimeout, type Db, type Organization, type Play, type PlayCandidate, type PlayRun, type PlayType } from "@prospex/db";
import { hasAi, pMap, redact, scoreLeadRules, wilsonInterval, type AiProvider, type IcpCriteria } from "@prospex/core";
import { z, ZodError, type ZodTypeAny } from "zod";
import { env } from "../env.js";
import { aiForOrg } from "../lib/ai.js";
import { errorLine } from "../lib/errors.js";
import { emitEvent } from "../lib/events.js";
import { guardJobCapacity, withOrgLock } from "../lib/limits.js";
import { contactBlock, platformListed, workspaceListed } from "../lib/privacySuppression.js";
import { assertQuotaAvailable } from "../lib/quota.js";
import { enrollEligibleLeads, leadsWithUsableEmail } from "./campaigns.js";
import { canonicalEmail, chargeNewLead, companyDomainOrNull, findExistingLead, profileUrlOrNull, upsertCompany, upsertLead } from "./leads.js";
import { plural } from "./notes.js";
import { addTrace, cleanText, jobChangeChecksAvailable, linkOrNull, mailSafe, playEngines, runPlayEngine, type ApiFinding, type EngagerRow, type Engagement, type EngineOutcome, type PlayEngineOptions, type PlayRunTrace } from "./playEngines.js";

/**
 * Plays: saved recipes that find the people who need the customer's product now.
 *
 * What a play finds does not become a lead. It lands in `play_candidates` with the sentence
 * that says why it is relevant and the page that shows it, and waits for a person to
 * approve or skip it. This module is everything between an engine's findings and that
 * decision: cleaning and storing candidates, the decision itself (the only place in the
 * feature where a lead is created), running a play, and the per-play results.
 *
 * Nothing here sends anything. Approval can enrol a lead in the play's campaign - through
 * the same `enrollEligibleLeads` every other path uses - and a campaign still only sends
 * when it is active.
 */

// ── Limits ──

/** A play stops adding once this many of its candidates are waiting for review. */
export const PENDING_CAP_PER_PLAY = 5_000;
/**
 * And once it holds this many that were not approved - waiting or skipped. Skipping made
 * room under the first limit for nothing, so uploading and skipping in a loop grew one play
 * without end. (Skipped candidates are kept so the same person is not offered again; they
 * go when their retention period ends.)
 */
export const UNAPPROVED_CAP_PER_PLAY = 20_000;
/** People an upload (or a run that happens inside a request) approves by itself; the rest wait in Review. */
export const AUTO_APPROVE_INLINE_MAX = 100;
/** How long one run may keep starting new work. */
export const RUN_DEADLINE_MS = 4 * 60_000;
/** The same, where a run happens inside a request (JOB_MODE=inline). */
export const RUN_DEADLINE_INLINE_MS = 40_000;
/** Company findings per run that are followed up with a people search. */
export const PEOPLE_SEARCHES_PER_RUN = 15;
/** People kept per company. */
const PEOPLE_PER_COMPANY = 3;
/** Companies searched for people at the same time. */
const PEOPLE_SEARCH_CONCURRENCY = 3;
/** When a run will also look for people, the share of its time the source engine may use; the rest is kept for the people. */
const ENGINE_SHARE_WITH_PEOPLE = 0.6;
/** A run of a play that is still "running" blocks another one for this long. */
export const RUN_BUSY_MS = 15 * 60_000;
/** Plays the scheduler starts per tick. */
export const PLAYS_PER_TICK = 50;
/** How long an approval holds its claim on a candidate before another request may take over. */
const CLAIM_SECONDS = 120;
const READ_STATEMENT_MS = 15_000;

// ── Text that came from the web, from an upload or from an upstream error ──

export { cleanText, linkOrNull, mailSafe };

/** NAMES_LIKE_THIS: how a server setting is spelled. A customer can do nothing with one. */
const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Upstream text (an engine's note, an error) as a customer may read it: secrets masked, the
 * names of server settings removed, one bounded line.
 */
export function customerText(text: unknown, max = 300): string {
  return (cleanText(redact(String(text ?? ""), { max: 2_000 }).replace(SETTING_NAME, "a server setting"), max) ?? "").trim();
}

// ── Play settings, per type ──

const term = (max: number) => z.string().trim().min(1).max(max);
const terms = (items: number, len = 100) => z.array(term(len)).max(items);
const blankAsMissing = <T extends ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema);
/** A company's public website, stored as its domain. Not an IP address, a port or an internal name. */
const domainField = z
  .string()
  .trim()
  .max(300)
  .transform((v, ctx) => {
    const d = companyDomainOrNull(v);
    if (!d) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A website must be a public domain like example.com." });
      return z.NEVER;
    }
    return d;
  });

export const ASK_SOURCES = ["linkedin", "reddit", "hackernews", "x", "forums"] as const;
export const ENGAGEMENTS = ["reacted", "commented", "reposted", "followed", "signed_up", "attended", "other"] as const;

/**
 * What each play type may be configured with. Unknown keys are dropped. A play's stored
 * settings are parsed with this again on EVERY run, so a row written before a limit existed
 * (or edited in the database) cannot make a run search for more than a request could ask for.
 */
export const PLAY_CONFIG: Record<PlayType, ZodTypeAny> = {
  competitor_customers: z.object({
    competitors: z.array(z.object({ name: term(120), domain: blankAsMissing(domainField.optional()) })).min(1).max(10),
    maxPerCompetitor: z.number().int().min(1).max(50).optional(),
  }),
  hiring_role: z.object({
    roles: terms(10, 100).min(1),
    keywords: terms(10).optional(),
    locations: terms(10).optional(),
    companyDomains: z.array(domainField).max(50).optional(),
  }),
  funding: z.object({
    keywords: terms(10).optional(),
    industries: terms(10).optional(),
    locations: terms(10).optional(),
    days: z.number().int().min(1).max(60).default(14),
    minAmountUsd: z.number().int().min(0).max(1_000_000_000_000).optional(),
    country: blankAsMissing(z.string().trim().regex(/^[A-Za-z]{2}$/, "Country must be a two-letter code like US.").transform((v) => v.toUpperCase()).optional()),
  }),
  public_asks: z
    .object({
      competitors: terms(10, 120).optional(),
      problems: terms(10, 160).optional(),
      category: blankAsMissing(term(120).optional()),
      sources: z.array(z.enum(ASK_SOURCES)).max(ASK_SOURCES.length).optional(),
      days: z.number().int().min(1).max(90).optional(),
    })
    .refine((v) => !!(v.competitors?.length || v.problems?.length || v.category), { message: "Add at least one competitor, problem or category to look for." }),
  website_visitors: z.object({ minIntentScore: z.number().min(0).max(100).default(30), days: z.number().int().min(1).max(90).default(14) }),
  job_changes: z.object({ days: z.number().int().min(1).max(90).default(30) }),
  engagers_upload: z.object({}),
};

/** A type's settings, validated; issues are reported under `config`. Throws a ZodError (answered as a 400). */
export function parsePlayConfig(type: PlayType, config: unknown): Record<string, unknown> {
  const r = PLAY_CONFIG[type].safeParse(config ?? {});
  if (!r.success) throw new ZodError(r.error.issues.map((i) => ({ ...i, path: ["config", ...i.path] })));
  return r.data as Record<string, unknown>;
}

const configBlob = z.record(z.unknown()).refine((v) => JSON.stringify(v).length <= 20_000, { message: "These play settings are too large." });
const ref = z.string().uuid().nullish();
/** A play's name is shown in lists, in tasks and on leads: one clean line, with no control or text-direction characters. */
const playName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((v, ctx) => {
    const name = cleanText(v, 120);
    if (!name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give the play a name." });
      return z.NEVER;
    }
    return name;
  });
const playFields = {
  name: playName,
  config: configBlob,
  targetTitles: z.array(term(100)).max(20),
  icpId: ref,
  clientId: ref,
  listId: ref,
  campaignId: ref,
  autoApprove: z.boolean(),
  minScore: z.number().int().min(0).max(100),
  runEveryHours: z.number().int().min(6).max(720).nullable(),
  status: z.enum(["active", "paused"]),
};

export const playCreateInput = z
  .object({
    ...playFields,
    type: z.enum(PLAY_TYPES),
    config: configBlob.default({}),
    targetTitles: playFields.targetTitles.optional(),
    autoApprove: playFields.autoApprove.optional(),
    minScore: playFields.minScore.optional(),
    runEveryHours: playFields.runEveryHours.optional(),
    status: playFields.status.optional(),
  })
  .transform((v, ctx) => {
    const parsed = PLAY_CONFIG[v.type].safeParse(v.config);
    if (!parsed.success) {
      for (const i of parsed.error.issues) ctx.addIssue({ ...i, path: ["config", ...i.path] });
      return z.NEVER;
    }
    return { ...v, config: parsed.data as Record<string, unknown> };
  });

export const playPatchInput = z.object({ ...playFields, type: z.enum(PLAY_TYPES) }).partial();

// ── The catalogue (GET /v1/plays/types) ──

type FieldKind = "tags" | "text" | "number" | "competitors" | "select";
export interface PlayTypeField {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  required?: boolean;
  max?: number;
  placeholder?: string;
  help?: string;
}
export interface PlayTypeOut {
  type: PlayType;
  name: string;
  summary: string;
  finds: "people" | "companies" | "conversations";
  needsSearch: boolean;
  available: boolean;
  unavailableReason?: string;
  setupHint?: string;
  fields: PlayTypeField[];
  defaultTitles?: string[];
}

const BUYER_TITLES = ["Founder", "CEO", "Head of Sales", "VP Sales", "Head of Marketing"];
const SEARCH_HINT = "Results depend on public search and may be thin until a search source is connected on our side.";
export const NO_PIXEL_REASON = "Add the tracking pixel to your website first (under Visitors). This play reads the companies that visit it.";
export const NO_JOB_CHECK_REASON = "Job-change checks need a contact data provider, which this workspace's plan does not include yet.";

const CATALOGUE: Omit<PlayTypeOut, "available" | "unavailableReason" | "setupHint">[] = [
  {
    type: "competitor_customers",
    name: "Competitor customers",
    summary: "Companies a competitor names as customers on its own site - case studies, customer pages and logo walls.",
    finds: "companies",
    needsSearch: true,
    fields: [
      { key: "competitors", label: "Competitors", kind: "competitors", required: true, max: 10, help: "Name each competitor and, if you know it, its website." },
      { key: "maxPerCompetitor", label: "Most companies per competitor", kind: "number", max: 50, placeholder: "20" },
    ],
    defaultTitles: BUYER_TITLES,
  },
  {
    type: "hiring_role",
    name: "Hiring for a role",
    summary: "Companies with an open job posting for a role you name - a team that is growing is a team that is buying.",
    finds: "companies",
    needsSearch: true,
    fields: [
      { key: "roles", label: "Roles they are hiring", kind: "tags", required: true, max: 10, placeholder: "Sales Development Representative" },
      { key: "keywords", label: "Keywords", kind: "tags", max: 10 },
      { key: "locations", label: "Locations", kind: "tags", max: 10 },
      { key: "companyDomains", label: "Only these companies", kind: "tags", max: 50, placeholder: "example.com", help: "Optional: check these companies' own careers pages." },
    ],
    defaultTitles: BUYER_TITLES,
  },
  {
    type: "funding",
    name: "Just raised funding",
    summary: "Companies that announced a funding round recently, from the news.",
    finds: "companies",
    needsSearch: false,
    fields: [
      { key: "keywords", label: "Keywords", kind: "tags", max: 10 },
      { key: "industries", label: "Industries", kind: "tags", max: 10 },
      { key: "locations", label: "Locations", kind: "tags", max: 10 },
      { key: "days", label: "Announced in the last (days)", kind: "number", max: 60, placeholder: "14" },
      { key: "minAmountUsd", label: "Smallest round (USD)", kind: "number", placeholder: "1000000" },
      { key: "country", label: "Country code", kind: "text", max: 2, placeholder: "US" },
    ],
    defaultTitles: BUYER_TITLES,
  },
  {
    type: "public_asks",
    name: "Asking in public",
    summary: "People asking in public for a tool like yours, or complaining about a competitor - on LinkedIn, Reddit, Hacker News, X and forums.",
    finds: "conversations",
    needsSearch: true,
    fields: [
      { key: "competitors", label: "Competitors", kind: "tags", max: 10 },
      { key: "problems", label: "Problems people describe", kind: "tags", max: 10, placeholder: "book meetings without cold calling" },
      { key: "category", label: "Your category", kind: "text", max: 120, placeholder: "sales engagement tool" },
      { key: "sources", label: "Where to look", kind: "select", options: [{ value: "linkedin", label: "LinkedIn" }, { value: "reddit", label: "Reddit" }, { value: "hackernews", label: "Hacker News" }, { value: "x", label: "X" }, { value: "forums", label: "Forums" }] },
      { key: "days", label: "Posted in the last (days)", kind: "number", max: 90, placeholder: "30" },
    ],
  },
  {
    type: "website_visitors",
    name: "Your website visitors",
    summary: "Companies that visited your own site with intent - pricing, demo and contact pages count most.",
    finds: "companies",
    needsSearch: false,
    fields: [
      { key: "minIntentScore", label: "Lowest intent score", kind: "number", max: 100, placeholder: "30" },
      { key: "days", label: "Visited in the last (days)", kind: "number", max: 90, placeholder: "14" },
    ],
    defaultTitles: BUYER_TITLES,
  },
  {
    type: "job_changes",
    name: "Contacts who changed jobs",
    summary: "People you already know who moved to a new company or a new role.",
    finds: "people",
    needsSearch: false,
    fields: [{ key: "days", label: "Changed in the last (days)", kind: "number", max: 90, placeholder: "30" }],
  },
  {
    type: "engagers_upload",
    name: "People who engaged",
    summary: "A list you upload of people who reacted to a post, commented, followed, signed up or attended.",
    finds: "people",
    needsSearch: false,
    fields: [],
  },
];

/** Is a keyed web search provider configured? The keyless fallbacks are not dependable. */
function dependableSearch(): boolean {
  const set = (k: string) => !!(process.env[k] ?? "").trim();
  return set("SERPER_API_KEY") || set("SERPAPI_KEY") || set("BRAVE_SEARCH_API_KEY") || (set("GOOGLE_CSE_API_KEY") && set("GOOGLE_CSE_CX"));
}

/** Why a type cannot work in this workspace yet, per type. A missing key means it can. */
export async function playAvailability(org: Pick<Organization, "id" | "plan" | "planLimits">): Promise<Partial<Record<PlayType, string>>> {
  const { db } = getDb();
  const out: Partial<Record<PlayType, string>> = {};
  const [pixel] = await db.select({ id: pixels.id }).from(pixels).where(and(eq(pixels.orgId, org.id), eq(pixels.active, true))).limit(1);
  if (!pixel) out.website_visitors = NO_PIXEL_REASON;
  if (!jobChangeChecksAvailable(org)) out.job_changes = NO_JOB_CHECK_REASON;
  return out;
}

export async function playTypes(org: Pick<Organization, "id" | "plan" | "planLimits">): Promise<PlayTypeOut[]> {
  const unavailable = await playAvailability(org);
  const thin = !dependableSearch();
  return CATALOGUE.map((t) => ({
    ...t,
    available: !unavailable[t.type],
    ...(unavailable[t.type] ? { unavailableReason: unavailable[t.type] } : {}),
    ...(t.needsSearch && thin ? { setupHint: SEARCH_HINT } : {}),
  }));
}

// ── Shapes that leave the server ──

export interface PlayCounts {
  pending: number;
  approved: number;
  skipped: number;
}
const noCounts = (): PlayCounts => ({ pending: 0, approved: 0, skipped: 0 });

export function playOut(p: Play, counts: PlayCounts = noCounts(), running = false) {
  const last = p.lastResult as Record<string, unknown> | null;
  return {
    id: p.id,
    // Cleaned on the way out too: a name saved before names were cleaned is still shown as one clean line.
    name: cleanText(p.name, 120) ?? "",
    type: p.type,
    status: p.status === "paused" ? ("paused" as const) : ("active" as const),
    config: p.config ?? {},
    targetTitles: p.targetTitles ?? [],
    icpId: p.icpId,
    clientId: p.clientId,
    listId: p.listId,
    campaignId: p.campaignId,
    autoApprove: p.autoApprove,
    minScore: p.minScore,
    runEveryHours: p.runEveryHours,
    lastRunAt: p.lastRunAt,
    nextRunAt: p.nextRunAt,
    lastResult: last ? { status: String(last.status ?? ""), found: Number(last.found) || 0, added: Number(last.added) || 0, duplicates: Number(last.duplicates) || 0, note: typeof last.note === "string" ? last.note : null } : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    counts,
    /** A run of this play is under way (started less than fifteen minutes ago and not finished). */
    running,
  };
}

/**
 * Of these plays, the ones with a run under way - and whether any of them still shows a
 * run as `running` that is too old to be one (for the caller to have closed). One query. Read-only.
 */
export async function runningPlays(orgId: string, playIds: string[]): Promise<{ running: Set<string>; lost: boolean }> {
  const running = new Set<string>();
  if (!playIds.length) return { running, lost: false };
  const { db } = getDb();
  const rows = await db
    .select({ playId: playRuns.playId, fresh: sql<boolean>`bool_or(${stillRunning})`, old: sql<boolean>`bool_or(NOT ${stillRunning})` })
    .from(playRuns)
    .where(and(eq(playRuns.orgId, orgId), inArray(playRuns.playId, playIds), eq(playRuns.status, "running")))
    .groupBy(playRuns.playId);
  let lost = false;
  for (const r of rows) {
    if (r.fresh) running.add(r.playId);
    if (r.old) lost = true;
  }
  return { running, lost };
}

/** Candidate counts by status for these plays of this workspace (one grouped query). */
export async function countsByPlay(orgId: string, playIds: string[]): Promise<Map<string, PlayCounts>> {
  const out = new Map<string, PlayCounts>();
  if (!playIds.length) return out;
  const { db } = getDb();
  const rows = await db
    .select({ playId: playCandidates.playId, status: playCandidates.status, n: sql<number>`count(*)::int` })
    .from(playCandidates)
    .where(and(eq(playCandidates.orgId, orgId), inArray(playCandidates.playId, playIds)))
    .groupBy(playCandidates.playId, playCandidates.status);
  for (const r of rows) {
    const c = out.get(r.playId) ?? noCounts();
    if (r.status === "pending" || r.status === "approved" || r.status === "skipped") c[r.status] = Number(r.n) || 0;
    out.set(r.playId, c);
  }
  return out;
}

const SIGNAL_TYPE = /^[a-z0-9_:-]{1,60}$/;

/**
 * A candidate as the API answers with it.
 *
 * Everything here was cleaned when it was stored (`normaliseFinding`). It is cleaned again
 * on the way out, with the same rules and limits, so a row written before a rule existed -
 * or by anything other than this module - still cannot put a control character, a
 * text-direction override, a `javascript:` link or a link with a password in it in front
 * of a reviewer.
 */
export function candidateOut(c: PlayCandidate, play: { name: string; type: string }) {
  const pending = c.status === "pending";
  const profile = c.linkedinUrl ? profileUrlOrNull(c.linkedinUrl, 500) : null;
  return {
    id: c.id,
    playId: c.playId,
    playName: cleanText(play.name, 120) ?? "",
    playType: play.type,
    kind: c.kind,
    status: c.status,
    skipReason: cleanText(c.skipReason, 200),
    fullName: cleanText(c.fullName, 200),
    firstName: cleanText(c.firstName, 200),
    lastName: cleanText(c.lastName, 200),
    title: cleanText(c.title, 300),
    linkedinUrl: profile ? linkOrNull(profile, 500) : null,
    email: canonicalEmail(c.email),
    emailStatus: cleanText(c.emailStatus, 40),
    location: cleanText(c.location, 300),
    companyName: cleanText(c.companyName, 200),
    companyDomain: c.companyDomain ? companyDomainOrNull(c.companyDomain) : null,
    relevantBecause: cleanText(c.relevantBecause, 300) ?? "",
    evidenceUrl: linkOrNull(c.evidenceUrl, 2000),
    evidenceTitle: cleanText(c.evidenceTitle, 200),
    evidenceQuote: cleanText(c.evidenceQuote, 500),
    signalType: SIGNAL_TYPE.test(c.signalType ?? "") ? c.signalType : "other",
    signalAt: c.signalAt,
    confidence: c.confidence,
    score: c.score,
    scoreReasons: (c.scoreReasons ?? []).slice(0, 10).map((r) => cleanText(r, 200)).filter((r): r is string => !!r),
    leadId: c.leadId,
    alreadyLead: c.alreadyLead,
    // While a candidate waits, `decided_at` only ever holds an approval's short-lived claim.
    decidedAt: pending ? null : c.decidedAt,
    createdAt: c.createdAt,
  };
}

export interface CandidateQuery {
  status: "pending" | "approved" | "skipped";
  playId?: string;
  kind?: "person" | "company" | "post";
  limit: number;
  offset: number;
}

/** The review queue: one page, the total for the filter, and the counts per status. Read-only. */
export async function listCandidates(orgId: string, q: CandidateQuery) {
  const { db } = getDb();
  const scope = and(eq(playCandidates.orgId, orgId), q.playId ? eq(playCandidates.playId, q.playId) : undefined, q.kind ? eq(playCandidates.kind, q.kind) : undefined);
  // One page and one grouped count, both time-limited: a queue of any size answers or says it cannot.
  const { rows, grouped } = await withStatementTimeout(db, READ_STATEMENT_MS, async (tx) => ({
    rows: await tx
      .select({ candidate: playCandidates, playName: plays.name, playType: plays.type })
      .from(playCandidates)
      // The join is scoped too: a candidate is only ever shown under a play of this workspace.
      .innerJoin(plays, and(eq(plays.id, playCandidates.playId), eq(plays.orgId, orgId)))
      .where(and(scope, eq(playCandidates.status, q.status)))
      .orderBy(...(q.status === "pending" ? [sql`${playCandidates.score} DESC NULLS LAST`, desc(playCandidates.createdAt)] : [desc(playCandidates.createdAt)]), desc(playCandidates.id))
      .limit(q.limit)
      .offset(q.offset),
    grouped: await tx.select({ status: playCandidates.status, n: sql<number>`count(*)::int` }).from(playCandidates).where(scope).groupBy(playCandidates.status),
  }));
  const counts = noCounts();
  for (const g of grouped) if (g.status === "pending" || g.status === "approved" || g.status === "skipped") counts[g.status] = Number(g.n) || 0;
  return { candidates: rows.map((r) => candidateOut(r.candidate, { name: r.playName, type: r.playType })), total: counts[q.status], counts };
}

// ── From a finding to a stored candidate ──

type CandidateValues = typeof playCandidates.$inferInsert;
type Normalised = Omit<CandidateValues, "orgId" | "playId" | "runId"> & { dedupeKey: string; leadIdHint?: string };

const KINDS = new Set(["person", "company", "post"]);

/**
 * The key rule, for the case core's `playDedupeKey` gave none: the same order and the same
 * prefixes (li: profile, em: address, pn: person at company, co: company domain, cn: company
 * name, ev: evidence page), so a key made here and one made there for the same finding agree
 * wherever the plain rules do.
 */
function fallbackDedupeKey(f: { kind: string; linkedinUrl?: string | null; email?: string | null; fullName?: string | null; companyName?: string | null; companyDomain?: string | null; evidenceUrl?: string | null }): string {
  const slug = f.linkedinUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (slug) return `li:${slug}`;
  if (f.email) return `em:${f.email}`;
  const page = (f.evidenceUrl ?? "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (f.kind === "post") return page ? `ev:${page}` : "";
  const company = (f.companyName ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
  const person = f.kind === "person" ? (f.fullName ?? "").replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
  if (person) return f.companyDomain ? `pn:${person}@${f.companyDomain}` : company ? `pn:${person}@${company}` : page ? `ev:${page}#${person}` : "";
  return f.companyDomain ? `co:${f.companyDomain}` : company ? `cn:${company}` : page ? `ev:${page}` : "";
}

/**
 * One finding as it may be stored, or null when it cannot be a candidate.
 *
 * Whatever an engine (or an upload) hands over is treated as text from outside: control and
 * invisible characters removed, every field bounded, an address kept only when it is ONE
 * address, links kept only when they are http(s). A finding with no reason, a conversation
 * with no page to answer on, a person nobody could identify and a company with no name are
 * not candidates.
 */
export function normaliseFinding(f: ApiFinding): Normalised | null {
  if (!f || typeof f !== "object" || !KINDS.has(f.kind)) return null;
  const relevantBecause = cleanText(f.relevantBecause, 300);
  if (!relevantBecause) return null;
  const kind = f.kind;
  const evidenceUrl = linkOrNull(f.evidenceUrl, 2000);
  if (kind === "post" && !evidenceUrl) return null;
  const person = kind === "person";
  const email = person ? canonicalEmail(f.email) : null;
  const linkedinUrl = person && f.linkedinUrl ? linkOrNull(profileUrlOrNull(f.linkedinUrl, 500), 500) : null;
  const firstName = person ? cleanText(f.firstName, 200) : null;
  const lastName = person ? cleanText(f.lastName, 200) : null;
  const fullName = person ? (cleanText(f.fullName, 200) ?? cleanText([firstName, lastName].filter(Boolean).join(" "), 200)) : null;
  const companyName = kind === "post" ? null : cleanText(f.companyName, 200);
  const companyDomain = kind === "post" ? null : f.companyDomain ? companyDomainOrNull(f.companyDomain) : null;
  const leadIdHint = person && typeof f.leadId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(f.leadId) ? f.leadId : undefined;
  if (person && !(linkedinUrl || email || leadIdHint || (fullName && (companyName || companyDomain)))) return null;
  if (kind === "company" && !(companyName || companyDomain)) return null;
  const signalType = (cleanText(f.signalType, 60) ?? "").toLowerCase();
  const signalAt = f.signalAt instanceof Date && Number.isFinite(f.signalAt.getTime()) && f.signalAt.getTime() <= Date.now() + 86_400_000 ? f.signalAt : null;
  const base = {
    kind,
    fullName,
    firstName,
    lastName,
    title: kind === "company" ? null : cleanText(f.title, 300),
    linkedinUrl,
    email,
    emailStatus: email ? "unknown" : null,
    location: person ? cleanText(f.location, 300) : null,
    companyName,
    companyDomain,
    relevantBecause,
    evidenceUrl,
    evidenceTitle: cleanText(f.evidenceTitle, 200),
    evidenceQuote: cleanText(f.evidenceQuote, 500),
    signalType: SIGNAL_TYPE.test(signalType) ? signalType : "other",
    signalAt,
    confidence: typeof f.confidence === "number" && Number.isFinite(f.confidence) ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
  };
  let key = "";
  if (typeof f.dedupeKey === "string") key = f.dedupeKey;
  else {
    try {
      key = playEngines().playDedupeKey({ ...f, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v ?? undefined])) } as ApiFinding);
    } catch {
      key = "";
    }
    if (typeof key !== "string" || !key.trim()) key = fallbackDedupeKey(base);
  }
  const dedupeKey = (cleanText(key, 300) ?? "").toLowerCase();
  if (!dedupeKey) return null;
  return { ...base, dedupeKey, ...(leadIdHint ? { leadIdHint } : {}) };
}

export type FindingOutcome = "added" | "duplicate" | "suppressed" | "invalid" | "full";
export interface StoreResult {
  /** What became of each finding, in the order given. */
  outcomes: FindingOutcome[];
  added: PlayCandidate[];
  counts: Record<FindingOutcome, number>;
  /** Which limit turned findings away, when any were (`counts.full`). */
  fullBecause?: "waiting" | "unapproved";
}

/** Why a play took no more, as a sentence that says what to do about it. */
export function fullSentence(because: StoreResult["fullBecause"]): string {
  return because === "unapproved"
    ? `this play already holds ${UNAPPROVED_CAP_PER_PLAY.toLocaleString("en-US")} people who were not approved (waiting or skipped), the most one play keeps. Start a new play for more.`
    : `this play already has ${PENDING_CAP_PER_PLAY.toLocaleString("en-US")} waiting for review. Review or skip some first.`;
}

const chunked = <T>(all: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
};

/**
 * Store findings as candidates of a play. Never creates a lead.
 *
 *  - an address on the platform's do-not-contact list, or on this workspace's own, is not
 *    stored: the finding is dropped whole;
 *  - the same person or company found twice by one play is one candidate (the unique index
 *    on (play, key) decides, so two runs at once cannot both add it);
 *  - someone who is already a lead of this workspace is marked so, with the lead linked;
 *  - a person is scored against the play's ICP when it has one;
 *  - once the play has `PENDING_CAP_PER_PLAY` candidates waiting, or `UNAPPROVED_CAP_PER_PLAY`
 *    that were not approved (waiting or skipped), nothing more is added.
 */
export async function storeFindings(play: Play, runId: string | null, findings: ApiFinding[], icp: IcpCriteria | null): Promise<StoreResult> {
  const { db } = getDb();
  const orgId = play.orgId;
  const outcomes: FindingOutcome[] = findings.map(() => "invalid" as FindingOutcome);
  const norm = findings.map((f) => normaliseFinding(f));

  const addresses = norm.map((n) => n?.email).filter((e): e is string => !!e);
  const onPlatform = await platformListed(addresses, db);
  const onWorkspace = await workspaceListed(orgId, addresses, db);

  let pending: { index: number; n: Normalised }[] = [];
  const seen = new Set<string>();
  norm.forEach((n, index) => {
    if (!n) return;
    if (n.email && (onPlatform.has(n.email) || onWorkspace.has(n.email))) {
      outcomes[index] = "suppressed";
      return;
    }
    if (seen.has(n.dedupeKey)) {
      outcomes[index] = "duplicate";
      return;
    }
    seen.add(n.dedupeKey);
    pending.push({ index, n });
  });

  // Already a candidate of this play.
  const known = new Set<string>();
  for (const part of chunked(pending.map((p) => p.n.dedupeKey), 500)) {
    const rows = await db.select({ key: playCandidates.dedupeKey }).from(playCandidates).where(and(eq(playCandidates.playId, play.id), eq(playCandidates.orgId, orgId), inArray(playCandidates.dedupeKey, part)));
    for (const r of rows) known.add(r.key);
  }
  pending = pending.filter((p) => {
    if (!known.has(p.n.dedupeKey)) return true;
    outcomes[p.index] = "duplicate";
    return false;
  });

  // Room left: in the review queue, and in the play as a whole.
  let fullBecause: StoreResult["fullBecause"];
  if (pending.length) {
    const [held] = await db
      .select({ waiting: sql<number>`count(*) FILTER (WHERE ${playCandidates.status} = 'pending')::int`, unapproved: sql<number>`count(*) FILTER (WHERE ${playCandidates.status} <> 'approved')::int` })
      .from(playCandidates)
      .where(and(eq(playCandidates.playId, play.id), eq(playCandidates.orgId, orgId)));
    const roomWaiting = Math.max(0, PENDING_CAP_PER_PLAY - (Number(held?.waiting) || 0));
    const roomInPlay = Math.max(0, UNAPPROVED_CAP_PER_PLAY - (Number(held?.unapproved) || 0));
    const room = Math.min(roomWaiting, roomInPlay);
    if (pending.length > room) fullBecause = roomInPlay < roomWaiting ? "unapproved" : "waiting";
    for (const p of pending.slice(room)) outcomes[p.index] = "full";
    pending = pending.slice(0, room);
  }

  // Who is already a lead here: by the lead an engine started from, by address, by profile.
  const people = pending.filter((p) => p.n.kind === "person");
  const hinted = [...new Set(people.map((p) => p.n.leadIdHint).filter((v): v is string => !!v))];
  const ownLeads = new Set<string>();
  for (const part of chunked(hinted, 500)) for (const r of await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.id, part)))) ownLeads.add(r.id);
  const byEmail = new Map<string, string>();
  for (const part of chunked([...new Set(people.map((p) => p.n.email).filter((v): v is string => !!v))], 500)) {
    for (const r of await db.select({ id: leads.id, email: leads.email }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.email, part)))) if (r.email) byEmail.set(r.email.toLowerCase(), r.id);
  }
  const bare = (u: string) => u.replace(/^https?:\/\//i, "");
  const byProfile = new Map<string, string>();
  const profiles = [...new Set(people.map((p) => p.n.linkedinUrl).filter((v): v is string => !!v))];
  for (const part of chunked(profiles, 250)) {
    for (const r of await db.select({ id: leads.id, url: leads.linkedinUrl }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.linkedinUrl, [...part, ...part.map(bare)])))) if (r.url) byProfile.set(bare(r.url), r.id);
  }

  const values: { index: number; row: CandidateValues }[] = [];
  for (const { index, n } of pending) {
    const { leadIdHint, ...fields } = n;
    // An engine may only point at a lead of this workspace; any other id makes the finding unusable.
    if (leadIdHint && !ownLeads.has(leadIdHint)) continue;
    const leadId = n.kind === "person" ? (leadIdHint ?? (n.email ? byEmail.get(n.email) : undefined) ?? (n.linkedinUrl ? byProfile.get(bare(n.linkedinUrl)) : undefined) ?? null) : null;
    let score: number | null = null;
    let scoreReasons: string[] = [];
    if (icp && n.kind === "person") {
      const s = scoreLeadRules({ title: n.title, location: n.location, company: { name: n.companyName } }, icp);
      score = Math.min(100, Math.max(0, Math.round(s.score)));
      scoreReasons = (s.reasons ?? []).slice(0, 10).map((r) => cleanText(r, 200)).filter((r): r is string => !!r);
    }
    values.push({ index, row: { ...fields, orgId, playId: play.id, runId, status: "pending", leadId, alreadyLead: !!leadId, score, scoreReasons } });
  }

  const added: PlayCandidate[] = [];
  for (const part of chunked(values, 100)) {
    const inserted = await db.insert(playCandidates).values(part.map((p) => p.row)).onConflictDoNothing({ target: [playCandidates.playId, playCandidates.dedupeKey] }).returning();
    const landed = new Set(inserted.map((r) => r.dedupeKey));
    // Not returned: another run added the same key in the meantime.
    for (const p of part) outcomes[p.index] = landed.has(p.row.dedupeKey) ? "added" : "duplicate";
    added.push(...inserted);
  }

  const counts: Record<FindingOutcome, number> = { added: 0, duplicate: 0, suppressed: 0, invalid: 0, full: 0 };
  for (const o of outcomes) counts[o]++;
  return { outcomes, added, counts, ...(counts.full ? { fullBecause: fullBecause ?? "waiting" } : {}) };
}

// ── Decisions: the only place a play creates a lead ──

export interface Decision {
  id: string;
  decision: "approve" | "skip";
  skipReason?: string;
}
export interface DecideResult {
  approved: number;
  skipped: number;
  leadsCreated: number;
  leadsExisting: number;
  tasksCreated: number;
  enrolled: number;
  queuedForEmail: number;
  notApplied: { id: string; reason: string }[];
  /** The ids whose decision was applied, in the order they were sent. */
  applied: string[];
  stopped?: { reason: "quota" | "error"; message: string };
}

const NOT_FOUND_HERE = "Not found in this workspace.";
const BEING_DECIDED = "Someone else is deciding this one right now. Try again in a moment.";
const NOT_REACHED = "Not processed, because the request stopped before reaching it. It is still waiting for review.";
const PLATFORM_LISTED_REASON = "This person has asked not to be contacted through Scout, so they were not added.";
const WORKSPACE_LISTED_REASON = "This person is on your do-not-contact list, so they were not added.";
const FAULT_MESSAGE = "Something went wrong on our side while approving. Nothing was half-done: what is not listed as approved is still waiting for review. Try again.";

/** Not claimed by an approval that is still in flight. */
const unclaimed = sql`(${playCandidates.decidedAt} IS NULL OR ${playCandidates.decidedAt} < now() - ${sql.raw(`interval '${CLAIM_SECONDS} seconds'`)})`;

/**
 * One workspace's decisions take turns within this process.
 *
 * The claim on a candidate (below) is what stops two approvals of the SAME candidate. This
 * is for two DIFFERENT candidates that are the same person - found by two plays, approved
 * in two requests at once: both would look the person up, both find nobody, and both add
 * (and charge for) the lead. Within a process they now run one after the other.
 */
const turns = new Map<string, Promise<unknown>>();
function inTurn<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const next = (turns.get(orgId) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  turns.set(orgId, tail);
  void tail.then(() => {
    if (turns.get(orgId) === tail) turns.delete(orgId);
  });
  return next;
}

interface PlayContext {
  play: Play;
  /** The play's list, ICP and client - each only when it is this workspace's own. */
  listId: string | null;
  icpId: string | null;
  clientId: string | null;
}

async function loadPlayContext(orgId: string, playId: string): Promise<PlayContext | null> {
  const { db } = getDb();
  const play = await db.query.plays.findFirst({ where: and(eq(plays.id, playId), eq(plays.orgId, orgId)) });
  if (!play) return null;
  // A reference written across a workspace boundary before the ownership checks existed is not followed.
  const list = play.listId ? await db.query.lists.findFirst({ where: and(eq(lists.id, play.listId), eq(lists.orgId, orgId)), columns: { id: true } }) : null;
  const icp = play.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, play.icpId), eq(icps.orgId, orgId)), columns: { id: true } }) : null;
  return { play, listId: list?.id ?? null, icpId: icp?.id ?? null, clientId: play.clientId ?? null };
}

type Approval =
  | { result: "approved"; leadId?: string; created?: boolean; existing?: boolean; task?: boolean; enrollable?: boolean }
  | { result: "not_applied"; reason: string }
  | { result: "stopped"; reason: "quota" | "error"; message: string };

/**
 * Decide candidates: approve (a person becomes a lead, a company is saved, a conversation
 * becomes a task) or skip.
 *
 *  - Only a candidate that is still waiting, in this workspace, is touched. Anything else
 *    is listed in `notApplied` and nothing changes, so sending the same decisions twice
 *    does the work once.
 *  - An approval first CLAIMS the candidate with one conditional update (waiting, and not
 *    claimed by another approval in the last two minutes). Two approvals of one candidate
 *    at the same moment therefore create one lead and charge once: the second finds the
 *    claim taken.
 *  - A new lead is charged to the plan's lead allowance BEFORE it is created. When the
 *    allowance is spent the request stops there: the candidate is released, everything
 *    after it stays waiting, and the answer says so in `stopped`.
 *
 * `userId` is null for approvals the play made by itself (auto-approve).
 */
export function decideCandidates(orgId: string, userId: string | null, decisions: Decision[], opts: { enroll?: boolean } = {}): Promise<DecideResult> {
  return inTurn(orgId, () => decideNow(orgId, userId, decisions, opts));
}

async function decideNow(orgId: string, userId: string | null, decisions: Decision[], opts: { enroll?: boolean }): Promise<DecideResult> {
  const { db } = getDb();
  const out: DecideResult = { approved: 0, skipped: 0, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 0, notApplied: [], applied: [] };
  const ids = [...new Set(decisions.map((d) => d.id))];
  const before = new Map<string, { status: string }>();
  for (const part of chunked(ids, 500)) {
    for (const r of await db.select({ id: playCandidates.id, status: playCandidates.status }).from(playCandidates).where(and(eq(playCandidates.orgId, orgId), inArray(playCandidates.id, part)))) before.set(r.id, r);
  }
  const whyNot = async (id: string): Promise<string> => {
    const [row] = await db.select({ status: playCandidates.status }).from(playCandidates).where(and(eq(playCandidates.id, id), eq(playCandidates.orgId, orgId))).limit(1);
    if (!row) return NOT_FOUND_HERE;
    return row.status === "pending" ? BEING_DECIDED : `Already ${row.status}.`;
  };
  const release = (id: string) =>
    db
      .update(playCandidates)
      .set({ decidedAt: null, decidedBy: null })
      .where(and(eq(playCandidates.id, id), eq(playCandidates.orgId, orgId), eq(playCandidates.status, "pending")))
      .catch(() => {});

  const contexts = new Map<string, PlayContext | null>();
  const contextOf = async (playId: string) => {
    if (!contexts.has(playId)) contexts.set(playId, await loadPlayContext(orgId, playId));
    return contexts.get(playId) ?? null;
  };
  const toEnroll = new Map<string, string[]>();

  for (const d of decisions) {
    if (out.stopped) {
      out.notApplied.push({ id: d.id, reason: NOT_REACHED });
      continue;
    }
    const known = before.get(d.id);
    if (!known) {
      out.notApplied.push({ id: d.id, reason: NOT_FOUND_HERE });
      continue;
    }
    if (known.status !== "pending") {
      out.notApplied.push({ id: d.id, reason: `Already ${known.status}.` });
      continue;
    }
    if (d.decision === "skip") {
      const done = await db
        .update(playCandidates)
        .set({ status: "skipped", skipReason: cleanText(d.skipReason, 200), decidedBy: userId, decidedAt: sql`now()` })
        .where(and(eq(playCandidates.id, d.id), eq(playCandidates.orgId, orgId), eq(playCandidates.status, "pending"), unclaimed))
        .returning({ id: playCandidates.id });
      if (done.length) {
        out.skipped++;
        out.applied.push(d.id);
      } else out.notApplied.push({ id: d.id, reason: await whyNot(d.id) });
      continue;
    }
    const [claimed] = await db
      .update(playCandidates)
      .set({ decidedBy: userId, decidedAt: sql`now()` })
      .where(and(eq(playCandidates.id, d.id), eq(playCandidates.orgId, orgId), eq(playCandidates.status, "pending"), unclaimed))
      .returning();
    if (!claimed) {
      out.notApplied.push({ id: d.id, reason: await whyNot(d.id) });
      continue;
    }
    let r: Approval;
    try {
      const ctx = await contextOf(claimed.playId);
      r = ctx ? await approveClaimed(claimed, ctx, userId) : { result: "not_applied", reason: "Its play no longer exists." };
    } catch (e) {
      // The detail goes to the operator's log; the caller gets a sentence. No customer text in either.
      console.warn(`[plays] approval of candidate ${claimed.id} failed: ${errorLine(e)}`);
      r = { result: "stopped", reason: "error", message: FAULT_MESSAGE };
    }
    if (r.result === "approved") {
      out.approved++;
      out.applied.push(d.id);
      if (r.created) out.leadsCreated++;
      if (r.existing) out.leadsExisting++;
      if (r.task) out.tasksCreated++;
      if (r.leadId && r.enrollable) toEnroll.set(claimed.playId, [...(toEnroll.get(claimed.playId) ?? []), r.leadId]);
    } else if (r.result === "not_applied") {
      out.notApplied.push({ id: d.id, reason: r.reason });
    } else {
      await release(claimed.id);
      out.stopped = { reason: r.reason, message: r.message };
      out.notApplied.push({ id: d.id, reason: r.reason === "quota" ? "Not added: the plan's lead allowance is used up. It is still waiting for review." : NOT_REACHED });
    }
  }

  // Enrolment never starts a campaign: a lead is put in the play's campaign, and the
  // campaign still only sends when it is active.
  if (opts.enroll && toEnroll.size) {
    try {
      for (const [playId, leadIds] of toEnroll) {
        const ctx = await contextOf(playId);
        if (!ctx?.play.campaignId) continue;
        const campaign = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, ctx.play.campaignId), eq(campaigns.orgId, orgId)) });
        if (!campaign) continue;
        const unique = [...new Set(leadIds)];
        const usable = await leadsWithUsableEmail(db, orgId, unique);
        if (usable.ids.length) out.enrolled += (await enrollEligibleLeads(campaign, usable.ids)).enrolled;
        const ready = new Set(usable.ids);
        const rest = unique.filter((id) => !ready.has(id));
        // No usable address yet: looked up in the background, then enrolled (job `play.enroll`).
        for (const part of chunked(rest, 200)) {
          await enqueue(db, "play.enroll", { playId, campaignId: campaign.id, leadIds: part }, { orgId, priority: 1 });
          out.queuedForEmail += part.length;
        }
      }
    } catch (e) {
      console.warn(`[plays] enrolment after approval failed for ${orgId}: ${errorLine(e)}`);
      out.stopped ??= { reason: "error", message: "The approvals were saved, but adding people to the campaign did not finish. Add them from the campaign page." };
    }
  }
  return out;
}

/** Mark a claimed candidate decided. False when it was no longer waiting (decided or removed meanwhile). */
async function finishCandidate(c: PlayCandidate, patch: { status: "approved" | "skipped"; leadId?: string | null; skipReason?: string | null }, userId: string | null, handle?: Db): Promise<boolean> {
  const db = handle ?? getDb().db;
  const done = await db
    .update(playCandidates)
    .set({ status: patch.status, ...(patch.leadId !== undefined ? { leadId: patch.leadId } : {}), ...(patch.skipReason !== undefined ? { skipReason: patch.skipReason } : {}), decidedBy: userId, decidedAt: sql`now()` })
    .where(and(eq(playCandidates.id, c.id), eq(playCandidates.orgId, c.orgId), eq(playCandidates.status, "pending")))
    .returning({ id: playCandidates.id });
  return done.length > 0;
}

const DECIDED_ELSEWHERE = "Decided elsewhere a moment ago.";
const REMOVED_MEANWHILE = "This was removed while it was being approved, so nothing was added.";

/** Why a claimed candidate could not be marked decided: someone else decided it, or it is gone (its play deleted, the person erased). */
async function whyNotFinished(c: PlayCandidate): Promise<string> {
  const { db } = getDb();
  const [still] = await db.select({ id: playCandidates.id }).from(playCandidates).where(and(eq(playCandidates.id, c.id), eq(playCandidates.orgId, c.orgId))).limit(1);
  return still ? DECIDED_ELSEWHERE : REMOVED_MEANWHILE;
}

/** What approving a play's candidate stamps on the lead. */
function leadMarks(c: PlayCandidate, play: Play) {
  const evidence = linkOrNull(c.evidenceUrl, 2000);
  // A company known by name only gets no company row (those are keyed by website), so a
  // template's {{company}} would be empty for this lead. The name is kept on the lead itself,
  // where the template reads it when there is no company row.
  const companyName = c.companyDomain && companyDomainOrNull(c.companyDomain) ? null : cleanText(c.companyName, 200);
  return {
    tags: ["play", `play:${play.id.slice(0, 8)}`],
    custom: { relevant_because: mailSafe(c.relevantBecause), play_id: play.id, play_name: cleanText(play.name, 120) ?? "", ...(evidence ? { evidence_url: evidence } : {}), ...(companyName ? { company_name: companyName } : {}) } as Record<string, unknown>,
  };
}

/** Longest body of a task a play creates. */
const TASK_BODY_MAX = 1_000;

/** What a "go and answer this" task says: the reason and the link, bounded. A link that would not fit whole is left out, never cut. */
function conversationTaskBody(c: PlayCandidate): string {
  const reason = cleanText(c.relevantBecause, 300) ?? "";
  const link = linkOrNull(c.evidenceUrl, 2000);
  if (!link) return reason;
  if (reason.length + 1 + link.length <= TASK_BODY_MAX) return `${reason}\n${link}`;
  return `${reason}\nThe link is too long to show here - open it from the play's approved conversations.`.slice(0, TASK_BODY_MAX);
}

async function approveClaimed(c: PlayCandidate, ctx: PlayContext, userId: string | null): Promise<Approval> {
  const { db } = getDb();
  const orgId = c.orgId;
  const play = ctx.play;

  if (c.kind === "post") {
    // A public conversation has nobody to add: it becomes a task to go and answer it. The
    // decision and the task are written together, so a conversation that was decided or
    // removed while this was under way (its play deleted) leaves no task behind.
    const done = await db.transaction(async (tx) => {
      if (!(await finishCandidate(c, { status: "approved" }, userId, tx as unknown as Db))) return false;
      await tx.insert(tasks).values({ orgId, type: "reply_public", title: "Answer this conversation", body: conversationTaskBody(c), dueAt: new Date(), assigneeUserId: userId });
      return true;
    });
    if (!done) return { result: "not_applied", reason: await whyNotFinished(c) };
    return { result: "approved", task: true };
  }

  if (c.kind === "company") {
    const domain = c.companyDomain ? companyDomainOrNull(c.companyDomain) : null;
    if (domain) {
      await upsertCompany(orgId, domain, { name: cleanText(c.companyName, 200) ?? undefined });
      await db.update(companies).set({ signalsCount: sql`${companies.signalsCount} + 1`, lastSignalAt: new Date(), intentScore: sql`LEAST(100, ${companies.intentScore} + 20)` }).where(and(eq(companies.orgId, orgId), eq(companies.domain, domain)));
    }
    if (!(await finishCandidate(c, { status: "approved" }, userId))) return { result: "not_applied", reason: await whyNotFinished(c) };
    return { result: "approved" };
  }

  const marks = leadMarks(c, play);

  // A recorded job change: the candidate IS a lead the workspace already has. It is tagged,
  // the reason is stored, and a person is asked to reach out - the address on file is
  // probably the old employer's, so it is not enrolled anywhere.
  if (c.signalType === "job_change") {
    const lead = c.leadId ? await db.query.leads.findFirst({ where: and(eq(leads.id, c.leadId), eq(leads.orgId, orgId)) }) : null;
    if (!lead) {
      await finishCandidate(c, { status: "skipped", skipReason: "The lead this was about no longer exists." }, userId);
      return { result: "not_applied", reason: "The lead this was about no longer exists." };
    }
    // Do-not-contact, again: asking a person to reach out is contact too.
    const block = await contactBlock(orgId, [canonicalEmail(lead.email), lead.email], { leadStatus: lead.status, db });
    if (block) {
      await finishCandidate(c, { status: "skipped", skipReason: "On a do-not-contact list." }, userId);
      return { result: "not_applied", reason: block.list === "platform" ? PLATFORM_LISTED_REASON : WORKSPACE_LISTED_REASON };
    }
    // The decision, the marks on the lead and the task are written together: decided or
    // removed meanwhile, and none of them is.
    const done = await db.transaction(async (tx) => {
      if (!(await finishCandidate(c, { status: "approved", leadId: lead.id }, userId, tx as unknown as Db))) return false;
      await tx
        .update(leads)
        .set({ tags: [...new Set([...(lead.tags ?? []), ...marks.tags])], custom: { ...((lead.custom as Record<string, unknown> | null) ?? {}), ...marks.custom }, updatedAt: new Date() })
        .where(and(eq(leads.id, lead.id), eq(leads.orgId, orgId)));
      await tx.insert(tasks).values({ orgId, leadId: lead.id, type: "job_change", title: "Reach out about the move", body: (cleanText(c.relevantBecause, 300) ?? "").slice(0, TASK_BODY_MAX), dueAt: new Date(), assigneeUserId: userId });
      return true;
    });
    if (!done) return { result: "not_applied", reason: await whyNotFinished(c) };
    await emitEvent(orgId, "play.candidate_approved", { leadId: lead.id, playId: play.id, candidateId: c.id }, { type: "lead", id: lead.id });
    return { result: "approved", leadId: lead.id, existing: true, task: true };
  }

  // Do-not-contact, again: the lists may have changed since the candidate was found.
  const email = canonicalEmail(c.email);
  if (email) {
    if ((await platformListed([email], db)).size) {
      // The address may not be kept at all, so the candidate goes.
      await db.delete(playCandidates).where(and(eq(playCandidates.id, c.id), eq(playCandidates.orgId, orgId)));
      return { result: "not_applied", reason: PLATFORM_LISTED_REASON };
    }
    if ((await workspaceListed(orgId, [email], db)).size) {
      await finishCandidate(c, { status: "skipped", skipReason: "On your do-not-contact list." }, userId);
      return { result: "not_applied", reason: WORKSPACE_LISTED_REASON };
    }
  }

  const source = `play:${play.type}`;
  // The same lookup the upsert makes: someone this workspace already has is not charged for.
  const existing = await findExistingLead(orgId, { email, linkedinUrl: c.linkedinUrl });
  let charged = false;
  if (!existing) {
    const charge = await chargeNewLead(orgId, source);
    if (!charge.ok) return { result: "stopped", reason: charge.reason, message: charge.reason === "quota" ? `Stopped: ${charge.message} The people not yet approved are still waiting for review.` : FAULT_MESSAGE };
    charged = true;
  }
  const refund = async () => {
    if (charged) await consume(db, orgId, "leads", -1, { allowOverage: true }).catch(() => {});
    charged = false;
  };
  let lead;
  let created: boolean;
  try {
    // Cleaned again here: what goes on the lead is what a reviewer was shown (candidateOut),
    // whatever the stored row holds.
    const profile = c.linkedinUrl ? linkOrNull(profileUrlOrNull(c.linkedinUrl, 500), 500) : null;
    ({ lead, created } = await upsertLead(
      orgId,
      {
        firstName: cleanText(c.firstName, 200),
        lastName: cleanText(c.lastName, 200),
        fullName: cleanText(c.fullName, 200),
        title: cleanText(c.title, 300),
        email,
        emailStatus: email ? (c.emailStatus ?? "unknown") : undefined,
        linkedinUrl: profile,
        location: cleanText(c.location, 300),
        companyName: cleanText(c.companyName, 200),
        companyDomain: c.companyDomain ? companyDomainOrNull(c.companyDomain) : null,
        source,
        tags: marks.tags,
        icpId: ctx.icpId,
        score: c.score,
        scoreReasons: c.scoreReasons?.length ? c.scoreReasons.slice(0, 10).map((r) => cleanText(r, 200)).filter((r): r is string => !!r) : undefined,
        custom: marks.custom,
      },
      { fillOnly: true },
    ));
  } catch (e) {
    await refund();
    throw e;
  }
  // Charged for a new lead, and the upsert found the person after all: nothing was added.
  if (!created) await refund();

  // The candidate is marked approved before anything else is hung on the lead, and the
  // answer to that is honoured. While this approval was under way the candidate may have
  // been decided by someone else - or have gone altogether: its play deleted, or the person
  // erased at their own request.
  if (!(await finishCandidate(c, { status: "approved", leadId: lead.id }, userId))) {
    const [still] = await db.select({ status: playCandidates.status }).from(playCandidates).where(and(eq(playCandidates.id, c.id), eq(playCandidates.orgId, orgId))).limit(1);
    // Approved elsewhere: that approval stands, and the lead is the one it found or made.
    if (still?.status === "approved") return { result: "not_applied", reason: DECIDED_ELSEWHERE };
    // Skipped elsewhere, or gone. A lead this approval made a moment ago is taken back out
    // (a skipped person was not wanted, an erased person must not come back as a lead, and a
    // deleted play adds nobody), and what it cost is given back. A lead the workspace
    // already had is left exactly as it was found.
    if (created) {
      try {
        let removed = false;
        if (still) {
          // Skipped: the candidate stays as the record of that decision, so only the lead and
          // the events about it go (the erasure routine would take the candidate as well).
          removed = await db.transaction(async (tx) => {
            await tx.delete(events).where(and(eq(events.orgId, orgId), sql`(${eq(events.entityId, lead.id)} OR ${events.data}->>'leadId' = ${lead.id} OR (${events.type} LIKE 'lead.%' AND ${events.data}->>'id' = ${lead.id}))`));
            return (await tx.delete(leads).where(and(eq(leads.id, lead.id), eq(leads.orgId, orgId))).returning({ id: leads.id })).length > 0;
          });
        } else {
          const { eraseLeads } = await import("../lib/privacyErase.js");
          removed = (await eraseLeads(orgId, [lead.id])).deleted.length > 0;
        }
        if (removed) await refund();
      } catch (e) {
        console.warn(`[plays] could not take back a lead whose candidate was removed mid-approval (${lead.id}): ${errorLine(e)}`);
      }
    }
    return { result: "not_applied", reason: still ? DECIDED_ELSEWHERE : "This was removed while it was being approved, so nobody was added." };
  }

  if (ctx.listId) await db.insert(listLeads).values({ listId: ctx.listId, leadId: lead.id }).onConflictDoNothing();
  if (ctx.clientId) {
    // The lead is saved (and paid for) by now: a failed claim must not undo the approval.
    try {
      const { claimSearchLeads } = await import("./clients.js");
      await claimSearchLeads(db, orgId, ctx.clientId, [lead.id]);
    } catch (e) {
      console.warn(`[plays] client claim failed for play ${play.id}: ${errorLine(e)}`);
    }
  }
  await emitEvent(orgId, "play.candidate_approved", { leadId: lead.id, playId: play.id, candidateId: c.id }, { type: "lead", id: lead.id });
  return { result: "approved", leadId: lead.id, created, existing: !created, enrollable: true };
}

// ── Running a play ──

/**
 * What an engine may use for this workspace: a deadline, and - when the workspace has an AI
 * engine and has not turned AI assistance off - that engine, metered.
 *
 * The metering is in the engine handed over, not in a promise that whoever uses it will
 * count: every call that reaches the model is one AI message, recorded when the model has
 * answered (a call that fails is not charged). `beforeAiCall` only says whether there is
 * allowance left, so an engine can stop preparing calls it could not make; once the
 * allowance is spent the engine itself refuses, and the run carries on by rules.
 */
export function engineOptions(org: Pick<Organization, "id" | "plan" | "settings">, deadlineAt: number, aiIn?: AiProvider): PlayEngineOptions {
  const ai = aiIn ?? aiForOrg(org);
  // No engine, or the workspace turned AI assistance off: rules only, and nothing is metered.
  if (!hasAi(ai)) return { deadlineAt };
  const { db } = getDb();
  let open = true;
  const room = async (): Promise<boolean> => {
    if (!open) return false;
    try {
      await assertQuotaAvailable(db, org.id, "aiMessages", 1);
      return true;
    } catch {
      // Spent - or usage cannot be read, in which case nothing more is spent blind.
      open = false;
      return false;
    }
  };
  const metered: AiProvider = {
    name: ai.name,
    model: ai.model,
    complete: async (messages, options) => {
      if (!(await room())) throw new Error("the AI allowance for this month is used up");
      const out = await ai.complete(messages, options);
      // Recorded even past the limit: the call has happened.
      await consume(db, org.id, "aiMessages", 1, { allowOverage: true }).catch(() => {});
      return out;
    },
  };
  return { ai: metered, deadlineAt, beforeAiCall: room };
}

const BLOCKED_DEFAULT = "Nothing could be looked at this time, so this is not a result about your market. Try again later.";

/** What a play approved by itself, and what it left for a person. */
function autoApproveNotes(auto: AutoApproved | null | undefined): string[] {
  if (!auto) return [];
  const parts: string[] = [];
  if (auto.approved) parts.push(`${plural(auto.approved, "person was", "people were")} approved automatically.`);
  if (auto.stopped) parts.push(auto.stopped.message);
  else if (auto.left) parts.push(`${plural(auto.left, "more person is", "more people are")} waiting in Review: at most ${AUTO_APPROVE_INLINE_MAX} are approved automatically at a time here, so approve the rest there.`);
  return parts;
}

function runNote(input: { found: number; counts: Record<FindingOutcome, number>; covered: number; autoApproved?: AutoApproved | null; trace: PlayRunTrace; blocked: boolean; own?: string[]; fullBecause?: StoreResult["fullBecause"] }): string {
  const { found, counts, trace } = input;
  const parts: string[] = [];
  if (input.blocked) parts.push(customerText(trace.blockedReason, 400) || BLOCKED_DEFAULT);
  else if (found === 0) parts.push("Nothing was found this time.");
  else {
    const seen = counts.duplicate + input.covered;
    parts.push(`Found ${found}: ${counts.added} new${seen ? `, ${seen} already seen` : ""}.`);
  }
  if (counts.suppressed) parts.push(`${plural(counts.suppressed, "person was", "people were")} left out because they are on a do-not-contact list.`);
  if (counts.invalid) parts.push(`${plural(counts.invalid, "result was", "results were")} left out for lack of a reason or a way to identify them.`);
  if (counts.full) parts.push(`${plural(counts.full, "result was", "results were")} not added because ${fullSentence(input.fullBecause)}`);
  parts.push(...autoApproveNotes(input.autoApproved));
  for (const n of input.own ?? []) if (!parts.includes(n)) parts.push(n);
  const notes = (trace.notes ?? []).map((n) => customerText(n, 240)).filter(Boolean);
  for (const n of [...new Set(notes)].slice(0, 3)) if (!parts.includes(n)) parts.push(n);
  return parts.join(" ").slice(0, 1_500);
}

interface RunOutcome {
  status: "done" | "failed" | "blocked";
  found: number;
  added: number;
  duplicates: number;
  note: string;
  error?: string | null;
}

/**
 * Write a run's result on the run, and on the play (with its next scheduled time).
 *
 * Only a run that is still `running` is finished: null means something else closed it first
 * (the sweep for runs whose job is gone), and whoever closed it also gave its search back.
 * So a caller refunds only when this returns the run - once per run, whoever gets there.
 */
async function finishRun(play: Play, runId: string, r: RunOutcome, opts: { reschedule?: boolean } = {}): Promise<PlayRun | null> {
  const { db } = getDb();
  const [row] = await db
    .update(playRuns)
    .set({ status: r.status, found: r.found, added: r.added, duplicates: r.duplicates, note: r.note, error: r.error ?? null, finishedAt: new Date() })
    .where(and(eq(playRuns.id, runId), eq(playRuns.orgId, play.orgId), eq(playRuns.playId, play.id), eq(playRuns.status, "running")))
    .returning();
  if (!row) return null;
  const now = new Date();
  await db
    .update(plays)
    .set({
      lastRunAt: now,
      lastResult: { status: r.status, found: r.found, added: r.added, duplicates: r.duplicates, note: r.note },
      ...(opts.reschedule === false ? {} : { nextRunAt: play.runEveryHours ? new Date(now.getTime() + play.runEveryHours * 3600_000) : null }),
    })
    .where(and(eq(plays.id, play.id), eq(plays.orgId, play.orgId)));
  await emitEvent(play.orgId, "play.ran", { playId: play.id, runId, status: r.status, found: r.found, added: r.added, duplicates: r.duplicates }, { type: "play", id: play.id });
  return row;
}

type AutoApproved = DecideResult & { /** Eligible people left waiting because of `max`. */ left: number };

/**
 * The people a play approves by itself: only when it says so, only people, only at or above
 * its score - and at most `max` of them (best score first) when the approving happens inside
 * a request. Six hundred uploaded rows used to be approved one by one while the request
 * waited, and every other decision in the workspace waited behind them.
 */
async function autoApprove(play: Play, added: PlayCandidate[], max = Number.POSITIVE_INFINITY): Promise<AutoApproved | null> {
  if (!play.autoApprove) return null;
  const eligible = added.filter((c) => c.kind === "person" && (play.minScore <= 0 || (c.score ?? -1) >= play.minScore));
  if (!eligible.length) return null;
  const now = eligible.length > max ? [...eligible].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, max) : eligible;
  // Approved, never enrolled: putting someone in a campaign takes a person's say-so.
  const r = await decideCandidates(play.orgId, null, now.map((c) => ({ id: c.id, decision: "approve" as const })), { enroll: false });
  return { ...r, left: eligible.length - now.length };
}

/** Has this workspace an open request to be deleted? */
async function deletionPending(orgId: string): Promise<boolean> {
  const { db } = getDb();
  const rows = (await db.execute(sql`SELECT 1 FROM workspace_deletion_requests WHERE org_id = ${orgId} AND cancelled_at IS NULL AND completed_at IS NULL LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Run one play: the job `play.run`.
 *
 * The search unit for the run was charged by whoever started it (the route or the
 * scheduler) and is given back when the run could not look at anything or broke. A plan
 * limit met along the way ends in a note, not an exception; only a real fault throws.
 */
export async function runPlay(play: Play, runId: string, ctx: { log?: (m: string) => void; charged?: boolean } = {}): Promise<Record<string, unknown>> {
  const { db } = getDb();
  const log = ctx.log ?? (() => {});
  const run = await db.query.playRuns.findFirst({ where: and(eq(playRuns.id, runId), eq(playRuns.playId, play.id), eq(playRuns.orgId, play.orgId)) });
  if (!run) return { skipped: "missing run" };
  const refund = async () => {
    if (ctx.charged) await consume(db, play.orgId, "searches", -1, { allowOverage: true }).catch(() => {});
  };
  // Finished already - by an earlier attempt, or closed as lost (and its search given back then).
  if (run.status !== "running") return { skipped: "already finished", status: run.status };
  const stop = async (skipped: string, note: string) => {
    if (await finishRun(play, run.id, { status: "failed", found: 0, added: 0, duplicates: 0, note })) await refund();
    return { skipped };
  };

  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, play.orgId) });
  if (!org || org.status !== "active") return stop("organization not active", "This workspace is not active, so the play did not run.");
  // Paused after the schedule queued this run: a paused play is never run by the schedule.
  // (A run a person starts on a paused play is their own decision and goes ahead.) The run
  // never started, so there is no run to show - the play says why, and the search is given back.
  // The same for a workspace that asked to be deleted after the schedule queued this run:
  // it starts nothing new by itself while that request is open (its campaigns are paused too).
  const notNow =
    run.trigger !== "schedule"
      ? null
      : play.status !== "active"
        ? { skipped: "paused", note: "Not run on schedule: the play was paused before its run started." }
        : (await deletionPending(play.orgId))
          ? { skipped: "workspace scheduled for deletion", note: "Not run on schedule: this workspace is scheduled for deletion. Cancel the deletion in Settings to run plays again." }
          : null;
  if (notNow) {
    const removed = await db.delete(playRuns).where(and(eq(playRuns.id, run.id), eq(playRuns.orgId, play.orgId), eq(playRuns.status, "running"))).returning({ id: playRuns.id });
    if (removed.length) {
      await db
        .update(plays)
        .set({ lastResult: { status: "skipped", found: 0, added: 0, duplicates: 0, note: notNow.note } })
        .where(and(eq(plays.id, play.id), eq(plays.orgId, play.orgId)));
      await refund();
    }
    return { skipped: notNow.skipped };
  }
  if (play.type === "engagers_upload") return stop("upload play", "This play is fed by uploads - add people with Upload.");
  const cfg = PLAY_CONFIG[play.type].safeParse(play.config ?? {});
  if (!cfg.success) return stop("invalid settings", "This play's settings are no longer valid. Open it, check the fields and save it again.");

  try {
    // The ICP is this workspace's own or it is not used.
    const icpRow = play.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, play.icpId), eq(icps.orgId, play.orgId)) }) : null;
    const icp = (icpRow?.criteria as IcpCriteria | undefined) ?? null;
    // With no worker (inline mode) the run happens inside a request that the platform cuts
    // off after about a minute, so it stops starting new work well before that.
    const startedAt = Date.now();
    const allowed = env.jobMode === "inline" ? RUN_DEADLINE_INLINE_MS : RUN_DEADLINE_MS;
    const deadlineAt = startedAt + allowed;
    // A play that names who to look for keeps part of its time for looking: a source engine
    // that used all of it would leave every company without its people.
    const willLookForPeople = (play.targetTitles ?? []).length > 0;
    const opts = engineOptions(org, willLookForPeople ? startedAt + Math.floor(allowed * ENGINE_SHARE_WITH_PEOPLE) : deadlineAt);

    const outcome: EngineOutcome = await runPlayEngine({ type: play.type, config: cfg.data as Record<string, unknown>, org, opts });
    let trace = outcome.trace;
    // An engine's hard maximum is 200 findings; whatever comes back, no more than that is read.
    const expanded = await expandCompanies(play, outcome.findings.slice(0, 200), { ...opts, deadlineAt }, deadlineAt);
    trace = addTrace(trace, expanded.trace);

    const stored = await storeFindings(play, run.id, expanded.findings, icp);
    const found = expanded.findings.length + expanded.covered;
    const blocked = trace.blocked && found === 0;
    const auto = blocked ? null : await autoApprove(play, stored.added, env.jobMode === "inline" ? AUTO_APPROVE_INLINE_MAX : undefined);
    const result: RunOutcome = {
      status: blocked ? "blocked" : "done",
      found,
      added: stored.counts.added,
      duplicates: stored.counts.duplicate + expanded.covered,
      note: runNote({ found, counts: stored.counts, covered: expanded.covered, autoApproved: auto, trace, blocked, own: expanded.notes, fullBecause: stored.fullBecause }),
    };
    const finished = await finishRun(play, run.id, result);
    if (blocked && finished) await refund();
    // Counts only: what a play looks for is the customer's text and stays out of the log.
    log(`play ${play.id} ${result.status}: found ${result.found}, added ${result.added}, already seen ${result.duplicates}`);
    // The job's result holds numbers, not the note: the note can quote what the play looks for.
    return { runId: run.id, status: result.status, found: result.found, added: result.added, duplicates: result.duplicates, ...(auto ? { autoApproved: auto.approved, leadsCreated: auto.leadsCreated, ...(auto.stopped ? { skipped: auto.stopped.reason === "quota" ? "quota" : "error", detail: auto.stopped.message } : {}) } : {}) };
  } catch (e) {
    const line = errorLine(e);
    // If even this cannot be written, the run stays `running` and the sweep for runs whose
    // job is gone closes it and gives the search back - so it is not given back here as well.
    const closed = await finishRun(play, run.id, { status: "failed", found: 0, added: 0, duplicates: 0, note: "The run stopped because of a fault on our side. Run it again.", error: customerText(line, 500) }).catch(() => null);
    if (closed) await refund();
    // Rethrown without the original message: it can echo what the play searched for.
    throw new Error(`play run failed: ${(e as Error)?.name ?? "Error"}`);
  }
}

/**
 * Turn company findings into people, where the play names who to look for.
 *
 * At most `PEOPLE_SEARCHES_PER_RUN` companies per run, and only companies this play has not
 * met before - one already waiting as a candidate, or whose people it already holds, is
 * not searched again (a reviewer can still press "Find people" on it). A company where
 * nobody was found stays a company candidate.
 *
 * One company can cost up to eleven web searches (its website, then one or two per title),
 * so the searches run a few at a time and none is started after the run's deadline; the
 * engine itself gives up on a search still in flight when the deadline passes. Whatever
 * was not reached stays a company candidate, and the run's note says how many.
 */
async function expandCompanies(play: Play, findings: ApiFinding[], opts: PlayEngineOptions, deadlineAt: number): Promise<{ findings: ApiFinding[]; covered: number; trace: Partial<PlayRunTrace>; notes: string[] }> {
  const titles = (play.targetTitles ?? []).map((t) => cleanText(t, 100)).filter((t): t is string => !!t).slice(0, 10);
  const companiesFound = findings.map((f, index) => ({ index, n: f?.kind === "company" ? normaliseFinding(f) : null })).filter((x): x is { index: number; n: Normalised } => !!x.n);
  if (!titles.length || !companiesFound.length) return { findings, covered: 0, trace: {}, notes: [] };
  const { db } = getDb();
  const mine = and(eq(playCandidates.playId, play.id), eq(playCandidates.orgId, play.orgId));
  const waiting = new Set<string>();
  for (const part of chunked([...new Set(companiesFound.map((c) => c.n.dedupeKey))], 500)) {
    for (const r of await db.select({ key: playCandidates.dedupeKey }).from(playCandidates).where(and(mine, inArray(playCandidates.dedupeKey, part)))) waiting.add(r.key);
  }
  const names = [...new Set(companiesFound.map((c) => c.n.companyName?.toLowerCase()).filter((v): v is string => !!v))];
  const domains = [...new Set(companiesFound.map((c) => c.n.companyDomain).filter((v): v is string => !!v))];
  const withPeople = new Set<string>();
  for (const part of chunked(names, 250)) {
    for (const r of await db.selectDistinct({ name: sql<string>`lower(${playCandidates.companyName})` }).from(playCandidates).where(and(mine, eq(playCandidates.kind, "person"), inArray(sql`lower(${playCandidates.companyName})`, part)))) withPeople.add(`n:${r.name}`);
  }
  for (const part of chunked(domains, 250)) {
    for (const r of await db.selectDistinct({ domain: playCandidates.companyDomain }).from(playCandidates).where(and(mine, eq(playCandidates.kind, "person"), inArray(playCandidates.companyDomain, part)))) if (r.domain) withPeople.add(`d:${r.domain}`);
  }

  /* What becomes of each finding: kept as it is, already represented by its people, or searched. */
  const byIndex = new Map(companiesFound.map((c) => [c.index, c.n]));
  type Slot = { f: ApiFinding; search?: boolean; covered?: boolean; people?: ApiFinding[] };
  const slots: Slot[] = [];
  const meeting = new Set<string>();
  let overBudget = 0;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const n = byIndex.get(i);
    // Not a company; one already waiting in the queue; or the same company twice in this run: stored (or counted as a duplicate) as it is.
    if (!n || waiting.has(n.dedupeKey) || meeting.has(n.dedupeKey)) slots.push({ f });
    else if ((n.companyDomain && withPeople.has(`d:${n.companyDomain}`)) || (n.companyName && withPeople.has(`n:${n.companyName.toLowerCase()}`))) slots.push({ f, covered: true });
    else {
      meeting.add(n.dedupeKey);
      if (meeting.size <= PEOPLE_SEARCHES_PER_RUN) slots.push({ f, search: true });
      else {
        overBudget++;
        slots.push({ f });
      }
    }
  }

  /* The searches, a few at a time, none started after the deadline. One company's search can take several web searches. */
  const toSearch = slots.filter((x) => x.search);
  const traces: (Partial<PlayRunTrace> | undefined)[] = [];
  let searched = 0;
  let failed = 0;
  await pMap(
    toSearch,
    async (slot) => {
      if (Date.now() >= deadlineAt) return;
      searched++;
      try {
        const r = await playEngines().findPeopleForFinding(slot.f, { titles, limit: PEOPLE_PER_COMPANY }, opts);
        traces.push(r?.trace);
        slot.people = Array.isArray(r?.people) ? r.people.slice(0, PEOPLE_PER_COMPANY) : [];
        // "Could not search" is not "nobody works there": counted, and said in the run's note.
        if (!slot.people.length && r?.trace?.blocked === true) failed++;
      } catch {
        failed++;
      }
    },
    PEOPLE_SEARCH_CONCURRENCY,
  );

  const out: ApiFinding[] = [];
  let covered = 0;
  for (const slot of slots) {
    if (slot.covered) covered++;
    else if (slot.people?.length) for (const p of slot.people) out.push(inheritFrom(slot.f, p));
    else out.push(slot.f);
  }
  let trace: PlayRunTrace = { searches: 0, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [], blocked: false };
  for (const t of traces) trace = addTrace(trace, t);

  // Said first, in the run's own words: what the reviewer will see in the queue and what to do about it.
  const notes: string[] = [];
  const unreached = toSearch.length - searched;
  if (unreached > 0) notes.push(`The run reached its time limit, so people were looked for at ${searched} of ${plural(toSearch.length, "company", "companies")}. The other ${unreached === 1 ? "one is" : `${unreached} are`} listed as ${unreached === 1 ? "a company" : "companies"} - press Find people on ${unreached === 1 ? "it" : "any of them"}.`);
  if (overBudget > 0) notes.push(`People were looked for at the first ${PEOPLE_SEARCHES_PER_RUN} new companies. The other ${overBudget === 1 ? "one is" : `${overBudget} are`} listed as ${overBudget === 1 ? "a company" : "companies"} - press Find people on ${overBudget === 1 ? "it" : "any of them"}.`);
  if (failed) notes.push(`The people search could not run for ${plural(failed, "company", "companies")}; ${failed === 1 ? "it is" : "they are"} listed as ${failed === 1 ? "a company" : "companies"} instead.`);
  return { findings: out, covered, trace, notes };
}

/** A person found at a company carries the company's reason and proof - never their own invented one. */
function inheritFrom(company: ApiFinding, person: ApiFinding): ApiFinding {
  return {
    ...person,
    kind: "person",
    companyName: person.companyName ?? company.companyName,
    companyDomain: person.companyDomain ?? company.companyDomain,
    relevantBecause: company.relevantBecause,
    evidenceUrl: company.evidenceUrl,
    evidenceTitle: company.evidenceTitle,
    evidenceQuote: company.evidenceQuote,
    signalType: company.signalType,
    signalAt: company.signalAt,
    confidence: Math.min(typeof person.confidence === "number" ? person.confidence : 1, typeof company.confidence === "number" ? company.confidence : 1),
  };
}

function findingOf(c: PlayCandidate): ApiFinding {
  return {
    kind: c.kind as ApiFinding["kind"],
    companyName: c.companyName ?? undefined,
    companyDomain: c.companyDomain ?? undefined,
    relevantBecause: c.relevantBecause,
    evidenceUrl: c.evidenceUrl ?? undefined,
    evidenceTitle: c.evidenceTitle ?? undefined,
    evidenceQuote: c.evidenceQuote ?? undefined,
    signalType: c.signalType,
    signalAt: c.signalAt ?? undefined,
    confidence: c.confidence,
  };
}

/**
 * "Find people" on one company candidate: people with the wanted titles, added to the same
 * play with the company's reason and proof. The caller has already charged the search.
 */
export async function findPeopleForCandidate(candidate: PlayCandidate, play: Play, input: { titles: string[]; limit: number }): Promise<{ added: PlayCandidate[]; blocked: boolean; found: number; note?: string }> {
  const { db } = getDb();
  const company = findingOf(candidate);
  const r = await playEngines().findPeopleForFinding(company, { titles: input.titles, limit: input.limit }, { deadlineAt: Date.now() + 60_000 });
  const people = (Array.isArray(r?.people) ? r.people : []).slice(0, input.limit).map((p) => inheritFrom(company, p));
  const where = candidate.companyName ?? candidate.companyDomain ?? "that company";
  if (!people.length) {
    const blocked = r?.trace?.blocked === true;
    return { added: [], blocked, found: 0, note: blocked ? customerText(r.trace.blockedReason, 300) || "The people search could not run this time, so this is not a finding that nobody works there. Try again later." : `Nobody with those titles was found at ${where}.` };
  }
  const icpRow = play.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, play.icpId), eq(icps.orgId, play.orgId)) }) : null;
  const stored = await storeFindings(play, candidate.runId, people, (icpRow?.criteria as IcpCriteria | undefined) ?? null);
  const notes: string[] = [];
  if (stored.counts.duplicate) notes.push(`${plural(stored.counts.duplicate, "person was", "people were")} already in this play.`);
  if (stored.counts.suppressed) notes.push(`${plural(stored.counts.suppressed, "person was", "people were")} left out because they are on a do-not-contact list.`);
  if (stored.counts.full) notes.push(`${plural(stored.counts.full, "person was", "people were")} not added because ${fullSentence(stored.fullBecause)}`);
  return { added: stored.added, blocked: false, found: people.length, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

// ── Uploads (engagers) ──

export interface EngagerUpload {
  engagement: Engagement;
  postUrl?: string;
  postTitle?: string;
  postAuthor?: string;
  /** The rows, each with the number the person who uploaded them would call it (1-based). */
  rows: { row: number; data: EngagerRow }[];
  /** Rows already refused before they got here (an unusable CSV line). */
  rejected?: { row: number; reason: string }[];
  /** Set instead of rows when a post could not be read: the run is recorded as blocked with this sentence. */
  blockedNote?: string;
}

const UNUSABLE_ROW = "Needs a LinkedIn profile link, an email address, or a name with a company.";

/** Take an uploaded list of people who engaged into a play's review queue. Creates no lead (unless the play auto-approves). */
export async function ingestEngagers(play: Play, input: EngagerUpload) {
  const { db } = getDb();
  const rejected = [...(input.rejected ?? [])];
  const findings: ApiFinding[] = [];
  const rowOf: number[] = [];
  const ctx = { engagement: input.engagement, postUrl: input.postUrl, postTitle: input.postTitle, postAuthor: input.postAuthor, when: new Date() };
  for (const { row, data } of input.rows) {
    const name = data.fullName ?? [data.firstName, data.lastName].filter(Boolean).join(" ");
    if (!(data.linkedinUrl || data.email || (name && (data.companyName || data.companyDomain)))) {
      rejected.push({ row, reason: UNUSABLE_ROW });
      continue;
    }
    // One row at a time: each row's verdict is its own, whatever numbering the engine uses.
    const r = playEngines().engagersFromRows([data], ctx);
    const f = r?.findings?.[0];
    if (f) {
      findings.push(f);
      rowOf.push(row);
    } else rejected.push({ row, reason: customerText(r?.rejected?.[0]?.reason, 200) || UNUSABLE_ROW });
  }

  const [run] = await db.insert(playRuns).values({ orgId: play.orgId, playId: play.id, status: "running", trigger: "upload" }).returning();
  try {
    const icpRow = play.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, play.icpId), eq(icps.orgId, play.orgId)) }) : null;
    const stored = await storeFindings(play, run.id, findings, (icpRow?.criteria as IcpCriteria | undefined) ?? null);
    stored.outcomes.forEach((o, i) => {
      if (o === "suppressed") rejected.push({ row: rowOf[i], reason: "On a do-not-contact list, so not added." });
      else if (o === "invalid") rejected.push({ row: rowOf[i], reason: UNUSABLE_ROW });
      else if (o === "full") rejected.push({ row: rowOf[i], reason: `Not added: ${fullSentence(stored.fullBecause)}` });
    });
    rejected.sort((a, b) => a.row - b.row);
    const auto = await autoApprove(play, stored.added, AUTO_APPROVE_INLINE_MAX);
    const total = input.rows.length + (input.rejected?.length ?? 0);
    const blocked = !!input.blockedNote && total === 0;
    // "Not usable" is about the row; "did not fit" is about the play. Said separately, with the numbers.
    const unusable = rejected.length - stored.counts.full;
    const parts = blocked
      ? [input.blockedNote!]
      : [`${plural(total, "row")} read: ${stored.counts.added} added${stored.counts.duplicate ? `, ${stored.counts.duplicate} already in this play` : ""}${unusable > 0 ? `, ${unusable} not usable` : ""}.`];
    if (!blocked && stored.counts.full) parts.push(`${plural(stored.counts.full, "row was", "rows were")} not added because ${fullSentence(stored.fullBecause)}`);
    parts.push(...autoApproveNotes(auto));
    const finished = await finishRun(play, run.id, { status: blocked ? "blocked" : "done", found: total, added: stored.counts.added, duplicates: stored.counts.duplicate, note: parts.join(" ") }, { reschedule: false });
    return {
      run: finished ?? run,
      added: stored.counts.added,
      duplicates: stored.counts.duplicate,
      rejected: rejected.slice(0, 50),
      rejectedCount: rejected.length,
      // Rows that were usable but did not fit in the play, with the sentence that says why.
      ...(stored.counts.full ? { notAdded: { count: stored.counts.full, reason: `Not added: ${fullSentence(stored.fullBecause)}` } } : {}),
      ...(auto ? { autoApproved: auto.approved, ...(auto.left ? { leftForReview: auto.left } : {}) } : {}),
    };
  } catch (e) {
    await finishRun(play, run.id, { status: "failed", found: 0, added: 0, duplicates: 0, note: "The upload stopped because of a fault on our side. Nothing was half-added - upload it again.", error: customerText(errorLine(e), 500) }, { reschedule: false }).catch(() => {});
    throw e;
  }
}

// ── Planning (POST /v1/plays/plan) ──

/** The competitors a workspace saved for AI visibility: reused, never asked for twice. */
export function savedCompetitors(org: { settings?: unknown } | null | undefined): { name: string; domain?: string }[] {
  const list = ((org?.settings as { visibility?: { competitors?: unknown } } | null | undefined)?.visibility?.competitors ?? []) as unknown;
  if (!Array.isArray(list)) return [];
  const out: { name: string; domain?: string }[] = [];
  for (const c of list.slice(0, 10)) {
    const name = cleanText((c as { name?: unknown })?.name, 120);
    if (!name) continue;
    const domain = companyDomainOrNull((c as { domain?: unknown })?.domain);
    out.push({ name, ...(domain ? { domain } : {}) });
  }
  return out;
}

/**
 * What to run for a product, from its website. Saves nothing.
 *
 * Every suggested play is passed through the same settings schema a created play is, so
 * what is offered can be created as it is; one that does not pass is not offered.
 */
export async function planFor(org: Organization, domain: string) {
  const plan = await playEngines().planPlays({ website: domain, knownCompetitors: savedCompetitors(org) }, engineOptions(org, Date.now() + 90_000));
  const unavailable = await playAvailability(org);
  const titles = (Array.isArray(plan?.titles) ? plan.titles : []).map((t) => cleanText(t, 100)).filter((t): t is string => !!t).slice(0, 20);
  const suggestions: { type: PlayType; name: string; config: Record<string, unknown>; targetTitles: string[]; why: string; available: boolean; unavailableReason?: string }[] = [];
  const offer = (type: unknown, name: unknown, config: unknown, targetTitles: unknown, why: unknown) => {
    if (typeof type !== "string" || !(PLAY_TYPES as readonly string[]).includes(type) || suggestions.some((s) => s.type === type)) return;
    const t = type as PlayType;
    const parsed = PLAY_CONFIG[t].safeParse(config ?? {});
    if (!parsed.success) return;
    const reason = unavailable[t];
    suggestions.push({
      type: t,
      name: cleanText(name, 120) ?? CATALOGUE.find((c) => c.type === t)!.name,
      config: parsed.data as Record<string, unknown>,
      targetTitles: (Array.isArray(targetTitles) ? targetTitles : []).map((x) => cleanText(x, 100)).filter((x): x is string => !!x).slice(0, 20),
      why: cleanText(why, 300) ?? "",
      available: !reason,
      ...(reason ? { unavailableReason: reason } : {}),
    });
  };
  for (const p of Array.isArray(plan?.plays) ? plan.plays.slice(0, 12) : []) offer(p?.type, p?.name, p?.config, p?.targetTitles, p?.why);
  // The two plays that run on the workspace's own data: only the API knows whether they can.
  if (!unavailable.website_visitors) offer("website_visitors", "Companies on your pricing page", {}, titles.length ? titles : BUYER_TITLES, "Your tracking pixel is installed: companies looking at your pricing or demo pages are the warmest list you have.");
  if (!unavailable.job_changes) offer("job_changes", "Contacts who changed jobs", {}, [], "Someone who knew you at their last company is the easiest first conversation at their new one.");

  const trace = plan?.trace;
  const notes = [...new Set([...(trace?.blocked ? [customerText(trace.blockedReason, 300) || "Your website could not be read, so these suggestions are general ones."] : []), ...(Array.isArray(trace?.notes) ? trace.notes : []).map((n) => customerText(n, 240))].filter(Boolean))].slice(0, 8);
  const competitors = (Array.isArray(plan?.competitors) ? plan.competitors : []).slice(0, 15).flatMap((c) => {
    const name = cleanText(c?.name, 120);
    if (!name) return [];
    const d = companyDomainOrNull(c?.domain);
    return [{ name, ...(d ? { domain: d } : {}), source: c?.source === "saved" || c?.source === "site" ? c.source : ("ai" as const) }];
  });
  return {
    // Nothing of the website could be read: what follows is general advice, and the caller does not charge for it.
    siteRead: !trace?.blocked,
    product: { domain: companyDomainOrNull(plan?.product?.domain) ?? domain, ...(cleanText(plan?.product?.name, 200) ? { name: cleanText(plan?.product?.name, 200)! } : {}), ...(cleanText(plan?.product?.description, 600) ? { description: cleanText(plan?.product?.description, 600)! } : {}) },
    icp: cleanIcp(plan?.icp),
    titles,
    competitors,
    plays: suggestions,
    notes,
  };
}

const ICP_KEYS = ["industries", "titles", "seniorities", "departments", "companySizes", "locations", "countries", "keywords", "excludeKeywords", "techStack"] as const;
function cleanIcp(raw: unknown): IcpCriteria {
  const out: IcpCriteria = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of ICP_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (!Array.isArray(v)) continue;
    const list = v.map((x) => cleanText(x, 120)).filter((x): x is string => !!x).slice(0, 20);
    if (list.length) out[k] = list;
  }
  return out;
}

// ── Results per play ──

export interface PlayPerformanceRow {
  playId: string;
  name: string;
  type: string;
  found: number;
  pending: number;
  approved: number;
  skipped: number;
  leads: number;
  contacted: number;
  replied: number;
  positive: number;
  replyRate: number | null;
  positiveRate: number | null;
  sufficient: boolean;
}

/** Below this many people contacted, a rate is an anecdote. The same bar as the Sources table. */
export const SUFFICIENT_CONTACTED = 20;

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : Array.isArray((res as { rows?: unknown })?.rows) ? ((res as { rows: T[] }).rows) : []);

/**
 * Each play judged by what happened after it found someone.
 *
 * Windowed by when the CANDIDATE was created. `found` is every candidate in the window;
 * the rest follow the approved ones' leads:
 *
 *   contacted  an outbound message was sent to the lead after the candidate was approved
 *   replied    of those, a reply is on record (a sent message marked replied, or an inbound one)
 *   positive   of those, an inbound message triaged `interested` or `referral` - the
 *              definition services/insights.ts uses
 *
 * Only messages from the approval onwards count: a lead the workspace was already talking
 * to before the play found them is not that play's result. A lead is counted once per play
 * however many messages it has, and rates are per person CONTACTED, null when nobody was.
 */
export async function playPerformance(orgId: string, days: number) {
  const { db } = getDb();
  const rows = rowsOf<Record<string, string | number>>(
    await withStatementTimeout(db, READ_STATEMENT_MS, (tx) =>
      tx.execute(sql`
        WITH cand AS (
          SELECT play_id, status, lead_id, decided_at
          FROM play_candidates
          WHERE org_id = ${orgId} AND created_at > now() - (${days} || ' days')::interval
        ),
        per_lead AS (
          SELECT play_id, lead_id, min(decided_at) AS since
          FROM cand
          WHERE status = 'approved' AND lead_id IS NOT NULL
          GROUP BY play_id, lead_id
        ),
        touched AS (
          SELECT pl.play_id, pl.lead_id,
                 bool_or(m.direction = 'outbound' AND m.sent_at IS NOT NULL) AS contacted,
                 bool_or((m.direction = 'outbound' AND m.replied_at IS NOT NULL) OR m.direction = 'inbound') AS replied,
                 bool_or(m.direction = 'inbound' AND m.intent IN ('interested','referral')) AS positive
          FROM per_lead pl
          JOIN messages m ON m.lead_id = pl.lead_id AND m.org_id = ${orgId} AND (pl.since IS NULL OR m.created_at >= pl.since)
          GROUP BY pl.play_id, pl.lead_id
        ),
        c AS (
          SELECT play_id,
                 count(*)::int AS found,
                 count(*) FILTER (WHERE status = 'pending')::int AS pending,
                 count(*) FILTER (WHERE status = 'approved')::int AS approved,
                 count(*) FILTER (WHERE status = 'skipped')::int AS skipped
          FROM cand GROUP BY play_id
        ),
        l AS (
          SELECT pl.play_id,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE t.contacted)::int AS contacted,
                 count(*) FILTER (WHERE t.contacted AND t.replied)::int AS replied,
                 count(*) FILTER (WHERE t.contacted AND t.positive)::int AS positive
          FROM per_lead pl
          LEFT JOIN touched t ON t.play_id = pl.play_id AND t.lead_id = pl.lead_id
          GROUP BY pl.play_id
        )
        SELECT p.id, p.name, p.type,
               coalesce(c.found, 0) AS found, coalesce(c.pending, 0) AS pending, coalesce(c.approved, 0) AS approved, coalesce(c.skipped, 0) AS skipped,
               coalesce(l.leads, 0) AS leads, coalesce(l.contacted, 0) AS contacted, coalesce(l.replied, 0) AS replied, coalesce(l.positive, 0) AS positive
        FROM plays p
        LEFT JOIN c ON c.play_id = p.id
        LEFT JOIN l ON l.play_id = p.id
        WHERE p.org_id = ${orgId}
        ORDER BY p.created_at DESC
        LIMIT 200`),
    ),
  );
  const rate = (n: number, of: number) => (of > 0 ? Number((n / of).toFixed(4)) : null);
  const out: PlayPerformanceRow[] = rows.map((r) => {
    const contacted = Number(r.contacted) || 0;
    const replied = Number(r.replied) || 0;
    const positive = Number(r.positive) || 0;
    return {
      playId: String(r.id),
      name: String(r.name),
      type: String(r.type),
      found: Number(r.found) || 0,
      pending: Number(r.pending) || 0,
      approved: Number(r.approved) || 0,
      skipped: Number(r.skipped) || 0,
      leads: Number(r.leads) || 0,
      contacted,
      replied,
      positive,
      replyRate: rate(replied, contacted),
      positiveRate: rate(positive, contacted),
      // One reply out of three sends is not a 33% reply rate, it is one reply.
      sufficient: contacted >= SUFFICIENT_CONTACTED,
    };
  });

  // The best play is the one whose positive rate is highest at the bottom of its interval,
  // so 2 of 20 never outranks 30 of 200 on a lucky week.
  const ranked = out
    .filter((p) => p.sufficient && p.positive > 0)
    .map((p) => ({ p, floor: wilsonInterval(p.positive, p.contacted).lower }))
    .sort((a, b) => b.floor - a.floor || b.p.positive - a.p.positive);
  const top = ranked[0]?.p ?? null;
  const best = top ? { playId: top.playId, name: top.name, why: `Most positive replies for the people contacted: ${top.positive} of ${top.contacted} (${Math.round((top.positive / top.contacted) * 100)}%), among plays with at least ${SUFFICIENT_CONTACTED} people contacted.` } : null;

  const contactedAll = out.reduce((n, p) => n + p.contacted, 0);
  const repliedAll = out.reduce((n, p) => n + p.replied, 0);
  let note: string | undefined;
  if (contactedAll > 0 && repliedAll === 0) {
    // Nothing replied in the plays' numbers: is ANY reply on record for this workspace?
    // Time-limited, and never the reason the results do not load: without an answer, no claim is made.
    const any = await withStatementTimeout(db, READ_STATEMENT_MS, (tx) => tx.execute(sql`SELECT EXISTS (SELECT 1 FROM messages WHERE org_id = ${orgId} AND (direction = 'inbound' OR replied_at IS NOT NULL)) AS seen`))
      .then((r) => rowsOf<{ seen: boolean }>(r)[0] ?? null)
      .catch(() => null);
    if (any && !any.seen) note = "No reply has been recorded in this workspace yet. Replies are counted only when they reach Scout, so zero here can mean replies are not being forwarded rather than nobody answering.";
  }
  if (!note && !best) {
    note = out.some((p) => p.sufficient)
      ? "No play has a positive reply yet, so there is no best play to name."
      : `No play has ${SUFFICIENT_CONTACTED} people contacted yet, so it is too early to name a best one. More sends are needed.`;
  }
  return { days, plays: out, best, ...(note ? { note } : {}) };
}

// ── Starting a run ──

export type RunStart =
  | { started: true; run: PlayRun; jobId: string }
  | { started: false; reason: "running"; runId: string }
  | { started: false; reason: "quota"; message: string }
  | { started: false; reason: "gone" | "not_due" };

/**
 * Start a run of a play: the check that none is under way, the search unit, the run row
 * and its job, as ONE step per play.
 *
 * They used to be four separate statements, so thirty requests arriving together each saw
 * "no run under way" before any of them had written its run: twelve runs started, each
 * charged, each reading the same website (a double-click started two). Now they happen
 * inside a transaction holding a lock on the play, so the second request waits for the
 * first to finish and then finds its run. Everything in here uses the transaction's own
 * connection - a request that waited for a second connection while holding the lock could
 * leave every connection in the pool held by requests waiting for that lock.
 *
 * A failure anywhere rolls all of it back: no charge without a run, no run without a job.
 * `manual` throws what a person should be told (no allowance left, queue full); `schedule`
 * answers `quota` instead, and starts only a play that is still active and still due.
 */
export async function startRun(play: Pick<Play, "id" | "orgId">, trigger: "manual" | "schedule", opts: { nextRunAt?: Date } = {}): Promise<RunStart> {
  const { db } = getDb();
  return withOrgLock(db, play.orgId, `play-run:${play.id}`, async (tx): Promise<RunStart> => {
    const going = await runInProgress(play, tx);
    if (going) return { started: false, reason: "running", runId: going };
    const [now] = await tx
      .select({ status: plays.status, due: sql<boolean>`(${plays.nextRunAt} IS NULL OR ${plays.nextRunAt} <= now())`, scheduled: sql<boolean>`${plays.runEveryHours} IS NOT NULL` })
      .from(plays)
      .where(and(eq(plays.id, play.id), eq(plays.orgId, play.orgId)))
      .limit(1);
    if (!now) return { started: false, reason: "gone" };
    if (trigger === "schedule") {
      // Paused, taken off its schedule, or started by another instance's tick a moment ago.
      if (now.status !== "active" || !now.scheduled || !now.due) return { started: false, reason: "not_due" };
      try {
        await consume(tx, play.orgId, "searches", 1);
      } catch (e) {
        if (e instanceof QuotaExceededError) return { started: false, reason: "quota", message: e.message };
        throw e;
      }
    } else {
      // Before the charge and before the run row: "try again" must leave nothing behind.
      await guardJobCapacity(tx, play.orgId, "play.run");
      await consume(tx, play.orgId, "searches", 1);
    }
    const [run] = await tx.insert(playRuns).values({ orgId: play.orgId, playId: play.id, status: "running", trigger }).returning();
    if (opts.nextRunAt) await tx.update(plays).set({ nextRunAt: opts.nextRunAt }).where(and(eq(plays.id, play.id), eq(plays.orgId, play.orgId)));
    // One attempt: a run that breaks is recorded as failed (and its search given back) by
    // the handler, and running the whole search again unasked would spend it twice.
    const job = await enqueue(tx, "play.run", { playId: play.id, runId: run.id, charged: true }, { orgId: play.orgId, priority: trigger === "manual" ? 2 : 1, maxAttempts: 1 });
    return { started: true, run, jobId: job.id };
  });
}

// ── The schedule ──

/** Plays one workspace may have started by one tick: one workspace with a hundred due plays does not take every slot. */
export const PLAYS_PER_ORG_PER_TICK = 5;
/** Due plays one tick looks at. Above `PLAYS_PER_TICK` because a play skipped for lack of allowance does not use a slot. */
const TICK_SCAN = 400;

/**
 * Start the plays that are due: active, on a schedule, of a workspace that is active and
 * not scheduled for deletion.
 *
 * Each start is charged one search, like a run a person starts. A workspace with none left
 * is not run: its due plays say so in their last result and wait for their next slot -
 * without using any of the tick's `PLAYS_PER_TICK` starts, which are for plays that run. A
 * workspace gets at most `PLAYS_PER_ORG_PER_TICK` of them, oldest first, and the rest of
 * its plays stay due for the next tick. The next slot is stamped when the run is queued,
 * so a slow run is not queued a second time.
 */
export async function tickPlays(): Promise<{ due: number; queued: number; skippedQuota: number; skippedBusy: number; failed: number; closedStale: number }> {
  const { db } = getDb();
  let closedStale = await closeLostRuns().catch((e) => {
    console.warn(`[plays] could not close runs whose job is gone: ${errorLine(e)}`);
    return 0;
  });
  closedStale += await closeStaleRuns().catch((e) => {
    console.warn(`[plays] could not close runs that never finished: ${errorLine(e)}`);
    return 0;
  });
  // Oldest first within a workspace, at most a handful per workspace, then oldest first overall.
  const due = (await db.execute(sql`
    SELECT id, org_id AS "orgId", run_every_hours AS "runEveryHours"
    FROM (
      SELECT p.id, p.org_id, p.run_every_hours, p.next_run_at,
             row_number() OVER (PARTITION BY p.org_id ORDER BY p.next_run_at ASC NULLS FIRST, p.id) AS turn
      FROM plays p
      WHERE p.status = 'active' AND p.run_every_hours IS NOT NULL AND p.type <> 'engagers_upload'
        AND (p.next_run_at IS NULL OR p.next_run_at <= now())
        AND p.org_id IN (SELECT id FROM organizations WHERE status = 'active')
        -- A workspace scheduled for deletion starts nothing new; its campaigns are paused in that state too.
        AND NOT EXISTS (SELECT 1 FROM workspace_deletion_requests d WHERE d.org_id = p.org_id AND d.cancelled_at IS NULL AND d.completed_at IS NULL)
    ) ranked
    WHERE turn <= ${PLAYS_PER_ORG_PER_TICK}
    ORDER BY next_run_at ASC NULLS FIRST, id
    LIMIT ${TICK_SCAN}`)) as unknown as { id: string; orgId: string; runEveryHours: number | null }[];
  const out = { due: due.length, queued: 0, skippedQuota: 0, skippedBusy: 0, failed: 0, closedStale };
  /** Workspaces found to have no searches left in this tick, with the sentence that says so. */
  const spent = new Map<string, string>();
  const skipForQuota = async (play: { id: string; orgId: string }, next: Date, message: string) => {
    await db
      .update(plays)
      .set({ nextRunAt: next, lastResult: { status: "skipped", found: 0, added: 0, duplicates: 0, note: `Not run on schedule: ${message}` } })
      .where(and(eq(plays.id, play.id), eq(plays.orgId, play.orgId)));
    out.skippedQuota++;
  };
  for (const play of due) {
    if (out.queued >= PLAYS_PER_TICK) break;
    try {
      const every = Math.min(720, Math.max(6, play.runEveryHours ?? 24));
      const next = new Date(Date.now() + every * 3600_000);
      const known = spent.get(play.orgId);
      if (known !== undefined) {
        await skipForQuota(play, next, known);
        continue;
      }
      const r = await startRun(play, "schedule", { nextRunAt: next });
      if (r.started) out.queued++;
      else if (r.reason === "quota") {
        spent.set(play.orgId, r.message);
        await skipForQuota(play, next, r.message);
      } else out.skippedBusy++;
    } catch (e) {
      out.failed++;
      console.warn(`[plays] could not start scheduled play ${play.id}: ${errorLine(e)}`);
    }
  }
  return out;
}

/** What a run reads as when its job never came back. */
export const STALE_RUN_NOTE = "This run did not finish. Run the play again.";
/** How long a run may say "running" before it is taken to be lost whatever its job says. Far beyond the run's own four-minute deadline plus any wait in the queue. */
const STALE_RUN_HOURS = 6;

type ClosedRun = { id: string; playId: string; orgId: string; startedAt: Date | string; trigger: string };

/**
 * After runs were closed as lost: the search each was charged is given back, and the play
 * says what happened unless a later run has already replaced it there.
 *
 * Once per run: the caller closed each of these with one conditional update (still
 * `running` at that moment), so no two closers - and no closer and the run's own job -
 * both get here for the same run.
 */
async function settleClosedRuns(closed: ClosedRun[]): Promise<void> {
  const { db } = getDb();
  for (const r of closed.slice(0, 500)) {
    const startedAt = r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt);
    // Given back in the month it was charged in, never as a credit against a later one. (An upload is not charged.)
    // Never below zero: a counter an operator has reset since must not go negative.
    if (r.trigger !== "upload" && currentPeriod(startedAt) === currentPeriod()) await adjustUsage(db, r.orgId, "searches", { delta: -1 }).catch(() => {});
    await db
      .update(plays)
      .set({ lastResult: { status: "failed", found: 0, added: 0, duplicates: 0, note: STALE_RUN_NOTE } })
      .where(and(eq(plays.id, r.playId), eq(plays.orgId, r.orgId), sql`(${plays.lastRunAt} IS NULL OR ${plays.lastRunAt} < ${startedAt.toISOString()}::timestamptz)`));
  }
}

/**
 * A run whose job died with its worker would say "running" for ever - and a run that never
 * finished must not look like one still under way. Closed as failed, with a sentence, and
 * shown on the play unless a later run has already replaced it there.
 */
export async function closeStaleRuns(): Promise<number> {
  const { db } = getDb();
  const stale = await db
    .update(playRuns)
    .set({ status: "failed", note: STALE_RUN_NOTE, finishedAt: new Date() })
    .where(and(eq(playRuns.status, "running"), sql`${playRuns.startedAt} < now() - ${sql.raw(`interval '${STALE_RUN_HOURS} hours'`)}`))
    .returning({ id: playRuns.id, playId: playRuns.playId, orgId: playRuns.orgId, startedAt: playRuns.startedAt, trigger: playRuns.trigger });
  await settleClosedRuns(stale);
  return stale.length;
}

/**
 * Close the runs whose job is gone: still `running` after `RUN_BUSY_MS`, with no `play.run`
 * job for them waiting or at work (the worker died, the job was removed, the request that
 * was doing an upload never came back). Without this such a run sat as "running" in the
 * play's history - and its search stayed charged - until the six-hour sweep.
 *
 * Called by the scheduler for everyone, and for one workspace (or one play) when its plays
 * are read and one of them shows such a run. One statement; the refund is once per run.
 */
export async function closeLostRuns(scope: { orgId?: string; playId?: string } = {}): Promise<number> {
  const { db } = getDb();
  const closed = (await db.execute(sql`
    UPDATE play_runs r SET status = 'failed', note = ${STALE_RUN_NOTE}, finished_at = now()
    WHERE r.id IN (
      SELECT r2.id FROM play_runs r2
      WHERE r2.status = 'running'
        AND r2.started_at < now() - ${sql.raw(`interval '${Math.floor(RUN_BUSY_MS / 1000)} seconds'`)}
        ${scope.orgId ? sql`AND r2.org_id = ${scope.orgId}` : sql``}
        ${scope.playId ? sql`AND r2.play_id = ${scope.playId}` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.org_id = r2.org_id AND j.type = 'play.run' AND j.status IN ('queued', 'running') AND j.payload->>'runId' = r2.id::text)
      LIMIT 500)
      AND r.status = 'running'
    RETURNING r.id, r.play_id AS "playId", r.org_id AS "orgId", r.started_at AS "startedAt", r.trigger`)) as unknown as ClosedRun[];
  await settleClosedRuns([...closed]);
  return closed.length;
}

/** Started recently enough to still count as under way. */
const stillRunning = sql`${playRuns.startedAt} > now() - ${sql.raw(`interval '${Math.floor(RUN_BUSY_MS / 1000)} seconds'`)}`;

/** The run of this play that is still going (started less than `RUN_BUSY_MS` ago and not finished), or null. */
export async function runInProgress(play: Pick<Play, "id" | "orgId">, handle?: Db): Promise<string | null> {
  const db = handle ?? getDb().db;
  const [row] = await db
    .select({ id: playRuns.id })
    .from(playRuns)
    .where(and(eq(playRuns.playId, play.id), eq(playRuns.orgId, play.orgId), eq(playRuns.status, "running"), stillRunning))
    .orderBy(desc(playRuns.startedAt))
    .limit(1);
  return row?.id ?? null;
}
