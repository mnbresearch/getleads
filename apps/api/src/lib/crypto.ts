import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

function key() {
  const raw = env.encryptionKey || env.jwtSecret;
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM, output: base64(iv).base64(tag).base64(ct) */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(blob: string) {
  const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export function encryptJson(obj: unknown) {
  return encrypt(JSON.stringify(obj));
}
export function decryptJson<T = Record<string, unknown>>(blob: string | null | undefined): T | null {
  if (!blob) return null;
  try {
    return JSON.parse(decrypt(blob)) as T;
  } catch {
    return null;
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
