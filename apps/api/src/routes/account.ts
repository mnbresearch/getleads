import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq, getDb, sql, users } from "@prospex/db";
import { zValidator } from "../lib/validate.js";
import { ApiError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { roleGate } from "../lib/roles.js";
import { enforceWindows, windowHit, windowRemaining } from "../lib/rateWindow.js";
import { clientIp, requireAuth, requireUser, type Env } from "../middleware.js";
import { reconfirmIdentity } from "../services/accountGuards.js";
import { exportWorkspaceStream } from "../services/accountExport.js";
import { cancelWorkspaceDeletion, pendingDeletion, requestWorkspaceDeletion } from "../services/accountDeletion.js";

/**
 * The workspace as a whole: take a copy of everything in it, or delete it.
 *
 * Both are for an OWNER, signed in as a person (an API key cannot do either), who has just
 * proved again that they are who the session says: their password, or - when two-factor
 * sign-in is on - a code. A session left open on a shared machine, or a stolen session
 * token, is enough to use the product; it is not enough to walk away with the whole
 * database or to destroy it.
 */
export const accountRoutes = new Hono<Env>();
accountRoutes.use("*", requireAuth);

const confirmation = { password: z.string().max(200).optional(), code: z.string().max(64).optional() };

/** Wrong confirmations per person: enough for typos, not enough to guess a password through this door. */
const CONFIRM_WINDOW_MS = 15 * 60_000;
const CONFIRM_FAILURES = 5;

/**
 * Re-confirm the signed-in owner, or throw. A refusal is written to the audit log under the
 * action that was being attempted.
 */
async function confirmOwner(c: Context<Env>, action: string, given: { password?: string | null; code?: string | null }): Promise<"password" | "code"> {
  const a = c.get("auth");
  const user = a.user!;
  const key = `reconfirm:${user.id}`;
  if (windowRemaining(key, CONFIRM_FAILURES, CONFIRM_WINDOW_MS) === 0) {
    await audit(c, action, { result: "denied", data: { reason: "too_many_confirmations" } });
    throw new ApiError(429, "Too many incorrect confirmations. Wait 15 minutes and try again.", "rate_limited");
  }
  // The row as it is now, not as it was when the request was authenticated a moment ago.
  const { db } = getDb();
  const fresh = (await db.query.users.findFirst({ where: eq(users.id, user.id) })) ?? user;
  const r = await reconfirmIdentity(fresh, given, { ip: clientIp(c), during: action });
  if (r.ok) return r.method;
  // Only a wrong answer counts; "you did not send one" is not an attempt.
  if (r.status === 401) windowHit(key, CONFIRM_WINDOW_MS);
  await audit(c, action, { result: "denied", data: { reason: r.code } });
  throw new ApiError(r.status, r.message, r.code);
}

// ── Export ──

const EXPORT_WINDOW_MS = 10 * 60_000;
const EXPORT_LIMIT_MESSAGE = "An export of this workspace was started less than 10 minutes ago. Wait a few minutes before starting another.";

async function startExport(c: Context<Env>, given: { password?: string | null; code?: string | null }) {
  const a = c.get("auth");
  const method = await confirmOwner(c, "account.exported", given);

  // One export per workspace per 10 minutes. Counted in this process (two clicks at once) and
  // against the audit trail (another instance, or a restart in between).
  const { db } = getDb();
  const recent = (await db.execute(
    sql`SELECT 1 FROM audit_log WHERE org_id = ${a.org.id} AND action = 'account.export_started' AND created_at > now() - interval '10 minutes' LIMIT 1`,
  )) as unknown as unknown[];
  if (recent.length) {
    c.header("retry-after", "600");
    throw new ApiError(429, EXPORT_LIMIT_MESSAGE, "rate_limited");
  }
  enforceWindows([{ key: `account-export:${a.org.id}`, limit: 1, message: EXPORT_LIMIT_MESSAGE }], EXPORT_WINDOW_MS);
  await audit(c, "account.export_started", { targetType: "organization", targetId: a.org.id, data: { confirmedWith: method } });

  const stream = exportWorkspaceStream(a.org, {
    onDone: (r) =>
      audit(c, "account.exported", {
        targetType: "organization",
        targetId: a.org.id,
        result: r.complete ? "ok" : "failed",
        // Row counts per table and the size: what left, never the content.
        data: { complete: r.complete, ...(r.aborted ? { aborted: true } : {}), ...(r.error ? { error: r.error } : {}), bytes: r.bytes, counts: r.counts },
      }),
  });
  const day = new Date().toISOString().slice(0, 10);
  const slug = a.org.slug.replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "workspace";
  return c.body(stream, 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="scout-export-${slug}-${day}.json"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

/** A header value that was percent-encoded by the sender (a password may hold any character; a header may not). */
function headerValue(c: Context<Env>, name: string): string | undefined {
  const raw = c.req.header(name);
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * GET /v1/account/export - the confirmation travels in request headers, never in the URL:
 * `x-confirm-password` (percent-encoded) or `x-confirm-code`.
 */
accountRoutes.get("/export", requireUser, roleGate("account.exported", "owner"), (c) => startExport(c, { password: headerValue(c, "x-confirm-password"), code: headerValue(c, "x-confirm-code") }));

/** POST /v1/account/export - the same download, with the confirmation in a JSON body. */
accountRoutes.post("/export", requireUser, roleGate("account.exported", "owner"), zValidator("json", z.object(confirmation)), (c) => startExport(c, c.req.valid("json")));

// ── Deletion ──

/** Who asked, for the people looking at the banner. Null when that person has since left. */
async function requester(orgId: string, userId: string | null): Promise<{ name: string; email: string } | null> {
  if (!userId) return null;
  const { db } = getDb();
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true, email: true, orgId: true } });
  return u && u.orgId === orgId ? { name: u.name, email: u.email } : null;
}

/** Whether a deletion is pending. Any member may ask: the banner is shown to everyone in the workspace. */
accountRoutes.get("/deletion", async (c) => {
  const a = c.get("auth");
  const req = await pendingDeletion(a.org.id);
  if (!req) return c.json({ pending: false });
  return c.json({
    pending: true,
    scheduledFor: req.scheduledFor.toISOString(),
    requestedAt: req.requestedAt.toISOString(),
    requestedBy: await requester(a.org.id, req.requestedBy),
    canCancel: a.user?.role === "owner",
  });
});

accountRoutes.post("/delete", requireUser, roleGate("account.deletion_requested", "owner"), zValidator("json", z.object({ confirmName: z.string().max(200), ...confirmation })), async (c) => {
  const a = c.get("auth");
  const b = c.req.valid("json");
  // Exactly the name, as it is written: this is the "are you sure" that cannot be clicked through.
  if (b.confirmName !== a.org.name) {
    await audit(c, "account.deletion_requested", { result: "denied", data: { reason: "name_mismatch" } });
    throw new ApiError(400, "That does not match the workspace name. Type the name exactly as it is shown, including capital letters and spaces.", "name_mismatch");
  }
  const method = await confirmOwner(c, "account.deletion_requested", b);
  const r = await requestWorkspaceDeletion(a.org, a.user!);
  if (!r.alreadyPending) {
    await audit(c, "account.deletion_requested", {
      targetType: "organization",
      targetId: a.org.id,
      data: { requestId: r.request.id, scheduledFor: r.request.scheduledFor.toISOString(), confirmedWith: method, pausedCampaigns: r.pausedCampaigns.map((p) => p.id).slice(0, 200), ownersEmailed: r.emailed },
    });
  }
  return c.json({
    pending: true,
    scheduledFor: r.request.scheduledFor.toISOString(),
    alreadyPending: r.alreadyPending,
    pausedCampaigns: r.pausedCampaigns,
    emailed: r.emailed > 0,
  });
});

accountRoutes.post("/delete/cancel", requireUser, roleGate("account.deletion_cancelled", "owner"), async (c) => {
  const a = c.get("auth");
  const r = await cancelWorkspaceDeletion(a.org.id);
  if (r.cancelled) {
    await audit(c, "account.deletion_cancelled", { targetType: "organization", targetId: a.org.id, data: { requestId: r.request!.id, scheduledFor: r.request!.scheduledFor.toISOString() } });
  }
  // Campaigns the request paused are not restarted behind anyone's back; they are listed so
  // they can be resumed deliberately.
  return c.json({ ok: true, cancelled: r.cancelled, pausedCampaigns: r.pausedCampaigns });
});
