import { and, companies, desc, eq, getDb, leads, signals, sql, type Db } from "@prospex/db";
import { detectJobChange, enrichWithProviders, type JobChangeResult } from "@prospex/core";
import { emitEvent } from "../lib/events.js";

/**
 * Re-check tracked leads for a job change, and record the ones that moved.
 *
 * Only leads worth re-checking are re-checked: someone the org has engaged, qualified or
 * marked a customer, or who scores well against the ICP. Re-enriching an entire database
 * every night would cost provider credits per person to tell you that almost nobody moved.
 *
 * The rule this lives or dies by is in packages/core/src/signals/jobChange.ts: an
 * unconfirmed comparison is reported as `unknown` and stored as nothing. A provider that
 * returns a name but no company must never read as a resignation.
 */

export interface JobChangeScanResult {
  checked: number;
  /** Leads whose employer or title demonstrably changed. */
  changed: number;
  /** Leads we could not confirm either way - reported, never counted as unchanged. */
  unconfirmed: number;
  /** Providers were configured but none could answer. */
  blocked?: string;
  changes: { leadId: string; fullName: string | null; change: JobChangeResult }[];
}

/** Which leads are worth spending an enrichment call on. */
function worthRechecking(minScore: number) {
  return sql`(${leads.status} IN ('contacted','engaged','replied','qualified','customer') OR ${leads.score} >= ${minScore})`;
}

export async function scanJobChanges(
  orgId: string,
  opts: { limit?: number; minScore?: number; staleDays?: number } = {},
): Promise<JobChangeScanResult> {
  const { db } = getDb();
  const limit = Math.min(opts.limit ?? 50, 500);
  const minScore = opts.minScore ?? 70;
  const staleDays = opts.staleDays ?? 30;

  const rows = await db
    .select({ lead: leads, company: companies })
    .from(leads)
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(
      and(
        eq(leads.orgId, orgId),
        worthRechecking(minScore),
        // Someone checked yesterday has not moved since. This also stops a scheduled scan
        // re-spending credits on the same people every run.
        sql`(${leads.jobCheckedAt} IS NULL OR ${leads.jobCheckedAt} < now() - (${staleDays} || ' days')::interval)`,
        sql`(${leads.linkedinUrl} IS NOT NULL OR ${leads.email} IS NOT NULL)`,
      ),
    )
    .orderBy(desc(leads.score))
    .limit(limit);

  const out: JobChangeScanResult = { checked: 0, changed: 0, unconfirmed: 0, changes: [] };
  let answered = 0;

  for (const { lead, company } of rows) {
    const fresh = await enrichWithProviders({
      email: lead.email ?? undefined,
      linkedinUrl: lead.linkedinUrl ?? undefined,
      firstName: lead.firstName ?? undefined,
      lastName: lead.lastName ?? undefined,
      companyDomain: company?.domain ?? undefined,
    }).catch(() => null);

    out.checked++;

    // No provider answered for this person. Stamping jobCheckedAt here would mean "we
    // looked and they are fine", which is exactly the lie this module exists to avoid - and
    // it would suppress the next real check for a month.
    if (!fresh) {
      out.unconfirmed++;
      continue;
    }
    answered++;

    const change = detectJobChange({
      previous: { companyName: company?.name ?? null, companyDomain: company?.domain ?? null, title: lead.title },
      current: { companyName: fresh.companyName ?? null, companyDomain: fresh.companyDomain ?? null, title: fresh.title ?? null },
    });

    if (change.kind === "unknown") {
      out.unconfirmed++;
      continue;
    }

    // A confirmed look, whatever it found. Only now is it honest to say we checked.
    await db.update(leads).set({ jobCheckedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id));

    if (change.kind === "none") continue;

    out.changed++;
    out.changes.push({ leadId: lead.id, fullName: lead.fullName, change });
    await recordJobChange(db, orgId, lead, change, fresh.companyDomain ?? null);
  }

  // Everything we tried refused us. That is not "nobody moved".
  if (out.checked > 0 && answered === 0) {
    out.blocked = `No data provider answered for any of the ${out.checked} leads checked. This is a provider or credential problem, not a month in which nobody changed job.`;
  }

  return out;
}

/** Write the signal, link it to the lead, and tell anything listening. */
async function recordJobChange(
  db: Db,
  orgId: string,
  lead: { id: string; fullName: string | null; title: string | null },
  change: JobChangeResult,
  newDomain: string | null,
) {
  const title = change.sameEmployer
    ? `${lead.fullName ?? "A tracked lead"} was promoted to ${change.to?.title ?? "a new role"}`
    : `${lead.fullName ?? "A tracked lead"} moved to ${change.to?.company ?? "a new company"}`;

  // Written with an orgId, unlike the news-scanned signals which are global and fan out
  // through signal_matches. A job change is private to the org that tracks that lead - it
  // is derived from their own pipeline - and the feed query already reads org-scoped rows.
  const [signal] = await db
    .insert(signals)
    .values({
      orgId,
      type: "job_change",
      title,
      summary: change.reason,
      url: "",
      companyName: change.to?.company ?? null,
      companyDomain: newDomain,
      confidence: change.confidence,
      occurredAt: new Date(),
      raw: { leadId: lead.id, kind: change.kind, from: change.from, to: change.to, sameEmployer: change.sameEmployer },
    })
    .returning();

  // No signal_matches row: that table links a GLOBAL signal to the subscription that
  // matched it, and its subscription_id is part of the primary key. A job change belongs to
  // no subscription - the org already tracks this person.
  void signal;

  await emitEvent(
    orgId,
    "lead.job_changed",
    {
      leadId: lead.id,
      kind: change.kind,
      confidence: change.confidence,
      from: change.from,
      to: change.to,
      sameEmployer: change.sameEmployer,
      // Said out loud because it is the whole point: one of these is a new opportunity and
      // the other is a deal quietly losing its sponsor.
      whatThisMeans: change.sameEmployer
        ? "Same employer, more senior - the relationship holds and the budget may have grown."
        : "They have left. Any open deal at their old company has lost its champion, and there is a fresh opportunity at the new one.",
    },
    { type: "lead", id: lead.id },
  );
}
