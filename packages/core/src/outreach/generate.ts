import type { AiProvider } from "../types.js";
import { completeJson, hasAi } from "../ai/provider.js";
import { leadVars, renderTemplate } from "./template.js";

export interface OutreachInput {
  lead: Parameters<typeof leadVars>[0];
  sender: { name: string; company: string; title?: string; valueProp: string; signature?: string; tone?: "friendly" | "direct" | "formal" | "casual" };
  /** Optional base template; AI rewrites/personalizes around it. */
  subjectTemplate?: string;
  bodyTemplate?: string;
  /** Extra instructions (e.g. "mention their recent funding") */
  instructions?: string;
  stepNo?: number;
  previousSubject?: string;
  language?: string;
}

export interface OutreachResult {
  subject: string;
  body: string;
  personalized: boolean;
  provider: string;
}

/** Generate a personalized cold email. Falls back to template rendering if no AI provider. */
export async function generateOutreach(ai: AiProvider, input: OutreachInput): Promise<OutreachResult> {
  const vars = leadVars(input.lead, { name: input.sender.name, company: input.sender.company, signature: input.sender.signature });
  const fallbackSubject = renderTemplate(input.subjectTemplate ?? "Quick question, {{first_name | fallback:\"there\"}}", vars);
  const fallbackBody = renderTemplate(
    input.bodyTemplate ??
      `Hi {{first_name | fallback:"there"}},\n\nI noticed {{company}} and thought of you. ${input.sender.valueProp}\n\nWould you be open to a quick chat next week?\n\n{{sender_name}}\n{{sender_company}}`,
    vars,
  );
  if (!hasAi(ai)) return { subject: fallbackSubject, body: fallbackBody, personalized: false, provider: "template" };

  const step = input.stepNo ?? 1;
  const res = await completeJson<{ subject: string; body: string }>(
    ai,
    [
      {
        role: "system",
        content: `You write high-converting B2B cold emails. Rules: under 120 words; one clear ask; no fluff, no "I hope this finds you well"; plain text; specific to the recipient's role and company; sound human, ${input.sender.tone ?? "friendly"} tone; never invent facts you don't have; sign off with the sender's name only (signature added separately). ${step > 1 ? `This is follow-up #${step} in a sequence - keep it shorter and reference the earlier note lightly (previous subject: "${input.previousSubject ?? ""}").` : ""} ${input.language ? `Write in ${input.language}.` : ""} Reply with JSON {"subject": string, "body": string}.`,
      },
      {
        role: "user",
        content: `Sender: ${input.sender.name}, ${input.sender.title ?? ""} at ${input.sender.company}. Value proposition: ${input.sender.valueProp}
Recipient: ${vars.full_name || "unknown"}, ${vars.title || "unknown role"} at ${vars.company || "unknown company"}${vars.industry ? ` (${vars.industry})` : ""}${vars.location ? `, ${vars.location}` : ""}.
Company context: ${vars.company_description || "n/a"}
${input.bodyTemplate ? `Base template to adapt (keep the intent):\n${fallbackBody}\n` : ""}${input.instructions ? `Extra instructions: ${input.instructions}` : ""}
Return JSON only.`,
      },
    ],
    { maxTokens: 500, temperature: 0.7 },
  );
  if (!res?.subject || !res?.body) return { subject: fallbackSubject, body: fallbackBody, personalized: false, provider: "template" };
  let body = String(res.body).trim();
  if (input.sender.signature) body += `\n\n${input.sender.signature}`;
  return { subject: String(res.subject).trim().slice(0, 120), body, personalized: true, provider: ai.name };
}

/** Classify an inbound reply: interested / not_interested / out_of_office / unsubscribe / other */
export async function classifyReply(ai: AiProvider, text: string): Promise<{ intent: string; confidence: number }> {
  const t = text.toLowerCase();
  if (/unsubscribe|remove me|stop emailing|opt out/.test(t)) return { intent: "unsubscribe", confidence: 0.95 };
  if (/out of (the )?office|on leave|automatic reply|auto-reply|vacation/.test(t)) return { intent: "out_of_office", confidence: 0.9 };
  if (!hasAi(ai)) {
    if (/interested|let'?s talk|schedule|call|demo|sounds good/.test(t)) return { intent: "interested", confidence: 0.6 };
    if (/not interested|no thanks|not a fit|not right now/.test(t)) return { intent: "not_interested", confidence: 0.6 };
    return { intent: "other", confidence: 0.4 };
  }
  const res = await completeJson<{ intent: string; confidence: number }>(ai, [
    { role: "system", content: 'Classify a reply to a sales email. JSON {"intent": one of interested|not_interested|out_of_office|unsubscribe|referral|question|other, "confidence": 0-1}.' },
    { role: "user", content: text.slice(0, 2000) },
  ], { maxTokens: 60, temperature: 0 });
  return res?.intent ? { intent: res.intent, confidence: Number(res.confidence ?? 0.7) } : { intent: "other", confidence: 0.4 };
}

/** Draft a short human follow-up reply to an inbound message that showed positive signal. */
export async function draftReplyToInbound(
  ai: AiProvider,
  input: {
    inboundText: string;
    inboundSubject?: string;
    intent: string;
    lead: Parameters<typeof leadVars>[0];
    sender: { name: string; company: string; title?: string; valueProp: string; signature?: string; tone?: "friendly" | "direct" | "formal" | "casual" };
  },
): Promise<{ subject: string; body: string } | null> {
  if (!hasAi(ai)) return null;
  const vars = leadVars(input.lead, { name: input.sender.name, company: input.sender.company, signature: input.sender.signature });
  const res = await completeJson<{ subject: string; body: string }>(
    ai,
    [
      {
        role: "system",
        content: `You draft short, human replies to inbound sales email replies. The person just replied with intent "${input.intent}". Rules: under 100 words; plain text; directly respond to what they said; one clear next step; ${input.sender.tone ?? "friendly"} tone; never invent facts you don't have; sign off with the sender's name only (signature added separately). Reply with JSON {"subject": string, "body": string}.`,
      },
      {
        role: "user",
        content: `Sender: ${input.sender.name}, ${input.sender.title ?? ""} at ${input.sender.company}. Value proposition: ${input.sender.valueProp}
Recipient: ${vars.full_name || "unknown"}, ${vars.title || "unknown role"} at ${vars.company || "unknown company"}.
Their reply (subject: "${input.inboundSubject ?? ""}"):
${input.inboundText.slice(0, 2000)}
Return JSON only.`,
      },
    ],
    { maxTokens: 400, temperature: 0.6 },
  );
  if (!res?.subject || !res?.body) return null;
  let body = String(res.body).trim();
  if (input.sender.signature) body += `\n\n${input.sender.signature}`;
  return { subject: String(res.subject).trim().slice(0, 120), body };
}
