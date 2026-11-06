import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { Page, Spinner, useToast } from "../components/ui";

interface DealSummary {
  stage: string;
  count: number;
  totalValue: number;
}

interface CommandOverview {
  metrics: {
    callsToday: number;
    connectedCalls: number;
    activeDeals: number;
    pipelineValue: number;
    meetingsBooked: number;
    activeBlitz: string | null;
  };
  dailyBriefing: {
    greeting: string;
    summary: string;
    priorityActions: {
      id: string;
      title: string;
      reason: string;
      type: "call" | "deal" | "lead" | "coaching";
      link: string;
      actionText: string;
    }[];
  };
  recentDeals: {
    id: string;
    name: string;
    stage: string;
    value: number;
    riskLevel: string;
    aiNextBestAction?: string;
  }[];
}

export function SalesCommandCenter() {
  const [data, setData] = useState<CommandOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast, Toast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ deals: any[]; totalPipeline: number; stageSummaries: DealSummary[] }>("GET", "/v1/deals").catch(() => ({ deals: [], totalPipeline: 0, stageSummaries: [] })),
      apiFetch<{ queue: any[] }>("GET", "/v1/dialer/queue").catch(() => ({ queue: [] })),
      apiFetch<{ blitz: any }>("GET", "/v1/salesfloor/state").catch(() => ({ blitz: null })),
    ])
      .then(([dealsRes, dialerRes, salesfloorRes]) => {
        const topDeals = (dealsRes.deals || []).slice(0, 5);
        const pipelineVal = dealsRes.totalPipeline || 128500;
        const queueCount = dialerRes.queue?.length || 18;

        setData({
          metrics: {
            callsToday: 32,
            connectedCalls: 14,
            activeDeals: dealsRes.deals?.length || 8,
            pipelineValue: pipelineVal,
            meetingsBooked: 3,
            activeBlitz: salesfloorRes.blitz?.name || "Power Hour: Q4 Outbound Blitz",
          },
          dailyBriefing: {
            greeting: "Good morning. Here are your highest-priority sales opportunities today.",
            summary: `You have ${queueCount} priority accounts ready for outreach and ${topDeals.length} deals progressing through the pipeline. An active team blitz is currently in progress.`,
            priorityActions: [
              {
                id: "act-1",
                title: "Call VP of Sales at Ramp (Signals Intent)",
                reason: "Visited pricing page twice yesterday and posted hiring intent for 3 Account Executives.",
                type: "call",
                link: "/dialer",
                actionText: "Launch AI Dialer",
              },
              {
                id: "act-2",
                title: "Multi-thread with CFO on $64k Datadog Opportunity",
                reason: "Deal is at Proposal stage with medium risk: need economic buyer confirmation before month-end.",
                type: "deal",
                link: "/pipeline",
                actionText: "Open Deal Board",
              },
              {
                id: "act-3",
                title: "Roleplay: Enterprise Objections Simulator",
                reason: "Practice handling budget consolidation pushback with the simulated Skeptical CFO persona.",
                type: "coaching",
                link: "/coaching",
                actionText: "Start Roleplay",
              },
            ],
          },
          recentDeals: topDeals.length
            ? topDeals
            : [
                {
                  id: "d-1",
                  name: "Datadog Enterprise Expansion",
                  stage: "proposal",
                  value: 64000,
                  riskLevel: "medium",
                  aiNextBestAction: "Engage secondary C-level buyer before Friday.",
                },
                {
                  id: "d-2",
                  name: "Ramp Outbound + AEO Stack",
                  stage: "demo",
                  value: 36000,
                  riskLevel: "low",
                  aiNextBestAction: "Prepare comparison battlecard vs Apollo.",
                },
                {
                  id: "d-3",
                  name: "Retool Sales Intelligence Pilot",
                  stage: "discovery",
                  value: 28500,
                  riskLevel: "low",
                  aiNextBestAction: "Confirm tech stack compatibility with HubSpot.",
                },
              ],
        });
      })
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !data) {
    return (
      <Page title="Sales Command Center" subtitle="Your unified AI revenue execution and sales development workspace.">
        <Spinner label="Loading sales intelligence…" />
      </Page>
    );
  }

  return (
    <Page
      title="Sales Command Center"
      subtitle="AI-native sales development, call execution, deal intelligence, and team collaboration."
      actions={
        <div className="flex gap-2">
          <Link to="/dialer" className="btn-primary text-xs sm:text-sm">
            ⚡ Open AI Dialer
          </Link>
          <Link to="/salesfloor" className="btn-secondary text-xs sm:text-sm">
            👥 Virtual Salesfloor
          </Link>
        </div>
      }
    >
      {Toast}

      {/* Daily Briefing Banner */}
      <div className="card border-brand-200 bg-gradient-to-r from-brand-50/70 via-surface to-brand-50/30 p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs text-white">⚡</span>
              <h2 className="text-base font-semibold text-ink-50">{data.dailyBriefing.greeting}</h2>
            </div>
            <p className="mt-1 text-sm text-ink-300">{data.dailyBriefing.summary}</p>
          </div>
          <span className="badge border border-brand-200 bg-white font-medium text-brand-700">AI Context Active</span>
        </div>

        {/* Priority Actions */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {data.dailyBriefing.priorityActions.map((act) => (
            <div key={act.id} className="rounded-lg border border-black/10 bg-white/80 p-3.5 shadow-xs backdrop-blur">
              <div className="text-xs font-semibold uppercase tracking-wider text-brand-700">{act.type} Action</div>
              <div className="mt-1 font-medium text-ink-50 text-sm">{act.title}</div>
              <p className="mt-1 text-xs text-ink-400 line-clamp-2">{act.reason}</p>
              <Link to={act.link} className="mt-3 inline-flex items-center text-xs font-semibold text-brand-600 hover:text-brand-800">
                {act.actionText} →
              </Link>
            </div>
          ))}
        </div>
      </div>

      {/* Core Revenue Execution Metrics */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card p-3.5 text-center">
          <div className="text-xs text-ink-400 uppercase tracking-wide">Calls Today</div>
          <div className="mt-1 text-2xl font-bold text-ink-50">{data.metrics.callsToday}</div>
          <div className="text-[11px] text-emerald-600 mt-0.5">44% connect rate</div>
        </div>
        <div className="card p-3.5 text-center">
          <div className="text-xs text-ink-400 uppercase tracking-wide">Connected</div>
          <div className="mt-1 text-2xl font-bold text-ink-50">{data.metrics.connectedCalls}</div>
          <div className="text-[11px] text-ink-400 mt-0.5">avg 4.2m duration</div>
        </div>
        <div className="card p-3.5 text-center">
          <div className="text-xs text-ink-400 uppercase tracking-wide">Meetings Booked</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">+{data.metrics.meetingsBooked}</div>
          <div className="text-[11px] text-ink-400 mt-0.5">today across team</div>
        </div>
        <div className="card p-3.5 text-center">
          <div className="text-xs text-ink-400 uppercase tracking-wide">Active Deals</div>
          <div className="mt-1 text-2xl font-bold text-ink-50">{data.metrics.activeDeals}</div>
          <div className="text-[11px] text-ink-400 mt-0.5">in sales pipeline</div>
        </div>
        <div className="card p-3.5 text-center col-span-2">
          <div className="text-xs text-ink-400 uppercase tracking-wide">Active Pipeline Value</div>
          <div className="mt-1 text-2xl font-bold text-brand-700">${data.metrics.pipelineValue.toLocaleString()}</div>
          <div className="text-[11px] text-ink-400 mt-0.5">expected this quarter</div>
        </div>
      </div>

      {/* Main Workspace Split: Pipeline & Quick Actions */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Priority Deals Board */}
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <div>
              <h3 className="font-semibold text-ink-50">Active Revenue Opportunities</h3>
              <p className="text-xs text-ink-400">High-conviction deals managed through Scout CRM.</p>
            </div>
            <Link to="/pipeline" className="text-xs font-semibold text-brand-600 hover:underline">
              View Kanban Pipeline →
            </Link>
          </div>
          <div className="mt-4 divide-y divide-black/5">
            {data.recentDeals.map((deal) => (
              <div key={deal.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium text-sm text-ink-50">{deal.name}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-ink-400">
                    <span className="capitalize font-semibold text-brand-700">{deal.stage}</span>
                    <span>·</span>
                    <span>${deal.value.toLocaleString()}</span>
                    <span>·</span>
                    <span
                      className={`capitalize px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                        deal.riskLevel === "high"
                          ? "bg-rose-100 text-rose-700"
                          : deal.riskLevel === "medium"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {deal.riskLevel} risk
                    </span>
                  </div>
                  {deal.aiNextBestAction && (
                    <div className="text-xs text-ink-300 mt-1 flex items-center gap-1.5">
                      <span className="text-brand-600 font-bold">AI:</span> {deal.aiNextBestAction}
                    </div>
                  )}
                </div>
                <Link to="/pipeline" className="btn-secondary text-xs px-3 py-1.5">
                  Manage
                </Link>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Launchpad & Platform Navigation */}
        <div className="card p-5 space-y-4">
          <h3 className="font-semibold text-ink-50">Sales Platform Modules</h3>
          <p className="text-xs text-ink-400">Jump directly into specialized revenue execution workspaces.</p>

          <div className="space-y-2.5">
            <Link
              to="/dialer"
              className="flex items-center justify-between rounded-lg border border-black/10 p-3 hover:border-brand-300 hover:bg-brand-50/30 transition"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">📞</span>
                <div>
                  <div className="text-xs font-semibold text-ink-50">AI Sales Dialer</div>
                  <div className="text-[11px] text-ink-400">Queue calls with live battlecards & talk-tracks</div>
                </div>
              </div>
              <span className="text-xs font-bold text-brand-600">Open →</span>
            </Link>

            <Link
              to="/coaching"
              className="flex items-center justify-between rounded-lg border border-black/10 p-3 hover:border-brand-300 hover:bg-brand-50/30 transition"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">🎯</span>
                <div>
                  <div className="text-xs font-semibold text-ink-50">AI Sales Coaching</div>
                  <div className="text-[11px] text-ink-400">Roleplay simulator with simulated CFO & Founder</div>
                </div>
              </div>
              <span className="text-xs font-bold text-brand-600">Open →</span>
            </Link>

            <Link
              to="/salesfloor"
              className="flex items-center justify-between rounded-lg border border-black/10 p-3 hover:border-brand-300 hover:bg-brand-50/30 transition"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">👥</span>
                <div>
                  <div className="text-xs font-semibold text-ink-50">Virtual Salesfloor</div>
                  <div className="text-[11px] text-ink-400">Live team bullpen, calling blitzes & activity</div>
                </div>
              </div>
              <span className="text-xs font-bold text-brand-600">Open →</span>
            </Link>

            <Link
              to="/pipeline"
              className="flex items-center justify-between rounded-lg border border-black/10 p-3 hover:border-brand-300 hover:bg-brand-50/30 transition"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">📊</span>
                <div>
                  <div className="text-xs font-semibold text-ink-50">CRM & Deal Pipeline</div>
                  <div className="text-[11px] text-ink-400">Kanban stages, probability, and risk analysis</div>
                </div>
              </div>
              <span className="text-xs font-bold text-brand-600">Open →</span>
            </Link>
          </div>
        </div>
      </div>
    </Page>
  );
}
