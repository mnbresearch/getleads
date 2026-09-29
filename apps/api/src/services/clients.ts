import { randomBytes } from "node:crypto";
import { and, clients, eq, getDb, icps, inArray, leads, organizations, sql, type Client } from "@prospex/db";
import { scoreLeadRules, type IcpCriteria, type LeadForScoring } from "@prospex/core";
import { badRequest, notFound } from "../lib/errors.js";

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

const STATS_SQL = (orgId: string, clientFilter: ReturnType<typeof sql>) => sql`
  SELECT
    l.client_id                                                                       AS client_id,
    count(*)::int                                                                     AS leads,
    count(*) FILTER (WHERE l.client_assigned_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS delivered_this_month,
    count(*) FILTER (WHERE l.created_at >= now() - interval '7 days')::int            AS new_7d,
    count(*) FILTER (WHERE l.email IS NOT NULL)::int                                  AS with_email,
    count(*) FILTER (WHERE l.email_status = 'valid')::int                             AS verified,
    count(*) FILTER (WHERE l.status IN ('contacted','engaged','replied','qualified','customer'))::int AS contacted,
    count(*) FILTER (WHERE l.status IN ('replied','qualified','customer'))::int       AS replied,
    count(*) FILTER (WHERE l.status IN ('qualified','customer'))::int                 AS qualified,
    count(*) FILTER (WHERE l.status = 'customer')::int                                AS customers,
    max(l.updated_at)                                                                 AS last_activity,
    count(*) FILTER (WHERE l.email IS NULL AND l.status <> 'lost')::int               AS no_email,
    count(*) FILTER (WHERE l.email IS NOT NULL AND l.email_status = 'unknown' AND l.status <> 'lost')::int AS unverified,
    count(*) FILTER (WHERE l.email_status = 'invalid' AND l.status <> 'lost')::int    AS bad_email,
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

/** The share token is a credential: it is returned only by the routes that manage it. */
function publicClient(c: Client) {
  const { shareToken, ...rest } = c;
  return { ...rest, sharing: !!shareToken };
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
    // An ICP chosen for a client is, from now on, that client's ICP.
    if (row.icpId) await db.update(icps).set({ clientId: row.id }).where(and(eq(icps.id, row.icpId), eq(icps.orgId, orgId)));
    return publicClient(row);
  } catch (e) {
    if (isDuplicateName(e)) throw badRequest(`A client called "${input.name.trim()}" already exists.`);
    throw e;
  }
}

export async function updateClient(orgId: string, id: string, input: Partial<ClientInput>) {
  const { db } = getDb();
  await requireClient(orgId, id);
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
    if (input.icpId) await db.update(icps).set({ clientId: id }).where(and(eq(icps.id, input.icpId), eq(icps.orgId, orgId)));
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

export interface AssignResult {
  requested: number;
  assigned: number;
  /** Already belonged to this client; nothing to do. */
  alreadyThisClient: number;
  /** Owned by a different client and left alone. Pass `move: true` to take them. */
  ownedByAnotherClient: number;
  /** Not in this workspace, or deleted. */
  notFound: number;
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
  return { requested: ids.length, assigned: updated.length, alreadyThisClient, ownedByAnotherClient, notFound: ids.length - before.length };
}

export async function unassignLeads(orgId: string, leadIds: string[]) {
  const { db } = getDb();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return { returnedToPool: 0 };
  const rows = await db
    .update(leads)
    .set({ clientId: null, clientAssignedAt: null, updatedAt: new Date() })
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NOT NULL`))
    .returning({ id: leads.id });
  return { returnedToPool: rows.length };
}

/**
 * Claim leads a search just produced, for the client the search was run for.
 *
 * Deliberately the non-moving path: a person another client already owns is left with that
 * client and counted, so the search report can say "12 of these were already X's".
 */
export async function claimSearchLeads(db: Db, orgId: string, clientId: string, leadIds: string[]) {
  if (leadIds.length === 0) return { claimed: 0, ownedByAnotherClient: 0 };
  const ids = [...new Set(leadIds)];
  const updated = await db
    .update(leads)
    .set({ clientId, clientAssignedAt: new Date() })
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NULL`))
    .returning({ id: leads.id });
  const [{ other }] = await db
    .select({ other: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.orgId, orgId), inArray(leads.id, ids), sql`${leads.clientId} IS NOT NULL`, sql`${leads.clientId} <> ${clientId}`));
  return { claimed: updated.length, ownedByAnotherClient: n(other) };
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

export async function routeSuggestions(orgId: string, opts: { limit?: number } = {}) {
  const { db } = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const active = await db
    .select({ client: clients, icp: icps })
    .from(clients)
    .leftJoin(icps, eq(clients.icpId, icps.id))
    .where(and(eq(clients.orgId, orgId), eq(clients.status, "active")));

  const routable = active.filter((r) => r.icp && Object.values((r.icp.criteria ?? {}) as IcpCriteria).some((v) => Array.isArray(v) && v.length > 0));
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

/** Assign every clearly-routable pooled lead to its best client. Contested ones are left. */
export async function autoRoute(orgId: string, opts: { limit?: number } = {}) {
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

export async function clientDetail(orgId: string, id: string) {
  const { db } = getDb();
  const c = await requireClient(orgId, id);
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
    client: { ...publicClient(c), shareToken: c.shareToken },
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
export async function attentionLeadIds(orgId: string, clientId: string | null, bucket: keyof ClientAttention, limit = 1000): Promise<string[]> {
  const { db } = getDb();
  const owner = clientId ? sql`l.client_id = ${clientId}` : sql`l.client_id IS NULL`;
  const where = {
    noEmail: sql`l.email IS NULL AND l.status <> 'lost'`,
    unverified: sql`l.email IS NOT NULL AND l.email_status = 'unknown' AND l.status <> 'lost'`,
    badEmail: sql`l.email_status = 'invalid' AND l.status <> 'lost'`,
    readyButIdle: sql`l.status = 'new' AND l.email_status IN ('valid','catch_all') AND coalesce(l.client_assigned_at, l.created_at) < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc WHERE cc.lead_id = l.id)`,
  }[bucket];
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`SELECT l.id FROM leads l WHERE l.org_id = ${orgId} AND ${owner} AND ${where} ORDER BY l.score DESC LIMIT ${limit}`),
  );
  return rows.map((r) => String(r.id));
}

// ── Sharing ──────────────────────────────────────────────────────────────────────────

export async function enableSharing(orgId: string, id: string) {
  const { db } = getDb();
  await requireClient(orgId, id);
  // 32 bytes of randomness: a report link is a bearer credential for this client's pipeline.
  const token = randomBytes(32).toString("base64url");
  await db.update(clients).set({ shareToken: token, updatedAt: new Date() }).where(and(eq(clients.id, id), eq(clients.orgId, orgId)));
  return { shareToken: token };
}

export async function disableSharing(orgId: string, id: string) {
  const { db } = getDb();
  await requireClient(orgId, id);
  await db.update(clients).set({ shareToken: null, updatedAt: new Date() }).where(and(eq(clients.id, id), eq(clients.orgId, orgId)));
  return { sharing: false };
}

/**
 * What a client sees through their report link.
 *
 * Names, titles, companies and stage - enough to see the pipeline being built for them.
 * Never email addresses, phone numbers or LinkedIn URLs: a link gets forwarded, and the
 * contact data is the part that must not travel with it.
 */
export async function publicReport(token: string) {
  if (!token || token.length < 20) return null;
  const { db } = getDb();
  const c = await db.query.clients.findFirst({ where: eq(clients.shareToken, token) });
  if (!c || c.status === "archived") return null;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, c.orgId) });

  const [statsRow] = rowsOf<StatsRow>(await db.execute(STATS_SQL(c.orgId, sql`l.client_id = ${c.id}`)));
  const stats = toStats(statsRow);
  const funnel = rowsOf<{ status: string; n: number }>(
    await db.execute(sql`SELECT status, count(*)::int AS n FROM leads WHERE org_id = ${c.orgId} AND client_id = ${c.id} GROUP BY status`),
  );
  const list = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT l.full_name, l.title, l.status, l.email_status, l.client_assigned_at, co.name AS company, co.industry
      FROM leads l LEFT JOIN companies co ON co.id = l.company_id
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
      verified: stats.verified,
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
      emailVerified: r.email_status === "valid",
      deliveredAt: r.client_assigned_at ? new Date(String(r.client_assigned_at)).toISOString() : null,
    })),
    shownLeads: list.length,
    // The list is capped; the totals are not. Said so, rather than letting a client count
    // rows and conclude they were short-changed.
    listTruncated: stats.leads > list.length,
  };
}
