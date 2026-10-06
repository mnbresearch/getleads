import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, campaigns, clients, consume, desc, enqueue, eq, getDb, icps, inArray, lists, playCandidates, playRuns, plays, runJobById, sql, tasks, type Play } from "@prospex/db";
import { normalizeLinkedinPostUrl } from "@prospex/core";
import { env } from "../env.js";
import { audit } from "../lib/audit.js";
import { parseCsvRecords } from "../lib/csv.js";
import { ApiError, badRequest, errorLine, notFound, requireSomeFields, UNUSABLE_VALUE_MESSAGE } from "../lib/errors.js";
import { httpUrlField } from "../lib/fields.js";
import { assertRowCap, guardJobCapacity } from "../lib/limits.js";
import { assertOwned } from "../lib/ownership.js";
import { zValidator } from "../lib/validate.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { handlers } from "../jobs.js";
import { companyDomainOrNull } from "../services/leads.js";
import { playEngines, type EngagerRow } from "../services/playEngines.js";
import {
  candidateOut,
  cleanText,
  countsByPlay,
  customerText,
  decideCandidates,
  ENGAGEMENTS,
  findPeopleForCandidate,
  ingestEngagers,
  listCandidates,
  parsePlayConfig,
  planFor,
  playCreateInput,
  playOut,
  playPatchInput,
  playPerformance,
  playTypes,
  runInProgress,
  runningPlays,
} from "../services/plays.js";
import { mapImportRow } from "./leads.js";

/**
 * Plays: recipes that find the people who need the product now, a review queue, and the
 * results per play.
 *
 * Members and full API keys may use everything here, like autopilots. Read-only keys get
 * the GETs (requireAuth refuses them anything else), so no GET in this file writes.
 * Static paths are declared before `/:id`.
 */
export const playRoutes = new Hono<Env>();
playRoutes.use("*", requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that is not an id never reaches the database. */
function pathId(c: Context<Env>, name = "id"): string {
  const id = c.req.param(name) ?? "";
  if (!UUID.test(id)) throw new ApiError(400, UNUSABLE_VALUE_MESSAGE, "bad_request");
  return id;
}

async function ownPlay(c: Context<Env>): Promise<Play> {
  const { db } = getDb();
  const play = await db.query.plays.findFirst({ where: and(eq(plays.id, pathId(c)), eq(plays.orgId, orgId(c))) });
  if (!play) throw notFound("Play");
  return play;
}

/**
 * A play scores against its ICP, saves into its list, enrols into its campaign and
 * delivers to its client by id, later and unattended. Each id must be this workspace's own
 * before it is stored.
 */
async function assertPlayRefs(c: Context<Env>, oid: string, b: { icpId?: string | null; listId?: string | null; campaignId?: string | null; clientId?: string | null }) {
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  await assertOwned(lists, b.listId, oid, "List", c);
  await assertOwned(campaigns, b.campaignId, oid, "Campaign", c);
  await assertOwned(clients, b.clientId, oid, "Client", c);
  if (b.clientId) {
    const { requireClient } = await import("../services/clients.js");
    const client = await requireClient(oid, b.clientId);
    if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before running plays for it.");
  }
}

/** When a play on a schedule should next run. A new or re-scheduled play runs at the next tick. */
const nextRunFor = (runEveryHours: number | null | undefined, type: string) => (runEveryHours && type !== "engagers_upload" ? new Date() : null);

// ── Catalogue and planning ──

playRoutes.get("/types", async (c) => c.json({ types: await playTypes(c.get("auth").org) }));

/** What to run for a product, from its website. Saves nothing. */
playRoutes.post("/plan", rateLimit({ perMinute: 6, name: "plays-plan" }), zValidator("json", z.object({ website: z.string().trim().min(1).max(300) })), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const domain = companyDomainOrNull(c.req.valid("json").website);
  if (!domain) throw badRequest("Enter your website as a public address, like example.com.");
  await consume(db, oid, "searches", 1);
  try {
    return c.json(await planFor(c.get("auth").org, domain));
  } catch (e) {
    // Nothing was delivered, so the search is given back. The detail is for the operator.
    await consume(db, oid, "searches", -1, { allowOverage: true }).catch(() => {});
    console.warn(`[plays] planning failed for ${oid}: ${(e as Error)?.name ?? "Error"}`);
    throw new ApiError(502, "We could not read that website to plan from this time. Check the address and try again in a moment.", "plan_unavailable");
  }
});

// ── The review queue ──

const candidateQuery = z.object({
  status: z.enum(["pending", "approved", "skipped"]).default("pending"),
  playId: z.string().uuid().optional(),
  kind: z.enum(["person", "company", "post"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

playRoutes.get("/candidates", zValidator("query", candidateQuery), async (c) => {
  const oid = orgId(c);
  const q = c.req.valid("query");
  // Checked like any other id - but without the security-log entry a refused write gets:
  // this is a GET, and a GET in this file writes nothing at all.
  await assertOwned(plays, q.playId, oid, "Play");
  return c.json(await listCandidates(oid, q));
});

const decideInput = z.object({
  decisions: z.array(z.object({ id: z.string().uuid(), decision: z.enum(["approve", "skip"]), skipReason: z.string().trim().max(200).optional() })).min(1).max(200),
  enroll: z.boolean().optional(),
});

/**
 * Approve or skip candidates. Approval is the only way a play's finding becomes a lead.
 * Nothing is sent: `enroll` puts approved people in the play's campaign, which still only
 * sends when it is active.
 */
playRoutes.post("/candidates/decide", rateLimit({ perMinute: 120, name: "plays-decide" }), zValidator("json", decideInput), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  // Before anything is decided: a "queue is full" or "too many tasks" answer must not come
  // after half the decisions were applied.
  if (b.enroll) await guardJobCapacity(db, oid, "play.enroll");
  // Approving a conversation, or a recorded job change, creates a task: there must be room for them.
  const approving = [...new Set(b.decisions.filter((d) => d.decision === "approve").map((d) => d.id))];
  if (approving.length) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(playCandidates)
      .where(and(eq(playCandidates.orgId, oid), inArray(playCandidates.id, approving), eq(playCandidates.status, "pending"), sql`(${playCandidates.kind} = 'post' OR ${playCandidates.signalType} = 'job_change')`));
    if (Number(n) > 0) await assertRowCap(db, tasks, oid, "tasks", Number(n));
  }
  const r = await decideCandidates(oid, c.get("auth").user?.id ?? null, b.decisions, { enroll: b.enroll === true });
  if (r.leadsCreated || r.leadsExisting) await audit(c, "play.candidates_approved", { targetType: "play_candidate", data: { approved: r.approved, leadsCreated: r.leadsCreated, leadsExisting: r.leadsExisting, enrolled: r.enrolled, queuedForEmail: r.queuedForEmail } });
  return c.json(r);
});

const TITLE_LIST = z.array(z.string().trim().min(1).max(100)).max(10);

/** People with the wanted titles at one company candidate, added to the same play for review. */
playRoutes.post("/candidates/:id/find-people", rateLimit({ perMinute: 12, name: "plays-find-people" }), zValidator("json", z.object({ titles: TITLE_LIST.optional(), limit: z.number().int().min(1).max(5).default(3) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const candidate = await db.query.playCandidates.findFirst({ where: and(eq(playCandidates.id, pathId(c)), eq(playCandidates.orgId, oid)) });
  if (!candidate) throw notFound("Candidate");
  if (candidate.kind !== "company") throw badRequest("People can only be looked up for a company.");
  const play = await db.query.plays.findFirst({ where: and(eq(plays.id, candidate.playId), eq(plays.orgId, oid)) });
  if (!play) throw notFound("Play");
  const titles = (b.titles?.length ? b.titles : (play.targetTitles ?? [])).map((t) => cleanText(t, 100)).filter((t): t is string => !!t).slice(0, 10);
  if (!titles.length) throw badRequest("Say which job titles to look for.");
  await consume(db, oid, "searches", 1);
  const giveBack = () => consume(db, oid, "searches", -1, { allowOverage: true }).catch(() => {});
  let r: Awaited<ReturnType<typeof findPeopleForCandidate>>;
  try {
    r = await findPeopleForCandidate(candidate, play, { titles, limit: b.limit });
  } catch (e) {
    await giveBack();
    console.warn(`[plays] people search failed for candidate ${candidate.id}: ${(e as Error)?.name ?? "Error"}`);
    throw new ApiError(502, "The people search could not run this time. This is not a finding that nobody works there - try again in a moment.", "search_unavailable");
  }
  // A search that could not look at anything is not charged.
  if (r.blocked) await giveBack();
  return c.json({ added: r.added.length, candidates: r.added.map((x) => candidateOut(x, play)), ...(r.note ? { note: r.note } : {}) });
});

// ── Results ──

playRoutes.get("/performance", zValidator("query", z.object({ days: z.coerce.number().int().min(7).max(365).default(90) })), async (c) => c.json(await playPerformance(orgId(c), c.req.valid("query").days)));

// ── Plays ──

playRoutes.get("/", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const rows = await db.select().from(plays).where(eq(plays.orgId, oid)).orderBy(desc(plays.createdAt)).limit(500);
  const ids = rows.map((r) => r.id);
  const [counts, running] = await Promise.all([countsByPlay(oid, ids), runningPlays(oid, ids)]);
  return c.json({ plays: rows.map((p) => playOut(p, counts.get(p.id), running.has(p.id))) });
});

playRoutes.post("/", zValidator("json", playCreateInput), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  await assertRowCap(db, plays, oid, "plays");
  await assertPlayRefs(c, oid, b);
  const runEveryHours = b.type === "engagers_upload" ? null : (b.runEveryHours ?? null);
  const [row] = await db
    .insert(plays)
    .values({
      orgId: oid,
      name: b.name,
      type: b.type,
      status: b.status ?? "active",
      config: b.config,
      targetTitles: b.targetTitles ?? [],
      icpId: b.icpId ?? null,
      clientId: b.clientId ?? null,
      listId: b.listId ?? null,
      campaignId: b.campaignId ?? null,
      autoApprove: b.autoApprove ?? false,
      minScore: b.minScore ?? 0,
      runEveryHours,
      nextRunAt: nextRunFor(runEveryHours, b.type),
      createdBy: c.get("auth").user?.id ?? null,
    })
    .returning();
  await audit(c, "play.created", { targetType: "play", targetId: row.id, data: { type: row.type, autoApprove: row.autoApprove, runEveryHours: row.runEveryHours } });
  return c.json({ play: playOut(row) }, 201);
});

playRoutes.get("/:id", async (c) => {
  const play = await ownPlay(c);
  const { db } = getDb();
  const runs = await db.select().from(playRuns).where(and(eq(playRuns.playId, play.id), eq(playRuns.orgId, play.orgId))).orderBy(desc(playRuns.startedAt)).limit(10);
  const counts = await countsByPlay(play.orgId, [play.id]);
  return c.json({ play: playOut(play, counts.get(play.id), !!(await runInProgress(play))), runs });
});

playRoutes.patch("/:id", zValidator("json", playPatchInput), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  requireSomeFields(b);
  const play = await ownPlay(c);
  if (b.type !== undefined && b.type !== play.type) throw badRequest("A play's type cannot be changed. Create a new play instead.");
  await assertPlayRefs(c, oid, b);
  const { db } = getDb();
  const set: Partial<typeof plays.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name;
  // Validated against the play's own type, with the same schema a new play goes through.
  if (b.config !== undefined) set.config = parsePlayConfig(play.type, b.config);
  if (b.targetTitles !== undefined) set.targetTitles = b.targetTitles;
  if (b.icpId !== undefined) set.icpId = b.icpId;
  if (b.clientId !== undefined) set.clientId = b.clientId;
  if (b.listId !== undefined) set.listId = b.listId;
  if (b.campaignId !== undefined) set.campaignId = b.campaignId;
  if (b.autoApprove !== undefined) set.autoApprove = b.autoApprove;
  if (b.minScore !== undefined) set.minScore = b.minScore;
  if (b.status !== undefined) set.status = b.status;
  if (b.runEveryHours !== undefined) {
    const every = play.type === "engagers_upload" ? null : b.runEveryHours;
    set.runEveryHours = every;
    // A new interval counts from the last run; a play never run on a schedule starts at the next tick.
    set.nextRunAt = every ? new Date(Math.max(Date.now(), (play.lastRunAt?.getTime() ?? 0) + every * 3600_000)) : null;
  }
  const [row] = await db.update(plays).set(set).where(and(eq(plays.id, play.id), eq(plays.orgId, oid))).returning();
  if (!row) throw notFound("Play");
  if (b.autoApprove !== undefined && b.autoApprove !== play.autoApprove) await audit(c, "play.auto_approve_changed", { targetType: "play", targetId: row.id, data: { autoApprove: row.autoApprove, minScore: row.minScore } });
  const counts = await countsByPlay(oid, [row.id]);
  return c.json({ play: playOut(row, counts.get(row.id), !!(await runInProgress(row))) });
});

/** Delete a play and what is waiting in it. Leads it already created stay. */
playRoutes.delete("/:id", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const gone = await db.delete(plays).where(and(eq(plays.id, pathId(c)), eq(plays.orgId, oid))).returning({ id: plays.id, type: plays.type });
  if (!gone.length) throw notFound("Play");
  await audit(c, "play.deleted", { targetType: "play", targetId: gone[0].id, data: { type: gone[0].type } });
  return c.json({ ok: true });
});

playRoutes.post("/:id/run", rateLimit({ perMinute: 12, name: "plays-run" }), async (c) => {
  const oid = orgId(c);
  const play = await ownPlay(c);
  if (play.type === "engagers_upload") throw badRequest("This play is fed by uploads - add people with Upload.");
  const { db } = getDb();
  const going = await runInProgress(play);
  // `runId` lets a client that lost track of the run it started pick it up again.
  if (going) throw new ApiError(409, "This play is already running. Its result will appear here when it finishes.", "already_running", { runId: going });
  // Before the charge and before the run row: "try again" must leave nothing behind.
  await guardJobCapacity(db, oid, "play.run");
  await consume(db, oid, "searches", 1);
  let run: typeof playRuns.$inferSelect;
  let jobId: string;
  try {
    [run] = await db.insert(playRuns).values({ orgId: oid, playId: play.id, status: "running", trigger: "manual" }).returning();
    // One attempt: a run that breaks is recorded as failed (and its search given back) by
    // the handler, and running the whole search again unasked would spend it twice.
    jobId = (await enqueue(db, "play.run", { playId: play.id, runId: run.id, charged: true }, { orgId: oid, priority: 2, maxAttempts: 1 })).id;
  } catch (e) {
    await consume(db, oid, "searches", -1, { allowOverage: true }).catch(() => {});
    throw e;
  }
  if (env.jobMode === "inline") {
    // Serverless: run this play's own job now, not the whole queue.
    await runJobById(db, handlers, jobId).catch((e) => console.warn(`[plays] inline run of play ${play.id} failed: ${errorLine(e)}`));
    const done = await db.query.playRuns.findFirst({ where: and(eq(playRuns.id, run.id), eq(playRuns.orgId, oid)) });
    return c.json({ run: done ?? run, jobId, runId: run.id }, 200);
  }
  return c.json({ jobId, runId: run.id }, 202);
});

playRoutes.get("/:id/runs", async (c) => {
  const play = await ownPlay(c);
  const { db } = getDb();
  const runs = await db.select().from(playRuns).where(and(eq(playRuns.playId, play.id), eq(playRuns.orgId, play.orgId))).orderBy(desc(playRuns.startedAt)).limit(20);
  return c.json({ runs });
});

// ── Uploads ──

/** Most people in one upload. */
export const UPLOAD_MAX_ROWS = 2_000;
const cell = (max: number) => z.string().max(max).optional();
/** Lenient on purpose: a row that is not usable is reported with its number, it does not fail the upload. */
const engagerRow = z.object({ fullName: cell(300), firstName: cell(300), lastName: cell(300), title: cell(500), companyName: cell(300), companyDomain: cell(300), linkedinUrl: cell(600), email: cell(320), location: cell(400), note: cell(600) });
const uploadInput = z
  .object({
    engagement: z.enum(ENGAGEMENTS),
    postUrl: httpUrlField(2000).optional(),
    postTitle: z.string().trim().max(200).optional(),
    postAuthor: z.string().trim().max(120).optional(),
    people: z.array(engagerRow).max(UPLOAD_MAX_ROWS).optional(),
    csv: z.string().max(2 * 1024 * 1024).optional(),
  })
  .refine((v) => !(v.people && v.csv !== undefined), { message: "Send the people as a list or as a CSV, not both." });

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One CSV record as an engager row, through the same header names the lead import accepts. */
function csvRow(record: Record<string, string>): { ok: true; data: EngagerRow } | { ok: false; reason: string } {
  const m = mapImportRow(record);
  if (!m.ok) return m;
  const r = m.row;
  const custom = (r.custom ?? {}) as Record<string, unknown>;
  return { ok: true, data: { fullName: text(r.fullName), firstName: text(r.firstName), lastName: text(r.lastName), title: text(r.title), companyName: text(r.companyName), companyDomain: text(r.companyDomain), linkedinUrl: text(r.linkedinUrl), email: text(r.email), location: text(r.location), note: text(custom.note) ?? text(custom.comment) } };
}

/** Add people who engaged with a post, signed up, followed or attended to an upload play's review queue. */
playRoutes.post("/:id/upload", rateLimit({ perMinute: 12, name: "plays-upload" }), zValidator("json", uploadInput), async (c) => {
  const play = await ownPlay(c);
  if (play.type !== "engagers_upload") throw badRequest("Only a \"People who engaged\" play takes uploads.");
  const b = c.req.valid("json");
  const rows: { row: number; data: EngagerRow }[] = [];
  const rejected: { row: number; reason: string }[] = [];
  let blockedNote: string | undefined;

  if (b.people) {
    b.people.forEach((p, i) => rows.push({ row: i + 1, data: p }));
  } else if (b.csv !== undefined) {
    const parsed = parseCsvRecords(b.csv);
    if (parsed.unterminatedQuote) throw badRequest("That CSV has a quote that is never closed, so the rows after it cannot be told apart. Fix the file and upload it again.");
    if (parsed.records.length > UPLOAD_MAX_ROWS) throw badRequest(`Upload at most ${UPLOAD_MAX_ROWS.toLocaleString("en-US")} people at a time.`);
    parsed.records.forEach((rec, i) => {
      const m = csvRow(rec);
      if (m.ok) rows.push({ row: i + 1, data: m.data });
      else rejected.push({ row: i + 1, reason: m.reason });
    });
  } else {
    // No list: the post itself. Only a LinkedIn post anyone can open without signing in can be
    // read; for any other link the answer says so, as a run that could not look.
    if (!b.postUrl) throw badRequest("Add the people as a list or a CSV, or give the link of a public LinkedIn post.");
    if (!normalizeLinkedinPostUrl(b.postUrl)) {
      blockedNote = "Who engaged can only be read from the link of a public LinkedIn post, and this link is not one. Paste the profile links or upload a CSV instead.";
    } else {
      let post: Awaited<ReturnType<ReturnType<typeof playEngines>["linkedinPostEngagers"]>>;
      try {
        post = await playEngines().linkedinPostEngagers(b.postUrl);
      } catch (e) {
        console.warn(`[plays] could not read a post for play ${play.id}: ${(e as Error)?.name ?? "Error"}`);
        post = { people: [], publicPage: false };
      }
      if (post.refused) blockedNote = customerText(post.refused, 300);
      else if (!post.publicPage) blockedNote = "LinkedIn did not show that post without signing in, so nobody could be read from it. Paste the profile links or upload a CSV instead.";
      else if (!post.people.length) blockedNote = "That post is public, but it did not show who engaged with it. Paste the profile links or upload a CSV instead.";
      post.people.slice(0, UPLOAD_MAX_ROWS).forEach((p, i) => rows.push({ row: i + 1, data: { fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title, companyName: p.companyName, linkedinUrl: p.linkedinUrl, location: p.location } }));
    }
  }

  const r = await ingestEngagers(play, { engagement: b.engagement, postUrl: b.postUrl, postTitle: b.postTitle, postAuthor: b.postAuthor, rows, rejected, blockedNote });
  await audit(c, "play.uploaded", { targetType: "play", targetId: play.id, data: { rows: rows.length + rejected.length, added: r.added, duplicates: r.duplicates, rejected: r.rejectedCount } });
  return c.json(r);
});
