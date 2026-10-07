import type { PersonCandidate, SearchResult } from "../types.js";
import { summarizeWebSearchFailures, webSearch, type WebSearchOptions, type WebSearchOutcome } from "../search/index.js";
import { normalizeLinkedinUrl } from "../util/domain.js";
import { splitName } from "../util/names.js";

/** How much of a search result's title and snippet is read (see `tidyResults` in search/index.ts, which passes on no more). */
const MAX_TITLE_READ = 300;
const MAX_SNIPPET_READ = 1_000;

/**
 * Parse LinkedIn profile SERP titles. Common formats:
 *   "Jane Doe - Head of Growth - Acme Corp | LinkedIn"
 *   "Jane Doe – Acme Corp – Bengaluru, India | LinkedIn"
 *   "Jane Doe | LinkedIn"
 */
export function parseLinkedinTitle(title: string, snippet = ""): Omit<PersonCandidate, "source" | "confidence"> | null {
  // A title and a snippet are lines. The patterns below are written for lines: only a line's worth of each is read.
  title = String(title ?? "").slice(0, MAX_TITLE_READ);
  snippet = String(snippet ?? "").slice(0, MAX_SNIPPET_READ);
  let t = title.replace(/\s*[|–-]\s*LinkedIn\s*$/i, "").replace(/\s+on LinkedIn:?.*$/i, "").trim();
  const parts = t.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const name = parts[0];
  if (!/^[A-Za-z][A-Za-z'.\- ]{1,60}$/.test(name) || name.split(" ").length > 5) return null;
  let personTitle: string | undefined;
  let companyName: string | undefined;
  let location: string | undefined;
  if (parts.length >= 3) {
    personTitle = parts[1];
    companyName = parts[2];
  } else if (parts.length === 2) {
    // Could be "Name - Title at Company" or "Name - Company"
    const m = parts[1].match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (m) {
      personTitle = m[1];
      companyName = m[2];
    } else personTitle = parts[1];
  }
  // Snippet often has "Location · Title at Company" or "Experience: Company · Location: City"
  const locM = snippet.match(/Location:\s*([^·\n]+)/i) ?? snippet.match(/^([A-Z][A-Za-z .,]+(?:India|USA|United States|UK|United Kingdom|Canada|Australia|Singapore|Germany|France|UAE)[^·\n]*)/);
  if (locM) location = locM[1].trim();
  if (!personTitle) {
    const tm = snippet.match(/(?:^|·)\s*([A-Z][^·\n]{3,80}?)\s+(?:at|@)\s+([A-Z][^·\n]{1,60})/);
    if (tm) {
      personTitle = tm[1].trim();
      companyName = companyName ?? tm[2].trim();
    }
  }
  const nm = splitName(name);
  return { ...nm, title: personTitle, companyName: companyName?.replace(/\.$/, ""), location };
}

export function extractPeopleFromResults(results: SearchResult[]): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const li = normalizeLinkedinUrl(r.url);
    if (!li || !li.includes("/in/")) continue;
    if (seen.has(li)) continue;
    const parsed = parseLinkedinTitle(r.title, r.snippet);
    if (!parsed) continue;
    seen.add(li);
    out.push({ ...parsed, linkedinUrl: li, snippet: r.snippet, source: `search:${r.provider}`, confidence: parsed.title && parsed.companyName ? 0.8 : 0.55 });
  }
  return out;
}

export interface PeopleSearchInput {
  titles?: string[];
  keywords?: string[];
  locations?: string[];
  companyName?: string;
  companyDomain?: string;
  industries?: string[];
  limit?: number;
  country?: string;
}

/** Build one or more search queries targeting LinkedIn profiles. */
export function buildPeopleQueries(input: PeopleSearchInput): string[] {
  const titleGroups = (input.titles?.length ? input.titles : [""]).map((t) => (t ? `"${t}"` : ""));
  const loc = input.locations?.length ? input.locations.map((l) => `"${l}"`).join(" OR ") : "";
  const ind = input.industries?.length ? input.industries.slice(0, 3).map((i) => `"${i}"`).join(" OR ") : "";
  const kw = input.keywords?.length ? input.keywords.slice(0, 4).join(" ") : "";
  const comp = input.companyName ? `"${input.companyName}"` : "";
  const queries: string[] = [];
  for (const t of titleGroups) {
    const q = [`site:linkedin.com/in`, t, comp, loc && `(${loc})`, ind && `(${ind})`, kw].filter(Boolean).join(" ");
    queries.push(q.trim());
  }
  return queries;
}

/** What the web searches behind a discovery call did, for telling "nobody" from "could not ask". */
export interface DiscoverySearchTrace {
  /** One per web search fired. */
  searches: WebSearchOutcome[];
  /** Searches in which no provider answered. */
  failedSearches: number;
  /** True when at least one search ran and none got an answer from any provider. */
  everySearchFailed: boolean;
  /** One operator-readable sentence when everySearchFailed, else null. */
  failureMessage: string | null;
}

export function traceFromOutcomes(searches: WebSearchOutcome[]): DiscoverySearchTrace {
  const failureMessage = summarizeWebSearchFailures(searches);
  return { searches, failedSearches: searches.filter((o) => o.everyProviderFailed).length, everySearchFailed: failureMessage !== null, failureMessage };
}

/** findPeople, plus what its web searches did. */
export async function findPeopleDetailed(input: PeopleSearchInput, searchOpts: WebSearchOptions = {}): Promise<{ people: PersonCandidate[] } & DiscoverySearchTrace> {
  const outcomes: WebSearchOutcome[] = [];
  const outer = searchOpts.onOutcome;
  const people = await findPeople(input, {
    ...searchOpts,
    onOutcome: (o, q) => {
      outcomes.push(o);
      outer?.(o, q);
    },
  });
  return { people, ...traceFromOutcomes(outcomes) };
}

export async function findPeople(input: PeopleSearchInput, searchOpts: WebSearchOptions = {}): Promise<PersonCandidate[]> {
  const limit = input.limit ?? 25;
  const queries = buildPeopleQueries(input);
  const found: PersonCandidate[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    for (let offset = 0; offset < 40 && found.length < limit; offset += 20) {
      const results = await webSearch(q, { count: 20, offset, country: input.country, ...searchOpts });
      if (results.length === 0) break;
      for (const p of extractPeopleFromResults(results)) {
        if (seen.has(p.linkedinUrl!)) continue;
        seen.add(p.linkedinUrl!);
        found.push(p);
        if (found.length >= limit) break;
      }
      if (results.length < 10) break;
    }
    if (found.length >= limit) break;
  }
  return found.slice(0, limit);
}
