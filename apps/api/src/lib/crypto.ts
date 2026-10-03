import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

/**
 * Encryption of stored credentials (SMTP passwords, CRM tokens, webhook secrets): AES-256-GCM.
 *
 * Two blob formats exist and both decrypt:
 *
 *   legacy  base64(iv).base64(tag).base64(ct)
 *           key = sha256(ENCRYPTION_KEY, or JWT_SECRET when ENCRYPTION_KEY is unset). Everything
 *           written before the v2 format looks like this and MUST stay readable, so the
 *           derivation is frozen exactly as it was. No key id, no AAD.
 *
 *   v2      v2.<kid>.base64(iv).base64(tag).base64(ct)
 *           key = HKDF-SHA256(raw key). <kid> is a short fingerprint of the raw key, so after a
 *           rotation the right key is picked directly instead of guessed. Optional AAD binds
 *           the ciphertext to its owner (e.g. "integration:<orgId>:<provider>"): a blob copied
 *           onto another row no longer decrypts there.
 *
 * Rotation: put the new value in ENCRYPTION_KEY and the previous one(s) in ENCRYPTION_KEYS_OLD
 * (comma-separated). New writes use ENCRYPTION_KEY; reads try every listed key. Without the
 * old value listed, every stored credential becomes unreadable - which used to surface as a
 * sender with an empty SMTP host, not as an error. Use `decryptJsonStrict` to tell the two apart.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const V2 = "v2";

/** Thrown by decryptJsonStrict / decrypt when a stored blob exists but cannot be read. */
export class CredentialUnreadableError extends Error {
  readonly code = "ECREDUNREADABLE";
  constructor(message = "A stored credential could not be decrypted. It was encrypted with a key this server no longer has (ENCRYPTION_KEY / JWT_SECRET changed) or the stored value is damaged. Re-enter the credential, or restore the previous key in ENCRYPTION_KEYS_OLD.") {
    super(message);
    this.name = "CredentialUnreadableError";
  }
}

/** The raw key new ciphertext is written under. */
function currentRawKey(): string {
  return env.encryptionKey || env.jwtSecret;
}

/**
 * Every raw key a stored blob may have been written under, current first, without duplicates.
 * JWT_SECRET is included even when ENCRYPTION_KEY is set: a deployment that ran without
 * ENCRYPTION_KEY for a while encrypted under JWT_SECRET, and setting ENCRYPTION_KEY later must
 * not strand those rows.
 */
function rawKeyring(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [currentRawKey(), ...(env.encryptionKeysOld ?? []), env.jwtSecret]) {
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

const legacyKey = (raw: string) => createHash("sha256").update(raw).digest();
const v2Key = (raw: string) => Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), "scout:credentials:v2", 32));
/** Not secret-bearing in any useful way (8 bytes of a domain-separated hash); only selects a key. */
const keyId = (raw: string) => createHash("sha256").update(`scout:kid:${raw}`).digest("hex").slice(0, 12);

/** Strict base64: Buffer.from() silently drops junk, which would let a mangled blob "decode". */
function b64(part: string | undefined): Buffer | null {
  if (part === undefined || !/^[A-Za-z0-9+/]*={0,2}$/.test(part)) return null;
  return Buffer.from(part, "base64");
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad?: string): string | null {
  try {
    // authTagLength pins the tag to 16 bytes. Without it Node accepts any tag from 4 bytes up,
    // so a truncated tag (forgeable in 2^32 tries) passed as authentic.
    const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    if (aad !== undefined) d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encrypt. Output is the v2 format. Pass `aad` to bind the ciphertext to its owner; the same
 * value must then be passed to decrypt.
 */
export function encrypt(plain: string, aad?: string) {
  const raw = currentRawKey();
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", v2Key(raw), iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [V2, keyId(raw), iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

/**
 * Decrypt either format. Throws CredentialUnreadableError when the blob is malformed, was
 * tampered with, was written under a key that is not in the keyring, or (v2) was bound to a
 * different `aad`.
 *
 * AAD rules: a legacy blob has none, so `aad` is ignored for it. A v2 blob written WITH an aad
 * only opens with that same aad. A v2 blob written without one opens with or without - that
 * is what lets a call site start passing an aad without first rewriting its existing rows.
 */
export function decrypt(blob: string, aad?: string) {
  const parts = typeof blob === "string" ? blob.split(".") : [];
  if (parts[0] === V2) {
    if (parts.length !== 5) throw new CredentialUnreadableError();
    const [, kid, ivB, tagB, ctB] = parts;
    const iv = b64(ivB);
    const tag = b64(tagB);
    const ct = b64(ctB);
    if (!iv || !tag || !ct || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialUnreadableError();
    const ring = rawKeyring();
    // The key the blob names first; the rest only as a fallback.
    const ordered = [...ring.filter((k) => keyId(k) === kid), ...ring.filter((k) => keyId(k) !== kid)];
    for (const raw of ordered) {
      const key = v2Key(raw);
      const out = (aad !== undefined ? open(key, iv, tag, ct, aad) : null) ?? open(key, iv, tag, ct);
      if (out !== null) return out;
    }
    throw new CredentialUnreadableError();
  }
  if (parts.length !== 3) throw new CredentialUnreadableError();
  const iv = b64(parts[0]);
  const tag = b64(parts[1]);
  const ct = b64(parts[2]);
  if (!iv || !tag || !ct || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialUnreadableError();
  for (const raw of rawKeyring()) {
    const out = open(legacyKey(raw), iv, tag, ct);
    if (out !== null) return out;
  }
  throw new CredentialUnreadableError();
}

export function encryptJson(obj: unknown, aad?: string) {
  return encrypt(JSON.stringify(obj), aad);
}

let lastUnreadableWarning = 0;
/**
 * Lenient read: null for "nothing stored" AND for "stored but unreadable". Kept because
 * existing callers depend on it, but the second case is logged, because a caller that treats
 * null as "no config" goes on to act with empty credentials. Prefer decryptJsonStrict.
 */
export function decryptJson<T = Record<string, unknown>>(blob: string | null | undefined, aad?: string): T | null {
  if (!blob) return null;
  try {
    return JSON.parse(decrypt(blob, aad)) as T;
  } catch {
    const now = Date.now();
    if (now - lastUnreadableWarning > 60_000) {
      lastUnreadableWarning = now;
      console.warn("[crypto] a stored credential could not be decrypted (wrong/rotated ENCRYPTION_KEY or damaged value). The caller is treating it as absent. If ENCRYPTION_KEY or JWT_SECRET was changed, list the previous value in ENCRYPTION_KEYS_OLD.");
    }
    return null;
  }
}

/**
 * Strict read: null ONLY when nothing is stored. A blob that is present but cannot be
 * decrypted or parsed throws CredentialUnreadableError, so "no config" and "cannot read the
 * config" stop looking the same to the caller.
 */
export function decryptJsonStrict<T = Record<string, unknown>>(blob: string | null | undefined, aad?: string): T | null {
  if (!blob) return null;
  const plain = decrypt(blob, aad);
  try {
    return JSON.parse(plain) as T;
  } catch {
    throw new CredentialUnreadableError("A stored credential decrypted but is not valid JSON; the stored value is damaged. Re-enter the credential.");
  }
}

export function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacSign(secret: string, payload: string) {
  return createHash("sha256").update(`${secret}.${payload}`).digest("hex");
}

/**
 * Webhook signature v2: a real HMAC-SHA256.
 *
 * `hmacSign` above is sha256(secret + "." + payload), which is not an HMAC and is open to
 * length extension - a holder of one valid signature can forge one for payload+suffix
 * without the secret. It stays for hooks created before v2 (changing it would break every
 * customer's existing verifier); new and rotated hooks use this.
 */
export function hmacSignV2(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
