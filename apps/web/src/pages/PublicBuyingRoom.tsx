import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface Milestone {
  id: string;
  title: string;
  owner: "buyer" | "seller" | "mutual";
  assignedTo: string;
  dueDate: string;
  completed: boolean;
  status: "pending" | "in_progress" | "completed" | "delayed";
  notes?: string;
}

export function PublicBuyingRoomPage() {
  const { token } = useParams<{ token: string }>();
  const [room, setRoom] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ room: any }>("GET", `/v1/dsr/room/${token || "demo"}`)
      .then((res) => setRoom(res.room))
      .catch((err) => console.error("Error loading buying room:", err))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center p-6 text-sm text-ink-400">
        Loading Digital Sales Room...
      </div>
    );
  }

  const milestones: Milestone[] = room?.milestones || [];
  const completedCount = milestones.filter((m) => m.completed).length;
  const totalCount = milestones.length || 1;
  const pct = Math.round((completedCount / totalCount) * 100);

  return (
    <div className="min-h-screen bg-cream/60 py-10 px-4 sm:px-6 font-sans">
      <div className="mx-auto max-w-5xl space-y-8">
        {/* Header Strip */}
        <div className="card p-8 bg-surface shadow-md border-brand-200">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="badge bg-brand-50 text-brand-700 border border-brand-200">Shared Evaluation Hub</span>
                <span className="text-xs text-ink-400">Target Go-Live: {room?.targetGoLiveDate || "Dec 2026"}</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-ink-50 mt-2">{room?.title}</h1>
              <p className="text-sm text-ink-300 mt-1">
                Prepared by Scout by MNB Research for <strong className="text-ink-50">{room?.targetCompany}</strong> · Champion:{" "}
                <span className="text-brand-700 font-semibold">{room?.championName || "Executive Sponsor"}</span>
              </p>
            </div>

            <div className="text-right">
              <span className="badge bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold px-3 py-1">
                Mutual Action Plan Active
              </span>
            </div>
          </div>
        </div>

        {/* Mutual Action Plan Timeline */}
        <div className="card p-6 bg-surface shadow-sm">
          <div className="flex items-center justify-between border-b border-black/5 pb-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-ink-50">Mutual Action Plan (MAP)</h2>
              <p className="text-xs text-ink-400 mt-0.5">Shared milestones agreed upon to ensure evaluation success and timely go-live.</p>
            </div>
            <div className="text-sm font-bold text-brand-700">{pct}% Complete</div>
          </div>

          <div className="h-2 rounded-full bg-black/10 overflow-hidden mb-6">
            <div className="h-full bg-brand-600 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>

          <div className="space-y-3">
            {milestones.map((m, idx) => (
              <div
                key={m.id}
                className={`p-4 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                  m.completed ? "bg-emerald-50/40 border-emerald-200" : m.status === "in_progress" ? "bg-brand-50/30 border-brand-200 ring-1 ring-brand-300" : "bg-black/[0.01] border-black/10"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${m.completed ? "bg-emerald-600 text-white" : "bg-black/10 text-ink-400"}`}>
                    {m.completed ? "✓" : idx + 1}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-ink-50">{m.title}</div>
                    <div className="text-xs text-ink-400 mt-0.5">
                      Assigned to: <span className="font-semibold text-ink-200">{m.assignedTo}</span> · Target Date: {m.dueDate}
                    </div>
                    {m.notes && <div className="text-xs text-brand-800 font-medium mt-1">{m.notes}</div>}
                  </div>
                </div>

                <span className={`badge text-xs shrink-0 ${m.completed ? "bg-emerald-100 text-emerald-800" : m.status === "in_progress" ? "bg-brand-100 text-brand-800" : "bg-black/5 text-ink-400"}`}>
                  {m.completed ? "Completed" : m.status === "in_progress" ? "In Progress" : "Pending"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Resources & Deliverables Section */}
        <div className="card p-6 bg-surface shadow-sm">
          <h2 className="text-lg font-bold text-ink-50 mb-4">Executive Deliverables & Verification Artifacts</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-black/10 bg-black/[0.01]">
              <div className="text-lg mb-1">📊</div>
              <div className="text-sm font-bold text-ink-50">Executive ROI Model</div>
              <p className="text-xs text-ink-400 mt-1">Payback analysis showing CAC reduction within 90 days.</p>
              <button className="btn-secondary text-xs mt-3 w-full">Open ROI Calculator</button>
            </div>
            <div className="p-4 rounded-xl border border-black/10 bg-black/[0.01]">
              <div className="text-lg mb-1">🔒</div>
              <div className="text-sm font-bold text-ink-50">Security & SOC-2 Package</div>
              <p className="text-xs text-ink-400 mt-1">SOC-2 Type II audit report, GDPR/CCPA certifications, and DPA.</p>
              <button className="btn-secondary text-xs mt-3 w-full">Download Security Packet</button>
            </div>
            <div className="p-4 rounded-xl border border-black/10 bg-black/[0.01]">
              <div className="text-lg mb-1">⚡</div>
              <div className="text-sm font-bold text-ink-50">Implementation Playbook</div>
              <p className="text-xs text-ink-400 mt-1">Multi-channel cadence setup, dialer warm-up, and CRM mapping.</p>
              <button className="btn-secondary text-xs mt-3 w-full">Review Architecture</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
