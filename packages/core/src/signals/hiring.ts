/**
 * Hiring signals from a company's own careers page + public job boards via search.
 * Keyless. Returns open role count by function - a strong buying-intent proxy.
 */
import * as cheerio from "cheerio";
import { fetchText } from "../util/http.js";
import { webSearch } from "../search/index.js";

const CAREER_PATHS = ["/careers", "/jobs", "/careers/", "/join-us", "/work-with-us", "/company/careers", "/about/careers", "/openings"];
const FUNCTION_RULES: [RegExp, string][] = [
  [/\b(sales|account executive|sdr|bdr|business development|revenue)\b/i, "sales"],
  [/\b(marketing|growth|demand gen|content|seo|brand)\b/i, "marketing"],
  [/\b(engineer|developer|sde|backend|frontend|full ?stack|devops|sre|data scientist|ml|ai)\b/i, "engineering"],
  [/\b(product manager|product designer|ux|ui designer)\b/i, "product"],
  [/\b(customer success|support|account manager|onboarding)\b/i, "customer_success"],
  [/\b(finance|accountant|controller|fp&a)\b/i, "finance"],
  [/\b(hr|recruiter|talent|people ops)\b/i, "hr"],
  [/\b(operations|ops|supply chain|logistics|procurement)\b/i, "operations"],
];

export interface HiringSignal {
  domain: string;
  openRoles: number;
  byFunction: Record<string, number>;
  titles: string[];
  source: "careers_page" | "search" | "none";
  careersUrl?: string;
}

const TITLE_RE = /^(senior|junior|lead|principal|head of|vp|director|manager|associate|staff|chief)?\s*[A-Za-z][A-Za-z /&+-]{3,60}$/;

export async function detectHiring(domain: string, companyName?: string): Promise<HiringSignal> {
  const titles = new Set<string>();
  let careersUrl: string | undefined;
  for (const p of CAREER_PATHS) {
    const html = await fetchText(`https://${domain}${p}`, { timeoutMs: 8000 });
    if (!html) continue;
    const $ = cheerio.load(html);
    const candidates: string[] = [];
    $("a, h2, h3, h4, li, [class*=job], [class*=position], [class*=opening], [class*=role]").each((_, el) => {
      const t = $(el).clone().children("span,small,div").remove().end().text().replace(/\s+/g, " ").trim();
      if (t.length >= 6 && t.length <= 70 && TITLE_RE.test(t) && FUNCTION_RULES.some(([re]) => re.test(t))) candidates.push(t);
    });
    if (candidates.length >= 2) {
      careersUrl = `https://${domain}${p}`;
      for (const c of candidates) titles.add(c);
      break;
    }
    // Embedded ATS (Lever/Greenhouse/Workable/Keka/Zoho Recruit) links
    const ats = html.match(/https?:\/\/(?:jobs\.lever\.co|boards\.greenhouse\.io|apply\.workable\.com|[a-z0-9-]+\.keka\.com\/careers|[a-z0-9-]+\.zohorecruit\.(?:com|in)\/jobs|wellfound\.com\/company\/[a-z0-9-]+\/jobs|jobs\.ashbyhq\.com)[^"'\s]*/i)?.[0];
    if (ats) {
      const atsHtml = await fetchText(ats, { timeoutMs: 8000 });
      if (atsHtml) {
        const $a = cheerio.load(atsHtml);
        $a("a, h3, h4, [class*=posting], [class*=opening]").each((_, el) => {
          const t = $a(el).text().replace(/\s+/g, " ").trim();
          if (t.length >= 6 && t.length <= 70 && TITLE_RE.test(t) && FUNCTION_RULES.some(([re]) => re.test(t))) titles.add(t);
        });
        if (titles.size) {
          careersUrl = ats;
          break;
        }
      }
    }
  }
  let source: HiringSignal["source"] = titles.size ? "careers_page" : "none";
  if (!titles.size && companyName) {
    const res = await webSearch(`site:linkedin.com/jobs "${companyName}"`, { count: 20, minResults: 1 }).catch(() => []);
    for (const r of res) {
      const t = r.title.replace(/\s*[-|–].*$/, "").trim();
      if (t.length >= 6 && t.length <= 70) titles.add(t);
    }
    if (titles.size) source = "search";
  }
  const byFunction: Record<string, number> = {};
  for (const t of titles) {
    const fn = FUNCTION_RULES.find(([re]) => re.test(t))?.[1] ?? "other";
    byFunction[fn] = (byFunction[fn] ?? 0) + 1;
  }
  return { domain, openRoles: titles.size, byFunction, titles: [...titles].slice(0, 50), source, careersUrl };
}
