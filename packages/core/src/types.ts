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
