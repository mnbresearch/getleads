/**
 * The only way a stored or third-party URL becomes an `href`.
 *
 * React escapes text, but it does not judge a URL: `<a href={lead.linkedinUrl}>` with a
 * stored value of `javascript:...` is a working script link, and the value can arrive from a
 * CSV import, an API client, a crawled page or a news feed - none of which this app controls.
 * So a link is rendered only when the value parses as http: or https:. Anything else
 * (javascript:, data:, vbscript:, file:, a bare identity string like "job:123") comes back
 * undefined and the caller shows plain text instead.
 *
 * A value with no scheme that is plainly a host ("www.linkedin.com/in/x", "acme.com") is
 * given https:// - before this helper those rendered as relative links into this app, which
 * went nowhere. The result is still parsed and still has to be http(s).
 */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const s = url.trim();
  if (!s || s.length > 4096) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(s) ? `https://${s}` : null;
  if (!candidate) return undefined;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!u.hostname) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** `rel` for every link that leaves the app: no window.opener, no Referer. */
export const EXTERNAL_REL = "noopener noreferrer";
