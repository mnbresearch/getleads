import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { Empty, LoadError, Page, Spinner, useToast } from "../components/ui";

interface BlitzState {
  id: string;
  name: string;
  targetCalls: number;
  targetMeetings: number;
  startedAt?: string;
}

interface TeamMember {
  id: string;
  name: string;
  callsToday: number;
  meetingsToday: number;
}

interface Milestone {
  rep: string;
  type: string;
  time: string;
}

/**
 * The team's calling day, counted from the calls people actually logged in the dialer.
 * Nothing here is invented: no blitz is shown when none is running, the people are this
 * workspace's members, and every count comes from call logs since midnight UTC.
 */
export function SalesfloorPage() {
  const [blitz, setBlitz] = useState<BlitzState | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [callsToday, setCallsToday] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", targetCalls: 50, targetMeetings: 5 });
  const [starting, setStarting] = useState(false);
  const { toast, Toast } = useToast();

  const loadState = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ blitz: BlitzState | null; teamMembers: TeamMember[]; recentMilestones: Milestone[]; callsToday?: number }>("GET", "/v1/salesfloor/state")
      .then((res) => {
        setBlitz(res.blitz);
        setTeam(res.teamMembers || []);
        setMilestones(res.recentMilestones || []);
        setCallsToday(res.callsToday ?? 0);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const startBlitz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setStarting(true);
    try {
      await apiFetch("POST", "/v1/salesfloor/blitz", { name: form.name.trim(), targetCalls: form.targetCalls, targetMeetings: form.targetMeetings });
      toast("Blitz started");
      loadState();
    } catch (err) {
      toast((err as Error).message, "err");
    } finally {
      setStarting(false);
    }
  };

  const subtitle = "Your team's calling day: who is calling, how many calls and meetings today, and a shared target when you run a blitz.";
  if (loading) return <Page title="Salesfloor" subtitle={subtitle}><Spinner label="Loading the floor…" /></Page>;
  if (error) return <Page title="Salesfloor" subtitle={subtitle}><LoadError message={error} onRetry={loadState} /></Page>;

  const meetingsToday = team.reduce((a, m) => a + m.meetingsToday, 0);
  const bar = (n: number, d: number) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);

  return (
    <Page
      title="Salesfloor"
      subtitle={subtitle}
      actions={<Link to="/dialer" className="btn-primary text-xs">Open the dialer</Link>}
    >
      {Toast}
      {blitz ? (
        <div className="card border-brand-200 bg-gradient-to-r from-brand-50/70 via-surface to-brand-50/40 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="badge bg-brand-600 text-[10px] font-bold uppercase tracking-wider text-white">Blitz running</span>
              <h2 className="mt-1.5 text-xl font-bold text-ink-50">{blitz.name}</h2>
              <p className="text-xs text-ink-400">Target today: {blitz.targetCalls} calls and {blitz.targetMeetings} meetings. Counts are every call logged today.</p>
            </div>
            <div className="flex items-center gap-6 text-center">
              {[
                { l: "Calls", n: callsToday, d: blitz.targetCalls, c: "bg-brand-600" },
                { l: "Meetings", n: meetingsToday, d: blitz.targetMeetings, c: "bg-emerald-500" },
              ].map((x) => (
                <div key={x.l}>
                  <div className="text-xs font-semibold uppercase text-ink-400">{x.l}</div>
                  <div className="mt-0.5 text-xl font-bold text-ink-50">{x.n} / {x.d}</div>
                  <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-black/10"><div className={`${x.c} h-full`} style={{ width: `${bar(x.n, x.d)}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={startBlitz} className="card flex flex-wrap items-end gap-3 p-5">
          <div className="min-w-[200px] flex-1">
            <div className="label">Start a team blitz</div>
            <input className="input mt-1 w-full" placeholder="e.g. Tuesday power hour" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <div className="label">Calls</div>
            <input type="number" min={1} className="input mt-1 w-24" value={form.targetCalls} onChange={(e) => setForm({ ...form, targetCalls: Math.max(1, Number(e.target.value) || 1) })} />
          </div>
          <div>
            <div className="label">Meetings</div>
            <input type="number" min={1} className="input mt-1 w-24" value={form.targetMeetings} onChange={(e) => setForm({ ...form, targetMeetings: Math.max(1, Number(e.target.value) || 1) })} />
          </div>
          <button type="submit" className="btn-primary" disabled={starting || !form.name.trim()}>{starting ? "Starting…" : "Start blitz"}</button>
        </form>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card space-y-4 p-5 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-ink-50">Team today</h3>
              <p className="text-xs text-ink-400">{callsToday} calls and {meetingsToday} meetings logged since midnight UTC.</p>
            </div>
            <button type="button" className="border-0 bg-transparent p-0 text-xs font-semibold text-brand-600 hover:underline" onClick={loadState}>Refresh</button>
          </div>
          {team.length === 0 ? (
            <Empty title="No teammates yet" hint="Invite your team from Settings to see everyone's calls here." />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {team.map((m) => (
                <div key={m.id} className="space-y-2 rounded-lg border border-black/10 bg-white/70 p-4">
                  <div className="text-sm font-bold text-ink-50">{m.name}</div>
                  <div className="flex items-center justify-between border-t border-black/5 pt-2 text-xs text-ink-400">
                    <span>Calls: <strong>{m.callsToday}</strong></span>
                    <span>Meetings: <strong className="text-emerald-700">{m.meetingsToday}</strong></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card space-y-4 p-5">
          <div className="border-b border-black/5 pb-3">
            <h3 className="text-sm font-semibold text-ink-50">Today's calls</h3>
            <p className="text-xs text-ink-400">The latest calls logged in the dialer.</p>
          </div>
          {milestones.length === 0 ? (
            <p className="text-xs text-ink-400">No calls logged today yet.</p>
          ) : (
            <div className="space-y-2">
              {milestones.map((m, i) => (
                <div key={i} className="rounded-lg border border-black/5 bg-surface p-3 text-xs">
                  <span className="font-semibold text-ink-50">{m.rep}</span>{" "}
                  <span className="text-ink-400">{m.type === "meeting_booked" ? "booked a meeting" : "logged a call"}</span>
                  <div className="mt-0.5 text-[10px] text-ink-400">{new Date(m.time).toLocaleTimeString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
