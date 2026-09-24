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

  it("refuses a malformed address rather than letting it through", () => {
    expect(isPublicHost("999.999.999.999")).toBe(false);
    expect(isPublicHost("")).toBe(false);
    expect(isPublicHost("   ")).toBe(false);
  });
});
