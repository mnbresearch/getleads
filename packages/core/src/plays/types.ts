import type { AiProvider } from "../types.js";
import type { WebSearchOptions } from "../search/index.js";

/**
 * Plays: recipes that find the people who need a product now, from one source of intent.
 * An engine returns findings; each finding carries the one-sentence reason it is relevant
 * and the page that shows it. The reason is built from a template filled with extracted
 * facts - never written freely by a model - so it can be shown to a reviewer as it is.
 */
export type PlayFindingKind = "person" | "company" | "post";

export interface PlayFinding {
  kind: PlayFindingKind;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedinUrl?: string;
  email?: string;
  location?: string;
  companyName?: string;
  companyDomain?: string;
  /** One plain sentence, at most 300 characters, no URLs, no line breaks. */
  relevantBecause: string;
  /** Absolute http(s) URL of the page that shows it, at most 2000 characters. */
  evidenceUrl?: string;
  evidenceTitle?: string;
  /** Verbatim from the evidence, at most 500 characters. */
  evidenceQuote?: string;
  /** competitor_customer | job_posting | funding | public_ask | public_complaint | site_visit | job_change | post_engagement */
  signalType: string;
  signalAt?: Date;
  /** 0..1 */
  confidence: number;
}

export interface PlayRunTrace {
  searches: number;
  failedSearches: number;
  pagesFetched: number;
  pagesRefused: number;
  aiCalls: number;
  /** Plain sentences for the person reading the run result. */
  notes: string[];
  /** True when nothing could be looked at (no search source answered, every page refused). */
  blocked: boolean;
  blockedReason?: string;
}

export interface PlayEngineResult {
  findings: PlayFinding[];
  trace: PlayRunTrace;
}

export interface PlayEngineOptions {
  /** Absent, or the "none" provider: rules only. */
  ai?: AiProvider;
  /** Called before each model call; resolve false to stop using AI for the rest of the run. */
  beforeAiCall?: () => Promise<boolean>;
  searchOpts?: WebSearchOptions;
  country?: string;
  /** Maximum findings. Default 40, hard maximum 200. */
  limit?: number;
  /** Epoch milliseconds. No new work is started after this; what was found is returned. */
  deadlineAt?: number;
  /** Tests only. */
  allowPrivateHosts?: boolean;
}
