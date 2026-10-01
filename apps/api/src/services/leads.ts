import { and, companies, consume, eq, getDb, leads, sql, type Company, type Lead, type NewLead } from "@prospex/db";
import type { CompanyProfile, PipelineLead } from "@prospex/core";
import { inferDepartment, inferSeniority, splitName } from "@prospex/core";
import { emitEvent } from "../lib/events.js";
import { tryConsume, type QuotaOutcome } from "../lib/quota.js";

export async function upsertCompany(orgId: string, domain: string, data: Partial<CompanyProfile> & { name?: string | null }): Promise<Company> {
  const { db } = getDb();
  const values = {
    orgId,
    domain,
    name: data.name ?? undefined,
    description: data.description ?? undefined,
    industry: data.industry ?? undefined,
    size: data.size ?? undefined,
    location: data.location ?? undefined,
    country: data.country ?? undefined,
    website: `https://${domain}`,
    linkedinUrl: data.linkedinUrl ?? undefined,
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
  const [row] = await db
    .insert(companies)
    .values(values)
    .onConflictDoUpdate({
      target: [companies.orgId, companies.domain],
      set: Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && !["orgId", "domain"].includes(k))),
    })
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
  const email = input.email?.trim().toLowerCase() || null;
  let existing: Lead | undefined;
  if (email) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, email)) });
  if (!existing && input.linkedinUrl) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.linkedinUrl, input.linkedinUrl)) });
  return existing;
}

/** Idempotent lead upsert keyed on (org, email) or (org, linkedin). Emits lead.created / lead.updated. */
export async function upsertLead(orgId: string, input: UpsertLeadInput, opts: UpsertLeadOptions = {}): Promise<{ lead: Lead; created: boolean }> {
  const { db } = getDb();
  let companyId: string | null = null;
  if (input.companyDomain) {
    const c = await upsertCompany(orgId, input.companyDomain, { ...(input.companyData ?? {}), name: input.companyData?.name ?? input.companyName ?? undefined });
    companyId = c.id;
  }
  const nm = input.fullName ? splitName(input.fullName) : { firstName: input.firstName ?? undefined, lastName: input.lastName ?? undefined, fullName: [input.firstName, input.lastName].filter(Boolean).join(" ") };
  const email = input.email?.trim().toLowerCase() || null;
  const linkedin = input.linkedinUrl || null;

  const existing = await findExistingLead(orgId, { email, linkedinUrl: linkedin });

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
    email: email ?? undefined,
    emailStatus: input.emailStatus ?? undefined,
    emailConfidence: input.emailConfidence ?? undefined,
    emailVerifiedBy: input.emailVerifiedBy ?? undefined,
    linkedinUrl: linkedin ?? undefined,
    phone: input.phone ?? undefined,
    location: input.location ?? undefined,
    country: input.country ?? undefined,
    companyId: companyId ?? undefined,
    icpId: input.icpId ?? undefined,
    score: input.score ?? undefined,
    scoreReasons: input.scoreReasons ?? undefined,
    tags: input.tags ?? undefined,
    custom: input.custom ?? undefined,
    raw: input.raw ?? undefined,
    verifiedAt: input.emailStatus && input.emailStatus !== "unknown" ? new Date() : undefined,
    updatedAt: new Date(),
  };
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<NewLead>;

  if (existing) {
    // don't downgrade a verified email to unknown
    if (existing.emailStatus === "valid" && clean.emailStatus && clean.emailStatus !== "valid" && clean.email === existing.email) delete clean.emailStatus;

    // Tags and custom fields are merged, never replaced. Replacing them dropped every tag
    // a user had added (and every `search:`/`saved:` provenance tag from earlier runs) the
    // moment the same person turned up again, and wiped custom fields such as
    // `invalidEmails` that exist precisely so a bad address is never resurrected.
    if (clean.tags) clean.tags = [...new Set([...(existing.tags ?? []), ...clean.tags])];
    if (clean.custom) clean.custom = { ...(existing.custom ?? {}), ...clean.custom };

    if (opts.fillOnly) {
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

    const [row] = await db.update(leads).set(clean).where(eq(leads.id, existing.id)).returning();
    await emitEvent(orgId, "lead.updated", { id: row.id, email: row.email, changes: Object.keys(clean) }, { type: "lead", id: row.id });
    return { lead: row, created: false };
  }
  const [row] = await db
    .insert(leads)
    .values({ ...clean, orgId, source: input.source ?? "manual" } as NewLead)
    .returning();
  await emitEvent(orgId, "lead.created", { id: row.id, email: row.email, fullName: row.fullName, title: row.title, score: row.score }, { type: "lead", id: row.id });
  return { lead: row, created: true };
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
    await consume(db, orgId, "premiumLeads", 1, { allowOverage: true }).catch((e) => console.warn(`[leads] premium usage not recorded for ${orgId}: ${(e as Error).message}`));
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
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  return { ...lead, company: company ?? null };
}

export async function countLeads(orgId: string) {
  const { db } = getDb();
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.orgId, orgId));
  return r.n;
}
