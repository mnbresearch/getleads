import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectLists, expectShape, fmtDate, fmtNum } from "../lib/api";

/**
 * Deliverability and integrations: is the platform's outreach landing, and are the
 * customers' connections to other tools working? One read (GET /v1/admin/deliverability)
 * across every workspace. Bounces and replies are counted against the day the email was sent;
 * a webhook is named by its host only, because its path is often its secret.
 */

const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

type Breaker = "ok" | "warn" | "halt";
type Report = {
  days: number;
  daily: { day: string; sent: number; bounced: number; complained: number; replied: number }[];
  totals: { sent: number; bounced: number; complained: number; replied: number; bounceRate: number; complaintRate: number };
  senders: { orgId: string; orgName: string; accountId: string; account: string; provider: string; status: string; paused: boolean; circuitBreaker: Breaker; circuitReason: string | null; sent7d: number; bounceRate7d: number; warmupDay: number | null; dailyLimit: number }[];
  suppressions: { global: number; workspaceTotal: number; workspaceEstimated?: boolean };
  bounceTracking: { resendWebhookConfigured: boolean; lastEventAt: string | null };
  integrations: { byProvider: { provider: string; connected: number; inError: number }[]; errors: { orgId: string; orgName: string; provider: string; lastError: string | null; lastErrorAt: string | null; credentialsRejected: boolean }[] };
  webhooks: { total: number; active: number; disabled: number; failing: { webhookId: string; orgId: string; orgName: string; host: string; lastStatus: number | null; lastError: string | null; lastFailureAt: string | null; failures24h: number; consecutiveFailures: number; disabled: boolean }[] };
  inbound: { addressesCreated: number; repliesReceived7d: number };
  timedOut?: string[];
  generatedAt?: string;
};

const errText = (e: unknown) => {
  if (e instanceof AdminApiError && (e.status === 404 || e.status === 405)) return "Deliverability is not available on this server yet.";
  return (e as Error)?.message || "Something went wrong.";
};
/** 0.0754 -> "7.5%"; small rates keep two decimals so 0.2% does not read as 0%. */
const pct = (r: number | null | undefined) => (r === null || r === undefined ? "-" : `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1)}%`);
/** A UTC calendar day ("2026-10-14") as a short label, without shifting it into another day. */
const dayLabel = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
};
const SECTION_NAMES: Record<string, string> = {
  daily: "daily sends",
  complaints: "complaints",
  senders: "sender volumes",
  accounts: "sender accounts",
  suppressions: "suppression lists",
  bounceTracking: "last bounce event",
  integrations: "integrations",
  webhookTotals: "webhook totals",
  webhooks: "failing webhooks",
  inbound: "inbound replies",
};
const BREAKER_STYLES: Record<Breaker, string> = {
  ok: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-800",
  halt: "bg-red-50 text-red-700",
};
const BREAKER_TEXT: Record<Breaker, string> = { ok: "Healthy", warn: "Throttled", halt: "Halted" };
const PROVIDER_LABELS: Record<string, string> = { system: "Scout shared", smtp: "SMTP", resend: "Resend" };

function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="card min-w-0 p-4" data-testid={testId}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card min-w-0 p-3 sm:p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-50">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

function OrgLink({ orgId, name, onViewOrg }: { orgId: string; name: string; onViewOrg: (id: string) => void }) {
  return (
    <button className={`${TAP} text-left font-medium text-ink-50 hover:underline [overflow-wrap:anywhere]`} onClick={() => onViewOrg(orgId)} title="Open this workspace">
      {name || "(unnamed workspace)"}
    </button>
  );
}

export function DeliverabilityTab({ onViewOrg }: { onViewOrg: (orgId: string) => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    adminFetch<Report>("GET", `/v1/admin/deliverability?days=${days}`)
      .then((r) => {
        if (mine !== seq.current) return;
        const ok = expectShape(expectLists(r, "daily", "senders"), (x) => !!x.totals && !!x.integrations && Array.isArray(x.integrations.byProvider) && !!x.webhooks && Array.isArray(x.webhooks.failing));
        setData(ok);
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e)); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1" role="group" aria-label="Period">
        {([7, 30] as const).map((d) => (
          <button key={d} className={`rounded-lg px-3 py-1.5 text-sm max-lg:min-h-[40px] ${days === d ? "bg-brand-600 text-white" : "text-ink-300 hover:bg-black/5"}`} aria-pressed={days === d} onClick={() => setDays(d)}>
            Last {d} days
          </button>
        ))}
      </div>
      <button className="btn-secondary max-lg:min-h-[40px]" onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
    </div>
  );

  if (err && !data) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          Could not load deliverability: {err} <button className={LINK_BTN} onClick={load} disabled={busy}>Retry</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card p-5 text-sm text-ink-400" role="status">Loading deliverability…</div>
      </div>
    );
  }

  const t = data.totals;
  const dayMax = Math.max(1, ...data.daily.map((d) => d.sent));
  const anySent = data.daily.some((d) => d.sent > 0);
  const timedOut = (data.timedOut ?? []).map((s) => SECTION_NAMES[s] ?? s);
  const bt = data.bounceTracking;

  return (
    <div className="space-y-3" data-testid="deliverability-tab">
      {header}
      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not refresh: {err}. Showing the last numbers that loaded.</div>}
      {timedOut.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="status">
          Some parts took too long to count and are shown empty: {timedOut.join(", ")}. Press Refresh to try again.
        </div>
      )}

      <div className={`rounded-lg border p-3 text-sm ${bt.resendWebhookConfigured ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-800"}`} data-testid="bounce-tracking">
        {bt.resendWebhookConfigured ? (
          <>Bounce tracking is on. {bt.lastEventAt ? `Last bounce or complaint recorded ${fmtDate(bt.lastEventAt)}.` : "No bounce or complaint recorded in the last 30 days."}</>
        ) : (
          <>Bounce tracking is off: RESEND_WEBHOOK_SECRET is not set, so bounces and spam complaints reported after sending are not recorded and the bounce rates below read low. Set it in the hosting dashboard and point Resend's webhook at /v1/email-events/resend.</>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Sent" value={fmtNum(t.sent)} hint={`Last ${data.days} days`} />
        <Kpi label="Bounced" value={fmtNum(t.bounced)} hint={`${pct(t.bounceRate)} of sent`} />
        <Kpi label="Spam complaints" value={fmtNum(t.complained)} hint={`${pct(t.complaintRate)} of sent`} />
        <Kpi label="Replies" value={fmtNum(t.replied)} hint={t.sent ? `${pct(t.replied / t.sent)} of sent` : "Nothing sent"} />
      </div>

      <Card title="Daily sends" testId="deliverability-daily">
        {!anySent ? (
          <p className="text-sm text-ink-400">No email was sent in this period.</p>
        ) : (
          <>
            <div className="flex h-28 items-end gap-px" role="img" aria-label={`Emails sent per day over the last ${data.days} days`}>
              {data.daily.map((d) => (
                <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${dayLabel(d.day)}: ${fmtNum(d.sent)} sent, ${fmtNum(d.bounced)} bounced, ${fmtNum(d.complained)} complaints, ${fmtNum(d.replied)} replies`}>
                  <div className="rounded-t-sm bg-brand-600/70" style={{ height: `${(d.sent / dayMax) * 100}%` }} />
                  <div className={`mt-px h-1 ${d.bounced || d.complained ? "bg-red-500" : "bg-transparent"}`} />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-ink-400"><span>{dayLabel(data.daily[0]?.day ?? "")}</span><span>{dayLabel(data.daily[data.daily.length - 1]?.day ?? "")}</span></div>
            <p className="mt-1 text-xs text-ink-400">Bars: emails sent per day (UTC). Red mark: a day with bounces or complaints. Bounces and replies count against the day the email was sent.</p>
          </>
        )}
      </Card>

      <Card title={`Busiest senders (${data.senders.length})`} testId="deliverability-senders">
        {data.senders.length === 0 ? (
          <p className="text-sm text-ink-400">No workspace has a sender account yet.</p>
        ) : (
          <>
          {/* Phones: one card per sender; the five-column table did not fit 375px. */}
          <ul className="divide-y divide-black/5 text-sm md:hidden">
            {data.senders.map((s) => (
              <li key={s.accountId} className="py-2">
                <div className="font-mono text-xs text-ink-200 [overflow-wrap:anywhere]">{s.account}</div>
                <div className="text-xs text-ink-400"><OrgLink orgId={s.orgId} name={s.orgName} onViewOrg={onViewOrg} /> · {PROVIDER_LABELS[s.provider] ?? s.provider}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-300">
                  <span className={`badge whitespace-nowrap ${BREAKER_STYLES[s.circuitBreaker] ?? ""}`}>{BREAKER_TEXT[s.circuitBreaker] ?? s.circuitBreaker}</span>
                  {s.status !== "active" && <span className="badge whitespace-nowrap bg-black/5 text-ink-300">{s.status}</span>}
                  <span className="tabular-nums">{fmtNum(s.sent7d)} sent 7d</span>
                  <span className="tabular-nums">{s.sent7d ? pct(s.bounceRate7d) : "-"} bounced</span>
                  <span>{s.warmupDay ? `Warm-up day ${s.warmupDay} of 21` : "Warmed"}</span>
                </div>
                {s.circuitReason && <div className="mt-0.5 text-xs text-ink-400 [overflow-wrap:anywhere]">{s.circuitReason}</div>}
              </li>
            ))}
          </ul>
          <div className="-mx-4 overflow-x-auto max-md:hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-400">
                  <th className="th">Sender</th>
                  <th className="th text-right">Sent 7d</th>
                  <th className="th text-right">Bounce 7d</th>
                  <th className="th">State</th>
                  <th className="th">Warm-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {data.senders.map((s) => (
                  <tr key={s.accountId}>
                    <td className="td min-w-0">
                      <div className="font-mono text-xs text-ink-200 [overflow-wrap:anywhere]">{s.account}</div>
                      <div className="text-xs text-ink-400"><OrgLink orgId={s.orgId} name={s.orgName} onViewOrg={onViewOrg} /> · {PROVIDER_LABELS[s.provider] ?? s.provider}</div>
                    </td>
                    <td className="td text-right tabular-nums">{fmtNum(s.sent7d)}</td>
                    <td className={`td text-right tabular-nums ${s.bounceRate7d >= 0.05 ? "text-red-700" : s.bounceRate7d >= 0.02 ? "text-amber-800" : ""}`}>{s.sent7d ? pct(s.bounceRate7d) : "-"}</td>
                    <td className="td">
                      <span className={`badge whitespace-nowrap ${BREAKER_STYLES[s.circuitBreaker] ?? ""}`} title={s.circuitReason ?? "Within the bounce and complaint limits"}>{BREAKER_TEXT[s.circuitBreaker] ?? s.circuitBreaker}</span>
                      {s.status !== "active" && <span className="badge ml-1 whitespace-nowrap bg-black/5 text-ink-300">{s.status}</span>}
                      {s.circuitReason && <div className="mt-0.5 text-xs text-ink-400 [overflow-wrap:anywhere]">{s.circuitReason}</div>}
                    </td>
                    <td className="td whitespace-nowrap text-ink-300">{s.warmupDay ? `Day ${s.warmupDay} of 21` : "Warmed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
        <p className="mt-2 text-xs text-ink-400">State is the same verdict the campaign scheduler enforces, from the last 14 days: Halted senders are not sending. Scout shared senders are judged per workspace.</p>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Do-not-contact lists" testId="deliverability-suppressions">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-ink-400">Platform-wide</dt><dd className="text-xl font-semibold tabular-nums text-ink-50">{fmtNum(data.suppressions.global)}</dd></div>
            <div><dt className="text-xs text-ink-400">All workspaces' lists</dt><dd className="text-xl font-semibold tabular-nums text-ink-50">{data.suppressions.workspaceEstimated ? "about " : ""}{fmtNum(data.suppressions.workspaceTotal)}</dd></div>
          </dl>
        </Card>
        <Card title="Inbound replies" testId="deliverability-inbound">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-ink-400">Reply addresses set up</dt><dd className="text-xl font-semibold tabular-nums text-ink-50">{fmtNum(data.inbound.addressesCreated)}</dd></div>
            <div><dt className="text-xs text-ink-400">Replies received, 7 days</dt><dd className="text-xl font-semibold tabular-nums text-ink-50">{fmtNum(data.inbound.repliesReceived7d)}</dd></div>
          </dl>
        </Card>
      </div>

      <Card title="Integrations" testId="deliverability-integrations">
        {data.integrations.byProvider.length === 0 ? (
          <p className="text-sm text-ink-400">No workspace has connected an integration yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.integrations.byProvider.map((p) => (
              <span key={p.provider} className={`badge ${p.inError ? "bg-red-50 text-red-700" : "bg-black/5 text-ink-200"}`}>
                {p.provider} · {fmtNum(p.connected)} connected{p.inError ? ` · ${fmtNum(p.inError)} in error` : ""}
              </span>
            ))}
          </div>
        )}
        {data.integrations.errors.length > 0 ? (
          <ul className="mt-3 divide-y divide-black/5 text-sm">
            {data.integrations.errors.map((e) => (
              <li key={`${e.orgId}-${e.provider}`} className="py-2">
                <div className="flex flex-wrap items-center gap-x-2">
                  <OrgLink orgId={e.orgId} name={e.orgName} onViewOrg={onViewOrg} />
                  <span className="text-ink-400">· {e.provider}</span>
                  {e.credentialsRejected && <span className="badge bg-red-50 text-red-700">Credentials rejected</span>}
                  <span className="ml-auto text-xs text-ink-400">{fmtDate(e.lastErrorAt)}</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-300 [overflow-wrap:anywhere]">{e.lastError ?? "No error text was recorded."}</div>
              </li>
            ))}
          </ul>
        ) : (
          data.integrations.byProvider.length > 0 && <p className="mt-3 text-sm text-ink-400">No integration is in error.</p>
        )}
      </Card>

      <Card title="Webhooks" testId="deliverability-webhooks">
        <div className="text-sm text-ink-300">
          {fmtNum(data.webhooks.total)} in total · {fmtNum(data.webhooks.active)} active · <span className={data.webhooks.disabled ? "text-red-700" : ""}>{fmtNum(data.webhooks.disabled)} switched off</span>
        </div>
        {data.webhooks.failing.length === 0 ? (
          <p className="mt-2 text-sm text-ink-400">{data.webhooks.total ? "No webhook failed a delivery in the last 24 hours." : "No workspace has a webhook yet."}</p>
        ) : (
          <ul className="mt-3 divide-y divide-black/5 text-sm">
            {data.webhooks.failing.map((w) => (
              <li key={w.webhookId} className="py-2">
                <div className="flex flex-wrap items-center gap-x-2">
                  <OrgLink orgId={w.orgId} name={w.orgName} onViewOrg={onViewOrg} />
                  <span className="font-mono text-xs text-ink-300 [overflow-wrap:anywhere]">{w.host}</span>
                  {w.disabled && <span className="badge bg-red-50 text-red-700">Switched off</span>}
                  {w.lastStatus !== null && <span className="badge bg-black/5 text-ink-200">HTTP {w.lastStatus}</span>}
                  <span className="ml-auto text-xs text-ink-400">{w.lastFailureAt ? fmtDate(w.lastFailureAt) : ""}</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-400 [overflow-wrap:anywhere]">
                  {fmtNum(w.failures24h)} failed {w.failures24h === 1 ? "attempt" : "attempts"} in 24 hours · {fmtNum(w.consecutiveFailures)} failed in a row{w.lastError ? ` · ${w.lastError}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-400">Webhooks are shown by host only: the rest of the address is often the receiver's secret.</p>
      </Card>

      {data.generatedAt && <p className="text-right text-xs text-ink-400">Counted {fmtDate(data.generatedAt)}</p>}
    </div>
  );
}
