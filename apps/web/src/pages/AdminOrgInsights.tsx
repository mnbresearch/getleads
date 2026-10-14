import { fmtDate, fmtNum } from "../lib/api";

/**
 * The extra sections of the workspace panel in the admin console: what the workspace holds,
 * when it was last used, how its email is doing, its integrations and senders, and its most
 * recent security events. Fed by the additive fields of GET /v1/admin/orgs/:id; an older
 * server sends none of them and nothing here is shown.
 */

type Counts = Partial<Record<"members" | "leads" | "companies" | "lists" | "campaigns" | "campaignsActive" | "plays" | "clients" | "apiKeysActive" | "webhooks" | "integrations" | "pixels" | "signalsSubscriptions" | "autopilots", number>>;
export type OrgInsightsData = {
  counts?: Counts | null;
  countsCapped?: string[];
  lastLoginAt?: string | null;
  lastActiveAt?: string | null;
  emailsSent30d?: number | null;
  bounceRate30d?: number | null;
  integrations?: { provider: string; status: string; lastSyncAt: string | null; lastError: string | null }[];
  senders?: { account: string; provider: string; status: string }[];
  recentAudit?: { action: string; actorType: string; createdAt: string | null; result: string }[];
  insightsTimedOut?: string[];
};

const COUNT_LABELS: [keyof Counts, string][] = [
  ["members", "Members"],
  ["leads", "Leads"],
  ["companies", "Companies"],
  ["lists", "Lists"],
  ["campaigns", "Campaigns"],
  ["campaignsActive", "Active campaigns"],
  ["plays", "Plays"],
  ["clients", "Clients"],
  ["apiKeysActive", "Active API keys"],
  ["webhooks", "Webhooks"],
  ["integrations", "Integrations"],
  ["pixels", "Pixels"],
  ["signalsSubscriptions", "Signal alerts"],
  ["autopilots", "Autopilots"],
];
const PROVIDER_LABELS: Record<string, string> = { system: "Scout shared", smtp: "SMTP", resend: "Resend" };
const ACTOR_LABELS: Record<string, string> = { user: "member", api_key: "API key", admin: "operator", system: "system", anonymous: "not signed in" };
const RESULT_STYLES: Record<string, string> = { ok: "bg-emerald-50 text-emerald-700", denied: "bg-amber-50 text-amber-800", failed: "bg-red-50 text-red-700" };
const STATUS_STYLES: Record<string, string> = { active: "bg-emerald-50 text-emerald-700", error: "bg-red-50 text-red-700", paused: "bg-amber-50 text-amber-800" };
const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1)}%`;
/** "auth.login_failed" -> "auth login failed": readable without a lookup table that goes stale. */
const actionText = (a: string) => a.replace(/[._]/g, " ");

export function hasOrgInsights(d: OrgInsightsData): boolean {
  return d.counts !== undefined || d.lastActiveAt !== undefined || Array.isArray(d.recentAudit);
}

export function OrgInsights({ data }: { data: OrgInsightsData }) {
  if (!hasOrgInsights(data)) return null;
  const capped = new Set(data.countsCapped ?? []);
  const integrations = data.integrations ?? [];
  const senders = data.senders ?? [];
  const audit = data.recentAudit ?? [];
  const timedOut = data.insightsTimedOut ?? [];

  return (
    <div className="space-y-5" data-testid="org-insights">
      {timedOut.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="status">
          Some details took too long to count and are left out ({timedOut.join(", ")}). Reopen the workspace to try again.
        </div>
      )}

      <div data-testid="org-activity">
        <div className="label">Activity</div>
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm min-[360px]:grid-cols-2">
          <div><dt className="text-xs text-ink-400">Last active</dt><dd className="text-ink-100">{data.lastActiveAt ? fmtDate(data.lastActiveAt) : "Never"}</dd></div>
          <div><dt className="text-xs text-ink-400">Last sign-in</dt><dd className="text-ink-100">{data.lastLoginAt ? fmtDate(data.lastLoginAt) : "Never"}</dd></div>
          <div><dt className="text-xs text-ink-400">Emails sent, 30 days</dt><dd className="tabular-nums text-ink-100">{data.emailsSent30d === null || data.emailsSent30d === undefined ? "-" : fmtNum(data.emailsSent30d)}</dd></div>
          <div>
            <dt className="text-xs text-ink-400">Bounce rate, 30 days</dt>
            <dd className={`tabular-nums ${(data.bounceRate30d ?? 0) >= 0.05 ? "text-red-700" : (data.bounceRate30d ?? 0) >= 0.02 ? "text-amber-800" : "text-ink-100"}`}>
              {data.bounceRate30d === null || data.bounceRate30d === undefined || !data.emailsSent30d ? "-" : pct(data.bounceRate30d)}
            </dd>
          </div>
        </dl>
      </div>

      {data.counts && (
        <div data-testid="org-counts">
          <div className="label">What it holds</div>
          <div className="grid grid-cols-2 gap-1.5 min-[400px]:grid-cols-3">
            {COUNT_LABELS.filter(([k]) => typeof data.counts?.[k] === "number").map(([k, label]) => (
              <div key={k} className="rounded-lg bg-black/[0.03] px-2 py-1.5">
                <div className="text-[11px] leading-tight text-ink-400">{label}</div>
                <div className="text-sm font-semibold tabular-nums text-ink-50">{capped.has(k) ? "1,000,000+" : fmtNum(data.counts?.[k])}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div data-testid="org-integrations">
        <div className="label">Integrations ({integrations.length})</div>
        {integrations.length === 0 ? (
          <div className="text-sm text-ink-400">None connected.</div>
        ) : (
          <ul className="space-y-1.5 text-sm text-ink-300">
            {integrations.map((i) => (
              <li key={i.provider} className="[overflow-wrap:anywhere]">
                <span className="font-medium text-ink-100">{i.provider}</span> <span className={`badge ${STATUS_STYLES[i.status] ?? "bg-black/5 text-ink-300"}`}>{i.status}</span>
                <span className="ml-1 text-xs text-ink-400">{i.lastSyncAt ? `last sync ${fmtDate(i.lastSyncAt)}` : "never synced"}</span>
                {i.lastError && <div className="text-xs text-red-700">{i.lastError}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="org-senders">
        <div className="label">Sender accounts ({senders.length})</div>
        {senders.length === 0 ? (
          <div className="text-sm text-ink-400">No sender set up, so this workspace cannot send email yet.</div>
        ) : (
          <ul className="space-y-1 text-sm text-ink-300">
            {senders.map((s, i) => (
              <li key={`${s.account}-${i}`} className="[overflow-wrap:anywhere]">
                <span className="font-mono text-xs text-ink-200">{s.account}</span> <span className="text-xs text-ink-400">· {PROVIDER_LABELS[s.provider] ?? s.provider}</span> <span className={`badge ${STATUS_STYLES[s.status] ?? "bg-black/5 text-ink-300"}`}>{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="org-recent-audit">
        <div className="label">Recent security events</div>
        {audit.length === 0 ? (
          <div className="text-sm text-ink-400">Nothing recorded yet.</div>
        ) : (
          <ul className="divide-y divide-black/5 text-sm">
            {audit.map((a, i) => (
              <li key={`${a.createdAt}-${i}`} className="flex flex-wrap items-center gap-x-2 py-1">
                <span className="min-w-0 text-ink-200 [overflow-wrap:anywhere]">{actionText(a.action)}</span>
                <span className="text-xs text-ink-400">by {ACTOR_LABELS[a.actorType] ?? a.actorType}</span>
                {a.result !== "ok" && <span className={`badge ${RESULT_STYLES[a.result] ?? "bg-black/5 text-ink-300"}`}>{a.result}</span>}
                <span className="ml-auto whitespace-nowrap text-xs text-ink-400">{fmtDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 text-xs text-ink-400">The full log is in the Security tab.</div>
      </div>
    </div>
  );
}
