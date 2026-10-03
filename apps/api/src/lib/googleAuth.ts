/**
 * Sign in with Google (OAuth 2.0 authorization code flow).
 *
 * Password auth stays; this sits beside it. Most buyers arrive with a Google Workspace
 * account and a one-click sign-in removes the "invent another password" step, which is the
 * single biggest drop-off on a signup form.
 *
 * The parts that carry real risk, and how each is handled:
 *
 * CSRF / login fixation. The `state` parameter is a signed, ten-minute token with its own
 * audience ("oauth_state"), and it is BOUND TO THE BROWSER that started the flow: /start puts
 * the state's nonce in an HttpOnly cookie and /callback refuses a state whose nonce is not in
 * the cookie. A signature alone was not enough - any state we had ever signed (and, before
 * audiences, any session token) was accepted from any browser, so an attacker could finish
 * their own sign-in in a victim's browser.
 *
 * Handoff to the web app. The session is not put in the redirect URL. The callback mints a
 * one-time code (60 seconds, single use, only its hash stored) tied to a verifier hash the
 * web app chose before the flow started (`cv`); the web app trades code + verifier for the
 * session over POST. A link carrying somebody else's code is useless in a browser that does
 * not hold the matching verifier.
 *
 * Token trust. The id_token is fetched server-to-server from Google's token endpoint over
 * TLS, in exchange for a one-time code plus the client secret. Because it arrives directly
 * from Google rather than through the browser, its signature does not need separate JWKS
 * verification; what does still need checking is that the claims describe who we think they
 * do, so `iss`, `aud` and `exp` are all verified before the token is believed.
 *
 * Account takeover. This is the dangerous one. Linking a Google identity to an existing
 * password account by email means anyone who can make Google assert an email could seize
 * that account - so `email_verified` must be true, and an unverified Google email is
 * refused outright rather than being allowed to create or link anything.
 *
 * Pre-hijack, the mirror image. Password signup does not prove the address is yours, so
 * someone can register a victim's address first and wait for the victim to "Sign in with
 * Google" into the account they still hold a password, a session and an API key for. See
 * resolveGoogleUser: an account whose address was never proved is CLAIMED for the Google
 * identity (old password, sessions and keys die) instead of being quietly shared.
 */

import { sign, verify } from "hono/jwt";
import { createHash } from "node:crypto";
import { and, apiKeys, eq, events, getDb, isNull, sql, users, type User } from "@prospex/db";
import { env } from "../env.js";
import { ApiError } from "./errors.js";
import { hasUsablePassword, unusablePasswordHash } from "./auth.js";
import { randomToken, safeEqual } from "./crypto.js";
import { forgetOtherKnownAddresses } from "./loginGuard.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_SECONDS = 10 * 60;

/** Google's issuer claim comes in two spellings; both are legitimate. */
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export function googleAuthConfigured(): boolean {
  return !!env.google.clientId && !!env.google.clientSecret;
}

/** Where Google sends the browser back. Must match the console entry exactly, including scheme. */
export function googleRedirectUri(): string {
  return `${env.apiUrl.replace(/\/$/, "")}/v1/auth/google/callback`;
}

export interface StatePayload {
  /** Where to send the user in the app afterwards. Validated as a same-site path, never a URL. */
  next: string;
  /** Random value also held in the browser's `g_state` cookie; the two must match at the callback. */
  nonce: string;
  /** base64url(sha256(verifier)) chosen by the web app; the one-time code is only redeemable with that verifier. */
  cv: string;
}

/** Cookie that binds an OAuth state to the browser that started the flow. */
export const STATE_COOKIE = "g_state";
export const STATE_COOKIE_PATH = "/v1/auth/google";
export const STATE_TTL = STATE_TTL_SECONDS;

/** base64url of a SHA-256 digest: 43 characters, no padding. */
const CV_RE = /^[A-Za-z0-9_-]{43}$/;
export function isValidCodeChallenge(cv: unknown): cv is string {
  return typeof cv === "string" && CV_RE.test(cv);
}

/** base64url(sha256(verifier)) - what the web app sends as `cv` and what is stored with the code. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * A signed, expiring state value.
 *
 * `next` is carried inside the signed blob rather than as a separate query parameter, so a
 * tampered redirect target invalidates the signature instead of quietly redirecting
 * elsewhere - an open redirect is the classic way this flow gets abused. The audience claim
 * makes it a state and nothing else: it is not a session, and a session is not a state.
 */
export async function makeState(next: string, cv: string, nonce: string = randomToken(24)): Promise<{ state: string; nonce: string }> {
  const now = Math.floor(Date.now() / 1000);
  const state = await sign({ aud: "oauth_state", next: safeNext(next), nonce, cv, iat: now, exp: now + STATE_TTL_SECONDS }, env.jwtSecret);
  return { state, nonce };
}

/**
 * Verify a state. `cookieNonce` is the value of the browser's g_state cookie: a state is only
 * good in the browser that started the flow, so a missing or different cookie is refused the
 * same way a forged signature is.
 */
export async function readState(state: string | undefined, cookieNonce: string | undefined): Promise<StatePayload> {
  if (!state) throw new ApiError(400, "Missing state", "oauth_state_missing");
  const invalid = () => new ApiError(400, "This sign-in link has expired or is invalid. Please try again.", "oauth_state_invalid");
  let p: { aud?: unknown; next?: unknown; nonce?: unknown; cv?: unknown };
  try {
    p = (await verify(state, env.jwtSecret, "HS256")) as typeof p;
  } catch {
    // Covers forged, tampered and expired states alike. The user simply starts again.
    throw invalid();
  }
  // Must be a state: a session or admin token signed with the same secret is not one.
  if (p.aud !== "oauth_state") throw invalid();
  if (typeof p.nonce !== "string" || p.nonce.length < 16 || !isValidCodeChallenge(p.cv)) throw invalid();
  if (!cookieNonce || !safeEqual(cookieNonce, p.nonce)) {
    throw new ApiError(400, "This sign-in was started in a different browser or has expired. Please try again.", "oauth_state_mismatch");
  }
  return { next: safeNext(typeof p.next === "string" ? p.next : "/"), nonce: p.nonce, cv: p.cv };
}

/**
 * Only ever redirect to a path on our own app.
 *
 * Anything absolute, protocol-relative, or containing a backslash is discarded rather than
 * sanitised: a half-cleaned redirect target is how open redirects survive review.
 */
export function safeNext(next: string | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next.slice(0, 200);
}

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.google.clientId!,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Ask every time rather than silently reusing a session: on a shared machine, silent
    // reuse signs someone into the wrong account with no visible choice.
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

/** Decode a JWT payload without verifying its signature. Only safe for a token we fetched
 * ourselves over TLS from Google's token endpoint; never for one handed to us by a browser. */
function decodePayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new ApiError(502, "Malformed token from Google", "oauth_bad_token");
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
}

/** Trade the one-time code for an identity, validating the claims before believing them. */
export async function exchangeCode(code: string): Promise<GoogleIdentity> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId!,
      client_secret: env.google.clientSecret!,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new ApiError(502, `Google rejected the sign-in (${res.status}): ${body}`, "oauth_exchange_failed");
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new ApiError(502, "Google did not return an identity token", "oauth_no_id_token");

  const p = decodePayload(data.id_token);
  const iss = String(p.iss ?? "");
  const aud = String(p.aud ?? "");
  const exp = Number(p.exp ?? 0);

  // Even arriving over TLS from Google, a token for a different client or a stale one must
  // not be accepted; these three checks are what make the claims mean anything.
  if (!VALID_ISSUERS.has(iss)) throw new ApiError(502, "Identity token came from an unexpected issuer", "oauth_bad_issuer");
  if (aud !== env.google.clientId) throw new ApiError(502, "Identity token was issued for a different application", "oauth_bad_audience");
  if (!exp || exp * 1000 < Date.now()) throw new ApiError(502, "Identity token has expired", "oauth_expired_token");

  const email = String(p.email ?? "").toLowerCase();
  if (!email) throw new ApiError(400, "Google did not share an email address", "oauth_no_email");

  return {
    sub: String(p.sub ?? ""),
    email,
    emailVerified: p.email_verified === true || p.email_verified === "true",
    name: String(p.name ?? ""),
    picture: typeof p.picture === "string" ? p.picture : undefined,
  };
}

export type GoogleMatch =
  /** No account for this identity: the caller creates one (bound to the subject from the start). */
  | "none"
  /** The account already bound to this Google subject. */
  | "matched_sub"
  /** An account with this address whose ownership was already established; now bound to the subject. */
  | "linked"
  /** An account somebody registered with a password for this address and never proved they own; taken over by the Google identity. */
  | "claimed_unverified";

export interface GoogleResolution {
  user: User | null;
  match: GoogleMatch;
  /** Only for "claimed_unverified": what was done, for the audit log. Never contains secrets. */
  claim?: { soleUser: boolean; apiKeysRevoked: number; otherUsers: number };
}

/**
 * Was this account created by "Sign in with Google" before the no-password marker existed?
 * Those rows hold a random bcrypt hash, indistinguishable from a chosen password, but their
 * workspace's `org.created` event recorded `via: "google"` with the same address.
 */
async function createdByGoogle(user: User): Promise<boolean> {
  const { db } = getDb();
  try {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.orgId, user.orgId), eq(events.type, "org.created"), sql`${events.data}->>'via' = 'google'`, sql`lower(${events.data}->>'email') = ${user.email.toLowerCase()}`))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Resolve a verified Google identity to an account, binding the account to the Google subject.
 *
 * Order matters:
 *
 * 1. By Google subject. Once bound, the subject is the identity - not the email, which can be
 *    re-assigned to somebody else.
 * 2. By email, when the row is not bound yet:
 *    - bound to a DIFFERENT subject: refused. Two Google accounts do not share one login.
 *    - ownership of the address already established (email verified by a password reset, or
 *      the account was created by Google in the first place): bind and continue. This is the
 *      "same person, either door" convenience. An accepted team invite does NOT count: the
 *      invite link is also shown to the inviter, so accepting it proves nothing about the
 *      mailbox.
 *    - ownership never established and the row has a password someone chose: CLAIM it. The
 *      Google user has just proved they own the address; whoever typed it into the signup
 *      form never did. Their password stops working, every session they hold is revoked
 *      (token version bump) and, when they were the workspace's only user, the workspace's
 *      API keys are revoked too - the signup response handed them one. In a workspace with
 *      other users the keys belong to the team, so they are left alone.
 *
 * The honest case this costs: someone who signed up with a password, never reset it, and
 * later clicks "Sign in with Google" loses their password (they can set a new one from
 * Settings) and, if they work alone, their API keys. That is the price of not being able to
 * tell them from a squatter; the audit log records it and the caller emails them.
 *
 * Who this applies to: accounts created AFTER migration 0018. That migration marked every
 * account that already existed as owning its address (the operator knows that customer
 * base), so an existing customer's first Google sign-in LINKS and costs them nothing.
 * Password signup still leaves `email_verified_at` empty, so a new account stays unproved
 * until a password reset or a Google sign-in proves it.
 */
export async function resolveGoogleUser(identity: GoogleIdentity, opts: { ip?: string | null } = {}): Promise<GoogleResolution> {
  if (!identity.emailVerified) throw new ApiError(400, "Your Google email address is not verified", "oauth_email_unverified");
  if (!identity.sub) throw new ApiError(502, "Google did not return an account identifier", "oauth_bad_token");
  const { db } = getDb();
  const now = new Date();

  const bySub = await db.query.users.findFirst({ where: eq(users.googleSub, identity.sub) });
  if (bySub) {
    if (!bySub.emailVerifiedAt) {
      const [u] = await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, bySub.id)).returning();
      return { user: u ?? bySub, match: "matched_sub" };
    }
    return { user: bySub, match: "matched_sub" };
  }

  const byEmail = await db.query.users.findFirst({ where: eq(users.email, identity.email) });
  if (!byEmail) return { user: null, match: "none" };

  if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
    throw new ApiError(409, "This email address is already linked to a different Google account. Sign in with your password, or contact support.", "oauth_account_mismatch");
  }

  const established = !!byEmail.emailVerifiedAt || !hasUsablePassword(byEmail.passwordHash) || (await createdByGoogle(byEmail));
  if (established) {
    // `google_sub IS NULL` in the WHERE: two callbacks racing must not both bind.
    const [u] = await db
      .update(users)
      .set({ googleSub: identity.sub, emailVerifiedAt: byEmail.emailVerifiedAt ?? now })
      .where(and(eq(users.id, byEmail.id), isNull(users.googleSub)))
      .returning();
    if (!u) throw new ApiError(409, "This sign-in could not be completed. Please try again.", "oauth_account_mismatch");
    return { user: u, match: "linked" };
  }

  // Unproven password account: the Google identity takes it over.
  const [{ n: userCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.orgId, byEmail.orgId));
  const soleUser = userCount <= 1;
  const unusable = await unusablePasswordHash(`google:${identity.sub}`);
  const [u] = await db
    .update(users)
    .set({ googleSub: identity.sub, emailVerifiedAt: now, passwordHash: unusable, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, byEmail.id), isNull(users.googleSub)))
    .returning();
  if (!u) throw new ApiError(409, "This sign-in could not be completed. Please try again.", "oauth_account_mismatch");
  // Whoever held the old password also left "known address" rows behind (signup and every
  // password sign-in write one). Left in place, that address kept a private allowance of
  // guesses at the account it no longer owns, exempt from the account-wide lock. They go
  // with the password; only the address completing this Google sign-in is kept.
  await forgetOtherKnownAddresses(u.email, opts.ip ?? null).catch((e) => console.warn(`[auth] could not clear known sign-in addresses after a Google claim: ${(e as Error).message}`));
  let apiKeysRevoked = 0;
  if (soleUser) {
    const gone = await db.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.orgId, u.orgId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
    apiKeysRevoked = gone.length;
  }
  return { user: u, match: "claimed_unverified", claim: { soleUser, apiKeysRevoked, otherUsers: Math.max(0, userCount - 1) } };
}

/**
 * Find the user this Google identity belongs to, if any (see resolveGoogleUser for what
 * "belongs to" means and what it changes). Kept under its old name for existing callers.
 */
export async function findUserForGoogle(identity: GoogleIdentity): Promise<User | null> {
  return (await resolveGoogleUser(identity)).user;
}
