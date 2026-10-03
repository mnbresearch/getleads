import { z } from "zod";
import { stripNul } from "./sanitize.js";

/**
 * The shape of a lead-search query, in one place.
 *
 * POST /v1/search validated its body with this schema (limit <= 200, companyDomains <= 50,
 * ten titles ...). A saved search and an autopilot store the SAME query to run later - and
 * accepted it as `z.record(z.unknown())`. The scheduled job then spread whatever was stored
 * straight into the pipeline: `limit: 100000`, 10,000 company domains, 500 titles, plus
 * keys nobody had defined (`maxProviderLeads`, `verify`, `ai`). One saved search was an
 * unmetered crawl of ten thousand sites for the price of one search.
 *
 * So the stored query is validated with this schema when it is saved, and clamped with
 * `clampSearchQuery` again when it is run - the second because rows saved before this
 * existed are still in the table.
 */
const term = z.string().max(200);
export const SEARCH_LIMITS = { limit: 200, companyDomains: 50, list: 10, query: 500, term: 200 } as const;

export const searchQueryFields = {
  query: z.string().max(SEARCH_LIMITS.query).optional(),
  titles: z.array(term).max(SEARCH_LIMITS.list).optional(),
  industries: z.array(term).max(SEARCH_LIMITS.list).optional(),
  locations: z.array(term).max(SEARCH_LIMITS.list).optional(),
  companySizes: z.array(term).max(SEARCH_LIMITS.list).optional(),
  keywords: z.array(term).max(SEARCH_LIMITS.list).optional(),
  companyDomains: z.array(z.string().max(253)).max(SEARCH_LIMITS.companyDomains).optional(),
  limit: z.number().int().min(1).max(SEARCH_LIMITS.limit).default(25),
  findEmails: z.boolean().default(true),
  icpId: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
  country: z.string().length(2).optional(),
  /** Run this search for a client: its leads are delivered to that client. */
  clientId: z.string().uuid().optional(),
};

/** The body of POST /v1/search. Unknown keys are dropped (zod's default for objects). */
export const searchQuerySchema = z.object(searchQueryFields);
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * A query as STORED on a saved search or an autopilot.
 *
 * Same fields and the same ceilings; `limit` and `findEmails` carry no default here because
 * the job that runs the query supplies its own (an autopilot derives its limit from
 * dailyLeads), and a default written into the row would read as the customer's choice.
 * Unknown keys are stripped, which is what removes `maxProviderLeads`, `verify`, `ai` and
 * `allowPrivateHosts` from a stored query.
 */
export const storedSearchQuerySchema = z.object({
  ...searchQueryFields,
  limit: z.number().int().min(1).max(SEARCH_LIMITS.limit).optional(),
  findEmails: z.boolean().optional(),
});
export type StoredSearchQuery = z.infer<typeof storedSearchQuerySchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampList(v: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = stripNul(x).trim().slice(0, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

/**
 * Bring ANY stored query inside the limits, without throwing.
 *
 * For the jobs that run saved searches and autopilots: a row written before validation
 * existed must still run - a customer's nightly search must not start failing because of a
 * key we no longer accept - but it runs as the query the API would have accepted. Known
 * keys are kept and cut to size (limit <= 200, companyDomains <= 50, ten of each list,
 * strings capped); everything else is dropped. Never returns more than it was given.
 */
export function clampSearchQuery(q: unknown): StoredSearchQuery {
  const src = q && typeof q === "object" && !Array.isArray(q) ? (q as Record<string, unknown>) : {};
  const out: StoredSearchQuery = {};
  if (typeof src.query === "string" && src.query.trim()) out.query = stripNul(src.query).slice(0, SEARCH_LIMITS.query);
  for (const k of ["titles", "industries", "locations", "companySizes", "keywords"] as const) {
    const v = clampList(src[k], SEARCH_LIMITS.list, SEARCH_LIMITS.term);
    if (v) out[k] = v;
  }
  const domains = clampList(src.companyDomains, SEARCH_LIMITS.companyDomains, 253);
  if (domains) out.companyDomains = domains;
  const limit = Number(src.limit);
  if (Number.isFinite(limit) && limit >= 1) out.limit = Math.min(SEARCH_LIMITS.limit, Math.floor(limit));
  if (typeof src.findEmails === "boolean") out.findEmails = src.findEmails;
  for (const k of ["icpId", "listId", "clientId"] as const) {
    const v = src[k];
    if (typeof v === "string" && UUID_RE.test(v)) out[k] = v;
  }
  if (typeof src.country === "string" && /^[a-z]{2}$/i.test(src.country)) out.country = src.country;
  return out;
}
