import { useCallback, useEffect, useState } from "react";
import { apiFetch, fmtDate } from "../lib/api";
import { Empty, Modal, Page, Spinner, TagInput, useToast } from "../components/ui";

interface Signal { id: string; type: string; companyName: string | null; companyDomain: string | null; title: string; summary: string | null; url: string; source: string | null; amountUsd: number | null; round: string | null; confidence: number; occurredAt: string | null; createdAt: string; match: { status: string; leadsCreated: number } | null }
interface Sub { id: string; name: string; types: string[]; keywords: string[]; industries: string[]; locations: string[]; targetTitles: string[]; autoCreateLeads: boolean; active: boolean; lastRunAt: string | null; stats: Record<string, number> }
interface Monitor { id: string; type: string; name: string; target: string; active: boolean; intervalMinutes: number; lastRunAt: string | null; resultsCount: number; lastResult: Record<string, unknown> | null }
interface Result { id: string; kind: string; title: string; url: string | null; snippet: string | null; leadId: string | null; foundAt: string; data: Record<string, unknown> }

const TYPES = ["funding", "acquisition", "hiring", "leadership", "expansion", "launch", "partnership"];
const money = (n: number | null) => (n ? (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`) : "");
const TypeBadge = ({ t }: { t: string }) => <span className={`badge ${{ funding: "bg-emerald-500/10 text-emerald-300", acquisition: "bg-purple-50 text-purple-700", hiring: "bg-brand-500/10 text-brand-300", leadership: "bg-amber-500/10 text-amber-300" }[t] ?? "bg-surface/5 text-ink-300"}`}>{t}</span>;

export function SignalsPage() {
  const [tab, setTab] = useState<"feed" | "subscriptions" | "monitors">("feed");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [mons, setMons] = useState<Monitor[]>([]);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [matched, setMatched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [monOpen, setMonOpen] = useState(false);
  const [results, setResults] = useState<{ m: Monitor; rows: Result[] } | null>(null);
  const { toast, Toast } = useToast();
  const load = useCallback(() => {
    apiFetch<{ signals: Signal[] }>("GET", `/v1/signals?days=14&limit=200${type ? `&type=${type}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${matched ? "&matched=true" : ""}`).then((r) => setSignals(r.signals)).finally(() => setLoading(false));
    apiFetch<{ subscriptions: Sub[] }>("GET", "/v1/signals/subscriptions").then((r) => setSubs(r.subscriptions));
    apiFetch<{ monitors: Monitor[] }>("GET", "/v1/signals/monitors").then((r) => setMons(r.monitors));
  }, [type, q, matched]);
  useEffect(() => { load(); }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await apiFetch<{ parsed: number; stored: number }>("POST", "/v1/signals/scan", { types: ["funding", "acquisition", "leadership", "hiring"], locations: ["India"], days: 7 });
      toast(`Scanned news: ${r.parsed} signals, ${r.stored} new`);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setScanning(false); }
  };

  return (
    <Page title="Intent signals" subtitle="Companies that just raised money, got acquired, hired a new leader or are hiring fast are 3-5x more likely to buy. Subscribe and Prospex turns signals into decision-maker leads automatically." actions={<><button className="btn-secondary" onClick={scan} disabled={scanning}>{scanning ? "Scanning news…" : "Scan now"}</button><button className="btn-secondary" onClick={() => setMonOpen(true)}>New monitor</button><button className="btn-primary" onClick={() => setSubOpen(true)}>New subscription</button></>}>
      {Toast}
      <div className="mb-3 flex gap-2 border-b border-white/10">{(["feed", "subscriptions", "monitors"] as const).map((t) => <button key={t} className={`px-3 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-brand-400 font-medium text-brand-300" : "text-ink-400"}`} onClick={() => setTab(t)}>{t}{t === "subscriptions" ? ` (${subs.length})` : t === "monitors" ? ` (${mons.length})` : ""}</button>)}</div>

      {tab === "feed" && <>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input w-64" placeholder="Search company or headline" onKeyDown={(e) => e.key === "Enter" && setQ((e.target as HTMLInputElement).value)} />
          <select className="input w-40" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} /> Only matched to my subscriptions</label>
        </div>
        {loading ? <Spinner /> : signals.length === 0 ? <Empty title="No signals yet" hint='Click "Scan now" to pull the last 7 days of funding, acquisition and leadership news, or create a subscription to scan automatically every 6 hours.' /> : (
          <div className="card divide-y divide-slate-100">
            {signals.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start gap-3 p-3">
                <TypeBadge t={s.type} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.companyName ?? "Unknown company"} {s.amountUsd ? <span className="ml-1 text-emerald-300">{money(s.amountUsd)}</span> : null} {s.round && <span className="ml-1 text-xs text-ink-400">{s.round}</span>}</div>
                  <a className="text-sm text-ink-300 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                  <div className="text-xs text-ink-500">{s.source} · {fmtDate(s.occurredAt ?? s.createdAt)} {s.match && <span className="ml-2 badge bg-brand-500/10 text-brand-300">matched{s.match.leadsCreated ? ` · ${s.match.leadsCreated} leads` : ""}</span>}</div>
                </div>
                {s.companyName && <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch<{ people: unknown[] }>("POST", "/v1/tools/decision-makers", { companyName: s.companyName, companyDomain: s.companyDomain ?? undefined, limit: 4 }).then((r) => toast(`${r.people.length} decision makers saved as leads`)).catch((e) => toast(e.message, "err"))}>Find decision makers</button>}
              </div>
            ))}
          </div>
        )}
      </>}

      {tab === "subscriptions" && (subs.length === 0 ? <Empty title="No subscriptions" hint="A subscription scans news every 6 hours for your keywords/industries and can auto-create leads for the decision makers at each matching company." action={<button className="btn-primary" onClick={() => setSubOpen(true)}>Create subscription</button>} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {subs.map((s) => (
            <div key={s.id} className="card p-4">
              <div className="flex items-start justify-between"><div className="font-semibold">{s.name}</div><div className="flex gap-2"><button className="btn-secondary py-1 text-xs" onClick={() => apiFetch("POST", `/v1/signals/subscriptions/${s.id}/run`).then((r) => { toast(`Run: ${JSON.stringify(r)}`); load(); })}>Run now</button><button className="text-xs text-red-300" onClick={() => apiFetch("DELETE", `/v1/signals/subscriptions/${s.id}`).then(load)}>Delete</button></div></div>
              <div className="mt-2 flex flex-wrap gap-1">{s.types.map((t) => <TypeBadge key={t} t={t} />)}</div>
              <div className="mt-2 text-xs text-ink-400">Keywords: {[...s.keywords, ...s.industries, ...s.locations].join(", ") || "any"} · Targets: {s.targetTitles.join(", ")}</div>
              <div className="mt-1 text-xs text-ink-400">{s.autoCreateLeads ? "Auto-creates leads" : "Match only"} · matched {s.stats.matched ?? 0} · leads {s.stats.leadsCreated ?? 0} · last run {fmtDate(s.lastRunAt)}</div>
            </div>
          ))}
        </div>
      ))}

      {tab === "monitors" && (mons.length === 0 ? <Empty title="No monitors" hint="Monitor a LinkedIn post (engagers → leads), a competitor, a keyword, a company's news, or a company's job openings." action={<button className="btn-primary" onClick={() => setMonOpen(true)}>Create monitor</button>} /> : (
        <div className="card divide-y divide-slate-100">
          {mons.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="badge bg-surface/5 text-ink-200">{m.type.replace("_", " ")}</span>
              <div className="min-w-0 flex-1"><div className="font-medium">{m.name}</div><div className="truncate text-xs text-ink-400">{m.target} · every {m.intervalMinutes >= 60 ? `${Math.round(m.intervalMinutes / 60)}h` : `${m.intervalMinutes}m`} · {m.resultsCount} results · last {fmtDate(m.lastRunAt)}{m.lastResult && "openRoles" in m.lastResult ? ` · ${m.lastResult.openRoles} open roles` : ""}{m.lastResult && "publicPage" in m.lastResult && !m.lastResult.publicPage ? " · post not public" : ""}</div></div>
              <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch<{ results: Result[] }>("GET", `/v1/signals/monitors/${m.id}/results`).then((r) => setResults({ m, rows: r.results }))}>Results</button>
              <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch<{ added: number }>("POST", `/v1/signals/monitors/${m.id}/run`).then((r) => { toast(`Added ${r.added}`); load(); }).catch((e) => toast(e.message, "err"))}>Run</button>
              <button className="text-xs text-red-300" onClick={() => apiFetch("DELETE", `/v1/signals/monitors/${m.id}`).then(load)}>Delete</button>
            </div>
          ))}
        </div>
      ))}

      <SubModal open={subOpen} onClose={() => setSubOpen(false)} onDone={() => { setSubOpen(false); load(); }} toast={toast} />
      <MonitorModal open={monOpen} onClose={() => setMonOpen(false)} onDone={() => { setMonOpen(false); load(); }} toast={toast} />
      <Modal open={!!results} onClose={() => setResults(null)} title={results?.m.name ?? ""} wide>
        <div className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto text-sm">
          {results?.rows.map((r) => <div key={r.id} className="py-2"><span className="badge mr-2 bg-surface/5 text-ink-300">{r.kind}</span>{r.url && !r.url.startsWith("job:") ? <a className="hover:underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : r.title}{r.leadId && <span className="ml-2 badge bg-emerald-500/10 text-emerald-300">lead</span>}<div className="text-xs text-ink-400">{r.snippet}</div></div>)}
          {results?.rows.length === 0 && <div className="py-6 text-center text-ink-400">No results yet.</div>}
        </div>
      </Modal>
    </Page>
  );
}

function SubModal({ open, onClose, onDone, toast }: { open: boolean; onClose: () => void; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState({ name: "", types: ["funding", "leadership"] as string[], keywords: [] as string[], industries: [] as string[], locations: ["India"] as string[], targetTitles: ["CEO", "Founder", "Head of Sales", "Head of Marketing"] as string[], autoCreateLeads: true });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New signal subscription" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Freshly funded Indian SaaS" /></div>
        <div className="sm:col-span-2"><label className="label">Signal types</label><div className="flex flex-wrap gap-2">{TYPES.map((t) => <label key={t} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.types.includes(t)} onChange={(e) => setF({ ...f, types: e.target.checked ? [...f.types, t] : f.types.filter((x) => x !== t) })} />{t}</label>)}</div></div>
        <div><label className="label">Keywords</label><TagInput value={f.keywords} onChange={(v) => setF({ ...f, keywords: v })} placeholder="SaaS, D2C…" /></div>
        <div><label className="label">Industries</label><TagInput value={f.industries} onChange={(v) => setF({ ...f, industries: v })} placeholder="fintech…" /></div>
        <div><label className="label">Locations</label><TagInput value={f.locations} onChange={(v) => setF({ ...f, locations: v })} /></div>
        <div><label className="label">Decision-maker titles to find</label><TagInput value={f.targetTitles} onChange={(v) => setF({ ...f, targetTitles: v })} /></div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.autoCreateLeads} onChange={(e) => setF({ ...f, autoCreateLeads: e.target.checked })} /> Automatically find decision makers and save them as leads for every matching company</label>
      </div>
      <button className="btn-primary mt-4 w-full justify-center" disabled={busy || !f.name || !f.types.length} onClick={async () => { setBusy(true); try { await apiFetch("POST", "/v1/signals/subscriptions", f); toast("Subscription created - first scan running"); onDone(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } }}>{busy ? "…" : "Create"}</button>
    </Modal>
  );
}

function MonitorModal({ open, onClose, onDone, toast }: { open: boolean; onClose: () => void; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState({ type: "linkedin_post", name: "", target: "", intervalMinutes: 360 });
  const [busy, setBusy] = useState(false);
  const help: Record<string, string> = { linkedin_post: "Public LinkedIn post URL. People who commented/reacted are saved as leads (works when LinkedIn serves the post publicly).", keyword: "A phrase to watch in the news, e.g. 'GST automation'.", competitor: "Competitor name. Tracks their news plus 'alternatives to' discussions from buyers evaluating them.", company_news: "Company name. Funding, hiring, leadership and expansion news.", jobs: "Company domain (e.g. razorpay.com). Tracks open roles by function; alerts when hiring accelerates." };
  return (
    <Modal open={open} onClose={onClose} title="New monitor">
      <div className="space-y-3">
        <div><label className="label">Type</label><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="linkedin_post">LinkedIn post engagers</option><option value="competitor">Competitor</option><option value="keyword">Keyword in news</option><option value="company_news">Company news</option><option value="jobs">Company job openings</option></select><p className="mt-1 text-xs text-ink-400">{help[f.type]}</p></div>
        <div><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label">Target</label><input className="input" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></div>
        <div><label className="label">Check every</label><select className="input" value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })}><option value={60}>hour</option><option value={360}>6 hours</option><option value={1440}>day</option><option value={10080}>week</option></select></div>
        <button className="btn-primary w-full justify-center" disabled={busy || !f.name || !f.target} onClick={async () => { setBusy(true); try { await apiFetch("POST", "/v1/signals/monitors", f); toast("Monitor created - first run queued"); onDone(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } }}>{busy ? "…" : "Create"}</button>
      </div>
    </Modal>
  );
}
