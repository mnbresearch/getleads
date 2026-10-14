/**
 * The operator's configuration checklist: every environment setting the server reads that
 * changes what Scout can do, with whether it is set and what it unlocks.
 *
 * Rule for this file: a secret's VALUE never leaves the server. Each row says only whether
 * the variable is set. A handful of rows are plain mode switches (JOB_MODE, DEFAULT_PLAN,
 * CHECKOUT_FOLLOWUP, ...); for those `value` carries the effective mode, computed the way
 * the code that reads it computes it, so the page shows what the server actually does
 * rather than what was typed.
 *
 * Pure apart from reading the variables it is handed: the tests pass their own set.
 */
import { DEFAULT_CORS_ALLOW_REGEX, env } from "../env.js";
import { keepAwakeConfig, withinWindow } from "../lib/keepAwake.js";

export type ConfigArea = "search" | "ai" | "email" | "billing" | "security" | "privacy" | "runtime";
export interface ConfigItem {
  key: string;
  label: string;
  area: ConfigArea;
  set: boolean;
  /** What this unlocks, and what happens while it is missing. */
  effect: string;
  /** Only for non-secret mode switches: the mode the server is running with. */
  value?: string | null;
}

const has = (v: string | undefined | null) => typeof v === "string" && v.trim().length > 0;
const OFF = /^(off|false|0|no|disabled)$/i;
const TRUE = /^(1|true|yes|on)$/i;

export interface KeepAwakeState {
  configured: boolean;
  /** "10:00-19:00" */
  window: string | null;
  timeZone: string | null;
  /** Inside the window right now, so the pinger is asking for /health every ten minutes. */
  activeNow: boolean;
  /** RENDER is set: a free Render instance sleeps after 15 idle minutes. */
  onRender: boolean;
}

/** Whether this process runs the job worker: the same rule server.ts applies at start. */
export function embeddedWorkerOn(e: NodeJS.ProcessEnv = process.env): boolean {
  const jobMode = e.JOB_MODE === "inline" ? "inline" : "worker";
  return e.EMBED_WORKER === "true" || (jobMode === "worker" && e.EMBED_WORKER !== "false" && (e.NODE_ENV ?? "development") !== "production");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function keepAwakeState(e: NodeJS.ProcessEnv = process.env, now = new Date()): KeepAwakeState {
  const cfg = keepAwakeConfig(e);
  const onRender = has(e.RENDER) || has(e.RENDER_EXTERNAL_URL);
  if (!cfg) return { configured: false, window: null, timeZone: null, activeNow: false, onRender };
  return { configured: true, window: `${pad(cfg.startHour)}:00-${pad(cfg.endHour % 24)}:00`, timeZone: cfg.timeZone, activeNow: withinWindow(now, cfg), onRender };
}

/** The paid plans that have their own Stripe price variable. */
const PRICED_PLANS = ["starter", "growth", "scale", "enterprise"];

/**
 * Every row. `e` is the environment to judge; the guarded credentials that the server may
 * have switched off at boot (a published placeholder value) are judged from the running
 * configuration instead, so a disabled ADMIN_PASSWORD reads as not set - which is what the
 * server does with it.
 */
export function configChecklist(e: NodeJS.ProcessEnv = process.env, now = new Date()): ConfigItem[] {
  const live = e === process.env;
  const adminPassword = live ? has(env.adminPassword) : has(e.ADMIN_PASSWORD);
  const adminApiToken = live ? has(env.adminApiToken) : has(e.ADMIN_API_TOKEN);
  const internalToken = live ? has(env.internalToken) : has(e.INTERNAL_TOKEN);
  const stripeWebhook = live ? !!env.stripe.webhookSecret : has(e.STRIPE_WEBHOOK_SECRET);
  const ka = keepAwakeState(e, now);
  const corsRegex = e.CORS_ALLOW_REGEX === undefined ? "default" : /^(none|off)?$/i.test(e.CORS_ALLOW_REGEX.trim()) ? "off" : e.CORS_ALLOW_REGEX.trim() === DEFAULT_CORS_ALLOW_REGEX ? "default" : "custom";
  const extraOrigins = (e.CORS_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;
  const pilot = e.PILOT_MODE === undefined ? true : TRUE.test(e.PILOT_MODE);
  const followup = (() => {
    const v = (e.CHECKOUT_FOLLOWUP ?? "").trim().toLowerCase();
    return v === "on" || v === "dry_run" ? v : "off";
  })();
  const jobMode = e.JOB_MODE === "inline" ? "inline" : "worker";
  const nodeEnv = e.NODE_ENV ?? "development";
  const embedded = embeddedWorkerOn(e);
  const items: ConfigItem[] = [
    // ── search and data providers ──
    { key: "SERPER_API_KEY", label: "Serper (Google results)", area: "search", set: has(e.SERPER_API_KEY), effect: "Main web search source for people and company discovery. Without any search key, discovery falls back to the keyless DuckDuckGo/Bing pages, which are slow and often blocked." },
    { key: "SERPAPI_KEY", label: "SerpApi", area: "search", set: has(e.SERPAPI_KEY), effect: "Second web search source, used when Serper is missing or out of credit." },
    { key: "BRAVE_SEARCH_API_KEY", label: "Brave Search", area: "search", set: has(e.BRAVE_SEARCH_API_KEY), effect: "Additional web search source in the discovery chain." },
    { key: "GOOGLE_CSE_API_KEY", label: "Google Programmable Search (key and CX)", area: "search", set: has(e.GOOGLE_CSE_API_KEY) && has(e.GOOGLE_CSE_CX), effect: "Google Custom Search as a discovery source. Needs both GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX." },
    { key: "APOLLO_API_KEY", label: "Apollo", area: "search", set: has(e.APOLLO_API_KEY), effect: "Structured people and company data. Missing: discovery relies on web search only." },
    { key: "PDL_API_KEY", label: "People Data Labs", area: "search", set: has(e.PDL_API_KEY), effect: "Person and company enrichment. Missing: enrichment uses web pages and the other providers." },
    { key: "HUNTER_API_KEY", label: "Hunter", area: "search", set: has(e.HUNTER_API_KEY), effect: "Email finding and verification fallback. A workspace may also save its own Hunter key." },
    { key: "IPINFO_TOKEN", label: "IPinfo", area: "search", set: has(e.IPINFO_TOKEN), effect: "Turns website visitor addresses into companies. Missing: the visitor pixel records visits but identifies few companies." },
    { key: "DDG_DISABLED", label: "Keyless DuckDuckGo search", area: "search", set: e.DDG_DISABLED === "true", value: e.DDG_DISABLED === "true" ? "disabled" : "enabled", effect: "Free fallback search source. Set DDG_DISABLED=true to stop using it." },
    { key: "BING_HTML_DISABLED", label: "Keyless Bing search", area: "search", set: e.BING_HTML_DISABLED === "true", value: e.BING_HTML_DISABLED === "true" ? "disabled" : "enabled", effect: "Free fallback search source. Set BING_HTML_DISABLED=true to stop using it." },

    // ── AI ──
    { key: "GROQ_API_KEY", label: "Groq", area: "ai", set: has(e.GROQ_API_KEY), effect: "Free-tier AI engine for ICP building, personalisation, reply triage and briefs." },
    { key: "GEMINI_API_KEY", label: "Google Gemini", area: "ai", set: has(e.GEMINI_API_KEY), effect: "AI engine; also one of the engines AI visibility sampling asks." },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic", area: "ai", set: has(e.ANTHROPIC_API_KEY), effect: "Paid AI engine, used for paid plans only (free and pilot plans use the free engines)." },
    { key: "OPENAI_COMPAT_BASE_URL", label: "OpenAI-compatible endpoint", area: "ai", set: has(e.OPENAI_COMPAT_BASE_URL), effect: "Any OpenAI-compatible AI endpoint (with OPENAI_COMPAT_API_KEY). Missing every AI key: AI features say AI is not available and fall back to rules." },
    { key: "AI_PROVIDER", label: "AI engine choice", area: "ai", set: has(e.AI_PROVIDER), value: (e.AI_PROVIDER || "auto").toLowerCase(), effect: "Which configured engine wins. auto picks the best one available." },
    { key: "AI_MODELS", label: "AI model overrides", area: "ai", set: has(e.GROQ_MODEL) || has(e.GEMINI_MODEL) || has(e.ANTHROPIC_MODEL) || has(e.OPENAI_COMPAT_MODEL), value: [["groq", e.GROQ_MODEL], ["gemini", e.GEMINI_MODEL], ["anthropic", e.ANTHROPIC_MODEL], ["compat", e.OPENAI_COMPAT_MODEL]].filter(([, v]) => has(v)).map(([k, v]) => `${k}: ${String(v).trim().slice(0, 60)}`).join(", ") || "built-in defaults", effect: "GROQ_MODEL, GEMINI_MODEL, ANTHROPIC_MODEL, OPENAI_COMPAT_MODEL pin a model. Unset: each engine's built-in default." },

    // ── email ──
    { key: "RESEND_API_KEY", label: "Resend (platform mail)", area: "email", set: has(e.RESEND_API_KEY), effect: "Sends sign-up confirmations, password resets, invites, security notices and system-sender campaigns." },
    { key: "SMTP_HOST", label: "SMTP relay (platform mail)", area: "email", set: has(e.SMTP_HOST), effect: "Alternative to Resend for platform mail (with SMTP_USER / SMTP_PASS). With neither, no platform email is sent at all." },
    { key: "MAIL_FROM", label: "Platform sender address", area: "email", set: has(e.MAIL_FROM), effect: "From address for platform mail. Unset: no-reply@localhost, which most inboxes reject." },
    { key: "RESEND_WEBHOOK_SECRET", label: "Bounce and complaint events", area: "email", set: has(e.RESEND_WEBHOOK_SECRET), effect: "Lets Resend report bounces and spam complaints, which suppress the address and stop its sequences. Missing: bounce tracking is off." },
    { key: "OUTBOUND_SENDING_ENABLED", label: "Platform-wide sending switch", area: "email", set: has(e.OUTBOUND_SENDING_ENABLED), value: OFF.test((e.OUTBOUND_SENDING_ENABLED ?? "true").trim()) ? "paused" : "on", effect: "Set to false to pause every campaign send at once (nothing is lost; contacts stay queued)." },
    { key: "SYSTEM_SENDER_DAILY_CAP", label: "System sender daily cap", area: "email", set: has(e.SYSTEM_SENDER_DAILY_CAP), value: has(e.SYSTEM_SENDER_DAILY_CAP) ? e.SYSTEM_SENDER_DAILY_CAP!.trim().slice(0, 12) : "plan based", effect: "Emails a workspace may send per day through the platform's own sender." },
    { key: "ORG_DAILY_SEND_CEILING", label: "Workspace daily send ceiling", area: "email", set: has(e.ORG_DAILY_SEND_CEILING), value: has(e.ORG_DAILY_SEND_CEILING) ? e.ORG_DAILY_SEND_CEILING!.trim().slice(0, 12) : "2000", effect: "Most emails one workspace may send in a day across all its senders." },
    { key: "SMTP_PROBE_ENABLED", label: "SMTP mailbox probe", area: "email", set: has(e.SMTP_PROBE_ENABLED), value: e.SMTP_PROBE_ENABLED === undefined || TRUE.test(e.SMTP_PROBE_ENABLED) ? "on" : "off", effect: "Free email verification by asking the mail server. Most hosts block port 25, in which case it reports nothing." },
    { key: "REOON_API_KEY", label: "Reoon verifier", area: "email", set: has(e.REOON_API_KEY), effect: "Pay-as-you-go email verification. Without any verifier key, verification relies on the SMTP probe and patterns." },
    { key: "MILLIONVERIFIER_API_KEY", label: "MillionVerifier", area: "email", set: has(e.MILLIONVERIFIER_API_KEY), effect: "Pay-as-you-go email verification (tried after Reoon)." },
    { key: "ABSTRACT_EMAIL_API_KEY", label: "Abstract email validation", area: "email", set: has(e.ABSTRACT_EMAIL_API_KEY), effect: "Additional email validation source." },
    { key: "LEAD_NOTIFY_EMAIL", label: "Upgrade request notifications", area: "email", set: has(e.LEAD_NOTIFY_EMAIL) || has(e.ADMIN_EMAIL), effect: "Where upgrade requests are emailed (falls back to ADMIN_EMAIL)." },

    // ── billing ──
    { key: "STRIPE_SECRET_KEY", label: "Stripe checkout", area: "billing", set: has(e.STRIPE_SECRET_KEY), effect: "Online checkout for paid plans. Missing: upgrades arrive as requests in the admin console." },
    { key: "STRIPE_WEBHOOK_SECRET", label: "Stripe billing events", area: "billing", set: stripeWebhook, effect: "Applies paid plans and cancellations automatically. Missing: a paid checkout does not change the plan." },
    ...PRICED_PLANS.map((p): ConfigItem => ({ key: `STRIPE_PRICE_${p.toUpperCase()}`, label: `Stripe price for ${p}`, area: "billing", set: has(e[`STRIPE_PRICE_${p.toUpperCase()}`]), effect: `Lets the ${p} plan be bought online.` })),
    { key: "CHECKOUT_FOLLOWUP", label: "Abandoned checkout reminder", area: "billing", set: has(e.CHECKOUT_FOLLOWUP), value: followup, effect: "on sends one reminder per abandoned checkout; dry_run only records what it would send; off does nothing." },
    { key: "DEFAULT_PLAN", label: "Plan for new workspaces", area: "billing", set: has(e.DEFAULT_PLAN), value: (e.DEFAULT_PLAN || (pilot ? "pilot" : "free")).slice(0, 40), effect: "The plan a new sign-up starts on." },
    { key: "PILOT_MODE", label: "Pilot mode", area: "billing", set: has(e.PILOT_MODE), value: pilot ? "on" : "off", effect: "Pilot sign-ups and pilot plan defaults." },
    { key: "PILOT_INVITE_CODE", label: "Pilot invite code", area: "billing", set: has(e.PILOT_INVITE_CODE), effect: "When set, sign-up needs this code." },

    // ── security ──
    { key: "ADMIN_PASSWORD", label: "Admin console sign-in", area: "security", set: adminPassword && has(e.ADMIN_EMAIL), effect: "ADMIN_EMAIL and ADMIN_PASSWORD open this console. A published example password is switched off at boot." },
    { key: "ADMIN_TOTP_SECRET", label: "Admin two-factor", area: "security", set: has(e.ADMIN_TOTP_SECRET), effect: "Asks for an authenticator code at admin sign-in. Missing: the password alone opens every workspace's plan and status." },
    { key: "ADMIN_API_TOKEN", label: "Admin API token", area: "security", set: adminApiToken, effect: "Server-to-server access to the admin API (x-admin-token header)." },
    { key: "ADMIN_JWT_SECRET", label: "Separate admin session key", area: "security", set: has(e.ADMIN_JWT_SECRET), effect: "Signs admin sessions with their own key, so a leaked JWT_SECRET alone cannot mint one." },
    { key: "INTERNAL_TOKEN", label: "Job runner token", area: "security", set: internalToken, effect: "Protects the internal endpoint an external cron uses to run jobs." },
    { key: "JWT_SECRET", label: "Session signing key", area: "security", set: has(e.JWT_SECRET) && e.JWT_SECRET !== "dev-secret-change-me", effect: "Signs every session. Production refuses to start without a strong one." },
    { key: "ENCRYPTION_KEY", label: "Credential encryption key", area: "security", set: has(e.ENCRYPTION_KEY), effect: "Encrypts stored mail and CRM credentials. Missing: a key derived from JWT_SECRET is used, so rotating JWT_SECRET would lose them." },
    { key: "ENCRYPTION_KEYS_OLD", label: "Previous encryption keys", area: "security", set: has(e.ENCRYPTION_KEYS_OLD), effect: "Keeps credentials saved under an earlier ENCRYPTION_KEY readable after a rotation." },
    { key: "GOOGLE_OAUTH_CLIENT_ID", label: "Sign in with Google", area: "security", set: has(e.GOOGLE_OAUTH_CLIENT_ID) && has(e.GOOGLE_OAUTH_CLIENT_SECRET), effect: "Shows Sign in with Google (needs the client id and secret)." },
    { key: "TRUSTED_PROXY", label: "Client address source", area: "security", set: has(e.TRUSTED_PROXY), value: live ? env.trustedProxy : (e.TRUSTED_PROXY ?? "default").trim().slice(0, 20), effect: "Which proxy header carries the caller's address, for rate limits and sign-in locks." },
    { key: "CORS_ALLOW_REGEX", label: "Extra browser origins (pattern)", area: "security", set: corsRegex !== "default", value: corsRegex === "default" ? "default (Vercel previews)" : corsRegex, effect: "Origins allowed to call the API beyond APP_URL." },
    { key: "CORS_EXTRA_ORIGINS", label: "Extra browser origins (list)", area: "security", set: extraOrigins > 0, value: extraOrigins ? `${extraOrigins} origin${extraOrigins === 1 ? "" : "s"}` : "none", effect: "Exact origins allowed to call the API beyond APP_URL." },

    // ── privacy ──
    { key: "PRIVACY_SWEEP", label: "Retention sweep", area: "privacy", set: has(e.PRIVACY_SWEEP), value: OFF.test((e.PRIVACY_SWEEP ?? "").trim()) ? "off" : "on", effect: "Deletes data past the retention periods the Privacy Policy states. off stops it." },
    { key: "LINK_TOKENS_CLEAR_PLAINTEXT", label: "Clear legacy link tokens", area: "privacy", set: has(e.LINK_TOKENS_CLEAR_PLAINTEXT), value: String(e.LINK_TOKENS_CLEAR_PLAINTEXT ?? "").trim().toLowerCase() === "true" ? "on" : "off", effect: "Removes the readable copy of old report-link tokens once they are hashed." },
    { key: "IP_LOOKUP_ALLOW_PLAIN_HTTP", label: "Plain-HTTP IP lookups", area: "privacy", set: has(e.IP_LOOKUP_ALLOW_PLAIN_HTTP), value: TRUE.test(e.IP_LOOKUP_ALLOW_PLAIN_HTTP ?? "") ? "allowed" : "refused", effect: "Whether visitor IP lookups may go over unencrypted HTTP." },

    // ── runtime ──
    { key: "NODE_ENV", label: "Environment", area: "runtime", set: has(e.NODE_ENV), value: nodeEnv.slice(0, 20), effect: "production turns on the strict secret checks." },
    { key: "JOB_MODE", label: "Job mode", area: "runtime", set: has(e.JOB_MODE), value: jobMode, effect: "worker runs background jobs from the queue; inline runs them inside requests." },
    { key: "EMBED_WORKER", label: "Worker inside the API", area: "runtime", set: has(e.EMBED_WORKER), value: embedded ? "on" : "off", effect: "Runs the job worker in this process. Off: a separate worker process must run, or nothing in the background happens." },
    { key: "WORKER_CONCURRENCY", label: "Worker concurrency", area: "runtime", set: has(e.WORKER_CONCURRENCY), value: (e.WORKER_CONCURRENCY ?? "3").trim().slice(0, 6), effect: "Jobs the embedded worker runs at once." },
    { key: "KEEP_AWAKE", label: "Keep-awake pinger", area: "runtime", set: ka.configured, value: ka.configured ? `${ka.window} ${ka.timeZone}${ka.activeNow ? ", pinging now" : ", outside the window now"}` : "off", effect: "Keeps a free Render instance (and its worker) awake inside the window. Outside it the instance sleeps after 15 idle minutes and no campaign sends or schedules run." },
    { key: "AUTO_MIGRATE", label: "Migrations at start", area: "runtime", set: has(e.AUTO_MIGRATE), value: e.AUTO_MIGRATE === "false" ? "off" : "on", effect: "Applies database migrations when the API starts." },
    { key: "DATABASE_SSL", label: "Database TLS mode", area: "runtime", set: has(e.DATABASE_SSL), value: (e.DATABASE_SSL ?? "default").trim().slice(0, 20), effect: "How the database connection checks TLS." },
    { key: "DB_POOL_MAX", label: "Database pool size", area: "runtime", set: has(e.DB_POOL_MAX), value: (e.DB_POOL_MAX ?? "default").trim().slice(0, 6), effect: "Connections the API keeps to the database." },
    { key: "APP_URL", label: "App address", area: "runtime", set: has(e.APP_URL), effect: "Used in every link Scout emails. Unset: links point at localhost." },
    { key: "API_URL", label: "API address", area: "runtime", set: has(e.API_URL), effect: "Used for tracking links, the pixel and webhooks. Unset: localhost." },
  ];
  return items;
}
