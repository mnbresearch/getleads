import type { PersonCandidate } from "../types.js";
import { rootDomain } from "../util/domain.js";

/**
 * Has this person changed job since we last looked?
 *
 * A champion who moves is the strongest buying trigger in B2B: they arrive somewhere new
 * with budget, a mandate, and a tool they already know they like. The same fact cuts the
 * other way too - the deal you were working at their old company just lost its sponsor, and
 * nobody tells you.
 *
 * The whole value of this depends on one distinction, which is the same one the rest of
 * this codebase is built around: a person who HAS moved must not look like a person we
 * failed to re-check. Enrichment returns partial records constantly - a provider that has
 * the name but not the company, a crawl that reached nothing - and reading "company: null"
 * as "they left" would invent a resignation out of a timeout. So every comparison here
 * requires evidence on BOTH sides, and anything less is reported as `unknown` rather than
 * as a change.
 */

export type JobChangeKind = "company_change" | "title_change" | "both" | "none" | "unknown";

export interface JobChangeInput {
  /** What we have on file. */
  previous: { companyName?: string | null; companyDomain?: string | null; title?: string | null };
  /** What a fresh lookup just returned. */
  current: { companyName?: string | null; companyDomain?: string | null; title?: string | null };
}

export interface JobChangeResult {
  kind: JobChangeKind;
  /** 0..1. How sure we are this is a real change and not a data artefact. */
  confidence: number;
  /** Plain-language explanation, suitable for showing a user. */
  reason: string;
  from?: { company?: string | null; title?: string | null };
  to?: { company?: string | null; title?: string | null };
  /** True when a move looks like a promotion at the same employer rather than a new one. */
  sameEmployer?: boolean;
}

/** Normalise a company name enough to compare two spellings of the same employer. */
export function normalizeCompany(name?: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"]/g, "")
    // Legal suffixes and the noise around them. "Acme Technologies Private Limited",
    // "Acme Technologies Pvt. Ltd." and "Acme Technologies" are one employer, and treating
    // them as three would report a job change every time a provider spelled it differently.
    .replace(/\b(private|pvt|public|limited|ltd|llc|llp|inc|incorporated|corp|corporation|co|company|gmbh|bv|nv|sa|ag|plc|pte|holdings|group|technologies|technology|labs|software|solutions|services|systems|international|global)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalise a title enough to tell a real move from a reworded one. */
export function normalizeTitle(title?: string | null): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(vice president)\b/g, "vp")
    .replace(/\b(chief executive officer)\b/g, "ceo")
    .replace(/\b(chief technology officer)\b/g, "cto")
    .replace(/\b(chief marketing officer)\b/g, "cmo")
    .replace(/\b(chief financial officer)\b/g, "cfo")
    .replace(/\b(chief operating officer)\b/g, "coo")
    .replace(/\b(co-?founder)\b/g, "founder")
    .replace(/\b(sr|snr)\b/g, "senior")
    .replace(/\b(jr)\b/g, "junior")
    // "Head of Sales, EMEA" and "Head of Sales" are the same job with a region bolted on.
    .replace(/[,|–-].*$/, "")
    .replace(/\b(at|for|of|the|and)\b/g, " ")
    .replace(/[^a-z0-9+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Do these two records describe the same employer? Domain wins when both have one. */
function sameCompany(a: JobChangeInput["previous"], b: JobChangeInput["current"]): boolean | null {
  const da = a.companyDomain ? rootDomain(a.companyDomain.toLowerCase()) : "";
  const db = b.companyDomain ? rootDomain(b.companyDomain.toLowerCase()) : "";
  // A domain is the strongest identifier we have: two people at "Acme" may be at different
  // Acmes, but acme.com is acme.com.
  if (da && db) return da === db;

  const na = normalizeCompany(a.companyName);
  const nb = normalizeCompany(b.companyName);
  if (!na || !nb) return null; // one side has nothing to compare
  if (na === nb) return true;
  // A rename or an acquisition often leaves one name a prefix of the other.
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  return false;
}

export function detectJobChange(input: JobChangeInput): JobChangeResult {
  const { previous, current } = input;

  const companyVerdict = sameCompany(previous, current);
  const prevTitle = normalizeTitle(previous.title);
  const currTitle = normalizeTitle(current.title);
  const haveBothTitles = !!prevTitle && !!currTitle;

  // We could not compare either field. That is not "they stayed put" - it is that we do not
  // know, and saying otherwise would let a failed lookup masquerade as a checked one.
  if (companyVerdict === null && !haveBothTitles) {
    return {
      kind: "unknown",
      confidence: 0,
      reason: "Not enough on one side to compare - this was not checked, rather than unchanged.",
    };
  }

  const companyChanged = companyVerdict === false;
  const titleChanged = haveBothTitles && prevTitle !== currTitle;

  if (companyChanged) {
    // A domain match on both sides is near-certain; two names that simply differ could
    // still be a rebrand, an acquisition, or a provider writing the parent company.
    const byDomain = !!previous.companyDomain && !!current.companyDomain;
    return {
      kind: titleChanged ? "both" : "company_change",
      confidence: byDomain ? 0.92 : 0.7,
      reason: byDomain
        ? `Moved from ${previous.companyName ?? previous.companyDomain} to ${current.companyName ?? current.companyDomain} - confirmed by company domain.`
        : `Company name changed from "${previous.companyName}" to "${current.companyName}". This can also be a rebrand or an acquisition, so treat it as likely rather than certain.`,
      from: { company: previous.companyName, title: previous.title },
      to: { company: current.companyName, title: current.title },
      sameEmployer: false,
    };
  }

  if (titleChanged) {
    // Same employer, different title: a promotion or a sideways move. Worth knowing - the
    // relationship survives and the budget may have grown - but it is not a new account.
    return {
      kind: "title_change",
      confidence: companyVerdict === true ? 0.85 : 0.6,
      reason:
        companyVerdict === true
          ? `Still at ${current.companyName ?? "the same company"}, now "${current.title}" (was "${previous.title}").`
          : `Title changed from "${previous.title}" to "${current.title}". The employer could not be confirmed on both sides, so this may also be a move.`,
      from: { company: previous.companyName, title: previous.title },
      to: { company: current.companyName, title: current.title },
      sameEmployer: companyVerdict === true,
    };
  }

  return {
    kind: "none",
    confidence: companyVerdict === true ? 0.9 : 0.5,
    reason: companyVerdict === true ? "Same employer and the same title." : "Nothing changed in what could be compared.",
    sameEmployer: companyVerdict === true,
  };
}

/** Convenience for callers holding a freshly enriched candidate. */
export function detectJobChangeFromCandidate(
  previous: JobChangeInput["previous"],
  candidate: Pick<PersonCandidate, "title" | "companyName"> & { companyDomain?: string | null },
): JobChangeResult {
  return detectJobChange({
    previous,
    current: { companyName: candidate.companyName, companyDomain: candidate.companyDomain, title: candidate.title },
  });
}
