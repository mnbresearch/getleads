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

export class Prospex {
  private baseUrl: string;
  private headers: Record<string, string>;
  private f: typeof fetch;

  constructor(opts: ProspexOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? (typeof process !== "undefined" ? process.env.PROSPEX_API_URL : undefined) ?? "http://localhost:8080").replace(/\/$/, "");
    const key = opts.apiKey ?? (typeof process !== "undefined" ? process.env.PROSPEX_API_KEY : undefined);
    this.headers = { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
    this.f = opts.fetch ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
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
      const j = await this.request<{ id: string; status: string; progress: number; result: unknown; error: string | null }>("GET", `/v1/search/jobs/${jobId}`);
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
    status: (searchId: string) => this.request<{ search: unknown; job: unknown; leadIds: string[] }>("GET", `/v1/search/${searchId}`),
    parse: (query: string) => this.request<SearchQuery>("POST", "/v1/search/parse", { query }),
    people: (b: { companyName?: string; companyDomain?: string; titles?: string[]; locations?: string[]; limit?: number }) => this.request<{ people: unknown[] }>("POST", "/v1/search/people", b),
    companies: (b: { query?: string; industries?: string[]; locations?: string[]; keywords?: string[]; limit?: number }) => this.request<{ companies: unknown[] }>("POST", "/v1/search/companies", b),
  };

  enrich = {
    company: (domain: string) => this.request<{ company: unknown; profile: unknown }>("POST", "/v1/search/company/enrich", { domain }),
    verifyEmail: (email: string) => this.request<{ email: string; status: string; confidence: number; checks: Record<string, unknown> }>("POST", "/v1/search/verify", { email }),
    verifyEmails: (emails: string[]) => this.request<{ results: unknown[] }>("POST", "/v1/search/verify", { emails }),
    findEmail: (b: { firstName: string; lastName: string; domain: string }) => this.request<{ email?: string; status: string; confidence: number }>("POST", "/v1/search/find-email", b),
    lead: (leadId: string) => this.request<{ jobId: string }>("POST", `/v1/leads/${leadId}/enrich`),
  };

  leads = {
    list: (q: Record<string, unknown> = {}) => this.request<{ leads: Lead[]; total: number }>("GET", "/v1/leads", undefined, q),
    get: (id: string) => this.request<Lead>("GET", `/v1/leads/${id}`),
    create: (lead: Record<string, unknown>) => this.request<{ lead: Lead; created: boolean }>("POST", "/v1/leads", lead),
    update: (id: string, patch: Record<string, unknown>) => this.request<Lead>("PATCH", `/v1/leads/${id}`, patch),
    delete: (id: string) => this.request<{ ok: true }>("DELETE", `/v1/leads/${id}`),
    import: (leads: Record<string, unknown>[]) => this.request<{ created: number; updated: number; errors: unknown[] }>("POST", "/v1/leads/import", leads),
    tag: (ids: string[], add?: string[], remove?: string[]) => this.request<{ updated: number }>("POST", "/v1/leads/bulk/tag", { ids, add, remove }),
    verify: (id: string) => this.request<{ lead: Lead; verification: unknown }>("POST", `/v1/leads/${id}/verify`),
    findEmail: (id: string) => this.request<{ email?: string; status: string }>("POST", `/v1/leads/${id}/find-email`),
  };

  lists = {
    all: () => this.request<{ lists: { id: string; name: string; count: number }[] }>("GET", "/v1/leads/lists/all"),
    create: (name: string, description?: string) => this.request<{ id: string; name: string }>("POST", "/v1/leads/lists", { name, description }),
    add: (listId: string, ids: string[]) => this.request<{ added: number }>("POST", `/v1/leads/lists/${listId}/leads`, { ids }),
  };

  icps = {
    list: () => this.request<{ icps: unknown[] }>("GET", "/v1/icps"),
    create: (b: { name: string; description?: string; product?: string; seedDomains?: string[]; criteria?: Record<string, string[]>; buildWithAi?: boolean }) => this.request<{ icp: { id: string }; jobId: string | null }>("POST", "/v1/icps", b),
    score: (icpId: string, b: { leadIds?: string[]; assign?: boolean; aiRerankTop?: number } = {}) => this.request<{ scored: { leadId: string; score: number; reasons: string[] }[] }>("POST", `/v1/icps/${icpId}/score`, b),
  };

  outreach = {
    generate: (b: { leadId?: string; lead?: Record<string, unknown>; sender: Sender; instructions?: string; stepNo?: number; language?: string }) => this.request<{ subject: string; body: string; personalized: boolean }>("POST", "/v1/campaigns/generate", b),
    emailAccounts: () => this.request<{ emailAccounts: unknown[] }>("GET", "/v1/campaigns/email-accounts"),
    addEmailAccount: (b: Record<string, unknown>) => this.request<{ emailAccount: { id: string }; test: { ok: boolean } }>("POST", "/v1/campaigns/email-accounts", b),
    campaigns: () => this.request<{ campaigns: unknown[] }>("GET", "/v1/campaigns"),
    createCampaign: (b: Record<string, unknown>) => this.request<{ id: string }>("POST", "/v1/campaigns", b),
    enroll: (campaignId: string, b: { leadIds?: string[]; fromList?: boolean; minScore?: number }) => this.request<{ enrolled: number }>("POST", `/v1/campaigns/${campaignId}/enroll`, b),
    start: (campaignId: string) => this.request<{ status: string }>("POST", `/v1/campaigns/${campaignId}/start`),
    pause: (campaignId: string) => this.request<{ status: string }>("POST", `/v1/campaigns/${campaignId}/pause`),
    stats: (campaignId: string) => this.request<Record<string, unknown>>("GET", `/v1/campaigns/${campaignId}/stats`),
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
    decisionMakers: (domain: string, b: { titles?: string[]; limit?: number; save?: boolean } = {}) => this.request<{ people: unknown[]; savedLeadIds: string[] }>("POST", `/v1/visitors/${domain}/decision-makers`, b),
  };

  signals = {
    feed: (q: { type?: string; q?: string; matched?: "true" | "false"; days?: number; limit?: number } = {}) => this.request<{ signals: unknown[] }>("GET", "/v1/signals", undefined, q),
    scan: (b: { types?: string[]; keywords?: string[]; industries?: string[]; locations?: string[]; days?: number } = {}) => this.request<{ parsed: number; stored: number; signals: unknown[] }>("POST", "/v1/signals/scan", b),
    subscriptions: () => this.request<{ subscriptions: unknown[] }>("GET", "/v1/signals/subscriptions"),
    subscribe: (b: { name: string; types: string[]; keywords?: string[]; industries?: string[]; locations?: string[]; targetTitles?: string[]; autoCreateLeads?: boolean; icpId?: string; campaignId?: string }) => this.request<{ id: string }>("POST", "/v1/signals/subscriptions", b),
    runSubscription: (id: string) => this.request<{ matched: number; leadsCreated: number }>("POST", `/v1/signals/subscriptions/${id}/run`),
    monitors: () => this.request<{ monitors: unknown[] }>("GET", "/v1/signals/monitors"),
    createMonitor: (b: { type: "linkedin_post" | "keyword" | "competitor" | "company_news" | "jobs"; name: string; target: string; config?: Record<string, unknown>; intervalMinutes?: number }) => this.request<{ id: string }>("POST", "/v1/signals/monitors", b),
    runMonitor: (id: string) => this.request<{ added: number }>("POST", `/v1/signals/monitors/${id}/run`),
    monitorResults: (id: string) => this.request<{ results: unknown[] }>("GET", `/v1/signals/monitors/${id}/results`),
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
    completeTask: (id: string, outcome: "done" | "skipped" = "done", note?: string) => this.request<{ ok: true }>("POST", `/v1/tools/tasks/${id}/complete`, { outcome, note }),
    savedSearches: () => this.request<{ savedSearches: unknown[] }>("GET", "/v1/tools/saved-searches"),
    saveSearch: (b: { name: string; query: SearchQuery; alert?: boolean; alertEmail?: string; listId?: string }) => this.request<{ id: string }>("POST", "/v1/tools/saved-searches", b),
    autopilots: () => this.request<{ autopilots: unknown[] }>("GET", "/v1/tools/autopilots"),
    createAutopilot: (b: { name: string; query: SearchQuery; icpId?: string; listId?: string; campaignId?: string; dailyLeads?: number; minScore?: number; requireValidEmail?: boolean; autoEnroll?: boolean; runHourUtc?: number }) => this.request<{ id: string }>("POST", "/v1/tools/autopilots", b),
    runAutopilot: (id: string) => this.request<{ jobId: string }>("POST", `/v1/tools/autopilots/${id}/run`),
    setLeadStatus: (id: string, status: string) => this.request<Lead>("POST", `/v1/tools/leads/${id}/status`, { status }),
  };

  account = {
    usage: () => this.request<{ period: string; plan: string; usage: Record<string, { used: number; limit: number }> }>("GET", "/v1/usage"),
    analytics: () => this.request<Record<string, unknown>>("GET", "/v1/analytics/overview"),
    events: (q: { type?: string; limit?: number } = {}) => this.request<{ events: unknown[] }>("GET", "/v1/events", undefined, q),
    webhooks: () => this.request<{ webhooks: unknown[] }>("GET", "/v1/webhooks"),
    createWebhook: (url: string, events: string[] = ["*"]) => this.request<{ id: string; secret: string }>("POST", "/v1/webhooks", { url, events }),
    integrations: () => this.request<{ integrations: unknown[]; providers: string[] }>("GET", "/v1/integrations"),
    configureIntegration: (provider: string, config: Record<string, string>, autoSync = false) => this.request<unknown>("PUT", `/v1/integrations/${provider}`, { config, autoSync }),
    syncToCrm: (provider: string, leadIds: string[]) => this.request<{ queued: number }>("POST", `/v1/integrations/${provider}/sync`, { leadIds }),
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
