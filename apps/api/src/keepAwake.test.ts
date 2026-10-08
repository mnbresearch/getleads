import { afterEach, describe, expect, it, vi } from "vitest";
import { hourIn, keepAwakeConfig, KEEP_AWAKE_INTERVAL_MS, parseHours, startKeepAwake, withinWindow } from "./lib/keepAwake.js";

const RENDER = { RENDER_EXTERNAL_URL: "https://getleads-api.onrender.com" } as NodeJS.ProcessEnv;
// 2026-10-08 05:00 UTC is 10:30 in Asia/Kolkata (UTC+5:30).
const IN_WINDOW = new Date("2026-10-08T05:00:00Z");
// 2026-10-08 20:00 UTC is 01:30 the next day in Asia/Kolkata.
const OUT_OF_WINDOW = new Date("2026-10-08T20:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("keep-awake configuration", () => {
  it("does nothing off Render (no RENDER_EXTERNAL_URL, no KEEP_AWAKE_URL)", () => {
    expect(keepAwakeConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(startKeepAwake({ env: {} as NodeJS.ProcessEnv, log: () => {} })).toBeNull();
  });

  it("defaults to 10-19 Asia/Kolkata every 10 minutes on Render", () => {
    expect(keepAwakeConfig(RENDER)).toEqual({
      url: "https://getleads-api.onrender.com",
      startHour: 10,
      endHour: 19,
      timeZone: "Asia/Kolkata",
      intervalMs: 10 * 60_000,
    });
    expect(KEEP_AWAKE_INTERVAL_MS).toBeLessThan(15 * 60_000);
  });

  it("KEEP_AWAKE=off (and its spellings) turns it off", () => {
    for (const v of ["off", "OFF", "false", "0", "no", " off "]) {
      expect(keepAwakeConfig({ ...RENDER, KEEP_AWAKE: v })).toBeNull();
    }
    expect(keepAwakeConfig({ ...RENDER, KEEP_AWAKE: "on" })).not.toBeNull();
  });

  it("KEEP_AWAKE_URL wins over RENDER_EXTERNAL_URL and loses its trailing slash", () => {
    expect(keepAwakeConfig({ ...RENDER, KEEP_AWAKE_URL: "https://api.mnbresearch.com/" })?.url).toBe("https://api.mnbresearch.com");
  });

  it("a non-http KEEP_AWAKE_URL is refused with a warning, not pinged", () => {
    const warn = vi.fn();
    expect(keepAwakeConfig({ KEEP_AWAKE_URL: "javascript:alert(1)" } as NodeJS.ProcessEnv, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("parses the window and rejects nonsense", () => {
    expect(parseHours("9-18")).toEqual({ start: 9, end: 18 });
    expect(parseHours(" 0 - 24 ")).toEqual({ start: 0, end: 24 });
    for (const bad of ["", "18-9", "10-10", "24-25", "-1-5", "nine-five", "10", "10-19-20"]) expect(parseHours(bad)).toBeNull();
  });

  it("a bad window or time zone falls back to the default and says so", () => {
    const warn = vi.fn();
    const cfg = keepAwakeConfig({ ...RENDER, KEEP_AWAKE_HOURS: "19-10", KEEP_AWAKE_TZ: "Mars/Olympus" }, warn);
    expect(cfg).toMatchObject({ startHour: 10, endHour: 19, timeZone: "Asia/Kolkata" });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("keep-awake window", () => {
  it("reads the hour in the configured time zone", () => {
    expect(hourIn(IN_WINDOW, "Asia/Kolkata")).toBe(10);
    expect(hourIn(IN_WINDOW, "UTC")).toBe(5);
    expect(hourIn(OUT_OF_WINDOW, "Asia/Kolkata")).toBe(1);
  });

  it("start hour is inside, end hour is outside", () => {
    const cfg = { startHour: 10, endHour: 19, timeZone: "Asia/Kolkata" };
    expect(withinWindow(new Date("2026-10-08T04:30:00Z"), cfg)).toBe(true); // 10:00 IST
    expect(withinWindow(new Date("2026-10-08T04:29:00Z"), cfg)).toBe(false); // 09:59 IST
    expect(withinWindow(new Date("2026-10-08T13:29:00Z"), cfg)).toBe(true); // 18:59 IST
    expect(withinWindow(new Date("2026-10-08T13:30:00Z"), cfg)).toBe(false); // 19:00 IST
    expect(withinWindow(OUT_OF_WINDOW, { startHour: 0, endHour: 24, timeZone: "Asia/Kolkata" })).toBe(true);
  });
});

describe("keep-awake pinger", () => {
  const ok = () => Promise.resolve(new Response("{}", { status: 200 }));

  it("asks <url>/health inside the window, every interval", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const logs: string[] = [];
    const stop = startKeepAwake({ env: RENDER, log: (m) => logs.push(m), fetchImpl, now: () => IN_WINDOW });
    expect(stop).toBeTypeOf("function");
    expect(logs[0]).toMatch(/keep-awake: asking getleads-api\.onrender\.com\/health every 10 min between 10:00 and 19:00 Asia\/Kolkata/);
    expect(fetchImpl).not.toHaveBeenCalled(); // nothing at start: the instance is awake already
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://getleads-api.onrender.com/health");
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    stop!();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("sends nothing outside the window, so the instance can sleep", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const stop = startKeepAwake({ env: RENDER, log: () => {}, fetchImpl, now: () => OUT_OF_WINDOW });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS * 6);
    expect(fetchImpl).not.toHaveBeenCalled();
    stop!();
  });

  it("a failing ping is swallowed and the next one still runs", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchImpl = vi.fn(() => (++n === 1 ? Promise.reject(new Error("ECONNRESET")) : ok())) as unknown as typeof fetch;
    const stop = startKeepAwake({ env: RENDER, log: () => {}, fetchImpl, now: () => IN_WINDOW });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop!();
  });

  it("does not stack pings when one hangs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const stop = startKeepAwake({ env: RENDER, log: () => {}, fetchImpl, now: () => IN_WINDOW });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS * 4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    stop!();
  });
});
