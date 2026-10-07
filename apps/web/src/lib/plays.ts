import { ProspexError } from "./api";
import { plural, pluralWord } from "./plural";
import { safeHref } from "./safeHref";

/**
 * Plays: the shapes the API sends, and the words this app puts around them.
 *
 * Everything a play finds is somebody else's text - a name from a public profile, a headline,
 * a quote lifted from a case study. It is only ever rendered as text (see `clean`), and a URL
 * only ever becomes a link through ExtLink / safeHref.
 */

export type CandidateKind = "person" | "company" | "post";
export type CandidateStatus = "pending" | "approved" | "skipped";

export interface PlayLastResult { status?: string | null; found?: number | null; added?: number | null; duplicates?: number | null; note?: string | null }
export interface PlayCounts { pending: number; approved: number; skipped: number }

export interface PlayOut {
  id: string;
  name: string;
  type: string;
  status: "active" | "paused";
  config: Record<string, unknown>;
  targetTitles: string[];
  icpId: string | null;
  clientId: string | null;
  listId: string | null;
  campaignId: string | null;
  autoApprove: boolean;
  minScore: number;
  runEveryHours: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: PlayLastResult | null;
  createdAt: string;
  updatedAt: string;
  counts: PlayCounts;
  /** A run of this play is in progress. Absent on a server that does not say. */
  running?: boolean;
}

export interface PlayRun {
  id: string;
  playId?: string;
  status: string;
  trigger?: string;
  found: number;
  added: number;
  duplicates: number;
  note: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Candidate {
  id: string;
  playId: string;
  playName: string;
  playType: string;
  kind: CandidateKind;
  status: CandidateStatus;
  skipReason: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: string | null;
  location: string | null;
  companyName: string | null;
  companyDomain: string | null;
  relevantBecause: string;
  evidenceUrl: string | null;
  evidenceTitle: string | null;
  evidenceQuote: string | null;
  signalType: string;
  signalAt: string | null;
  confidence: number;
  score: number | null;
  scoreReasons: string[];
  leadId: string | null;
  alreadyLead: boolean;
  decidedAt: string | null;
  createdAt: string;
  /** For a company: how many people this play already holds for it. Null for a person or a post; absent on an older server. */
  peopleFound?: number | null;
}

export type FieldKind = "tags" | "text" | "number" | "competitors" | "select";
export type FieldOption = string | { value: string; label?: string };
export interface PlayTypeField { key: string; label: string; kind: FieldKind | string; options?: FieldOption[]; required?: boolean; min?: number; max?: number; placeholder?: string; help?: string }

/**
 * The smallest value a number field accepts. The server's own `min` when it sends one;
 * otherwise what the API is known to enforce for the fields that exist today (a count of
 * days or of companies starts at 1), and 0 for anything else.
 */
const KNOWN_MINIMUMS: Record<string, number> = { days: 1, maxPerCompetitor: 1, minIntentScore: 0, minAmountUsd: 0 };
export function fieldMin(field: PlayTypeField): number {
  if (typeof field.min === "number" && Number.isFinite(field.min)) return field.min;
  return lookup(KNOWN_MINIMUMS, field.key) ?? 0;
}

/**
 * Whether a play of this type finds companies and then looks for people at them - the only
 * case in which job titles mean anything. Unknown types are assumed to, so a title field is
 * never hidden from a play that needs it.
 */
export function findsCompanies(types: PlayTypeInfo[] | null | undefined, type: string): boolean {
  const info = types?.find((t) => t.type === type);
  if (info) return info.finds === "companies";
  return !["public_asks", "job_changes", "engagers_upload"].includes(type);
}
export interface PlayTypeInfo {
  type: string;
  name: string;
  summary: string;
  finds: "people" | "companies" | "conversations" | string;
  needsSearch?: boolean;
  available: boolean;
  unavailableReason?: string;
  setupHint?: string;
  fields: PlayTypeField[];
  defaultTitles?: string[];
}

export interface Competitor { name: string; domain?: string; source?: string }

export interface PlanPlay { type: string; name: string; config: Record<string, unknown>; targetTitles: string[]; why: string; available: boolean; unavailableReason?: string; needsSearch?: boolean; setupHint?: string }
export interface PlayPlan {
  product: { domain: string; name?: string; description?: string };
  icp: Record<string, unknown>;
  titles: string[];
  competitors: Competitor[];
  plays: PlanPlay[];
  notes: string[];
  /** False when no search source is connected on the server's side. Absent on an older server. */
  searchDependable?: boolean;
}

export interface DecideResult {
  approved: number;
  skipped: number;
  leadsCreated: number;
  leadsExisting: number;
  tasksCreated: number;
  enrolled: number;
  queuedForEmail: number;
  notApplied: { id: string; reason: string; code?: string }[];
  /** The ids whose decision was applied. Absent on a server that only sends the counts. */
  applied?: string[];
  stopped?: { reason: "quota" | "error" | string; message: string };
}

export interface PerformanceRow {
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
export interface Performance { days: number; plays: PerformanceRow[]; best: { playId: string; name: string; why: string } | null; note?: string }

export interface UploadResult { run?: PlayRun | null; added: number; duplicates: number; rejected: { row: number; reason: string }[]; rejectedCount: number }

/** The most decisions one request may carry (the server's limit). */
export const DECIDE_MAX = 200;
export const REVIEW_PAGE = 50;
export const UPLOAD_MAX_PEOPLE = 2000;
/** A little under the server's 2 MB body limit, so the JSON around the file still fits. */
export const UPLOAD_MAX_CSV_CHARS = 1_800_000;

export const SKIP_REASONS = ["Not a fit", "Wrong person", "Already a customer", "Evidence is weak"] as const;

export const ENGAGEMENTS: { value: string; label: string }[] = [
  { value: "reacted", label: "Reacted to a post" },
  { value: "commented", label: "Commented on a post" },
  { value: "reposted", label: "Reposted it" },
  { value: "followed", label: "Followed you" },
  { value: "signed_up", label: "Signed up" },
  { value: "attended", label: "Attended an event" },
  { value: "other", label: "Something else" },
];

/**
 * A lookup in a fixed table by a key the server chose. `table[key]` would also find
 * "constructor" and "toString" on the prototype; this only finds what the table lists.
 */
export function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Shown until GET /v1/plays/types answers, and for a type this build has not met. */
const TYPE_NAMES: Record<string, string> = {
  competitor_customers: "Competitor customers",
  hiring_role: "Hiring for a role",
  funding: "Just raised funding",
  public_asks: "Asking in public",
  website_visitors: "Your website visitors",
  job_changes: "Contacts who changed jobs",
  engagers_upload: "People who engaged",
};

export function typeName(types: PlayTypeInfo[] | null | undefined, type: string): string {
  const known = types?.find((t) => t.type === type)?.name;
  if (known) return known;
  return lookup(TYPE_NAMES, type) ?? (clean(String(type ?? "").replace(/_/g, " "), 60) || "Play");
}

const TYPE_TONE: Record<string, string> = {
  competitor_customers: "bg-brand-50 text-brand-700",
  hiring_role: "bg-sky-50 text-sky-700",
  funding: "bg-emerald-50 text-emerald-700",
  public_asks: "bg-purple-50 text-purple-700",
  website_visitors: "bg-amber-50 text-amber-700",
  job_changes: "bg-teal-50 text-teal-700",
  engagers_upload: "bg-rose-50 text-rose-700",
};
export const typeTone = (type: string) => lookup(TYPE_TONE, type) ?? "bg-black/[0.05] text-ink-300";

/**
 * Third-party text, made safe to read: control characters and the invisible direction
 * overrides that can make "evil.com" read as something else are dropped, runs of whitespace
 * become one space, and the length is capped. The server does this too; a second pass here
 * costs nothing and means a screen never depends on it.
 */
export function clean(value: unknown, max = 600): string {
  if (typeof value !== "string") return "";
  // Joiners (U+200C, U+200D) and the plain direction marks stay: Indic and Arabic-script
  // names need them to render correctly. Only the overrides, isolates and zero-width
  // spaces go.
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "acme.com" for a link that will actually be a link; "" otherwise. */
export function hostOf(url: unknown): string {
  const safe = safeHref(url);
  if (!safe) return "";
  try {
    return new URL(safe).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** "2 days ago", "in 3 hours", "just now". Empty for a missing or unreadable date. */
export function ago(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  const abs = Math.abs(diff);
  const units: [number, string][] = [[365 * 86_400_000, "year"], [30 * 86_400_000, "month"], [7 * 86_400_000, "week"], [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];
  for (const [ms, word] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return diff >= 0 ? `${plural(n, word)} ago` : `in ${plural(n, word)}`;
    }
  }
  return diff >= 0 ? "just now" : "in a moment";
}

const strings = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => clean(x, 160)).slice(0, max) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function competitorsOf(v: unknown): Competitor[] {
  if (!Array.isArray(v)) return [];
  const out: Competitor[] = [];
  for (const c of v) {
    if (typeof c === "string" && c.trim()) out.push({ name: clean(c, 120) });
    else if (c && typeof c === "object" && typeof (c as Competitor).name === "string" && (c as Competitor).name.trim()) {
      const d = (c as Competitor).domain;
      out.push({ name: clean((c as Competitor).name, 120), ...(typeof d === "string" && d.trim() ? { domain: clean(d, 200) } : {}) });
    }
  }
  return out;
}

const list = (items: string[], shown = 3) =>
  items.length > shown ? `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`
  : items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
  : items.join("");
const money = (n: number) => (n >= 1e9 ? `$${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);
const SOURCE_NAMES: Record<string, string> = { linkedin: "LinkedIn", reddit: "Reddit", hackernews: "Hacker News", x: "X", forums: "forums" };

/**
 * What a play looks for, in one line of words.
 *
 * Built from the keys this build knows; anything else in `config` is left out rather than
 * printed as JSON.
 */
export function playInputs(type: string, config: Record<string, unknown> | null | undefined): string {
  const c = config && typeof config === "object" ? config : {};
  const days = num(c.days);
  const parts: string[] = [];
  switch (type) {
    case "competitor_customers": {
      const names = competitorsOf(c.competitors).map((x) => x.name);
      return names.length ? `Companies named as customers of ${list(names)}` : "Companies your competitors name as customers";
    }
    case "hiring_role": {
      const roles = strings(c.roles);
      parts.push(roles.length ? `Companies hiring ${list(roles)}` : "Companies hiring for a role you choose");
      const where = strings(c.locations);
      if (where.length) parts.push(`in ${list(where)}`);
      const kw = strings(c.keywords);
      if (kw.length) parts.push(`mentioning ${list(kw)}`);
      return parts.join(" · ");
    }
    case "funding": {
      parts.push(`Companies that raised money in the last ${plural(days ?? 14, "day")}`);
      const about = [...strings(c.industries), ...strings(c.keywords)];
      if (about.length) parts.push(list(about));
      const where = strings(c.locations);
      if (where.length) parts.push(`in ${list(where)}`);
      const min = num(c.minAmountUsd);
      if (min && min > 0) parts.push(`at least ${money(min)}`);
      return parts.join(" · ");
    }
    case "public_asks": {
      const comps = competitorsOf(c.competitors).map((x) => x.name);
      const problems = strings(c.problems);
      const category = typeof c.category === "string" ? clean(c.category, 120) : "";
      // "People asking for an alternative to Acme, a way to automate onboarding or an onboarding tool"
      if (comps.length) parts.push(`an alternative to ${list(comps)}`);
      if (problems.length) parts.push(`a way to ${list(problems, 2)}`);
      if (category) parts.push(`${/^[aeiou]/i.test(category) ? "an" : "a"} ${category}`);
      const wants = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}` : parts[0] ?? "a tool like yours";
      const sources = strings(c.sources).map((s) => lookup(SOURCE_NAMES, s) ?? s);
      return `People asking in public for ${wants}${sources.length ? ` · on ${sources.slice(0, 5).join(", ")}` : ""}`;
    }
    case "website_visitors": {
      const min = num(c.minIntentScore);
      return `Companies that visited your website in the last ${plural(days ?? 14, "day")}${min !== null ? ` with an intent score of ${min} or more` : ""}`;
    }
    case "job_changes":
      return `People you already know who changed jobs in the last ${plural(days ?? 30, "day")}`;
    case "engagers_upload":
      return "People you upload: post engagers, sign-ups, followers, attendees";
    default:
      return "";
  }
}

export const SCHEDULES: { value: number | null; label: string }[] = [
  { value: null, label: "Only when I press Run" },
  { value: 24, label: "Every day" },
  { value: 84, label: "Twice a week" },
  { value: 168, label: "Every week" },
];

export function scheduleLabel(runEveryHours: number | null | undefined): string {
  if (!runEveryHours) return "Runs when you press Run";
  if (runEveryHours === 84) return "Runs twice a week";
  if (runEveryHours === 168) return "Runs every week";
  return `Runs every ${plural(runEveryHours, "hour")}`;
}

/**
 * When a scheduled play runs next, in words. A time that has already passed is not "2
 * minutes ago" - the run is simply due, and happens at the scheduler's next pass.
 */
export function nextRunLabel(nextRunAt: string | null | undefined, now = Date.now()): string {
  if (!nextRunAt) return "";
  const t = new Date(nextRunAt).getTime();
  if (Number.isNaN(t)) return "";
  return t <= now ? "next run is due" : `next ${ago(nextRunAt, now)}`;
}

/**
 * Whether a run did not do its job - it could not search, broke, or was skipped - as opposed
 * to having looked and found little. Only "done" (and a run still going) counts as having
 * looked; a status this build has not met is treated as not having, so it can never be
 * reported as "found nobody".
 */
export function runFailed(status: string | null | undefined): boolean {
  return !!status && status !== "done" && status !== "running";
}

/** The heading over a run that did not do its job. */
export function runProblemTitle(status: string | null | undefined): string {
  if (status === "blocked") return "The last run could not search.";
  if (status === "failed") return "The last run did not finish.";
  if (status === "skipped") return "The last scheduled run did not happen.";
  return "The last run did not complete.";
}

/**
 * A finished run, in words. A run that could not search never reads as "found 0": it says it
 * could not look, with the server's sentence when there is one.
 */
export function runSentence(r: { status?: string | null; found?: number | null; added?: number | null; duplicates?: number | null; note?: string | null; error?: string | null } | null | undefined): string {
  if (!r) return "";
  const note = clean(r.note ?? "", 500);
  if (r.status === "blocked") return note || "This run could not search, so nothing was checked. Nothing is wrong with the play - try again in a little while.";
  if (r.status === "failed") return note || clean(r.error ?? "", 300) || "This run failed before it finished. Try again.";
  if (r.status === "running") return "Running now.";
  if (runFailed(r.status)) return note || "This run did not happen, so nothing was checked.";
  // The server's note is the whole account of a run ("Found 4: 3 new, 1 already seen. ...").
  // It is shown as it is; counting again in front of it said everything twice.
  if (note) return note;
  const found = r.found ?? 0;
  const added = r.added ?? 0;
  const dup = r.duplicates ?? 0;
  return found === 0 && added === 0
    ? "Looked and found nobody new this time."
    : `Found ${found.toLocaleString()}: ${added.toLocaleString()} new for review${dup > 0 ? `, ${dup.toLocaleString()} already seen` : ""}.`;
}

/** What approving and skipping did, in the server's numbers. Nothing here is inferred. */
export function decisionSummary(r: DecideResult): string {
  const parts: string[] = [];
  if (r.approved > 0) {
    const detail = [
      r.leadsCreated > 0 ? `${plural(r.leadsCreated, "lead")} created` : "",
      r.leadsExisting > 0 ? `${r.leadsExisting.toLocaleString()} already existed` : "",
      r.tasksCreated > 0 ? `${plural(r.tasksCreated, "task")} created` : "",
      r.enrolled > 0 ? `${r.enrolled.toLocaleString()} added to the campaign` : "",
      r.queuedForEmail > 0 ? `${r.queuedForEmail.toLocaleString()} waiting for an address` : "",
    ].filter(Boolean);
    parts.push(`Approved ${r.approved.toLocaleString()}${detail.length ? `: ${detail.join(", ")}` : ""}.`);
  }
  if (r.skipped > 0) parts.push(`Skipped ${r.skipped.toLocaleString()}.`);
  const na = r.notApplied?.length ?? 0;
  if (na > 0) parts.push(`${na.toLocaleString()} ${pluralWord(na, "was", "were")} not changed - see the reason on ${na === 1 ? "the card" : "each card"}.`);
  if (!parts.length) parts.push("Nothing was changed.");
  return parts.join(" ");
}

/** A decide answer with every number present, whatever an older or partial server sent. */
export function normalizeDecide(raw: unknown): DecideResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<DecideResult>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const stopped = r.stopped && typeof r.stopped === "object" && typeof r.stopped.message === "string" ? { reason: String(r.stopped.reason ?? "error"), message: clean(r.stopped.message, 400) } : undefined;
  return {
    approved: n(r.approved),
    skipped: n(r.skipped),
    leadsCreated: n(r.leadsCreated),
    leadsExisting: n(r.leadsExisting),
    tasksCreated: n(r.tasksCreated),
    enrolled: n(r.enrolled),
    queuedForEmail: n(r.queuedForEmail),
    notApplied: Array.isArray(r.notApplied) ? r.notApplied.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, reason: clean(x.reason, 300) || "The server did not apply this one.", ...(typeof x.code === "string" && x.code ? { code: x.code } : {}) })) : [],
    ...(Array.isArray(r.applied) ? { applied: r.applied.filter((x): x is string => typeof x === "string") } : {}),
    ...(stopped ? { stopped } : {}),
  };
}

export function candidateName(c: Pick<Candidate, "kind" | "fullName" | "firstName" | "lastName" | "companyName" | "companyDomain" | "evidenceTitle">): string {
  if (c.kind === "post") return "Public conversation";
  if (c.kind === "company") return clean(c.companyName, 160) || clean(c.companyDomain, 160) || "Unnamed company";
  return clean(c.fullName, 160) || clean([c.firstName, c.lastName].filter(Boolean).join(" "), 160) || "Name not known";
}

/**
 * Why a refused decision means the card should leave the queue anyway - or null when it is
 * still waiting and should stay with its reason.
 *
 * The server says which with a `code`. Without one (an older server) the opening words of
 * its sentence are read instead.
 */
const CODE_LEAVES: Record<string, "elsewhere" | "do_not_contact" | null> = {
  already_decided: "elsewhere", removed: "elsewhere", not_found: "elsewhere", play_gone: "elsewhere",
  do_not_contact: "do_not_contact",
  being_decided: null, quota: null, error: null,
};
const SENTENCE_LEAVES = /^(already (approved|skipped)\b|decided elsewhere\b|this was removed while it was being approved|not found in this workspace|its play no longer exists)/i;
export function leavesQueue(entry: { reason: string; code?: string }): "elsewhere" | "do_not_contact" | null {
  if (entry.code && Object.prototype.hasOwnProperty.call(CODE_LEAVES, entry.code)) return CODE_LEAVES[entry.code];
  return SENTENCE_LEAVES.test(entry.reason) ? "elsewhere" : null;
}

/**
 * The same items, with the ones whose own source is web search moved after the rest - used
 * only when the server says no search source is connected, so what works today comes first.
 * The order within each group is kept.
 */
export function workingFirst<T>(items: T[], needsSearch: (item: T) => boolean, searchDependable: boolean | undefined): T[] {
  if (searchDependable !== false) return items;
  return [...items.filter((x) => !needsSearch(x)), ...items.filter((x) => needsSearch(x))];
}

/** The plan limit was reached (402). The server's sentence is shown; this adds the way out. */
export const isQuota = (e: unknown) => e instanceof ProspexError && (e.status === 402 || e.code === "quota_exceeded");
/** This API has no such route: an older server that does not have Plays yet. */
export const isMissingRoute = (e: unknown) => e instanceof ProspexError && (e.status === 404 || e.status === 405);
export const isForbidden = (e: unknown) => e instanceof ProspexError && e.status === 403;
/** The run a "this play is already running" answer points at, when the server names it. */
export function runIdOf(e: unknown): string | null {
  const body = e instanceof ProspexError ? (e.details as { error?: { details?: { runId?: unknown }; runId?: unknown } } | null) : null;
  const id = body?.error?.details?.runId ?? body?.error?.runId ?? (body as { runId?: unknown } | null)?.runId;
  return typeof id === "string" && id ? id : null;
}
export const messageOf = (e: unknown) => clean((e as { message?: unknown } | null)?.message, 400) || "Something went wrong.";

export const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n * 100)}%`);
