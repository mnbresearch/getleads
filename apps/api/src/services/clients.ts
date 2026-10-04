import { and, campaignContacts, clientLeadDeliveries, clients, eq, getDb, icps, inArray, leads, or, organizations, sql, type Client } from "@prospex/db";
import { scoreLeadRules, type IcpCriteria, type LeadForScoring } from "@prospex/core";
import { badRequest, notFound } from "../lib/errors.js";
import { hashLinkToken, isLiveShareCopy, LIVE_SHARE_COPY_SQL, migrateClientShareToken, newShareToken, openShareToken, shareTokenColumns } from "../lib/linkTokens.js";

/**
 * Client workspaces: every lead belongs to a client, or sits in the pool waiting for one.
 *
 * Built for an agency running pipeline for many companies at once. The rules this module
 * holds to, because each one is a way leads quietly go to waste:
 *
 *   1. One owner per lead. Assignment never silently takes a lead from another client; a
 *      move has to be asked for. Two clients of one agency emailing the same person from the
 *      same sending setup is a deliverability problem and a relationship problem.
 *   2. Every count says what it did NOT do. "Assigned 40" is not a complete answer when 12
 *      of the 52 asked for were already owned by someone else.
 *   3. Routing only acts on evidence. A lead is suggested for a client when it fits that
 *      client's ICP clearly, on data we actually have, and clearly better than any other
 *      client. Ties and guesses are shown to a person, never auto-assigned.
 */

type Db = ReturnType<typeof getDb>["db"];

/** Rows out of `db.execute`, which this driver returns as a bare array. */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = (res as { rows?: unknown })?.rows;
  return Array.isArray(r) ? (r as T[]) : [];
}

const n = (v: unknown) => Number(v ?? 0);

// ── Stats ────────────────────────────────────────────────────────────────────────────

export interface ClientStats {
  leads: number;
  /** Assigned to this client since the first of the current month (UTC). */
  deliveredThisMonth: number;
  new7d: number;
  withEmail: number;
  verified: number;
  contacted: number;
  replied: number;
  qualified: number;
  customers: number;
  lastActivity: string | null;
}

export interface ClientAttention {
  /** No email address yet: enrichment would turn these into contactable leads. */
  noEmail: number;
  /** Has an address that has never been checked. Sending to these is how domains get burned. */
  unverified: number;
  /** The address is known bad. Keeping them in play only hurts reply rates and reputation. */
  badEmail: number;
  /**
   * Verified, never contacted, in no campaign, and assigned more than a week ago. Paid-for
   * leads that are ready to use and that nobody is using - the most literal form of waste.
   */
  readyButIdle: number;
}

export type AttentionBucket = keyof ClientAttention;
export const ATTENTION_BUCKETS: AttentionBucket[] = ["noEmail", "unverified", "badEmail", "readyButIdle"];

/**
 * A stored "email" that is not one address: a display name with angle brackets, several
 * addresses separated by commas or semicolons, quotes, or whitespace inside the value
 * ("Name <a@b.com>", "a@x.com, b@x.com"). Rows written before every writer validated the
 * address still hold these. Nothing can be sent to them - enrolment skips them and a send
 * refuses them - so they belong with the known-bad addresses, where the customer can see
 * and correct them, rather than sitting among the unverified ones looking usable.
 *
 * A Postgres regular expression, used on both sides of the bucket definitions below.
 */
export const MALFORMED_EMAIL_PATTERN = '[<>,;"\\s]';

/**
 * The one definition of each bucket, over the `leads` table.
 *
 * Used for the counts on the dashboard, for the ids an action acts on, and for the Leads
 * page filter behind each "View" link - so the number on the card, the leads acted on and
 * the list you land on are always the same set. They were three hand-copied definitions
 * before, and the "View" links had already drifted from the counts beside them.
 */
export function attentionWhere(bucket: AttentionBucket): ReturnType<typeof sql> {
  switch (bucket) {
    case "noEmail":
      return sql`(${leads.email} IS NULL AND ${leads.status} <> 'lost')`;
    case "unverified":
      return sql`(${leads.email} IS NOT NULL AND ${leads.emailStatus} = 'unknown' AND ${leads.email} !~ ${MALFORMED_EMAIL_PATTERN} AND ${leads.status} <> 'lost')`;
    case "badEmail":
      return sql`((${leads.emailStatus} = 'invalid' OR (${leads.email} IS NOT NULL AND ${leads.email} ~ ${MALFORMED_EMAIL_PATTERN})) AND ${leads.status} <> 'lost')`;
    case "readyButIdle":
      return sql`(${leads.status} = 'new' AND ${leads.emailStatus} IN ('valid','catch_all') AND coalesce(${leads.clientAssignedAt}, ${leads.createdAt}) < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc WHERE cc.lead_id = ${leads.id}))`;
  }
}

const STATS_SQL = (orgId: string, clientFilter: ReturnType<typeof sql>) => sql`
  SELECT
    l.client_id                                                                       AS client_id,
    count(*)::int                                                                     AS leads,
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM client_lead_deliveries d
      WHERE d.client_id = l.client_id AND d.lead_id = l.id
        AND d.delivered_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ))::int                                                                           AS delivered_this_month,
    count(*) FILTER (WHERE l.created_at >= now() - interval '7 days')::int            AS new_7d,
    count(*) FILTER (WHERE l.email IS NOT NULL)::int                                  AS with_email,
    count(*) FILTER (WHERE l.email_status = 'valid')::int                             AS verified,
    count(*) FILTER (WHERE l.status IN ('contacted','engaged','replied','qualified','customer'))::int AS contacted,
    count(*) FILTER (WHERE l.status IN ('replied','qualified','customer'))::int       AS replied,
    count(*) FILTER (WHERE l.status IN ('qualified','customer'))::int                 AS qualified,
    count(*) FILTER (WHERE l.status = 'customer')::int                                AS customers,
    max(l.updated_at)                                                                 AS last_activity,
    count(*) FILTER (WHERE l.email IS NULL AND l.status <> 'lost')::int               AS no_email,
    count(*) FILTER (WHERE l.email IS NOT NULL AND l.email_status = 'unknown' AND l.email !~ ${MALFORMED_EMAIL_PATTERN} AND l.status <> 'lost')::int AS unverified,
    count(*) FILTER (WHERE (l.email_status = 'invalid' OR (l.email IS NOT NULL AND l.email ~ ${MALFORMED_EMAIL_PATTERN})) AND l.status <> 'lost')::int AS bad_email,
    count(*) FILTER (
      WHERE l.status = 'new'
        AND l.email_status IN ('valid','catch_all')
        AND coalesce(l.client_assigned_at, l.created_at) < now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc WHERE cc.lead_id = l.id)
    )::int                                                                            AS ready_but_idle
  FROM leads l
  WHERE l.org_id = ${orgId} AND ${clientFilter}
  GROUP BY l.client_id`;

type StatsRow = Record<string, unknown> & { client_id: string | null };

function toStats(r: StatsRow | undefined): ClientStats {
  return {
    leads: n(r?.leads),
    deliveredThisMonth: n(r?.delivered_this_month),
    new7d: n(r?.new_7d),
    withEmail: n(r?.with_email),
    verified: n(r?.verified),
    contacted: n(r?.contacted),
    replied: n(r?.replied),
    qualified: n(r?.qualified),
    customers: n(r?.customers),
    lastActivity: r?.last_activity ? new Date(String(r.last_activity)).toISOString() : null,
  };
}

function toAttention(r: StatsRow | undefined): ClientAttention {
  return { noEmail: n(r?.no_email), unverified: n(r?.unverified), badEmail: n(r?.bad_email), readyButIdle: n(r?.ready_but_idle) };
}

/** Progress against the monthly target, or null when the client has no target. */
function targetProgress(c: Pick<Client, "monthlyLeadTarget">, stats: ClientStats) {
  if (!c.monthlyLeadTarget || c.monthlyLeadTarget <= 0) return null;
  const now = new Date();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  // Where delivery should be by today if it ran evenly through the month. Without this a
  // client at 30% on the 5th and one at 30% on the 28th look identical, and only one of
  // them is a problem.
  const expectedByNow = Math.round((c.monthlyLeadTarget * dayOfMonth) / daysInMonth);
  return {
    target: c.monthlyLeadTarget,
    delivered: stats.deliveredThisMonth,
    share: Number((stats.deliveredThisMonth / c.monthlyLeadTarget).toFixed(4)),
    expectedByNow,
    onTrack: stats.deliveredThisMonth >= expectedByNow,
  };
}

// ── Overview ─────────────────────────────────────────────────────────────────────────

export async function clientOverview(orgId: string, opts: { includeArchived?: boolean } = {}) {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(clients)
    .where(opts.includeArchived ? eq(clients.orgId, orgId) : and(eq(clients.orgId, orgId), sql`${clients.status} <> 'archived'`))
    .orderBy(clients.name);

  const stats = rowsOf<StatsRow>(await db.execute(STATS_SQL(orgId, sql`true`)));
  // Keyed by client id, with the pool under null - GROUP BY client_id puts unassigned leads
  // in a group of their own, which is exactly the pool.
  const byClient = new Map<string | null, StatsRow>(stats.map((r) => [r.client_id ?? null, r]));
  const pool = byClient.get(null);

  const list = rows.map((c) => {
    const s = byClient.get(c.id);
    const st = toStats(s);
    return { ...publicClient(c), stats: st, attention: toAttention(s), target: targetProgress(c, st) };
  });

  const sum = (k: keyof ClientStats) => list.reduce((a, c) => a + (c.stats[k] as number), 0);
  const attentionTotal = list.reduce((a, c) => a + c.attention.noEmail + c.attention.unverified + c.attention.badEmail + c.attention.readyButIdle, 0);

  return {
    clients: list,
    totals: {
      activeClients: list.filter((c) => c.status === "active").length,
      assignedLeads: sum("leads"),
      deliveredThisMonth: sum("deliveredThisMonth"),
      targetThisMonth: list.reduce((a, c) => a + (c.target?.target ?? 0), 0),
      verified: sum("verified"),
      replied: sum("replied"),
      qualified: sum("qualified"),
      needsAttention: attentionTotal,
      // Clients behind the pace needed to hit this month's target. The number an agency
      // owner actually opens this page for.
      behindTarget: list.filter((c) => c.status === "active" && c.target && !c.target.onTrack).length,
    },
    pool: { leads: n(pool?.leads), withEmail: n(pool?.with_email), verified: n(pool?.verified), attention: toAttention(pool) },
  };
}

/**
 * Does this client have a report link?
 *
 * Yes when the row still has its plaintext token (a link from before this release - that
 * column is what the previous release reads and writes, so it decides), or when it has a
 * hash together with the encrypted copy this release writes for a link without plaintext.
 * A hash left behind on a link the previous release turned off (no plaintext, and either no
 * copy or the copy that was kept next to the plaintext) is not a link.
 */
export function hasShareLink(c: Pick<Client, "shareToken" | "shareTokenHash" | "shareTokenEncrypted">): boolean {
  return !!c.shareToken || (!!c.shareTokenHash && isLiveShareCopy(c.shareTokenEncrypted));
}

/**
 * The share token is a credential: it is returned only by the routes that manage it. None
 * of its three columns (the legacy plaintext, the hash, the encrypted copy) is ever part of
 * a client as the API returns it - only whether sharing is on.
 */
function publicClient(c: Client) {
  const { shareToken: _t, shareTokenHash: _h, shareTokenEncrypted: _e, ...rest } = c;
  return { ...rest, sharing: hasShareLink(c) };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────────────

async function assertIcpInOrg(db: Db, orgId: string, icpId: string | null | undefined) {
  if (!icpId) return;
  const icp = await db.query.icps.findFirst({ where: and(eq(icps.id, icpId), eq(icps.orgId, orgId)) });
  // Tenancy, not validation: an ICP id from another workspace must not be linkable here.
  if (!icp) throw badRequest("That ICP does not exist in this workspace.");
}

export async function requireClient(orgId: string, id: string): Promise<Client> {
  const { db } = getDb();
  const c = await db.query.clients.findFirst({ where: and(eq(clients.id, id), eq(clients.orgId, orgId)) });
  if (!c) throw notFound("Client");
  return c;
}

export interface ClientInput {
  name: string;
  domain?: string | null;
  industry?: string | null;
  status?: "active" | "paused" | "archived";
  color?: string | null;
  icpId?: string | null;
  monthlyLeadTarget?: number | null;
  notes?: string | null;
  reportShowTarget?: boolean;
}

/**
 * Was this the case-insensitive unique name index?
 *
 * Drizzle wraps the driver error, so the Postgres code and constraint live on `cause`, and
 * the outer message is just "Failed query: ...". Matching only the outer message turned a
 * clear "that name is taken" into a 500.
 */
function isDuplicateName(e: unknown): boolean {
  for (let cur: any = e, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (cur.code === "23505" && /idx_clients_org_name/.test(String(cur.constraint_name ?? cur.constraint ?? cur.message ?? ""))) return true;
    if (/idx_clients_org_name/.test(String(cur.message ?? ""))) return true;
  }
  return false;
}

function cleanDomain(d?: string | null) {
  if (!d) return null;
  const v = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return v || null;
}

export async function createClient(orgId: string, input: ClientInput) {
  const { db } = getDb();
  await assertIcpInOrg(db, orgId, input.icpId);
  try {
    const [row] = await db
      .insert(clients)
      .values({
        orgId,
        name: input.name.trim(),
        domain: cleanDomain(input.domain),
        industry: input.industry ?? null,
        status: input.status ?? "active",
        color: input.color ?? null,
        icpId: input.icpId ?? null,
        monthlyLeadTarget: input.monthlyLeadTarget ?? null,
        notes: input.notes ?? null,
        reportShowTarget: input.reportShowTarget ?? false,
      })
      .returning();
    if (row.icpId) await linkIcp(db, orgId, row.id, null, row.icpId);
    return publicClient(row);
  } catch (e) {
    if (isDuplicateName(e)) throw badRequest(`A client called "${input.name.trim()}" already exists.`);
    throw e;
  }
}

/**
 * Point an ICP back at the client that uses it.
 *
 * Only claims an ICP nobody else has claimed: several clients may share one ICP, and the
 * last one saved used to overwrite the link for all of them. When a client switches ICP,
 * the old one is released - but only if it still points here.
 */
async function linkIcp(db: Db, orgId: string, clientId: string, oldIcpId: string | null, newIcpId: string | null) {
  if (oldIcpId && oldIcpId !== newIcpId) {
    await db.update(icps).set({ clientId: null }).where(and(eq(icps.id, oldIcpId), eq(icps.orgId, orgId), eq(icps.clientId, clientId)));
  }
  if (newIcpId) {
    await db.update(icps).set({ clientId }).where(and(eq(icps.id, newIcpId), eq(icps.orgId, orgId), sql`${icps.clientId} IS NULL`));
  }
}

export async function updateClient(orgId: string, id: string, input: Partial<ClientInput>) {
  const { db } = getDb();
  const before = await requireClient(orgId, id);
  if (input.icpId !== undefined) await assertIcpInOrg(db, orgId, input.icpId);
  const patch: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.domain !== undefined) patch.domain = cleanDomain(input.domain);
  if (input.industry !== undefined) patch.industry = input.industry;
  if (input.status !== undefined) patch.status = input.status;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icpId !== undefined) patch.icpId = input.icpId;
  if (input.monthlyLeadTarget !== undefined) patch.monthlyLeadTarget = input.monthlyLeadTarget;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.reportShowTarget !== undefined) patch.reportShowTarget = input.reportShowTarget;
  try {
    const [row] = await db.update(clients).set(patch).where(and(eq(clients.id, id), eq(clients.orgId, orgId))).returning();
    if (input.icpId !== undefined) await linkIcp(db, orgId, id, before.icpId, input.icpId);
    return publicClient(row);
  } catch (e) {
    if (isDuplicateName(e)) throw badRequest(`A client called "${input.name?.trim()}" already exists.`);
    throw e;
  }
}

/**
 * Delete a client. Its leads go back to the pool - they were paid for, and a different
 * client may well want them. Nothing about the lead itself is lost.
 */
export async function deleteClient(orgId: string, id: string) {
  const { db } = getDb();
  await requireClient(orgId, id);
  const released = await db
    .update(leads)
    .set({ clientId: null, clientAssignedAt: null, updatedAt: new Date() })
    .where(and(eq(leads.orgId, orgId), eq(leads.clientId, id)))
    .returning({ id: leads.id });
  await db.delete(clients).where(and(eq(clients.id, id), eq(clients.orgId, orgId)));
  return { deleted: true, leadsReturnedToPool: released.length };
}

// ── Assignment ───────────────────────────────────────────────────────────────────────

/** Record first deliveries. Re-assigning a lead a client already had never counts twice. */
async function recordDeliveries(db: Db, clientId: string, leadIds: string[]) {
  if (leadIds.length === 0) return;
  await db
    .insert(clientLeadDeliveries)
    .values(leadIds.map((leadId) => ({ clientId, leadId })))
    .onConflictDoNothing();
}

/**
 * Stop a moved lead's sequences in its previous client's campaigns.
 *
 * Otherwise a move hands the person to client B while client A's sequence keeps emailing
 * them from the same sending setup - the double contact that one-owner-per-lead exists to
 * prevent, arriving through the move itself. Returning a lead to the pool does not do this:
 * nobody else is about to contact them.
 */
async function stopPreviousClientSequences(db: Db, orgId: string, moves: { leadId: string; fromClientId: string }[]) {
  let stopped = 0;
  for (const m of moves) {
    const rows = await db
      .update(campaignContacts)
      .set({ status: "reassigned", nextSendAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(campaignContacts.leadId, m.leadId),
          sql`${campaignContacts.status} IN ('queued','active')`,
          sql`${campaignContacts.campaignId} IN (SELECT id FROM campaigns WHERE org_id = ${orgId} AND client_id = ${m.fromClientId})`,
        ),
      )
      .returning({ id: campaignContacts.id });
    stopped += rows.length;
  }
  return stopped;
}

export interface AssignResult {
  requested: number;
  assigned: number;
  /** Already belonged to this client; nothing to do. */
  alreadyThisClient: number;
  /** Owned by a different client and left alone. Pass `move: true` to take them. */
  ownedByAnotherClient: number;
  /** Not in this workspace, or deleted. */
  notFound: number;
  /** On a move: sequences stopped in the previous client's campaigns. */
  stoppedSequences?: number;
}

export async function assignLeads(orgId: string, clientId: string, leadIds: string[], opts: { move?: boolean } = {}): Promise<AssignResult> {
  const { db } = getDb();
  const client = await requireClient(orgId, clientId);
  // Archived clients are closed books. Assigning to one would put leads where nobody looks.
  if (client.status === "archived") throw badRequest("That client is archived. Reactivate it before assigning leads to it.");
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return { requested: 0, assigned: 0, alreadyThisClient: 0, ownedByAnotherClient: 0, notFound: 0 };

  // Snapshot first, so every lead asked about can be accounted for by name, not inferred.
  const before = await db
    .select({ id: leads.id, clientId: leads.clientId })
    .from(leads)
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids)));

  // The guard is in the UPDATE, not only in the snapshot: two people routing at the same
  // moment must not both "win" the same lead. Only rows still unowned (or, on an explicit
  // move, owned by someone else) are touched.
  const updated = await db
    .update(leads)
    .set({ clientId, clientAssignedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(leads.orgId, orgId),
        inArray(leads.id, ids),
        opts.move ? sql`(${leads.clientId} IS NULL OR ${leads.clientId} <> ${clientId})` : sql`${leads.clientId} IS NULL`,
      ),
    )
    .returning({ id: leads.id });

  const updatedSet = new Set(updated.map((r) => r.id));
  let alreadyThisClient = 0;
  let ownedByAnotherClient = 0;
  for (const r of before) {
    if (updatedSet.has(r.id)) continue;
    if (r.clientId === clientId) alreadyThisClient++;
    else ownedByAnotherClient++;
  }
  await recordDeliveries(db, clientId, [...updatedSet]);
  const moves = before.filter((r) => updatedSet.has(r.id) && r.clientId && r.clientId !== clientId).map((r) => ({ leadId: r.id, fromClientId: r.clientId! }));
  const stoppedSequences = moves.length ? await stopPreviousClientSequences(db, orgId, moves) : 0;
  return {
    requested: ids.length,
    assigned: updated.length,
    alreadyThisClient,
    ownedByAnotherClient,
    notFound: ids.length - before.length,
    ...(opts.move ? { stoppedSequences } : {}),
  };
}

export async function unassignLeads(orgId: string, leadIds: string[]) {
  const { db } = getDb();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return { requested: 0, returnedToPool: 0, alreadyInPool: 0, notFound: 0 };
  const found = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.id, ids)));
  const rows = await db
    .update(leads)
    .set({ clientId: null, clientAssignedAt: null, updatedAt: new Date() })
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NOT NULL`))
    .returning({ id: leads.id });
  return { requested: ids.length, returnedToPool: rows.length, alreadyInPool: found.length - rows.length, notFound: ids.length - found.length };
}

/**
 * Claim leads a search just produced, for the client the search was run for.
 *
 * Deliberately the non-moving path: a person another client already owns is left with that
 * client and counted, so the search report can say "12 of these were already X's".
 */
export async function claimSearchLeads(db: Db, orgId: string, clientId: string, leadIds: string[]): Promise<{ claimed: number; ownedByAnotherClient: number; skipped?: string }> {
  if (leadIds.length === 0) return { claimed: 0, ownedByAnotherClient: 0 };
  // Checked at claim time, not only when the search was submitted: a search runs later, and
  // a client deleted or archived in between must not be written to (a deleted one fails on
  // the foreign key; an archived one would receive leads nobody looks at).
  const client = await db.query.clients.findFirst({ where: and(eq(clients.id, clientId), eq(clients.orgId, orgId)) });
  if (!client) return { claimed: 0, ownedByAnotherClient: 0, skipped: "client_deleted" };
  if (client.status === "archived") return { claimed: 0, ownedByAnotherClient: 0, skipped: "client_archived" };
  const ids = [...new Set(leadIds)];
  const updated = await db
    .update(leads)
    .set({ clientId, clientAssignedAt: new Date() })
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NULL`))
    .returning({ id: leads.id });
  await recordDeliveries(db, clientId, updated.map((u) => u.id));
  const [{ other }] = await db
    .select({ other: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NOT NULL`, sql`${leads.clientId} <> ${clientId}`));
  return { claimed: updated.length, ownedByAnotherClient: n(other) };
}

/**
 * Make a client-tagged campaign respect ownership.
 *
 * Of the leads asked to be enrolled: those owned by the campaign's client go in; unowned
 * ones are claimed for that client first (they are about to be contacted on its behalf);
 * those owned by a different client are left out and counted.
 */
export async function partitionForClientCampaign(db: Db, orgId: string, clientId: string, leadIds: string[]) {
  if (leadIds.length === 0) return { allowed: [] as string[], claimed: 0, ownedByAnotherClient: 0 };
  const rows = await db.select({ id: leads.id, clientId: leads.clientId }).from(leads).where(and(eq(leads.orgId, orgId), inArray(leads.id, leadIds)));
  const unowned = rows.filter((r) => !r.clientId).map((r) => r.id);
  let claimed: string[] = [];
  if (unowned.length) {
    claimed = (
      await db
        .update(leads)
        .set({ clientId, clientAssignedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(leads.orgId, orgId), inArray(leads.id, unowned), sql`${leads.clientId} IS NULL`))
        .returning({ id: leads.id })
    ).map((r) => r.id);
    await recordDeliveries(db, clientId, claimed);
  }
  const claimedSet = new Set(claimed);
  const allowed = rows.filter((r) => r.clientId === clientId || claimedSet.has(r.id)).map((r) => r.id);
  return { allowed, claimed: claimed.length, ownedByAnotherClient: rows.length - allowed.length };
}

// ── Routing the pool ─────────────────────────────────────────────────────────────────

/** Below this, a lead is not a fit for anyone and stays in the pool. */
export const MIN_FIT = 60;
/**
 * The best client must beat the runner-up by at least this much. Closer than that and the
 * choice is a coin toss dressed up as a recommendation, so it goes to a person instead.
 */
export const MIN_MARGIN = 10;
/**
 * The share of the ICP decided on real data. A lead with no company on file scores the same
 * partial credit on every criterion for every client, so its "best fit" is an artefact of
 * which ICP asks the fewest questions. Below this we do not route at all.
 */
export const MIN_COVERAGE = 0.4;

export interface RouteSuggestion {
  leadId: string;
  fullName: string | null;
  title: string | null;
  company: string | null;
  best: { clientId: string; clientName: string; score: number; reasons: string[] } | null;
  runnerUp: { clientId: string; clientName: string; score: number } | null;
  coverage: number;
  /** Criteria of the best client's ICP this lead is known to fail. */
  mismatches: string[];
  /** Why this one was not auto-routable, when it was not. */
  hold: null | "no_fit" | "contested" | "too_little_data" | "partial_fit";
}

export async function routeSuggestions(orgId: string, opts: { limit?: number; leadIds?: string[] } = {}) {
  const { db } = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const active = await db
    .select({ client: clients, icp: icps })
    .from(clients)
    // Scoped join: a client whose icp_id points at another workspace's ICP is treated as
    // having none, rather than being routed with that workspace's criteria.
    .leftJoin(icps, and(eq(clients.icpId, icps.id), eq(icps.orgId, orgId)))
    .where(and(eq(clients.orgId, orgId), eq(clients.status, "active")));

  // Positive criteria only. An ICP made of nothing but exclusions leaves the scorer with a
  // single criterion - whether the email is verified - so every verified lead scored 100
  // against it with full coverage, and that client won the entire pool on no evidence of
  // fit at all.
  const hasPositiveCriteria = (c: IcpCriteria) =>
    Object.entries(c ?? {}).some(([k, v]) => k !== "excludeKeywords" && Array.isArray(v) && v.length > 0);
  const routable = active.filter((r) => r.icp && hasPositiveCriteria(r.icp.criteria as IcpCriteria));
  // Named, so the page can say why a client never receives anything rather than leaving
  // the operator to wonder.
  const unroutable = active.filter((r) => !routable.includes(r)).map((r) => ({ clientId: r.client.id, name: r.client.name, reason: r.icp ? "icp_has_no_criteria" : "no_icp" }));

  const pool = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT l.id, l.full_name, l.title, l.location, l.country, l.email_status,
             co.name AS company_name, co.industry, co.size, co.location AS company_location,
             co.country AS company_country, co.description, co.tech_stack
      FROM leads l
      LEFT JOIN companies co ON co.id = l.company_id
      WHERE l.org_id = ${orgId} AND l.client_id IS NULL AND l.status <> 'lost'
        ${opts.leadIds ? sql`AND l.id IN (SELECT unnest(${`{${opts.leadIds.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).join(",")}}`}::uuid[]))` : sql``}
      ORDER BY l.created_at DESC
      LIMIT ${limit}`),
  );

  const suggestions: RouteSuggestion[] = pool.map((r) => {
    const lead: LeadForScoring = {
      title: (r.title as string) ?? null,
      location: (r.location as string) ?? null,
      country: (r.country as string) ?? null,
      emailStatus: (r.email_status as string) ?? null,
      company: r.company_name || r.industry || r.size
        ? {
            name: (r.company_name as string) ?? null,
            industry: (r.industry as string) ?? null,
            size: (r.size as string) ?? null,
            location: (r.company_location as string) ?? null,
            country: (r.company_country as string) ?? null,
            description: (r.description as string) ?? null,
            techStack: (r.tech_stack as string[]) ?? null,
          }
        : null,
    };
    const scored = routable
      .map((c) => ({ client: c.client, s: scoreLeadRules(lead, c.icp!.criteria as IcpCriteria) }))
      .sort((a, b) => b.s.score - a.s.score);
    const top = scored[0];
    const second = scored[1];
    // Coverage of the winning ICP: the data behind the verdict we would act on.
    const coverage = top?.s.coverage ?? 0;
    const mismatches = top?.s.mismatches ?? [];
    let hold: RouteSuggestion["hold"] = null;
    if (!top || top.s.score < MIN_FIT) hold = "no_fit";
    else if (coverage < MIN_COVERAGE) hold = "too_little_data";
    // A known failure on something the client's ICP explicitly asks about. The score can
    // still clear the bar - title carries more weight than industry, so a Head of Growth at
    // a retailer scores 64 against a fintech client's ICP - but "right title, wrong industry"
    // is exactly the lead an agency must not hand to the wrong client without a look.
    else if (mismatches.length > 0) hold = "partial_fit";
    else if (second && top.s.score - second.s.score < MIN_MARGIN) hold = "contested";
    return {
      leadId: String(r.id),
      fullName: (r.full_name as string) ?? null,
      title: (r.title as string) ?? null,
      company: (r.company_name as string) ?? null,
      best: top ? { clientId: top.client.id, clientName: top.client.name, score: Math.round(top.s.score), reasons: top.s.reasons.slice(0, 4) } : null,
      runnerUp: second ? { clientId: second.client.id, clientName: second.client.name, score: Math.round(second.s.score) } : null,
      coverage: Number(coverage.toFixed(2)),
      mismatches,
      hold,
    };
  });

  const [{ total }] = rowsOf<{ total: number }>(
    await db.execute(sql`SELECT count(*)::int AS total FROM leads WHERE org_id = ${orgId} AND client_id IS NULL AND status <> 'lost'`),
  );

  return {
    poolSize: n(total),
    examined: suggestions.length,
    // Said plainly when the pool is bigger than what was looked at, so "12 routable" is not
    // read as "12 of your 3,000".
    truncated: n(total) > suggestions.length,
    rules: { minFit: MIN_FIT, minMargin: MIN_MARGIN, minCoverage: MIN_COVERAGE },
    routable: suggestions.filter((s) => s.hold === null),
    held: {
      contested: suggestions.filter((s) => s.hold === "contested"),
      partialFit: suggestions.filter((s) => s.hold === "partial_fit"),
      tooLittleData: suggestions.filter((s) => s.hold === "too_little_data").length,
      noFit: suggestions.filter((s) => s.hold === "no_fit").length,
    },
    unroutableClients: unroutable,
  };
}

/**
 * Assign every clearly-routable pooled lead to its best client. Contested and partial fits
 * are left for a person.
 *
 * With `leadIds`, only those leads are considered - the ones a person was actually shown.
 * Routing "all clear fits" used to recompute over a larger window than the review screen
 * displayed, so leads nobody had seen were assigned under a button that said otherwise.
 */
export async function autoRoute(orgId: string, opts: { limit?: number; leadIds?: string[] } = {}) {
  const s = await routeSuggestions(orgId, opts);
  const byClient = new Map<string, { name: string; ids: string[] }>();
  for (const r of s.routable) {
    const e = byClient.get(r.best!.clientId) ?? { name: r.best!.clientName, ids: [] };
    e.ids.push(r.leadId);
    byClient.set(r.best!.clientId, e);
  }
  const results: { clientId: string; name: string; assigned: number; lostRace: number }[] = [];
  for (const [clientId, { name, ids }] of byClient) {
    const r = await assignLeads(orgId, clientId, ids);
    // Anything not assigned here was claimed by someone else between the suggestion and the
    // write. Counted, not hidden.
    results.push({ clientId, name, assigned: r.assigned, lostRace: r.requested - r.assigned - r.alreadyThisClient });
  }
  return {
    routed: results.reduce((a, r) => a + r.assigned, 0),
    byClient: results,
    leftForReview: s.held.contested.length + s.held.partialFit.length,
    leftInPool: { noFit: s.held.noFit, tooLittleData: s.held.tooLittleData },
    truncated: s.truncated,
  };
}

// ── Detail ───────────────────────────────────────────────────────────────────────────

/**
 * The report link's token for someone allowed to see it (an owner or admin).
 *
 * A link from before this release still has its plaintext column: that is returned as it
 * is (it is what the previous release serves, so it is the truth), and the row is given its
 * hash and encrypted copy on the way if it does not have them yet. The plaintext is only
 * removed when the operator has asked for that (see lib/linkTokens.ts).
 * A link created or replaced on this release is read from its encrypted copy.
 * `unreadable` means a link exists but its stored copy cannot be decrypted (the server's
 * key changed): the link itself still works for whoever already has it, it just cannot be
 * shown again - replacing it gives a new one.
 */
async function readableShareToken(c: Client): Promise<{ token: string | null; unreadable: boolean }> {
  if (c.shareToken) {
    await migrateClientShareToken(c).catch(() => false);
    return { token: c.shareToken, unreadable: false };
  }
  if (c.shareTokenHash && c.shareTokenEncrypted && isLiveShareCopy(c.shareTokenEncrypted)) {
    try {
      return { token: openShareToken(c.orgId, c.id, c.shareTokenEncrypted), unreadable: false };
    } catch {
      return { token: null, unreadable: true };
    }
  }
  return { token: null, unreadable: false };
}

/**
 * `canSeeShareLink`: owners and admins (and API keys, which only they can create) get the
 * report link back. A member is told that sharing is on, but not the link: it publishes the
 * client's pipeline to whoever holds it, and handing it out is an owner/admin decision.
 */
export async function clientDetail(orgId: string, id: string, opts: { canSeeShareLink?: boolean } = {}) {
  const { db } = getDb();
  const c = await requireClient(orgId, id);
  const link = opts.canSeeShareLink ? await readableShareToken(c) : { token: null, unreadable: false };
  const [statsRow] = rowsOf<StatsRow>(await db.execute(STATS_SQL(orgId, sql`l.client_id = ${id}`)));
  const stats = toStats(statsRow);

  const funnel = rowsOf<{ status: string; n: number }>(
    await db.execute(sql`SELECT status, count(*)::int AS n FROM leads WHERE org_id = ${orgId} AND client_id = ${id} GROUP BY status`),
  );

  const campaignRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT c.id, c.name, c.status, c.stats, c.updated_at,
             (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id) AS contacts
      FROM campaigns c
      WHERE c.org_id = ${orgId} AND c.client_id = ${id}
      ORDER BY c.updated_at DESC
      LIMIT 20`),
  );

  const recent = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT l.id, l.full_name, l.title, l.email, l.email_status, l.status, l.score, l.client_assigned_at, co.name AS company
      FROM leads l LEFT JOIN companies co ON co.id = l.company_id
      WHERE l.org_id = ${orgId} AND l.client_id = ${id}
      ORDER BY coalesce(l.client_assigned_at, l.created_at) DESC
      LIMIT 25`),
  );

  const icp = c.icpId ? await db.query.icps.findFirst({ where: and(eq(icps.id, c.icpId), eq(icps.orgId, orgId)) }) : null;

  return {
    client: {
      ...publicClient(c),
      shareToken: link.token,
      // false: sharing may be on, but this caller is not shown the link.
      shareLinkVisible: !!opts.canSeeShareLink,
      ...(link.unreadable ? { shareLinkError: "This report link is still active, but it can no longer be displayed. Replace the link to get a new one you can copy." } : {}),
    },
    icp: icp ? { id: icp.id, name: icp.name } : null,
    stats,
    attention: toAttention(statsRow),
    target: targetProgress(c, stats),
    funnel: Object.fromEntries(funnel.map((f) => [f.status, n(f.n)])),
    campaigns: campaignRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      status: String(r.status),
      contacts: n(r.contacts),
      stats: (r.stats as Record<string, number>) ?? {},
    })),
    recentLeads: recent.map((r) => ({
      id: String(r.id),
      fullName: (r.full_name as string) ?? null,
      title: (r.title as string) ?? null,
      company: (r.company as string) ?? null,
      email: (r.email as string) ?? null,
      emailStatus: String(r.email_status ?? "unknown"),
      status: String(r.status ?? "new"),
      score: n(r.score),
      assignedAt: r.client_assigned_at ? new Date(String(r.client_assigned_at)).toISOString() : null,
    })),
  };
}

/** Lead ids in one attention bucket, so the page can act on exactly what it counted. */
export async function attentionLeadIds(orgId: string, clientId: string | null, bucket: AttentionBucket, limit = 1000): Promise<{ ids: string[]; total: number }> {
  const { db } = getDb();
  const owner = clientId ? eq(leads.clientId, clientId) : sql`${leads.clientId} IS NULL`;
  const where = and(eq(leads.orgId, orgId), owner, attentionWhere(bucket));
  const rows = await db.select({ id: leads.id }).from(leads).where(where).orderBy(sql`${leads.score} DESC`).limit(limit);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(leads).where(where);
  return { ids: rows.map((r) => r.id), total: n(total) };
}

// ── Sharing ──────────────────────────────────────────────────────────────────────────

export async function enableSharing(orgId: string, id: string) {
  const { db } = getDb();
  const before = await requireClient(orgId, id);
  // 32 bytes of randomness: a report link is a bearer credential for this client's pipeline.
  // Stored as a hash (what a report request is looked up by) and encrypted (so an owner can
  // copy the link again); never in plaintext. Any previous link stops working here - also
  // one from before this release, whose plaintext column is cleared by this write.
  const token = newShareToken();
  await db.update(clients).set({ ...shareTokenColumns(orgId, id, token), updatedAt: new Date() }).where(and(eq(clients.id, id), eq(clients.orgId, orgId)));
  // `rotated`: there was a link already and this one replaced it (so the page can say
  // "the old one no longer works" rather than "link created").
  return { shareToken: token, rotated: hasShareLink(before) };
}

export async function disableSharing(orgId: string, id: string) {
  const { db } = getDb();
  await requireClient(orgId, id);
  await db.update(clients).set({ shareToken: null, shareTokenHash: null, shareTokenEncrypted: null, updatedAt: new Date() }).where(and(eq(clients.id, id), eq(clients.orgId, orgId)));
  return { sharing: false };
}

/**
 * "Verified", as told to a client: the status says valid AND something checked it.
 *
 * `email_status` alone is not evidence. It can be set by hand through PATCH /v1/leads/:id,
 * and the report then told the agency's client that an address nobody had tested was
 * verified. `verified_at` / `email_verified_by` are only written when a verifier or the
 * SMTP probe answered (and are cleared when a status is set by hand), so both are required.
 */
function isVerified(r: Record<string, unknown>): boolean {
  return r.email_status === "valid" && (r.verified_at != null || (typeof r.email_verified_by === "string" && r.email_verified_by !== ""));
}

/**
 * What a client sees through their report link.
 *
 * Names, titles, companies and stage - enough to see the pipeline being built for them.
 * Never email addresses, phone numbers or LinkedIn URLs: a link gets forwarded, and the
 * contact data is the part that must not travel with it.
 */
/**
 * The client a report-link token belongs to, or null.
 *
 * A link created or replaced on this release has no plaintext: it is found by the token's
 * hash - an index probe, with nothing compared against a stored secret - and only when the
 * row carries the encrypted copy this release writes for such a link.
 *
 * A link from before this release still has its plaintext column, and that column decides:
 * it is found by it, exactly as the previous release finds it. Its hash is deliberately not
 * trusted on its own - a link that was replaced or turned off on the previous release
 * (during a rollback, or by an old instance in a rolling deploy) leaves an out-of-date hash
 * behind, and an old or switched-off link must not start working again because of it.
 */
export async function findClientByShareToken(token: string): Promise<Client | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const { db } = getDb();
  const c = await db.query.clients.findFirst({
    where: or(and(sql`${clients.shareToken} IS NULL`, eq(clients.shareTokenHash, hashLinkToken(token)), LIVE_SHARE_COPY_SQL), eq(clients.shareToken, token)),
  });
  return c ?? null;
}

export async function publicReport(token: string) {
  const { db } = getDb();
  const c = await findClientByShareToken(token);
  if (!c || c.status === "archived") return null;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, c.orgId) });

  const [statsRow] = rowsOf<StatsRow>(await db.execute(STATS_SQL(c.orgId, sql`l.client_id = ${c.id}`)));
  const stats = toStats(statsRow);
  // The report's own "verified" figure: addresses a verifier actually checked (see
  // isVerified), counted with the same rule as the per-lead flag below so the two agree.
  const [{ n: verifiedChecked }] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM leads l WHERE l.org_id = ${c.orgId} AND l.client_id = ${c.id} AND l.email_status = 'valid' AND (l.verified_at IS NOT NULL OR l.email_verified_by IS NOT NULL)`),
  );
  const funnel = rowsOf<{ status: string; n: number }>(
    await db.execute(sql`SELECT status, count(*)::int AS n FROM leads WHERE org_id = ${c.orgId} AND client_id = ${c.id} GROUP BY status`),
  );
  const list = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT l.full_name, l.title, l.status, l.email_status, l.verified_at, l.email_verified_by, l.client_assigned_at, co.name AS company, co.industry
      FROM leads l LEFT JOIN companies co ON co.id = l.company_id AND co.org_id = l.org_id
      WHERE l.org_id = ${c.orgId} AND l.client_id = ${c.id} AND l.status <> 'lost'
      ORDER BY coalesce(l.client_assigned_at, l.created_at) DESC
      LIMIT 200`),
  );

  return {
    client: { name: c.name, domain: c.domain },
    preparedBy: org?.name ?? null,
    generatedAt: new Date().toISOString(),
    stats: {
      leads: stats.leads,
      deliveredThisMonth: stats.deliveredThisMonth,
      verified: n(verifiedChecked),
      contacted: stats.contacted,
      replied: stats.replied,
      qualified: stats.qualified,
      customers: stats.customers,
    },
    // Only when the agency has chosen to show it. See migration 0013.
    target: c.reportShowTarget ? targetProgress(c, stats) : null,
    funnel: Object.fromEntries(funnel.map((f) => [f.status, n(f.n)])),
    leads: list.map((r) => ({
      name: (r.full_name as string) ?? null,
      title: (r.title as string) ?? null,
      company: (r.company as string) ?? null,
      industry: (r.industry as string) ?? null,
      stage: String(r.status ?? "new"),
      emailVerified: isVerified(r),
      deliveredAt: r.client_assigned_at ? new Date(String(r.client_assigned_at)).toISOString() : null,
    })),
    shownLeads: list.length,
    // The list is capped and leaves out leads marked lost; compared against the same
    // population, or a client with one active and one lost lead is told the list is cut.
    listTruncated: stats.leads - n(funnel.find((f) => f.status === "lost")?.n) > list.length,
  };
}
