/**
 * Play: companies that announced funding recently.
 *
 * Wraps the news scanner. One finding per company: the same round reported by several
 * outlets is one event, so reports of one company within fourteen days collapse into the
 * best of them. The reason states an amount or a round only when the headline itself does.
 */
import { fetchGoogleNews, scanSignals, type ParsedSignal } from "../signals/news.js";
import { PlayRun, cleanCompanyName, cleanList, clampInt, findingLimit, finishFinding, isVendorName, rankFindings, safeHttpUrl, stripDescriptorPrefix } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, cleanQuote, normCompanyName } from "./util.js";

const SAME_ROUND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CODE = "USD|CAD|AUD|SGD|NZD|HKD|EUR|GBP|INR|CHF|SEK|NOK|DKK|JPY|AED";
const MONEY = new RegExp(
  `(?:(${CODE})\\s?)?(US\\$|CA\\$|AU\\$|A\\$|C\\$|S\\$|\\$|\\u20B9|Rs\\.?\\s?|\\u20AC|\\u00A3)?\\s?(\\d{1,4}(?:,\\d{3})*(?:\\.\\d+)?)[\\s-]?(billion|bn|b|million|mn|mm|m|crore|cr|lakh|k|thousand)?(?![\\p{L}\\p{N}])(?:\\s?(${CODE})(?![\\p{L}\\p{N}]))?`,
  "giu",
);

/** Roughly what one unit of a currency is in US dollars: only used to compare an amount with a minimum, never shown. */
const RATE: Record<string, number> = { USD: 1, CAD: 0.73, AUD: 0.66, SGD: 0.75, NZD: 0.6, HKD: 0.13, EUR: 1.08, GBP: 1.27, INR: 0.012, CHF: 1.1, SEK: 0.095, NOK: 0.093, DKK: 0.145, JPY: 0.0067, AED: 0.27 };

/** Dashes that look like a hyphen but are other characters ("pre\u2011seed"): read as a hyphen. */
const plainHyphens = (s: string): string => s.replace(/[\u2010\u2011\u2012\u2013]/g, "-");

const SAID_BEFORE = /(?:valued at|valuation of|valuing\s+\S+(?:\s+\S+)?\s+at|worth)\s*(?:about|around|nearly|over|more than|up to|roughly|approximately|~)?\s*$/i;
const SAID_AFTER = /^\s*\+?\s*(?:post-?money\s+|pre-?money\s+)?valuation\b/i;

function compact(v: number): string {
  const fmt = (x: number, suffix: string): string => {
    const r = Math.round(x * 10) / 10;
    return `${Number.isInteger(r) ? r : r.toFixed(1)}${suffix}`;
  };
  if (v >= 1e9) return fmt(v / 1e9, "B");
  if (v >= 1e6) return fmt(v / 1e6, "M");
  if (v >= 1e3) return fmt(v / 1e3, "K");
  return String(Math.round(v));
}

/**
 * The amount a headline says was raised: roughly in US dollars (for comparing with a
 * minimum), whether the headline wrote it in US dollars, and how to show it.
 *
 * Stricter than the scanner's own reading. The unit must end at a word boundary ("$5 more"
 * is five dollars, not five million). Only the headline is read, never the summary, which
 * lists other companies' rounds. A figure the headline gives as a valuation ("at a $500M
 * valuation", "valued at $2B") is not what was raised and is passed over. And an amount in
 * another currency is shown in that currency ("CAD 17M", "EUR 2.5M", "INR 7 crore"), never
 * as dollars.
 */
export function headlineAmount(headline: string): { usd: number; inDollars: boolean; shown: string } | null {
  const text = plainHyphens(headline);
  for (const m of text.matchAll(MONEY)) {
    const symbol = (m[2] ?? "").trim().toLowerCase();
    const code = (m[1] ?? m[5] ?? "").toUpperCase();
    // A number with neither a currency sign nor a currency code is not money.
    if (!symbol && !code) continue;
    const at = m.index ?? 0;
    if (SAID_BEFORE.test(text.slice(Math.max(0, at - 40), at)) || SAID_AFTER.test(text.slice(at + m[0].length, at + m[0].length + 30))) continue;
    const n = parseFloat(m[3].replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    const currency =
      code ||
      (symbol === "\u20B9" || symbol.startsWith("rs") ? "INR" : symbol === "\u20AC" ? "EUR" : symbol === "\u00A3" ? "GBP" : symbol === "a$" || symbol === "au$" ? "AUD" : symbol === "c$" || symbol === "ca$" ? "CAD" : symbol === "s$" ? "SGD" : "USD");
    const unit = (m[4] ?? "").toLowerCase();
    const mult = unit === "billion" || unit === "bn" || unit === "b" ? 1e9 : unit === "million" || unit === "mn" || unit === "mm" || unit === "m" ? 1e6 : unit === "crore" || unit === "cr" ? 1e7 : unit === "lakh" ? 1e5 : unit === "k" || unit === "thousand" ? 1e3 : 1;
    const usd = Math.round(n * mult * (RATE[currency] ?? 1));
    // A bare "$12" in a funding headline is a typo or a share price, not a round.
    if (usd < 10_000) continue;
    const indian = unit === "crore" || unit === "cr" || unit === "lakh";
    const amount = indian ? `${m[3]} ${unit === "lakh" ? "lakh" : "crore"}` : compact(n * mult);
    return { usd, inDollars: currency === "USD", shown: currency === "USD" ? `$${amount}` : `${currency} ${amount}` };
  }
  return null;
}

/** "$12M", "$1.5B", "$500K". */
export function formatUsd(usd: number): string {
  return `$${compact(usd)}`;
}

/** A named round in the headline: "Series A", "seed", "pre-seed". Vague words ("round", "growth") are not a round. */
export function headlineRound(headline: string): string | null {
  const m = /\b(pre-?seed|seed|pre-?series\s+[a-k]|series\s+[a-k]\d?|angel)\b/i.exec(plainHyphens(headline));
  if (!m) return null;
  const r = m[1].toLowerCase().replace(/\s+/g, " ");
  if (r.startsWith("series")) return `Series ${r.split(" ")[1].toUpperCase()}`;
  if (r.startsWith("pre") && r.includes("series")) return `pre-Series ${r.split(" ")[1].toUpperCase()}`;
  if (r === "preseed" || r === "pre-seed") return "pre-seed";
  return r;
}

/** A fund raising a fund is not a company raising a round. ("Raises $10M to fund expansion" is.) */
const FUND_RAISE =
  /\b(?:fund|funds)\s+(?:[ivx]+|\d+)\b|\b(?:new|debut|maiden|first|second|third|fourth|fifth|latest|flagship|venture|climate|opportunity|early-stage|(?:million|billion|mn|bn|crore|[\d.]+[mb]))\s+fund\b|\bfund\s+(?:targeting|aimed|focused|dedicated)\b|\b(?:vc|venture capital|private equity)\s+(?:firm|fund|investor)\b/i;

/** An investor changing what it invests ("raises seed cap to $5M", "backs 18 new startups") is not a company raising money. */
const INVESTOR_NEWS = /\b(?:raises?|raised|raising|lifts?|lifted|increases?|increased|doubles?|doubled|hikes?|hiked)\b[^.]{0,40}\b(?:cap|ceiling|limit|che(?:que|ck)\s+size|ticket\s+size)\b\s+to\b|\bbacks?\s+\d+\s+(?:new\s+|more\s+)?(?:startups|companies|founders|ventures)\b/i;

/** "Raises concerns", "lands a $10M contract": the scanner's verbs, but not a funding round. */
const NOT_FUNDING =
  /\b(?:raises?|raised|raising)\s+(?:concerns?|questions?|alarms?|doubts?|eyebrows|awareness|prices?|rates?|stakes?|the bar|forecasts?|outlook|guidance|targets?|fears?|hopes?|issues?|(?:red )?flags?|objections?|minimum|wages?|pay|salaries|dividends?|fees|tariffs?)\b|\b(?:contracts?|settlement|fines?|fined|penalt(?:y|ies)|lawsuit|verdict|tender|purchase order|orders? (?:worth|from|for)|buyback|dividend|share price|price target)\b/i;
/** Business won, not money raised: "bags record order", "lands two projects", "wins licence". */
const BUSINESS_WON = /\b(?:bags?|bagged|lands?|landed|wins?|won|secures?|secured|receives?|received|gets?|got|clinch(?:es|ed)?|awarded)\b(?:[^.;]|\.\d){0,70}\b(?:orders?|order book|contracts?|projects?|licen[cs]es?|mandates?|tenders?|letters? of (?:award|intent)|loa)\b/i;
const FUNDING_WORD = /\b(?:funding|fundraise|investment|financing|round|pre-?seed|seed|series\s+[a-k]|raises?|raised)\b/i;
/** With no amount and no round in the headline, it must at least say it is about funding. */
const SAYS_FUNDING = /\b(?:raises?|raised|secures?|secured|bags|bagged|closes|closed|lands|landed|nets|netted|snags|gets|receives?|received)\b[^.]{0,60}\b(?:funding|investment|financing|capital|round)\b/i;

/** Is this headline a company announcing money raised? */
export function isFundingHeadline(title: string): boolean {
  const t = plainHyphens(title);
  if (FUND_RAISE.test(t) || NOT_FUNDING.test(t) || INVESTOR_NEWS.test(t)) return false;
  if (BUSINESS_WON.test(t) && !FUNDING_WORD.test(t)) return false;
  return !!headlineAmount(t) || !!headlineRound(t) || SAYS_FUNDING.test(t);
}

/** Outlets that news feeds name by their web address. Any other address is left out rather than shown raw. */
const PUBLISHERS: Record<string, string> = {
  dealroom: "Dealroom",
  siliconangle: "SiliconANGLE",
  endpoints: "Endpoints News",
  satnews: "SatNews",
  bloomberg: "Bloomberg",
  yourstory: "YourStory",
  economictimes: "The Economic Times",
  techcrunch: "TechCrunch",
  reuters: "Reuters",
  wsj: "WSJ",
  ft: "Financial Times",
  forbes: "Forbes",
  fortune: "Fortune",
  cnbc: "CNBC",
  businesswire: "Business Wire",
  prnewswire: "PR Newswire",
  globenewswire: "GlobeNewswire",
  venturebeat: "VentureBeat",
  theinformation: "The Information",
  axios: "Axios",
  crunchbase: "Crunchbase News",
  inc42: "Inc42",
  entrackr: "Entrackr",
  techinasia: "Tech in Asia",
  geekwire: "GeekWire",
  betakit: "BetaKit",
  sifted: "Sifted",
  finsmes: "FinSMEs",
  pymnts: "PYMNTS",
  fiercebiotech: "Fierce Biotech",
  businessinsider: "Business Insider",
  theverge: "The Verge",
  wired: "Wired",
  nytimes: "The New York Times",
  theglobeandmail: "The Globe and Mail",
  livemint: "Mint",
  moneycontrol: "Moneycontrol",
  vccircle: "VCCircle",
  bwdisrupt: "BW Disrupt",
  thenextweb: "The Next Web",
  siliconrepublic: "Silicon Republic",
  spacenews: "SpaceNews",
  medcitynews: "MedCity News",
  statnews: "STAT",
  agfundernews: "AgFunderNews",
  finextra: "Finextra",
  marketwatch: "MarketWatch",
  seekingalpha: "Seeking Alpha",
  benzinga: "Benzinga",
  citybiz: "citybiz",
};

/** The outlet's name as a reader knows it, or "" when all the feed gave is a web address we cannot put a name to. */
export function publisherName(source: unknown): string {
  const s = cleanLine(source, 80);
  if (!s) return "";
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(s)) return cleanLine(s, 60);
  const labels = s.toLowerCase().split(".");
  for (const l of labels) if (PUBLISHERS[l]) return PUBLISHERS[l];
  return "";
}

export function fundingReason(s: { title: string; source?: string; occurredAt?: Date }): string {
  const amount = headlineAmount(s.title);
  const round = headlineRound(s.title);
  let what: string;
  if (amount && round) what = `Raised ${amount.shown} ${round}`;
  else if (amount) what = `Raised ${amount.shown}`;
  else if (round) what = `Raised ${/^[aeiou]/i.test(round) ? "an" : "a"} ${round} round`;
  else what = "Announced new funding";
  const source = publisherName(s.source);
  const d = s.occurredAt instanceof Date && Number.isFinite(s.occurredAt.getTime()) ? s.occurredAt : null;
  const on = d ? ` on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
  return source ? `${what}, reported by ${source}${on}.` : d ? `${what}, reported${on}.` : `${what}.`;
}

export async function findFundedCompanies(cfg: { keywords?: string[]; industries?: string[]; locations?: string[]; days?: number; minAmountUsd?: number }, opts: PlayEngineOptions = {}): Promise<PlayEngineResult> {
  const run = new PlayRun(opts);
  const limit = findingLimit(opts);
  const days = clampInt(cfg?.days, 14, 1, 60);
  const minAmount = typeof cfg?.minAmountUsd === "number" && Number.isFinite(cfg.minAmountUsd) && cfg.minAmountUsd > 0 ? cfg.minAmountUsd : 0;
  // A country given by the caller is used as given; with none, this engine reads US news.
  const country = /^[A-Za-z]{2}$/.test(String(opts.country ?? "")) ? String(opts.country).toUpperCase() : "US";

  if (run.expired) return { findings: [], trace: run.finish(false, "The run had no time left, so funding news was not checked.") };

  let signals: ParsedSignal[] = [];
  let scanFailed = false;
  try {
    const scanned = await run.within(scanSignals({ types: ["funding"], keywords: cleanList(cfg?.keywords, 10, 60), industries: cleanList(cfg?.industries, 10, 60), locations: cleanList(cfg?.locations, 10, 60), days, country }));
    if (scanned) signals = scanned;
    else scanFailed = true;
  } catch {
    scanFailed = true;
  }
  run.trace.searches++;
  let answered = signals.length > 0;
  if (!answered) {
    // Nothing came back. One plain question tells "nothing matched" from "the news source did not answer".
    const probe = scanFailed || run.expired ? [] : ((await run.within(fetchGoogleNews("funding round", { days: 7, country }).catch(() => []))) ?? []);
    answered = probe.length > 0;
    if (!answered) run.trace.failedSearches++;
  }

  const cutoff = Date.now() - (days + 1) * 24 * 60 * 60 * 1000;
  type Kept = { s: ParsedSignal; name: string; at: number | null; amount: number | null };
  const kept: Kept[] = [];
  let belowMinimum = 0;
  for (const s of signals) {
    if (s.type !== "funding" || typeof s.title !== "string") continue;
    const title = cleanLine(s.title, 300);
    const given = cleanCompanyName(s.companyName, 6);
    // "Nine-person Halluminate", "Space Insurer Charter Space": the headline's description is not part of the name.
    const stripped = given ? stripDescriptorPrefix(given) : null;
    const name = stripped ? cleanCompanyName(stripped, 5) : null;
    if (!title || !name || isVendorName(name)) continue;
    if (!isFundingHeadline(title)) continue;
    // The company must be named in the headline that is quoted as evidence.
    if (!title.toLowerCase().includes(name.toLowerCase())) continue;
    if (!safeHttpUrl(s.url)) continue;
    const at = s.occurredAt instanceof Date && Number.isFinite(s.occurredAt.getTime()) ? s.occurredAt.getTime() : null;
    if (at !== null && (at < cutoff || at > Date.now() + 24 * 60 * 60 * 1000)) continue;
    const amount = headlineAmount(title)?.usd ?? null;
    if (minAmount > 0 && (amount === null || amount < minAmount)) {
      belowMinimum++;
      continue;
    }
    kept.push({ s: { ...s, title }, name, at, amount });
  }

  /* One finding per company and round: several outlets reporting it within fourteen days are one event. */
  const groups = new Map<string, Kept[]>();
  for (const k of kept) {
    const key = normCompanyName(k.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  const findings: PlayFinding[] = [];
  let merged = 0;
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const clusters: Kept[][] = [];
    for (const k of sorted) {
      const home = clusters.find((c) => c.some((o) => k.at === null || o.at === null || Math.abs(o.at - k.at) <= SAME_ROUND_WINDOW_MS));
      if (home) home.push(k);
      else clusters.push([k]);
    }
    // The newest round is the one that matters this week.
    const cluster = clusters[0];
    merged += cluster.length - 1;
    // The most confident report; between equals the one that says most (amount, round), then the first to report it.
    const says = (k: Kept): number => Number(k.amount !== null) + Number(headlineRound(k.s.title) !== null);
    const best = cluster.slice().sort((a, b) => (b.s.confidence ?? 0) - (a.s.confidence ?? 0) || says(b) - says(a) || (a.at ?? Infinity) - (b.at ?? Infinity))[0];
    const f = finishFinding({
      kind: "company",
      companyName: best.name,
      relevantBecause: fundingReason({ title: best.s.title, source: best.s.source, occurredAt: best.at !== null ? new Date(best.at) : undefined }),
      evidenceUrl: best.s.url,
      evidenceTitle: best.s.title,
      evidenceQuote: cleanQuote(best.s.title, 500),
      signalType: "funding",
      ...(best.at !== null ? { signalAt: new Date(best.at) } : {}),
      confidence: Math.min(0.9, Math.max(0.3, best.s.confidence ?? 0.5)),
    });
    if (f) findings.push(f);
  }
  if (merged > 0) run.note(`${merged} repeat report${merged === 1 ? "" : "s"} of the same funding round ${merged === 1 ? "was" : "were"} merged.`);
  if (belowMinimum > 0) run.note(`${belowMinimum} announcement${belowMinimum === 1 ? "" : "s"} left out: the headline did not state an amount at or above your minimum.`);
  if (answered && !findings.length) run.note(`No funding announcements matched in the last ${days} days.`);

  const trace = run.finish(answered, "The news source did not answer, so funding announcements could not be checked. This is not a result about your market - try again later.");
  return { findings: rankFindings(findings, limit), trace };
}
