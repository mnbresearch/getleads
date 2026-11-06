import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Page, Spinner, useToast, Modal } from "../components/ui";

interface Deal {
  id: string;
  name: string;
  stage: "qualified" | "discovery" | "demo" | "proposal" | "negotiation" | "won" | "lost";
  value: number;
  currency: string;
  probability: number;
  riskLevel: string;
  riskSummary?: string;
  aiNextBestAction?: string;
}

const STAGES = [
  { key: "qualified", label: "Qualified", color: "border-sky-300" },
  { key: "discovery", label: "Discovery Call", color: "border-blue-400" },
  { key: "demo", label: "Demo Completed", color: "border-indigo-400" },
  { key: "proposal", label: "Proposal / Pricing", color: "border-amber-400" },
  { key: "negotiation", label: "Negotiation", color: "border-purple-400" },
  { key: "won", label: "Closed Won", color: "border-emerald-500" },
  { key: "lost", label: "Closed Lost", color: "border-zinc-400" },
] as const;

export function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [totalPipeline, setTotalPipeline] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [newDeal, setNewDeal] = useState({
    name: "",
    value: 25000,
    stage: "qualified" as Deal["stage"],
    notes: "",
  });
  const { toast, Toast } = useToast();

  const loadDeals = useCallback(() => {
    setLoading(true);
    apiFetch<{ deals: Deal[]; totalPipeline: number }>("GET", "/v1/deals")
      .then((res) => {
        setDeals(res.deals || []);
        setTotalPipeline(res.totalPipeline || 0);
      })
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    loadDeals();
  }, [loadDeals]);

  const advanceStage = async (deal: Deal, targetStage: Deal["stage"]) => {
    try {
      await apiFetch("PATCH", `/v1/deals/${deal.id}`, { stage: targetStage });
      toast(`Moved "${deal.name}" to ${targetStage}`);
      loadDeals();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const createDeal = async () => {
    if (!newDeal.name.trim()) return;
    try {
      await apiFetch("POST", "/v1/deals", {
        name: newDeal.name.trim(),
        value: Number(newDeal.value) || 0,
        stage: newDeal.stage,
        notes: newDeal.notes.trim() || undefined,
      });
      toast("Deal created and added to pipeline!");
      setModalOpen(false);
      setNewDeal({ name: "", value: 25000, stage: "qualified", notes: "" });
      loadDeals();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  if (loading) {
    return (
      <Page title="CRM & Deal Pipeline" subtitle="Opportunity board with deal velocity, revenue forecasting, and AI risk analysis.">
        <Spinner label="Loading pipeline..." />
      </Page>
    );
  }

  return (
    <Page
      title="CRM & Deal Pipeline"
      subtitle="Opportunity tracking board with deal risk analysis, AI next-best-action guidance, and revenue forecasting."
      actions={
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-[11px] font-semibold uppercase text-ink-400">Total Active Pipeline</div>
            <div className="text-base font-bold text-brand-700">${totalPipeline.toLocaleString()}</div>
          </div>
          <button className="btn-primary text-xs" onClick={() => setModalOpen(true)}>
            + Create Deal
          </button>
        </div>
      }
    >
      {Toast}

      {/* Kanban Board Columns */}
      <div className="mt-4 flex gap-4 overflow-x-auto pb-4 items-start min-h-[650px]">
        {STAGES.map((col) => {
          const stageDeals = deals.filter((d) => d.stage === col.key);
          const colValue = stageDeals.reduce((acc, curr) => acc + (curr.value || 0), 0);

          return (
            <div
              key={col.key}
              className={`w-72 shrink-0 rounded-xl border bg-black/[0.02] p-3 border-t-4 ${col.color}`}
            >
              <div className="flex items-center justify-between border-b border-black/5 pb-2">
                <div className="font-semibold text-xs text-ink-50 capitalize">{col.label}</div>
                <span className="text-[11px] font-bold text-ink-400 bg-black/5 px-2 py-0.5 rounded-full">
                  {stageDeals.length}
                </span>
              </div>
              <div className="text-[11px] text-ink-400 mt-1 font-semibold">
                ${colValue.toLocaleString()}
              </div>

              {/* Deal Cards */}
              <div className="mt-3 space-y-3">
                {stageDeals.map((deal) => (
                  <div
                    key={deal.id}
                    className="card p-3.5 space-y-2 bg-white/90 shadow-xs hover:border-brand-300 transition"
                  >
                    <div className="font-semibold text-xs text-ink-50">{deal.name}</div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-brand-700">${deal.value.toLocaleString()}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
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
                      <div className="rounded bg-brand-50/60 p-2 text-[11px] text-brand-900 border border-brand-100">
                        <strong className="text-brand-700">Next Action:</strong> {deal.aiNextBestAction}
                      </div>
                    )}

                    {/* Stage Mover Selector */}
                    <div className="pt-2 border-t border-black/5 flex items-center justify-between text-[11px]">
                      <span className="text-ink-400">Move to:</span>
                      <select
                        className="text-[11px] border border-black/10 rounded px-1.5 py-0.5 bg-surface"
                        value={deal.stage}
                        onChange={(e) => advanceStage(deal, e.target.value as Deal["stage"])}
                      >
                        {STAGES.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}

                {stageDeals.length === 0 && (
                  <div className="text-center py-6 text-xs text-ink-400 border border-dashed border-black/10 rounded-lg">
                    No deals in this stage
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Deal Modal */}
      {modalOpen && (
        <Modal open={modalOpen} title="Create New Revenue Opportunity" onClose={() => setModalOpen(false)}>
          <div className="space-y-3">
            <div>
              <label className="label text-xs">Opportunity Name *</label>
              <input
                className="input text-xs"
                placeholder="e.g. Ramp - Enterprise Outbound Expansion"
                value={newDeal.name}
                onChange={(e) => setNewDeal({ ...newDeal, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label text-xs">Estimated Value ($)</label>
                <input
                  type="number"
                  className="input text-xs"
                  value={newDeal.value}
                  onChange={(e) => setNewDeal({ ...newDeal, value: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="label text-xs">Initial Stage</label>
                <select
                  className="input text-xs"
                  value={newDeal.stage}
                  onChange={(e) => setNewDeal({ ...newDeal, stage: e.target.value as Deal["stage"] })}
                >
                  {STAGES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label text-xs">Notes / Context</label>
              <textarea
                className="input text-xs h-20 resize-none"
                placeholder="Key discovery notes, timeline, decision makers..."
                value={newDeal.notes}
                onChange={(e) => setNewDeal({ ...newDeal, notes: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary text-xs" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary text-xs" onClick={createDeal} disabled={!newDeal.name.trim()}>
                Create Opportunity
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
