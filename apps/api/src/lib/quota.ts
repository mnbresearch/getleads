import { consume, QuotaExceededError, type Db } from "@prospex/db";

export type QuotaOutcome = { ok: true } | { ok: false; reason: "quota"; message: string } | { ok: false; reason: "error"; message: string };

/**
 * Charge a quota, and say which of the two "no" answers this was.
 *
 * `await consume(...).then(() => true, () => false)` was used in eight places, and it turns
 * EVERY failure into "you are out of quota" - including a dropped connection or any other
 * error from the two round trips inside `consume`. The caller then records `skipped:
 * "quota"`, and in `savedsearch.run` still stamps `lastRunAt`, so a transient database
 * blip silently cancels that day's alert digest and files it under the customer's plan
 * limit. The customer is told they hit a cap they did not hit, and the real fault is never
 * recorded anywhere.
 *
 * `QuotaExceededError` already exists and is exported; it just was not being looked at.
 */
export async function tryConsume(db: Db, orgId: string, metric: Parameters<typeof consume>[2], amount = 1): Promise<QuotaOutcome> {
  try {
    await consume(db, orgId, metric, amount);
    return { ok: true };
  } catch (e) {
    if (e instanceof QuotaExceededError) return { ok: false, reason: "quota", message: e.message };
    return { ok: false, reason: "error", message: (e as Error).message ?? String(e) };
  }
}
