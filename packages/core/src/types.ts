export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: string;
}

export interface PersonCandidate {
  firstName?: string;
  lastName?: string;
  fullName: string;
  title?: string;
  companyName?: string;
  linkedinUrl?: string;
  location?: string;
  snippet?: string;
  source: string;
  confidence: number;
}

export interface CompanyCandidate {
  name?: string;
  domain: string;
  website?: string;
  description?: string;
  linkedinUrl?: string;
  snippet?: string;
  source: string;
}

export interface CompanyProfile {
  domain: string;
  name?: string;
  description?: string;
  industry?: string;
  size?: string;
  location?: string;
  country?: string;
  foundedYear?: number;
  linkedinUrl?: string;
  techStack: string[];
  emailsFound: string[];
  peopleFound: PersonCandidate[];
  socials: Record<string, string>;
  emailPattern?: string;
  mxValid?: boolean;
  catchAll?: boolean;
  /** How many pages were requested, and how many actually came back. */
  pagesAttempted?: number;
  pagesFetched?: number;
  /**
   * True when NOT ONE page could be fetched.
   *
   * A crawl that fetched nothing used to return exactly the same well-formed profile as a
   * company whose site genuinely has no team page, no emails and no detectable stack:
   * empty arrays all round. Callers wrote that profile to the database and stamped
   * `enrichedAt`, so a DNS hiccup or a firewall could mark a company "enriched with nothing
   * found" and keep it that way for the full thirty-day re-enrichment window. The empty
   * result has to be distinguishable from the failure, or the failure becomes the record.
   */
  crawlFailed?: boolean;
  /** True when https reached nothing and the crawl fell back to plain http. */
  insecureFallback?: boolean;
  /** Set when the target was refused before any request, e.g. a private or loopback address. */
  crawlRefused?: string;
}

export type EmailStatus = "valid" | "risky" | "invalid" | "catch_all" | "unknown";

export interface EmailVerification {
  email: string;
  status: EmailStatus;
  confidence: number; // 0..1
  checks: {
    syntax: boolean;
    disposable: boolean;
    roleAccount: boolean;
    freeProvider: boolean;
    mx: boolean | null;
    smtp: "accepted" | "rejected" | "catch_all" | "blocked" | "skipped" | "error";
  };
  mxHost?: string;
  reason?: string;
}

export interface EmailFindResult {
  email?: string;
  status: EmailStatus;
  confidence: number;
  pattern?: string;
  candidates: { email: string; status: EmailStatus; confidence: number }[];
}

export interface LeadSearchQuery {
  /** Free-text description, e.g. "Heads of Growth at Series A fintech startups in Bangalore" */
  query?: string;
  titles?: string[];
  industries?: string[];
  locations?: string[];
  companySizes?: string[];
  keywords?: string[];
  companyDomains?: string[];
  limit?: number;
  /** Also attempt to find + verify work emails (slower). */
  findEmails?: boolean;
}

export interface ScoredLead {
  score: number; // 0..100
  reasons: string[];
  /**
   * 0..1. The share of the ICP's weight that was decided on data we actually have.
   *
   * A score of 90 built from one known field is not the same claim as a score of 90 built
   * from eight, and ranking treated them as identical. Optional so every existing caller
   * keeps working; present on every rule-based score.
   */
  coverage?: number;
  /** Criteria the ICP asks about that this lead has no data for. */
  unknownCriteria?: string[];
  /**
   * Criteria the ICP asks about that this lead is KNOWN to fail - the data is there and it
   * says no. Distinct from `unknownCriteria`, and from a low score: a lead can clear a score
   * threshold on its title alone while sitting in the wrong industry entirely, and anything
   * deciding which of several ICPs a lead belongs to needs to see that.
   */
  mismatches?: string[];
}

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiProvider {
  name: string;
  model: string;
  complete(messages: AiMessage[], opts?: { maxTokens?: number; temperature?: number; json?: boolean }): Promise<string>;
}
