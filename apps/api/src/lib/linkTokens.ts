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
 *
 * Report links that already existed when this release was installed are a special case. The
 * previous release finds a report by the plaintext in `clients.share_token` and nothing
 * else, so removing that column's value would make every existing link stop working the
 * moment someone rolled back. By default this release therefore ADDS the hash and an
 * encrypted copy to those rows and leaves the plaintext where it is; it is removed only when
 * the operator sets LINK_TOKENS_CLEAR_PLAINTEXT=true. Links created or replaced on this
 * release never have a plaintext copy, with or without the switch.
 *
 * While a row still has its plaintext, that column is the truth about the link: it is the
 * only thing the previous release reads or writes. A link replaced or turned off there
 * (during a rollback, or by an old instance in a rolling deploy) leaves the hash and the
 * copy behind, out of date. So:
 *   - a hash only counts on its own when the row's copy is one THIS release wrote for a
 *     link without plaintext. The copy kept next to a plaintext is marked (`legacy:`), and
 *     a row with such a copy and no plaintext is a link that was turned off - not a link;
 *   - a row whose hash does not match its plaintext is brought back in line from the
 *     plaintext the next time the start-up task runs.
 */

/** What a link token is stored and looked up as. */
export const hashLinkToken = (token: string): string => sha256(token);

/** A new report-link token: 32 random bytes, URL-safe. */
export const newShareToken = (): string => randomBytes(32).toString("base64url");

/**
 * Operator switch: remove the plaintext of report links that existed before this release.
 * OFF unless LINK_TOKENS_CLEAR_PLAINTEXT is exactly "true" (any case, spaces ignored).
 * Off keeps a rollback free for those links; on leaves no usable link in the table.
 */
export const clearsLinkPlaintext = (): boolean => String(process.env.LINK_TOKENS_CLEAR_PLAINTEXT ?? "").trim().toLowerCase() === "true";

const shareAad = (orgId: string, clientId: string) => `client-share:${orgId}:${clientId}`;

/** Marks the encrypted copy that sits NEXT TO a plaintext token (see the note at the top). */
const LEGACY_COPY = "legacy:";
/** SQL: this row's encrypted copy is one written for a link that has no plaintext. */
export const LIVE_SHARE_COPY_SQL = sql`(${clients.shareTokenEncrypted} IS NOT NULL AND ${clients.shareTokenEncrypted} NOT LIKE 'legacy:%')`;
/** The same test on a loaded row. */
export const isLiveShareCopy = (blob: string | null | undefined): boolean => !!blob && !blob.startsWith(LEGACY_COPY);

/**
 * The three link columns for a link created or replaced on this release: hash + encrypted
 * copy, no plaintext.
 */
export function shareTokenColumns(orgId: string, clientId: string, token: string): { shareToken: null; shareTokenHash: string; shareTokenEncrypted: string } {
  return { shareToken: null, shareTokenHash: hashLinkToken(token), shareTokenEncrypted: encrypt(token, shareAad(orgId, clientId)) };
}

/**
 * The two columns ADDED to a link that keeps its plaintext (one from before this release):
 * the lookup hash, and an encrypted copy marked as belonging next to a plaintext.
 */
export function legacyShareColumns(orgId: string, clientId: string, token: string): { shareTokenHash: string; shareTokenEncrypted: string } {
  return { shareTokenHash: hashLinkToken(token), shareTokenEncrypted: `${LEGACY_COPY}${encrypt(token, shareAad(orgId, clientId))}` };
}

/**
 * The link token back from the encrypted copy of a link that has NO plaintext. Throws when
 * it cannot be read - including for the marked copy kept next to a plaintext, which is never
 * the source of a link (the plaintext is; without it the link was turned off).
 */
export function openShareToken(orgId: string, clientId: string, blob: string): string {
  return decrypt(blob, shareAad(orgId, clientId));
}

/** Either kind of encrypted copy, opened. For checks and tooling; not how a link is served. */
export function openShareCopy(orgId: string, clientId: string, blob: string): string {
  return decrypt(blob.startsWith(LEGACY_COPY) ? blob.slice(LEGACY_COPY.length) : blob, shareAad(orgId, clientId));
}

type LegacyLinkRow = { id: string; orgId: string; shareToken: string | null; shareTokenHash?: string | null; shareTokenEncrypted?: string | null };

/**
 * Bring one client's pre-existing (plaintext) link up to date.
 *
 * Default: the hash and the (marked) encrypted copy are added - or corrected, if they no
 * longer match the plaintext - and the plaintext is left exactly as it is. A row that is
 * already in line is not written at all.
 * With LINK_TOKENS_CLEAR_PLAINTEXT=true (or `clearPlaintext`): the row becomes hash +
 * encrypted copy only, like a link created on this release.
 *
 * Guarded by the old value: if the link was replaced or turned off in between, nothing is
 * written. Returns whether this call changed the row.
 */
export async function migrateClientShareToken(row: LegacyLinkRow, opts: { clearPlaintext?: boolean } = {}): Promise<boolean> {
  if (!row.shareToken) return false;
  const clear = opts.clearPlaintext ?? clearsLinkPlaintext();
  if (!clear && row.shareTokenHash === hashLinkToken(row.shareToken) && !!row.shareTokenEncrypted && !isLiveShareCopy(row.shareTokenEncrypted)) return false;
  const { db } = getDb();
  const done = await db
    .update(clients)
    .set(clear ? shareTokenColumns(row.orgId, row.id, row.shareToken) : legacyShareColumns(row.orgId, row.id, row.shareToken))
    .where(and(eq(clients.id, row.id), eq(clients.orgId, row.orgId), eq(clients.shareToken, row.shareToken)))
    .returning({ id: clients.id });
  return done.length > 0;
}

/**
 * SQL: a row with a plaintext link whose hash or encrypted copy is missing, out of date, or
 * not marked as sitting next to a plaintext (a link whose plaintext was written back by the
 * rollback tool keeps the unmarked copy it had).
 */
const NEEDS_HASH_OR_COPY = sql`(${clients.shareTokenHash} IS NULL OR ${clients.shareTokenEncrypted} IS NULL OR ${clients.shareTokenEncrypted} NOT LIKE 'legacy:%' OR ${clients.shareTokenHash} <> encode(sha256(convert_to(${clients.shareToken}, 'UTF8')), 'hex'))`;

/**
 * Start-up task (also run by the housekeeping job): get every link token ready for lookup
 * by hash.
 *
 *  - every client report link that still has its plaintext in `clients.share_token` gets
 *    its hash and an encrypted copy. The plaintext STAYS, so the previous release can still
 *    serve the link after a rollback - unless LINK_TOKENS_CLEAR_PLAINTEXT=true, in which
 *    case it is set to NULL;
 *  - a hash and copy left behind on a link that was turned off by the previous release
 *    (plaintext gone, marked copy still there) are removed, so the link stays off;
 *  - any invite that has a plaintext token but no hash (created by the previous release
 *    while both were running) gets its hash, so it is found by the hash lookup. The legacy
 *    invite token itself is left as it is: those rows expire within 14 days.
 *
 * Idempotent in both modes: it selects the rows that still need work (by what is missing
 * or out of date, not by "plaintext is not null"), so a second run finds none. Safe to run
 * from two instances at once: each row is updated only while it still holds the value that
 * was read, so the slower instance simply changes nothing.
 */
export async function migrateLegacyLinkTokens(opts: { batchSize?: number; clearPlaintext?: boolean } = {}): Promise<{ clientLinks: number; inviteHashes: number; plaintextCleared: boolean; disabledLinksTidied: number }> {
  const { db } = getDb();
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 5000);
  const clear = opts.clearPlaintext ?? clearsLinkPlaintext();
  let clientLinks = 0;
  // A row that cannot be migrated (it should not happen) is skipped by id, so one bad row
  // cannot spin this loop or hide the rows behind it.
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .select({ id: clients.id, orgId: clients.orgId, shareToken: clients.shareToken, shareTokenHash: clients.shareTokenHash, shareTokenEncrypted: clients.shareTokenEncrypted })
      .from(clients)
      .where(and(sql`${clients.shareToken} IS NOT NULL`, clear ? sql`true` : NEEDS_HASH_OR_COPY, sql`${clients.id} > ${after}`))
      .orderBy(clients.id)
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      try {
        if (await migrateClientShareToken(row, { clearPlaintext: clear })) clientLinks++;
      } catch (e) {
        console.warn(`[links] could not prepare the report link of client ${row.id}: ${(e as Error).name}`);
      }
    }
    if (rows.length < batchSize) break;
  }
  // A link the previous release turned off: its plaintext is gone, and what is left is a
  // hash with the marked copy (or no copy). Lookups already ignore it; this removes it.
  const tidied = (await db.execute(
    sql`UPDATE clients SET share_token_hash = NULL, share_token_encrypted = NULL
        WHERE share_token IS NULL AND share_token_hash IS NOT NULL AND (share_token_encrypted IS NULL OR share_token_encrypted LIKE 'legacy:%') RETURNING id`,
  )) as unknown as unknown[];
  const hashed = (await db.execute(
    sql`UPDATE invites SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token IS NOT NULL AND token_hash IS NULL RETURNING id`,
  )) as unknown as unknown[];
  return { clientLinks, inviteHashes: Array.isArray(hashed) ? hashed.length : 0, plaintextCleared: clear, disabledLinksTidied: Array.isArray(tidied) ? tidied.length : 0 };
}
