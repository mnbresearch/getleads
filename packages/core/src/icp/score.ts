import type { AiProvider, ScoredLead } from "../types.js";
import { completeJson, hasAi } from "../ai/provider.js";
import { UNTRUSTED_RULE, fence, fenceBlock, oneLine, plainString, stringList } from "../ai/untrusted.js";
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

/**
 * What a single criterion came to.
 *
 * `null` means the ICP does not ask about this, so it is not part of the question and is
 * left out of the denominator entirely. `"unknown"` means the ICP DOES ask and we have no
 * data - a different thing, and the one this scorer used to conflate with the first.
 */
export type CriterionVerdict = true | false | "unknown" | null;

/**
 * How much of a criterion's weight an unknown earns.
 *
 * Not zero, because a missing field is not evidence of a bad fit; not full, because it is
 * not evidence of a good one either. Sitting between the two is what stops a lead we know
 * nothing about from outranking one we have checked.
 */
const UNKNOWN_CREDIT = 0.35;

const has = (hay: string | null | undefined, needles?: string[]): CriterionVerdict => {
  if (!needles?.length) return null;
  if (!hay || !hay.trim()) return "unknown";
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

/**
 * Deterministic rule-based ICP fit score (0..100). Fast, free, explainable.
 *
 * The denominator used to skip any criterion the LEAD had no data for, not just the ones
 * the ICP did not ask about. A lead whose industry was unknown was scored out of 30 and
 * came back at 100; an otherwise identical lead whose industry was known and wrong was
 * scored out of 50 and came back at 60. Missing data therefore outranked checked data, and
 * the top of every list filled with the records we knew least about - the exact opposite of
 * what a fit score is for.
 *
 * A criterion the ICP asks about now always counts toward the denominator. An unknown earns
 * partial credit rather than a zero, because absence is not evidence of a bad fit, and the
 * result carries `coverage` so a thinly-evidenced score can be told from a well-evidenced
 * one at a glance.
 */
export function scoreLeadRules(lead: LeadForScoring, icp: IcpCriteria): ScoredLead {
  let score = 0;
  let max = 0;
  let known = 0;
  const reasons: string[] = [];
  const unknownCriteria: string[] = [];
  const mismatches: string[] = [];
  const add = (weight: number, ok: CriterionVerdict, label: string) => {
    // The ICP does not ask about this. Not part of the question, so not part of the answer.
    if (ok === null) return;
    max += weight;
    if (ok === "unknown") {
      score += weight * UNKNOWN_CREDIT;
      unknownCriteria.push(label);
      reasons.push(`? ${label} - no data`);
      return;
    }
    known += weight;
    if (ok) {
      score += weight;
      reasons.push(`+ ${label}`);
    } else {
      reasons.push(`- ${label}`);
      mismatches.push(label);
    }
  };

  const titleVerdict: CriterionVerdict = !icp.titles?.length ? null : !lead.title ? "unknown" : titleMatch(lead.title, icp.titles);
  add(30, titleVerdict, "title match");

  const sen = inferSeniority(lead.title ?? undefined);
  add(15, !icp.seniorities?.length ? null : !lead.title ? "unknown" : sen ? icp.seniorities.includes(sen) : false, `seniority ${sen ?? "unknown"}`);

  const dept = inferDepartment(lead.title ?? undefined);
  add(10, !icp.departments?.length ? null : !lead.title ? "unknown" : dept ? icp.departments.includes(dept) : false, `department ${dept ?? "unknown"}`);

  add(20, has(`${lead.company?.industry ?? ""} ${lead.company?.description ?? ""}`, icp.industries), "industry match");
  add(10, !icp.companySizes?.length ? null : !lead.company?.size ? "unknown" : icp.companySizes.includes(lead.company.size), "company size");
  add(10, has(`${lead.location ?? ""} ${lead.company?.location ?? ""} ${lead.country ?? ""} ${lead.company?.country ?? ""}`, [...(icp.locations ?? []), ...(icp.countries ?? [])]), "location match");
  add(10, has(`${lead.title ?? ""} ${lead.company?.description ?? ""}`, icp.keywords), "keyword match");
  add(
    5,
    !icp.techStack?.length ? null : !lead.company?.techStack?.length ? "unknown" : lead.company.techStack.some((t) => icp.techStack!.map((x) => x.toLowerCase()).includes(t.toLowerCase())),
    "tech stack",
  );

  // An exclusion only fires on text we actually have; "unknown" must never exclude.
  const excluded = has(`${lead.title ?? ""} ${lead.company?.description ?? ""}`, icp.excludeKeywords);
  if (excluded === true) {
    reasons.push("- excluded keyword");
    return { score: 0, reasons, coverage: 1, unknownCriteria: [], mismatches: [...mismatches, "excluded keyword"] };
  }

  // Email verification is a property of the lead, not of the ICP, so it is always asked.
  max += 5;
  if (lead.emailStatus === "valid") {
    score += 5;
    known += 5;
    reasons.push("+ verified email");
  } else if (lead.emailStatus && lead.emailStatus !== "unknown") {
    known += 5;
    reasons.push(`- email ${lead.emailStatus}`);
  } else {
    score += 5 * UNKNOWN_CREDIT;
    unknownCriteria.push("email status");
    reasons.push("? email not verified yet");
  }

  const pct = max === 0 ? 50 : Math.round((score / max) * 100);
  return { score: pct, reasons, coverage: max === 0 ? 0 : known / max, unknownCriteria, mismatches };
}

/** The only values the two enum-typed criteria may take, whatever a model returns. */
const SENIORITIES = ["c_level", "vp", "director", "manager", "senior", "individual", "entry"];
const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"];
/** Caps on model-written lists: a criteria object is stored and re-sent on every search. */
const LIST_CAP = 25;
const KEYWORD_CAP = 40;

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
  // Seed companies are crawled pages: name, description and industry are whatever the site
  // says about itself, so each seed is one fenced line.
  const seeds = (input.seedCompanies ?? [])
    .slice(0, 10)
    .map((c, i) => fence(`seed_company_${i + 1}`, `${c.name ?? c.domain} (${c.domain}): ${c.industry ?? ""} ${c.description ?? ""}`, 500))
    .join("\n");
  const res = await completeJson<Record<string, unknown>>(ai, [
    {
      role: "system",
      content:
        "You are a B2B sales strategist. Produce an Ideal Customer Profile as strict JSON with keys: summary, industries[], titles[], seniorities[] (values from: c_level, vp, director, manager, senior, individual, entry), companySizes[] (values from: 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5000+), locations[], keywords[], excludeKeywords[], searchQueries[] (5 web search queries that would find matching decision makers on LinkedIn). Be concrete; titles should be real job titles. " +
        UNTRUSTED_RULE,
    },
    {
      role: "user",
      content: `Product/offer: ${oneLine(input.product ?? "not specified", 1000) || "not specified"}\nDescription of best customers: ${oneLine(input.description ?? "not specified", 2000) || "not specified"}\nExample best customers:\n${seeds || "none"}\nReturn JSON only.`,
    },
  ]);
  if (!res || typeof res !== "object") return null;
  return {
    summary: plainString(res.summary, 1000),
    industries: stringList(res.industries, LIST_CAP),
    titles: stringList(res.titles, LIST_CAP),
    seniorities: stringList(res.seniorities, LIST_CAP).filter((v) => SENIORITIES.includes(v)),
    companySizes: stringList(res.companySizes, LIST_CAP).filter((v) => COMPANY_SIZES.includes(v)),
    locations: stringList(res.locations, LIST_CAP),
    keywords: stringList(res.keywords, KEYWORD_CAP),
    excludeKeywords: stringList(res.excludeKeywords, KEYWORD_CAP),
    searchQueries: stringList(res.searchQueries, 10, 200),
  };
}

/** AI second-opinion on fit for a single lead (used for top-N re-ranking). */
export async function scoreLeadWithAi(ai: AiProvider, lead: LeadForScoring & { fullName?: string | null }, icpSummary: string): Promise<ScoredLead | null> {
  if (!hasAi(ai)) return null;
  const res = await completeJson<{ score?: unknown; reasons?: unknown }>(ai, [
    {
      role: "system",
      content: `Score how well the lead described in the lead_* blocks fits the Ideal Customer Profile in the icp block. ${UNTRUSTED_RULE} Reply with JSON {score: 0-100, reasons: string[] (max 3, short)}.`,
    },
    {
      role: "user",
      content: [
        fence("icp", icpSummary, 1500),
        fence("lead_name", lead.fullName ?? "", 160),
        fence("lead_title", lead.title ?? "unknown title", 200),
        fence("lead_company", lead.company?.name ?? "unknown company", 200),
        fence("lead_company_facts", `${lead.company?.industry ?? ""}; ${lead.company?.size ?? ""}; ${lead.company?.location ?? lead.location ?? ""}`, 300),
        fence("lead_company_description", lead.company?.description ?? "", 600),
        "Return JSON only.",
      ].join("\n"),
    },
  ], { maxTokens: 200, temperature: 0.1 });
  if (!res || typeof res.score !== "number" || !Number.isFinite(res.score)) return null;
  // Reasons are shown in the lead list: strings only, three at most, short.
  return { score: Math.max(0, Math.min(100, Math.round(res.score))), reasons: stringList(res.reasons, 3, 160) };
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
  const history = (Array.isArray(input.history) ? input.history : [])
    .slice(-20)
    .map((h) => `${h.role === "assistant" ? "assistant" : "user"}: ${oneLine(h.content, 2000)}`)
    .join("\n");
  const res = await completeJson<{ reply?: unknown; criteria?: unknown }>(
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
          "new list for it (it replaces the old one, it does not merge). " +
          UNTRUSTED_RULE,
      },
      {
        role: "user",
        // The stored criteria and summary may have been written by a model from crawled
        // pages, so they are data. The conversation is the user's own.
        content: `${fenceBlock("current_criteria", JSON.stringify(input.criteria ?? {}), 6000)}\n${
          input.summary ? `${fence("current_summary", input.summary, 1500)}\n` : ""
        }Conversation so far:\n${history}\nuser: ${oneLine(input.message, 4000)}\n\nReturn JSON only.`,
      },
    ],
    { maxTokens: 500, temperature: 0.4 },
  );
  const reply = plainString(res?.reply, 2000);
  if (!res || !reply) return null;
  const proposed = res.criteria && typeof res.criteria === "object" && !Array.isArray(res.criteria) ? (res.criteria as Record<string, unknown>) : {};
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
    // Own keys only, arrays only, strings only: "titles": "CEO" or a nested object is not a
    // list and is ignored rather than coerced.
    if (!Object.prototype.hasOwnProperty.call(proposed, k) || !Array.isArray(proposed[k])) continue;
    let v = stringList(proposed[k], k === "keywords" || k === "excludeKeywords" || k === "techStack" ? KEYWORD_CAP : LIST_CAP);
    if (k === "seniorities") v = v.filter((x) => SENIORITIES.includes(x));
    if (k === "companySizes") v = v.filter((x) => COMPANY_SIZES.includes(x));
    patch[k] = v;
  }
  return { reply, criteria: { ...input.criteria, ...patch } };
}
