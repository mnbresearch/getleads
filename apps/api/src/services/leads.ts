import { and, companies, eq, getDb, leads, sql, type Company, type Lead, type NewLead } from "@prospex/db";
import type { CompanyProfile, PipelineLead } from "@prospex/core";
import { inferDepartment, inferSeniority, splitName } from "@prospex/core";
import { emitEvent } from "../lib/events.js";

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
    raw: data.emailsFound || data.socials ? { emailsFound: data.emailsFound ?? [], socials: data.socials ?? {} } : undefined,
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

/** Idempotent lead upsert keyed on (org, email) or (org, linkedin). Emits lead.created / lead.updated. */
export async function upsertLead(orgId: string, input: UpsertLeadInput): Promise<{ lead: Lead; created: boolean }> {
  const { db } = getDb();
  let companyId: string | null = null;
  if (input.companyDomain) {
    const c = await upsertCompany(orgId, input.companyDomain, { ...(input.companyData ?? {}), name: input.companyData?.name ?? input.companyName ?? undefined });
    companyId = c.id;
  }
  const nm = input.fullName ? splitName(input.fullName) : { firstName: input.firstName ?? undefined, lastName: input.lastName ?? undefined, fullName: [input.firstName, input.lastName].filter(Boolean).join(" ") };
  const email = input.email?.trim().toLowerCase() || null;
  const linkedin = input.linkedinUrl || null;

  let existing: Lead | undefined;
  if (email) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, email)) });
  if (!existing && linkedin) existing = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.linkedinUrl, linkedin)) });

  const values: Partial<NewLead> = {
    firstName: input.firstName ?? nm.firstName,
    lastName: input.lastName ?? nm.lastName,
    fullName: nm.fullName || null,
    title: input.title ?? undefined,
    seniority: inferSeniority(input.title ?? undefined),
    department: inferDepartment(input.title ?? undefined),
    email: email ?? undefined,
    emailStatus: input.emailStatus ?? undefined,
    emailConfidence: input.emailConfidence ?? undefined,
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

export function pipelineLeadToInput(p: PipelineLead, extra: Partial<UpsertLeadInput> = {}): UpsertLeadInput {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    fullName: p.fullName,
    title: p.title,
    email: p.email,
    emailStatus: p.emailStatus,
    emailConfidence: p.emailConfidence,
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
