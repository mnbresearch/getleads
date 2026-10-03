import type { AiProvider } from "../types.js";
import { completeJson, hasAi } from "./provider.js";
import { UNTRUSTED_RULE, fence, plainString, stringList } from "./untrusted.js";

export interface AccountBrief {
  summary: string;
  whyNow: string;
  angles: string[];
}

export interface BriefCompanyInput {
  name?: string | null;
  domain: string;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  description?: string | null;
  techStack?: string[];
  headcount?: number | null;
  fundingTotalUsd?: number | null;
  lastFundingRound?: string | null;
  openRoles?: number | null;
}

export interface BriefSignalInput {
  type: string;
  title: string;
  summary?: string | null;
  occurredAt?: Date | string | null;
}

/** Short, concrete "why reach out now" brief for a company, grounded only in given facts. */
export async function generateAccountBrief(
  ai: AiProvider,
  company: BriefCompanyInput,
  signals: BriefSignalInput[] = [],
): Promise<AccountBrief | null> {
  if (!hasAi(ai)) return null;

  // Every field here was scraped or imported: a page description, a search snippet, a news
  // headline. Each one is fenced, so none of it can pose as part of the instructions.
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
  const facts = [
    fence("name", company.name || company.domain, 160),
    fence("domain", company.domain, 160),
    company.industry ? fence("industry", company.industry, 160) : null,
    company.size ? fence("size", company.size, 60) : null,
    num(company.headcount) ? `Headcount: ${Math.round(num(company.headcount)!)}` : null,
    company.location ? fence("location", company.location, 160) : null,
    company.techStack?.length ? fence("tech_stack", company.techStack.slice(0, 15).map((t) => String(t)).join(", "), 400) : null,
    num(company.fundingTotalUsd) ? `Total funding: $${Math.round(num(company.fundingTotalUsd)!).toLocaleString()}` : null,
    company.lastFundingRound ? fence("last_funding_round", company.lastFundingRound, 80) : null,
    num(company.openRoles) ? `Open roles: ${Math.round(num(company.openRoles)!)}` : null,
    company.description ? fence("description", company.description, 600) : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sig = signals
    .slice(0, 8)
    .map((s, i) => {
      const d = s.occurredAt ? new Date(s.occurredAt) : null;
      const when = d && !Number.isNaN(d.getTime()) ? ` (${d.toISOString().slice(0, 10)})` : "";
      return fence(`signal_${i + 1}`, `[${s.type}]${when} ${s.title}${s.summary ? `: ${s.summary}` : ""}`, 400);
    })
    .join("\n");

  const res = await completeJson<{ summary?: unknown; whyNow?: unknown; angles?: unknown }>(
    ai,
    [
      {
        role: "system",
        content:
          'You write short, concrete account intelligence briefs for B2B sales reps. Reply with strict JSON ' +
          '{"summary": string, "whyNow": string, "angles": string[]}. "summary" is 1-2 sentences on what the ' +
          'company does and who it is. "whyNow" is 1-2 sentences on why this is a good time to reach out - be ' +
          "concrete and grounded ONLY in the facts and signals given; if there isn't enough signal for real " +
          'urgency, say the account looks like a solid general fit instead of inventing urgency. "angles" is ' +
          "2-4 short, specific talking points/angles a rep could open with. Never invent facts not given below. " +
          "Plain text only. " +
          UNTRUSTED_RULE,
      },
      {
        role: "user",
        content: `Company facts:\n${facts}\n\nRecent signals:\n${sig || "none available"}\n\nReturn JSON only.`,
      },
    ],
    { maxTokens: 450, temperature: 0.3 },
  );
  if (!res || typeof res !== "object") return null;
  // Shape-checked: a field of the wrong type is dropped, never stringified ("[object Object]").
  const brief = {
    summary: plainString(res.summary, 600),
    whyNow: plainString(res.whyNow, 600),
    angles: stringList(res.angles, 5, 240),
  };
  // Nothing usable came back: say so, rather than returning an empty brief that looks like one.
  if (!brief.summary && !brief.whyNow && brief.angles.length === 0) return null;
  return brief;
}
