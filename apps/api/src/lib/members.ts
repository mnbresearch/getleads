import { and, eq, getDb, sql, users } from "@prospex/db";
import { canonicalEmail } from "../services/leads.js";

/**
 * Is `email` the address of a member of this workspace? Returns it in canonical form, or
 * null.
 *
 * Platform mail (search alerts, the platform sender's Reply-To) used to go to - or name -
 * any address a tenant typed. Restricting those to addresses that belong to people IN the
 * workspace is what stops Scout's own sending reputation being pointed at strangers.
 * Used at save time by the routes and again at send time by the jobs, because rows saved
 * before this check existed are still in the table.
 */
export async function orgMemberEmail(orgId: string, email: unknown): Promise<string | null> {
  const e = canonicalEmail(email);
  if (!e) return null;
  const { db } = getDb();
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.orgId, orgId), sql`lower(${users.email}) = ${e}`))
    .limit(1);
  return row ? e : null;
}

/** The address platform mail for a workspace falls back to: its owner's (oldest owner first). */
export async function orgOwnerEmail(orgId: string): Promise<string | null> {
  const { db } = getDb();
  const rows = await db.select({ email: users.email, role: users.role, createdAt: users.createdAt }).from(users).where(eq(users.orgId, orgId));
  const sorted = rows.sort((a, b) => (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1) || a.createdAt.getTime() - b.createdAt.getTime());
  return sorted.length ? canonicalEmail(sorted[0].email) : null;
}
