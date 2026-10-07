import type { PersonCandidate } from "../types.js";
import { extractDomain, isSocialOrAggregator, rootDomain } from "../util/domain.js";

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
  /**
   * Whether the EMPLOYER could be compared on both sides.
   *
   * `kind: "none"` is returned when the titles match even if the company could not be
   * compared, which is honest as far as it goes - nothing changed in what we could see.
   * But a caller that records "checked, no change" on the strength of that will suppress
   * the next real check, so it needs to know which kind of "none" this was.
   */
  comparedCompany: boolean;
}

/** How much of a name or a title is read: far more than any real one. */
const MAX_FIELD_READ = 300;

/** Normalise a company name enough to compare two spellings of the same employer. */
export function normalizeCompany(name?: string | null): string {
  if (!name || typeof name !== "string") return "";
  // A name is a line. A provider can send anything as one; a dozen passes over a megabyte is a second of work for nothing.
  return name
    .slice(0, MAX_FIELD_READ)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"]/g, "")
    // LEGAL suffixes only. "Acme Technologies Private Limited", "Acme Technologies Pvt.
    // Ltd." and "Acme Technologies" are one employer, and treating them as three would
    // report a move every time a provider spelled it differently.
    //
    // Descriptive words stay. A first version also stripped Technologies, Solutions,
    // Systems, Labs, Software, Services, Group, Holdings, International and Global - which
    // collapsed "Acme Solutions" and "Acme Systems" to the same string, so a champion
    // moving between them was reported as no change at 0.9 confidence. It also reduced
    // employers whose names are entirely generic ("Systems Limited") to the empty string,
    // making them permanently uncomparable. Losing a real move is the expensive error here;
    // a duplicate alert is merely annoying.
    .replace(/\b(private|pvt|public|limited|ltd|llc|llp|inc|incorporated|corp|corporation|co|company|gmbh|bv|nv|sa|ag|plc|pte)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalise a title enough to tell a real move from a reworded one. */
export function normalizeTitle(title?: string | null): string {
  if (!title || typeof title !== "string") return "";
  return title
    .slice(0, MAX_FIELD_READ)
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

/** A comparable root domain, from whatever shape the provider gave us. */
function domainOf(value?: string | null): string {
  if (!value) return "";
  const host = extractDomain(value.trim().toLowerCase());
  if (!host) return "";
  const root = rootDomain(host);
  // A LinkedIn company page is not an employer.
  //
  // Providers put "linkedin.com/company/acme" in a website field constantly, and parsing
  // it properly - which is the fix above - reduces two entirely different employers to
  // "linkedin.com" on both sides. That reads as the same company, which returns
  // `kind: "none"` at 0.9 with "Same employer and the same title", which stamps
  // jobCheckedAt and suppresses the next real check for a month. Before the parse fix this
  // was accidentally safe, because the raw strings differed; the parse has to bring its own
  // guard. Same for sites.google.com, facebook.com pages and the rest.
  if (isSocialOrAggregator(root)) return "";
  return root;
}

/** Do these two records describe the same employer? Domain wins when both have one. */
function sameCompany(a: JobChangeInput["previous"], b: JobChangeInput["current"]): boolean | null {
  // Parsed, not lowercased-and-split.
  //
  // `rootDomain` assumes it was handed a bare hostname; given "https://acme.com/careers"
  // it returns that whole string unchanged. Providers do not cooperate - People Data Labs
  // supplies `job_company_website`, which routinely carries a scheme and sometimes a path -
  // so comparing raw strings reported "https://acme.com" and "acme.com" as two different
  // employers and asserted, at 0.92 "confirmed by company domain", that someone who never
  // moved had moved. `extractDomain` parses the URL and returns the host, or null when
  // there is no usable host in it at all, which is correctly treated as "no domain".
  const da = domainOf(a.companyDomain);
  const db = domainOf(b.companyDomain);
  // A domain is the strongest identifier we have: two people at "Acme" may be at different
  // Acmes, but acme.com is acme.com.
  if (da && db) return da === db;

  const na = normalizeCompany(a.companyName);
  const nb = normalizeCompany(b.companyName);
  if (!na || !nb) return null; // one side has nothing to compare
  // Exact match only, once legal suffixes are gone.
  //
  // An earlier version also treated one name being a prefix of the other as the same
  // employer, to absorb renames. That swallowed real moves whole: "Zoho" to "Zoho Labs" is
  // a parent-to-subsidiary move and reported nothing at all. Renames are handled where they
  // belong instead - in the CONFIDENCE of the reported change, via looksLikeRename - so a
  // probable rename surfaces as a low-confidence change worth a glance, rather than as
  // silence.
  return na === nb;
}

/** How closely related do two company names look? */
type NameRelation = "renamed" | "same-family" | "unrelated";

/**
 * Three tiers, because two were not enough to describe what we actually know.
 *
 * `renamed` - one name begins with the other, whole: "Acme" -> "Acme Global". Most likely a
 * rebrand or a restructure, and asserting a departure here would send someone to write off
 * a live deal.
 *
 * `same-family` - a shared distinctive first word that is not a prefix: "Acme India" ->
 * "Acme Global", "Tata Motors" -> "Tata Steel". This is the tier that has been wrong twice.
 * Treating it as a rename swallowed real moves between genuinely separate companies that
 * happen to share a founder's surname, and reported them at 0.45 as "may not be a move at
 * all". Treating it as unrelated, which the previous fix did, swung it the other way: an
 * internal move from "Acme India" to "Acme Global" was announced at 0.92 as "confirmed by
 * company domain", and a rebrand takes the domain with it, so the domain confirms nothing
 * here. It is a real change either way and it is reported as one - at the confidence the
 * evidence actually supports, with the ambiguity named.
 *
 * `unrelated` - nothing in common. The domains, if we have two, mean what they say.
 */
function nameRelation(a?: string | null, b?: string | null): NameRelation {
  const na = normalizeCompany(a);
  const nb = normalizeCompany(b);
  if (!na || !nb) return "unrelated";
  if (na.startsWith(nb + " ") || nb.startsWith(na + " ")) return "renamed";
  const [fa] = na.split(" ");
  const [fb] = nb.split(" ");
  // Short first words ("the", "new", "global") are far too common to carry this weight.
  if (fa.length >= 4 && fa === fb) return "same-family";
  return "unrelated";
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
      comparedCompany: false,
      reason: "Not enough on one side to compare - this was not checked, rather than unchanged.",
    };
  }

  const companyChanged = companyVerdict === false;
  const titleChanged = haveBothTitles && prevTitle !== currTitle;

  if (companyChanged) {
    // Parseable domains on both sides - not merely non-empty fields. Providers put "n/a",
    // "-" and free text in a website column, and a truthiness check let those claim
    // "confirmed by company domain" at 0.92 for a verdict that was reached on the names
    // alone. `domainOf` is what `sameCompany` compares, so this now agrees with it.
    const byDomain = !!domainOf(previous.companyDomain) && !!domainOf(current.companyDomain);
    const relation = nameRelation(previous.companyName, current.companyName);
    // A rebrand changes the domain too, so "the domains differ" is not by itself proof of a
    // departure. How much it proves depends on how closely the two NAMES are related, which
    // is what nameRelation grades; the 0.92 "confirmed by company domain" claim is reserved
    // for names with nothing in common.
    // Name evidence outranks domain evidence in BOTH hedged tiers, because a rebrand and a
    // restructure each take the domain with them - so for two names this closely related,
    // differing domains are not the independent confirmation they look like.
    const confidence = relation === "renamed" ? 0.45 : relation === "same-family" ? 0.7 : byDomain ? 0.92 : 0.7;
    return {
      kind: titleChanged ? "both" : "company_change",
      confidence,
      reason:
        relation === "renamed"
          ? `The company on file changed from "${previous.companyName}" to "${current.companyName}". These names look like the same company renamed or restructured, so this may not be a move at all - worth a look before acting on it.`
          : relation === "same-family"
            ? `The company on file changed from "${previous.companyName}" to "${current.companyName}". These are either two companies in the same group or one of them renamed, and the domain cannot tell them apart because a rebrand changes that too - so this is a real change, but whether they actually left is worth checking.`
            : byDomain
              ? `Moved from ${previous.companyName ?? previous.companyDomain} to ${current.companyName ?? current.companyDomain} - confirmed by company domain.`
              : `Company name changed from "${previous.companyName}" to "${current.companyName}". This can also be a rebrand or an acquisition, so treat it as likely rather than certain.`,
      from: { company: previous.companyName, title: previous.title },
      to: { company: current.companyName, title: current.title },
      sameEmployer: false,
      comparedCompany: true,
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
      comparedCompany: companyVerdict !== null,
    };
  }

  return {
    kind: "none",
    confidence: companyVerdict === true ? 0.9 : 0.5,
    reason: companyVerdict === true ? "Same employer and the same title." : "Nothing changed in what could be compared - but the employer could not be checked on both sides.",
    sameEmployer: companyVerdict === true,
    comparedCompany: companyVerdict !== null,
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
