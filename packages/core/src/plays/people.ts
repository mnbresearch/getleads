/**
 * From a company a play found to the people worth contacting there.
 *
 * Each person carries the company finding's reason and evidence unchanged - the reason is
 * about the company, and it is only attached to people the search shows working there.
 * No email address is ever made up here.
 *
 * When job titles are asked for, only people whose own title is one of them come back: a
 * person with another title, or with none the search could show, is not who was asked for.
 * (A search result often puts the company's name where the title goes; that is not a title.)
 */
import { titleMatch } from "../icp/score.js";
import { resolveCompanyDomainDetailed } from "../discovery/companies.js";
import { findPeopleDetailed } from "../discovery/people.js";
import type { PersonCandidate } from "../types.js";
import { extractDomain, rootDomain } from "../util/domain.js";
import { isPublicHost } from "../util/publicHost.js";
import { PlayRun, clampInt, cleanList, finishFinding } from "./shared.js";
import type { PlayEngineOptions, PlayFinding, PlayRunTrace } from "./types.js";
import { cleanLine, normCompanyName, playDedupeKey } from "./util.js";

const MAX_TITLES_SEARCHED = 5;

/** Does the search result place this person at the company? */
function worksAt(p: PersonCandidate, company: string, label: string): "yes" | "probably" | "no" {
  const want = normCompanyName(company) || label;
  if (!want) return "no";
  const have = normCompanyName(p.companyName ?? "");
  const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
  if (have) return same(have, want) || (!!label && same(have, label)) ? "yes" : "no";
  const hay = `${p.title ?? ""} ${p.snippet ?? ""}`.toLowerCase();
  const name = cleanLine(company, 160).toLowerCase();
  if (name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(hay)) return "probably";
  return "no";
}

/** Decision makers at the company of a company finding. Each person inherits the finding's reason, evidence, signalType, signalAt; confidence is the lower of the two. */
export async function findPeopleForFinding(finding: PlayFinding, cfg: { titles: string[]; limit?: number }, opts: PlayEngineOptions = {}): Promise<{ people: PlayFinding[]; trace: PlayRunTrace }> {
  const run = new PlayRun(opts);
  const limit = clampInt(cfg?.limit, 3, 1, 25);
  const titles = cleanList(cfg?.titles, 20, 100);
  let companyName = cleanLine(finding?.companyName, 160);
  let companyDomain = typeof finding?.companyDomain === "string" ? (extractDomain(finding.companyDomain.trim()) ?? "") : "";
  if (companyDomain && !isPublicHost(companyDomain)) companyDomain = "";

  if (!companyName && !companyDomain) {
    run.block("This candidate has no company name or website, so there is nobody to look for.");
    return { people: [], trace: run.trace };
  }
  if (run.expired) return { people: [], trace: run.finish(false, "The run had no time left, so nobody was looked for.") };

  /* The company's website, when the finding did not come with one. Only an answer the search backs up is used. */
  if (!companyDomain && companyName) {
    const resolved = await run.within(resolveCompanyDomainDetailed(companyName, undefined, { providers: opts.searchOpts?.providers, onOutcome: run.recordOutcome }).catch(() => null));
    if (resolved?.domain && /domain contains/.test(resolved.reason) && isPublicHost(resolved.domain)) companyDomain = resolved.domain;
  }
  const label = companyDomain ? rootDomain(companyDomain).split(".")[0].replace(/[^a-z0-9]/g, "") : "";
  if (!companyName) companyName = label;

  let found: PersonCandidate[] = [];
  if (!run.expired) {
    const outer = opts.searchOpts?.onOutcome;
    const res = await run.within(
      findPeopleDetailed(
      { companyName, ...(companyDomain ? { companyDomain } : {}), titles: titles.slice(0, MAX_TITLES_SEARCHED), limit: limit * 4, ...(opts.country ? { country: opts.country } : {}) },
      {
        ...(opts.searchOpts ?? {}),
        onOutcome: (o, q) => {
          run.recordOutcome(o);
          try {
            outer?.(o, q);
          } catch {
            // an observer never breaks the search it is watching
          }
        },
        },
      ).catch(() => null),
    );
    found = res?.people ?? [];
  }

  /** The person's job title, or "" when what the search put there is the company's name or nothing. */
  const titleOf = (p: PersonCandidate): string => {
    const t = cleanLine(p.title, 200);
    const key = normCompanyName(t);
    if (!t || !key) return "";
    return key === normCompanyName(companyName) || key === normCompanyName(finding?.companyName) || (!!label && key === label) ? "" : t;
  };
  let elsewhere = 0;
  let otherTitle = 0;
  const ranked: { p: PersonCandidate; at: "yes" | "probably"; titled: boolean; title: string }[] = [];
  for (const p of found) {
    const at = worksAt(p, companyName, label);
    if (at === "no") {
      elsewhere++;
      continue;
    }
    const title = titleOf(p);
    const titled = titles.length ? titleMatch(title, titles) === true : false;
    // Titles were asked for: somebody with another title, or none we can see, is not who was asked for.
    if (titles.length && !titled) {
      otherTitle++;
      continue;
    }
    ranked.push({ p, at, titled, title });
  }
  ranked.sort((a, b) => Number(b.titled) - Number(a.titled) || Number(b.at === "yes") - Number(a.at === "yes") || b.p.confidence - a.p.confidence);

  const people: PlayFinding[] = [];
  const seen = new Set<string>();
  for (const { p, at, title } of ranked) {
    if (people.length >= limit) break;
    const f = finishFinding({
      kind: "person",
      fullName: p.fullName,
      firstName: p.firstName,
      lastName: p.lastName,
      ...(title ? { title } : {}),
      linkedinUrl: p.linkedinUrl,
      location: p.location,
      companyName: cleanLine(finding.companyName, 160) || p.companyName || companyName,
      ...(companyDomain ? { companyDomain } : {}),
      relevantBecause: finding.relevantBecause,
      evidenceUrl: finding.evidenceUrl,
      evidenceTitle: finding.evidenceTitle,
      evidenceQuote: finding.evidenceQuote,
      signalType: finding.signalType,
      signalAt: finding.signalAt,
      confidence: Math.min(typeof finding.confidence === "number" ? finding.confidence : 0, at === "yes" ? p.confidence : Math.min(p.confidence, 0.5)),
    });
    if (!f || !f.fullName) continue;
    const key = playDedupeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(f);
  }
  if (elsewhere > 0) run.note(`${elsewhere} ${elsewhere === 1 ? "person" : "people"} found by search did not clearly work at ${companyName}, so ${elsewhere === 1 ? "that person was" : "they were"} left out.`);
  if (otherTitle > 0) run.note(`${otherTitle} ${otherTitle === 1 ? "person" : "people"} found at ${companyName} did not hold one of those job titles, so ${otherTitle === 1 ? "that person was" : "they were"} left out.`);
  if (run.searchAnswered && !people.length) run.note(`No one matching those job titles was found at ${companyName}.`);

  const trace = run.finish(run.searchAnswered, "The people search could not run, so nobody could be looked for.");
  return { people, trace };
}
