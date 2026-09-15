import type { Context, MiddlewareHandler } from "hono";
import { authenticate, type AuthContext } from "./lib/auth.js";
import { ApiError } from "./lib/errors.js";

export type Env = { Variables: { auth: AuthContext } };

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const header = c.req.header("authorization") ?? (c.req.header("x-api-key") ? `ApiKey ${c.req.header("x-api-key")}` : undefined);
  const auth = await authenticate(header);
  if (!auth) throw new ApiError(401, "Authentication required. Use `Authorization: Bearer <jwt>` or `x-api-key: gl_...`", "unauthorized");
  c.set("auth", auth);
  await next();
};

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const a = c.get("auth");
  if (!a?.user) throw new ApiError(403, "This endpoint requires a user session (not an API key)", "forbidden");
  await next();
};

/** Simple in-memory token bucket per org/IP. Fine for a single instance; swap for Upstash later. */
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(opts: { perMinute: number; burst?: number }): MiddlewareHandler<Env> {
  const cap = opts.burst ?? opts.perMinute;
  const refill = opts.perMinute / 60_000; // tokens per ms
  return async (c, next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    const key = auth?.org.id ?? c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "anon";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) * refill);
    b.at = now;
    if (b.tokens < 1) {
      c.header("retry-after", "10");
      throw new ApiError(429, "Rate limit exceeded", "rate_limited");
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    c.header("x-ratelimit-limit", String(opts.perMinute));
    c.header("x-ratelimit-remaining", String(Math.floor(b.tokens)));
    await next();
  };
}

export function orgId(c: Context<Env>) {
  return c.get("auth").org.id;
}
