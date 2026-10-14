import { env } from "../env.js";
import { orgDataKeys } from "../services/integrations.js";

/** Email-verification options from the server's own configuration (the platform's keys). */
export const platformVerifyOpts = () => ({ smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });

/**
 * The same, for one workspace: when the workspace connected its own Hunter key
 * (Settings > Integrations) that key is used for its own lookups, so its quota is spent
 * instead of the shared one. Anything unreadable falls back to the platform key.
 */
export async function verifyOptsFor(orgId: string | null | undefined) {
  const own = await orgDataKeys(orgId);
  return { ...platformVerifyOpts(), ...(own.hunterApiKey ? { hunterApiKey: own.hunterApiKey } : {}) };
}
