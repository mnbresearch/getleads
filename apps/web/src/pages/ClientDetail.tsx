import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiFetch, fmtDate } from "../lib/api";
import { BUCKET_COPY, type ClientAttention, type ClientRow, type ClientStats, type TargetProgress } from "../lib/clients";
import { ClientDot, ClientFormModal, StatusPill, TargetBar, type ClientFormValue, toClientPayload } from "../components/ClientBits";
import { EmailStatusBadge, LoadError, Page, ScoreBar, Spinner, Stat, useToast } from "../components/ui";

interface Detail {
  client: Omit<ClientRow, "stats" | "attention" | "target"> & { shareToken: string | null };
  icp: { id: string; name: string } | null;
  stats: ClientStats;
  attention: ClientAttention;
  target: TargetProgress | null;
  funnel: Record<string, number>;
  campaigns: { id: string; name: string; status: string; contacts: number; stats: Record<string, number> }[];
  recentLeads: { id: string; fullName: string | null; title: string | null; company: string | null; email: string | null; emailStatus: string; status: string; score: number; assignedAt: string | null }[];
}

const STAGES = ["new", "contacted", "engaged", "replied", "qualified", "customer", "lost"];

export function ClientDetailPage() {
  const { id = "" } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(() => {
    setErr(null);
    apiFetch<Detail>("GET", `/v1/clients/${id}`).then(setD).catch((e) => setErr((e as Error).message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (err) return <Page title="Client"><LoadError message={err} onRetry={load} /></Page>;
  if (!d) return <Page title="Client"><Spinner label="Loading…" /></Page>;

  const c = d.client;
  const shareUrl = c.shareToken ? `${window.location.origin}/r/${c.shareToken}` : null;
  const verifiedPct = d.stats.withEmail ? Math.round((d.stats.verified / d.stats.withEmail) * 100) : null;

  const act = async (bucket: keyof ClientAttention) => {
    const copy = BUCKET_COPY[bucket];
    setActing(bucket);
    try {
      const r = await apiFetch<{ queued?: number; added?: number; alreadyOnList?: number; listName?: string; note?: string }>("POST", `/v1/clients/${id}/act`, { bucket, action: copy.action });
      if (r.note) toast(r.note);
      else if (copy.action === "list") toast(`${r.added} added to "${r.listName}"${r.alreadyOnList ? `, ${r.alreadyOnList} were already on it` : ""}. Point a campaign at that list.`);
      else toast(`${r.queued} queued - results land over the next few minutes`);
      setTimeout(load, 1500);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setActing(null);
    }
  };

  const setStatus = async (status: string) => {
    try {
      await apiFetch("PATCH", `/v1/clients/${id}`, { status });
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const share = async (on: boolean) => {
    try {
      if (on) await apiFetch("POST", `/v1/clients/${id}/share`);
      else await apiFetch("DELETE", `/v1/clients/${id}/share`);
      load();
      toast(on ? "Report link created" : "Report link turned off - old links no longer work");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${c.name}? Its ${d.stats.leads} leads go back to the pool - nothing about them is lost.`)) return;
    try {
      const r = await apiFetch<{ leadsReturnedToPool: number }>("DELETE", `/v1/clients/${id}`);
      toast(`Deleted. ${r.leadsReturnedToPool} leads returned to the pool.`);
      navigate("/clients");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const initial: ClientFormValue = {
    name: c.name,
    domain: c.domain ?? "",
    industry: c.industry ?? "",
    monthlyLeadTarget: c.monthlyLeadTarget ? String(c.monthlyLeadTarget) : "",
    icpId: c.icpId ?? "",
    color: c.color ?? "",
    notes: c.notes ?? "",
  };

  const funnelMax = Math.max(1, ...STAGES.map((s) => d.funnel[s] ?? 0));

  return (
    <Page
      title={c.name}
      subtitle={[c.domain, c.industry, d.icp ? `ICP: ${d.icp.name}` : "No ICP - pooled leads cannot be routed here"].filter(Boolean).join(" · ")}
      actions={
        <>
          <Link to={`/search?clientId=${id}`} className="btn-primary">Find leads for {c.name}</Link>
          <Link to={`/leads?clientId=${id}`} className="btn-secondary">All leads</Link>
          <button className="btn-secondary" onClick={() => setEditing(true)}>Edit</button>
        </>
      }
    >
      {Toast}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ClientDot color={c.color} size={12} />
        <StatusPill status={c.status} />
        <select className="input w-36 py-1 text-xs" value={c.status} onChange={(e) => setStatus(e.target.value)} aria-label="Client status">
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
        <Link to="/clients" className="ml-auto text-xs text-ink-400 hover:text-ink-50">← All clients</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Leads" value={d.stats.leads.toLocaleString()} hint={d.stats.new7d ? `+${d.stats.new7d} this week` : undefined} />
        <Stat label="Verified" value={d.stats.verified.toLocaleString()} hint={verifiedPct !== null ? `${verifiedPct}% of those with an email` : "No emails yet"} />
        <Stat label="Contacted" value={d.stats.contacted.toLocaleString()} />
        <Stat label="Replied" value={d.stats.replied.toLocaleString()} />
        <Stat label="Qualified" value={d.stats.qualified.toLocaleString()} hint={d.stats.customers ? `${d.stats.customers} became customers` : undefined} />
      </div>

      <div className="card mt-4 p-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Monthly delivery</div>
        <TargetBar t={d.target} />
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-ink-400">Needs attention</h2>
      <p className="mt-1 text-sm text-ink-400">Leads already paid for that are not yet doing any work. Each one here can be recovered.</p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(BUCKET_COPY) as (keyof ClientAttention)[]).map((b) => {
          const copy = BUCKET_COPY[b];
          const count = d.attention[b];
          return (
            <div key={b} className={`card flex flex-col p-4 ${count ? "" : "opacity-60"}`}>
              <div className="text-2xl font-semibold tabular-nums text-ink-50">{count.toLocaleString()}</div>
              <div className="mt-1 font-medium text-ink-100">{copy.title}</div>
              <p className="mt-1 flex-1 text-xs text-ink-400">{copy.why}</p>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary py-1 text-xs" disabled={!count || acting !== null} onClick={() => act(b)}>{acting === b ? "Working…" : copy.actionLabel}</button>
                {count > 0 && <Link className="btn-secondary py-1 text-xs" to={`/leads?clientId=${id}&${copy.leadsQuery}`}>View</Link>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">Where their leads are</div>
          {d.stats.leads === 0 ? (
            <p className="text-sm text-ink-400">No leads yet. Run a search for this client, route leads from the pool, or assign them from the Leads page.</p>
          ) : (
            <div className="space-y-1.5">
              {STAGES.map((s) => (
                <div key={s} className="flex items-center gap-3 text-sm">
                  <span className="w-20 capitalize text-ink-300">{s}</span>
                  <div className="h-2 flex-1 rounded-full bg-black/[0.05]">
                    <div className={`h-2 rounded-full ${s === "lost" ? "bg-black/20" : "bg-brand-500"}`} style={{ width: `${((d.funnel[s] ?? 0) / funnelMax) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right tabular-nums text-ink-200">{d.funnel[s] ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Campaigns</span>
            <Link to="/campaigns" className="text-xs text-brand-600 hover:underline">New campaign</Link>
          </div>
          {d.campaigns.length === 0 ? (
            <p className="text-sm text-ink-400">No campaigns tagged to this client yet. When you create one, choose this client so its results show up here.</p>
          ) : (
            <ul className="divide-y divide-black/[0.05]">
              {d.campaigns.map((k) => (
                <li key={k.id} className="flex items-center justify-between py-2 text-sm">
                  <Link to={`/campaigns/${k.id}`} className="font-medium text-ink-50 hover:text-brand-700">{k.name}</Link>
                  <span className="text-xs text-ink-400">{k.status} · {k.contacts} contacts{k.stats.replied ? ` · ${k.stats.replied} replied` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card mt-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Client report</div>
            <p className="mt-1 max-w-xl text-sm text-ink-300">A read-only page you can send {c.name}: their pipeline, delivery against target, and every lead's name, title, company and stage. Email addresses, phone numbers and profile links are never included.</p>
          </div>
          {shareUrl ? (
            <button className="btn-secondary" onClick={() => share(false)}>Turn off</button>
          ) : (
            <button className="btn-primary" onClick={() => share(true)}>Create report link</button>
          )}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={c.reportShowTarget}
            onChange={async (e) => {
              try {
                await apiFetch("PATCH", `/v1/clients/${id}`, { reportShowTarget: e.target.checked });
                load();
              } catch (x) {
                toast((x as Error).message, "err");
              }
            }}
          />
          Show this month's delivery against the target in the report
        </label>
        {shareUrl && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className="input flex-1 font-mono text-xs" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Report link" />
            <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(shareUrl).then(() => toast("Link copied"))}>Copy</button>
            <a className="btn-secondary" href={shareUrl} target="_blank" rel="noreferrer">Open</a>
            <button className="btn-secondary" onClick={() => share(true)} title="Issues a new link; the old one stops working">New link</button>
          </div>
        )}
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Most recently delivered</span>
          <Link to={`/leads?clientId=${id}`} className="text-xs text-brand-600 hover:underline">See all {d.stats.leads.toLocaleString()}</Link>
        </div>
        {d.recentLeads.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-400">Nothing delivered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-2 w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="th">Person</th>
                  <th className="th">Email</th>
                  <th className="th">Stage</th>
                  <th className="th">Fit</th>
                  <th className="th">Delivered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05]">
                {d.recentLeads.map((l) => (
                  <tr key={l.id}>
                    <td className="td">
                      <div className="font-medium text-ink-50">{l.fullName ?? "Unnamed"}</div>
                      <div className="text-xs text-ink-400">{[l.title, l.company].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="td"><div className="flex items-center gap-2"><span className="truncate text-xs">{l.email ?? "-"}</span><EmailStatusBadge status={l.emailStatus} /></div></td>
                    <td className="td capitalize">{l.status}</td>
                    <td className="td"><ScoreBar score={l.score} /></td>
                    <td className="td text-xs text-ink-400">{fmtDate(l.assignedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 flex justify-end">
        <button className="text-xs text-red-600 hover:underline" onClick={remove}>Delete client</button>
      </div>

      <ClientFormModal
        open={editing}
        onClose={() => setEditing(false)}
        initial={initial}
        title={`Edit ${c.name}`}
        submitLabel="Save"
        onSubmit={async (f) => {
          await apiFetch("PATCH", `/v1/clients/${id}`, toClientPayload(f));
          setEditing(false);
          toast("Saved");
          load();
        }}
      />
    </Page>
  );
}
