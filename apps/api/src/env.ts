import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secret } from "@prospex/core";

// Load .env from repo root or app dir without a dependency
for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  try {
    const txt = readFileSync(p, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].replace(/\s+#.*$/, "");
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    break;
  } catch {}
}

function resolveTrustedProxy(): "cloudflare" | "xff" | "none" {
  const v = (process.env.TRUSTED_PROXY ?? "").trim().toLowerCase();
  if (v === "cloudflare" || v === "xff" || v === "none") return v;
  if (v) console.warn(`[env] TRUSTED_PROXY="${v}" is not one of cloudflare | xff | none; using the default.`);
  if (process.env.RENDER) return "cloudflare";
  return (process.env.NODE_ENV ?? "development") === "production" ? "xff" : "cloudflare";
}

/** Same reach as the pattern it replaces (any *.vercel.app), anchored and https-only. */
export const DEFAULT_CORS_ALLOW_REGEX = "^https://[a-z0-9-]+(\\.[a-z0-9-]+)*\\.vercel\\.app$";
function compileOriginRegex(src: string | undefined): RegExp | null {
  const pattern = src === undefined ? DEFAULT_CORS_ALLOW_REGEX : src.trim();
  if (!pattern || pattern === "none" || pattern === "off") return null;
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    // A typo here must not take the API down or, worse, silently allow everything.
    console.warn(`[env] CORS_ALLOW_REGEX is not a valid regular expression (${(e as Error).message}); ignoring it.`);
    return null;
  }
}

const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),
  appUrl: (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  apiUrl: (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/$/, ""),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  databaseUrl: process.env.DATABASE_URL,
  jobMode: (process.env.JOB_MODE ?? "worker") as "worker" | "inline",
  pilotMode: bool(process.env.PILOT_MODE, true),
  pilotInviteCode: process.env.PILOT_INVITE_CODE ?? "",
  defaultPlan: process.env.DEFAULT_PLAN ?? (bool(process.env.PILOT_MODE, true) ? "pilot" : "free"),
  resendApiKey: secret(process.env.RESEND_API_KEY),
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: secret(process.env.SMTP_USER),
    pass: secret(process.env.SMTP_PASS),
    secure: bool(process.env.SMTP_SECURE, false),
  },
  mailFrom: process.env.MAIL_FROM ?? "Scout <no-reply@localhost>",
  hunterApiKey: secret(process.env.HUNTER_API_KEY),
  abstractEmailApiKey: secret(process.env.ABSTRACT_EMAIL_API_KEY),
  /** Pay-as-you-go verifiers. Either is enough; both are tried in order when set. */
  reoonApiKey: secret(process.env.REOON_API_KEY),
  millionVerifierApiKey: secret(process.env.MILLIONVERIFIER_API_KEY),
  smtpProbeEnabled: bool(process.env.SMTP_PROBE_ENABLED, true),
  stripe: {
    secretKey: secret(process.env.STRIPE_SECRET_KEY),
    webhookSecret: secret(process.env.STRIPE_WEBHOOK_SECRET),
    // One STRIPE_PRICE_<PLAN> env var per plan id in packages/db/src/plans.ts (upper-cased),
    // e.g. STRIPE_PRICE_PRO, STRIPE_PRICE_STARTER, STRIPE_PRICE_GROWTH, STRIPE_PRICE_SCALE.
    // Legacy pricePro/priceBusiness kept for anything still reading them directly.
    pricePro: process.env.STRIPE_PRICE_PRO,
    priceBusiness: process.env.STRIPE_PRICE_BUSINESS,
    priceForPlan(plan: string): string | undefined {
      return process.env[`STRIPE_PRICE_${plan.toUpperCase()}`];
    },
  },
  google: {
    clientId: secret(process.env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: secret(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
  },
  internalToken: process.env.INTERNAL_TOKEN ?? "",
  /** Server-to-server admin API token. Separate from INTERNAL_TOKEN; see requireAdmin. */
  adminApiToken: process.env.ADMIN_API_TOKEN ?? "",
  adminEmail: (process.env.ADMIN_EMAIL ?? "").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  /**
   * Second factor for the admin dashboard login: a base32 TOTP secret, the same one that is
   * added to an authenticator app. Optional. When set, POST /v1/admin/login also needs the
   * current 6-digit code; when unset the login is email + password, as before. Spaces and
   * dashes are ignored, so it can be pasted the way an app displays it.
   */
  adminTotpSecret: (process.env.ADMIN_TOTP_SECRET ?? "").replace(/[\s-]/g, "").toUpperCase(),
  /** Where "upgrade me" lead-capture emails are sent. Falls back to ADMIN_EMAIL. */
  leadNotifyEmail: process.env.LEAD_NOTIFY_EMAIL ?? process.env.ADMIN_EMAIL ?? "",
  /**
   * Signing secret for the admin dashboard session. Optional: when unset the admin session is
   * signed with JWT_SECRET (and kept apart from customer sessions by its `aud` claim). Setting
   * it means a leak of JWT_SECRET alone can no longer mint an admin session.
   */
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || "dev-secret-change-me",
  /**
   * Previous ENCRYPTION_KEY values, comma-separated, newest first. Only ever used to DECRYPT:
   * rotating ENCRYPTION_KEY without listing the old value here makes every stored sender and
   * integration credential unreadable.
   */
  encryptionKeysOld: (process.env.ENCRYPTION_KEYS_OLD ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /**
   * Which proxy header carries the caller's address (see clientIp in middleware.ts).
   *  - "cloudflare": cf-connecting-ip, which Cloudflare overwrites on every request. Correct on
   *    Render (its edge is Cloudflare) and behind a Cloudflare-proxied domain; WRONG anywhere
   *    else, where the header is whatever the client typed.
   *  - "xff": the right-most X-Forwarded-For entry, the one our own proxy appended.
   *  - "none": no proxy in front; headers are ignored and the socket address is used.
   * Default: "cloudflare" on Render (RENDER is set there) and outside production, "xff" on any
   * other production host.
   */
  trustedProxy: resolveTrustedProxy(),
  /** Extra browser origins allowed to call the API, comma-separated (APP_URL is always allowed). */
  corsExtraOrigins: (process.env.CORS_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  /** Regex of further allowed origins. Default keeps Vercel preview deployments working. */
  corsAllowRegex: compileOriginRegex(process.env.CORS_ALLOW_REGEX),
};

/**
 * The default JWT secret is in this public source file, so anyone can mint a session for any
 * user with it. In production that is not a misconfiguration to warn about, it is an open
 * door - refuse to start. Only the exact default is fatal: render.yaml generates a value, and
 * a deployment that has one must never be taken down by this check.
 */
export const DEFAULT_JWT_SECRET = "dev-secret-change-me";
if (env.nodeEnv === "production" && env.jwtSecret === DEFAULT_JWT_SECRET) {
  throw new Error("[env] JWT_SECRET is the built-in default. Refusing to start in production: set JWT_SECRET to a long random value.");
}
/**
 * Without ENCRYPTION_KEY, stored credentials (SMTP passwords, CRM keys) are encrypted with a
 * key derived from JWT_SECRET. Kept as a fallback - switching keys now would make every
 * existing stored credential undecryptable - but said out loud, because rotating JWT_SECRET
 * then silently breaks every saved sender and integration.
 */
if (env.nodeEnv === "production" && !env.encryptionKey) {
  console.warn("[env] WARNING: ENCRYPTION_KEY is not set; stored credentials are encrypted with a key derived from JWT_SECRET. Rotating JWT_SECRET would make them unreadable.");
}
/**
 * A short JWT_SECRET can be guessed offline from any one session token (HS256 signatures are
 * checkable without the server). Warned about rather than refused: a deployment that already
 * runs on a short value must keep booting, and rotating it signs every user out, so it is a
 * decision for the operator, not something a deploy should force.
 */
export const MIN_JWT_SECRET_LENGTH = 32;
if (env.nodeEnv === "production" && env.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
  console.warn(
    `[env] WARNING: JWT_SECRET is only ${env.jwtSecret.length} characters long. Anyone holding one session token can try to guess a short secret offline and then sign in as any user. ` +
      `Set it to at least ${MIN_JWT_SECRET_LENGTH} random characters (openssl rand -hex 32). Rotating it signs every user out once.`,
  );
}
if (env.nodeEnv === "production" && process.env.ADMIN_JWT_SECRET && process.env.ADMIN_JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  console.warn(`[env] WARNING: ADMIN_JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters; use a long random value.`);
}
if (env.nodeEnv === "production" && env.adminPassword && env.adminPassword.length < 12) {
  console.warn("[env] WARNING: ADMIN_PASSWORD is shorter than 12 characters. It guards every customer's plan and status; use a long random value.");
}
/**
 * ADMIN_TOTP_SECRET that is set but is not base32 cannot match any code. The admin login then
 * refuses every sign-in (it fails closed - the operator asked for a second factor) and says
 * why; this line is the same message at boot, where it is seen before anyone is locked out.
 */
if (env.adminTotpSecret && !/^[A-Z2-7]{16,}=*$/.test(env.adminTotpSecret)) {
  console.warn("[env] WARNING: ADMIN_TOTP_SECRET is set but is not a base32 secret (letters A-Z and digits 2-7, at least 16 characters). The admin login will refuse every sign-in until it is fixed or removed. See DEPLOY.md, 'Admin two-factor sign-in'.");
}
