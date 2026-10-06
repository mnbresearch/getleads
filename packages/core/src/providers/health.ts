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
import { redact } from "../ai/redact.js";

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
  | "unsupported_query"
  /**
   * The credential is fine and the account has run out of paid credit: HTTP 402, or a body
   * that says "not enough credits" / "run out of searches" whatever the status code.
   *
   * Used to land in bad_response ("Unexpected response"), which is not actionable and so
   * never alerted - while every call to that provider kept failing until somebody happened to
   * open the admin page. Topping up is the fix, and it is the operator's to make.
   */
  | "out_of_credit";

export interface ProviderCall {
  provider: string;
  outcome: ProviderOutcome;
  /** HTTP status when there was one. */
  status?: number;
  /** Short human explanation, safe to show an operator. Never contains the credential. */
  detail?: string;
}

/** Outcomes that mean an operator has something to fix, as opposed to a transient blip. */
export const ACTIONABLE: ProviderOutcome[] = ["auth", "forbidden", "rate_limit", "unsupported_query", "out_of_credit"];

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
    // The detail is stored (provider health, `last_detail`) and shown in the admin UI. It is
    // built from upstream error text, which echoes keys and account ids, so it is masked at
    // the one place every report passes through - whoever built it.
    hook(call.detail ? { ...call, detail: redact(call.detail, { max: 300 }) } : call);
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
  const r = classifyHttpRaw(status, body);
  // Classification reads the provider's own words; what is RETURNED has credentials masked.
  return { outcome: r.outcome, detail: redact(r.detail, { max: 200 }) };
}

function classifyHttpRaw(status: number, body = ""): { outcome: ProviderOutcome; detail: string } {
  const summary = summarise(body);
  if (status >= 200 && status < 300) return { outcome: "ok", detail: "" };
  // Ahead of 401/403/429 on purpose: providers disagree on which code means "no credit left"
  // (SerpAPI uses 429, Serper 400, Hunter 403), but the words in the body are consistent and
  // the operator action - top up - is the same for all of them.
  if (status === 402 || looksLikeOutOfCredit(summary)) {
    return { outcome: "out_of_credit", detail: summary || `out of credit (${status}); top up or upgrade the plan` };
  }
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

/**
 * Does this message say the account has no credit left, as opposed to a rate limit?
 *
 * Narrow, for the same reason as the other two: "quota" alone is left out because Google uses
 * it for per-minute limits that clear on their own.
 */
export function looksLikeOutOfCredit(message: string): boolean {
  return /not enough credits?|insufficient (credits?|balance|funds)|out of credits?|no (more )?credits?( left| remaining)?\b|credits? (exhausted|depleted)|run out of (searches|credits?)|payment required|top ?up/i.test(message);
}

/** Map a thrown fetch error to an outcome. Timeouts and DNS failures are not auth problems. */
export function classifyThrown(e: unknown): { outcome: ProviderOutcome; detail: string } {
  const msg = (e as Error)?.message ?? String(e);
  // A fetch error can carry the request URL, and some providers take the key in the query.
  return { outcome: "network", detail: redact(msg, { max: 200 }) };
}

/**
 * A provider could not answer, as distinct from answering with nothing.
 *
 * Search providers returned `[]` for both, which defeated webSearch's own guard against
 * caching an outage: that guard counts providers which THREW, and the providers do not
 * throw on an HTTP failure. So a 429 or a 5xx from every configured provider produced a
 * clean empty result set, was cached, and was served to the user as "nobody matched that
 * query" - the exact failure-as-absence bug the guard was written to prevent, walking
 * straight past it.
 *
 * The outcome has already been reported to health by the time this is thrown, so webSearch
 * does not report it a second time.
 */
export class ProviderUnavailableError extends Error {
  constructor(public provider: string, public outcome: ProviderOutcome, message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
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
/**
 * A 429 cools off too, but briefly. Hammering a rate-limited provider on every search only
 * extends the limit and burns the request budget proving it again; a couple of minutes is
 * long enough for a per-minute window to clear and short enough that a daily cap lifting
 * is noticed quickly.
 */
export const RATE_LIMIT_COOL_MS = 2 * 60 * 1000;
const skipUntil = new Map<string, number>();
const skipReason = new Map<string, ProviderOutcome>();

/** True while a provider is in its cooling-off window after rejecting us. */
export function providerRecentlyRejected(provider: string, now = Date.now()): boolean {
  const until = skipUntil.get(provider);
  if (until === undefined) return false;
  if (now >= until) {
    skipUntil.delete(provider);
    skipReason.delete(provider);
    return false;
  }
  return true;
}

/** Why a provider is cooling off, and until when - so a skipped provider can say why. */
export function providerCoolOff(provider: string, now = Date.now()): { outcome: ProviderOutcome; until: number } | null {
  if (!providerRecentlyRejected(provider, now)) return null;
  return { outcome: skipReason.get(provider) ?? "auth", until: skipUntil.get(provider)! };
}

/** Credential, permission and credit failures cool off for long; a 429 briefly; a timeout deserves an immediate retry. */
function noteForSkipping(call: ProviderCall, now = Date.now()) {
  // Deliberately excludes unsupported_query: the provider is healthy and the next query of a
  // different shape will work, so cooling it off would turn one rejected query into thirty
  // minutes of not using a provider that was never broken.
  if (call.outcome === "auth" || call.outcome === "forbidden" || call.outcome === "out_of_credit") {
    skipUntil.set(call.provider, now + SKIP_MS);
    skipReason.set(call.provider, call.outcome);
  } else if (call.outcome === "rate_limit") {
    // Never shortens a longer window already running for a worse reason.
    const until = now + RATE_LIMIT_COOL_MS;
    if ((skipUntil.get(call.provider) ?? 0) < until) {
      skipUntil.set(call.provider, until);
      skipReason.set(call.provider, "rate_limit");
    }
  } else if (call.outcome === "ok") {
    skipUntil.delete(call.provider);
    skipReason.delete(call.provider);
  }
}

/**
 * Rest a provider for a stated time, for a reason its caller knows and an outcome alone
 * does not say.
 *
 * A timeout normally deserves an immediate retry (see noteForSkipping), and for a keyed API
 * that is right. A keyless scraper that answers with a bot challenge, or whose two endpoints
 * both time out in one search, will do exactly the same for the next search and the one
 * after: without this it was asked twice per search for a whole run, ten seconds each time.
 * Never shortens a window already running. A later success clears it, as for any provider.
 */
export function coolOffProvider(provider: string, outcome: ProviderOutcome, ms: number, now = Date.now()) {
  if (!(ms > 0)) return;
  const until = now + ms;
  if ((skipUntil.get(provider) ?? 0) < until) {
    skipUntil.set(provider, until);
    skipReason.set(provider, outcome);
  }
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
  skipReason.clear();
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
    out_of_credit: "Out of credit - top up or upgrade the plan",
  };
  return detail ? `${base[outcome]}: ${detail}` : base[outcome];
}
