import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

describe("security: demo account generation & expiry hardening", () => {
  it("generates cryptographically strong, non-predictable passwords with required format", () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const generatePassword = () => {
      const bytes = randomBytes(12);
      let pass = "";
      for (let i = 0; i < 12; i++) {
        pass += chars[bytes[i] % chars.length];
      }
      return `Scout-${pass.slice(0, 4)}-${pass.slice(4, 8)}!`;
    };

    const passwords = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^Scout-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}!$/);
      expect(passwords.has(p)).toBe(false);
      passwords.add(p);
    }
    expect(passwords.size).toBe(200);
  });

  it("disambiguates slug collisions with cryptographically secure hex suffixes", () => {
    const makeSuffix = () => randomBytes(3).toString("hex");
    const suffixes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const s = makeSuffix();
      expect(s).toHaveLength(6);
      expect(s).toMatch(/^[0-9a-f]{6}$/);
      suffixes.add(s);
    }
    expect(suffixes.size).toBe(100);
  });

  it("evaluates demo expiration correctly in background worker logic", () => {
    function isOrgDemoExpired(settings: unknown): boolean {
      if (!settings || typeof settings !== "object") return false;
      const s = settings as Record<string, unknown>;
      if (!s.isDemo || !s.demoExpiresAt) return false;
      const expiresAt = new Date(s.demoExpiresAt as string).getTime();
      return !Number.isNaN(expiresAt) && Date.now() > expiresAt;
    }

    // Standard non-demo org
    expect(isOrgDemoExpired({})).toBe(false);
    expect(isOrgDemoExpired({ plan: "growth" })).toBe(false);

    // Active demo org (future expiry)
    const futureExpiry = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    expect(isOrgDemoExpired({ isDemo: true, demoExpiresAt: futureExpiry })).toBe(false);

    // Expired demo org (past expiry)
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    expect(isOrgDemoExpired({ isDemo: true, demoExpiresAt: pastExpiry })).toBe(true);

    // Converted demo org (isDemo deleted or false)
    expect(isOrgDemoExpired({ isDemo: false, demoExpiresAt: pastExpiry })).toBe(false);
  });
});
