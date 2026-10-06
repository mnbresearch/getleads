import { and, eq, events, getDb, globalSuppressions, inArray, jobs, leads, messages, monitorResults, organizations, playCandidates, scrapedLeads, sql, withStatementTimeout, type Db } from "@prospex/db";
import { ADDRESS_FINGERPRINT_PREFIX, addressFingerprint, onPlatformList, platformBase } from "./privacySuppression.js";

/**
 * Deleting a person means deleting the copies too.
 *
 * `DELETE FROM leads` used to be the whole of "delete this lead". The row went, and so did
 * everything that cascades from it (campaign contacts, list memberships, tasks, discovery
 * provenance) - but the person's address, name and words stayed behind in:
 *
 *   messages         every email sent to them and every reply they wrote (lead_id set NULL)
 *   events           "lead.created" with their name and address, "message.sent" with the
 *                    address and subject - for 90 days, and still delivered to webhooks
 *   monitor_results  the LinkedIn post or mention that surfaced them
 *   play_candidates  what a play found about them, before and after they were approved
 *   jobs             finished enrichment / verification jobs naming them
 *   organizations.settings.aiReplyStyleExamples   replies written to them, kept as examples
 *
 * `eraseLeads` is the one routine for all of it. It is used by the admin's data-subject
 * erasure, is what the lead delete routes call, and the periodic sweep (`sweepErasedLeads`,
 * run by system.cleanup) applies the same treatment to anything a plain delete left behind.
 *
 * What is deliberately kept:
 *   - the workspace's do-not-contact entries: deleting them would allow the person to be
 *     emailed again;
 *   - a message ROW for each message, with no content: the address becomes a one-way
 *     fingerprint and the subject and body are removed. The rows are what the daily sending
 *     caps and the bounce-rate circuit breaker count, so deleting leads must not be a way to
 *     reset either. The fingerprint is also what keeps the unsubscribe link in an
 *     already-sent email working (see lib/privacySuppression.ts);
 *   - copies already pushed to a CRM or delivered to a webhook: they are outside Scout.
 */

/** What a removed message's subject and body read as. */
export const ERASED_TEXT = "(removed)";

/** SQL for an address turned into its fingerprint, leaving a fingerprint as it is. Mirrors addressFingerprint(). */
const fingerprintSql = sql`CASE WHEN ${messages.toEmail} LIKE ${ADDRESS_FINGERPRINT_PREFIX + "%"} THEN ${messages.toEmail} ELSE ${ADDRESS_FINGERPRINT_PREFIX} || encode(sha256(convert_to(lower(btrim(${messages.toEmail})), 'UTF8')), 'hex') END`;

/** The column values that strip a message of everything personal, keeping the row. */
const anonymisedMessage = { toEmail: fingerprintSql, subject: ERASED_TEXT, bodyText: ERASED_TEXT, bodyHtml: null, draftReply: null, error: null } as const;

const chunks = <T>(all: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
};

export interface EraseLeadsResult {
  /** Ids of the lead rows that existed in this workspace and were deleted. */
  deleted: string[];
  messagesAnonymised: number;
  eventsDeleted: number;
}

/**
 * Delete these leads of this workspace, and every copy of their personal data in it.
 *
 * Ids that are not this workspace's leads are ignored (and not reported as deleted), so a
 * caller can pass what it was given and compare `deleted.length` with what was asked for.
 */
export async function eraseLeads(orgId: string, leadIds: string[], dbIn?: Db): Promise<EraseLeadsResult> {
  const db = dbIn ?? getDb().db;
  const out: EraseLeadsResult = { deleted: [], messagesAnonymised: 0, eventsDeleted: 0 };
  const wanted = [...new Set(leadIds.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))];
  for (const part of chunks(wanted, 500)) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: leads.id, email: leads.email, linkedinUrl: leads.linkedinUrl })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), inArray(leads.id, part)));
      if (!rows.length) return;
      const ids = rows.map((r) => r.id);
      const emails = [...new Set(rows.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => !!e))];
      const profiles = [...new Set(rows.map((r) => r.linkedinUrl).filter((u): u is string => !!u))];

      // Replies written to these people that were kept as style examples for AI drafts.
      const sent = await tx
        .select({ body: messages.bodyText })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), inArray(messages.leadId, ids), eq(messages.direction, "outbound")));
      await forgetStyleExamples(tx as unknown as Db, orgId, ids, sent.map((m) => m.body));

      const anonymised = await tx
        .update(messages)
        .set(anonymisedMessage)
        .where(and(eq(messages.orgId, orgId), inArray(messages.leadId, ids)))
        .returning({ id: messages.id });
      out.messagesAnonymised += anonymised.length;

      // Events about the lead itself, about messages to it, and - for rows written with no
      // lead id - events that carry its address.
      const gone = await tx
        .delete(events)
        .where(
          and(
            eq(events.orgId, orgId),
            sql`(${inArray(events.entityId, ids)} OR ${inArray(sql`${events.data}->>'leadId'`, ids)} OR (${events.type} LIKE 'lead.%' AND ${inArray(sql`${events.data}->>'id'`, ids)})${
              emails.length ? sql` OR ${inArray(sql`lower(${events.data}->>'email')`, emails)} OR ${inArray(sql`lower(${events.data}->>'to')`, emails)}` : sql``
            })`,
          ),
        )
        .returning({ id: events.id });
      out.eventsDeleted += gone.length;

      await tx.delete(monitorResults).where(and(eq(monitorResults.orgId, orgId), profiles.length ? sql`(${inArray(monitorResults.leadId, ids)} OR ${inArray(monitorResults.url, profiles)})` : inArray(monitorResults.leadId, ids)));
      // What a play found about these people: the candidates that became (or were matched to)
      // these leads, and any other candidate carrying the same address or profile.
      await tx
        .delete(playCandidates)
        .where(
          and(
            eq(playCandidates.orgId, orgId),
            sql`(${inArray(playCandidates.leadId, ids)}${emails.length ? sql` OR ${inArray(sql`lower(${playCandidates.email})`, emails)}` : sql``}${profiles.length ? sql` OR ${inArray(playCandidates.linkedinUrl, profiles)}` : sql``})`,
          ),
        );
      // Provenance rows cascade with the lead; rows from before they were linked are matched by address.
      if (emails.length) await tx.delete(scrapedLeads).where(and(eq(scrapedLeads.orgId, orgId), sql`${scrapedLeads.leadId} IS NULL`, inArray(sql`lower(${scrapedLeads.email})`, emails)));
      // Finished jobs that name the lead (their results can hold its address). Queued ones
      // find the lead gone and do nothing.
      await tx.delete(jobs).where(and(eq(jobs.orgId, orgId), inArray(jobs.status, ["done", "failed"]), inArray(sql`${jobs.payload}->>'leadId'`, ids)));

      const deleted = await tx.delete(leads).where(and(eq(leads.orgId, orgId), inArray(leads.id, ids))).returning({ id: leads.id });
      out.deleted.push(...deleted.map((d) => d.id));
    });
  }
  return out;
}

/**
 * Drop saved reply examples that were written to these leads.
 *
 * New examples carry the lead's id. Older ones do not, and are matched by their text: the
 * stored example is the reply as typed, and the sent message is that text plus the footer.
 */
async function forgetStyleExamples(db: Db, orgId: string, leadIds: string[], sentBodies: string[]): Promise<void> {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const examples = settings.aiReplyStyleExamples;
  if (!Array.isArray(examples) || !examples.length) return;
  const idSet = new Set(leadIds);
  const kept = examples.filter((e) => {
    if (!e || typeof e !== "object") return false;
    const ex = e as { leadId?: unknown; body?: unknown };
    if (typeof ex.leadId === "string") return !idSet.has(ex.leadId);
    return !(typeof ex.body === "string" && ex.body.trim() && sentBodies.some((b) => typeof b === "string" && b.startsWith(ex.body as string)));
  });
  if (kept.length === examples.length) return;
  // Only this key is rewritten, so a setting saved by someone else in the meantime is not lost.
  await db.execute(sql`UPDATE organizations SET settings = jsonb_set(settings, '{aiReplyStyleExamples}', ${JSON.stringify(kept)}::jsonb) WHERE id = ${orgId}`);
}

// ── Data-subject requests (platform admin) ──

export interface DataSubjectWorkspace {
  orgId: string;
  orgName: string;
  leads: number;
  campaignContacts: number;
  /** Message rows that still hold the address (and so its content). */
  messages: number;
  /** Message rows kept WITHOUT content: the address is a fingerprint, subject and body are removed. */
  anonymisedMessages: number;
  suppressed: boolean;
}

/**
 * "Is this the person's mailbox?" in SQL, for a lower-cased address column: the same rule
 * as platformBase() - the local part up to the first "+". A request about jane@acme.com is
 * a request about jane+news@acme.com too.
 */
const sameMailbox = (column: ReturnType<typeof sql>, base: string) => sql`regexp_replace(lower(btrim(${column})), '^([^+@]+)\\+[^@]*@', '\\1@') = ${base}`;

/**
 * Where one person appears, across every workspace. Counts only: no content leaves the workspace.
 *
 * `held` answers the question an operator is actually asking - "does any workspace still
 * hold this person's data?". Message rows kept without content and do-not-contact entries
 * are records ABOUT a removal, not the person's data, so a person who appears only in
 * those is not held. They are still listed, with their own counts, so the operator can see
 * what remains and why.
 */
export async function dataSubjectReport(email: string): Promise<{ email: string; globallySuppressed: boolean; held: boolean; workspaces: DataSubjectWorkspace[] }> {
  const { db } = getDb();
  const e = email.trim().toLowerCase();
  const base = platformBase(e);
  const prints = [...new Set([addressFingerprint(e), addressFingerprint(base)])];
  const listKeys = [...new Set([e, base, ...prints])];
  const rows = (await db.execute(sql`
    WITH l AS (SELECT org_id, count(*)::int AS n FROM leads WHERE ${sameMailbox(sql`email`, base)} GROUP BY org_id),
         cc AS (SELECT le.org_id, count(*)::int AS n FROM campaign_contacts c JOIN leads le ON le.id = c.lead_id WHERE ${sameMailbox(sql`le.email`, base)} GROUP BY le.org_id),
         m AS (SELECT org_id, count(*)::int AS n FROM messages WHERE ${sameMailbox(sql`to_email`, base)} GROUP BY org_id),
         am AS (SELECT org_id, count(*)::int AS n FROM messages WHERE ${inArray(sql`to_email`, prints)} GROUP BY org_id),
         s AS (SELECT DISTINCT org_id FROM suppressions WHERE ${inArray(sql`email`, listKeys)})
    SELECT o.id AS org_id, o.name AS org_name, coalesce(l.n, 0) AS leads, coalesce(cc.n, 0) AS campaign_contacts, coalesce(m.n, 0) AS messages, coalesce(am.n, 0) AS anonymised_messages, (s.org_id IS NOT NULL) AS suppressed
    FROM organizations o
    LEFT JOIN l ON l.org_id = o.id LEFT JOIN cc ON cc.org_id = o.id LEFT JOIN m ON m.org_id = o.id LEFT JOIN am ON am.org_id = o.id LEFT JOIN s ON s.org_id = o.id
    WHERE l.org_id IS NOT NULL OR cc.org_id IS NOT NULL OR m.org_id IS NOT NULL OR am.org_id IS NOT NULL OR s.org_id IS NOT NULL
    ORDER BY o.name
    LIMIT 1000`)) as unknown as { org_id: string; org_name: string; leads: number; campaign_contacts: number; messages: number; anonymised_messages: number; suppressed: boolean }[];
  const workspaces = [...rows].map((r) => ({
    orgId: String(r.org_id),
    orgName: String(r.org_name),
    leads: Number(r.leads) || 0,
    campaignContacts: Number(r.campaign_contacts) || 0,
    messages: Number(r.messages) || 0,
    anonymisedMessages: Number(r.anonymised_messages) || 0,
    suppressed: r.suppressed === true,
  }));
  return {
    email: e,
    globallySuppressed: await onPlatformList(e, db),
    held: workspaces.some((w) => w.leads > 0 || w.campaignContacts > 0 || w.messages > 0),
    workspaces,
  };
}

/**
 * Erase a person from every workspace and put their address on the platform list.
 *
 * The address goes on the list FIRST: from that moment no workspace can email it, even if
 * the rest of this is interrupted - and running it again finishes the job. Plus-tagged
 * variants of the address (see platformBase) are the same person and are erased with it.
 */
export async function eraseDataSubject(email: string, note = "Erased at the person's request"): Promise<{ workspaces: number; leadsDeleted: number; messagesAnonymised: number; eventsDeleted: number }> {
  const { db } = getDb();
  const e = email.trim().toLowerCase();
  const base = platformBase(e);
  await db.insert(globalSuppressions).values({ email: e, reason: "erasure_request", note: note.slice(0, 500) }).onConflictDoNothing();

  const holders = await db.select({ id: leads.id, orgId: leads.orgId }).from(leads).where(sameMailbox(sql`${leads.email}`, base));
  const byOrg = new Map<string, string[]>();
  for (const h of holders) byOrg.set(h.orgId, [...(byOrg.get(h.orgId) ?? []), h.id]);
  const touched = new Set<string>();
  let leadsDeleted = 0;
  let messagesAnonymised = 0;
  let eventsDeleted = 0;
  for (const [orgId, ids] of byOrg) {
    const r = await eraseLeads(orgId, ids);
    leadsDeleted += r.deleted.length;
    messagesAnonymised += r.messagesAnonymised;
    eventsDeleted += r.eventsDeleted;
    if (r.deleted.length) touched.add(orgId);
  }
  // Copies with no lead behind them any more: messages left by an earlier plain delete,
  // events carrying the address, provenance rows.
  const orphans = await db.update(messages).set(anonymisedMessage).where(sameMailbox(sql`${messages.toEmail}`, base)).returning({ orgId: messages.orgId });
  messagesAnonymised += orphans.length;
  for (const o of orphans) touched.add(o.orgId);
  const ev = await db.delete(events).where(sql`${sameMailbox(sql`${events.data}->>'email'`, base)} OR ${sameMailbox(sql`${events.data}->>'to'`, base)}`).returning({ orgId: events.orgId });
  eventsDeleted += ev.length;
  for (const o of ev) touched.add(o.orgId);
  await db.delete(scrapedLeads).where(sameMailbox(sql`${scrapedLeads.email}`, base));
  // Candidates a play is holding for review, in every workspace: the person asked to be
  // forgotten, and the address is on the platform list so no play will store it again.
  const candidates = await db.delete(playCandidates).where(sameMailbox(sql`${playCandidates.email}`, base)).returning({ orgId: playCandidates.orgId });
  for (const o of candidates) touched.add(o.orgId);
  // The workspaces' own do-not-contact entries for this address stay: they are what keeps
  // it from being emailed, and they hold nothing but the address.
  return { workspaces: touched.size, leadsDeleted, messagesAnonymised, eventsDeleted };
}

// ── The periodic sweep ──

const SWEEP_STATEMENT_MS = 120_000;
/**
 * The sweep leaves the last hour alone. A row that new may belong to work still in flight (a
 * send recording its message while the lead is being deleted), and rows this young are the
 * ones another transaction is most likely to hold; anything it skips is picked up by the
 * next pass, six hours later.
 */
const SWEEP_MIN_AGE = sql.raw("interval '1 hour'");

/**
 * Apply the erasure to what a plain `DELETE FROM leads` left behind.
 *
 * Belt and braces for any delete that does not go through `eraseLeads` (an older release
 * during a rolling deploy, a row removed by hand, a cascade from a deleted client or list):
 * a message whose lead is gone loses its content, and events naming a lead that no longer
 * exists are removed. Each statement is time-limited and failures are reported, not thrown -
 * housekeeping must not stop the rest of the cleanup job.
 */
export async function sweepErasedLeads(dbIn?: Db): Promise<{ messagesAnonymised: number; eventsDeleted: number; failed: string[] }> {
  const db = dbIn ?? getDb().db;
  const out = { messagesAnonymised: 0, eventsDeleted: 0, failed: [] as string[] };
  const step = async (name: string, run: (tx: Db) => Promise<number>) => {
    try {
      const n = await withStatementTimeout(db, SWEEP_STATEMENT_MS, run);
      return n;
    } catch (e) {
      out.failed.push(name);
      console.warn(`[privacy] cleanup step "${name}" did not finish: ${(e as Error).name}`);
      return 0;
    }
  };
  // Raw statements and the driver's row count: the first run after this ships may touch
  // every message a past delete left behind, and those rows need not be read back.
  const counted = (r: unknown) => Number((r as { count?: number } | null)?.count ?? 0) || 0;
  out.messagesAnonymised = await step("messages of deleted leads", async (tx) =>
    counted(
      await tx.execute(sql`
        UPDATE messages SET
          to_email = ${ADDRESS_FINGERPRINT_PREFIX} || encode(sha256(convert_to(lower(btrim(to_email)), 'UTF8')), 'hex'),
          subject = ${ERASED_TEXT}, body_text = ${ERASED_TEXT}, body_html = NULL, draft_reply = NULL, error = NULL
        WHERE lead_id IS NULL AND to_email NOT LIKE ${ADDRESS_FINGERPRINT_PREFIX + "%"} AND created_at < now() - ${SWEEP_MIN_AGE}
          -- Only when the person really is gone. A message can be stored without a lead id
          -- while the lead still exists (a reply whose sender address differs only in
          -- letter case from the stored one); its content belongs to a lead the workspace
          -- still has, and must be left alone.
          AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.org_id = messages.org_id AND lower(btrim(l.email)) = lower(btrim(messages.to_email)))
          AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.org_id = messages.org_id AND l.phone IS NOT NULL AND l.phone = messages.to_email)`),
    ),
  );
  out.eventsDeleted = await step("events of deleted leads", async (tx) => {
    const a = counted(await tx.execute(sql`DELETE FROM events e WHERE e.entity_type = 'lead' AND e.entity_id IS NOT NULL AND e.created_at < now() - ${SWEEP_MIN_AGE} AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = e.entity_id)`));
    // The CASE keeps the cast from ever being tried on something that is not an id.
    const b = counted(
      await tx.execute(sql`
        DELETE FROM events e
        WHERE e.data->>'leadId' IS NOT NULL
          AND e.created_at < now() - ${SWEEP_MIN_AGE}
          AND e.data->>'leadId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          AND NOT EXISTS (
            SELECT 1 FROM leads l
            WHERE l.id = CASE WHEN e.data->>'leadId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (e.data->>'leadId')::uuid END)`),
    );
    return a + b;
  });
  return out;
}
