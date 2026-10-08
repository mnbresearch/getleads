/**
 * Keeps a free Render instance from going to sleep during the working day.
 *
 * Render's free web services stop after 15 minutes without an inbound request. A stopped
 * instance runs no background worker (no campaign sends, no scheduled plays) and makes the
 * next visitor wait about a minute while it starts. Asking our own public address for
 * /health every few minutes counts as inbound traffic, so the instance stays up.
 *
 * Only inside a daily window, on purpose. Two free allowances are at stake:
 *   - Render: 750 instance hours a month for the whole workspace. Awake around the clock is
 *     ~744 of them, and running out suspends every free service until the next month.
 *   - Neon (free): 100 compute hours (CU-hours) a month. The embedded worker queries the
 *     database every 1.5 s while the API is up, so Neon is awake whenever the API is - at
 *     0.25 CU, 9 hours a day is ~70 CU-hours a month, which leaves room for visits outside
 *     the window. Running out suspends the database until the next month.
 * Outside the window nothing is sent, so the instance sleeps 15 minutes after its last
 * real request, exactly as before.
 *
 * Switches (read once at start):
 *   KEEP_AWAKE=off            never ping (also: false, 0, no)
 *   KEEP_AWAKE_HOURS=10-19    the window, start hour inclusive, end hour exclusive, 0-24
 *   KEEP_AWAKE_TZ=Asia/Kolkata  the time zone of the window
 *   KEEP_AWAKE_URL            the address to ping; default RENDER_EXTERNAL_URL, which Render
 *                             sets on every web service. Neither set: nothing runs, so local
 *                             development, tests and other hosts are unaffected.
 */

export interface KeepAwakeConfig {
  url: string;
  startHour: number;
  endHour: number;
  timeZone: string;
  intervalMs: number;
}

export const KEEP_AWAKE_DEFAULT_HOURS = { start: 10, end: 19 } as const;
export const KEEP_AWAKE_DEFAULT_TZ = "Asia/Kolkata";
/** Under Render's 15-minute idle limit with room for one slow or failed ping. */
export const KEEP_AWAKE_INTERVAL_MS = 10 * 60_000;

const OFF = /^(off|false|0|no)$/i;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "10-19" -> {start: 10, end: 19}. Anything else, or start >= end, is null. */
export function parseHours(raw: string | undefined): { start: number; end: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 0 || start > 23 || end < 1 || end > 24 || start >= end) return null;
  return { start, end };
}

/** The base address to ping, without a trailing slash; null when it is not an http(s) URL. */
function baseUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The configuration, or null when keep-awake should not run. `warn` hears about values that
 * were ignored, so a typo is visible in the log instead of silently changing the window.
 */
export function keepAwakeConfig(e: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): KeepAwakeConfig | null {
  if (OFF.test((e.KEEP_AWAKE ?? "").trim())) return null;
  const url = baseUrl(e.KEEP_AWAKE_URL) ?? baseUrl(e.RENDER_EXTERNAL_URL);
  if (!url) {
    if ((e.KEEP_AWAKE_URL ?? "").trim()) warn("KEEP_AWAKE_URL is not an http(s) address; keep-awake is off");
    return null;
  }
  let hours = parseHours(e.KEEP_AWAKE_HOURS);
  if (!hours) {
    if ((e.KEEP_AWAKE_HOURS ?? "").trim()) warn(`KEEP_AWAKE_HOURS must look like 10-19 (start-end, 0-24); using ${KEEP_AWAKE_DEFAULT_HOURS.start}-${KEEP_AWAKE_DEFAULT_HOURS.end}`);
    hours = { ...KEEP_AWAKE_DEFAULT_HOURS };
  }
  let timeZone = (e.KEEP_AWAKE_TZ ?? "").trim() || KEEP_AWAKE_DEFAULT_TZ;
  if (!validTimeZone(timeZone)) {
    warn(`KEEP_AWAKE_TZ "${timeZone.slice(0, 40)}" is not a time zone; using ${KEEP_AWAKE_DEFAULT_TZ}`);
    timeZone = KEEP_AWAKE_DEFAULT_TZ;
  }
  return { url, startHour: hours.start, endHour: hours.end, timeZone, intervalMs: KEEP_AWAKE_INTERVAL_MS };
}

/** The hour (0-23) at `at` in the given time zone. */
export function hourIn(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at);
  return Number(h) % 24;
}

export function withinWindow(at: Date, cfg: Pick<KeepAwakeConfig, "startHour" | "endHour" | "timeZone">): boolean {
  const h = hourIn(at, cfg.timeZone);
  return h >= cfg.startHour && h < cfg.endHour;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Starts the pinger and returns a stop function, or null when it is not configured.
 * The timer is unref'd (it never keeps the process alive on its own) and every failure is
 * swallowed: a ping that fails changes nothing, the next one is ten minutes later.
 */
export function startKeepAwake(
  opts: { env?: NodeJS.ProcessEnv; log?: (m: string) => void; fetchImpl?: typeof fetch; now?: () => Date } = {},
): (() => void) | null {
  const log = opts.log ?? ((m: string) => console.log(m));
  const cfg = keepAwakeConfig(opts.env ?? process.env, (m) => log(`[api] keep-awake: ${m}`));
  if (!cfg) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  let host = cfg.url;
  try {
    host = new URL(cfg.url).host;
  } catch {
    /* keep the full value */
  }
  log(
    `[api] keep-awake: asking ${host}/health every ${Math.round(cfg.intervalMs / 60_000)} min between ${pad(cfg.startHour)}:00 and ${pad(cfg.endHour % 24)}:00 ${cfg.timeZone} (KEEP_AWAKE=off turns it off)`,
  );
  let inFlight = false;
  const tick = async () => {
    if (inFlight || !withinWindow(now(), cfg)) return;
    inFlight = true;
    try {
      const res = await doFetch(`${cfg.url}/health`, {
        method: "GET",
        headers: { "user-agent": "ScoutKeepAwake/1" },
        signal: AbortSignal.timeout(15_000),
      });
      // The body is not needed; reading it releases the connection.
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      /* the next tick tries again */
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), cfg.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
