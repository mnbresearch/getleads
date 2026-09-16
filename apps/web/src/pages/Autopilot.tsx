import { useCallback, useEffect, useState } from "react";
import { apiFetch, fmtDate } from "../lib/api";
import { Empty, Modal, Page, useToast } from "../components/ui";

interface AP { id: string; name: string; query: { query?: string }; icpId: string | null; listId: string | null; campaignId: string | null; dailyLeads: number; minScore: number; requireValidEmail: boolean; autoEnroll: boolean; active: boolean; runHourUtc: number; lastRunAt: string | null; stats: Record<string, number> }
interface SS { id: string; name: string; query: Record<string, unknown>; alert: boolean; alertEmail: string | null; lastRunAt: string | null; lastNewCount: number }

export function AutopilotPage() {
  const [aps, setAps] = useState<AP[]>([]);
  const [saved, setSaved] = useState<SS[]>([]);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [camps, setCamps] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const { toast, Toast } = useToast();
  const load = useCallback(() => {
    apiFetch<{ autopilots: AP[] }>("GET", "/v1/tools/autopilots").then((r) => setAps(r.autopilots));
    apiFetch<{ savedSearches: SS[] }>("GET", "/v1/tools/saved-searches").then((r) => setSaved(r.savedSearches));
    apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(r.icps));
    apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(r.lists));
    apiFetch<{ campaigns: typeof camps }>("GET", "/v1/campaigns").then((r) => setCamps(r.campaigns));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Page title="Autopilot" subtitle="An autonomous prospecting agent: every day it finds fresh leads for your query, enriches and verifies them, scores against your ICP, and can enroll qualified ones into a campaign. Set it and check the pipeline." actions={<button className="btn-primary" onClick={() => setOpen(true)}>New autopilot</button>}>
      {Toast}
      {aps.length === 0 ? <Empty title="No autopilots yet" hint="Example: 'Founders of D2C brands in Mumbai using Shopify', 10 leads/day, score ≥ 60, verified email only, auto-enroll in 'D2C intro sequence'." action={<button className="btn-primary" onClick={() => setOpen(true)}>Create autopilot</button>} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {aps.map((a) => (
            <div key={a.id} className="card p-4">
              <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{a.name}</div><div className="text-sm text-ink-300">{a.query.query ?? JSON.stringify(a.query)}</div></div><span className={`badge ${a.active ? "bg-emerald-50 text-emerald-700" : "bg-black/[0.05] text-ink-300"}`}>{a.active ? "active" : "paused"}</span></div>
              <div className="mt-2 text-xs text-ink-400">{a.dailyLeads}/day · score ≥ {a.minScore} · {a.requireValidEmail ? "verified email only" : "any email"} · {a.autoEnroll ? "auto-enrolls" : "saves only"} · runs {String(a.runHourUtc).padStart(2, "0")}:00 UTC</div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">{[["runs", a.stats.runs], ["found", a.stats.found], ["saved", a.stats.saved], ["enrolled", a.stats.enrolled]].map(([l, v]) => <div key={String(l)} className="rounded-lg bg-cream p-2"><div className="text-ink-400">{l}</div><div className="text-base font-semibold">{v ?? 0}</div></div>)}</div>
              <div className="mt-2 flex items-center gap-2 text-xs"><span className="text-ink-500">last run {fmtDate(a.lastRunAt)}</span><button className="btn-secondary ml-auto py-1" onClick={() => apiFetch("POST", `/v1/tools/autopilots/${a.id}/run`).then(() => toast("Run queued (takes 1-3 min)"))}>Run now</button><button className="btn-secondary py-1" onClick={() => apiFetch("PATCH", `/v1/tools/autopilots/${a.id}`, { active: !a.active }).then(load)}>{a.active ? "Pause" : "Resume"}</button><button className="text-red-600" onClick={() => apiFetch("DELETE", `/v1/tools/autopilots/${a.id}`).then(load)}>Delete</button></div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-8">
        <div className="mb-2 font-medium">Saved searches & alerts</div>
        {saved.length === 0 ? <div className="text-sm text-ink-400">Save a search from the Find leads page to re-run it daily and get an email when new matches appear.</div> : (
          <div className="card divide-y divide-slate-100">{saved.map((s) => <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 text-sm"><div className="flex-1"><div className="font-medium">{s.name}</div><div className="text-xs text-ink-400">{JSON.stringify(s.query).slice(0, 100)} · {s.alert ? `alerts → ${s.alertEmail}` : "no alerts"} · last run {fmtDate(s.lastRunAt)} · {s.lastNewCount} new</div></div><button className="btn-secondary py-1 text-xs" onClick={() => apiFetch("POST", `/v1/tools/saved-searches/${s.id}/run`).then(() => toast("Queued"))}>Run</button><button className="text-xs text-red-600" onClick={() => apiFetch("DELETE", `/v1/tools/saved-searches/${s.id}`).then(load)}>Delete</button></div>)}</div>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New autopilot" wide>
        <ApForm icps={icps} lists={lists} camps={camps} onDone={() => { setOpen(false); load(); }} toast={toast} />
      </Modal>
    </Page>
  );
}

function ApForm({ icps, lists, camps, onDone, toast }: { icps: { id: string; name: string }[]; lists: { id: string; name: string }[]; camps: { id: string; name: string }[]; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState({ name: "", query: "", icpId: "", listId: "", campaignId: "", dailyLeads: 10, minScore: 60, requireValidEmail: true, autoEnroll: false, runHourUtc: 3 });
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="sm:col-span-2"><label className="label">Who to find (natural language)</label><input className="input" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} placeholder="Heads of Operations at logistics companies in NCR with 50-500 employees" /></div>
      <div><label className="label">Score against ICP</label><select className="input" value={f.icpId} onChange={(e) => setF({ ...f, icpId: e.target.value })}><option value="">(query filters)</option>{icps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
      <div><label className="label">Save to list</label><select className="input" value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}><option value="">None</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div><label className="label">Leads per day</label><input type="number" className="input" value={f.dailyLeads} onChange={(e) => setF({ ...f, dailyLeads: Number(e.target.value) })} /></div>
      <div><label className="label">Minimum score</label><input type="number" className="input" value={f.minScore} onChange={(e) => setF({ ...f, minScore: Number(e.target.value) })} /></div>
      <div><label className="label">Run at (UTC hour)</label><input type="number" min={0} max={23} className="input" value={f.runHourUtc} onChange={(e) => setF({ ...f, runHourUtc: Number(e.target.value) })} /></div>
      <div><label className="label">Auto-enroll in campaign</label><select className="input" value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value, autoEnroll: !!e.target.value })}><option value="">Don't enroll</option>{camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.requireValidEmail} onChange={(e) => setF({ ...f, requireValidEmail: e.target.checked })} /> Only keep leads with a verified or catch-all email</label>
      <button className="btn-primary w-full justify-center sm:col-span-2" disabled={busy || !f.name || !f.query} onClick={async () => { setBusy(true); try { await apiFetch("POST", "/v1/tools/autopilots", { name: f.name, query: { query: f.query }, icpId: f.icpId || undefined, listId: f.listId || undefined, campaignId: f.campaignId || undefined, dailyLeads: f.dailyLeads, minScore: f.minScore, requireValidEmail: f.requireValidEmail, autoEnroll: f.autoEnroll, runHourUtc: f.runHourUtc }); toast("Autopilot created"); onDone(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } }}>{busy ? "…" : "Create autopilot"}</button>
    </div>
  );
}
