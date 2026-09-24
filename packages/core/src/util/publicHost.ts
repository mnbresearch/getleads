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
 * This is a literal check, not a DNS one. A hostname that RESOLVES to a private address
 * still gets through, which would need resolution before connect to stop properly; it
 * closes the direct cases - loopback, link-local, RFC 1918, unique-local v6 - and leaves a
 * note rather than pretending to be complete.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"]);

/** Reserved IPv4 ranges that must never be fetched on a user's behalf. */
function isPrivateV4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[2]), Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed: refuse
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments / test
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(host: string): boolean {
  // A zone id ("fe80::1%eth0") is not part of the address for this purpose.
  const h = host.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true;
  if (/^f[cd]/.test(h)) return true; // unique-local
  if (/^fe[89ab]/.test(h)) return true; // link-local
  // IPv4-mapped, in both spellings: ::ffff:127.0.0.1 and ::ffff:7f00:1. Only the dotted
  // one was handled at first, so the hex form walked straight through to loopback.
  const dotted = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateV4(dotted[1]);
  // Both the mapped (::ffff:a:b) and the deprecated compatible (::a:b) forms. URL
  // canonicalisation turns [::127.0.0.1] into [::7f00:1], which matched neither branch.
  const hex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPrivateV4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return false;
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
function normalizeHostname(host: string, opts: { allowUserinfo?: boolean } = {}): string | null {
  try {
    // A bare host needs a scheme to parse; one that already has a scheme keeps it.
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    // For a CRAWL TARGET, userinfo means the string is not what it appears to be -
    // `example.com@169.254.169.254` reads as a company domain and fetches the metadata
    // endpoint - and no legitimate company domain is written that way, so it is refused.
    //
    // For a URL the customer typed into their own settings it is different: HTTP Basic in
    // the URL is an ordinary way to secure a self-hosted webhook, and refusing it silently
    // stopped those customers receiving their leads. There the credentials are stripped and
    // the host behind them is judged on its merits.
    if ((u.username || u.password) && !opts.allowUserinfo) return null;
    // A trailing root label ("localhost.") resolves the same as without it.
    return u.hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when this host is safe to fetch on a user's behalf.
 *
 * `host` may be a bare hostname, a host:port, or a full URL.
 *
 * This is a check on the ADDRESS, not on where a name resolves. A hostname whose DNS
 * record points at a private address still passes, and a public host that redirects to a
 * private one is caught separately, by the per-hop check in `fetchPublic`.
 */
export function isPublicHost(host: string, opts: { allowUserinfo?: boolean } = {}): boolean {
  const hostname = normalizeHostname(host, opts);
  if (!hostname) return false;

  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  // `.local`, `.internal`, `.home.arpa` and friends are not on the public web.
  if (/\.(local|internal|localdomain|home\.arpa|lan|intranet)$/.test(hostname)) return false;
  if (isPrivateV4(hostname)) return false;
  if (isPrivateV6(hostname)) return false;
  // A bare label with no dot ("intranet", "router") is a local name, not a public site.
  if (!hostname.includes(".") && !hostname.includes(":")) return false;
  return true;
}
