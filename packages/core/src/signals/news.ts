/**
 * Intent signals from public news, keyless.
 * Google News RSS is free and needs no key; Bing News RSS is a fallback.
 */
import * as cheerio from "cheerio";
import { fetchText } from "../util/http.js";
import { extractDomain, isSocialOrAggregator } from "../util/domain.js";

export type SignalType = "funding" | "acquisition" | "hiring" | "leadership" | "expansion" | "launch" | "partnership" | "news";

export interface NewsItem {
  title: string;
  url: string;
  source?: string;
  publishedAt?: Date;
  summary?: string;
}

export interface ParsedSignal {
  type: SignalType;
  companyName?: string;
  title: string;
  summary?: string;
  url: string;
  source?: string;
  amountUsd?: number;
  round?: string;
  confidence: number;
  occurredAt?: Date;
}

export async function fetchGoogleNews(query: string, opts: { lang?: string; country?: string; days?: number } = {}): Promise<NewsItem[]> {
  const q = opts.days ? `${query} when:${opts.days}d` : query;
  const params = new URLSearchParams({ q, hl: opts.lang ?? "en-IN", gl: opts.country ?? "IN", ceid: `${opts.country ?? "IN"}:${opts.lang ?? "en"}` });
  const xml = await fetchText(`https://news.google.com/rss/search?${params}`, { timeoutMs: 15_000 });
  if (!xml) return fetchBingNews(query);
  return parseRss(xml);
}

export async function fetchBingNews(query: string): Promise<NewsItem[]> {
  const xml = await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`, { timeoutMs: 15_000 });
  return xml ? parseRss(xml) : [];
}

export function parseRss(xml: string): NewsItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: NewsItem[] = [];
  $("item").each((_, el) => {
    const title = $(el).find("title").first().text().trim();
    const link = $(el).find("link").first().text().trim() || $(el).find("guid").first().text().trim();
    const pub = $(el).find("pubDate").first().text().trim();
    const source = $(el).find("source").first().text().trim() || undefined;
    const desc = $(el).find("description").first().text();
    const summary = desc ? cheerio.load(desc).text().replace(/\s+/g, " ").trim().slice(0, 400) : undefined;
    if (title && link) out.push({ title: title.replace(/\s+-\s+[^-]+$/, ""), url: link, source, publishedAt: pub ? new Date(pub) : undefined, summary });
  });
  return out;
}

const MONEY = /(?:(?:US)?\$|₹|Rs\.?|INR|€|£)\s?([\d,.]+)\s*(million|mn|m|billion|bn|b|crore|cr|lakh|k)?/i;
const ROUND = /\b(pre-?seed|seed|series\s+[a-h]|angel|bridge|growth|pre-?ipo|debt|venture debt|extension|round)\b/i;

export function parseMoney(text: string): number | undefined {
  const m = text.match(MONEY);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const cur = m[0][0] === "₹" || /^(rs|inr)/i.test(m[0]) ? 0.012 : m[0][0] === "€" ? 1.08 : m[0][0] === "£" ? 1.27 : 1;
  const mult = unit.startsWith("b") ? 1e9 : unit.startsWith("m") ? 1e6 : unit === "crore" || unit === "cr" ? 1e7 : unit === "lakh" ? 1e5 : unit === "k" ? 1e3 : 1;
  return Math.round(n * mult * cur);
}

const VERBS = ["raises", "raised", "secures", "bags", "lands", "closes", "nets", "gets", "snags", "scores", "has raised", "acquires", "acquired", "to acquire", "buys", "hires", "appoints", "names", "launches", "expands", "opens", "partners", "is hiring", "announces", "unveils", "enters", "taps", "elevates", "promotes", "onboards"];
const ci = (w: string) => w.split(" ").map((x) => `(?:${x[0].toUpperCase()}|${x[0]})${x.slice(1)}`).join("\\s+");
const VERB_RE = `(?:${VERBS.map(ci).join("|")})`;
const NAME = "([A-Z][A-Za-z0-9.&'-]*(?:\\s+[A-Z][A-Za-z0-9.&'-]*){0,7})";
const RE_LEAD = new RegExp(`^${NAME}\\s+${VERB_RE}\\b`);
const RE_DESC = new RegExp(`^(?:[A-Za-z-]+\\s+){0,4}(?:startup|fintech|edtech|saas|d2c|unicorn|company|firm|brand|platform)\\s+${NAME}\\s+${VERB_RE}\\b`, "i");
const RE_MONEY = new RegExp(`${NAME}\\s+${VERB_RE}\\s+(?:\\$|₹|Rs|INR|€|£)`);

/** Extract the company name from a headline: "Acme raises $10M ..." → Acme */
export function companyFromHeadline(title: string): string | undefined {
  const t = title.replace(/^(exclusive|breaking|report|update)[:\s-]+/i, "").trim();
  const m = t.match(RE_LEAD) ?? t.match(RE_DESC) ?? t.match(RE_MONEY) ?? t.match(/^([A-Z][A-Za-z0-9.&'-]*(?:\s+[A-Z][A-Za-z0-9.&'-]*){1,2}|[A-Z]{2,}[A-Za-z0-9.&'-]*)\s+[a-z]/);
  let name = m?.[1]?.trim();
  if (!name) return undefined;
  // Drop leading descriptors: "Quick food-delivery startup Swish" → "Swish"
  const words = name.split(/\s+/);
  const idx = words.findIndex((w, i) => i > 0 && /^(startup|company|firm|platform|brand|maker|app|fintech|edtech|saas|healthtech|agritech|unicorn|major|indian|based)$/i.test(w));
  if (idx >= 0 && idx < words.length - 1) name = words.slice(idx + 1).join(" ");
  // Also drop a leading lowercase run
  name = name.replace(/^(?:[a-z][\w-]*\s+)+/, "");
  // Cut trailing preposition phrases: "Pixxel With US Federal Contracts" → "Pixxel"
  name = name.replace(/\s+(With|In|For|At|From|To|Of|On|As|After|Amid|Led|Backed|Valued|Ahead)\b.*$/, "");
  // Cut leading descriptor phrases like "Space Startup" when followed by a proper noun
  name = name.replace(/^(?:[A-Z][a-z]+\s+)*(?:Startup|Company|Firm|Platform|Brand|Maker|Unicorn)\s+(?=[A-Z])/, "");
  return name || undefined;
}

export function classifyHeadline(item: NewsItem): ParsedSignal | null {
  const text = `${item.title} ${item.summary ?? ""}`;
  const t = item.title.toLowerCase();
  let type: SignalType | null = null;
  let confidence = 0.5;
  if (/\b(raises|raised|secures|bags|closes|lands|nets|snags)\b/.test(t) && (MONEY.test(text) || /\b(funding|round|seed|series)\b/.test(t))) {
    type = "funding";
    confidence = MONEY.test(item.title) ? 0.9 : 0.7;
  } else if (/\b(acquires|acquired|acquisition|to acquire|buys|bought|merger|merges with|takes over)\b/.test(t) && !/\b(talent|customer|user|land|data) acquisition\b/.test(t)) {
    type = "acquisition";
    confidence = 0.8;
  } else if (/\b(is hiring|hiring spree|to hire|plans to hire|adds \d+ jobs|opens \d+ (positions|roles)|ramps up hiring)\b/.test(t)) {
    type = "hiring";
    confidence = 0.7;
  } else if (/\b(appoints|names|hires .* as (ceo|cto|cfo|cmo|coo|chief|head|vp|president)|new (ceo|cto|cfo|cmo|coo)|joins as)\b/.test(t)) {
    type = "leadership";
    confidence = 0.75;
  } else if (/\b(expands|expansion|opens (new )?(office|store|facility|plant)|enters .* market|launches in)\b/.test(t)) {
    type = "expansion";
    confidence = 0.65;
  } else if (/\b(launches|unveils|introduces|rolls out|debuts)\b/.test(t)) {
    type = "launch";
    confidence = 0.6;
  } else if (/\b(partners with|partnership|teams up with|collaborates with|signs (deal|agreement) with)\b/.test(t)) {
    type = "partnership";
    confidence = 0.6;
  }
  if (!type) return null;
  const round = text.match(ROUND)?.[1];
  return {
    type,
    companyName: companyFromHeadline(item.title),
    title: item.title,
    summary: item.summary,
    url: item.url,
    source: item.source,
    amountUsd: type === "funding" || type === "acquisition" ? parseMoney(text) : undefined,
    round: round ? round.replace(/\s+/g, " ") : undefined,
    confidence,
    occurredAt: item.publishedAt,
  };
}

export const SIGNAL_QUERIES: Record<SignalType, string[]> = {
  funding: ['"raises" funding startup', '"secures" "Series" funding', '"seed round" startup raises', '"bags" funding crore'],
  acquisition: ['"acquires" startup', '"acquisition" announced company', '"to acquire" firm'],
  hiring: ['"is hiring" company plans', '"hiring spree" startup', '"plans to hire" employees'],
  leadership: ['"appoints" "chief" officer', '"names" new CEO', '"joins as" CTO'],
  expansion: ['"expands" operations new office', '"enters" market launch India'],
  launch: ['"launches" new platform startup'],
  partnership: ['"partners with" announces partnership'],
  news: [],
};

/** Scan news for a set of signal types + optional keywords/industries/locations. */
export async function scanSignals(opts: { types: SignalType[]; keywords?: string[]; industries?: string[]; locations?: string[]; days?: number; country?: string; maxPerQuery?: number }): Promise<ParsedSignal[]> {
  const out: ParsedSignal[] = [];
  const seen = new Set<string>();
  const ctx = [...(opts.industries ?? []), ...(opts.locations ?? []), ...(opts.keywords ?? [])].slice(0, 4).map((k) => `"${k}"`).join(" ");
  for (const type of opts.types) {
    for (const base of SIGNAL_QUERIES[type] ?? []) {
      const items = await fetchGoogleNews(`${base} ${ctx}`.trim(), { days: opts.days ?? 7, country: opts.country });
      for (const it of items.slice(0, opts.maxPerQuery ?? 30)) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        const s = classifyHeadline(it);
        if (s && (s.type === type || opts.types.includes(s.type))) out.push(s);
      }
    }
  }
  return out;
}

/** Company-specific news (for monitors and enrichment). */
export async function companyNews(companyName: string, days = 30): Promise<ParsedSignal[]> {
  const items = await fetchGoogleNews(`"${companyName}"`, { days });
  return items.map((it) => classifyHeadline(it) ?? { type: "news" as SignalType, companyName, title: it.title, summary: it.summary, url: it.url, source: it.source, confidence: 0.4, occurredAt: it.publishedAt });
}

/** Resolve a news article's company to a domain using the article URL as last resort. */
export function domainHintFromUrl(url: string) {
  const d = extractDomain(url);
  return d && !isSocialOrAggregator(d) && !/news|times|mint|economic|techcrunch|yourstory|inc42|entrackr|moneycontrol|business|reuters|bloomberg|forbes|medium|prnewswire|businesswire|globenewswire/.test(d) ? d : null;
}
