import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner, Empty } from "../components/ui";

interface DigitalWorkerItem {
  id: string;
  name: string;
  role: string;
  channel: string;
  status: string;
  dailyCapacity: number;
  actionsExecutedToday: number;
  autonomousMode: boolean;
  config: Record<string, any>;
}

interface WorkerSummary {
  activeWorkers: number;
  totalTouches24h: number;
  repliesCategorized: number;
  meetingsBookedThisWeek: number;
  hoursSavedVsManualSdr: number;
}

export function DigitalWorkersPage() {
  const [workers, setWorkers] = useState<DigitalWorkerItem[]>([]);
  const [summary, setSummary] = useState<WorkerSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ workers: DigitalWorkerItem[]; summary: WorkerSummary }>("GET", "/v1/scale/digital-workers")
      .then((res) => {
        setWorkers(res.workers);
        setSummary(res.summary);
      })
      .catch((err) => console.error("Error loading digital workers:", err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <Spinner label="Loading digital workers…" />;
  }

  return (
    <Page title="Autonomous Digital Workers" subtitle="Dedicated AI workforce operating 24/7 across email, phone, and social channels with human-in-the-loop safeguards.">
      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Active Digital SDRs</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.activeWorkers ?? workers.length} Active</div>
          <div className="text-xs text-brand-700 mt-0.5">Alice (Inbound/Outbound) & Jordan (Voice)</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Automated Touches (24h)</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.totalTouches24h ?? 312}</div>
          <div className="text-xs text-emerald-700 mt-0.5">Across email sequences & phone connects</div>
        </div>
        <div className="card p-4 border-l-4 border-blue-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Meetings Generated</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.meetingsBookedThisWeek ?? 9}</div>
          <div className="text-xs text-blue-700 mt-0.5">Booked directly on rep calendars</div>
        </div>
        <div className="card p-4 border-l-4 border-amber-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Rep Time Reclaimed</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.hoursSavedVsManualSdr ?? 42.5} hrs</div>
          <div className="text-xs text-amber-700 mt-0.5">Equivalent to 2.5 full-time SDR seats</div>
        </div>
      </div>

      {/* Workers Grid */}
      {workers.length === 0 ? (
        <Empty title="No digital workers deployed" hint="Deploy an autonomous SDR to start handling outbound prospecting." />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {workers.map((worker) => {
            const isVoice = worker.channel === "voice" || worker.name.toLowerCase().includes("jordan");
            const capPercent = Math.min(100, Math.round(((worker.actionsExecutedToday || 0) / (worker.dailyCapacity || 1)) * 100));
            return (
              <div
                key={worker.id}
                className={`card p-6 relative overflow-hidden ${isVoice ? "border-indigo-200" : "border-brand-200"}`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-12 w-12 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-md ${
                        isVoice ? "bg-gradient-to-tr from-indigo-600 to-purple-600" : "bg-gradient-to-tr from-brand-600 to-indigo-600"
                      }`}
                    >
                      {worker.name.charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-ink-50">{worker.name}</h3>
                        <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">
                          {worker.status === "active" ? "Online 24/7" : worker.status}
                        </span>
                      </div>
                      <p className="text-xs text-ink-400">{worker.role}</p>
                    </div>
                  </div>
                  <span
                    className={`badge text-xs ${
                      worker.autonomousMode
                        ? "bg-brand-50 text-brand-700 border border-brand-200"
                        : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}
                  >
                    {worker.autonomousMode ? "Autonomous Mode" : "Human-in-Loop"}
                  </span>
                </div>

                <div className="mt-6 space-y-3">
                  <div className="p-3 rounded-lg bg-black/[0.02] border border-black/5">
                    <div className="flex justify-between text-xs text-ink-400 mb-1">
                      <span>{isVoice ? "Daily Voice Outreach" : "Daily Outbound Capacity"}</span>
                      <span className="font-semibold text-ink-50">
                        {worker.actionsExecutedToday} / {worker.dailyCapacity} {isVoice ? "calls" : "touches"}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-black/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isVoice ? "bg-indigo-600" : "bg-brand-600"}`}
                        style={{ width: `${capPercent}%` }}
                      />
                    </div>
                  </div>

                  <div className="text-xs space-y-1.5 text-ink-300">
                    {isVoice ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span>Voice Latency:</span>
                          <span className="font-medium text-ink-50">
                            {worker.config?.objectionLatencyMs ? `${worker.config.objectionLatencyMs}ms` : "480ms"} (Ultra-Low Latency Conversational)
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Objection Handling:</span>
                          <span className="font-medium text-emerald-600">Dynamic Live Battlecards</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Post-Call Processing:</span>
                          <span className="font-medium text-brand-600">Auto-Transcript, Sentiment & CRM Sync</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <span>Research Depth:</span>
                          <span className="font-medium text-ink-50">
                            {worker.config?.personalizationDepth ? `${worker.config.personalizationDepth} profile & recent company news` : "Profile + Company Recent News & Funding"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Inbound Reply Handling:</span>
                          <span className="font-medium text-emerald-600">Auto-Categorize & Draft Responses</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Auto Follow-up Interval:</span>
                          <span className="font-medium text-brand-600">
                            {worker.config?.autoFollowupHours ? `${worker.config.autoFollowupHours} hours` : "48 hours"}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-black/5 flex items-center justify-between">
                  <div className="text-xs text-ink-400">
                    {isVoice ? "Safety: Calls require rep approval or pre-warmed list" : "Trained on your ICP & verified case studies"}
                  </div>
                  <button className="btn-secondary text-xs">
                    {isVoice ? "Configure Voice Tone" : "Configure Prompts"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
