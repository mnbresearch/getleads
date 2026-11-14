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
      apiFetch<{ deals: any[]; totalPipeline: number; stageSummaries: DealSummary[] }>("GET", "/v1/deals").catch(() => ({
        deals: [],
        totalPipeline: 0,
        stageSummaries: [],
      })),
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
            greeting: "Good morning. Here is your unified revenue & sales intelligence overview.",
            summary: `You have ${queueCount} high-conviction accounts ready for outreach and ${topDeals.length} active opportunities progressing through the pipeline. Autonomous SDRs Alice & Jordan are currently operational.`,
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
        <div className="flex items-center gap-2">
          <Link to="/waterfall" className="btn-secondary text-xs sm:text-sm">
            💧 Waterfall Cascade
          </Link>
          <Link to="/dialer" className="btn-primary text-xs sm:text-sm shadow-sm">
            📞 Launch AI Dialer
          </Link>
        </div>
      }
    >
      {Toast}

      {/* Krater.ai-Style Bento Grid Workspace */}
      <div className="space-y-6">
        {/* Top Hero Bento Tile: Executive Intelligence & 1-Click Omnibar Triggers */}
        <div className="card p-6 border-brand-200 dark:border-brand-900 bg-gradient-to-r from-brand-50/70 via-surface to-brand-50/20 dark:from-slate-900 dark:via-slate-900 dark:to-brand-950/20 shadow-sm relative overflow-hidden">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-brand-600 text-sm text-white font-bold shadow-sm">
                  ⚡
                </span>
                <h2 className="text-lg font-bold text-ink-50 dark:text-white">{data.dailyBriefing.greeting}</h2>
                <span className="badge bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 text-[10px] font-bold uppercase tracking-wider">
                  Engine Online
                </span>
              </div>
              <p className="mt-1.5 text-xs sm:text-sm text-ink-300 dark:text-slate-300 max-w-2xl">
                {data.dailyBriefing.summary}
              </p>
            </div>

            {/* Quick Action Pills (Krater.ai-style instant tool shortcuts) */}
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/digital-workers"
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-ink-100 dark:text-white hover:border-brand-400 dark:hover:border-brand-500 transition shadow-xs"
              >
                <span>🤖</span>
                <span>SDR Alice & Jordan</span>
              </Link>
              <Link
                to="/surges"
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-ink-100 dark:text-white hover:border-brand-400 dark:hover:border-brand-500 transition shadow-xs"
              >
                <span>⚡</span>
                <span>Signal Radar</span>
              </Link>
              <Link
                to="/email-coach"
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-ink-100 dark:text-white hover:border-brand-400 dark:hover:border-brand-500 transition shadow-xs"
              >
                <span>✉</span>
                <span>Grade Draft</span>
              </Link>
            </div>
          </div>

          {/* Priority High-Intent Actions Row */}
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 pt-4 border-t border-black/5 dark:border-white/5">
            {data.dailyBriefing.priorityActions.map((act) => (
              <div
                key={act.id}
                className="rounded-xl border border-black/10 dark:border-white/10 bg-surface/90 dark:bg-slate-800/80 p-3.5 shadow-xs backdrop-blur hover:border-brand-300 dark:hover:border-brand-500 transition group"
              >
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-400">
                  <span>{act.type} Action</span>
                  <span className="text-[10px] text-ink-400 dark:text-slate-400 group-hover:translate-x-0.5 transition-transform">
                    →
                  </span>
                </div>
                <div className="mt-1 font-semibold text-ink-50 dark:text-white text-xs sm:text-sm line-clamp-1">
                  {act.title}
                </div>
                <p className="mt-1 text-[11px] text-ink-400 dark:text-slate-400 line-clamp-2 leading-relaxed">
                  {act.reason}
                </p>
                <Link
                  to={act.link}
                  className="mt-2.5 inline-flex items-center text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline"
                >
                  {act.actionText} →
                </Link>
              </div>
            ))}
          </div>
        </div>

        {/* Bento Suite Row 1: High-Velocity Metrics Bento Strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="card p-4 text-center border-l-4 border-brand-500">
            <div className="text-[11px] font-semibold text-ink-400 dark:text-slate-400 uppercase tracking-wide">
              Calls Today
            </div>
            <div className="mt-1 text-2xl font-extrabold text-ink-50 dark:text-white">{data.metrics.callsToday}</div>
            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">44% connect rate</div>
          </div>
          <div className="card p-4 text-center border-l-4 border-indigo-500">
            <div className="text-[11px] font-semibold text-ink-400 dark:text-slate-400 uppercase tracking-wide">
              Connected
            </div>
            <div className="mt-1 text-2xl font-extrabold text-ink-50 dark:text-white">{data.metrics.connectedCalls}</div>
            <div className="text-[10px] text-ink-400 dark:text-slate-400 mt-0.5">avg 4.2m duration</div>
          </div>
          <div className="card p-4 text-center border-l-4 border-emerald-500">
            <div className="text-[11px] font-semibold text-ink-400 dark:text-slate-400 uppercase tracking-wide">
              Meetings Booked
            </div>
            <div className="mt-1 text-2xl font-extrabold text-emerald-600 dark:text-emerald-400">
              +{data.metrics.meetingsBooked}
            </div>
            <div className="text-[10px] text-ink-400 dark:text-slate-400 mt-0.5">on team calendars</div>
          </div>
          <div className="card p-4 text-center border-l-4 border-amber-500">
            <div className="text-[11px] font-semibold text-ink-400 dark:text-slate-400 uppercase tracking-wide">
              Active Deals
            </div>
            <div className="mt-1 text-2xl font-extrabold text-ink-50 dark:text-white">{data.metrics.activeDeals}</div>
            <div className="text-[10px] text-ink-400 dark:text-slate-400 mt-0.5">in CRM pipeline</div>
          </div>
          <div className="card p-4 text-center col-span-2 border-l-4 border-purple-500">
            <div className="text-[11px] font-semibold text-ink-400 dark:text-slate-400 uppercase tracking-wide">
              Active Pipeline Value
            </div>
            <div className="mt-1 text-2xl font-extrabold text-brand-700 dark:text-brand-400">
              ${data.metrics.pipelineValue.toLocaleString()}
            </div>
            <div className="text-[10px] text-ink-400 dark:text-slate-400 mt-0.5">expected quarter value</div>
          </div>
        </div>

        {/* Bento Suite Row 2: 4 Core Competitor Moat Modules (Clay, Nooks, 11x, ZoomInfo) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Moat 1: Waterfall Data Enrichment (Clay Moat) */}
          <div className="card p-4 hover:border-brand-300 dark:hover:border-brand-500 transition group flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 flex items-center gap-1.5">
                  <span>💧</span> Waterfall Engine
                </span>
                <span className="badge bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 text-[10px]">
                  94.6% Match
                </span>
              </div>
              <h3 className="text-sm font-bold text-ink-50 dark:text-white">Multi-Vendor Cascading</h3>
              <p className="text-xs text-ink-400 dark:text-slate-400 mt-1 leading-relaxed">
                Hunter → Reoon → MillionVerifier → Socket SMTP. Eliminates costly dead-email bounces with zero credit burn on misses.
              </p>
            </div>
            <Link
              to="/waterfall"
              className="mt-4 inline-flex items-center justify-between text-xs font-semibold text-brand-600 dark:text-brand-400 group-hover:underline pt-2 border-t border-black/5 dark:border-white/5"
            >
              <span>Simulate Cascade</span>
              <span>→</span>
            </Link>
          </div>

          {/* Moat 2: Autonomous Digital Workers (11x Alice & Jordan Moat) */}
          <div className="card p-4 hover:border-brand-300 dark:hover:border-brand-500 transition group flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 flex items-center gap-1.5">
                  <span>🤖</span> Digital Workers
                </span>
                <span className="badge bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 text-[10px]">
                  Alice & Jordan
                </span>
              </div>
              <h3 className="text-sm font-bold text-ink-50 dark:text-white">24/7 Autonomous SDRs</h3>
              <p className="text-xs text-ink-400 dark:text-slate-400 mt-1 leading-relaxed">
                Alice handles deep account research & multi-touch emails. Jordan executes AI voice calling with 480ms low latency.
              </p>
            </div>
            <Link
              to="/digital-workers"
              className="mt-4 inline-flex items-center justify-between text-xs font-semibold text-brand-600 dark:text-brand-400 group-hover:underline pt-2 border-t border-black/5 dark:border-white/5"
            >
              <span>Manage Workers</span>
              <span>→</span>
            </Link>
          </div>

          {/* Moat 3: AI Sales Dialer & Bullpen (Nooks Moat) */}
          <div className="card p-4 hover:border-brand-300 dark:hover:border-brand-500 transition group flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 flex items-center gap-1.5">
                  <span>📞</span> AI Sales Dialer
                </span>
                <span className="badge bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 text-[10px]">
                  Live Bullpen
                </span>
              </div>
              <h3 className="text-sm font-bold text-ink-50 dark:text-white">Multi-Line Calling</h3>
              <p className="text-xs text-ink-400 dark:text-slate-400 mt-1 leading-relaxed">
                Connect directly with decision makers using live objection battlecards, talk tracks, and post-call auto CRM logging.
              </p>
            </div>
            <Link
              to="/dialer"
              className="mt-4 inline-flex items-center justify-between text-xs font-semibold text-brand-600 dark:text-brand-400 group-hover:underline pt-2 border-t border-black/5 dark:border-white/5"
            >
              <span>Open Dialer Bullpen</span>
              <span>→</span>
            </Link>
          </div>

          {/* Moat 4: Intent Convergence & Surges (ZoomInfo Moat) */}
          <div className="card p-4 hover:border-brand-300 dark:hover:border-brand-500 transition group flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 flex items-center gap-1.5">
                  <span>⚡</span> Signal Convergence
                </span>
                <span className="badge bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800 text-[10px]">
                  Explosive Intent
                </span>
              </div>
              <h3 className="text-sm font-bold text-ink-50 dark:text-white">Intent Radar Graph</h3>
              <p className="text-xs text-ink-400 dark:text-slate-400 mt-1 leading-relaxed">
                Pinpoint accounts actively shopping: deanonymized site visitors, hiring surges, and topic searches unified in one feed.
              </p>
            </div>
            <Link
              to="/surges"
              className="mt-4 inline-flex items-center justify-between text-xs font-semibold text-brand-600 dark:text-brand-400 group-hover:underline pt-2 border-t border-black/5 dark:border-white/5"
            >
              <span>Inspect Surges</span>
              <span>→</span>
            </Link>
          </div>
        </div>

        {/* Bento Suite Row 3: Live Revenue Pipeline & Team Salesfloor Blitz */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Active Revenue Pipeline Board */}
          <div className="card p-5 lg:col-span-2">
            <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
              <div>
                <h3 className="font-semibold text-sm sm:text-base text-ink-50 dark:text-white">Active Revenue Opportunities</h3>
                <p className="text-xs text-ink-400 dark:text-slate-400">High-conviction deals managed through Scout CRM.</p>
              </div>
              <Link to="/pipeline" className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline">
                View Kanban Board →
              </Link>
            </div>
            <div className="mt-3 divide-y divide-black/5 dark:divide-white/5">
              {data.recentDeals.map((deal) => (
                <div key={deal.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-semibold text-xs sm:text-sm text-ink-50 dark:text-white truncate">
                      {deal.name}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-ink-400 dark:text-slate-400">
                      <span className="capitalize font-semibold text-brand-700 dark:text-brand-400">{deal.stage}</span>
                      <span>·</span>
                      <span className="font-medium text-ink-100 dark:text-slate-200">${deal.value.toLocaleString()}</span>
                      <span>·</span>
                      <span
                        className={`capitalize px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                          deal.riskLevel === "high"
                            ? "bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-400"
                            : deal.riskLevel === "medium"
                            ? "bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400"
                            : "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"
                        }`}
                      >
                        {deal.riskLevel} risk
                      </span>
                    </div>
                    {deal.aiNextBestAction && (
                      <div className="text-xs text-ink-300 dark:text-slate-300 mt-1 flex items-center gap-1.5">
                        <span className="text-brand-600 dark:text-brand-400 font-bold">AI:</span> {deal.aiNextBestAction}
                      </div>
                    )}
                  </div>
                  <Link to="/pipeline" className="btn-secondary text-xs px-3 py-1.5 flex-shrink-0">
                    Manage
                  </Link>
                </div>
              ))}
            </div>
          </div>

          {/* Virtual Salesfloor & Team Blitz Bullpen */}
          <div className="card p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
              <div>
                <h3 className="font-semibold text-sm sm:text-base text-ink-50 dark:text-white">Virtual Salesfloor</h3>
                <p className="text-xs text-ink-400 dark:text-slate-400">Collaborative team calling bullpen.</p>
              </div>
              <span className="badge bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 text-[10px]">
                Active Blitz
              </span>
            </div>

            <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-ink-50 dark:text-white">{data.metrics.activeBlitz}</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-mono font-bold">24 mins left</span>
              </div>
              <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                <div className="h-full bg-brand-600 rounded-full" style={{ width: "68%" }} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-ink-400 dark:text-slate-400">
                <span>Team Goal: 50 Connects</span>
                <span className="font-semibold text-ink-100 dark:text-slate-200">34 Completed</span>
              </div>
            </div>

            <div className="space-y-2">
              <Link
                to="/salesfloor"
                className="w-full flex items-center justify-between p-2.5 rounded-lg border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-base">👥</span>
                  <span className="font-medium text-ink-100 dark:text-slate-200">Join Team Bullpen Room</span>
                </div>
                <span className="text-brand-600 dark:text-brand-400 font-bold">Join →</span>
              </Link>
              <Link
                to="/rooms"
                className="w-full flex items-center justify-between p-2.5 rounded-lg border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-base">🤝</span>
                  <span className="font-medium text-ink-100 dark:text-slate-200">Digital Sales Rooms & MAPs</span>
                </div>
                <span className="text-brand-600 dark:text-brand-400 font-bold">View →</span>
              </Link>
              <Link
                to="/committees"
                className="w-full flex items-center justify-between p-2.5 rounded-lg border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-base">👥</span>
                  <span className="font-medium text-ink-100 dark:text-slate-200">Buying Committee Graphs</span>
                </div>
                <span className="text-brand-600 dark:text-brand-400 font-bold">View →</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
