/**
 * Security notification emails.
 *
 * When something changes about how an account is protected - its password, its two-factor
 * setting, a new API key, a sign-in from somewhere new - the owner is told by email, so that
 * a change they did not make is noticed the same day instead of after the damage.
 *
 * Rules, all of which the callers rely on:
 *  - never throws and never blocks: callers write `void notifySecurity(...)` and carry on;
 *    a mail that cannot be sent is logged and forgotten;
 *  - sent only when the platform has a mail provider. With none there is nothing to send
 *    through (and in development sendMail would print the text to the console instead);
 *  - plain text, and no secret of any kind in it: no token, no key, no code, no link that
 *    signs anyone in. The only link is the public "forgot password" page;
 *  - the address shown is the one the request came from, as far as we can tell. It is called
 *    approximate because that is what an IP address is.
 */
import { env } from "../env.js";
import { sendMail, systemMailerConfig } from "./mailer.js";
import { windowHit, windowRemaining } from "./rateWindow.js";

/** Where a customer writes when they need a person. */
export const SECURITY_CONTACT_EMAIL = "contact@mnbresearch.com";

export type SecurityMailKind =
  | "password_changed"
  | "password_reset"
  | "twofa_enabled"
  | "twofa_disabled"
  | "twofa_reset_by_support"
  | "api_key_created"
  | "new_signin"
  | "admin_new_signin"
  | "admin_locked";

export interface SecurityMailDetails {
  /** The address the request came from (clientIp). */
  ip?: string | null;
  /** When it happened; now when omitted. */
  at?: Date;
  /** api_key_created: the key's name, its visible prefix and whether it is read-only. Never the key. */
  keyName?: string;
  keyPrefix?: string;
  keyScope?: "full" | "read";
  /** new_signin: how they signed in ("password", "Google"). */
  method?: string;
  /** admin_locked: how long the lock lasts. */
  retryAfterSeconds?: number;
}

/** "2026-10-03 18:22 UTC" */
export function utcStamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** An address fit to print in a mail: an IP address, or nothing. */
function shownAddress(ip: string | null | undefined): string {
  const v = (ip ?? "").trim();
  return v && v !== "unknown" && /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : "";
}

/** Text a tenant chose (a key's name), made safe for a mail body: one line, no control characters, capped. */
const oneLine = (v: string | undefined, max = 80) => (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

const forgotLink = () => `${env.appUrl.replace(/\/$/, "")}/forgot-password`;

interface Composed {
  subject: string;
  /** What happened, as a sentence or two. */
  what: string;
  /** What to do if it was not them. */
  notYou: string;
}

function compose(kind: SecurityMailKind, email: string, d: SecurityMailDetails): Composed {
  const reset = `reset your password straight away at ${forgotLink()}`;
  const contact = `If you need help, write to ${SECURITY_CONTACT_EMAIL}.`;
  switch (kind) {
    case "password_changed":
      return {
        subject: "Your Scout password was changed",
        what: `The password for your Scout account (${email}) was changed. Every other device that was signed in has been signed out.`,
        notYou: `If you did not do this, ${reset}, then check your team and API keys under Settings. ${contact}`,
      };
    case "password_reset":
      return {
        subject: "Your Scout password was reset",
        what: `The password for your Scout account (${email}) was reset using the link we emailed to this address. Every other device that was signed in has been signed out.`,
        notYou: `If you did not do this, someone else can read this mailbox: change your email password first, then ${reset}. ${contact}`,
      };
    case "twofa_enabled":
      return {
        subject: "Two-factor sign-in was turned on for your Scout account",
        what: `Two-factor sign-in is now on for your Scout account (${email}). From now on, signing in with your password also needs a 6-digit code from your authenticator app. Keep your recovery codes somewhere safe: each one works once if you lose your phone.`,
        notYou: `If you did not do this, ${reset} and write to ${SECURITY_CONTACT_EMAIL} - whoever turned it on holds the authenticator, so you will need our help to get back in.`,
      };
    case "twofa_disabled":
      return {
        subject: "Two-factor sign-in was turned off for your Scout account",
        what: `Two-factor sign-in was turned off for your Scout account (${email}). Signing in now needs only your password.`,
        notYou: `If you did not do this, ${reset}, then turn two-factor sign-in back on under Settings > Security. ${contact}`,
      };
    case "twofa_reset_by_support":
      return {
        subject: "Two-factor sign-in was reset on your Scout account",
        what: `Our support team turned off two-factor sign-in for your Scout account (${email}), which is what we do when someone has lost both their authenticator and their recovery codes. Signing in now needs only your password. Your old recovery codes no longer work. You can turn two-factor sign-in on again under Settings > Security.`,
        notYou: `If you did not ask for this, ${reset} and write to ${SECURITY_CONTACT_EMAIL} at once.`,
      };
    case "api_key_created": {
      const name = oneLine(d.keyName);
      const prefix = oneLine(d.keyPrefix, 20);
      const access = d.keyScope === "read" ? "read-only access" : "full access";
      return {
        subject: "A new API key was created in your Scout workspace",
        what: `A new API key${name ? ` named "${name}"` : ""}${prefix ? ` (it starts with ${prefix})` : ""} with ${access} was created from your Scout account (${email}). An API key can use your workspace without a password.`,
        notYou: `If you did not create it, revoke it under Settings > API keys, then ${reset}. ${contact}`,
      };
    }
    case "new_signin":
      return {
        subject: "New sign-in to your Scout account",
        what: `Your Scout account (${email}) was just signed in to${d.method ? ` with ${oneLine(d.method, 30)}` : ""} from an address we have not seen for this account before.`,
        notYou: `If this was you, there is nothing to do. If it was not, ${reset} - that signs out every device - and consider turning on two-factor sign-in under Settings > Security. ${contact}`,
      };
    case "admin_new_signin":
      return {
        subject: "Scout admin console: sign-in from a new address",
        what: "The Scout admin console was just signed in to from an address that has not signed in to it before.",
        notYou: "If this was you, there is nothing to do. If it was not, change the admin password now, sign the admin console out, and review the platform security log for what was changed.",
      };
    case "admin_locked": {
      const mins = d.retryAfterSeconds ? Math.max(1, Math.ceil(d.retryAfterSeconds / 60)) : 15;
      return {
        subject: "Scout admin console: sign-in locked after failed attempts",
        what: `The Scout admin console sign-in was locked after repeated failed attempts. It unlocks by itself in about ${mins} minute${mins === 1 ? "" : "s"}; a session that is already signed in keeps working.`,
        notYou: "If the failed attempts were not yours, someone is guessing at the admin password. Make sure it is long and random, and turn on the admin two-factor code if it is not on yet. The platform security log shows where the attempts came from.",
      };
    }
  }
}

/** The whole mail for a kind. Exported for tests; callers use notifySecurity. */
export function securityMail(kind: SecurityMailKind, email: string, details: SecurityMailDetails = {}): { subject: string; text: string } {
  const c = compose(kind, email, details);
  const from = shownAddress(details.ip);
  const text = [
    "Hello,",
    "",
    c.what,
    "",
    `When: ${utcStamp(details.at ?? new Date())}`,
    // A support action is ours: the customer is told who did it, not which address our
    // operator sat at.
    kind === "twofa_reset_by_support" ? "By: the Scout support team" : `From: ${from ? `IP address ${from} (approximate)` : "an address we could not determine"}`,
    "",
    c.notYou,
    "",
    "This message was sent because of a change to how the account is protected. It is sent to keep the account safe and cannot be switched off.",
  ].join("\n");
  return { subject: c.subject, text };
}

/** Can security mails be sent at all? (Is the platform's own mail provider set up?) */
export function securityMailAvailable(): boolean {
  return !!systemMailerConfig();
}

/** At most one "new sign-in" mail per account per hour, however many sign-ins there are. */
const NEW_SIGNIN_WINDOW_MS = 60 * 60 * 1000;
const HOURLY_KINDS: ReadonlySet<SecurityMailKind> = new Set(["new_signin", "admin_new_signin", "admin_locked"]);

/**
 * Tell an account's owner about a security-relevant change.
 *
 * `userOrEmail` is the user row (anything with an `email`) or an address. For the two admin
 * kinds pass anything - they always go to the operator's address.
 *
 * Resolves to whether a mail was handed to the provider. Never rejects.
 */
export async function notifySecurity(userOrEmail: { email: string } | string | null | undefined, kind: SecurityMailKind, details: SecurityMailDetails = {}): Promise<boolean> {
  try {
    if (!securityMailAvailable()) return false;
    const admin = kind === "admin_new_signin" || kind === "admin_locked";
    const to = (admin ? env.adminEmail : typeof userOrEmail === "string" ? userOrEmail : userOrEmail?.email ?? "").trim();
    if (!to || !/^[^\s@]+@[^\s@]+$/.test(to)) return false;
    if (HOURLY_KINDS.has(kind)) {
      const key = `secmail:${kind}:${to.toLowerCase()}`;
      if (windowRemaining(key, 1, NEW_SIGNIN_WINDOW_MS) < 1) return false;
      windowHit(key, NEW_SIGNIN_WINDOW_MS);
    }
    const mail = securityMail(kind, to, details);
    const r = await sendMail(null, { from: env.mailFrom, to, subject: mail.subject, text: mail.text });
    if (!r.ok) console.warn(`[security-mail] ${kind} notice could not be sent: ${String(r.error ?? "unknown error").slice(0, 200)}`);
    return !!r.ok;
  } catch (e) {
    console.warn(`[security-mail] ${kind} notice failed: ${(e as Error).message?.slice(0, 200)}`);
    return false;
  }
}
