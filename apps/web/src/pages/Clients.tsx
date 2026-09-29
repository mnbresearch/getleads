import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { attentionTotal, type ClientRow, type Overview } from "../lib/clients";
import { ClientDot, ClientFormModal, StatusPill, TargetBar, emptyClientForm, toClientPayload } from "../components/ClientBits";
import { Empty, LoadError, Modal, Page, Spinner, Stat, useToast } from "../components/ui";

/**
 * The agency view: every client, how each is tracking against what was promised, what is
 * sitting unused, and the pool of leads that belong to nobody yet.
 */
export function ClientsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [routing, setRouting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { toast, Toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(() => {
    setErr(null);
    apiFetch<Overview>("GET", `/v1/clients${showArchived ? "?includeArchived=true" : ""}`)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [showArchived]);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals;

  return (
    <Page
      title="Clients"
      subtitle="Every lead belongs to a client, or waits in the pool for one. Nothing sourced goes unused without you seeing it."
      actions={
        <>
          <button className="btn-secondary" onClick={() => setRouting(true)} disabled={!data}>Route the pool</button>
          <button className="btn-primary" onClick={() => setCreating(true)}>New client</button>
        </>
      }
    >
      {Toast}
      {err ? (
        <LoadError message={err} onRetry={load} />
      ) : !data ? (
        <Spinner label="Loading clients…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Active clients" value={t!.activeClients} />
            <Stat
              label="Delivered this month"
              value={<span className="tabular-nums">{t!.deliveredThisMonth.toLocaleString()}{t!.targetThisMonth > 0 && <span className="text-base font-normal text-ink-400"> / {t!.targetThisMonth.toLocaleString()}</span>}</span>}
              hint={t!.targetThisMonth > 0 ? "Against the targets you set" : "Set monthly targets to track delivery"}
            />
            <Stat label="Behind target" value={<span className={t!.behindTarget ? "text-amber-700" : ""}>{t!.behindTarget}</span>} hint="Behind the pace for today's date" />
            <Stat label="Needs attention" value={<span className={t!.needsAttention ? "text-brand-700" : ""}>{t!.needsAttention.toLocaleString()}</span>} hint="Leads that can be recovered" />
            <Stat label="In the pool" value={data.pool.leads.toLocaleString()} hint={`${data.pool.verified.toLocaleString()} verified, belong to no client`} />
          </div>

          {data.pool.leads > 0 && (
            <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 border-brand-200 bg-brand-50/50 p-4">
              <div className="text-sm">
                <span className="font-semibold text-ink-50">{data.pool.leads.toLocaleString()} leads belong to no client.</span>{" "}
                <span className="text-ink-300">Scout can route the ones that clearly fit a client's ICP, and shows you the rest.</span>
              </div>
              <div className="flex gap-2">
                <Link to="/leads?clientId=none" className="btn-secondary">View pool</Link>
                <button className="btn-primary" onClick={() => setRouting(true)}>Review routing</button>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">Clients</h2>
            <label className="flex items-center gap-2 text-xs text-ink-400">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          </div>

          {data.clients.length === 0 ? (
            <div className="mt-3">
              <Empty
                title="No clients yet"
                hint="Add each company you generate pipeline for. Searches can then be run for a specific client, leads land in the right place, and each client gets a report link you can send them."
                action={<button className="btn-primary" onClick={() => setCreating(true)}>Add your first client</button>}
              />
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.clients.map((c) => (
                <ClientCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </>
      )}

      <ClientFormModal
        open={creating}
        onClose={() => setCreating(false)}
        initial={emptyClientForm()}
        title="New client"
        submitLabel="Create client"
        onSubmit={async (f) => {
          const c = await apiFetch<{ id: string; name: string }>("POST", "/v1/clients", toClientPayload(f));
          setCreating(false);
          toast(`${c.name} created`);
          navigate(`/clients/${c.id}`);
        }}
      />

      <RoutingModal
        open={routing}
        onClose={() => setRouting(false)}
        onChanged={() => load()}
        toast={toast}
      />
    </Page>
  );
}

function ClientCard({ c }: { c: ClientRow }) {
  const att = attentionTotal(c.attention);
  const s = c.stats;
  const cells: [string, number][] = [
    ["Leads", s.leads],
    ["Verified", s.verified],
    ["Contacted", s.contacted],
    ["Replied", s.replied],
    ["Qualified", s.qualified],
  ];
  return (
    <Link to={`/clients/${c.id}`} className="card group flex flex-col p-5 transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClientDot color={c.color} />
            <span className="truncate font-semibold text-ink-50 group-hover:text-brand-700">{c.name}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-400">{[c.domain, c.industry].filter(Boolean).join(" · ") || "No website set"}</div>
        </div>
        <StatusPill status={c.status} />
      </div>

      <div className="mt-4">
        <TargetBar t={c.target} compact />
      </div>

      <div className="mt-4 grid grid-cols-5 gap-1 text-center">
        {cells.map(([label, v]) => (
          <div key={label}>
            <div className="text-base font-semibold tabular-nums text-ink-50">{v.toLocaleString()}</div>
            <div className="text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-3 text-xs">
        {att > 0 ? (
          <span className="badge bg-brand-50 text-brand-700 ring-1 ring-brand-200">{att.toLocaleString()} need attention</span>
        ) : (
          <span className="text-ink-400">Nothing waiting</span>
        )}
        {!c.icpId && <span className="badge bg-black/[0.04] text-ink-400" title="Without an ICP, pooled leads cannot be routed here">No ICP</span>}
        {c.sharing && <span className="badge bg-black/[0.04] text-ink-400">Report shared</span>}
        {s.new7d > 0 && <span className="ml-auto text-ink-400">+{s.new7d} this week</span>}
      </div>
    </Link>
  );
}

interface Suggestion {
  leadId: string;
  fullName: string | null;
  title: string | null;
  company: string | null;
  best: { clientId: string; clientName: string; score: number; reasons: string[] } | null;
  runnerUp: { clientId: string; clientName: string; score: number } | null;
  coverage: number;
  mismatches: string[];
  hold: null | "no_fit" | "contested" | "too_little_data" | "partial_fit";
}
interface Routing {
  poolSize: number;
  examined: number;
  truncated: boolean;
  rules: { minFit: number; minMargin: number; minCoverage: number };
  routable: Suggestion[];
  held: { contested: Suggestion[]; partialFit: Suggestion[]; tooLittleData: number; noFit: number };
  unroutableClients: { clientId: string; name: string; reason: string }[];
}

/**
 * Review, then route. Clear fits can go in one click; ties are shown with both options so a
 * person makes the call. Nothing here is silently decided.
 */
function RoutingModal({ open, onClose, onChanged, toast }: { open: boolean; onClose: () => void; onChanged: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [r, setR] = useState<Routing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setR(null);
    setErr(null);
    setDone(new Set());
    apiFetch<Routing>("GET", "/v1/clients/routing?limit=300").then(setR).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  const remainingClear = r ? r.routable.filter((x) => !done.has(x.leadId)).length : 0;

  const assign = async (leadId: string, clientId: string) => {
    try {
      const res = await apiFetch<{ assigned: number; ownedByAnotherClient: number }>("POST", `/v1/clients/${clientId}/assign`, { leadIds: [leadId] });
      if (res.assigned) setDone((d) => new Set(d).add(leadId));
      else toast("Already assigned elsewhere - refresh to see the current pool", "err");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const auto = async () => {
    setBusy(true);
    try {
      // Only the clear fits this screen showed, and not the ones already assigned by hand.
      const shown = (r?.routable ?? []).map((x) => x.leadId).filter((id) => !done.has(id));
      const res = await apiFetch<{ routed: number; byClient: { name: string; assigned: number }[]; leftForReview: number }>("POST", "/v1/clients/routing/auto", { leadIds: shown });
      toast(res.routed ? `Routed ${res.routed} leads: ${res.byClient.filter((b) => b.assigned).map((b) => `${b.name} ${b.assigned}`).join(", ")}` : "Nothing clear enough to route automatically");
      onChanged();
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Route the pool" wide>
      {err ? (
        <LoadError message={err} onRetry={load} />
      ) : !r ? (
        <Spinner label="Scoring pooled leads against every client's ICP…" />
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-ink-300">
            A lead is suggested for a client only when it scores at least <b>{r.rules.minFit}</b> against that client's ICP, on enough real data (≥{Math.round(r.rules.minCoverage * 100)}% of the criteria known), and at least <b>{r.rules.minMargin}</b> points ahead of any other client. Anything closer is shown to you, not decided.
          </p>

          {r.unroutableClients.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Cannot route to {r.unroutableClients.map((u) => u.name).join(", ")} - {r.unroutableClients.length === 1 ? "it has" : "they have"} no ICP with criteria yet. Add one on the client's page.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <b className="text-ink-50">{remainingClear}</b> clear fits ·{" "}
              <b className="text-ink-50">{r.held.contested.length + r.held.partialFit.length}</b> need your call · {r.held.noFit} fit nobody · {r.held.tooLittleData} too little data
              {r.truncated && <span className="text-ink-400"> (the newest {r.examined} of {r.poolSize.toLocaleString()} examined)</span>}
            </div>
            <button className="btn-primary" disabled={busy || remainingClear === 0} onClick={auto}>{busy ? "Routing…" : `Route these ${remainingClear} clear fits`}</button>
          </div>

          {r.routable.length > 0 && (
            <SuggestionTable title="Clear fits" rows={r.routable} done={done} onAssign={assign} />
          )}
          {r.held.contested.length > 0 && (
            <SuggestionTable title="Close call - you decide" rows={r.held.contested} done={done} onAssign={assign} contested />
          )}
          {r.held.partialFit.length > 0 && (
            <SuggestionTable title="Partly fits - fails part of the ICP" rows={r.held.partialFit} done={done} onAssign={assign} />
          )}
          {r.routable.length === 0 && r.held.contested.length === 0 && r.held.partialFit.length === 0 && (
            <Empty title="Nothing to route right now" hint={r.poolSize === 0 ? "The pool is empty - every lead belongs to a client." : "None of the pooled leads clearly fits a client's ICP. They stay in the pool, where you can assign them by hand from the Leads page."} />
          )}
        </div>
      )}
    </Modal>
  );
}

function SuggestionTable({ title, rows, done, onAssign, contested }: { title: string; rows: Suggestion[]; done: Set<string>; onAssign: (leadId: string, clientId: string) => void; contested?: boolean }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</div>
      <div className="max-h-80 overflow-auto rounded-lg border border-black/10">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-black/[0.05]">
            {rows.map((s) => (
              <tr key={s.leadId} className={done.has(s.leadId) ? "opacity-40" : ""}>
                <td className="px-3 py-2">
                  <div className="font-medium text-ink-50">{s.fullName ?? "Unnamed"}</div>
                  <div className="text-xs text-ink-400">{[s.title, s.company].filter(Boolean).join(" · ")}</div>
                </td>
                <td className="px-3 py-2 text-xs text-ink-300">
                  {s.best && (
                    <div>
                      <b className="text-ink-50">{s.best.clientName}</b> <span className="tabular-nums">{s.best.score}</span>
                      {s.runnerUp && <span className="text-ink-400"> · {s.runnerUp.clientName} {s.runnerUp.score}</span>}
                    </div>
                  )}
                  {s.mismatches.length > 0 ? (
                    <div className="mt-0.5 text-amber-700">Fails: {s.mismatches.join(", ")}</div>
                  ) : s.best?.reasons.length ? (
                    <div className="mt-0.5 truncate text-ink-400" title={s.best.reasons.join("; ")}>{s.best.reasons.filter((x) => x.startsWith("+")).slice(0, 2).join("; ")}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {done.has(s.leadId) ? (
                    <span className="text-xs text-emerald-700">Assigned</span>
                  ) : contested && s.best && s.runnerUp ? (
                    <div className="flex justify-end gap-1">
                      <button className="btn-secondary py-1 text-xs" onClick={() => onAssign(s.leadId, s.best!.clientId)}>{s.best.clientName}</button>
                      <button className="btn-secondary py-1 text-xs" onClick={() => onAssign(s.leadId, s.runnerUp!.clientId)}>{s.runnerUp.clientName}</button>
                    </div>
                  ) : s.best ? (
                    <button className="btn-secondary py-1 text-xs" onClick={() => onAssign(s.leadId, s.best!.clientId)}>Assign</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
