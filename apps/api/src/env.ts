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
  mailFrom: process.env.MAIL_FROM ?? "Prospex <no-reply@localhost>",
  hunterApiKey: secret(process.env.HUNTER_API_KEY),
  abstractEmailApiKey: secret(process.env.ABSTRACT_EMAIL_API_KEY),
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
  adminEmail: (process.env.ADMIN_EMAIL ?? "").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  /** Where "upgrade me" lead-capture emails are sent. Falls back to ADMIN_EMAIL. */
  leadNotifyEmail: process.env.LEAD_NOTIFY_EMAIL ?? process.env.ADMIN_EMAIL ?? "",
};

if (env.nodeEnv === "production" && env.jwtSecret === "dev-secret-change-me") {
  console.warn("[env] WARNING: JWT_SECRET is the default. Set a real secret in production.");
}
