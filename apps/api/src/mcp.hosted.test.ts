/**
 * The hosted MCP endpoint (routes/mcp.ts).
 *
 * The pure half runs everywhere. The database half drives the real endpoint the way an
 * assistant does - initialize, tools/list, tools/call - and is the one that matters, because
 * its whole security claim is "a tool call is an ordinary authenticated request". That is only
 * true if a read-only key is refused a write THROUGH MCP, so the test asks exactly that.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm run test -w apps/api
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiKeyFromHeaders, countToolCalls, firstMcpPlan } from "./routes/mcp.js";

const root = resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8");

describe("hosted MCP: what it accepts as a key", () => {
  it("reads a key from Bearer, ApiKey or x-api-key, and nothing else", () => {
    expect(apiKeyFromHeaders("Bearer px_live_abc", undefined)).toBe("px_live_abc");
    expect(apiKeyFromHeaders("ApiKey px_live_abc", undefined)).toBe("px_live_abc");
    expect(apiKeyFromHeaders(undefined, " px_live_abc ")).toBe("px_live_abc");
    expect(apiKeyFromHeaders("Basic dXNlcjpwYXNz", undefined)).toBeNull();
    expect(apiKeyFromHeaders("Bearer", undefined)).toBeNull();
    expect(apiKeyFromHeaders(undefined, undefined)).toBeNull();
  });

  it("meters tools/call and nothing else, in a single message or a batch", () => {
    expect(countToolCalls({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toBe(1);
    expect(countToolCalls([{ method: "tools/call" }, { method: "tools/list" }, { method: "tools/call" }])).toBe(2);
    for (const m of ["initialize", "tools/list", "notifications/initialized"]) expect(countToolCalls({ method: m })).toBe(0);
    expect(countToolCalls(null)).toBe(0);
  });

  it("names Growth as the cheapest plan with hosted MCP", () => {
    expect(firstMcpPlan()?.id).toBe("growth");
  });

  it("serves the same tool registrations as the stdio server, not a copy", () => {
    const route = read("apps/api/src/routes/mcp.ts");
    const stdio = read("packages/mcp/src/server.ts");
    expect(route).toMatch(/registerScoutTools\(new McpServer/);
    expect(stdio).toMatch(/registerScoutTools\(server, gl\)/);
    // A second definition of any tool would drift from the first.
    expect(stdio).not.toMatch(/server\.tool\(/);
    expect(route).not.toMatch(/\.tool\(/);
  });

  it("has the 60+ tools the landing page says it has", () => {
    const n = read("packages/mcp/src/tools.ts").split("server.tool(").length - 1;
    expect(n).toBeGreaterThanOrEqual(60);
    expect(read("apps/web/src/pages/Landing.tsx")).toMatch(/60\+ (Scout )?tools/);
  });

  it("refuses a browser session and skips the outer scope check (scope is enforced per inner request)", () => {
    const route = read("apps/api/src/routes/mcp.ts");
    expect(route).toMatch(/auth\.via !== "api_key"/);
    // Code, not the header comment that explains why requireAuth is not used.
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/requireAuth/);
    expect(route).toMatch(/app\.fetch\(new Request\(url, \{ \.\.\.init, headers \}\), env\)/);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  delete process.env.PILOT_INVITE_CODE;
} else {
  process.stderr.write(`\n[!] "hosted MCP over HTTP" did NOT run: TEST_DATABASE_URL is not set.\n`);
}
const suite = TEST_DB ? describe : describe.skip;

suite("hosted MCP over HTTP", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let session = "";
  let full = "";
  let readOnly = "";
  let email = "";
  let orgId = "";
  const setPlan = async (plan: string, planLimits: Record<string, unknown> = {}) => {
    const dbPkg = await import("@prospex/db");
    // As an upgrade does: the plan, and its limits stored as the whole merged set.
    await dbPkg.getDb().db.update(dbPkg.organizations).set({ plan, planLimits: { ...dbPkg.limitsFor(plan), ...planLimits } }).where(dbPkg.eq(dbPkg.organizations.id, orgId));
  };
  const used = async () => {
    const dbPkg = await import("@prospex/db");
    return (await dbPkg.getUsage(dbPkg.getDb().db, orgId)).usage.mcpCalls;
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://local${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const rpc = (key: string, body: unknown) => post("/mcp", body, { accept: "application/json, text/event-stream", authorization: `Bearer ${key}` });
  const call = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(key, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
    expect(r.status).toBe(200);
    return (await r.json()).result;
  };

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    const { createApp } = await import("./app.js");
    app = createApp({ print: false } as any);
    email = `mcp-${Date.now()}@example.com`;
    const s = await (await post("/v1/auth/signup", { email, password: "Correct-Horse-9-Battery!", name: "Mcp Test" })).json();
    session = s.token;
    const mk = async (scope: string) => (await (await post("/v1/auth/api-keys", { name: `mcp ${scope}`, scope }, { authorization: `Bearer ${session}` })).json()).key;
    full = await mk("full");
    readOnly = await mk("read");
    // Hosted MCP is a Growth-and-above feature; a new workspace starts on Free.
    const me = await dbPkg.getDb().db.query.users.findFirst({ where: dbPkg.eq(dbPkg.users.email, email) });
    orgId = me!.orgId;
    await setPlan("growth");
  });

  it("refuses no key and a browser session token", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    expect((await post("/mcp", init, { accept: "application/json, text/event-stream" })).status).toBe(401);
    expect((await rpc(session, init)).status).toBe(401);
    const ok = await rpc(full, init);
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.serverInfo.name).toBe("scout");
  });

  it("lists the tools, and a read-only key can read and list", async () => {
    const r = await rpc(readOnly, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.status).toBe(200);
    const names = (await r.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(50);
    for (const n of ["prospect", "find_email", "verify_email", "usage", "create_campaign"]) expect(names).toContain(n);
    expect((await call(readOnly, "usage")).isError).toBeFalsy();
  });

  it("a read-only key is refused a write through MCP, as it is over REST", async () => {
    const res = await call(readOnly, "create_icp", { name: "x", industries: ["software"] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/insufficient_scope/);
  });

  it("charges one mcpCalls per tools/call, and nothing for listing", async () => {
    const before = (await used()).used;
    await rpc(full, { jsonrpc: "2.0", id: 10, method: "tools/list" });
    expect((await used()).used).toBe(before);
    await call(full, "usage");
    expect((await used()).used).toBe(before + 1);
    expect((await used()).limit).toBe(5000);
  });

  it("refuses a plan without hosted MCP, naming the plan that has it", async () => {
    await setPlan("starter");
    try {
      const r = await rpc(full, { jsonrpc: "2.0", id: 11, method: "tools/list" });
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.error.code).toBe("plan_required");
      expect(body.error.message).toMatch(/Growth plan \(\$359\/month\) and above/);
    } finally {
      await setPlan("growth");
    }
  });

  it("stops at the monthly allowance with a JSON-RPC error the assistant can relay", async () => {
    const now = (await used()).used;
    await setPlan("growth", { mcpCallsPerMonth: now + 1 });
    try {
      expect((await call(full, "usage")).isError).toBeFalsy();
      const r = await rpc(full, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "usage", arguments: {} } });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.id).toBe(12);
      expect(body.error.code).toBe(-32002);
      expect(body.error.data).toMatchObject({ code: "quota_exceeded", metric: "mcpCalls" });
      expect((await used()).used).toBe(now + 1);
    } finally {
      await setPlan("growth");
    }
  });

  it("is stateless: no stream to open, no session to end", async () => {
    const get = await app.fetch(new Request("http://local/mcp", { method: "GET", headers: { authorization: `Bearer ${full}` } }));
    expect(get.status).toBe(405);
  });
});
