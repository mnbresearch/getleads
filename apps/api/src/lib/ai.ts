import { createAiProvider, createAiProviderForPlan, hasAi, type AiProvider } from "@prospex/core";
import type { AuthContext } from "./auth.js";

/**
 * A provider that never calls anything; AI helpers fall back to their rule-based path.
 *
 * `name: "none"` is what `hasAi()` in core looks at, so every helper that takes a provider
 * (email drafting, reply classification, ICP building, query parsing, lead scoring) takes
 * its non-AI path when handed this.
 */
export const NO_AI: AiProvider = { name: "none", model: "none", complete: async () => "" } as AiProvider;

/** What a customer is told when a feature ran without AI because the workspace turned it off. */
export const AI_OFF_NOTE = "AI assistance is turned off for this workspace, so this was done without AI. An owner or admin can turn it back on under Settings.";

/** The same, for a feature that cannot run without AI: what is not available, and how to get it back. */
export const AI_OFF_UNAVAILABLE = "AI assistance is turned off for this workspace, so this is not available. An owner or admin can turn it back on under Settings.";

/**
 * Has this workspace turned AI assistance off?
 *
 * The switch lives in `organizations.settings.aiDisabled`. When it is on, no lead, prospect
 * or inbound-mail content of this workspace is sent to any AI provider: every caller that
 * asks for the workspace's provider gets `NO_AI` instead. Only the literal `true` turns it
 * off - a missing or malformed setting leaves the workspace as it was.
 */
export function aiDisabled(org: { settings?: unknown } | null | undefined): boolean {
  const s = org?.settings;
  return !!s && typeof s === "object" && (s as Record<string, unknown>).aiDisabled === true;
}

/**
 * The AI provider a workspace is allowed to use: none when it has turned AI off, otherwise
 * the engine its plan pays for.
 *
 * Every route that called `createAiProvider()` picked the best configured engine - which is
 * the paid Anthropic one whenever its key is set - for free, pilot and starter orgs alike.
 * The plan gating already existed in core; routes just were not using it.
 */
export function aiForOrg(org: { plan?: string | null; settings?: unknown } | null | undefined): AiProvider {
  if (aiDisabled(org)) return NO_AI;
  return createAiProviderForPlan(org?.plan ?? "free");
}

/** The same, for a request: the org is already on the auth context, so this costs no query. */
export function aiFor(auth: Pick<AuthContext, "org">): AiProvider {
  return aiForOrg(auth.org);
}

/**
 * Why a workspace has no AI engine, when it has none. Three different causes used to share
 * one sentence ("isn't switched on for this workspace yet. Contact support"), which was wrong
 * twice over: a workspace that switched AI off itself was sent to support, and a server with
 * no engine at all was described as a setting of the customer's workspace.
 *
 *  - "workspace_off": an owner or admin turned AI assistance off under Settings.
 *  - "plan": the server has an engine, but only one this workspace's plan does not include.
 *  - "platform": no AI engine is connected on the server at all - nothing the customer can change.
 *
 * null when the workspace does have an engine.
 */
export type AiMissingReason = "workspace_off" | "plan" | "platform";

export function aiMissingReason(org: { plan?: string | null; settings?: unknown } | null | undefined): AiMissingReason | null {
  if (aiDisabled(org)) return "workspace_off";
  if (hasAi(createAiProviderForPlan(org?.plan ?? "free"))) return null;
  // Any engine at all on the server (the paid one included)? Then it is the plan, not the platform.
  return hasAi(createAiProvider()) ? "plan" : "platform";
}

/** Customer-facing sentences for each cause. They name no server setting. */
export const AI_PLATFORM_MISSING = "AI drafting isn't available yet: no AI engine is connected on our side. This is not a setting in your workspace - contact support if you need it.";
export const AI_PLAN_MISSING = "AI drafting isn't included in this workspace's plan. Upgrade the plan to use it.";

/**
 * One sentence saying why there was no AI, for a feature that falls back to something
 * without it (a template, rules). `what` is the fallback, e.g. "this is a template, not a
 * personalised draft". Undefined when the workspace has an engine.
 */
export function aiMissingNote(org: { plan?: string | null; settings?: unknown } | null | undefined, what?: string): string | undefined {
  const reason = aiMissingReason(org);
  if (!reason) return undefined;
  const tail = what ? `, so ${what}.` : ".";
  if (reason === "workspace_off") return `AI assistance is turned off for this workspace${tail} An owner or admin can turn it back on under Settings.`;
  if (reason === "plan") return `AI drafting isn't included in this workspace's plan${tail} Upgrade the plan to use it.`;
  return `AI drafting isn't available yet - no AI engine is connected on our side${tail} This is not a setting in your workspace; contact support if you need it.`;
}
