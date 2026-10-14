/**
 * B1 fix round: an SMTP probe that never reached the mailbox is not a check.
 *
 * Port 25 refused (what most hosts do) and a probe that errored used to return
 * verifiedBy "smtp" - the same mark as a server that accepted the address - so the lead was
 * stamped verified. The socket and the public-address check are faked: nothing is dialled.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({ fail: false }));
vi.mock("./util/egress.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./util/egress.js")>();
  return {
    ...orig,
    assertPublicHost: vi.fn(async () => {
      if (egress.fail) throw new Error("getaddrinfo ENOTFOUND mx.target.example");
      return { address: "203.0.113.5", family: 4 as const };
    }),
  };
});
vi.mock("node:net", () => {
  const createConnection = () => {
    const s = new EventEmitter() as EventEmitter & { write: () => void; destroy: () => void };
    s.write = () => {};
    s.destroy = () => {};
    // What a host that blocks outbound port 25 answers.
    setTimeout(() => s.emit("error", Object.assign(new Error("connect ECONNREFUSED 203.0.113.5:25"), { code: "ECONNREFUSED" })), 1);
    return s;
  };
  return { default: { createConnection }, createConnection };
});

import { isUncheckedSmtp, resetMxCache, setMxResolver, verifyEmail } from "./email/verify.js";

beforeEach(() => {
  resetMxCache();
  setMxResolver({ resolveMx: async () => [{ exchange: "mx.target.example", priority: 10 }], resolve4: async () => ["203.0.113.5"] });
  egress.fail = false;
});
afterEach(() => {
  setMxResolver(null);
});

describe("verifyEmail with the SMTP probe on and no verifier", () => {
  it("port 25 refused: risky, and verifiedBy says the probe was blocked, not 'smtp'", async () => {
    const v = await verifyEmail("jane@target.example", { smtp: true });
    expect(v.status).toBe("risky");
    expect(v.checks.smtp).toBe("blocked");
    expect(v.verifiedBy).toBe("smtp-blocked");
    expect(isUncheckedSmtp(v.verifiedBy)).toBe(true);
  });

  it("probe errored: verifiedBy 'smtp-error'", async () => {
    egress.fail = true;
    const v = await verifyEmail("jane@target.example", { smtp: true });
    expect(v.checks.smtp).toBe("error");
    expect(v.verifiedBy).toBe("smtp-error");
  });
});
