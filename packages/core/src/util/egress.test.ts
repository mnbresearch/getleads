/**
 * Regression tests for the SSRF / guarded-egress findings (security validation, area B).
 *
 * What was confirmed, and is reproduced here:
 *
 *   F1  a hostname that RESOLVES to a private address passed `isPublicHost` and
 *       `fetchPublic`; `crawlCompanyWebsite("127.0.0.1.nip.io:PORT")` stored an internal
 *       service's response in the company profile.
 *   F7  the address classifier missed IPv6 site-local, multicast, discard, documentation,
 *       6to4, NAT64, Teredo and SIIT, several IPv4 special ranges, and any non-http scheme.
 *   F2  a `linkedin_post` monitor fetched whatever string the tenant typed.
 *   F5  the SMTP probe connected to whatever an MX record named.
 *
 * No real network is used. An "internal service" is a listener on 127.0.0.1, and DNS is
 * decided by stubbing `dns.lookup` - which is exactly the seam the production code resolves
 * through, so a stubbed answer of 127.0.0.1 is indistinguishable from a hostile DNS record.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { assertPublicHost, guardedDispatcher, guardedLookup, isSsrfBlocked, SsrfBlockedError } from "./egress.js";
import { fetchPublic, fetchText } from "./http.js";
import { isPublicAddress, isPublicHost, parseHttpUrl } from "./publicHost.js";
import { crawlCompanyWebsite } from "../enrich/website.js";
import { detectHiring } from "../signals/hiring.js";
import { linkedinPostEngagers, normalizeLinkedinPostUrl } from "../linkedin/resolve.js";
import { smtpProbe } from "../email/verify.js";

type Addr = { address: string; family: 4 | 6 };

/** Decide what names resolve to. A name not in the table does not exist. */
function stubDns(table: Record<string, Addr[] | (() => Addr[])>) {
  const calls: string[] = [];
  const spy = vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: unknown, cb: unknown) => {
    const callback = (typeof options === "function" ? options : cb) as (e: Error | null, a?: unknown, f?: number) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    // `server.listen(0, "127.0.0.1")` goes through dns.lookup too. A literal is its own answer.
    if (net.isIP(hostname)) {
      const fam = net.isIP(hostname) as 4 | 6;
      return process.nextTick(() => (all ? callback(null, [{ address: hostname, family: fam }]) : callback(null, hostname, fam)));
    }
    calls.push(hostname);
    const entry = table[hostname];
    const list = typeof entry === "function" ? entry() : entry;
    process.nextTick(() => {
      if (!list?.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
      if (all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  }) as never);
  return { calls, spy };
}

const servers: Server[] = [];

/** A stand-in for an internal service: a listener on loopback that records every request. */
async function internalService(handler?: (req: IncomingMessage) => { status?: number; headers?: Record<string, string>; body?: string }) {
  const hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const r = handler?.(req) ?? {};
      res.writeHead(r.status ?? 200, { "content-type": "text/html", ...(r.headers ?? {}) });
      res.end(r.body ?? '<html><head><title>INTERNAL metadata token=SECRET-169254</title><meta name="description" content="iam-role creds visible"></head></html>');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  return { port: addr.port, base: `http://127.0.0.1:${addr.port}`, hits };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/* ───────────────────────────────── F7: the classifier ──────────────────────────────── */

describe("F7: the address classifier (matrix from the validator's probe)", () => {
  /** Every row that reaches a non-public address, or is not an http(s) fetch at all. */
  const MUST_BLOCK: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["2130706433", "decimal int loopback"],
    ["017700000001", "octal int"],
    ["0x7f000001", "hex int"],
    ["0177.0.0.1", "octal dotted"],
    ["0x7f.0.0.1", "hex dotted"],
    ["127.1", "short"],
    ["127.0.1", "short3"],
    ["0", "zero"],
    ["0.0.0.0", "any"],
    ["169.254.169.254", "metadata"],
    ["2852039166", "metadata decimal"],
    ["0xa9fea9fe", "metadata hex"],
    ["169.254.169.254.", "trailing dot"],
    ["10.0.0.5", "rfc1918"],
    ["172.16.0.1", "rfc1918"],
    ["172.31.255.255", "rfc1918"],
    ["192.168.1.1", "rfc1918"],
    ["100.64.0.1", "cgnat"],
    ["198.18.0.1", "benchmark 198.18/15 (was allowed)"],
    ["198.19.255.255", "benchmark 198.18/15, top of range"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.1", "doc"],
    ["198.51.100.1", "doc (was allowed)"],
    ["203.0.113.1", "doc (was allowed)"],
    ["192.88.99.1", "6to4 relay (was allowed)"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["[::1]", "v6 loopback"],
    ["[::]", "v6 any"],
    ["[::ffff:127.0.0.1]", "v4-mapped dotted"],
    ["[::ffff:7f00:1]", "v4-mapped hex"],
    ["[0:0:0:0:0:ffff:7f00:1]", "v4-mapped long"],
    ["[::ffff:a9fe:a9fe]", "v4-mapped metadata"],
    ["[::127.0.0.1]", "v4-compat"],
    ["[fe80::1]", "link-local"],
    ["[fe80::1%25eth0]", "zone id"],
    ["[fc00::1]", "ULA"],
    ["[fd12:3456::1]", "ULA"],
    ["[fd00:ec2::254]", "AWS IMDS v6"],
    ["[fec0::1]", "site-local, deprecated (was allowed)"],
    ["[2002:7f00:1::]", "6to4 embedding 127.0.0.1 (was allowed)"],
    ["[2002:a9fe:a9fe::]", "6to4 embedding metadata (was allowed)"],
    ["[64:ff9b::7f00:1]", "NAT64 embedding 127.0.0.1 (was allowed)"],
    ["[64:ff9b::a9fe:a9fe]", "NAT64 embedding metadata (was allowed)"],
    ["[64:ff9b:1::a9fe:a9fe]", "local NAT64 64:ff9b:1::/48 (was allowed)"],
    ["[2001:0:4136:e378:8000:63bf:3fff:fdd2]", "Teredo (was allowed)"],
    ["[::ffff:0:7f00:1]", "SIIT ::ffff:0:0:0/96 (was allowed)"],
    ["[ff02::1]", "v6 multicast (was allowed)"],
    ["[100::1]", "discard (was allowed)"],
    ["[2001:db8::1]", "v6 doc (was allowed)"],
    ["LOCALHOST", "case"],
    ["localhost.", "root label"],
    ["LocalHost.LocalDomain", "localdomain"],
    ["app.localhost", "*.localhost is loopback (RFC 6761)"],
    ["metadata.google.internal", "gcp metadata"],
    ["Metadata.Google.Internal.", "gcp metadata, case and root label"],
    ["foo.internal", ".internal"],
    ["foo.local", ".local"],
    ["intranet", "single label"],
    ["srv-abc123", "render private service name"],
    ["dpg-abc123-a", "render internal postgres host"],
    ["my-service:10000", "render private service with port"],
    ["127。0。0。1", "ideographic dots"],
    ["１２７.０.０.１", "fullwidth digits"],
    ["ⓛocalhost", "unicode letter"],
    ["localhost%00.example.com", "nul"],
    ["example.com@169.254.169.254", "userinfo"],
    ["http://example.com@169.254.169.254/", "userinfo full URL"],
    ["http://169.254.169.254\\@example.com/", "backslash"],
    ["http://169.254.169.254#@example.com/", "fragment"],
    ["http://example.com:80@169.254.169.254/", "port-like userinfo"],
    ["http://127.0.0.1:8080/", "port"],
    ["http://127.0.0.1:80\t/", "tab"],
    ["http://127.0.\n0.1/", "newline inside host"],
    ["http://loc\talhost/", "tab inside host"],
    ["file:///etc/passwd", "file scheme"],
    ["gopher://127.0.0.1:6379/_INFO", "gopher"],
    ["ftp://127.0.0.1/", "ftp"],
    ["ftp://example.com/", "ftp to a public host is still not an http fetch"],
    ["data:text/html,hi", "data"],
    ["javascript:alert(1)", "js"],
    ["foo://0x7f.0.0.1/", "non-special scheme: host is not canonicalised (was allowed)"],
    ["foo://2130706433/", "non-special scheme decimal"],
    ["foo://127.1/", "non-special scheme short form (was allowed)"],
    ["999.999.999.999", "malformed"],
    ["", "empty"],
  ];

  it.each(MUST_BLOCK)("refuses %j (%s)", (input) => {
    expect(isPublicHost(input)).toBe(false);
    // Allowing credentials in a customer's own webhook URL must not relax the address check.
    expect(isPublicHost(input, { allowUserinfo: true })).toBe(false);
  });

  /**
   * Rows the string check is right to pass. The four `nip.io` / `localtest.me` names are
   * here on purpose: as STRINGS they are ordinary public names. Where they resolve is the
   * connect-time guard's business, and the tests further down prove it refuses them.
   */
  const MUST_ALLOW: [string, string][] = [
    ["example.com", "control"],
    ["8.8.8.8", "public v4"],
    ["1.1.1.1", "public v4"],
    ["[2606:4700:4700::1111]", "public v6"],
    ["2606:4700:4700::1111", "public v6 as DNS returns it, no brackets"],
    ["172.15.0.1", "just below 172.16/12"],
    ["172.32.0.1", "just above 172.16/12"],
    ["192.0.78.9", "192.0.64.0/18 is public - WordPress.com - and used to be refused as '192.0.x.x'"],
    ["198.17.255.255", "just below 198.18/15"],
    ["198.20.0.1", "just above 198.18/15"],
    ["razorpay.com", "ordinary site"],
    ["www.example.co.uk", "ordinary site"],
    ["acme.io:8443", "host:port"],
    ["https://razorpay.com/pricing", "full URL"],
    ["dpg-abc123-a.oregon-postgres.render.com", "public name"],
    ["my-service.onrender.com", "public name"],
    ["http://example.com\\@169.254.169.254/", "backslash is a path separator: this fetches example.com"],
    ["http://example.com#@169.254.169.254/", "the fragment is not the host: this fetches example.com"],
    ["127.0.0.1.nip.io", "public NAME (refused at connect time)"],
    ["169.254.169.254.nip.io", "public NAME (refused at connect time)"],
    ["10.0.0.5.nip.io", "public NAME (refused at connect time)"],
    ["localtest.me", "public NAME (refused at connect time)"],
  ];

  it.each(MUST_ALLOW)("allows %j (%s)", (input) => {
    expect(isPublicHost(input)).toBe(true);
  });

  it("isPublicAddress judges an address in the form DNS and sockets report it", () => {
    const nonPublic = [
      "0.0.0.0", "0.1.2.3", "10.0.0.5", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::7f00:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:0:7f00:1", "fe80::1", "fe80::1%eth0", "febf::1", "fc00::1", "fd12:3456::1", "fd00:ec2::254",
      "fec0::1", "ff02::1", "ff0e::1", "100::1", "2001:db8::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2002:7f00:1::", "2002:a9fe:a9fe::", "2002:808:808::",
      "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::a9fe:a9fe", "3fff::1", "4000::1", "1::1",
    ];
    for (const ip of nonPublic) expect({ ip, public: isPublicAddress(ip) }).toEqual({ ip, public: false });

    const publicOnes = ["8.8.8.8", "1.1.1.1", "104.20.23.154", "172.15.0.1", "172.32.0.1", "192.0.78.9", "100.63.255.255", "100.128.0.1", "223.255.255.254", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2001:200::1", "::ffff:8.8.8.8", "64:ff9b::808:808"];
    for (const ip of publicOnes) expect({ ip, public: isPublicAddress(ip) }).toEqual({ ip, public: true });
  });

  it("isPublicAddress refuses anything that is not a canonical IP address", () => {
    for (const s of ["", "example.com", "localhost", "0177.0.0.1", "0x7f.0.0.1", "127.1", "2130706433", "010.0.0.1", "1.2.3.4.5", "256.1.1.1", "[::1]", "::1::", "12345::1", "gggg::1", "1.2.3.4:80"]) {
      expect({ s, public: isPublicAddress(s) }).toEqual({ s, public: false });
    }
    expect(isPublicAddress(undefined as never)).toBe(false);
    expect(isPublicAddress(null as never)).toBe(false);
  });

  it("parseHttpUrl accepts only http(s), refuses credentials unless asked, and drops the fragment", () => {
    for (const bad of ["file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO", "ftp://example.com/", "foo://0x7f.0.0.1/", "javascript:alert(1)", "data:text/html,hi", "example.com", "", "http://"]) {
      expect({ bad, parsed: parseHttpUrl(bad) }).toEqual({ bad, parsed: null });
    }
    expect(parseHttpUrl("https://user:pw@hooks.acme.com/x")).toBeNull();
    expect(parseHttpUrl("https://user:pw@hooks.acme.com/x", { allowUserinfo: true })?.hostname).toBe("hooks.acme.com");
    expect(parseHttpUrl("https://example.com/a?b=1#@169.254.169.254/")?.href).toBe("https://example.com/a?b=1");
  });
});

/* ─────────────────────── F1: names that resolve somewhere private ───────────────────── */

describe("F1: the connect-time guard", () => {
  it("guardedLookup refuses a name that resolves to loopback, and hands back only vetted addresses", async () => {
    stubDns({
      "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }],
      "metadata.attacker.example": [{ address: "169.254.169.254", family: 4 }],
      "v6.attacker.example": [{ address: "fd00:ec2::254", family: 6 }],
      "mixed.attacker.example": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
      "good.example": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }],
    });
    const lookup = (h: string, all: boolean) => new Promise<{ err: unknown; address?: unknown; family?: number }>((r) => guardedLookup(h, { all }, (err, address, family) => r({ err, address, family })));

    for (const h of ["127.0.0.1.nip.io", "metadata.attacker.example", "v6.attacker.example"]) {
      const r = await lookup(h, true);
      expect(r.err).toBeInstanceOf(SsrfBlockedError);
      expect((r.err as SsrfBlockedError).code).toBe("ESSRFBLOCKED");
      expect(r.address).toBeUndefined();
    }
    // ONE private address among public ones refuses the name: picking the good one would
    // leave the bad one to the client's own fallback.
    const mixed = await lookup("mixed.attacker.example", true);
    expect(mixed.err).toBeInstanceOf(SsrfBlockedError);
    expect((mixed.err as SsrfBlockedError).address).toBe("10.0.0.5");

    expect(await lookup("good.example", true)).toEqual({ err: null, address: [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }], family: undefined });
    expect(await lookup("good.example", false)).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    // A name that does not exist stays a DNS error, not an SSRF refusal.
    const missing = await lookup("nope.example", true);
    expect((missing.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
    expect(isSsrfBlocked(missing.err)).toBe(false);
  });

  it("the guarded dispatcher refuses a hostname that resolves to 127.0.0.1, and nothing reaches the listener", async () => {
    const internal = await internalService();
    const { calls } = stubDns({ "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }] });

    const err = await fetch(`http://127.0.0.1.nip.io:${internal.port}/latest/meta-data/`, { dispatcher: guardedDispatcher() } as RequestInit).then(
      (r) => r.text().then((t) => new Error(`LEAKED ${r.status} ${t}`)),
      (e) => e,
    );
    expect(isSsrfBlocked(err)).toBe(true);
    expect(calls).toEqual(["127.0.0.1.nip.io"]);
    expect(internal.hits).toEqual([]);
  });

  it("the guarded dispatcher refuses a private IP LITERAL itself (no lookup happens for a literal)", async () => {
    const internal = await internalService();
    const { calls } = stubDns({});
    for (const url of [`http://127.0.0.1:${internal.port}/`, `http://[::ffff:127.0.0.1]:${internal.port}/`, `http://[::1]:${internal.port}/`]) {
      const err = await fetch(url, { dispatcher: guardedDispatcher() } as RequestInit).then(
        (r) => new Error(`LEAKED ${r.status}`),
        (e) => e,
      );
      expect({ url, blocked: isSsrfBlocked(err) }).toEqual({ url, blocked: true });
    }
    expect(calls).toEqual([]);
    expect(internal.hits).toEqual([]);
  });

  it("fetchPublic refuses a private literal at the pre-check, before any connection", async () => {
    const internal = await internalService();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of [`${internal.base}/`, `http://2130706433:${internal.port}/`, `http://0x7f.0.0.1:${internal.port}/`, `http://[::ffff:7f00:1]:${internal.port}/`, `http://localhost:${internal.port}/`]) {
      expect({ url, res: await fetchPublic(url, { timeoutMs: 1500 }) }).toEqual({ url, res: null });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(internal.hits).toEqual([]);
  });

  it("fetchPublic refuses a name that resolves private: null, not a response and not a throw", async () => {
    const internal = await internalService();
    stubDns({ "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }], "localtest.me": [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }] });
    // The exploit from the report: isPublicHost says yes ...
    expect(isPublicHost("127.0.0.1.nip.io")).toBe(true);
    // ... and the fetch is refused anyway.
    expect(await fetchPublic(`http://127.0.0.1.nip.io:${internal.port}/`, { timeoutMs: 1500 })).toBeNull();
    expect(await fetchPublic(`http://localtest.me:${internal.port}/`, { timeoutMs: 1500 })).toBeNull();
    expect(await fetchText(`http://127.0.0.1.nip.io:${internal.port}/`, { timeoutMs: 1500, publicOnly: true })).toBeNull();
    expect(internal.hits).toEqual([]);
  });

  it("DNS rebinding cannot win: public to the pre-flight check, private to the connection, still refused", async () => {
    const internal = await internalService();
    let n = 0;
    // First answer (the pre-flight check) is public. Every later answer is loopback.
    const { calls } = stubDns({ "rebind.attacker.example": () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]) });

    // The pre-flight sees a public address and is satisfied ...
    expect((await assertPublicHost("rebind.attacker.example")).address).toBe("93.184.216.34");
    // ... and the connection, which resolves for itself and vets what IT got, refuses.
    expect(await fetchPublic(`http://rebind.attacker.example:${internal.port}/`, { timeoutMs: 1500 })).toBeNull();
    expect(calls.length).toBe(2);
    expect(internal.hits).toEqual([]);

    // The same through the crawler, whose pre-flight is the one that gets the public answer.
    n = 0;
    const profile = await crawlCompanyWebsite(`http://rebind.attacker.example:${internal.port}`, { maxPages: 2, timeoutMs: 1500 });
    expect(profile.name).toBeUndefined();
    expect(profile.description).toBeUndefined();
    expect(profile.crawlFailed).toBe(true);
    expect(internal.hits).toEqual([]);
  });

  it("fetchPublic refuses a 302 to a private literal and a 302 to a name that resolves private", async () => {
    const internal = await internalService();
    stubDns({ "internal.attacker.example": [{ address: "127.0.0.1", family: 4 }] });
    for (const location of [`${internal.base}/latest/meta-data/`, `http://internal.attacker.example:${internal.port}/admin`, "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "gopher://127.0.0.1:6379/_INFO", "file:///etc/passwd", `http://user:pw@8.8.8.8/`]) {
      const redirector = await internalService(() => ({ status: 302, headers: { location }, body: "" }));
      // allowFirstHop: the redirector itself has to live on loopback. Every LATER hop is
      // judged, which is the thing under test.
      const res = await fetchPublic(`${redirector.base}/start`, { timeoutMs: 1500, allowFirstHop: true });
      expect({ location, res }).toEqual({ location, res: null });
      expect(redirector.hits.map((h) => h.url)).toEqual(["/start"]);
    }
    expect(internal.hits).toEqual([]);
  });

  it("maxRedirects: 0 returns the 3xx itself - status and Location, no body - and never the destination", async () => {
    const destination = await internalService();
    const redirector = await internalService(() => ({ status: 307, headers: { location: `${destination.base}/replayed` }, body: "redirect body that must not be surfaced" }));
    const res = await fetchPublic(`${redirector.base}/hook`, { method: "POST", body: JSON.stringify({ lead: "secret" }), timeoutMs: 1500, allowPrivateHosts: true, maxRedirects: 0 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(307);
    expect(res!.ok).toBe(false);
    expect(res!.headers.get("location")).toBe(`${destination.base}/replayed`);
    expect(await res!.text()).toBe("");
    expect(redirector.hits).toHaveLength(1);
    // The payload was not replayed to the redirect target.
    expect(destination.hits).toEqual([]);

    // An ordinary answer is unaffected by the option.
    const plain = await internalService(() => ({ status: 200, body: "ok" }));
    const ok = await fetchPublic(`${plain.base}/hook`, { method: "POST", body: "{}", timeoutMs: 1500, allowPrivateHosts: true, maxRedirects: 0 });
    expect(ok!.status).toBe(200);
    expect(await ok!.text()).toBe("ok");
  });

  it("allowPrivateHosts still works for tests and local development, on an unguarded dispatcher", async () => {
    const internal = await internalService(() => ({ status: 200, body: "fixture" }));
    const res = await fetchPublic(`${internal.base}/x`, { timeoutMs: 1500, allowPrivateHosts: true });
    expect(await res!.text()).toBe("fixture");
    // ... but it does not make a non-http scheme fetchable.
    expect(await fetchPublic("file:///etc/passwd", { allowPrivateHosts: true })).toBeNull();
  });

  it("global fetch is still what fetchPublic calls, so a test can stub it - and it is handed the guarded dispatcher", async () => {
    const seen: { url: string; init: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: Record<string, unknown>) => {
        seen.push({ url, init });
        return new Response("stubbed", { status: 200 });
      }),
    );
    const res = await fetchPublic("https://example.com/page#frag", { timeoutMs: 1500 });
    expect(await res!.text()).toBe("stubbed");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://example.com/page");
    expect(seen[0].init.redirect).toBe("manual");
    expect(seen[0].init.dispatcher).toBe(guardedDispatcher());

    // With the escape hatch, no guarded dispatcher is attached.
    await fetchPublic("https://example.com/page", { timeoutMs: 1500, allowPrivateHosts: true });
    expect(seen[1].init.dispatcher).toBeUndefined();
  });

  it("maxBytes caps what can be read from the returned response", async () => {
    const big = await internalService(() => ({ status: 200, body: "x".repeat(2_000_000) }));
    const res = await fetchPublic(`${big.base}/`, { timeoutMs: 5000, allowPrivateHosts: true, maxBytes: 1000 });
    expect((await res!.text()).length).toBe(1000);
  });

  it("allowUserinfo sends URL credentials as HTTP Basic on the first hop only; without it the URL is refused", async () => {
    const hook = await internalService(() => ({ status: 200, body: "ok" }));
    const url = `http://user:p%40ss@127.0.0.1:${hook.port}/in`;
    expect(await fetchPublic(url, { timeoutMs: 1500, allowPrivateHosts: true })).toBeNull();
    const res = await fetchPublic(url, { method: "POST", body: "{}", timeoutMs: 1500, allowPrivateHosts: true, allowUserinfo: true, noDefaultHeaders: true });
    expect(res!.status).toBe(200);
    expect(hook.hits).toHaveLength(1);
    expect(hook.hits[0].headers.authorization).toBe(`Basic ${Buffer.from("user:p@ss").toString("base64")}`);
    // noDefaultHeaders: a webhook delivery does not go out dressed as a browser.
    expect(hook.hits[0].headers["user-agent"]).not.toMatch(/Mozilla|ScoutBot/);
    // The credentials are judged with the host, not instead of it.
    expect(await fetchPublic(`http://user:pw@127.0.0.1:${hook.port}/in`, { timeoutMs: 1500, allowUserinfo: true })).toBeNull();
  });

  it("hostAllow keeps every hop on the named site", async () => {
    const elsewhere = await internalService();
    const first = await internalService(() => ({ status: 302, headers: { location: `http://localhost:${elsewhere.port}/x` }, body: "" }));
    const res = await fetchPublic(`${first.base}/a`, { timeoutMs: 1500, allowPrivateHosts: true, hostAllow: (h) => h === "127.0.0.1" });
    expect(res).toBeNull();
    expect(elsewhere.hits).toEqual([]);
  });

  it("assertPublicHost: literal check, then every resolved address; IPv4 preferred; DNS failure is not a refusal", async () => {
    stubDns({
      "smtp.good.example": [{ address: "2a00:1450:4001:81b::200e", family: 6 }, { address: "142.250.1.109", family: 4 }],
      "smtp.evil.example": [{ address: "142.250.1.109", family: 4 }, { address: "10.0.0.5", family: 4 }],
      "v6only.example": [{ address: "2a00:1450:4001:81b::200e", family: 6 }],
    });
    expect(await assertPublicHost("smtp.good.example")).toMatchObject({ address: "142.250.1.109", family: 4 });
    expect(await assertPublicHost("v6only.example")).toMatchObject({ address: "2a00:1450:4001:81b::200e", family: 6 });
    expect(await assertPublicHost("8.8.8.8")).toMatchObject({ address: "8.8.8.8", family: 4 });
    expect(await assertPublicHost("2606:4700:4700::1111")).toMatchObject({ address: "2606:4700:4700::1111", family: 6 });

    for (const bad of ["smtp.evil.example", "127.0.0.1", "10.0.0.5", "localhost", "169.254.169.254", "::1", "fd00:ec2::254", "db.internal", "redis", "0x7f.0.0.1", "user@10.0.0.1", ""]) {
      const err = await assertPublicHost(bad).then(
        () => null,
        (e) => e,
      );
      expect({ bad, blocked: err instanceof SsrfBlockedError && err.code === "ESSRFBLOCKED" }).toEqual({ bad, blocked: true });
    }
    const missing = await assertPublicHost("no-such-host.example").catch((e) => e);
    expect(isSsrfBlocked(missing)).toBe(false);
    expect(missing.code).toBe("ENOTFOUND");
  });
});

/* ──────────────────────────── F1: the crawler, end to end ───────────────────────────── */

describe("F1: a crawl of a name that resolves to an internal service stores nothing", () => {
  it("crawlCompanyWebsite returns nothing, says why, and makes no connection to the listener", async () => {
    const internal = await internalService();
    stubDns({ "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }] });

    // Both spellings from the report: with a scheme and bare (which also tries the http fallback).
    for (const target of [`http://127.0.0.1.nip.io:${internal.port}`, `127.0.0.1.nip.io:${internal.port}`]) {
      const profile = await crawlCompanyWebsite(target, { maxPages: 2, timeoutMs: 1500 });
      // Before the fix: name "INTERNAL metadata token=SECRET", description "iam-role creds visible".
      expect(profile.name).toBeUndefined();
      expect(profile.description).toBeUndefined();
      expect(profile.pagesFetched).toBe(0);
      expect(profile.crawlFailed).toBe(true);
      expect(profile.crawlRefused).toMatch(/does not resolve to a public web address/);
    }
    expect(internal.hits).toEqual([]);
  });

  it("the careers-page probe refuses the same target and says so", async () => {
    const internal = await internalService();
    stubDns({ "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }] });
    const h = await detectHiring(`127.0.0.1.nip.io:${internal.port}`);
    expect(h.reached).toBe(false);
    expect(h.refused).toMatch(/does not resolve to a public web address/);
    expect(h.reason).toMatch(/not fetched/);
    const literal = await detectHiring(`127.0.0.1:${internal.port}`);
    expect(literal.refused).toMatch(/not a public web address/);
    expect(internal.hits).toEqual([]);
  });
});

/* ───────────────────────────── F2: LinkedIn post monitors ───────────────────────────── */

describe("F2: a LinkedIn post target must be a LinkedIn URL", () => {
  it("normalizeLinkedinPostUrl accepts LinkedIn however it was pasted, and nothing else", () => {
    expect(normalizeLinkedinPostUrl("https://www.linkedin.com/posts/acme_launch-activity-7123")).toBe("https://www.linkedin.com/posts/acme_launch-activity-7123");
    expect(normalizeLinkedinPostUrl("  linkedin.com/feed/update/urn:li:activity:7123/  ")).toBe("https://linkedin.com/feed/update/urn:li:activity:7123/");
    expect(normalizeLinkedinPostUrl("http://in.linkedin.com/posts/x?utm=1#comments")).toBe("https://in.linkedin.com/posts/x?utm=1");
    expect(normalizeLinkedinPostUrl("HTTPS://WWW.LINKEDIN.COM/posts/x")).toBe("https://www.linkedin.com/posts/x");

    for (const bad of [
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "https://evil.example/linkedin.com/posts/x",
      "https://www.linkedin.com.evil.example/posts/x",
      "https://linkedin.com.evil.example/posts/x",
      "https://evil-linkedin.com/posts/x",
      "https://www.linkedin.com@127.0.0.1/posts/x",
      "https://user:pw@www.linkedin.com/posts/x",
      "https://www.linkedin.com:8443/posts/x",
      "https://a.b.linkedin.com/posts/x",
      "ftp://www.linkedin.com/posts/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect({ bad, url: normalizeLinkedinPostUrl(bad) }).toEqual({ bad, url: null });
    }
  });

  it("linkedinPostEngagers fetches nothing for a non-LinkedIn target and reports a refusal, not an empty page", async () => {
    const internal = await internalService();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const target of [`${internal.base}/latest/meta-data/`, `http://www.linkedin.com@127.0.0.1:${internal.port}/`, `https://attacker.example/redirect?to=${encodeURIComponent(internal.base)}`]) {
      const r = await linkedinPostEngagers(target);
      expect(r.people).toEqual([]);
      expect(r.publicPage).toBe(false);
      expect(r.refused).toMatch(/not a LinkedIn post URL/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(internal.hits).toEqual([]);
  });

  it("a LinkedIn URL that redirects off LinkedIn is not followed", async () => {
    const internal = await internalService();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(null, { status: 302, headers: { location: `${internal.base}/steal` } });
      }),
    );
    const r = await linkedinPostEngagers("https://www.linkedin.com/posts/acme_launch-activity-7123");
    expect(urls).toEqual(["https://www.linkedin.com/posts/acme_launch-activity-7123"]);
    expect(r.publicPage).toBe(false);
    expect(r.refused).toBeUndefined();
    expect(internal.hits).toEqual([]);
  });
});

/* ──────────────────────────────── F5: the SMTP probe ────────────────────────────────── */

describe("F5: the SMTP probe only connects to a public mail server, at the address it checked", () => {
  it("refuses an MX host that is, or resolves to, a private address - no socket is opened", async () => {
    stubDns({ "mx.attacker.example": [{ address: "10.0.0.5", family: 4 }], "mx.mixed.example": [{ address: "142.250.1.27", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    const connect = vi.spyOn(net, "createConnection");
    for (const mx of ["mx.attacker.example", "mx.mixed.example", "127.0.0.1", "10.0.0.5", "localhost", "[::1]", "169.254.169.254"]) {
      const r = await smtpProbe("someone@attacker.example", mx, { timeoutMs: 500 });
      expect({ mx, result: r.result }).toEqual({ mx, result: "error" });
      expect(r.detail).toMatch(/not at a public address/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects to the vetted IP, not to the name", async () => {
    stubDns({ "mx.good.example": [{ address: "142.250.1.27", family: 4 }] });
    const opened: unknown[] = [];
    vi.spyOn(net, "createConnection").mockImplementation(((opts: unknown) => {
      opened.push(opts);
      const sock = Object.assign(new EventEmitter(), { write: () => true, destroy: () => {} });
      setImmediate(() => sock.emit("error", Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" })));
      return sock;
    }) as never);
    const r = await smtpProbe("someone@good.example", "mx.good.example", { timeoutMs: 500 });
    expect(opened).toEqual([{ host: "142.250.1.27", port: 25, family: 4 }]);
    expect(r.result).toBe("error");
  });
});
