import type { CompanyCandidate, SearchResult } from "../types.js";
import { webSearch, type SearchProvider, type WebSearchOptions } from "../search/index.js";
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

export interface DomainResolution {
  domain: string | null;
  /** 0..1. How much the SERP actually corroborated this being the company's own site. */
  confidence: number;
  reason: string;
}

/**
 * Resolve a company name to its website domain, or admit that it could not.
 *
 * The old version ended with a fallback that returned the first non-social domain in the
 * result set whenever nothing scored - so a search that found only directory listings,
 * news articles or an unrelated site handed back a confident-looking domain belonging to
 * someone else. Downstream that domain became the company's identity: emails were guessed
 * at it, a website crawl was attributed to it, leads were filed under it. A wrong answer
 * here is far more expensive than no answer, because nothing downstream can tell it is
 * wrong, so corroboration is now required rather than assumed.
 *
 * Corroboration means one of: the domain contains a distinctive word from the name, or the
 * result's title or snippet names the company. Rank alone is not evidence.
 */
export async function resolveCompanyDomainDetailed(name: string, hint?: string, opts: { providers?: SearchProvider[] } = {}): Promise<DomainResolution> {
  const results = await webSearch(`"${name}" ${hint ?? ""} official website`.trim(), { count: 10, providers: opts.providers });
  if (!results.length) return { domain: null, confidence: 0, reason: "search returned nothing - provider failure or no match, not a company without a website" };

  const lower = name.toLowerCase();
  const nameTokens = lower.replace(/[^a-z0-9 ]/g, "").split(" ").filter((t) => t.length > 2);
  // A name made only of short words ("3M", "SAP") has no distinctive token to match on, so
  // the title/snippet evidence has to carry it.
  let best: { domain: string; score: number; why: string[] } | null = null;

  for (const r of results) {
    const d = extractDomain(r.url);
    if (!d || isSocialOrAggregator(d)) continue;
    const dl = d.toLowerCase();
    const why: string[] = [];
    let score = 0;
    const matched = nameTokens.filter((t) => dl.includes(t));
    if (matched.length) {
      score += 2 * matched.length;
      why.push(`domain contains ${matched.join(", ")}`);
    }
    if ((r.title ?? "").toLowerCase().includes(lower)) {
      score += 1;
      why.push("title names the company");
    }
    if ((r.snippet ?? "").toLowerCase().includes(lower)) {
      score += 0.5;
      why.push("snippet names the company");
    }
    if (!best || score > best.score) best = { domain: d, score, why };
  }

  if (!best || best.score < 1) {
    return {
      domain: null,
      confidence: 0,
      reason: `no result corroborated "${name}" - returning nothing rather than the first unrelated domain in the list`,
    };
  }
  // 2 tokens + title + snippet is the ceiling in practice; cap so this never reads as certain.
  const confidence = Math.min(0.95, 0.45 + best.score * 0.1);
  return { domain: best.domain, confidence, reason: best.why.join("; ") };
}

/** Resolve a company name to its most likely website domain, or null if nothing corroborates it. */
export async function resolveCompanyDomain(name: string, hint?: string, opts: { providers?: SearchProvider[] } = {}): Promise<string | null> {
  return (await resolveCompanyDomainDetailed(name, hint, opts)).domain;
}
