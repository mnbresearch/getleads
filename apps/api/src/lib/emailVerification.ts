/**
 * Email verification.
 *
 * Typing an address into the signup form proves nothing about who owns it. Until this, the
 * only things that did were a completed password reset and a Google sign-in, so most new
 * accounts stayed unproved for ever - and an unproved account could still make the platform
 * send mail in its name (team invites, the shared platform sender).
 *
 * Now a new account is emailed a link. The token in it is 32 random bytes, shown once; only
 * its sha256 is stored, so a read of the database yields no usable link. 24 hours, one use.
 *
 * Who this applies to: accounts created from now on. Every account that existed before the
 * release was marked verified by migration 0018, and Google sign-ups are verified when they
 * are created. Someone who joins through a team invite is unverified until they confirm:
 * the invite link is also shown to the inviter, so accepting it proves nothing about the
 * mailbox.
 *
 * When the platform has no mail provider there is no way to send the link, so nothing is
 * restricted: `emailVerificationAvailable()` is false and `requireVerifiedEmail` lets
 * everything through. A deployment must not be able to lock its users behind an email it
 * cannot send.
 */
import type { Context } from "hono";
import { and, emailVerificationTokens, eq, getDb, isNull, sql, users, type User } from "@prospex/db";
import { env } from "../env.js";
import { ApiError, errorLine, redactMessage } from "./errors.js";
import { randomToken, sha256 } from "./crypto.js";
import { sendMail, systemMailerConfig } from "./mailer.js";
import type { AuthContext } from "./auth.js";

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Can a verification email be sent at all? False = nothing is restricted. */
export function emailVerificationAvailable(): boolean {
  return !!systemMailerConfig();
}

/** A new single-use token for this user. Returns the token itself; only its hash is stored. */
export async function issueVerificationToken(userId: string, ttlMs: number = VERIFICATION_TTL_MS): Promise<string> {
  const { db } = getDb();
  const token = randomToken(32);
  // Only the newest link works. "Send again" used to leave every earlier link valid for its
  // full 24 hours, while the screen said the opposite; a link forwarded or left in an old
  // inbox stayed usable. Earlier unused links are ended here, before the new one exists.
  await db.execute(sql`UPDATE email_verification_tokens SET expires_at = now() WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > now()`);
  await db.insert(emailVerificationTokens).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  // Housekeeping: links that expired more than a week ago are never read again.
  void db
    .delete(emailVerificationTokens)
    .where(sql`${emailVerificationTokens.expiresAt} < now() - interval '7 days'`)
    .catch(() => {});
  return token;
}

export function verificationLink(token: string): string {
  return `${env.appUrl.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Email this user a verification link. Best-effort: resolves to whether the mail was handed
 * to the provider and never rejects, so a signup or an invite acceptance can call it without
 * caring how it went. Does nothing for a user who is already verified, or when the platform
 * cannot send mail.
 */
export async function sendVerificationEmail(user: Pick<User, "id" | "email" | "emailVerifiedAt">): Promise<{ emailed: boolean }> {
  try {
    if (!emailVerificationAvailable() || user.emailVerifiedAt) return { emailed: false };
    const token = await issueVerificationToken(user.id);
    const r = await sendMail(null, {
      from: env.mailFrom,
      to: user.email,
      subject: "Confirm your email address for Scout",
      text:
        `Welcome to Scout.\n\n` +
        `Confirm that ${user.email} is your address: ${verificationLink(token)}\n\n` +
        `This link works once and expires in 24 hours. Until you confirm, your workspace cannot send team invitations or use Scout's shared sending address; everything else works.\n\n` +
        `If you did not create a Scout account, ignore this email - nothing will be sent from this address.`,
    });
    if (!r.ok) console.warn(`[auth] verification email to user ${user.id} could not be sent: ${redactMessage(String(r.error ?? "unknown error")).slice(0, 200)}`);
    return { emailed: !!r.ok };
  } catch (e) {
    console.warn(`[auth] verification email to user ${user.id} failed: ${errorLine(e).slice(0, 200)}`);
    return { emailed: false };
  }
}

/**
 * The same, with a ceiling on how long the caller waits. Signup awaits the send (so it is
 * not lost on a host that stops work when the response goes out) but must not hang on a
 * mail provider that does: after `maxMs` the signup carries on and the send finishes, or
 * fails, on its own.
 */
export async function sendVerificationEmailWithin(user: Pick<User, "id" | "email" | "emailVerifiedAt">, maxMs = 4000): Promise<{ emailed: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ emailed: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ emailed: false }), maxMs);
  });
  try {
    return await Promise.race([sendVerificationEmail(user), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Spend a verification token. Returns the user it verified, or null when the token is
 * unknown, already used or expired.
 *
 * Claimed in one statement, so two tabs opening the same link cannot both succeed. The
 * user's other outstanding links die with it: once the address is proved they have no use,
 * and a copy sitting in an old mail should not stay live for a day.
 */
export async function confirmVerificationToken(token: unknown): Promise<User | null> {
  if (typeof token !== "string" || token.length < 10 || token.length > 500) return null;
  const { db } = getDb();
  const [claimed] = await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerificationTokens.tokenHash, sha256(token)), isNull(emailVerificationTokens.usedAt), sql`${emailVerificationTokens.expiresAt} > now()`))
    .returning({ userId: emailVerificationTokens.userId });
  if (!claimed) return null;
  const [user] = await db
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.id, claimed.userId))
    .returning();
  if (!user) return null;
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.usedAt)));
  return user;
}

/** The sentence an unverified caller is shown. Names the address the link went to. */
export function unverifiedMessage(email: string): string {
  return `Confirm your email address first - we sent a link to ${email}. You can send it again from the banner at the top.`;
}

/** The workspace's owner (the oldest one, when there are several), or null. */
async function workspaceOwner(orgId: string): Promise<Pick<User, "id" | "email" | "emailVerifiedAt"> | null> {
  const { db } = getDb();
  const rows = await db.select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt, role: users.role, createdAt: users.createdAt }).from(users).where(eq(users.orgId, orgId));
  rows.sort((a, b) => (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1) || a.createdAt.getTime() - b.createdAt.getTime());
  return rows[0] ?? null;
}

/**
 * Whose address must be verified for this caller, and is it? A signed-in person answers for
 * themselves. An API key has no person behind it, so the workspace's owner answers for it.
 * `email` is null when there is nobody to ask (a workspace with no users), which passes.
 */
async function verificationSubject(auth: AuthContext): Promise<{ verified: boolean; email: string | null }> {
  if (auth.user) return { verified: !!auth.user.emailVerifiedAt, email: auth.user.email };
  const owner = await workspaceOwner(auth.org.id);
  return owner ? { verified: !!owner.emailVerifiedAt, email: owner.email } : { verified: true, email: null };
}

/**
 * Is the caller allowed to do the things that need a verified address? True when
 * verification is not available on this deployment (nothing is restricted then).
 */
export async function callerEmailVerified(auth: AuthContext): Promise<boolean> {
  if (!emailVerificationAvailable()) return true;
  return (await verificationSubject(auth)).verified;
}

/**
 * Guard for the actions that make the platform send mail on a workspace's behalf: sending a
 * team invite, adding or using the shared platform sender.
 *
 *   await requireVerifiedEmail(c);
 *
 * Throws 403 `email_unverified` when verification is available and the acting user (or, for
 * an API key, the workspace owner) has not confirmed their address. A no-op otherwise.
 */
export async function requireVerifiedEmail(c: Context): Promise<void> {
  if (!emailVerificationAvailable()) return;
  const auth = (c as unknown as { get: (k: string) => unknown }).get("auth") as AuthContext | undefined;
  if (!auth) return;
  const subject = await verificationSubject(auth);
  if (subject.verified) return;
  throw new ApiError(403, unverifiedMessage(subject.email ?? "your address"), "email_unverified");
}

/**
 * The same question for code with no request in hand (a job about to send through the
 * shared platform sender): has this workspace's owner confirmed their address? True when
 * verification is not available.
 */
export async function workspaceEmailVerified(orgId: string): Promise<boolean> {
  if (!emailVerificationAvailable()) return true;
  const owner = await workspaceOwner(orgId);
  return owner ? !!owner.emailVerifiedAt : true;
}
