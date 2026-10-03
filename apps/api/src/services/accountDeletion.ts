import Stripe from "stripe";
import { and, campaigns, desc, eq, getDb, inArray, lte, organizations, sql, users, workspaceDeletionRequests, type Organization, type User } from "@prospex/db";
import { env } from "../env.js";
import { writeAudit } from "../lib/audit.js";
import { emitEvent } from "../lib/events.js";
import { sendMail } from "../lib/mailer.js";
import { safeHeaderText } from "../lib/sanitize.js";

/**
 * Workspace deletion: a request, a grace period, and a purge.
 *
 * Deleting a workspace removes every lead, campaign, message and member with it and cannot
 * be undone, so it is never immediate. An owner asks; the workspace is scheduled for
 * deletion seven days later; every owner is told by email; any owner can cancel until then.
 * While the request is pending the workspace works normally, except that campaigns are
 * paused and stay paused - a workspace on its way out should not keep emailing prospects.
 *
 * The purge (job `org.purge`) deletes the organization row. Every table that belongs to a
 * workspace references it with ON DELETE CASCADE (asserted in security.data.test.ts), so
 * that one delete removes all of it. What survives is a single audit row with no workspace
 * attached, recording that the purge happened and how much it removed.
 */
export const DELETION_GRACE_MS = 7 * 24 * 3600_000;
/** How far ahead of the scheduled time the reminder goes out (the job runs once a day). */
export const REMINDER_LEAD_MS = 48 * 3600_000;
/** No purge until this long after the reminder: whoever reads it has a day to cancel. */
export const MIN_NOTICE_AFTER_REMINDER_MS = 23 * 3600_000;

export const PAUSED_FOR_DELETION = "This workspace is scheduled for deletion, so its campaigns are paused. Cancel the deletion in Settings to send again.";

export type DeletionRequest = typeof workspaceDeletionRequests.$inferSelect;

const PENDING = sql`${workspaceDeletionRequests.cancelledAt} IS NULL AND ${workspaceDeletionRequests.completedAt} IS NULL`;

/** The workspace's open deletion request, or null. */
export async function pendingDeletion(orgId: string): Promise<DeletionRequest | null> {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(workspaceDeletionRequests)
    .where(and(eq(workspaceDeletionRequests.orgId, orgId), PENDING))
    .orderBy(desc(workspaceDeletionRequests.requestedAt))
    .limit(1);
  return row ?? null;
}

async function ownerEmails(orgId: string): Promise<string[]> {
  const { db } = getDb();
  const rows = await db.select({ email: users.email }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "owner")));
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const settingsUrl = () => `${env.appUrl}/settings`;

/** Platform mail to every owner. Returns how many were actually sent; never throws. */
async function mailOwners(addresses: string[], subject: string, text: string): Promise<number> {
  let sent = 0;
  for (const to of addresses) {
    const r = await sendMail(null, { from: env.mailFrom, to, subject, text }).catch(() => ({ ok: false }));
    if (r.ok) sent++;
  }
  return sent;
}

/**
 * Pause every active campaign of a workspace because it is scheduled for deletion.
 * The reason is recorded as an event per campaign (the same place every other automatic
 * pause is recorded), and the caller puts the ids on the audit trail.
 */
async function pauseCampaignsForDeletion(orgId: string, requestId: string): Promise<{ id: string; name: string }[]> {
  const { db } = getDb();
  const paused = await db
    .update(campaigns)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(campaigns.orgId, orgId), eq(campaigns.status, "active")))
    .returning({ id: campaigns.id, name: campaigns.name });
  for (const cp of paused) {
    await emitEvent(orgId, "campaign.paused_workspace_deletion", { campaignId: cp.id, requestId, reason: PAUSED_FOR_DELETION }, { type: "campaign", id: cp.id }).catch(() => {});
  }
  return paused;
}

/** Campaigns this request paused that are still paused: what an owner may want to resume after cancelling. */
async function campaignsPausedBy(orgId: string, requestId: string): Promise<{ id: string; name: string }[]> {
  const { db } = getDb();
  const rows = (await db.execute(sql`
    SELECT c.id, c.name FROM campaigns c
    WHERE c.org_id = ${orgId} AND c.status = 'paused'
      AND EXISTS (SELECT 1 FROM events e WHERE e.org_id = ${orgId} AND e.type = 'campaign.paused_workspace_deletion' AND e.entity_id = c.id AND e.data->>'requestId' = ${requestId})
    ORDER BY c.name`)) as unknown as { id: string; name: string }[];
  return [...rows].map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/**
 * Schedule the workspace for deletion. The caller has already established that this is an
 * owner, that they typed the workspace's name, and that they re-confirmed who they are.
 *
 * Asking again while a request is pending returns that request unchanged: the date does not
 * move and no second set of emails goes out.
 */
export async function requestWorkspaceDeletion(org: Organization, requestedBy: Pick<User, "id" | "email" | "name">): Promise<{ request: DeletionRequest; alreadyPending: boolean; pausedCampaigns: { id: string; name: string }[]; emailed: number }> {
  const { db } = getDb();
  const { request, created } = await db.transaction(async (tx) => {
    // Serialises two owners (or one double-click) asking at the same moment.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`workspace-deletion:${org.id}`}))`);
    const [existing] = await tx.select().from(workspaceDeletionRequests).where(and(eq(workspaceDeletionRequests.orgId, org.id), PENDING)).limit(1);
    if (existing) return { request: existing, created: false };
    const [row] = await tx
      .insert(workspaceDeletionRequests)
      .values({ orgId: org.id, requestedBy: requestedBy.id, scheduledFor: new Date(Date.now() + DELETION_GRACE_MS) })
      .returning();
    return { request: row, created: true };
  });
  if (!created) return { request, alreadyPending: true, pausedCampaigns: await campaignsPausedBy(org.id, request.id), emailed: 0 };

  const pausedCampaigns = await pauseCampaignsForDeletion(org.id, request.id);
  const name = safeHeaderText(org.name, 80, "your workspace");
  const who = safeHeaderText(requestedBy.name || requestedBy.email, 80, "An owner");
  const emailed = await mailOwners(
    await ownerEmails(org.id),
    `Your Scout workspace "${name}" is scheduled for deletion`,
    [
      `${who} asked for the Scout workspace "${name}" and all of its data to be deleted.`,
      "",
      `It will be permanently deleted on or shortly after ${when(request.scheduledFor)}. Until then the workspace keeps working, but its campaigns are paused${pausedCampaigns.length ? ` (${pausedCampaigns.length} paused just now)` : ""}.`,
      "",
      `Changed your mind? Any owner can cancel the deletion under Settings > Workspace: ${settingsUrl()}`,
      "",
      "Want a copy first? Use \"Export all data\" on the same page before the date above.",
      "",
      "If you did not expect this email, cancel the deletion and change your password straight away.",
    ].join("\n"),
  );
  return { request, alreadyPending: false, pausedCampaigns, emailed };
}

/** Cancel the pending request. Campaigns it paused stay paused; they are listed so they can be resumed. */
export async function cancelWorkspaceDeletion(orgId: string): Promise<{ cancelled: boolean; request: DeletionRequest | null; pausedCampaigns: { id: string; name: string }[] }> {
  const { db } = getDb();
  const [row] = await db
    .update(workspaceDeletionRequests)
    .set({ cancelledAt: new Date() })
    .where(and(eq(workspaceDeletionRequests.orgId, orgId), PENDING))
    .returning();
  if (!row) return { cancelled: false, request: null, pausedCampaigns: [] };
  return { cancelled: true, request: row, pausedCampaigns: await campaignsPausedBy(orgId, row.id) };
}

/** Row counts of what a purge is about to remove, for the surviving audit row. */
async function countsFor(orgId: string): Promise<Record<string, number>> {
  const { db } = getDb();
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM users WHERE org_id = ${orgId}) AS users,
      (SELECT count(*)::int FROM leads WHERE org_id = ${orgId}) AS leads,
      (SELECT count(*)::int FROM companies WHERE org_id = ${orgId}) AS companies,
      (SELECT count(*)::int FROM lists WHERE org_id = ${orgId}) AS lists,
      (SELECT count(*)::int FROM clients WHERE org_id = ${orgId}) AS clients,
      (SELECT count(*)::int FROM campaigns WHERE org_id = ${orgId}) AS campaigns,
      (SELECT count(*)::int FROM messages WHERE org_id = ${orgId}) AS messages,
      (SELECT count(*)::int FROM api_keys WHERE org_id = ${orgId}) AS "apiKeys",
      (SELECT count(*)::int FROM webhooks WHERE org_id = ${orgId}) AS webhooks,
      (SELECT count(*)::int FROM integrations WHERE org_id = ${orgId}) AS integrations`)) as unknown as Record<string, number>[];
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v) || 0]));
}

/** End a paid subscription before its workspace disappears. Best-effort; the outcome goes on the audit row. */
async function cancelSubscription(org: Organization): Promise<"none" | "cancelled" | "failed"> {
  if (!org.stripeSubscriptionId) return "none";
  if (!env.stripe.secretKey) return "failed";
  try {
    await new Stripe(env.stripe.secretKey).subscriptions.cancel(org.stripeSubscriptionId);
    return "cancelled";
  } catch (e) {
    console.error(`[account] could not cancel the subscription of workspace ${org.id} before deleting it: ${(e as Error).name}`);
    return "failed";
  }
}

export interface PurgeOutcome {
  reminded: string[];
  purged: string[];
  waiting: string[];
  failed: { orgId: string; error: string }[];
}

/**
 * The daily pass over deletion requests.
 *
 * For each open request:
 *  - within two days of its date (or already past it) and not yet reminded: every owner is
 *    emailed that the deletion is about to happen, and nothing else is done on this pass;
 *  - past its date, reminded at least a day ago, still not cancelled: the workspace is
 *    deleted, the owners are told, and one audit row with no workspace records it.
 *
 * So a workspace is never deleted without a reminder having gone out a day before, even if
 * this job did not run for a while. The delete re-checks the request under a row lock, so a
 * cancellation that lands while the job runs wins, and two instances cannot both purge.
 *
 * `onlyOrgIds` narrows the pass to those workspaces (used by tests).
 */
export async function purgeDueWorkspaces(opts: { now?: Date; onlyOrgIds?: string[] } = {}): Promise<PurgeOutcome> {
  const { db } = getDb();
  const now = opts.now ?? new Date();
  const out: PurgeOutcome = { reminded: [], purged: [], waiting: [], failed: [] };
  if (opts.onlyOrgIds && opts.onlyOrgIds.length === 0) return out;
  const horizon = new Date(now.getTime() + REMINDER_LEAD_MS);
  const open = await db
    .select()
    .from(workspaceDeletionRequests)
    .where(and(PENDING, lte(workspaceDeletionRequests.scheduledFor, horizon), opts.onlyOrgIds ? inArray(workspaceDeletionRequests.orgId, opts.onlyOrgIds) : sql`true`))
    .orderBy(workspaceDeletionRequests.scheduledFor)
    .limit(200);

  for (const req of open) {
    try {
      const org = await db.query.organizations.findFirst({ where: eq(organizations.id, req.orgId) });
      if (!org) continue; // already gone; the request row went with it
      const name = safeHeaderText(org.name, 80, "your workspace");

      const [reminder] = (await db.execute(
        sql`SELECT created_at FROM audit_log WHERE org_id = ${org.id} AND action = 'account.deletion_reminder' AND data->>'requestId' = ${req.id} ORDER BY created_at LIMIT 1`,
      )) as unknown as { created_at: string | Date }[];
      if (!reminder) {
        const emailed = await mailOwners(
          await ownerEmails(org.id),
          `Reminder: your Scout workspace "${name}" will be deleted soon`,
          [
            `The Scout workspace "${name}" is scheduled to be permanently deleted on or shortly after ${when(req.scheduledFor)}.`,
            "",
            "Everything in it - leads, companies, lists, campaigns, messages, members and settings - will be removed and cannot be restored.",
            "",
            `To keep the workspace, any owner can cancel the deletion under Settings > Workspace: ${settingsUrl()}`,
            "",
            "To keep a copy, use \"Export all data\" on the same page before then.",
          ].join("\n"),
        );
        await writeAudit({ action: "account.deletion_reminder", orgId: org.id, actorType: "system", targetType: "organization", targetId: org.id, data: { requestId: req.id, scheduledFor: req.scheduledFor.toISOString(), emailed } });
        out.reminded.push(org.id);
        continue;
      }
      const remindedAt = new Date(reminder.created_at);
      if (req.scheduledFor.getTime() > now.getTime() || now.getTime() - remindedAt.getTime() < MIN_NOTICE_AFTER_REMINDER_MS) {
        out.waiting.push(org.id);
        continue;
      }

      const owners = await ownerEmails(org.id);
      const counts = await countsFor(org.id);
      const purged = await db.transaction(async (tx) => {
        // The request must still be open at the moment of deletion.
        const still = (await tx.execute(sql`SELECT id FROM workspace_deletion_requests WHERE id = ${req.id} AND cancelled_at IS NULL AND completed_at IS NULL FOR UPDATE`)) as unknown as unknown[];
        if (!still.length) return false;
        // Rows that name this workspace's people but do not hang off the organization row.
        await tx.execute(sql`DELETE FROM login_attempts WHERE subject IN (SELECT lower(email) FROM users WHERE org_id = ${org.id})`);
        await tx.execute(sql`DELETE FROM upgrade_requests WHERE org_id = ${org.id}`);
        // Queued and finished jobs carry ids (and sometimes data) of this workspace.
        await tx.execute(sql`DELETE FROM jobs WHERE org_id = ${org.id}`);
        await tx.execute(sql`UPDATE workspace_deletion_requests SET completed_at = now() WHERE id = ${req.id}`);
        const gone = (await tx.execute(sql`DELETE FROM organizations WHERE id = ${org.id} RETURNING id`)) as unknown as unknown[];
        if (!gone.length) return false;
        // The one thing kept: no workspace id on the row (it would have cascaded with it),
        // no personal data in it - the name, the ids, the dates and the counts.
        await tx.execute(sql`
          INSERT INTO audit_log (org_id, actor_type, actor_user_id, action, target_type, target_id, result, data)
          VALUES (NULL, 'system', NULL, 'account.purged', 'organization', ${org.id}, 'ok', ${JSON.stringify({
            orgId: org.id,
            name: org.name.slice(0, 200),
            slug: org.slug,
            plan: org.plan,
            requestId: req.id,
            requestedBy: req.requestedBy,
            requestedAt: req.requestedAt.toISOString(),
            scheduledFor: req.scheduledFor.toISOString(),
            hadSubscription: !!org.stripeSubscriptionId,
            counts,
          })}::jsonb)`);
        return true;
      });
      if (!purged) continue;
      out.purged.push(org.id);
      // Only once the workspace is really gone: a subscription is never ended for a
      // workspace that was kept. If it cannot be ended, that is recorded for the operator -
      // the customer must not keep paying for a workspace that no longer exists.
      const subscription = await cancelSubscription(org);
      if (subscription === "failed") {
        await writeAudit({ action: "account.purge_subscription_not_cancelled", orgId: null, actorType: "system", targetType: "organization", targetId: org.id, result: "failed", data: { orgId: org.id, name: org.name.slice(0, 200), stripeSubscriptionId: org.stripeSubscriptionId, stripeCustomerId: org.stripeCustomerId } });
        if (env.adminEmail) {
          await sendMail(null, { from: env.mailFrom, to: env.adminEmail, subject: "Action needed: cancel the subscription of a deleted workspace", text: `The workspace "${name}" (${org.id}) was deleted at its owner's request, but its subscription ${org.stripeSubscriptionId} could not be cancelled automatically. Cancel it in the billing provider so the customer is not charged again.` }).catch(() => {});
        }
      }
      await mailOwners(
        owners,
        `Your Scout workspace "${name}" was deleted`,
        [
          `The Scout workspace "${name}" and all of its data have been permanently deleted, as requested on ${when(req.requestedAt)}.`,
          "",
          "Leads, companies, lists, campaigns, messages, members, API keys and settings are gone and cannot be restored. Sign-ins for this workspace no longer work.",
          ...(subscription === "cancelled" ? ["", "Its paid subscription has been cancelled."] : []),
          "",
          "You are welcome to create a new workspace at any time.",
        ].join("\n"),
      );
    } catch (e) {
      // One workspace failing must not stop the others; the next daily pass tries again.
      const error = (e as Error).name || "Error";
      console.error(`[account] purge of workspace ${req.orgId} failed: ${error}`);
      out.failed.push({ orgId: req.orgId, error });
    }
  }
  return out;
}
