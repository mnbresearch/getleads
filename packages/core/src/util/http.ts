import { classifyHttp, classifyThrown, reportProviderCall } from "../providers/health.js";
import { isPublicHost } from "./publicHost.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ProspexBot/0.1 (+https://prospex.dev/bot)";

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Report this call's outcome to provider health.
   *
   * Opt-in rather than automatic: most fetchJson callers are scraping the open web, where a
   * 404 or a timeout is ordinary and recording it as a provider fault would bury the signal.
   * Set it only for calls against a credentialed API we actually care about the health of.
   */
  provider?: string;
  /** fetchText / fetchPublic: refuse a URL, or a redirect, that points at a private address. */
  publicOnly?: boolean;
  /** Escape hatch for tests, which serve fixtures from loopback. Applies to every hop. */
  allowPrivateHosts?: boolean;
  /**
   * Permit the FIRST hop unconditionally, and judge every later one.
   *
   * Only for tests that need to serve a redirect from loopback while still proving the
   * per-hop check refuses the target. `allowPrivateHosts` is all-or-nothing and cannot
   * express that, which is how a test of this guard came to pass without exercising it.
   */
  allowFirstHop?: boolean;
  /** How many redirects fetchPublic will follow before giving up. Default 5. */
  maxRedirects?: number;
}

/**
 * Fetch with a deadline that covers the whole exchange, body included.
 *
 * The timer used to be cleared in a `finally`, which runs the moment the response HEADERS
 * arrive. Everything after that - `res.json()`, `res.arrayBuffer()` - was unbounded, so a
 * server that answered `200 OK` and then stopped sending held the caller open forever. That
 * is how one slow upstream stalls a worker: not a timeout that fires, but a timeout that
 * quietly stopped applying at the worst moment.
 *
 * So the timer stays armed until the caller has read the body, and is only cleared when the
 * fetch itself throws. Aborting a request whose body has already been consumed is a no-op,
 * and `unref` keeps the pending timer from holding the process open on the way out. Every
 * caller in this codebase reads the body immediately; a caller that wants to hold a response
 * open and stream it later should pass a `timeoutMs` that covers that, or use `fetch`.
 */
export async function fetchWithTimeout(url: string, opts: FetchOpts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12_000);
  (t as unknown as { unref?: () => void }).unref?.();
  try {
    return await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en", ...(opts.headers ?? {}) },
      // `?? "follow"`, not a hardcoded "follow". Spread order made this override the
      // caller's choice, so fetchPublic's `redirect: "manual"` never took effect and its
      // entire per-hop SSRF check was dead code - while both of its tests passed, because
      // undici followed the redirect internally and produced the expected result anyway.
      redirect: opts.redirect ?? "follow",
    });
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/**
 * Read at most `max` bytes of a response body, and stop pulling once past it.
 *
 * `await res.arrayBuffer()` then slicing buffers the entire response first, so a `maxBytes`
 * applied afterwards limits what is parsed but not what is downloaded. A page that streams
 * hundreds of megabytes - a misconfigured export endpoint, a tarball behind an HTML
 * content-type - would be pulled into memory in full before the cap was consulted.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(await res.arrayBuffer()).slice(0, max);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const take = Math.min(value.byteLength, max - total);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      total += take;
    }
  } finally {
    // Stop the transfer rather than letting the rest of a huge body drain in the background.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Fetch a URL that came from a user, checking every hop.
 *
 * `isPublicHost` is a pre-flight check on the address we were given, and on its own it is
 * defeated by one redirect: a host the guard allows answers `302 Location:
 * http://169.254.169.254/...`, undici follows it because `redirect: "follow"` is the
 * default here, and the metadata response is what gets parsed, stored on the company
 * record and shown back in the UI.
 *
 * So redirects are followed by hand, and the guard runs against each new location. A
 * redirect to a private address ends the walk rather than being followed.
 */
export async function fetchPublic(url: string, opts: FetchOpts = {}): Promise<Response | null> {
  const max = opts.maxRedirects ?? 5;
  let current = url;
  let method = opts.method;
  let body = opts.body;
  for (let hop = 0; hop <= max; hop++) {
    const permitted = (opts.allowPrivateHosts ?? false) || (hop === 0 && (opts.allowFirstHop ?? false));
    if (!permitted && !isPublicHost(current)) return null;
    const res = await fetchWithTimeout(current, { ...opts, method, body, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    // Cancel the redirect body so the connection is not left hanging.
    await res.body?.cancel().catch(() => {});
    // 301, 302 and 303 turn into a GET with no body, as the spec requires and as every
    // browser does; 307 and 308 preserve both. Replaying a POST body across a 302 would
    // send the same payload somewhere the caller never addressed.
    if (res.status !== 307 && res.status !== 308) {
      method = "GET";
      body = undefined;
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  try {
    // `publicOnly` routes through the per-hop check. Callers fetching a URL the USER chose
    // - a company domain, a careers page - set it; callers hitting a known API do not.
    const res = opts.publicOnly ? await fetchPublic(url, opts) : await fetchWithTimeout(url, opts);
    if (!res || !res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text|html|json|xml/.test(ct)) return null;
    const max = opts.maxBytes ?? 1_500_000;
    return new TextDecoder("utf-8", { fatal: false }).decode(await readCapped(res, max));
  } catch {
    return null;
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) {
      if (opts.provider) {
        const body = await res.text().catch(() => "");
        const { outcome, detail } = classifyHttp(res.status, body);
        reportProviderCall({ provider: opts.provider, outcome, status: res.status, detail });
      }
      return null;
    }
    // Parse BEFORE declaring success. Reporting "ok" and then having res.json() throw
    // recorded the same call as both a success and a network failure, and stamped lastOkAt
    // on a call that produced nothing usable.
    let parsed: T;
    try {
      parsed = (await res.json()) as T;
    } catch (e) {
      if (opts.provider) {
        reportProviderCall({ provider: opts.provider, outcome: "bad_response", status: res.status, detail: `HTTP ${res.status} with a body that is not JSON: ${(e as Error).message}`.slice(0, 200) });
      }
      return null;
    }
    if (opts.provider) reportProviderCall({ provider: opts.provider, outcome: "ok", status: res.status });
    return parsed;
  } catch (e) {
    if (opts.provider) {
      const { outcome, detail } = classifyThrown(e);
      reportProviderCall({ provider: opts.provider, outcome, detail });
    }
    return null;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run async tasks with bounded concurrency. */
export async function pMap<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>, concurrency = 5): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
