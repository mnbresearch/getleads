/**
 * Guarded egress: the CONNECT-TIME half of the SSRF guard.
 *
 * `isPublicHost` (./publicHost.ts) judges the string we were handed. That is not enough on
 * its own, and the gap was exploitable: `127.0.0.1.nip.io` is a perfectly public-looking
 * name that resolves to loopback, so a crawl of it fetched an internal service and stored
 * the response in the company profile for the tenant to read. A pre-flight DNS lookup does
 * not close it either - the name can answer "public" to the check and "private" to the
 * connection a moment later (DNS rebinding).
 *
 * So the decision is made on the address the socket actually connects to:
 *
 *   1. IP literal  -> classified in the connector (net.connect never calls `lookup` for a
 *                     literal, so a lookup hook alone would let `http://127.0.0.1/` through).
 *   2. hostname    -> resolved ONCE, by `guardedLookup`, inside the connect call. Every
 *                     address returned must be public or the connection is refused, and
 *                     the socket connects to exactly the addresses that were vetted. There
 *                     is no second resolution for a rebinding answer to slip into.
 *   3. connected   -> `socket.remoteAddress` is classified again before the socket is
 *                     handed to the HTTP client, so nothing is written to a private peer
 *                     even if 1 and 2 were somehow bypassed.
 *
 * Because this lives in the dispatcher, it applies to every connection that dispatcher
 * opens: first hop, redirect hops, retries.
 *
 * Provider API calls to constant hosts (Serper, Hunter, HubSpot ...) do NOT use this and do
 * not need to. It is for destinations chosen by a tenant, a user, or third-party content.
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector } from "undici";
import { isIpLiteral, isPublicAddress, isPublicHost, normalizeHostname } from "./publicHost.js";

/** Thrown (or passed to a callback) when a destination is refused for not being public. */
export class SsrfBlockedError extends Error {
  readonly code = "ESSRFBLOCKED" as const;
  /** The host that was asked for. */
  readonly host: string;
  /** The non-public address it is, or resolved to. Absent when the NAME itself was refused. */
  readonly address?: string;
  constructor(host: string, address?: string) {
    super(address && address !== host ? `${host} resolves to a non-public address (${address}), so it was not contacted` : `${host} is not a public address, so it was not contacted`);
    this.name = "SsrfBlockedError";
    this.host = host;
    this.address = address;
  }
}

/**
 * Was this failure the guard refusing a destination?
 *
 * `fetch` wraps the connector's error ("TypeError: fetch failed", with the real error as
 * `cause`), so the code has to be looked for down the cause chain.
 */
export function isSsrfBlocked(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e && typeof e === "object"; depth++) {
    if ((e as { code?: unknown }).code === "ESSRFBLOCKED") return true;
    // An AggregateError from a multi-address connect attempt carries the refusals inside.
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.some((x) => x && typeof x === "object" && (x as { code?: unknown }).code === "ESSRFBLOCKED")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Every address the system resolver returns for a name.
 *
 * Called through the `dns` module object, not a destructured import, so a test can stub
 * `dns.lookup` and decide what a name resolves to.
 */
function lookupAll(hostname: string, options: { family?: number | string; hints?: number } = {}): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    const opts: dns.LookupAllOptions = { all: true };
    if (options.family !== undefined && options.family !== null) opts.family = options.family as dns.LookupAllOptions["family"];
    if (options.hints !== undefined && options.hints !== null) opts.hints = options.hints;
    dns.lookup(hostname, opts, (err, addresses) => {
      if (err) return reject(err);
      const list = (Array.isArray(addresses) ? addresses : []).map((a) => ({ address: a.address, family: (a.family === 6 ? 6 : 4) as 4 | 6 }));
      if (!list.length) return reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }));
      resolve(list);
    });
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | ResolvedAddress[], family?: number) => void;

/**
 * A drop-in for the `lookup` option of net.connect / tls.connect.
 *
 * Resolves every address for the name and refuses if ANY of them is not public. "Any", not
 * "the one we would have used": a name that answers with one public and one private
 * address is not an honest public site, and picking the good one would let the client's
 * own fallback (Happy Eyeballs, retry on the next address) reach the bad one.
 */
export function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const o = (typeof options === "object" && options ? options : {}) as { family?: number | string; hints?: number; all?: boolean };
  lookupAll(hostname, { family: o.family, hints: o.hints }).then(
    (list) => {
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (bad) return cb(new SsrfBlockedError(hostname, bad.address));
      if (o.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    },
    (err) => cb(err as NodeJS.ErrnoException),
  );
}

/**
 * Check that a host is public, by name AND by every address it resolves to, and return an
 * address to connect to.
 *
 * For clients that are not HTTP and so cannot use `guardedDispatcher()` - SMTP above all.
 * The caller must then connect to the RETURNED ADDRESS, not to the name: resolving again
 * at connect time is exactly the second lookup that DNS rebinding exploits. Keep the name
 * for TLS (`servername`) so the certificate is still checked against it.
 *
 * `host` is a hostname or IP (a host:port or URL is accepted and reduced to its host).
 * IPv4 is preferred when a name has both, matching what mail clients do and what works on
 * hosts with no IPv6 route.
 *
 * Throws `SsrfBlockedError` (code "ESSRFBLOCKED") when the host is not public. A name that
 * does not resolve throws the resolver's own error (code "ENOTFOUND" and friends), so a
 * caller can tell "not allowed" from "no such host".
 */
export async function assertPublicHost(host: string): Promise<ResolvedAddress & { addresses: ResolvedAddress[] }> {
  const hostname = normalizeHostname(host);
  if (!hostname || !isPublicHost(hostname)) throw new SsrfBlockedError(String(host).slice(0, 255));
  if (isIpLiteral(hostname)) {
    const one: ResolvedAddress = { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
    return { ...one, addresses: [one] };
  }
  const addresses = await lookupAll(hostname);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw new SsrfBlockedError(hostname, bad.address);
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { ...chosen, addresses };
}

let agent: Agent | null = null;

/**
 * The dispatcher every tenant/user/third-party-derived HTTP request must go out through.
 *
 * Pass it as `dispatcher` to the global `fetch` (which is what `fetchPublic` does - global
 * fetch, so tests can still stub it). A refused destination makes fetch reject with
 * "fetch failed" whose `cause` is an `SsrfBlockedError`; test with `isSsrfBlocked(err)`.
 *
 * One shared instance: it pools connections per origin, and a pooled socket stays vetted
 * for as long as it is open.
 */
export function guardedDispatcher(): Agent {
  if (agent) return agent;
  const connect = buildConnector({ lookup: guardedLookup as never, timeout: 10_000 });
  agent = new Agent({
    connect(opts, callback) {
      // undici hands the host without brackets, but be exact about it rather than trust that.
      const host = String(opts.hostname ?? "").replace(/^\[|\]$/g, "");
      // 1. A literal never reaches `lookup`, so it is judged here.
      if (isIpLiteral(host) && !isPublicAddress(host)) return callback(new SsrfBlockedError(host), null);
      // 2. A name is resolved and vetted by guardedLookup, inside this connect call.
      connect(opts, (err, socket) => {
        if (err || !socket) return callback(err ?? new Error("connect failed"), null);
        // 3. The peer we are actually connected to.
        const peer = socket.remoteAddress;
        if (!peer || !isPublicAddress(peer)) {
          socket.destroy();
          return callback(new SsrfBlockedError(host, peer), null);
        }
        callback(null, socket);
      });
    },
  });
  return agent;
}
