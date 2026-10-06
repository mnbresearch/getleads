import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { randomBytes } from "node:crypto";
import { databaseTlsHint, getDb } from "@prospex/db";
import { env } from "./env.js";
import { describeError, errorHandler } from "./lib/errors.js";
import { withReservationScope } from "./lib/limits.js";
import { requireInternalToken, type Env } from "./middleware.js";
import { authRoutes } from "./routes/auth.js";
import { leadRoutes } from "./routes/leads.js";
import { clientReportPublic, clientRoutes } from "./routes/clients.js";
import { searchRoutes } from "./routes/search.js";
import { icpRoutes } from "./routes/icps.js";
import { companyRoutes } from "./routes/companies.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { trackRoutes } from "./routes/track.js";
import { miscRoutes } from "./routes/misc.js";
import { agentRoutes } from "./routes/agent.js";
import { automationRoutes } from "./routes/automation.js";
import { pixelPublic, visitorRoutes } from "./routes/visitors.js";
import { signalRoutes } from "./routes/signals.js";
import { playRoutes } from "./routes/plays.js";
import { joinRoutes, toolRoutes } from "./routes/tools.js";
import { adminRoutes } from "./routes/admin.js";
import { leadCaptureRoutes } from "./routes/leadCapture.js";
import { visibilityRoutes } from "./routes/visibility.js";
import { docsHtml, openapi, SWAGGER_UI } from "./openapi.js";
import { runMaintenanceTick } from "./jobs.js";
import { emailEventRoutes } from "./routes/emailEvents.js";
import { auditRoutes } from "./routes/audit.js";
import { accountRoutes } from "./routes/account.js";
import { wireToolMeter } from "./lib/toolMeter.js";

// ── Access log ──

/** Query parameters whose VALUE is a credential (or stands in for one) and must never be logged. */
const SECRET_QUERY_KEYS = new Set([
  "token", "u", "code", "state", "key", "api_key", "apikey", "cv", "verifier", "access_token", "id_token", "refresh_token", "secret", "password", "signature", "sig", "authorization", "x-internal-token", "x-admin-token", "x-api-key",
]);
/**
 * Query parameters whose VALUE can be a person's address or name: the look-ups and search
 * boxes. `GET /v1/admin/data-subject?email=...`, `/v1/admin/orgs?q=sara%40...` and
 * `/v1/admin/suppressions?q=...` wrote the address someone was being looked up by into the
 * access log - the one place a data-subject request should leave no new copy. `to` / `from`
 * are here for the same reason (they also carry dates on some APIs; a date is no loss).
 */
const PERSONAL_QUERY_KEYS = new Set(["email", "q", "to", "from", "cc", "bcc", "recipient", "address", "search", "query", "name", "phone", "reply_to", "replyto", "user", "username", "login"]);
const REDACTED = "[redacted]";
/** Something shaped like an email address, as sent (%40) or decoded (@). */
const ADDRESS_SHAPED = /[^\s/@=&]{1,64}(?:@|%40)[^\s/@=&]{1,255}\.[a-z]{2,}/i;

/**
 * A request path + query string that is safe to write to a log.
 *
 * Several URLs on this API carry their credential IN the URL: tracking and unsubscribe links
 * (/t/o|c|u/<token>), the client report (/v1/public/clients/report/<token>), the visitor
 * pixel (/px/<key>), and the OAuth callback (?code=&state=). hono's logger printed all of
 * them verbatim, so the access log was a list of working links - and of INTERNAL_TOKEN, back
 * when the job runner accepted it as ?token=.
 *
 * `path` should be the decoded path (so /%74/o/<token> is recognised too); `rawQuery` is the
 * query string as sent, without the leading "?".
 */
export function redactRequestLine(path: string, rawQuery = ""): string {
  let p = path;
  p = p.replace(/^\/t\/([^/]+)\/.+$/s, (_m, kind: string) => `/t/${kind.slice(0, 8)}/${REDACTED}`);
  p = p.replace(/^\/v1\/public\/clients\/report\/.+$/s, `/v1/public/clients/report/${REDACTED}`);
  p = p.replace(/^\/px\/.+$/s, (m: string) => `/px/${REDACTED}${m.endsWith("/collect") ? "/collect" : m.endsWith(".js") ? ".js" : ""}`);
  // Anything else in a path is a route name or a UUID. Control characters could forge extra
  // log lines, so they never reach the log.
  // An address in a path segment (no route takes one today; a mistyped or probing URL can).
  p = p
    .split("/")
    .map((seg) => (ADDRESS_SHAPED.test(seg) ? REDACTED : seg))
    .join("/");
  p = p.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 300);
  if (!rawQuery) return p;
  const parts = rawQuery
    .slice(0, 2000)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        // An undecodable key cannot be checked against the list, so its value is not trusted.
        return `${REDACTED}=${REDACTED}`;
      }
      // An address sent as the NAME of a parameter ("?sara@example.com" or
      // "?sara%40example.com=1" - a mistyped link does this) is no more loggable than one
      // sent as a value. Without this it was written with "@" turned into "_", still readable.
      if (ADDRESS_SHAPED.test(key) || ADDRESS_SHAPED.test(rawKey)) return eq === -1 ? REDACTED : `${REDACTED}=${REDACTED}`;
      const safeKey = key.replace(/[^\w.\-[\]]/g, "_").slice(0, 40);
      if (eq === -1) return safeKey;
      const k = key.trim().toLowerCase();
      if (SECRET_QUERY_KEYS.has(k) || PERSONAL_QUERY_KEYS.has(k)) return `${safeKey}=${REDACTED}`;
      // Whatever the parameter is called: a value that is an address is not written down.
      if (ADDRESS_SHAPED.test(pair.slice(eq + 1))) return `${safeKey}=${REDACTED}`;
      return `${safeKey}=${pair.slice(eq + 1).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200)}`;
    });
  return parts.length ? `${p}?${parts.join("&")}` : p;
}

/**
 * Request log: method, redacted path, status, time. Never headers (so never Authorization,
 * x-api-key or a cookie) and never a body.
 */
function accessLog(print: (line: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const url = c.req.url;
    const q = url.indexOf("?");
    const line = redactRequestLine(c.req.path, q === -1 ? "" : url.slice(q + 1));
    const method = c.req.method;
    print(`<-- ${method} ${line}`);
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    print(`--> ${method} ${line} ${c.res.status} ${ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}`);
  };
}

// ── Request body limits ──

const KB = 1024;
const MB = 1024 * KB;
export const BODY_LIMITS = { default: 1 * MB, leadImport: 10 * MB, playUpload: 2 * MB, publicPost: 256 * KB } as const;

/** Unauthenticated endpoints: anyone on the internet can POST to these, so they get the smallest allowance. */
const PUBLIC_POST_PREFIXES = ["/px/", "/v1/auth/", "/t/", "/v1/email-events/", "/v1/public/", "/internal/"];
const PUBLIC_POST_PATHS = new Set(["/v1/upgrade-requests", "/v1/admin/login"]);

/**
 * How large a body this request may carry.
 *
 * There was no limit anywhere: a 50 MB body was read into memory in full on any endpoint,
 * signed in or not, and a 20 MB CSV import took a 512 MB instance down. Now:
 *   - 10 MB for the lead import (5,000 leads of CSV or JSON fit several times over);
 *   - 2 MB for a play's upload of people who engaged (2,000 rows fit several times over);
 *   - 256 KB for POSTs that need no authentication (sign-in forms, the visitor pixel,
 *     unsubscribe, provider event hooks) - none of them has a legitimate body near that;
 *   - 1 MB for everything else, including the Stripe webhook: its events are normally a few
 *     KB, but an invoice with many lines is larger and a refused event is a missed payment.
 */
export function bodyLimitFor(method: string, path: string): number {
  if (method === "POST" && path === "/v1/leads/import") return BODY_LIMITS.leadImport;
  // A list of up to 2,000 people who engaged with a post, as rows or as a CSV.
  if (method === "POST" && /^\/v1\/plays\/[^/]+\/upload$/.test(path)) return BODY_LIMITS.playUpload;
  if (method === "POST" && (PUBLIC_POST_PATHS.has(path) || PUBLIC_POST_PREFIXES.some((p) => path.startsWith(p)))) return BODY_LIMITS.publicPost;
  return BODY_LIMITS.default;
}

const humanSize = (n: number) => (n >= MB ? `${n / MB} MB` : `${n / KB} KB`);

/**
 * hono's bodyLimit does the two things that matter: a declared Content-Length over the limit
 * is refused before a byte of the body is read, and a body with no declared length (chunked)
 * is read only up to the limit and then cut off. One limiter per size, picked per request.
 */
function requestBodyLimit(): MiddlewareHandler {
  const limiters = new Map<number, MiddlewareHandler>();
  const limiter = (maxSize: number) => {
    let l = limiters.get(maxSize);
    if (!l) {
      l = bodyLimit({
        maxSize,
        // Written for the person who chose the file or pressed Save, not for the HTTP client.
        onError: (c) =>
          c.json(
            {
              error: {
                code: "payload_too_large",
                message:
                  maxSize === BODY_LIMITS.leadImport
                    ? `That file is too large to import in one go (${humanSize(maxSize)} at most). Split it and import in parts.`
                    : `That request is too large (${humanSize(maxSize)} at most).`,
              },
            },
            413,
          ),
      });
      limiters.set(maxSize, l);
    }
    return l;
  };
  return (c, next) => limiter(bodyLimitFor(c.req.method, c.req.path))(c, next);
}

// ── Response security headers ──

/** Nothing this API returns should load anything, be framed, or be treated as a document. */
const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/** The unsubscribe / link pages: inline styles and a form that posts back to this origin. Nothing else. */
const CSP_PAGES = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function docsCsp(nonce: string): string {
  const api = (() => {
    try {
      return new URL(env.apiUrl).origin;
    } catch {
      return "";
    }
  })();
  return [
    "default-src 'none'",
    // Exactly the pinned bundle (which also carries an SRI hash) and the one inline bootstrap.
    `script-src ${SWAGGER_UI.js} 'nonce-${nonce}'`,
    `style-src ${SWAGGER_UI.css} 'unsafe-inline'`,
    "img-src 'self' data:",
    "font-src data:",
    `connect-src 'self'${api ? ` ${api}` : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Health probes arrive every few seconds; while the database is down each one fails. One log
 * line per 30 seconds says everything the hundredth would.
 */
let lastHealthFailureLog = 0;
function logHealthFailure(e: unknown) {
  const now = Date.now();
  if (now - lastHealthFailureLog < 30_000) return;
  lastHealthFailureLog = now;
  const d = describeError(e);
  console.error(`[api] health check: database unavailable: ${d.name}${d.code ? ` [${d.code}]` : ""}: ${d.message}`);
  // A certificate or handshake problem has a one-line fix; say it next to the error.
  const hint = databaseTlsHint(e);
  if (hint) console.error(hint);
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
/**
 * Which browser origins may call the API: the web app (APP_URL), anything listed in
 * CORS_EXTRA_ORIGINS, localhost (development against a deployed API), and whatever
 * CORS_ALLOW_REGEX matches - by default any https *.vercel.app origin, which keeps Vercel
 * preview deployments working ("none" turns the pattern off). The pattern is always matched
 * against the whole origin (see compileOriginRegex in env.ts). (*.netlify.app and *.pages.dev used to be reflected as well;
 * nothing of ours is hosted there. Add them through CORS_ALLOW_REGEX if that changes.)
 */
export function corsOriginAllowed(origin: string): boolean {
  return origin === env.appUrl || env.corsExtraOrigins.includes(origin) || LOCALHOST_ORIGIN.test(origin) || !!env.corsAllowRegex?.test(origin);
}

export interface AppOptions {
  /**
   * Where request-log lines go. Default: console.log, except under NODE_ENV=test where the
   * log is off. Pass a function to capture the lines (tests do), or false to turn it off.
   */
  accessLog?: ((line: string) => void) | false;
}

export function createApp(opts: AppOptions = {}) {
  wireToolMeter();
  const app = new Hono<Env>();
  app.onError(errorHandler);
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  const print = opts.accessLog === false ? null : opts.accessLog ?? (env.nodeEnv !== "test" ? (line: string) => console.log(line) : null);
  if (print) app.use("*", accessLog(print));
  app.use("*", async (c, next) => {
    await next();
    // Set after the handler so the document routes below can supply their own policy.
    if (!c.res.headers.has("content-security-policy")) c.res.headers.set("content-security-policy", c.req.path.startsWith("/t/") ? CSP_PAGES : CSP_API);
    // Every API answer is one workspace's data, or a token, or an error about them: no cache
    // anywhere - a browser's, a proxy's, a CDN's - should keep a copy. This used to cover only
    // sign-in and admin responses; the public report link (the token is in the URL, so there
    // is no Authorization header to stop a shared cache) and every list of leads were left to
    // whatever heuristic the cache in the middle applied. A route that wants caching sets its
    // own Cache-Control and is left alone.
    const p = c.req.path;
    if ((p.startsWith("/v1/") || p === "/v1" || p.startsWith("/internal/")) && !c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });
  // CORS comes BEFORE the body limit (and before every route). The limiter answers 413 itself
  // without calling the rest of the chain, so with CORS registered after it that 413 carried no
  // Access-Control-Allow-Origin: the browser refused to show it to the web app, and a person
  // uploading a file that was too large was told "Could not reach the server" instead of the
  // size limit. Registered first, the headers are already on the response whatever answers -
  // the limiter, a route, the error handler or the 404 handler.
  app.use("/px/*", cors({ origin: "*", allowMethods: ["POST", "GET", "OPTIONS"], allowHeaders: ["content-type"] }));
  app.use(
    "/v1/*",
    cors({
      // `credentials` is deliberately NOT set. Authentication is a bearer token or an API key
      // in a header, never a cookie, so a page on another origin has nothing to ride on. The
      // one cookie this API sets (g_state, during Google sign-in) is read only on top-level
      // navigations to /v1/auth/google/*; it must never become readable to cross-origin
      // fetches, which is what turning credentials on would do.
      origin: (o) => (!o ? "*" : corsOriginAllowed(o) ? o : env.appUrl),
      // x-confirm-*: the password / two-factor code that re-confirms an export (GET /v1/account/export).
      allowHeaders: ["authorization", "content-type", "x-api-key", "x-internal-token", "x-admin-token", "x-confirm-password", "x-confirm-code"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // content-disposition: so the web app can name the export file it downloads.
      exposeHeaders: ["x-ratelimit-limit", "x-ratelimit-remaining", "retry-after", "content-disposition"],
      maxAge: 86400,
    }),
  );
  // Before anything reads a body.
  app.use("*", requestBodyLimit());
  // Slots a create reserved against a per-workspace ceiling are given back with the answer
  // (lib/limits.ts, "Reservations").
  app.use("*", (_c, next) => withReservationScope(next));

  app.get("/", (c) => c.json({ name: "Scout API", version: "1.0.0", docs: `${env.apiUrl}/docs`, openapi: `${env.apiUrl}/openapi.json`, health: `${env.apiUrl}/health` }));
  app.get("/health", async (c) => {
    try {
      const { sql } = getDb();
      await sql`select 1`;
      return c.json({ ok: true, db: "up", jobMode: env.jobMode, time: new Date().toISOString() });
    } catch (e) {
      // The driver's message names the database host, its port, or the role that was refused
      // ("getaddrinfo ENOTFOUND <host>", "password authentication failed for user ..."). This
      // endpoint is public, so the caller gets the state and a fixed reason; the detail goes
      // to the log, where the operator is.
      logHealthFailure(e);
      return c.json({ ok: false, db: "down", error: "database unavailable" }, 503);
    }
  });
  app.get("/openapi.json", (c) => c.json(openapi(env.apiUrl)));
  app.get("/docs", (c) => {
    // A fresh nonce per response: the only inline script the page may run is the one we wrote.
    const nonce = randomBytes(16).toString("base64");
    c.header("content-security-policy", docsCsp(nonce));
    return c.html(docsHtml(`${env.apiUrl}/openapi.json`, nonce));
  });

  app.route("/v1/auth", authRoutes);
  app.route("/v1/leads", leadRoutes);
  app.route("/v1/clients", clientRoutes);
  // Unauthenticated: the client-facing report, where the token in the URL is the credential.
  app.route("/v1/public", clientReportPublic);
  app.route("/v1/search", searchRoutes);
  app.route("/v1/icps", icpRoutes);
  app.route("/v1/companies", companyRoutes);
  app.route("/v1/campaigns", campaignRoutes);
  app.route("/v1/visibility", visibilityRoutes);
  app.route("/v1/agent", agentRoutes);
  app.route("/v1/automation", automationRoutes);
  app.route("/v1/visitors", visitorRoutes);
  app.route("/v1/signals", signalRoutes);
  app.route("/v1/plays", playRoutes);
  app.route("/v1/tools", toolRoutes);
  app.route("/v1/auth", joinRoutes);
  app.route("/px", pixelPublic);
  app.route("/v1", miscRoutes);
  app.route("/v1", leadCaptureRoutes);
  // The admin password was set, but to a published example value, so sign-in is switched off
  // (env.ts). Say exactly that, in words the operator can act on - the route's own answer for
  // a missing password is "not configured", which sends them looking for a setting they did set.
  app.post("/v1/admin/login", async (c, next) => {
    if (env.adminSignInOff) return c.json({ error: { code: "bad_request", message: env.adminSignInOff } }, 400);
    await next();
  });
  app.route("/v1/admin", adminRoutes);
  app.route("/v1/audit-log", auditRoutes);
  // Workspace export and deletion: owner only, session only, re-confirmed (routes/account.ts).
  app.route("/v1/account", accountRoutes);
  app.route("/t", trackRoutes);
  // Provider delivery events (bounces, complaints). Authenticated by the provider signature, not a session.
  app.route("/v1/email-events", emailEventRoutes);

  /**
   * Serverless job runner: call from an external cron (cron-job.org is free) when JOB_MODE=inline.
   * It also revives the recurring schedulers and reaps dead jobs, which a serverless deploy has
   * no long-lived worker to do. The token check fails closed: with INTERNAL_TOKEN unset the
   * endpoint is disabled rather than open. The token goes in the `x-internal-token` request
   * header, never in the URL. (The Render deployment runs an embedded worker and does not
   * call this endpoint at all.)
   */
  const runJobs = async (c: Context<Env>) => {
    const maxMs = Math.min(Math.max(Number(c.req.query("maxMs") ?? 25_000) || 25_000, 1_000), 55_000);
    const r = await runMaintenanceTick({ maxMs });
    return c.json(r);
  };
  app.post("/internal/jobs/run", requireInternalToken, runJobs);
  app.get("/internal/jobs/run", requireInternalToken, runJobs);

  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));
  return app;
}
