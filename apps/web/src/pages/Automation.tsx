import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, fmtDate } from "../lib/api";
import { Empty, LoadError, Page, Spinner, useToast } from "../components/ui";

interface AgentRun { id: string; agentType: string; status: string; rowsCreated: number | null; error: string | null; startedAt: string; completedAt: string | null }
interface JobChange {
  id: string;
  title: string;
  summary: string | null;
  companyName: string | null;
  confidence: number;
  createdAt: string;
  raw: { leadId?: string; kind?: string; sameEmployer?: boolean; from?: { company?: string | null; title?: string | null }; to?: { company?: string | null; title?: string | null } } | null;
}

export function AutomationPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [changes, setChanges] = useState<JobChange[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("VP Sales at B2B SaaS companies in India");
  const { toast, Toast } = useToast();

  const load = useCallback(() => {
    setErr(null);
    Promise.all([
      apiFetch<{ runs: AgentRun[] }>("GET", "/v1/automation/runs?limit=25"),
      apiFetch<{ changes: JobChange[] }>("GET", "/v1/signals/job-changes?days=90"),
    ])
      .then(([r, j]) => { setRuns(r.runs); setChanges(j.changes); })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const discover = async (preview: boolean) => {
    setBusy(preview ? "preview" : "run");
    try {
      const r = await apiFetch<{ found: number; created: number; duplicates: number; note?: string }>("POST", "/v1/automation/discover", { query, count: 25, preview });
      toast(preview ? `Would store ${r.found} leads` : `Found ${r.found}, stored ${r.created} new, ${r.duplicates} already known`);
      if (r.note) toast(r.note);
      load();
    } catch (e) {
      // The 502 case carries the real explanation: every provider refused us. Showing the
      // raw message matters here, because "no leads" and "nothing answered" look identical
      // in a lead list and only one of them is about the market.
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page title="Automation" subtitle="Scheduled discovery and job-change tracking. Every lead here came from a real source and can be traced back to the run that found it.">
      {Toast}
      {loading ? <Spinner label="Loading…" /> : err ? <LoadError message={err} onRetry={load} /> : (
        <div className="space-y-6">
          <div className="card p-5">
            <div className="mb-3 font-medium">Run discovery now</div>
            <div className="flex flex-wrap gap-2">
              <input className="input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Who are you looking for?" aria-label="Discovery query" />
              <button className="btn-secondary" disabled={!!busy || query.trim().length < 3} onClick={() => discover(true)}>{busy === "preview" ? "…" : "Preview"}</button>
              <button className="btn-primary" disabled={!!busy || query.trim().length < 3} onClick={() => discover(false)}>{busy === "run" ? "Searching…" : "Run"}</button>
            </div>
            <p className="mt-2 text-xs text-ink-400">
              Preview reports what would be stored without storing it or spending lead quota. A scheduled run does the same thing daily - see <code>.github/workflows/discovery-daily.yml</code>.
            </p>
          </div>

          <div className="card p-5">
            <div className="mb-3 font-medium">Job changes</div>
            {changes.length === 0 ? (
              <Empty
                title="No job changes detected yet"
                hint="Leads you have engaged, or that score well against your ICP, are re-checked daily. A champion who moves is the strongest buying signal there is - and it also tells you when a live deal has quietly lost its sponsor."
              />
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {changes.map((ch) => (
                  <li key={ch.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="font-medium">{ch.title}</div>
                      <div className="text-xs text-ink-400">{ch.summary}</div>
                      {ch.raw?.from?.company && ch.raw?.to?.company && !ch.raw.sameEmployer && (
                        <div className="mt-1 text-xs">
                          <span className="text-ink-400">{ch.raw.from.company}</span>
                          <span className="mx-1 text-ink-500">→</span>
                          <span className="font-medium">{ch.raw.to.company}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs">
                      <span className={`badge ${ch.raw?.sameEmployer ? "bg-brand-50 text-brand-700" : "bg-emerald-50 text-emerald-700"}`}>
                        {ch.raw?.sameEmployer ? "promoted" : "moved"}
                      </span>
                      {/* Shown because a name-only match can also be a rebrand or an acquisition. */}
                      <span className="text-ink-400" title="How sure we are this is a real change and not a data artefact">{Math.round(ch.confidence * 100)}%</span>
                      {ch.raw?.leadId && <Link className="text-brand-600 hover:underline" to={`/leads?q=${encodeURIComponent(ch.raw.to?.company ?? "")}`}>Open</Link>}
                      <span className="text-ink-500">{fmtDate(ch.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-5">
            <div className="mb-3 font-medium">Agent runs</div>
            {runs.length === 0 ? (
              <Empty title="No runs yet" hint="Run discovery above, or wait for the daily schedule." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-black/10 bg-cream">
                    <tr><th className="th">Started</th><th className="th">Agent</th><th className="th">Status</th><th className="th">Leads stored</th><th className="th">Detail</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td className="td whitespace-nowrap text-ink-400">{fmtDate(r.startedAt)}</td>
                        <td className="td">{r.agentType}</td>
                        <td className="td">
                          {/* "blocked" is its own status on purpose: a run that stored nothing
                              because nothing answered is not a run that found nothing. */}
                          <span className={`badge ${r.status === "completed" ? "bg-emerald-50 text-emerald-700" : r.status === "blocked" ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200" : r.status === "failed" ? "bg-red-50 text-red-700" : "bg-black/[0.05] text-ink-300"}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="td tabular-nums">{r.rowsCreated ?? 0}</td>
                        <td className="td text-xs text-ink-400">{r.error ?? (r.completedAt ? "" : "running…")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
