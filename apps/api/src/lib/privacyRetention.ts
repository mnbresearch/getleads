import { sql, withStatementTimeout, type Db } from "@prospex/db";
import { KNOWN_IP_DAYS } from "./loginGuard.js";
import { KEYED_IP_HASH_PREFIX, keyedFromLegacy } from "./privacyVisitor.js";
import { sweepErasedLeads } from "./privacyErase.js";

/**
 * How long things are kept. One table of numbers, used by the cleanup job below and stated,
 * with the same numbers, in the Privacy Policy (apps/web/src/pages/Legal.tsx carries a copy
 * of this object, and security.privacy.test.ts fails when the two differ).
 *
 * Generous on purpose: these are upper bounds on data nobody needs any more, not a tight
 * schedule. What a customer keeps deliberately - leads, companies, campaigns, messages, the
 * do-not-contact list - has no time limit here: it stays until the customer deletes it or
 * the workspace is deleted.
 */
export const RETENTION = {
  /** Individual page-view rows from the visitor pixel. (The per-company summary stays.) */
  visitDays: 395,
  /** Failed sign-in attempts (address + IP). */
  loginFailureDays: 30,
  /** Successful sign-ins (address + IP): what makes an address "known" for an account. */
  loginSuccessDays: 90,
  /** Password-reset, email-confirmation and sign-in hand-off tokens, after they expire. */
  expiredTokenDays: 30,
  /** Team invitations, after they were accepted, revoked or expired. */
  closedInviteDays: 90,
  /** Finished background jobs. (A finished search keeps its list of result ids.) */
  finishedJobDays: 7,
  /** Failed background jobs, kept longer because they are what gets read when diagnosing. */
  failedJobDays: 30,
  /** The activity feed (events), which is also what webhooks are delivered from. */
  eventDays: 90,
  /** The security audit log. */
  auditLogDays: 730,
  /** Upgrade requests that were closed (converted or dismissed). */
  closedUpgradeRequestDays: 730,
  /**
   * What a play found and nobody approved: candidates still waiting or skipped, and the
   * record of each run. (An approved candidate stays for as long as its lead does.)
   */
  playCandidateDays: 180,
} as const;

const STATEMENT_MS = 120_000;
const BATCH = 10_000;
const MAX_BATCHES = 30;

const counted = (r: unknown) => Number((r as { count?: number } | null)?.count ?? 0) || 0;

export interface RetentionReport {
  deleted: Record<string, number>;
  /** One-off conversions of rows stored before the pixel's privacy rules. */
  converted: Record<string, number>;
  /** Steps that did not finish this time; they run again on the next pass. */
  failed: string[];
  /** Steps that were not run because an operator switched them off. */
  skipped?: string[];
}

/** The deleted-lead sweep runs unless PRIVACY_SWEEP is "off" (also: false, 0, no). Read per pass, so it can be changed without a deploy. */
export function privacySweepEnabled(): boolean {
  return !/^(off|false|0|no)$/i.test((process.env.PRIVACY_SWEEP ?? "").trim());
}

/**
 * The retention pass. Every step is independent, time-limited and batched: a table that is
 * slow or locked today is reported in `failed` and tried again in six hours, and never
 * stops the steps after it.
 */
export async function runRetention(db: Db): Promise<RetentionReport> {
  const report: RetentionReport = { deleted: {}, converted: {}, failed: [] };
  // `repeat`: the statement handles at most `full` rows a time; run it again while it comes back full.
  const step = async (kind: "deleted" | "converted", name: string, run: (tx: Db) => Promise<number>, opts: { repeat?: boolean; full?: number } = {}) => {
    try {
      let total = 0;
      for (let i = 0; i < (opts.repeat ? MAX_BATCHES : 1); i++) {
        const n = await withStatementTimeout(db, STATEMENT_MS, run);
        total += n;
        if (n < (opts.full ?? BATCH)) break;
      }
      if (total) report[kind][name] = (report[kind][name] ?? 0) + total;
    } catch (e) {
      report.failed.push(name);
      console.warn(`[privacy] retention step "${name}" did not finish: ${(e as Error).name}`);
    }
  };
  const days = (n: number) => sql.raw(`interval '${Math.floor(n)} days'`);

  // ── Visitor pixel ──
  await step("deleted", "visits", async (tx) => counted(await tx.execute(sql`DELETE FROM visits WHERE id IN (SELECT id FROM visits WHERE visited_at < now() - ${days(RETENTION.visitDays)} LIMIT ${BATCH})`)), { repeat: true });
  // A finished lookup has no further use for its job row; the address in it was scrubbed
  // when the job ended, and anything a crash left behind is scrubbed here.
  await step("converted", "visit lookups scrubbed", async (tx) =>
    counted(await tx.execute(sql`UPDATE jobs SET payload = payload - 'sealed' - 'ip' - 'identify' WHERE type = 'visit.identify' AND status IN ('done', 'failed') AND (payload ? 'sealed' OR payload ? 'ip' OR payload ? 'identify')`)),
  );
  await step("deleted", "visit lookups", async (tx) => counted(await tx.execute(sql`DELETE FROM jobs WHERE type = 'visit.identify' AND status IN ('done', 'failed') AND updated_at < now() - interval '1 day'`)));
  // Stored before query strings were stripped at the door: cut in place.
  await step("converted", "visit addresses without query strings", async (tx) =>
    counted(
      await tx.execute(sql`
        UPDATE visits SET page = split_part(split_part(page, '?', 1), '#', 1), referrer = split_part(split_part(referrer, '?', 1), '#', 1)
        WHERE id IN (SELECT id FROM visits WHERE page ~ '[?#]' OR referrer ~ '[?#]' LIMIT ${BATCH})`),
    ),
    { repeat: true },
  );
  await step("converted", "visitor events without query strings", async (tx) =>
    counted(
      await tx.execute(sql`
        UPDATE events SET data = jsonb_set(data, '{page}', to_jsonb(split_part(split_part(data->>'page', '?', 1), '#', 1)))
        WHERE type = 'visitor.identified' AND data->>'page' ~ '[?#]'`),
    ),
  );
  // Stored before the IP hash was keyed: converted in place, so a returning visitor's new
  // rows carry the same value as their old ones (see lib/privacyVisitor.ts).
  await step("converted", "visit address hashes keyed", (tx) => rekeyLegacyIpHashes(tx), { repeat: true, full: REKEY_BATCH });

  // ── Sign-in ──
  await step("deleted", "login attempts", async (tx) =>
    counted(
      await tx.execute(sql`
        DELETE FROM login_attempts WHERE id IN (
          SELECT id FROM login_attempts
          WHERE (succeeded = false AND created_at < now() - ${days(RETENTION.loginFailureDays)})
             OR created_at < now() - ${days(Math.max(RETENTION.loginSuccessDays, KNOWN_IP_DAYS))}
          LIMIT ${BATCH})`),
    ),
    { repeat: true },
  );
  await step("deleted", "password reset tokens", async (tx) => counted(await tx.execute(sql`DELETE FROM password_reset_tokens WHERE expires_at < now() - ${days(RETENTION.expiredTokenDays)}`)));
  await step("deleted", "email confirmation tokens", async (tx) => counted(await tx.execute(sql`DELETE FROM email_verification_tokens WHERE expires_at < now() - ${days(RETENTION.expiredTokenDays)}`)));
  await step("deleted", "sign-in hand-off codes", async (tx) => counted(await tx.execute(sql`DELETE FROM oauth_exchange_codes WHERE expires_at < now() - ${days(RETENTION.expiredTokenDays)}`)));
  await step("deleted", "invites", async (tx) =>
    counted(
      await tx.execute(sql`
        DELETE FROM invites
        WHERE coalesce(accepted_at, revoked_at, coalesce(expires_at, created_at + interval '14 days')) < now() - ${days(RETENTION.closedInviteDays)}
          AND (accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR coalesce(expires_at, created_at + interval '14 days') < now())`),
    ),
  );

  // ── Logs ──
  await step("deleted", "audit log", async (tx) => counted(await tx.execute(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < now() - ${days(RETENTION.auditLogDays)} LIMIT ${BATCH})`)), { repeat: true });
  await step("deleted", "upgrade requests", async (tx) => counted(await tx.execute(sql`DELETE FROM upgrade_requests WHERE status IN ('converted', 'dismissed') AND created_at < now() - ${days(RETENTION.closedUpgradeRequestDays)}`)));

  // ── Plays ──
  // People a play found who were never approved are not kept indefinitely: a candidate is
  // personal data held on the strength of "someone may want to review this".
  await step("deleted", "play candidates", async (tx) =>
    counted(await tx.execute(sql`DELETE FROM play_candidates WHERE id IN (SELECT id FROM play_candidates WHERE status IN ('pending', 'skipped') AND created_at < now() - ${days(RETENTION.playCandidateDays)} LIMIT ${BATCH})`)),
    { repeat: true },
  );
  // An approved person stays while their lead exists. A lead removed by a plain delete (a
  // cascade, a row removed by hand) leaves the candidate without one; it goes too.
  await step("deleted", "play candidates of deleted leads", async (tx) =>
    counted(
      await tx.execute(sql`
        DELETE FROM play_candidates WHERE id IN (
          SELECT id FROM play_candidates
          WHERE status = 'approved' AND kind = 'person' AND lead_id IS NULL AND coalesce(decided_at, created_at) < now() - interval '1 hour'
          LIMIT ${BATCH})`),
    ),
    { repeat: true },
  );
  await step("deleted", "play runs", async (tx) => counted(await tx.execute(sql`DELETE FROM play_runs WHERE id IN (SELECT id FROM play_runs WHERE started_at < now() - ${days(RETENTION.playCandidateDays)} LIMIT ${BATCH})`)), { repeat: true });

  // ── Copies of deleted leads ──
  // The one step that rewrites rows a customer could once read (a deleted lead's old
  // messages lose their content), and cannot be undone. On by default; an operator who
  // wants to keep a rollback to the previous release free of surprises can switch it off,
  // and everything above still runs. Deleting a lead in the app erases its copies at once
  // either way - this only concerns what earlier deletes left behind.
  if (privacySweepEnabled()) {
    const swept = await sweepErasedLeads(db);
    if (swept.messagesAnonymised) report.converted["messages of deleted leads"] = swept.messagesAnonymised;
    if (swept.eventsDeleted) report.deleted["events of deleted leads"] = swept.eventsDeleted;
    report.failed.push(...swept.failed);
  } else {
    report.skipped = ["copies of deleted leads (switched off by the operator)"];
  }
  return report;
}

const REKEY_BATCH = 1000;

/** One batch of distinct legacy IP hashes converted to the keyed form. Returns how many it converted. */
async function rekeyLegacyIpHashes(tx: Db): Promise<number> {
  const PER = REKEY_BATCH;
  const rows = (await tx.execute(sql`SELECT DISTINCT ip_hash FROM visits WHERE left(ip_hash, ${KEYED_IP_HASH_PREFIX.length}) <> ${KEYED_IP_HASH_PREFIX} LIMIT ${PER}`)) as unknown as { ip_hash: string }[];
  const legacy = [...rows].map((r) => String(r.ip_hash));
  if (!legacy.length) return 0;
  const pairs = sql.join(legacy.map((h) => sql`(${h}, ${keyedFromLegacy(h)})`), sql`, `);
  await tx.execute(sql`UPDATE visits v SET ip_hash = m.keyed FROM (VALUES ${pairs}) AS m(legacy, keyed) WHERE v.ip_hash = m.legacy`);
  return legacy.length;
}
