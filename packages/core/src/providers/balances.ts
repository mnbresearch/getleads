/**
 * How much is left on each paid data provider.
 *
 * The question an operator actually asks before a campaign is not "is the key valid" (see
 * check.ts) but "will this run out halfway through". Every provider here is asked through
 * its own account or balance endpoint, which costs nothing - a balance check that spent the
 * balance it was reporting would be absurd.
 *
 * Where a provider has no such endpoint, that is said plainly (`no_endpoint`) with where to
 * look instead. It is never reported as zero, and never as unlimited: both would be a
 * number we made up.
 *
 * The credential never appears in the result.
 */

import { fetchWithTimeout } from "../util/http.js";
import { readSecret } from "../util/secret.js";
import { classifyHttp, classifyThrown, explainOutcome } from "./health.js";

export type BalanceStatus = "ok" | "error" | "not_configured" | "no_endpoint";

export interface BalanceLine {
  /** What this number counts, e.g. "searches", "verifications". */
  label: string;
  remaining: number | null;
  used: number | null;
  limit: number | null;
}

export interface ProviderBalance {
  provider: string;
  /** Human name. */
  name: string;
  /** What the provider is used for in this product. */
  role: string;
  configured: boolean;
  status: BalanceStatus;
  lines: BalanceLine[];
  resetsAt: string | null;
  /** How the provider bills: shown next to the balance so a low number reads correctly. */
  billing: string;
  /** One sentence an operator can act on. */
  summary: string;
  /** Low enough that a normal run could exhaust it. */
  low: boolean;
  checkedAt: string;
}

const TIMEOUT = 12_000;
const now = () => new Date().toISOString();
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

interface Spec {
  provider: string;
  name: string;
  role: string;
  env: string;
  billing: string;
  /** Remaining below this on the primary line is flagged low. */
  lowAt: number;
  fetch?: (key: string) => Promise<{ lines: BalanceLine[]; resetsAt?: string | null }>;
  /** When there is no balance endpoint: where the operator should look. */
  lookAt?: string;
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchWithTimeout(url, { ...init, timeoutMs: TIMEOUT });
  const text = await res.text();
  if (!res.ok) {
    const { outcome, detail } = classifyHttp(res.status, text);
    throw Object.assign(new Error(explainOutcome(outcome, detail || undefined)), { outcome });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The provider answered with something that was not JSON.");
  }
}

const SPECS: Spec[] = [
  {
    provider: "hunter",
    name: "Hunter",
    role: "Email finding (and verification if no dedicated verifier is set)",
    env: "HUNTER_API_KEY",
    billing: "Monthly plan, or Data Platform credit packs valid 12 months",
    lowAt: 100,
    async fetch(key) {
      const j = (await getJson(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`)) as {
        data?: { reset_date?: string; requests?: Record<string, { used?: number; available?: number; remaining?: number }> };
      };
      const req = j.data?.requests ?? {};
      const line = (label: string, k: string): BalanceLine => {
        const r = req[k] ?? {};
        const used = num(r.used);
        const available = num(r.available);
        // `available` is the allowance, not what is left. Older responses have no
        // `remaining`, so it is derived rather than assumed.
        const remaining = num(r.remaining) ?? (available !== null && used !== null ? Math.max(0, available - used) : null);
        return { label, remaining, used, limit: available };
      };
      const lines = [line("credits", "credits"), line("searches", "searches"), line("verifications", "verifications")].filter((l) => l.limit !== null || l.remaining !== null);
      return { lines, resetsAt: j.data?.reset_date ?? null };
    },
  },
  {
    provider: "reoon",
    name: "Reoon",
    role: "Email verification (first choice)",
    env: "REOON_API_KEY",
    billing: "Pay-as-you-go credits that never expire, plus a small daily allowance",
    lowAt: 500,
    async fetch(key) {
      const j = (await getJson(`https://emailverifier.reoon.com/api/v1/check-account-balance/?key=${encodeURIComponent(key)}`)) as {
        remaining_daily_credits?: number | string;
        remaining_instant_credits?: number | string;
        status?: string;
        api_status?: string;
      };
      if (j.status && j.status !== "success") throw new Error(`Reoon reported "${j.status}".`);
      return {
        lines: [
          { label: "instant credits", remaining: num(j.remaining_instant_credits), used: null, limit: null },
          { label: "daily credits", remaining: num(j.remaining_daily_credits), used: null, limit: null },
        ],
      };
    },
  },
  {
    provider: "millionverifier",
    name: "MillionVerifier",
    role: "Email verification (second choice)",
    env: "MILLIONVERIFIER_API_KEY",
    billing: "Pay-as-you-go credits that never expire",
    lowAt: 500,
    async fetch(key) {
      const j = (await getJson(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(key)}`)) as {
        credits?: number;
        bulk_credits?: number;
        error?: string;
      };
      // Like its verify endpoint, this answers 200 with an `error` field for a bad key.
      if (j.error) throw new Error(`MillionVerifier: ${j.error}`);
      return {
        lines: [
          { label: "credits", remaining: num(j.credits), used: null, limit: null },
          { label: "bulk credits", remaining: num(j.bulk_credits), used: null, limit: null },
        ],
      };
    },
  },
  {
    provider: "serpapi",
    name: "SerpAPI",
    role: "Web search for company discovery",
    env: "SERPAPI_KEY",
    billing: "Monthly plan; unused searches do not roll over",
    lowAt: 100,
    async fetch(key) {
      const j = (await getJson(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`)) as {
        total_searches_left?: number;
        plan_searches_left?: number;
        this_month_usage?: number;
        searches_per_month?: number;
      };
      return {
        lines: [{ label: "searches", remaining: num(j.total_searches_left ?? j.plan_searches_left), used: num(j.this_month_usage), limit: num(j.searches_per_month) }],
      };
    },
  },
  {
    provider: "apollo",
    name: "Apollo",
    role: "People search and enrichment",
    env: "APOLLO_API_KEY",
    billing: "Monthly per-seat plan",
    lowAt: 100,
    async fetch(key) {
      const j = (await getJson("https://api.apollo.io/api/v1/usage_stats/credit_usage_stats", {
        method: "POST",
        headers: { "content-type": "application/json", "cache-control": "no-cache", "x-api-key": key },
        body: "{}",
      })) as Record<string, unknown>;
      // Shape varies by plan: a map of credit type to { limit, consumed, left_over }.
      const lines: BalanceLine[] = [];
      const walk = (label: string, v: unknown) => {
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        if ("left_over" in o || "limit" in o || "consumed" in o) {
          lines.push({ label: label.replace(/_/g, " "), remaining: num(o.left_over), used: num(o.consumed), limit: num(o.limit) });
          return;
        }
        for (const [k, vv] of Object.entries(o)) walk(k, vv);
      };
      walk("credits", j);
      if (lines.length === 0) throw new Error("Apollo answered, but not with credit balances. This endpoint needs a master API key.");
      return { lines };
    },
  },
  {
    provider: "ipinfo",
    name: "IPinfo",
    role: "Website visitor IP lookup",
    env: "IPINFO_TOKEN",
    billing: "Monthly plan; company names need the Enterprise tier",
    lowAt: 1000,
    async fetch(key) {
      const j = (await getJson(`https://ipinfo.io/me?token=${encodeURIComponent(key)}`)) as {
        requests?: { day?: number; month?: number; limit?: number; remaining?: number };
      };
      const r = j.requests ?? {};
      return { lines: [{ label: "requests this month", remaining: num(r.remaining), used: num(r.month), limit: num(r.limit) }] };
    },
  },
  // No balance endpoint. Listed so the page is complete, and so a missing number reads as
  // "look in their dashboard" rather than as nothing.
  { provider: "serper", name: "Serper", role: "Web search for company discovery", env: "SERPER_API_KEY", billing: "Prepaid credit packs, valid 6 months", lowAt: 0, lookAt: "serper.dev dashboard" },
  { provider: "brave", name: "Brave Search", role: "Web search for company discovery", env: "BRAVE_SEARCH_API_KEY", billing: "Metered per search, with a monthly free credit", lowAt: 0, lookAt: "api-dashboard.search.brave.com" },
  { provider: "pdl", name: "People Data Labs", role: "Person enrichment", env: "PDL_API_KEY", billing: "Monthly plan", lowAt: 0, lookAt: "dashboard.peopledatalabs.com (a balance check would spend a credit)" },
  { provider: "groq", name: "Groq", role: "AI scoring and writing", env: "GROQ_API_KEY", billing: "Metered per token on your card", lowAt: 0, lookAt: "console.groq.com" },
  { provider: "gemini", name: "Gemini", role: "AI, and AI-visibility answers", env: "GEMINI_API_KEY", billing: "Metered per token through Google billing", lowAt: 0, lookAt: "Google AI Studio / Cloud billing" },
  { provider: "resend", name: "Resend", role: "Sending email", env: "RESEND_API_KEY", billing: "Free tier, then monthly", lowAt: 0, lookAt: "resend.com dashboard" },
  { provider: "google_cse", name: "Google Custom Search", role: "Web search (legacy)", env: "GOOGLE_CSE_API_KEY", billing: "Metered; closed to new customers, ends 1 Jan 2027", lowAt: 0, lookAt: "Google Cloud console" },
];

async function one(spec: Spec): Promise<ProviderBalance> {
  const base = { provider: spec.provider, name: spec.name, role: spec.role, billing: spec.billing, checkedAt: now() };
  const { value: key } = readSecret(process.env[spec.env]);
  if (!key) {
    return { ...base, configured: false, status: "not_configured", lines: [], resetsAt: null, low: false, summary: `Not set up. Add ${spec.env} to enable it.` };
  }
  if (!spec.fetch) {
    return { ...base, configured: true, status: "no_endpoint", lines: [], resetsAt: null, low: false, summary: `Configured. ${spec.name} has no balance API - check ${spec.lookAt}.` };
  }
  try {
    const { lines, resetsAt } = await spec.fetch(key);
    const primary = lines.find((l) => l.remaining !== null);
    const low = primary?.remaining !== null && primary?.remaining !== undefined && primary.remaining < spec.lowAt;
    const summary = primary
      ? `${primary.remaining!.toLocaleString("en-US")} ${primary.label} left${low ? " - low, top up before a large run" : ""}.`
      : "Answered, but reported no balance figures.";
    return { ...base, configured: true, status: "ok", lines, resetsAt: resetsAt ?? null, low, summary };
  } catch (e) {
    const { detail } = classifyThrown(e);
    const msg = (e as Error)?.message || detail;
    return { ...base, configured: true, status: "error", lines: [], resetsAt: null, low: false, summary: `Could not read the balance: ${msg}` };
  }
}

/** Every provider, concurrently. One failing never hides the others. */
export async function checkAllBalances(): Promise<ProviderBalance[]> {
  const settled = await Promise.allSettled(SPECS.map(one));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          provider: SPECS[i].provider,
          name: SPECS[i].name,
          role: SPECS[i].role,
          billing: SPECS[i].billing,
          configured: true,
          status: "error" as const,
          lines: [],
          resetsAt: null,
          low: false,
          summary: "The balance check itself failed.",
          checkedAt: now(),
        },
  );
}
