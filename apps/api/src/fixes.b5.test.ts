/**
 * Fix round B5: public site honesty, web polish, docs, OpenAPI coverage, SDK and MCP.
 *
 * Most of what B5 changed is copy and documentation, so most of these tests read files and
 * pin the claims that were false (and must not come back) or the facts that were missing.
 * The OpenAPI test walks the app's real route table, so a route added later without a doc
 * entry fails here instead of going unnoticed again.
 *
 * No database is needed: building the app and its route table opens no connection.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? "postgres://scout:scout@127.0.0.1:5432/scout_unused";
process.env.JWT_SECRET ??= "x".repeat(48);
process.env.NODE_ENV ??= "test";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const normPath = (p: string) => p.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, "{$1}").replace(/\/$/, "") || "/";

describe("B5 OpenAPI covers the live route table", () => {
  it("documents every route the app registers, with no stale entries", async () => {
    const { createApp } = await import("./app.js");
    const { openapi } = await import("./openapi.js");
    const app = createApp() as unknown as { routes: { method: string; path: string }[] };
    const live = new Set<string>();
    for (const r of app.routes) {
      if (r.method === "ALL" || r.method === "OPTIONS" || r.path.includes("*")) continue;
      live.add(`${r.method} ${normPath(r.path)}`);
    }
    const spec = openapi("http://api.test") as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const m of Object.keys(ops)) if (["get", "post", "put", "patch", "delete"].includes(m)) documented.add(`${m.toUpperCase()} ${p.replace(/\/$/, "") || "/"}`);
    }
    const missing = [...live].filter((x) => !documented.has(x)).sort();
    expect(missing, "routes in the app with no OpenAPI entry").toEqual([]);
    // The pixel script is registered as /px/:file but is documented under its readable name
    // as well; that one alias is the only entry allowed without a route of the same spelling.
    const stale = [...documented].filter((x) => !live.has(x)).sort();
    expect(stale).toEqual(["GET /px/{key}.js"]);
  });

  it("uses 201 where the route answers 201", async () => {
    const { openapi } = await import("./openapi.js");
    const spec = openapi("http://api.test") as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    const createdOnly: [string, string][] = [
      ["/v1/clients", "post"],
      ["/v1/icps", "post"],
      ["/v1/campaigns", "post"],
      ["/v1/leads/lists", "post"],
      ["/v1/webhooks", "post"],
      ["/v1/visibility/prompts", "post"],
      ["/v1/tools/team/invite", "post"],
      ["/v1/upgrade-requests", "post"],
    ];
    for (const [p, m] of createdOnly) {
      const r = spec.paths[p]?.[m]?.responses ?? {};
      expect(Object.keys(r), `${m.toUpperCase()} ${p}`).toContain("201");
      expect(Object.keys(r), `${m.toUpperCase()} ${p}`).not.toContain("200");
    }
    // Create-or-update: 201 when it created, 200 when it updated an existing lead.
    expect(Object.keys(spec.paths["/v1/leads"].post.responses)).toEqual(expect.arrayContaining(["201", "200"]));
    // Already documented methods on a path are kept when new ones are merged in.
    expect(Object.keys(spec.paths["/v1/clients/{id}/share"]).sort()).toEqual(["delete", "post"]);
  });
});

describe("B5 public copy claims only what production does", () => {
  const pages = {
    landing: read("apps/web/src/pages/Landing.tsx"),
    faq: read("apps/web/src/content/faq.ts"),
    llms: read("apps/web/public/llms.txt"),
    index: read("apps/web/index.html"),
  };
  const all = Object.values(pages).join("\n");

  it("does not say Claude or ChatGPT answers are measured, and names the engines sampled today", () => {
    expect(all).not.toMatch(/Gemini, Claude and Llama/);
    expect(all).not.toMatch(/recommended by ChatGPT/);
    expect(pages.landing).toMatch(/Gemini and Llama today/);
    expect(pages.llms).toMatch(/Gemini and Llama today/);
  });

  it("does not claim citation tracking, tech-stack or intent filters, warm-up, a public MCP package or monthly billing", () => {
    expect(all).not.toMatch(/which sources each engine cites/i);
    expect(all).not.toMatch(/tech stack and intent/i);
    expect(pages.landing).not.toMatch(/company size, tech stack/i);
    expect(pages.landing).not.toMatch(/"Warm-up,/);
    expect(all).not.toMatch(/Connect over MCP/);
    expect(all).not.toMatch(/MCP-connected agents/);
    expect(all).not.toMatch(/billed monthly/i);
    expect(pages.llms).not.toMatch(/verifies their email addresses before anything is sent/);
    expect(pages.faq).toMatch(/MCP server is available on request/);
  });

  it("has no em dashes in the copy B5 touched", () => {
    for (const [name, text] of Object.entries(pages)) expect(text.includes("—"), name).toBe(false);
  });
});

describe("B5 web polish", () => {
  it("ships favicon.ico and an apple touch icon, linked from index.html", () => {
    const ico = readFileSync(resolve(ROOT, "apps/web/public/favicon.ico"));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const png = readFileSync(resolve(ROOT, "apps/web/public/apple-touch-icon.png"));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const index = read("apps/web/index.html");
    expect(index).toMatch(/href="\/favicon\.ico"/);
    expect(index).toMatch(/rel="apple-touch-icon"/);
  });

  it("shows a Not Found page for unknown routes instead of redirecting silently", () => {
    expect(existsSync(resolve(ROOT, "apps/web/src/pages/NotFound.tsx"))).toBe(true);
    const main = read("apps/web/src/main.tsx");
    expect(main).not.toMatch(/path="\*" element={<Navigate to="\/" replace \/>}/);
    expect(main).toMatch(/<Route path="\*" element={<NotFoundPage inApp \/>} \/>/);
    expect(main).toMatch(/isAppPath\(loc\.pathname\)/);
  });

  it("gives the landing page a mobile menu button", () => {
    const landing = read("apps/web/src/pages/Landing.tsx");
    expect(landing).toMatch(/data-testid="landing-menu-button"/);
    expect(landing).toMatch(/aria-expanded=\{menuOpen\}/);
  });

  it("makes the modal a labelled dialog with a focus trap that does not discard edits on a backdrop click", () => {
    const ui = read("apps/web/src/components/ui.tsx");
    expect(ui).toMatch(/role="dialog"/);
    expect(ui).toMatch(/aria-modal="true"/);
    expect(ui).toMatch(/aria-labelledby=\{titleId\}/);
    expect(ui).toMatch(/e\.key !== "Tab"/);
    expect(ui).toMatch(/dirtyRef\.current && !confirm\(/);
  });
});

describe("B5 docs match the code", () => {
  it("README explains how the API gets its .env and uses the current name", () => {
    const readme = read("README.md");
    expect(readme.startsWith("# Scout")).toBe(true);
    expect(readme).toMatch(/--env-file=\.\.\/\.\.\/\.env/);
    expect(readme).not.toMatch(/zero-cost/i);
  });

  it("DEPLOY.md and PILOT.md quote the prices in plans.ts and treat Stripe as optional", async () => {
    const { PLANS } = await import("@prospex/db");
    const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
    const deploy = read("DEPLOY.md");
    const pilot = read("docs/PILOT.md");
    for (const id of ["starter", "growth", "scale", "enterprise"]) {
      const price = usd(PLANS[id].priceUsd);
      expect(deploy, `DEPLOY.md ${id}`).toContain(price);
      expect(pilot, `PILOT.md ${id}`).toContain(price);
    }
    for (const old of ["$99.00", "$329.00", "$1,099.00", "$2,999.00"]) expect(deploy).not.toContain(old);
    expect(deploy).toMatch(/### A7\. Billing - OPTIONAL/);
    // Reply ingestion goes to the per-workspace inbound address, not to a Resend webhook.
    expect(deploy).toMatch(/\/v1\/public\/inbound\/<token>/);
    expect(deploy).not.toMatch(/in Resend → Webhooks, or via Zapier/);
    // No outside pinger every 10 minutes: B13's keep-awake window is the one mechanism.
    expect(deploy).not.toMatch(/every 10 min\) so the free instance does not sleep/);
  });

  it(".env.example documents every variable the code reads that was missing", () => {
    const env = read(".env.example");
    for (const v of ["REOON_API_KEY", "MILLIONVERIFIER_API_KEY", "WORKER_CONCURRENCY", "DDG_DISABLED", "BING_HTML_DISABLED", "ROW_CAP_PLAYS", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS"]) {
      expect(env, v).toMatch(new RegExp(`^#? ?${v}=`, "m"));
    }
    expect(env).toMatch(/Unused legacy names/);
  });
});

describe("B5 SDK and MCP", () => {
  it("SDK clients and visibility methods call the existing API routes", async () => {
    const sdk = await import("@prospex/sdk");
    const seen: string[] = [];
    const client = new sdk.Prospex({
      apiKey: "px_live_TEST",
      baseUrl: "https://api.scout.test",
      fetch: (async (url: string, init?: { method?: string }) => {
        seen.push(`${init?.method ?? "GET"} ${String(url).replace("https://api.scout.test", "")}`);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const id = "11111111-2222-4333-8444-555555555555";
    await client.clients.list();
    await client.clients.create({ name: "Acme" });
    await client.clients.get(id);
    await client.clients.createReportLink(id);
    await client.visibility.prompts();
    await client.visibility.addPrompt({ text: "Best payroll software for a small team?" });
    await client.visibility.sampleNow(id, { samples: 2 });
    await client.visibility.results(30);
    expect(seen).toEqual([
      "GET /v1/clients",
      "POST /v1/clients",
      `GET /v1/clients/${id}`,
      `POST /v1/clients/${id}/share`,
      "GET /v1/visibility/prompts",
      "POST /v1/visibility/prompts",
      `POST /v1/visibility/prompts/${id}/run`,
      "GET /v1/visibility/overview?days=30",
    ]);
    // An id that is not a UUID never reaches a request path.
    expect(() => client.clients.get("../admin")).toThrow(/must be an id/);
  });

  it("MCP argument limits match what the API accepts", () => {
    const mcp = read("packages/mcp/src/server.ts");
    const tool = (name: string) => {
      const i = mcp.indexOf(`"${name}"`);
      expect(i, name).toBeGreaterThan(-1);
      return mcp.slice(i, mcp.indexOf("\n", mcp.indexOf("(a) =>", i)));
    };
    expect(tool("signals_scan")).toMatch(/days: z\.number\(\)\.int\(\)\.min\(1\)\.max\(30\)/);
    expect(tool("create_monitor")).toMatch(/intervalMinutes: z\.number\(\)\.int\(\)\.min\(30\)/);
    expect(tool("create_campaign")).toMatch(/delayDays: z\.number\(\)\.int\(\)\.min\(0\)\.max\(60\)/);
    expect(tool("create_icp")).toMatch(/seedDomains: z\.array\(domain\)\.max\(10\)/);
    expect(tool("colleagues")).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(25\)/);
    expect(tool("decision_makers")).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)/);
    for (const t of ["list_clients", "create_client", "get_client", "client_report_link", "list_visibility_prompts", "add_visibility_prompt", "sample_visibility_now", "visibility_results"]) {
      expect(mcp, t).toContain(`"${t}"`);
    }
  });
});
