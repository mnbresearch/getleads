import { and, emailAccounts, eq, getDb, integrations, webhooks } from "@prospex/db";
import { CredentialUnreadableError, decrypt, encrypt } from "./crypto.js";

/**
 * Stored credentials, bound to the workspace that owns them.
 *
 * This module is the ONLY place a tenant credential is encrypted or decrypted: sender
 * configs (SMTP passwords, Resend keys), integration configs (CRM tokens, WhatsApp tokens)
 * and webhook signing secrets.
 *
 * Every blob written here carries the owning workspace as additional authenticated data
 * (`<kind>:<orgId>`). The ciphertext is otherwise position-independent: before this, a blob
 * copied from one workspace's row onto another's (by a bug, a bad migration, or anyone able
 * to write to the table) decrypted there, and that second workspace then sent mail through
 * the first one's SMTP account. A bound blob only opens for the workspace it was written for.
 *
 * Blobs written before this change have no binding (the legacy 3-part format, and v2 blobs
 * written without AAD). They MUST keep opening, so reads fall back to "no AAD" for them -
 * lib/crypto.ts decrypt() does exactly that: an unbound blob opens with or without AAD, a
 * bound one only with its own.
 *
 * What is written when: a credential SAVED on this release is always written bound. A legacy
 * blob that is merely READ is left exactly as it is, byte for byte, unless the operator has
 * turned on CREDENTIAL_REBIND_ON_READ=true - then it is rewritten bound the first time it is
 * read successfully (`rebindOnRead`). That is opt-in because the previous release cannot open
 * a bound blob: rewriting existing credentials on our own initiative would turn a rollback
 * into "every sender and integration that was used has to be reconnected".
 *
 * Key derivation is unchanged: this adds AAD, nothing else.
 */
export type OrgSecretKind = "email-account" | "integration" | "webhook-secret";

export { CredentialUnreadableError };

const aadFor = (orgId: string, kind: OrgSecretKind) => `${kind}:${orgId}`;

function assertOrg(orgId: string): void {
  // Sealing under an empty owner would produce one blob every workspace could "own".
  if (typeof orgId !== "string" || !orgId) throw new Error("sealOrgSecret: a workspace id is required");
}

/** Encrypt `value` so that it only opens for this workspace and this kind of credential. */
export function sealOrgSecret(orgId: string, kind: OrgSecretKind, value: string): string {
  assertOrg(orgId);
  return encrypt(value, aadFor(orgId, kind));
}

/**
 * Decrypt a stored credential for this workspace. Throws CredentialUnreadableError when the
 * blob is damaged, was written under a key that is no longer listed, or is bound to another
 * workspace (or another kind of credential).
 */
export function openOrgSecret(orgId: string, kind: OrgSecretKind, blob: string): string {
  assertOrg(orgId);
  return decrypt(blob, aadFor(orgId, kind));
}

export function sealOrgJson(orgId: string, kind: OrgSecretKind, obj: unknown): string {
  return sealOrgSecret(orgId, kind, JSON.stringify(obj));
}

/**
 * Strict JSON read: null ONLY when nothing is stored. Present-but-unreadable (or readable
 * but not JSON) throws CredentialUnreadableError, so "no config" and "cannot read the
 * config" never look the same to a caller.
 */
export function openOrgJson<T = Record<string, unknown>>(orgId: string, kind: OrgSecretKind, blob: string | null | undefined): T | null {
  if (!blob) return null;
  const plain = openOrgSecret(orgId, kind, blob);
  try {
    return JSON.parse(plain) as T;
  } catch {
    throw new CredentialUnreadableError("A stored credential decrypted but is not valid JSON; the stored value is damaged. Re-enter the credential.");
  }
}

/** True when the blob opens WITHOUT a binding: it was written before credentials were bound. */
export function isUnboundSecret(blob: string): boolean {
  try {
    decrypt(blob);
    return true;
  } catch {
    return false;
  }
}

/**
 * Operator switch for the lazy upgrade below. OFF unless CREDENTIAL_REBIND_ON_READ is exactly
 * "true" (any case, spaces ignored).
 *
 * Off is the default because the upgrade rewrites EXISTING stored credentials in a format
 * the previous release cannot read back. With it off, the only bound credentials are the
 * ones customers saved on this release; everything older stays readable by both releases.
 * Read on every call, so it takes effect without a restart where the platform allows that.
 */
export const rebindOnReadEnabled = (): boolean => String(process.env.CREDENTIAL_REBIND_ON_READ ?? "").trim().toLowerCase() === "true";
const rebindEnabled = rebindOnReadEnabled;

const STORES = {
  "email-account": { table: emailAccounts, column: emailAccounts.configEncrypted, field: "configEncrypted" },
  integration: { table: integrations, column: integrations.configEncrypted, field: "configEncrypted" },
  "webhook-secret": { table: webhooks, column: webhooks.secretEncrypted, field: "secretEncrypted" },
} as const;

/**
 * Lazy upgrade (only with CREDENTIAL_REBIND_ON_READ=true; otherwise this does nothing and
 * returns false): a legacy (unbound) blob that was just read successfully is rewritten bound
 * to its workspace.
 *
 * One row, one UPDATE, guarded by the old value: if anything else changed the credential in
 * between (the customer saved a new one, another instance already upgraded it) nothing is
 * written. Never throws - failing to upgrade must not fail the send that read the credential.
 * Returns whether the row was rewritten.
 */
export async function rebindOnRead(orgId: string, kind: OrgSecretKind, rowId: string, blob: string, plain: string): Promise<boolean> {
  try {
    if (!rebindEnabled() || !orgId || !rowId || !blob || !isUnboundSecret(blob)) return false;
    const store = STORES[kind];
    const { db } = getDb();
    const bound = sealOrgSecret(orgId, kind, plain);
    const rows = await db
      .update(store.table)
      .set({ [store.field]: bound } as never)
      .where(and(eq(store.table.id, rowId), eq(store.table.orgId, orgId), eq(store.column, blob)))
      .returning({ id: store.table.id });
    return rows.length > 0;
  } catch (e) {
    console.warn(`[credentials] could not upgrade a stored ${kind} credential (it stays readable as it is): ${(e as Error).name}`);
    return false;
  }
}

/** Fire-and-forget form of rebindOnRead, for synchronous readers. */
export function rebindOnReadSoon(orgId: string, kind: OrgSecretKind, rowId: string | null | undefined, blob: string | null | undefined, plain: string): void {
  if (!rowId || !blob || !rebindEnabled()) return;
  // Cheap check first, so the common (already bound) case schedules nothing.
  if (!isUnboundSecret(blob)) return;
  void rebindOnRead(orgId, kind, rowId, blob, plain);
}
