import { createHash, createHmac, hkdfSync } from "node:crypto";
import { env } from "../env.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * What the visitor pixel is allowed to keep about a person.
 *
 * Three rules, each of which the pixel used to break:
 *
 *  1. A visitor's IP address is needed for one lookup and for nothing after it. It was kept
 *     in clear in the job queue next to the visit it belonged to. It now travels in the job
 *     encrypted, and the job row is scrubbed when the job ends.
 *  2. The stored "IP hash" was sha256(ip:pixelId). The pixel id sits in the same database,
 *     and there are only four billion IPv4 addresses, so anyone who could read the table
 *     could read the addresses back in seconds. It is now keyed with a secret that is not in
 *     the database.
 *  3. Page addresses and referrers were stored with their query strings, which is where
 *     password-reset tokens, email addresses and search terms live.
 */

/** Marks a keyed hash. The legacy value is 64 hex characters and never starts with this. */
export const KEYED_IP_HASH_PREFIX = "k1_";

let cachedKey: Buffer | null = null;
let cachedFor = "";
/** The hashing key: derived from the server's encryption secret, used for nothing else. */
function ipHashKey(): Buffer {
  const raw = env.encryptionKey || env.jwtSecret;
  if (!cachedKey || cachedFor !== raw) {
    cachedKey = Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), "scout:visitor-ip-hash:v1", 32));
    cachedFor = raw;
  }
  return cachedKey;
}

/** The hash as it was stored before: unkeyed, and so reversible by anyone holding the pixel id. */
export const legacyIpHash = (ip: string, pixelId: string) => createHash("sha256").update(`${ip}:${pixelId}`).digest("hex");

export const isKeyedIpHash = (h: string | null | undefined) => typeof h === "string" && h.startsWith(KEYED_IP_HASH_PREFIX);

/**
 * The keyed form of a legacy hash.
 *
 * Keyed OVER the legacy value on purpose: rows stored before this change hold only the
 * legacy hash (the address itself is long gone), and this lets them be converted in place.
 * A returning visitor's new rows therefore carry exactly the value their old rows are
 * converted to - nothing is orphaned and nobody is counted twice.
 */
export const keyedFromLegacy = (legacy: string) => `${KEYED_IP_HASH_PREFIX}${createHmac("sha256", ipHashKey()).update(legacy).digest("hex")}`;

/** What is stored with a visit. Per pixel, so it cannot be matched across customers' sites. */
export const visitorIpHash = (ip: string, pixelId: string) => keyedFromLegacy(legacyIpHash(ip, pixelId));

/**
 * A page address or referrer without its query string or fragment.
 * `/reset?token=abc#x` -> `/reset`; `https://mail.example/inbox?q=jane` -> `https://mail.example/inbox`.
 */
export function withoutQuery(value: string | null | undefined, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  const cut = s.search(/[?#]/);
  return (cut === -1 ? s : s.slice(0, cut)).slice(0, max);
}

/** Did the browser ask not to be tracked? Global Privacy Control, or the older Do Not Track. */
export function asksNotToBeTracked(header: (name: string) => string | undefined): boolean {
  return header("sec-gpc")?.trim() === "1" || header("dnt")?.trim() === "1";
}

const SEAL_AAD = "job:visit.identify";

/** The parts of a visit.identify job that are personal data, as one encrypted value. */
export function sealVisitorJob(v: { ip: string; identify?: Record<string, unknown> | null }): string {
  return encrypt(JSON.stringify({ ip: v.ip, identify: v.identify ?? null }), SEAL_AAD);
}

/**
 * Read a visit.identify payload: the sealed form, or - for jobs queued by the release before
 * this one - the fields in clear. `ip` is null when nothing readable is left (already
 * scrubbed, or sealed under a key this server no longer has).
 */
export function openVisitorJob(payload: Record<string, unknown>): { ip: string | null; identify: Record<string, unknown> | null } {
  if (typeof payload.sealed === "string" && payload.sealed) {
    try {
      const v = JSON.parse(decrypt(payload.sealed, SEAL_AAD)) as { ip?: unknown; identify?: unknown };
      return {
        ip: typeof v.ip === "string" && v.ip ? v.ip : null,
        identify: v.identify && typeof v.identify === "object" && !Array.isArray(v.identify) ? (v.identify as Record<string, unknown>) : null,
      };
    } catch {
      return { ip: null, identify: null };
    }
  }
  const identify = payload.identify && typeof payload.identify === "object" && !Array.isArray(payload.identify) ? (payload.identify as Record<string, unknown>) : null;
  return { ip: typeof payload.ip === "string" && payload.ip ? payload.ip : null, identify };
}
