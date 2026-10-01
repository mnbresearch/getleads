import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, asc, clients, companies, consume, desc, enqueue, eq, getDb, icps, ilike, inArray, isNull, leads, listLeads, lists, or, QuotaExceededError, signals, sql, suppressions } from "@prospex/db";
import { verifyEmail, findEmail, extractDomain, computeLeadPriority } from "@prospex/core";
import { env } from "../env.js";
import { badRequest, notFound, requireSomeFields } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";
import { csvCell, parseCsv } from "../lib/csv.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { findExistingLead, leadWithCompany, upsertCompany, upsertLead } from "../services/leads.js";
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

/**
 * The PATCH shape. GET returns null for every empty column, so a client that edits a lead by
 * sending back what it read sent nulls, and `.optional()` rejected them. null here means
 * "clear this field"; absent means "leave it".
 */
const leadPatch = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  fullName: z.string().nullish(),
  title: z.string().nullish(),
  email: z.string().email().nullish(),
  linkedinUrl: z.string().url().nullish(),
  phone: z.string().nullish(),
  location: z.string().nullish(),
  country: z.string().nullish(),
  companyDomain: z.string().nullish(),
  companyName: z.string().nullish(),
  icpId: z.string().uuid().nullish(),
  tags: z.array(z.string()).optional(),
  custom: z.record(z.unknown()).optional(),
  source: z.string().optional(),
  emailStatus: z.string().optional(),
  score: z.number().optional(),
});

/** Signals visible to an org: the shared feed plus its own private ones (job changes). */
const visibleSignals = (oid: string) => or(isNull(signals.orgId), eq(signals.orgId, oid))!;

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
  // The pipeline stage. The column and the transition endpoint both existed; there was no
  // way to filter by it, so "show me everyone I have contacted" was unaskable.
  status: z.string().optional(),
  /** A client id, or "none" for the unassigned pool. */
  clientId: z.union([z.string().uuid(), z.literal("none")]).optional(),
  /** One of the client dashboard's needs-attention buckets, with the dashboard's definition. */
  attention: z.enum(["noEmail", "unverified", "badEmail", "readyButIdle"]).optional(),
  sort: z.enum(["score", "created", "updated", "name"]).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
});

async function buildWhere(oid: string, q: z.infer<typeof listQuery>) {
  const conds = [eq(leads.orgId, oid)];
  // Company name and domain too: the job-change feed's "Open" link searches by company name,
  // and searching for "Acme" returning nobody who works at Acme reads as "no such leads".
  if (q.q) {
    const p = `%${q.q}%`;
    conds.push(or(ilike(leads.fullName, p), ilike(leads.email, p), ilike(leads.title, p), sql`${leads.companyId} IN (SELECT id FROM companies WHERE org_id = ${oid} AND (name ILIKE ${p} OR domain ILIKE ${p}))`)!);
  }
  if (q.emailStatus) conds.push(inArray(leads.emailStatus, q.emailStatus.split(",")));
  if (q.minScore !== undefined) conds.push(sql`${leads.score} >= ${q.minScore}`);
  if (q.tag) conds.push(sql`${q.tag} = ANY(${leads.tags})`);
  if (q.icpId) conds.push(eq(leads.icpId, q.icpId));
  if (q.seniority) conds.push(inArray(leads.seniority, q.seniority.split(",")));
  if (q.department) conds.push(inArray(leads.department, q.department.split(",")));
  if (q.hasEmail === "true") conds.push(sql`${leads.email} IS NOT NULL`);
  if (q.hasEmail === "false") conds.push(sql`${leads.email} IS NULL`);
  if (q.status) conds.push(inArray(leads.status, q.status.split(",")));
  if (q.clientId === "none") conds.push(sql`${leads.clientId} IS NULL`);
  else if (q.clientId) conds.push(eq(leads.clientId, q.clientId));
  if (q.attention) {
    const { attentionWhere } = await import("../services/clients.js");
    conds.push(attentionWhere(q.attention));
  }
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
  const esc = csvCell;
  const lines = [cols.join(",")];
  for (const { lead: l, company: co } of rows) lines.push([l.firstName, l.lastName, l.title, l.email, l.emailStatus, l.emailConfidence, l.linkedinUrl, l.phone, l.location, co?.name, co?.domain, co?.industry, co?.size, l.score, l.tags.join(";"), l.createdAt.toISOString()].map(esc).join(","));
  c.header("content-type", "text/csv");
  c.header("content-disposition", `attachment; filename="leads-${Date.now()}.csv"`);
  return c.body(lines.join("\n"));
});

leadRoutes.post("/", zValidator("json", leadInput), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertOwned(icps, b.icpId, oid, "ICP");
  // Charged only when this creates a lead. Posting someone the workspace already has is an
  // update, and billing it as a new lead charged customers for their own duplicates.
  if (!(await findExistingLead(oid, b))) await consume(db, oid, "leads", 1);
  const r = await upsertLead(oid, { ...b, source: b.source ?? "api" });
  return c.json(r, r.created ? 201 : 200);
});

/** Bulk import: JSON array or CSV text (auto-detects headers). */
leadRoutes.post("/import", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const ct = c.req.header("content-type") ?? "";
  let items: Record<string, unknown>[] = [];
  if (ct.includes("json")) {
    // Malformed JSON, `null`, or an object without `leads` was a 500 (a TypeError reading
    // `.leads` of null). The caller sent something unusable, so say what was expected.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The request body is not valid JSON. Send an array of leads, or { \"leads\": [...] }.");
    }
    const arr = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { leads?: unknown }).leads) ? (body as { leads: unknown[] }).leads : null;
    if (!arr) throw badRequest("Expected an array of leads, or { \"leads\": [...] }.");
    items = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    if (items.length < arr.length) throw badRequest(`Every lead must be an object; ${arr.length - items.length} entr${arr.length - items.length === 1 ? "y is" : "ies are"} not.`);
  } else {
    items = parseCsv(await c.req.text());
  }
  if (items.length === 0) throw badRequest("No leads provided");
  if (items.length > 5000) throw badRequest("Max 5000 leads per import");
  let created = 0;
  let updated = 0;
  let stopped: string | undefined;
  let notProcessed = 0;
  const errors: { row: number; error: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = normalizeImportRow(items[i]);
    try {
      // Only a NEW lead costs a lead. Re-importing a file to refresh titles used to bill
      // every row again.
      if (!(await findExistingLead(oid, it))) await consume(db, oid, "leads", 1);
      const r = await upsertLead(oid, { ...it, source: "import" });
      r.created ? created++ : updated++;
    } catch (e) {
      errors.push({ row: i + 1, error: (e as Error).message });
      if (e instanceof QuotaExceededError) {
        stopped = `Stopped at row ${i + 1} of ${items.length}: ${e.message}`;
        notProcessed = items.length - (i + 1);
        break;
      }
    }
  }
  await emitEvent(oid, "leads.imported", { created, updated, errors: errors.length });
  return c.json({ created, updated, errors: errors.slice(0, 50), stopped, notProcessed });
});

// ── Static paths first ──
// Hono runs handlers in registration order, so a static path registered AFTER a `/:id`
// route of the same shape is unreachable: POST /bulk/enrich was captured by POST
// /:id/enrich with id "bulk" and answered 400 forever. Everything with a fixed first
// segment is declared here, above every /:id route.

leadRoutes.post("/bulk/delete", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })), async (c) => {
  const { db } = getDb();
  const ids = [...new Set(c.req.valid("json").ids)];
  const gone = await db.delete(leads).where(and(inArray(leads.id, ids), eq(leads.orgId, orgId(c)))).returning({ id: leads.id });
  return c.json({ ok: true, requested: ids.length, deleted: gone.length, notFound: ids.length - gone.length });
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

leadRoutes.post("/bulk/enrich", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  // Only this workspace's leads go on the job. The ids used to be queued as given, and the
  // job enriches (and spends verifications on) whatever ids it is handed.
  const requested = [...new Set(c.req.valid("json").ids)];
  const owned = (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, requested)))).map((r) => r.id);
  if (!owned.length) return c.json({ jobId: null, status: "nothing_to_do", requested: requested.length, queued: 0, notFound: requested.length });
  const job = await enqueue(db, "leads.bulk_enrich", { leadIds: owned }, { orgId: oid });
  return c.json({ jobId: job.id, status: "queued", requested: requested.length, queued: owned.length, notFound: requested.length - owned.length }, 202);
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
leadRoutes.post("/lists", zValidator("json", z.object({ name: z.string().min(1), description: z.string().optional(), clientId: z.string().uuid().optional() })), async (c) => {
  const { db } = getDb();
  await assertOwned(clients, c.req.valid("json").clientId, orgId(c), "Client");
  const [row] = await db.insert(lists).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  return c.json(row, 201);
});
leadRoutes.delete("/lists/:listId", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(lists).where(and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, orgId(c)))).returning({ id: lists.id });
  if (!gone.length) throw notFound("List");
  return c.json({ ok: true });
});
leadRoutes.post("/lists/:listId/leads", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const list = await db.query.lists.findFirst({ where: and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, oid)) });
  if (!list) throw notFound("List");
  // Only this workspace's leads. Any uuid used to be inserted as given: another org's lead
  // landed on this list (and from there in a campaign), and an id matching no lead at all
  // hit the foreign key and failed the whole request with a 500.
  const requested = [...new Set(c.req.valid("json").ids)];
  const owned = (await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, requested)))).map((r) => r.id);
  const inserted = owned.length ? await db.insert(listLeads).values(owned.map((leadId) => ({ listId: list.id, leadId }))).onConflictDoNothing().returning({ leadId: listLeads.leadId }) : [];
  return c.json({ requested: requested.length, added: inserted.length, alreadyInList: owned.length - inserted.length, notFound: requested.length - owned.length });
});
leadRoutes.delete("/lists/:listId/leads/:leadId", async (c) => {
  const { db } = getDb();
  // listLeads has no orgId of its own, so ownership has to be established through the list
  // first - exactly as the sibling POST does. Without it, one tenant could remove rows from
  // another tenant's list given only the two ids.
  const list = await db.query.lists.findFirst({ where: and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, orgId(c))) });
  if (!list) throw notFound("List");
  const gone = await db.delete(listLeads).where(and(eq(listLeads.listId, list.id), eq(listLeads.leadId, c.req.param("leadId")))).returning({ leadId: listLeads.leadId });
  if (!gone.length) throw notFound("Lead on this list");
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
  const emails = [...new Set(b.emails.map((e) => e.toLowerCase()))];
  // `added` counts rows actually inserted; an address already suppressed is reported as such
  // rather than counted again.
  const inserted = await db.insert(suppressions).values(emails.map((email) => ({ orgId: orgId(c), email, reason: b.reason ?? "manual" }))).onConflictDoNothing().returning({ email: suppressions.email });
  return c.json({ ok: true, added: inserted.length, alreadySuppressed: emails.length - inserted.length });
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
  const signalRows = domains.length ? await db.select({ companyDomain: signals.companyDomain, type: signals.type, occurredAt: signals.occurredAt }).from(signals).where(and(inArray(signals.companyDomain, domains), visibleSignals(oid))) : [];
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
    ? await getDb().db.select({ type: signals.type, occurredAt: signals.occurredAt }).from(signals).where(and(eq(signals.companyDomain, l.company.domain), visibleSignals(oid))).orderBy(desc(signals.occurredAt)).limit(20)
    : [];
  const priority = computeLeadPriority(l, recentSignals);
  return c.json({ leadId: l.id, ...priority });
});

leadRoutes.patch("/:id", zValidator("json", leadPatch), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const existing = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!existing) throw notFound("Lead");
  const { companyDomain, companyName, email: rawEmail, ...b } = c.req.valid("json");
  requireSomeFields({ ...b, companyDomain, companyName, email: rawEmail });
  await assertOwned(icps, b.icpId, oid, "ICP");
  const email = rawEmail === null ? null : rawEmail?.toLowerCase();

  /**
   * The company is identified by its domain, so a domain moves the lead to that company
   * (created if new, named with companyName if given). These two fields used to be accepted
   * and silently dropped, so "moved to a new employer" saved and changed nothing.
   * A bare companyName is refused rather than guessed at: renaming the existing company
   * would rename it for every other lead there too.
   */
  let companyPatch: { companyId?: string | null } = {};
  if (companyDomain === null) companyPatch = { companyId: null };
  else if (companyDomain) {
    const domain = extractDomain(companyDomain);
    if (!domain) throw badRequest(`companyDomain "${companyDomain}" is not a domain`);
    const co = await upsertCompany(oid, domain, { name: companyName ?? undefined });
    companyPatch = { companyId: co.id };
  } else if (companyName) {
    throw badRequest("companyName needs companyDomain: a company is identified by its domain. Send both to move this lead to another company.");
  }

  /**
   * A corrected address has never been checked.
   *
   * Enforced here rather than left to the caller, because the verdict this clears is
   * load-bearing: `valid` earns the ICP score's verification credit and clears the
   * campaign send gate, so carrying it across to a different mailbox would mark an
   * unchecked address as safe to send to. The confidence and the verification date go with
   * it - otherwise the detail view and the CSV export read "unknown, 95%, verified today",
   * which is three statements that cannot all be true.
   */
  const emailChanged = email === null ? existing.email !== null : !!email && email !== (existing.email ?? "").toLowerCase();
  const resetVerification = emailChanged ? { emailStatus: "unknown", emailConfidence: 0, verifiedAt: null } : {};

  const [row] = await db
    .update(leads)
    .set({ ...b, ...companyPatch, ...resetVerification, ...(email !== undefined ? { email } : {}), updatedAt: new Date() })
    .where(eq(leads.id, existing.id))
    .returning();
  return c.json(row);
});

leadRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(leads).where(and(eq(leads.id, c.req.param("id")), eq(leads.orgId, orgId(c)))).returning({ id: leads.id });
  if (!gone.length) throw notFound("Lead");
  return c.json({ ok: true });
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

/** Synchronous verify (fast: MX + SMTP). */
leadRoutes.post("/:id/verify", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  if (!l.email) throw badRequest("Lead has no email");
  await consume(db, oid, "verifications", 1);
  const v = await verifyEmail(l.email, { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });
  // emailVerifiedBy records who actually answered ("reoon:safe", "smtp", "mx-only"...), so a
  // "valid" from a mailbox check is distinguishable from one inferred from DNS alone.
  const [row] = await db.update(leads).set({ emailStatus: v.status, emailConfidence: v.confidence, verifiedAt: new Date(), emailVerifiedBy: v.verifiedBy ?? null, updatedAt: new Date() }).where(eq(leads.id, l.id)).returning();
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
  const r = await findEmail({ firstName: l.firstName, lastName: l.lastName, domain, knownPattern: co?.emailPattern, knownEmails: (co?.raw as { emailsFound?: string[] })?.emailsFound }, { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });
  if (r.email) {
    // Only stamp verifiedAt when something checked the mailbox; a pattern guess is not verified.
    await db.update(leads).set({ email: r.email, emailStatus: r.status, emailConfidence: r.confidence, verifiedAt: r.verifiedBy ? new Date() : null, emailVerifiedBy: r.verifiedBy ?? null, updatedAt: new Date() }).where(eq(leads.id, l.id));
    if (co && r.pattern && !co.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, co.id));
  }
  return c.json(r);
});

// ── helpers ──
export { parseCsv };

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
