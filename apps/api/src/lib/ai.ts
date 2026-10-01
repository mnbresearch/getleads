import { createAiProviderForPlan, type AiProvider } from "@prospex/core";
import type { AuthContext } from "./auth.js";

/**
 * The AI provider a request is allowed to spend on.
 *
 * Every route that called `createAiProvider()` picked the best configured engine - which is
 * the paid Anthropic one whenever its key is set - for free, pilot and starter orgs alike.
 * The plan gating already existed in core; routes just were not using it. The org is
 * already on the auth context, so this costs no query.
 */
export function aiFor(auth: Pick<AuthContext, "org">): AiProvider {
  return createAiProviderForPlan(auth.org.plan ?? "free");
}

/** A provider that never calls anything; AI helpers fall back to their rule-based path. */
export const NO_AI: AiProvider = { name: "none", model: "none", complete: async () => "" } as AiProvider;
