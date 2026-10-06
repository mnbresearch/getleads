/**
 * Play: companies that announced funding recently.
 *
 * Wraps the news scanner. One finding per company: the same round reported by several
 * outlets is one event, so reports of one company within fourteen days collapse into the
 * best of them. The reason states an amount or a round only when the headline itself does.
 */
import { fetchGoogleNews, scanSignals, type ParsedSignal } from "../signals/news.js";
import { PlayRun, cleanCompanyName, cleanList, clampInt, findingLimit, finishFinding, isVendorName, rankFindings, safeHttpUrl } from "./shared.js";
import type { PlayEngineOptions, PlayEngineResult, PlayFinding } from "./types.js";
import { cleanLine, cleanQuote, normCompanyName } from "./util.js";

const SAME_ROUND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONEY = /(US\$|A\$|C\$|S\$|\$|\u20B9|Rs\.?\s?|INR\s?|\u20AC|\u00A3)\s?(\d{1,4}(?:,\d{3})*(?:\.\d+)?)\s?(billion|bn|b|million|mn|m|crore|cr|lakh|k|thousand)?(?![\p{L}\p{N}])/iu;

/**
 * The amount a headline states, in US dollars, and whether the headline wrote it in dollars.
 * Stricter than the scanner's own reading: the unit must end at a word boundary ("$5 more"
 * is five dollars, not five million) and only the headline is read, never the summary,
 * which lists other companies' rounds.
 */
export function headlineAmount(headline: string): { usd: number; inDollars: boolean } | null {
  const m = MONEY.exec(headline);
  if (!m) return null;
  const n = parseFloat(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const symbol = m[1].trim().toLowerCase();
  const unit = (m[3] ?? "").toLowerCase();
  const rate = symbol === "\u20B9" || symbol.startsWith("rs") || symbol.startsWith("inr") ? 0.012 : symbol === "\u20AC" ? 1.08 : symbol === "\u00A3" ? 1.27 : symbol === "a$" ? 0.66 : symbol === "c$" ? 0.73 : symbol === "s$" ? 0.75 : 1;
  const mult = unit === "billion" || unit === "bn" || unit === "b" ? 1e9 : unit === "million" || unit === "mn" || unit === "m" ? 1e6 : unit === "crore" || unit === "cr" ? 1e7 : unit === "lakh" ? 1e5 : unit === "k" || unit === "thousand" ? 1e3 : 1;
  const usd = Math.round(n * mult * rate);
  // A bare "$12" in a funding headline is a typo or a share price, not a round.
  if (usd < 10_000) return null;
  return { usd, inDollars: rate === 1 };
}

/** "$12M", "$1.5B", "$500K". */
export function formatUsd(usd: number): string {
  const fmt = (v: number, suffix: string): string => {
    const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return `$${Number.isInteger(r) ? r : r.toFixed(1)}${suffix}`;
  };
  if (usd >= 1e9) return fmt(usd / 1e9, "B");
  if (usd >= 1e6) return fmt(usd / 1e6, "M");
  if (usd >= 1e3) return fmt(usd / 1e3, "K");
  return `$${Math.round(usd)}`;
}

/** A named round in the headline: "Series A", "seed", "pre-seed". Vague words ("round", "growth") are not a round. */
export function headlineRound(headline: string): string | null {
  const m = /\b(pre-?seed|seed|pre-?series\s+[a-k]|series\s+[a-k]\d?|angel)\b/i.exec(headline);
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

/** "Raises concerns", "lands a $10M contract": the scanner's verbs, but not a funding round. */
const NOT_FUNDING =
  /\b(?:raises?|raised|raising)\s+(?:concerns?|questions?|alarms?|doubts?|eyebrows|awareness|prices?|rates?|stakes?|the bar|forecasts?|outlook|guidance|targets?|fears?|hopes?|issues?|(?:red )?flags?|objections?|minimum|wages?|pay|salaries|dividends?|fees|tariffs?)\b|\b(?:contracts?|settlement|fines?|fined|penalt(?:y|ies)|lawsuit|verdict|tender|purchase order|orders? (?:worth|from|for)|buyback|dividend|share price|price target)\b/i;
/** With no amount and no round in the headline, it must at least say it is about funding. */
const SAYS_FUNDING = /\b(?:raises?|raised|secures?|secured|bags|bagged|closes|closed|lands|landed|nets|netted|snags|gets|receives?|received)\b[^.]{0,60}\b(?:funding|investment|financing|capital|round)\b/i;

/** Is this headline a company announcing money raised? */
export function isFundingHeadline(title: string): boolean {
  if (FUND_RAISE.test(title) || NOT_FUNDING.test(title)) return false;
  return !!headlineAmount(title) || !!headlineRound(title) || SAYS_FUNDING.test(title);
}

export function fundingReason(s: { title: string; source?: string; occurredAt?: Date }): string {
  const amount = headlineAmount(s.title);
  const round = headlineRound(s.title);
  let what: string;
  if (amount && round) what = `Raised ${amount.inDollars ? "" : "about "}${formatUsd(amount.usd)} ${round}`;
  else if (amount) what = `Raised ${amount.inDollars ? "" : "about "}${formatUsd(amount.usd)}`;
  else if (round) what = `Raised ${/^[aeiou]/i.test(round) ? "an" : "a"} ${round} round`;
  else what = "Announced new funding";
  const source = cleanLine(s.source, 60);
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
    const name = cleanCompanyName(s.companyName, 5);
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
