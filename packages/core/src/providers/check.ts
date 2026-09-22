/**
 * Provider connection checks.
 *
 * "Configured" has meant "the env var is non-empty", which is not the same as working and
 * is exactly the gap that let a wrong key sit in production looking green. These make one
 * real, deliberately cheap call per provider and report what actually came back.
 *
 * Design rules:
 *   - A check costs one request against the smallest possible query, because free tiers are
 *     measured in tens of calls a month and a diagnostic that eats the quota it is checking
 *     would be self-defeating.
 *   - Zero results is a pass. The question is whether the credential is accepted, not
 *     whether a made-up query matched anyone.
 *   - A 403 is reported as a distinct state rather than a failure, because the key is fine
 *     and the plan is the constraint. Apollo's People Match behaves this way on lower tiers.
 *   - The credential never appears in the result.
 */

import { fetchWithTimeout } from "../util/http.js";
import { classifyHttp, classifyThrown, explainOutcome, type ProviderOutcome } from "./health.js";

export interface ProviderCheck {
  provider: string;
  /** False when the env var is empty; nothing was called. */
  configured: boolean;
  outcome: ProviderOutcome | "not_configured";
  /** True only when the provider accepted the credential. */
  ok: boolean;
  status?: number;
  detail: string;
  /** One sentence an operator can act on. */
  summary: string;
  /** Which endpoint was exercised, so the result can be traced. */
  endpoint?: string;
  ms: number;
}

const TIMEOUT = 15_000;

function notConfigured(provider: string, envVar: string): ProviderCheck {
  return {
    provider,
    configured: false,
    outcome: "not_configured",
    ok: false,
    detail: `${envVar} is not set`,
    summary: `Not configured: set ${envVar}`,
    ms: 0,
  };
}

async function run(
  provider: string,
  endpoint: string,
  call: () => Promise<Response>,
): Promise<ProviderCheck> {
  const started = Date.now();
  try {
    const res = await call();
    const body = res.ok ? "" : await res.text().catch(() => "");
    const { outcome, detail } = classifyHttp(res.status, body);
    return {
      provider,
      configured: true,
      outcome,
      ok: outcome === "ok",
      status: res.status,
      detail,
      summary: explainOutcome(outcome, detail || undefined),
      endpoint,
      ms: Date.now() - started,
    };
  } catch (e) {
    const { outcome, detail } = classifyThrown(e);
    return {
      provider,
      configured: true,
      outcome,
      ok: false,
      detail,
      summary: explainOutcome(outcome, detail),
      endpoint,
      ms: Date.now() - started,
    };
  }
}

/** Apollo: one person-search page of a single row. */
export async function checkApollo(apiKey = process.env.APOLLO_API_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("apollo", "APOLLO_API_KEY");
  return run("apollo", "POST /api/v1/mixed_people/search", () =>
    fetchWithTimeout("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      timeoutMs: TIMEOUT,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ page: 1, per_page: 1 }),
    }),
  );
}

/**
 * Apollo enrichment, checked separately.
 *
 * Search and People Match are gated independently, so a single Apollo check would report
 * "working" while the enrichment half quietly 403s. Reported as its own line for that
 * reason: knowing which half you have is the actionable part.
 */
export async function checkApolloEnrich(apiKey = process.env.APOLLO_API_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("apollo-enrich", "APOLLO_API_KEY");
  const r = await run("apollo-enrich", "POST /api/v1/people/match", () =>
    fetchWithTimeout("https://api.apollo.io/api/v1/people/match?first_name=test&last_name=test&domain=example.com", {
      method: "POST",
      timeoutMs: TIMEOUT,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
    }),
  );
  // A match endpoint answering "nobody" for an invented person is a healthy endpoint.
  if (r.outcome === "not_found") return { ...r, ok: true, summary: "Working (no match for the probe, which is expected)" };
  return r;
}

/** Hunter: domain-search capped to one result. */
export async function checkHunter(apiKey = process.env.HUNTER_API_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("hunter", "HUNTER_API_KEY");
  return run("hunter", "GET /v2/domain-search", () =>
    fetchWithTimeout(`https://api.hunter.io/v2/domain-search?domain=example.com&limit=1&api_key=${encodeURIComponent(apiKey)}`, {
      timeoutMs: TIMEOUT,
    }),
  );
}

/** PDL: person enrich with a deliberately unmatchable identity. */
export async function checkPdl(apiKey = process.env.PDL_API_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("pdl", "PDL_API_KEY");
  const r = await run("pdl", "GET /v5/person/enrich", () =>
    fetchWithTimeout(
      `https://api.peopledatalabs.com/v5/person/enrich?api_key=${encodeURIComponent(apiKey)}&email=probe%40example.com&min_likelihood=10`,
      { timeoutMs: TIMEOUT },
    ),
  );
  // PDL answers 404 when nobody matches. That is the endpoint working.
  if (r.outcome === "not_found") return { ...r, ok: true, summary: "Working (no match for the probe, which is expected)" };
  return r;
}

/** Google Programmable Search: one result. */
export async function checkGoogleCse(
  apiKey = process.env.GOOGLE_CSE_API_KEY,
  cx = process.env.GOOGLE_CSE_CX,
): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("google_cse", "GOOGLE_CSE_API_KEY");
  if (!cx) return notConfigured("google_cse", "GOOGLE_CSE_CX");
  return run("google_cse", "GET /customsearch/v1", () =>
    fetchWithTimeout(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=test&num=1`,
      { timeoutMs: TIMEOUT },
    ),
  );
}

/** SerpAPI, when configured as the paid search fallback. */
export async function checkSerpApi(apiKey = process.env.SERPAPI_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("serpapi", "SERPAPI_KEY");
  return run("serpapi", "GET /search.json", () =>
    fetchWithTimeout(`https://serpapi.com/search.json?q=test&num=1&api_key=${encodeURIComponent(apiKey)}`, { timeoutMs: TIMEOUT }),
  );
}

/** Resend, for transactional and outbound email. */
export async function checkResend(apiKey = process.env.RESEND_API_KEY): Promise<ProviderCheck> {
  if (!apiKey) return notConfigured("resend", "RESEND_API_KEY");
  return run("resend", "GET /domains", () =>
    fetchWithTimeout("https://api.resend.com/domains", { timeoutMs: TIMEOUT, headers: { authorization: `Bearer ${apiKey}` } }),
  );
}

export const PROVIDER_CHECKS: { provider: string; label: string; run: () => Promise<ProviderCheck> }[] = [
  { provider: "apollo", label: "Apollo (people search)", run: () => checkApollo() },
  { provider: "apollo-enrich", label: "Apollo (people match)", run: () => checkApolloEnrich() },
  { provider: "hunter", label: "Hunter.io", run: () => checkHunter() },
  { provider: "pdl", label: "People Data Labs", run: () => checkPdl() },
  { provider: "google_cse", label: "Google Programmable Search", run: () => checkGoogleCse() },
  { provider: "serpapi", label: "SerpAPI", run: () => checkSerpApi() },
  { provider: "resend", label: "Resend", run: () => checkResend() },
];

/**
 * Run every check concurrently.
 *
 * One provider being down must not stop the others being reported; a settled result per
 * provider is the whole point of the page this feeds.
 */
export async function checkAllProviders(): Promise<ProviderCheck[]> {
  const results = await Promise.allSettled(PROVIDER_CHECKS.map((c) => c.run()));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          provider: PROVIDER_CHECKS[i].provider,
          configured: true,
          outcome: "network" as const,
          ok: false,
          detail: (r.reason as Error)?.message?.slice(0, 200) ?? "check failed",
          summary: "Check could not be completed",
          ms: 0,
        },
  );
}
