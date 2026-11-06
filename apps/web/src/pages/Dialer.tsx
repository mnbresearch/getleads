import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner, useToast } from "../components/ui";

interface QueueItem {
  id: string;
  name: string;
  title: string;
  phone: string;
  companyName: string;
  priorityScore: number;
  status: string;
  aiTalkTrack: {
    opener: string;
    discoveryQuestions: string[];
    objectionBattlecards: { objection: string; counter: string }[];
  };
}

export function DialerPage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [callActive, setCallActive] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnHold, setIsOnHold] = useState(false);
  const [callNotes, setCallNotes] = useState("");
  const [disposition, setDisposition] = useState("interested");
  const [busy, setBusy] = useState(false);
  const { toast, Toast } = useToast();

  const loadQueue = useCallback(() => {
    apiFetch<{ queue: QueueItem[] }>("GET", "/v1/dialer/queue")
      .then((res) => {
        setQueue(res.queue || []);
        setCurrentIdx(0);
      })
      .catch((e) => toast((e as Error).message, "err"));
  }, [toast]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Call timer simulation
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (callActive && !isOnHold) {
      interval = setInterval(() => {
        setCallSeconds((s) => s + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [callActive, isOnHold]);

  const activeContact = queue[currentIdx] || null;

  const startCall = () => {
    if (!activeContact) return;
    setCallActive(true);
    setCallSeconds(0);
    setIsMuted(false);
    setIsOnHold(false);
    toast(`Connecting to ${activeContact.name} (${activeContact.phone})…`);
  };

  const endCall = async () => {
    if (!activeContact) return;
    setBusy(true);
    try {
      await apiFetch("POST", "/v1/dialer/log", {
        leadId: activeContact.id,
        phoneNumber: activeContact.phone,
        durationSeconds: callSeconds,
        disposition,
        notes: callNotes,
      });
      toast(`Call logged: ${disposition.replace(/_/g, " ")} (${callSeconds}s)`);
      setCallActive(false);
      setCallSeconds(0);
      setCallNotes("");
      // Advance to next lead in queue
      if (currentIdx < queue.length - 1) {
        setCurrentIdx((i) => i + 1);
      }
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  if (!queue.length) {
    return (
      <Page title="AI Sales Dialer" subtitle="AI-assisted calling workspace with real-time talk-tracks and objection battlecards.">
        <Spinner label="Loading callable queue…" />
      </Page>
    );
  }

  return (
    <Page
      title="AI Sales Dialer"
      subtitle="Intelligent calling workspace with instant CRM context, live objection battlecards, and automatic post-call disposition logging."
      actions={
        <div className="flex items-center gap-2">
          <span className="badge border border-emerald-300 bg-emerald-50 text-emerald-800 font-medium text-xs">
            ● Voice WebRTC Ready (Twilio/Exotel)
          </span>
          <button className="btn-secondary text-xs" onClick={loadQueue}>
            Refresh Queue
          </button>
        </div>
      }
    >
      {Toast}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Panel: Calling Queue */}
        <div className="card p-4 lg:col-span-3 flex flex-col h-[750px]">
          <div className="flex items-center justify-between border-b border-black/5 pb-2.5">
            <div>
              <div className="font-semibold text-sm text-ink-50">Dialer Queue</div>
              <div className="text-[11px] text-ink-400">{queue.length} prospects prioritized</div>
            </div>
            <span className="badge bg-brand-50 text-brand-700 text-xs">Queue Active</span>
          </div>

          <div className="mt-3 flex-1 overflow-y-auto space-y-2 pr-1">
            {queue.map((item, idx) => (
              <div
                key={item.id}
                onClick={() => !callActive && setCurrentIdx(idx)}
                className={`p-3 rounded-lg border text-left cursor-pointer transition ${
                  currentIdx === idx
                    ? "border-brand-500 bg-brand-50/50 shadow-xs"
                    : "border-black/5 hover:border-black/15 bg-white/60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-xs text-ink-50 truncate max-w-[140px]">{item.name}</div>
                  <span className="text-[10px] font-bold text-brand-700 bg-brand-100/60 px-1.5 py-0.5 rounded">
                    Score {item.priorityScore}
                  </span>
                </div>
                <div className="text-[11px] text-ink-300 truncate mt-0.5">{item.title}</div>
                <div className="text-[11px] text-ink-400 font-mono mt-1">{item.phone}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Center Panel: Active Call Controller */}
        <div className="card p-6 lg:col-span-5 flex flex-col justify-between h-[750px]">
          <div>
            <div className="flex items-start justify-between border-b border-black/5 pb-4">
              <div>
                <span className="badge border border-brand-200 bg-brand-50 text-brand-700 text-xs uppercase tracking-wide">
                  Lead {currentIdx + 1} of {queue.length}
                </span>
                <h2 className="mt-2 text-xl font-bold text-ink-50">{activeContact?.name}</h2>
                <p className="text-xs text-ink-400">
                  {activeContact?.title} · {activeContact?.companyName}
                </p>
                <div className="mt-1 font-mono text-xs font-semibold text-ink-200">{activeContact?.phone}</div>
              </div>

              {/* Call Status Badge & Timer */}
              <div className="text-right">
                <div
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                    callActive ? "bg-emerald-100 text-emerald-800 animate-pulse" : "bg-black/5 text-ink-400"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${callActive ? "bg-emerald-500" : "bg-ink-300"}`} />
                  {callActive ? (isOnHold ? "On Hold" : "Call Live") : "Idle"}
                </div>
                <div className="mt-2 font-mono text-2xl font-bold text-ink-50">{formatTimer(callSeconds)}</div>
              </div>
            </div>

            {/* Quick Call Controls */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!callActive ? (
                <button
                  onClick={startCall}
                  className="btn-primary px-8 py-3 text-sm font-bold shadow-glow flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700"
                >
                  <span>📞</span> Start Outbound Call
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setIsMuted((m) => !m)}
                    className={`btn-secondary text-xs px-3 py-2 ${isMuted ? "bg-rose-100 text-rose-800 border-rose-300" : ""}`}
                  >
                    {isMuted ? "🔇 Unmute" : "🎙️ Mute"}
                  </button>
                  <button
                    onClick={() => setIsOnHold((h) => !h)}
                    className={`btn-secondary text-xs px-3 py-2 ${isOnHold ? "bg-amber-100 text-amber-800 border-amber-300" : ""}`}
                  >
                    {isOnHold ? "▶ Resume" : "⏸ Hold"}
                  </button>
                  <button
                    onClick={endCall}
                    disabled={busy}
                    className="btn-primary px-6 py-2.5 text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white"
                  >
                    End & Log Call ⏹
                  </button>
                </>
              )}
            </div>

            {/* Disposition & Call Notes */}
            <div className="mt-6 border-t border-black/5 pt-4 space-y-3">
              <div>
                <label className="label text-xs">Call Disposition</label>
                <select
                  className="input text-xs"
                  value={disposition}
                  onChange={(e) => setDisposition(e.target.value)}
                >
                  <option value="meeting_booked">🎉 Meeting Booked (Qualified Demo)</option>
                  <option value="interested">👍 Interested / Follow-up Requested</option>
                  <option value="follow_up">📅 Call Back Later / Timing</option>
                  <option value="gatekeeper_rejection">⛔ Gatekeeper Blocked / Transferred</option>
                  <option value="voicemail">📼 Left Voicemail</option>
                  <option value="no_answer">📵 No Answer / Ringing Out</option>
                  <option value="not_interested">❌ Not Interested / Do Not Contact</option>
                </select>
              </div>

              <div>
                <label className="label text-xs">Rep Call Notes</label>
                <textarea
                  className="input text-xs h-28 resize-none"
                  placeholder="Key objections raised, timeline details, next follow-up agreement…"
                  value={callNotes}
                  onChange={(e) => setCallNotes(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="text-center text-[11px] text-ink-400">
            Calls are automatically logged to Scout CRM and synced with connected workflows.
          </div>
        </div>

        {/* Right Panel: AI Live Talk-Track & Objection Battlecards */}
        <div className="card p-5 lg:col-span-4 flex flex-col h-[750px] overflow-y-auto space-y-4">
          <div className="border-b border-black/5 pb-3">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[10px] text-white">⚡</span>
              <h3 className="font-semibold text-sm text-ink-50">AI Live Assistant & Battlecards</h3>
            </div>
            <p className="text-[11px] text-ink-400 mt-0.5">Real-time talk tracks tailored to this account.</p>
          </div>

          {/* Recommended Opener */}
          <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-3.5">
            <div className="text-[11px] font-bold text-brand-800 uppercase tracking-wide">Suggested Opening</div>
            <p className="mt-1 text-xs text-ink-100 leading-relaxed italic">&ldquo;{activeContact?.aiTalkTrack.opener}&rdquo;</p>
          </div>

          {/* Discovery Questions */}
          <div className="rounded-lg border border-black/10 bg-surface p-3.5 space-y-2">
            <div className="text-[11px] font-bold text-ink-300 uppercase tracking-wide">High-Yield Discovery</div>
            <ul className="text-xs text-ink-200 space-y-2 list-disc pl-4">
              {activeContact?.aiTalkTrack.discoveryQuestions.map((q, idx) => (
                <li key={idx}>{q}</li>
              ))}
            </ul>
          </div>

          {/* Live Objection Battlecards */}
          <div className="space-y-2.5">
            <div className="text-[11px] font-bold text-ink-300 uppercase tracking-wide">Objection Battlecards</div>
            {activeContact?.aiTalkTrack.objectionBattlecards.map((b, idx) => (
              <div key={idx} className="rounded-lg border border-black/10 p-3 bg-white/70">
                <div className="text-xs font-semibold text-rose-700">&ldquo;{b.objection}&rdquo;</div>
                <div className="mt-1 text-xs text-ink-200 leading-relaxed">
                  <span className="font-semibold text-emerald-700">Counter:</span> {b.counter}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Page>
  );
}
