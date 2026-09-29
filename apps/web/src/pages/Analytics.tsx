import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Empty, LoadError, Page, Spinner, useToast } from "../components/ui";

interface Stage { stage: string; label: string; count: number; conversionFromPrevious: number | null; conversionFromStart: number | null; currentlyHere: number }
interface Funnel { days: number; total: number; entered: number; lost: number; other: number; otherNote?: string; stages: Stage[]; biggestDropOff: { from: string; to: string; lostShare: number } | null; sufficient: boolean; note?: string }
interface SourceRow { source: string; leads: number; withEmail: number; verified: number; contacted: number; replied: number; qualified: number; customers: number; avgScore: number | null; replyRate: number | null; qualifiedRate: number | null; sufficient: boolean }
interface Sources { days: number; sources: SourceRow[]; note: string }
interface CampaignRow { campaignId: string; campaign: string; sent: number; opened: number; replied: number; qualifiedLeads: number; replyRate: number | null; openRate: number | null; sufficient: boolean; bestStep: number | null; steps: { stepNo: number | null; sent: number; opened: number; replied: number; replyRate: number | null }[] }
interface Attribution { days: number; campaigns: CampaignRow[]; model: string }

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n * 100)}%`);

/**
 * A rate with too little behind it is shown greyed and marked, never hidden.
 *
 * Hiding it would make a thin number look like no number; printing it plainly would make it
 * look like a finding. This is the third option: you can see it, and you can see that it
 * does not mean anything yet.
 */
function Rate({ value, sufficient, hint }: { value: number | null; sufficient: boolean; hint?: string }) {
  if (value === null) return <span className="text-ink-500">-</span>;
  return (
    <span className={sufficient ? "tabular-nums font-medium" : "tabular-nums text-ink-400"} title={sufficient ? hint : "Too few so far for this rate to mean anything"}>
      {pct(value)}
      {!sufficient && <span className="ml-1 text-[10px] uppercase tracking-wide">thin</span>}
    </span>
  );
}

export function AnalyticsPage() {
  const [days, setDays] = useState(90);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { Toast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    Promise.all([
      apiFetch<Funnel>("GET", `/v1/analytics/funnel?days=${days}`),
      apiFetch<Sources>("GET", `/v1/analytics/sources?days=${days}`),
      apiFetch<Attribution>("GET", `/v1/analytics/attribution?days=${days}`),
    ])
      .then(([f, s, a]) => { setFunnel(f); setSources(s); setAttribution(a); })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  return (
    <Page
      title="Analytics"
      subtitle="Where leads stall, where the good ones come from, and what actually produced the reply."
      actions={
        <select className="input w-36" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time window">
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      }
    >
      {Toast}
      {loading ? (
        <Spinner label="Loading…" />
      ) : err ? (
        <LoadError message={err} onRetry={load} />
      ) : (
        <div className="space-y-6">
          {/* ---- Funnel ---- */}
          <div className="card p-5">
            <div className="mb-1 font-medium">Pipeline</div>
            {funnel && !funnel.sufficient && <div className="mb-3 text-sm text-amber-700">{funnel.note}</div>}
            {funnel && funnel.entered === 0 ? (
              <Empty title="No leads in this window" hint="Run a search, or widen the time range." />
            ) : (
              <>
                <div className="space-y-2">
                  {funnel?.stages.map((s, i) => {
                    const widest = funnel.stages[0]?.count || 1;
                    return (
                      <div key={s.stage} className="flex items-center gap-3 text-sm">
                        <div className="w-24 shrink-0 text-ink-400">{s.label}</div>
                        <div className="h-6 flex-1 rounded bg-black/[0.04]">
                          <div className="h-6 rounded bg-brand-600/80" style={{ width: `${Math.max(1, (s.count / widest) * 100)}%` }} />
                        </div>
                        <div className="w-16 shrink-0 text-right tabular-nums font-medium">{s.count}</div>
                        <div className="w-20 shrink-0 text-right">
                          {i === 0 ? <span className="text-ink-500">-</span> : <Rate value={s.conversionFromPrevious} sufficient={funnel.sufficient} hint="of those who reached the previous stage" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-ink-400">
                  <span>{funnel?.entered} entered</span>
                  {!!funnel?.lost && <span>{funnel.lost} marked lost</span>}
                  {/* Named rather than quietly dropped, so the three buckets reconcile to
                      the lead count on screen instead of leaving a gap with no explanation. */}
                  {!!funnel?.other && (
                    <span title={funnel.otherNote} className="text-ink-500">
                      {funnel.other} outside the funnel
                    </span>
                  )}
                  {funnel?.biggestDropOff && (
                    <span className="text-amber-700">
                      Biggest drop: {funnel.biggestDropOff.from} → {funnel.biggestDropOff.to}, losing {pct(funnel.biggestDropOff.lostShare)}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ---- Sources ---- */}
          <div className="card p-5">
            <div className="mb-1 font-medium">Where your leads come from</div>
            <p className="mb-3 text-xs text-ink-400">{sources?.note}</p>
            {sources && sources.sources.length === 0 ? (
              <Empty title="Nothing to compare yet" hint="Once leads arrive from more than one source, this shows which is worth the effort." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b border-black/10 bg-cream">
                    <tr>
                      <th className="th">Source</th><th className="th">Leads</th><th className="th">Verified</th><th className="th">Contacted</th>
                      <th className="th">Replied</th><th className="th">Reply rate</th><th className="th">Qualified</th><th className="th">Customers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sources?.sources.map((s) => (
                      <tr key={s.source}>
                        <td className="td font-medium">{s.source}</td>
                        <td className="td tabular-nums">{s.leads}</td>
                        <td className="td tabular-nums text-ink-400">{s.verified}</td>
                        <td className="td tabular-nums">{s.contacted}</td>
                        <td className="td tabular-nums">{s.replied}</td>
                        <td className="td"><Rate value={s.replyRate} sufficient={s.sufficient} hint="of the leads from this source that were actually emailed" /></td>
                        <td className="td tabular-nums">{s.qualified}</td>
                        <td className="td tabular-nums font-medium">{s.customers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- Attribution ---- */}
          <div className="card p-5">
            <div className="mb-1 font-medium">What produced the reply</div>
            <p className="mb-3 text-xs text-ink-400">{attribution?.model}</p>
            {attribution && attribution.campaigns.length === 0 ? (
              <Empty title="No campaign sends in this window" hint="Attribution appears once a campaign has sent something." />
            ) : (
              <div className="space-y-4">
                {attribution?.campaigns.map((c) => (
                  <div key={c.campaignId} className="rounded-lg border border-black/10 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="font-medium">{c.campaign}</div>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-400">
                        <span>{c.sent} sent</span>
                        <span>{c.replied} replied</span>
                        <span>reply rate <Rate value={c.replyRate} sufficient={c.sufficient} /></span>
                        {c.qualifiedLeads > 0 && <span className="text-emerald-700">{c.qualifiedLeads} qualified</span>}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {c.steps.map((s) => (
                        <span
                          key={`${c.campaignId}-${s.stepNo}`}
                          className={`badge ${c.bestStep !== null && s.stepNo === c.bestStep ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-black/[0.05] text-ink-300"}`}
                          title={c.bestStep !== null && s.stepNo === c.bestStep ? "Best performing step, with enough sends behind it to say so" : undefined}
                        >
                          Step {s.stepNo ?? "?"}: {s.sent} sent, {s.replied} replied
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
