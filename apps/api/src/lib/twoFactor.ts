/**
 * Two-factor sign-in for customer accounts: the account-level rules around lib/totp.ts.
 *
 * Opt-in per user. Nothing here applies to an account that has not turned it on.
 *
 * What is stored, and how:
 *  - the TOTP secret, encrypted (AES-256-GCM, lib/crypto.ts) and bound to the user it belongs
 *    to with the AAD `totp:<userId>`: a ciphertext copied onto another user's row does not
 *    decrypt there. A database read alone does not yield a working authenticator;
 *  - the last time step a code was accepted for (`totpLastStep`): a code is good for one use,
 *    so one seen over a shoulder or replayed from a proxy log is already spent;
 *  - recovery codes as sha256 only, each usable once.
 *
 * `totpEnabledAt` is what "on" means. A secret with no `totpEnabledAt` is a setup someone
 * started and has not confirmed with a code yet; it protects nothing and asks for nothing.
 */
import type { Context } from "hono";
import { and, eq, getDb, isNull, sql, userRecoveryCodes, users, type User } from "@prospex/db";
import { ApiError } from "./errors.js";
import { decrypt, encrypt } from "./crypto.js";
import { audit, writeAudit } from "./audit.js";
import { clearLock, humanWait, lockState, recordAttempt, serialised } from "./loginGuard.js";
import { clientIp } from "../middleware.js";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, normaliseRecoveryCode, normaliseTotpCode, otpauthUrl, verifyTotp } from "./totp.js";

type TwoFactorUser = Pick<User, "id" | "email" | "totpSecretEncrypted" | "totpEnabledAt" | "totpLastStep">;

const secretAad = (userId: string) => `totp:${userId}`;

/** Is two-factor sign-in on for this user? */
export function twoFactorEnabled(user: Pick<User, "totpSecretEncrypted" | "totpEnabledAt"> | null | undefined): boolean {
  return !!user?.totpEnabledAt && !!user.totpSecretEncrypted;
}

/** The user's TOTP secret (base32), or null when there is none or it cannot be read. */
function readSecret(user: TwoFactorUser): string | null {
  if (!user.totpSecretEncrypted) return null;
  try {
    return decrypt(user.totpSecretEncrypted, secretAad(user.id));
  } catch {
    // The encryption key was changed without listing the old one. Codes cannot be checked;
    // recovery codes still work, and support can reset two-factor for the account.
    console.warn(`[2fa] the stored authenticator secret for user ${user.id} could not be read (was the encryption key rotated without ENCRYPTION_KEYS_OLD?).`);
    return null;
  }
}

/**
 * Start (or restart) setup: a fresh secret, stored encrypted, NOT enabled. Returns what the
 * settings page shows once - the secret for typing in by hand and the link behind the QR code.
 */
export async function beginTwoFactorSetup(user: Pick<User, "id" | "email">): Promise<{ secret: string; otpauthUrl: string }> {
  const { db } = getDb();
  const secret = generateTotpSecret();
  // Only while it is not on: a setup request racing the one that just enabled two-factor
  // must not swap the secret out from under it.
  const [row] = await db
    .update(users)
    .set({ totpSecretEncrypted: encrypt(secret, secretAad(user.id)), totpLastStep: null })
    .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
    .returning({ id: users.id });
  if (!row) throw new ApiError(409, "Two-factor sign-in is already on. Turn it off first if you want to set it up again.", "two_factor_already_enabled");
  return { secret, otpauthUrl: otpauthUrl(user.email, secret) };
}

/** Replace the user's recovery codes with ten new ones. Returns them; only hashes are stored. */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const { db } = getDb();
  const codes = generateRecoveryCodes();
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await db.insert(userRecoveryCodes).values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
  return codes;
}

/** How many of the user's recovery codes are still unused. */
export async function recoveryCodesLeft(userId: string): Promise<number> {
  const { db } = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(userRecoveryCodes).where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return n;
}

/** Turn two-factor off and forget everything about it: the secret, the last step, the recovery codes. */
export async function clearTwoFactor(userId: string): Promise<void> {
  const { db } = getDb();
  await db.update(users).set({ totpSecretEncrypted: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, userId));
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
}

export type SecondFactorMethod = "totp" | "recovery";

/**
 * Check a typed code against the account, and SPEND it when it is right.
 *
 * Six digits are an authenticator code: checked against the secret, and its time step is
 * claimed in one UPDATE that only succeeds while the stored step is older - so a code cannot
 * be used twice, not even by two requests arriving together. Anything else is tried as a
 * recovery code, claimed the same way (set `used_at` where it is still null).
 *
 * This only answers whether the code was good. Counting failures and locking is the
 * caller's: sign-in uses the account's login lock, everything else `confirmSecondFactor`.
 */
export async function checkSecondFactor(user: TwoFactorUser, code: unknown, opts: { allowRecovery?: boolean } = {}): Promise<SecondFactorMethod | null> {
  const { db } = getDb();
  if (normaliseTotpCode(code)) {
    const secret = readSecret(user);
    if (!secret) return null;
    const step = verifyTotp(secret, code, { afterStep: user.totpLastStep ?? null });
    if (step === null) return null;
    const [claimed] = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, user.id), sql`(${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`))
      .returning({ id: users.id });
    return claimed ? "totp" : null;
  }
  if (opts.allowRecovery === false) return null;
  const recovery = normaliseRecoveryCode(code);
  if (!recovery) return null;
  const [spent] = await db
    .update(userRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(userRecoveryCodes.userId, user.id), eq(userRecoveryCodes.codeHash, hashRecoveryCode(recovery)), isNull(userRecoveryCodes.usedAt)))
    .returning({ id: userRecoveryCodes.id });
  return spent ? "recovery" : null;
}

export const CODE_REQUIRED_MESSAGE = "Enter the 6-digit code from your authenticator app, or one of your recovery codes.";
export const CODE_WRONG_MESSAGE = "That code is not correct. Enter the current 6-digit code from your authenticator app, or a recovery code you have not used yet.";

/**
 * Confirm a sensitive action by a SIGNED-IN user with their second factor.
 *
 *   if (twoFactorEnabled(user)) await confirmSecondFactor(c, user, body.code, "auth.password_changed");
 *
 * Used where a stolen session must not be enough: changing the password, turning two-factor
 * off, issuing new recovery codes - and available to any other route that needs the same
 * (deleting a workspace, exporting it).
 *
 * Throws:
 *   400 two_factor_code_required  no code was sent;
 *   429 too_many_attempts         five wrong codes in fifteen minutes (Retry-After is set);
 *   403 invalid_2fa_code          the code is wrong, already used or expired. 403, not 401:
 *                                 the session is fine, and the web app reads a 401 as
 *                                 "signed out".
 *
 * Wrong codes are counted per user under their own key - not the sign-in lock, so a stranger
 * failing sign-ins cannot stop the owner confirming, and whoever holds the session gets five
 * guesses in total however many addresses they come from. One check at a time per user.
 *
 * `pendingSetup` is for the one caller that checks a code BEFORE two-factor is on (enabling
 * it): authenticator codes only, against the secret that setup just stored.
 */
export async function confirmSecondFactor(c: Context, user: User, code: string | null | undefined, action: string, opts: { pendingSetup?: boolean } = {}): Promise<SecondFactorMethod> {
  if (!code || !String(code).trim()) throw new ApiError(400, opts.pendingSetup ? "Enter the 6-digit code your authenticator app shows." : CODE_REQUIRED_MESSAGE, "two_factor_code_required");
  const method = await countedCheck(user, code, { ip: clientIp(c), pendingSetup: opts.pendingSetup, onLocked: (seconds) => c.header("retry-after", String(seconds)) });
  if (!method) {
    await audit(c, "auth.2fa_failed", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, result: "failed", data: { during: action } });
    throw new ApiError(403, opts.pendingSetup ? "That code is not correct. Enter the 6-digit code your authenticator app shows right now." : CODE_WRONG_MESSAGE, "invalid_2fa_code");
  }
  return method;
}

/**
 * The check behind confirmSecondFactor: one at a time per user, refused outright after five
 * wrong codes in fifteen minutes (429, thrown), a failure counted when the code is wrong.
 * Returns how the code was accepted, or null when it was not.
 */
async function countedCheck(user: User, code: string, opts: { ip: string | null; pendingSetup?: boolean; onLocked?: (retryAfterSeconds: number) => void }): Promise<SecondFactorMethod | null> {
  const key = `2fa:${user.id}`;
  return serialised(key, async () => {
    const lock = await lockState(key);
    if (lock.locked) {
      opts.onLocked?.(lock.retryAfterSeconds);
      throw new ApiError(429, `Too many wrong codes. Try again ${humanWait(lock.retryAfterSeconds)}.`, "too_many_attempts", { retryAfterSeconds: lock.retryAfterSeconds });
    }
    // The row as it is now, not as it was when the session was read: the step claimed by a
    // request a moment ago must count.
    const { db } = getDb();
    const fresh = (await db.query.users.findFirst({ where: eq(users.id, user.id) })) ?? user;
    const method = await checkSecondFactor(fresh, code, { allowRecovery: !opts.pendingSetup });
    if (!method) {
      await recordAttempt(key, opts.ip, false);
      return null;
    }
    await clearLock(key).catch(() => {});
    return method;
  });
}

/**
 * The same confirmation for code that has a user and a code but no request in hand, as a
 * plain yes or no: true when two-factor is on for the user and the code (an authenticator
 * code or a recovery code) is right. The code is spent when it is.
 *
 * Wrong codes are counted exactly as in confirmSecondFactor and written to the workspace's
 * security log; after five in fifteen minutes this THROWS 429 `too_many_attempts` instead of
 * answering, so a caller that lets errors reach the error handler gets the right response
 * without doing anything. Also reachable as `verifySecondFactor` from lib/auth.ts.
 */
export async function verifySecondFactor(user: User, code: string, opts: { ip?: string | null; during?: string } = {}): Promise<boolean> {
  if (!twoFactorEnabled(user) || typeof code !== "string" || !code.trim()) return false;
  const method = await countedCheck(user, code, { ip: opts.ip ?? null });
  if (!method) {
    await writeAudit({ action: "auth.2fa_failed", orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, result: "failed", ip: opts.ip ?? null, data: { during: opts.during ?? "account.confirmation" } });
    return false;
  }
  return true;
}
