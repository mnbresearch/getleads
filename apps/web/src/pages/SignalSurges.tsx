import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner, Empty } from "../components/ui";

interface SignalSurgeItem {
  id: string;
  companyName: string;
  companyDomain: string;
  compositeIntentScore: number;
  surgeLevel: string;
  primaryTopic: string;
  decisionMakersIdentified: number;
  detectedSignals: { source: string; detail: string; detectedAt: string }[];
}

interface SurgeAggregate {
  surgingAccounts: number;
  averageIntentScore: number;
  autoEnrolledInPlays: number;
}

export function SignalSurgesPage() {
  const [surges, setSurges] = useState<SignalSurgeItem[]>([]);
  const [aggregate, setAggregate] = useState<SurgeAggregate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ surges: SignalSurgeItem[]; aggregate: SurgeAggregate }>("GET", "/v1/scale/signal-surges")
      .then((res) => {
        setSurges(res.surges);
        setAggregate(res.aggregate);
      })
      .catch((err) => console.error("Error loading intent surges:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <Spinner label="Loading signal surges…" />;
  }

  return (
    <Page title="Signal Convergence & Intent Surges" subtitle="Unified buyer intent graph: combines website deanonymization, hiring sprees, social engagement, and topic search spikes to pinpoint accounts ready to buy.">
      {/* Top Metric Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <div className="card p-4 border-l-4 border-rose-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">High-Surge Accounts</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{aggregate?.surgingAccounts ?? surges.length} Accounts</div>
          <div className="text-xs text-rose-700 mt-0.5">Multiple intent sources firing simultaneously</div>
        </div>
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Average Composite Intent</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{aggregate?.averageIntentScore ?? 90} / 100</div>
          <div className="text-xs text-brand-700 mt-0.5">Top 5th percentile of target ICP universe</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Auto-Enrolled in Plays</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{aggregate?.autoEnrolledInPlays ?? 2} In Flight</div>
          <div className="text-xs text-emerald-700 mt-0.5">Dispatched to multi-channel cadences</div>
        </div>
      </div>

      {/* Surging Accounts List */}
      {surges.length === 0 ? (
        <Empty title="No active surges detected" hint="When prospects exhibit intent spikes (deanonymized traffic, funding, hiring), they will appear here." />
      ) : (
        <div className="space-y-4">
          {surges.map((account) => (
            <div key={account.id} className="card p-5 hover:border-brand-200 transition">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/5 pb-3 mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-ink-50">{account.companyName}</h3>
                    <span className="text-xs text-ink-400 font-mono">({account.companyDomain})</span>
                    <span className={`badge text-[10px] uppercase font-bold ${account.surgeLevel === "explosive" ? "bg-rose-100 text-rose-800" : "bg-brand-100 text-brand-800"}`}>
                      {account.surgeLevel} Surge
                    </span>
                  </div>
                  <div className="text-xs text-brand-700 mt-0.5 font-medium">Topic: {account.primaryTopic}</div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-lg font-bold text-ink-50">{account.compositeIntentScore}%</div>
                    <div className="text-[10px] text-ink-400">Composite Intent</div>
                  </div>
                  <button className="btn-primary text-xs">Launch Cadence</button>
                </div>
              </div>

              {/* Signal Stream */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Converged Signals Detected</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {(account.detectedSignals || []).map((sig, i) => (
                    <div key={i} className="p-2.5 rounded-lg bg-black/[0.02] border border-black/5">
                      <div className="flex items-center justify-between text-[11px] text-ink-400">
                        <span className="font-semibold text-brand-700">{sig.source}</span>
                        <span>{sig.detectedAt}</span>
                      </div>
                      <div className="text-xs text-ink-100 mt-1">{sig.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
