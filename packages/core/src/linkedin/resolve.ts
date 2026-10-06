/**
 * Resolve LinkedIn profile URLs to people (name/title/company) and back, using public search snippets
 * and the public profile page (when LinkedIn serves it). No LinkedIn login or scraping of logged-in pages.
 */
import { loadHtml } from "../util/html.js";
import type { PersonCandidate } from "../types.js";
import { webSearch, type WebSearchOutcome } from "../search/index.js";
import { fetchText } from "../util/http.js";
import { normalizeLinkedinUrl } from "../util/domain.js";
import { parseLinkedinTitle } from "../discovery/people.js";
import { splitName } from "../util/names.js";

export async function resolveLinkedinUrl(url: string): Promise<PersonCandidate | null> {
  const li = normalizeLinkedinUrl(url);
  if (!li) return null;
  const slug = li.split("/in/")[1];
  // 1) Public profile page (LinkedIn serves a limited public view with og:title "Name - Title - Company | LinkedIn")
  // `li` is rebuilt by normalizeLinkedinUrl as https://www.linkedin.com/..., so the first
  // hop is fixed; publicOnly + hostAllow keep every redirect on LinkedIn as well.
  const html = await fetchText(li, { timeoutMs: 10_000, publicOnly: true, hostAllow: isLinkedinHost });
  if (html && !/authwall|login/i.test(html.slice(0, 2000)) && html.includes("og:title")) {
    // Through the shared guard (util/html.ts); an unreadable page is treated like no page, and the search below is tried.
    const $ = loadHtml(html);
    const og = $ ? ($('meta[property="og:title"]').attr("content") ?? $("title").text()) : "";
    const desc = $ ? ($('meta[name="description"]').attr("content") ?? "") : "";
    const parsed = $ ? parseLinkedinTitle(og, desc) : null;
    if (parsed) return { ...parsed, linkedinUrl: li, snippet: desc.slice(0, 300), source: "linkedin:public", confidence: 0.85 };
  }
  // 2) Search engines index the profile title
  const results = await webSearch(`site:linkedin.com/in/${slug}`, { count: 5, minResults: 1 }).catch(() => []);
  for (const r of results) {
    if (normalizeLinkedinUrl(r.url) !== li) continue;
    const parsed = parseLinkedinTitle(r.title, r.snippet);
    if (parsed) return { ...parsed, linkedinUrl: li, snippet: r.snippet, source: `search:${r.provider}`, confidence: 0.75 };
  }
  // 3) Fall back to slug → name guess
  const guess = slug.replace(/-[a-z0-9]{6,}$/i, "").replace(/-/g, " ").replace(/\d+/g, "").trim();
  if (guess.split(" ").length >= 2) return { ...splitName(guess.replace(/\b\w/g, (c) => c.toUpperCase())), linkedinUrl: li, source: "linkedin:slug", confidence: 0.3 };
  return null;
}

/** Find a LinkedIn URL for a person from name + company (or email). */
export async function findLinkedinUrl(input: { firstName?: string; lastName?: string; fullName?: string; companyName?: string; email?: string }): Promise<{ url: string; confidence: number } | null> {
  return (await findLinkedinUrlDetailed(input)).match;
}

/**
 * findLinkedinUrl, plus whether the searches behind a null could actually run.
 *
 * null used to mean both "no profile found" and "every search provider failed".
 */
export async function findLinkedinUrlDetailed(input: { firstName?: string; lastName?: string; fullName?: string; companyName?: string; email?: string }): Promise<{ match: { url: string; confidence: number } | null; searches: number; failedSearches: number; searchFailed: boolean }> {
  let searches = 0;
  let failedSearches = 0;
  const onOutcome = (o: WebSearchOutcome) => {
    searches++;
    if (o.everyProviderFailed) failedSearches++;
  };
  const match = await findLinkedinUrlInner(input, onOutcome);
  return { match, searches, failedSearches, searchFailed: !match && searches > 0 && failedSearches === searches };
}

async function findLinkedinUrlInner(
  input: { firstName?: string; lastName?: string; fullName?: string; companyName?: string; email?: string },
  onOutcome: (o: WebSearchOutcome) => void,
): Promise<{ url: string; confidence: number } | null> {
  const name = input.fullName ?? [input.firstName, input.lastName].filter(Boolean).join(" ");
  const domain = input.email?.split("@")[1];
  const queries = [
    name && input.companyName ? `site:linkedin.com/in "${name}" "${input.companyName}"` : null,
    name && domain ? `site:linkedin.com/in "${name}" ${domain.split(".")[0]}` : null,
    name ? `site:linkedin.com/in "${name}"` : null,
  ].filter(Boolean) as string[];
  for (const q of queries) {
    const results = await webSearch(q, { count: 10, minResults: 1, onOutcome }).catch(() => []);
    for (const r of results) {
      const li = normalizeLinkedinUrl(r.url);
      if (!li?.includes("/in/")) continue;
      const parsed = parseLinkedinTitle(r.title, r.snippet);
      if (!parsed) continue;
      const nameOk = name ? parsed.fullName.toLowerCase().includes((input.lastName ?? name.split(" ").pop() ?? "").toLowerCase()) : true;
      const compOk = input.companyName ? `${r.title} ${r.snippet}`.toLowerCase().includes(input.companyName.toLowerCase().split(" ")[0]) : true;
      if (nameOk) return { url: li, confidence: compOk ? 0.85 : 0.6 };
    }
  }
  return null;
}

/** linkedin.com itself, or one of its subdomains (www, the country sites, m). */
function isLinkedinHost(hostname: string): boolean {
  return hostname === "linkedin.com" || /^[a-z0-9-]{1,20}\.linkedin\.com$/.test(hostname);
}

/**
 * Turn what a customer pasted as "a LinkedIn post" into the URL we will fetch, or null.
 *
 * A post monitor's target is a free-text field. It used to be handed to `fetch` exactly as
 * typed, redirects followed, every tick - so a monitor "watching" http://169.254.169.254/
 * or an internal service was a scheduled request to it from inside our network. The rule
 * now: it must be a LinkedIn URL, and it is always fetched over https on the default port.
 *
 * Forgiving about how it was pasted (no scheme, http://, a country subdomain such as
 * in.linkedin.com, a trailing fragment), strict about where it points.
 */
export function normalizeLinkedinPostUrl(input: string): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // Credentials in the URL mean the host is not the part that reads like one.
  if (u.username || u.password) return null;
  if (u.port && !(u.protocol === "https:" && u.port === "443") && !(u.protocol === "http:" && u.port === "80")) return null;
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!isLinkedinHost(host)) return null;
  u.protocol = "https:";
  u.port = "";
  u.hostname = host;
  u.hash = "";
  return u.toString();
}

/**
 * Best-effort public LinkedIn post engagers (only works when LinkedIn serves the public post page).
 *
 * `refused` is set, and nothing is fetched, when `postUrl` is not a LinkedIn URL. That is a
 * different outcome from `publicPage: false` (LinkedIn answered with its login wall) and a
 * caller must not report the two the same way.
 */
export async function linkedinPostEngagers(postUrl: string): Promise<{ people: PersonCandidate[]; postText?: string; reactions?: number; comments?: number; publicPage: boolean; refused?: string }> {
  const url = normalizeLinkedinPostUrl(postUrl);
  if (!url) return { people: [], publicPage: false, refused: "This is not a LinkedIn post URL, so it was not fetched. Paste the post's link from linkedin.com (it starts with https://www.linkedin.com/)." };
  // publicOnly: every hop goes through the guarded dispatcher. hostAllow: a redirect that
  // leaves LinkedIn ends the fetch rather than being followed.
  const html = await fetchText(url, { timeoutMs: 12_000, publicOnly: true, hostAllow: isLinkedinHost });
  if (!html || /authwall/i.test(html.slice(0, 3000))) return { people: [], publicPage: false };
  const $ = loadHtml(html);
  if (!$) return { people: [], publicPage: false };
  const postText = $('meta[property="og:description"]').attr("content")?.slice(0, 500);
  const people = new Map<string, PersonCandidate>();
  $("a[href*='linkedin.com/in/']").each((_, el) => {
    const li = normalizeLinkedinUrl($(el).attr("href") ?? "");
    if (!li || people.has(li)) return;
    const name = $(el).text().replace(/\s+/g, " ").trim();
    const titleText = $(el).closest("[class*=comment], article, li").find("[class*=headline], [class*=subtitle], [class*=description]").first().text().replace(/\s+/g, " ").trim();
    if (name.length < 3 || name.length > 60) return;
    people.set(li, { ...splitName(name), title: titleText || undefined, linkedinUrl: li, source: "linkedin:post", confidence: 0.6 });
  });
  const reactions = Number(html.match(/"numLikes":(\d+)/)?.[1] ?? html.match(/(\d+)\s+reactions?/i)?.[1] ?? 0) || undefined;
  const comments = Number(html.match(/"numComments":(\d+)/)?.[1] ?? html.match(/(\d+)\s+comments?/i)?.[1] ?? 0) || undefined;
  return { people: [...people.values()], postText, reactions, comments, publicPage: true };
}
