import { describe, expect, it } from "vitest";
import { isPublicHost } from "./publicHost.js";

/**
 * Crawl targets come from user input and what a crawl harvests is shown back to the person
 * who asked for it, so a crawl aimed at our own infrastructure reads its response out loud.
 * The https-only crawler mostly hid this, because internal services rarely speak https; a
 * plain-http fallback removes that accident, which is why the check is here and not in the
 * fallback.
 */
describe("only public web addresses are fetched on a user's behalf", () => {
  it("refuses the cloud metadata endpoint", () => {
    expect(isPublicHost("169.254.169.254")).toBe(false);
    expect(isPublicHost("169.254.169.254:80")).toBe(false);
    expect(isPublicHost("metadata.google.internal")).toBe(false);
  });

  it("refuses loopback in every spelling", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "localhost:3000", "[::1]", "::1", "[::ffff:127.0.0.1]"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("refuses private and reserved ranges", () => {
    for (const h of ["10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[fd00::1]", "[fe80::1]"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("refuses names that are not on the public web", () => {
    for (const h of ["printer.local", "db.internal", "router", "wiki.lan", "host.home.arpa"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("allows ordinary public sites, including public addresses in the 172 range", () => {
    for (const h of ["razorpay.com", "www.example.co.uk", "acme.io:8443", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: true });
    }
  });

  /**
   * The bypasses a pattern-match misses.
   *
   * A first version of this guard matched dotted-quad with a regex. `fetch` does not:
   * WHATWG URL parsing applies inet_aton semantics and strips userinfo, so every one of
   * these reached loopback or the cloud metadata endpoint while looking public to the
   * regex. This is the test that made the guard parse instead of pattern-match.
   */
  it("refuses alternative encodings of a private address", () => {
    for (const h of ["0177.0.0.1", "0x7f.0.0.1", "127.1", "0x7f000001", "2130706433", "017700000001"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("refuses a host smuggled after userinfo", () => {
    for (const h of ["example.com@169.254.169.254", "https://razorpay.com@127.0.0.1/", "user:pass@10.0.0.1"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("refuses a trailing root label and a zone id", () => {
    for (const h of ["localhost.", "169.254.169.254.", "[fe80::1%eth0]"]) {
      expect({ h, ok: isPublicHost(h) }).toEqual({ h, ok: false });
    }
  });

  it("refuses the hex spelling of an IPv4-mapped address", () => {
    expect(isPublicHost("[::ffff:7f00:1]")).toBe(false);
    expect(isPublicHost("[::ffff:a9fe:a9fe]")).toBe(false);
  });

  it("accepts a full URL as well as a bare host", () => {
    expect(isPublicHost("https://razorpay.com/pricing")).toBe(true);
    expect(isPublicHost("http://127.0.0.1:8080/admin")).toBe(false);
  });

  it("refuses a malformed address rather than letting it through", () => {
    expect(isPublicHost("999.999.999.999")).toBe(false);
    expect(isPublicHost("")).toBe(false);
    expect(isPublicHost("   ")).toBe(false);
  });
});

/**
 * A pre-flight check on the address we were handed is defeated by one redirect: a host the
 * guard allows answers `302 Location: http://169.254.169.254/...`, the client follows it,
 * and the metadata response is what gets parsed and stored. So the guard has to run on
 * every hop, which is what fetchPublic does.
 */
describe("the guard survives a redirect", () => {
  it("refuses to follow a redirect into a private address", async () => {
    const { createServer } = await import("node:http");
    const { fetchPublic } = await import("./http.js");

    const server = createServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");

    try {
      // allowPrivateHosts lets the FIRST hop through (the fixture is on loopback); the
      // redirect target is judged on its own, which is the point of the per-hop check.
      const res = await fetchPublic(`http://127.0.0.1:${addr.port}/`, { timeoutMs: 2000, allowPrivateHosts: false });
      expect(res).toBeNull();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("follows an ordinary redirect between public addresses", async () => {
    const { createServer } = await import("node:http");
    const { fetchPublic } = await import("./http.js");

    const server = createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/end" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("arrived");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");

    try {
      const res = await fetchPublic(`http://127.0.0.1:${addr.port}/start`, { timeoutMs: 2000, allowPrivateHosts: true });
      expect(res).not.toBeNull();
      expect(await res!.text()).toBe("arrived");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
