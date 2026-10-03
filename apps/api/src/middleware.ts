import type { Context, MiddlewareHandler } from "hono";
import { authenticate, scopeAllows, verifyAdminJwt, type AuthContext } from "./lib/auth.js";
import { ApiError } from "./lib/errors.js";
import { env } from "./env.js";
import { safeEqual } from "./lib/crypto.js";

export type Env = { Variables: { auth: AuthContext } };

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const header = c.req.header("authorization") ?? (c.req.header("x-api-key") ? `ApiKey ${c.req.header("x-api-key")}` : undefined);
  const auth = await authenticate(header);
  if (!auth) throw new ApiError(401, "Authentication required. Use `Authorization: Bearer <jwt>` or `x-api-key: px_live_...`", "unauthorized");
  if (auth.org.status === "deactivated" || auth.org.status === "revoked") {
    throw new ApiError(403, "This account has been suspended. Contact support to reactivate it.", "account_suspended");
  }
  c.set("auth", auth);
  // A read-only API key may look and not touch. Checked here, once, for every route behind
  // requireAuth - not per route, where the next new route would forget it. (The admin API
  // and the job runner have their own credentials and never come through here.)
  if (!scopeAllows(auth, c.req.method)) {
    await auditScopeDenied(c, auth);
    throw new ApiError(403, READ_ONLY_KEY_MESSAGE, "insufficient_scope");
  }
  await next();
};

export const READ_ONLY_KEY_MESSAGE = "This API key is read-only. Create a full-access key to make changes.";

/**
 * A refused write is worth a line in the workspace's security log - once a minute per key at
 * most, because a script that holds the wrong key retries, and each retry would be a row.
 */
const scopeDeniedAt = new Map<string, number>();
async function auditScopeDenied(c: Context, auth: AuthContext): Promise<void> {
  const id = auth.apiKey?.id;
  if (!id) return;
  const now = Date.now();
  const last = scopeDeniedAt.get(id);
  if (last !== undefined && now - last < 60_000) return;
  if (scopeDeniedAt.size > 5000) scopeDeniedAt.clear();
  scopeDeniedAt.set(id, now);
  // Imported lazily: audit.ts imports this module for clientIp.
  await import("./lib/audit.js")
    .then((m) => m.audit(c, "apikey.scope_denied", { result: "denied", targetType: "api_key", targetId: id, data: { method: c.req.method, path: c.req.path.slice(0, 200), prefix: auth.apiKey?.prefix, scope: "read" } }))
    .catch(() => {});
}

/**
 * Super-admin dashboard auth - a signed admin JWT from POST /v1/admin/login, or a shared
 * token header for server-to-server calls. Not connected to customer accounts.
 *
 * The server-to-server token is ADMIN_API_TOKEN and nothing else. INTERNAL_TOKEN is the job
 * runner's credential: it is pasted into third-party cron services and used to travel in
 * their URLs, so it ends up in access logs. It was accepted here whenever ADMIN_API_TOKEN was
 * unset, which made every one of those log lines a key to every customer's plan and status.
 * With ADMIN_API_TOKEN unset the header path is simply off; the dashboard's password login
 * (which the web admin UI uses exclusively) is unaffected.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  // `x-admin-token` is the documented header. `x-internal-token` is still read as a header
  // NAME, for scripts written against the old docs - but its value must be ADMIN_API_TOKEN.
  const presented = c.req.header("x-admin-token") ?? c.req.header("x-internal-token");
  if (presented && env.adminApiToken && safeEqual(presented, env.adminApiToken)) {
    c.set("adminVia" as never, "token" as never);
    await next();
    return;
  }
  const header = c.req.header("authorization");
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;
  if (token && (await verifyAdminJwt(token))) {
    c.set("adminVia" as never, "session" as never);
    await next();
    return;
  }
  throw new ApiError(401, "Admin authentication required", "unauthorized");
};

/**
 * Guard for the serverless job runner (/internal/jobs/run).
 *
 * Fails CLOSED: with INTERNAL_TOKEN unset the route answers 503 rather than running the
 * queue for anyone who finds the URL.
 *
 * The token is read from the `x-internal-token` header ONLY. `?token=` used to be accepted
 * too, and a secret in a URL is a secret in every access log, proxy log and cron dashboard
 * between the caller and here. cron-job.org (the documented scheduler) supports custom
 * request headers, so nothing needs the URL form.
 */
export const requireInternalToken: MiddlewareHandler = async (c, next) => {
  if (!env.internalToken) throw new ApiError(503, "INTERNAL_TOKEN is not configured on the server, so the job runner endpoint is disabled.", "not_configured");
  const presented = c.req.header("x-internal-token") ?? "";
  if (!presented || !safeEqual(presented, env.internalToken)) {
    const inUrl = c.req.query("token") !== undefined;
    throw new ApiError(403, inUrl ? "The token must be sent in the x-internal-token header, not in the URL." : "forbidden", "forbidden");
  }
  await next();
};

/**
 * Owner/admin-only actions: API keys, org settings, members and invites, webhooks,
 * integrations, billing.
 *
 * An API key has no user and therefore no role. It is an org-level credential that only an
 * owner or admin can create, so it is treated as one; a member's session is not.
 */
export function requireRole(...roles: string[]): MiddlewareHandler<Env> {
  const allowed = roles.length ? roles : ["owner", "admin"];
  return async (c, next) => {
    const a = c.get("auth");
    if (a?.user && !allowed.includes(a.user.role)) {
      // A refused privileged action is exactly what an audit log is for. Imported lazily:
      // audit.ts imports this module for clientIp.
      if (!(c as unknown as { get: (k: string) => unknown }).get("roleAuditHandled")) await import("./lib/audit.js").then((m) => m.audit(c, "role.denied", { result: "denied", data: { method: c.req.method, path: c.req.path, role: a.user!.role, required: allowed } })).catch(() => {});
      throw new ApiError(403, `Only a workspace ${allowed.join(" or ")} can do this. Your role is "${a.user.role}" - ask an owner or admin.`, "forbidden_role");
    }
    await next();
  };
}

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const a = c.get("auth");
  if (!a?.user) throw new ApiError(403, "This endpoint requires a user session (not an API key)", "forbidden");
  await next();
};

/**
 * The caller's IP, as reported by the proxy in front of us - never as claimed by the client.
 *
 * `x-forwarded-for` is a list the client starts and every proxy appends to, so its FIRST
 * entry is whatever the client typed. Keying a limiter on it let anyone rotate a header
 * value and get a fresh bucket on every request, which made the login and signup limits
 * decorative. The RIGHT-most XFF entry is the one our own proxy appended.
 *
 * `cf-connecting-ip` is only trustworthy when Cloudflare is actually in front (it overwrites
 * the header on every request). Render's edge is Cloudflare; Fly and Vercel are not, and
 * there the header is client-controlled - the same rotate-a-header bypass again. Which header
 * to believe is therefore configuration (TRUSTED_PROXY, see env.ts), not a guess:
 *
 *   cloudflare  cf-connecting-ip, then right-most XFF, then x-real-ip
 *   xff         right-most XFF, then x-real-ip (cf-connecting-ip ignored)
 *   none        no proxy: the socket's remote address, headers ignored
 */
export function clientIp(c: Context): string {
  const mode = env.trustedProxy;
  if (mode === "none") return socketAddress(c) ?? "unknown";
  if (mode === "cloudflare") {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return c.req.header("x-real-ip")?.trim() || socketAddress(c) || "unknown";
}

/** The TCP peer, when running under @hono/node-server (absent in tests and on serverless). */
function socketAddress(c: Context): string | undefined {
  try {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress || undefined;
  } catch {
    return undefined;
  }
}

/**
 * In-memory token bucket, one bucket per (limiter, org or IP).
 *
 * Every limiter used to share one bucket per org, so six calls to a 6/min endpoint
 * rate-limited an unrelated 30/min one, and each limiter's numbers were wrong for the
 * others. Each `rateLimit()` call now owns its buckets. Fine for a single instance; swap for
 * a shared store if the API is ever scaled out.
 */
const MAX_BUCKETS = 10_000;
let limiterSeq = 0;
export function rateLimit(opts: { perMinute: number; burst?: number; name?: string }): MiddlewareHandler<Env> {
  const cap = opts.burst ?? opts.perMinute;
  const refill = opts.perMinute / 60_000; // tokens per ms
  const name = opts.name ?? `rl${++limiterSeq}`;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return async (c, next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    const key = `${name}:${auth?.org.id ?? `ip:${clientIp(c)}`}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) * refill);
    b.at = now;
    // Re-inserted on every hit so Map order is least-recently-used first. Clearing the whole
    // map on overflow (as before) handed every caller - including one mid-attack - a full
    // bucket; evicting the stalest keys only forgets callers who went quiet.
    buckets.delete(key);
    buckets.set(key, b);
    if (buckets.size > MAX_BUCKETS) {
      const it = buckets.keys();
      for (let n = buckets.size - MAX_BUCKETS; n > 0; n--) buckets.delete(it.next().value as string);
    }
    if (b.tokens < 1) {
      c.header("retry-after", String(Math.max(1, Math.ceil((1 - b.tokens) / refill / 1000))));
      throw new ApiError(429, "Rate limit exceeded. Wait a moment and try again.", "rate_limited");
    }
    b.tokens -= 1;
    c.header("x-ratelimit-limit", String(opts.perMinute));
    c.header("x-ratelimit-remaining", String(Math.floor(b.tokens)));
    await next();
  };
}

export function orgId(c: Context<Env>) {
  return c.get("auth").org.id;
}
