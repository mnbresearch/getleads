import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, fmtDate } from "../lib/api";
import { DeleteButton, Empty, LoadError, Modal, Page, ScoreBar, Spinner, useToast } from "../components/ui";

interface Pixel { id: string; key: string; name: string; snippet: string; active: boolean; createdAt: string }
interface VC { id: string; domain: string; name: string | null; firstSeenAt: string; lastSeenAt: string; visits: number; sessions: number; pages: Record<string, number>; intentScore: number; status: string; leadsFound: number; company: { name: string | null; industry: string | null; description: string | null; location: string | null; techStack: string[]; openRoles: number | null } | null }

export function VisitorsPage() {
  const [pixels, setPixels] = useState<Pixel[]>([]);
  const [rows, setRows] = useState<VC[]>([]);
  const [totals, setTotals] = useState<{ visits: number; identified: number; isp: number } | null>(null);
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState(false);
  const [detail, setDetail] = useState<VC | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast, Toast } = useToast();
  const [listErr, setListErr] = useState<string | null>(null);
  // A failed pixels fetch used to show "No pixel yet" to a customer with a live pixel.
  const [pixErr, setPixErr] = useState<string | null>(null);
  const [pixLoaded, setPixLoaded] = useState(false);
  const load = useCallback(() => {
    apiFetch<{ pixels: Pixel[] }>("GET", "/v1/visitors/pixels").then((r) => { setPixels(r.pixels); setPixErr(null); setPixLoaded(true); }).catch((e) => setPixErr((e as Error).message));
    apiFetch<{ companies: VC[]; totals: typeof totals }>("GET", `/v1/visitors?days=${days}${status ? `&status=${status}` : ""}`)
      .then((r) => { setRows(r.companies); setTotals(r.totals); setListErr(null); })
      .catch((e) => setListErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [days, status]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const createPixel = async () => {
    const name = prompt("Name this website", "Main site");
    if (!name) return;
    try {
      await apiFetch("POST", "/v1/visitors/pixels", { name });
      load();
      setSetup(true);
    } catch (e) { toast((e as Error).message, "err"); }
  };
  const findPeople = async (vc: VC) => {
    setBusy(true);
    try {
      const r = await apiFetch<{ people: unknown[]; savedLeadIds: string[]; stopped?: string }>("POST", `/v1/visitors/${vc.domain}/decision-makers`, {});
      // A quota stop is said out loud: a short list must not read as "that is all there was".
      toast(`${r.people.length} decision makers found, ${r.savedLeadIds.length} saved as leads${r.stopped ? `. ${r.stopped}` : ""}`, r.stopped ? "err" : "ok");
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  /**
   * The ordered journey, not just a page-count map.
   *
   * The page subtitle promises "see what they looked at", and the detail modal delivered a
   * dictionary of page -> count, which tells you nothing about the order or the timing -
   * whether someone glanced at the blog or went pricing, pricing, contact. That sequence is
   * the whole buying signal, and the endpoint returning it was never called.
   */
  const [journey, setJourney] = useState<{ id: string; page: string | null; referrer: string | null; durationMs: number; visitedAt: string; sessionId: string; city: string | null }[] | null>(null);
  const [journeyErr, setJourneyErr] = useState<string | null>(null);
  /** Only the newest journey request is allowed to write its result. */
  const journeyToken = useRef(0);

  const openDetail = (vc: VC) => {
    setDetail(vc);
    setJourney(null);
    setJourneyErr(null);
    // The endpoint returns newest-first, and a journey read newest-first is the wrong
    // story: "New session" lands at the END of each session, and "blog, then pricing, then
    // contact" reads as "contact, then pricing, then blog". Reverse it once, here.
    //
    // A token rather than a domain comparison: comparing domains lets a slow response for
    // company A land after the user has closed and REOPENED company A, overwriting the
    // fresh journey with the stale one. Only the most recent request may write, and the
    // check happens in the callback rather than inside a state updater - React requires
    // those to be pure, and StrictMode double-invokes them.
    const token = ++journeyToken.current;
    apiFetch<{ visits: NonNullable<typeof journey> }>("GET", `/v1/visitors/${vc.domain}/visits`)
      .then((r) => { if (journeyToken.current === token) setJourney([...r.visits].reverse()); })
      .catch((e) => { if (journeyToken.current === token) setJourneyErr((e as Error).message); });
  };

  const setStat = (vc: VC, s: string) => apiFetch("PATCH", `/v1/visitors/${vc.domain}`, { status: s }).then(load).catch((e) => { toast(`Status not changed: ${(e as Error).message}`, "err"); load(); });

  return (
    <Page title="Website visitors" subtitle="Identify the companies browsing your site, see what they looked at, and pull their decision makers into your pipeline." actions={<><button className="btn-secondary" onClick={() => setSetup(true)}>Install pixel</button><button className="btn-primary" onClick={createPixel}>New website</button></>}>
      {Toast}
      {pixErr ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">Could not load your pixels: {pixErr} <button className="underline" onClick={load}>Try again</button></div>
      ) : pixLoaded && pixels.length === 0 && <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">No pixel yet. Click "New website" to get a one-line script for your site.</div>}
      {totals && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Page views ({days}d)</div><div className="text-xl font-semibold">{totals.visits}</div></div>
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Identified as business</div><div className="text-xl font-semibold">{totals.identified} <span className="text-xs font-normal text-ink-400">{totals.visits ? Math.round((totals.identified / totals.visits) * 100) : 0}%</span></div></div>
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Filtered (ISP / hosting)</div><div className="text-xl font-semibold">{totals.isp}</div></div>
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input w-36" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="new">New</option><option value="reviewed">Reviewed</option><option value="contacted">Contacted</option><option value="ignored">Ignored</option></select>
        {/* The day filter picks which companies are listed (seen in the window); the per-company
            visits, sessions and pages are running totals since first seen. Said here so a
            "last 7 days" view with 400 visits isn't read as 400 visits this week. */}
        <span className="self-center text-xs text-ink-400">Companies seen in the last {days} days. Visits, sessions and pages per company are all-time totals.</span>
      </div>
      {loading ? <Spinner /> : listErr && rows.length === 0 ? <LoadError message={listErr} onRetry={load} /> : rows.length === 0 ? <Empty title="No identified companies yet" hint="Once the pixel is installed, business visitors appear here within seconds of their visit. Consumer ISPs and cloud/hosting IPs are filtered out." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead className="border-b border-black/10 bg-cream"><tr><th className="th">Company</th><th className="th">Intent</th><th className="th">Top pages (all time)</th><th className="th">Visits (all time)</th><th className="th">Last seen</th><th className="th">Status</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((v) => (
                <tr key={v.id} className="hover:bg-black/[0.05]">
                  <td
                    className="td cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open ${v.company?.name ?? v.name ?? v.domain}`}
                    onClick={() => openDetail(v)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(v); } }}
                  ><div className="font-medium">{v.company?.name ?? v.name ?? v.domain}</div><div className="text-xs text-ink-400">{v.domain}{v.company?.industry ? ` · ${v.company.industry}` : ""}{v.company?.location ? ` · ${v.company.location}` : ""}</div></td>
                  <td className="td"><ScoreBar score={v.intentScore} /></td>
                  <td className="td text-xs text-ink-300">{Object.entries(v.pages).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => <div key={p}>{p} <span className="text-ink-500">×{n}</span></div>)}</td>
                  <td className="td tabular-nums">{v.visits} <span className="text-xs text-ink-500">/ {v.sessions} sessions</span></td>
                  <td className="td text-xs text-ink-400">{fmtDate(v.lastSeenAt)}</td>
                  <td className="td"><select className="input py-1 text-xs" value={v.status} onChange={(e) => setStat(v, e.target.value)}>{["new", "reviewed", "contacted", "ignored"].map((s) => <option key={s}>{s}</option>)}</select></td>
                  <td className="td text-right"><button className="btn-primary py-1" disabled={busy} onClick={() => findPeople(v)}>{v.leadsFound ? `+${v.leadsFound} leads · more` : "Find decision makers"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={setup} onClose={() => setSetup(false)} title="Install the visitor pixel" wide>
        <p className="mb-3 text-sm text-ink-300">Paste before <code>&lt;/head&gt;</code> on every page (or in Google Tag Manager as a Custom HTML tag). It is cookieless and under 1KB. Optionally call <code>window.prospex.identify({"{"}email, company{"}"})</code> after a login or form submit to identify visitors exactly.</p>
        {pixels.map((p) => (
          <div key={p.id} className="mb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">{p.name}</div>
              {/* Pixels were created from a bare prompt() with no confirmation and no way
                  back out, so every typo stayed in this list permanently. */}
              <DeleteButton
                what={`the pixel "${p.name}"`}
                consequence="Any site still running this snippet stops being tracked, and the individual visits it recorded (the page-by-page journeys) are deleted. The identified companies stay in your list."
                label="Remove"
                className="text-xs"
                onDelete={async () => { await apiFetch("DELETE", `/v1/visitors/pixels/${p.id}`); toast("Pixel removed"); load(); }}
                onError={(m) => toast(m, "err")}
              />
            </div>
            <pre className="max-w-full overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-800">{p.snippet}</pre>
            <button className="btn-secondary mt-1" onClick={() => navigator.clipboard.writeText(p.snippet).then(() => toast("Copied")).catch(() => toast("Could not copy - select the snippet and copy it manually", "err"))}>Copy</button>
          </div>
        ))}
        {pixels.length === 0 && <button className="btn-primary" onClick={createPixel}>Create your first pixel</button>}
      </Modal>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.company?.name ?? detail?.domain ?? ""} wide>
        {detail && <div className="space-y-2 text-sm">
          <div className="text-ink-300">{detail.company?.description}</div>
          <div className="text-xs text-ink-400">{[detail.company?.industry, detail.company?.location, detail.company?.openRoles ? `${detail.company.openRoles} open roles` : null].filter(Boolean).join(" · ")}</div>
          {detail.company?.techStack?.length ? <div className="flex flex-wrap gap-1">{detail.company.techStack.map((t) => <span key={t} className="badge bg-black/[0.05] text-ink-300">{t}</span>)}</div> : null}
          <div className="mt-2 font-medium">Pages viewed (all time)</div>
          <ul className="text-xs">{Object.entries(detail.pages).sort((a, b) => b[1] - a[1]).map(([p, n]) => <li key={p} className="flex justify-between border-b border-black/5 py-1"><span>{p}</span><span className="text-ink-500">{n}</span></li>)}</ul>

          <div className="mt-4 font-medium">Their journey</div>
          {journeyErr ? (
            <div className="text-xs text-red-600">Could not load the visit history: {journeyErr}</div>
          ) : journey === null ? (
            <Spinner label="Loading visits…" />
          ) : journey.length === 0 ? (
            <div className="text-xs text-ink-400">No individual visits recorded yet.</div>
          ) : (
            <ol className="relative space-y-2 border-l border-black/10 pl-4 text-xs">
              {journey.map((v, i) => {
                const newSession = i === 0 || journey[i - 1].sessionId !== v.sessionId;
                return (
                  <li key={v.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand-600" />
                    {newSession && <div className="mb-1 text-ink-400">New session{v.city ? ` · ${v.city}` : ""}</div>}
                    <div className="font-medium text-ink-200">{v.page ?? "/"}</div>
                    <div className="text-ink-400">
                      {new Date(v.visitedAt).toLocaleString()}
                      {v.durationMs > 0 && ` · ${Math.round(v.durationMs / 1000)}s`}
                      {v.referrer && ` · from ${(() => { try { return new URL(v.referrer).hostname; } catch { return v.referrer; } })()}`}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="text-xs text-ink-400">First seen {fmtDate(detail.firstSeenAt)} · last seen {fmtDate(detail.lastSeenAt)}</div>
        </div>}
      </Modal>
    </Page>
  );
}
