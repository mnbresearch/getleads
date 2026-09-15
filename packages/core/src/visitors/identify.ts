/**
 * Website visitor identification (reverse IP → company), keyless.
 * Providers: ipapi.is (free 1k/day), ip-api.com (free 45/min, non-commercial), ipinfo.io (50k/mo with free token), reverse DNS.
 * Consumer ISPs are filtered so only businesses surface.
 */
import { promises as dns } from "node:dns";
import { fetchJson } from "../util/http.js";
import { extractDomain, isSocialOrAggregator, rootDomain } from "../util/domain.js";

export interface IpIdentity {
  ip: string;
  orgName?: string;
  asn?: string;
  isIsp: boolean;
  isHosting: boolean;
  country?: string;
  city?: string;
  domainHint?: string;
  provider: string;
}

const ISP_WORDS = /\b(telecom|telekom|broadband|communications|mobile|cellular|wireless|internet|isp|jio|airtel|vodafone|idea|bsnl|mtnl|act fibernet|hathway|tikona|excitel|comcast|verizon|at&t|t-mobile|sprint|charter|spectrum|cox|centurylink|frontier|bt group|virgin media|sky|vodafone|orange|telefonica|deutsche telekom|rogers|bell canada|telus|optus|telstra|reliance|tata teleservices|you broadband|gtpl|den networks|alliance broadband|wish net|dsl|fiber|fibre|cable|network services|data services)\b/i;
const HOSTING_WORDS = /\b(amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|linode|akamai|cloudflare|ovh|hetzner|oracle cloud|alibaba|tencent|vultr|contabo|rackspace|fastly|godaddy|hostinger|bluehost|netlify|vercel|fly\.io|render)\b/i;

const cache = new Map<string, { at: number; v: IpIdentity }>();
const TTL = 24 * 3600_000;

export async function identifyIp(ip: string, opts: { ipinfoToken?: string } = {}): Promise<IpIdentity> {
  const c = cache.get(ip);
  if (c && Date.now() - c.at < TTL) return c.v;
  let out: IpIdentity = { ip, isIsp: false, isHosting: false, provider: "none" };
  if (isPrivate(ip)) {
    out = { ...out, isIsp: true, provider: "private" };
    cache.set(ip, { at: Date.now(), v: out });
    return out;
  }
  // 1) ipapi.is - free tier returns flat strings; paid returns objects. Handle both.
  const a = await fetchJson<Record<string, unknown>>(`https://api.ipapi.is/?q=${ip}`, { timeoutMs: 6000 });
  if (a && (a.company || a.asn)) {
    const companyObj = typeof a.company === "object" && a.company ? (a.company as { name?: string; domain?: string; type?: string }) : null;
    const asnObj = typeof a.asn === "object" && a.asn ? (a.asn as { asn?: number; org?: string; type?: string }) : null;
    const asnStr = typeof a.asn === "string" ? a.asn : undefined;
    const name = companyObj?.name ?? (typeof a.company === "string" ? a.company : undefined) ?? asnObj?.org ?? asnStr?.replace(/^AS\d+\s+/, "");
    const type = (companyObj?.type ?? asnObj?.type ?? "").toLowerCase();
    const loc = (typeof a.location === "object" && a.location ? (a.location as { country?: string; city?: string }) : null);
    out = {
      ip,
      orgName: name,
      asn: asnObj?.asn ? `AS${asnObj.asn}` : asnStr?.match(/^AS\d+/)?.[0],
      isIsp: type === "isp" || (!!name && ISP_WORDS.test(name)),
      isHosting: !!a.is_datacenter || type === "hosting" || (!!name && HOSTING_WORDS.test(name)),
      country: loc?.country ?? (typeof a.country === "string" ? a.country : undefined),
      city: loc?.city ?? (typeof a.city === "string" ? a.city : undefined),
      domainHint: companyObj?.domain ? extractDomain(companyObj.domain) ?? undefined : undefined,
      provider: "ipapi.is",
    };
  } else if (opts.ipinfoToken) {
    const b = await fetchJson<{ org?: string; country?: string; city?: string; company?: { name?: string; domain?: string; type?: string }; privacy?: { hosting?: boolean } }>(`https://ipinfo.io/${ip}?token=${opts.ipinfoToken}`, { timeoutMs: 6000 });
    if (b) {
      const name = b.company?.name ?? b.org?.replace(/^AS\d+\s+/, "");
      out = { ip, orgName: name, asn: b.org?.match(/^AS\d+/)?.[0], isIsp: b.company?.type === "isp" || (!!name && ISP_WORDS.test(name)), isHosting: !!b.privacy?.hosting || b.company?.type === "hosting", country: b.country, city: b.city, domainHint: b.company?.domain, provider: "ipinfo" };
    }
  } else {
    const d = await fetchJson<{ status?: string; org?: string; isp?: string; as?: string; country?: string; city?: string; hosting?: boolean; mobile?: boolean }>(`http://ip-api.com/json/${ip}?fields=status,org,isp,as,country,city,hosting,mobile`, { timeoutMs: 6000 });
    if (d?.status === "success") {
      const name = d.org || d.isp;
      out = { ip, orgName: name, asn: d.as?.split(" ")[0], isIsp: !!d.mobile || (!!name && ISP_WORDS.test(name)) || (!!d.isp && d.org === d.isp && ISP_WORDS.test(d.isp)), isHosting: !!d.hosting, country: d.country, city: d.city, provider: "ip-api" };
    }
  }
  // 2) reverse DNS often reveals corporate domains
  if (!out.domainHint) {
    try {
      const names = await dns.reverse(ip);
      const host = names.find((n) => !/(dsl|cable|dyn|pool|broadband|customer|res\.|static\.|ip-|\.in-addr\.)/i.test(n));
      if (host) {
        const d = rootDomain(host.toLowerCase());
        if (!isSocialOrAggregator(d) && !HOSTING_WORDS.test(d) && !ISP_WORDS.test(d)) out.domainHint = d;
      }
    } catch {}
  }
  if (out.orgName && ISP_WORDS.test(out.orgName)) out.isIsp = true;
  cache.set(ip, { at: Date.now(), v: out });
  return out;
}

function isPrivate(ip: string) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc00:|fe80:|0\.)/.test(ip);
}

/** Guess a clean company name from an org string like "ACME TECHNOLOGIES PRIVATE LIMITED". */
export function cleanOrgName(name?: string) {
  if (!name) return undefined;
  return name
    .replace(/^AS\d+\s+/, "")
    .replace(/\b(private|pvt\.?|limited|ltd\.?|llc|inc\.?|corp\.?|corporation|gmbh|s\.?a\.?|plc|co\.?|company)\b\.?/gi, "")
    .replace(/[,.\s]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Pages that indicate buying intent get higher weight. */
export function pageIntentWeight(path: string) {
  const p = path.toLowerCase();
  if (/pricing|plans|buy|checkout|demo|contact|book|trial|signup|sign-up|quote/.test(p)) return 3;
  if (/product|features|solutions|integrations|compare|vs|case-stud|customers/.test(p)) return 2;
  if (/blog|docs|careers|about|privacy|terms/.test(p)) return 0.5;
  return 1;
}
