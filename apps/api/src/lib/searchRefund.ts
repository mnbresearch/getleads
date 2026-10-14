import { consume, type Db } from "@prospex/db";

/**
 * Give back the one search unit a discovery call charged up front, when it turned out that no
 * source could search at all (none connected, none answered, or only a keyless fallback
 * scraper did). Such a call delivered nothing and said so; it must not also cost the
 * customer a search.
 *
 * Same pattern as the other give-backs (plays, jobs): allowOverage so a refund is never
 * refused, and best-effort, because failing to refund must not turn a clear "could not
 * search" answer into a 500.
 */
export async function refundBlockedSearch(db: Db, orgId: string): Promise<void> {
  await consume(db, orgId, "searches", -1, { allowOverage: true }).catch(() => {});
}
