import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The resolver, mocked, so an outage can be simulated.
 *
 * checkDomainHealth talks to DNS four different ways and every one of them used to swallow
 * its error. A test that cannot break DNS cannot tell the difference between the report this
 * module is supposed to produce and the one it produced during an outage - which is the
 * difference this file exists to pin down.
 */
const resolveMx = vi.fn();
const resolveTxt = vi.fn();
vi.mock("node:dns", () => ({ promises: { resolveMx: (d: string) => resolveMx(d), resolveTxt: (d: string) => resolveTxt(d) } }));

const { checkDomainHealth } = await import("./domainHealth.js");

const err = (code: string) => {
  const e = new Error(`query failed: ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
};

afterEach(() => {
  resolveMx.mockReset();
  resolveTxt.mockReset();
});

describe("sender domain health separates 'no record' from 'could not ask'", () => {
  it("refuses to call a resolver outage a set of findings", async () => {
    resolveMx.mockRejectedValue(err("SERVFAIL"));
    resolveTxt.mockRejectedValue(err("SERVFAIL"));

    const r = await checkDomainHealth("acme.com");
    expect(r.resolved).toBe(false);
    // The old version returned score 0 with "No SPF record" and "No DMARC record", which
    // reads as a finding and invites the user to change live DNS off a network blip.
    expect(r.spf.issues).not.toContain("No SPF record");
    expect(r.dmarc.issues).not.toContain("No DMARC record");
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0]).toMatch(/did not complete/i);
  });

  it("still reports genuinely missing records when the resolver answers", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.acme.com", priority: 10 }]);
    resolveTxt.mockRejectedValue(err("ENODATA"));

    const r = await checkDomainHealth("acme.com");
    expect(r.resolved).toBe(true);
    expect(r.mx.ok).toBe(true);
    expect(r.spf.issues).toContain("No SPF record");
    expect(r.dmarc.issues).toContain("No DMARC record");
    expect(r.recommendations.join(" ")).toMatch(/Publish an SPF record/);
  });

  it("scores a well-configured domain and says so", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.acme.com", priority: 10 }]);
    resolveTxt.mockImplementation(async (name: string) => {
      if (name === "acme.com") return [["v=spf1 include:_spf.google.com ~all"]];
      if (name === "_dmarc.acme.com") return [["v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com"]];
      if (name === "google._domainkey.acme.com") return [["v=DKIM1; k=rsa; p=MIGf"]];
      throw err("ENODATA");
    });

    const r = await checkDomainHealth("acme.com");
    expect(r.resolved).toBe(true);
    expect(r.score).toBe(100);
    expect(r.dkim.selectorsFound).toContain("google");
    expect(r.recommendations.join(" ")).toMatch(/well configured/i);
  });

  it("flags an SPF record that permits anyone", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.acme.com", priority: 10 }]);
    resolveTxt.mockImplementation(async (name: string) => {
      if (name === "acme.com") return [["v=spf1 +all"]];
      throw err("ENODATA");
    });

    const r = await checkDomainHealth("acme.com");
    expect(r.spf.issues).toContain("SPF uses +all (allows anyone)");
    expect(r.spf.ok).toBe(false);
  });
});
