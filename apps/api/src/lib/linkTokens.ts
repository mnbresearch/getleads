import { randomBytes } from "node:crypto";
import { and, clients, eq, getDb, sql } from "@prospex/db";
import { decrypt, encrypt, sha256 } from "./crypto.js";

/**
 * Link tokens: the secret in an invite link and in a client report link.
 *
 * Both used to sit in the database in plaintext, so a copy of the table (a backup, a
 * read-only SQL console, an injection anywhere) was a list of working links. They are now
 * looked up by their SHA-256:
 *
 *  - invites keep ONLY the hash. Nobody needs to see an invite link again - "Resend" issues
 *    a new one;
 *  - client report links keep the hash for lookup and the token itself encrypted, bound to
 *    the workspace and the client, because owners and admins copy the link again from the
 *    client page. The encrypted copy is useless without the server's key, and it does not
 *    open if moved to another client's row.
 *
 * The tokens are 24+ random bytes, so an unsalted hash is not guessable and the lookup is an
 * index probe on the hash - nothing is compared character by character against a secret.
 */

/** What a link token is stored and looked up as. */
export const hashLinkToken = (token: string): string => sha256(token);

/** A new report-link token: 32 random bytes, URL-safe. */
export const newShareToken = (): string => randomBytes(32).toString("base64url");

const shareAad = (orgId: string, clientId: string) => `client-share:${orgId}:${clientId}`;

/** The three link columns for a client whose report link is `token`. */
export function shareTokenColumns(orgId: string, clientId: string, token: string): { shareToken: null; shareTokenHash: string; shareTokenEncrypted: string } {
  return { shareToken: null, shareTokenHash: hashLinkToken(token), shareTokenEncrypted: encrypt(token, shareAad(orgId, clientId)) };
}

/** The link token back from its encrypted column. Throws when it cannot be read. */
export function openShareToken(orgId: string, clientId: string, blob: string): string {
  return decrypt(blob, shareAad(orgId, clientId));
}

/**
 * Move one client's legacy plaintext link into the hashed + encrypted columns.
 *
 * Guarded by the old value: if the link was replaced or turned off in between, nothing is
 * written. Returns whether this call did the move.
 */
export async function migrateClientShareToken(row: { id: string; orgId: string; shareToken: string | null }): Promise<boolean> {
  if (!row.shareToken) return false;
  const { db } = getDb();
  const done = await db
    .update(clients)
    .set(shareTokenColumns(row.orgId, row.id, row.shareToken))
    .where(and(eq(clients.id, row.id), eq(clients.orgId, row.orgId), eq(clients.shareToken, row.shareToken)))
    .returning({ id: clients.id });
  return done.length > 0;
}

/**
 * Boot-time task: finish moving link tokens out of plaintext.
 *
 *  - every client report link still in `clients.share_token` is encrypted into
 *    `share_token_encrypted`, its hash recorded, and the plaintext column set to NULL;
 *  - any invite that has a plaintext token but no hash (created by the previous release
 *    while both were running) gets its hash, so it is found by the hash lookup. The legacy
 *    invite token itself is left as it is: those rows expire within 14 days.
 *
 * Idempotent, and safe to run from two instances at once: each row is updated only while it
 * still holds the value that was read, so the slower instance simply changes nothing.
 */
export async function migrateLegacyLinkTokens(opts: { batchSize?: number } = {}): Promise<{ clientLinks: number; inviteHashes: number }> {
  const { db } = getDb();
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 5000);
  let clientLinks = 0;
  // A row that cannot be migrated (it should not happen) is skipped by id, so one bad row
  // cannot spin this loop or hide the rows behind it.
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .select({ id: clients.id, orgId: clients.orgId, shareToken: clients.shareToken })
      .from(clients)
      .where(and(sql`${clients.shareToken} IS NOT NULL`, sql`${clients.id} > ${after}`))
      .orderBy(clients.id)
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      try {
        if (await migrateClientShareToken(row)) clientLinks++;
      } catch (e) {
        console.warn(`[links] could not move the report link of client ${row.id} out of plaintext: ${(e as Error).name}`);
      }
    }
    if (rows.length < batchSize) break;
  }
  const hashed = (await db.execute(
    sql`UPDATE invites SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token IS NOT NULL AND token_hash IS NULL RETURNING id`,
  )) as unknown as unknown[];
  return { clientLinks, inviteHashes: Array.isArray(hashed) ? hashed.length : 0 };
}
