/**
 * Provider call outcomes: telling a rejected key apart from an empty result.
 *
 * Every provider in this package used to collapse failure into absence - `if (!res.ok)
 * return null`, `catch {}` - so a 401 from a wrong key, a 403 from a plan that does not
 * include the endpoint, and a genuine "nobody matched that query" all looked identical
 * from the outside. The product then reported the provider as configured and healthy
 * while it was returning nothing, which is the same mistake as counting an AI engine's
 * refusal as absence: a configuration problem wearing a data problem's clothes.
 *
 * The distinction that matters most in practice is 401 against 403. A 401 means the key
 * is wrong and you should replace it. A 403 usually means the key is fine but the plan
 * does not include that endpoint, and replacing the key will not help - Apollo's People
 * Match on a lower tier behaves exactly this way.
 *
 * Like `meter()`, this lives in core with no DB dependency and reports through a hook that
 * apps/api wires at boot. A reporting failure must never break the call it describes.
 */

export type ProviderOutcome =
  /** The call succeeded. Says nothing about whether it returned any rows. */
  | "ok"
  /** 401: the credential was rejected. Replace the key. */
  | "auth"
  /** 403: authenticated but not permitted - usually a plan or scope limit, not a bad key. */
  | "forbidden"
  /** 429: rate limited or out of quota. */
  | "rate_limit"
  /** 404: endpoint or record not found. */
  | "not_found"
  /** 5xx: the provider broke, not us. */
  | "server"
  /** The request never completed: DNS, timeout, connection reset. */
  | "network"
  /** 2xx with a body we could not read as expected. */
  | "bad_response"
  /**
   * The credential and the plan are both fine; this particular QUERY is not supported.
   *
   * Serper's free tier refuses operator syntax - site:, quoted phrases, parentheses, OR -
   * with "Query pattern not allowed for free accounts." That is not a broken key and not a
   * dead provider, so it must not cool the provider off: the very next plain query will
   * succeed. It is still actionable, because the fix is a plan upgrade.
   */
  | "unsupported_query";

export interface ProviderCall {
  provider: string;
  outcome: ProviderOutcome;
  /** HTTP status when there was one. */
  status?: number;
  /** Short human explanation, safe to show an operator. Never contains the credential. */
  detail?: string;
}

/** Outcomes that mean an operator has something to fix, as opposed to a transient blip. */
export const ACTIONABLE: ProviderOutcome[] = ["auth", "forbidden", "rate_limit", "unsupported_query"];

export function isActionable(outcome: ProviderOutcome): boolean {
  return ACTIONABLE.includes(outcome);
}

type HealthHook = (call: ProviderCall) => void;
let hook: HealthHook = () => {};

export function setProviderHealthHook(fn: HealthHook) {
  hook = fn;
}

/** Fire-and-forget: reporting must never break the request it is describing. */
export function reportProviderCall(call: ProviderCall) {
  try {
    noteForSkipping(call);
    hook(call);
  } catch {
    // health reporting is best-effort by design
  }
}

/**
 * Trim a provider's error body to something an operator can act on.
 *
 * Bodies from these APIs are small JSON objects or short HTML error pages; either way the
 * first line is the useful part. Truncated hard because this is stored and displayed.
 */
function summarise(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const msg = parsed.error ?? parsed.message ?? parsed.error_message ?? parsed.errors ?? parsed.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
    if (Array.isArray(msg)) {
      const first = msg[0];
      if (typeof first === "string") return first.slice(0, 200);
      // Hunter nests it: { errors: [{ id, code, details }] }
      if (first && typeof first === "object") {
        const o = first as Record<string, unknown>;
        const nested = o.details ?? o.message ?? o.detail;
        if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 200);
      }
    }
    // Google nests it one level down: { error: { code, message } }
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      const nested = o.message ?? o.details ?? o.detail;
      if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 200);
    }
  } catch {
    // not JSON; fall through to the raw first line
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Does a 400's message actually describe a credential problem?
 *
 * Kept narrow on purpose. A 400 is normally a malformed request, and mislabelling those as
 * a bad key would send people to rotate a working credential - the exact failure this
 * module exists to prevent, just in the other direction.
 */
function looksLikeCredentialProblem(message: string): boolean {
  return /\b(api[\s_-]?key|credential|unauthori[sz]ed|authentication|auth token|access token|invalid[\s_-]?key)\b/i.test(message);
}

/** Map an HTTP response to an outcome plus an explanation worth storing. */
export function classifyHttp(status: number, body = ""): { outcome: ProviderOutcome; detail: string } {
  const summary = summarise(body);
  if (status >= 200 && status < 300) return { outcome: "ok", detail: "" };
  if (status === 401) {
    return { outcome: "auth", detail: summary || "credential rejected (401); the API key is wrong, expired or revoked" };
  }
  if (status === 403) {
    // A 403 usually is a plan limit - Apollo says so in words - and folding those into "auth"
    // would send someone to rotate a perfectly good key. But not every API uses 401 for a
    // rejected credential: Serper answers a bad key with 403 "Unauthorized.", and reporting
    // that as "the key is fine, upgrade your plan" is a worse lie than saying nothing, because
    // it points at a bill instead of at the one-line fix. So the body decides.
    if (looksLikeCredentialProblem(summary)) return { outcome: "auth", detail: summary };
    return { outcome: "forbidden", detail: summary || "authenticated but not permitted (403); usually the plan or key scope excludes this endpoint" };
  }
  if (status === 429) return { outcome: "rate_limit", detail: summary || "rate limited or out of quota (429)" };
  if (looksLikeUnsupportedQuery(summary)) {
    // Checked before the 400/403 branches, because the provider returns this as an ordinary
    // client error and reading it as a bad key or a dead plan would be wrong in both cases.
    return { outcome: "unsupported_query", detail: summary };
  }
  if (status === 400 && looksLikeCredentialProblem(summary)) {
    // Not every API uses 401 for a bad key. Google Programmable Search answers a rejected
    // key with 400 "API key not valid", verified against the live endpoint - reporting that
    // as an unexpected response would hide the single most common misconfiguration there.
    return { outcome: "auth", detail: summary };
  }
  if (status === 404) return { outcome: "not_found", detail: summary || "not found (404)" };
  if (status >= 500) return { outcome: "server", detail: summary || `provider error (${status})` };
  return { outcome: "bad_response", detail: summary || `unexpected status ${status}` };
}

/**
 * Does this message describe a query the plan will not run, rather than a broken credential?
 *
 * Narrow on purpose, for the same reason as looksLikeCredentialProblem: a false positive here
 * would tell someone their plan is the problem when their key is.
 */
function looksLikeUnsupportedQuery(message: string): boolean {
  return /query pattern not allowed|not allowed for free account|unsupported query|operator.{0,20}not (allowed|supported)/i.test(message);
}

/** Map a thrown fetch error to an outcome. Timeouts and DNS failures are not auth problems. */
export function classifyThrown(e: unknown): { outcome: ProviderOutcome; detail: string } {
  const msg = (e as Error)?.message ?? String(e);
  return { outcome: "network", detail: msg.slice(0, 200) };
}

/**
 * Record an HTTP response and return whether it was a success, so a call site can stay a
 * one-liner: `if (!ok(res, "apollo")) return null;`
 */
export async function recordHttp(provider: string, res: Response): Promise<boolean> {
  if (res.ok) {
    reportProviderCall({ provider, outcome: "ok", status: res.status });
    return true;
  }
  // Reading the body consumes it; callers on this path are not going to parse a failure.
  let body = "";
  try {
    body = await res.text();
  } catch {
    // some error responses have no readable body
  }
  const { outcome, detail } = classifyHttp(res.status, body);
  reportProviderCall({ provider, outcome, status: res.status, detail });
  return false;
}

/** Record a thrown error from a provider call. */
export function recordThrown(provider: string, e: unknown) {
  const { outcome, detail } = classifyThrown(e);
  reportProviderCall({ provider, outcome, detail });
}

/**
 * Short-lived skip list for providers that just rejected us.
 *
 * A provider returning 401 or 403 will return it again for the next request and the one
 * after. Google closed the Custom Search JSON API to new customers on 22 Sep 2026, so that
 * provider now 403s permanently while still sitting first in the search chain - without
 * this, every single search pays a round trip to a door that is never going to open.
 *
 * Deliberately time-boxed rather than permanent: plans get upgraded and keys get replaced,
 * and a process that refuses to retry would hide a fix. Deliberately in memory rather than
 * in the database: core has no DB dependency, and a restart re-probing once is correct.
 */
const SKIP_MS = 30 * 60 * 1000;
const skipUntil = new Map<string, number>();

/** True while a provider is in its cooling-off window after rejecting us. */
export function providerRecentlyRejected(provider: string, now = Date.now()): boolean {
  const until = skipUntil.get(provider);
  if (until === undefined) return false;
  if (now >= until) {
    skipUntil.delete(provider);
    return false;
  }
  return true;
}

/** Only credential and permission failures cool off; a timeout deserves an immediate retry. */
function noteForSkipping(call: ProviderCall, now = Date.now()) {
  // Deliberately excludes unsupported_query: the provider is healthy and the next query of a
  // different shape will work, so cooling it off would turn one rejected query into thirty
  // minutes of not using a provider that was never broken.
  if (call.outcome === "auth" || call.outcome === "forbidden") skipUntil.set(call.provider, now + SKIP_MS);
  else if (call.outcome === "ok") skipUntil.delete(call.provider);
}

/**
 * Providers that are closed for good, not merely failing.
 *
 * Distinct from the cooling-off map because the answer is different: a rejected key might be
 * replaced within the hour, but Google closing Custom Search to new customers is policy. A
 * retired provider sits first in the chain costing a round trip on every single search while
 * being incapable of ever answering, so it is dropped for the life of the process rather than
 * re-probed every half hour. A restart re-probes once, which is the right amount of optimism.
 */
const retired = new Map<string, string>();

export function retireProvider(provider: string, reason: string) {
  if (!retired.has(provider)) retired.set(provider, reason);
}

export function providerRetired(provider: string): boolean {
  return retired.has(provider);
}

export function retiredReason(provider: string): string | undefined {
  return retired.get(provider);
}

/** Testing seam: clears the cooling-off state. */
export function resetProviderSkips() {
  skipUntil.clear();
  retired.clear();
}

/** Human sentence for an outcome, used in the admin UI and in check results. */
export function explainOutcome(outcome: ProviderOutcome, detail?: string): string {
  const base: Record<ProviderOutcome, string> = {
    ok: "Working",
    auth: "Key rejected",
    forbidden: "Key works, endpoint not permitted on this plan",
    rate_limit: "Rate limited or out of quota",
    not_found: "Endpoint not found",
    server: "Provider is erroring",
    network: "Could not reach the provider",
    bad_response: "Unexpected response",
    unsupported_query: "Key works, but this query type needs a paid plan",
  };
  return detail ? `${base[outcome]}: ${detail}` : base[outcome];
}
