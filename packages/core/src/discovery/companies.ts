import type { CompanyCandidate, SearchResult } from "../types.js";
import { webSearch, type WebSearchOptions } from "../search/index.js";
import { extractDomain, isSocialOrAggregator, normalizeLinkedinUrl } from "../util/domain.js";

export interface CompanySearchInput {
  query?: string;
  industries?: string[];
  locations?: string[];
  keywords?: string[];
  sizes?: string[];
  limit?: number;
  country?: string;
}

export function buildCompanyQueries(input: CompanySearchInput): string[] {
  const loc = input.locations?.length ? input.locations.map((l) => `"${l}"`).join(" OR ") : "";
  const base = input.query ?? "";
  const inds = input.industries?.length ? input.industries : [""];
  const kw = input.keywords?.join(" ") ?? "";
  const qs: string[] = [];
  for (const ind of inds) {
    qs.push([base, ind, kw, loc && `(${loc})`, "company"].filter(Boolean).join(" ").trim());
    // LinkedIn company pages give clean names + one-line descriptions
    qs.push([`site:linkedin.com/company`, base, ind, kw, loc && `(${loc})`].filter(Boolean).join(" ").trim());
  }
  return qs;
}

export function extractCompaniesFromResults(results: SearchResult[]): CompanyCandidate[] {
  const out: CompanyCandidate[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const li = normalizeLinkedinUrl(r.url);
    if (li && li.includes("/company/")) {
      const name = r.title.replace(/\s*[|–-]\s*LinkedIn\s*$/i, "").split(/\s+[|–-]\s+/)[0].trim();
      const key = `li:${li}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, domain: "", linkedinUrl: li, snippet: r.snippet, description: r.snippet, source: `search:${r.provider}` });
      continue;
    }
    const domain = extractDomain(r.url);
    if (!domain || isSocialOrAggregator(domain)) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    const name = r.title.split(/\s+[|–\-:]\s+/)[0].trim().slice(0, 80);
    out.push({ name, domain, website: `https://${domain}`, description: r.snippet, snippet: r.snippet, source: `search:${r.provider}` });
  }
  return out;
}

export async function findCompanies(input: CompanySearchInput, searchOpts: WebSearchOptions = {}): Promise<CompanyCandidate[]> {
  const limit = input.limit ?? 20;
  const queries = buildCompanyQueries(input);
  const found: CompanyCandidate[] = [];
  const seenDomain = new Set<string>();
  const seenName = new Set<string>();
  for (const q of queries) {
    const results = await webSearch(q, { count: 20, country: input.country, ...searchOpts });
    for (const c of extractCompaniesFromResults(results)) {
      const nk = (c.name ?? "").toLowerCase();
      if (c.domain && seenDomain.has(c.domain)) continue;
      if (!c.domain && nk && seenName.has(nk)) continue;
      if (c.domain) seenDomain.add(c.domain);
      if (nk) seenName.add(nk);
      found.push(c);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** Resolve a company name to its most likely website domain. */
export async function resolveCompanyDomain(name: string, hint?: string): Promise<string | null> {
  const results = await webSearch(`"${name}" ${hint ?? ""} official website`.trim(), { count: 10 });
  const nameTokens = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((t) => t.length > 2);
  let best: { domain: string; score: number } | null = null;
  for (const r of results) {
    const d = extractDomain(r.url);
    if (!d || isSocialOrAggregator(d)) continue;
    const dl = d.toLowerCase();
    let score = 0;
    for (const t of nameTokens) if (dl.includes(t)) score += 2;
    if (r.title.toLowerCase().includes(name.toLowerCase())) score += 1;
    if (!best || score > best.score) best = { domain: d, score };
  }
  return best && best.score > 0 ? best.domain : results.map((r) => extractDomain(r.url)).find((d) => d && !isSocialOrAggregator(d)) ?? null;
}
