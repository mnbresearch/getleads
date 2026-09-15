import { slugifyNamePart } from "../util/names.js";

/** Email pattern tokens: {first} {last} {f} {l} */
export const PATTERNS = [
  "{first}.{last}",
  "{first}",
  "{f}{last}",
  "{first}{last}",
  "{first}_{last}",
  "{f}.{last}",
  "{first}{l}",
  "{last}.{first}",
  "{last}",
  "{first}-{last}",
  "{last}{first}",
  "{f}{l}",
] as const;

export type Pattern = (typeof PATTERNS)[number];

export function applyPattern(pattern: string, firstName: string, lastName: string, domain: string): string | null {
  const first = slugifyNamePart(firstName);
  const last = slugifyNamePart(lastName);
  if (!first) return null;
  if (pattern.includes("{last}") || pattern.includes("{l}")) {
    if (!last) return null;
  }
  const local = pattern
    .replace("{first}", first)
    .replace("{last}", last)
    .replace("{f}", first[0])
    .replace("{l}", last[0] ?? "");
  return `${local}@${domain}`;
}

/** Infer the dominant pattern from known (name, email) pairs at a domain. */
export function inferPattern(samples: { firstName?: string; lastName?: string; email: string }[]): { pattern: Pattern; confidence: number } | null {
  const votes = new Map<Pattern, number>();
  let considered = 0;
  for (const s of samples) {
    if (!s.firstName || !s.email) continue;
    const [local, domain] = s.email.toLowerCase().split("@");
    if (!domain) continue;
    considered++;
    for (const p of PATTERNS) {
      const cand = applyPattern(p, s.firstName, s.lastName ?? "", domain);
      if (cand && cand.split("@")[0] === local) votes.set(p, (votes.get(p) ?? 0) + 1);
    }
  }
  if (considered === 0 || votes.size === 0) return null;
  const [pattern, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { pattern, confidence: Math.min(0.95, 0.5 + (n / considered) * 0.5) };
}

/** Guess pattern from any emails at the domain even without names (e.g. 'john.doe@' → first.last). */
export function inferPatternFromEmails(emails: string[]): { pattern: Pattern; confidence: number } | null {
  const votes = new Map<Pattern, number>();
  for (const e of emails) {
    const local = e.split("@")[0].toLowerCase();
    if (/^(info|contact|hello|sales|support|admin|team|hr|careers|jobs|press|media|help|office|mail|marketing)$/.test(local)) continue;
    if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) votes.set("{first}.{last}", (votes.get("{first}.{last}") ?? 0) + 1);
    else if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) votes.set("{first}_{last}", (votes.get("{first}_{last}") ?? 0) + 1);
    else if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) votes.set("{first}-{last}", (votes.get("{first}-{last}") ?? 0) + 1);
    else if (/^[a-z]{3,8}$/.test(local)) votes.set("{first}", (votes.get("{first}") ?? 0) + 1);
    else if (/^[a-z][a-z]{3,}$/.test(local)) votes.set("{f}{last}", (votes.get("{f}{last}") ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  const [pattern, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { pattern, confidence: Math.min(0.7, 0.35 + n * 0.1) };
}

export function candidatesFor(firstName: string, lastName: string, domain: string, preferred?: string | null): string[] {
  const order = preferred ? [preferred, ...PATTERNS.filter((p) => p !== preferred)] : [...PATTERNS];
  const out: string[] = [];
  for (const p of order) {
    const e = applyPattern(p, firstName, lastName, domain);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}
