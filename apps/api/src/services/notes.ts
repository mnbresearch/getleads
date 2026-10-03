/**
 * Sentences a customer reads, built in one place.
 *
 * Search, saved searches, autopilots and the discovery agent each hand-wrote the note for a
 * run that came back empty because our data sources could not answer. Each copy said
 * "N data source(s)", and each repeated whatever the source said verbatim - which, with no
 * web search set up, was a line naming the server's environment variables.
 */
import { NO_WEB_SEARCH_CONFIGURED, isNoWebSearchConfigured } from "@prospex/core";

/** "1 lead", "2 leads" - never "1 leads" or "lead(s)". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type ProviderFailure = { provider: string; message: string };

const notConnected = (f: ProviderFailure) => f.provider === "web_search" && isNoWebSearchConfigured(f.message);

/** One failure as a customer reads it: the source, and what it said. */
function describeFailure(f: ProviderFailure): string {
  if (notConnected(f)) return "web search - no search source is connected on our side";
  return `${f.provider === "web_search" ? "web search" : f.provider} - ${f.message}`;
}

/** The failures of a run, as a list in a sentence. */
export function listProviderFailures(failures: ProviderFailure[]): string {
  return failures.map(describeFailure).join("; ");
}

/**
 * The note for a run that returned nothing while at least one source could not answer.
 *
 * `tail` is the sentence that says what this is NOT ("This is not the same as nobody matching
 * your criteria."). When the only reason is that no search source is connected on our side,
 * the customer gets that one plain sentence - it already says so, and tells them what to do.
 */
export function blockedByProvidersNote(failures: ProviderFailure[], tail: string, opening = "No leads were returned"): string {
  if (failures.length > 0 && failures.every(notConnected)) return NO_WEB_SEARCH_CONFIGURED;
  const which = failures.length === 1 ? "the data source we tried could not answer" : `${failures.length} data sources could not answer`;
  return `${opening}, and ${which}: ${listProviderFailures(failures)}. ${tail}`;
}
