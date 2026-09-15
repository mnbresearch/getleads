/**
 * End-to-end lead discovery pipeline, provider-agnostic and DB-agnostic.
 * Query → companies/people via web search → website enrichment → email find + verify → ICP score.
 */
import type { AiProvider, CompanyProfile, LeadSearchQuery, PersonCandidate } from "./types.js";
import { completeJson, hasAi } from "./ai/provider.js";
import { findCompanies, resolveCompanyDomain } from "./discovery/companies.js";
import { findPeople } from "./discovery/people.js";
import { crawlCompanyWebsite } from "./enrich/website.js";
import { findEmail } from "./email/find.js";
import { verifyEmail, type VerifyOptions } from "./email/verify.js";
import { scoreLeadRules, type IcpCriteria } from "./icp/score.js";
import { inferDepartment, inferSeniority } from "./util/names.js";
import { pMap } from "./util/http.js";
import { searchProviders, peopleProviders, type ProviderPerson } from "./providers/people.js";

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
}

export interface PipelineOptions {
  ai?: AiProvider;
  verify?: VerifyOptions;
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
  if (!q.query || (q.titles?.length && q.industries?.length)) return q;
  if (ai && hasAi(ai)) {
    const res = await completeJson<{ titles: string[]; industries: string[]; locations: string[]; keywords: string[]; companySizes: string[] }>(ai, [
      { role: "system", content: 'Extract B2B lead search filters from text. JSON {"titles":[], "industries":[], "locations":[], "keywords":[], "companySizes":[]}. Titles are job titles to search on LinkedIn (max 4). Keep arrays short.' },
      { role: "user", content: q.query },
    ], { maxTokens: 300, temperature: 0 });
    if (res) {
      return {
        ...q,
        titles: q.titles?.length ? q.titles : res.titles ?? [],
        industries: q.industries?.length ? q.industries : res.industries ?? [],
        locations: q.locations?.length ? q.locations : res.locations ?? [],
        keywords: q.keywords?.length ? q.keywords : res.keywords ?? [],
        companySizes: q.companySizes?.length ? q.companySizes : res.companySizes ?? [],
      };
    }
  }
  // Heuristic: "X at Y in Z"
  const m = q.query.match(/^(.*?)(?:\s+(?:at|in|for)\s+(.*?))?(?:\s+in\s+(.*))?$/i);
  return { ...q, titles: q.titles ?? (m?.[1] ? [m[1].trim()] : []), industries: q.industries ?? (m?.[2] ? [m[2].trim()] : []), locations: q.locations ?? (m?.[3] ? [m[3].trim()] : []) };
}

export async function runLeadPipeline(query: LeadSearchQuery, opts: PipelineOptions = {}): Promise<PipelineLead[]> {
  const progress = opts.onProgress ?? (() => {});
  const cache = opts.companyCache ?? new Map<string, CompanyProfile>();
  const limit = query.limit ?? 25;

  progress(5, "parsing query");
  const q = await parseQuery(opts.ai, query);

  // 0) External data providers first (Apollo / Hunter / PDL) when configured AND the org still
  // has premium-lead budget left this period - database-quality rows, but they cost real money,
  // so never call out to them past what maxProviderLeads allows (0 = skip entirely).
  progress(8, "querying data providers");
  const providerBudget = opts.maxProviderLeads ?? Infinity;
  const providerRows: ProviderPerson[] = providerBudget > 0 && peopleProviders().length
    ? (await searchProviders({ titles: q.titles, locations: q.locations, industries: q.industries, keywords: q.keywords, companyDomains: q.companyDomains, companySizes: q.companySizes, limit: Math.min(limit, providerBudget) }).catch(() => [])).slice(0, providerBudget)
    : [];

  // 1) People discovery
  progress(10, "searching people");
  let people: PersonCandidate[] = [...providerRows];
  if (people.length >= limit) {
    // skip web discovery entirely
  } else if (q.companyDomains?.length) {
    for (const d of q.companyDomains) {
      const prof = await getCompany(d, cache);
      const byName = await findPeople({ titles: q.titles, companyName: prof.name ?? d, locations: q.locations, limit: Math.ceil(limit / q.companyDomains.length), country: opts.country });
      people.push(...byName.map((p) => ({ ...p, companyName: p.companyName ?? prof.name, companyDomainHint: d })));
      people.push(...prof.peopleFound.filter((p) => !q.titles?.length || q.titles.some((t) => p.title?.toLowerCase().includes(t.toLowerCase()))).map((p) => ({ ...p, companyDomainHint: d })));
    }
  } else {
    people.push(...(await findPeople({ titles: q.titles, industries: q.industries, locations: q.locations, keywords: q.keywords, limit: limit * 2, country: opts.country })));
  }
  // Fallback: find companies first, then people at each
  if (people.length < Math.min(5, limit) && !q.companyDomains?.length) {
    progress(25, "searching companies");
    const companies = await findCompanies({ query: q.query, industries: q.industries, locations: q.locations, keywords: q.keywords, limit: 10, country: opts.country });
    for (const c of companies.slice(0, 8)) {
      const domain = c.domain || (c.name ? await resolveCompanyDomain(c.name) : null);
      if (!domain) continue;
      const ppl = await findPeople({ titles: q.titles, companyName: c.name ?? domain, limit: 3, country: opts.country });
      people.push(...ppl.map((p) => ({ ...p, companyName: p.companyName ?? c.name, companyDomainHint: domain })));
      if (people.length >= limit * 2) break;
    }
  }
  people = dedupePeople(people).slice(0, limit);
  progress(40, `found ${people.length} people`);

  // 2) Company resolution + enrichment
  const leads: PipelineLead[] = await pMap(
    people,
    async (p) => {
      const pp = p as ProviderPerson;
      const lead: PipelineLead = { ...p, seniority: pp.seniority ?? inferSeniority(p.title), department: inferDepartment(p.title), email: pp.email, emailStatus: pp.emailStatus, emailConfidence: pp.emailStatus === "valid" ? 0.95 : undefined };
      const hint = (p as PersonCandidate & { companyDomainHint?: string }).companyDomainHint ?? pp.companyDomain;
      const domain = hint ?? (p.companyName ? await resolveCompanyDomain(p.companyName, p.location).catch(() => null) : null);
      if (domain) {
        lead.companyDomain = domain;
        const prof = await getCompany(domain, cache).catch(() => null);
        if (prof) lead.company = prof;
      }
      return lead;
    },
    4,
  );
  progress(65, "enriched companies");

  // 3) Email find + verify
  if (query.findEmails !== false) {
    await pMap(
      leads,
      async (lead) => {
        if (!lead.companyDomain || !lead.firstName || !lead.lastName || lead.email) return;
        const prof = cache.get(lead.companyDomain);
        const r = await findEmail(
          { firstName: lead.firstName, lastName: lead.lastName, domain: lead.companyDomain, knownPattern: prof?.emailPattern, knownEmails: prof?.emailsFound },
          opts.verify,
        ).catch(() => null);
        if (r?.email) {
          lead.email = r.email;
          lead.emailStatus = r.status;
          lead.emailConfidence = r.confidence;
          if (prof && r.pattern && !prof.emailPattern) prof.emailPattern = r.pattern;
        } else if (r) {
          lead.emailStatus = r.status;
          lead.emailConfidence = r.confidence;
        }
      },
      3,
    );
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
  return leads;
}

async function getCompany(domain: string, cache: Map<string, CompanyProfile>) {
  const hit = cache.get(domain);
  if (hit) return hit;
  const prof = await crawlCompanyWebsite(domain, { maxPages: 5 });
  cache.set(domain, prof);
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
