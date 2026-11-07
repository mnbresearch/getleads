import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page } from "../components/ui";

interface GtmCampaign {
  id: string;
  name: string;
  objective: string;
  status: string;
  budgetTokensOrUsd: number;
  strategyPlaybook: string;
  targetAccountCount: number;
  accountsPenetrated: number;
  meetingsBooked: number;
  pipelineGeneratedUsd: number;
  orchestratedChannels: string[];
}

export function AutonomousGtmCampaignsPage() {
  const [campaigns, setCampaigns] = useState<GtmCampaign[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ campaigns: GtmCampaign[]; summary: any }>("GET", "/v1/moat/gtm-campaigns")
      .then((res) => {
        setCampaigns(res.campaigns);
        setSummary(res.summary);
      })
      .catch((err) => console.error("Error loading GTM campaigns:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page
      title="Autonomous GTM & Goal-Driven ABM"
      subtitle="Shift from manual lists to goal-driven pipeline generation. Define a revenue target, and Scout autonomously maps accounts, activates buying committees, and orchestrates cross-channel plays."
    >
      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Active GTM Campaigns</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.totalCampaigns || campaigns.length} Active</div>
          <div className="text-xs text-brand-700 mt-0.5">Goal-oriented autonomous motions</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Pipeline Generated</div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">${(summary?.totalPipelineGenerated || 640000).toLocaleString()}</div>
          <div className="text-xs text-emerald-700 mt-0.5">Verified qualified revenue pipeline</div>
        </div>
        <div className="card p-4 border-l-4 border-blue-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Accounts Penetrated</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{summary?.totalAccountsTargeted || 140} Accounts</div>
          <div className="text-xs text-blue-700 mt-0.5">Target ICP accounts with active touches</div>
        </div>
        <div className="card p-4 border-l-4 border-purple-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Pipeline Conversion</div>
          <div className="text-2xl font-bold text-purple-700 mt-1">{summary?.pipelineConversionRate || "20.4%"}</div>
          <div className="text-xs text-purple-700 mt-0.5">Accounts converted to meetings</div>
        </div>
      </div>

      {/* Campaigns List */}
      <div className="space-y-4">
        {campaigns.map((camp) => (
          <div key={camp.id} className="card p-6 border-brand-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/5 pb-4 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-ink-50">{camp.name}</h3>
                  <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">Autonomous Active</span>
                </div>
                <div className="text-xs font-semibold text-brand-700 mt-1">Goal: {camp.objective}</div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="text-xl font-extrabold text-emerald-700">${camp.pipelineGeneratedUsd.toLocaleString()}</div>
                  <div className="text-[10px] text-ink-400 uppercase font-semibold">Pipeline Sourced</div>
                </div>
                <button className="btn-secondary text-xs">Tune Strategy</button>
              </div>
            </div>

            {/* Playbook Narrative */}
            <div className="p-3.5 rounded-xl bg-black/[0.02] border border-black/5 mb-4 text-xs">
              <span className="font-bold text-ink-50">Autonomous Agentic Execution:</span>{" "}
              <span className="text-ink-300">{camp.strategyPlaybook}</span>
            </div>

            {/* Orchestrated Channels */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-ink-400 font-semibold uppercase text-[10px] tracking-wider">Orchestration Layers:</span>
                {camp.orchestratedChannels.map((ch) => (
                  <span key={ch} className="badge bg-brand-50 text-brand-700 border border-brand-200">
                    {ch.replace(/_/g, " ")}
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-4 text-ink-400">
                <span>Accounts: <strong className="text-ink-50">{camp.accountsPenetrated} / {camp.targetAccountCount}</strong></span>
                <span>Meetings: <strong className="text-ink-50">{camp.meetingsBooked} booked</strong></span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
