import type { AiProvider, ScoredLead } from "../types.js";
import { completeJson, hasAi } from "../ai/provider.js";
import { inferDepartment, inferSeniority } from "../util/names.js";

export interface IcpCriteria {
  industries?: string[];
  titles?: string[];
  seniorities?: string[];
  departments?: string[];
  companySizes?: string[];
  locations?: string[];
  countries?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  techStack?: string[];
}

export interface LeadForScoring {
  title?: string | null;
  location?: string | null;
  country?: string | null;
  emailStatus?: string | null;
  company?: {
    name?: string | null;
    industry?: string | null;
    size?: string | null;
    location?: string | null;
    country?: string | null;
    description?: string | null;
    techStack?: string[] | null;
  } | null;
}

const has = (hay: string | null | undefined, needles?: string[]) => {
  if (!hay || !needles?.length) return null;
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
};

const STOP = new Set(["of", "the", "and", "&", "at", "for", "in", "-", "|"]);
const SYNONYMS: Record<string, string> = { "vice president": "vp", "chief executive officer": "ceo", "chief technology officer": "cto", "chief marketing officer": "cmo", "chief financial officer": "cfo", "co-founder": "founder", cofounder: "founder", "business development": "bd", "sr.": "senior", "sr": "senior" };

function tokens(s: string) {
  let t = s.toLowerCase();
  for (const [k, v] of Object.entries(SYNONYMS)) t = t.replaceAll(k, v);
  return t.split(/[^a-z0-9.+#]+/).filter((w) => w && !STOP.has(w));
}

/** Token-based title match: every token of any wanted title appears in the lead title. */
export function titleMatch(title: string | null | undefined, wanted?: string[]) {
  if (!title || !wanted?.length) return null;
  const have = new Set(tokens(title));
  return wanted.some((w) => {
    const need = tokens(w);
    return need.length > 0 && need.every((n) => have.has(n));
  });
}

/** Deterministic rule-based ICP fit score (0..100). Fast, free, explainable. */
export function scoreLeadRules(lead: LeadForScoring, icp: IcpCriteria): ScoredLead {
  let score = 0;
  let max = 0;
  const reasons: string[] = [];
  const add = (weight: number, ok: boolean | null, label: string) => {
    if (ok === null) return;
    max += weight;
    if (ok) {
      score += weight;
      reasons.push(`+ ${label}`);
    } else reasons.push(`- ${label}`);
  };

  add(30, titleMatch(lead.title, icp.titles), "title match");
  const sen = inferSeniority(lead.title ?? undefined);
  add(15, icp.seniorities?.length ? (sen ? icp.seniorities.includes(sen) : false) : null, `seniority ${sen ?? "unknown"}`);
  const dept = inferDepartment(lead.title ?? undefined);
  add(10, icp.departments?.length ? (dept ? icp.departments.includes(dept) : false) : null, `department ${dept ?? "unknown"}`);
  add(20, has(`${lead.company?.industry ?? ""} ${lead.company?.description ?? ""}`, icp.industries), "industry match");
  add(10, icp.companySizes?.length ? (lead.company?.size ? icp.companySizes.includes(lead.company.size) : false) : null, "company size");
  add(10, has(`${lead.location ?? ""} ${lead.company?.location ?? ""} ${lead.country ?? ""} ${lead.company?.country ?? ""}`, [...(icp.locations ?? []), ...(icp.countries ?? [])]), "location match");
  add(10, has(`${lead.title ?? ""} ${lead.company?.description ?? ""}`, icp.keywords), "keyword match");
  add(5, icp.techStack?.length ? (lead.company?.techStack ?? []).some((t) => icp.techStack!.map((x) => x.toLowerCase()).includes(t.toLowerCase())) : null, "tech stack");
  const excluded = has(`${lead.title ?? ""} ${lead.company?.description ?? ""}`, icp.excludeKeywords);
  if (excluded) {
    reasons.push("- excluded keyword");
    return { score: 0, reasons };
  }
  if (lead.emailStatus === "valid") {
    score += 5;
    max += 5;
    reasons.push("+ verified email");
  } else if (lead.emailStatus) max += 5;

  const pct = max === 0 ? 50 : Math.round((score / max) * 100);
  return { score: pct, reasons };
}

export interface AiLookalikeProfile {
  summary: string;
  industries: string[];
  titles: string[];
  seniorities: string[];
  companySizes: string[];
  locations: string[];
  keywords: string[];
  excludeKeywords: string[];
  searchQueries: string[];
}

/**
 * Build an ICP from a plain-language description and/or seed customer companies.
 * Uses whichever AI provider is configured (Groq/Gemini are free).
 */
export async function buildIcpWithAi(
  ai: AiProvider,
  input: { description?: string; seedCompanies?: { domain: string; name?: string; description?: string; industry?: string }[]; product?: string },
): Promise<AiLookalikeProfile | null> {
  if (!hasAi(ai)) return null;
  const seeds = (input.seedCompanies ?? []).map((c) => `- ${c.name ?? c.domain} (${c.domain}): ${c.industry ?? ""} ${c.description ?? ""}`).join("\n");
  const res = await completeJson<AiLookalikeProfile>(ai, [
    {
      role: "system",
      content:
        "You are a B2B sales strategist. Produce an Ideal Customer Profile as strict JSON with keys: summary, industries[], titles[], seniorities[] (values from: c_level, vp, director, manager, senior, individual, entry), companySizes[] (values from: 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5000+), locations[], keywords[], excludeKeywords[], searchQueries[] (5 web search queries that would find matching decision makers on LinkedIn). Be concrete; titles should be real job titles.",
    },
    {
      role: "user",
      content: `Product/offer: ${input.product ?? "not specified"}\nDescription of best customers: ${input.description ?? "not specified"}\nExample best customers:\n${seeds || "none"}\nReturn JSON only.`,
    },
  ]);
  if (!res) return null;
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  return {
    summary: String(res.summary ?? ""),
    industries: arr(res.industries),
    titles: arr(res.titles),
    seniorities: arr(res.seniorities),
    companySizes: arr(res.companySizes),
    locations: arr(res.locations),
    keywords: arr(res.keywords),
    excludeKeywords: arr(res.excludeKeywords),
    searchQueries: arr(res.searchQueries),
  };
}

/** AI second-opinion on fit for a single lead (used for top-N re-ranking). */
export async function scoreLeadWithAi(ai: AiProvider, lead: LeadForScoring & { fullName?: string | null }, icpSummary: string): Promise<ScoredLead | null> {
  if (!hasAi(ai)) return null;
  const res = await completeJson<{ score: number; reasons: string[] }>(ai, [
    { role: "system", content: "Score how well a lead fits an Ideal Customer Profile. Reply with JSON {score: 0-100, reasons: string[] (max 3, short)}." },
    {
      role: "user",
      content: `ICP: ${icpSummary}\nLead: ${lead.fullName ?? ""}, ${lead.title ?? "unknown title"} at ${lead.company?.name ?? "unknown company"} (${lead.company?.industry ?? ""}; ${lead.company?.size ?? ""}; ${lead.company?.location ?? lead.location ?? ""}). Company: ${lead.company?.description ?? ""}`,
    },
  ], { maxTokens: 200, temperature: 0.1 });
  if (!res || typeof res.score !== "number") return null;
  return { score: Math.max(0, Math.min(100, Math.round(res.score))), reasons: (res.reasons ?? []).map(String) };
}

export interface IcpChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Conversational ICP refinement: the user chats about who they want to target, and the
 * assistant proposes an updated criteria object alongside a natural-language reply. Only
 * fields the assistant chooses to change are patched onto the existing criteria.
 */
export async function refineIcpWithAi(
  ai: AiProvider,
  input: { criteria: IcpCriteria; summary?: string; history: IcpChatMessage[]; message: string },
): Promise<{ reply: string; criteria: IcpCriteria } | null> {
  if (!hasAi(ai)) return null;
  const res = await completeJson<{ reply: string; criteria: Partial<IcpCriteria> }>(
    ai,
    [
      {
        role: "system",
        content:
          "You are a B2B sales strategist helping someone refine their Ideal Customer Profile (ICP) through " +
          "conversation. Ask clarifying questions when useful, and propose concrete updates to their targeting " +
          "criteria as you go. Reply with strict JSON " +
          '{"reply": string, "criteria": {"industries"?: string[], "titles"?: string[], "seniorities"?: string[], ' +
          '"departments"?: string[], "companySizes"?: string[], "locations"?: string[], "countries"?: string[], ' +
          '"keywords"?: string[], "excludeKeywords"?: string[], "techStack"?: string[]}}. ' +
          '"reply" is your conversational response (1-4 sentences). Only include a key in "criteria" if it should ' +
          "change based on this message - omit keys that should stay as-is. When you include a key, give the FULL " +
          "new list for it (it replaces the old one, it does not merge).",
      },
      {
        role: "user",
        content: `Current criteria: ${JSON.stringify(input.criteria)}\n${
          input.summary ? `Current summary: ${input.summary}\n` : ""
        }Conversation so far:\n${input.history
          .slice(-20)
          .map((h) => `${h.role}: ${h.content}`)
          .join("\n")}\nuser: ${input.message}\n\nReturn JSON only.`,
      },
    ],
    { maxTokens: 500, temperature: 0.4 },
  );
  if (!res?.reply) return null;
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : undefined);
  const patch: Partial<IcpCriteria> = {};
  for (const k of [
    "industries",
    "titles",
    "seniorities",
    "departments",
    "companySizes",
    "locations",
    "countries",
    "keywords",
    "excludeKeywords",
    "techStack",
  ] as const) {
    const v = arr((res.criteria as Record<string, unknown> | undefined)?.[k]);
    if (v) (patch as Record<string, unknown>)[k] = v;
  }
  return { reply: String(res.reply), criteria: { ...input.criteria, ...patch } };
}
