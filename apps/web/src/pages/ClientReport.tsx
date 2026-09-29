import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, fmtDate } from "../lib/api";
import { Logo } from "../components/Logo";
import { TargetBar } from "../components/ClientBits";
import type { TargetProgress } from "../lib/clients";

interface Report {
  client: { name: string; domain: string | null };
  preparedBy: string | null;
  generatedAt: string;
  stats: { leads: number; deliveredThisMonth: number; verified: number; contacted: number; replied: number; qualified: number; customers: number };
  target: TargetProgress | null;
  funnel: Record<string, number>;
  leads: { name: string | null; title: string | null; company: string | null; industry: string | null; stage: string; emailVerified: boolean; deliveredAt: string | null }[];
  shownLeads: number;
  listTruncated: boolean;
}

const STAGES = ["new", "contacted", "engaged", "replied", "qualified", "customer"];

/**
 * What an agency's client sees through a shared link.
 *
 * No login, no app chrome, and no contact details: names, titles, companies and stages,
 * which is enough to see the pipeline being built without the data that must not travel
 * when a link is forwarded.
 */
export function ClientReportPage() {
  const { token = "" } = useParams();
  const [r, setR] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "error" | "ok">("loading");

  useEffect(() => {
    apiFetch<Report>("GET", `/v1/public/clients/report/${encodeURIComponent(token)}`)
      .then((x) => { setR(x); setState("ok"); })
      .catch((e) => setState((e as { status?: number }).status === 404 ? "missing" : "error"));
  }, [token]);

  useEffect(() => {
    if (r) document.title = `${r.client.name} - pipeline report`;
  }, [r]);

  // A client's pipeline must never end up in a search index because a link was pasted
  // somewhere public. The API sets x-robots-tag on its JSON; this page is the SPA shell, so
  // it says the same thing in markup.
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots";
    m.content = "noindex, nofollow";
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-black/10 bg-surface/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Logo size={24} textClassName="text-base" />
          <span className="text-xs text-ink-400">Pipeline report</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {state === "loading" && <p className="text-sm text-ink-400">Loading report…</p>}
        {state === "missing" && (
          <div className="card mx-auto max-w-md p-8 text-center">
            <h1 className="text-lg font-semibold text-ink-50">This report link is not active</h1>
            <p className="mt-2 text-sm text-ink-400">It may have been turned off or replaced with a newer link. Ask whoever sent it for the current one.</p>
          </div>
        )}
        {state === "error" && (
          <div className="card mx-auto max-w-md p-8 text-center">
            <h1 className="text-lg font-semibold text-ink-50">The report could not be loaded</h1>
            <p className="mt-2 text-sm text-ink-400">That is a problem on our side, not with the link. Try again in a minute.</p>
          </div>
        )}
        {state === "ok" && r && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-3xl font-bold tracking-tight text-ink-50">{r.client.name}</h1>
                <p className="mt-1 text-sm text-ink-400">
                  {r.preparedBy ? <>Prepared by {r.preparedBy} · </> : null}Updated {fmtDate(r.generatedAt)}
                </p>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Leads delivered", r.stats.leads],
                ["Verified emails", r.stats.verified],
                ["Replied", r.stats.replied],
                ["Qualified", r.stats.qualified],
              ].map(([label, v]) => (
                <div key={String(label)} className="card p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-50">{Number(v).toLocaleString()}</div>
                </div>
              ))}
            </div>

            {r.target && (
              <div className="card mt-4 p-5">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">This month</div>
                <TargetBar t={r.target} />
              </div>
            )}

            <div className="card mt-4 p-5">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">Pipeline</div>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {STAGES.map((s) => (
                  <div key={s} className="rounded-lg bg-black/[0.03] p-3 text-center">
                    <div className="text-xl font-semibold tabular-nums text-ink-50">{(r.funnel[s] ?? 0).toLocaleString()}</div>
                    <div className="text-[11px] uppercase tracking-wide text-ink-400">{s}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card mt-4 overflow-hidden">
              <div className="px-5 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-400">Leads</div>
              {r.leads.length === 0 ? (
                <p className="px-5 py-4 text-sm text-ink-400">No leads delivered yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-black/[0.06]">
                        <th className="th">Person</th>
                        <th className="th">Company</th>
                        <th className="th">Stage</th>
                        <th className="th">Email verified</th>
                        <th className="th">Delivered</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.05]">
                      {r.leads.map((l, i) => (
                        <tr key={i}>
                          <td className="td">
                            <div className="font-medium text-ink-50">{l.name ?? "Unnamed"}</div>
                            <div className="text-xs text-ink-400">{l.title ?? ""}</div>
                          </td>
                          <td className="td">{l.company ?? "-"}{l.industry ? <div className="text-xs text-ink-400">{l.industry}</div> : null}</td>
                          <td className="td capitalize">{l.stage}</td>
                          <td className="td">{l.emailVerified ? <span className="text-emerald-700">Yes</span> : <span className="text-ink-500">-</span>}</td>
                          <td className="td text-xs text-ink-400">{fmtDate(l.deliveredAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {r.listTruncated && <p className="px-5 pb-4 text-xs text-ink-400">Showing the {r.shownLeads} most recent of {r.stats.leads.toLocaleString()}. The totals above count all of them.</p>}
            </div>

            <p className="mt-6 text-center text-xs text-ink-500">Contact details are kept private in this shared view.</p>
          </>
        )}
      </main>
    </div>
  );
}
