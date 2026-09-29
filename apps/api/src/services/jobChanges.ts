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
  /** Changes we had already recorded and alerted on, so did not raise again. */
  alreadyKnown: number;
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
  opts: { limit?: number; minScore?: number; staleDays?: number; retryDays?: number } = {},
): Promise<JobChangeScanResult> {
  const { db } = getDb();
  const limit = Math.min(opts.limit ?? 50, 500);
  const minScore = opts.minScore ?? 70;
  const staleDays = opts.staleDays ?? 30;
  // Backoff for a lead nothing could be confirmed about. Never longer than staleDays,
  // because that would make a failed lookup suppress checks for longer than a successful
  // one - the inversion this module is built to avoid, arriving by the back door.
  const retryDays = Math.max(1, Math.min(opts.retryDays ?? 3, staleDays));

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
        // And not attempted in the last few days, whatever came of that attempt.
        //
        // Without this, every lead the providers cannot answer for - no coverage, no
        // company on file to compare against - was re-selected on EVERY run: an enrichment
        // call per lead per night for an answer that will not change, and, for any change
        // detected without a comparable employer, a duplicate signal row and a duplicate
        // `lead.job_changed` alert each time. Refusing to stamp `jobCheckedAt` on an
        // unconfirmed lookup is right; retrying it nightly forever is not the same thing.
        sql`(${leads.jobCheckAttemptedAt} IS NULL OR ${leads.jobCheckAttemptedAt} < now() - (${retryDays} || ' days')::interval)`,
        sql`(${leads.linkedinUrl} IS NOT NULL OR ${leads.email} IS NOT NULL)`,
      ),
    )
    .orderBy(desc(leads.score))
    .limit(limit);

  const out: JobChangeScanResult = { checked: 0, changed: 0, unconfirmed: 0, alreadyKnown: 0, changes: [] };
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
    // The attempt is recorded whatever came of it. This is NOT "we checked and they are
    // fine" - that is `jobCheckedAt`, below, and it is still only written on a real
    // comparison. This is only "do not spend another provider call on this person
    // tomorrow".
    const attempted: Record<string, Date> = { jobCheckAttemptedAt: new Date(), updatedAt: new Date() };

    // No provider answered for this person. Stamping jobCheckedAt here would mean "we
    // looked and they are fine", which is exactly the lie this module exists to avoid - and
    // it would suppress the next real check for a month.
    if (!fresh) {
      out.unconfirmed++;
      await db.update(leads).set(attempted).where(eq(leads.id, lead.id));
      continue;
    }
    answered++;

    const change = detectJobChange({
      previous: { companyName: company?.name ?? null, companyDomain: company?.domain ?? null, title: lead.title },
      current: { companyName: fresh.companyName ?? null, companyDomain: fresh.companyDomain ?? null, title: fresh.title ?? null },
    });

    if (change.kind === "unknown") {
      out.unconfirmed++;
      await db.update(leads).set(attempted).where(eq(leads.id, lead.id));
      continue;
    }

    // Stamped only when the EMPLOYER could actually be compared on both sides.
    //
    // `kind: "none"` also comes back when the titles match and the company could not be
    // compared - honest as far as it goes, but a lead with no company on file whose title
    // is unchanged would have been recorded as "checked, no change", suppressing the next
    // real check for a month while the provider was quietly reporting a new employer we had
    // nothing to compare against. That is the failure this whole module is built to avoid,
    // arriving through the one path that looks like success.
    if (change.comparedCompany) {
      await db.update(leads).set({ ...attempted, jobCheckedAt: new Date() }).where(eq(leads.id, lead.id));
    } else {
      out.unconfirmed++;
      await db.update(leads).set(attempted).where(eq(leads.id, lead.id));
    }

    if (change.kind === "none") continue;

    // Already raised? Then it is still true, and still worth counting - but alerting on it
    // again every cycle would train the person receiving it to ignore the alert.
    if (await alreadyRecorded(db, orgId, lead.id, change)) {
      out.alreadyKnown++;
      continue;
    }

    out.changed++;
    out.changes.push({ leadId: lead.id, fullName: lead.fullName, change });
    await recordJobChange(db, orgId, lead, change, fresh.companyDomain ?? null);
  }

  // Everything we tried came back empty.
  //
  // Deliberately hedged. `enrichWithProviders` returns null for "no provider configured",
  // "the provider threw" AND "the provider answered and had no match on this person", and
  // it does not say which. Asserting a credential problem would be a diagnosis this data
  // cannot support - fifty people genuinely not in any database looks identical from here.
  // So it says what is true: nothing came back, and that is not the same as nobody moving.
  if (out.checked > 0 && answered === 0) {
    out.blocked = `Nothing came back for any of the ${out.checked} leads checked. That may be a provider or credential problem, or these people may simply not be in the databases we can reach - either way it is not a month in which nobody changed job. Check Settings - Integrations if you expect a provider to be answering.`;
  }

  return out;
}

/**
 * Have we already told this org about this exact move?
 *
 * The lead's own company row is not rewritten when a move is detected - deciding whether
 * the CRM record should follow the person or stay with the account is the org's call, not
 * ours - so the same move is detected again at the next scan, and would be announced again.
 * Matching on the destination rather than on the lead alone means a SECOND move, to
 * somewhere else, still comes through.
 */
async function alreadyRecorded(db: Db, orgId: string, leadId: string, change: JobChangeResult): Promise<boolean> {
  const rows = await db
    .select({ id: signals.id })
    .from(signals)
    .where(
      and(
        eq(signals.orgId, orgId),
        eq(signals.type, "job_change"),
        sql`${signals.raw}->>'leadId' = ${leadId}`,
        sql`${signals.raw}->>'kind' = ${change.kind}`,
        sql`coalesce(${signals.raw}->'to'->>'company', '') = ${change.to?.company ?? ""}`,
        sql`coalesce(${signals.raw}->'to'->>'title', '') = ${change.to?.title ?? ""}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
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
