import { and, eq, icps, sql, type Db } from "@prospex/db";
import { aiDisabled } from "../lib/ai.js";

/**
 * What an ICP shows when its AI profile could not be built.
 *
 * Without AI the build job ended quietly and left `aiProfile` empty, which is exactly what
 * "still building" looks like - so the page said "AI profile building..." for ever. The
 * outcome is written onto the ICP instead, in words, and the criteria the user typed are
 * what scoring uses.
 */
export const ICP_NO_AI_NOTE = "AI not available - using your criteria as written.";
export const ICP_AI_OFF_NOTE = "AI assistance is turned off for this workspace - using your criteria as written. An owner or admin can turn it back on under Settings.";
export const ICP_AI_FAILED_NOTE = "The AI could not build a profile this time - using your criteria as written. Try Rebuild later.";

/** The `aiProfile` value that records a build that did not happen, and why. */
export function skippedProfile(reason: "no_ai" | "ai_off" | "ai_failed"): Record<string, unknown> {
  const note = reason === "ai_off" ? ICP_AI_OFF_NOTE : reason === "ai_failed" ? ICP_AI_FAILED_NOTE : ICP_NO_AI_NOTE;
  return { status: "skipped", reason, note, at: new Date().toISOString() };
}

/**
 * Record a skipped build, without overwriting a real profile built earlier: an ICP that
 * once had an AI profile keeps it when a later rebuild finds no AI.
 */
export async function recordIcpBuildSkipped(db: Db, orgId: string, icpId: string, reason: "no_ai" | "ai_off" | "ai_failed") {
  await db
    .update(icps)
    .set({ aiProfile: skippedProfile(reason), updatedAt: new Date() })
    .where(and(eq(icps.id, icpId), eq(icps.orgId, orgId), sql`(${icps.aiProfile} IS NULL OR ${icps.aiProfile}->>'status' = 'skipped')`));
}

/**
 * Called by the icp.build job when no profile came back: works out which of the three
 * reasons applies (AI switched off by the workspace, no AI on this server, or the AI call
 * failed) and records it on the ICP.
 */
export async function recordIcpBuildMissed(db: Db, orgId: string, icpId: string, aiWasAvailable: boolean) {
  if (aiWasAvailable) return recordIcpBuildSkipped(db, orgId, icpId, "ai_failed");
  const org = await db.query.organizations.findFirst({ where: (t, { eq: e }) => e(t.id, orgId), columns: { settings: true } });
  return recordIcpBuildSkipped(db, orgId, icpId, aiDisabled(org) ? "ai_off" : "no_ai");
}
