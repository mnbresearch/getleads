import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectShape, fmtDate, fmtNum } from "../lib/api";

/** Same thumb-sized targets as the rest of the console (see AdminDashboard). */
const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

const errText = (e: unknown) => {
  if (e instanceof AdminApiError && (e.status === 404 || e.status === 405)) return "The overview is not available on this server yet.";
  return (e as Error)?.message || "Something went wrong.";
};

type N = number | null | undefined;
export type AdminAlert = { level: "critical" | "warning" | "info"; id?: string; title: string; detail: string; fix: string };
type Overview = {
  generatedAt?: string;
  workspaces: { total: N; byPlan?: Record<string, number>; byStatus?: Record<string, number>; new7d: N; new30d: N; active7d: N; pendingDeletion: N };
  users: { total: N; new7d: N; new30d: N; twoFactorOn: N };
  usage30d: { leads: N; searches: N; verifications: N; aiMessages: N; emailsSent: N; basis?: Record<string, string>; period?: string };
  outreach: { campaignsActive: N; emailsSent7d: N; replies7d: N; bounces7d: N; complaints7d: N };
  plays: { total: N; active: N; runs7d: N; candidatesPending: N };
  revenue: { stripeEnabled: boolean; paidWorkspaces: N; openUpgradeRequests: N };
  health: { failedJobs24h: N; stuckJobs: N; integrationsInError: N; webhooksFailing: N; queueOpen: N; oldestDueSeconds?: N };
  alerts: AdminAlert[];
  unavailable?: string[];
};

const LEVEL_STYLE: Record<AdminAlert["level"], { box: string; badge: string; label: string }> = {
  critical: { box: "border-red-200 bg-red-50/60", badge: "bg-red-100 text-red-700", label: "Critical" },
  warning: { box: "border-amber-200 bg-amber-50/60", badge: "bg-amber-100 text-amber-800", label: "Warning" },
  info: { box: "border-black/10 bg-black/[0.02]", badge: "bg-black/5 text-ink-300", label: "Info" },
};
const RANK = { critical: 0, warning: 1, info: 2 } as const;

/** A number as the console prints it; "-" when the server could not count it in time. */
const show = (v: N) => (typeof v === "number" ? fmtNum(v) : "-");

type TileSpec = { label: string; value: N; hint?: string; watch?: boolean; text?: string };

function Tile({ t }: { t: TileSpec }) {
  const hot = !!t.watch && typeof t.value === "number" && t.value > 0;
  return (
    <div className={`card min-w-0 p-3 sm:p-4 ${hot ? "border-amber-300 bg-amber-50/50" : ""}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400 [overflow-wrap:anywhere]">{t.label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-50">{t.text ?? show(t.value)}</div>
      {t.hint && <div className="mt-0.5 text-xs text-ink-400">{t.value === null && t.text === undefined ? "Could not be counted in time" : t.hint}</div>}
    </div>
  );
}

function Group({ title, note, tiles, children }: { title: string; note?: string; tiles: TileSpec[]; children?: ReactNode }) {
  return (
    <section className="mt-6" aria-label={title}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm font-semibold text-ink-50">{title}</h3>
        {note && <span className="text-xs text-ink-400">{note}</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        {tiles.map((t) => <Tile key={t.label} t={t} />)}
      </div>
      {children}
    </section>
  );
}

function Breakdown({ label, data }: { label: string; data?: Record<string, number> }) {
  const rows = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-300">
      <span className="font-medium text-ink-400">{label}:</span>
      {rows.map(([k, v]) => (
        <span key={k} className="badge border border-black/10 bg-black/[0.03] text-ink-200">
          {k} <b className="ml-1 tabular-nums">{fmtNum(v)}</b>
        </span>
      ))}
    </div>
  );
}

export function AlertsList({ alerts }: { alerts: AdminAlert[] }) {
  const sorted = [...alerts].sort((a, b) => (RANK[a.level] ?? 3) - (RANK[b.level] ?? 3));
  if (!sorted.length) {
    return <div className="card border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-800" data-testid="alerts-empty">Nothing needs attention: every check passed.</div>;
  }
  return (
    <ul className="space-y-2" data-testid="alerts">
      {sorted.map((a, i) => {
        const s = LEVEL_STYLE[a.level] ?? LEVEL_STYLE.info;
        return (
          <li key={a.id ?? `${a.title}-${i}`} className={`card border p-3 sm:p-4 ${s.box}`} data-level={a.level}>
            <div className="flex flex-wrap items-start gap-2">
              <span className={`badge shrink-0 ${s.badge}`}>{s.label}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink-50 [overflow-wrap:anywhere]">{a.title}</div>
                <div className="mt-0.5 text-sm text-ink-300 [overflow-wrap:anywhere]">{a.detail}</div>
                <div className="mt-1 text-sm text-ink-200 [overflow-wrap:anywhere]"><span className="font-medium">Fix:</span> {a.fix}</div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function OverviewTab({ onOpenTab }: { onOpenTab?: (tab: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    return adminFetch<Overview>("GET", "/v1/admin/overview")
      .then((r) => {
        if (mine !== seq.current) return;
        setData(expectShape(r, (x) => !!x.workspaces && !!x.health && Array.isArray(x.alerts)));
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e)); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const d = data;
  const monthly = d?.usage30d.basis?.verifications === "month";
  const counts = d ? d.alerts.reduce((acc, a) => ({ ...acc, [a.level]: (acc[a.level] ?? 0) + 1 }), {} as Record<string, number>) : {};

  return (
    <div data-testid="admin-overview">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-50">Platform overview</h2>
          <div className="text-xs text-ink-400">{d?.generatedAt ? `As of ${fmtDate(d.generatedAt)}` : "Every workspace, at a glance"}</div>
        </div>
        <button className="btn-secondary max-lg:min-h-[40px]" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : d || !err ? "Refresh" : "Retry"}</button>
      </div>

      {err && (
        <div className="card mb-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
          {d ? "Could not refresh the overview" : "Could not load the overview"}: {err}
          {d ? " The numbers below are from the last successful check." : ""}{" "}
          <button className={LINK_BTN} onClick={() => void load()} disabled={busy}>Retry</button>
        </div>
      )}

      {!d && !err && <div className="card p-5 text-sm text-ink-400" role="status">Loading the overview…</div>}

      {d && (
        <>
          <section aria-label="Needs attention">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-sm font-semibold text-ink-50">Needs attention</h3>
              {d.alerts.length > 0 && (
                <span className="text-xs text-ink-400">
                  {[["critical", "critical"], ["warning", "warning"], ["info", "for information"]].filter(([k]) => counts[k]).map(([k, w]) => `${fmtNum(counts[k])} ${w}`).join(", ")}
                </span>
              )}
            </div>
            <AlertsList alerts={d.alerts} />
          </section>

          {!!d.unavailable?.length && (
            <div className="card mt-3 border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status">
              Some numbers could not be counted in time and show as "-": {d.unavailable.join(", ")}. Refresh to try again.
            </div>
          )}

          <Group
            title="Workspaces"
            tiles={[
              { label: "Workspaces", value: d.workspaces.total, hint: "All time" },
              { label: "New this week", value: d.workspaces.new7d, hint: "Signed up in 7 days" },
              { label: "New this month", value: d.workspaces.new30d, hint: "Signed up in 30 days" },
              { label: "Active this week", value: d.workspaces.active7d, hint: "Signed in, used the app or added leads" },
              { label: "Pending deletion", value: d.workspaces.pendingDeletion, hint: "Owner asked to delete", watch: true },
            ]}
          >
            <Breakdown label="By plan" data={d.workspaces.byPlan} />
            <Breakdown label="By status" data={d.workspaces.byStatus} />
          </Group>

          <Group
            title="People"
            tiles={[
              { label: "Users", value: d.users.total, hint: "Accounts across workspaces" },
              { label: "New this week", value: d.users.new7d, hint: "Accounts in 7 days" },
              { label: "New this month", value: d.users.new30d, hint: "Accounts in 30 days" },
              { label: "Two-factor on", value: d.users.twoFactorOn, hint: typeof d.users.total === "number" && typeof d.users.twoFactorOn === "number" && d.users.total > 0 ? `${Math.round((d.users.twoFactorOn / d.users.total) * 100)}% of users` : "Users with an authenticator" },
            ]}
          />

          <Group
            title="Usage"
            note={monthly ? `Leads, searches and emails: last 30 days. Verifications and AI messages: this month (${d.usage30d.period ?? "so far"}).` : "Last 30 days"}
            tiles={[
              { label: "Leads added", value: d.usage30d.leads, hint: "Last 30 days" },
              { label: "Searches", value: d.usage30d.searches, hint: "Last 30 days" },
              { label: "Emails sent", value: d.usage30d.emailsSent, hint: "Last 30 days" },
              { label: "Verifications", value: d.usage30d.verifications, hint: monthly ? "This month" : "Last 30 days" },
              { label: "AI messages", value: d.usage30d.aiMessages, hint: monthly ? "This month" : "Last 30 days" },
            ]}
          />

          <Group
            title="Outreach"
            note="Last 7 days"
            tiles={[
              { label: "Active campaigns", value: d.outreach.campaignsActive, hint: "Sending now" },
              { label: "Emails sent", value: d.outreach.emailsSent7d, hint: "Last 7 days" },
              { label: "Replies", value: d.outreach.replies7d, hint: "Last 7 days" },
              { label: "Bounces", value: d.outreach.bounces7d, hint: "Last 7 days", watch: true },
              { label: "Spam complaints", value: d.outreach.complaints7d, hint: "Last 7 days", watch: true },
            ]}
          />

          <Group
            title="Plays"
            tiles={[
              { label: "Plays", value: d.plays.total, hint: "All workspaces" },
              { label: "Active plays", value: d.plays.active, hint: "Running on a schedule" },
              { label: "Runs this week", value: d.plays.runs7d, hint: "Last 7 days" },
              { label: "Waiting for review", value: d.plays.candidatesPending, hint: "Candidates not yet approved" },
            ]}
          />

          <Group
            title="Revenue"
            tiles={[
              { label: "Paid workspaces", value: d.revenue.paidWorkspaces, hint: "Not on free or pilot" },
              { label: "Upgrade requests", value: d.revenue.openUpgradeRequests, hint: "Not yet contacted", watch: true },
              { label: "Online checkout", value: null, text: d.revenue.stripeEnabled ? "On" : "Off", hint: d.revenue.stripeEnabled ? "Stripe is configured" : "Upgrades arrive as requests" },
            ]}
          >
            {onOpenTab && (typeof d.revenue.openUpgradeRequests === "number" && d.revenue.openUpgradeRequests > 0) && (
              <button className={`${LINK_BTN} mt-2 text-sm text-ink-300`} onClick={() => onOpenTab("leads")}>Open upgrade requests</button>
            )}
          </Group>

          <Group
            title="Health"
            tiles={[
              { label: "Failed jobs", value: d.health.failedJobs24h, hint: "Last 24 hours", watch: true },
              { label: "Stuck jobs", value: d.health.stuckJobs, hint: "Running over 30 minutes", watch: true },
              { label: "Jobs waiting", value: d.health.queueOpen, hint: "Queued or running" },
              { label: "Integrations failing", value: d.health.integrationsInError, hint: "Last CRM sync failed", watch: true },
              { label: "Webhooks failing", value: d.health.webhooksFailing, hint: "Failed in 24 hours or disabled", watch: true },
            ]}
          >
            {onOpenTab && <button className={`${LINK_BTN} mt-2 text-sm text-ink-300`} onClick={() => onOpenTab("system")}>Open the System tab for the job queue and configuration</button>}
          </Group>
        </>
      )}
    </div>
  );
}
