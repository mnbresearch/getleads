import { consume, getUsage, QuotaExceededError, type Db, type Metric } from "@prospex/db";

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

/**
 * Refuse up front when a metric has no room left, without charging anything.
 *
 * For work that should only be paid for when it succeeds (an AI call that may come back
 * empty): check here BEFORE spending the provider call, then `consume` after it worked.
 * Charging first and refunding on failure needs a refund path that does not exist;
 * charging after with `.catch(() => {})` - what several routes did - meant an org past its
 * cap kept getting AI answers for free, forever.
 */
export async function assertQuotaAvailable(db: Db, orgId: string, metric: Metric, amount = 1): Promise<void> {
  const { usage } = await getUsage(db, orgId);
  const u = usage[metric];
  if (u && u.limit > 0 && u.used + amount > u.limit) throw new QuotaExceededError(metric, u.used, u.limit);
}
