import { classifyHttp, classifyThrown, reportProviderCall } from "../providers/health.js";
import { guardedDispatcher, isSsrfBlocked } from "./egress.js";
import { isPublicHost, parseHttpUrl } from "./publicHost.js";

/**
 * The name this crawler goes by: the product token at the end of the user-agent every
 * request carries, and the name a site's robots.txt can address it by
 * ("User-agent: ScoutBot"). One constant, so what is sent and what is obeyed cannot drift apart.
 */
export const CRAWLER_TOKEN = "ScoutBot";

const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ${CRAWLER_TOKEN}/1.0 (+https://scout.mnbresearch.com)`;

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
  /**
   * How many redirects fetchPublic will follow before giving up. Default 5.
   *
   * `0` means "do not follow redirects at all", and is the one case where a redirect is
   * handed back instead of refused: the 3xx response is returned (status and headers
   * intact, body discarded), so the caller can report "this endpoint redirects" rather
   * than a bare failure. Webhook-style deliveries use this - a POST carrying a tenant's
   * lead is never re-sent to wherever a 3xx points. With any other value, running out of
   * hops returns null, as it always has.
   */
  maxRedirects?: number;
  /**
   * fetchPublic: accept `user:pass@` in the URL of the FIRST hop, sending it as HTTP Basic.
   *
   * For a URL a customer typed into their own settings (a self-hosted webhook secured with
   * Basic auth). The host behind the credentials is still judged. Never honoured on a
   * redirect hop, and never for a crawl target, where userinfo means the string is not the
   * host it appears to be.
   */
  allowUserinfo?: boolean;
  /**
   * fetchPublic: an extra rule every hop's hostname must pass (lower-case, no brackets).
   * For a fetch that should only ever talk to one site - a LinkedIn post, say - so that a
   * redirect cannot carry it somewhere else, public or not.
   */
  hostAllow?: (hostname: string) => boolean;
  /**
   * Do not add the crawler's browser-like default headers (user-agent, accept,
   * accept-language). For API-style calls - a webhook delivery is not a page view.
   */
  noDefaultHeaders?: boolean;
  /**
   * The undici dispatcher to send through. fetchPublic sets this itself (to
   * `guardedDispatcher()`, or to nothing when `allowPrivateHosts` permits the hop), and
   * overrides whatever is passed here.
   */
  dispatcher?: unknown;
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
      // Merged through Headers rather than object spread. Spreading only works for a plain
      // object: an array of pairs becomes {"0": [...]} and a Headers instance becomes {},
      // because its entries live in internal slots. That second case silently threw away
      // every header fetchPublic had carefully stripped credentials out of.
      headers: mergeHeaders(opts.noDefaultHeaders ? {} : { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en" }, opts.headers),
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
 * Fetch a URL that came from a tenant, a user or third-party content - checking every hop,
 * and checking the address each hop actually connects to.
 *
 * Three things are enforced on EVERY hop, the first and each redirect:
 *
 *   - the URL is http(s), carries no credentials (unless `allowUserinfo`, first hop only)
 *     and its host passes `isPublicHost` - the literal check, which catches an IP written
 *     any way a URL parser accepts;
 *   - the connection goes out through `guardedDispatcher()`, which resolves the name once,
 *     refuses if any address it resolves to is not public, and connects to the address it
 *     vetted - so a public-looking name that points at 127.0.0.1 or the metadata endpoint
 *     is refused, and DNS rebinding has no second lookup to win;
 *   - redirects are followed here, by hand, never by the client, so both of the above run
 *     again for each `Location`.
 *
 * Returns the Response, or **null when the request was refused** (not public, not http(s),
 * redirect limit reached). Network failures still throw, as fetch does. One exception to
 * "null on a redirect we will not follow": `maxRedirects: 0` returns the 3xx response
 * itself - see FetchOpts.maxRedirects.
 *
 * `maxBytes`, when given, caps how much of the response body can be read from the returned
 * Response, so `await res.text()` on a hostile endpoint cannot buffer without limit.
 *
 * This calls the GLOBAL fetch (with a `dispatcher`), so a test that stubs global fetch
 * still intercepts it. `allowPrivateHosts` - tests and local development only - skips the
 * address checks and uses the default, unguarded dispatcher.
 */
/** True only for a body that cannot be sent twice. */
function isSingleUseBody(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return false;
  return typeof (body as { getReader?: unknown }).getReader === "function";
}

function mergeHeaders(base: Record<string, string>, extra: HeadersInit | undefined): Headers {
  const h = new Headers(base);
  // forEach rather than iteration: the TS lib in this project types Headers without
  // Symbol.iterator, and forEach is on every runtime this ships to.
  if (extra) new Headers(extra).forEach((v, k) => h.set(k, v));
  return h;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function stripCredentials(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  const out = new Headers(headers);
  out.delete("authorization");
  out.delete("cookie");
  out.delete("proxy-authorization");
  const plain: Record<string, string> = {};
  out.forEach((v, k) => { plain[k] = v; });
  return plain;
}

/** Response -> same response, whose body ends after `max` bytes. */
function capBody(res: Response, max: number): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (total >= max) {
        controller.close();
        await reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) return controller.close();
      if (!value) return;
      const take = Math.min(value.byteLength, max - total);
      total += take;
      controller.enqueue(take === value.byteLength ? value : value.subarray(0, take));
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
  const headers = new Headers(res.headers);
  // The body has already been decoded and may now be shorter than these claim.
  headers.delete("content-length");
  headers.delete("content-encoding");
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers });
  Object.defineProperty(out, "url", { value: res.url });
  return out;
}

export async function fetchPublic(url: string, opts: FetchOpts = {}): Promise<Response | null> {
  const max = opts.maxRedirects ?? 5;
  let current = url;
  let method = opts.method;
  let body = opts.body;
  for (let hop = 0; hop <= max; hop++) {
    const permitted = (opts.allowPrivateHosts ?? false) || (hop === 0 && (opts.allowFirstHop ?? false));
    // http(s) only, no fragment, and credentials only where the caller said to expect them.
    const target = parseHttpUrl(current, { allowUserinfo: hop === 0 && (opts.allowUserinfo ?? false) });
    if (!target) return null;
    if (!permitted && !isPublicHost(target.href, { allowUserinfo: true })) return null;
    if (opts.hostAllow && !opts.hostAllow(target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase())) return null;
    // Credentials are dropped on a cross-origin hop, as a client following redirects for
    // us would do. This loop forwards `opts` verbatim, so without this an Authorization or
    // Cookie header set by the caller would be handed to whatever host the redirect names.
    let headers = hop === 0 || sameOrigin(url, current) ? opts.headers : stripCredentials(opts.headers);
    // fetch refuses a URL with credentials outright, so they travel as the header they
    // stand for. An Authorization header the caller set explicitly wins.
    if (target.username || target.password) {
      const h = new Headers(headers);
      if (!h.has("authorization")) h.set("authorization", `Basic ${Buffer.from(`${safeDecode(target.username)}:${safeDecode(target.password)}`).toString("base64")}`);
      const plain: Record<string, string> = {};
      h.forEach((v, k) => {
        plain[k] = v;
      });
      headers = plain;
      target.username = "";
      target.password = "";
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(target.toString(), { ...opts, headers, method, body, redirect: "manual", dispatcher: permitted ? undefined : guardedDispatcher() });
    } catch (e) {
      // The connect-time guard refused the address this name resolved to. That is a
      // refusal, the same as failing the literal check, not a network fault.
      if (isSsrfBlocked(e)) return null;
      throw e;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return opts.maxBytes !== undefined ? capBody(res, opts.maxBytes) : res;
    // Cancel the redirect body so the connection is not left hanging.
    await res.body?.cancel().catch(() => {});
    // "Do not follow redirects": hand the redirect back, without its body, so the caller
    // can say what happened. The Location is the caller's to report, never to follow blind.
    if (max === 0) {
      const bare = new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
      Object.defineProperty(bare, "url", { value: res.url });
      return bare;
    }
    // 301, 302 and 303 turn into a GET with no body, as the spec requires and as every
    // browser does; 307 and 308 preserve both. Replaying a POST body across a 302 would
    // send the same payload somewhere the caller never addressed.
    if (res.status !== 307 && res.status !== 308) {
      method = "GET";
      body = undefined;
    } else if (isSingleUseBody(body)) {
      // 307/308 must replay the body. A stream is genuinely single-use - the first hop has
      // already consumed it - so replaying would throw. Everything else undici re-serializes
      // per request and replays fine; an earlier version rejected all of them, which turned
      // an ordinary POST behind a 308 into something indistinguishable from an SSRF refusal.
      return null;
    }
    try {
      current = new URL(location, target).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
