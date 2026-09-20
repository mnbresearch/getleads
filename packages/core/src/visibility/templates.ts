/**
 * Prompt templates: the questions worth tracking.
 *
 * Tracking the wrong questions is the quiet failure mode of this whole category. A tool
 * that makes you type your own prompts measures whatever you happened to guess, which is
 * usually your product's name - the one question where you are guaranteed to appear and
 * which no real buyer ever asks.
 *
 * Real buyers ask category questions ("best X for Y"), comparison questions ("X vs Y"),
 * and problem questions where your name never comes up at all. Those are the answers that
 * decide a deal, and they are the ones you are most likely to be missing from.
 *
 * Two ways to get them here:
 *   - `starterPack()` - deterministic archetypes filled from your brand and category. No
 *     AI call, works on the free tier, and is what the generated set is measured against.
 *   - `templateBrief()` + `parseGeneratedPrompts()` - an AI writes the set from your own
 *     positioning and competitors. Better questions, but its output is untrusted text, so
 *     it is validated and deduplicated against the same rules before anything is stored.
 */

export type PromptIntent = "category" | "comparison" | "problem" | "alternative" | "evaluation";

export interface PromptTemplate {
  text: string;
  topic: string;
  intent: PromptIntent;
  /** Why this question is worth spending samples on. Shown in the UI; not stored. */
  rationale: string;
}

/** Everything the generator needs to write questions specific to one company. */
export interface TemplateContext {
  brand: string;
  category: string;
  competitors?: string[];
  /** Who they sell to, in the user's own words. Comes from the ICP when one exists. */
  audience?: string | null;
  /** The problem the product solves, in the user's own words. */
  problem?: string | null;
}

const MIN_LEN = 12;
const MAX_LEN = 300;

/** A question that names your brand measures the prompt, not your visibility. */
function mentionsBrand(text: string, brand: string): boolean {
  const b = brand.trim();
  if (b.length < 3) return false;
  return new RegExp(`(?<![\\w-])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/^["'“‘]|["'”’]$/g, "").trim();
}

/** Collapses near-duplicates: same words in any order and casing is the same question. */
function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(" ");
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "for", "of", "to", "in", "on", "and", "or", "what", "which",
  "who", "best", "good", "should", "i", "we", "my", "our", "you", "your", "me", "us", "it",
]);

export interface ValidationResult {
  kept: PromptTemplate[];
  /** Rejected candidates with the reason, so the UI can say why rather than silently dropping. */
  rejected: { text: string; reason: string }[];
}

/**
 * Validate and deduplicate a candidate set.
 *
 * Applied to AI output and to anything a user bulk-imports, because both are untrusted:
 * one is a model's guess, the other is a paste from a keyword tool.
 */
export function validatePrompts(candidates: PromptTemplate[], ctx: { brand: string }, existing: string[] = []): ValidationResult {
  const kept: PromptTemplate[] = [];
  const rejected: { text: string; reason: string }[] = [];
  const seen = new Set(existing.map(fingerprint));

  for (const c of candidates) {
    const text = normalise(c.text ?? "");
    if (text.length < MIN_LEN) {
      rejected.push({ text, reason: "too short to be a real buyer question" });
      continue;
    }
    if (text.length > MAX_LEN) {
      rejected.push({ text, reason: "too long; engines answer focused questions" });
      continue;
    }
    if (mentionsBrand(text, ctx.brand)) {
      rejected.push({ text, reason: `names ${ctx.brand}, which biases the engine toward mentioning you` });
      continue;
    }
    const fp = fingerprint(text);
    if (seen.has(fp)) {
      rejected.push({ text, reason: "duplicate of a question already tracked" });
      continue;
    }
    seen.add(fp);
    kept.push({ ...c, text });
  }

  return { kept, rejected };
}

/**
 * Deterministic starter set.
 *
 * Deliberately covers all five intents rather than stacking the easy ones. Category and
 * comparison questions are where brands discover they are absent; a pack made only of
 * flattering questions would be the same mistake as reporting one sample as a measurement.
 */
export function starterPack(ctx: TemplateContext): PromptTemplate[] {
  const cat = (ctx.category || "software").trim();
  const audience = (ctx.audience || "").trim();
  const forWhom = audience ? ` for ${audience}` : "";
  const rivals = (ctx.competitors ?? []).map((c) => c.trim()).filter(Boolean);
  const problem = (ctx.problem || "").trim();

  const out: PromptTemplate[] = [
    {
      text: `What is the best ${cat}${forWhom}?`,
      topic: "category",
      intent: "category",
      rationale: "The question a buyer asks first. If you are absent here, nothing downstream matters.",
    },
    {
      text: `Which ${cat} tools should I shortlist${forWhom} in 2026?`,
      topic: "category",
      intent: "category",
      rationale: "Shortlist questions decide who gets evaluated at all.",
    },
    {
      text: `What should I look for when choosing a ${cat}?`,
      topic: "evaluation",
      intent: "evaluation",
      rationale: "Reveals which criteria the engines treat as important, which is what to lead with in outreach.",
    },
    {
      text: `What are the pros and cons of the leading ${cat} platforms?`,
      topic: "evaluation",
      intent: "evaluation",
      rationale: "Surfaces how you are characterised, not just whether you are named.",
    },
  ];

  if (rivals[0]) {
    out.push({
      text: `Is ${rivals[0]} the best option for ${cat}, or are there better alternatives?`,
      topic: "competitor",
      intent: "alternative",
      rationale: `Buyers already looking at ${rivals[0]}. Being the named alternative here is the cheapest win available.`,
    });
  }
  if (rivals[0] && rivals[1]) {
    out.push({
      text: `${rivals[0]} vs ${rivals[1]}: which is better${forWhom}?`,
      topic: "competitor",
      intent: "comparison",
      rationale: "Head-to-head answers often list a third option. That slot is winnable.",
    });
  }
  if (rivals[0]) {
    out.push({
      text: `What are the top alternatives to ${rivals[0]}?`,
      topic: "competitor",
      intent: "alternative",
      rationale: "Pure alternative-seeking intent, and the highest-conversion answer to appear in.",
    });
  }

  out.push({
    text: problem
      ? `How do teams usually solve ${problem}?`
      : `How do teams usually handle ${cat} without dedicated software?`,
    topic: "problem",
    intent: "problem",
    rationale: "Problem-stage questions where your category may not even be mentioned yet.",
  });
  out.push({
    text: problem ? `What tools help with ${problem}?` : `What tools help teams with ${cat}?`,
    topic: "problem",
    intent: "problem",
    rationale: "The moment a problem turns into a tool search.",
  });

  return out;
}

/**
 * The brief handed to the model.
 *
 * Constrains it to the same rules validatePrompts enforces, so most output survives, and
 * asks for JSON because prose would have to be parsed by guesswork.
 */
export function templateBrief(ctx: TemplateContext): { system: string; user: string } {
  const rivals = (ctx.competitors ?? []).filter(Boolean);
  return {
    system:
      "You write the questions real B2B buyers type into AI assistants while researching a purchase. " +
      "You return JSON only: an array of objects with keys text, topic, intent, rationale. " +
      "intent is one of: category, comparison, problem, alternative, evaluation. " +
      "Rules, all mandatory: never name the brand being tracked, because a question naming them " +
      "guarantees they appear and measures nothing; write questions a buyer would actually type, " +
      "not marketing phrases; keep each under 200 characters; no duplicates or reworded repeats; " +
      "cover every intent rather than stacking one.",
    user: [
      `Brand being tracked (never name it in a question): ${ctx.brand}`,
      `Category: ${ctx.category}`,
      ctx.audience ? `They sell to: ${ctx.audience}` : null,
      ctx.problem ? `Problem they solve: ${ctx.problem}` : null,
      rivals.length ? `Known competitors (you may name these): ${rivals.join(", ")}` : null,
      "",
      "Write 10 questions worth tracking. Favour questions where this brand is plausibly missing " +
      "from the answer today over questions it obviously wins. Return JSON only.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const INTENTS: PromptIntent[] = ["category", "comparison", "problem", "alternative", "evaluation"];

/**
 * Parse the model's reply.
 *
 * Tolerates the usual deviations (code fences, a sentence before the array) because a
 * parse failure here would throw away a paid call, but never trusts the content: every
 * field is coerced, and anything unparseable returns empty rather than a guess.
 */
export function parseGeneratedPrompts(raw: string): PromptTemplate[] {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: PromptTemplate[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const t = typeof r.text === "string" ? r.text : "";
    if (!t.trim()) continue;
    const intent = typeof r.intent === "string" && (INTENTS as string[]).includes(r.intent) ? (r.intent as PromptIntent) : "category";
    out.push({
      text: t,
      topic: typeof r.topic === "string" && r.topic.trim() ? r.topic.trim().slice(0, 80) : intent,
      intent,
      rationale: typeof r.rationale === "string" ? r.rationale.slice(0, 300) : "",
    });
  }
  return out;
}

/** Which intents a set is missing, so the UI can say what the coverage actually is. */
export function intentCoverage(prompts: { intent: PromptIntent }[]): { intent: PromptIntent; count: number }[] {
  return INTENTS.map((intent) => ({ intent, count: prompts.filter((p) => p.intent === intent).length }));
}
