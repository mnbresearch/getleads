/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), and recovery codes.
 *
 * Written against node:crypto rather than a package: the algorithm is thirty lines, it sits
 * on the sign-in path, and a dependency there is one more thing that can change under us.
 * The parameters are the ones every authenticator app assumes when a QR code does not say
 * otherwise: HMAC-SHA1, 6 digits, a 30-second step.
 *
 * Nothing in this file touches the database. The account-level rules (which step was used
 * last, which recovery codes are spent) live in lib/twoFactor.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./crypto.js";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of "now" that are accepted, for a phone whose clock is a little off. */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

// ── base32 (RFC 4648, the alphabet authenticator apps expect) ──

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32 as a person would paste it: either case, spaces or dashes between groups,
 * trailing "=" padding. Returns null for anything else - never a partial decode, because a
 * secret that silently lost a character is a secret no code will ever match.
 */
export function base32Decode(input: string): Buffer | null {
  if (typeof input !== "string") return null;
  const s = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!s || !/^[A-Z2-7]+$/.test(s)) return null;
  // Lengths that cannot come from whole bytes (1, 3 or 6 characters over a multiple of 8).
  if ([1, 3, 6].includes(s.length % 8)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── HOTP / TOTP ──

/** RFC 4226: the code for one counter value. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The time step a moment falls in. */
export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code an authenticator shows for this secret at this moment. */
export function totpCode(secretBase32: string, atMs: number = Date.now(), digits = TOTP_DIGITS): string | null {
  const key = base32Decode(secretBase32);
  if (!key) return null;
  return hotp(key, totpStep(atMs), digits);
}

/** A new secret: 20 random bytes (the HMAC-SHA1 block the RFC recommends), as base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Is this usable as a TOTP secret (base32 of at least 10 bytes)? */
export function isValidTotpSecret(secretBase32: string): boolean {
  const key = base32Decode(secretBase32);
  return !!key && key.length >= 10;
}

/** What a person typed, reduced to the digits: "123 456" and "123-456" are the same code. */
export function normaliseTotpCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits) ? digits : null;
}

/**
 * Check a code against a secret.
 *
 * Returns the time step the code belongs to, or null. The step matters to the caller: it is
 * what gets stored so the same code cannot be used a second time. `afterStep` is that stored
 * value - a step at or before it is not accepted, which is the replay rule.
 *
 * Every candidate step is computed and compared, in constant time, whether or not an earlier
 * one matched: how long this takes says nothing about which step (if any) was right.
 */
export function verifyTotp(secretBase32: string, code: unknown, opts: { atMs?: number; window?: number; afterStep?: number | null } = {}): number | null {
  const key = base32Decode(secretBase32);
  const presented = normaliseTotpCode(code);
  if (!key || !presented) return null;
  const now = totpStep(opts.atMs ?? Date.now());
  const window = opts.window ?? TOTP_WINDOW;
  const given = Buffer.from(presented);
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    if (step < 0) continue;
    const same = timingSafeEqual(Buffer.from(hotp(key, step)), given);
    const fresh = opts.afterStep === null || opts.afterStep === undefined || step > opts.afterStep;
    if (same && fresh && matched === null) matched = step;
  }
  return matched;
}

/** The link an authenticator app reads from a QR code. */
export function otpauthUrl(email: string, secretBase32: string, issuer = "Scout"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}`;
}

// ── Recovery codes ──

/**
 * 32 characters with no look-alikes: no "i", "l", "o" or "u" (Crockford's alphabet). A code
 * read off a printout and typed back cannot be mistyped into a different valid code by
 * confusing 0/o or 1/l - those are folded to the digit on the way in.
 */
const RECOVERY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_GROUPS = 3;
const RECOVERY_GROUP_LENGTH = 4;

/** One code, "xxxx-xxxx-xxxx": 12 characters of 5 bits each, 60 bits. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH);
  // 32 symbols and a byte's low five bits: every symbol is equally likely.
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31]);
  const groups: string[] = [];
  for (let i = 0; i < RECOVERY_GROUPS; i++) groups.push(chars.slice(i * RECOVERY_GROUP_LENGTH, (i + 1) * RECOVERY_GROUP_LENGTH).join(""));
  return groups.join("-");
}

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(generateRecoveryCode());
  return [...out];
}

/**
 * A typed recovery code in the one form it is stored under, or null when it cannot be one.
 * Case, spaces and missing dashes do not matter; "o" is read as 0 and "i"/"l" as 1.
 */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input
    .toLowerCase()
    .replace(/[\s-]/g, "")
    .replace(/o/g, "0")
    .replace(/[il]/g, "1");
  if (s.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s.match(new RegExp(`.{${RECOVERY_GROUP_LENGTH}}`, "g"))!.join("-");
}

/** What is stored for a recovery code: sha256 of its normalised form. 60 random bits need no slow hash. */
export function hashRecoveryCode(normalised: string): string {
  return sha256(normalised);
}
