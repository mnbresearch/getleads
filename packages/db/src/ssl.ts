import { readFileSync } from "node:fs";
import { isIP } from "node:net";

/**
 * How a database connection is encrypted.
 *
 *   false          no TLS (loopback only, or an explicit choice)
 *   "prefer"       TLS when the server offers it, plaintext when it does not, no certificate check
 *   "require"      TLS or no connection; the certificate is not checked
 *   "verify-full"  TLS, and the certificate must chain to a trusted CA and name the host
 *   { ca, ... }    "verify-full" against a CA supplied by the operator (DATABASE_SSL_CA)
 */
export type SslDecision = false | "prefer" | "require" | "verify-full" | { ca: string; rejectUnauthorized: true };

export interface SslChoice {
  ssl: SslDecision;
  /** One of: off | prefer | require | verify-full. What the decision amounts to, for logs and tests. */
  mode: "off" | "prefer" | "require" | "verify-full";
  /** Why: which rule decided. Never contains the URL, a user name or a password. */
  reason: string;
}

/**
 * Managed Postgres hosts whose certificates chain to a public CA that Node already trusts, so
 * the certificate can be verified with no configuration. Only providers this is known to be
 * true for: Neon serves certificates issued by a public CA for every endpoint and pooler host.
 * (Supabase and Amazon RDS use their own CAs - verify those with DATABASE_SSL=verify-full plus
 * DATABASE_SSL_CA.)
 */
const PUBLIC_CA_HOST_SUFFIXES = [".neon.tech"];

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function stripBrackets(h: string): string {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** Host and the TLS-related query parameters of a connection string, without throwing. */
export function parseDbTarget(url: string): { host: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let host = "";
  try {
    const u = new URL(url);
    host = stripBrackets(decodeURIComponent(u.hostname));
    for (const [k, v] of u.searchParams) params[k.toLowerCase()] = v;
  } catch {
    // Multi-host strings ("a:5432,b:5432") and other forms URL refuses: take the first host
    // after the credentials, and the query string by hand.
    const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const afterAuth = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
    const authority = afterAuth.split(/[/?]/)[0] ?? "";
    const first = authority.split(",")[0] ?? "";
    host = first.startsWith("[") ? first.slice(1, first.indexOf("]")) : first.split(":")[0] ?? "";
    const q = url.indexOf("?");
    if (q !== -1) {
      for (const pair of url.slice(q + 1).split("&")) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          try {
            params[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] = decodeURIComponent(pair.slice(eq + 1));
          } catch {
            // an undecodable parameter is not one of ours
          }
        }
      }
    }
  }
  // `?host=` overrides the authority in libpq-style strings (and carries a socket directory).
  if (!host && params.host) host = params.host;
  return { host: host.trim().toLowerCase().replace(/\.$/, ""), params };
}

/** Loopback, a unix socket, or nothing at all (the driver then uses its local default). */
export function isLoopbackHost(host: string): boolean {
  if (!host || host.startsWith("/")) return true;
  // "<anything>.localhost" is loopback by definition (RFC 6761).
  if (LOOPBACK_NAMES.has(host) || host.endsWith(".localhost")) return true;
  const v = isIP(host);
  if (v === 4) return host.startsWith("127.");
  if (v === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1" || /^::ffff:127\./.test(host);
  return false;
}

/**
 * A host that is only reachable on a private network: a single-label name (a docker-compose
 * service such as "db", a platform's internal service name), a name under a private-network
 * suffix (".internal", ".flycast", ".local", ".lan", ...), an RFC 1918 / link-local /
 * carrier-grade NAT IPv4 address, or a unique-local / link-local IPv6 address.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map((n) => Number(n));
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (v === 6) {
    const h = host.toLowerCase();
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateNetworkHost(mapped[1]!) : false;
  }
  // Not an address: a name with no dot in it never resolves on the public internet.
  if (!host.includes(".")) return true;
  return PRIVATE_NAME_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/**
 * Names that only exist inside a private network: platform-internal DNS (Fly's
 * `<app>.internal` and `<app>.flycast`, Railway's `<service>.railway.internal`, a cloud
 * provider's `*.internal` instance names, Kubernetes' `*.svc.cluster.local`), mDNS and home or
 * office routers (`.local`, `.lan`, `.home.arpa`, ...). None of them can be reached - or
 * impersonated - from the public internet, and databases addressed this way very often have
 * no TLS at all, so they keep "TLS when the server offers it", as before.
 */
const PRIVATE_NAME_SUFFIXES = [".internal", ".flycast", ".local", ".localdomain", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".private"];

export function isPublicCaHost(host: string): boolean {
  return PUBLIC_CA_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

const warned = new Set<string>();
function warnOnce(key: string, line: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(line);
}

/**
 * The operator's own CA for certificate verification: DATABASE_SSL_CA holds the PEM text
 * (line breaks may be written as \n), or the path of a PEM file. Returns undefined when it is
 * unset or unusable (and says so once).
 */
export function readDatabaseCa(raw = process.env.DATABASE_SSL_CA): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  try {
    const pem = readFileSync(v, "utf8");
    if (pem.includes("-----BEGIN")) return pem;
    warnOnce("ca-not-pem", "[db] DATABASE_SSL_CA names a file that does not contain a PEM certificate; ignoring it.");
  } catch {
    warnOnce("ca-unreadable", "[db] DATABASE_SSL_CA is neither PEM text nor a readable file; ignoring it.");
  }
  return undefined;
}

function verified(reason: string, ca: string | undefined): SslChoice {
  return ca ? { ssl: { ca, rejectUnauthorized: true }, mode: "verify-full", reason: `${reason}, checked against the configured CA` } : { ssl: "verify-full", mode: "verify-full", reason };
}

/**
 * Decide how to encrypt the connection to `url`, and say why.
 *
 * The driver used to be handed `ssl: "prefer"` for every remote host. Two things were wrong
 * with that. "prefer" falls back to plaintext whenever the other end answers "no TLS" - and
 * anyone on the path between the API and the database can give that answer, after which the
 * driver sends the startup message, and the password if asked for it, in the clear. And an
 * option passed in code overrides the connection string, so `?sslmode=require` or
 * `?sslmode=verify-full` in DATABASE_URL was silently ignored.
 *
 * Order of precedence:
 *   1. DATABASE_SSL = disable | require | verify-full - the operator's explicit choice.
 *   2. A loopback host (localhost, 127.x, ::1, a unix socket) -> no TLS, as before.
 *   3. `sslmode` (or `ssl`) in the connection string: disable -> off; verify-ca / verify-full
 *      -> verified; require -> TLS required, and verified as well when the host is one whose
 *      certificate is known to be publicly trusted (see 4b).
 *   4. The host:
 *      a. a private-network host (single-label name, private address) -> "prefer", as before;
 *      b. a managed provider with publicly trusted certificates (*.neon.tech) -> verified;
 *      c. any other remote host -> TLS required. No silent downgrade to plaintext.
 */
export function chooseSsl(url: string, opts: { mode?: string | undefined; ca?: string | undefined } = {}): SslChoice {
  const { host, params } = parseDbTarget(url);
  const ca = "ca" in opts ? opts.ca : readDatabaseCa();
  const explicit = ("mode" in opts ? opts.mode ?? "" : process.env.DATABASE_SSL ?? "").trim().toLowerCase();

  if (explicit) {
    if (explicit === "disable") return { ssl: false, mode: "off", reason: "DATABASE_SSL=disable" };
    if (explicit === "require") return { ssl: "require", mode: "require", reason: "DATABASE_SSL=require" };
    if (explicit === "verify-full") return verified("DATABASE_SSL=verify-full", ca);
    warnOnce(`mode:${explicit}`, "[db] DATABASE_SSL is not one of disable | require | verify-full; ignoring it and deciding from the connection string.");
  }

  // Loopback before the connection string: TLS to the same machine protects nothing, and a
  // local database without TLS must keep working whatever a copied connection string says.
  if (isLoopbackHost(host)) return { ssl: false, mode: "off", reason: "loopback host" };

  const publicCa = isPublicCaHost(host);
  const urlMode = (params.sslmode ?? params.ssl ?? "").trim().toLowerCase();
  if (params.sslrootcert === "system") return verified("sslrootcert=system in the connection string", undefined);
  if (urlMode === "disable" || urlMode === "false") return { ssl: false, mode: "off", reason: "sslmode=disable in the connection string" };
  if (urlMode === "verify-ca" || urlMode === "verify-full") return verified(`sslmode=${urlMode} in the connection string`, ca);
  if (urlMode === "require" || urlMode === "true") {
    if (publicCa) return verified("sslmode=require in the connection string, on a host with publicly trusted certificates", ca);
    return { ssl: "require", mode: "require", reason: "sslmode=require in the connection string" };
  }
  // "prefer", "allow" and anything unrecognised fall through to the host rule.

  if (isPrivateNetworkHost(host)) return { ssl: "prefer", mode: "prefer", reason: "private-network host" };
  if (publicCa) return verified("host with publicly trusted certificates", ca);
  return { ssl: "require", mode: "require", reason: "remote host" };
}

/** The `ssl` option for the driver. See `chooseSsl` for the rules. */
export function sslOption(url: string, opts: { mode?: string | undefined; ca?: string | undefined } = {}): SslDecision {
  return chooseSsl(url, opts).ssl;
}

// ── When the connection fails because of TLS: say what to do ──

const CERTIFICATE_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

function errorChain(e: unknown): { code?: unknown; message?: unknown }[] {
  const out: { code?: unknown; message?: unknown }[] = [];
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; cur = (cur as { cause?: unknown }).cause, i++) out.push(cur as { code?: unknown; message?: unknown });
  return out;
}

/** Did the connection fail because the database's certificate could not be verified? */
export function isCertificateError(e: unknown): boolean {
  return errorChain(e).some(
    (x) => (typeof x.code === "string" && CERTIFICATE_ERROR_CODES.has(x.code)) || (typeof x.message === "string" && /self[- ]signed certificate|unable to verify the first certificate|certificate has expired|does not match certificate's altnames|unable to get (local )?issuer certificate/i.test(x.message)),
  );
}

/** Did the other end refuse or drop the TLS handshake itself (a server with no TLS, most often)? */
export function isTlsHandshakeFailure(e: unknown): boolean {
  return errorChain(e).some(
    (x) =>
      (typeof x.code === "string" && /^ERR_SSL_|^EPROTO$/.test(x.code)) ||
      (typeof x.message === "string" && /before secure TLS connection was established|wrong version number|ssl3?_|tlsv1 alert|packet length too long/i.test(x.message)),
  );
}

/** Where the settings below are explained. */
export const DATABASE_TLS_DOC = 'DEPLOY.md, section B10, "Database connection security"';

/**
 * One sentence for the log when a database connection failed for a TLS reason: what to set,
 * and where it is documented. Null when the failure is something else (wrong password, host
 * unreachable), so the caller prints nothing misleading. Never includes the connection string.
 */
export function databaseTlsHint(e: unknown): string | null {
  if (isCertificateError(e)) {
    return (
      "[db] The database's TLS certificate could not be verified, so no connection was made. If your provider signs its certificates with its own CA, set DATABASE_SSL_CA to that CA certificate; " +
      `to encrypt without checking the certificate, set DATABASE_SSL=require. See ${DATABASE_TLS_DOC}.`
    );
  }
  if (isTlsHandshakeFailure(e)) {
    return (
      "[db] The database did not complete a TLS handshake, so no connection was made (this server never falls back to an unencrypted connection to a remote database). " +
      `If the database is on a private network and has no TLS, set DATABASE_SSL=disable. See ${DATABASE_TLS_DOC}.`
    );
  }
  return null;
}
