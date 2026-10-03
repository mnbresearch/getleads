/**
 * End-to-end lead discovery pipeline, provider-agnostic and DB-agnostic.
 * Query → companies/people via web search → website enrichment → email find + verify → ICP score.
 */
import type { AiProvider, CompanyProfile, LeadSearchQuery, PersonCandidate } from "./types.js";
import { completeJson, hasAi } from "./ai/provider.js";
import { redact } from "./ai/redact.js";
import { UNTRUSTED_RULE, fenceBlock, stringList } from "./ai/untrusted.js";
import { findCompanies, resolveCompanyDomain } from "./discovery/companies.js";
import { findPeople } from "./discovery/people.js";
import { crawlCompanyWebsite } from "./enrich/website.js";
import { BULK_FIND_DEFAULTS, findEmail, type FindEmailOptions } from "./email/find.js";
import { verifyEmail, type VerifyOptions } from "./email/verify.js";
import { scoreLeadRules, type IcpCriteria } from "./icp/score.js";
import { inferDepartment, inferSeniority } from "./util/names.js";
import { pMap } from "./util/http.js";
import { summarizeWebSearchFailures, type WebSearchOutcome } from "./search/index.js";
import { searchProvidersDetailed, peopleProviders, type ProviderPerson } from "./providers/people.js";

export interface PipelineLead extends PersonCandidate {
  seniority?: string;
  department?: string;
  email?: string;
  emailStatus?: string;
  emailConfidence?: number;
  companyDomain?: string;
  company?: Partial<CompanyProfile>;
  score?: number;
  scoreReasons?: string[];
  /** Which verifier vouched for `email` ("reoon:safe", "smtp", ...); undefined for a guess. */
  emailVerifiedBy?: string;
}

export interface PipelineOptions {
  ai?: AiProvider;
  verify?: FindEmailOptions;
  icp?: IcpCriteria;
  onProgress?: (pct: number, msg: string) => void;
  companyCache?: Map<string, CompanyProfile>;
  country?: string;
  /**
   * Caps how many results may come from a paid data provider (Apollo/Hunter/PDL) in this
   * call. Pass the org's remaining premium-lead budget (see packages/db's
   * remainingPremiumBudget()) so provider APIs are never even called past what the org is
   * entitled to this billing period. 0 skips provider calls entirely and falls straight to
   * free web discovery + site-crawl enrichment. Omitted/undefined = no cap (back-compat).
   */
  maxProviderLeads?: number;
}

/** Turn a natural-language query into structured filters using AI (or heuristics if unavailable). */
export async function parseQuery(ai: AiProvider | undefined, q: LeadSearchQuery): Promise<LeadSearchQuery> {
  return (await parseQueryDetailed(ai, q)).query;
}

/**
 * parseQuery, plus a note when the AI could not be used.
 *
 * A Groq 429 here used to throw out of the pipeline and fail the entire search - over the
 * step with the cheapest possible fallback. The heuristic parser is worse, not wrong, so it
 * takes over and the note says it did.
 */
export async function parseQueryDetailed(ai: AiProvider | undefined, q: LeadSearchQuery): Promise<{ query: LeadSearchQuery; note: string | null }> {
  if (!q.query || (q.titles?.length && q.industries?.length)) return { query: q, note: null };
  let note: string | null = null;
  if (ai && hasAi(ai)) {
    const res = await completeJson<Record<string, unknown>>(ai, [
      {
        role: "system",
        content:
          'Extract B2B lead search filters from the search text in the query block. JSON {"titles":[], "industries":[], "locations":[], "keywords":[], "companySizes":[]}. Titles are job titles to search on LinkedIn (max 4). Keep arrays short. ' +
          UNTRUSTED_RULE,
      },
      { role: "user", content: `${fenceBlock("query", q.query, 2000)}\nReturn JSON only.` },
    ], { maxTokens: 300, temperature: 0 }).catch((e) => {
      // The reason is kept for the operator; the upstream body never reaches the note verbatim.
      note = `AI query parsing failed (${redact((e as Error).message ?? String(e), { max: 160 })}); used the keyword parser instead`;
      return null;
    });
    if (res && typeof res === "object") {
      // Shape-checked: each filter is a short list of short strings or it is nothing. A
      // model that answers {"titles": "CEO; DROP"} or {"industries": {"a": 1}} used to have
      // that value passed straight into the provider queries.
      const list = (v: unknown, max: number) => stringList(v, max, 100);
      const sizes = list(res.companySizes, 7).filter((x) => /^(?:\d{1,6}-\d{1,6}|\d{1,6}\+)$/.test(x));
      return { note: null, query: {
        ...q,
        titles: q.titles?.length ? q.titles : list(res.titles, 6),
        industries: q.industries?.length ? q.industries : list(res.industries, 10),
        locations: q.locations?.length ? q.locations : list(res.locations, 10),
        keywords: q.keywords?.length ? q.keywords : list(res.keywords, 10),
        companySizes: q.companySizes?.length ? q.companySizes : sizes,
      } };
    }
    note ??= "AI query parsing returned nothing usable; used the keyword parser instead";
  }
  // Heuristic: "X at Y in Z"
  const m = q.query.match(/^(.*?)(?:\s+(?:at|in|for)\s+(.*?))?(?:\s+in\s+(.*))?$/i);
  return { note, query: { ...q, titles: q.titles ?? (m?.[1] ? [m[1].trim()] : []), industries: q.industries ?? (m?.[2] ? [m[2].trim()] : []), locations: q.locations ?? (m?.[3] ? [m[3].trim()] : []) } };
}

export interface PipelineOutcome {
  leads: PipelineLead[];
  /**
   * Configured data providers that could not answer, with the reason each gave.
   *
   * An empty result set means one of two very different things - nobody matched, or nothing
   * we asked could reply - and a search that finishes `resultCount: 0, error: null` asserts
   * the first. When this array is non-empty and no leads came back, it is the second.
   */
  providerFailures: { provider: string; message: string }[];
  /**
   * Things that degraded the run without failing it: the AI parser falling back to keywords,
   * email lookups that threw, company sites that could not be crawled. Present so a thin
   * result can be explained; not a failure on its own.
   */
  notes: string[];
  /** Web searches fired and how many of them no provider answered. */
  webSearch: { searches: number; failed: number };
}

/** Hard bounds on a search, whoever asked for it. The interactive route validates to the same numbers. */
export const LEAD_QUERY_LIMITS = { limit: 200, companyDomains: 50, list: 10, keywords: 20, queryChars: 2000, itemChars: 200 } as const;

/**
 * Reduce anything query-shaped to a bounded LeadSearchQuery.
 *
 * The interactive search route validates its input, but saved searches and autopilots store
 * a query as free jsonb and replay it later from a job - where `limit: 100000` and ten
 * thousand company domains were passed straight through, each domain costing a crawl and a
 * web search. This is applied where the pipeline STARTS, so no caller can skip it: unknown
 * keys are dropped (a stored query can never supply an option), lists are capped and must be
 * lists of strings, and the limit is 1..200.
 */
export function clampLeadQuery(raw: unknown): LeadSearchQuery {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const L = LEAD_QUERY_LIMITS;
  const list = (v: unknown, max: number): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") continue;
      const s = x.trim().slice(0, L.itemChars);
      if (s) out.push(s);
      if (out.length >= max) break;
    }
    return out;
  };
  const out: LeadSearchQuery = {};
  if (typeof r.query === "string" && r.query.trim()) out.query = r.query.slice(0, L.queryChars);
  const titles = list(r.titles, L.list);
  const industries = list(r.industries, L.list);
  const locations = list(r.locations, L.list);
  const companySizes = list(r.companySizes, L.list);
  const keywords = list(r.keywords, L.keywords);
  const companyDomains = list(r.companyDomains, L.companyDomains);
  if (titles) out.titles = titles;
  if (industries) out.industries = industries;
  if (locations) out.locations = locations;
  if (companySizes) out.companySizes = companySizes;
  if (keywords) out.keywords = keywords;
  if (companyDomains) out.companyDomains = companyDomains;
  const n = typeof r.limit === "number" ? r.limit : typeof r.limit === "string" ? Number(r.limit) : NaN;
  if (Number.isFinite(n)) out.limit = Math.min(L.limit, Math.max(1, Math.floor(n)));
  if (typeof r.findEmails === "boolean") out.findEmails = r.findEmails;
  return out;
}

/** The pipeline, with what went wrong alongside what came back. */
export async function runLeadPipelineDetailed(rawQuery: LeadSearchQuery, opts: PipelineOptions = {}): Promise<PipelineOutcome> {
  // Bounded here, at the one place every search passes through.
  const query = clampLeadQuery(rawQuery);
  const progress = opts.onProgress ?? (() => {});
  const cache = opts.companyCache ?? new Map<string, CompanyProfile>();
  const limit = query.limit ?? 25;

  progress(5, "parsing query");
  const notes: string[] = [];
  const parsed = await parseQueryDetailed(opts.ai, query);
  const q = parsed.query;
  if (parsed.note) notes.push(parsed.note);

  // Every web search this run fires reports here, so "no provider answered" can be told
  // apart from "nobody matched" once discovery is done.
  const searchOutcomes: WebSearchOutcome[] = [];
  const searchOpts = { onOutcome: (o: WebSearchOutcome) => void searchOutcomes.push(o) };

  // 0) External data providers first (Apollo / Hunter / PDL) when configured AND the org still
  // has premium-lead budget left this period - database-quality rows, but they cost real money,
  // so never call out to them past what maxProviderLeads allows (0 = skip entirely).
  progress(8, "querying data providers");
  const providerBudget = opts.maxProviderLeads ?? Infinity;
  const providerFailures: { provider: string; message: string }[] = [];
  let providerRows: ProviderPerson[] = [];
  if (providerBudget > 0 && peopleProviders().length) {
    // A rejected key must not arrive here looking like an empty database. apolloProvider
    // classifies and throws precisely so the distinction survives; it is carried out of the
    // pipeline rather than swallowed into [].
    const r = await searchProvidersDetailed({ titles: q.titles, locations: q.locations, industries: q.industries, keywords: q.keywords, companyDomains: q.companyDomains, companySizes: q.companySizes, limit: Math.min(limit, providerBudget) }).catch((e) => ({
      people: [] as ProviderPerson[],
      failures: [{ provider: "providers", message: (e as Error).message ?? "threw" }],
      answered: [] as string[],
    }));
    providerRows = r.people.slice(0, providerBudget);
    // These messages are shown to the customer as the reason a search came back empty, and
    // they are built from upstream error text - so credentials and account ids are masked.
    providerFailures.push(...r.failures.map((f) => ({ provider: f.provider, message: redact(f.message, { max: 300 }) })));
  }

  // 1) People discovery
  progress(10, "searching people");
  let people: PersonCandidate[] = [...providerRows];
  if (people.length >= limit) {
    // skip web discovery entirely
  } else if (q.companyDomains?.length) {
    for (const d of q.companyDomains) {
      const prof = await getCompany(d, cache);
      const byName = await findPeople({ titles: q.titles, companyName: prof.name ?? d, locations: q.locations, limit: Math.ceil(limit / q.companyDomains.length), country: opts.country }, searchOpts);
      people.push(...byName.map((p) => ({ ...p, companyName: p.companyName ?? prof.name, companyDomainHint: d })));
      people.push(...prof.peopleFound.filter((p) => !q.titles?.length || q.titles.some((t) => p.title?.toLowerCase().includes(t.toLowerCase()))).map((p) => ({ ...p, companyDomainHint: d })));
    }
  } else {
    people.push(...(await findPeople({ titles: q.titles, industries: q.industries, locations: q.locations, keywords: q.keywords, limit: limit * 2, country: opts.country }, searchOpts)));
  }
  // Fallback: find companies first, then people at each
  if (people.length < Math.min(5, limit) && !q.companyDomains?.length) {
    progress(25, "searching companies");
    const companies = await findCompanies({ query: q.query, industries: q.industries, locations: q.locations, keywords: q.keywords, limit: 10, country: opts.country }, searchOpts);
    for (const c of companies.slice(0, 8)) {
      const domain = c.domain || (c.name ? await resolveCompanyDomain(c.name, undefined, searchOpts) : null);
      if (!domain) continue;
      const ppl = await findPeople({ titles: q.titles, companyName: c.name ?? domain, limit: 3, country: opts.country }, searchOpts);
      people.push(...ppl.map((p) => ({ ...p, companyName: p.companyName ?? c.name, companyDomainHint: domain })));
      if (people.length >= limit * 2) break;
    }
  }
  people = dedupePeople(people).slice(0, limit);
  // Web discovery where no search provider ever answered is an outage, not an empty market.
  // Carried in providerFailures because that is what callers already turn into a search
  // error when the run comes back empty.
  const webFailure = summarizeWebSearchFailures(searchOutcomes);
  if (webFailure) providerFailures.push({ provider: "web_search", message: redact(webFailure, { max: 300 }) });
  progress(40, `found ${people.length} people`);

  // 2) Company resolution + enrichment
  const enrichErrors: string[] = [];
  const leads: PipelineLead[] = await pMap(
    people,
    async (p) => {
      const pp = p as ProviderPerson;
      const lead: PipelineLead = { ...p, seniority: pp.seniority ?? inferSeniority(p.title), department: inferDepartment(p.title), email: pp.email, emailStatus: pp.emailStatus, emailConfidence: pp.emailStatus === "valid" ? 0.95 : undefined };
      const hint = (p as PersonCandidate & { companyDomainHint?: string }).companyDomainHint ?? pp.companyDomain;
      const domain = hint ?? (p.companyName ? await resolveCompanyDomain(p.companyName, p.location).catch((e) => {
            enrichErrors.push(`domain for ${p.companyName}: ${(e as Error).message}`);
            return null;
          }) : null);
      if (domain) {
        lead.companyDomain = domain;
        const prof = await getCompany(domain, cache).catch((e) => {
          enrichErrors.push(`crawl ${domain}: ${(e as Error).message}`);
          return null;
        });
        if (prof) lead.company = prof;
      }
      return lead;
    },
    4,
  );
  if (enrichErrors.length) notes.push(`${enrichErrors.length} company lookup(s) failed: ${redact(enrichErrors.slice(0, 3).join("; "), { max: 300 })}`);
  progress(65, "enriched companies");

  // 3) Email find + verify
  if (query.findEmails !== false) {
    const emailErrors: string[] = [];
    await pMap(
      leads,
      async (lead) => {
        if (!lead.companyDomain || !lead.firstName || !lead.lastName || lead.email) return;
        const prof = cache.get(lead.companyDomain);
        const r = await findEmail(
          { firstName: lead.firstName, lastName: lead.lastName, domain: lead.companyDomain, knownPattern: prof?.emailPattern, knownEmails: prof?.emailsFound },
          // Bulk path: one pay-as-you-go check per lead unless the caller says otherwise. Three
          // paid checks per lead across every search/autopilot run was a cost blow-up.
          { ...BULK_FIND_DEFAULTS, ...opts.verify },
        ).catch((e) => {
          emailErrors.push((e as Error).message ?? String(e));
          return null;
        });
        if (r?.email) {
          lead.email = r.email;
          lead.emailStatus = r.status;
          lead.emailConfidence = r.confidence;
          lead.emailVerifiedBy = r.verifiedBy;
          if (prof && r.pattern && !prof.emailPattern) prof.emailPattern = r.pattern;
        } else if (r) {
          lead.emailStatus = r.status;
          lead.emailConfidence = r.confidence;
        }
      },
      3,
    );
    if (emailErrors.length) notes.push(`email lookup failed for ${emailErrors.length} lead(s): ${redact(emailErrors[0], { max: 200 })}`);
    progress(90, "verified emails");
  }

  // 4) Score
  const icp: IcpCriteria = opts.icp ?? { titles: q.titles, industries: q.industries, locations: q.locations, keywords: q.keywords, companySizes: q.companySizes };
  for (const lead of leads) {
    const s = scoreLeadRules(
      { title: lead.title, location: lead.location, emailStatus: lead.emailStatus, company: lead.company ? { name: lead.company.name, industry: lead.company.industry, size: lead.company.size, location: lead.company.location, country: lead.company.country, description: lead.company.description, techStack: lead.company.techStack } : null },
      icp,
    );
    lead.score = s.score;
    lead.scoreReasons = s.reasons;
  }
  leads.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  progress(100, "done");
  return { leads, providerFailures, notes, webSearch: { searches: searchOutcomes.length, failed: searchOutcomes.filter((o) => o.everyProviderFailed).length } };
}

/** Back-compatible shape: the leads alone, for callers that do not need the detail. */
export async function runLeadPipeline(query: LeadSearchQuery, opts: PipelineOptions = {}): Promise<PipelineLead[]> {
  return (await runLeadPipelineDetailed(query, opts)).leads;
}

async function getCompany(domain: string, cache: Map<string, CompanyProfile>) {
  const hit = cache.get(domain);
  if (hit) return hit;
  const prof = await crawlCompanyWebsite(domain, { maxPages: 5 });
  // Only remember a crawl that actually reached the site. Caching a failure would re-serve
  // one unreachable moment as this company's profile for the rest of the run.
  if (!prof.crawlFailed) cache.set(domain, prof);
  return prof;
}

function dedupePeople(list: PersonCandidate[]) {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = p.linkedinUrl ?? `${p.fullName.toLowerCase()}|${(p.companyName ?? "").toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export { verifyEmail };
