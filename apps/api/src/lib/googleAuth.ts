/**
 * Sign in with Google (OAuth 2.0 authorization code flow).
 *
 * Password auth stays; this sits beside it. Most buyers arrive with a Google Workspace
 * account and a one-click sign-in removes the "invent another password" step, which is the
 * single biggest drop-off on a signup form.
 *
 * The parts that carry real risk, and how each is handled:
 *
 * CSRF. The `state` parameter is an HMAC of a nonce and an expiry, signed with JWT_SECRET
 * and valid for ten minutes. An attacker cannot mint one, and a stale one is refused. It is
 * stateless on purpose - a database round trip per redirect buys nothing here, and a signed
 * value cannot be forged without the secret.
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
 */

import { sign, verify } from "hono/jwt";
import { eq, getDb, users, type User } from "@prospex/db";
import { env } from "../env.js";
import { ApiError } from "./errors.js";

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
  nonce: string;
}

/**
 * A signed, expiring state value.
 *
 * `next` is carried inside the signed blob rather than as a separate query parameter, so a
 * tampered redirect target invalidates the signature instead of quietly redirecting
 * elsewhere - an open redirect is the classic way this flow gets abused.
 */
export async function makeState(next: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ next: safeNext(next), nonce: crypto.randomUUID(), iat: now, exp: now + STATE_TTL_SECONDS }, env.jwtSecret);
}

export async function readState(state: string | undefined): Promise<StatePayload> {
  if (!state) throw new ApiError(400, "Missing state", "oauth_state_missing");
  try {
    const p = (await verify(state, env.jwtSecret, "HS256")) as unknown as StatePayload;
    return { next: safeNext(p.next), nonce: p.nonce };
  } catch {
    // Covers forged, tampered and expired states alike. The user simply starts again.
    throw new ApiError(400, "This sign-in link has expired or is invalid. Please try again.", "oauth_state_invalid");
  }
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

/**
 * Find the user this Google identity belongs to, if any.
 *
 * Matching on a verified email links a Google sign-in to an existing password account, which
 * is what people expect: the same person, one account, whichever door they came through.
 * That convenience is only safe because the caller has already refused unverified emails -
 * without that check this function would be an account takeover.
 */
export async function findUserForGoogle(identity: GoogleIdentity): Promise<User | null> {
  if (!identity.emailVerified) throw new ApiError(400, "Your Google email address is not verified", "oauth_email_unverified");
  const { db } = getDb();
  return (await db.query.users.findFirst({ where: eq(users.email, identity.email) })) ?? null;
}
