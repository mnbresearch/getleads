import { and, eq, getDb } from "@prospex/db";
import { notFound } from "./errors.js";

/**
 * Assert that a referenced row belongs to this org, before it is stored or used.
 *
 * Reading is scoped consistently across this codebase - every list query anchors on
 * `eq(x.orgId, orgId(c))`. REFERENCES were not. A request could name another org's row by
 * id in a field that was validated only as `z.string().uuid()`, and the write went through:
 *
 *   - a campaign's `emailAccountId`, which sendStep later loads with no org predicate, then
 *     decrypts that tenant's SMTP credentials, sends from their address and consumes their
 *     daily sending cap;
 *   - a signal subscription's `campaignId`, which enrolls your leads into a foreign org's
 *     campaign, which then emails them.
 *
 * Both need a known UUID, so neither is trivially exploitable - but "hard to guess" is not
 * an authorization model, and the blast radius is another customer's sending reputation.
 *
 * It answers 404 rather than 403 on purpose: a tenant should not be able to learn whether
 * an id exists in someone else's workspace.
 */
export async function assertOwned(
  table: { id: unknown; orgId: unknown },
  id: string | null | undefined,
  orgId: string,
  what: string,
): Promise<void> {
  if (!id) return;
  const { db } = getDb();
  const rows = await db
    .select({ id: table.id as never })
    .from(table as never)
    .where(and(eq(table.id as never, id), eq(table.orgId as never, orgId)))
    .limit(1);
  if (!rows.length) throw notFound(what);
}
