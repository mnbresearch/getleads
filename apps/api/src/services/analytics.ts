import { getDb, sql } from "@prospex/db";

/**
 * Funnel, source performance and campaign attribution.
 *
 * The three questions a founder actually asks - where do good leads come from, where do
 * they stall, and which campaign produced the reply - and none of them were answerable.
 *
 * One rule runs through all of it. A rate is only as honest as its denominator, so nothing
 * here divides by a population that quietly includes rows the step could never have
 * applied to. A lead with no email address has not "failed to convert from contacted": it
 * was never contactable, and counting it as a loss makes every downstream rate look worse
 * than the work actually was. Where a denominator is narrowed, the response says by how
 * much, so a number can always be traced back to the population it describes.
 */

/**
 * Rows out of `db.execute`.
 *
 * The postgres.js driver returns the rows array directly, while `drizzle-orm`'s types
 * describe a `{ rows }` envelope. Reading only `.rows` silently yields an empty array and
 * every metric computed from it comes back as a confident zero - which is the failure this
 * whole module is supposed to make impossible, so it is worth the four lines.
 */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = (res as { rows?: unknown })?.rows;
  return Array.isArray(r) ? (r as T[]) : [];
}

export interface FunnelStage {
  stage: string;
  label: string;
  /** Leads that have reached at least this stage. */
  count: number;
  /** Of those that reached the previous stage, the share that reached this one. */
  conversionFromPrevious: number | null;
  /** Of everything that entered the funnel, the share that reached this one. */
  conversionFromStart: number | null;
  /** Leads sitting at exactly this stage right now. */
  currentlyHere: number;
}

/** The pipeline stages, in order. Anything outside this is terminal or unset. */
const STAGES: { stage: string; label: string }[] = [
  { stage: "new", label: "New" },
  { stage: "contacted", label: "Contacted" },
  { stage: "engaged", label: "Engaged" },
  { stage: "replied", label: "Replied" },
  { stage: "qualified", label: "Qualified" },
  { stage: "customer", label: "Customer" },
];

const rank = (s: string) => STAGES.findIndex((x) => x.stage === s);

export async function leadFunnel(orgId: string, days: number) {
  const { db } = getDb();

  const rows = rowsOf<{ status: string; n: number }>(
    await db.execute(sql`
      SELECT coalesce(status, 'new') AS status, count(*)::int AS n
      FROM leads
      WHERE org_id = ${orgId} AND created_at > now() - (${days} || ' days')::interval
      GROUP BY 1`),
  );

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, Number(r.n));

  /**
   * "lost" is excluded from the funnel entirely - numerator and denominator both.
   *
   * Only the CURRENT status is stored, so a lost lead's furthest stage is unknown: it may
   * have been lost at "contacted" or after "qualified". A first version kept lost leads in
   * the denominator and, because `rank("lost")` is -1, in none of the stage counts - which
   * showed 20% of leads failing to reach the first stage of the funnel, a thing that cannot
   * happen, since every lead reaches "new". Putting them in at rank 0 would be the opposite
   * lie: claiming they got nowhere.
   *
   * So they are counted beside the funnel with a note, and the rates below describe the
   * population they actually describe.
   */
  const lost = counts.get("lost") ?? 0;
  const inFunnel = [...counts.entries()].filter(([s]) => rank(s) >= 0);
  const entered = inFunnel.reduce((a, [, n]) => a + n, 0);
  /**
   * Everything else with a status this funnel does not model.
   *
   * `leads.status` is a plain text column. The app's own writers only ever set the six
   * stages and "lost" - so on data that came through the app this bucket is empty, and
   * saying otherwise would be inventing a problem. It exists for the data that did not:
   * imports, backfills and anything written directly. Those rows are in neither `entered`
   * nor `lost`, and an earlier version dropped them without a word, which is the silent
   * narrowing the rest of this module refuses.
   */
  const totalRows = [...counts.values()].reduce((a, n) => a + n, 0);
  const other = totalRows - entered - lost;
  const otherStatuses = [...counts.entries()].filter(([st]) => rank(st) < 0 && st !== "lost").map(([st, n]) => ({ status: st, count: n }));

  const stages: FunnelStage[] = STAGES.map((s, i) => {
    // Reaching a stage is cumulative: someone who replied was, necessarily, contacted.
    const reached = inFunnel.filter(([st]) => rank(st) >= i).reduce((a, [, n]) => a + n, 0);
    const prevReached = i === 0 ? entered : inFunnel.filter(([st]) => rank(st) >= i - 1).reduce((a, [, n]) => a + n, 0);
    return {
      stage: s.stage,
      label: s.label,
      count: reached,
      conversionFromPrevious: prevReached > 0 ? Number((reached / prevReached).toFixed(4)) : null,
      conversionFromStart: entered > 0 ? Number((reached / entered).toFixed(4)) : null,
      currentlyHere: counts.get(s.stage) ?? 0,
    };
  });

  // The biggest single drop, which is the only actionable thing in a funnel.
  let worst: { from: string; to: string; lostShare: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const c = stages[i].conversionFromPrevious;
    if (c === null) continue;
    const dropped = 1 - c;
    if (!worst || dropped > worst.lostShare) worst = { from: stages[i - 1].label, to: stages[i].label, lostShare: Number(dropped.toFixed(4)) };
  }

  return {
    days,
    /**
     * Leads CREATED IN THIS WINDOW - not the org's lead count.
     *
     * Named carefully because the obvious reading is wrong and the difference is large: an
     * org whose leads are all older than `days` sees zero here while its Leads page shows
     * hundreds. The window is the funnel's real denominator, and a cohort measured over a
     * window is the only honest way to read conversion anyway - leads acquired last week
     * have not had time to become customers.
     */
    totalInWindow: totalRows,
    windowNote: `Counts leads created in the last ${days} days, not every lead in the workspace.`,
    entered,
    lost,
    other,
    otherNote:
      other > 0
        ? `${other} lead${other === 1 ? "" : "s"} have a status this funnel does not model (${otherStatuses.map((o) => `${o.status}: ${o.count}`).join(", ")}) and are in neither the rates below nor the lost count.`
        : undefined,
    otherStatuses,
    lostNote:
      lost > 0
        ? `${lost} lead${lost === 1 ? "" : "s"} marked lost are not in the rates below. Only the current status is stored, so where each one was lost is unknown - counting them at the start would understate the funnel and counting them at the end would overstate it.`
        : undefined,
    stages,
    biggestDropOff: entered >= 20 ? worst : null,
    // Below this, stage-to-stage rates swing wildly on single leads and reporting one as a
    // finding would be the same overclaim the visibility module refuses to make.
    sufficient: entered >= 20,
    note: entered >= 20 ? undefined : `Only ${entered} leads in this window - too few for stage conversion rates to mean anything yet.`,
  };
}

export interface SourceRow {
  source: string;
  leads: number;
  withEmail: number;
  verified: number;
  contacted: number;
  replied: number;
  qualified: number;
  customers: number;
  avgScore: number | null;
  /** Replies per lead CONTACTED, not per lead acquired. See the note in the response. */
  replyRate: number | null;
  /** Qualified per lead acquired - the number that actually says whether a source is worth it. */
  qualifiedRate: number | null;
  sufficient: boolean;
}

/**
 * Which sources produce leads that go somewhere.
 *
 * Reply rate is deliberately per lead CONTACTED rather than per lead acquired. A source
 * that produced 500 leads of which 10 were emailed has not got a 0.4% reply rate; it has a
 * 20% reply rate and a contact problem, and those call for opposite actions.
 */
export async function sourcePerformance(orgId: string, days: number) {
  const { db } = getDb();

  // Messages are aggregated per lead BEFORE the join, not joined row-by-row.
  //
  // Joining messages directly multiplies each lead by its message count, so a lead that
  // received four touches counted as four leads - inflating volume for exactly the sources
  // that are worked hardest, which is the opposite of what this table is for. Written this
  // way the lead row appears once, whatever its send history.
  const rows = await db.execute(sql`
    WITH touched AS (
      SELECT lead_id,
             count(*) FILTER (WHERE sent_at IS NOT NULL)      AS sends,
             count(*) FILTER (WHERE replied_at IS NOT NULL)   AS replies
      FROM messages
      WHERE org_id = ${orgId} AND direction = 'outbound' AND lead_id IS NOT NULL
      GROUP BY lead_id
    )
    SELECT
      coalesce(nullif(l.source, ''), 'unknown')                               AS source,
      count(*)::int                                                           AS leads,
      count(*) FILTER (WHERE l.email IS NOT NULL)::int                        AS with_email,
      count(*) FILTER (WHERE l.email_status = 'valid')::int                   AS verified,
      count(*) FILTER (WHERE t.sends > 0)::int                                AS contacted,
      count(*) FILTER (WHERE t.replies > 0)::int                              AS replied,
      count(*) FILTER (WHERE l.status IN ('qualified','customer'))::int       AS qualified,
      count(*) FILTER (WHERE l.status = 'customer')::int                      AS customers,
      round(avg(l.score))::int                                                AS avg_score
    FROM leads l
    LEFT JOIN touched t ON t.lead_id = l.id
    WHERE l.org_id = ${orgId} AND l.created_at > now() - (${days} || ' days')::interval
    GROUP BY 1
    ORDER BY count(*) DESC`);

  const sources: SourceRow[] = rowsOf<Record<string, number | string>>(rows).map((r) => {
    const leadsN = Number(r.leads);
    const contacted = Number(r.contacted);
    const replied = Number(r.replied);
    const qualified = Number(r.qualified);
    return {
      source: String(r.source),
      leads: leadsN,
      withEmail: Number(r.with_email),
      verified: Number(r.verified),
      contacted,
      replied,
      qualified,
      customers: Number(r.customers),
      avgScore: r.avg_score === null ? null : Number(r.avg_score),
      replyRate: contacted > 0 ? Number((replied / contacted).toFixed(4)) : null,
      qualifiedRate: leadsN > 0 ? Number((qualified / leadsN).toFixed(4)) : null,
      // One reply out of three sends is not a 33% reply rate, it is one reply.
      sufficient: contacted >= 20,
    };
  });

  return {
    days,
    sources,
    note:
      "Reply rate is per lead CONTACTED, not per lead acquired: a source that produced 500 leads of which 10 were emailed has a contact problem, not a reply problem. `sufficient` is false where too few were contacted for the rate to mean anything.",
  };
}

/**
 * Which campaign, and which step, produced the reply.
 *
 * Last-touch: the reply is credited to the message it is a reply to. That is the only
 * attribution this data can actually support - there is no multi-touch model here, and
 * inventing weights across touches would be a model presented as a measurement.
 */
export async function campaignAttribution(orgId: string, days: number) {
  const { db } = getDb();

  // Qualified leads are counted once per CAMPAIGN in their own CTE, not per step row.
  //
  // Per-step counts cannot be recombined afterwards: summing double-counts a lead that
  // received several steps, and taking the max undercounts whenever two qualified leads
  // were reached by different steps - which reports a campaign's qualified leads as the
  // size of its single busiest step cohort. (And `count(DISTINCT ...) OVER ()` is not
  // something Postgres supports, so a window will not do it either.)
  const rows = await db.execute(sql`
    WITH scoped AS (
      SELECT m.*, c.id AS c_id, c.name AS c_name
      FROM messages m
      JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.org_id = ${orgId}
        AND m.direction = 'outbound'
        AND m.created_at > now() - (${days} || ' days')::interval
    ),
    qualified AS (
      SELECT s.c_id, count(DISTINCT s.lead_id)::int AS n
      FROM scoped s
      JOIN leads l ON l.id = s.lead_id
      WHERE l.status IN ('qualified','customer')
      GROUP BY s.c_id
    )
    SELECT
      s.c_id                                                    AS campaign_id,
      s.c_name                                                  AS campaign,
      ss.step_no                                                AS step_no,
      count(*) FILTER (WHERE s.sent_at IS NOT NULL)::int        AS sent,
      count(*) FILTER (WHERE s.opened_at IS NOT NULL)::int      AS opened,
      count(*) FILTER (WHERE s.replied_at IS NOT NULL)::int     AS replied,
      coalesce(max(q.n), 0)::int                                AS qualified_leads
    FROM scoped s
    LEFT JOIN sequence_steps ss ON ss.id = s.step_id
    LEFT JOIN qualified q       ON q.c_id = s.c_id
    GROUP BY s.c_id, s.c_name, ss.step_no
    ORDER BY s.c_name, ss.step_no`);

  const byCampaign = new Map<string, { campaignId: string; campaign: string; sent: number; opened: number; replied: number; qualifiedLeads: number; steps: { stepNo: number | null; sent: number; opened: number; replied: number; replyRate: number | null }[] }>();

  for (const r of rowsOf<Record<string, number | string | null>>(rows)) {
    const id = String(r.campaign_id);
    const entry = byCampaign.get(id) ?? { campaignId: id, campaign: String(r.campaign), sent: 0, opened: 0, replied: 0, qualifiedLeads: 0, steps: [] };
    const sent = Number(r.sent);
    const replied = Number(r.replied);
    entry.sent += sent;
    entry.opened += Number(r.opened);
    entry.replied += replied;
    entry.qualifiedLeads = Math.max(entry.qualifiedLeads, Number(r.qualified_leads));
    entry.steps.push({
      stepNo: r.step_no === null ? null : Number(r.step_no),
      sent,
      opened: Number(r.opened),
      replied,
      replyRate: sent > 0 ? Number((replied / sent).toFixed(4)) : null,
    });
    byCampaign.set(id, entry);
  }

  const campaigns = [...byCampaign.values()]
    .map((c) => ({
      ...c,
      replyRate: c.sent > 0 ? Number((c.replied / c.sent).toFixed(4)) : null,
      openRate: c.sent > 0 ? Number((c.opened / c.sent).toFixed(4)) : null,
      sufficient: c.sent >= 20,
      /**
       * Which step earns its place.
       *
       * Only computed with enough sends behind it. A step that got one reply from three
       * sends is not the best-performing step, and telling someone to delete step 3 on that
       * basis is a recommendation made out of noise.
       */
      bestStep: c.sent >= 20 ? c.steps.filter((s) => s.sent >= 10).sort((a, b) => (b.replyRate ?? 0) - (a.replyRate ?? 0))[0]?.stepNo ?? null : null,
    }))
    .sort((a, b) => b.replied - a.replied);

  return {
    days,
    campaigns,
    model:
      "Replies are last-touch: a reply is credited to the message it replies to. `qualifiedLeads` is NOT - it is any-touch, counting every lead this campaign messaged that is now qualified or a customer, so a lead worked by two campaigns is counted by both and the column does not sum to your qualified total. Crediting one campaign would need a decision this data cannot make: only the lead's current status is stored, with no record of when it changed relative to each send.",
  };
}
