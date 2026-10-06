import { and, companies, consume, eq, getDb, leads, sql, type Company, type Lead, type NewLead } from "@prospex/db";
import type { CompanyProfile, PipelineLead } from "@prospex/core";
import { extractDomain, inferDepartment, inferSeniority, isPublicHost, splitName } from "@prospex/core";
import { emitEvent } from "../lib/events.js";
import { tryConsume, type QuotaOutcome } from "../lib/quota.js";
import { httpUrlOrNull, stripNul } from "../lib/sanitize.js";
import { addressFingerprint, onPlatformList } from "../lib/privacySuppression.js";
import { errorLine } from "../lib/errors.js";

/**
 * The one definition of "an email address we will store and later send to".
 *
 * POST /v1/leads validated its email with zod. The CSV/JSON import, the pipeline, the pixel
 * and every tool that saves a lead did not - they shared a `\S+@\S+\.\S+` check or none -
 * so `a@x.com,b@x.com,c@x.com` and `"x" <victim@x.com>` were stored as a lead's email and
 * later handed to the mailer as the recipient: one "lead" mailed three people, and one of
 * them could be an address on the suppression list.
 *
 * Returns the trimmed, lower-cased address when `raw` is exactly ONE bare `local@domain`:
 * no whitespace, comma, semicolon, angle brackets, quotes, parentheses or display name; at
 * most 254 characters (64 for the local part); a dotted domain of ordinary labels. Anything
 * else - including a non-string - is null.
 */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)[a-z0-9_'+\-.]*[a-z0-9_+\-]@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
export function canonicalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!EMAIL_RE.test(s)) return null;
  if (s.indexOf("@") > 64) return null;
  return s;
}

/**
 * A company domain we are willing to create a company row for (and later crawl): a real
 * dotted hostname. Not an IP address, not `host:port`, not a path, not an internal name.
 * Accepts a bare domain or a URL and returns the registrable-looking host, or null.
 */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
export function companyDomainOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = stripNul(raw).trim();
  if (!s || s.length > 300) return null;
  const d = extractDomain(s);
  if (!d || d.length > 253 || !DOMAIN_RE.test(d)) return null;
  if (!isPublicHost(d)) return null;
  return d;
}

/** http(s) URL or null. Re-exported here so every lead writer imports one module. */
export const safeHttpUrl = httpUrlOrNull;

/**
 * A profile link as stored: http(s), or null.
 *
 * Scrapes and spreadsheets often carry "linkedin.com/in/jane" with no scheme; that is a web
 * address, so it gets https://. Anything with a different scheme (`javascript:`, `data:`)
 * or that is not a URL at all is null.
 */
export function profileUrlOrNull(raw: unknown, maxLength = 500): string | null {
  if (typeof raw !== "string") return null;
  const s = stripNul(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(s)) return httpUrlOrNull(`https://${s}`, maxLength);
  return httpUrlOrNull(s, maxLength);
}

export interface UpsertCompanyOptions {
  /**
   * Replace the company's existing name.
   *
   * A company row is shared by every lead at that domain, and its name used to be
   * overwritten by whatever arrived last: one import row with `company = "RENAMED"` (or one
   * unauthenticated pixel hit) renamed the company for every lead there. A name that
   * arrives ON ITS OWN now only ever fills an empty one.
   *
   * A name that arrives as part of a crawled profile - the company's own site, read by
   * crawlCompanyWebsite, which always carries `emailsFound`/`socials` and usually a
   * description - is the authoritative one and may still replace a placeholder; that is
   * detected from the data, so the enrichment jobs behave as before. Pass `rename` to say
   * so explicitly either way.
   */
  rename?: boolean;
}

/** Is this the output of a crawl (or a provider's company record), not a bare typed name? */
const isProfile = (d: Partial<CompanyProfile>) => d.description != null || d.techStack != null || d.emailsFound != null || d.socials != null || d.industry != null;

export async function upsertCompany(orgId: string, domain: string, data: Partial<CompanyProfile> & { name?: string | null }, opts: UpsertCompanyOptions = {}): Promise<Company> {
  const { db } = getDb();
  const name = typeof data.name === "string" && data.name.trim() ? stripNul(data.name).trim().slice(0, 200) : undefined;
  const values = {
    orgId,
    domain,
    name,
    description: data.description ?? undefined,
    industry: data.industry ?? undefined,
    size: data.size ?? undefined,
    location: data.location ?? undefined,
    country: data.country ?? undefined,
    website: `https://${domain}`,
    linkedinUrl: data.linkedinUrl ? httpUrlOrNull(data.linkedinUrl) ?? undefined : undefined,
    foundedYear: data.foundedYear ?? undefined,
    techStack: data.techStack ?? undefined,
    emailPattern: data.emailPattern ?? undefined,
    mxValid: data.mxValid ?? undefined,
    catchAll: data.catchAll ?? undefined,
    // `[]` and `{}` are truthy, and crawlCompanyWebsite always returns both, so this used
    // to overwrite `raw` on EVERY call - including one where the crawl reached nothing.
    // The harvested emailsFound list is what findEmail uses as knownEmails to infer a
    // domain's address pattern, so wiping it silently degrades every later email discovery
    // for that company to guessing. Only write it when there is something to write.
    raw: data.emailsFound?.length || Object.keys(data.socials ?? {}).length ? { emailsFound: data.emailsFound ?? [], socials: data.socials ?? {} } : undefined,
    enrichedAt: data.description || data.techStack?.length ? new Date() : undefined,
    updatedAt: new Date(),
  };
  const set: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && !["orgId", "domain"].includes(k)));
  // Fill-only unless this is a profile or the caller asked to rename: keep a name that is
  // already there.
  const rename = opts.rename ?? isProfile(data);
  if (name !== undefined && !rename) set.name = sql`coalesce(nullif(${companies.name}, ''), ${name})`;
  const [row] = await db
    .insert(companies)
    .values(values)
    .onConflictDoUpdate({ target: [companies.orgId, companies.domain], set })
    .returning();
  return row;
}

export interface UpsertLeadInput {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  email?: string | null;
  emailStatus?: string | null;
  emailConfidence?: number | null;
  /** Which verifier vouched for `email`; undefined for an unverified guess. */
  emailVerifiedBy?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  location?: string | null;
  country?: string | null;
  source?: string;
  companyDomain?: string | null;
  companyName?: string | null;
  companyData?: Partial<CompanyProfile>;
  icpId?: string | null;
  score?: number | null;
  scoreReasons?: string[];
  tags?: string[];
  custom?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

/** Email statuses that say the address is not known to work. */
const WEAK_EMAIL = new Set(["invalid", "unknown"]);

export interface UpsertLeadOptions {
  /**
   * Treat the input as a rediscovery, not an edit.
   *
   * Searches, autopilots, saved searches, signals and the discovery agent keep finding
   * people the org already has. Their data is a scrape, and it used to be written OVER the
   * lead: a title the user had corrected went back to whatever the snippet said, tags the
   * user had added were replaced, custom fields were dropped, and a worse email could
   * replace a verified one. With `fillOnly`, a rediscovery only fills what is empty, and
   * an email is only replaced by a verified one when the current one is known bad or
   * unchecked. Manual edits, API writes and imports keep their authoritative overwrite.
   */
  fillOnly?: boolean;
}

/** Find the lead an upsert would update, without writing anything. */
export async function findExistingLead(orgId: string, input: { email?: string | null; linkedinUrl?: string | null }): Promise<Lead | undefined> {
  const { db } = getDb();
  const email = canonicalEmail(input.email);
  let existing: Lead | undefined;
  if (email) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, email)) });
  if (!existing && input.linkedinUrl) {
    existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.linkedinUrl, input.linkedinUrl)) });
    // Imports used to store a URL exactly as typed, often without a scheme
    // ("linkedin.com/in/x"). The import now adds https://, so the older spelling is tried
    // too - otherwise re-importing the same file would duplicate those leads.
    const bare = input.linkedinUrl.replace(/^https?:\/\//i, "");
    if (!existing && bare !== input.linkedinUrl && bare) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.linkedinUrl, bare)) });
  }
  return existing;
}

/** Longest value stored in each free-text lead column; anything longer is cut, not refused. */
const FIELD_MAX = { firstName: 200, lastName: 200, fullName: 200, title: 300, phone: 100, location: 300, country: 100 } as const;
const clip = (v: string | null | undefined, max: number): string | null | undefined => (typeof v === "string" ? stripNul(v).slice(0, max) : v);

/**
 * Idempotent lead upsert keyed on (org, email) or (org, linkedin). Emits lead.created / lead.updated.
 *
 * This is the last line of defence for every writer (routes, import, pipeline, pixel,
 * tools, agents): whatever the caller did or did not validate, an email that is not one
 * canonical address is NOT stored (the reason is kept in `raw.emailRejected` and returned
 * as `emailRejected`), a LinkedIn URL that is not http(s) is not stored, and a company is
 * only created for a real public domain.
 */
/** Why an address was not stored: its owner asked never to be contacted through Scout. */
export const DO_NOT_CONTACT_REASON = "this person has asked not to be contacted through Scout, so their address was not stored";

export async function upsertLead(orgId: string, rawInput: UpsertLeadInput, opts: UpsertLeadOptions = {}): Promise<{ lead: Lead; created: boolean; emailRejected?: string }> {
  const { db } = getDb();
  const input: UpsertLeadInput = {
    ...rawInput,
    firstName: clip(rawInput.firstName, FIELD_MAX.firstName),
    lastName: clip(rawInput.lastName, FIELD_MAX.lastName),
    fullName: clip(rawInput.fullName, FIELD_MAX.fullName),
    title: clip(rawInput.title, FIELD_MAX.title),
    phone: clip(rawInput.phone, FIELD_MAX.phone),
    location: clip(rawInput.location, FIELD_MAX.location),
    country: clip(rawInput.country, FIELD_MAX.country),
  };
  const email = canonicalEmail(input.email);
  // Something was offered as an email and it is not one address: say so, store nothing.
  const offered = typeof input.email === "string" ? input.email.trim() : input.email == null ? "" : String(input.email);
  /**
   * An address on the platform-wide do-not-contact list is not stored again.
   *
   * That list holds people who asked us - not one customer - to stop: an erasure request
   * removes them from every workspace and puts the address there. Without this, the next
   * import or search simply brought the address back. It is still used to FIND a lead the
   * workspace already has (so an import does not create a duplicate); it is never written,
   * and it is not copied into the "rejected" note either.
   */
  const doNotContact = !!email && (await onPlatformList(email, db).catch(() => false));
  const emailRejected = offered && !email ? "not a single valid email address" : doNotContact ? DO_NOT_CONTACT_REASON : undefined;
  const linkedin = input.linkedinUrl ? profileUrlOrNull(input.linkedinUrl, 500) : null;

  let companyId: string | null = null;
  const companyDomain = input.companyDomain ? companyDomainOrNull(input.companyDomain) : null;
  if (companyDomain) {
    const c = await upsertCompany(orgId, companyDomain, { ...(input.companyData ?? {}), name: input.companyData?.name ?? input.companyName ?? undefined });
    companyId = c.id;
  }
  const nm = input.fullName ? splitName(input.fullName) : { firstName: input.firstName ?? undefined, lastName: input.lastName ?? undefined, fullName: [input.firstName, input.lastName].filter(Boolean).join(" ") };

  let existing = await findExistingLead(orgId, { email, linkedinUrl: linkedin });
  // A do-not-contact address is not stored, so a second import of the same row has no address
  // to be recognised by - and would add the same person again each time. The row left by the
  // first import carries a one-way fingerprint of the address; it is found by that.
  const fingerprint = doNotContact && email ? addressFingerprint(email) : null;
  if (!existing && fingerprint) {
    const [same] = await db.select().from(leads).where(and(eq(leads.orgId, orgId), sql`${leads.raw}->'emailRejected'->>'fingerprint' = ${fingerprint}`)).limit(1);
    existing = same ?? undefined;
  }

  const values: Partial<NewLead> = {
    firstName: input.firstName ?? nm.firstName,
    lastName: input.lastName ?? nm.lastName,
    // `null`, unlike `undefined`, survives the `clean` filter below and is written. A
    // caller with only an email and a title - a perfectly ordinary CSV row - therefore
    // BLANKED the stored full name of an existing lead. An update must never replace a
    // real value with nothing; it just has nothing to say about that field.
    fullName: nm.fullName || undefined,
    title: input.title ?? undefined,
    seniority: inferSeniority(input.title ?? undefined),
    department: inferDepartment(input.title ?? undefined),
    email: doNotContact ? undefined : email ?? undefined,
    // A verdict describes an address. With the address refused, there is nothing it is about.
    emailStatus: emailRejected ? undefined : input.emailStatus ?? undefined,
    emailConfidence: emailRejected ? undefined : input.emailConfidence ?? undefined,
    emailVerifiedBy: emailRejected ? undefined : input.emailVerifiedBy ?? undefined,
    linkedinUrl: linkedin ?? undefined,
    phone: input.phone ?? undefined,
    location: input.location ?? undefined,
    country: input.country ?? undefined,
    companyId: companyId ?? undefined,
    icpId: input.icpId ?? undefined,
    score: typeof input.score === "number" && Number.isFinite(input.score) ? Math.min(100, Math.max(0, Math.round(input.score))) : undefined,
    scoreReasons: input.scoreReasons ?? undefined,
    tags: input.tags ?? undefined,
    custom: input.custom ?? undefined,
    raw: input.raw ?? undefined,
    verifiedAt: !emailRejected && input.emailStatus && input.emailStatus !== "unknown" ? new Date() : undefined,
    updatedAt: new Date(),
  };
  const rejectedNote = emailRejected ? { emailRejected: { reason: emailRejected, ...(doNotContact ? { fingerprint } : { value: stripNul(offered).slice(0, 120) }), at: new Date().toISOString() } } : null;
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<NewLead>;

  if (existing) {
    // don't downgrade a verified email to unknown
    if (existing.emailStatus === "valid" && clean.emailStatus && clean.emailStatus !== "valid" && clean.email === existing.email) delete clean.emailStatus;

    if (opts.fillOnly) {
      // A rediscovery merges tags and custom fields, never replaces them. Replacing dropped
      // every tag a user had added (and every `search:`/`saved:` provenance tag from earlier
      // runs) the moment the same person turned up again, and wiped custom fields such as
      // `invalidEmails` that exist precisely so a bad address is never resurrected.
      // Manual edits, API writes and imports (no fillOnly) still overwrite: that is how a
      // caller removes a tag.
      if (clean.tags) clean.tags = [...new Set([...(existing.tags ?? []), ...clean.tags])];
      if (clean.custom) clean.custom = { ...(existing.custom ?? {}), ...clean.custom };

      // Scalar fields: only fill what is empty. A rediscovery is a scrape and must not undo
      // a correction a person made.
      const fillable = ["firstName", "lastName", "fullName", "title", "seniority", "department", "linkedinUrl", "phone", "location", "country", "companyId", "icpId"] as const;
      for (const k of fillable) {
        if (clean[k] !== undefined && existing[k] !== null && existing[k] !== undefined && existing[k] !== "") delete clean[k];
      }
      // A score of 0 is the column default, i.e. "never scored", so a real score may fill it.
      if (existing.score) {
        delete clean.score;
        delete clean.scoreReasons;
      }
      if (existing.raw && Object.keys(existing.raw).length) delete clean.raw;
      // Email: only replace one that is known bad or never checked, and only with a
      // verified one. Otherwise the address and everything describing it stay as they are.
      const replacingEmail = clean.email !== undefined && clean.email !== existing.email;
      const emailUpgrade = replacingEmail && (!existing.email || (WEAK_EMAIL.has(existing.emailStatus) && clean.emailStatus === "valid"));
      if (replacingEmail && !emailUpgrade) {
        delete clean.email;
        delete clean.emailStatus;
        delete clean.emailConfidence;
        delete clean.emailVerifiedBy;
        delete clean.verifiedAt;
      }
    }

    // Never take another lead's address. The (org, email) index is unique, and a match by
    // LinkedIn URL carrying an email that a DIFFERENT lead already has used to throw a
    // unique violation that failed the whole search.run it happened inside.
    if (clean.email && clean.email !== existing.email) {
      const owner = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, clean.email)) });
      if (owner && owner.id !== existing.id) {
        delete clean.email;
        delete clean.emailStatus;
        delete clean.emailConfidence;
        delete clean.emailVerifiedBy;
        delete clean.verifiedAt;
      }
    }

    // (No note when the workspace already holds this address on this lead: nothing was refused.)
    if (rejectedNote && !(doNotContact && existing.email === email)) clean.raw = { ...((existing.raw as Record<string, unknown> | null) ?? {}), ...((clean.raw as Record<string, unknown> | undefined) ?? {}), ...rejectedNote };
    const [row] = await db.update(leads).set(clean).where(eq(leads.id, existing.id)).returning();
    await emitEvent(orgId, "lead.updated", { id: row.id, email: row.email, changes: Object.keys(clean) }, { type: "lead", id: row.id });
    return { lead: row, created: false, ...(emailRejected ? { emailRejected } : {}) };
  }
  if (rejectedNote) clean.raw = { ...((clean.raw as Record<string, unknown> | undefined) ?? {}), ...rejectedNote };
  const [row] = await db
    .insert(leads)
    .values({ ...clean, orgId, source: stripNul(input.source ?? "manual").slice(0, 100) } as NewLead)
    .returning();
  await emitEvent(orgId, "lead.created", { id: row.id, email: row.email, fullName: row.fullName, title: row.title, score: row.score }, { type: "lead", id: row.id });
  return { lead: row, created: true, ...(emailRejected ? { emailRejected } : {}) };
}

/**
 * Charge for one newly saved lead: the leads quota, plus the premium sub-quota when it
 * came from a paid provider.
 *
 * The premium charge is recorded even past its limit (`allowOverage`): the provider was
 * already paid by the time we know, and the old `.catch(() => {})` meant it was silently
 * not recorded at all. A plan limit and a database fault come back as different answers.
 */
export async function chargeNewLead(orgId: string, source?: string | null): Promise<QuotaOutcome> {
  const { db } = getDb();
  const charge = await tryConsume(db, orgId, "leads", 1);
  if (!charge.ok) return charge;
  if (source?.startsWith("provider:")) {
    await consume(db, orgId, "premiumLeads", 1, { allowOverage: true }).catch((e) => console.warn(`[leads] premium usage not recorded for ${orgId}: ${errorLine(e)}`));
  }
  return charge;
}

export function pipelineLeadToInput(p: PipelineLead, extra: Partial<UpsertLeadInput> = {}): UpsertLeadInput {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    fullName: p.fullName,
    title: p.title,
    email: p.email,
    emailStatus: p.emailStatus,
    emailConfidence: p.emailConfidence,
    // Read loosely so this compiles against a core that predates the field.
    emailVerifiedBy: (p as { emailVerifiedBy?: string }).emailVerifiedBy,
    linkedinUrl: p.linkedinUrl,
    location: p.location,
    source: p.source,
    companyDomain: p.companyDomain,
    companyName: p.companyName,
    companyData: p.company,
    score: p.score,
    scoreReasons: p.scoreReasons,
    raw: { snippet: p.snippet, confidence: p.confidence },
    ...extra,
  };
}

export async function leadWithCompany(orgId: string, id: string) {
  const { db } = getDb();
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, id), eq(leads.orgId, orgId)) });
  if (!lead) return null;
  const company = lead.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, lead.companyId), eq(companies.orgId, orgId)) }) : null;
  return { ...lead, company: company ?? null };
}

export async function countLeads(orgId: string) {
  const { db } = getDb();
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.orgId, orgId));
  return r.n;
}

/**
 * Which verifier gave this verdict, for leads.email_verified_by. Null when no external
 * verifier or SMTP probe actually answered (a syntax rule or "probe disabled" is not a
 * verification, and must not be stamped as one).
 */
export function verifierOf(v: { reason?: string | null; verifiedBy?: string | null }): string | null {
  const by = v.verifiedBy ?? "";
  if (/^(reoon|millionverifier|hunter|abstract):/i.test(by) || by === "smtp") return by.slice(0, 80);
  if (by) return null; // a local check ("syntax", "dns", "mx-only") is not a verification
  const r = v.reason ?? "";
  if (/^(reoon|millionverifier|hunter|abstract):/i.test(r)) return r.slice(0, 80);
  if (/^SMTP (accepted|rejected)/.test(r)) return "smtp";
  return null;
}
