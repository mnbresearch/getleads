import type { User } from "@prospex/db";
import { checkPassword, hasUsablePassword, verifySecondFactor } from "../lib/auth.js";

/** Does this user sign in with a second factor? (The same rule the sign-in code applies.) */
export function twoFactorEnabled(user: Pick<User, "totpEnabledAt" | "totpSecretEncrypted">): boolean {
  return !!user.totpEnabledAt && !!user.totpSecretEncrypted;
}

export type Reconfirmation = { ok: true; method: "password" | "code" } | { ok: false; status: 400 | 401; code: string; message: string };

/**
 * "Is this really the account owner, right now?" - asked again before an export or a
 * deletion, because a session left open on a shared machine should not be enough for either.
 *
 *  - an account with two-factor sign-in on is asked for a code (an authenticator code or a
 *    recovery code);
 *  - any other account is asked for its password;
 *  - an account that has neither (it signs in with Google and never set a password) is told
 *    how to get one, since there is nothing to check.
 */
export async function reconfirmIdentity(user: User, given: { password?: string | null; code?: string | null }, ctx: { ip?: string | null; during?: string } = {}): Promise<Reconfirmation> {
  if (twoFactorEnabled(user)) {
    const code = typeof given.code === "string" ? given.code.trim() : "";
    if (!code) return { ok: false, status: 400, code: "confirmation_required", message: "Enter the 6-digit code from your authenticator app (or a recovery code) to confirm." };
    // The sign-in code's own check: an authenticator code cannot be replayed, a recovery
    // code works once, and wrong codes are counted (it throws 429 after too many).
    return (await verifySecondFactor(user, code, { ip: ctx.ip ?? null, during: ctx.during }))
      ? { ok: true, method: "code" }
      : { ok: false, status: 401, code: "invalid_2fa_code", message: "That code is not correct or has already been used. Enter the current code from your authenticator app, or a recovery code you have not used yet." };
  }
  if (!hasUsablePassword(user.passwordHash)) {
    return { ok: false, status: 400, code: "password_not_set", message: 'This account signs in with Google and has no password to confirm with. Set a password first (use "Forgot password" on the sign-in page) or turn on two-factor sign-in, then try again.' };
  }
  const password = typeof given.password === "string" ? given.password : "";
  if (!password) return { ok: false, status: 400, code: "confirmation_required", message: "Enter your password to confirm." };
  return (await checkPassword(password, user.passwordHash)) ? { ok: true, method: "password" } : { ok: false, status: 401, code: "invalid_password", message: "That password is not correct." };
}
