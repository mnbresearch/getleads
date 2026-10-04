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
/**
 * Compile CORS_ALLOW_REGEX. Unset keeps the built-in default (Vercel preview deployments);
 * "none" or "off" turns the pattern off, leaving only the exact origins (APP_URL,
 * CORS_EXTRA_ORIGINS, localhost).
 *
 * The pattern is always matched against the WHOLE origin: it is compiled as ^(?:pattern)$.
 * A pattern written without anchors (`vercel\.app`) used to match any origin that merely
 * contained it - `https://vercel.app.evil.example` included. Wrapping can only make a pattern
 * stricter, never looser, so a pattern that was already anchored behaves exactly as before.
 */
export function compileOriginRegex(src: string | undefined, warn: (line: string) => void = (l) => console.warn(l)): RegExp | null {
  const pattern = src === undefined ? DEFAULT_CORS_ALLOW_REGEX : src.trim();
  if (!pattern || pattern === "none" || pattern === "off") return null;
  if (pattern.length > 500) {
    warn("[env] CORS_ALLOW_REGEX is longer than 500 characters; ignoring it. Only the exact origins are allowed.");
    return null;
  }
  try {
    new RegExp(pattern, "i");
    if (!(pattern.startsWith("^") && pattern.endsWith("$") && !pattern.endsWith("\\$"))) {
      warn("[env] CORS_ALLOW_REGEX is not anchored with ^ and $. It is matched against the whole origin, so an origin that only contains the pattern is refused. Write it as ^https://...$ to make that explicit.");
    }
    return new RegExp(`^(?:${pattern})$`, "i");
  } catch (e) {
    // A typo here must not take the API down or, worse, silently allow everything.
    warn(`[env] CORS_ALLOW_REGEX is not a valid regular expression (${(e as Error).message}); ignoring it.`);
    return null;
  }
}

const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),
  appUrl: (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  apiUrl: (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/$/, ""),
  // `||`, not `??`: JWT_SECRET= (set but empty) must never become an empty signing key.
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
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
  // `||`: an empty LEAD_NOTIFY_EMAIL (a dashboard field left blank) must fall back, not win.
  leadNotifyEmail: process.env.LEAD_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || "",
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

/** The JWT secret used when none is configured. Public (it is in this file), so never acceptable in production. */
export const DEFAULT_JWT_SECRET = "dev-secret-change-me";
/** Below this, JWT_SECRET / ENCRYPTION_KEY are refused in production. */
export const MIN_SECRET_LENGTH = 16;
/** Below this, JWT_SECRET is warned about (a short HS256 secret can be guessed offline from one token). */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Secret values that are printed somewhere public: this repository's .env.example, its docs,
 * docker-compose.yml, the CI workflow, the seed and smoke scripts - plus the handful of values
 * every default-credential list starts with. A deployment "secured" by one of these is
 * secured by nothing.
 */
const PUBLISHED_SECRET_VALUES = new Set(
  [
    DEFAULT_JWT_SECRET,
    "change-me-to-a-long-random-string",
    "change-me-32-bytes-base64-or-hex",
    "ci",
    "prospex",
    "getleads",
    "demo1234",
    "password123",
    "changeme",
    "change-me",
    "password",
    "secret",
    "admin",
    "test",
    "example",
  ].map((v) => v.toLowerCase()),
);

/** Is this value a published placeholder (or an unexpanded template such as `$(openssl rand -hex 32)` or `<token>`)? */
export function isPublishedPlaceholder(value: string | undefined | null): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return false;
  if (PUBLISHED_SECRET_VALUES.has(v)) return true;
  // Prefixes no randomly generated secret starts with. (Deliberately not "xxx...": a random
  // base64 value can begin with any three letters, and this check can stop a production start.)
  if (/^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]|placeholder|example[-_ ]|todo[-_ ])/.test(v)) return true;
  if (/^x+$/.test(v)) return true;
  // A shell substitution or an angle-bracket template pasted literally, or a doc ellipsis ("px_live_...").
  return /^\$\(.*\)$/.test(v) || /^\$\{.*\}$/.test(v) || /^<.*>$/.test(v) || /\.\.\.$/.test(v);
}

export interface SecretAssessment {
  /** Reasons the process must not start. Only ever JWT_SECRET / ENCRYPTION_KEY, only in production. */
  fatal: string[];
  /** Said loudly at boot; nothing is changed. */
  warnings: string[];
  /** Credentials that are published placeholders: the feature each one guards is switched off. Production only. */
  disabled: { name: string; line: string }[];
}

/**
 * Judge the configured secrets. Pure: takes the variables, returns what to do about them.
 *
 * In production:
 *   - JWT_SECRET that is a published placeholder (including the built-in default) or shorter
 *     than 16 characters, and ENCRYPTION_KEY that is set to a published placeholder or to
 *     fewer than 16 characters, stop the process. JWT_SECRET signs every session; anyone who
 *     knows it is every user. ENCRYPTION_KEY protects every stored mail and CRM credential.
 *     These two are the only things that stop a boot.
 *   - ADMIN_API_TOKEN, ADMIN_PASSWORD, INTERNAL_TOKEN, ADMIN_JWT_SECRET and the webhook secrets
 *     never stop a boot. A published placeholder there switches off the one thing it guards
 *     (that door then answers "not configured") and says so.
 * Outside production everything is a warning.
 */
export function assessSecrets(vars: Record<string, string | undefined>, nodeEnv: string): SecretAssessment {
  const out: SecretAssessment = { fatal: [], warnings: [], disabled: [] };
  const prod = nodeEnv === "production";
  const jwt = vars.JWT_SECRET || DEFAULT_JWT_SECRET;
  const enc = vars.ENCRYPTION_KEY ?? "";

  const jwtProblem = isPublishedPlaceholder(jwt)
    ? jwt === DEFAULT_JWT_SECRET
      ? "JWT_SECRET is the built-in default (it is unset, empty, or set to the value printed in the source)"
      : "JWT_SECRET is a placeholder value that is published in this project's example files"
    : jwt.length < MIN_SECRET_LENGTH
      ? `JWT_SECRET is only ${jwt.length} characters long (the minimum is ${MIN_SECRET_LENGTH})`
      : null;
  if (jwtProblem) {
    const line = `[env] ${jwtProblem}. It signs every session, so anyone who knows or guesses it can sign in as any user. Set JWT_SECRET to a long random value (openssl rand -hex 32).`;
    if (prod) out.fatal.push(`${line} Refusing to start in production.`);
    else out.warnings.push(`${line} This would stop the server in production.`);
  } else if (prod && jwt.length < MIN_JWT_SECRET_LENGTH) {
    out.warnings.push(
      `[env] WARNING: JWT_SECRET is only ${jwt.length} characters long. Anyone holding one session token can try to guess a short secret offline and then sign in as any user. ` +
        `Set it to at least ${MIN_JWT_SECRET_LENGTH} random characters (openssl rand -hex 32). Rotating it signs every user out once.`,
    );
  }

  if (enc) {
    const encProblem = isPublishedPlaceholder(enc)
      ? "ENCRYPTION_KEY is a placeholder value that is published in this project's example files"
      : enc.length < MIN_SECRET_LENGTH
        ? `ENCRYPTION_KEY is only ${enc.length} characters long (the minimum is ${MIN_SECRET_LENGTH})`
        : null;
    if (encProblem) {
      const line =
        `[env] ${encProblem}. It protects every stored mail and CRM credential. Set ENCRYPTION_KEY to a long random value (openssl rand -hex 32) ` +
        "and put the current value in ENCRYPTION_KEYS_OLD, so credentials saved under it stay readable.";
      if (prod) out.fatal.push(`${line} Refusing to start in production.`);
      else out.warnings.push(`${line} This would stop the server in production.`);
    }
  } else if (prod) {
    out.warnings.push("[env] WARNING: ENCRYPTION_KEY is not set; stored credentials are encrypted with a key derived from JWT_SECRET. Rotating JWT_SECRET would make them unreadable.");
  }

  const guarded: { name: string; guards: string; off: string }[] = [
    { name: "ADMIN_API_TOKEN", guards: "the server-to-server admin API", off: "Token access to the admin API is switched off" },
    { name: "ADMIN_PASSWORD", guards: "the admin console sign-in", off: "The admin console sign-in is switched off" },
    { name: "INTERNAL_TOKEN", guards: "the job runner endpoint", off: "The job runner endpoint is switched off" },
    { name: "STRIPE_WEBHOOK_SECRET", guards: "billing events", off: "Billing events are ignored" },
    { name: "RESEND_WEBHOOK_SECRET", guards: "delivery events (bounces and complaints)", off: "Delivery events are refused" },
    { name: "ADMIN_JWT_SECRET", guards: "the admin session", off: "It is ignored and the admin session is signed with JWT_SECRET instead" },
  ];
  for (const g of guarded) {
    const v = vars[g.name];
    if (!v) continue;
    const weakAdminJwt = g.name === "ADMIN_JWT_SECRET" && v.length < MIN_SECRET_LENGTH;
    if (isPublishedPlaceholder(v) || weakAdminJwt) {
      const why = isPublishedPlaceholder(v) ? "a placeholder value that is published in this project's example files" : `only ${v.length} characters long`;
      if (prod) out.disabled.push({ name: g.name, line: `[env] SECURITY: ${g.name} is ${why}, so it does not protect ${g.guards}. ${g.off} until it is set to a long random value (openssl rand -hex 24).` });
      else out.warnings.push(`[env] ${g.name} is ${why}. In production ${g.guards} would be switched off until it is replaced.`);
    }
  }
  if (prod && vars.ADMIN_JWT_SECRET && !out.disabled.some((d) => d.name === "ADMIN_JWT_SECRET") && vars.ADMIN_JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    out.warnings.push(`[env] WARNING: ADMIN_JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters; use a long random value.`);
  }
  if (prod && vars.ADMIN_PASSWORD && !out.disabled.some((d) => d.name === "ADMIN_PASSWORD") && vars.ADMIN_PASSWORD.length < 12) {
    out.warnings.push("[env] WARNING: ADMIN_PASSWORD is shorter than 12 characters. It guards every customer's plan and status; use a long random value.");
  }
  // The database passwords printed in docker-compose.yml and .env.example.
  if (prod && /:\/\/(prospex:prospex|getleads:getleads|postgres:postgres)@/i.test(vars.DATABASE_URL ?? "")) {
    out.warnings.push("[env] SECURITY: DATABASE_URL uses a database password that is published in this project's example files. Change the database password.");
  }
  return out;
}

/**
 * Apply the assessment to the running configuration. Throws for a fatal finding (production
 * only); blanks each disabled credential so the code that checks it sees "not configured".
 */
function applySecretPolicy() {
  const a = assessSecrets(process.env, env.nodeEnv);
  // Test runs configure short throwaway secrets on purpose; saying so on every import is noise.
  if (env.nodeEnv !== "test") for (const w of a.warnings) console.warn(w);
  for (const d of a.disabled) {
    console.error(d.line);
    if (d.name === "ADMIN_API_TOKEN") env.adminApiToken = "";
    else if (d.name === "ADMIN_PASSWORD") env.adminPassword = "";
    else if (d.name === "INTERNAL_TOKEN") env.internalToken = "";
    else if (d.name === "STRIPE_WEBHOOK_SECRET") env.stripe.webhookSecret = undefined;
    else if (d.name === "ADMIN_JWT_SECRET") env.adminJwtSecret = env.jwtSecret;
    // Read straight from the environment by the route that checks it.
    else if (d.name === "RESEND_WEBHOOK_SECRET") delete process.env.RESEND_WEBHOOK_SECRET;
  }
  if (a.fatal.length) {
    for (const f of a.fatal) console.error(f);
    throw new Error(a.fatal[0]);
  }
}
applySecretPolicy();
/**
 * ADMIN_TOTP_SECRET that is set but is not base32 cannot match any code. The admin login then
 * refuses every sign-in (it fails closed - the operator asked for a second factor) and says
 * why; this line is the same message at boot, where it is seen before anyone is locked out.
 */
if (env.adminTotpSecret && !/^[A-Z2-7]{16,}=*$/.test(env.adminTotpSecret)) {
  console.warn("[env] WARNING: ADMIN_TOTP_SECRET is set but is not a base32 secret (letters A-Z and digits 2-7, at least 16 characters). The admin login will refuse every sign-in until it is fixed or removed. See DEPLOY.md, 'Admin two-factor sign-in'.");
}
