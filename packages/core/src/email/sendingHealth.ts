/**
 * Sending health guardrails.
 *
 * The fastest way to destroy a cold outreach programme is to keep sending from a domain
 * that is already bouncing or drawing complaints. Reputation damage is slow to detect,
 * fast to accumulate, and effectively permanent once a domain is flagged.
 *
 * domainHealth.ts answers "is the DNS set up right" once, at configuration time. This
 * module answers "is it safe to send *right now*", continuously, from live outcomes, and
 * returns a hard stop when it is not.
 *
 * Deterministic, DNS-free, no external calls. Thresholds follow the limits the major
 * mailbox providers publish for bulk senders.
 */

export interface SendingStats {
  sent: number;
  bounced: number;
  complained?: number;
  unsubscribed?: number;
  replied?: number;
}

export interface SendingHealthOptions {
  /** Days since this sending identity started sending. null/undefined = unknown, treated as warmed. */
  domainAgeDays?: number | null;
  /** The cap the user configured. The recommendation never exceeds it. */
  configuredDailyCap?: number;
  /** Below this volume, rates are too noisy to act on. Default 20. */
  minVolumeForRates?: number;
}

export interface SendingHealth {
  status: "ok" | "warn" | "halt";
  bounceRate: number;
  complaintRate: number;
  unsubscribeRate: number;
  /** Safe cap for today, accounting for warm-up ramp and any degradation. 0 when halted. */
  recommendedDailyCap: number;
  /** Position in the warm-up schedule, null once warmed or when age is unknown. */
  rampDay: number | null;
  reasons: string[];
  actions: string[];
}

/** Hard stop. Sustained bounce rates at this level get a domain blocked. */
const BOUNCE_HALT = 0.05;
const BOUNCE_WARN = 0.02;
/** Complaints are punished far more harshly than bounces. */
const COMPLAINT_HALT = 0.003;
const COMPLAINT_WARN = 0.001;
const UNSUB_WARN = 0.05;

/** Conservative warm-up ladder for a cold sending identity. */
const RAMP: { throughDay: number; cap: number }[] = [
  { throughDay: 2, cap: 20 },
  { throughDay: 4, cap: 40 },
  { throughDay: 7, cap: 75 },
  { throughDay: 10, cap: 125 },
  { throughDay: 14, cap: 200 },
  { throughDay: 21, cap: 350 },
];
const WARMED_AFTER_DAYS = 21;

/** Cap implied by the warm-up ladder, or null once the identity is warmed / age unknown. */
export function rampCapFor(domainAgeDays: number | null | undefined): number | null {
  if (domainAgeDays == null || !Number.isFinite(domainAgeDays)) return null;
  if (domainAgeDays > WARMED_AFTER_DAYS) return null;
  const day = Math.max(1, Math.floor(domainAgeDays));
  for (const r of RAMP) if (day <= r.throughDay) return r.cap;
  return null;
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x >= 0.01 ? 1 : 2)}%`;
}

/**
 * Decide whether it is safe to keep sending, and at what volume.
 *
 * `halt` is meant to be enforced, not advisory: the campaign scheduler refuses to queue
 * sends while it holds.
 */
export function evaluateSendingHealth(stats: SendingStats, opts: SendingHealthOptions = {}): SendingHealth {
  const minVolume = opts.minVolumeForRates ?? 20;
  const sent = Math.max(0, stats.sent ?? 0);
  const bounceRate = rate(stats.bounced ?? 0, sent);
  const complaintRate = rate(stats.complained ?? 0, sent);
  const unsubscribeRate = rate(stats.unsubscribed ?? 0, sent);

  const reasons: string[] = [];
  const actions: string[] = [];
  const OK = 0;
  const WARN = 1;
  const HALT = 2;
  let severity = OK;
  const escalate = (s: number) => {
    severity = Math.max(severity, s);
  };

  const enoughVolume = sent >= minVolume;
  if (!enoughVolume && sent > 0) {
    reasons.push(`Only ${sent} sent so far, too few to judge deliverability rates.`);
  }

  if (enoughVolume) {
    if (bounceRate >= BOUNCE_HALT) {
      escalate(HALT);
      reasons.push(`Bounce rate ${pct(bounceRate)} is at or above the ${pct(BOUNCE_HALT)} hard limit.`);
      actions.push("Sending is halted. Verify your remaining list before resuming.");
    } else if (bounceRate >= BOUNCE_WARN) {
      escalate(WARN);
      reasons.push(`Bounce rate ${pct(bounceRate)} is above the ${pct(BOUNCE_WARN)} safe threshold.`);
      actions.push("Run email verification on unverified leads before they are sent to.");
    }

    if (complaintRate >= COMPLAINT_HALT) {
      escalate(HALT);
      reasons.push(`Spam complaint rate ${pct(complaintRate)} is at or above the ${pct(COMPLAINT_HALT)} hard limit.`);
      actions.push("Sending is halted. Review targeting and message relevance before resuming.");
    } else if (complaintRate >= COMPLAINT_WARN) {
      escalate(WARN);
      reasons.push(`Spam complaint rate ${pct(complaintRate)} is elevated.`);
      actions.push("Tighten targeting; complaints damage reputation faster than bounces.");
    }

    if (unsubscribeRate >= UNSUB_WARN) {
      escalate(WARN);
      reasons.push(`Unsubscribe rate ${pct(unsubscribeRate)} suggests the list is poorly targeted.`);
    }
  }

  const status: SendingHealth["status"] = severity === HALT ? "halt" : severity === WARN ? "warn" : "ok";

  const rampCap = rampCapFor(opts.domainAgeDays);
  const rampDay = rampCap == null ? null : Math.max(1, Math.floor(opts.domainAgeDays as number));
  if (rampCap != null) {
    reasons.push(`Sending identity is ${rampDay} day${rampDay === 1 ? "" : "s"} old, still warming up.`);
    actions.push(`Hold at ${rampCap}/day until day ${WARMED_AFTER_DAYS} to build reputation.`);
  }

  const configured = opts.configuredDailyCap && opts.configuredDailyCap > 0 ? opts.configuredDailyCap : Number.POSITIVE_INFINITY;
  let recommendedDailyCap: number;
  if (status === "halt") {
    recommendedDailyCap = 0;
  } else {
    const base = Math.min(configured, rampCap ?? configured);
    const safe = status === "warn" ? Math.floor(base / 2) : base;
    recommendedDailyCap = Number.isFinite(safe) ? Math.max(0, safe) : 0;
    if (status === "warn" && Number.isFinite(safe)) {
      actions.push(`Daily volume cut to ${recommendedDailyCap} while deliverability recovers.`);
    }
  }

  if (status === "ok" && reasons.length === 0) {
    reasons.push(sent > 0 ? `${sent} sent, bounce rate ${pct(bounceRate)}. Healthy.` : "No sending history yet.");
  }

  return { status, bounceRate, complaintRate, unsubscribeRate, recommendedDailyCap, rampDay, reasons, actions };
}
