// Placeholder implementations so dependants compile while the engines are being written.
// Every function here is replaced by its real module (see plays/*.ts).
import type { IcpCriteria } from "../icp/score.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding, PlayRunTrace } from "./types.js";
export * from "./types.js";

export type AskSource = "linkedin" | "reddit" | "hackernews" | "x" | "forums";
export type Engagement = "reacted" | "commented" | "reposted" | "followed" | "signed_up" | "attended" | "other";
export interface EngagerRow { fullName?: string; firstName?: string; lastName?: string; title?: string; companyName?: string; companyDomain?: string; linkedinUrl?: string; email?: string; location?: string; note?: string }
export interface PlayPlan {
  product: { domain: string; name?: string; description?: string };
  icp: IcpCriteria;
  titles: string[];
  competitors: { name: string; domain?: string; source: "saved" | "site" | "ai" }[];
  plays: { type: string; name: string; config: Record<string, unknown>; targetTitles: string[]; why: string }[];
  trace: PlayRunTrace;
}
const todo = (): never => { throw new Error("not implemented yet"); };
export const emptyTrace = (): PlayRunTrace => ({ searches: 0, failedSearches: 0, pagesFetched: 0, pagesRefused: 0, aiCalls: 0, notes: [], blocked: false });
export function mergeTrace(_a: PlayRunTrace, _b: PlayRunTrace): PlayRunTrace { return todo(); }
export function playDedupeKey(_f: PlayFinding): string { return todo(); }
export function mailSafeReason(_text: string): string { return todo(); }
export async function findCompetitorCustomers(_cfg: { competitors: { name: string; domain?: string }[]; maxPerCompetitor?: number }, _opts?: PlayEngineOptions): Promise<PlayEngineResult> { return todo(); }
export async function findHiringCompanies(_cfg: { roles: string[]; keywords?: string[]; locations?: string[]; companyDomains?: string[] }, _opts?: PlayEngineOptions): Promise<PlayEngineResult> { return todo(); }
export async function findFundedCompanies(_cfg: { keywords?: string[]; industries?: string[]; locations?: string[]; days?: number; minAmountUsd?: number }, _opts?: PlayEngineOptions): Promise<PlayEngineResult> { return todo(); }
export async function findPublicAsks(_cfg: { competitors?: string[]; problems?: string[]; category?: string; sources?: AskSource[]; days?: number }, _opts?: PlayEngineOptions): Promise<PlayEngineResult> { return todo(); }
export async function findPeopleForFinding(_finding: PlayFinding, _cfg: { titles: string[]; limit?: number }, _opts?: PlayEngineOptions): Promise<{ people: PlayFinding[]; trace: PlayRunTrace }> { return todo(); }
export function engagersFromRows(_rows: EngagerRow[], _ctx: { engagement: Engagement; postUrl?: string; postTitle?: string; postAuthor?: string; when?: Date }): { findings: PlayFinding[]; rejected: { row: number; reason: string }[] } { return todo(); }
export async function planPlays(_input: { website: string; knownCompetitors?: { name: string; domain?: string }[] }, _opts?: PlayEngineOptions): Promise<PlayPlan> { return todo(); }
