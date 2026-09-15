import { useCallback, useEffect, useState } from "react";
import { apiFetch, fmtDate } from "../lib/api";
import { Empty, Modal, Page, ScoreBar, Spinner, useToast } from "../components/ui";

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
  const load = useCallback(() => {
    apiFetch<{ pixels: Pixel[] }>("GET", "/v1/visitors/pixels").then((r) => setPixels(r.pixels));
    apiFetch<{ companies: VC[]; totals: typeof totals }>("GET", `/v1/visitors?days=${days}${status ? `&status=${status}` : ""}`).then((r) => { setRows(r.companies); setTotals(r.totals); }).finally(() => setLoading(false));
  }, [days, status]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const createPixel = async () => {
    const name = prompt("Name this website", "Main site");
    if (!name) return;
    await apiFetch("POST", "/v1/visitors/pixels", { name });
    load();
    setSetup(true);
  };
  const findPeople = async (vc: VC) => {
    setBusy(true);
    try {
      const r = await apiFetch<{ people: unknown[]; savedLeadIds: string[] }>("POST", `/v1/visitors/${vc.domain}/decision-makers`, {});
      toast(`${r.people.length} decision makers found, ${r.savedLeadIds.length} saved as leads`);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const setStat = (vc: VC, s: string) => apiFetch("PATCH", `/v1/visitors/${vc.domain}`, { status: s }).then(load);

  return (
    <Page title="Website visitors" subtitle="Identify the companies browsing your site, see what they looked at, and pull their decision makers into your pipeline." actions={<><button className="btn-secondary" onClick={() => setSetup(true)}>Install pixel</button><button className="btn-primary" onClick={createPixel}>New website</button></>}>
      {Toast}
      {pixels.length === 0 && <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">No pixel yet. Click "New website" to get a one-line script for your site.</div>}
      {totals && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Page views</div><div className="text-xl font-semibold">{totals.visits}</div></div>
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Identified as business</div><div className="text-xl font-semibold">{totals.identified} <span className="text-xs font-normal text-ink-400">{totals.visits ? Math.round((totals.identified / totals.visits) * 100) : 0}%</span></div></div>
          <div className="card p-3"><div className="text-xs uppercase text-ink-400">Filtered (ISP / hosting)</div><div className="text-xl font-semibold">{totals.isp}</div></div>
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input w-36" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="new">New</option><option value="reviewed">Reviewed</option><option value="contacted">Contacted</option><option value="ignored">Ignored</option></select>
      </div>
      {loading ? <Spinner /> : rows.length === 0 ? <Empty title="No identified companies yet" hint="Once the pixel is installed, business visitors appear here within seconds of their visit. Consumer ISPs and cloud/hosting IPs are filtered out." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead className="border-b border-white/10 bg-base"><tr><th className="th">Company</th><th className="th">Intent</th><th className="th">Top pages</th><th className="th">Visits</th><th className="th">Last seen</th><th className="th">Status</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((v) => (
                <tr key={v.id} className="hover:bg-surface/5">
                  <td className="td cursor-pointer" onClick={() => setDetail(v)}><div className="font-medium">{v.company?.name ?? v.name ?? v.domain}</div><div className="text-xs text-ink-400">{v.domain}{v.company?.industry ? ` · ${v.company.industry}` : ""}{v.company?.location ? ` · ${v.company.location}` : ""}</div></td>
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
        {pixels.map((p) => <div key={p.id} className="mb-3"><div className="text-sm font-medium">{p.name}</div><pre className="overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-200">{p.snippet}</pre><button className="btn-secondary mt-1" onClick={() => navigator.clipboard.writeText(p.snippet).then(() => toast("Copied"))}>Copy</button></div>)}
        {pixels.length === 0 && <button className="btn-primary" onClick={createPixel}>Create your first pixel</button>}
      </Modal>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.company?.name ?? detail?.domain ?? ""} wide>
        {detail && <div className="space-y-2 text-sm">
          <div className="text-ink-300">{detail.company?.description}</div>
          <div className="text-xs text-ink-400">{[detail.company?.industry, detail.company?.location, detail.company?.openRoles ? `${detail.company.openRoles} open roles` : null].filter(Boolean).join(" · ")}</div>
          {detail.company?.techStack?.length ? <div className="flex flex-wrap gap-1">{detail.company.techStack.map((t) => <span key={t} className="badge bg-surface/5 text-ink-300">{t}</span>)}</div> : null}
          <div className="mt-2 font-medium">Pages viewed</div>
          <ul className="text-xs">{Object.entries(detail.pages).sort((a, b) => b[1] - a[1]).map(([p, n]) => <li key={p} className="flex justify-between border-b border-white/5 py-1"><span>{p}</span><span className="text-ink-500">{n}</span></li>)}</ul>
          <div className="text-xs text-ink-400">First seen {fmtDate(detail.firstSeenAt)} · last seen {fmtDate(detail.lastSeenAt)}</div>
        </div>}
      </Modal>
    </Page>
  );
}
