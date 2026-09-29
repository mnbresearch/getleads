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

  // "lost" leaves the funnel from wherever it was; it is reported beside the funnel rather
  // than inside it, because a lost lead did reach the stages it reached.
  const lost = counts.get("lost") ?? 0;
  const entered = [...counts.entries()].filter(([s]) => s !== "lost").reduce((a, [, n]) => a + n, 0) + lost;

  const stages: FunnelStage[] = STAGES.map((s, i) => {
    // Reaching a stage is cumulative: someone who replied was, necessarily, contacted.
    const reached = [...counts.entries()].filter(([st]) => rank(st) >= i).reduce((a, [, n]) => a + n, 0);
    const prevReached = i === 0 ? entered : [...counts.entries()].filter(([st]) => rank(st) >= i - 1).reduce((a, [, n]) => a + n, 0);
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
    entered,
    lost,
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

  const rows = await db.execute(sql`
    SELECT
      c.id                                                                    AS campaign_id,
      c.name                                                                  AS campaign,
      ss.step_no                                                              AS step_no,
      count(*) FILTER (WHERE m.sent_at IS NOT NULL)::int                      AS sent,
      count(*) FILTER (WHERE m.opened_at IS NOT NULL)::int                    AS opened,
      count(*) FILTER (WHERE m.replied_at IS NOT NULL)::int                   AS replied,
      count(DISTINCT l.id) FILTER (WHERE l.status IN ('qualified','customer'))::int AS qualified_leads
    FROM messages m
    JOIN campaigns c        ON c.id = m.campaign_id
    LEFT JOIN sequence_steps ss ON ss.id = m.step_id
    LEFT JOIN leads l       ON l.id = m.lead_id
    WHERE m.org_id = ${orgId}
      AND m.direction = 'outbound'
      AND m.created_at > now() - (${days} || ' days')::interval
    GROUP BY c.id, c.name, ss.step_no
    ORDER BY c.name, ss.step_no`);

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
    model: "last-touch: a reply is credited to the message it replies to. No multi-touch weighting - there is no data here that would support one.",
  };
}
