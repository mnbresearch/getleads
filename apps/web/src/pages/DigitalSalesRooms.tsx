import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { Page } from "../components/ui";

interface Milestone {
  id: string;
  title: string;
  owner: "buyer" | "seller" | "mutual";
  assignedTo: string;
  dueDate: string;
  completed: boolean;
  status: "pending" | "in_progress" | "completed" | "delayed";
}

interface RoomItem {
  id: string;
  title: string;
  shareToken: string;
  targetCompany: string;
  status: string;
  championName: string;
  championEmail: string;
  targetGoLiveDate: string;
  viewsCount: number;
  milestones: Milestone[];
  artifacts: { title: string; type: string }[];
}

interface RoomStats {
  activeRooms: number;
  avgMilestoneCompletion: string;
  buyerEngagementRate: string;
}

export function DigitalSalesRoomsPage() {
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [stats, setStats] = useState<RoomStats | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newChampion, setNewChampion] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ rooms: RoomItem[]; stats: RoomStats }>("GET", "/v1/moat/rooms")
      .then((res) => {
        setRooms(res.rooms);
        setStats(res.stats);
      })
      .catch((err) => console.error("Error loading sales rooms:", err));
  }, []);

  const createRoom = async () => {
    if (!newTitle || !newCompany) return;
    try {
      const res = await apiFetch<{ room: RoomItem }>("POST", "/v1/moat/rooms", {
        title: newTitle,
        targetCompany: newCompany,
        championName: newChampion,
      });
      setRooms([res.room, ...rooms]);
      setModalOpen(false);
      setNewTitle("");
      setNewCompany("");
      setNewChampion("");
    } catch (e: any) {
      alert("Failed to create room: " + e.message);
    }
  };

  const copyShareLink = (token: string) => {
    const url = `${window.location.origin}/dsr/${token}`;
    navigator.clipboard.writeText(url);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2500);
  };

  return (
    <Page
      title="Digital Sales Rooms & Mutual Action Plans (MAP)"
      subtitle="Equip your champions to sell on your behalf. Shared collaborative deal hubs housing ROI models, security clearances, mutual action timelines, and stakeholder deliverables."
      actions={
        <button onClick={() => setModalOpen(true)} className="btn-primary">
          + Create Digital Sales Room
        </button>
      }
    >
      {/* Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        <div className="card p-4 border-l-4 border-brand-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Active Buying Rooms</div>
          <div className="text-2xl font-bold text-ink-50 mt-1">{stats?.activeRooms || rooms.length} Hubs</div>
          <div className="text-xs text-brand-700 mt-0.5">Live champion collaborative workspaces</div>
        </div>
        <div className="card p-4 border-l-4 border-emerald-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Milestone Completion Pace</div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">{stats?.avgMilestoneCompletion || "50%"}</div>
          <div className="text-xs text-emerald-700 mt-0.5">Security, Legal & Pilot Milestones</div>
        </div>
        <div className="card p-4 border-l-4 border-purple-500">
          <div className="text-xs uppercase tracking-wider text-ink-400 font-semibold">Buyer Engagement Rate</div>
          <div className="text-2xl font-bold text-purple-700 mt-1">{stats?.buyerEngagementRate || "88%"}</div>
          <div className="text-xs text-purple-700 mt-0.5">Execs viewing DSR content before calls</div>
        </div>
      </div>

      {/* Rooms Grid */}
      <div className="space-y-4">
        {rooms.map((room) => {
          const completedCount = room.milestones?.filter((m) => m.completed).length || 0;
          const totalMilestones = room.milestones?.length || 1;
          const pct = Math.round((completedCount / totalMilestones) * 100);

          return (
            <div key={room.id} className="card p-6 hover:border-brand-300 transition">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/5 pb-4 mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-ink-50">{room.title}</h3>
                    <span className="badge bg-emerald-50 text-emerald-700 border border-emerald-200">Active Room</span>
                    <span className="badge bg-black/5 text-ink-400">{room.viewsCount || 0} Buyer Views</span>
                  </div>
                  <div className="text-xs text-ink-400 mt-0.5">
                    Target Company: <span className="font-semibold text-ink-200">{room.targetCompany}</span> · Champion:{" "}
                    <span className="font-semibold text-ink-200">{room.championName || "Sarah Chen"}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={`/dsr/${room.shareToken}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary text-xs"
                  >
                    Preview Hub ↗
                  </a>
                  <button
                    onClick={() => copyShareLink(room.shareToken)}
                    className="btn-primary text-xs"
                  >
                    {copiedToken === room.shareToken ? "✓ Link Copied!" : "Copy Champion Link"}
                  </button>
                </div>
              </div>

              {/* MAP Milestones Timeline */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                    Mutual Action Plan: {completedCount}/{totalMilestones} Steps Completed ({pct}%)
                  </div>
                </div>

                <div className="h-2 rounded-full bg-black/10 overflow-hidden">
                  <div className="h-full bg-brand-600 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                  {room.milestones?.map((m) => (
                    <div
                      key={m.id}
                      className={`p-3 rounded-lg border text-xs ${
                        m.completed
                          ? "bg-emerald-50/50 border-emerald-200 text-emerald-950"
                          : m.status === "in_progress"
                          ? "bg-brand-50/50 border-brand-200 text-brand-950"
                          : "bg-surface border-black/10 text-ink-300"
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold mb-1">
                        <span className="truncate">{m.title}</span>
                        <span>{m.completed ? "✓" : "○"}</span>
                      </div>
                      <div className="text-[11px] text-ink-400">Due: {m.dueDate} · {m.assignedTo}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal for Creating Digital Sales Room */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="card max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-ink-50">Create New Digital Sales Room</h3>
            <p className="text-xs text-ink-400">Generates a branded, collaborative hub equipped with an interactive Mutual Action Plan for your target champion.</p>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-ink-300">Room Title</label>
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Acme <> Scout Evaluation Hub"
                  className="w-full mt-1 p-2 text-sm rounded-lg border border-black/10 bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-ink-300">Target Company Name</label>
                <input
                  value={newCompany}
                  onChange={(e) => setNewCompany(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="w-full mt-1 p-2 text-sm rounded-lg border border-black/10 bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-ink-300">Internal Champion Name</label>
                <input
                  value={newChampion}
                  onChange={(e) => setNewChampion(e.target.value)}
                  placeholder="e.g. Sarah Chen (Head of Outbound)"
                  className="w-full mt-1 p-2 text-sm rounded-lg border border-black/10 bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-black/5">
              <button onClick={() => setModalOpen(false)} className="btn-secondary text-xs">Cancel</button>
              <button onClick={createRoom} className="btn-primary text-xs">Create Hub</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
