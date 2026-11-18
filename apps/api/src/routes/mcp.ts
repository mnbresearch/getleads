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

/** `app` is the whole Scout app: the tools call its /v1 routes in process. */
export function mcpRoutes(app: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> }) {
  const r = new Hono<Env>();

  r.post("/", requireApiKey, rateLimit({ perMinute: MCP_PER_MINUTE, name: "mcp" }), async (c) => {
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
