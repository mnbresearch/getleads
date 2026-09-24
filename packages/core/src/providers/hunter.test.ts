import { describe, expect, it } from "vitest";
import { hunterEmailVerdict } from "./people.js";

/**
 * Hunter returns two numbers that mean different things: `confidence` is how well an address
 * fits the domain's pattern, `verification.status` is whether the mailbox was checked. Any
 * confidence >= 80 used to be mapped to "valid", so a pattern guess arrived carrying the
 * same label as a verified mailbox - a label that downstream suppresses re-verification and
 * clears the address for sending.
 */
describe("Hunter results are not relabelled as verification", () => {
  it("calls a verified mailbox valid", () => {
    expect(hunterEmailVerdict("valid", 97)).toEqual({ status: "valid", confidence: 0.97 });
  });

  it("does not call a high-confidence guess valid", () => {
    const v = hunterEmailVerdict(undefined, 92);
    expect(v.status).toBe("risky");
    expect(v.confidence).toBeLessThanOrEqual(0.75);
  });

  it("does not call a weak guess a verdict at all", () => {
    const v = hunterEmailVerdict(undefined, 40);
    expect(v.status).toBe("unknown");
    expect(v.confidence).toBeLessThanOrEqual(0.5);
  });

  it("keeps a verified address ranked above the best guess", () => {
    expect(hunterEmailVerdict("valid", 80).confidence).toBeGreaterThan(hunterEmailVerdict(undefined, 99).confidence);
  });

  it("passes through invalid and accept_all rather than flattening them", () => {
    expect(hunterEmailVerdict("invalid", 95).status).toBe("invalid");
    expect(hunterEmailVerdict("accept_all", 95).status).toBe("catch_all");
    expect(hunterEmailVerdict("accept_all", 95).confidence).toBeLessThanOrEqual(0.6);
  });

  it("treats an unrecognised status as unverified, not as a pass", () => {
    expect(hunterEmailVerdict("pending", 95).status).toBe("risky");
    expect(hunterEmailVerdict("webmail", 10).status).toBe("unknown");
  });
});
