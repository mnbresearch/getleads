import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, companies, consume, desc, enqueue, eq, getDb, ilike, inArray, leads, listLeads, lists, or, signals, sql, suppressions } from "@prospex/db";
import { verifyEmail, findEmail, extractDomain, computeLeadPriority } from "@prospex/core";
import { env } from "../env.js";
import { badRequest, notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { leadWithCompany, upsertLead } from "../services/leads.js";
import { emitEvent } from "../lib/events.js";

export const leadRoutes = new Hono<Env>();
leadRoutes.use("*", requireAuth);

const leadInput = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
  title: z.string().optional(),
  email: z.string().email().optional(),
  linkedinUrl: z.string().url().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  country: z.string().optional(),
  companyDomain: z.string().optional(),
  companyName: z.string().optional(),
  icpId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  custom: z.record(z.unknown()).optional(),
  source: z.string().optional(),
});

const listQuery = z.object({
  q: z.string().optional(),
  emailStatus: z.string().optional(),
  minScore: z.coerce.number().optional(),
  tag: z.string().optional(),
  icpId: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
  companyDomain: z.string().optional(),
  seniority: z.string().optional(),
  department: z.string().optional(),
  hasEmail: z.enum(["true", "false"]).optional(),
  sort: z.enum(["score", "created", "updated", "name"]).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
});

async function buildWhere(oid: string, q: z.infer<typeof listQuery>) {
  const conds = [eq(leads.orgId, oid)];
  if (q.q) conds.push(or(ilike(leads.fullName, `%${q.q}%`), ilike(leads.email, `%${q.q}%`), ilike(leads.title, `%${q.q}%`))!);
  if (q.emailStatus) conds.push(inArray(leads.emailStatus, q.emailStatus.split(",")));
  if (q.minScore !== undefined) conds.push(sql`${leads.score} >= ${q.minScore}`);
  if (q.tag) conds.push(sql`${q.tag} = ANY(${leads.tags})`);
  if (q.icpId) conds.push(eq(leads.icpId, q.icpId));
  if (q.seniority) conds.push(inArray(leads.seniority, q.seniority.split(",")));
  if (q.department) conds.push(inArray(leads.department, q.department.split(",")));
  if (q.hasEmail === "true") conds.push(sql`${leads.email} IS NOT NULL`);
  if (q.hasEmail === "false") conds.push(sql`${leads.email} IS NULL`);
  if (q.listId) conds.push(sql`${leads.id} IN (SELECT lead_id FROM list_leads WHERE list_id = ${q.listId})`);
  if (q.companyDomain) conds.push(sql`${leads.companyId} IN (SELECT id FROM companies WHERE org_id = ${oid} AND domain = ${q.companyDomain})`);
  return and(...conds);
}

leadRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const q = c.req.valid("query");
  const oid = orgId(c);
  const { db } = getDb();
  const where = await buildWhere(oid, q);
  const sortCol = { score: leads.score, created: leads.createdAt, updated: leads.updatedAt, name: leads.fullName }[q.sort];
  const rows = await db
    .select({ lead: leads, company: companies })
    .from(leads)
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(where)
    .orderBy(q.order === "asc" ? asc(sortCol) : desc(sortCol))
    .limit(q.limit)
    .offset(q.offset);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(where);
  return c.json({ leads: rows.map((r) => ({ ...r.lead, company: r.company })), total: n, limit: q.limit, offset: q.offset });
});

leadRoutes.get("/export.csv", zValidator("query", listQuery), async (c) => {
  const q = { ...c.req.valid("query"), limit: 5000, offset: 0 };
  const { db } = getDb();
  const rows = await db.select({ lead: leads, company: companies }).from(leads).leftJoin(companies, eq(leads.companyId, companies.id)).where(await buildWhere(orgId(c), q)).orderBy(desc(leads.score)).limit(5000);
  const cols = ["first_name", "last_name", "title", "email", "email_status", "email_confidence", "linkedin_url", "phone", "location", "company", "company_domain", "industry", "company_size", "score", "tags", "created_at"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")];
  for (const { lead: l, company: co } of rows) lines.push([l.firstName, l.lastName, l.title, l.email, l.emailStatus, l.emailConfidence, l.linkedinUrl, l.phone, l.location, co?.name, co?.domain, co?.industry, co?.size, l.score, l.tags.join(";"), l.createdAt.toISOString()].map(esc).join(","));
  c.header("content-type", "text/csv");
  c.header("content-disposition", `attachment; filename="leads-${Date.now()}.csv"`);
  return c.body(lines.join("\n"));
});

leadRoutes.post("/", zValidator("json", leadInput), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  await consume(db, oid, "leads", 1);
  const r = await upsertLead(oid, { ...c.req.valid("json"), source: c.req.valid("json").source ?? "api" });
  return c.json(r, r.created ? 201 : 200);
});

/** Bulk import: JSON array or CSV text (auto-detects headers). */
leadRoutes.post("/import", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const ct = c.req.header("content-type") ?? "";
  let items: Record<string, unknown>[] = [];
  if (ct.includes("json")) {
    const body = await c.req.json();
    items = Array.isArray(body) ? body : Array.isArray(body.leads) ? body.leads : [];
  } else {
    items = parseCsv(await c.req.text());
  }
  if (items.length === 0) throw badRequest("No leads provided");
  if (items.length > 5000) throw badRequest("Max 5000 leads per import");
  let created = 0;
  let updated = 0;
  const errors: { row: number; error: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = normalizeImportRow(items[i]);
    try {
      await consume(db, oid, "leads", 1);
      const r = await upsertLead(oid, { ...it, source: "import" });
      r.created ? created++ : updated++;
    } catch (e) {
      errors.push({ row: i + 1, error: (e as Error).message });
      if ((e as Error).message.includes("quota")) break;
    }
  }
  await emitEvent(oid, "leads.imported", { created, updated, errors: errors.length });
  return c.json({ created, updated, errors: errors.slice(0, 50) });
});

leadRoutes.get("/:id", async (c) => {
  const l = await leadWithCompany(orgId(c), c.req.param("id"));
  if (!l) throw notFound("Lead");
  return c.json(l);
});

/**
 * Composite "who to contact today, and why" score for a single lead - blends ICP fit,
 * engagement (opens/clicks/replies), and recent company signals (funding, hiring, etc.)
 * into one number with plain-English reasons. Free, deterministic, no AI call.
 */
leadRoutes.get("/:id/priority", async (c) => {
  const oid = orgId(c);
  const l = await leadWithCompany(oid, c.req.param("id"));
  if (!l) throw notFound("Lead");
  const recentSignals = l.company?.domain
    ? await getDb().db.select({ type: signals.type, occurredAt: signals.occurredAt }).from(signals).where(eq(signals.companyDomain, l.company.domain)).orderBy(desc(signals.occurredAt)).limit(20)
    : [];
  const priority = computeLeadPriority(l, recentSignals);
  return c.json({ leadId: l.id, ...priority });
});

/**
 * Top N leads for this org ranked by the same composite priority score, for a "who should
 * I contact today" view. Computed in-process over the org's leads rather than in SQL so the
 * scoring logic (packages/core/src/icp/priority.ts) stays in one place and easy to tune.
 */
leadRoutes.get("/hot/list", zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const { limit } = c.req.valid("query");
  // Pull a generous window of candidates (highest ICP fit + most recently active first) so
  // the ranked slice we return is meaningful even on orgs with thousands of leads.
  const rows = await db
    .select({ lead: leads, company: companies })
    .from(leads)
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(leads.orgId, oid), sql`${leads.status} != 'unsubscribed'`))
    .orderBy(desc(leads.score), desc(leads.engagementScore))
    .limit(500);
  const domains = [...new Set(rows.map((r) => r.company?.domain).filter((d): d is string => !!d))];
  const signalRows = domains.length ? await db.select({ companyDomain: signals.companyDomain, type: signals.type, occurredAt: signals.occurredAt }).from(signals).where(inArray(signals.companyDomain, domains)) : [];
  const signalsByDomain = new Map<string, { type: string; occurredAt: Date | null }[]>();
  for (const s of signalRows) {
    if (!s.companyDomain) continue;
    if (!signalsByDomain.has(s.companyDomain)) signalsByDomain.set(s.companyDomain, []);
    signalsByDomain.get(s.companyDomain)!.push({ type: s.type, occurredAt: s.occurredAt });
  }
  const ranked = rows
    .map((r) => {
      const priority = computeLeadPriority(r.lead, r.company?.domain ? signalsByDomain.get(r.company.domain) ?? [] : []);
      return { lead: { ...r.lead, company: r.company ?? null }, priority };
    })
    .sort((a, b) => b.priority.score - a.priority.score)
    .slice(0, limit);
  return c.json({ leads: ranked });
});

leadRoutes.patch("/:id", zValidator("json", leadInput.partial().extend({ emailStatus: z.string().optional(), score: z.number().optional() })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const existing = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!existing) throw notFound("Lead");
  const b = c.req.valid("json");
  const [row] = await db
    .update(leads)
    .set({ ...b, email: b.email?.toLowerCase(), updatedAt: new Date() })
    .where(eq(leads.id, existing.id))
    .returning();
  return c.json(row);
});

leadRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  await db.delete(leads).where(and(eq(leads.id, c.req.param("id")), eq(leads.orgId, orgId(c))));
  return c.json({ ok: true });
});

leadRoutes.post("/bulk/delete", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })), async (c) => {
  const { db } = getDb();
  await db.delete(leads).where(and(inArray(leads.id, c.req.valid("json").ids), eq(leads.orgId, orgId(c))));
  return c.json({ ok: true });
});

leadRoutes.post("/bulk/tag", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  const rows = await db.select().from(leads).where(and(inArray(leads.id, b.ids), eq(leads.orgId, orgId(c))));
  for (const r of rows) {
    const tags = new Set(r.tags);
    b.add?.forEach((t) => tags.add(t));
    b.remove?.forEach((t) => tags.delete(t));
    await db.update(leads).set({ tags: [...tags], updatedAt: new Date() }).where(eq(leads.id, r.id));
  }
  return c.json({ updated: rows.length });
});

/** Queue enrichment (company crawl + email find/verify + rescore). */
leadRoutes.post("/:id/enrich", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  const job = await enqueue(db, "lead.enrich", { leadId: l.id }, { orgId: oid, priority: 3 });
  return c.json({ jobId: job.id, status: "queued" }, 202);
});

leadRoutes.post("/bulk/enrich", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const job = await enqueue(db, "leads.bulk_enrich", { leadIds: c.req.valid("json").ids }, { orgId: oid });
  return c.json({ jobId: job.id, status: "queued" }, 202);
});

/** Synchronous verify (fast: MX + SMTP). */
leadRoutes.post("/:id/verify", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  if (!l.email) throw badRequest("Lead has no email");
  await consume(db, oid, "verifications", 1);
  const v = await verifyEmail(l.email, { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });
  const [row] = await db.update(leads).set({ emailStatus: v.status, emailConfidence: v.confidence, verifiedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, l.id)).returning();
  return c.json({ lead: row, verification: v });
});

/** Synchronous email finder for a lead with a company. */
leadRoutes.post("/:id/find-email", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  const co = l.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, l.companyId) }) : null;
  const domain = co?.domain ?? (c.req.query("domain") ? extractDomain(c.req.query("domain")!) : null);
  if (!domain || !l.firstName || !l.lastName) throw badRequest("Need first name, last name and a company domain");
  await consume(db, oid, "verifications", 1);
  const r = await findEmail({ firstName: l.firstName, lastName: l.lastName, domain, knownPattern: co?.emailPattern, knownEmails: (co?.raw as { emailsFound?: string[] })?.emailsFound }, { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey });
  if (r.email) {
    await db.update(leads).set({ email: r.email, emailStatus: r.status, emailConfidence: r.confidence, verifiedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, l.id));
    if (co && r.pattern && !co.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, co.id));
  }
  return c.json(r);
});

// ── Lists ──
leadRoutes.get("/lists/all", async (c) => {
  const { db } = getDb();
  const rows = await db
    .select({ list: lists, count: sql<number>`(SELECT count(*)::int FROM list_leads WHERE list_id = ${lists.id})` })
    .from(lists)
    .where(eq(lists.orgId, orgId(c)))
    .orderBy(desc(lists.createdAt));
  return c.json({ lists: rows.map((r) => ({ ...r.list, count: r.count })) });
});
leadRoutes.post("/lists", zValidator("json", z.object({ name: z.string().min(1), description: z.string().optional() })), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(lists).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  return c.json(row, 201);
});
leadRoutes.delete("/lists/:listId", async (c) => {
  const { db } = getDb();
  await db.delete(lists).where(and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, orgId(c))));
  return c.json({ ok: true });
});
leadRoutes.post("/lists/:listId/leads", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1) })), async (c) => {
  const { db } = getDb();
  const list = await db.query.lists.findFirst({ where: and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, orgId(c))) });
  if (!list) throw notFound("List");
  let n = 0;
  for (const leadId of c.req.valid("json").ids) n += (await db.insert(listLeads).values({ listId: list.id, leadId }).onConflictDoNothing().returning()).length;
  return c.json({ added: n });
});
leadRoutes.delete("/lists/:listId/leads/:leadId", async (c) => {
  const { db } = getDb();
  await db.delete(listLeads).where(and(eq(listLeads.listId, c.req.param("listId")), eq(listLeads.leadId, c.req.param("leadId"))));
  return c.json({ ok: true });
});

// ── Suppressions ──
leadRoutes.get("/suppressions/all", async (c) => {
  const { db } = getDb();
  return c.json({ suppressions: await db.select().from(suppressions).where(eq(suppressions.orgId, orgId(c))).orderBy(desc(suppressions.createdAt)).limit(1000) });
});
leadRoutes.post("/suppressions", zValidator("json", z.object({ emails: z.array(z.string().email()).min(1), reason: z.string().optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  for (const e of b.emails) await db.insert(suppressions).values({ orgId: orgId(c), email: e.toLowerCase(), reason: b.reason ?? "manual" }).onConflictDoNothing();
  return c.json({ ok: true, added: b.emails.length });
});

// ── helpers ──
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const parseLine = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  return lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [headers[i] ?? `col${i}`, v.trim()])));
}

const ALIASES: Record<string, string[]> = {
  firstName: ["first_name", "firstname", "first", "given_name"],
  lastName: ["last_name", "lastname", "last", "surname", "family_name"],
  fullName: ["full_name", "name", "contact_name", "person"],
  title: ["title", "job_title", "position", "role", "designation"],
  email: ["email", "email_address", "work_email", "e_mail"],
  linkedinUrl: ["linkedin", "linkedin_url", "linkedin_profile", "profile_url"],
  phone: ["phone", "mobile", "phone_number", "telephone"],
  location: ["location", "city", "address"],
  country: ["country"],
  companyName: ["company", "company_name", "organization", "organisation", "employer"],
  companyDomain: ["domain", "company_domain", "website", "company_website", "url"],
};

export function normalizeImportRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { custom: {} as Record<string, unknown> };
  const used = new Set<string>();
  for (const [key, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      if (row[n] !== undefined && row[n] !== "") {
        out[key] = String(row[n]);
        used.add(n);
        break;
      }
    }
  }
  if (typeof out.companyDomain === "string") out.companyDomain = extractDomain(out.companyDomain) ?? undefined;
  if (typeof out.email === "string" && !/^\S+@\S+\.\S+$/.test(out.email)) delete out.email;
  for (const [k, v] of Object.entries(row)) if (!used.has(k) && v !== "" && v !== undefined) (out.custom as Record<string, unknown>)[k] = v;
  return out as Parameters<typeof upsertLead>[1];
}
