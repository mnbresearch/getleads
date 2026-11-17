import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, fmtNum, expectLists } from "../lib/api";
import { metricLabel } from "../lib/metrics";
import { LoadError, Page, Spinner, Stat } from "../components/ui";
import { plural } from "../lib/plural";
import { OnboardingModal, openOnboardingTour } from "../components/OnboardingModal";

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
  // People the plays have found who are waiting for a yes or no. An extra, never a
  // dependency: an older server without Plays, or a failed request, shows nothing at all.
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    let live = true;
    apiFetch<{ plays?: { counts?: { pending?: unknown } }[] }>("GET", "/v1/plays")
      .then((r) => {
        const n = Array.isArray(r?.plays) ? r.plays.reduce((sum, p) => sum + (typeof p?.counts?.pending === "number" && p.counts.pending > 0 ? p.counts.pending : 0), 0) : 0;
        if (live) setWaiting(n);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const loadHot = useCallback(() => {
    setHotErr(null);
    apiFetch<{ leads: HotLead[] }>("GET", "/v1/leads/hot/list?limit=6").then((r) => setHot(expectLists(r, "leads").leads)).catch((e) => setHotErr((e as Error).message));
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
  // Needs your attention: only things somebody can act on, built from reads
  // that succeeded. A metric is "nearly used" only when it has a real limit.
  const nearlyUsed = Object.entries(d.usage.usage).filter(([, v]) => v.limit > 0 && v.used / v.limit >= 0.8);
  return (
    <Page
      title="Command Center"
      subtitle={`Plan: ${d.usage.plan} · period ${d.usage.period}`}
      actions={
        <div className="flex items-center gap-2">
          <button type="button" onClick={openOnboardingTour} className="btn-secondary text-xs">
            Guided Tour & Objectives
          </button>
          <Link to="/search" className="btn-primary">
            Find leads
          </Link>
        </div>
      }
    >
      <OnboardingModal />

      {d.leads.total === 0 && (
        <div className="card mb-6 border-brand-200 bg-gradient-to-r from-brand-50/40 via-surface to-brand-50/40 p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <span className="badge bg-brand-100 text-brand-800 text-[10px] font-bold uppercase tracking-wider mb-1 inline-block">
                Zero-Sample Workspace
              </span>
              <h3 className="font-bold text-sm text-ink-50">Welcome to your clean Scout workspace</h3>
              <p className="text-xs text-ink-300 mt-0.5 max-w-xl">
                We never inject fabricated or sample leads into your database. Start your first real prospect search to discover verified decision-makers and companies.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={openOnboardingTour} className="btn-secondary text-xs py-2 px-3">
                View Setup Guide
              </button>
              <Link to="/search" className="btn-primary text-xs py-2 px-4">
                Run First Search →
              </Link>
            </div>
          </div>
        </div>
      )}

      {nearlyUsed.length > 0 && (
        <div className="card glass mb-6 p-4" role="region" aria-label="Needs your attention">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">Needs your attention</div>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {nearlyUsed.map(([k, v]) => (
              <li key={k}>
                <Link to="/analytics" className="block rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm hover:bg-amber-100/70 dark:border-amber-700/50 dark:bg-amber-900/15">
                  <span className="font-medium">{metricLabel(k)}: {Math.round((v.used / v.limit) * 100)}% used →</span>
                  <span className="block text-xs text-ink-400">{fmtNum(v.used)} of {fmtNum(v.limit)} this period</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat glass label="Leads" value={fmtNum(d.leads.total)} hint={`${fmtNum(d.leads.last7d)} in last 7 days`} />
        <Stat glass label="Verified emails" value={fmtNum(d.leads.verified)} hint={`${fmtNum(d.leads.withEmail)} with any email`} />
        <Stat glass label="Emails sent" value={fmtNum(d.messages.sent)} hint={`${d.messages.sent ? Math.round((d.messages.opened / d.messages.sent) * 100) : 0}% opened · ${d.messages.sent ? Math.round((d.messages.replied / d.messages.sent) * 100) : 0}% replied`} />
        <Stat glass label="Active campaigns" value={fmtNum(d.campaigns.active)} hint={`${plural(d.companies, "company")} tracked`} />
      </div>

      <nav aria-label="Quick tools" className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          { to: "/search", label: "Find leads", icon: "⌕" },
          { to: "/leads", label: "Leads", icon: "☰" },
          { to: "/campaigns", label: "Campaigns", icon: "📨" },
          { to: "/plays", label: "Plays", icon: "▷" },
          { to: "/pipeline", label: "Deals", icon: "📊" },
          { to: "/analytics", label: "Analytics", icon: "▤" },
        ].map((q) => (
          <Link key={q.to} to={q.to} className="card glass flex min-h-16 flex-col items-center justify-center gap-1 p-2 text-center text-xs font-medium transition hover:border-brand-300">
            <span className="text-lg text-brand-600 dark:text-brand-400" aria-hidden>{q.icon}</span>
            {q.label}
          </Link>
        ))}
      </nav>

      {waiting > 0 && (
        <Link to="/plays" className="card mt-6 flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-brand-300" data-testid="plays-waiting">
          <span className="min-w-0">
            <span className="block font-medium text-ink-50">{plural(waiting, "person", "people")} waiting for review in Plays</span>
            <span className="block text-xs text-ink-400">Each comes with the reason they are relevant and the proof. Approve or skip.</span>
          </span>
          <span className="btn-primary shrink-0 py-1.5">Review</span>
        </Link>
      )}

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
              <div key={x.day} className="group relative flex flex-1 items-end gap-px" title={`${x.day}: ${plural(x.leads, "lead")}, ${x.sent} sent, ${x.replied} replied`}>
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
