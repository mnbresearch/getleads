import { randomToken } from "./crypto.js";
import { openOrgSecret, rebindOnReadSoon, sealOrgSecret } from "./credentials.js";

type HookRow = { id?: string | null; orgId?: string | null; secret?: string | null; secretEncrypted?: string | null };

/**
 * A webhook's signing secret, wherever it is stored.
 *
 * Hooks created before signature v2 keep their secret in plaintext in `secret` and are
 * signed with the legacy scheme. New and rotated hooks store it encrypted in
 * `secretEncrypted` (`secret` is null) and are signed with a real HMAC. The delivery job
 * calls this instead of reading `hook.secret`, so both kinds keep working.
 *
 * The encrypted secret is bound to the hook's workspace (lib/credentials.ts): one copied
 * onto another workspace's hook does not open there. Secrets encrypted before the binding
 * existed still open; pass `upgrade` (the delivery job does) to have such a secret rewritten
 * bound once it has been read.
 *
 * Throws when a hook has no usable secret at all (a row damaged by hand, or an encryption
 * key that changed): signing with an empty string would produce a signature anyone can
 * compute, so "cannot sign" must fail the delivery, not weaken it.
 */
export function webhookSecret(row: HookRow, opts: { upgrade?: boolean } = {}): string {
  if (row.secretEncrypted && row.orgId) {
    try {
      const s = openOrgSecret(row.orgId, "webhook-secret", row.secretEncrypted);
      if (s) {
        if (opts.upgrade) rebindOnReadSoon(row.orgId, "webhook-secret", row.id, row.secretEncrypted, s);
        return s;
      }
    } catch {
      // fall through to the legacy column, then to the error below
    }
  }
  if (row.secret) return row.secret;
  throw new Error("webhook has no usable signing secret (rotate it from Settings > Webhooks)");
}

/** A fresh v2 secret for a hook of this workspace: the plaintext to show once, and the columns to store. */
export function newWebhookSecret(orgId: string): { secret: string; columns: { secret: null; secretEncrypted: string; signatureVersion: 2 } } {
  const secret = `whsec_${randomToken(32)}`;
  return { secret, columns: { secret: null, secretEncrypted: sealOrgSecret(orgId, "webhook-secret", secret), signatureVersion: 2 } };
}

/** What a list may show of a secret: enough to tell two hooks apart, not enough to sign. */
export function secretPreview(row: HookRow): string {
  try {
    // Every new secret starts "whsec_", so the prefix alone told nothing apart: the last four
    // characters do, and four of forty-odd random characters are no help in forging one.
    const s = webhookSecret(row);
    return s.length >= 16 ? `${s.slice(0, 6)}...${s.slice(-4)}` : "...";
  } catch {
    return "";
  }
}

/** A webhook row as the API returns it: never the secret, plaintext or encrypted. */
export function publicWebhook<T extends HookRow>(row: T): Omit<T, "secret" | "secretEncrypted"> & { secretPreview: string } {
  const { secret: _s, secretEncrypted: _e, ...rest } = row;
  return { ...rest, secretPreview: secretPreview(row) };
}
