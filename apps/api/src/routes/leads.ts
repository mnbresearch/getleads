import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, asc, clients, companies, consume, desc, enqueue, eq, getDb, icps, ilike, inArray, isNull, leads, listLeads, lists, or, QuotaExceededError, signals, sql, suppressions } from "@prospex/db";
import { verifyEmail, findEmail, computeLeadPriority } from "@prospex/core";
import { env } from "../env.js";
import { ApiError, badRequest, describeError, isClientDataError, notFound, requireSomeFields } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";
import { CSV_MAX_COLUMNS, csvCell, parseCsv, parseCsvRecords } from "../lib/csv.js";
import { describeIssues } from "../lib/validate.js";
import { audit } from "../lib/audit.js";
import { stripNulDeep } from "../lib/sanitize.js";
import { emailField, profileUrlField } from "../lib/fields.js";
import { boundedCsv, boundedRead, likeContains, LIST_SEARCH_MAX } from "../lib/listSearch.js";
import { assertRowCap, guardJobCapacity } from "../lib/limits.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { canonicalEmail, companyDomainOrNull, findExistingLead, leadWithCompany, upsertCompany, upsertLead, verifierOf } from "../services/leads.js";
import { emitEvent } from "../lib/events.js";
import { eraseLeads } from "../lib/privacyErase.js";
import { onPlatformList } from "../lib/privacySuppression.js";

/** What a caller is told when an address is on the platform-wide do-not-contact list. */
const PLATFORM_LISTED = "This person has asked not to be contacted through Scout, so their address cannot be stored.";

export const leadRoutes = new Hono<Env>();
leadRoutes.use("*", requireAuth);

// ── The lead DTO ──
// One set of field rules, used by POST, PATCH and - row by row - by the import. The import
// used to bypass all of it (it had its own two-line check), which is how a 1 MB title, a
// `javascript:` LinkedIn URL and a three-recipient "email" got into the leads table.

/** Custom fields per lead, and the size of each value (as JSON). */
export const CUSTOM_MAX_KEYS = 100;
export const CUSTOM_MAX_VALUE_CHARS = 2000;
const CUSTOM_MAX_KEY_CHARS = 100;
/** Keys that are never stored: they are how a later object merge reaches Object.prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const customField = z.record(z.unknown()).transform((obj, ctx) => {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (k.length > CUSTOM_MAX_KEY_CHARS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A custom field name is too long (${k.length} characters; the limit is ${CUSTOM_MAX_KEY_CHARS}).` });
      return z.NEVER;
    }
    const size = typeof v === "string" ? v.length : (JSON.stringify(v) ?? "").length;
    if (size > CUSTOM_MAX_VALUE_CHARS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Custom field "${k.slice(0, 40)}" is too long (${size.toLocaleString("en-US")} characters; the limit is ${CUSTOM_MAX_VALUE_CHARS.toLocaleString("en-US")}).` });
      return z.NEVER;
    }
    out[k] = v;
    n++;
  }
  if (n > CUSTOM_MAX_KEYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Too many custom fields (${n}; the limit is ${CUSTOM_MAX_KEYS} per lead).` });
    return z.NEVER;
  }
  return out;
});

const leadFields = {
  // Limits generous enough for real imported data, tight enough that a pasted paragraph is
  // refused rather than stored as a name.
  firstName: z.string().max(200),
  lastName: z.string().max(200),
  fullName: z.string().max(200),
  title: z.string().max(300),
  email: emailField,
  linkedinUrl: profileUrlField,
  phone: z.string().max(100),
  location: z.string().max(300),
  country: z.string().max(100),
  companyDomain: z.string().max(300),
  companyName: z.string().max(200),
  tags: z.array(z.string().max(100)).max(50),
  custom: customField,
  source: z.string().max(100),
};

const leadInput = z.object({
  firstName: leadFields.firstName.optional(),
  lastName: leadFields.lastName.optional(),
  fullName: leadFields.fullName.optional(),
  title: leadFields.title.optional(),
  email: leadFields.email.optional(),
  linkedinUrl: leadFields.linkedinUrl.optional(),
  phone: leadFields.phone.optional(),
  location: leadFields.location.optional(),
  country: leadFields.country.optional(),
  companyDomain: leadFields.companyDomain.optional(),
  companyName: leadFields.companyName.optional(),
  icpId: z.string().uuid().optional(),
  tags: leadFields.tags.optional(),
  custom: leadFields.custom.optional(),
  source: leadFields.source.optional(),
});

/** One import row, after its columns have been mapped. Same rules as `leadInput`. */
const importRow = z.object({
  firstName: leadFields.firstName.optional(),
  lastName: leadFields.lastName.optional(),
  fullName: leadFields.fullName.optional(),
  title: leadFields.title.optional(),
  email: leadFields.email.optional(),
  linkedinUrl: leadFields.linkedinUrl.optional(),
  phone: leadFields.phone.optional(),
  location: leadFields.location.optional(),
  country: leadFields.country.optional(),
  companyDomain: leadFields.companyDomain.optional(),
  companyName: leadFields.companyName.optional(),
  tags: leadFields.tags.optional(),
  custom: leadFields.custom.optional(),
});

/** The statuses a verifier can give. A hand-set status is one of these or it is refused. */
const EMAIL_STATUSES = ["valid", "risky", "invalid", "catch_all", "unknown"] as const;

/**
 * The PATCH shape. GET returns null for every empty column, so a client that edits a lead by
 * sending back what it read sent nulls, and `.optional()` rejected them. null here means
 * "clear this field"; absent means "leave it".
 */
const leadPatch = z.object({
  firstName: leadFields.firstName.nullish(),
  lastName: leadFields.lastName.nullish(),
  fullName: leadFields.fullName.nullish(),
  title: leadFields.title.nullish(),
  email: leadFields.email.nullish(),
  linkedinUrl: leadFields.linkedinUrl.nullish(),
  phone: leadFields.phone.nullish(),
  location: leadFields.location.nullish(),
  country: leadFields.country.nullish(),
  companyDomain: leadFields.companyDomain.nullish(),
  companyName: leadFields.companyName.nullish(),
  icpId: z.string().uuid().nullish(),
  tags: leadFields.tags.optional(),
  custom: leadFields.custom.optional(),
  source: leadFields.source.optional(),
  emailStatus: z.enum(EMAIL_STATUSES).optional(),
  // A score is 0-100 everywhere it is read (the hot list, the ICP filter, the report), so
  // an out-of-range one is brought into range rather than stored: -5000 sorted a lead out
  // of every view, and 1e39 overflowed the column.
  score: z.number().finite().transform((n) => Math.min(100, Math.max(0, Math.round(n)))).optional(),
});

/** Signals visible to an org: the shared feed plus its own private ones (job changes). */
const visibleSignals = (oid: string) => or(isNull(signals.orgId), eq(signals.orgId, oid))!;

/** Is this a Postgres unique-constraint violation (SQLSTATE 23505), anywhere in the cause chain? */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    if ((cur as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

const listQuery = z.object({
  // Bounded: the text is matched with a leading-wildcard ILIKE across several columns, which
  // is a sequential scan. An unbounded pattern was a one-request way to tie up the instance.
  q: z.string().max(LIST_SEARCH_MAX).optional(),
  emailStatus: z.string().max(400).optional(),
  minScore: z.coerce.number().optional(),
  tag: z.string().max(LIST_SEARCH_MAX).optional(),
  icpId: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
  companyDomain: z.string().max(253).optional(),
  seniority: z.string().max(400).optional(),
  department: z.string().max(400).optional(),
  hasEmail: z.enum(["true", "false"]).optional(),
  // The pipeline stage. The column and the transition endpoint both existed; there was no
  // way to filter by it, so "show me everyone I have contacted" was unaskable.
  status: z.string().max(400).optional(),
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
    // Escaped literal substring, so the caller's own % and _ cannot widen the scan.
    const p = likeContains(q.q);
    conds.push(or(ilike(leads.fullName, p), ilike(leads.email, p), ilike(leads.title, p), sql`${leads.companyId} IN (SELECT id FROM companies WHERE org_id = ${oid} AND (name ILIKE ${p} OR domain ILIKE ${p}))`)!);
  }
  if (q.emailStatus) conds.push(inArray(leads.emailStatus, boundedCsv(q.emailStatus)));
  if (q.minScore !== undefined) conds.push(sql`${leads.score} >= ${q.minScore}`);
  if (q.tag) conds.push(sql`${q.tag.slice(0, LIST_SEARCH_MAX)} = ANY(${leads.tags})`);
  if (q.icpId) conds.push(eq(leads.icpId, q.icpId));
  if (q.seniority) conds.push(inArray(leads.seniority, boundedCsv(q.seniority)));
  if (q.department) conds.push(inArray(leads.department, boundedCsv(q.department)));
  if (q.hasEmail === "true") conds.push(sql`${leads.email} IS NOT NULL`);
  if (q.hasEmail === "false") conds.push(sql`${leads.email} IS NULL`);
  if (q.status) conds.push(inArray(leads.status, boundedCsv(q.status)));
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
  // Under a statement time cap: a filter that would otherwise scan a large table for seconds
  // is cancelled and answered with a 503, instead of occupying a connection and the instance.
  const { rows, n } = await boundedRead(db, async (tx) => {
    const rows = await tx
      .select({ lead: leads, company: companies })
      .from(leads)
      // The join is scoped as well as the WHERE: a lead whose company_id points at another
      // workspace's company must come back with no company, not with theirs.
      .leftJoin(companies, and(eq(leads.companyId, companies.id), eq(companies.orgId, oid)))
      .where(where)
      .orderBy(q.order === "asc" ? asc(sortCol) : desc(sortCol))
      .limit(q.limit)
      .offset(q.offset);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(leads).where(where);
    return { rows, n };
  });
  return c.json({ leads: rows.map((r) => ({ ...r.lead, company: r.company })), total: n, limit: q.limit, offset: q.offset });
});

leadRoutes.get("/export.csv", zValidator("query", listQuery), async (c) => {
  const filters = c.req.valid("query");
  const q = { ...filters, limit: 5000, offset: 0 };
  const oid = orgId(c);
  const { db } = getDb();
  const where = await buildWhere(oid, q);
  const rows = await boundedRead(db, (tx) => tx.select({ lead: leads, company: companies }).from(leads).leftJoin(companies, and(eq(leads.companyId, companies.id), eq(companies.orgId, oid))).where(where).orderBy(desc(leads.score)).limit(5000));
  const cols = ["first_name", "last_name", "title", "email", "email_status", "email_confidence", "linkedin_url", "phone", "location", "company", "company_domain", "industry", "company_size", "score", "tags", "created_at"];
  const esc = csvCell;
  const lines = [cols.join(",")];
  for (const { lead: l, company: co } of rows) lines.push([l.firstName, l.lastName, l.title, l.email, l.emailStatus, l.emailConfidence, l.linkedinUrl, l.phone, l.location, co?.name, co?.domain, co?.industry, co?.size, l.score, l.tags.join(";"), l.createdAt.toISOString()].map(esc).join(","));
  // An export is the bulk exit for contact data, so every one is on the audit trail: who,
  // from where, how many rows, and which filters selected them.
  const { limit: _l, offset: _o, sort: _s, order: _or, ...applied } = filters;
  await audit(c, "leads.exported", { targetType: "lead", data: { rows: rows.length, format: "csv", truncated: rows.length === 5000, filters: applied } });
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("x-content-type-options", "nosniff");
  c.header("content-disposition", `attachment; filename="leads-${Date.now()}.csv"`);
  return c.body(lines.join("\n"));
});

leadRoutes.post("/", zValidator("json", leadInput), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const b = c.req.valid("json");
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  if (b.companyDomain !== undefined && !companyDomainOrNull(b.companyDomain)) throw badRequest(`companyDomain "${b.companyDomain.slice(0, 80)}" is not a public company domain (for example acme.com).`);
  // Charged only when this creates a lead. Posting someone the workspace already has is an
  // update, and billing it as a new lead charged customers for their own duplicates.
  const charged = !(await findExistingLead(oid, b));
  if (charged) await consume(db, oid, "leads", 1);
  try {
    const r = await upsertLead(oid, { ...b, source: b.source ?? "api" });
    // A race: two parallel creates of one new address both found no existing lead and both
    // charged, but only one inserted. The one whose insert folded into an update of the other
    // (created === false) did not create a lead, so give its charge back.
    if (charged && !r.created) await consume(db, oid, "leads", -1, { allowOverage: true }).catch(() => {});
    return c.json(r, r.created ? 201 : 200);
  } catch (e) {
    // The loser of the same race whose insert hit the unique index: it created nothing.
    if (charged && isUniqueViolation(e)) await consume(db, oid, "leads", -1, { allowOverage: true }).catch(() => {});
    throw e;
  }
});

/** Most rows in one import. */
const IMPORT_MAX_ROWS = 5000;

/**
 * Bulk import: JSON array or CSV text (auto-detects headers).
 *
 * Every row goes through the same field rules as POST /v1/leads. A row that fails them is
 * not imported and is listed in `skippedRows` with the reason in plain words; the rest of
 * the file carries on. `errors` is for rows that passed validation and then could not be
 * saved (out of quota, a database fault) - its text is ours, never the database's.
 */
leadRoutes.post("/import", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const ct = c.req.header("content-type") ?? "";
  let items: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  /** 0-based index of the row a never-closed quote swallowed the rest of the file into. */
  let unterminated = -1;
  /** 0-based indexes of rows that were wider than the column limit. */
  const overWide = new Set<number>();
  const format = ct.includes("json") ? "json" : "csv";
  if (format === "json") {
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
    if (arr.length > IMPORT_MAX_ROWS) throw badRequest(`Max ${IMPORT_MAX_ROWS} leads per import`);
    items = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    if (items.length < arr.length) throw badRequest(`Every lead must be an object; ${arr.length - items.length} entr${arr.length - items.length === 1 ? "y is" : "ies are"} not.`);
    items.forEach((it, i) => {
      if (Object.keys(it).length > CSV_MAX_COLUMNS) overWide.add(i);
    });
  } else {
    const parsed = parseCsvRecords(await c.req.text());
    items = parsed.records;
    parsed.overWide.forEach((i) => overWide.add(i));
    if (parsed.unterminatedQuote) {
      warnings.push("The file ends inside a quoted cell (a \" that is never closed), so everything after that quote was read as one cell. Check the last rows of the file.");
      // That last "row" is the rest of the file glued into one cell. It is never a lead.
      if (items.length) unterminated = items.length - 1;
    }
  }
  if (items.length === 0) throw badRequest("No leads provided");
  if (items.length > IMPORT_MAX_ROWS) throw badRequest(`Max ${IMPORT_MAX_ROWS} leads per import`);
  let created = 0;
  let updated = 0;
  let stopped: string | undefined;
  let notProcessed = 0;
  const errors: { row: number; error: string }[] = [];
  const skippedRows: { row: number; reason: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i === unterminated) {
      skippedRows.push({ row: i + 1, reason: "This row opens a quote (\") that is never closed, so the rest of the file was read as part of it. Close the quote and import again." });
      continue;
    }
    if (overWide.has(i)) {
      skippedRows.push({ row: i + 1, reason: `This row has more than ${CSV_MAX_COLUMNS} columns. Remove the columns you do not need and import it again.` });
      continue;
    }
    const mapped = mapImportRow(items[i]);
    if (!mapped.ok) {
      skippedRows.push({ row: i + 1, reason: mapped.reason });
      continue;
    }
    const checked = importRow.safeParse(mapped.row);
    if (!checked.success) {
      skippedRows.push({ row: i + 1, reason: describeIssues(checked.error) });
      continue;
    }
    const it = checked.data;
    // A row that names nobody (only a title, say) became a blank lead nobody could find,
    // contact or dedupe. It is skipped and reported, and the import carries on.
    const hasName = [it.fullName, it.firstName, it.lastName].some((v) => typeof v === "string" && v.trim());
    if (!hasName && !it.email && !it.linkedinUrl) {
      skippedRows.push({ row: i + 1, reason: "No name, email or LinkedIn URL - nothing identifies this person." });
      continue;
    }
    let rowCharged = false;
    try {
      // Only a NEW lead costs a lead. Re-importing a file to refresh titles used to bill
      // every row again.
      if (!(await findExistingLead(oid, it))) {
        await consume(db, oid, "leads", 1);
        rowCharged = true;
      }
      const r = await upsertLead(oid, { ...it, source: "import" });
      // Folded into an existing lead after all (a concurrent writer won): no new lead, give it back.
      if (rowCharged && !r.created) await consume(db, oid, "leads", -1, { allowOverage: true }).catch(() => {});
      r.created ? created++ : updated++;
    } catch (e) {
      if (rowCharged) await consume(db, oid, "leads", -1, { allowOverage: true }).catch(() => {});
      // What the caller is told is written here. The exception's own text is the SQL
      // statement with every bound value in it, and it used to be returned as-is.
      if (e instanceof QuotaExceededError) {
        errors.push({ row: i + 1, error: e.message });
        stopped = `Stopped at row ${i + 1} of ${items.length}: ${e.message}`;
        notProcessed = items.length - (i + 1);
        break;
      }
      if (e instanceof ApiError) errors.push({ row: i + 1, error: e.message });
      else if (isClientDataError(e)) errors.push({ row: i + 1, error: "A value in this row cannot be stored (for example text with unsupported characters, or a value that is too long)." });
      else {
        const d = describeError(e);
        console.error(`[leads] import row ${i + 1} failed: ${d.name}${d.code ? ` [${d.code}]` : ""}: ${d.message}`);
        errors.push({ row: i + 1, error: d.code === "23505" ? "This row conflicts with a lead that already exists." : "This row could not be saved because of a server error. It was not imported." });
      }
    }
  }
  await emitEvent(oid, "leads.imported", { created, updated, errors: errors.length, skipped: skippedRows.length });
  await audit(c, "leads.imported", { targetType: "lead", data: { format, rows: items.length, created, updated, skipped: skippedRows.length, errors: errors.length, stopped: !!stopped } });
  return c.json({ created, updated, errors: errors.slice(0, 50), stopped, notProcessed, skipped: skippedRows.length, skippedRows: skippedRows.slice(0, 50), ...(warnings.length ? { warnings } : {}) });
});

// ── Static paths first ──
// Hono runs handlers in registration order, so a static path registered AFTER a `/:id`
// route of the same shape is unreachable: POST /bulk/enrich was captured by POST
// /:id/enrich with id "bulk" and answered 400 forever. Everything with a fixed first
// segment is declared here, above every /:id route.

leadRoutes.post("/bulk/delete", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })), async (c) => {
  const { db } = getDb();
  const ids = [...new Set(c.req.valid("json").ids)];
  // Deleting a person removes the copies too (messages, events, monitor results): lib/privacyErase.ts.
  const gone = (await eraseLeads(orgId(c), ids, db)).deleted.map((id) => ({ id }));
  await audit(c, "leads.bulk_deleted", { targetType: "lead", data: { requested: ids.length, deleted: gone.length } });
  return c.json({ ok: true, requested: ids.length, deleted: gone.length, notFound: ids.length - gone.length });
});

leadRoutes.post("/bulk/tag", zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), add: z.array(z.string().max(100)).max(50).optional(), remove: z.array(z.string().max(100)).max(50).optional() })), async (c) => {
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
  await guardJobCapacity(db, oid, "leads.bulk_enrich");
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
leadRoutes.post("/lists", zValidator("json", z.object({ name: z.string().min(1).max(200), description: z.string().max(5000).optional(), clientId: z.string().uuid().optional() })), async (c) => {
  const { db } = getDb();
  await assertRowCap(db, lists, orgId(c), "lists");
  await assertOwned(clients, c.req.valid("json").clientId, orgId(c), "Client", c);
  const [row] = await db.insert(lists).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
  return c.json(row, 201);
});
leadRoutes.delete("/lists/:listId", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(lists).where(and(eq(lists.id, c.req.param("listId")), eq(lists.orgId, orgId(c)))).returning({ id: lists.id, name: lists.name });
  if (!gone.length) throw notFound("List");
  await audit(c, "list.deleted", { targetType: "list", targetId: gone[0].id, data: { name: gone[0].name } });
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
leadRoutes.post("/suppressions", zValidator("json", z.object({ emails: z.array(emailField).min(1).max(5000), reason: z.string().max(200).optional() })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  // Stored in canonical form - the form a lead's email is stored in - so the send-time
  // lookup `suppressions.email = lead.email` cannot miss on case or stray whitespace.
  const emails = [...new Set(b.emails)];
  // `added` counts rows actually inserted; an address already suppressed is reported as such
  // rather than counted again.
  const inserted = await db.insert(suppressions).values(emails.map((email) => ({ orgId: orgId(c), email, reason: b.reason ?? "manual" }))).onConflictDoNothing().returning({ email: suppressions.email });
  await audit(c, "suppression.added", { targetType: "suppression", data: { requested: emails.length, added: inserted.length, reason: b.reason ?? "manual" } });
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
    .leftJoin(companies, and(eq(leads.companyId, companies.id), eq(companies.orgId, oid)))
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
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  // Already canonical: the schema ran canonicalEmail.
  const email = rawEmail;
  // A person who asked the platform itself to stop is not stored again by hand either.
  if (email && email !== existing.email && (await onPlatformList(email, db))) throw new ApiError(409, PLATFORM_LISTED, "suppressed");

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
    const domain = companyDomainOrNull(companyDomain);
    if (!domain) throw badRequest(`companyDomain "${companyDomain.slice(0, 80)}" is not a domain`);
    // Fill-only: this names a company that has no name yet. It does not rename one that
    // does - that company row is shared by every other lead at the domain.
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
  const resetVerification = emailChanged ? { emailStatus: "unknown", emailConfidence: 0, verifiedAt: null, emailVerifiedBy: null } : {};
  /**
   * A status typed in by hand is an opinion, not a verification.
   *
   * `emailStatus: "valid"` could be PATCHed onto any lead, and the client-facing report
   * then showed it as a verified address - with no verifier ever having looked at it and
   * no verification charged. The status is still the caller's to set, but the two fields
   * that say "a verifier checked this" are cleared with it, and they are what the report
   * (and anything else that says "verified") now requires.
   */
  const handSetStatus = !emailChanged && b.emailStatus !== undefined && b.emailStatus !== existing.emailStatus ? { verifiedAt: null, emailVerifiedBy: null } : {};

  const [row] = await db
    .update(leads)
    .set({ ...b, ...companyPatch, ...handSetStatus, ...resetVerification, ...(email !== undefined ? { email } : {}), updatedAt: new Date() })
    .where(eq(leads.id, existing.id))
    .returning();
  return c.json(row);
});

leadRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  const gone = (await eraseLeads(orgId(c), [c.req.param("id")], db)).deleted;
  if (!gone.length) throw notFound("Lead");
  return c.json({ ok: true });
});

/** Queue enrichment (company crawl + email find/verify + rescore). */
leadRoutes.post("/:id/enrich", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  await guardJobCapacity(db, oid, "lead.enrich");
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
  // Same rule as the lead.verify job: verifiedAt and emailVerifiedBy are stamped only when a
  // real verifier or the SMTP probe answered. A DNS/syntax-only result still updates the
  // status, but stamping it read as "verified" in the UI for an address nobody checked.
  const by = verifierOf(v);
  const [row] = await db.update(leads).set({ emailStatus: v.status, emailConfidence: v.confidence, ...(by ? { verifiedAt: new Date(), emailVerifiedBy: by } : {}), updatedAt: new Date() }).where(eq(leads.id, l.id)).returning();
  return c.json({ lead: row, verification: v });
});

/** Synchronous email finder for a lead with a company. */
leadRoutes.post("/:id/find-email", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const l = await db.query.leads.findFirst({ where: and(eq(leads.id, c.req.param("id")), eq(leads.orgId, oid)) });
  if (!l) throw notFound("Lead");
  const co = l.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, l.companyId), eq(companies.orgId, oid)) }) : null;
  const domain = co?.domain ?? (c.req.query("domain") ? companyDomainOrNull(c.req.query("domain")!) : null);
  if (!domain || !l.firstName || !l.lastName) throw badRequest("Need first name, last name and a company domain");
  await consume(db, oid, "verifications", 1);
  const r = await findEmail({ firstName: l.firstName, lastName: l.lastName, domain, knownPattern: co?.emailPattern, knownEmails: (co?.raw as { emailsFound?: string[] })?.emailsFound }, { smtp: env.smtpProbeEnabled, hunterApiKey: env.hunterApiKey, abstractApiKey: env.abstractEmailApiKey, reoonApiKey: env.reoonApiKey, millionVerifierApiKey: env.millionVerifierApiKey });
  if (r.email && canonicalEmail(r.email) && (await onPlatformList(canonicalEmail(r.email), db))) {
    // Nothing is stored and nothing is charged for an address that may not be kept.
    await consume(db, oid, "verifications", -1, { allowOverage: true }).catch(() => {});
    throw new ApiError(409, PLATFORM_LISTED, "suppressed");
  }
  if (r.email && canonicalEmail(r.email)) {
    // Only stamp verifiedAt when something checked the mailbox; a pattern guess is not verified.
    await db.update(leads).set({ email: canonicalEmail(r.email) ?? undefined, emailStatus: r.status, emailConfidence: r.confidence, verifiedAt: r.verifiedBy ? new Date() : null, emailVerifiedBy: r.verifiedBy ?? null, updatedAt: new Date() }).where(eq(leads.id, l.id));
    if (co && r.pattern && !co.emailPattern) await db.update(companies).set({ emailPattern: r.pattern }).where(eq(companies.id, co.id));
  }
  return c.json(r);
});

// ── helpers ──
export { parseCsv };

// The field's own name comes first, so a JSON row shaped like the POST /v1/leads body
// (`firstName`, `companyDomain` ...) maps the way the API reference says it does.
const ALIASES: Record<string, string[]> = {
  firstName: ["firstName", "first_name", "firstname", "first", "given_name"],
  lastName: ["lastName", "last_name", "lastname", "last", "surname", "family_name"],
  fullName: ["fullName", "full_name", "name", "contact_name", "person"],
  title: ["title", "job_title", "jobTitle", "position", "role", "designation"],
  email: ["email", "email_address", "work_email", "e_mail"],
  linkedinUrl: ["linkedinUrl", "linkedin", "linkedin_url", "linkedin_profile", "profile_url"],
  phone: ["phone", "mobile", "phone_number", "telephone"],
  location: ["location", "city", "address"],
  country: ["country"],
  companyName: ["companyName", "company", "company_name", "organization", "organisation", "employer"],
  companyDomain: ["companyDomain", "domain", "company_domain", "website", "company_website", "url"],
};
const FIELD_LABELS: Record<string, string> = { firstName: "First name", lastName: "Last name", fullName: "Name", title: "Title", email: "Email", linkedinUrl: "LinkedIn URL", phone: "Phone", location: "Location", country: "Country", companyName: "Company", companyDomain: "Company domain" };
/** Cell values that mean "nothing here". */
const PLACEHOLDER = /^(?:n\/?a|none|null|nil|undefined|unknown|-+|\?+|\.+)$/i;

type MappedRow = { ok: true; row: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Map one raw row (CSV record or JSON object) onto the lead fields.
 *
 * Mapping only - the lengths, the email and the URL are judged by the `importRow` schema
 * afterwards, with the same rules as POST /v1/leads. What is decided here is what cannot be
 * expressed as a field rule:
 *  - a mapped field must be text (a phone may be a number). `String(value)` used to turn
 *    an object into "[object Object]" and store it as a name;
 *  - a cell that is a placeholder ("n/a", "-") is no value;
 *  - an email cell with no "@" at all is no email (people write "none"); one that HAS an
 *    "@" is passed on to be validated, and refused there if it is not one address;
 *  - a LinkedIn URL without a scheme ("linkedin.com/in/x") gets https://; any other scheme
 *    is passed on and refused;
 *  - everything unmapped becomes a custom field, except keys that could reach a prototype.
 */
export function mapImportRow(input: Record<string, unknown>): MappedRow {
  const row = stripNulDeep(input);
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(row, k) ? row[k] : undefined);
  const out: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const [key, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const v = own(n);
      if (v === undefined || v === null || v === "") continue;
      used.add(n);
      let text: string;
      if (typeof v === "string") text = v.trim();
      else if (key === "phone" && typeof v === "number" && Number.isFinite(v)) text = String(v);
      else return { ok: false, reason: `${FIELD_LABELS[key]} must be text, not ${Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : `a ${typeof v}`}.` };
      if (!text || PLACEHOLDER.test(text)) continue;
      out[key] = text;
      break;
    }
  }
  if (typeof out.email === "string") {
    if (!out.email.includes("@")) delete out.email;
    else if (!canonicalEmail(out.email)) return { ok: false, reason: `Email "${out.email.slice(0, 80)}" is not a single valid email address. Use one address per lead, with no name, commas or brackets around it.` };
  }
  if (typeof out.linkedinUrl === "string") {
    const u = out.linkedinUrl;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      // No scheme. A host/path gets https://; anything else ("ask me") is not a URL at all.
      if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(u)) out.linkedinUrl = `https://${u}`;
      else delete out.linkedinUrl;
    } else if (!/^https?:\/\//i.test(u)) {
      return { ok: false, reason: "LinkedIn URL must be a web address starting with http:// or https://." };
    }
  }
  if (typeof out.companyDomain === "string") {
    // A website column is a hint about the company, not about the person: one that is not a
    // public domain (an intranet URL, an IP address) is dropped and the lead is still imported.
    const d = companyDomainOrNull(out.companyDomain);
    if (d) out.companyDomain = d;
    else delete out.companyDomain;
  }
  // JSON rows may carry real `tags` and `custom`, as the POST body does.
  const tags = own("tags");
  if (Array.isArray(tags)) {
    if (!tags.every((t) => typeof t === "string")) return { ok: false, reason: "Tags must be a list of text values." };
    out.tags = tags;
    used.add("tags");
  }
  const custom: Record<string, unknown> = {};
  const given = own("custom");
  if (given && typeof given === "object" && !Array.isArray(given)) {
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) if (!FORBIDDEN_KEYS.has(k) && v !== "" && v !== undefined && v !== null) custom[k] = v;
    used.add("custom");
  }
  for (const [k, v] of Object.entries(row)) {
    if (used.has(k) || FORBIDDEN_KEYS.has(k) || v === "" || v === undefined || v === null) continue;
    custom[k] = v;
  }
  out.custom = custom;
  return { ok: true, row: out };
}

/**
 * Kept for callers that used the old helper: maps a row and returns the upsert input, with
 * an unusable row mapped to an empty one. New code uses `mapImportRow` + the `importRow`
 * schema, which also say WHY a row was refused.
 */
export function normalizeImportRow(row: Record<string, unknown>) {
  const m = mapImportRow(row);
  const checked = m.ok ? importRow.safeParse(m.row) : null;
  return (checked?.success ? checked.data : { custom: {} }) as Parameters<typeof upsertLead>[1];
}
