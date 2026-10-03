/**
 * Regression tests for the SSRF findings on the API side (security validation, areas B/C/D).
 *
 *   F2  a `linkedin_post` monitor fetched whatever its target said, redirects followed.
 *   F3  webhook-style CRM delivery followed redirects, re-sending the lead wherever a 3xx
 *       pointed, and only checked the URL as a string.
 *   F4  Zoho `apiDomain` and Pipedrive `companyDomain` were request hosts taken straight
 *       from tenant config (`apiDomain: "http://127.0.0.1:PORT/internal?x="`), and the
 *       first bytes of whatever answered were stored in the job error.
 *   F6  every SMTP transport connected to whatever host a tenant typed, on any port; the
 *       send path had no check at all.
 *
 * An "internal service" is a listener on 127.0.0.1 that records what reaches it; the
 * assertion that matters in most of these tests is that NOTHING does. DNS is decided by
 * stubbing `dns.lookup`, the seam production resolves through.
 *
 * The first half needs no database. The second half (syncLead, runMonitor) does, and is
 * skipped - loudly - without TEST_DATABASE_URL, like the other DB-backed suites.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "x".repeat(48);
process.env.ENCRYPTION_KEY ??= "y".repeat(48);
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_ALLOWED_PORTS;
process.env.SMTP_PROBE_ENABLED = "false";

if (!TEST_DB) {
  process.stderr.write(`\n[!] "security: SSRF (database-backed half)" did NOT run: TEST_DATABASE_URL is not set.\n`);
}

type Addr = { address: string; family: 4 | 6 };

/** Decide what names resolve to. A name not in the table does not exist. */
function stubDns(table: Record<string, Addr[]>) {
  const calls: string[] = [];
  vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: unknown, cb: unknown) => {
    const callback = (typeof options === "function" ? options : cb) as (e: Error | null, a?: unknown, f?: number) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    // `server.listen(0, "127.0.0.1")` goes through dns.lookup too. A literal is its own answer.
    if (net.isIP(hostname)) {
      const fam = net.isIP(hostname) as 4 | 6;
      return process.nextTick(() => (all ? callback(null, [{ address: hostname, family: fam }]) : callback(null, hostname, fam)));
    }
    calls.push(hostname);
    const list = table[hostname];
    process.nextTick(() => {
      if (!list?.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
      if (all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  }) as never);
  return { calls };
}

const servers: Server[] = [];

/** A stand-in for an internal service: a loopback listener that records every request. */
async function internalService(handler?: (req: IncomingMessage) => { status?: number; headers?: Record<string, string>; body?: string }) {
  const hits: { method: string; url: string; auth?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const r = handler?.(req) ?? {};
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.body ?? JSON.stringify({ data: [{ details: { id: "internal-id-1" }, message: "INTERNAL-SERVICE-RESPONSE secret=abc" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return { port: addr.port, base: `http://127.0.0.1:${addr.port}`, hits };
}

/** Replace global fetch and record what it was asked for. */
function stubFetch(impl: (url: string, init: RequestInit & { dispatcher?: unknown }) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit & { dispatcher?: unknown } }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return impl(String(url), init);
    }),
  );
  return calls;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SMTP_ALLOWED_PORTS;
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/* ───────────────────────── F4: integration config validation ───────────────────────── */

describe("F4: validateIntegrationConfig", () => {
  it("zoho: apiDomain must be one of Zoho's API hosts, https, nothing after the domain", async () => {
    const { validateIntegrationConfig } = await import("./services/integrations.js");
    const bad = [
      "http://127.0.0.1:41343/internal?x=", // the payload from the report
      "http://127.0.0.1:9",
      "http://169.254.169.254",
      "https://169.254.169.254",
      "https://www.zohoapis.in.attacker.example",
      "https://attacker.example/www.zohoapis.in",
      "https://www.zohoapis.in@attacker.example",
      "https://user:pw@www.zohoapis.in",
      "https://www.zohoapis.in:8443",
      "https://www.zohoapis.in/crm/v2/../../x",
      "https://www.zohoapis.in/?x=",
      "http://www.zohoapis.in", // https only: the token is a bearer credential
      "https://accounts.zoho.in",
      "https://evilzohoapis.in",
      "ftp://www.zohoapis.in",
      "//attacker.example",
      "localhost",
    ];
    for (const apiDomain of bad) {
      const r = validateIntegrationConfig("zoho", { accessToken: "t", apiDomain });
      expect({ apiDomain, ok: r.ok }).toEqual({ apiDomain, ok: false });
      if (!r.ok) expect(r.message).toMatch(/Zoho API domain/);
    }
    for (const [given, stored] of [
      ["https://www.zohoapis.in", "https://www.zohoapis.in"],
      ["https://www.zohoapis.com/", "https://www.zohoapis.com"],
      ["https://www.zohoapis.eu", "https://www.zohoapis.eu"],
      ["https://www.zohoapis.com.au", "https://www.zohoapis.com.au"],
      ["https://www.zohoapis.jp", "https://www.zohoapis.jp"],
      ["https://www.zohoapis.ca", "https://www.zohoapis.ca"],
      ["https://www.zohoapis.sa", "https://www.zohoapis.sa"],
      ["https://www.zohoapis.com.cn", "https://www.zohoapis.com.cn"],
      ["  HTTPS://WWW.ZOHOAPIS.IN  ", "https://www.zohoapis.in"],
      ["www.zohoapis.in", "https://www.zohoapis.in"],
      ["zohoapis.in", "https://www.zohoapis.in"],
    ]) {
      expect(validateIntegrationConfig("zoho", { accessToken: "t", apiDomain: given })).toEqual({ ok: true, config: { accessToken: "t", apiDomain: stored } });
    }
    // Optional: left out or blank means the default data centre.
    expect(validateIntegrationConfig("zoho", { accessToken: "t" })).toEqual({ ok: true, config: { accessToken: "t" } });
    expect(validateIntegrationConfig("zoho", { accessToken: "t", apiDomain: "" })).toEqual({ ok: true, config: { accessToken: "t" } });
  });

  it("pipedrive: companyDomain must be a single subdomain label", async () => {
    const { validateIntegrationConfig } = await import("./services/integrations.js");
    const bad = [
      "127.0.0.1:41343/x?", // the payload from the report
      "169.254.169.254/latest/meta-data/?x=", // the other one: host/path?x= swallowing ".pipedrive.com"
      "attacker.example/",
      "attacker.example#",
      "a.b",
      "acme@attacker.example",
      "acme:8443",
      "acme/..",
      "-acme",
      "acme-",
      "a".repeat(64),
      "acme pipedrive",
      "acme\n.attacker.example",
    ];
    for (const companyDomain of bad) {
      const r = validateIntegrationConfig("pipedrive", { apiToken: "t", companyDomain });
      expect({ companyDomain, ok: r.ok }).toEqual({ companyDomain, ok: false });
    }
    for (const [given, stored] of [
      ["mycompany", "mycompany"],
      ["MyCompany", "mycompany"],
      ["my-company-2", "my-company-2"],
      ["mycompany.pipedrive.com", "mycompany"],
      ["https://mycompany.pipedrive.com/", "mycompany"],
    ]) {
      expect(validateIntegrationConfig("pipedrive", { apiToken: "t", companyDomain: given })).toEqual({ ok: true, config: { apiToken: "t", companyDomain: stored } });
    }
    expect(validateIntegrationConfig("pipedrive", { apiToken: "t", companyDomain: "" })).toEqual({ ok: true, config: { apiToken: "t" } });
  });

  it("webhook-style providers: url must be http(s) and a public address", async () => {
    const { validateIntegrationConfig } = await import("./services/integrations.js");
    for (const provider of ["webhook", "cortex", "sheets"]) {
      for (const url of ["http://127.0.0.1:8080/hook", "http://localhost/hook", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fd00:ec2::254]/", "http://2130706433/", "http://0x7f.0.0.1/", "http://db.internal/hook", "http://redis:6379/", "https://user:pw@10.0.0.5/hook", "ftp://hooks.acme.com/x", "file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO", "javascript:alert(1)", "hooks.acme.com/x", ""]) {
        const r = validateIntegrationConfig(provider, { url });
        expect({ provider, url, ok: r.ok }).toEqual({ provider, url, ok: false });
      }
      expect(validateIntegrationConfig(provider, { url: "https://hooks.zapier.com/hooks/catch/1/abc/" })).toEqual({ ok: true, config: { url: "https://hooks.zapier.com/hooks/catch/1/abc/" } });
    }
    // HTTP Basic in a customer's own webhook URL is allowed; the fragment is not stored.
    expect(validateIntegrationConfig("webhook", { url: "https://user:pw@hooks.acme.com/in#frag", authHeader: "Bearer abc" })).toEqual({ ok: true, config: { url: "https://user:pw@hooks.acme.com/in", authHeader: "Bearer abc" } });
    // A refusal never echoes credentials from the URL.
    const refused = validateIntegrationConfig("webhook", { url: "https://user:hunter2@10.0.0.5/hook" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).not.toMatch(/hunter2/);
    // Header injection.
    expect(validateIntegrationConfig("webhook", { url: "https://hooks.acme.com/in", authHeader: "Bearer x\r\nX-Evil: 1" }).ok).toBe(false);
  });

  it("drops keys a known provider does not read, keeps everything for the channel providers, and still checks their url", async () => {
    const { validateIntegrationConfig } = await import("./services/integrations.js");
    expect(validateIntegrationConfig("zoho", { accessToken: " t ", apiDomain: "https://www.zohoapis.in", evilKey: "v", url: "http://127.0.0.1/" })).toEqual({ ok: true, config: { accessToken: "t", apiDomain: "https://www.zohoapis.in" } });
    expect(validateIntegrationConfig("hubspot", { accessToken: "t", apiDomain: "http://127.0.0.1", nested: { a: 1 } })).toEqual({ ok: true, config: { accessToken: "t" } });
    // Not a lead-sync provider: its keys are its own business.
    expect(validateIntegrationConfig("whatsapp", { phoneNumberId: "1", accessToken: "t", templateName: "hello", templateLanguage: "en" })).toEqual({ ok: true, config: { phoneNumberId: "1", accessToken: "t", templateName: "hello", templateLanguage: "en" } });
    expect(validateIntegrationConfig("whatsapp", { accessToken: "t", url: "http://169.254.169.254/" }).ok).toBe(false);
    for (const notAnObject of [null, undefined, "x", 1, []]) expect(validateIntegrationConfig("zoho", notAnObject).ok).toBe(false);
  });
});

/* ─────────────────────────── F3: webhook-style delivery ─────────────────────────────── */

describe("F3: postJsonToTenantUrl", () => {
  it("refuses a private address - by literal and by what the name resolves to - without connecting", async () => {
    const { postJsonToTenantUrl } = await import("./services/integrations.js");
    const internal = await internalService();
    stubDns({ "hooks.attacker.example": [{ address: "127.0.0.1", family: 4 }], "meta.attacker.example": [{ address: "169.254.169.254", family: 4 }] });

    for (const url of [`${internal.base}/hook`, `http://localhost:${internal.port}/hook`, `http://[::ffff:127.0.0.1]:${internal.port}/hook`, `http://2130706433:${internal.port}/hook`, `http://hooks.attacker.example:${internal.port}/hook`, "http://meta.attacker.example/latest/meta-data/", "file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO"]) {
      const r = await postJsonToTenantUrl(url, { body: JSON.stringify({ lead: { email: "secret@lead.example" } }) });
      expect({ url, ok: r.ok }).toEqual({ url, ok: false });
      expect(r.error).toMatch(/not a public address|does not resolve to a public address|not an http\(s\) URL/);
    }
    expect(internal.hits).toEqual([]);
  });

  it("a redirect is a failed delivery: reported as one, and the lead is not sent to where it points", async () => {
    const { postJsonToTenantUrl } = await import("./services/integrations.js");
    const internal = await internalService();
    for (const status of [301, 302, 303, 307, 308]) {
      const calls = stubFetch(() => new Response("redirecting", { status, headers: { location: `${internal.base}/steal` } }));
      const r = await postJsonToTenantUrl("https://hooks.acme.example/in", { body: '{"lead":"secret"}' });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(status);
      expect(r.error).toMatch(/redirect/i);
      expect(r.error).toMatch(/not followed/i);
      // One request: the POST that was asked for. Nothing to the Location.
      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.redirect).toBe("manual");
      expect(calls[0].init.dispatcher).toBeDefined();
      vi.unstubAllGlobals();
    }
    // A redirect to another PUBLIC host is not followed either: the payload goes only
    // where the customer typed.
    const calls = stubFetch(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/in" } }));
    const r = await postJsonToTenantUrl("https://hooks.acme.example/in", { body: "{}" });
    expect(r.ok).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(["https://hooks.acme.example/in"]);
    expect(internal.hits).toEqual([]);
  });

  it("Google Apps Script's 302 is the one redirect that is completed - with a GET, no payload, on Google's hosts only", async () => {
    const { postJsonToTenantUrl } = await import("./services/integrations.js");
    const calls = stubFetch((url) =>
      url.startsWith("https://script.google.com/") ? new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?user_content_key=k" } }) : new Response('{"ok":true}', { status: 200 }),
    );
    const r = await postJsonToTenantUrl("https://script.google.com/macros/s/AKfy/exec", { body: '{"lead":"x"}' });
    expect(r).toEqual({ ok: true, status: 200, error: undefined });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "https://script.google.com/macros/s/AKfy/exec"],
      ["GET", "https://script.googleusercontent.com/macros/echo?user_content_key=k"],
    ]);
    expect(calls[1].init.body).toBeUndefined();
    vi.unstubAllGlobals();

    // The exception is for Google's hosts. An "Apps Script" that points anywhere else is a redirect like any other.
    const internal = await internalService();
    const evil = stubFetch(() => new Response(null, { status: 302, headers: { location: `${internal.base}/steal` } }));
    const bad = await postJsonToTenantUrl("https://script.google.com/macros/s/AKfy/exec", { body: "{}" });
    expect(bad.ok).toBe(false);
    expect(evil).toHaveLength(1);
    expect(internal.hits).toEqual([]);
  });

  it("never returns the response body: an error is a status code, nothing the endpoint said", async () => {
    const { postJsonToTenantUrl } = await import("./services/integrations.js");
    stubFetch(() => new Response("INTERNAL-SERVICE-RESPONSE secret=abc", { status: 500 }));
    const r = await postJsonToTenantUrl("https://hooks.acme.example/in", { body: "{}" });
    expect(r).toEqual({ ok: false, status: 500, error: "HTTP 500" });
    vi.unstubAllGlobals();

    // A connection failure says which endpoint, not what the socket error was.
    stubFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), { code: "ECONNREFUSED" }) });
    });
    const down = await postJsonToTenantUrl("https://user:hunter2@hooks.acme.example/in?token=t0p", { body: "{}" });
    expect(down.ok).toBe(false);
    expect(down.error).toBe("https://hooks.acme.example/in could not be reached");
    expect(JSON.stringify(down)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2|t0p/);
  });

  it("sends HTTP Basic for credentials in the URL, and an ordinary 2xx is a delivery", async () => {
    const { postJsonToTenantUrl } = await import("./services/integrations.js");
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const r = await postJsonToTenantUrl("https://user:pw@hooks.acme.example/in", { body: '{"a":1}', headers: { "x-prospex-event": "lead.created" } });
    expect(r).toEqual({ ok: true, status: 200, error: undefined });
    expect(calls[0].url).toBe("https://hooks.acme.example/in");
    const h = new Headers(calls[0].init.headers);
    expect(h.get("authorization")).toBe(`Basic ${Buffer.from("user:pw").toString("base64")}`);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("x-prospex-event")).toBe("lead.created");
    expect(calls[0].init.body).toBe('{"a":1}');
  });
});

/* ───────────────────────────────── F6: the mailer ───────────────────────────────────── */

describe("F6: tenant SMTP transports", () => {
  const input = { from: "A <a@acme.example>", to: "lead@target.example", subject: "s", text: "t" };

  async function load() {
    const nodemailer = (await import("nodemailer")).default;
    const mailer = await import("./lib/mailer.js");
    const transports: Record<string, unknown>[] = [];
    vi.spyOn(nodemailer, "createTransport").mockImplementation(((opts: Record<string, unknown>) => {
      transports.push(opts);
      return { verify: async () => true, sendMail: async () => ({ messageId: "<m@test>" }) };
    }) as never);
    return { mailer, transports };
  }

  it("refuses an SMTP host that is, or resolves to, a private address - on the send path and the test path", async () => {
    const { mailer, transports } = await load();
    stubDns({
      "smtp.attacker.example": [{ address: "10.0.0.5", family: 4 }],
      "rebind.attacker.example": [{ address: "142.250.1.109", family: 4 }, { address: "127.0.0.1", family: 4 }],
      "v6.attacker.example": [{ address: "fd00:ec2::254", family: 6 }],
    });
    const connect = vi.spyOn(net, "createConnection");
    for (const host of ["smtp.attacker.example", "rebind.attacker.example", "v6.attacker.example", "127.0.0.1", "localhost", "10.0.0.5", "169.254.169.254", "[::1]", "::ffff:127.0.0.1", "0x7f.0.0.1", "2130706433", "postgres", "db.internal", "user@127.0.0.1"]) {
      const cfg = { provider: "smtp" as const, smtp: { host, port: 587, user: "u", pass: "p" } };
      const sent = await mailer.sendMail(cfg, input);
      expect({ host, ok: sent.ok }).toEqual({ host, ok: false });
      expect(sent.error).toMatch(/must be a public mail server/);
      const tested = await mailer.testMailer(cfg);
      expect({ host, ok: tested.ok, refused: tested.refused }).toEqual({ host, ok: false, refused: true });
      expect(tested.error).toMatch(/must be a public mail server/);
    }
    expect(transports).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects to the IP it vetted, keeping the typed name for TLS", async () => {
    const { mailer, transports } = await load();
    const { calls } = stubDns({ "smtp.acme.example": [{ address: "2a00:1450:4001:81b::200e", family: 6 }, { address: "142.250.1.109", family: 4 }] });

    const sent = await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.acme.example", port: 587, user: "u", pass: "p" } }, input);
    expect(sent).toEqual({ ok: true, provider: "smtp", providerMessageId: "<m@test>" });
    // Bounded timeouts: a host that drops the connection must not hold a request or a worker for minutes.
    const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
    expect(transports[0]).toEqual({ host: "142.250.1.109", port: 587, secure: false, auth: { user: "u", pass: "p" }, ...timeouts, servername: "smtp.acme.example", tls: { servername: "smtp.acme.example" } });

    expect(await mailer.testMailer({ provider: "smtp", smtp: { host: "smtp.acme.example", port: 465 } })).toEqual({ ok: true });
    expect(transports[1]).toEqual({ host: "142.250.1.109", port: 465, secure: true, auth: undefined, ...timeouts, servername: "smtp.acme.example", tls: { servername: "smtp.acme.example" } });
    // Resolved once per transport, by us. nodemailer is handed an address, so it resolves nothing.
    expect(calls).toEqual(["smtp.acme.example", "smtp.acme.example"]);

    // A public IP typed as the host has no name to verify against, as before.
    await mailer.sendMail({ provider: "smtp", smtp: { host: "8.8.8.8", port: 25 } }, input);
    expect(transports[2]).toEqual({ host: "8.8.8.8", port: 25, secure: false, auth: undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  });

  it("only mail ports: the transport is not a port scanner for public hosts either", async () => {
    const { mailer, transports } = await load();
    stubDns({ "smtp.acme.example": [{ address: "142.250.1.109", family: 4 }] });
    for (const port of [22, 80, 443, 3306, 5432, 6379, 8080, 0, -1, 65536, Number.NaN]) {
      const cfg = { provider: "smtp" as const, smtp: { host: "smtp.acme.example", port } };
      const sent = await mailer.sendMail(cfg, input);
      expect({ port, ok: sent.ok }).toEqual({ port, ok: false });
      expect(sent.error).toMatch(/SMTP port is not allowed/);
      expect((await mailer.testMailer(cfg)).refused).toBe(true);
    }
    expect(transports).toEqual([]);
    for (const port of [25, 26, 465, 587, 2465, 2525, 2587]) {
      expect((await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.acme.example", port } }, input)).ok).toBe(true);
    }
    expect(transports).toHaveLength(7);
    // A deployment can add to the list without a code change.
    process.env.SMTP_ALLOWED_PORTS = "1025, 8025";
    expect((await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.acme.example", port: 8025 } }, input)).ok).toBe(true);
  });

  it("a refusal is never mistaken for a hard bounce of the recipient", async () => {
    const { mailer } = await load();
    const { isHardBounce } = await import("./services/campaigns.js");
    stubDns({ "smtp.550.example": [{ address: "10.0.0.5", family: 4 }] });
    for (const smtp of [{ host: "smtp.550.example", port: 587 }, { host: "smtp.acme.example", port: 550 }, { host: "5.1.1.no-such-host.example", port: 587 }]) {
      const r = await mailer.sendMail({ provider: "smtp", smtp }, input);
      expect(r.ok).toBe(false);
      expect({ error: r.error, bounce: isHardBounce(r.error) }).toEqual({ error: r.error, bounce: false });
    }
  });

  it("a setting we refused is marked as ours on the SEND path too, and its message reaches the customer as written", async () => {
    // The upgrade rehearsal: a sender saved on port 2526 before ports were restricted. Every
    // send through it failed with "The sending provider rejected the message" - nothing was
    // rejected by any provider; we refused the port, and the customer was not told which.
    const { mailer, transports } = await load();
    const { sendFailureCategory } = await import("./services/campaigns.js");
    stubDns({ "smtp.acme.example": [{ address: "142.250.1.109", family: 4 }], "smtp.rebound.example": [{ address: "10.0.0.5", family: 4 }] });
    const port = await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.acme.example", port: 2526 } }, input);
    expect(port).toMatchObject({ ok: false, refused: true });
    expect(port.error).toMatch(/^That SMTP port is not allowed\. Use one of the standard mail ports: 25, 26, 465, 587, 2465, 2525, 2587\.$/);
    expect(sendFailureCategory(port)).toBe(port.error);
    // A host that is not public, and one that does not exist: also ours, also passed through.
    const priv = await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.rebound.example", port: 587 } }, input);
    expect(priv).toMatchObject({ ok: false, refused: true });
    expect(sendFailureCategory(priv)).toMatch(/^SMTP host must be a public mail server address/);
    const gone = await mailer.sendMail({ provider: "smtp", smtp: { host: "no-such-host.example", port: 587 } }, input);
    expect(gone).toMatchObject({ ok: false, refused: true });
    expect(sendFailureCategory(gone)).toBe("The SMTP host could not be found. Check the spelling.");
    expect(transports).toEqual([]);
    // What a SERVER said is still never passed through: it gets a category.
    const nodemailer = (await import("nodemailer")).default;
    vi.mocked(nodemailer.createTransport).mockImplementation((() => ({
      sendMail: async () => {
        throw new Error("connect ECONNREFUSED 142.250.1.109:587 (relay mx-internal-3)");
      },
    })) as never);
    const down = await mailer.sendMail({ provider: "smtp", smtp: { host: "smtp.acme.example", port: 587 } }, input);
    expect(down.ok).toBe(false);
    expect(down.refused).toBeUndefined();
    expect(sendFailureCategory(down)).toBe("The sending server could not be reached");
  });

  it("the platform's own mailer is trusted configuration and is not blocked", async () => {
    const { mailer, transports } = await load();
    const { env } = await import("./env.js");
    const before = { ...env.smtp };
    Object.assign(env.smtp, { host: "127.0.0.1", port: 1025, user: "", pass: "", secure: false });
    try {
      stubDns({});
      expect((await mailer.sendMail(null, input)).ok).toBe(true);
      expect((await mailer.sendMail({ provider: "system" }, input)).ok).toBe(true);
      expect(transports).toHaveLength(2);
      expect(transports[0]).toMatchObject({ host: "127.0.0.1", port: 1025 });
      expect(transports[0]).not.toHaveProperty("servername");
    } finally {
      Object.assign(env.smtp, before);
    }
  });
});

/* ───────────────────────── database-backed: syncLead, runMonitor ────────────────────── */

const suite = TEST_DB ? describe : describe.skip;

suite("security: SSRF (database-backed half)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let schema: any;
  let syncLead: typeof import("./services/integrations.js").syncLead;
  let runMonitor: typeof import("./services/monitors.js").runMonitor;
  let encryptJson: typeof import("./lib/crypto.js").encryptJson;

  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    schema = dbPkg;
    db = dbPkg.getDb().db;
    ({ syncLead } = await import("./services/integrations.js"));
    ({ runMonitor } = await import("./services/monitors.js"));
    ({ encryptJson } = await import("./lib/crypto.js"));
  }, 60_000);

  const uid = () => randomUUID().slice(0, 8);

  async function orgWithLead() {
    const [org] = await db.insert(schema.organizations).values({ name: "ssrf", slug: `ssrf-${uid()}` }).returning();
    const [company] = await db.insert(schema.companies).values({ orgId: org.id, name: "Target Co", domain: `target-${uid()}.example` }).returning();
    const [lead] = await db.insert(schema.leads).values({ orgId: org.id, companyId: company.id, email: `p-${uid()}@target.example`, fullName: "Pat Lead", firstName: "Pat", lastName: "Lead" }).returning();
    return { org, lead };
  }

  /** A row as it would have been stored BEFORE validation existed: straight into the table. */
  async function storedIntegration(orgId: string, provider: string, config: Record<string, string>) {
    const [row] = await db.insert(schema.integrations).values({ orgId, provider, configEncrypted: encryptJson(config), status: "active" }).returning();
    return row;
  }

  const leadRow = (id: string) => db.query.leads.findFirst({ where: schema.eq(schema.leads.id, id) });

  it("F4 zoho: a stored apiDomain pointing at an internal service is refused - no connection, nothing echoed", async () => {
    const internal = await internalService();
    const { org, lead } = await orgWithLead();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const apiDomain of [`http://127.0.0.1:${internal.port}/internal?x=`, `http://127.0.0.1:${internal.port}`, `http://localhost:${internal.port}/internal-admin?x=`, "http://169.254.169.254/latest/meta-data?x="]) {
      await db.delete(schema.integrations).where(schema.eq(schema.integrations.orgId, org.id));
      const integ = await storedIntegration(org.id, "zoho", { accessToken: "zoho-token", apiDomain });
      const r = await syncLead(integ, lead.id);
      expect({ apiDomain, ok: r.ok }).toEqual({ apiDomain, ok: false });
      expect(r.error).toMatch(/Zoho API domain/);
      expect(r.error).toMatch(/Nothing was sent/);
      expect(r.externalId).toBeUndefined();
      // Before the fix: externalId "internal-id-1" and error "INTERNAL-SERVICE-RESPONSE secret=abc".
      expect(JSON.stringify(r)).not.toMatch(/INTERNAL-SERVICE-RESPONSE|internal-id-1/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(internal.hits).toEqual([]);
    expect((await leadRow(lead.id)).custom ?? {}).not.toHaveProperty("zoho_id");
  });

  it("F4 pipedrive: a stored companyDomain that rewrites the host is refused - no connection", async () => {
    const internal = await internalService();
    const { org, lead } = await orgWithLead();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const companyDomain of [`127.0.0.1:${internal.port}/x?`, "169.254.169.254/latest/meta-data/?x=", "attacker.example/#"]) {
      await db.delete(schema.integrations).where(schema.eq(schema.integrations.orgId, org.id));
      const integ = await storedIntegration(org.id, "pipedrive", { apiToken: "pd-token", companyDomain });
      const r = await syncLead(integ, lead.id);
      expect({ companyDomain, ok: r.ok }).toEqual({ companyDomain, ok: false });
      expect(r.error).toMatch(/Pipedrive company subdomain/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(internal.hits).toEqual([]);
  });

  it("F3 webhook / cortex / sheets: a stored URL that is private, or resolves private, is refused - no connection", async () => {
    const internal = await internalService();
    stubDns({ "hooks.attacker.example": [{ address: "127.0.0.1", family: 4 }] });
    const { org, lead } = await orgWithLead();
    for (const provider of ["webhook", "cortex", "sheets"]) {
      for (const url of [`${internal.base}/hook`, `http://hooks.attacker.example:${internal.port}/hook`]) {
        await db.delete(schema.integrations).where(schema.eq(schema.integrations.orgId, org.id));
        const integ = await storedIntegration(org.id, provider, { url, authHeader: "Bearer tenant-secret" });
        const r = await syncLead(integ, lead.id);
        expect({ provider, url, ok: r.ok }).toEqual({ provider, url, ok: false });
        expect(r.error).toMatch(/not a public address|does not resolve to a public address/);
      }
    }
    expect(internal.hits).toEqual([]);
    expect((await leadRow(lead.id)).custom ?? {}).toEqual({});
  });

  it("F4: valid configs build the URL they should, go out guarded, and never surface a response body", async () => {
    const { org, lead } = await orgWithLead();

    // Zoho, default data centre, answering with something that is not JSON.
    let calls = stubFetch(() => new Response("<html>INTERNAL-SERVICE-RESPONSE secret=abc</html>", { status: 502 }));
    let integ = await storedIntegration(org.id, "zoho", { accessToken: "zoho-token" });
    let r = await syncLead(integ, lead.id);
    expect(r).toEqual({ ok: false, externalId: undefined, error: "Zoho HTTP 502" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.zohoapis.in/crm/v2/Leads");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.dispatcher).toBeDefined();
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Zoho-oauthtoken zoho-token");
    vi.unstubAllGlobals();

    // Zoho redirecting: not followed, reported.
    calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    r = await syncLead(integ, lead.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirect/);
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();

    // Zoho succeeding, on a data centre the customer chose.
    await db.delete(schema.integrations).where(schema.eq(schema.integrations.orgId, org.id));
    integ = await storedIntegration(org.id, "zoho", { accessToken: "zoho-token", apiDomain: "https://www.zohoapis.com" });
    calls = stubFetch(() => new Response(JSON.stringify({ data: [{ code: "SUCCESS", details: { id: "zoho-1" } }] }), { status: 201 }));
    r = await syncLead(integ, lead.id);
    expect(r).toEqual({ ok: true, externalId: "zoho-1", error: undefined });
    expect(calls[0].url).toBe("https://www.zohoapis.com/crm/v2/Leads");
    expect((await leadRow(lead.id)).custom).toMatchObject({ zoho_id: "zoho-1" });
    vi.unstubAllGlobals();

    // Pipedrive: the label becomes exactly one host, and the token is a query parameter.
    await db.delete(schema.integrations).where(schema.eq(schema.integrations.orgId, org.id));
    integ = await storedIntegration(org.id, "pipedrive", { apiToken: "pd tok&en", companyDomain: "acme" });
    calls = stubFetch(() => new Response(JSON.stringify({ data: { id: 7 } }), { status: 201 }));
    r = await syncLead(integ, lead.id);
    expect(r).toEqual({ ok: true, externalId: "7", error: undefined });
    expect(calls.map((c) => c.url)).toEqual(["https://acme.pipedrive.com/v1/organizations?api_token=pd+tok%26en", "https://acme.pipedrive.com/v1/persons?api_token=pd+tok%26en"]);
    for (const c of calls) expect(new URL(c.url).hostname).toBe("acme.pipedrive.com");
  });

  it("F2: a linkedin_post monitor aimed at anything but LinkedIn is refused, with the error on the monitor", async () => {
    const internal = await internalService();
    const { org } = await orgWithLead();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const target of [`${internal.base}/latest/meta-data/`, "http://169.254.169.254/latest/meta-data/", `https://www.linkedin.com@127.0.0.1:${internal.port}/posts/x`, "https://www.linkedin.com.attacker.example/posts/x"]) {
      const [m] = await db.insert(schema.monitors).values({ orgId: org.id, type: "linkedin_post", name: "probe", target }).returning();
      const out = await runMonitor(m);
      expect(out.added).toBe(0);
      expect(out.refused).toBe(true);
      expect(out.error).toMatch(/not a LinkedIn post URL/);
      const after = await db.query.monitors.findFirst({ where: schema.eq(schema.monitors.id, m.id) });
      // Not a silent empty run: the monitor row itself says it was refused, and why.
      expect(after.lastResult).toMatchObject({ refused: true, publicPage: false, people: 0 });
      expect(after.lastResult.error).toMatch(/not a LinkedIn post URL/);
      expect(after.lastRunAt).not.toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(internal.hits).toEqual([]);
  });

  it("F2: a jobs monitor aimed at an internal address is refused the same way", async () => {
    const internal = await internalService();
    stubDns({ "jobs.attacker.example": [{ address: "127.0.0.1", family: 4 }] });
    const { org } = await orgWithLead();
    for (const target of [`127.0.0.1:${internal.port}`, `jobs.attacker.example:${internal.port}`]) {
      const [m] = await db.insert(schema.monitors).values({ orgId: org.id, type: "jobs", name: "probe", target }).returning();
      const out = await runMonitor(m);
      expect(out.refused).toBe(true);
      expect(out.error).toMatch(/public web address/);
      const after = await db.query.monitors.findFirst({ where: schema.eq(schema.monitors.id, m.id) });
      expect(after.lastResult).toMatchObject({ refused: true, unreachable: true });
    }
    expect(internal.hits).toEqual([]);
  });
});
