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
 *
 * The first version of these tests could not tell whether it did. One started on loopback
 * with the guard ON, so it was refused at hop zero and the redirect never happened; the
 * other turned the guard OFF entirely, so undici followed the redirect itself. Both passed
 * against a fetchPublic whose loop body was dead code - which is exactly what it was, since
 * fetchWithTimeout was overriding `redirect: "manual"` with a hardcoded "follow".
 *
 * So these tests decide the two questions separately: is the redirect followed BY THE LOOP
 * (count the requests the server sees), and is a hop that fails the guard refused.
 */
describe("the guard survives a redirect", () => {
  async function fixture(handler: (url: string) => { status: number; location?: string; body?: string }) {
    const { createServer } = await import("node:http");
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "/");
      const r = handler(req.url ?? "/");
      if (r.location) {
        res.writeHead(r.status, { location: r.location });
        return res.end();
      }
      res.writeHead(r.status, { "content-type": "text/plain" });
      res.end(r.body ?? "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no address");
    return {
      base: `http://127.0.0.1:${addr.port}`,
      hits,
      async close() {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  it("refuses to follow a redirect into a private address", async () => {
    const { fetchPublic } = await import("./http.js");
    // The guard is ON. The first hop is permitted explicitly, so the ONLY thing that can
    // refuse the second hop is the per-hop check - which is what this test exists to prove.
    const f = await fixture((u) => (u === "/start" ? { status: 302, location: "http://169.254.169.254/latest/meta-data/" } : { status: 200, body: "should not be reached" }));
    try {
      const res = await fetchPublic(`${f.base}/start`, { timeoutMs: 2000, allowFirstHop: true });
      expect(res).toBeNull();
      // The fixture WAS contacted - so the test really did reach the redirect, rather than
      // being refused before it started, which is how the previous version passed vacuously.
      expect(f.hits).toEqual(["/start"]);
    } finally {
      await f.close();
    }
  });

  it("follows an ordinary redirect itself, rather than letting the client do it", async () => {
    const { fetchPublic } = await import("./http.js");
    const f = await fixture((u) => (u === "/start" ? { status: 302, location: "/end" } : { status: 200, body: "arrived" }));
    try {
      const res = await fetchPublic(`${f.base}/start`, { timeoutMs: 2000, allowPrivateHosts: true });
      expect(res).not.toBeNull();
      expect(await res!.text()).toBe("arrived");
      expect(f.hits).toEqual(["/start", "/end"]);

      // The hit count above does NOT distinguish who followed the redirect - both this
      // loop and the client produce the same two requests against a same-origin fixture,
      // which is how an earlier version of this test came to prove nothing while its
      // comment claimed otherwise. `maxRedirects: 0` is what separates them: the loop
      // refuses to take the hop at all, while a client following internally returns the
      // destination regardless of a limit it knows nothing about.
      f.hits.length = 0;
      expect(await fetchPublic(`${f.base}/start`, { timeoutMs: 2000, allowPrivateHosts: true, maxRedirects: 0 })).toBeNull();
      expect(f.hits).toEqual(["/start"]);
    } finally {
      await f.close();
    }
  });

  it("gives up rather than following a redirect loop forever", async () => {
    const { fetchPublic } = await import("./http.js");
    const f = await fixture(() => ({ status: 302, location: "/round" }));
    try {
      expect(await fetchPublic(`${f.base}/round`, { timeoutMs: 2000, allowPrivateHosts: true, maxRedirects: 3 })).toBeNull();
      expect(f.hits.length).toBe(4);
    } finally {
      await f.close();
    }
  });
});

describe("userinfo is judged differently for a crawl target and a customer's own webhook", () => {
  it("refuses a host smuggled after userinfo when crawling", () => {
    expect(isPublicHost("example.com@169.254.169.254")).toBe(false);
  });

  it("allows HTTP Basic credentials in a webhook URL, and still judges the host", () => {
    // Refusing every URL with credentials silently stopped customers whose self-hosted
    // endpoint uses Basic auth in the URL - an ordinary pattern - from receiving leads.
    expect(isPublicHost("https://user:pass@hooks.acme.com/prospex", { allowUserinfo: true })).toBe(true);
    // The host behind the credentials is still judged on its merits.
    expect(isPublicHost("https://user:pass@127.0.0.1/steal", { allowUserinfo: true })).toBe(false);
    expect(isPublicHost("https://acme.com@169.254.169.254/", { allowUserinfo: true })).toBe(false);
  });

  it("refuses the deprecated IPv4-compatible IPv6 spelling", () => {
    // [::127.0.0.1] canonicalises to [::7f00:1], which matched neither mapped-address
    // branch when this guard was first written.
    expect(isPublicHost("[::127.0.0.1]")).toBe(false);
    expect(isPublicHost("[::7f00:1]")).toBe(false);
  });
});
