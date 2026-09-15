import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, fmtNum } from "../lib/api";
import { Page, Spinner, Stat } from "../components/ui";

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

export function Dashboard() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<Overview>("GET", "/v1/analytics/overview").then(setD).catch((e) => setErr(e.message));
  }, []);
  if (err) return <Page title="Overview"><div className="text-red-600">{err}</div></Page>;
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

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-medium">Last 30 days</div>
            <div className="flex gap-3 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-500" />leads</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />sent</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500" />replied</span></div>
          </div>
          <div className="flex h-40 items-end gap-[3px]">
            {d.daily.map((x) => (
              <div key={x.day} className="group relative flex flex-1 items-end gap-px" title={`${x.day}: ${x.leads} leads, ${x.sent} sent, ${x.replied} replied`}>
                <div className="flex-1 rounded-t bg-brand-500/80" style={{ height: `${(x.leads / max) * 100}%` }} />
                <div className="flex-1 rounded-t bg-emerald-500/80" style={{ height: `${(x.sent / max) * 100}%` }} />
                <div className="flex-1 rounded-t bg-amber-500/80" style={{ height: `${(x.replied / max) * 100}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className="card p-4">
          <div className="mb-3 font-medium">Monthly usage</div>
          <div className="space-y-3">
            {Object.entries(d.usage.usage).map(([k, v]) => (
              <div key={k}>
                <div className="flex justify-between text-xs"><span className="capitalize text-slate-600">{k.replace(/([A-Z])/g, " $1")}</span><span className="tabular-nums text-slate-500">{fmtNum(v.used)} / {fmtNum(v.limit)}</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className={`h-1.5 rounded-full ${v.limit && v.used / v.limit > 0.9 ? "bg-red-500" : "bg-brand-500"}`} style={{ width: `${v.limit ? Math.min(100, (v.used / v.limit) * 100) : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 font-medium">Email quality</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(d.emailStatus).map(([s, n]) => (
              <div key={s} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"><span className="text-slate-500">{s.replace("_", " ")}</span> <span className="ml-2 font-semibold">{fmtNum(n)}</span></div>
            ))}
            {Object.keys(d.emailStatus).length === 0 && <div className="text-sm text-slate-500">No leads yet.</div>}
          </div>
        </div>
        <div className="card p-4">
          <div className="mb-3 font-medium">Top companies</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {d.topCompanies.map((c) => (
              <li key={c.domain} className="flex justify-between py-1.5"><span className="truncate">{c.name ?? c.domain} <span className="text-slate-400">{c.domain}</span></span><span className="tabular-nums text-slate-500">{c.n}</span></li>
            ))}
            {d.topCompanies.length === 0 && <li className="py-1.5 text-slate-500">No companies yet.</li>}
          </ul>
        </div>
      </div>
    </Page>
  );
}
