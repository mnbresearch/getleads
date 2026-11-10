import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner } from "../components/ui";

interface Stakeholder {
  id: string;
  name: string;
  title: string;
  email: string;
  role: "economic_buyer" | "champion" | "technical_evaluator" | "end_user" | "blocker" | "legal_procurement";
  engagementStatus: "uncontacted" | "contacted" | "engaged" | "supportive" | "objecting";
  lastTouchAt?: string;
  sentiment?: "positive" | "neutral" | "negative";
  customAngle?: string;
}

interface CommitteeItem {
  id: string;
  companyName: string;
  companyDomain: string;
  healthStatus: "single_threaded" | "multi_threaded" | "consensus_ready" | "at_risk";
  coverageScore: number;
  stakeholders: Stakeholder[];
  coverageGaps: string[];
  recommendedAction: string;
}

interface CommitteeStats {
  totalAccountsTracked: number;
  singleThreadedAtRisk: number;
  avgCommitteeCoverage: string;
  winRateLiftMultiThreaded: string;
}

export function BuyingCommitteesPage() {
  const [committees, setCommittees] = useState<CommitteeItem[]>([]);
  const [stats, setStats] = useState<CommitteeStats | null>(null);
  const [selectedCommittee, setSelectedCommittee] = useState<CommitteeItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ committees: CommitteeItem[]; stats: CommitteeStats }>("GET", "/v1/moat/committees")
      .then((res) => {
        const commList = res.committees || [];
        setCommittees(commList);
        setStats(res.stats || null);
        if (commList.length > 0) setSelectedCommittee(commList[0]);
      })
      .catch((err) => console.error("Error loading buying committees:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Page title="Buying Committee & Multi-Threading Intelligence" subtitle="Defend against the #1 killer of B2B deals: single-threaded champion traps. Map entire enterprise committees, flag coverage gaps, and coordinate role-specific touches.">
        <Spinner label="Loading buying committees…" />
      </Page>
    );
  }

  const getRoleBadge = (role: string) => {
    switch (role) {
      case "champion":
        return <span className="badge bg-emerald-100 text-emerald-800">Champion</span>;
      case "economic_buyer":
        return <span className="badge bg-purple-100 text-purple-800 font-semibold">Economic Buyer (CFO/VP)</span>;
      case "technical_evaluator":
        return <span className="badge bg-blue-100 text-blue-800">Tech / SecOps</span>;
      case "legal_procurement":
        return <span className="badge bg-amber-100 text-amber-800">Legal / Procurement</span>;
      default:
        return <span className="badge bg-black/5 text-ink-400">{role.replace("_", " ")}</span>;
    }
  };

  const getHealthBadge = (health: string) => {
    switch (health) {
      case "multi_threaded":
        return <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">Multi-Threaded (Healthy)</span>;
      case "single_threaded":
        return <span className="badge bg-rose-50 text-rose-700 border border-rose-200 font-bold">Single-Threaded Risk</span>;
      case "consensus_ready":
        return <span className="badge bg-purple-50 text-purple-700 border border-purple-200">Consensus Ready</span>;
      default:
        return <span className="badge bg-amber-50 text-amber-700 border border-amber-200">At Risk</span>;
    }
  };

  return (
    <Page
      title="Buying Committee & Multi-Threading Intelligence"
      subtitle="Defend against the #1 killer of B2B deals: single-threaded champion traps. Map entire enterprise committees, flag coverage gaps, and coordinate role-specific touches."
    >
      {/* Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Tracked Accounts</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{stats?.totalAccountsTracked || 2} Accounts</div>
          <div className="text-xs text-brand-700 mt-0.5">Active enterprise pipeline deals</div>
        </div>
        <div className="card p-4 border-l-4 border-rose-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Single-Threaded Deals</div>
          <div className="text-2xl font-bold text-rose-700 mt-1">{stats?.singleThreadedAtRisk || 1} At Risk</div>
          <div className="text-xs text-rose-700 mt-0.5">Missing Economic Buyer (CFO / VP)</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Avg Committee Coverage</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{stats?.avgCommitteeCoverage || "60%"}</div>
          <div className="text-xs text-emerald-700 mt-0.5">Champions, Finance, SecOps & Users</div>
        </div>
        <div className="card p-4 border-l-4 border-purple-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Win Rate Multiplier</div>
          <div className="text-2xl font-bold text-purple-700 mt-1">{stats?.winRateLiftMultiThreaded || "+42%"}</div>
          <div className="text-xs text-purple-700 mt-0.5">When 3+ personas engaged in parallel</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Account Selector (4 cols) */}
        <div className="lg:col-span-4 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-400 mb-1">Target Account Committees</div>
          {committees.map((comm) => (
            <div
              key={comm.id}
              onClick={() => setSelectedCommittee(comm)}
              className={`card p-4 cursor-pointer transition ${
                selectedCommittee?.id === comm.id ? "ring-2 ring-brand-500 border-brand-300 bg-brand-50/20" : "hover:border-brand-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-ink-50">{comm.companyName}</span>
                {getHealthBadge(comm.healthStatus)}
              </div>
              <div className="text-xs text-ink-400 font-mono mt-0.5">{comm.companyDomain}</div>

              <div className="mt-3">
                <div className="flex justify-between text-xs text-ink-400 mb-1">
                  <span>Committee Coverage</span>
                  <span className="font-semibold text-ink-50">{comm.coverageScore}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-black/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${comm.coverageScore >= 70 ? "bg-emerald-500" : comm.coverageScore >= 40 ? "bg-amber-500" : "bg-rose-500"}`}
                    style={{ width: `${comm.coverageScore}%` }}
                  />
                </div>
              </div>

              {comm.coverageGaps.length > 0 && (
                <div className="mt-2.5 text-[11px] text-rose-700 bg-rose-50 p-2 rounded border border-rose-100 flex items-start gap-1">
                  <span>⚠️</span>
                  <span>{comm.coverageGaps[0]}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Committee Matrix Details (8 cols) */}
        <div className="lg:col-span-8">
          {selectedCommittee ? (
            <div className="card p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/5 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-ink-50">{selectedCommittee.companyName} Buying Committee</h2>
                    {getHealthBadge(selectedCommittee.healthStatus)}
                  </div>
                  <p className="text-xs text-ink-400 mt-1">
                    {selectedCommittee.stakeholders.length} Stakeholders mapped · {selectedCommittee.coverageScore}% consensus coverage
                  </p>
                </div>
                <button className="btn-primary text-xs">Dispatch Multi-Thread Play</button>
              </div>

              {/* Recommended Next Best Action Banner */}
              <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-brand-900 uppercase tracking-wider">
                  <span>⚡ AI Multi-Threading Directive</span>
                </div>
                <p className="text-sm text-brand-950 font-medium mt-1">{selectedCommittee.recommendedAction}</p>
              </div>

              {/* Stakeholder Roster */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400 mb-3">Mapped Committee Stakeholders</h3>
                <div className="space-y-3">
                  {selectedCommittee.stakeholders.map((s) => (
                    <div key={s.id} className="p-4 rounded-xl border border-black/[0.08] bg-surface flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-ink-50">{s.name}</span>
                          {getRoleBadge(s.role)}
                          <span className={`badge text-[10px] ${s.engagementStatus === "supportive" ? "bg-emerald-50 text-emerald-700" : s.engagementStatus === "engaged" ? "bg-blue-50 text-blue-700" : "bg-black/5 text-ink-400"}`}>
                            {s.engagementStatus}
                          </span>
                        </div>
                        <div className="text-xs text-ink-300 font-medium">{s.title} · <span className="font-mono text-ink-400">{s.email}</span></div>
                        {s.customAngle && (
                          <div className="text-xs text-ink-400 italic bg-black/[0.02] p-2 rounded border border-black/5 mt-1">
                            &quot;{s.customAngle}&quot;
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button className="btn-secondary text-xs">Email Angle</button>
                        <button className="btn-secondary text-xs">Phone Script</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="card p-8 text-center text-ink-400">Select an account to view buying committee coverage.</div>
          )}
        </div>
      </div>
    </Page>
  );
}
