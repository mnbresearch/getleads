import { useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectLists, expectShape, fmtDate, fmtNum } from "../lib/api";

/**
 * Growth: the platform's own funnel (visits to paid), where visitors came from, and the
 * checkouts that were started - with the follow-up email's mode and a preview of what it
 * would do. Every number is a count. Visits are page views, not people: the public site's
 * beacon carries no identifier at all.
 */

const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

const errText = (e: unknown, what: string) => {
  if (e instanceof AdminApiError && (e.status === 404 || e.status === 405)) return `${what} is not available on this server yet.`;
  return (e as Error)?.message || "Something went wrong.";
};

type StepKey = "visits" | "pricing_views" | "signups" | "verified" | "activated" | "checkout_started" | "paid";
type Funnel = {
  range: { days: number; from: string; to: string };
  steps: { key: StepKey; label: string; count: number }[];
  conversion: { from: StepKey; to: StepKey; rate: number | null }[];
  daily: ({ day: string } & Record<StepKey, number>)[];
  referrers: { host: string; count: number }[];
  sources: { source: string; count: number }[];
  logins: { succeeded: number; failed: number };
  apiKeys: { active: number; usedInRange: number };
  abandonedCheckouts?: number;
  subscriptionsCancelled?: number;
};
type Checkout = { id: string; orgId: string; orgName: string | null; plan: string; status: string; createdAt: string; completedAt: string | null; followupStatus: string | null; followupAt: string | null; ownerEmail: string | null };
type FollowupInfo = { mode: "off" | "dry_run" | "on"; afterHours: number; mailer: boolean };
type Preview = {
  mode: string;
  afterHours: number;
  considered: number;
  sent: number;
  dryRun: number;
  failed: number;
  skipped: Record<string, number>;
  decisions?: { sessionId: string; orgName: string; plan: string; createdAt: string; outcome: string }[];
  sample?: { to: string; subject: string; text: string } | null;
  mailer?: boolean;
};

const RANGES = [7, 30, 90] as const;
const pct = (r: number | null) => (r === null ? "-" : `${Math.round(r * 1000) / 10}%`);
const MODE_TEXT: Record<FollowupInfo["mode"], string> = {
  off: "Off - abandoned checkouts are counted, nobody is emailed",
  dry_run: "Dry run - every decision is recorded, no email is sent",
  on: "On - one reminder per abandoned checkout",
};
const SKIP_TEXT: Record<string, string> = {
  completed_later: "paid later",
  plan_already: "already on that plan",
  too_old: "older than 7 days",
  org_inactive: "workspace suspended",
  no_user: "no user",
  unverified: "email not confirmed",
  opted_out: "opted out",
  suppressed: "on the do-not-contact list",
  recent_followup: "reminded in the last 14 days",
  off: "follow-up is off",
};
const outcomeText = (s: string | null) => {
  if (!s) return "-";
  if (s.startsWith("skipped:")) return `Skipped (${SKIP_TEXT[s.slice(8)] ?? s.slice(8)})`;
  return { sent: "Sent", dry_run: "Dry run", failed: "Failed", "failed:no_mailer": "Failed (no mail provider)", sending: "Sending" }[s] ?? s;
};

function FunnelSection({ days }: { days: number }) {
  const [data, setData] = useState<Funnel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    adminFetch<Funnel>("GET", `/v1/admin/analytics/funnel?days=${days}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setData(expectShape(expectLists(r, "steps", "daily", "referrers", "sources"), (x) => !!x.logins && !!x.apiKeys));
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e, "The growth funnel")); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [days]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) {
    return (
      <div className="card border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
        Could not load the funnel: {err} <button className={LINK_BTN} onClick={load} disabled={busy}>Retry</button>
      </div>
    );
  }
  if (!data) return <div className="card p-5 text-sm text-ink-400" role="status">Loading the funnel…</div>;

  const top = Math.max(1, ...data.steps.map((s) => s.count));
  const empty = data.steps.every((s) => s.count === 0);
  const rateTo = (k: StepKey) => data.conversion.find((c) => c.to === k)?.rate ?? null;
  const dayMax = Math.max(1, ...data.daily.map((d) => d.visits + d.pricing_views));

  return (
    <div className="space-y-3">
      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not refresh: {err}. Showing the last numbers that loaded.</div>}
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-50">Funnel, last {data.range.days} days</h2>
          <button className="btn-secondary max-lg:min-h-[40px]" onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
        </div>
        {empty ? (
          <p className="text-sm text-ink-400">No activity recorded in this period yet. Visits appear once the public site sends page views; sign-ups and checkouts as they happen.</p>
        ) : (
          <ol className="space-y-2" data-testid="growth-funnel">
            {data.steps.map((s, i) => (
              <li key={s.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate text-ink-200">{s.label}</span>
                <span className="h-5 rounded bg-black/5" aria-hidden>
                  <span className="block h-5 rounded bg-brand-600/80" style={{ width: `${Math.max(s.count ? 2 : 0, (s.count / top) * 100)}%` }} />
                </span>
                <span className="w-28 text-right tabular-nums text-ink-50">
                  <b>{fmtNum(s.count)}</b>
                  {i > 0 && <span className="ml-2 text-xs text-ink-400">{pct(rateTo(s.key))}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-ink-400">Percentages are from the step above. Visits and pricing views are counted views, not people.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          ["Sign-ins", data.logins.succeeded, "Successful"],
          ["Failed sign-ins", data.logins.failed, "Wrong password or code"],
          ["Active API keys", data.apiKeys.active, "Not revoked or expired"],
          ["Keys used", data.apiKeys.usedInRange, "In this period"],
        ] as const).map(([label, n, hint]) => (
          <div key={label} className="card min-w-0 p-3 sm:p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-50">{fmtNum(n)}</div>
            <div className="mt-0.5 text-xs text-ink-400">{hint}</div>
          </div>
        ))}
      </div>

      <div className="card p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Daily visits and sign-ups</div>
        {empty ? (
          <p className="mt-2 text-sm text-ink-400">Nothing to chart yet.</p>
        ) : (
          <>
            <div className="mt-3 flex h-28 items-end gap-px" role="img" aria-label={`Daily visits over the last ${data.range.days} days`}>
              {data.daily.map((d) => (
                <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.day}: ${d.visits + d.pricing_views} views, ${d.signups} sign-ups, ${d.paid} paid`}>
                  <div className="rounded-t-sm bg-brand-600/70" style={{ height: `${((d.visits + d.pricing_views) / dayMax) * 100}%` }} />
                  <div className={`mt-px h-1 ${d.signups ? "bg-emerald-500" : "bg-transparent"}`} />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-ink-400"><span>{data.daily[0]?.day}</span><span>{data.daily[data.daily.length - 1]?.day}</span></div>
            <p className="mt-1 text-xs text-ink-400">Bars: page views. Green mark: a day with at least one sign-up.</p>
          </>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {([
          ["Top referring sites", data.referrers.map((r) => [r.host, r.count] as const), "No referring sites recorded yet."],
          ["Top utm sources", data.sources.map((r) => [r.source, r.count] as const), "No utm_source tags recorded yet."],
        ] as const).map(([title, list, none]) => (
          <div key={title} className="card p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</div>
            {list.length === 0 ? (
              <div className="mt-2 text-sm text-ink-400">{none}</div>
            ) : (
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-black/5">
                  {list.map(([name, n]) => (
                    <tr key={name}>
                      <td className="py-1.5 pr-3 font-mono text-xs text-ink-200 [overflow-wrap:anywhere]">{name}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink-50">{fmtNum(n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckoutsSection() {
  const [status, setStatus] = useState<"" | "open" | "completed" | "expired" | "abandoned">("");
  const [rows, setRows] = useState<Checkout[] | null>(null);
  const [info, setInfo] = useState<FollowupInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "load" | "preview" | "test">("");
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy("load");
    adminFetch<{ checkouts: Checkout[]; followup: FollowupInfo }>("GET", `/v1/admin/checkouts?limit=100${status ? `&status=${status}` : ""}`)
      .then((r) => {
        if (mine !== seq.current) return;
        const ok = expectLists(r, "checkouts");
        setRows(ok.checkouts);
        setInfo(ok.followup ?? null);
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e, "The checkout list")); })
      .finally(() => { if (mine === seq.current) setBusy(""); });
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const runPreview = () => {
    setBusy("preview");
    setNote(null);
    adminFetch<Preview>("POST", "/v1/admin/checkout-followup/preview", {})
      .then((r) => setPreview(r))
      .catch((e) => setNote(errText(e, "The preview")))
      .finally(() => setBusy(""));
  };
  const sendTest = () => {
    setBusy("test");
    setNote(null);
    adminFetch<{ sent: boolean; to?: string; message?: string }>("POST", "/v1/admin/checkout-followup/test", {})
      .then((r) => setNote(r.sent ? `Test email sent to ${r.to ?? "the admin address"}.` : r.message ?? "The test email could not be sent."))
      .catch((e) => setNote(errText(e, "The test email")))
      .finally(() => setBusy(""));
  };

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Checkout follow-up</div>
            <div className="mt-1 text-sm text-ink-50" data-testid="followup-mode">{info ? MODE_TEXT[info.mode] ?? info.mode : "-"}</div>
            <div className="mt-0.5 text-xs text-ink-400">
              {info ? `A checkout counts as abandoned ${info.afterHours} hour${info.afterHours === 1 ? "" : "s"} after it was started.` : ""}
              {info && !info.mailer ? " No mail provider is set up, so nothing can be sent." : ""} Set with CHECKOUT_FOLLOWUP and CHECKOUT_FOLLOWUP_AFTER_HOURS on the server.
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn-secondary max-lg:min-h-[40px]" onClick={runPreview} disabled={!!busy}>{busy === "preview" ? "Checking…" : "Preview"}</button>
            <button className="btn-secondary max-lg:min-h-[40px]" onClick={sendTest} disabled={!!busy}>{busy === "test" ? "Sending…" : "Send test"}</button>
          </div>
        </div>
        {note && <div className="mt-3 rounded-lg border border-black/10 bg-black/5 p-2 text-sm text-ink-200" role="status">{note}</div>}
        {preview && (
          <div className="mt-3 space-y-2 text-sm" data-testid="followup-preview">
            <div className="text-ink-200">
              A run now would look at <b>{fmtNum(preview.considered)}</b> checkout{preview.considered === 1 ? "" : "s"}: {fmtNum(preview.sent)} sent, {fmtNum(preview.dryRun)} dry run
              {Object.entries(preview.skipped).map(([k, n]) => `, ${fmtNum(n)} skipped (${SKIP_TEXT[k] ?? k})`).join("")}.
            </div>
            {preview.sample ? (
              <div className="rounded-lg border border-black/10 p-3">
                <div className="text-xs text-ink-400">To: {preview.sample.to}</div>
                <div className="text-xs text-ink-400">Subject: {preview.sample.subject}</div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-200 [overflow-wrap:anywhere]">{preview.sample.text}</pre>
              </div>
            ) : (
              <div className="text-ink-400">No checkout is eligible for a reminder right now, so there is no email to show.</div>
            )}
          </div>
        )}
      </div>

      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Checkouts</div>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter checkouts by status">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
            <option value="expired">Expired</option>
            <option value="abandoned">Abandoned</option>
          </select>
        </div>
        {err && <div className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700" role="alert">{err} <button className={LINK_BTN} onClick={load}>Retry</button></div>}
        {!rows ? (
          !err && <div className="text-sm text-ink-400" role="status">Loading checkouts…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-400">No checkouts{status ? ` with status "${status}"` : ""} yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-400">
                  <th className="py-1.5 pr-3 font-medium">Workspace</th>
                  <th className="py-1.5 pr-3 font-medium">Plan</th>
                  <th className="py-1.5 pr-3 font-medium">Started</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 font-medium">Follow-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-3">
                      <div className="text-ink-50 [overflow-wrap:anywhere]">{r.orgName ?? "-"}</div>
                      {r.ownerEmail && <div className="text-xs text-ink-400 [overflow-wrap:anywhere]">{r.ownerEmail}</div>}
                    </td>
                    <td className="py-1.5 pr-3 text-ink-200">{r.plan}</td>
                    <td className="py-1.5 pr-3 text-ink-200">{fmtDate(r.createdAt)}</td>
                    <td className="py-1.5 pr-3 text-ink-200">{r.status}{r.completedAt ? ` (${fmtDate(r.completedAt)})` : ""}</td>
                    <td className="py-1.5 text-ink-200">{outcomeText(r.followupStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function GrowthTab() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  return (
    <section aria-label="Growth" className="space-y-4" data-testid="growth-tab">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((d) => (
          <button key={d} className={`rounded-lg px-3 py-1.5 text-sm max-lg:min-h-[40px] ${days === d ? "bg-black/10 text-ink-50" : "text-ink-300 hover:bg-black/5"}`} aria-pressed={days === d} onClick={() => setDays(d)}>
            {d} days
          </button>
        ))}
      </div>
      <FunnelSection days={days} />
      <CheckoutsSection />
    </section>
  );
}
