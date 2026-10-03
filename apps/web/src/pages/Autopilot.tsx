import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, fmtDate, expectLists } from "../lib/api";
import { Empty, LoadError, Modal, Page, Spinner, useToast } from "../components/ui";
import { plural } from "../lib/plural";

interface AP { id: string; name: string; query: { query?: string }; icpId: string | null; listId: string | null; campaignId: string | null; dailyLeads: number; minScore: number; requireValidEmail: boolean; autoEnroll: boolean; active: boolean; runHourUtc: number; lastRunAt: string | null; stats: Record<string, number> }
interface SS { id: string; name: string; query: Record<string, unknown>; alert: boolean; alertEmail: string | null; lastRunAt: string | null; lastNewCount: number }

const QUERY_CHIPS: [string, string][] = [["titles", "Title"], ["industries", "Industry"], ["locations", "Location"], ["companySizes", "Company size"], ["keywords", "Keyword"], ["companyDomains", "Company"]];

/**
 * A stored search, in words.
 *
 * The row used to print the query as it is stored - {"limit":25,"query":"…","findEmails":true}
 * cut off at 100 characters. The same facts, readable: what is being looked for, the filters
 * as chips, and how many leads a run asks for. Keys this build does not know are left out
 * rather than dumped (ids of an ICP, list or client mean nothing on screen).
 */
function QuerySummary({ query }: { query: Record<string, unknown> | null | undefined }) {
  const q = query && typeof query === "object" ? query : {};
  const text = typeof q.query === "string" && q.query.trim() ? q.query.trim() : null;
  const chips = QUERY_CHIPS.flatMap(([key, label]) => (Array.isArray(q[key]) ? (q[key] as unknown[]).filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => ({ key: `${key}:${v}`, label, value: v })) : []));
  const facts = [
    typeof q.limit === "number" ? `up to ${plural(q.limit, "lead")} per run` : null,
    typeof q.country === "string" && q.country ? `country ${q.country.toUpperCase()}` : null,
    q.findEmails === false ? "without finding emails" : q.findEmails === true ? "finds emails" : null,
  ].filter(Boolean);
  if (!text && chips.length === 0 && facts.length === 0) return <span className="text-ink-400">No search criteria saved.</span>;
  return (
    <span className="[overflow-wrap:anywhere]">
      {text && <span className="text-ink-200">"{text}"</span>}
      {chips.length > 0 && (
        <span className={`${text ? "ml-2 " : ""}inline-flex flex-wrap gap-1 align-middle`}>
          {chips.map((c) => <span key={c.key} className="badge bg-black/[0.05] text-ink-300" title={c.label}>{c.value}</span>)}
        </span>
      )}
      {facts.length > 0 && <span className="text-ink-400">{text || chips.length ? " · " : ""}{facts.join(" · ")}</span>}
    </span>
  );
}

export function AutopilotPage() {
  const [aps, setAps] = useState<AP[]>([]);
  const [saved, setSaved] = useState<SS[]>([]);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [camps, setCamps] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AP | null>(null);
  const { toast, Toast } = useToast();
  const [listErr, setListErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [savedLoaded, setSavedLoaded] = useState(false);
  // The pickers in the form. A failure here used to leave them silently empty, which reads
  // as "you have no ICPs/lists/campaigns".
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const load = useCallback(() => {
    apiFetch<{ autopilots: AP[] }>("GET", "/v1/tools/autopilots")
      .then((r) => { setAps(r.autopilots); setListErr(null); setLoaded(true); })
      .catch((e) => setListErr((e as Error).message));
    apiFetch<{ savedSearches: SS[] }>("GET", "/v1/tools/saved-searches")
      .then((r) => { setSaved(r.savedSearches); setSavedErr(null); setSavedLoaded(true); })
      .catch((e) => setSavedErr((e as Error).message));
    const fails: string[] = [];
    Promise.all([
      apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(expectLists(r, "icps").icps)).catch((e) => { fails.push(`ICPs (${(e as Error).message})`); }),
      apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(expectLists(r, "lists").lists)).catch((e) => { fails.push(`lists (${(e as Error).message})`); }),
      apiFetch<{ campaigns: typeof camps }>("GET", "/v1/campaigns").then((r) => setCamps(expectLists(r, "campaigns").campaigns)).catch((e) => { fails.push(`campaigns (${(e as Error).message})`); }),
    ]).then(() => setPickErr(fails.length ? `Couldn't load ${fails.join(", ")}.` : null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const runNow = async (a: AP) => {
    try {
      await apiFetch("POST", `/v1/tools/autopilots/${a.id}/run`);
      toast("Run queued (takes 1-3 min) - stats refresh when it finishes");
      // The run is a background job with no completion signal on this page, so refresh the
      // stats on the schedule it usually takes rather than leaving the old numbers up.
      setRunning((s) => new Set(s).add(a.id));
      for (const ms of [60_000, 120_000, 180_000]) timers.current.push(window.setTimeout(load, ms));
      timers.current.push(window.setTimeout(() => setRunning((s) => { const n = new Set(s); n.delete(a.id); return n; }), 180_000));
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <Page title="Autopilot" subtitle="An autonomous prospecting agent: every day it finds fresh leads for your query, enriches and verifies them, scores against your ICP, and can enroll qualified ones into a campaign. Set it and check the pipeline." actions={<button className="btn-primary" onClick={() => setOpen(true)}>New autopilot</button>}>
      {Toast}
      {pickErr && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">{pickErr} The pickers below may be incomplete. <button className="underline" onClick={load}>Retry</button></div>}
      {listErr && aps.length === 0 ? <LoadError message={listErr} onRetry={load} /> : !loaded ? <Spinner label="Loading autopilots…" /> : aps.length === 0 ? <Empty title="No autopilots yet" hint="Example: 'Founders of D2C brands in Mumbai using Shopify', 10 leads/day, score ≥ 60, verified email only, auto-enroll in 'D2C intro sequence'." action={<button className="btn-primary" onClick={() => setOpen(true)}>Create autopilot</button>} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {aps.map((a) => (
            <div key={a.id} className="card p-4">
              <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{a.name}</div><div className="text-sm text-ink-300">{a.query?.query ? a.query.query : <QuerySummary query={a.query as Record<string, unknown>} />}</div></div><span className={`badge ${a.active ? "bg-emerald-50 text-emerald-700" : "bg-black/[0.05] text-ink-300"}`}>{a.active ? "active" : "paused"}</span></div>
              <div className="mt-2 text-xs text-ink-400">{a.dailyLeads}/day · score ≥ {a.minScore} · {a.requireValidEmail ? "verified email only" : "any email"} · {a.autoEnroll ? "auto-enrolls" : "saves only"} · runs {String(a.runHourUtc).padStart(2, "0")}:00 UTC</div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">{[["runs", a.stats.runs], ["found", a.stats.found], ["saved", a.stats.saved], ["enrolled", a.stats.enrolled]].map(([l, v]) => <div key={String(l)} className="rounded-lg bg-cream p-2"><div className="text-ink-400">{l}</div><div className="text-base font-semibold">{v ?? 0}</div></div>)}</div>
              <div className="mt-2 flex items-center gap-2 text-xs"><span className="text-ink-500">last run {fmtDate(a.lastRunAt)}</span><button className="btn-secondary ml-auto py-1" disabled={running.has(a.id)} onClick={() => runNow(a)}>{running.has(a.id) ? "Running…" : "Run now"}</button><button className="btn-secondary py-1" onClick={() => setEditing(a)}>Edit</button><button className="btn-secondary py-1" onClick={() => apiFetch("PATCH", `/v1/tools/autopilots/${a.id}`, { active: !a.active }).then(load).catch((e) => toast((e as Error).message, "err"))}>{a.active ? "Pause" : "Resume"}</button><button className="text-red-600" onClick={() => { if (!confirm(`Delete the autopilot "${a.name}"? This cannot be undone.`)) return; apiFetch("DELETE", `/v1/tools/autopilots/${a.id}`).then(load).catch((e) => toast((e as Error).message, "err")); }}>Delete</button></div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-8">
        <div className="mb-2 font-medium">Saved searches & alerts</div>
        {savedErr && !savedLoaded ? <LoadError message={savedErr} onRetry={load} /> : !savedLoaded ? <Spinner /> : saved.length === 0 ? <div className="text-sm text-ink-400">Save a search from the Find leads page to re-run it daily and get an email when new matches appear.</div> : (
          <div className="card divide-y divide-slate-100">{saved.map((s) => <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 text-sm"><div className="min-w-0 flex-1"><div className="font-medium [overflow-wrap:anywhere]">{s.name}</div><div className="text-xs text-ink-300"><QuerySummary query={s.query} /></div><div className="mt-0.5 text-xs text-ink-400">{s.alert ? `alerts → ${s.alertEmail ?? "your email"}` : "no alerts"} · last run {s.lastRunAt ? fmtDate(s.lastRunAt) : "never"} · {s.lastNewCount ?? 0} new</div></div><button className="btn-secondary py-1 text-xs" onClick={() => apiFetch("POST", `/v1/tools/saved-searches/${s.id}/run`).then(() => toast("Queued")).catch((e) => toast((e as Error).message, "err"))}>Run</button><button className="text-xs text-red-600" onClick={() => { if (!confirm(`Delete the saved search "${s.name}"?`)) return; apiFetch("DELETE", `/v1/tools/saved-searches/${s.id}`).then(load).catch((e) => toast((e as Error).message, "err")); }}>Delete</button></div>)}</div>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New autopilot" wide>
        <ApForm icps={icps} lists={lists} camps={camps} onDone={() => { setOpen(false); load(); }} toast={toast} />
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit autopilot" wide>
        {editing && <ApForm key={editing.id} initial={editing} icps={icps} lists={lists} camps={camps} onDone={() => { setEditing(null); load(); }} toast={toast} />}
      </Modal>
    </Page>
  );
}

/** Create, or (with `initial`) edit through the existing PATCH. */
function ApForm({ initial, icps, lists, camps, onDone, toast }: { initial?: AP; icps: { id: string; name: string }[]; lists: { id: string; name: string }[]; camps: { id: string; name: string }[]; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState(() =>
    initial
      ? { name: initial.name, query: initial.query.query ?? "", icpId: initial.icpId ?? "", listId: initial.listId ?? "", campaignId: initial.autoEnroll ? initial.campaignId ?? "" : "", dailyLeads: initial.dailyLeads, minScore: initial.minScore, requireValidEmail: initial.requireValidEmail, autoEnroll: initial.autoEnroll, runHourUtc: initial.runHourUtc }
      : { name: "", query: "", icpId: "", listId: "", campaignId: "", dailyLeads: 10, minScore: 60, requireValidEmail: true, autoEnroll: false, runHourUtc: 3 },
  );
  const [busy, setBusy] = useState(false);
  const rangeErr =
    !Number.isInteger(f.dailyLeads) || f.dailyLeads < 1 || f.dailyLeads > 200 ? "Leads per day must be a whole number from 1 to 200."
    : !Number.isInteger(f.minScore) || f.minScore < 0 || f.minScore > 100 ? "Minimum score must be from 0 to 100."
    : !Number.isInteger(f.runHourUtc) || f.runHourUtc < 0 || f.runHourUtc > 23 ? "Run hour must be from 0 to 23 (UTC)."
    : null;
  const save = async () => {
    setBusy(true);
    try {
      if (initial) {
        // The API cannot clear an ICP/list/campaign once set (they are optional, not
        // nullable), so only send ones that are chosen; turning enrollment off is autoEnroll.
        // An object query (made elsewhere) is kept as-is unless the text was changed.
        const queryChanged = f.query !== (initial.query.query ?? "");
        await apiFetch("PATCH", `/v1/tools/autopilots/${initial.id}`, {
          name: f.name,
          ...(queryChanged ? { query: { ...initial.query, query: f.query } } : {}),
          // null clears a reference the API already holds; "" in the select means "none".
          icpId: f.icpId || null,
          listId: f.listId || null,
          campaignId: f.campaignId || null,
          autoEnroll: f.autoEnroll,
          dailyLeads: f.dailyLeads,
          minScore: f.minScore,
          requireValidEmail: f.requireValidEmail,
          runHourUtc: f.runHourUtc,
        });
        toast("Autopilot updated");
      } else {
        await apiFetch("POST", "/v1/tools/autopilots", { name: f.name, query: { query: f.query }, icpId: f.icpId || undefined, listId: f.listId || undefined, campaignId: f.campaignId || undefined, dailyLeads: f.dailyLeads, minScore: f.minScore, requireValidEmail: f.requireValidEmail, autoEnroll: f.autoEnroll, runHourUtc: f.runHourUtc });
        toast("Autopilot created");
      }
      onDone();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
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
      {rangeErr && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2" role="alert">{rangeErr}</div>}
      <button className="btn-primary w-full justify-center sm:col-span-2" disabled={busy || !f.name || (!initial && !f.query) || !!rangeErr} onClick={save}>{busy ? "…" : initial ? "Save changes" : "Create autopilot"}</button>
    </div>
  );
}
