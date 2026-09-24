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
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true;
  if (/^f[cd]/.test(h)) return true; // unique-local
  if (/^fe[89ab]/.test(h)) return true; // link-local
  // ::ffff:127.0.0.1 and friends
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

/**
 * True when this host is safe to fetch: a public name or a public address.
 *
 * `host` may carry a port; it must not carry a scheme or a path.
 */
export function isPublicHost(host: string): boolean {
  const bare = host.split("/")[0].trim().toLowerCase();
  if (!bare) return false;

  // Strip a port. A bracketed literal keeps its brackets; a BARE IPv6 address has several
  // colons and no port, and stripping ":1" off "::1" would turn loopback into something
  // this function no longer recognises - which is the one mistake that must not happen here.
  const bareIpv6 = !bare.startsWith("[") && (bare.match(/:/g) ?? []).length > 1;
  const hostname = bare.startsWith("[")
    ? bare.slice(0, bare.indexOf("]") + 1)
    : bareIpv6
      ? bare
      : bare.replace(/:\d+$/, "");
  if (!hostname) return false;

  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  // `.local`, `.internal`, `.home.arpa` and bare single-label names are not on the public web.
  if (/\.(local|internal|localdomain|home\.arpa|lan|intranet)$/.test(hostname)) return false;
  if (isPrivateV4(hostname)) return false;
  if (isPrivateV6(hostname)) return false;
  // A bare label with no dot ("intranet", "router") is a local name, not a public site.
  if (!hostname.includes(".") && !hostname.includes(":")) return false;
  return true;
}
