/**
 * Human names for usage metric keys.
 *
 * An explicit map rather than splitting camelCase: the generated "Ai Messages" read as a
 * bug, and "verifications" alone does not say what was verified.
 */
const METRIC_LABELS: Record<string, string> = {
  leads: "Leads",
  searches: "Searches",
  verifications: "Email verifications",
  aiMessages: "AI messages",
  emails: "Emails sent",
  premiumLeads: "Premium provider leads",
};

export function metricLabel(key: string): string {
  if (METRIC_LABELS[key]) return METRIC_LABELS[key];
  // An unknown metric still reads as words, not as a code.
  const words = key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/**
 * The plan-limit side of "used / limit". A limit of 0 (or less) means unlimited for every
 * metric except provider-sourced leads, where it means the plan includes none
 * (packages/db usage.ts). Printing "12 / 0" for an unlimited plan read as over quota.
 */
export function limitLabel(metric: string, limit: number): string {
  if (limit > 0) return limit.toLocaleString();
  return metric === "premiumLeads" ? "0 (not on this plan)" : "unlimited";
}
