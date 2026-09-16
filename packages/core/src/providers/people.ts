/**
 * External people/company data providers. All optional; each has a free tier.
 * When configured they run BEFORE web discovery so users get database-quality results.
 *   - Apollo.io      free plan: limited credits/month, people + org search
 *   - Hunter.io      25 domain searches/month
 *   - People Data Labs  100 person enrich/month free
 */
import type { PersonCandidate } from "../types.js";
import { fetchJson, fetchWithTimeout } from "../util/http.js";
import { splitName } from "../util/names.js";
import { normalizeLinkedinUrl } from "../util/domain.js";
import { meter } from "../util/meter.js";

export interface PeopleProviderQuery {
  titles?: string[];
  seniorities?: string[];
  locations?: string[];
  industries?: string[];
  keywords?: string[];
  companyDomains?: string[];
  companyName?: string;
  companySizes?: string[];
  limit?: number;
}

export interface ProviderPerson extends PersonCandidate {
  email?: string;
  emailStatus?: string;
  phone?: string;
  companyDomain?: string;
  companyIndustry?: string;
  companySize?: string;
  companyLinkedinUrl?: string;
  seniority?: string;
}

export interface PeopleProvider {
  name: string;
  available(): boolean;
  search(q: PeopleProviderQuery): Promise<ProviderPerson[]>;
  /** Optional: enrich a single person by email or LinkedIn URL. */
  enrich?(input: { email?: string; linkedinUrl?: string; firstName?: string; lastName?: string; companyDomain?: string }): Promise<ProviderPerson | null>;
}

const APOLLO_SIZE_MAP: Record<string, string> = { "1-10": "1,10", "11-50": "11,50", "51-200": "51,200", "201-500": "201,500", "501-1000": "501,1000", "1001-5000": "1001,5000", "5000+": "5001,1000000" };

export const apolloProvider = (apiKey = process.env.APOLLO_API_KEY): PeopleProvider => ({
  name: "apollo",
  available: () => !!apiKey,
  async search(q) {
    meter("apollo");
    const body: Record<string, unknown> = {
      page: 1,
      per_page: Math.min(q.limit ?? 25, 100),
      ...(q.titles?.length ? { person_titles: q.titles } : {}),
      ...(q.seniorities?.length ? { person_seniorities: q.seniorities.map((s) => ({ c_level: "c_suite", vp: "vp", director: "director", manager: "manager", senior: "senior", individual: "entry", entry: "entry" })[s] ?? s) } : {}),
      ...(q.locations?.length ? { person_locations: q.locations } : {}),
      ...(q.companyDomains?.length ? { q_organization_domains: q.companyDomains.join("\n") } : {}),
      ...(q.companyName ? { q_organization_name: q.companyName } : {}),
      ...(q.keywords?.length ? { q_keywords: q.keywords.join(" ") } : {}),
      ...(q.companySizes?.length ? { organization_num_employees_ranges: q.companySizes.map((s) => APOLLO_SIZE_MAP[s] ?? s) } : {}),
    };
    const res = await fetchWithTimeout("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      timeoutMs: 20_000,
      headers: { "content-type": "application/json", "x-api-key": apiKey!, "cache-control": "no-cache" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`apollo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { people?: Record<string, unknown>[] };
    return (data.people ?? []).map((p) => {
      const org = (p.organization ?? {}) as Record<string, unknown>;
      return {
        firstName: p.first_name as string | undefined,
        lastName: p.last_name as string | undefined,
        fullName: String(p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()),
        title: p.title as string | undefined,
        seniority: p.seniority as string | undefined,
        companyName: org.name as string | undefined,
        companyDomain: org.primary_domain as string | undefined,
        companyIndustry: org.industry as string | undefined,
        companySize: org.estimated_num_employees ? sizeBand(Number(org.estimated_num_employees)) : undefined,
        companyLinkedinUrl: org.linkedin_url as string | undefined,
        linkedinUrl: p.linkedin_url ? normalizeLinkedinUrl(String(p.linkedin_url)) ?? undefined : undefined,
        location: [p.city, p.state, p.country].filter(Boolean).join(", ") || undefined,
        email: p.email && !String(p.email).includes("email_not_unlocked") ? String(p.email) : undefined,
        emailStatus: p.email_status === "verified" ? "valid" : undefined,
        source: "provider:apollo",
        confidence: 0.9,
      };
    });
  },
  async enrich(input) {
    meter("apollo");
    const params = new URLSearchParams();
    if (input.email) params.set("email", input.email);
    if (input.linkedinUrl) params.set("linkedin_url", input.linkedinUrl);
    if (input.firstName) params.set("first_name", input.firstName);
    if (input.lastName) params.set("last_name", input.lastName);
    if (input.companyDomain) params.set("domain", input.companyDomain);
    const res = await fetchWithTimeout(`https://api.apollo.io/api/v1/people/match?${params}`, { method: "POST", timeoutMs: 20_000, headers: { "x-api-key": apiKey!, "content-type": "application/json" } });
    if (!res.ok) return null;
    const p = ((await res.json()) as { person?: Record<string, unknown> }).person;
    if (!p) return null;
    const org = (p.organization ?? {}) as Record<string, unknown>;
    return { firstName: p.first_name as string, lastName: p.last_name as string, fullName: String(p.name ?? ""), title: p.title as string, companyName: org.name as string, companyDomain: org.primary_domain as string, linkedinUrl: p.linkedin_url as string, email: p.email as string | undefined, emailStatus: p.email_status === "verified" ? "valid" : undefined, phone: (p.phone_numbers as { sanitized_number?: string }[] | undefined)?.[0]?.sanitized_number, source: "provider:apollo", confidence: 0.9 };
  },
});

export const hunterProvider = (apiKey = process.env.HUNTER_API_KEY): PeopleProvider => ({
  name: "hunter",
  available: () => !!apiKey,
  async search(q) {
    const domains = q.companyDomains ?? [];
    if (!domains.length) return [];
    const out: ProviderPerson[] = [];
    for (const domain of domains.slice(0, 5)) {
      meter("hunter");
      const data = await fetchJson<{ data?: { organization?: string; emails?: { value: string; first_name?: string; last_name?: string; position?: string; seniority?: string; linkedin?: string; confidence?: number; verification?: { status?: string } }[] } }>(
        `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=${Math.min(q.limit ?? 25, 100)}&api_key=${apiKey}${q.seniorities?.length ? `&seniority=${encodeURIComponent(q.seniorities.map((s) => (s === "c_level" ? "executive" : s)).join(","))}` : ""}`,
        { timeoutMs: 20_000 },
      );
      for (const e of data?.data?.emails ?? []) {
        if (!e.first_name) continue;
        out.push({ firstName: e.first_name, lastName: e.last_name, fullName: `${e.first_name} ${e.last_name ?? ""}`.trim(), title: e.position, seniority: e.seniority, companyName: data?.data?.organization, companyDomain: domain, linkedinUrl: e.linkedin ? normalizeLinkedinUrl(e.linkedin) ?? undefined : undefined, email: e.value, emailStatus: e.verification?.status === "valid" ? "valid" : (e.confidence ?? 0) >= 80 ? "valid" : "risky", source: "provider:hunter", confidence: (e.confidence ?? 50) / 100 });
      }
    }
    return out.filter((p) => !q.titles?.length || q.titles.some((t) => p.title?.toLowerCase().includes(t.toLowerCase())));
  },
});

export const pdlProvider = (apiKey = process.env.PDL_API_KEY): PeopleProvider => ({
  name: "pdl",
  available: () => !!apiKey,
  async search() {
    return []; // PDL search is paid; enrich is free-tier
  },
  async enrich(input) {
    meter("pdl");
    const params = new URLSearchParams({ api_key: apiKey!, min_likelihood: "6" });
    if (input.email) params.set("email", input.email);
    if (input.linkedinUrl) params.set("profile", input.linkedinUrl);
    if (input.firstName && input.lastName && input.companyDomain) {
      params.set("first_name", input.firstName);
      params.set("last_name", input.lastName);
      params.set("company", input.companyDomain);
    }
    const data = await fetchJson<{ status?: number; data?: Record<string, unknown> }>(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, { timeoutMs: 15_000 });
    const p = data?.data;
    if (!p) return null;
    const nm = splitName(String(p.full_name ?? ""));
    return { ...nm, title: p.job_title as string | undefined, companyName: p.job_company_name as string | undefined, companyDomain: p.job_company_website as string | undefined, linkedinUrl: p.linkedin_url ? `https://www.${p.linkedin_url}` : undefined, email: (p.work_email as string | undefined) ?? undefined, phone: (p.mobile_phone as string | undefined) ?? undefined, location: p.location_name as string | undefined, source: "provider:pdl", confidence: 0.85 };
  },
});

export function peopleProviders(): PeopleProvider[] {
  return [apolloProvider(), hunterProvider(), pdlProvider()].filter((p) => p.available());
}

/** Query all configured providers, merged and deduped by LinkedIn URL / email / name+company. */
export async function searchProviders(q: PeopleProviderQuery): Promise<ProviderPerson[]> {
  const out: ProviderPerson[] = [];
  const seen = new Set<string>();
  for (const p of peopleProviders()) {
    try {
      for (const r of await p.search(q)) {
        const k = r.linkedinUrl ?? r.email ?? `${r.fullName.toLowerCase()}|${(r.companyName ?? "").toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
      }
    } catch (e) {
      if (process.env.DEBUG_SEARCH) console.warn(`[provider:${p.name}]`, (e as Error).message);
    }
    if (out.length >= (q.limit ?? 25)) break;
  }
  return out.slice(0, q.limit ?? 25);
}

export async function enrichWithProviders(input: { email?: string; linkedinUrl?: string; firstName?: string; lastName?: string; companyDomain?: string }): Promise<ProviderPerson | null> {
  for (const p of peopleProviders()) {
    if (!p.enrich) continue;
    try {
      const r = await p.enrich(input);
      if (r) return r;
    } catch {}
  }
  return null;
}

export function sizeBand(n: number) {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  if (n <= 5000) return "1001-5000";
  return "5000+";
}
