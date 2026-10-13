/**
 * One reminder email for a checkout that was started and not finished.
 *
 * Off unless the operator turns it on. CHECKOUT_FOLLOWUP is one of:
 *   off      (default) nothing is emailed; sessions are still judged abandoned and counted
 *   dry_run  every decision is made and recorded, but no email is sent
 *   on       the reminder is sent
 * CHECKOUT_FOLLOWUP_AFTER_HOURS (default 24, 1-168) is how long after starting a checkout
 * it counts as abandoned. Both are read on every run, so they change without a deploy.
 *
 * Rules, each one tested in checkout.followup.test.ts:
 *  - a session gets exactly one outcome in `followup_status`: sent, dry_run, failed (or
 *    failed:no_mailer) or skipped:<reason>. The row is claimed with
 *    `UPDATE ... WHERE followup_status IS NULL RETURNING` before anything happens, so two
 *    runs at once never email the same session twice;
 *  - never more than one email per session, and at most one per workspace per 14 days;
 *  - only to the person who started the checkout, only when their address is confirmed, and
 *    never when they opted out of these emails or are on the platform do-not-contact list;
 *  - every email carries a one-click unsubscribe link (and a List-Unsubscribe header).
 *
 * Expired sessions count as well as open ones: Stripe expires an unpaid checkout after 24
 * hours, which is the default wait here, so most abandoned checkouts are already "expired"
 * by the time they are looked at.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { getDb, PLANS, sql, type Db } from "@prospex/db";
import { env } from "../env.js";
import { safeEqual } from "../lib/crypto.js";
import { sendMail, systemMailerConfig } from "../lib/mailer.js";
import { onPlatformList } from "../lib/privacySuppression.js";
import { trackProduct } from "../lib/productEvents.js";

export type FollowupMode = "off" | "dry_run" | "on";
export const FOLLOWUP_KIND = "checkout_followup";
/** Sessions older than this are never emailed: the moment has passed. */
export const FOLLOWUP_MAX_AGE_DAYS = 7;
/** At most one reminder per workspace in this many days. */
export const FOLLOWUP_ORG_GAP_DAYS = 14;
/** A claim that has been "sending" this long belongs to a run that died; it is closed as failed. */
const STALE_SENDING_MINUTES = 60;
const BATCH = 200;

export function followupMode(): FollowupMode {
  const v = (process.env.CHECKOUT_FOLLOWUP ?? "").trim().toLowerCase();
  return v === "on" || v === "dry_run" ? v : "off";
}

export function followupAfterHours(): number {
  const n = Number((process.env.CHECKOUT_FOLLOWUP_AFTER_HOURS ?? "").trim() || 24);
  if (!Number.isFinite(n)) return 24;
  return Math.min(168, Math.max(1, Math.floor(n)));
}

// ── Unsubscribe link ──
/** Key for the opt-out signature: derived from JWT_SECRET and used for nothing else. */
const optOutKey = () => Buffer.from(hkdfSync("sha256", env.jwtSecret, Buffer.alloc(0), "scout:email-opt-out:v1", 32));

export function optOutSignature(userId: string, kind: string): string {
  return createHmac("sha256", optOutKey()).update(`${userId}.${kind}`).digest("base64url");
}

export function verifyOptOutSignature(userId: string, kind: string, sig: string): boolean {
  if (typeof sig !== "string" || !sig || sig.length > 100) return false;
  return safeEqual(optOutSignature(userId, kind), sig);
}

export function optOutLink(userId: string, kind: string = FOLLOWUP_KIND): string {
  const q = new URLSearchParams({ u: userId, k: kind, s: optOutSignature(userId, kind) });
  return `${env.apiUrl}/v1/public/email-opt-out?${q.toString()}`;
}

// ── The email ──
const oneLine = (v: string | null | undefined, max = 80) => (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const planName = (plan: string) => (Object.prototype.hasOwnProperty.call(PLANS, plan) ? PLANS[plan].name : oneLine(plan, 40));

export interface FollowupEmail {
  subject: string;
  text: string;
  headers: Record<string, string>;
}

export function renderFollowupEmail(input: { workspace: string; plan: string; userId: string }): FollowupEmail {
  const workspace = oneLine(input.workspace) || "your workspace";
  const plan = planName(input.plan);
  const link = optOutLink(input.userId);
  const text = [
    "Hello,",
    "",
    `You started upgrading ${workspace} to ${plan} but didn't finish. Pick up where you left off: ${env.appUrl}/settings/billing`,
    "",
    "If you meant to stop, there is nothing to do. This is the only reminder we send for it.",
    "",
    "- Scout",
    "",
    `Don't want reminders like this? Unsubscribe with one click: ${link}`,
  ].join("\n");
  return {
    subject: `Finish upgrading ${workspace} to ${plan}`,
    text,
    headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// ── Deciding ──
interface Candidate {
  id: string;
  org_id: string;
  user_id: string | null;
  plan: string;
  created_at: Date | string;
  org_name: string | null;
  org_plan: string | null;
  org_status: string | null;
  email: string | null;
  email_verified_at: Date | string | null;
  opted_out: boolean;
  later_completed: boolean;
  recent_followup: boolean;
  too_old: boolean;
}

export type Decision = { send: true } | { send: false; reason: string; abandoned: boolean };

/** What should happen to one candidate, given the facts the query collected. Pure. */
export function decide(c: Candidate, suppressed: boolean, orgsThisRun: ReadonlySet<string>): Decision {
  if (c.later_completed) return { send: false, reason: "completed_later", abandoned: false };
  if (c.org_plan && c.org_plan === c.plan) return { send: false, reason: "plan_already", abandoned: false };
  if (c.too_old) return { send: false, reason: "too_old", abandoned: true };
  if (c.org_status && c.org_status !== "active") return { send: false, reason: "org_inactive", abandoned: true };
  if (!c.user_id || !c.email) return { send: false, reason: "no_user", abandoned: true };
  if (!c.email_verified_at) return { send: false, reason: "unverified", abandoned: true };
  if (c.opted_out) return { send: false, reason: "opted_out", abandoned: true };
  if (suppressed) return { send: false, reason: "suppressed", abandoned: true };
  if (c.recent_followup || orgsThisRun.has(c.org_id)) return { send: false, reason: "recent_followup", abandoned: true };
  return { send: true };
}

const rowsOf = <T>(r: unknown): T[] => [...((Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as T[])];

/**
 * Sessions due a decision now: open or expired, not decided yet, started at least
 * AFTER_HOURS ago. Older than 7 days are included too, so they get their one outcome
 * (skipped:too_old) instead of sitting undecided forever.
 */
async function loadCandidates(db: Db, afterHours: number, limit: number): Promise<Candidate[]> {
  return rowsOf<Candidate>(
    await db.execute(sql`
      SELECT cs.id, cs.org_id, cs.user_id, cs.plan, cs.created_at,
        o.name AS org_name, o.plan AS org_plan, o.status AS org_status,
        u.email, u.email_verified_at,
        EXISTS (SELECT 1 FROM email_opt_outs eo WHERE eo.user_id = cs.user_id AND eo.kind = ${FOLLOWUP_KIND}) AS opted_out,
        EXISTS (SELECT 1 FROM checkout_sessions c2 WHERE c2.org_id = cs.org_id AND c2.status = 'completed' AND c2.completed_at >= cs.created_at) AS later_completed,
        EXISTS (SELECT 1 FROM checkout_sessions c3 WHERE c3.org_id = cs.org_id AND c3.id <> cs.id AND c3.followup_status IN ('sent', 'sending')
                AND c3.followup_at > now() - ${sql.raw(`interval '${FOLLOWUP_ORG_GAP_DAYS} days'`)}) AS recent_followup,
        cs.created_at < now() - ${sql.raw(`interval '${FOLLOWUP_MAX_AGE_DAYS} days'`)} AS too_old
      FROM checkout_sessions cs
      JOIN organizations o ON o.id = cs.org_id
      LEFT JOIN users u ON u.id = cs.user_id AND u.org_id = cs.org_id
      WHERE cs.status IN ('open', 'expired') AND cs.followup_status IS NULL
        AND cs.created_at <= now() - ${sql.raw(`interval '${Math.floor(afterHours)} hours'`)}
      ORDER BY cs.created_at ASC
      LIMIT ${limit}`),
  );
}

/** Set a session's outcome, only if it has none yet. True when this caller set it. */
async function claim(db: Db, id: string, status: string): Promise<boolean> {
  const r = await db.execute(sql`UPDATE checkout_sessions SET followup_status = ${status}, followup_at = now() WHERE id = ${id} AND followup_status IS NULL RETURNING id`);
  return rowsOf(r).length > 0;
}

export interface FollowupReport {
  mode: FollowupMode;
  afterHours: number;
  considered: number;
  sent: number;
  dryRun: number;
  failed: number;
  skipped: Record<string, number>;
  /** preview only: what each session would get, in order. */
  decisions?: { sessionId: string; orgId: string; orgName: string; plan: string; createdAt: string; outcome: string }[];
  /** preview only: the email the first eligible session would get. */
  sample?: (FollowupEmail & { to: string }) | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * Decide every session that is due, and act on it according to the mode.
 *
 * `preview: true` makes the same decisions and writes nothing at all (no outcome, no event,
 * no email): it is what the admin "Preview" button shows. Never throws for one bad row; a row
 * whose email fails is recorded as failed and the run goes on.
 */
export async function runCheckoutFollowups(opts: { preview?: boolean; mode?: FollowupMode; limit?: number } = {}): Promise<FollowupReport> {
  const { db } = getDb();
  const mode = opts.mode ?? followupMode();
  const afterHours = followupAfterHours();
  const preview = !!opts.preview;
  const report: FollowupReport = { mode, afterHours, considered: 0, sent: 0, dryRun: 0, failed: 0, skipped: {} };
  if (preview) {
    report.decisions = [];
    report.sample = null;
  }
  // A run that died between claiming and sending left "sending" behind: closed as failed,
  // so every session still ends with one final outcome (and nobody is emailed twice).
  if (!preview) await db.execute(sql`UPDATE checkout_sessions SET followup_status = 'failed' WHERE followup_status = 'sending' AND followup_at < now() - ${sql.raw(`interval '${STALE_SENDING_MINUTES} minutes'`)}`);

  const candidates = await loadCandidates(db, afterHours, Math.min(Math.max(opts.limit ?? BATCH, 1), 1000));
  const orgsThisRun = new Set<string>();
  const skip = (reason: string) => (report.skipped[reason] = (report.skipped[reason] ?? 0) + 1);

  for (const c of candidates) {
    report.considered++;
    const suppressed = c.email ? await onPlatformList(c.email, db).catch(() => true) : false;
    const base = decide(c, suppressed, orgsThisRun);
    let d = base;
    // Off: judged (and counted as abandoned) but never emailed.
    if (d.send && mode === "off") d = { send: false, reason: "off", abandoned: true };
    const abandoned = d.send || d.abandoned;

    if (preview) {
      const outcome = d.send ? (mode === "on" ? "sent" : "dry_run") : `skipped:${d.reason}`;
      report.decisions!.push({ sessionId: c.id, orgId: c.org_id, orgName: oneLine(c.org_name), plan: c.plan, createdAt: iso(c.created_at), outcome });
      if (d.send) {
        orgsThisRun.add(c.org_id);
        if (mode === "on") report.sent++;
        else report.dryRun++;
      } else skip(d.reason);
      // The sample is shown even while the mode is off: it is what switching it on would send.
      if (base.send && !report.sample) report.sample = { to: c.email!, ...renderFollowupEmail({ workspace: c.org_name ?? "", plan: c.plan, userId: c.user_id! }) };
      continue;
    }

    if (!d.send) {
      if (await claim(db, c.id, `skipped:${d.reason}`)) {
        skip(d.reason);
        if (abandoned) await trackProduct("checkout_abandoned", { orgId: c.org_id, userId: c.user_id, props: { plan: c.plan } });
      }
      continue;
    }

    if (mode === "dry_run") {
      if (await claim(db, c.id, "dry_run")) {
        orgsThisRun.add(c.org_id);
        report.dryRun++;
        await trackProduct("checkout_abandoned", { orgId: c.org_id, userId: c.user_id, props: { plan: c.plan } });
      }
      continue;
    }

    // mode on. With no mail provider there is nothing to send through: recorded, not thrown.
    if (!systemMailerConfig()) {
      if (await claim(db, c.id, "failed:no_mailer")) {
        report.failed++;
        await trackProduct("checkout_abandoned", { orgId: c.org_id, userId: c.user_id, props: { plan: c.plan } });
      }
      continue;
    }
    // The workspace's 14-day gap is re-checked under a lock on the workspace together with the
    // claim, so two runs handling two of its sessions at once still send one email.
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`checkout-followup:${c.org_id}`}))`);
      const recent = rowsOf(
        await tx.execute(sql`SELECT 1 FROM checkout_sessions WHERE org_id = ${c.org_id} AND id <> ${c.id} AND followup_status IN ('sent', 'sending') AND followup_at > now() - ${sql.raw(`interval '${FOLLOWUP_ORG_GAP_DAYS} days'`)} LIMIT 1`),
      );
      if (recent.length) return (await claim(tx as unknown as Db, c.id, "skipped:recent_followup")) ? "recent" : null;
      return (await claim(tx as unknown as Db, c.id, "sending")) ? "mine" : null;
    });
    if (claimed === null) continue;
    await trackProduct("checkout_abandoned", { orgId: c.org_id, userId: c.user_id, props: { plan: c.plan } });
    if (claimed === "recent") {
      skip("recent_followup");
      continue;
    }
    orgsThisRun.add(c.org_id);
    const mail = renderFollowupEmail({ workspace: c.org_name ?? "", plan: c.plan, userId: c.user_id! });
    let ok = false;
    try {
      const r = await sendMail(null, { from: env.mailFrom, to: c.email!, subject: mail.subject, text: mail.text, headers: mail.headers });
      ok = !!r.ok;
    } catch {
      ok = false;
    }
    await db.execute(sql`UPDATE checkout_sessions SET followup_status = ${ok ? "sent" : "failed"}, followup_at = now() WHERE id = ${c.id} AND followup_status = 'sending'`);
    if (ok) report.sent++;
    else {
      report.failed++;
      // The session only: never the address or the provider's message, which can quote it.
      console.warn(`[checkout-followup] reminder for session ${c.id} could not be sent`);
    }
  }
  return report;
}

/**
 * Job body for `checkout.followup` (hourly). The lead registers it in jobs.ts wrapped in
 * withReschedule. Counts only in the result: no addresses, no workspace names.
 */
export async function checkoutFollowupJob(): Promise<Record<string, unknown>> {
  const r = await runCheckoutFollowups();
  return { mode: r.mode, considered: r.considered, sent: r.sent, dryRun: r.dryRun, failed: r.failed, skipped: r.skipped };
}

/**
 * The sample reminder, sent to ADMIN_EMAIL and nowhere else (the admin "Send test" button).
 * Uses the first eligible session when there is one, otherwise made-up names.
 */
export async function sendFollowupTest(): Promise<{ sent: boolean; reason?: string }> {
  const to = (env.adminEmail ?? "").trim();
  if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) return { sent: false, reason: "ADMIN_EMAIL is not set" };
  if (!systemMailerConfig()) return { sent: false, reason: "no_mailer" };
  const preview = await runCheckoutFollowups({ preview: true, mode: "on", limit: 50 }).catch(() => null);
  const first = preview?.decisions?.find((d) => d.outcome === "sent");
  // The sample's unsubscribe link must not opt a real customer out when the admin clicks it,
  // so it is always signed for a placeholder id.
  const mail = renderFollowupEmail({ workspace: first?.orgName || "Acme Inc", plan: first?.plan || "growth", userId: "00000000-0000-0000-0000-000000000000" });
  const r = await sendMail(null, { from: env.mailFrom, to, subject: `[Test] ${mail.subject}`, text: mail.text, headers: mail.headers }).catch(() => ({ ok: false }));
  return r.ok ? { sent: true } : { sent: false, reason: "send_failed" };
}

/** Record a person's "no more of these". Idempotent. */
export async function recordOptOut(userId: string, kind: string): Promise<boolean> {
  const { db } = getDb();
  const r = await db.execute(sql`INSERT INTO email_opt_outs (user_id, kind) SELECT id, ${kind} FROM users WHERE id = ${userId} ON CONFLICT DO NOTHING RETURNING user_id`);
  return rowsOf(r).length > 0;
}
