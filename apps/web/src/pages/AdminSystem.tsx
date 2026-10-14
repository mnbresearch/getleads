import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectShape, fmtDate, fmtNum } from "../lib/api";

/** Same thumb-sized targets as the rest of the console (see AdminDashboard). */
const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

const errText = (e: unknown) => {
  if (e instanceof AdminApiError && (e.status === 404 || e.status === 405)) return "The system view is not available on this server yet.";
  return (e as Error)?.message || "Something went wrong.";
};

type ConfigItem = { key: string; label: string; area: string; set: boolean; effect: string; value?: string | null };
type JobType = { type: string; queued: number; running: number; failed24h: number; done24h: number; oldestQueuedSeconds: number | null };
type Recurring = { type: string; intervalSeconds: number; lastFinishedAt: string | null; lastStatus: string | null; nextRunAt: string | null; running: boolean; healthy: boolean; problem: string | null };
type Failure = { id: string; type: string; orgId: string | null; orgName: string | null; error: string | null; failedAt: string | null; attempts: number; maxAttempts: number; retryable: boolean };
type SystemReport = {
  serverTime?: string;
  build: { commit: string | null; node: string; startedAt: string; uptimeSeconds: number; nodeEnv: string; jobMode: string; embeddedWorker: boolean };
  database: { migrationsApplied: number | null; latestMigration: string | null; sizeBytes: number | null; largestTables: { name: string; estimatedRows: number | null; sizeBytes: number }[] };
  config: ConfigItem[];
  keepAwake?: { configured: boolean; window: string | null; timeZone: string | null; activeNow: boolean; onRender: boolean };
  jobs: { byType: JobType[]; recurring: Recurring[]; recentFailures: Failure[] };
  unavailable?: string[];
};

const AREAS: readonly (readonly [string, string])[] = [
  ["search", "Search and data"],
  ["ai", "AI"],
  ["email", "Email"],
  ["billing", "Billing"],
  ["security", "Security"],
  ["privacy", "Privacy"],
  ["runtime", "Runtime"],
];

/** "1.2 GB" */
export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** "3 d 4 h", "12 min", "40 s" - a duration, the two largest units. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${fmtNum(d)} d ${h} h` : `${fmtNum(d)} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return `${m} min`;
  return `${s} s`;
}

const every = (s: number) => (s % 86400 === 0 ? (s === 86400 ? "daily" : `every ${s / 86400} days`) : s % 3600 === 0 ? (s === 3600 ? "hourly" : `every ${s / 3600} hours`) : `every ${fmtDuration(s)}`);

function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="card min-w-0 p-4" aria-label={title} data-testid={testId}>
      <h3 className="mb-3 text-sm font-semibold text-ink-50">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-400">{k}</dt>
          <dd className="min-w-0 text-ink-100 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-black/20"}`} />;
}

function ConfigChecklist({ items }: { items: ConfigItem[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="config-checklist">
      {AREAS.map(([area, title]) => {
        const rows = items.filter((i) => i.area === area);
        if (!rows.length) return null;
        const set = rows.filter((r) => r.set).length;
        return (
          <section key={area} className="card min-w-0 p-4" aria-label={`${title} settings`}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink-50">{title}</h4>
              <span className="text-xs text-ink-400">{fmtNum(set)} of {fmtNum(rows.length)} set</span>
            </div>
            <ul className="divide-y divide-black/5">
              {rows.map((r) => (
                <li key={r.key} className="flex gap-2.5 py-2" data-config={r.key} data-set={r.set ? "yes" : "no"}>
                  <Dot on={r.set} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-ink-100">{r.label}</span>
                      <code className="font-mono text-[11px] text-ink-400 [overflow-wrap:anywhere]">{r.key}</code>
                      {r.value ? <span className="badge border border-black/10 bg-black/[0.03] text-ink-200 [overflow-wrap:anywhere]">{r.value}</span> : <span className="sr-only">{r.set ? "set" : "not set"}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-400">{r.effect}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function JobsTable({ rows }: { rows: JobType[] }) {
  if (!rows.length) return <div className="text-sm text-ink-400">The queue is empty and nothing finished in the last 24 hours.</div>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-400">
            <th className="py-1.5 pr-3 font-semibold">Type</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Queued</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Running</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Failed 24h</th>
            <th className="hidden py-1.5 pr-3 text-right font-semibold sm:table-cell">Done 24h</th>
            <th className="hidden py-1.5 text-right font-semibold sm:table-cell">Oldest waiting</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5">
          {rows.map((r) => (
            <tr key={r.type}>
              <td className="py-1.5 pr-3 font-mono text-xs text-ink-100 [overflow-wrap:anywhere]">{r.type}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.queued)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.running)}</td>
              <td className={`py-1.5 pr-3 text-right tabular-nums ${r.failed24h ? "font-semibold text-red-700" : ""}`}>{fmtNum(r.failed24h)}</td>
              <td className="hidden py-1.5 pr-3 text-right tabular-nums sm:table-cell">{fmtNum(r.done24h)}</td>
              <td className="hidden py-1.5 text-right tabular-nums sm:table-cell">{r.oldestQueuedSeconds === null ? "-" : fmtDuration(r.oldestQueuedSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecurringList({ rows }: { rows: Recurring[] }) {
  if (!rows.length) return <div className="text-sm text-ink-400">No schedulers reported.</div>;
  return (
    <ul className="divide-y divide-black/5" data-testid="recurring-jobs">
      {rows.map((r) => (
        <li key={r.type} className="py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-ink-100">{r.type}</span>
            <span className={`badge ${r.healthy ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{r.running ? "Running now" : r.healthy ? "Scheduled" : "Needs attention"}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-ink-400">
            <span>Runs {every(r.intervalSeconds)}</span>
            <span>Last finished: {r.lastFinishedAt ? `${fmtDate(r.lastFinishedAt)}${r.lastStatus === "failed" ? " (failed)" : ""}` : "not in the last 8 days"}</span>
            <span>Next: {r.nextRunAt ? fmtDate(r.nextRunAt) : "-"}</span>
          </div>
          {r.problem && <div className="mt-1 text-xs text-red-700">{r.problem}</div>}
        </li>
      ))}
    </ul>
  );
}

function FailureList({ rows }: { rows: Failure[] }) {
  const [state, setState] = useState<Record<string, { busy?: boolean; msg?: string; err?: string }>>({});
  if (!rows.length) return <div className="text-sm text-ink-400">No failed jobs in the last 30 days.</div>;
  const retry = async (id: string) => {
    setState((s) => ({ ...s, [id]: { busy: true } }));
    try {
      const r = await adminFetch<{ ok?: boolean; note?: string }>("POST", `/v1/admin/jobs/${id}/retry`);
      // The row stays until the next refresh, so the answer is seen where the button was.
      setState((s) => ({ ...s, [id]: { msg: r?.note ? `Queued again. ${r.note}` : "Queued again for one more attempt. Refresh to see how it went." } }));
    } catch (e) {
      setState((s) => ({ ...s, [id]: { err: errText(e) } }));
    }
  };
  return (
    <ul className="divide-y divide-black/5" data-testid="recent-failures">
      {rows.map((f) => {
        const st = state[f.id] ?? {};
        return (
          <li key={f.id} className="py-2.5 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="font-mono text-xs text-ink-100">{f.type}</span>
                <span className="ml-2 text-xs text-ink-400">{f.orgName ?? (f.orgId ? "Deleted workspace" : "Platform")}</span>
              </div>
              {f.retryable ? (
                <button className="btn-secondary max-lg:min-h-[40px]" disabled={st.busy || !!st.msg} onClick={() => void retry(f.id)}>{st.busy ? "Retrying…" : st.msg ? "Queued" : "Retry"}</button>
              ) : (
                <span className="text-xs text-ink-400">Scheduler: re-runs on its own</span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-ink-400">
              {f.failedAt ? fmtDate(f.failedAt) : "-"} · attempt {fmtNum(f.attempts)} of {fmtNum(f.maxAttempts)}
            </div>
            {f.error && <div className="mt-1 rounded-md bg-black/[0.03] p-2 font-mono text-xs text-ink-200 [overflow-wrap:anywhere]">{f.error}</div>}
            {st.msg && <div className="mt-1 text-xs text-emerald-700" role="status">{st.msg}</div>}
            {st.err && <div className="mt-1 text-xs text-red-700" role="alert">{st.err}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function SystemTab() {
  const [data, setData] = useState<SystemReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    return adminFetch<SystemReport>("GET", "/v1/admin/system")
      .then((r) => {
        if (mine !== seq.current) return;
        setData(expectShape(r, (x) => !!x.build && !!x.database && Array.isArray(x.config) && !!x.jobs && Array.isArray(x.jobs.byType)));
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e)); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const d = data;
  return (
    <div data-testid="admin-system">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-50">System</h2>
          <div className="text-xs text-ink-400">{d?.serverTime ? `Server time ${fmtDate(d.serverTime)} (shown in your time zone)` : "Build, database, settings and the job queue"}</div>
        </div>
        <button className="btn-secondary max-lg:min-h-[40px]" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : d || !err ? "Refresh" : "Retry"}</button>
      </div>

      {err && (
        <div className="card mb-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
          {d ? "Could not refresh" : "Could not load the system view"}: {err}{" "}
          <button className={LINK_BTN} onClick={() => void load()} disabled={busy}>Retry</button>
        </div>
      )}
      {!d && !err && <div className="card p-5 text-sm text-ink-400" role="status">Loading the system view…</div>}

      {d && (
        <div className="space-y-4">
          {!!d.unavailable?.length && (
            <div className="card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status">
              Some parts could not be read in time: {d.unavailable.join(", ")}. Refresh to try again.
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Build" testId="build">
              <Facts
                rows={[
                  ["Commit", d.build.commit ? <code className="font-mono text-xs">{d.build.commit.slice(0, 12)}</code> : <span className="text-ink-400">Not reported by the host</span>],
                  ["Node", d.build.node],
                  ["Started", fmtDate(d.build.startedAt)],
                  ["Up for", fmtDuration(d.build.uptimeSeconds)],
                  ["Environment", d.build.nodeEnv],
                  ["Job mode", d.build.jobMode],
                  ["Worker in this process", d.build.embeddedWorker ? "Yes" : <span className="text-amber-800">No - a separate worker must run</span>],
                  ...(d.keepAwake ? ([["Keep-awake", d.keepAwake.configured ? `${d.keepAwake.window} ${d.keepAwake.timeZone ?? ""}${d.keepAwake.activeNow ? " (pinging now)" : " (outside the window now)"}` : d.keepAwake.onRender ? <span className="text-amber-800">Off - the instance sleeps after 15 idle minutes</span> : "Off"]] as [string, ReactNode][]) : []),
                ]}
              />
            </Card>
            <Card title="Database" testId="database">
              <Facts
                rows={[
                  ["Migrations applied", d.database.migrationsApplied === null ? "-" : fmtNum(d.database.migrationsApplied)],
                  ["Latest migration", d.database.latestMigration ? <code className="font-mono text-xs">{d.database.latestMigration}</code> : "-"],
                  ["Size", fmtBytes(d.database.sizeBytes)],
                ]}
              />
              {d.database.largestTables.length > 0 && (
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-400">
                      <th className="py-1 pr-3 font-semibold">Largest tables</th>
                      <th className="py-1 pr-3 text-right font-semibold">Rows (est.)</th>
                      <th className="py-1 text-right font-semibold">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/5">
                    {d.database.largestTables.map((t) => (
                      <tr key={t.name}>
                        <td className="py-1 pr-3 font-mono text-xs [overflow-wrap:anywhere]">{t.name}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{t.estimatedRows === null ? "not counted yet" : fmtNum(t.estimatedRows)}</td>
                        <td className="py-1 text-right tabular-nums">{fmtBytes(t.sizeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <section aria-label="Configuration">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-sm font-semibold text-ink-50">Configuration</h3>
              <span className="text-xs text-ink-400">Green: set on the server. Grey: not set. Secret values are never shown.</span>
            </div>
            <ConfigChecklist items={d.config} />
          </section>

          <Card title="Job queue" testId="jobs">
            <JobsTable rows={d.jobs.byType} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Schedulers">
              <RecurringList rows={d.jobs.recurring} />
            </Card>
            <Card title="Recent failures">
              <FailureList rows={d.jobs.recentFailures} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
