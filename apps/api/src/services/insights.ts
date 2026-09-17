import { getDb, sql } from "@prospex/db";
import { learnFromOutcomes, type IcpLearning, type OutcomeSample } from "@prospex/core";

/**
 * Build the outcome samples that ICP learning reasons over: one row per lead that has
 * actually been emailed, tagged with whether it produced a positive outcome.
 *
 * A lead counts as positive if any outbound message to it was replied to, or if any
 * inbound message from it was triaged as `interested` or `referral`.
 *
 * Buckets deliberately use normalized/inferred attributes (seniority, department,
 * industry, size, country) rather than raw job titles. Raw titles are far too
 * high-cardinality to ever reach a statistically meaningful group size, so they would
 * produce nothing but noise.
 *
 * Lives here rather than inline in the route so it can be tested against a real
 * database. The aggregate SQL is the part most likely to break, and it is invisible to
 * unit tests.
 */
export async function icpLearningSamples(db: ReturnType<typeof getDb>["db"], orgIdValue: string): Promise<OutcomeSample[]> {
  const res = (await db.execute(sql`
    SELECT l.seniority, l.department, l.country, l.email_status, co.industry, co.size,
           bool_or(m.replied_at IS NOT NULL) AS replied,
           coalesce(bool_or(inb.intent IN ('interested','referral')), false) AS positive_intent
    FROM leads l
    JOIN messages m ON m.lead_id = l.id AND m.direction = 'outbound' AND m.sent_at IS NOT NULL
    LEFT JOIN messages inb ON inb.lead_id = l.id AND inb.direction = 'inbound'
    LEFT JOIN companies co ON co.id = l.company_id
    WHERE l.org_id = ${orgIdValue}
    GROUP BY l.id, co.id
  `)) as unknown as { rows?: Record<string, unknown>[] };
  // The driver returns either a { rows } envelope or a bare array depending on version.
  const list = res.rows ?? (res as unknown as Record<string, unknown>[]) ?? [];
  return list.map((r) => ({
    attributes: {
      seniority: r.seniority as string | null,
      department: r.department as string | null,
      industry: r.industry as string | null,
      companySize: r.size as string | null,
      country: r.country as string | null,
      emailStatus: r.email_status as string | null,
    },
    positive: Boolean(r.replied) || Boolean(r.positive_intent),
  }));
}

/** What the org's send history says its ICP actually is. */
export async function icpLearningFor(db: ReturnType<typeof getDb>["db"], orgIdValue: string): Promise<IcpLearning> {
  return learnFromOutcomes(await icpLearningSamples(db, orgIdValue));
}
