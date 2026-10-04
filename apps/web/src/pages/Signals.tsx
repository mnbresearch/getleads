import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, fmtDate, expectLists } from "../lib/api";
import { DeleteButton, Empty, LoadError, Modal, Page, Spinner, TagInput, useToast } from "../components/ui";
import { ExtLink } from "../components/ExtLink";
import { plural } from "../lib/plural";
import { LIST_SEARCH_MAX, listErrorText, searchText } from "../lib/listSearch";

interface Signal { id: string; type: string; companyName: string | null; companyDomain: string | null; title: string; summary: string | null; url: string; source: string | null; amountUsd: number | null; round: string | null; confidence: number; occurredAt: string | null; createdAt: string; match: { status: string; leadsCreated: number } | null }
interface Sub { id: string; name: string; types: string[]; keywords: string[]; industries: string[]; locations: string[]; targetTitles: string[]; autoCreateLeads: boolean; active: boolean; lastRunAt: string | null; stats: Record<string, number> }
interface Monitor { id: string; type: string; name: string; target: string; active: boolean; intervalMinutes: number; lastRunAt: string | null; resultsCount: number; lastResult: Record<string, unknown> | null }
interface Result { id: string; kind: string; title: string; url: string | null; snippet: string | null; leadId: string | null; foundAt: string; data: Record<string, unknown> }

/**
 * Fallback only. The authoritative list is GET /v1/signals/types.
 *
 * This array used to BE the list, and the server validates a subscription's types against
 * its own enum - so a type added on the server never appeared here, and one removed there
 * surfaced as a validation error on save rather than as a missing option. Fetched once on
 * mount; this stands in until it arrives, and if the request fails.
 */
const FALLBACK_TYPES = ["funding", "acquisition", "hiring", "leadership", "expansion", "launch", "partnership"];

let cachedTypes: string[] | null = null;

function useSignalTypes() {
  const [types, setTypes] = useState<string[]>(cachedTypes ?? FALLBACK_TYPES);
  useEffect(() => {
    if (cachedTypes) return;
    apiFetch<{ types: string[] }>("GET", "/v1/signals/types")
      .then((r) => { if (r.types?.length) { cachedTypes = r.types; setTypes(r.types); } })
      .catch(() => {});
  }, []);
  return types;
}
/**
 * Types a subscription can actually be fed. "news" has no news-search queries behind it, so
 * a subscription to it alone scans nothing and matches nothing - offering it set the user
 * up for a subscription that silently never fires.
 */
const UNSUBSCRIBABLE = new Set(["news"]);

/** Plain-English result of a subscription run, instead of the raw JSON it used to print. */
function describeSubRun(r: { parsed?: number; stored?: number; matched?: number; leadsCreated?: number; skipped?: string; stopped?: string; note?: string }): string {
  const parts = [`Scanned ${plural(r.parsed ?? 0, "headline")} (${r.stored ?? 0} new)`, `${r.matched ?? 0} matched this subscription`];
  if (r.leadsCreated !== undefined) parts.push(`${plural(r.leadsCreated, "lead")} created`);
  const tail = [r.stopped, r.skipped, r.note].filter(Boolean).join(" ");
  return `${parts.join(", ")}.${tail ? ` ${tail}` : ""}`;
}

/** Saved count from leadIds actually returned, plus whatever stopped the rest. */
function dmSummary(r: { people: { leadId?: string }[]; skipped?: string; saveStopped?: string }): string {
  const saved = r.people.filter((p) => p.leadId).length;
  const head = saved === r.people.length ? `${saved} decision makers saved as leads` : `${r.people.length} decision makers found, ${saved} saved as leads`;
  const tail = [r.saveStopped, r.skipped].filter(Boolean).join(" ");
  return tail ? `${head}. ${tail}` : head;
}

const money = (n: number | null) => (n ? (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`) : "");
const TypeBadge = ({ t }: { t: string }) => <span className={`badge ${{ funding: "bg-emerald-50 text-emerald-700", acquisition: "bg-purple-50 text-purple-700", hiring: "bg-brand-50 text-brand-700", leadership: "bg-amber-50 text-amber-700" }[t] ?? "bg-black/[0.05] text-ink-300"}`}>{t}</span>;

export function SignalsPage() {
  const TYPES = useSignalTypes();
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
  const [listErr, setListErr] = useState<string | null>(null);
  // Both used to be uncaught, so a failed fetch rendered "No subscriptions" / "No monitors".
  const [subsErr, setSubsErr] = useState<string | null>(null);
  const [monsErr, setMonsErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const shownFor = useRef<string | null>(null);
  const feedSeq = useRef(0);
  const load = useCallback(() => {
    const key = `${type}|${q}|${matched}`;
    const mine = ++feedSeq.current;
    // Rows belong to the filter they were loaded for. When a load for a DIFFERENT filter
    // fails, the rows on screen are not its answer and must not stay as if they were; when
    // a refresh of the SAME filter fails (a blip between polls), they are still right.
    apiFetch<{ signals: Signal[] }>("GET", `/v1/signals?days=14&limit=200${type ? `&type=${type}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${matched ? "&matched=true" : ""}`)
      .then((r) => { if (mine !== feedSeq.current) return; setSignals(expectLists(r, "signals").signals); shownFor.current = key; setListErr(null); })
      .catch((e) => {
        if (mine !== feedSeq.current) return;
        if (shownFor.current !== key) { setSignals([]); shownFor.current = null; }
        setListErr(listErrorText((e as Error).message));
      })
      .finally(() => { if (mine === feedSeq.current) setLoading(false); });
    apiFetch<{ subscriptions: Sub[] }>("GET", "/v1/signals/subscriptions").then((r) => { setSubs(expectLists(r, "subscriptions").subscriptions); setSubsErr(null); }).catch((e) => setSubsErr((e as Error).message));
    apiFetch<{ monitors: Monitor[] }>("GET", "/v1/signals/monitors").then((r) => { setMons(expectLists(r, "monitors").monitors); setMonsErr(null); }).catch((e) => setMonsErr((e as Error).message));
  }, [type, q, matched]);
  useEffect(() => { load(); }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      // Locations come from the org's own ICPs, not a hardcoded "India" that narrowed every
      // customer's scan to one country. No ICP locations means no location filter.
      const icps = await apiFetch<{ icps: { criteria?: { locations?: string[]; countries?: string[] } }[] }>("GET", "/v1/icps").then((r) => r.icps).catch(() => []);
      const locations = [...new Set(icps.flatMap((i) => [...(i.criteria?.locations ?? []), ...(i.criteria?.countries ?? [])]).map((x) => x.trim()).filter(Boolean))].slice(0, 4);
      const r = await apiFetch<{ parsed: number; stored: number; skipped?: string; stopped?: string; note?: string }>("POST", "/v1/signals/scan", { types: ["funding", "acquisition", "leadership", "hiring"], locations, days: 7 });
      const extra = [r.stopped, r.skipped, r.note].filter(Boolean).join(" ");
      toast(`Scanned news${locations.length ? ` (${locations.join(", ")})` : ""}: ${plural(r.parsed, "signal")}, ${r.stored} new.${extra ? ` ${extra}` : ""}`);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setScanning(false); }
  };

  return (
    <Page title="Intent signals" subtitle="Companies that just raised money, got acquired, hired a new leader or are hiring fast are 3-5x more likely to buy. Subscribe and Scout turns signals into decision-maker leads automatically." actions={<><button className="btn-secondary" onClick={scan} disabled={scanning}>{scanning ? "Scanning news…" : "Scan now"}</button><button className="btn-secondary" onClick={() => setMonOpen(true)}>New monitor</button><button className="btn-primary" onClick={() => setSubOpen(true)}>New subscription</button></>}>
      {Toast}
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto whitespace-nowrap border-b border-black/10 px-4 sm:mx-0 sm:px-0">{(["feed", "subscriptions", "monitors"] as const).map((t) => <button key={t} className={`shrink-0 px-3 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400"}`} onClick={() => setTab(t)}>{t}{t === "subscriptions" ? ` (${subs.length})` : t === "monitors" ? ` (${mons.length})` : ""}</button>)}</div>

      {tab === "feed" && <>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input w-64" placeholder="Search company or headline" aria-label="Search signals" maxLength={LIST_SEARCH_MAX} onKeyDown={(e) => e.key === "Enter" && setQ(searchText((e.target as HTMLInputElement).value))} />
          <select className="input w-40" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} /> Only matched to my subscriptions</label>
        </div>
        {loading ? <Spinner /> : listErr && signals.length === 0 ? <LoadError message={listErr} onRetry={load} /> : signals.length === 0 ? <Empty title="No signals yet" hint='Click "Scan now" to pull the last 7 days of funding, acquisition and leadership news, or create a subscription to scan automatically every 6 hours.' /> : (
          <div className="card divide-y divide-slate-100">
            {signals.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start gap-3 p-3">
                <TypeBadge t={s.type} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.companyName ?? "Unknown company"} {s.amountUsd ? <span className="ml-1 text-emerald-600">{money(s.amountUsd)}</span> : null} {s.round && <span className="ml-1 text-xs text-ink-400">{s.round}</span>}</div>
                  {/* Linkified only when there is somewhere to go. A job change has no
                      source article - its `url` is an internal identity string - and an
                      anchor with a non-http href renders as a link that goes nowhere. */}
                  <ExtLink className="text-sm text-ink-300 hover:underline" href={s.url} fallback={<div className="text-sm text-ink-300">{s.title}</div>}>{s.title}</ExtLink>
                  <div className="text-xs text-ink-500">{s.source} · {fmtDate(s.occurredAt ?? s.createdAt)} {s.match && <span className="ml-2 badge bg-brand-50 text-brand-700">matched{s.match.leadsCreated ? ` · ${plural(s.match.leadsCreated, "lead")}` : ""}</span>}</div>
                </div>
                {s.companyName && <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch<{ people: { leadId?: string }[]; skipped?: string; saveStopped?: string }>("POST", "/v1/tools/decision-makers", { companyName: s.companyName, companyDomain: s.companyDomain ?? undefined, limit: 4 }).then((r) => toast(dmSummary(r))).catch((e) => toast((e as Error).message, "err"))}>Find decision makers</button>}
              </div>
            ))}
          </div>
        )}
      </>}

      {tab === "subscriptions" && (subsErr && subs.length === 0 ? <LoadError message={subsErr} onRetry={load} /> : subs.length === 0 ? <Empty title="No subscriptions" hint="A subscription scans news every 6 hours for your keywords/industries and can auto-create leads for the decision makers at each matching company." action={<button className="btn-primary" onClick={() => setSubOpen(true)}>Create subscription</button>} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {subs.map((s) => (
            <div key={s.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold">{s.name}{s.active === false && <span className="badge ml-2 bg-black/[0.05] text-ink-300">paused</span>}</div>
                <div className="flex gap-2">
                  <button className="btn-secondary py-1 text-xs" disabled={busyId === s.id} onClick={() => { setBusyId(s.id); apiFetch<Parameters<typeof describeSubRun>[0]>("POST", `/v1/signals/subscriptions/${s.id}/run`).then((r) => { toast(describeSubRun(r)); load(); }).catch((e) => toast((e as Error).message, "err")).finally(() => setBusyId(null)); }}>{busyId === s.id ? "Running…" : "Run now"}</button>
                  {/* A subscription that scans every six hours and auto-creates leads could
                      only be stopped by deleting it, which threw away its match history and
                      stats too. Pausing keeps both. */}
                  <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch("PATCH", `/v1/signals/subscriptions/${s.id}`, { active: s.active === false }).then(load).catch((e) => toast((e as Error).message, "err"))}>{s.active === false ? "Resume" : "Pause"}</button>
                  <DeleteButton
                    what={`the subscription "${s.name}"`}
                    consequence="Its match history and stats go with it. Pause it instead if you only want it to stop scanning."
                    className="text-xs"
                    onDelete={async () => { await apiFetch("DELETE", `/v1/signals/subscriptions/${s.id}`); load(); }}
                    onError={(m2) => toast(m2, "err")}
                  />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">{s.types.map((t) => <TypeBadge key={t} t={t} />)}</div>
              <div className="mt-2 text-xs text-ink-400">Keywords: {[...s.keywords, ...s.industries, ...s.locations].join(", ") || "any"} · Targets: {s.targetTitles.join(", ")}</div>
              <div className="mt-1 text-xs text-ink-400">{s.autoCreateLeads ? "Auto-creates leads" : "Match only"} · matched {s.stats.matched ?? 0} · leads {s.stats.leadsCreated ?? 0} · last run {fmtDate(s.lastRunAt)}</div>
            </div>
          ))}
        </div>
      ))}

      {tab === "monitors" && (monsErr && mons.length === 0 ? <LoadError message={monsErr} onRetry={load} /> : mons.length === 0 ? <Empty title="No monitors" hint="Monitor a LinkedIn post (engagers → leads), a competitor, a keyword, a company's news, or a company's job openings." action={<button className="btn-primary" onClick={() => setMonOpen(true)}>Create monitor</button>} /> : (
        <div className="card divide-y divide-slate-100">
          {mons.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="badge bg-black/[0.05] text-ink-200">{m.type.replace("_", " ")}</span>
              <div className="min-w-0 flex-1"><div className="font-medium">{m.name}{m.active === false && <span className="badge ml-2 bg-black/[0.05] text-ink-300">paused</span>}</div><div className="truncate text-xs text-ink-400">{m.target} · every {m.intervalMinutes >= 60 ? `${Math.round(m.intervalMinutes / 60)}h` : `${m.intervalMinutes}m`} · {plural(m.resultsCount, "result")} · last {fmtDate(m.lastRunAt)}{m.lastResult && "openRoles" in m.lastResult ? ` · ${m.lastResult.openRoles} open roles` : ""}{m.lastResult && typeof m.lastResult.error === "string" ? "" : m.lastResult && "publicPage" in m.lastResult && !m.lastResult.publicPage ? " · post not public" : ""}</div>{m.lastResult && typeof m.lastResult.error === "string" && <div className="mt-0.5 text-xs text-red-700 [overflow-wrap:anywhere]">{m.lastResult.error}</div>}</div>
              <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch<{ results: Result[] }>("GET", `/v1/signals/monitors/${m.id}/results`).then((r) => setResults({ m, rows: r.results })).catch((e) => toast(`Could not load results: ${(e as Error).message}`, "err"))}>Results</button>
              <button className="btn-secondary py-1 text-xs" disabled={busyId === m.id} onClick={() => { setBusyId(m.id); apiFetch<{ added: number; skipped?: string; stopped?: string; note?: string }>("POST", `/v1/signals/monitors/${m.id}/run`).then((r) => { const extra = [r.stopped, r.skipped, r.note].filter(Boolean).join(" "); toast(`Added ${r.added} new result${r.added === 1 ? "" : "s"}.${extra ? ` ${extra}` : ""}`); load(); }).catch((e) => toast((e as Error).message, "err")).finally(() => setBusyId(null)); }}>{busyId === m.id ? "Running…" : "Run"}</button>
              <button className="btn-secondary py-1 text-xs" onClick={() => apiFetch("PATCH", `/v1/signals/monitors/${m.id}`, { active: m.active === false }).then(load).catch((e) => toast((e as Error).message, "err"))}>{m.active === false ? "Resume" : "Pause"}</button>
              <DeleteButton
                what={`the monitor "${m.name}"`}
                consequence={`${plural(m.resultsCount, "recorded result")} ${m.resultsCount === 1 ? "goes" : "go"} with it. Pause it instead if you only want it to stop checking.`}
                className="text-xs"
                onDelete={async () => { await apiFetch("DELETE", `/v1/signals/monitors/${m.id}`); load(); }}
                onError={(msg) => toast(msg, "err")}
              />
            </div>
          ))}
        </div>
      ))}

      <SubModal open={subOpen} onClose={() => setSubOpen(false)} onDone={() => { setSubOpen(false); load(); }} toast={toast} />
      <MonitorModal open={monOpen} onClose={() => setMonOpen(false)} onDone={() => { setMonOpen(false); load(); }} toast={toast} />
      <Modal open={!!results} onClose={() => setResults(null)} title={results?.m.name ?? ""} wide>
        <div className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto text-sm">
          {results?.rows.map((r) => <div key={r.id} className="py-2"><span className="badge mr-2 bg-black/[0.05] text-ink-300">{r.kind}</span><ExtLink className="hover:underline" href={r.url} fallback={r.title}>{r.title}</ExtLink>{r.leadId && <span className="ml-2 badge bg-emerald-50 text-emerald-700">lead</span>}<div className="text-xs text-ink-400">{r.snippet}</div></div>)}
          {results?.rows.length === 0 && <div className="py-6 text-center text-ink-400">No results yet.</div>}
        </div>
      </Modal>
    </Page>
  );
}

function SubModal({ open, onClose, onDone, toast }: { open: boolean; onClose: () => void; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const TYPES = useSignalTypes().filter((t) => !UNSUBSCRIBABLE.has(t));
  const [f, setF] = useState({ name: "", types: ["funding", "leadership"] as string[], keywords: [] as string[], industries: [] as string[], locations: ["India"] as string[], targetTitles: ["CEO", "Founder", "Head of Sales", "Head of Marketing"] as string[], autoCreateLeads: true });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New signal subscription" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Freshly funded Indian SaaS" /></div>
        <div className="sm:col-span-2"><label className="label">Signal types</label><div className="flex flex-wrap gap-2">{TYPES.map((t) => <label key={t} className="flex items-center gap-1 text-sm" title={t === "job_change" ? "Comes from re-checking leads you already track, not from news" : undefined}><input type="checkbox" checked={f.types.includes(t)} onChange={(e) => setF({ ...f, types: e.target.checked ? [...f.types, t] : f.types.filter((x) => x !== t) })} />{t.replace("_", " ")}</label>)}</div></div>
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
