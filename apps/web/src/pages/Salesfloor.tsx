import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { Page, Spinner, useToast } from "../components/ui";

interface BlitzState {
  id: string;
  name: string;
  targetCalls: number;
  targetMeetings: number;
  completedCalls: number;
  bookedMeetings: number;
  status: string;
}

interface TeamMember {
  id: string;
  name: string;
  status: "calling" | "in_call" | "ready" | "wrap_up";
  currentLead: string | null;
  callsToday: number;
  meetingsToday: number;
}

interface Milestone {
  rep: string;
  type: string;
  company: string;
  time: string;
}

export function SalesfloorPage() {
  const [blitz, setBlitz] = useState<BlitzState | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const { toast, Toast } = useToast();

  const loadState = useCallback(() => {
    apiFetch<{
      blitz: BlitzState;
      teamMembers: TeamMember[];
      recentMilestones: Milestone[];
      salesfloorOnlineCount: number;
    }>("GET", "/v1/salesfloor/state")
      .then((res) => {
        setBlitz(res.blitz);
        setTeam(res.teamMembers || []);
        setMilestones(res.recentMilestones || []);
        setOnlineCount(res.salesfloorOnlineCount || 0);
      })
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  if (loading || !blitz) {
    return (
      <Page title="Virtual Salesfloor" subtitle="Collaborative digital bullpen for sales teams with live presence and calling blitzes.">
        <Spinner label="Loading salesfloor presence…" />
      </Page>
    );
  }

  const callsProgress = Math.min(100, Math.round((blitz.completedCalls / blitz.targetCalls) * 100));
  const meetingsProgress = Math.min(100, Math.round((blitz.bookedMeetings / blitz.targetMeetings) * 100));

  return (
    <Page
      title="Virtual Salesfloor"
      subtitle="Recreate the energy and collaboration of a physical bullpen digitally. Shadow calls, cheer peer milestones, and power through team calling blitzes."
      actions={
        <div className="flex items-center gap-2">
          <span className="badge border border-emerald-300 bg-emerald-50 text-emerald-800 font-bold text-xs flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
            {onlineCount} Reps Active on Floor
          </span>
          <Link to="/dialer" className="btn-primary text-xs">
            ⚡ Join Calling Floor
          </Link>
        </div>
      }
    >
      {Toast}

      {/* Active Call Blitz Banner */}
      <div className="card p-6 border-brand-200 bg-gradient-to-r from-brand-50/70 via-surface to-brand-50/40">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="badge bg-brand-600 text-white font-bold text-[10px] uppercase tracking-wider">
              Live Team Blitz
            </span>
            <h2 className="mt-1.5 text-xl font-bold text-ink-50">{blitz.name}</h2>
            <p className="text-xs text-ink-400">Team target: {blitz.targetCalls} calls & {blitz.targetMeetings} meetings booked today.</p>
          </div>
          <div className="flex items-center gap-6 text-center">
            <div>
              <div className="text-xs font-semibold text-ink-400 uppercase">Calls Progress</div>
              <div className="text-xl font-bold text-ink-50 mt-0.5">
                {blitz.completedCalls} / {blitz.targetCalls}
              </div>
              <div className="w-28 bg-black/10 rounded-full h-1.5 mt-1 overflow-hidden">
                <div className="bg-brand-600 h-full" style={{ width: `${callsProgress}%` }} />
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-ink-400 uppercase">Meetings Booked</div>
              <div className="text-xl font-bold text-emerald-600 mt-0.5">
                {blitz.bookedMeetings} / {blitz.targetMeetings}
              </div>
              <div className="w-28 bg-black/10 rounded-full h-1.5 mt-1 overflow-hidden">
                <div className="bg-emerald-500 h-full" style={{ width: `${meetingsProgress}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Active Sales Reps on Floor */}
        <div className="card p-5 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <div>
              <h3 className="font-semibold text-sm text-ink-50">Team Floor Status</h3>
              <p className="text-xs text-ink-400">Live dialing presence across your sales team.</p>
            </div>
            <span className="text-xs text-brand-600 font-semibold cursor-pointer hover:underline" onClick={loadState}>
              Refresh ↻
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {team.map((member) => (
              <div key={member.id} className="rounded-lg border border-black/10 bg-white/70 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-sm text-ink-50">{member.name}</div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                      member.status === "in_call"
                        ? "bg-rose-100 text-rose-800"
                        : member.status === "calling"
                        ? "bg-amber-100 text-amber-800 animate-pulse"
                        : "bg-emerald-100 text-emerald-800"
                    }`}
                  >
                    {member.status.replace(/_/g, " ")}
                  </span>
                </div>

                {member.currentLead && (
                  <div className="text-xs text-ink-300 font-medium">
                    <span className="text-ink-400">Dialing:</span> {member.currentLead}
                  </div>
                )}

                <div className="pt-2 border-t border-black/5 flex items-center justify-between text-xs text-ink-400">
                  <span>Calls: <strong>{member.callsToday}</strong></span>
                  <span>Meetings: <strong className="text-emerald-700">{member.meetingsToday}</strong></span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Live Milestone Feed */}
        <div className="card p-5 space-y-4">
          <div className="border-b border-black/5 pb-3">
            <h3 className="font-semibold text-sm text-ink-50">Live Floor Feed</h3>
            <p className="text-xs text-ink-400">Real-time team wins, connects, and meeting milestones.</p>
          </div>

          <div className="space-y-3">
            {milestones.map((m, idx) => (
              <div key={idx} className="flex items-start gap-3 rounded-lg border border-black/5 p-3 bg-surface">
                <span className="text-lg">🎉</span>
                <div>
                  <div className="text-xs font-semibold text-ink-50">
                    {m.rep} <span className="font-normal text-ink-400">booked a demo at</span> {m.company}
                  </div>
                  <div className="text-[10px] text-ink-400 mt-0.5">{m.time}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 text-center">
            <div className="text-xs font-bold text-brand-800">Ready to contribute to the blitz?</div>
            <Link to="/dialer" className="btn-primary text-xs mt-2 inline-block px-4 py-1.5">
              Launch Outbound Dialer
            </Link>
          </div>
        </div>
      </div>
    </Page>
  );
}
