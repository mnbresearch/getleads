import { and, asc, inArray, campaignContacts, campaigns, companies, emailAccounts, enqueue, eq, getDb, integrations, leads, lte, messages, organizations, sequenceSteps, suppressions, tasks, sql, type Campaign, type CampaignSettings, type EmailAccount, type Organization } from "@prospex/db";
import { allocateVariant, createAiProviderForPlan, evaluateSendingHealth, generateOutreach, leadVars, pickVariantWinner, renderTemplate, textToHtml, normalizePhone, sendWhatsApp, type ExperimentResult, type SendingHealth } from "@prospex/core";
import { decryptJson as decryptCfg } from "../lib/crypto.js";
import { consume } from "@prospex/db";
import { env } from "../env.js";
import { decryptJson, randomToken } from "../lib/crypto.js";
import { sendMail, type MailerConfig } from "../lib/mailer.js";
import { emitEvent } from "../lib/events.js";
import { tryConsume } from "../lib/quota.js";

const DEFAULT_SETTINGS: Required<CampaignSettings> = {
  dailyLimit: 50,
  timezone: "Asia/Kolkata",
  sendWindow: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  stopOnReply: true,
  trackOpens: true,
  trackClicks: true,
  unsubscribeFooter: true,
};

/** Consecutive failed sends after which a contact is stopped instead of retried again. */
export const MAX_SEND_FAILURES = 3;

export function settingsOf(c: Campaign): Required<CampaignSettings> {
  return { ...DEFAULT_SETTINGS, ...(c.settings ?? {}), sendWindow: { ...DEFAULT_SETTINGS.sendWindow, ...(c.settings?.sendWindow ?? {}) } };
}

/** Is this an IANA zone the runtime can actually format in? */
export function isValidTimezone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "9:00" and "09:00" both mean 540. Null for anything that is not a time. */
function minutesOf(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

function localParts(tz: string, now: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return { weekday: parts.weekday, hour, minute: Number(parts.minute), second: Number(parts.second) };
}

/**
 * Is `now` inside the campaign's send window (in its timezone)?
 *
 * An unknown timezone answers NO. It used to answer yes - the catch returned true - so a
 * campaign with a typo in its zone sent around the clock, weekends included, with nothing
 * to say why. Times are compared as minutes, not strings: "9:00" > "18:00" as text, which
 * made a window written without a leading zero never open at all.
 */
export function inSendWindow(s: Required<CampaignSettings>, now = new Date()) {
  if (!isValidTimezone(s.timezone)) return false;
  const p = localParts(s.timezone, now);
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  if (!s.sendWindow.days.includes(dayIdx)) return false;
  const start = minutesOf(s.sendWindow.start);
  const end = minutesOf(s.sendWindow.end);
  if (start === null || end === null) return false;
  const cur = p.hour * 60 + p.minute;
  return cur >= start && cur <= end;
}

/**
 * The calendar date in the campaign's timezone, as YYYY-MM-DD.
 *
 * The daily cap is a per-LOCAL-day promise. Keying it on the UTC date reset it at UTC
 * midnight, which for a US campaign is mid-afternoon - so one local working day could
 * send up to twice the cap.
 */
export function localDate(tz: string, now = new Date()): string {
  const zone = isValidTimezone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The next local midnight (plus a minute), when a spent daily cap opens again. */
export function nextLocalDay(tz: string, now = new Date()): Date {
  const zone = isValidTimezone(tz) ? tz : "UTC";
  const p = localParts(zone, now);
  const elapsed = (p.hour * 3600 + p.minute * 60 + p.second) * 1000;
  return new Date(now.getTime() + (86_400_000 - elapsed) + 60_000);
}

/** Enroll all leads in the campaign's list (or explicit ids). */
export async function enrollLeads(campaign: Campaign, leadIds: string[]) {
  const { db } = getDb();
  let n = 0;
  let i = 0;
  for (const leadId of leadIds) {
    const r = await db
      .insert(campaignContacts)
      .values({ campaignId: campaign.id, leadId, status: "queued", currentStep: 0, nextSendAt: new Date(), variant: i++ })
      .onConflictDoNothing()
      .returning();
    n += r.length;
  }
  return n;
}

/**
 * Enroll with the same filters the enroll route applies: a usable email, and - for a
 * campaign run for a client - only leads that client owns (unowned ones are claimed).
 *
 * Autopilots and signal subscriptions used to call enrollLeads directly, skipping both.
 * Every lead without an address was then enrolled only to fail at its first send, and a
 * lead owned by another client was emailed on behalf of the wrong one.
 */
export async function enrollEligibleLeads(campaign: Campaign, leadIds: string[]) {
  const { db } = getDb();
  const ids = [...new Set(leadIds)];
  if (!ids.length) return { enrolled: 0, skippedNoEmail: 0, skippedOtherClient: 0, claimedForClient: 0 };
  const valid = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.orgId, campaign.orgId), inArray(leads.id, ids), sql`${leads.email} IS NOT NULL`, sql`${leads.emailStatus} <> 'invalid'`));
  let toEnroll = valid.map((v) => v.id);
  let skippedOtherClient = 0;
  let claimedForClient = 0;
  if (campaign.clientId) {
    const { partitionForClientCampaign } = await import("./clients.js");
    const p = await partitionForClientCampaign(db, campaign.orgId, campaign.clientId, toEnroll);
    toEnroll = p.allowed;
    skippedOtherClient = p.ownedByAnotherClient;
    claimedForClient = p.claimed;
  }
  const enrolled = await enrollLeads(campaign, toEnroll);
  return { enrolled, skippedNoEmail: ids.length - valid.length, skippedOtherClient, claimedForClient };
}

/** Rolling window used to judge deliverability. Long enough to be stable, short enough to react. */
const HEALTH_WINDOW_DAYS = 14;

/**
 * Live deliverability verdict for one sending identity, from the last 14 days of real outcomes.
 *
 * Bounces come from the messages sent through this account's campaigns; complaints and
 * unsubscribes come from the org's suppression list over the same window. Account age is
 * used as the warm-up clock.
 */
export async function sendingHealthForAccount(
  db: ReturnType<typeof getDb>["db"],
  orgIdValue: string,
  account: EmailAccount,
): Promise<SendingHealth> {
  const [m] = await db
    .select({
      sent: sql<number>`count(*) FILTER (WHERE ${messages.sentAt} IS NOT NULL)::int`,
      bounced: sql<number>`count(*) FILTER (WHERE ${messages.bouncedAt} IS NOT NULL)::int`,
      replied: sql<number>`count(*) FILTER (WHERE ${messages.repliedAt} IS NOT NULL)::int`,
    })
    .from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(and(eq(messages.orgId, orgIdValue), eq(campaigns.emailAccountId, account.id), sql`${messages.createdAt} > now() - (${HEALTH_WINDOW_DAYS} || ' days')::interval`));
  const [s] = await db
    .select({
      complained: sql<number>`count(*) FILTER (WHERE ${suppressions.reason} IN ('complaint','spam'))::int`,
      // Every way an unsubscribe is written: the link writes 'unsubscribe_link', a reply
      // classified as one writes 'reply', the manual/API path writes 'unsubscribe'.
      // Counting only the last made the unsubscribe rate read zero for real campaigns.
      unsubscribed: sql<number>`count(*) FILTER (WHERE ${suppressions.reason} IN ('unsubscribe','unsubscribe_link','reply'))::int`,
    })
    .from(suppressions)
    .where(and(eq(suppressions.orgId, orgIdValue), sql`${suppressions.createdAt} > now() - (${HEALTH_WINDOW_DAYS} || ' days')::interval`));
  const ageDays = account.createdAt ? Math.floor((Date.now() - new Date(account.createdAt).getTime()) / 86_400_000) : null;
  return evaluateSendingHealth(
    { sent: m?.sent ?? 0, bounced: m?.bounced ?? 0, complained: s?.complained ?? 0, unsubscribed: s?.unsubscribed ?? 0, replied: m?.replied ?? 0 },
    { domainAgeDays: ageDays, configuredDailyCap: account.dailyLimit },
  );
}

/**
 * Put back contacts that nothing will ever pick up again.
 *
 * tickCampaign clears nextSendAt when it hands a contact to a message.send job, and the
 * due query requires a date. So any send that ended without rescheduling - the campaign
 * paused while sends were queued (including the automatic deliverability pause), a job
 * that exhausted its retries, a worker that died - left the contact "active" with no
 * nextSendAt: never sent, never failed, invisible. This finds those and requeues them.
 *
 * Excluded: contacts waiting on a human task (manual steps advance when the task is done),
 * and contacts with a send still in flight.
 */
export async function requeueStrandedContacts(campaignId: string) {
  const { db } = getDb();
  const rows = await db.execute(sql`
    UPDATE campaign_contacts cc SET status = 'queued', next_send_at = now(), updated_at = now()
    WHERE cc.campaign_id = ${campaignId}
      AND cc.status = 'active'
      AND cc.next_send_at IS NULL
      AND cc.updated_at < now() - interval '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.contact_id = cc.id AND t.status = 'pending')
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.type = 'message.send' AND j.status IN ('queued','running') AND j.payload->>'contactId' = cc.id::text
      )
      AND (SELECT s2.channel FROM sequence_steps s2 WHERE s2.campaign_id = cc.campaign_id ORDER BY s2.step_no OFFSET cc.current_step LIMIT 1) IN ('email','whatsapp')
    RETURNING cc.id
  `);
  const r = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return Array.isArray(r) ? r.length : 0;
}

/** message.send jobs not yet finished for any campaign sending through this account. */
async function inFlightSends(db: ReturnType<typeof getDb>["db"], accountId: string) {
  const [r] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM jobs j
    WHERE j.type = 'message.send' AND j.status IN ('queued','running')
      AND j.payload->>'campaignId' IN (SELECT id::text FROM campaigns WHERE email_account_id = ${accountId})
  `).then((x) => ((x as unknown as { rows?: { n: number }[] }).rows ?? (x as unknown as { n: number }[])));
  return Number(r?.n ?? 0);
}

/**
 * One scheduler tick for an active campaign: pick due contacts, respect daily limit + window,
 * enqueue message.send jobs. Called by the campaign.tick job every minute.
 */
export async function tickCampaign(campaignId: string) {
  const { db } = getDb();
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaign || campaign.status !== "active") return { sent: 0, reason: "not active" };
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, campaign.orgId) });
  // A suspended workspace sends nothing. Auth already blocked its users; the scheduler
  // did not, so a deactivated org's campaigns kept emailing prospects on its behalf.
  if (!org || org.status !== "active") return { sent: 0, reason: "organization not active" };
  const requeued = await requeueStrandedContacts(campaign.id).catch(() => 0);
  const s = settingsOf(campaign);
  if (!isValidTimezone(s.timezone)) {
    // Not "outside the window" forever with no explanation: stop the campaign and say why.
    await db.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
    await emitEvent(campaign.orgId, "campaign.paused_invalid_timezone", { campaignId: campaign.id, timezone: s.timezone, reason: `"${s.timezone}" is not a timezone we recognise; sending is paused until it is corrected` }, { type: "campaign", id: campaign.id });
    return { sent: 0, reason: `paused: invalid timezone "${s.timezone}"` };
  }
  if (!inSendWindow(s)) return { sent: 0, requeued, reason: "outside send window" };
  // Scoped to the campaign's own org as well as the id. The route now rejects a foreign
  // emailAccountId outright (lib/ownership.ts), and this is the second lock on the same
  // door: nothing should be able to reach another tenant's decrypted SMTP credentials,
  // send from their address, or consume their daily sending cap - including any row that
  // was written before that check existed.
  const account = campaign.emailAccountId
    ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, campaign.emailAccountId), eq(emailAccounts.orgId, campaign.orgId)) })
    : null;
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, campaign.id)).orderBy(asc(sequenceSteps.stepNo));
  if (steps.length === 0) return { sent: 0, reason: "no steps" };
  const needsEmail = steps.some((st) => st.channel === "email");
  if (needsEmail && (!account || account.status !== "active")) return { sent: 0, reason: "no active email account" };

  // Deliverability gate. A domain that is already bouncing gets worse, not better, by
  // continuing to send, so a "halt" verdict stops the campaign rather than just warning.
  let health: SendingHealth | null = null;
  if (account) {
    health = await sendingHealthForAccount(db, campaign.orgId, account);
    if (health.status === "halt") {
      await db.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
      await emitEvent(
        campaign.orgId,
        "campaign.paused_deliverability",
        { campaignId: campaign.id, emailAccountId: account.id, reasons: health.reasons, bounceRate: health.bounceRate },
        { type: "campaign", id: campaign.id },
      );
      return { sent: 0, reason: `paused: ${health.reasons[0] ?? "deliverability"}` };
    }
  }

  // The budget is an estimate that keeps the queue short; the binding cap is the atomic
  // reservation in sendStep. It still has to count sends already enqueued but not yet
  // made - by this campaign and by every other campaign sharing the sender - or each tick
  // re-spent the same remaining budget and the queue overshot the cap many times over.
  const today = localDate(s.timezone);
  const sentToday = account && account.sentTodayDate === today ? account.sentToday : 0;
  const caps = [s.dailyLimit, account?.dailyLimit ?? s.dailyLimit];
  // Warm-up ramp and any degraded-deliverability throttle both bind here.
  if (health) caps.push(health.recommendedDailyCap);
  const inFlight = account ? await inFlightSends(db, account.id) : 0;
  const budget = Math.min(...caps) - sentToday - inFlight;
  if (budget <= 0) return { sent: 0, requeued, reason: health && health.status === "warn" ? "throttled for deliverability" : inFlight > 0 && sentToday < Math.min(...caps) ? "sends already queued" : "daily limit reached" };

  const due = await db
    .select()
    .from(campaignContacts)
    .where(and(eq(campaignContacts.campaignId, campaign.id), sql`${campaignContacts.status} IN ('queued','active')`, lte(campaignContacts.nextSendAt, new Date())))
    .orderBy(asc(campaignContacts.nextSendAt))
    .limit(Math.min(budget, 25));

  let queued = 0;
  for (const cc of due) {
    const step = steps[cc.currentStep];
    if (!step) {
      await db.update(campaignContacts).set({ status: "completed", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
      continue;
    }
    await db.update(campaignContacts).set({ status: "active", nextSendAt: null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    if (step.channel === "email" || step.channel === "whatsapp") {
      await enqueue(db, "message.send", { campaignId: campaign.id, contactId: cc.id, stepId: step.id }, { orgId: campaign.orgId, priority: 5 });
    } else {
      await createStepTask(campaign, cc.id, cc.leadId, step, steps.length);
    }
    queued++;
  }
  return { sent: queued, requeued, reason: "ok" };
}

export function mailerFromAccount(a: EmailAccount): MailerConfig | null {
  if (a.provider === "system") return { provider: "system" };
  const cfg = decryptJson<Record<string, unknown>>(a.configEncrypted);
  if (a.provider === "resend") return { provider: "resend", resendApiKey: String(cfg?.apiKey ?? "") };
  if (a.provider === "smtp") return { provider: "smtp", smtp: { host: String(cfg?.host ?? ""), port: Number(cfg?.port ?? 587), user: cfg?.user ? String(cfg.user) : undefined, pass: cfg?.pass ? String(cfg.pass) : undefined, secure: !!cfg?.secure } };
  return null;
}

/**
 * Is this send error a permanent rejection of the RECIPIENT (a hard bounce)?
 *
 * SMTP 550-554 (and enhanced 5.1.x mailbox codes) mean the address will not accept mail.
 * Retrying it only adds bounces to the sender's record, and the address must never be
 * sent to again. 4xx and connection errors are transient and are NOT bounces.
 */
export function isHardBounce(error: string | null | undefined): boolean {
  if (!error) return false;
  return /\b55[0-4]\b/.test(error) || /\b5\.1\.[0-9]\b/.test(error);
}

/**
 * Record a bounce or spam complaint for an address, wherever it was learned.
 *
 * Nothing wrote `messages.bounced_at` before this, so the deliverability gate - which
 * halts a campaign on a high bounce rate - was reading a column that was always empty, and
 * a bounced address stayed eligible for every later step and every other campaign.
 */
export async function recordBounce(orgIdValue: string, input: { email: string; messageId?: string | null; kind: "bounce" | "complaint"; detail?: string }) {
  const { db } = getDb();
  const email = input.email.trim().toLowerCase();
  const msg = input.messageId ? await db.query.messages.findFirst({ where: and(eq(messages.id, input.messageId), eq(messages.orgId, orgIdValue)) }) : null;
  if (msg && input.kind === "bounce") {
    await db.update(messages).set({ status: "bounced", bouncedAt: new Date(), error: input.detail?.slice(0, 1000) ?? msg.error }).where(eq(messages.id, msg.id));
    if (msg.campaignId) await bumpStat(msg.campaignId, "bounced");
  }
  await db.insert(suppressions).values({ orgId: orgIdValue, email, reason: input.kind }).onConflictDoNothing();
  const lead = msg?.leadId
    ? await db.query.leads.findFirst({ where: eq(leads.id, msg.leadId) })
    : await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgIdValue), eq(leads.email, email)) });
  if (lead) {
    await db
      .update(campaignContacts)
      .set({ status: input.kind === "bounce" ? "bounced" : "unsubscribed", nextSendAt: null, lastError: input.kind === "bounce" ? `Bounced: ${input.detail?.slice(0, 300) ?? "permanent delivery failure"}` : "Marked our email as spam", updatedAt: new Date() })
      .where(and(eq(campaignContacts.leadId, lead.id), sql`${campaignContacts.status} IN ('queued','active')`));
    if (input.kind === "bounce" && lead.email?.toLowerCase() === email) {
      const custom = { ...(lead.custom ?? {}) } as Record<string, unknown>;
      const priorBad = Array.isArray(custom.invalidEmails) ? (custom.invalidEmails as string[]) : [];
      custom.invalidEmails = [...new Set([...priorBad, email])];
      await db.update(leads).set({ emailStatus: "invalid", emailConfidence: 0.99, emailVerifiedBy: "bounce", verifiedAt: new Date(), custom, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    }
  }
  await emitEvent(orgIdValue, input.kind === "bounce" ? "message.bounced" : "message.complained", { messageId: msg?.id ?? null, leadId: lead?.id ?? null, email, detail: input.detail ?? null }, msg ? { type: "message", id: msg.id } : undefined);
  return { messageId: msg?.id ?? null, leadId: lead?.id ?? null };
}

/**
 * A send that did not go out. Exactly one retry mechanism: the contact is requeued with a
 * backoff, and stopped (status failed, reason kept) after MAX_SEND_FAILURES in a row.
 *
 * Previously a failed send did both - requeued the contact AND threw so the job retried -
 * and the requeue had no limit, so a permanently broken address was retried every half
 * hour forever, billed each cycle.
 */
async function recordSendFailure(contactId: string, error: string) {
  const { db } = getDb();
  const rows = await db.execute<{ send_failures: number; status: string }>(sql`
    UPDATE campaign_contacts SET
      send_failures = send_failures + 1,
      last_error = ${error.slice(0, 1000)},
      status = CASE WHEN send_failures + 1 >= ${MAX_SEND_FAILURES} THEN 'failed' ELSE 'queued' END,
      next_send_at = CASE WHEN send_failures + 1 >= ${MAX_SEND_FAILURES} THEN NULL ELSE now() + ((30 * (send_failures + 1)) || ' minutes')::interval END,
      updated_at = now()
    WHERE id = ${contactId}
    RETURNING send_failures, status
  `);
  const r = ((rows as unknown as { rows?: { send_failures: number; status: string }[] }).rows ?? (rows as unknown as { send_failures: number; status: string }[]))[0];
  return { failures: Number(r?.send_failures ?? 0), stopped: r?.status === "failed" };
}

/** Put a contact back in the queue for later, with a reason when there is one to give. */
async function requeueContact(contactId: string, at: Date, lastError?: string | null) {
  const { db } = getDb();
  await db
    .update(campaignContacts)
    .set({ status: "queued", nextSendAt: at, ...(lastError !== undefined ? { lastError } : {}), updatedAt: new Date() })
    .where(eq(campaignContacts.id, contactId));
}

async function stopContact(contactId: string, status: "failed" | "unsubscribed" | "reassigned", lastError: string) {
  const { db } = getDb();
  await db.update(campaignContacts).set({ status, nextSendAt: null, lastError, updatedAt: new Date() }).where(eq(campaignContacts.id, contactId));
}

/**
 * Take one slot of the sender's daily cap, atomically.
 *
 * The cap used to be checked in tickCampaign and incremented after the send with a
 * read-modify-write of the value read at the START of sendStep. Concurrent sends each
 * wrote "what I read + 1" and lost each other's increments (a cap of 3 sent 9), and
 * campaigns sharing a sender each spent the whole budget. One conditional UPDATE is both
 * the check and the increment, so concurrent senders serialize on the row.
 */
export async function reserveDailySlot(accountId: string, today: string, cap: number): Promise<boolean> {
  const { db } = getDb();
  const rows = await db.execute(sql`
    UPDATE email_accounts SET
      sent_today = CASE WHEN sent_today_date = ${today} THEN sent_today + 1 ELSE 1 END,
      sent_today_date = ${today}
    WHERE id = ${accountId}
      AND ${cap} > 0
      AND (sent_today_date IS DISTINCT FROM ${today} OR sent_today < ${cap})
    RETURNING id
  `);
  const r = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return Array.isArray(r) && r.length > 0;
}

/** Give back a slot taken by reserveDailySlot for a send that did not go out. */
async function releaseDailySlot(accountId: string, today: string) {
  const { db } = getDb();
  await db.execute(sql`UPDATE email_accounts SET sent_today = GREATEST(0, sent_today - 1) WHERE id = ${accountId} AND sent_today_date = ${today}`);
}

/** Workspace-level sender defaults (Settings - Defaults for AI-drafted emails). */
function orgSenderDefaults(org: Organization | null | undefined) {
  const o = (org?.settings ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return { senderName: str(o.senderName), senderCompany: str(o.senderCompany), valueProp: str(o.valueProp), senderTitle: str(o.senderTitle), tone: str(o.tone) };
}

/**
 * Send one step of a sequence to one contact.
 *
 * Every way this can end leaves the contact somewhere a later tick can see it: sent and
 * advanced, requeued with a time, or stopped with `lastError` saying why. A bare return
 * after tickCampaign has cleared nextSendAt strands the contact "active" forever.
 *
 * Billing: the emails quota is charged for a send that goes out, and refunded when it does
 * not. A plan limit is terminal for this attempt (the contact waits until tomorrow) rather
 * than a thrown error the job retries - the retry used to skip the charge and send free.
 * `attempt` is kept for the idempotency guard's callers; the guard itself now always runs.
 */
export async function sendStep(campaignId: string, contactId: string, stepId: string, opts: { attempt?: number } = {}) {
  void opts;
  const { db } = getDb();
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  const cc = await db.query.campaignContacts.findFirst({ where: eq(campaignContacts.id, contactId) });
  const step = await db.query.sequenceSteps.findFirst({ where: eq(sequenceSteps.id, stepId) });
  if (!campaign || !cc || !step) return { skipped: "missing" };
  // Only a contact still in the sequence. "reassigned" (moved to another client),
  // "completed" and "failed" used to fall through and be sent to.
  if (cc.status !== "active" && cc.status !== "queued") return { skipped: cc.status };
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, campaign.orgId) });
  if (campaign.status !== "active" || !org || org.status !== "active") {
    // Back in the queue rather than dropped: tickCampaign cleared nextSendAt to hand this
    // contact to us, so returning without a date stranded it for good, even after resume.
    await requeueContact(cc.id, new Date());
    return { skipped: campaign.status !== "active" ? "campaign not active" : "organization not active" };
  }
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, cc.leadId) });
  if (!lead) {
    await stopContact(cc.id, "failed", "The lead was deleted");
    return { skipped: "lead missing" };
  }
  // A client campaign speaks for that client only. A lead moved to another client (or back
  // to the pool) since enrolment must not be emailed on the old client's behalf.
  if (campaign.clientId && lead.clientId !== campaign.clientId) {
    await stopContact(cc.id, "reassigned", "This lead no longer belongs to the campaign's client");
    return { skipped: "lead belongs to another client" };
  }
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const defaults = orgSenderDefaults(org);

  if (step.channel === "whatsapp") {
    const phone = lead.whatsapp ?? lead.phone;
    if (!phone) {
      await createStepTask(campaign, cc.id, lead.id, step, 0); // no number → hand to a human
      return { skipped: "no phone, task created" };
    }
    const os = campaign.settings as Record<string, unknown>;
    const vars = leadVars({ ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, { name: String(os.senderName ?? defaults.senderName ?? ""), company: String(os.senderCompany ?? defaults.senderCompany ?? "") });
    const text = renderTemplate(pickVariant(step, cc.variant).bodyTemplate, vars);
    // Same idempotency question as the email path: a retry must not send a second message.
    // WhatsApp writes its row before the send, so a prior row for this exact step is proof
    // it may already have gone out. Checked on every attempt, not just retries: a contact
    // requeued after a crashed job comes back as a FIRST attempt of a new job.
    const priorWa = await db.query.messages.findFirst({
      where: and(eq(messages.campaignId, campaign.id), eq(messages.stepId, step.id), eq(messages.leadId, lead.id), inArray(messages.status, ["sent", "sending"])),
    });
    if (priorWa) {
      const advanced = cc.currentStep > step.stepNo - 1;
      if (priorWa.status === "sending") {
        // Same reasoning as the email path: we cannot tell whether it went out, so
        // neither resend nor skip the step - stop and let a person settle it.
        await db.update(messages).set({ status: "unknown", error: "a previous attempt reached WhatsApp and the outcome was never recorded; not sent again, and this contact's sequence was stopped for review" }).where(eq(messages.id, priorWa.id));
        if (!advanced) await stopContact(cc.id, "failed", "A previous WhatsApp send's outcome was never recorded; stopped for review");
        return { skipped: "earlier attempt's outcome unknown; sequence stopped for review", messageId: priorWa.id, channel: "whatsapp" };
      }
      if (!advanced) await advanceContact(cc.id);
      else await bumpStat(campaign.id, "sent");
      return { skipped: "already sent on an earlier attempt", messageId: priorWa.id, channel: "whatsapp" };
    }
    // Everything that can fail WITHOUT touching the provider - loading the integration,
    // decrypting its config - happens first, so an ordinary configuration error stays an
    // ordinary failure instead of stranding the contact for human review.
    const wa = await whatsappSender(campaign.orgId);
    if (!wa.ok) {
      // Not a silent skip: hand it to a person, the same way a missing phone number does.
      await createStepTask(campaign, cc.id, lead.id, step, 0);
      return { skipped: `${wa.error} - handed to a person as a task` };
    }

    const [wm] = await db
      .insert(messages)
      .values({ orgId: campaign.orgId, campaignId: campaign.id, stepId: step.id, leadId: lead.id, channel: "whatsapp", toEmail: phone, subject: "(whatsapp)", bodyText: text, status: "sending" })
      .returning();
    const r = await wa.send(phone, text);
    await db
      .update(messages)
      .set({ status: r.ok ? "sent" : "failed", providerMessageId: r.messageId, error: r.error, sentAt: r.ok ? new Date() : null })
      .where(eq(messages.id, wm.id));
    if (!r.ok) {
      // Requeued with a backoff, stopped after MAX_SEND_FAILURES - not thrown. A throw
      // retried the job three times and then left the contact active with no next send.
      await bumpStat(campaign.id, "failed");
      const f = await recordSendFailure(cc.id, `WhatsApp: ${r.error ?? "send failed"}`);
      return { failed: true, error: r.error, channel: "whatsapp", failures: f.failures, stopped: f.stopped };
    }
    await db.update(campaignContacts).set({ lastMessageId: wm.id, sendFailures: 0, lastError: null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    await advanceContact(cc.id);
    await emitEvent(campaign.orgId, "message.sent", { messageId: wm.id, leadId: lead.id, campaignId: campaign.id, channel: "whatsapp" }, { type: "message", id: wm.id });
    return { sent: true, messageId: wm.id, channel: "whatsapp" };
  }

  if (!lead.email) {
    await stopContact(cc.id, "failed", "This lead has no email address");
    return { skipped: "no email" };
  }
  if (lead.emailStatus === "invalid") {
    await stopContact(cc.id, "failed", "This lead's email address is known to be invalid");
    return { skipped: "invalid email" };
  }
  const sup = await db.query.suppressions.findFirst({ where: and(eq(suppressions.orgId, campaign.orgId), eq(suppressions.email, lead.email)) });
  if (sup) {
    await stopContact(cc.id, "unsubscribed", `Address is on the suppression list (${sup.reason})`);
    return { skipped: "suppressed" };
  }
  // Scoped to the campaign's own org as well as the id. THIS is the lookup that matters:
  // it is the one whose result is handed to mailerFromAccount, which decrypts the SMTP
  // credentials, sends from that address and increments that account's daily cap.
  const account = campaign.emailAccountId
    ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, campaign.emailAccountId), eq(emailAccounts.orgId, campaign.orgId)) })
    : null;
  if (!account) {
    // tickCampaign cleared nextSendAt before enqueueing, so a bare return leaves this
    // contact "active" and permanently unreachable. Stopping it is visible; stalling is not.
    await stopContact(cc.id, "failed", "No sending account configured for this campaign");
    return { skipped: "no sending account configured for this campaign" };
  }

  /**
   * Has this exact step already gone out to this lead?
   *
   * A row that says `sent` is proof of delivery, so we advance without resending. A row
   * left `sending` means a previous attempt reached the provider and we never learned the
   * outcome; we do not gamble a second copy on it, we record the uncertainty and move on.
   *
   * Checked on EVERY attempt. It used to run only when the job's attempt number was above
   * one, but a contact requeued after its job died comes back through a brand-new job whose
   * first attempt skipped the check - and could send the same step twice.
   */
  const prior = await db.query.messages.findFirst({
    where: and(eq(messages.campaignId, campaign.id), eq(messages.stepId, step.id), eq(messages.leadId, lead.id), inArray(messages.status, ["sent", "sending"])),
  });
  if (prior) {
    // Has the contact already moved past this step? The success path advances it, so a
    // failure AFTER that point leaves a `sent` row and an already-advanced contact.
    const alreadyAdvanced = cc.currentStep > step.stepNo - 1;
    if (prior.status === "sent") {
      if (!alreadyAdvanced) await advanceContact(cc.id);
      // advanceContact bumps the "sent" stat as a side effect, so a retry that finds the
      // contact ALREADY advanced must bump it here or the counter stays one short.
      else await bumpStat(campaign.id, "sent");
      return { skipped: "already sent on an earlier attempt", messageId: prior.id };
    }
    // Left at `sending`: we genuinely do not know whether it went out. Stop and leave it
    // visible; resumeContact is the way back once a person has checked.
    await db.update(messages).set({ status: "unknown", error: "a previous attempt reached the provider and the outcome was never recorded; not sent again, and this contact's sequence was stopped for review" }).where(eq(messages.id, prior.id));
    if (!alreadyAdvanced) await stopContact(cc.id, "failed", "A previous send's outcome was never recorded; stopped for review");
    return { skipped: "earlier attempt's outcome unknown; sequence stopped for review rather than risking a duplicate or a skipped step", messageId: prior.id };
  }

  const s = settingsOf(campaign);
  if (!isValidTimezone(s.timezone)) {
    await requeueContact(cc.id, new Date(Date.now() + 3600_000), `Campaign timezone "${s.timezone}" is not recognised`);
    return { skipped: "invalid timezone" };
  }

  // Quota first: a plan limit is the end of this attempt, not an error to retry. The
  // contact waits for tomorrow with the reason on it.
  const quota = await tryConsume(db, campaign.orgId, "emails", 1);
  if (!quota.ok && quota.reason === "quota") {
    await requeueContact(cc.id, nextLocalDay(s.timezone), "Monthly email limit reached");
    return { skipped: "quota", detail: quota.message };
  }
  if (!quota.ok) throw new Error(`could not record email usage: ${quota.message}`);
  const refundQuota = () => consume(db, campaign.orgId, "emails", -1, { allowOverage: true }).catch(() => {});

  // Then the daily cap, reserved atomically. No slot: back in the queue for the next local
  // day, uncharged.
  const health = await sendingHealthForAccount(db, campaign.orgId, account);
  const cap = Math.min(s.dailyLimit, account.dailyLimit, health.recommendedDailyCap);
  const today = localDate(s.timezone);
  if (!(await reserveDailySlot(account.id, today, cap))) {
    await refundQuota();
    await requeueContact(cc.id, nextLocalDay(s.timezone));
    return { skipped: "daily limit reached" };
  }

  // Set once the reservation is settled either way - sent, or refunded - so the catch
  // below never refunds twice or refunds a send that went out.
  let settled = false;
  try {
    const cs = campaign.settings as Record<string, unknown> | undefined;
    // Campaign settings first, then the workspace defaults the settings page saves for
    // exactly this purpose (they were stored and never read), then the account.
    const sender = {
      name: account.fromName || String(cs?.senderName ?? defaults.senderName ?? ""),
      company: String(cs?.senderCompany ?? defaults.senderCompany ?? ""),
      title: cs?.senderTitle ? String(cs.senderTitle) : defaults.senderTitle,
      valueProp: String(cs?.valueProp ?? defaults.valueProp ?? step.aiInstructions ?? ""),
      signature: account.signature ?? undefined,
      tone: ((cs?.tone ?? defaults.tone) as "friendly" | undefined) ?? "friendly",
    };
    const prevMsg = cc.lastMessageId ? await db.query.messages.findFirst({ where: eq(messages.id, cc.lastMessageId) }) : null;
    const leadForTpl = { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null };

    // Once an A/B test has a statistically clear winner, most new sends go to it instead of
    // continuing an even round-robin against a variant already known to lose.
    const experiment = await experimentForStep(db, step);
    const variantIdx = experiment?.confident ? allocateVariant(experiment.allocation, cc.variant) : cc.variant;
    const variant = pickVariant(step, variantIdx);
    const vars = leadVars(leadForTpl, { name: sender.name, company: sender.company, signature: sender.signature });
    let subject = renderTemplate(variant.subjectTemplate, vars);
    let body = renderTemplate(variant.bodyTemplate, vars);
    let aiNote: string | null = null;
    if (step.aiPersonalize) {
      // The plan decides the engine: free workspaces never reach the paid model.
      // An AI outage falls back to the template instead of throwing - a throw used to burn
      // the job's retries and leave the contact stranded with no next send.
      const out = await generateOutreach(createAiProviderForPlan(org.plan), {
        lead: leadForTpl,
        sender,
        subjectTemplate: variant.subjectTemplate,
        bodyTemplate: variant.bodyTemplate,
        instructions: step.aiInstructions ?? undefined,
        stepNo: step.stepNo,
        previousSubject: prevMsg?.subject,
      }).catch((e) => {
        aiNote = `AI personalization failed, sent the template instead: ${(e as Error).message}`.slice(0, 500);
        return null;
      });
      if (out) {
        subject = out.subject;
        body = out.body;
        // Charged for a model call that was made, recorded even past the limit: the
        // call has happened, and silently not recording it is how overage went missing.
        if (out.personalized) await consume(db, campaign.orgId, "aiMessages", 1, { allowOverage: true }).catch(() => {});
      }
    }
    if (step.stepNo > 1 && prevMsg && !/^re:/i.test(subject)) subject = `Re: ${prevMsg.subject.replace(/^re:\s*/i, "")}`;

    const token = randomToken(16);
    let html = textToHtml(body);
    if (s.trackClicks) html = html.replace(/href="(https?:\/\/[^"]+)"/g, (_, u) => `href="${env.apiUrl}/t/c/${token}?u=${encodeURIComponent(u)}"`);
    if (s.trackOpens) html += `<img src="${env.apiUrl}/t/o/${token}.gif" width="1" height="1" alt="" style="display:none">`;
    let text = body;
    const unsub = `${env.apiUrl}/t/u/${token}`;
    if (s.unsubscribeFooter) {
      text += `\n\n--\nIf you'd rather not hear from me, reply "unsubscribe" or click: ${unsub}`;
      html += `<p style="color:#888;font-size:12px;margin-top:2em">If you'd rather not hear from me, <a href="${unsub}" style="color:#888">unsubscribe here</a>.</p>`;
    }
    // RFC 8058 one-click unsubscribe. Gmail and Yahoo require it for bulk senders, and a
    // List-Unsubscribe without the -Post header is not one-click to them. The mailto goes
    // to the reply address, where an "unsubscribe" reply is already acted on.
    const mailto = account.replyTo ?? account.fromEmail;
    const listUnsubscribe = mailto ? `<${unsub}>, <mailto:${mailto}?subject=unsubscribe>` : `<${unsub}>`;

    const [msg] = await db
      .insert(messages)
      .values({ orgId: campaign.orgId, campaignId: campaign.id, stepId: step.id, leadId: lead.id, toEmail: lead.email, subject, bodyText: text, bodyHtml: html, trackingToken: token, status: "queued", variant: variant.index })
      .returning();

    // Marked before the provider call, so a crash in between leaves evidence that this step
    // may already have gone out. See the idempotency check above.
    await db.update(messages).set({ status: "sending" }).where(eq(messages.id, msg.id));

    const res = await sendMail(mailerFromAccount(account), {
      from: `${account.fromName} <${account.fromEmail}>`,
      to: lead.email,
      subject,
      text,
      html,
      replyTo: account.replyTo ?? account.fromEmail,
      headers: { "X-Prospex-Message": msg.id, "List-Unsubscribe": listUnsubscribe, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });

    if (res.ok) {
      settled = true;
      await db.update(messages).set({ status: "sent", sentAt: new Date(), providerMessageId: res.providerMessageId }).where(eq(messages.id, msg.id));
      const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, campaign.id)).orderBy(asc(sequenceSteps.stepNo));
      const next = steps[cc.currentStep + 1];
      await db
        .update(campaignContacts)
        .set({
          currentStep: cc.currentStep + 1,
          lastMessageId: msg.id,
          status: next ? "active" : "completed",
          nextSendAt: next ? new Date(Date.now() + next.delayDays * 86_400_000) : null,
          sendFailures: 0,
          lastError: aiNote,
          updatedAt: new Date(),
        })
        .where(eq(campaignContacts.id, cc.id));
      await bumpStat(campaign.id, "sent");
      await db.execute(sql`UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ${lead.id}`);
      await emitEvent(campaign.orgId, "message.sent", { messageId: msg.id, leadId: lead.id, campaignId: campaign.id, to: lead.email, subject, variant: variant.index }, { type: "message", id: msg.id });
      return { sent: true, messageId: msg.id };
    }

    // Not sent: give back the slot and the charge.
    await db.update(messages).set({ status: "failed", error: res.error }).where(eq(messages.id, msg.id));
    await releaseDailySlot(account.id, today);
    await refundQuota();
    settled = true;
    await bumpStat(campaign.id, "failed");
    if (isHardBounce(res.error)) {
      // The receiving server refused the address permanently. Never again, anywhere.
      await recordBounce(campaign.orgId, { email: lead.email, messageId: msg.id, kind: "bounce", detail: res.error });
      return { failed: true, bounced: true, error: res.error };
    }
    const f = await recordSendFailure(cc.id, `Send failed: ${res.error ?? "unknown error"}`);
    return { failed: true, error: res.error, failures: f.failures, stopped: f.stopped };
  } catch (e) {
    // Something threw before the provider was reached (or while recording a failure):
    // return what was reserved and let the job retry. After a successful send nothing is
    // refunded - it went out.
    if (!settled) {
      await releaseDailySlot(account.id, today).catch(() => {});
      await refundQuota();
    }
    throw e;
  }
}

export async function bumpStat(campaignId: string, key: string, n = 1) {
  const { db } = getDb();
  await db.execute(sql`UPDATE campaigns SET stats = jsonb_set(coalesce(stats,'{}'::jsonb), ${`{${key}}`}::text[], (coalesce((stats->>${key})::int,0) + ${n})::text::jsonb), updated_at = now() WHERE id = ${campaignId}`);
}

/**
 * Is this inbound message an automatic out-of-office / vacation reply?
 *
 * An auto-reply is not a reply. Treating it as one stopped the sequence and counted it as
 * engagement, so every prospect on holiday was dropped from outreach - and counted as a
 * positive response in the A/B stats.
 */
export function isOutOfOffice(input: { intent?: string | null; subject?: string | null; text?: string | null; headers?: Record<string, string | undefined> | null }): boolean {
  if (input.intent === "out_of_office") return true;
  const h = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]));
  if (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"] || /auto_reply|autoreply/i.test(h["x-auto-response-suppress"] ?? "")) return true;
  // Wording alone is weaker evidence than a header: a real reply can mention being away
  // ("out of office next week, but yes, interested"). When the classifier heard a real
  // answer, trust it over the phrase.
  if (input.intent && ["interested", "not_interested", "referral", "question"].includes(input.intent)) return false;
  const hay = `${input.subject ?? ""}\n${(input.text ?? "").slice(0, 2000)}`.toLowerCase();
  return /out of (the )?office|automatic reply|auto-?reply|autoreply|away from (the |my )?(office|desk|email)|\bon leave\b|on (annual |parental |maternity |paternity )?leave|on vacation|on holiday|vacation (reply|responder)/.test(hay);
}

/** How long an out-of-office reply pushes the next step back. */
const OOO_DELAY_MS = 3 * 86_400_000;

export async function markReplied(orgId: string, leadEmail: string, intent: string, inbound: { subject?: string | null; text?: string | null; headers?: Record<string, string | undefined> | null } = {}) {
  const { db } = getDb();
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, leadEmail)) });
  if (!lead) return false;
  const ccs = await db.select().from(campaignContacts).where(and(eq(campaignContacts.leadId, lead.id), sql`${campaignContacts.status} IN ('queued','active')`));

  if (intent !== "unsubscribe" && isOutOfOffice({ intent, ...inbound })) {
    // Not a reply: the sequence carries on, a few days later, when they are back. A
    // contact with a send in flight (active, no date) is left to that send.
    const later = new Date(Date.now() + OOO_DELAY_MS);
    for (const cc of ccs) {
      if (!cc.nextSendAt) continue;
      if (cc.nextSendAt.getTime() < later.getTime()) await db.update(campaignContacts).set({ nextSendAt: later, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    }
    await emitEvent(orgId, "lead.out_of_office", { leadId: lead.id, email: leadEmail, resumesAt: later.toISOString() }, { type: "lead", id: lead.id });
    return true;
  }

  const campaignRows = ccs.length ? await db.select({ id: campaigns.id, settings: campaigns.settings }).from(campaigns).where(inArray(campaigns.id, [...new Set(ccs.map((c) => c.campaignId))])) : [];
  const stopsOnReply = new Map(campaignRows.map((c) => [c.id, (c.settings as CampaignSettings | null)?.stopOnReply !== false]));
  for (const cc of ccs) {
    // `stopOnReply: false` was accepted by the API and never read: every reply stopped
    // every sequence. An unsubscribe always stops, whatever the setting.
    const stop = intent === "unsubscribe" || (stopsOnReply.get(cc.campaignId) ?? true);
    if (stop) await db.update(campaignContacts).set({ status: intent === "unsubscribe" ? "unsubscribed" : "replied", nextSendAt: null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    await bumpStat(cc.campaignId, "replied");
    if (cc.lastMessageId) await db.update(messages).set({ status: "replied", repliedAt: new Date() }).where(eq(messages.id, cc.lastMessageId));
  }
  if (intent === "unsubscribe") await db.insert(suppressions).values({ orgId, email: leadEmail, reason: "reply" }).onConflictDoNothing();
  await db.update(leads).set({ tags: sql`array_append(array_remove(${leads.tags}, ${"replied:" + intent}), ${"replied:" + intent})`, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await bumpEngagement(lead.id, "reply");
  await emitEvent(orgId, "lead.replied", { leadId: lead.id, email: leadEmail, intent }, { type: "lead", id: lead.id });
  return true;
}


/** Manual channels (LinkedIn connect/message, call, custom task) become tasks for a human; the sequence advances when the task is completed. */
export async function createStepTask(campaign: Campaign, contactId: string, leadId: string, step: { id: string; stepNo: number; channel: string; subjectTemplate: string; bodyTemplate: string; aiPersonalize: boolean; aiInstructions: string | null }, totalSteps: number) {
  const { db } = getDb();
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  const company = lead?.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, campaign.orgId) });
  const d = orgSenderDefaults(org);
  const os = campaign.settings as Record<string, unknown>;
  const senderName = String(os.senderName ?? d.senderName ?? "");
  const senderCompany = String(os.senderCompany ?? d.senderCompany ?? "");
  const vars = leadVars({ ...(lead ?? {}), company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, { name: senderName, company: senderCompany });
  let body = renderTemplate(step.bodyTemplate, vars);
  if (step.aiPersonalize && lead) {
    const out = await generateOutreach(createAiProviderForPlan(org?.plan ?? "free"), { lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, sender: { name: senderName, company: senderCompany, valueProp: String(os.valueProp ?? d.valueProp ?? ""), tone: (os.tone ?? d.tone) as "friendly" | undefined }, bodyTemplate: step.bodyTemplate, instructions: `${step.channel === "linkedin_connect" ? "This is a LinkedIn connection note: max 280 characters, no subject." : step.channel === "linkedin_message" ? "This is a LinkedIn DM: short, casual, no subject line." : step.channel === "call" ? "Write a 60-second call opener script." : ""} ${step.aiInstructions ?? ""}`, stepNo: step.stepNo }).catch(() => null);
    if (out?.body) body = out.body;
  }
  const titles: Record<string, string> = { linkedin_connect: "Send LinkedIn connection request", linkedin_message: "Send LinkedIn message", call: "Call", whatsapp: "Send WhatsApp message", task: renderTemplate(step.subjectTemplate, vars) || "Task" };
  const [t] = await db.insert(tasks).values({ orgId: campaign.orgId, leadId, campaignId: campaign.id, contactId, stepId: step.id, type: step.channel, title: `${titles[step.channel] ?? "Task"}: ${lead?.fullName ?? ""}`, body, dueAt: new Date() }).returning();
  await emitEvent(campaign.orgId, "task.created", { taskId: t.id, type: step.channel, leadId, campaignId: campaign.id }, { type: "task", id: t.id });
  void totalSteps;
  return t;
}

/** Advance a contact after a manual/task step is completed. */
/**
 * Put a stopped contact back into its sequence.
 *
 * A contact is set to "failed" when a send's outcome could not be established, because
 * neither resending nor advancing is safe without knowing. That is the right call in the
 * moment and the wrong place to leave someone permanently, so a human who has checked the
 * mailbox can say which way it went: `resend: false` means it arrived, move on; `true`
 * means it did not, try that step again.
 */
export async function resumeContact(contactId: string, opts: { resend?: boolean } = {}) {
  const { db } = getDb();
  const cc = await db.query.campaignContacts.findFirst({ where: eq(campaignContacts.id, contactId) });
  if (!cc) return { ok: false as const, error: "No such contact" };
  if (cc.status !== "failed") return { ok: false as const, error: `This contact is "${cc.status}", not stopped` };

  // The step the contact is stuck on. currentStep indexes the step being attempted, and
  // stepNo is 1-based, so this is the row whose outcome is in question.
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cc.campaignId)).orderBy(asc(sequenceSteps.stepNo));
  const stepId = steps[cc.currentStep]?.id ?? null;
  if (!stepId) return { ok: false as const, error: "This contact has no step left to resume" };

  if (opts.resend) {
    // Clear the uncertain row for THIS step so the guard does not immediately stop it
    // again. Scoped by stepId: a contact can accumulate an unknown row per step, and
    // matching on campaign+lead alone would stamp "this never arrived" onto an earlier
    // step that the same person may already have confirmed did.
    await db
      .update(messages)
      .set({ status: "failed", error: "superseded: a person confirmed this never arrived and asked for it to be sent again" })
      .where(and(eq(messages.campaignId, cc.campaignId), eq(messages.leadId, cc.leadId), eq(messages.stepId, stepId), eq(messages.status, "unknown")));
    await db.update(campaignContacts).set({ status: "active", nextSendAt: new Date(), updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    return { ok: true as const, resumed: "will retry this step" };
  }

  // Resolve the row too. The person has just testified that it arrived, so leaving it at
  // "unknown" would keep a delivered message filed as uncertain forever - and any later
  // count of what was sent would disagree with the contact's own progress.
  await db
    .update(messages)
    .set({ status: "sent", sentAt: new Date(), error: "outcome was never recorded by the sender; a person confirmed it arrived" })
    .where(and(eq(messages.campaignId, cc.campaignId), eq(messages.leadId, cc.leadId), eq(messages.stepId, stepId), eq(messages.status, "unknown")));
  await db.update(campaignContacts).set({ status: "active", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
  await advanceContact(cc.id);
  return { ok: true as const, resumed: "moved on to the next step" };
}

export async function advanceContact(contactId: string) {
  const { db } = getDb();
  const cc = await db.query.campaignContacts.findFirst({ where: eq(campaignContacts.id, contactId) });
  if (!cc) return;
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cc.campaignId)).orderBy(asc(sequenceSteps.stepNo));
  const next = steps[cc.currentStep + 1];
  await db.update(campaignContacts).set({ currentStep: cc.currentStep + 1, status: next ? "active" : "completed", nextSendAt: next ? new Date(Date.now() + next.delayDays * 86_400_000) : null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
  await bumpStat(cc.campaignId, "sent");
  if (next && next.delayDays === 0) await tickCampaign(cc.campaignId).catch(() => {}); // fire the next step promptly
}

/**
 * Live A/B results for one sequence step, from real sends and replies.
 *
 * Returns null when the step has no variants, so callers fall back to the contact's
 * round-robin index unchanged.
 */
export async function experimentForStep(
  db: ReturnType<typeof getDb>["db"],
  step: { id: string; variants: { subjectTemplate: string; bodyTemplate: string }[] },
): Promise<ExperimentResult | null> {
  const variantCount = 1 + (step.variants?.length ?? 0);
  if (variantCount < 2) return null;
  const rows = await db
    .select({
      variant: messages.variant,
      sent: sql<number>`count(*) FILTER (WHERE ${messages.sentAt} IS NOT NULL)::int`,
      positives: sql<number>`count(*) FILTER (WHERE ${messages.repliedAt} IS NOT NULL)::int`,
    })
    .from(messages)
    .where(and(eq(messages.stepId, step.id), eq(messages.direction, "outbound")))
    .groupBy(messages.variant);
  const byVariant = new Map(rows.map((r) => [r.variant, r]));
  const stats = Array.from({ length: variantCount }, (_, i) => ({
    variant: i,
    sent: byVariant.get(i)?.sent ?? 0,
    positives: byVariant.get(i)?.positives ?? 0,
  }));
  return pickVariantWinner(stats);
}

/** Pick an A/B variant for a step (round-robin by contact variant index). */
export function pickVariant(step: { subjectTemplate: string; bodyTemplate: string; variants: { subjectTemplate: string; bodyTemplate: string }[] }, variantIdx: number) {
  const all = [{ subjectTemplate: step.subjectTemplate, bodyTemplate: step.bodyTemplate }, ...(step.variants ?? [])];
  const i = all.length ? variantIdx % all.length : 0;
  return { ...all[i], index: i };
}

/** Engagement scoring: opens +5, clicks +15, replies +40 (capped 100), and lead status progression. */
export async function bumpEngagement(leadId: string | null | undefined, kind: "open" | "click" | "reply") {
  if (!leadId) return;
  const { db } = getDb();
  const delta = kind === "open" ? 5 : kind === "click" ? 15 : 40;
  const status = kind === "reply" ? "replied" : "engaged";
  await db.execute(sql`UPDATE leads SET engagement_score = LEAST(100, engagement_score + ${delta}), last_engaged_at = now(), status = CASE WHEN status IN ('new','contacted','engaged') THEN ${status} ELSE status END, updated_at = now() WHERE id = ${leadId}`);
}

/** WhatsApp send via the org's configured Cloud API integration. */
/**
 * Resolve the WhatsApp sender, separately from actually sending.
 *
 * Split in two so a caller can get everything that might fail WITHOUT reaching the
 * provider - loading the integration, decrypting its config - out of the way before it
 * commits to a send. Inside a send's uncertain window, an ordinary configuration error
 * would otherwise be indistinguishable from "we may have delivered this", and would strand
 * the contact for human review over a rotated encryption key.
 */
export async function whatsappSender(
  orgId: string,
): Promise<{ ok: true; send: (to: string, text: string) => Promise<{ ok: boolean; messageId?: string; error?: string }> } | { ok: false; error: string }> {
  const { db } = getDb();
  const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.orgId, orgId), eq(integrations.provider, "whatsapp"), eq(integrations.status, "active")) });
  if (!integ) return { ok: false, error: "WhatsApp integration not configured (Settings → Integrations → WhatsApp Cloud API)" };
  let cfg: { phoneNumberId: string; accessToken: string; templateName?: string; templateLanguage?: string } | null = null;
  try {
    cfg = decryptCfg<{ phoneNumberId: string; accessToken: string; templateName?: string; templateLanguage?: string }>(integ.configEncrypted);
  } catch (e) {
    return { ok: false, error: `WhatsApp config could not be read: ${(e as Error).message}` };
  }
  if (!cfg?.phoneNumberId || !cfg.accessToken) return { ok: false, error: "WhatsApp config incomplete" };
  const config = cfg;
  const country = String((integ.settings as Record<string, unknown>).defaultCountryCode ?? "91");
  return {
    ok: true,
    send: async (to: string, text: string) => {
      const phone = normalizePhone(to, country);
      // Outbound-first messages must use an approved template; text is the first body parameter.
      return config.templateName
        ? sendWhatsApp(config, phone, { template: { name: config.templateName, language: config.templateLanguage, params: [text] } })
        : sendWhatsApp(config, phone, { text });
    },
  };
}

/** Back-compatible one-shot, for callers that do not need the split. */
export async function sendWhatsAppStep(orgId: string, to: string, text: string) {
  const s = await whatsappSender(orgId);
  if (!s.ok) return { ok: false, error: s.error };
  return s.send(to, text);
}
