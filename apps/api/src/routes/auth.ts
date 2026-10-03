import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, apiKeys, desc, effectiveLimits, eq, getDb, isNull, limitsFor, oauthExchangeCodes, organizations, passwordResetTokens, sql, users } from "@prospex/db";
import { env } from "../env.js";
import { burnPasswordCheck, checkPassword, generateApiKey, hashPassword, hasUsablePassword, issueJwt, passwordProblem, unusablePasswordHash } from "../lib/auth.js";
import {
  challengeFor,
  exchangeCode,
  googleAuthConfigured,
  googleAuthUrl,
  isValidCodeChallenge,
  makeState,
  readState,
  resolveGoogleUser,
  safeNext,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  STATE_TTL,
  type GoogleIdentity,
  type GoogleResolution,
} from "../lib/googleAuth.js";
import { ApiError, badRequest, notFound, requireSomeFields } from "../lib/errors.js";
import { clientIp, rateLimit, requireAuth, requireRole, requireUser, type Env } from "../middleware.js";
import { randomToken, safeEqual, sha256 } from "../lib/crypto.js";
import { sendMail } from "../lib/mailer.js";
import { emitEvent } from "../lib/events.js";
import { audit } from "../lib/audit.js";
import { attemptQueue, clearLock, forgetOtherKnownAddresses, humanWait, lockedError, lockState, recordAttempt, serialised, shouldAuditLock } from "../lib/loginGuard.js";

export const authRoutes = new Hono<Env>();

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

/**
 * A NUL byte cannot be stored in a Postgres text column. One in a name or an email reached
 * the INSERT and came back as a 500 whose logged error carried the whole statement -
 * including the freshly computed password hash. Refused here, as the bad input it is.
 */
const NO_NUL = "contains a character that cannot be used";
const clean = (v: string) => !v.includes("\u0000");
const text = (max: number, min = 0) => z.string().min(min).max(max).refine(clean, NO_NUL);
const emailField = z.string().max(254).email().refine(clean, NO_NUL);
/** A NEW password. The floor is in the schema; the rest of the policy is passwordProblem(). */
const newPasswordField = z.string().min(8).refine(clean, NO_NUL);
/** A password being CHECKED: no policy (old passwords must keep working), only sanity bounds. */
const presentedPasswordField = z.string().max(4096).refine(clean, NO_NUL);

/**
 * Refuse a JSON body with a NUL anywhere in it, before validation.
 *
 * The shared validator strips NULs from input, which is right for a lead's name and wrong for
 * a credential: a password or an email address must be used exactly as typed or not at all -
 * quietly removing a character would sign someone up with a password they did not choose, or
 * aim a login at a different address. So on these routes it is a 400.
 */
const hasNul = (v: unknown, depth = 0): boolean =>
  typeof v === "string" ? v.includes("\u0000") : !!v && typeof v === "object" && depth < 4 && Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes("\u0000") || hasNul(x, depth + 1));
const rejectNul: MiddlewareHandler<Env> = async (c, next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Not JSON: the validator answers that.
  }
  if (hasNul(body)) throw new ApiError(400, "The request contains a character that cannot be used.", "validation_error");
  await next();
};

function assertAcceptablePassword(password: string, ctx: { email?: string | null } = {}) {
  const problem = passwordProblem(password, ctx);
  if (problem) throw new ApiError(400, problem, "weak_password");
}

authRoutes.post(
  "/signup",
  rateLimit({ perMinute: 10 }),
  rejectNul,
  zValidator("json", z.object({ email: emailField, password: newPasswordField, name: text(80, 1).optional(), orgName: text(80, 1).optional(), inviteCode: text(200).optional() })),
  async (c) => {
    const body = c.req.valid("json");
    if (env.pilotInviteCode && body.inviteCode !== env.pilotInviteCode) throw new ApiError(403, "Invalid invite code", "invalid_invite");
    const email = body.email.toLowerCase();
    assertAcceptablePassword(body.password, { email });
    const { db } = getDb();
    const exists = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (exists) throw badRequest("Email already registered");
    const orgName = body.orgName ?? `${body.name ?? body.email.split("@")[0]}'s workspace`;
    let slug = slugify(orgName);
    if (await db.query.organizations.findFirst({ where: eq(organizations.slug, slug) })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const plan = env.defaultPlan;
    const [org] = await db.insert(organizations).values({ name: orgName, slug, plan, planLimits: limitsFor(plan) }).returning();
    // `emailVerifiedAt` is deliberately NOT set: typing an address into this form proves
    // nothing about who owns it. It is set by a completed password reset or a Google sign-in.
    // (Accounts that existed before migration 0018 were marked verified by that migration;
    // that is a one-off for the existing customer base, not something signup does.)
    const [user] = await db.insert(users).values({ orgId: org.id, email, passwordHash: await hashPassword(body.password), name: body.name ?? "", role: "owner", lastLoginAt: new Date() }).returning();
    const key = generateApiKey();
    await db.insert(apiKeys).values({ orgId: org.id, name: "Default", prefix: key.prefix, keyHash: key.hash });
    await emitEvent(org.id, "org.created", { orgId: org.id, email: user.email });
    await audit(c, "auth.signup", { orgId: org.id, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, data: { email: user.email, via: "password" } });
    // The address that chose the password is known for the account from the start, so a
    // stranger's wrong guesses cannot lock the new owner out before their first sign-in.
    await recordAttempt(email, clientIp(c), true).catch(() => {});
    return c.json({ token: await issueJwt(user), user: publicUser(user), org: publicOrg(org), apiKey: key.raw }, 201);
  },
);

/**
 * The body every successful sign-in returns (login, password reset, Google exchange). A
 * suspended org is refused HERE: login used to issue a token that every other route then
 * rejected, so the person saw a working sign-in followed by an app that failed on every
 * click, with no explanation.
 */
async function sessionFor(user: typeof users.$inferSelect) {
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, user.orgId) });
  if (!org) throw new ApiError(401, "Invalid email or password", "invalid_credentials");
  if (org.status === "deactivated" || org.status === "revoked") {
    throw new ApiError(403, "This account has been suspended. Contact support to reactivate it.", "account_suspended");
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { token: await issueJwt(user), user: publicUser(user), org: publicOrg(org) };
}

/**
 * Password sign-in.
 *
 * Order of checks, and why:
 *  1. the per-IP limiter (one address hammering the form);
 *  2. the per-ACCOUNT lock, before the password is even looked at - five failures in fifteen
 *     minutes from anywhere, so rotating addresses buys nothing;
 *  3. the password. An unknown address, or an account with no password, still costs one
 *     bcrypt comparison, so the response time does not say whether the account exists.
 */
authRoutes.post("/login", rateLimit({ perMinute: 20 }), rejectNul, zValidator("json", z.object({ email: emailField, password: presentedPasswordField })), async (c) => {
  const body = c.req.valid("json");
  const email = body.email.toLowerCase();
  const ip = clientIp(c);
  return serialised(await attemptQueue("user", email, ip), async () => {
    const { db } = getDb();
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    const lock = await lockState(email, ip);
    if (lock.locked) {
      // Logged against the workspace (so its owner can see it), once a minute at most. A lock
      // on an address with no account is not logged at all: it would be a row nobody can
      // read, and a way to fill the table.
      if (user && shouldAuditLock(email)) {
        await audit(c, "auth.login_locked", { orgId: user.orgId, actorType: "anonymous", actorUserId: null, targetType: "user", targetId: user.id, result: "denied", data: { email, retryAfterSeconds: lock.retryAfterSeconds } });
      }
      c.header("retry-after", String(lock.retryAfterSeconds));
      throw lockedError(lock);
    }
    let ok = false;
    if (user && hasUsablePassword(user.passwordHash)) ok = await checkPassword(body.password, user.passwordHash);
    else await burnPasswordCheck(body.password);
    if (!user || !ok) {
      await recordAttempt(email, ip, false);
      // The reason is for the log only; the response is the same sentence in every case.
      const reason = !user ? "unknown_account" : !hasUsablePassword(user.passwordHash) ? "no_password_set" : "wrong_password";
      // No actor: whoever typed this is not known to be the account's owner. The account is
      // the target. A failure for an address with no account is kept in login_attempts
      // (address, IP, time; pruned after a day) and not in the audit log, which has no
      // workspace to show it to and would otherwise grow with every sprayed address.
      if (user) await audit(c, "auth.login", { orgId: user.orgId, actorType: "anonymous", actorUserId: null, targetType: "user", targetId: user.id, result: "failed", data: { email, reason } });
      throw new ApiError(401, "Invalid email or password", "invalid_credentials");
    }
    let session;
    try {
      session = await sessionFor(user);
    } catch (e) {
      // The password was right; the workspace is suspended. Not a guess, so it does not count
      // towards the lock, but it is worth a line in the log.
      await recordAttempt(email, ip, true);
      await audit(c, "auth.login", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, result: "denied", data: { email, reason: e instanceof ApiError ? e.code : "error" } });
      throw e;
    }
    await recordAttempt(email, ip, true);
    await audit(c, "auth.login", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, result: "ok", data: { email, via: "password" } });
    return c.json(session);
  });
});

// ── Password reset & change ──
//
// Tokens are 32 random bytes, shown once in the emailed link; only their sha256 is stored, so
// a database read does not yield a usable link. One hour, one use.
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Always answers 200 with the same body, whether or not the address has an account -
 * otherwise this endpoint is a free "is this person a customer?" oracle. Rate-limited per
 * IP, and the mail itself is not sent more than once a minute per account.
 */
authRoutes.post("/password/forgot", rateLimit({ perMinute: 5, name: "password-forgot" }), rejectNul, zValidator("json", z.object({ email: emailField })), async (c) => {
  const { db } = getDb();
  const email = c.req.valid("json").email.toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (user) {
    const recent = await db.query.passwordResetTokens.findFirst({ where: and(eq(passwordResetTokens.userId, user.id), sql`${passwordResetTokens.createdAt} > now() - interval '1 minute'`) });
    if (!recent) {
      const token = randomToken(32);
      await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
      const link = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
      const r = await sendMail(null, {
        from: env.mailFrom,
        to: user.email,
        subject: "Reset your Scout password",
        text: `Someone (hopefully you) asked to reset the password for ${user.email} on Scout.\n\nSet a new password: ${link}\n\nThis link works once and expires in 1 hour. If you did not ask for this, ignore this email - your password has not changed.`,
      }).catch((e) => ({ ok: false, error: (e as Error).message }));
      // Logged, not returned: the response must look the same either way.
      if (!r.ok) console.error(`[auth] password reset email to user ${user.id} failed: ${r.error}`);
      await audit(c, "auth.password_reset_requested", { orgId: user.orgId, actorType: "anonymous", actorUserId: null, targetType: "user", targetId: user.id, result: r.ok ? "ok" : "failed", data: { email, emailed: !!r.ok } });
    }
  }
  return c.json({ ok: true });
});

/**
 * Set a new password from an emailed token, then sign in (same body as /login).
 *
 * Completing a reset proves control of the mailbox, so it also: marks the address verified,
 * signs out every other session (token version bump - the reason people reset is often that
 * someone else may be signed in), and lifts a sign-in lock on the account.
 */
authRoutes.post("/password/reset", rateLimit({ perMinute: 10, name: "password-reset" }), rejectNul, zValidator("json", z.object({ token: text(500, 10), password: newPasswordField })), async (c) => {
  const { db } = getDb();
  const b = c.req.valid("json");
  const invalid = () => new ApiError(400, "This reset link is invalid or has expired. Request a new one.", "invalid_reset_token");
  const row = await db.query.passwordResetTokens.findFirst({ where: eq(passwordResetTokens.tokenHash, sha256(b.token)) });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) throw invalid();
  const owner = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!owner) throw invalid();
  // Checked BEFORE the link is spent: a rejected password must not cost the person their link.
  assertAcceptablePassword(b.password, { email: owner.email });
  // Claimed atomically, so two tabs submitting the same link cannot both succeed.
  const [claimed] = await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt))).returning();
  if (!claimed) throw new ApiError(400, "This reset link has already been used. Request a new one.", "invalid_reset_token");
  const [user] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(b.password), tokenVersion: sql`${users.tokenVersion} + 1`, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.id, row.userId))
    .returning();
  if (!user) throw invalid();
  // Any other outstanding link for this account dies with this one.
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
  // The old password is gone, and so is the standing of every address that proved it: an
  // address that was "known" for this account (it signed in with the old password) must not
  // keep its own allowance of guesses at the new one. Only this address stays known.
  await forgetOtherKnownAddresses(user.email, clientIp(c)).catch((e) => console.warn(`[auth] could not clear known sign-in addresses after a password reset: ${(e as Error).message}`));
  await clearLock(user.email, clientIp(c));
  await audit(c, "auth.password_reset", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, data: { email: user.email, sessionsRevoked: true } });
  // `user` is the updated row, so the token issued here carries the new version.
  return c.json(await sessionFor(user));
});

/**
 * Change the password of the signed-in user. The current password is required - a stolen
 * session must not be enough to lock the owner out - except for an account that has never
 * had one (created through Google), which has nothing to confirm.
 *
 * Every other session is signed out (token version bump). The response carries a fresh
 * `token` for THIS browser, which must replace the one it holds - the old one stops working
 * with this request.
 */
authRoutes.post("/password/change", requireAuth, requireUser, rateLimit({ perMinute: 10, name: "password-change" }), rejectNul, zValidator("json", z.object({ currentPassword: presentedPasswordField.optional(), newPassword: newPasswordField })), async (c) => {
  const { db } = getDb();
  const user = c.get("auth").user!;
  const b = c.req.valid("json");
  const hadPassword = hasUsablePassword(user.passwordHash);
  if (hadPassword) {
    if (!b.currentPassword) throw new ApiError(400, "Enter your current password to set a new one.", "current_password_required");
    // A stolen session must not be a way to guess the current password without limit either,
    // so wrong guesses here are limited too - under their own key. Sharing the login form's
    // lock meant a stranger failing five sign-ins stopped the signed-in owner changing their
    // own password.
    // Judged per user, not per address: whoever holds this session gets five guesses in
    // fifteen minutes in total, however many addresses they come from. One check at a time,
    // so parallel requests cannot all slip in under the count.
    const changeKey = `pwchange:${user.id}`;
    const currentPassword = b.currentPassword;
    await serialised(changeKey, async () => {
      const lock = await lockState(changeKey);
      if (lock.locked) {
        c.header("retry-after", String(lock.retryAfterSeconds));
        throw new ApiError(429, `Too many wrong attempts at your current password. Try again ${humanWait(lock.retryAfterSeconds)}, or sign out and use "Forgot password".`, "too_many_attempts", { retryAfterSeconds: lock.retryAfterSeconds });
      }
      if (!(await checkPassword(currentPassword, user.passwordHash))) {
        await recordAttempt(changeKey, clientIp(c), false);
        await audit(c, "auth.password_changed", { result: "failed", targetType: "user", targetId: user.id, data: { reason: "wrong_current_password" } });
        throw new ApiError(403, "Your current password is not correct.", "invalid_credentials");
      }
    });
  }
  assertAcceptablePassword(b.newPassword, { email: user.email });
  const [updated] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(b.newPassword), tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, user.id))
    .returning();
  // Outstanding reset links were issued for the old password; they should not outlive it.
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
  await audit(c, "auth.password_changed", { targetType: "user", targetId: user.id, data: { hadPassword, sessionsRevoked: true } });
  // Same as a reset: addresses that were known for the OLD password are forgotten, whether or
  // not there was a password before (an account claimed through Google sets its first one here).
  await forgetOtherKnownAddresses(user.email, clientIp(c)).catch((e) => console.warn(`[auth] could not clear known sign-in addresses after a password change: ${(e as Error).message}`));
  if (hadPassword) {
    // They proved the old password. Earlier wrong guesses - here or on the login form - were
    // at a password that no longer exists, and this address has earned being known.
    await clearLock(`pwchange:${user.id}`).catch(() => {});
    await clearLock(user.email, clientIp(c)).catch(() => {});
  }
  return c.json({ ok: true, token: await issueJwt(updated ?? user), sessionsRevoked: true });
});

/**
 * Sign out everywhere: every session token issued for this user stops working, including
 * the one that made this call. API keys are workspace credentials, not sessions, and are
 * not touched - revoke those under Settings.
 */
authRoutes.post("/logout-all", requireAuth, requireUser, rateLimit({ perMinute: 10, name: "logout-all" }), async (c) => {
  const { db } = getDb();
  const user = c.get("auth").user!;
  await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, user.id));
  await audit(c, "auth.logout_all", { targetType: "user", targetId: user.id });
  return c.json({ ok: true });
});


// ── Sign in with Google ──
//
// /start signs a state, pins it to this browser with a cookie and bounces to Google.
// /callback checks the state against the cookie, resolves the account and hands the web app
// a one-time code. /exchange trades that code (plus the web app's verifier) for the session.
// The security reasoning lives in lib/googleAuth.ts, which is where the risky decisions are.

/** Whether the web app should show the Google button at all. */
authRoutes.get("/google/status", (c) => c.json({ enabled: googleAuthConfigured() }));

const appBase = () => env.appUrl.replace(/\/$/, "");
const loginError = (c: Context, reason: string) => c.redirect(`${appBase()}/login?error=${encodeURIComponent(reason)}`);
const stateCookieOptions = () => ({ path: STATE_COOKIE_PATH, httpOnly: true, secure: env.nodeEnv === "production", sameSite: "Lax" as const });

/**
 * The state cookie.
 *
 * The API and the web app are on different sites, which is fine here: this cookie is set and
 * read only on the API's own origin, during top-level navigations (the browser goes to
 * /start, on to Google, and back to /callback). SameSite=Lax cookies are sent on a top-level
 * GET navigation arriving from another site, which is exactly what the return from Google
 * is; they are NOT sent on cross-site fetch/XHR, so this cookie never takes part in an API
 * call from the web app (and CORS on this API never allows credentials). HttpOnly, scoped to
 * /v1/auth/google, ten minutes.
 */
authRoutes.get("/google/start", rateLimit({ perMinute: 30 }), async (c) => {
  if (!googleAuthConfigured()) throw badRequest("Google sign-in is not configured");
  const cv = c.req.query("cv");
  // Without a verifier hash there is nothing to bind the one-time code to. An old copy of
  // the web app (cached before this flow existed) lands here; send it back to reload.
  if (!isValidCodeChallenge(cv)) return loginError(c, "Google sign-in needs a fresh page. Reload this page and try again.");
  const { state, nonce } = await makeState(c.req.query("next") ?? "/", cv);
  setCookie(c, STATE_COOKIE, nonce, { ...stateCookieOptions(), maxAge: STATE_TTL });
  c.header("cache-control", "no-store");
  return c.redirect(googleAuthUrl(state));
});

const EXCHANGE_CODE_TTL_MS = 60 * 1000;

/**
 * Google sends the browser here.
 *
 * Every failure path redirects back to the app with a short reason rather than rendering an
 * API error page: the person is in a browser mid-sign-in, and a raw JSON 400 is a dead end
 * for them. What leaves in the URL fragment is a one-time code, not a session: a fragment is
 * never sent to a server, and even if this one is seen it is worthless without the verifier
 * the web app kept in its own storage.
 */
authRoutes.get("/google/callback", rateLimit({ perMinute: 30 }), async (c) => {
  const cookieNonce = getCookie(c, STATE_COOKIE);
  // One attempt per cookie, whatever happens next.
  deleteCookie(c, STATE_COOKIE, stateCookieOptions());
  c.header("cache-control", "no-store");
  const fail = (reason: string) => loginError(c, reason);

  if (!googleAuthConfigured()) return fail("Google sign-in is not configured");
  // Google reports a user who cancelled as an error rather than an absent code.
  if (c.req.query("error")) return fail(c.req.query("error") === "access_denied" ? "Sign-in cancelled" : "Google could not complete the sign-in");

  const code = c.req.query("code");
  if (!code) return fail("Google did not return an authorization code");

  let next = "/";
  let cv = "";
  let identity: GoogleIdentity;
  try {
    // State first: nothing is sent to Google for a callback this browser did not start.
    const state = await readState(c.req.query("state"), cookieNonce);
    next = state.next;
    cv = state.cv;
    identity = await exchangeCode(code);
  } catch (e) {
    return fail(e instanceof ApiError ? e.message : "Sign-in failed");
  }

  const { db } = getDb();
  let resolved: GoogleResolution;
  try {
    resolved = await resolveGoogleUser(identity, { ip: clientIp(c) });
  } catch (e) {
    await audit(c, "auth.google_login", { orgId: null, actorType: "anonymous", result: "denied", data: { email: identity.email, reason: e instanceof ApiError ? e.code : "error" } });
    return fail(e instanceof ApiError ? e.message : "Sign-in failed");
  }
  let user = resolved.user;
  let created = false;

  if (!user) {
    // First time through: same workspace bootstrap as a password signup, minus the password.
    if (env.pilotInviteCode) return fail("Signing up with Google needs an invite code. Please use the signup form.");
    const orgName = `${identity.name || identity.email.split("@")[0]}'s workspace`.replace(/\u0000/g, "");
    let slug = slugify(orgName);
    if (await db.query.organizations.findFirst({ where: eq(organizations.slug, slug) })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const plan = env.defaultPlan;
    const [org] = await db.insert(organizations).values({ name: orgName, slug, plan, planLimits: limitsFor(plan) }).returning();
    // A random unusable password rather than an empty hash: the password login path compares
    // against this, and an empty or predictable value there would be a way in.
    // Marked as "no password yet" (see lib/auth.ts), so password change can let them set one
    // without asking for a current password they never had.
    const unusable = await unusablePasswordHash(`google:${identity.sub}`);
    [user] = await db
      .insert(users)
      .values({ orgId: org.id, email: identity.email, passwordHash: unusable, name: (identity.name || "").replace(/\u0000/g, ""), role: "owner", lastLoginAt: new Date(), googleSub: identity.sub, emailVerifiedAt: new Date() })
      .returning();
    const key = generateApiKey();
    await db.insert(apiKeys).values({ orgId: org.id, name: "Default", prefix: key.prefix, keyHash: key.hash });
    await emitEvent(org.id, "org.created", { orgId: org.id, email: user.email, via: "google" });
    created = true;
    await audit(c, "auth.signup", { orgId: org.id, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, data: { email: user.email, via: "google" } });
  } else {
    await db.update(users).set({ lastLoginAt: new Date(), ...(user.name ? {} : { name: (identity.name || "").replace(/\u0000/g, "") }) }).where(eq(users.id, user.id));
  }

  if (resolved.match === "claimed_unverified" && resolved.claim) {
    await audit(c, "auth.google_claimed_unverified_account", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, data: { email: user.email, ...resolved.claim, passwordDisabled: true, sessionsRevoked: true } });
    // Told by email as well: if this was the same person all along, their password and
    // (working alone) their API keys just stopped working, and they need to know why.
    void sendMail(null, {
      from: env.mailFrom,
      to: user.email,
      subject: "Your Scout account is now linked to Google",
      text:
        `You just signed in to Scout with Google as ${user.email}.\n\n` +
        `An account with this address already existed, created with a password, and nobody had ever confirmed that its owner controls this mailbox. ` +
        `To make sure only you can use it, we:\n` +
        `- turned off the old password (set a new one any time under Settings > Password),\n` +
        `- signed out every other session` +
        (resolved.claim.apiKeysRevoked > 0 ? `,\n- revoked ${resolved.claim.apiKeysRevoked} API key(s) (create new ones under Settings > API keys).\n` : `.\n`) +
        (resolved.claim.otherUsers > 0 ? `\nThis workspace has ${resolved.claim.otherUsers} other member(s); review them under Settings > Team if you do not recognise them.\n` : ``) +
        `\nIf you created that account yourself, nothing else has changed and your data is where you left it. If you did not, someone else had registered your address; they can no longer sign in, but review the workspace (webhooks, integrations, team) before using it.`,
    }).catch(() => {});
  }

  // One-time code: 32 random bytes, only the hash stored, 60 seconds, bound to the verifier hash.
  const handoff = randomToken(32);
  await db.insert(oauthExchangeCodes).values({ codeHash: sha256(handoff), userId: user.id, verifierHash: cv, expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS) });
  // Housekeeping: spent and expired codes are never read again.
  void db
    .delete(oauthExchangeCodes)
    .where(sql`${oauthExchangeCodes.expiresAt} < now() - interval '1 hour'`)
    .catch(() => {});
  await audit(c, "auth.google_login", { orgId: user.orgId, actorType: "user", actorUserId: user.id, targetType: "user", targetId: user.id, result: "ok", data: { email: user.email, match: created ? "created" : resolved.match, step: "callback" } });
  return c.redirect(`${appBase()}/auth/google#code=${encodeURIComponent(handoff)}&next=${encodeURIComponent(safeNext(next))}`);
});

/**
 * Trade the one-time code from the Google callback for a session (same body as /login).
 *
 * The caller must present the verifier whose hash it sent to /google/start. That is what
 * makes a code useless to anyone but the browser that started the flow: a link with somebody
 * else's code in it cannot be redeemed, because that browser does not hold the verifier.
 * Single use: the code is spent by the first attempt to redeem it, right or wrong.
 */
authRoutes.post("/google/exchange", rateLimit({ perMinute: 30, name: "google-exchange" }), rejectNul, zValidator("json", z.object({ code: text(200, 20), verifier: text(200, 20) })), async (c) => {
  if (!googleAuthConfigured()) throw badRequest("Google sign-in is not configured");
  const b = c.req.valid("json");
  const { db } = getDb();
  const invalid = () => new ApiError(400, "This sign-in could not be completed. Please start again.", "invalid_exchange_code");
  c.header("cache-control", "no-store");
  // Spent atomically, before anything is compared: no second try, and no race between tabs.
  const [row] = await db
    .update(oauthExchangeCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthExchangeCodes.codeHash, sha256(b.code)), isNull(oauthExchangeCodes.usedAt)))
    .returning();
  if (!row) throw invalid();
  if (row.expiresAt.getTime() <= Date.now()) throw invalid();
  if (!safeEqual(challengeFor(b.verifier), row.verifierHash)) {
    await audit(c, "auth.google_login", { orgId: null, actorType: "anonymous", targetType: "user", targetId: row.userId, result: "denied", data: { reason: "verifier_mismatch", step: "exchange" } });
    throw invalid();
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) throw invalid();
  return c.json(await sessionFor(user));
});

authRoutes.get("/me", requireAuth, async (c) => {
  const a = c.get("auth");
  return c.json({ user: a.user ? publicUser(a.user) : null, org: publicOrg(a.org), via: a.via, apiKey: a.apiKey ? { id: a.apiKey.id, name: a.apiKey.name, prefix: a.apiKey.prefix } : null });
});

/**
 * Workspace settings are free-form, but not unbounded: they are read on every AI draft and
 * every send, and a 900 KB "value proposition" was accepted and then pattern-matched on each
 * request. At most 60 keys, text values up to 5,000 characters, 32 KB in total.
 */
const orgSettingsInput = z
  .record(z.string().max(60), z.unknown())
  .refine((s) => Object.keys(s).length <= 60, "Too many settings (60 at most).")
  .refine((s) => Object.values(s).every((v) => typeof v !== "string" || v.length <= 5000), "A setting's text is too long (5,000 characters at most).")
  .refine((s) => JSON.stringify(s).length <= 32_000, "Settings are too large (32 KB at most).");

authRoutes.patch("/org", requireAuth, requireUser, requireRole("owner", "admin"), zValidator("json", z.object({ name: text(80, 1).optional(), settings: orgSettingsInput.optional() })), async (c) => {
  const a = c.get("auth");
  const body = c.req.valid("json");
  requireSomeFields(body);
  const { db } = getDb();
  const [org] = await db
    .update(organizations)
    .set({ ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: { ...a.org.settings, ...body.settings } } : {}) })
    .where(eq(organizations.id, a.org.id))
    .returning();
  // Setting NAMES only: the values are free-form and may hold things that do not belong in a log.
  await audit(c, "org.settings_changed", {
    targetType: "organization",
    targetId: a.org.id,
    data: { ...(body.name && body.name !== a.org.name ? { name: { before: a.org.name, after: body.name } } : {}), ...(body.settings ? { settingsChanged: Object.keys(body.settings).slice(0, 50) } : {}) },
  });
  return c.json({ org: publicOrg(org) });
});

// ── API keys ──
authRoutes.get("/api-keys", requireAuth, requireUser, async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, c.get("auth").org.id)).orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, createdAt: k.createdAt })) });
});

authRoutes.post("/api-keys", requireAuth, requireUser, requireRole("owner", "admin"), zValidator("json", z.object({ name: text(60, 1) })), async (c) => {
  const { db } = getDb();
  const key = generateApiKey();
  const [row] = await db.insert(apiKeys).values({ orgId: c.get("auth").org.id, name: c.req.valid("json").name, prefix: key.prefix, keyHash: key.hash }).returning();
  // The prefix identifies the key in the list; the key itself is never logged.
  await audit(c, "apikey.created", { targetType: "api_key", targetId: row.id, data: { name: row.name, prefix: row.prefix } });
  return c.json({ id: row.id, name: row.name, prefix: row.prefix, key: key.raw, note: "Store this key now; it is not shown again." }, 201);
});

authRoutes.delete("/api-keys/:id", requireAuth, requireUser, requireRole("owner", "admin"), async (c) => {
  const { db } = getDb();
  const gone = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.orgId, c.get("auth").org.id))).returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix });
  if (!gone.length) throw notFound("API key");
  await audit(c, "apikey.revoked", { targetType: "api_key", targetId: gone[0].id, data: { name: gone[0].name, prefix: gone[0].prefix } });
  return c.json({ ok: true });
});

export function publicUser(u: typeof users.$inferSelect) {
  // hasPassword lets the settings page ask for the current password only when there is one.
  // emailVerified / hasGoogle are additive: the settings page can show how the account signs in.
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt, hasPassword: hasUsablePassword(u.passwordHash), emailVerified: !!u.emailVerifiedAt, hasGoogle: !!u.googleSub };
}
export function publicOrg(o: typeof organizations.$inferSelect) {
  // effectiveLimits: the plan's defaults with the usable stored overrides, never a junk value.
  return { id: o.id, name: o.name, slug: o.slug, plan: o.plan, limits: effectiveLimits(o), settings: o.settings, createdAt: o.createdAt };
}
