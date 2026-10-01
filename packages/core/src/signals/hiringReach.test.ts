import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectHiring } from "./hiring.js";
import { resetSearchCache } from "../search/index.js";
import { resetProviderSkips } from "../providers/health.js";

/**
 * webSearch never throws, so the old `res !== null` check counted a search in which every
 * provider failed as "answered", and an unreachable company was reported as reached with
 * zero open roles - which zeroes the stored count and suppresses the hiring alert.
 */
beforeEach(() => {
  resetSearchCache();
  resetProviderSkips();
  for (const k of ["GOOGLE_CSE_API_KEY", "SERPAPI_KEY", "BRAVE_SEARCH_API_KEY"]) vi.stubEnv(k, "");
  vi.stubEnv("SERPER_API_KEY", "k");
  vi.stubEnv("DDG_DISABLED", "true");
  vi.stubEnv("BING_HTML_DISABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectHiring when nothing could be reached", () => {
  it("does not claim the search answered when every provider failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const h = await detectHiring("acme.example", "Acme", { allowPrivateHosts: true });
    expect(h.reached).toBe(false);
  });

  it("counts a search that answered with nothing as reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => (String(u).includes("serper.dev") ? new Response(JSON.stringify({ organic: [] }), { status: 200 }) : new Response("down", { status: 503 }))));
    const h = await detectHiring("acme.example", "Acme", { allowPrivateHosts: true });
    expect(h.reached).toBe(true);
  });
});
