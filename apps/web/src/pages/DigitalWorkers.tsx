import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page } from "../components/ui";

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

  return (
    <Page title="Autonomous Digital Workers" subtitle="Dedicated AI workforce operating 24/7 across email, phone, and social channels with human-in-the-loop safeguards.">
      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Active Digital SDRs</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.activeWorkers || 2} Active</div>
          <div className="text-xs text-brand-700 mt-0.5">Alice (Inbound/Outbound) & Jordan (Voice)</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Automated Touches (24h)</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.totalTouches24h || 312}</div>
          <div className="text-xs text-emerald-700 mt-0.5">Across email sequences & phone connects</div>
        </div>
        <div className="card p-4 border-l-4 border-blue-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Meetings Generated</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.meetingsBookedThisWeek || 9}</div>
          <div className="text-xs text-blue-700 mt-0.5">Booked directly on rep calendars</div>
        </div>
        <div className="card p-4 border-l-4 border-amber-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Rep Time Reclaimed</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.hoursSavedVsManualSdr || 42.5} hrs</div>
          <div className="text-xs text-amber-700 mt-0.5">Equivalent to 2.5 full-time SDR seats</div>
        </div>
      </div>

      {/* Workers Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Worker: Alice */}
        <div className="card p-6 relative overflow-hidden border-brand-200">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow-md">
                A
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-ink-50">Alice</h3>
                  <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">Online 24/7</span>
                </div>
                <p className="text-xs text-ink-400">Autonomous Outbound SDR (Email, LinkedIn & Research)</p>
              </div>
            </div>
            <span className="badge bg-brand-50 text-brand-700 border border-brand-200 text-xs">Autonomous Mode</span>
          </div>

          <div className="mt-6 space-y-3">
            <div className="p-3 rounded-lg bg-black/[0.02] border border-black/5">
              <div className="flex justify-between text-xs text-ink-400 mb-1">
                <span>Daily Outbound Capacity</span>
                <span className="font-semibold text-ink-50">84 / 250 touches</span>
              </div>
              <div className="h-2 rounded-full bg-black/10 overflow-hidden">
                <div className="h-full bg-brand-600 rounded-full" style={{ width: "33%" }} />
              </div>
            </div>

            <div className="text-xs space-y-1.5 text-ink-300">
              <div className="flex items-center justify-between">
                <span>Research Depth:</span>
                <span className="font-medium text-ink-50">Profile + Company Recent News & Funding</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Inbound Reply Handling:</span>
                <span className="font-medium text-emerald-600">Auto-Categorize & Draft Responses</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Calendar Booking:</span>
                <span className="font-medium text-brand-600">Direct Link + Multi-Timezone Proposals</span>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-black/5 flex items-center justify-between">
            <div className="text-xs text-ink-400">Trained on your ICP & verified case studies</div>
            <button className="btn-secondary text-xs">Configure Prompts</button>
          </div>
        </div>

        {/* Worker: Jordan */}
        <div className="card p-6 relative overflow-hidden border-indigo-200">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-md">
                J
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-ink-50">Jordan</h3>
                  <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">Online 24/7</span>
                </div>
                <p className="text-xs text-ink-400">AI Voice & Telephony Specialist (Phone Follow-ups)</p>
              </div>
            </div>
            <span className="badge bg-amber-50 text-amber-700 border border-amber-200 text-xs">Human-in-Loop</span>
          </div>

          <div className="mt-6 space-y-3">
            <div className="p-3 rounded-lg bg-black/[0.02] border border-black/5">
              <div className="flex justify-between text-xs text-ink-400 mb-1">
                <span>Daily Voice Outreach</span>
                <span className="font-semibold text-ink-50">32 / 120 calls</span>
              </div>
              <div className="h-2 rounded-full bg-black/10 overflow-hidden">
                <div className="h-full bg-indigo-600 rounded-full" style={{ width: "26%" }} />
              </div>
            </div>

            <div className="text-xs space-y-1.5 text-ink-300">
              <div className="flex items-center justify-between">
                <span>Voice Latency:</span>
                <span className="font-medium text-ink-50">480ms (Ultra-Low Latency Conversational)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Objection Handling:</span>
                <span className="font-medium text-emerald-600">Dynamic Live Battlecards</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Post-Call Processing:</span>
                <span className="font-medium text-brand-600">Auto-Transcript, Sentiment & CRM Sync</span>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-black/5 flex items-center justify-between">
            <div className="text-xs text-ink-400">Safety: Calls require rep approval or pre-warmed list</div>
            <button className="btn-secondary text-xs">Configure Voice Tone</button>
          </div>
        </div>
      </div>
    </Page>
  );
}
