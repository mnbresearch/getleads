/**
 * Is this host something we are willing to fetch on a user's behalf?
 *
 * Every crawl target in this product comes from user input: an ICP's seed domains, a
 * company domain typed into a tool, a domain resolved from a search result. Those are
 * validated as strings, not as public web addresses, so nothing stopped a crawl being
 * pointed at the machine doing the crawling.
 *
 * That was largely masked by only ever trying https, which internal services rarely speak.
 * Adding a plain-http fallback - which small-business sites genuinely need - removed the
 * mask: `169.254.169.254` is the cloud metadata endpoint and it answers on http, and the
 * page title and description a crawl harvests are written to the company record and shown
 * in the UI, so whatever comes back is readable by the person who asked for it.
 *
 * So the check belongs here rather than in the fallback: the same reasoning applies to the
 * https attempt, it was simply harder to exploit.
 *
 * This file is the LITERAL half of the guard: it judges the string we were handed. A
 * hostname that RESOLVES to a private address passes it, by design - names are judged at
 * connect time, on the address the socket is about to use, by `guardedDispatcher()` in
 * ./egress.ts (which `fetchPublic` uses on every hop). Both halves are needed: the HTTP
 * client never runs a DNS lookup for an IP literal, so the connect-time check alone would
 * let `http://127.0.0.1/` through, and this check alone lets `127.0.0.1.nip.io` through.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"]);

/* ───────────────────────────── IP address classification ───────────────────────────── */

/**
 * IPv4 ranges that are not globally routable unicast (IANA special-purpose registry).
 *
 * Exact prefixes, not "first octet" shortcuts. An earlier version refused all of
 * 192.0.0.0/16 to cover two /24s inside it; that was harmless while only typed literals
 * were judged, but resolved addresses are judged now, and 192.0.64.0/18 is where every
 * WordPress.com-hosted site lives.
 */
const V4_NON_PUBLIC: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private (RFC 1918)
  [100, 64, 0, 0, 10], // carrier-grade NAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, incl. the cloud metadata endpoint
  [172, 16, 0, 0, 12], // private (RFC 1918)
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation (TEST-NET-1)
  [192, 88, 99, 0, 24], // 6to4 relay anycast (deprecated)
  [192, 168, 0, 0, 16], // private (RFC 1918)
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation (TEST-NET-2)
  [203, 0, 113, 0, 24], // documentation (TEST-NET-3)
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, incl. 255.255.255.255 broadcast
];

/** Strict dotted quad -> 32-bit number. Anything else (octal, hex, short forms) is null. */
function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    // A leading zero is octal to inet_aton and decimal to everyone else. Refuse to guess.
    if (m[i].length > 1 && m[i][0] === "0") return null;
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function isPublicV4(n: number): boolean {
  for (const [a, b, c, d, bits] of V4_NON_PUBLIC) {
    const base = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return false;
  }
  return true;
}

/** IPv6 text -> eight 16-bit groups. Handles `::`, an embedded dotted quad, and a zone id. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  // A zone id ("fe80::1%eth0") names an interface, not a different address.
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  // Dotted-quad tail (::ffff:127.0.0.1, 64:ff9b::10.0.0.1) -> two hex groups.
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(at + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, at + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = groupsOf(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * IPv6 is public only when it is global unicast (2000::/3) and not one of the special
 * blocks inside it. Stated that way round on purpose: a deny-list of the ranges someone
 * remembered (loopback, fc00::/7, fe80::/10) is how site-local fec0::/10, multicast, the
 * discard prefix and every transition mechanism came to be "public".
 *
 * Addresses that are really an IPv4 address in IPv6 clothing are judged by that IPv4
 * address: v4-mapped (::ffff:a.b.c.d), SIIT (::ffff:0:a.b.c.d) and the NAT64 well-known
 * prefix (64:ff9b::/96 - which a DNS64 resolver synthesises for every IPv4-only site, so
 * refusing it wholesale would refuse the whole IPv4 web on an IPv6-only network).
 *
 * Deliberately NOT done with net.BlockList: Node matches an IPv4 address against a
 * v4-mapped IPv6 subnet, so listing ::ffff:0:0/96 there blocks every public IPv4 address.
 */
function isPublicV6(g: number[]): boolean {
  const embedded = g[6] * 65536 + g[7];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return isPublicV4(embedded); // ::ffff:0:0/96 v4-mapped
  if (zeroTo(4) && g[4] === 0xffff && g[5] === 0) return isPublicV4(embedded); // ::ffff:0:0:0/96 SIIT
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isPublicV4(embedded); // NAT64
  // Everything outside global unicast: ::, ::1, ::/96 v4-compatible, 64:ff9b:1::/48 local
  // NAT64, 100::/64 discard, fc00::/7 unique-local, fe80::/10 link-local, fec0::/10
  // site-local, ff00::/8 multicast, and all unallocated space.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] & 0xfe00) === 0) return false; // 2001::/23 IETF protocol assignments, incl. Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return false; // 2002::/16 6to4 (deprecated; embeds an arbitrary IPv4, private ones included)
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false; // 3fff::/20 documentation
  return true;
}

/**
 * True when `ip` is an IP address on the public internet.
 *
 * `ip` must be an address in canonical text form - a dotted quad or an IPv6 address,
 * without brackets - which is what DNS resolution and `socket.remoteAddress` produce.
 * Anything that is not an IP address at all is not a public address, and returns false.
 * Use `isPublicHost` for anything a person typed.
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string" || !ip) return false;
  const v4 = parseV4(ip);
  if (v4 !== null) return isPublicV4(v4);
  const v6 = parseV6(ip);
  if (v6 !== null) return isPublicV6(v6);
  return false;
}

/** Is this string an IP literal in canonical form (either family)? */
export function isIpLiteral(s: string): boolean {
  return typeof s === "string" && (parseV4(s) !== null || parseV6(s) !== null);
}

/* ─────────────────────────────── URL and host parsing ──────────────────────────────── */

/**
 * Parse a URL we are about to fetch on someone else's say-so.
 *
 * Only http: and https:. Anything else is refused: `file:` and `gopher:` are obvious, but
 * the subtler reason is that WHATWG only canonicalises hosts for the "special" schemes, so
 * `foo://0x7f.0.0.1/` keeps its hostname verbatim and sails past an address check.
 * Credentials in the URL are refused unless `allowUserinfo`; the fragment is dropped (it is
 * never sent, and `#@host` exists only to confuse a reader). Returns null when refused.
 */
export function parseHttpUrl(input: string, opts: { allowUserinfo?: boolean } = {}): URL | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if ((u.username || u.password) && !opts.allowUserinfo) return null;
  if (!u.hostname) return null;
  u.hash = "";
  return u;
}

/**
 * Normalise a host the way a fetch will, then judge THAT.
 *
 * Pattern-matching the raw string is not enough, and a first attempt at this file proved
 * it. WHATWG URL parsing - which is what `fetch` uses - applies inet_aton semantics and
 * strips userinfo, so all of these reach loopback or the metadata endpoint while looking
 * innocent to a dotted-quad regex:
 *
 *   0177.0.0.1            -> 127.0.0.1   (octal)
 *   0x7f.0.0.1            -> 127.0.0.1   (hex)
 *   127.1                 -> 127.0.0.1   (short form)
 *   example.com@169.254.169.254 -> 169.254.169.254  (userinfo, the host is what follows @)
 *   localhost.            -> localhost   (root label)
 *
 * So the check parses first and inspects the parsed hostname. Anything that will not parse
 * is refused rather than guessed at.
 */
export function normalizeHostname(host: string, opts: { allowUserinfo?: boolean } = {}): string | null {
  if (typeof host !== "string") return null;
  // A bare IPv6 address ("2606:4700::1111", as DNS returns it) will not parse as a URL
  // host without brackets. It is an address, so say so rather than refusing it unread.
  if (parseV6(host) !== null) return host.toLowerCase();
  try {
    // A bare host needs a scheme to parse; one that already has a scheme keeps it.
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    // Only http(s). For any other scheme the URL parser leaves the host un-canonicalised
    // (`foo://0x7f.0.0.1/` stays "0x7f.0.0.1"), so the address check below would be
    // judging a different string from the one a client would connect to.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // For a CRAWL TARGET, userinfo means the string is not what it appears to be -
    // `example.com@169.254.169.254` reads as a company domain and fetches the metadata
    // endpoint - and no legitimate company domain is written that way, so it is refused.
    //
    // For a URL the customer typed into their own settings it is different: HTTP Basic in
    // the URL is an ordinary way to secure a self-hosted webhook, and refusing it silently
    // stopped those customers receiving their leads. There the credentials are stripped and
    // the host behind them is judged on its merits.
    if ((u.username || u.password) && !opts.allowUserinfo) return null;
    // A trailing root label ("localhost.") resolves the same as without it. Brackets around
    // an IPv6 literal are URL syntax, not part of the address.
    const h = u.hostname.replace(/\.$/, "").toLowerCase();
    if (!h) return null;
    return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

/**
 * True when this host is safe to fetch on a user's behalf.
 *
 * `host` may be a bare hostname, a host:port, a bare IP address, or a full http(s) URL.
 *
 * An IP literal is judged by `isPublicAddress`. A NAME is judged only as a name here - is
 * it something that could be on the public web at all - and where it resolves is enforced
 * when the connection is made, by `guardedDispatcher()` / `assertPublicHost()` in
 * ./egress.ts. A public host that redirects to a private one is caught by the per-hop
 * check in `fetchPublic`.
 */
export function isPublicHost(host: string, opts: { allowUserinfo?: boolean } = {}): boolean {
  const hostname = normalizeHostname(host, opts);
  if (!hostname) return false;

  if (isIpLiteral(hostname)) return isPublicAddress(hostname);
  // Not an address, and yet it has a colon: not a hostname either.
  if (hostname.includes(":")) return false;

  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  // `.local`, `.internal`, `.home.arpa` and friends are not on the public web, and
  // `*.localhost` is loopback by definition (RFC 6761).
  if (/\.(local|localhost|internal|localdomain|home\.arpa|lan|intranet)$/.test(hostname)) return false;
  // A bare label with no dot ("intranet", "router") is a local name, not a public site.
  if (!hostname.includes(".")) return false;
  return true;
}
