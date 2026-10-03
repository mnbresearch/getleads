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
import { readSecret, describeSecretShape, type SecretShape } from "../util/secret.js";
import { classifyHttp, classifyThrown, explainOutcome, looksLikeOutOfCredit, type ProviderOutcome } from "./health.js";

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
  /**
   * What the stored credential looked like: length, and whether quotes or whitespace had to
   * be stripped off it. Never the credential. Present only when a key was configured.
   *
   * This exists because "the key is definitely correct" and "the provider rejects the key"
   * are both usually true at once - the value is right and the thing we send is not.
   */
  keyShape?: SecretShape;
  /** One sentence about keyShape, safe to display. */
  keyNote?: string;
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
  shape: SecretShape | null = null,
): Promise<ProviderCheck> {
  const started = Date.now();
  const keyBits = shape ? { keyShape: shape, keyNote: describeSecretShape(shape) } : {};
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
      // When a credential is refused, the shape of the stored value is the next thing worth
      // knowing, so it goes in the sentence rather than three clicks away.
      summary:
        outcome === "auth" || outcome === "forbidden"
          ? `${explainOutcome(outcome, detail || undefined)}${keyBits.keyNote ? ` - ${keyBits.keyNote}` : ""}`
          : explainOutcome(outcome, detail || undefined),
      endpoint,
      ...keyBits,
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
      ...keyBits,
      ms: Date.now() - started,
    };
  }
}

/** Read a JSON body without consuming the response run() still has to classify. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.clone().text());
  } catch {
    return null;
  }
}

/** A key that authenticates on an account with nothing left to spend. */
function outOfCredit(r: ProviderCheck, detail: string): ProviderCheck {
  return { ...r, ok: false, outcome: "out_of_credit", detail, summary: explainOutcome("out_of_credit", detail) };
}

/** Apollo: one person-search page of a single row. */
export async function checkApollo(raw = process.env.APOLLO_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("apollo", "APOLLO_API_KEY");
  return run("apollo", "POST /api/v1/mixed_people/search", () =>
    fetchWithTimeout("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      timeoutMs: TIMEOUT,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ page: 1, per_page: 1 }),
    }),
    shape,
  );
}

/**
 * Apollo enrichment, checked separately.
 *
 * Search and People Match are gated independently, so a single Apollo check would report
 * "working" while the enrichment half quietly 403s. Reported as its own line for that
 * reason: knowing which half you have is the actionable part.
 */
export async function checkApolloEnrich(raw = process.env.APOLLO_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("apollo-enrich", "APOLLO_API_KEY");
  const r = await run("apollo-enrich", "POST /api/v1/people/match", () =>
    fetchWithTimeout("https://api.apollo.io/api/v1/people/match?first_name=test&last_name=test&domain=example.com", {
      method: "POST",
      timeoutMs: TIMEOUT,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
    }),
    shape,
  );
  // A match endpoint answering "nobody" for an invented person is a healthy endpoint.
  if (r.outcome === "not_found") return { ...r, ok: true, summary: "Working (no match for the probe, which is expected)" };
  return r;
}

/**
 * Hunter: the account endpoint, which is free.
 *
 * Was a one-row domain search, which spends a search credit out of a free plan measured in
 * tens per month every time someone opened the admin page. /v2/account proves the key
 * without spending anything, and an exhausted plan is reported rather than read as working.
 */
export async function checkHunter(raw = process.env.HUNTER_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("hunter", "HUNTER_API_KEY");
  let left: number | null = null;
  const r = await run("hunter", "GET /v2/account", async () => {
    const res = await fetchWithTimeout(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(apiKey)}`, { timeoutMs: TIMEOUT });
    const j = (await readJson(res)) as { data?: { requests?: { searches?: { used?: number; available?: number }; credits?: { used?: number; available?: number } } } } | null;
    const c = j?.data?.requests?.credits ?? j?.data?.requests?.searches;
    if (c && typeof c.available === "number" && typeof c.used === "number") left = Math.max(0, c.available - c.used);
    return res;
  }, shape);
  if (r.ok && left === 0) return outOfCredit(r, "no Hunter credits left this period");
  return r;
}

/** PDL: person enrich with a deliberately unmatchable identity. */
export async function checkPdl(raw = process.env.PDL_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("pdl", "PDL_API_KEY");
  const r = await run("pdl", "GET /v5/person/enrich", () =>
    fetchWithTimeout(
      `https://api.peopledatalabs.com/v5/person/enrich?api_key=${encodeURIComponent(apiKey)}&email=probe%40example.com&min_likelihood=10`,
      { timeoutMs: TIMEOUT },
    ),
    shape,
  );
  // PDL answers 404 when nobody matches. That is the endpoint working.
  if (r.outcome === "not_found") return { ...r, ok: true, summary: "Working (no match for the probe, which is expected)" };
  return r;
}

/**
 * Reoon: the balance endpoint, which is free and still proves the key.
 *
 * Reoon answers a bad key with HTTP 200 and `{"status":"error","reason":...}`, so judging by
 * the status code reported a rejected key as working. The body decides.
 */
export async function checkReoon(raw = process.env.REOON_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("reoon", "REOON_API_KEY");
  type ReoonBalance = { status?: string; reason?: string; remaining_daily_credits?: number | string; remaining_instant_credits?: number | string };
  const got: { body: ReoonBalance | null } = { body: null };
  const r = await run("reoon", "GET /api/v1/check-account-balance/", async () => {
    const res = await fetchWithTimeout(`https://emailverifier.reoon.com/api/v1/check-account-balance/?key=${encodeURIComponent(apiKey)}`, { timeoutMs: TIMEOUT });
    got.body = (await readJson(res)) as ReoonBalance | null;
    return res;
  }, shape);
  if (!r.ok) return r;
  const b = got.body;
  if (!b) return { ...r, ok: false, outcome: "bad_response", detail: "200 with a body that is not JSON", summary: explainOutcome("bad_response", "200 with a body that is not JSON") };
  if (b.status && b.status !== "success") {
    const reason = (b.reason ?? b.status).slice(0, 200);
    if (looksLikeOutOfCredit(reason)) return outOfCredit(r, reason);
    return { ...r, ok: false, outcome: "auth", detail: reason, summary: `${explainOutcome("auth", reason)}${r.keyNote ? ` - ${r.keyNote}` : ""}` };
  }
  const daily = Number(b.remaining_daily_credits ?? NaN);
  const instant = Number(b.remaining_instant_credits ?? NaN);
  if (daily === 0 && instant === 0) return outOfCredit(r, "no Reoon credits left (daily and instant both 0)");
  return r;
}

/**
 * MillionVerifier: the credits endpoint, free.
 *
 * It answers HTTP 200 with an `error` field for a bad key, so the status code alone would
 * report a rejected key as working. The body is read before declaring success.
 */
export async function checkMillionVerifier(raw = process.env.MILLIONVERIFIER_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("millionverifier", "MILLIONVERIFIER_API_KEY");
  let bodyError: string | null = null;
  const r = await run("millionverifier", "GET /api/v3/credits", async () => {
    const res = await fetchWithTimeout(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(apiKey)}`, { timeoutMs: TIMEOUT });
    const text = await res.clone().text().catch(() => "");
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) bodyError = j.error;
    } catch {
      /* not JSON: run() classifies by status */
    }
    return res;
  }, shape);
  if (r.ok && bodyError) return { ...r, ok: false, outcome: "auth", detail: bodyError, summary: `Key rejected: ${bodyError}` };
  return r;
}

/** Google Programmable Search: one result. */
export async function checkGoogleCse(
  rawKey = process.env.GOOGLE_CSE_API_KEY,
  rawCx = process.env.GOOGLE_CSE_CX,
): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(rawKey);
  const cx = readSecret(rawCx).value;
  if (!apiKey) return notConfigured("google_cse", "GOOGLE_CSE_API_KEY");
  if (!cx) return notConfigured("google_cse", "GOOGLE_CSE_CX");
  return run("google_cse", "GET /customsearch/v1", () =>
    fetchWithTimeout(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=test&num=1`,
      { timeoutMs: TIMEOUT },
    ),
    shape,
  );
}

/**
 * Serper, the primary paid search provider since Google closed Custom Search to new customers.
 *
 * Costs one credit out of the 2,500 free ones, which is the cheapest honest way to prove the
 * key works.
 */
export async function checkSerper(raw = process.env.SERPER_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("serper", "SERPER_API_KEY");
  return run("serper", "POST /search", () =>
    fetchWithTimeout("https://google.serper.dev/search", {
      method: "POST",
      timeoutMs: TIMEOUT,
      headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: "test", num: 1 }),
    }),
    shape,
  );
}

/**
 * SerpAPI, when configured as the paid search fallback.
 *
 * Uses account.json, which SerpAPI does not bill. The old probe ran a real search, spending
 * one of 100 free monthly searches on every check.
 */
export async function checkSerpApi(raw = process.env.SERPAPI_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("serpapi", "SERPAPI_KEY");
  let left: number | null = null;
  const r = await run("serpapi", "GET /account.json", async () => {
    const res = await fetchWithTimeout(`https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`, { timeoutMs: TIMEOUT });
    const j = (await readJson(res)) as { total_searches_left?: number; plan_searches_left?: number } | null;
    const n = j?.total_searches_left ?? j?.plan_searches_left;
    if (typeof n === "number") left = n;
    return res;
  }, shape);
  if (r.ok && left === 0) return outOfCredit(r, "no SerpAPI searches left this month");
  return r;
}

/**
 * Brave Search. There is no free account endpoint, so this costs one query (count=1) - the
 * cheapest honest proof the key works. Brave has had no free tier since Feb 2026.
 */
export async function checkBrave(raw = process.env.BRAVE_SEARCH_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("brave", "BRAVE_SEARCH_API_KEY");
  return run("brave", "GET /res/v1/web/search", () =>
    fetchWithTimeout("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
      timeoutMs: TIMEOUT,
      headers: { "x-subscription-token": apiKey, accept: "application/json" },
    }),
    shape,
  );
}

/**
 * Resend, for transactional and outbound email.
 *
 * Probing GET /domains is the only read that costs nothing, but a send-only key cannot
 * reach it and Resend answers 401 - which looked identical to a bad key. A send-only key
 * is the correct production setup, so reporting it as rejected would send someone to
 * replace a properly scoped credential. Resend names the reason in the body, so the
 * restriction is recognised rather than guessed at.
 */
const SEND_ONLY = /restricted to only send|sending access|only send emails/i;

export async function checkResend(raw = process.env.RESEND_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("resend", "RESEND_API_KEY");
  const r = await run("resend", "GET /domains", () =>
    fetchWithTimeout("https://api.resend.com/domains", { timeoutMs: TIMEOUT, headers: { authorization: `Bearer ${apiKey}` } }),
    shape,
  );
  if (r.outcome === "auth" && SEND_ONLY.test(r.detail)) {
    return { ...r, outcome: "ok", ok: true, summary: "Working (send-only key, which is the recommended setup)" };
  }
  return r;
}

/**
 * Groq: the model list. A free, read-only call that needs a valid key and spends no tokens.
 */
export async function checkGroq(raw = process.env.GROQ_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("groq", "GROQ_API_KEY");
  return run("groq", "GET /openai/v1/models", () =>
    fetchWithTimeout("https://api.groq.com/openai/v1/models", { timeoutMs: TIMEOUT, headers: { authorization: `Bearer ${apiKey}` } }),
    shape,
  );
}

/**
 * Gemini: the model list (one row). Free and read-only. Google answers a bad key with 400
 * "API key not valid", which classifyHttp reads as a rejected key rather than a bad request.
 */
export async function checkGemini(raw = process.env.GEMINI_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("gemini", "GEMINI_API_KEY");
  return run("gemini", "GET /v1beta/models", () =>
    // The key goes in a header, not the URL, so it cannot end up in a proxy or error log.
    fetchWithTimeout("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { timeoutMs: TIMEOUT, headers: { "x-goog-api-key": apiKey } }),
    shape,
  );
}

/** Anthropic: the model list. Free and read-only; no tokens are generated. */
export async function checkAnthropic(raw = process.env.ANTHROPIC_API_KEY): Promise<ProviderCheck> {
  const { value: apiKey, shape } = readSecret(raw);
  if (!apiKey) return notConfigured("anthropic", "ANTHROPIC_API_KEY");
  return run("anthropic", "GET /v1/models", () =>
    fetchWithTimeout("https://api.anthropic.com/v1/models?limit=1", { timeoutMs: TIMEOUT, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } }),
    shape,
  );
}

/** ipinfo: the account endpoint, which does not count as a lookup. */
export async function checkIpinfo(raw = process.env.IPINFO_TOKEN): Promise<ProviderCheck> {
  const { value: token, shape } = readSecret(raw);
  if (!token) return notConfigured("ipinfo", "IPINFO_TOKEN");
  return run("ipinfo", "GET /me", () =>
    // Same call the "Credits left" page already makes for this provider.
    fetchWithTimeout(`https://ipinfo.io/me?token=${encodeURIComponent(token)}`, { timeoutMs: TIMEOUT, headers: { accept: "application/json" } }),
    shape,
  );
}

/**
 * Providers that hold a key but are deliberately NOT part of "Test all keys", with the reason
 * an operator is shown. A check is only added where the provider offers a free call with no
 * side effects; for these, the only way to prove the key is to spend quota or send something.
 * Listed so the summary can say what it did not test instead of implying it tested everything.
 */
export const UNTESTED_PROVIDERS: Record<string, { envVar: string; reason: string }> = {
  abstract_email: { envVar: "ABSTRACT_EMAIL_API_KEY", reason: "Abstract has no free account endpoint: every call validates an address and uses one of the monthly validations." },
  whatsapp_cloud: { envVar: "WHATSAPP_ACCESS_TOKEN", reason: "The WhatsApp Cloud API has no read-only call that proves the token without the phone number it sends from; it is only exercised by sending a message." },
};

export const PROVIDER_CHECKS: { provider: string; label: string; run: () => Promise<ProviderCheck> }[] = [
  { provider: "apollo", label: "Apollo (people search)", run: () => checkApollo() },
  { provider: "apollo-enrich", label: "Apollo (people match)", run: () => checkApolloEnrich() },
  { provider: "hunter", label: "Hunter.io", run: () => checkHunter() },
  { provider: "pdl", label: "People Data Labs", run: () => checkPdl() },
  { provider: "google_cse", label: "Google Programmable Search", run: () => checkGoogleCse() },
  { provider: "serper", label: "Serper", run: () => checkSerper() },
  { provider: "serpapi", label: "SerpAPI", run: () => checkSerpApi() },
  { provider: "brave", label: "Brave Search", run: () => checkBrave() },
  { provider: "resend", label: "Resend", run: () => checkResend() },
  { provider: "reoon", label: "Reoon (verification)", run: () => checkReoon() },
  { provider: "millionverifier", label: "MillionVerifier (verification)", run: () => checkMillionVerifier() },
  { provider: "groq", label: "Groq (AI)", run: () => checkGroq() },
  { provider: "gemini", label: "Google Gemini (AI)", run: () => checkGemini() },
  { provider: "anthropic", label: "Anthropic Claude (AI)", run: () => checkAnthropic() },
  { provider: "ipinfo", label: "ipinfo.io", run: () => checkIpinfo() },
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
