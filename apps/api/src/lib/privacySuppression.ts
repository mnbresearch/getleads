import { createHash } from "node:crypto";
import { and, eq, getDb, globalSuppressions, inArray, sql, suppressions, type Db } from "@prospex/db";

/**
 * Who must not be contacted, asked in one place.
 *
 * Two lists stop a send:
 *
 *  - the WORKSPACE's own do-not-contact list (`suppressions`): unsubscribes, bounces,
 *    complaints and addresses the workspace added by hand. It stops that workspace.
 *  - the PLATFORM list (`global_suppressions`): people who told us - not one customer - that
 *    they never want to hear from anyone using Scout. It stops every workspace.
 *
 * Every path that contacts a prospect asks `contactBlock` first: sequence emails, WhatsApp
 * steps, manual tasks (LinkedIn, calls), the reply box, and test sends to outsiders. Before
 * this file the check lived inside the email branch of one function, so a person who had
 * unsubscribed could still be sent a WhatsApp message by the same workspace.
 */

/** Lower-cased and trimmed; the form both lists store. Not a validator. */
const norm = (v: string) => v.trim().toLowerCase();

/**
 * The fingerprint an address is replaced with when the lead it belonged to is deleted.
 *
 * A deleted lead's messages no longer hold its address, but the unsubscribe link in an email
 * that was already sent must keep working. The message keeps this fingerprint instead; an
 * unsubscribe then stores the fingerprint on the workspace's list, and the send check below
 * compares against it too - so the opt-out survives the deletion without the address doing so.
 */
export const ADDRESS_FINGERPRINT_PREFIX = "sha256:";
export const addressFingerprint = (address: string) => `${ADDRESS_FINGERPRINT_PREFIX}${createHash("sha256").update(norm(address), "utf8").digest("hex")}`;
export const isAddressFingerprint = (v: string | null | undefined) => typeof v === "string" && v.startsWith(ADDRESS_FINGERPRINT_PREFIX);

/**
 * How an address field is shown to a customer.
 *
 * A fingerprint is bookkeeping: it means "the contact this belonged to was deleted". It is
 * never sent to the app as if it were an address - the field becomes null and
 * `recipientRemoved` says why, so a screen can read "a removed contact".
 */
export function shownAddress(stored: string | null | undefined): { address: string | null; recipientRemoved: boolean } {
  return isAddressFingerprint(stored) ? { address: null, recipientRemoved: true } : { address: stored ?? null, recipientRemoved: false };
}

/**
 * A security-log row as it may leave the server (the customer's log, the admin's log, the
 * workspace export).
 *
 * Some rows are keyed by a fingerprint of an address instead of the address: the "new sign-in
 * notice was sent" row (lib/securityMail.ts needs it to send one notice a day), and the
 * platform admin's do-not-contact and data-subject rows. The fingerprint is bookkeeping for
 * the server. Shown to a reader it is at best noise, and at worst a way to test a guess
 * ("is this row about sara@example.com?"), so it never goes out:
 *  - a `targetId` that is a fingerprint becomes null;
 *  - a fingerprint anywhere in `data` is dropped, and `<key>Hidden: true` says something was
 *    recorded there (`address` -> `addressHidden: true`).
 * The stored row is not changed.
 */
export function auditForResponse(targetId: string | null | undefined, data: unknown): { targetId: string | null; data: Record<string, unknown> } {
  const scrub = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && isAddressFingerprint(x))).map((x) => scrub(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && isAddressFingerprint(x)) out[`${k}Hidden`] = true;
      else out[k] = scrub(x, depth + 1);
    }
    return out;
  };
  const clean = scrub(data ?? {}, 0);
  return {
    targetId: isAddressFingerprint(targetId) ? null : (targetId ?? null),
    data: clean && typeof clean === "object" && !Array.isArray(clean) ? (clean as Record<string, unknown>) : {},
  };
}

/** Every form of these addresses that either list may hold: as given, and as a fingerprint. */
export function addressSpellings(addresses: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const a of addresses) {
    if (typeof a !== "string") continue;
    const n = norm(a);
    if (!n) continue;
    out.add(n);
    if (!isAddressFingerprint(n)) out.add(addressFingerprint(n));
  }
  return [...out];
}

export interface ContactBlock {
  /** Which list said no. */
  list: "workspace" | "platform" | "lead";
  /** The reason recorded on that list (`unsubscribe_link`, `bounce`, `request` ...). */
  reason: string;
  /** A sentence for the person looking at the stopped contact or the refused send. */
  message: string;
}

/**
 * The mailbox behind an address, for the PLATFORM list: the local part up to the first "+".
 *
 * `jane+news@acme.com` and `jane+2026@acme.com` are delivered to `jane@acme.com`. A person
 * who asked never to be contacted through Scout asked on behalf of that mailbox, so the
 * platform list is compared on this form - on both sides. Listing `jane@acme.com` blocks
 * every `jane+...@acme.com`, and listing `jane+news@acme.com` blocks `jane@acme.com` too.
 *
 * That is the whole rule. Nothing provider-specific is attempted (Gmail's dots, googlemail,
 * case-sensitive local parts): those differ per provider and guessing them wrong would
 * block the wrong person. A local part that starts with "+" is left as it is.
 *
 * `platformBaseSql` is the same rule in SQL; the two must stay in step.
 */
export function platformBase(address: string): string {
  return norm(address).replace(/^([^+@]+)\+[^@]*@/, "$1@");
}
const platformBaseSql = sql`regexp_replace(${globalSuppressions.email}, '^([^+@]+)\\+[^@]*@', '\\1@')`;

/** Is this address - or a plus-tagged variant of it - on the platform-wide do-not-contact list? */
export async function onPlatformList(address: string | null | undefined, db: Db = getDb().db): Promise<boolean> {
  if (typeof address !== "string" || !norm(address)) return false;
  const [row] = await db.select({ id: globalSuppressions.id }).from(globalSuppressions).where(sql`${platformBaseSql} = ${platformBase(address)}`).limit(1);
  return !!row;
}

/** Of these addresses, the ones the platform list blocks (returned as given, lower-cased). One query per 1,000. */
export async function platformListed(addresses: (string | null | undefined)[], db: Db = getDb().db): Promise<Set<string>> {
  const all = [...new Set(addresses.filter((a): a is string => typeof a === "string").map(norm).filter(Boolean))];
  const hit = new Set<string>();
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000);
    const bases = [...new Set(chunk.map(platformBase))];
    const rows = await db.select({ base: sql<string>`${platformBaseSql}` }).from(globalSuppressions).where(inArray(platformBaseSql, bases));
    const listed = new Set(rows.map((r) => r.base));
    for (const a of chunk) if (listed.has(platformBase(a))) hit.add(a);
  }
  return hit;
}

/** Of these addresses, the ones on this workspace's own list (matched as given or by fingerprint). */
export async function workspaceListed(orgId: string, addresses: (string | null | undefined)[], db: Db = getDb().db): Promise<Set<string>> {
  const all = [...new Set(addresses.filter((a): a is string => typeof a === "string").map(norm).filter(Boolean))];
  const hit = new Set<string>();
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const byFingerprint = new Map(chunk.map((a) => [addressFingerprint(a), a]));
    const rows = await db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(and(eq(suppressions.orgId, orgId), inArray(suppressions.email, [...chunk, ...byFingerprint.keys()])));
    for (const r of rows) hit.add(byFingerprint.get(r.email) ?? r.email);
  }
  return hit;
}

/**
 * May this workspace contact this person? Null when it may.
 *
 * `addresses` is every spelling of the person's email the caller holds (the canonical one
 * and the stored one). `leadStatus` is the lead's own status: "unsubscribed" blocks on its
 * own, which is what covers a lead with a phone number and no email.
 */
export async function contactBlock(orgId: string, addresses: (string | null | undefined)[], opts: { leadStatus?: string | null; db?: Db } = {}): Promise<ContactBlock | null> {
  const db = opts.db ?? getDb().db;
  const spellings = addressSpellings(addresses);
  if (spellings.length) {
    const [own] = await db
      .select({ reason: suppressions.reason })
      .from(suppressions)
      .where(and(eq(suppressions.orgId, orgId), inArray(suppressions.email, spellings)))
      .limit(1);
    if (own) return { list: "workspace", reason: own.reason, message: `Address is on the suppression list (${own.reason})` };
    const plain = spellings.filter((s) => !isAddressFingerprint(s));
    if (plain.length) {
      // Compared by mailbox, so a plus-tagged variant of a listed address is blocked too.
      const [everyone] = await db.select({ reason: globalSuppressions.reason }).from(globalSuppressions).where(inArray(platformBaseSql, [...new Set(plain.map(platformBase))])).limit(1);
      if (everyone) return { list: "platform", reason: everyone.reason, message: "This person has asked not to be contacted through Scout, so nothing is sent to them from any workspace" };
    }
  }
  if (opts.leadStatus === "unsubscribed") return { list: "lead", reason: "unsubscribed", message: "This lead has unsubscribed" };
  return null;
}
