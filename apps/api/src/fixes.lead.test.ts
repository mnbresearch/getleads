import { describe, expect, it } from "vitest";
import { redactRequestLine } from "./app.js";

describe("lead integration checks for the audit rounds", () => {
  it("never writes the per-workspace reply token to the access log", () => {
    const token = "Zx9_secretTokenValue-abcdefghijklmnopqrstuvwxyz0123";
    const line = redactRequestLine(`/v1/public/inbound/${token}`);
    expect(line).not.toContain(token);
    expect(line).toBe("/v1/public/inbound/[redacted]");
  });
});
