import { createAiProviderForPlan, type AiProvider } from "@prospex/core";
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
