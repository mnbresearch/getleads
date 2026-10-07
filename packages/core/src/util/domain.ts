const SOCIAL_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
  "github.com",
  "medium.com",
  "crunchbase.com",
  "wikipedia.org",
  "glassdoor.com",
  "indeed.com",
  "zoominfo.com",
  "apollo.io",
  "rocketreach.co",
  "signalhire.com",
  "g2.com",
  "capterra.com",
  "producthunt.com",
  "angel.co",
  "wellfound.com",
  "tracxn.com",
  "pitchbook.com",
  "bloomberg.com",
  "reuters.com",
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "amazon.com",
  "yelp.com",
  "reddit.com",
  "quora.com",
];

export function extractDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  // The host stands at the start of an address: what follows the first two thousand characters cannot change it.
  if (input.length > 2_100) input = input.slice(0, 2_100);
  try {
    const u = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    if (!host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

export function isSocialOrAggregator(domain: string) {
  return SOCIAL_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`));
}

export function rootDomain(domain: string) {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  // handle co.uk / com.au / co.in style
  const second = parts[parts.length - 2];
  if (["co", "com", "org", "net", "gov", "ac", "edu"].includes(second) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export function normalizeLinkedinUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  // A profile's name in an address is short; one of thousands of characters is not a profile.
  const m = url.slice(0, 2_000).match(/linkedin\.com\/(in|company)\/([A-Za-z0-9\-_%.]{1,200})/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[2]);
  } catch {
    // "%zz" and the like: not an address anyone can open. (This used to throw, out of whatever was reading a list of results.)
    return null;
  }
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${slug.replace(/\/+$/, "").toLowerCase()}`;
}
