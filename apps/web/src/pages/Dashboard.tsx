import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, fmtNum } from "../lib/api";
import { metricLabel } from "../lib/metrics";
import { LoadError, Page, Spinner, Stat } from "../components/ui";

interface Overview {
  leads: { total: number; withEmail: number; verified: number; last7d: number; avgScore: number };
  messages: { sent: number; opened: number; clicked: number; replied: number };
  companies: number;
  campaigns: { active: number; total: number };
  daily: { day: string; leads: number; sent: number; replied: number }[];
  emailStatus: Record<string, number>;
  topCompanies: { name: string | null; domain: string; n: number }[];
  usage: { period: string; plan: string; usage: Record<string, { used: number; limit: number }> };
}

interface HotLead {
  lead: { id: string; fullName: string | null; title: string | null; company: { name: string | null; domain: string } | null };
  priority: { score: number; reasons: string[] };
}

export function Dashboard() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hot, setHot] = useState<HotLead[] | null>(null);
  const [hotErr, setHotErr] = useState<string | null>(null);
  const loadHot = useCallback(() => {
    setHotErr(null);
    apiFetch<{ leads: HotLead[] }>("GET", "/v1/leads/hot/list?limit=6").then((r) => setHot(r.leads)).catch((e) => setHotErr((e as Error).message));
  }, []);
  const load = useCallback(() => {
    setErr(null);
    apiFetch<Overview>("GET", "/v1/analytics/overview").then(setD).catch((e) => setErr((e as Error).message));
    loadHot();
  }, [loadHot]);
  useEffect(() => { load(); }, [load]);
  if (err) return <Page title="Overview"><LoadError message={err} onRetry={load} /></Page>;
  if (!d) return <Page title="Overview"><Spinner label="Loading…" /></Page>;
  const max = Math.max(1, ...d.daily.map((x) => Math.max(x.leads, x.sent)));
  return (
    <Page title="Overview" subtitle={`Plan: ${d.usage.plan} · period ${d.usage.period}`} actions={<Link to="/search" className="btn-primary">Find leads</Link>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Leads" value={fmtNum(d.leads.total)} hint={`${fmtNum(d.leads.last7d)} in last 7 days`} />
        <Stat label="Verified emails" value={fmtNum(d.leads.verified)} hint={`${fmtNum(d.leads.withEmail)} with any email`} />
        <Stat label="Emails sent" value={fmtNum(d.messages.sent)} hint={`${d.messages.sent ? Math.round((d.messages.opened / d.messages.sent) * 100) : 0}% opened · ${d.messages.sent ? Math.round((d.messages.replied / d.messages.sent) * 100) : 0}% replied`} />
        <Stat label="Active campaigns" value={fmtNum(d.campaigns.active)} hint={`${fmtNum(d.companies)} companies tracked`} />
      </div>

      {/* The hot list failing used to hide the card, which reads as "nobody to contact today". */}
      {hotErr && (
        <div className="card mt-6 flex flex-wrap items-center justify-between gap-3 p-4 text-sm" role="alert">
          <span className="text-ink-300">Couldn&apos;t load today&apos;s leads to contact ({hotErr}).</span>
          <button className="btn-secondary" onClick={loadHot}>Try again</button>
        </div>
      )}
      {hot && hot.length > 0 && (
        <div className="card mt-6 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-medium">Contact today</div>
              <div className="text-xs text-ink-400">Ranked by fit, engagement, and live company signals - not just recency.</div>
            </div>
            <Link to="/leads?sort=score&order=desc" className="text-sm text-brand-600 hover:underline">View all leads →</Link>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hot.map((h) => (
              <div key={h.lead.id} className="min-w-0 rounded-lg border border-black/10 p-3 text-sm [overflow-wrap:anywhere]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 font-medium">{h.lead.fullName ?? "Unknown"}</div>
                  <span className={`badge ${h.priority.score >= 70 ? "bg-emerald-50 text-emerald-700" : h.priority.score >= 40 ? "bg-amber-50 text-amber-700" : "bg-black/[0.05] text-ink-400"}`}>{h.priority.score}</span>
                </div>
                <div className="text-xs text-ink-400">{h.lead.title ?? ""}{h.lead.company ? ` · ${h.lead.company.name ?? h.lead.company.domain}` : ""}</div>
                {h.priority.reasons[0] && <div className="mt-1 text-xs text-ink-300">{h.priority.reasons[0]}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card min-w-0 p-4 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">Last 30 days</div>
            <div className="flex gap-3 text-xs text-ink-400"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-500" />leads</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />sent</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500" />replied</span></div>
          </div>
          {/* An all-zero month drew an empty box that looked like a chart that failed to render. */}
          {d.daily.every((x) => !x.leads && !x.sent && !x.replied) ? (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-black/10 text-sm text-ink-400">No activity in the last 30 days yet</div>
          ) : (
          <div className="flex h-40 items-end gap-[3px]">
            {d.daily.map((x) => (
              <div key={x.day} className="group relative flex flex-1 items-end gap-px" title={`${x.day}: ${x.leads} leads, ${x.sent} sent, ${x.replied} replied`}>
                <div className="flex-1 rounded-t bg-brand-400" style={{ height: `${(x.leads / max) * 100}%` }} />
                <div className="flex-1 rounded-t bg-emerald-400" style={{ height: `${(x.sent / max) * 100}%` }} />
                <div className="flex-1 rounded-t bg-amber-400" style={{ height: `${(x.replied / max) * 100}%` }} />
              </div>
            ))}
          </div>
          )}
        </div>
        <div className="card min-w-0 p-4">
          <div className="mb-3 font-medium">Monthly usage</div>
          <div className="space-y-3">
            {Object.entries(d.usage.usage).map(([k, v]) => (
              <div key={k}>
                <div className="flex justify-between text-xs"><span className="text-ink-300">{metricLabel(k)}</span><span className="tabular-nums text-ink-400">{fmtNum(v.used)} / {limitLabel(k, v.limit)}</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-black/[0.05]"><div className={`h-1.5 rounded-full ${v.limit && v.used / v.limit > 0.9 ? "bg-red-500" : "bg-brand-500"}`} style={{ width: `${v.limit ? Math.min(100, (v.used / v.limit) * 100) : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card min-w-0 p-4">
          <div className="mb-3 font-medium">Email quality</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(d.emailStatus).map(([s, n]) => (
              <div key={s} className="rounded-lg border border-black/10 px-3 py-2 text-sm"><span className="text-ink-400">{s.replace("_", " ")}</span> <span className="ml-2 font-semibold">{fmtNum(n)}</span></div>
            ))}
            {Object.keys(d.emailStatus).length === 0 && <div className="text-sm text-ink-400">No leads yet.</div>}
          </div>
        </div>
        <div className="card min-w-0 p-4">
          <div className="mb-3 font-medium">Top companies</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {d.topCompanies.map((c) => (
              <li key={c.domain} className="flex justify-between gap-2 py-1.5"><span className="min-w-0 truncate" title={c.name ?? c.domain}>{c.name ?? c.domain} <span className="text-ink-500">{c.domain}</span></span><span className="tabular-nums text-ink-400">{c.n}</span></li>
            ))}
            {d.topCompanies.length === 0 && <li className="py-1.5 text-ink-400">No companies yet.</li>}
          </ul>
        </div>
      </div>
    </Page>
  );
}

/**
 * The plan-limit side of "used / limit". A limit of 0 (or less) means unlimited for every
 * metric except provider-sourced leads, where it means the plan includes none
 * (packages/db usage.ts). Printing "12 / 0" for an unlimited plan read as over quota.
 */
function limitLabel(metric: string, limit: number): string {
  if (limit > 0) return fmtNum(limit);
  return metric === "premiumLeads" ? "0 (not on this plan)" : "unlimited";
}
