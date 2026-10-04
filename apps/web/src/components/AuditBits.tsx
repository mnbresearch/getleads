/**
 * The security log's vocabulary: what each recorded action, actor and refusal is called on
 * screen. Shared by the workspace's own log (Settings > Security log) and the platform-wide
 * one in the Scout admin console, so the same event reads the same in both.
 */
export interface AuditEntry {
  id: string;
  action: string;
  actorType?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result?: string | null;
  ip?: string | null;
  createdAt: string;
  data?: Record<string, unknown> | null;
  /** Only on the platform-wide log the Scout admin console reads. */
  orgId?: string | null;
  orgName?: string | null;
}

/**
 * Security-log actions in plain words. Keyed on the action with its separators normalised
 * ("auth.password_change", "auth.password.change" and "auth:password-change" are one key),
 * so a spelling difference on the server does not turn a row into raw identifiers. Anything
 * not listed still reads as words through the fallback below - a new server action shows up
 * as "Webhook: rotate secret", never as a blank.
 */
export const AUDIT_WORDS: Record<string, string> = {
  // Sign-in and sessions
  "auth.signup": "Workspace created",
  "auth.login": "Sign-in",
  "auth.login.locked": "Sign-in blocked after too many attempts",
  "auth.google.login": "Sign-in with Google",
  "auth.google.claimed.unverified.account": "Google sign-in took over an unverified account",
  "auth.logout.all": "Signed out of all devices",
  "auth.password.changed": "Password change",
  "auth.password.reset": "Password reset from an emailed link",
  "auth.password.reset.requested": "Password reset requested",
  // Two-factor sign-in and email confirmation
  "auth.2fa.setup": "Two-factor setup started",
  "auth.2fa.setup.started": "Two-factor setup started",
  "auth.2fa.challenge": "Password accepted, two-factor code asked for",
  "auth.2fa.enabled": "Two-factor sign-in turned on",
  "auth.2fa.disabled": "Two-factor sign-in turned off",
  "auth.2fa.failed": "Two-factor code refused",
  "auth.2fa.verified": "Sign-in completed with a two-factor code",
  "auth.2fa.recovery.used": "Signed in with a recovery code",
  "auth.2fa.recovery.code.used": "Signed in with a recovery code",
  "auth.2fa.recovery.codes": "New recovery codes made",
  "auth.2fa.recovery.codes.regenerated": "New recovery codes made",
  "auth.2fa.recovery.codes.generated": "New recovery codes made",
  "auth.2fa.reset.by.support": "Two-factor sign-in reset by Scout support",
  "auth.email.verified": "Email address confirmed",
  "auth.verification.sent": "Confirmation email sent",
  // Refusals
  "role.denied": "Refused: needs owner or admin",
  "reference.denied": "Refused: that record belongs to another workspace",
  "scope.denied": "Refused: the API key is read-only",
  "apikey.scope.denied": "Refused: the API key is read-only",
  "email.unverified.denied": "Refused: email address not confirmed yet",
  // Credentials
  "apikey.created": "API key created",
  "apikey.revoked": "API key revoked",
  "webhook.created": "Webhook added",
  "webhook.deleted": "Webhook deleted",
  "webhook.secret.rotated": "Webhook secret rotated",
  "webhook.tested": "Webhook test sent",
  "integration.connected": "Integration connected",
  "integration.disconnected": "Integration disconnected",
  "integration.synced": "Leads pushed to an integration",
  "sender.created": "Sender account added",
  "sender.deleted": "Sender account removed",
  "sender.retested": "Sender account tested again",
  // People
  "team.invited": "Teammate invited",
  "team.invite.resent": "Invite resent",
  "team.invite.revoked": "Invite revoked",
  "team.joined": "Teammate joined from an invite",
  "team.member.removed": "Teammate removed",
  // Data leaving, being shared or being destroyed
  "leads.exported": "Leads exported",
  "leads.imported": "Leads imported",
  "leads.bulk.deleted": "Leads deleted in bulk",
  "list.deleted": "List deleted",
  "suppression.added": "Address added to the do-not-contact list",
  "lead.create.refused": "Lead not saved - the person asked not to be contacted through Scout",
  "security.new.signin.notice": "Notice sent about a sign-in from a new address",
  "client.created": "Client created",
  "client.deleted": "Client deleted",
  "client.share.enabled": "Client report link created",
  "client.share.disabled": "Client report link turned off",
  "client.share.rotated": "Client report link replaced",
  "client.report.settings.changed": "Client report settings changed",
  "campaign.started": "Campaign started",
  "campaign.paused": "Campaign paused",
  "campaign.deleted": "Campaign deleted",
  "autopilot.created": "Autopilot created",
  "autopilot.deleted": "Autopilot deleted",
  "pixel.created": "Website tracking pixel created",
  "pixel.deleted": "Website tracking pixel deleted",
  // Workspace and billing
  "org.settings.changed": "Workspace settings changed",
  "account.privacy.updated": "AI assistance or mailing address changed",
  // Not an action of its own: what a refused two-factor code was being used for ("While: ...").
  "account.confirmation": "Confirming an export or deletion",
  "account.export.started": "Export of all workspace data started",
  "account.exported": "All workspace data exported",
  "account.deletion.reminder": "Reminder sent: workspace deletion is coming up",
  "account.purge.subscription.not.cancelled": "Workspace deleted, but its subscription could not be cancelled",
  "account.deletion.requested": "Workspace deletion scheduled",
  "account.deletion.cancelled": "Workspace deletion cancelled",
  "account.deletion.canceled": "Workspace deletion cancelled",
  "account.purged": "Workspace permanently deleted",
  "billing.checkout": "Plan checkout started",
  // Scout staff
  "admin.login": "Scout admin sign-in",
  "admin.logout": "Scout admin sign-out",
  "admin.plan.changed": "Plan changed by Scout admin",
  "admin.status.changed": "Workspace suspended or restored by Scout admin",
  "admin.credits.changed": "Credits adjusted by Scout admin",
  "admin.upgrade.request.status.changed": "Upgrade request updated by Scout admin",
  "admin.suppression.added": "Address added to the platform do-not-contact list",
  "admin.suppression.removed": "Address removed from the platform do-not-contact list",
  "admin.data.subject.viewed": "A person's data looked up by Scout admin",
  "admin.data.subject.erased": "A person's data erased everywhere by Scout admin",
  "admin.tool.limit.changed": "Tool limit changed by Scout admin",
  "admin.tools.checked": "Tools checked by Scout admin",
  "admin.login.locked": "Scout admin sign-in blocked after too many attempts",
  "admin.2fa.reset": "Two-factor sign-in reset by Scout support",
  "admin.user.2fa.reset": "Two-factor sign-in reset by Scout support",
};

export function auditActionLabel(action: string): string {
  const key = String(action ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (AUDIT_WORDS[key]) return AUDIT_WORDS[key];
  const parts = String(action ?? "").split(/[.:/]+/).map((p) => p.replace(/[_-]+/g, " ").trim()).filter(Boolean);
  if (parts.length === 0) return "Unknown action";
  const head = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.length === 1 ? head : `${head}: ${parts.slice(1).join(" ")}`;
}

/** "API key created" says which kind: a read-only key and a full-access key are different events. */
function scopeOf(data: Record<string, unknown> | null | undefined): "read" | "full" | null {
  const one = data?.scope;
  const many = data?.scopes;
  const v = typeof one === "string" ? [one] : Array.isArray(many) ? many : null;
  if (!v) return null;
  if (v.includes("*") || v.includes("full")) return "full";
  return v.includes("read") ? "read" : null;
}

/** The action in words, with the one detail that changes what it means. */
export function auditEntryLabel(e: AuditEntry): string {
  const label = auditActionLabel(e.action);
  const key = String(e.action ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ".");
  if (key === "apikey.created") {
    const scope = scopeOf(e.data);
    if (scope) return `${label} (${scope === "read" ? "read-only" : "full access"})`;
  }
  return label;
}

export const AUDIT_ACTOR: Record<string, string> = { user: "A workspace member", api_key: "API key", admin: "Scout admin", system: "Scout (automatic)", anonymous: "Not signed in" };

export function auditWho(e: AuditEntry): string {
  if (e.actorEmail) return e.actorEmail;
  // A failed sign-in has no account behind it; the address that was tried is the only "who".
  const tried = e.data && typeof e.data.email === "string" ? e.data.email : null;
  const label = AUDIT_ACTOR[e.actorType ?? ""] ?? (e.actorType ? e.actorType : "Unknown");
  return tried ? `${label} (as ${tried})` : label;
}

/** Why an action was refused or failed, where the server recorded a reason. */
const AUDIT_REASONS: Record<string, string> = {
  role: "Needs owner or admin",
  locked: "Too many failed attempts - the account was temporarily locked",
  wrong_current_password: "The current password entered was wrong",
  verifier_mismatch: "The sign-in was not started in that browser",
  invalid_2fa_code: "The two-factor code was wrong",
  wrong_code: "The two-factor code was wrong",
  invalid_code: "The two-factor code was wrong",
  wrong_password: "The password entered was wrong",
  invalid_totp: "The authenticator code was wrong",
  totp_required: "No authenticator code was given",
  email_unverified: "The email address is not confirmed yet",
  insufficient_scope: "The API key is read-only",
  name_mismatch: "The workspace name typed did not match",
  invalid_password: "The password entered was wrong",
  confirmation_required: "No password or code was given to confirm",
  password_not_set: "The account has no password to confirm with",
  too_many_confirmations: "Too many wrong confirmations - try again later",
  confirmation_unavailable: "The two-factor code could not be checked",
  two_factor_code_required: "No two-factor code was given",
};

export function auditReason(e: AuditEntry): string | null {
  if ((e.result ?? "ok") === "ok") return null;
  const r = e.data && typeof e.data.reason === "string" ? e.data.reason : null;
  // A refused two-factor code records what it was being used for instead of a reason.
  const during = !r && e.data && typeof e.data.during === "string" && e.data.during ? e.data.during : null;
  if (during) return `While: ${auditActionLabel(during).replace(/^./, (c) => c.toLowerCase())}`;
  if (!r) return null;
  return AUDIT_REASONS[r] ?? r.replace(/[_.-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ── What the action was done to, and what it changed ──

const TARGET_WORDS: Record<string, string> = {
  organization: "Workspace",
  org: "Workspace",
  user: "User",
  admin_session: "Admin session",
  email_account: "Sender account",
  api_key: "API key",
  webhook: "Webhook",
  integration: "Integration",
  client: "Client",
  campaign: "Campaign",
  list: "List",
  lead: "Lead",
  invite: "Invite",
  pixel: "Tracking pixel",
  autopilot: "Autopilot",
  upgrade_request: "Upgrade request",
  tool: "Tool",
  tools: "Tools",
  global_suppression: "Platform do-not-contact entry",
  data_subject: "A person's data",
};

const NAMED_BY_ID = new Set(["tool", "integration"]);
/** Field names that read better as something other than their own words. */
const KEY_WORDS: Record<string, string> = { planId: "plan", testOk: "connection test passed", dailyLimit: "daily limit", replyTo: "replies go to" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An identifier that means nothing to a reader: a database id or a one-way fingerprint. */
const opaque = (v: string) => UUID.test(v) || /^sha256:/i.test(v) || /^[0-9a-f]{32,}$/i.test(v);
const words = (key: string) => KEY_WORDS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").toLowerCase().trim();
const sentenceCase = (t: string) => t.replace(/^./, (c) => c.toUpperCase());

/** A value as it can be shown, or null when it should not be (an object, an id, a fingerprint, something long). */
function shown(v: unknown, key = ""): string | null {
  if (typeof v === "boolean") return /set$/i.test(key) || key === "mailingAddress" ? (v ? "set" : "not set") : /^(aiAssist|active|enabled)$/i.test(key) ? (v ? "on" : "off") : v ? "yes" : "no";
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  if (typeof v === "string") return v && v.length <= 80 && !opaque(v) ? v : null;
  if (v === null) return "none";
  if (Array.isArray(v)) {
    const items = v.map((x) => shown(x)).filter((x): x is string => x !== null);
    return items.length === v.length ? (items.length ? items.slice(0, 6).join(", ") + (items.length > 6 ? ` and ${items.length - 6} more` : "") : "none") : null;
  }
  return null;
}

/** "status: active -> revoked" for each simple field that differs between two recorded states. */
function changes(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out: string[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const from = shown(b[k] ?? null, k);
    const to = shown(a[k] ?? null, k);
    if (from === null || to === null || from === to) continue;
    out.push(`${words(k)}: ${from} -> ${to}`);
  }
  return out;
}

/** What the action was done to: "Workspace", "Tool: hunter", "Sender account: sales@acme.com". Null when nothing was recorded. */
export function auditTarget(e: AuditEntry): string | null {
  const type = e.targetType ? TARGET_WORDS[e.targetType] ?? sentenceCase(words(e.targetType)) : null;
  const d = e.data ?? {};
  // A name a person would recognise, if one was recorded; never a database id or a fingerprint.
  // The recorded id is used only where the id IS the name (a tool is recorded by its provider name).
  const named = [d.name, d.fromEmail, d.provider, NAMED_BY_ID.has(e.targetType ?? "") ? e.targetId : null].map((v) => (typeof v === "string" ? shown(v) : null)).find((v) => !!v) ?? null;
  if (!type) return named;
  return named ? `${type}: ${named}` : type;
}

/** Keys that are already on the row (who, why) or are not for display. */
const NOT_DETAIL = new Set(["reason", "during", "email", "name", "fromEmail", "address", "before", "after", "scope", "scopes"]);

/**
 * What the action changed, as one readable line - or null when there is nothing worth adding.
 *
 * The log used to show only the action's name. "Tool limit changed" without which tool or
 * what it changed to, or "A person's data erased" without how much was removed, sent the
 * reader to the database. The recorded details are turned into words here; identifiers and
 * address fingerprints (which the log stores instead of addresses, on purpose) are left out.
 */
export function auditDetail(e: AuditEntry): string | null {
  const d = e.data;
  if (!d || typeof d !== "object") return null;
  const key = String(e.action ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ".");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const count = (v: number, one: string, many: string) => `${v.toLocaleString()} ${v === 1 ? one : many}`;
  const parts: string[] = [];

  if (key === "admin.data.subject.erased") {
    const leads = n(d.leadsDeleted), spaces = n(d.workspaces), msgs = n(d.messagesAnonymised), events = n(d.eventsDeleted);
    if (leads !== null) parts.push(`${count(leads, "lead record", "lead records")} removed${spaces !== null ? ` across ${count(spaces, "workspace", "workspaces")}` : ""}`);
    if (msgs !== null) parts.push(`${count(msgs, "message record", "message records")} kept without content`);
    if (events !== null) parts.push(`${count(events, "activity record", "activity records")} removed`);
  } else if (key === "admin.data.subject.viewed") {
    const spaces = n(d.workspaces);
    if (spaces !== null) parts.push(spaces === 0 ? "Found in no workspace" : `Found in ${count(spaces, "workspace", "workspaces")}`);
    if (typeof d.globallySuppressed === "boolean") parts.push(d.globallySuppressed ? "on the platform do-not-contact list" : "not on the platform do-not-contact list");
  } else if (key === "admin.suppression.added" || key === "admin.suppression.removed") {
    const reason = shown(d.reason);
    parts.push(reason && reason !== "none" ? `Reason given: ${reason}` : "No reason given");
  } else if (key === "account.privacy.updated") {
    const ai = d.aiAssist as { before?: unknown; after?: unknown } | undefined;
    const addr = d.mailingAddress as { before?: unknown; after?: unknown } | undefined;
    if (ai && typeof ai.after === "boolean") parts.push(`AI assistance turned ${ai.after ? "on" : "off"}`);
    if (addr && typeof addr.after === "boolean") parts.push(addr.after ? (addr.before === true ? "mailing address changed" : "mailing address added") : "mailing address removed");
  } else if (key === "admin.credits.changed") {
    const metric = shown(d.metric), action = shown(d.action), amount = n(d.amount);
    if (metric) parts.push(`${sentenceCase(words(metric))}${action ? `: ${action}` : ""}${amount !== null ? ` ${amount.toLocaleString()}` : ""}`);
    parts.push(...changes(d.before, d.after));
  } else {
    parts.push(...changes(d.before, d.after));
    for (const [k, v] of Object.entries(d)) {
      if (NOT_DETAIL.has(k) || parts.length >= 5) continue;
      const text = shown(v, k);
      if (text !== null) parts.push(`${words(k)}: ${text}`);
    }
  }
  if (parts.length === 0) return null;
  return sentenceCase(parts.join("; "));
}

/**
 * The outcome. A success is the quiet case; a refusal or a failure is the reason someone
 * opens this page, so those are solid, not tinted - they have to stand out in a long list
 * of green.
 */
export function AuditResult({ result }: { result?: string | null }) {
  const r = result ?? "ok";
  const [cls, text] = r === "ok" ? ["bg-emerald-50 text-emerald-700", "Succeeded"] : r === "denied" ? ["bg-amber-600 text-white", "Refused"] : r === "failed" ? ["bg-red-600 text-white", "Failed"] : ["bg-black/[0.08] text-ink-200", r];
  return <span className={`badge shrink-0 font-semibold ${cls}`}>{text}</span>;
}
