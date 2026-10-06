/**
 * Prospex SDK - zero-dependency client for Node 18+ / browsers / edge runtimes.
 *
 *   const gl = new Prospex({ apiKey: "px_live_...", baseUrl: "https://api.yourdomain.com" });
 *   const { leads } = await gl.agent.prospect({ query: "CTOs at Series A SaaS in Pune", limit: 5 });
 */

export interface ProspexOptions {
  apiKey?: string;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class ProspexError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Values that become part of a request PATH.
 *
 * They used to be pasted in as given ("/v1/leads/" + id). A URL is normalised before it is
 * sent, so an "id" of `export.csv` fetched the whole lead export through "get one lead", and
 * `../campaigns/<id>/start?` turned "enrich a lead" into "start a campaign" - which matters
 * when the caller is an AI agent whose arguments can be steered by text it has read. Every
 * path value is now checked for what it is supposed to be and percent-encoded, so it can
 * only ever be one path segment.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** An id (UUID) as one path segment, or a 400 that never leaves this process. */
export function idSegment(value: unknown, what = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new ProspexError(400, "invalid_id", `${what} must be an id like 3f2b8c1e-5d47-4a9b-9c0e-2f6a7b8c9d01.`);
  return encodeURIComponent(value.toLowerCase());
}

/** A company domain as one path segment. */
export function domainSegment(value: unknown): string {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!v || v.length > 253 || !DOMAIN_RE.test(v)) throw new ProspexError(400, "invalid_domain", "domain must be a company domain like acme.com.");
  return encodeURIComponent(v);
}

/** An integration name (hubspot, pipedrive, ...) as one path segment. */
export function providerSegment(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_RE.test(value)) throw new ProspexError(400, "invalid_provider", "provider must be a short name like hubspot.");
  return encodeURIComponent(value.toLowerCase());
}

/**
 * May credentials be sent to this base URL? Only over HTTPS - or to this machine.
 *
 * An API key sent over plain HTTP is readable by anything on the path. `http://` is accepted
 * for localhost alone (local development, a server on the same machine).
 */
export function insecureBaseUrlReason(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return "The API address is not a valid URL. Set it to your Scout API address, starting with https://.";
  }
  if (u.protocol === "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
  if (u.protocol === "http:" && local) return null;
  return "The API address must start with https:// (plain http:// is only accepted for localhost), so your key is never sent unencrypted.";
}

export interface SearchQuery {
  query?: string;
  titles?: string[];
  industries?: string[];
  locations?: string[];
  companySizes?: string[];
  keywords?: string[];
  companyDomains?: string[];
  limit?: number;
  findEmails?: boolean;
  icpId?: string;
  listId?: string;
  country?: string;
}

export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  email: string | null;
  emailStatus: string;
  emailConfidence: number;
  linkedinUrl: string | null;
  phone: string | null;
  location: string | null;
  score: number;
  scoreReasons: string[];
  tags: string[];
  custom: Record<string, unknown>;
  company?: { id: string; domain: string; name: string | null; industry: string | null; size: string | null; description: string | null; techStack: string[] } | null;
  createdAt: string;
}

export interface Sender {
  name: string;
  company: string;
  title?: string;
  valueProp: string;
  signature?: string;
  tone?: "friendly" | "direct" | "formal" | "casual";
}

// ── Plays ────────────────────────────────────────────────────────────────────────────────
// A play is a saved recipe that finds the people who need your product this week from one
// source of buying intent. What it finds waits in a review queue as candidates, each with a
// one-sentence reason and the page that proves it. Only an approved candidate becomes a lead.

export type PlayType = "competitor_customers" | "hiring_role" | "funding" | "public_asks" | "website_visitors" | "job_changes" | "engagers_upload";
export type PlayStatus = "active" | "paused";
/** person: a contactable individual. company: found the company, nobody there yet. post: a public conversation with no contact details. */
export type PlayCandidateKind = "person" | "company" | "post";
export type PlayCandidateStatus = "pending" | "approved" | "skipped";
export type PlayAskSource = "linkedin" | "reddit" | "hackernews" | "x" | "forums";
export type PlayEngagement = "reacted" | "commented" | "reposted" | "followed" | "signed_up" | "attended" | "other";

/** The same criteria an ICP holds. Every key is optional. */
export interface IcpCriteria {
  industries?: string[];
  titles?: string[];
  seniorities?: string[];
  departments?: string[];
  companySizes?: string[];
  locations?: string[];
  countries?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  techStack?: string[];
}

/** What each type of play is configured with. Unknown keys are dropped by the API. */
export interface PlayConfigByType {
  /** Companies a competitor names as customers. 1 to 10 competitors; up to 50 customers each. */
  competitor_customers: { competitors: { name: string; domain?: string }[]; maxPerCompetitor?: number };
  /** Companies with an open posting for a role. 1 to 10 roles. */
  hiring_role: { roles: string[]; keywords?: string[]; locations?: string[]; companyDomains?: string[] };
  /** Companies that announced funding in the last `days` (1 to 60, default 14). */
  funding: { keywords?: string[]; industries?: string[]; locations?: string[]; days?: number; minAmountUsd?: number; country?: string };
  /** People asking in public for a solution or complaining about a competitor. At least one of competitors, problems, category. */
  public_asks: { competitors?: string[]; problems?: string[]; category?: string; sources?: PlayAskSource[]; days?: number };
  /** Companies that visited your own site. minIntentScore 0 to 100 (default 30); days 1 to 90 (default 14). */
  website_visitors: { minIntentScore?: number; days?: number };
  /** Known contacts who changed jobs in the last `days` (1 to 90, default 30). */
  job_changes: { days?: number };
  /** Fed by uploads (see `plays.upload`); has no settings. */
  engagers_upload: Record<string, never>;
}
export type PlayConfig = PlayConfigByType[PlayType];

/** The settings every play shares, whatever its type. */
export interface PlayOptions {
  /** Job titles to look for at the companies a play finds. At most 20. */
  targetTitles?: string[];
  /** Score people against this ICP. */
  icpId?: string | null;
  clientId?: string | null;
  /** Approved people are added to this list. */
  listId?: string | null;
  /** The campaign approved people can be added to when a decision asks for it (`enroll`). Never started by a play. */
  campaignId?: string | null;
  /** When true, people the play finds become leads without review. Off by default. */
  autoApprove?: boolean;
  /** 0 to 100. */
  minScore?: number;
  /** null: only when asked. Otherwise every 6 to 720 hours. */
  runEveryHours?: number | null;
  status?: PlayStatus;
}

/** `config` is checked against the play's `type`. It may be left out for a type that needs no settings. */
export type PlayCreateInput = {
  [T in PlayType]: PlayOptions & { name: string; type: T } & ({} extends PlayConfigByType[T] ? { config?: PlayConfigByType[T] } : { config: PlayConfigByType[T] });
}[PlayType];

/** Every field optional; at least one is needed. `config` must fit the play's type. */
export interface PlayUpdateInput extends PlayOptions {
  name?: string;
  type?: PlayType;
  config?: PlayConfig | Record<string, unknown>;
}

export interface PlayLastResult {
  /** done | failed | blocked. `blocked` means the play could not look anywhere - not that it found nobody. */
  status: string;
  found: number;
  added: number;
  duplicates: number;
  /** A plain sentence about the run. */
  note: string | null;
}

export interface Play {
  id: string;
  name: string;
  type: PlayType;
  status: PlayStatus;
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
  /** Candidates of this play by decision. */
  counts: { pending: number; approved: number; skipped: number };
}

export interface PlayRun {
  id: string;
  playId: string;
  /** running | done | failed | blocked */
  status: "running" | "done" | "failed" | "blocked" | (string & {});
  /** manual | schedule | upload */
  trigger: "manual" | "schedule" | "upload" | (string & {});
  found: number;
  added: number;
  duplicates: number;
  note: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface PlayCandidate {
  id: string;
  playId: string;
  playName: string;
  playType: PlayType;
  kind: PlayCandidateKind;
  status: PlayCandidateStatus;
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
  /** One sentence: why this person or company is relevant now. Built from the evidence by rules. */
  relevantBecause: string;
  /** The page that proves the reason. null when the evidence is the workspace's own data. */
  evidenceUrl: string | null;
  evidenceTitle: string | null;
  /** Verbatim from the evidence. */
  evidenceQuote: string | null;
  signalType: string;
  signalAt: string | null;
  /** 0 to 1. */
  confidence: number;
  /** Fit against the play's ICP, 0 to 100; null when the play has none. */
  score: number | null;
  scoreReasons: string[];
  /** Set once approved (or at once, when the person was already a lead). */
  leadId: string | null;
  alreadyLead: boolean;
  decidedAt: string | null;
  createdAt: string;
}

export interface PlayTypeField {
  key: string;
  label: string;
  kind: "tags" | "text" | "number" | "competitors" | "select";
  options?: unknown[];
  required?: boolean;
  max?: number;
  placeholder?: string;
  help?: string;
}

export interface PlayTypeInfo {
  type: PlayType;
  name: string;
  summary: string;
  finds: "people" | "companies" | "conversations";
  /** True when the type depends on public web search. */
  needsSearch: boolean;
  /** False when the type cannot work in this workspace yet; `unavailableReason` says why. */
  available: boolean;
  unavailableReason?: string;
  setupHint?: string;
  fields: PlayTypeField[];
  defaultTitles?: string[];
}

export interface PlayPlanSuggestion {
  type: PlayType;
  name: string;
  config: Record<string, unknown>;
  targetTitles: string[];
  /** Why this play suits the product. */
  why: string;
  available: boolean;
  unavailableReason?: string;
}

/** What Scout understood from a website, and the plays it suggests. Nothing is saved. */
export interface PlayPlan {
  product: { domain: string; name?: string; description?: string };
  icp: IcpCriteria;
  titles: string[];
  competitors: { name: string; domain?: string; source: "saved" | "site" | "ai" }[];
  plays: PlayPlanSuggestion[];
  notes: string[];
}

/** A run that was queued (`jobId`, `runId`), or - when the API runs jobs inline - the finished run. */
export type PlayRunStarted = { jobId: string; runId: string; run?: undefined } | { run: PlayRun; jobId?: undefined; runId?: undefined };

export interface PlayCandidateQuery {
  /** Default: every status. */
  status?: PlayCandidateStatus;
  playId?: string;
  kind?: PlayCandidateKind;
  /** At most 200; default 50. */
  limit?: number;
  offset?: number;
}

export interface PlayCandidatePage {
  candidates: PlayCandidate[];
  total: number;
  counts: { pending: number; approved: number; skipped: number };
}

export interface PlayDecision {
  id: string;
  decision: "approve" | "skip";
  /** For a skip; at most 200 characters. */
  skipReason?: string;
}

export interface DecideResult {
  approved: number;
  skipped: number;
  leadsCreated: number;
  leadsExisting: number;
  tasksCreated: number;
  /** Added to the play's campaign now (only with `enroll`). */
  enrolled: number;
  /** Approved people with no usable address yet: looked up in the background, then added to the campaign. */
  queuedForEmail: number;
  /** Decisions that changed nothing (not pending any more, or not this workspace's). */
  notApplied: { id: string; reason: string }[];
  /** Present when the batch stopped early; the remaining candidates are still pending. */
  stopped?: { reason: "quota" | "error"; message: string };
}

/** One row of an uploaded list. Needs a LinkedIn profile URL, or an email, or a name with a company. */
export interface PlayEngagerRow {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
  companyDomain?: string;
  linkedinUrl?: string;
  email?: string;
  location?: string;
  note?: string;
}

export interface PlayUploadInput {
  /** What these people did. */
  engagement: PlayEngagement;
  /** http(s) link to the post; shown as the evidence on every candidate. */
  postUrl?: string;
  postTitle?: string;
  postAuthor?: string;
  /** Up to 2,000 rows. Give `people` or `csv`, not both. */
  people?: PlayEngagerRow[];
  /** CSV text with a header row. Give `people` or `csv`, not both. */
  csv?: string;
}

export interface PlayUploadResult {
  run: PlayRun;
  added: number;
  duplicates: number;
  /** The first 50 rows that could not be used, with the reason. */
  rejected: { row: number; reason: string }[];
  rejectedCount: number;
}

export interface PlayPerformanceRow {
  playId: string;
  name: string;
  type: PlayType;
  found: number;
  pending: number;
  approved: number;
  skipped: number;
  leads: number;
  contacted: number;
  replied: number;
  positive: number;
  /** replied / contacted; null when nobody was contacted. */
  replyRate: number | null;
  /** positive / contacted; null when nobody was contacted. */
  positiveRate: number | null;
  /** False until at least 20 people were contacted: the rates are too small a sample to compare. */
  sufficient: boolean;
}

export interface PlayPerformance {
  days: number;
  plays: PlayPerformanceRow[];
  /** The strongest play among those with enough sends, or null when none has enough yet. */
  best: { playId: string; name: string; why: string } | null;
  note?: string;
}

export class Prospex {
  private baseUrl: string;
  private headers: Record<string, string>;
  private f: typeof fetch;
  private insecure: string | null;

  constructor(opts: ProspexOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? (typeof process !== "undefined" ? process.env.PROSPEX_API_URL : undefined) ?? "http://localhost:8080").replace(/\/$/, "");
    const key = opts.apiKey ?? (typeof process !== "undefined" ? process.env.PROSPEX_API_KEY : undefined);
    this.headers = { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
    this.f = opts.fetch ?? fetch;
    // Checked when a request is made, not thrown here: constructing a client must never
    // crash the program that imports it. Nothing is ever sent to a refused address.
    this.insecure = insecureBaseUrlReason(this.baseUrl);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    if (this.insecure) throw new ProspexError(0, "insecure_base_url", this.insecure);
    const qs = query ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : "";
    const res = await this.f(`${this.baseUrl}${path}${qs}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new ProspexError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.details ?? data);
    }
    return data as T;
  }

  /** Poll a job until done/failed. */
  async waitForJob(jobId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}) {
    const start = Date.now();
    for (;;) {
      const j = await this.request<{ id: string; status: string; progress: number; result: unknown; error: string | null }>("GET", `/v1/search/jobs/${idSegment(jobId, "jobId")}`);
      if (j.status === "done" || j.status === "failed") return j;
      if (Date.now() - start > (opts.timeoutMs ?? 5 * 60_000)) throw new ProspexError(408, "timeout", "Job did not finish in time");
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
    }
  }

  auth = {
    me: () => this.request<{ user: unknown; org: { id: string; name: string; plan: string; limits: Record<string, number | boolean> } }>("GET", "/v1/auth/me"),
    createApiKey: (name: string) => this.request<{ id: string; key: string; prefix: string }>("POST", "/v1/auth/api-keys", { name }),
  };

  search = {
    /** Start an async search and wait for it; returns lead ids + fetches the leads. */
    run: async (q: SearchQuery, wait = true): Promise<{ searchId: string; jobId: string; leads: Lead[] }> => {
      const r = await this.request<{ search: { id: string }; jobId: string }>("POST", "/v1/search", q);
      if (!wait) return { searchId: r.search.id, jobId: r.jobId, leads: [] };
      const j = await this.waitForJob(r.jobId);
      if (j.status === "failed") throw new ProspexError(500, "search_failed", j.error ?? "search failed");
      const ids = ((j.result as { leadIds?: string[] })?.leadIds ?? []);
      const leads = await Promise.all(ids.map((id) => this.leads.get(id)));
      return { searchId: r.search.id, jobId: r.jobId, leads };
    },
    quick: (q: SearchQuery & { save?: boolean }) => this.request<{ results: unknown[] }>("POST", "/v1/search/quick", q),
    status: (searchId: string) => this.request<{ search: unknown; job: unknown; leadIds: string[] }>("GET", `/v1/search/${idSegment(searchId, "searchId")}`),
    parse: (query: string) => this.request<SearchQuery>("POST", "/v1/search/parse", { query }),
    people: (b: { companyName?: string; companyDomain?: string; titles?: string[]; locations?: string[]; limit?: number }) => this.request<{ people: unknown[] }>("POST", "/v1/search/people", b),
    companies: (b: { query?: string; industries?: string[]; locations?: string[]; keywords?: string[]; limit?: number }) => this.request<{ companies: unknown[] }>("POST", "/v1/search/companies", b),
  };

  enrich = {
    company: (domain: string) => this.request<{ company: unknown; profile: unknown }>("POST", "/v1/search/company/enrich", { domain }),
    verifyEmail: (email: string) => this.request<{ email: string; status: string; confidence: number; checks: Record<string, unknown> }>("POST", "/v1/search/verify", { email }),
    verifyEmails: (emails: string[]) => this.request<{ results: unknown[] }>("POST", "/v1/search/verify", { emails }),
    findEmail: (b: { firstName: string; lastName: string; domain: string }) => this.request<{ email?: string; status: string; confidence: number }>("POST", "/v1/search/find-email", b),
    lead: (leadId: string) => this.request<{ jobId: string }>("POST", `/v1/leads/${idSegment(leadId, "leadId")}/enrich`),
  };

  leads = {
    list: (q: Record<string, unknown> = {}) => this.request<{ leads: Lead[]; total: number }>("GET", "/v1/leads", undefined, q),
    get: (id: string) => this.request<Lead>("GET", `/v1/leads/${idSegment(id)}`),
    create: (lead: Record<string, unknown>) => this.request<{ lead: Lead; created: boolean }>("POST", "/v1/leads", lead),
    update: (id: string, patch: Record<string, unknown>) => this.request<Lead>("PATCH", `/v1/leads/${idSegment(id)}`, patch),
    delete: (id: string) => this.request<{ ok: true }>("DELETE", `/v1/leads/${idSegment(id)}`),
    import: (leads: Record<string, unknown>[]) => this.request<{ created: number; updated: number; errors: unknown[] }>("POST", "/v1/leads/import", leads),
    tag: (ids: string[], add?: string[], remove?: string[]) => this.request<{ updated: number }>("POST", "/v1/leads/bulk/tag", { ids, add, remove }),
    verify: (id: string) => this.request<{ lead: Lead; verification: unknown }>("POST", `/v1/leads/${idSegment(id)}/verify`),
    findEmail: (id: string) => this.request<{ email?: string; status: string }>("POST", `/v1/leads/${idSegment(id)}/find-email`),
  };

  lists = {
    all: () => this.request<{ lists: { id: string; name: string; count: number }[] }>("GET", "/v1/leads/lists/all"),
    create: (name: string, description?: string) => this.request<{ id: string; name: string }>("POST", "/v1/leads/lists", { name, description }),
    add: (listId: string, ids: string[]) => this.request<{ added: number }>("POST", `/v1/leads/lists/${idSegment(listId, "listId")}/leads`, { ids }),
  };

  icps = {
    list: () => this.request<{ icps: unknown[] }>("GET", "/v1/icps"),
    create: (b: { name: string; description?: string; product?: string; seedDomains?: string[]; criteria?: Record<string, string[]>; buildWithAi?: boolean }) => this.request<{ icp: { id: string }; jobId: string | null }>("POST", "/v1/icps", b),
    score: (icpId: string, b: { leadIds?: string[]; assign?: boolean; aiRerankTop?: number } = {}) => this.request<{ scored: { leadId: string; score: number; reasons: string[] }[] }>("POST", `/v1/icps/${idSegment(icpId, "icpId")}/score`, b),
  };

  outreach = {
    generate: (b: { leadId?: string; lead?: Record<string, unknown>; sender: Sender; instructions?: string; stepNo?: number; language?: string }) => this.request<{ subject: string; body: string; personalized: boolean }>("POST", "/v1/campaigns/generate", b),
    emailAccounts: () => this.request<{ emailAccounts: unknown[] }>("GET", "/v1/campaigns/email-accounts"),
    addEmailAccount: (b: Record<string, unknown>) => this.request<{ emailAccount: { id: string }; test: { ok: boolean } }>("POST", "/v1/campaigns/email-accounts", b),
    campaigns: () => this.request<{ campaigns: unknown[] }>("GET", "/v1/campaigns"),
    createCampaign: (b: Record<string, unknown>) => this.request<{ id: string }>("POST", "/v1/campaigns", b),
    enroll: (campaignId: string, b: { leadIds?: string[]; fromList?: boolean; minScore?: number }) => this.request<{ enrolled: number }>("POST", `/v1/campaigns/${idSegment(campaignId, "campaignId")}/enroll`, b),
    start: (campaignId: string) => this.request<{ status: string }>("POST", `/v1/campaigns/${idSegment(campaignId, "campaignId")}/start`),
    pause: (campaignId: string) => this.request<{ status: string }>("POST", `/v1/campaigns/${idSegment(campaignId, "campaignId")}/pause`),
    stats: (campaignId: string) => this.request<Record<string, unknown>>("GET", `/v1/campaigns/${idSegment(campaignId, "campaignId")}/stats`),
    inbound: (b: { from: string; text: string; subject?: string }) => this.request<{ matched: boolean; intent: string }>("POST", "/v1/campaigns/inbound", b),
  };

  agent = {
    /** One call: describe who you want → verified leads (+ optional draft emails). */
    prospect: (b: { query: string; limit?: number; findEmails?: boolean; generateEmails?: boolean; sender?: Sender; save?: boolean; country?: string }) =>
      this.request<{ count: number; leads: { leadId?: string; name: string; title?: string; company?: string; domain?: string; email?: string; emailStatus?: string; score?: number; draftEmail?: { subject: string; body: string } }[] }>("POST", "/v1/agent/prospect", b),
    capabilities: () => this.request<Record<string, unknown>>("GET", "/v1/agent/capabilities"),
  };

  visitors = {
    pixels: () => this.request<{ pixels: { id: string; key: string; name: string; snippet: string }[] }>("GET", "/v1/visitors/pixels"),
    createPixel: (name: string, allowedDomains: string[] = []) => this.request<{ id: string; key: string; snippet: string }>("POST", "/v1/visitors/pixels", { name, allowedDomains }),
    companies: (q: { days?: number; status?: string; limit?: number } = {}) => this.request<{ companies: unknown[]; totals: { visits: number; identified: number; isp: number } }>("GET", "/v1/visitors", undefined, q),
    decisionMakers: (domain: string, b: { titles?: string[]; limit?: number; save?: boolean } = {}) => this.request<{ people: unknown[]; savedLeadIds: string[] }>("POST", `/v1/visitors/${domainSegment(domain)}/decision-makers`, b),
  };

  signals = {
    feed: (q: { type?: string; q?: string; matched?: "true" | "false"; days?: number; limit?: number } = {}) => this.request<{ signals: unknown[] }>("GET", "/v1/signals", undefined, q),
    scan: (b: { types?: string[]; keywords?: string[]; industries?: string[]; locations?: string[]; days?: number } = {}) => this.request<{ parsed: number; stored: number; signals: unknown[] }>("POST", "/v1/signals/scan", b),
    subscriptions: () => this.request<{ subscriptions: unknown[] }>("GET", "/v1/signals/subscriptions"),
    subscribe: (b: { name: string; types: string[]; keywords?: string[]; industries?: string[]; locations?: string[]; targetTitles?: string[]; autoCreateLeads?: boolean; icpId?: string; campaignId?: string }) => this.request<{ id: string }>("POST", "/v1/signals/subscriptions", b),
    runSubscription: (id: string) => this.request<{ matched: number; leadsCreated: number }>("POST", `/v1/signals/subscriptions/${idSegment(id)}/run`),
    monitors: () => this.request<{ monitors: unknown[] }>("GET", "/v1/signals/monitors"),
    createMonitor: (b: { type: "linkedin_post" | "keyword" | "competitor" | "company_news" | "jobs"; name: string; target: string; config?: Record<string, unknown>; intervalMinutes?: number }) => this.request<{ id: string }>("POST", "/v1/signals/monitors", b),
    runMonitor: (id: string) => this.request<{ added: number }>("POST", `/v1/signals/monitors/${idSegment(id)}/run`),
    monitorResults: (id: string) => this.request<{ results: unknown[] }>("GET", `/v1/signals/monitors/${idSegment(id)}/results`),
  };

  tools = {
    linkedinToEmail: (urls: string[], save = false) => this.request<{ results: unknown[] }>("POST", "/v1/tools/linkedin-to-email", { urls, save }),
    emailToLinkedin: (emails: string[]) => this.request<{ results: unknown[] }>("POST", "/v1/tools/email-to-linkedin", { emails }),
    colleagues: (b: { leadId?: string; companyDomain?: string; titles?: string[]; limit?: number; save?: boolean }) => this.request<{ people: unknown[]; savedLeadIds: string[] }>("POST", "/v1/tools/colleagues", b),
    decisionMakers: (b: { companyDomain?: string; companyName?: string; personas?: string[]; limit?: number; findEmails?: boolean; save?: boolean }) => this.request<{ company: unknown; people: unknown[] }>("POST", "/v1/tools/decision-makers", b),
    companyIntel: (domain: string) => this.request<{ company: unknown; hiring: unknown; news: unknown[] }>("POST", "/v1/tools/company-intel", { domain }),
    domainHealth: (domain: string) => this.request<{ score: number; recommendations: string[] }>("GET", "/v1/tools/domain-health", undefined, { domain }),
    verifyBatch: (emails: string[]) => this.request<{ results: unknown[]; summary: Record<string, number> }>("POST", "/v1/tools/verify-batch", { emails }),
    batchEnrich: (b: { leadIds?: string[]; listId?: string; onlyMissingEmail?: boolean } = {}) => this.request<{ queued: number; jobId: string }>("POST", "/v1/tools/batch-enrich", b),
    personas: () => this.request<{ personas: Record<string, string[]> }>("GET", "/v1/tools/personas"),
    tasks: (status = "pending") => this.request<{ tasks: unknown[] }>("GET", "/v1/tools/tasks", undefined, { status }),
    completeTask: (id: string, outcome: "done" | "skipped" = "done", note?: string) => this.request<{ ok: true }>("POST", `/v1/tools/tasks/${idSegment(id)}/complete`, { outcome, note }),
    savedSearches: () => this.request<{ savedSearches: unknown[] }>("GET", "/v1/tools/saved-searches"),
    saveSearch: (b: { name: string; query: SearchQuery; alert?: boolean; alertEmail?: string; listId?: string }) => this.request<{ id: string }>("POST", "/v1/tools/saved-searches", b),
    autopilots: () => this.request<{ autopilots: unknown[] }>("GET", "/v1/tools/autopilots"),
    createAutopilot: (b: { name: string; query: SearchQuery; icpId?: string; listId?: string; campaignId?: string; dailyLeads?: number; minScore?: number; requireValidEmail?: boolean; autoEnroll?: boolean; runHourUtc?: number }) => this.request<{ id: string }>("POST", "/v1/tools/autopilots", b),
    runAutopilot: (id: string) => this.request<{ jobId: string }>("POST", `/v1/tools/autopilots/${idSegment(id)}/run`),
    setLeadStatus: (id: string, status: string) => this.request<Lead>("POST", `/v1/tools/leads/${idSegment(id)}/status`, { status }),
  };

  /**
   * Plays: find the people who need you this week, with the proof.
   *
   *   const plan = await gl.plays.plan("acme.com");                       // suggestions, nothing saved
   *   const { play } = await gl.plays.create({ name: "Funded this month", type: "funding", config: { days: 30 } });
   *   await gl.plays.run(play.id);                                         // candidates land in the review queue
   *   const { candidates } = await gl.plays.candidates({ status: "pending" });
   *   await gl.plays.decide([{ id: candidates[0].id, decision: "approve" }]);   // creates a lead; sends nothing
   *   const results = await gl.plays.performance(90);
   *
   * Approving never sends anything. `decide(..., { enroll: true })` also adds approved people to
   * the play's campaign, and a campaign that is running will then email them.
   */
  plays = {
    /** The seven kinds of play, the settings each needs and whether each can work in this workspace yet. */
    types: () => this.request<{ types: PlayTypeInfo[] }>("GET", "/v1/plays/types"),
    /** Read a website and suggest plays for it. Saves nothing. Uses one search unit. */
    plan: (website: string) => this.request<PlayPlan>("POST", "/v1/plays/plan", { website }),
    list: () => this.request<{ plays: Play[] }>("GET", "/v1/plays"),
    create: (input: PlayCreateInput) => this.request<{ play: Play }>("POST", "/v1/plays", { ...input, config: input.config ?? {} }),
    /** One play with its last 10 runs. */
    get: (id: string) => this.request<{ play: Play; runs: PlayRun[] }>("GET", `/v1/plays/${idSegment(id, "playId")}`),
    update: (id: string, patch: PlayUpdateInput) => this.request<{ play: Play }>("PATCH", `/v1/plays/${idSegment(id, "playId")}`, patch),
    /** Deletes the play and its candidates. Leads already created from it stay. */
    delete: (id: string) => this.request<{ ok: true }>("DELETE", `/v1/plays/${idSegment(id, "playId")}`),
    /** Run now. Uses one search unit. Puts what it finds in the review queue; creates no leads. */
    run: (id: string) => this.request<PlayRunStarted>("POST", `/v1/plays/${idSegment(id, "playId")}/run`),
    /** The last 20 runs of a play. */
    runs: (id: string) => this.request<{ runs: PlayRun[] }>("GET", `/v1/plays/${idSegment(id, "playId")}/runs`),
    /** The review queue. Pending candidates come best score first, then newest. */
    candidates: (q: PlayCandidateQuery = {}) =>
      this.request<PlayCandidatePage>("GET", "/v1/plays/candidates", undefined, { ...q, playId: q.playId === undefined ? undefined : idSegment(q.playId, "playId") }),
    /**
     * Approve or skip up to 200 candidates. Approving a person creates a lead (one lead unit
     * when the person is new), a company is saved as a company, a post becomes a task to answer
     * it. Nothing is sent. With `enroll`, approved people are also added to the play's campaign.
     */
    decide: (decisions: PlayDecision[], opts: { enroll?: boolean } = {}) =>
      this.request<DecideResult>("POST", "/v1/plays/candidates/decide", { decisions, ...(opts.enroll === undefined ? {} : { enroll: opts.enroll }) }),
    /** For a company candidate: find up to 5 people there. They join the queue with the company's reason and evidence. Uses one search unit. */
    findPeople: (candidateId: string, opts: { titles?: string[]; limit?: number } = {}) =>
      this.request<{ added: number; candidates: PlayCandidate[]; note?: string }>("POST", `/v1/plays/candidates/${idSegment(candidateId, "candidateId")}/find-people`, opts),
    /** Add people who engaged with a post (or signed up, followed, attended) to an engagers_upload play. Body up to 2 MB. */
    upload: (id: string, input: PlayUploadInput) => this.request<PlayUploadResult>("POST", `/v1/plays/${idSegment(id, "playId")}/upload`, input),
    /** Per play: found, approved, contacted, replied, replied positively. `days` 7 to 365, default 90. */
    performance: (days?: number) => this.request<PlayPerformance>("GET", "/v1/plays/performance", undefined, { days }),
  };

  account = {
    usage: () => this.request<{ period: string; plan: string; usage: Record<string, { used: number; limit: number }> }>("GET", "/v1/usage"),
    analytics: () => this.request<Record<string, unknown>>("GET", "/v1/analytics/overview"),
    events: (q: { type?: string; limit?: number } = {}) => this.request<{ events: unknown[] }>("GET", "/v1/events", undefined, q),
    webhooks: () => this.request<{ webhooks: unknown[] }>("GET", "/v1/webhooks"),
    createWebhook: (url: string, events: string[] = ["*"]) => this.request<{ id: string; secret: string }>("POST", "/v1/webhooks", { url, events }),
    integrations: () => this.request<{ integrations: unknown[]; providers: string[] }>("GET", "/v1/integrations"),
    configureIntegration: (provider: string, config: Record<string, string>, autoSync = false) => this.request<unknown>("PUT", `/v1/integrations/${providerSegment(provider)}`, { config, autoSync }),
    syncToCrm: (provider: string, leadIds: string[]) => this.request<{ queued: number }>("POST", `/v1/integrations/${providerSegment(provider)}/sync`, { leadIds }),
  };
}

/** Verify a webhook signature (HMAC-ish sha256 of `${secret}.${timestamp}.${body}`). */
export async function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string, signature: string) {
  const data = new TextEncoder().encode(`${secret}.${timestamp}.${rawBody}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === signature;
}

export default Prospex;
