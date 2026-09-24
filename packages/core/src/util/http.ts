import { classifyHttp, classifyThrown, reportProviderCall } from "../providers/health.js";

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
      redirect: "follow",
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

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) return null;
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
    if (opts.provider) reportProviderCall({ provider: opts.provider, outcome: "ok", status: res.status });
    return (await res.json()) as T;
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
