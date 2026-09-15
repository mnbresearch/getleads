/**
 * Resolve LinkedIn profile URLs to people (name/title/company) and back, using public search snippets
 * and the public profile page (when LinkedIn serves it). No LinkedIn login or scraping of logged-in pages.
 */
import * as cheerio from "cheerio";
import type { PersonCandidate } from "../types.js";
import { webSearch } from "../search/index.js";
import { fetchText } from "../util/http.js";
import { normalizeLinkedinUrl } from "../util/domain.js";
import { parseLinkedinTitle } from "../discovery/people.js";
import { splitName } from "../util/names.js";

export async function resolveLinkedinUrl(url: string): Promise<PersonCandidate | null> {
  const li = normalizeLinkedinUrl(url);
  if (!li) return null;
  const slug = li.split("/in/")[1];
  // 1) Public profile page (LinkedIn serves a limited public view with og:title "Name - Title - Company | LinkedIn")
  const html = await fetchText(li, { timeoutMs: 10_000 });
  if (html && !/authwall|login/i.test(html.slice(0, 2000)) && html.includes("og:title")) {
    const $ = cheerio.load(html);
    const og = $('meta[property="og:title"]').attr("content") ?? $("title").text();
    const desc = $('meta[name="description"]').attr("content") ?? "";
    const parsed = parseLinkedinTitle(og, desc);
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
  const name = input.fullName ?? [input.firstName, input.lastName].filter(Boolean).join(" ");
  const domain = input.email?.split("@")[1];
  const queries = [
    name && input.companyName ? `site:linkedin.com/in "${name}" "${input.companyName}"` : null,
    name && domain ? `site:linkedin.com/in "${name}" ${domain.split(".")[0]}` : null,
    name ? `site:linkedin.com/in "${name}"` : null,
  ].filter(Boolean) as string[];
  for (const q of queries) {
    const results = await webSearch(q, { count: 10, minResults: 1 }).catch(() => []);
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

/** Best-effort public LinkedIn post engagers (only works when LinkedIn serves the public post page). */
export async function linkedinPostEngagers(postUrl: string): Promise<{ people: PersonCandidate[]; postText?: string; reactions?: number; comments?: number; publicPage: boolean }> {
  const html = await fetchText(postUrl, { timeoutMs: 12_000 });
  if (!html || /authwall/i.test(html.slice(0, 3000))) return { people: [], publicPage: false };
  const $ = cheerio.load(html);
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
