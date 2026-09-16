/**
 * Composite lead prioritization: blends three signals Scout already tracks separately
 * (ICP fit score, engagement score, recent company signals) into one "who do I contact
 * today, and why" number. None of the three alone tells a rep what to do next - a
 * perfect-fit lead who never opens an email isn't as hot as a decent-fit lead whose
 * company just raised a round. This is the composite view.
 */

export interface SignalForPriority {
  type: string;
  occurredAt?: Date | string | null;
}

export interface LeadForPriority {
  score?: number | null; // rule-based ICP fit, 0..100 (packages/core/src/icp/score.ts)
  engagementScore?: number | null; // opens/clicks/replies, unbounded but typically 0..100+
  status?: string | null;
}

export interface PriorityResult {
  /** 0..100 composite priority score. */
  score: number;
  breakdown: { icpFit: number; engagement: number; signals: number };
  reasons: string[];
}

/** Signal types worth treating as a buying trigger, roughly in descending strength. */
const HOT_SIGNAL_TYPES = new Set(["funding", "acquisition", "leadership", "hiring", "expansion", "launch", "partnership"]);

const daysAgo = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
};

/** Deterministic, free, explainable - no AI call needed for every lead in a list. */
export function computeLeadPriority(lead: LeadForPriority, recentSignals: SignalForPriority[] = []): PriorityResult {
  const icpFit = Math.max(0, Math.min(100, lead.score ?? 0));
  const engagement = Math.max(0, Math.min(100, lead.engagementScore ?? 0));

  let signalPoints = 0;
  let bestSignal: { type: string; days: number } | null = null;
  for (const s of recentSignals) {
    if (!HOT_SIGNAL_TYPES.has(s.type)) continue;
    const days = daysAgo(s.occurredAt);
    if (days === null || days > 60) continue;
    const points = days <= 7 ? 100 : days <= 21 ? 70 : days <= 45 ? 40 : 20;
    if (!bestSignal || days < bestSignal.days) bestSignal = { type: s.type, days };
    signalPoints = Math.max(signalPoints, points);
  }

  // Weighted blend: fit matters most, a live buying trigger can still push a mediocre-fit
  // lead to the top of the list, engagement is the weakest signal (easy to game with opens).
  const score = Math.round(icpFit * 0.5 + engagement * 0.2 + signalPoints * 0.3);

  const reasons: string[] = [];
  if (icpFit >= 70) reasons.push(`Strong ICP fit (${Math.round(icpFit)}/100)`);
  else if (icpFit >= 40) reasons.push(`Partial ICP fit (${Math.round(icpFit)}/100)`);
  else if (icpFit > 0) reasons.push(`Weak ICP fit (${Math.round(icpFit)}/100)`);
  if (engagement >= 50) reasons.push("Has opened, clicked, or replied - actively engaged");
  else if (engagement > 0) reasons.push("Some engagement (opened at least once)");
  if (bestSignal) {
    const label = bestSignal.type === "funding" ? "raised funding" : bestSignal.type === "hiring" ? "is hiring" : bestSignal.type === "leadership" ? "made a leadership change" : bestSignal.type === "acquisition" ? "was acquired or made an acquisition" : `had a ${bestSignal.type} event`;
    reasons.push(`Company ${label} ${bestSignal.days < 1 ? "today" : `${Math.round(bestSignal.days)}d ago`} - good reason to reach out now`);
  }
  if (lead.status === "replied") reasons.push("Already replied - warm, don't let this go cold");
  if (reasons.length === 0) reasons.push("No strong signals yet - low priority for now");

  return { score: Math.max(0, Math.min(100, score)), breakdown: { icpFit: Math.round(icpFit), engagement: Math.round(engagement), signals: signalPoints }, reasons };
}
