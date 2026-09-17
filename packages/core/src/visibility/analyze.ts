/**
 * AI answer analysis: what a single LLM response says about you and your competitors.
 *
 * This is the deterministic half of AI visibility. Given the raw text an engine returned
 * for a tracked prompt, it extracts who was named, in what order, and who was cited with
 * a link. No AI call, no external service, so it is cheap, reproducible and testable.
 *
 * The judgement calls it deliberately does NOT make:
 *
 *  - Sentiment. Deciding whether a mention was favourable needs another model, and a
 *    wrong sentiment label is worse than no label. Left to a later, explicitly-flagged
 *    layer rather than faked with keyword matching.
 *  - Whether one answer means anything. It does not. A single LLM response is a sample
 *    from a distribution, and interpreting one run as a measurement is the central error
 *    in this whole product category. Aggregation and significance live in metrics.ts.
 */

export interface BrandSpec {
  /** Canonical display name, e.g. "Scout". */
  name: string;
  /** Other spellings that count as the same brand, e.g. ["Scout by MNB", "MNB Scout"]. */
  aliases?: string[];
  /** Root domain, used to detect citations, e.g. "scout.mnbresearch.com". */
  domain?: string | null;
}

export interface BrandHit {
  name: string;
  /** Rank among distinct brands by first appearance. 1 = named first. */
  position: number;
  /** Character offset of the first mention. */
  firstIndex: number;
  /** How early in the answer the brand appears, 1 = very top, 0 = very end. */
  prominence: number;
  /** Times the brand was named. Repetition is weak evidence of emphasis. */
  mentions: number;
  /** True when a link to the brand's own domain appeared in the answer. */
  cited: boolean;
  /** The brand's own URLs the engine linked to. */
  citedUrls: string[];
}

export interface AnswerAnalysis {
  /** The tracked brand, present whether or not it was mentioned. */
  brand: BrandHit | null;
  /** Every tracked competitor that appeared, best position first. */
  competitors: BrandHit[];
  /** Distinct brands named, tracked or not, in order of first appearance. */
  orderedBrands: string[];
  /** Every URL the answer linked to. */
  allUrls: string[];
  /** Answer length, useful for spotting truncation. */
  length: number;
  /** Blank or too short to contain an answer. */
  empty: boolean;
  /** The engine declined to answer. Distinct from answering without naming you. */
  refusal: boolean;
  /**
   * Safe to count as a measurement.
   *
   * Unusable answers must be excluded from the denominator, not recorded as absence.
   * Counting a refusal as "brand not mentioned" silently drags your mention rate down
   * and invents a visibility problem that does not exist.
   */
  usable: boolean;
}

/** Conservative: only phrases that clearly indicate a declined answer, to avoid false positives. */
const REFUSAL_RE = /\b(i (?:cannot|can't|can not|won't|will not|am unable to|'m unable to)\s+(?:help|assist|answer|provide|comply)|as an ai(?: language)? model,? i|i (?:do not|don't) have (?:enough )?(?:information|access)|unable to (?:help|assist|answer) with (?:that|this))\b/i;

/** Strip punctuation that commonly hugs a brand name so "Scout," still matches. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a name on word boundaries, tolerating a trailing possessive or plural.
 *
 * Word boundaries matter: without them "Apollo" matches inside "Apollonia", and a brand
 * like "Lead" or "Close" would match half the answer.
 */
function occurrences(haystack: string, needle: string): number[] {
  return matchRanges(haystack, [needle]).map((r) => r.start);
}

/**
 * Find every distinct span matching any of `names`, counting overlapping matches once.
 *
 * Aliases routinely contain the brand name ("Scout" and "Scout by MNB"), so matching each
 * name independently double-counts a single occurrence and inflates every mention metric.
 * Longest match wins, and any shorter match overlapping an accepted span is discarded.
 */
function matchRanges(haystack: string, names: string[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const name of names) {
    const trimmed = (name ?? "").trim();
    if (!trimmed) continue;
    const re = new RegExp(`(?<![\\w-])${escapeRegex(trimmed)}(?:'s|’s|s)?(?![\\w-])`, "gi");
    for (const m of haystack.matchAll(re)) {
      if (m.index !== undefined) found.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  // Longest first at a given start, so "Scout by MNB" is preferred over "Scout".
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: { start: number; end: number }[] = [];
  for (const r of found) {
    if (kept.some((k) => r.start < k.end && k.start < r.end)) continue;
    kept.push(r);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Does `host` equal the target domain or sit beneath it? */
function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.replace(/^www\./i, "").toLowerCase();
  if (!host || !d) return false;
  return host === d || host.endsWith(`.${d}`);
}

function analyzeBrand(text: string, spec: BrandSpec, urls: string[]): BrandHit | null {
  const names = [spec.name, ...(spec.aliases ?? [])].filter(Boolean);
  const idxs = matchRanges(text, names).map((r) => r.start);
  const citedUrls = spec.domain ? urls.filter((u) => hostMatchesDomain(hostOf(u), spec.domain!)) : [];

  // A citation counts as presence even when the engine never wrote the brand's name,
  // which happens when it links a source without naming the vendor in prose.
  if (idxs.length === 0 && citedUrls.length === 0) return null;

  const firstIndex = idxs.length > 0 ? idxs[0] : 0;
  const prominence = text.length > 0 ? Math.max(0, Math.min(1, 1 - firstIndex / text.length)) : 0;
  return {
    name: spec.name,
    position: 0, // assigned by the caller once every brand's first index is known
    firstIndex,
    prominence: Number(prominence.toFixed(4)),
    mentions: idxs.length,
    cited: citedUrls.length > 0,
    citedUrls: Array.from(new Set(citedUrls)),
  };
}

/**
 * Analyze one engine answer for one tracked prompt.
 *
 * `others` are brand names to detect for ordering context without tracking them as
 * competitors, typically harvested from previous answers so the ranking reflects the
 * whole field rather than only the brands you already knew about.
 */
export function analyzeAnswer(
  answer: string,
  opts: { brand: BrandSpec; competitors?: BrandSpec[]; others?: string[] },
): AnswerAnalysis {
  const text = answer ?? "";
  const allUrls = Array.from(new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, ""))));
  const trimmed = text.trim();
  const empty = trimmed.length < 20;
  // Only treat a refusal as such when it is the whole response. A long answer that
  // happens to contain a hedging phrase is still a real answer.
  const refusal = REFUSAL_RE.test(trimmed) && trimmed.length < 400;

  const brandHit = analyzeBrand(text, opts.brand, allUrls);
  const competitorHits = (opts.competitors ?? [])
    .map((c) => analyzeBrand(text, c, allUrls))
    .filter((h): h is BrandHit => h !== null);

  // Rank every named brand, including untracked ones, by where it first appears. An
  // untracked brand appearing above you is still you losing the answer.
  const untracked = (opts.others ?? [])
    .filter((n) => n && n !== opts.brand.name && !competitorHits.some((c) => c.name === n))
    .map((n) => ({ name: n, idx: occurrences(text, n)[0] }))
    .filter((x): x is { name: string; idx: number } => x.idx !== undefined);

  const ranked = [
    ...(brandHit ? [{ name: brandHit.name, idx: brandHit.firstIndex }] : []),
    ...competitorHits.map((c) => ({ name: c.name, idx: c.firstIndex })),
    ...untracked,
  ].sort((a, b) => a.idx - b.idx);

  const positionOf = new Map(ranked.map((r, i) => [r.name, i + 1]));
  if (brandHit) brandHit.position = positionOf.get(brandHit.name) ?? 0;
  for (const c of competitorHits) c.position = positionOf.get(c.name) ?? 0;
  competitorHits.sort((a, b) => a.position - b.position);

  return {
    brand: brandHit,
    competitors: competitorHits,
    orderedBrands: ranked.map((r) => r.name),
    allUrls,
    length: text.length,
    empty,
    refusal,
    usable: !empty && !refusal,
  };
}
