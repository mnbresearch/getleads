/**
 * Hosted MCP: Scout's tools for AI assistants, over HTTP, with nothing to install.
 *
 *   claude mcp add --transport http scout https://<api>/mcp --header "Authorization: Bearer px_live_..."
 *
 * Streamable HTTP in its stateless form: every POST is one JSON-RPC exchange, answered as JSON.
 * There is no session to keep and nothing to expire, so a serverless restart costs nothing.
 *
 * The tools are the SAME registrations the local stdio server uses (packages/mcp/src/tools.ts).
 * They run against an in-process Scout client that calls this app's own /v1 routes with the
 * caller's API key. That is the whole security model and it is deliberate: every tool call is
 * an ordinary authenticated request, so the key's org, its read-only scope, the plan limits,
 * the demo expiry, the per-route rate limits and the audit log all apply exactly as they do to
 * the REST API. Nothing here decides what a key may do.
 *
 * It is a paid-plan feature: hosted MCP is on Growth and above (plans.ts mcpCallsPerMonth),
 * where the plan keeps 80% margin even when an assistant uses every limit it sells
 * (packages/db/src/economics.ts). Each tools/call is metered as one `mcpCalls`; initialize,
 * tools/list and notifications are free, so an assistant can always see what it could do.
 *
 * Three rules:
 *  - API keys only. A browser session token is for the web app; an assistant gets a key the
 *    workspace can see, name and revoke on its own.
 *  - The outer request is NOT scope-checked. MCP is always POST, and requireAuth would refuse
 *    every POST from a read-only key - including tools/list and every read tool. Scope is
 *    enforced on each inner request, where the method is the real one.
 *  - The caller's address travels with the inner requests, so the audit log and any
 *    IP-keyed limit see the assistant's address, not 127.0.0.1.
 */
import { Hono, type Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Prospex } from "@prospex/sdk";
import { registerScoutTools } from "@prospex/mcp/tools";
import { consume, effectiveLimits, getDb, QuotaExceededError, PLANS } from "@prospex/db";
import { authenticate } from "../lib/auth.js";
import { ApiError } from "../lib/errors.js";
import { clientIp, rateLimit, type Env } from "../middleware.js";

export const MCP_SERVER_NAME = "scout";
export const MCP_SERVER_VERSION = "1.0.0";
/** An MCP call fans out into one or more /v1 calls, each with its own route limit. This bounds the fan-in. */
export const MCP_PER_MINUTE = 120;

/** The raw API key from `Authorization: Bearer <key>`, `Authorization: ApiKey <key>` or `x-api-key`. */
export function apiKeyFromHeaders(authorization: string | undefined, xApiKey: string | undefined): string | null {
  if (xApiKey?.trim()) return xApiKey.trim();
  if (!authorization) return null;
  const [scheme, token] = authorization.trim().split(/\s+/);
  if (!token || !/^(bearer|apikey)$/i.test(scheme)) return null;
  return token;
}

const requireApiKey = async (c: Context<Env>, next: () => Promise<void>) => {
  const key = apiKeyFromHeaders(c.req.header("authorization"), c.req.header("x-api-key"));
  const auth = key ? await authenticate(`ApiKey ${key}`) : null;
  if (!auth || auth.via !== "api_key") {
    throw new ApiError(401, "The Scout MCP endpoint takes an API key: `Authorization: Bearer px_live_...`. Create one in Settings -> API keys.", "unauthorized");
  }
  if (auth.org.status === "deactivated" || auth.org.status === "revoked") {
    throw new ApiError(403, "This account has been suspended. Contact support to reactivate it.", "account_suspended");
  }
  c.set("auth", auth);
  await next();
};

/** The cheapest plan that includes hosted MCP, for the refusal message. */
export function firstMcpPlan(): { id: string; name: string; priceUsd: number } | null {
  const plans = Object.entries(PLANS)
    .filter(([, p]) => (p.limits.mcpCallsPerMonth ?? 0) > 0 && p.priceUsd > 0)
    .sort((a, b) => a[1].priceUsd - b[1].priceUsd);
  return plans.length ? { id: plans[0][0], name: plans[0][1].name, priceUsd: plans[0][1].priceUsd } : null;
}

/** How many tools/call messages a JSON-RPC body carries (a single message or a batch). */
export function countToolCalls(body: unknown): number {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.filter((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call").length;
}

const rpcError = (body: unknown, code: number, message: string, data?: Record<string, unknown>) => {
  const id = !Array.isArray(body) && body && typeof body === "object" ? ((body as { id?: unknown }).id ?? null) : null;
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
};

/** `app` is the whole Scout app: the tools call its /v1 routes in process. */
export function mcpRoutes(app: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> }) {
  const r = new Hono<Env>();

  r.post("/", requireApiKey, rateLimit({ perMinute: MCP_PER_MINUTE, name: "mcp" }), async (c) => {
    const auth = c.get("auth");
    // The plan gate. A limit of 0 means the plan has no hosted MCP (not "unlimited"), the
    // same convention as premiumLeadsPerMonth. Refused with 403 before anything runs, and the
    // message names the plan that has it, because "upgrade" with no plan name sends people hunting.
    const allowance = effectiveLimits(auth.org).mcpCallsPerMonth ?? 0;
    if (allowance <= 0) {
      const p = firstMcpPlan();
      throw new ApiError(403, `Hosted MCP is included on ${p ? `the ${p.name} plan ($${p.priceUsd}/month) and above` : "paid plans"}. Your API key still works with the REST API. Upgrade in Settings -> Billing.`, "plan_required");
    }
    // Meter tools/call only. A body that is not JSON goes to the transport, which answers it
    // with a JSON-RPC parse error; it calls no tool, so there is nothing to charge.
    const body = await c.req.raw.clone().json().catch(() => null);
    const calls = countToolCalls(body);
    if (calls > 0) {
      try {
        await consume(getDb().db, auth.org.id, "mcpCalls", calls);
      } catch (e) {
        if (!(e instanceof QuotaExceededError)) throw e;
        // A JSON-RPC answer the assistant can read and relay, with HTTP 200 as the transport
        // expects for a delivered message. The data says exactly what ran out.
        return c.json(rpcError(body, -32002, e.message, { code: "quota_exceeded", metric: "mcpCalls", used: e.used, limit: e.limit }));
      }
    }
    const key = apiKeyFromHeaders(c.req.header("authorization"), c.req.header("x-api-key"))!;
    const ip = clientIp(c);
    const env = c.env;
    const client = new Prospex({
      apiKey: key,
      baseUrl: "http://127.0.0.1",
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-forwarded-for", ip);
        headers.set("cf-connecting-ip", ip);
        headers.set("x-real-ip", ip);
        return Promise.resolve(app.fetch(new Request(url, { ...init, headers }), env));
      },
    });
    const server = registerScoutTools(new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }), client);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });

  // Stateless: there is no server-to-client stream to open and no session to end.
  const notHere = (c: Context) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Scout's MCP endpoint is stateless: send JSON-RPC with POST." }, id: null }, 405, { allow: "POST" });
  r.get("/", notHere);
  r.delete("/", notHere);
  return r;
}
