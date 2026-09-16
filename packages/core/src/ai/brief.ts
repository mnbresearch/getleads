import type { AiProvider } from "../types.js";
import { completeJson, hasAi } from "./provider.js";

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

  const facts = [
    `Name: ${company.name || company.domain}`,
    `Domain: ${company.domain}`,
    company.industry ? `Industry: ${company.industry}` : null,
    company.size ? `Size: ${company.size}` : null,
    company.headcount ? `Headcount: ${company.headcount}` : null,
    company.location ? `Location: ${company.location}` : null,
    company.techStack?.length ? `Tech stack: ${company.techStack.slice(0, 15).join(", ")}` : null,
    company.fundingTotalUsd ? `Total funding: $${Math.round(company.fundingTotalUsd).toLocaleString()}` : null,
    company.lastFundingRound ? `Last funding round: ${company.lastFundingRound}` : null,
    company.openRoles ? `Open roles: ${company.openRoles}` : null,
    company.description ? `Description: ${company.description.slice(0, 600)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sig = signals
    .slice(0, 8)
    .map((s) => {
      const when = s.occurredAt ? ` (${new Date(s.occurredAt).toISOString().slice(0, 10)})` : "";
      return `- [${s.type}]${when} ${s.title}${s.summary ? `: ${s.summary}` : ""}`;
    })
    .join("\n");

  const res = await completeJson<{ summary: string; whyNow: string; angles: string[] }>(
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
          "2-4 short, specific talking points/angles a rep could open with. Never invent facts not given below.",
      },
      {
        role: "user",
        content: `Company facts:\n${facts}\n\nRecent signals:\n${sig || "none available"}\n\nReturn JSON only.`,
      },
    ],
    { maxTokens: 450, temperature: 0.3 },
  );
  if (!res) return null;
  return {
    summary: String(res.summary ?? "").trim(),
    whyNow: String(res.whyNow ?? "").trim(),
    angles: Array.isArray(res.angles) ? res.angles.map(String).filter(Boolean).slice(0, 5) : [],
  };
}
