import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { LoadError, Page, Spinner } from "../components/ui";

interface Deal {
  id: string;
  name: string;
  stage: string;
  value: number;
  currency?: string;
  riskLevel?: string | null;
  aiNextBestAction?: string | null;
}

interface DeskData {
  deals: Deal[];
  totalPipeline: number;
  currency: string;
  callable: number;
  callsToday: number;
  meetingsToday: number;
  blitz: { name: string; targetCalls: number; targetMeetings: number } | null;
}

/**
 * The sales desk: deals, the call queue and today's calls, all read from this workspace.
 *
 * This page used to be the signed-in home, and almost everything on it was invented: a
 * $128,500 pipeline when there were no deals, "32 calls today", deals at Datadog, Ramp and
 * Retool, two digital SDRs called Alice and Jordan "currently operational", and a "94.6%
 * match" badge. A customer's first screen showed somebody else's business as theirs. Every
 * number here is now counted, and an empty workspace says it is empty.
 */
export function SalesCommandCenter() {
  const [d, setD] = useState<DeskData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    Promise.all([
      apiFetch<{ deals: Deal[]; totalPipeline: number; currency?: string }>("GET", "/v1/deals"),
      apiFetch<{ queue: unknown[] }>("GET", "/v1/dialer/queue"),
      apiFetch<{ blitz: DeskData["blitz"]; teamMembers: { meetingsToday: number }[]; callsToday?: number }>("GET", "/v1/salesfloor/state"),
    ])
      .then(([deals, queue, floor]) =>
        setD({
          deals: (deals.deals ?? []).filter((x) => x.stage !== "lost" && x.stage !== "won"),
          totalPipeline: deals.totalPipeline ?? 0,
          currency: deals.currency ?? "USD",
          callable: queue.queue?.length ?? 0,
          callsToday: floor.callsToday ?? 0,
          meetingsToday: (floor.teamMembers ?? []).reduce((a, m) => a + (m.meetingsToday || 0), 0),
          blitz: floor.blitz ?? null,
        }),
      )
      .catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const subtitle = "Open deals, who to call next and today's calls, from this workspace.";
  if (err) return <Page title="Sales desk" subtitle={subtitle}><LoadError message={err} onRetry={load} /></Page>;
  if (!d) return <Page title="Sales desk" subtitle={subtitle}><Spinner label="Loading…" /></Page>;

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: d.currency, maximumFractionDigits: 0 }).format(n);
  const tiles = [
    { label: "Open pipeline", value: money(d.totalPipeline), hint: `${d.deals.length} open deal${d.deals.length === 1 ? "" : "s"}`, to: "/pipeline" },
    { label: "Ready to call", value: String(d.callable), hint: "leads with a phone number", to: "/dialer" },
    { label: "Calls today", value: String(d.callsToday), hint: "logged in the dialer", to: "/salesfloor" },
    { label: "Meetings today", value: String(d.meetingsToday), hint: "from logged calls", to: "/salesfloor" },
  ];

  return (
    <Page
      title="Sales desk"
      subtitle={subtitle}
      actions={
        <div className="flex items-center gap-2">
          <Link to="/pipeline" className="btn-secondary text-xs sm:text-sm">Deals board</Link>
          <Link to="/dialer" className="btn-primary text-xs sm:text-sm">Open call queue</Link>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="glass rounded-2xl p-4 transition hover:-translate-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t.label}</div>
            <div className="mt-1 text-2xl font-extrabold text-ink-50">{t.value}</div>
            <div className="mt-0.5 text-[11px] text-ink-400">{t.hint}</div>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-black/5 pb-3">
            <h3 className="text-sm font-semibold text-ink-50">Open deals</h3>
            <Link to="/pipeline" className="text-xs font-semibold text-brand-600 hover:underline">All deals</Link>
          </div>
          {d.deals.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-400">
              No open deals yet. <Link to="/pipeline" className="font-semibold text-brand-600 hover:underline">Add your first deal</Link>.
            </div>
          ) : (
            <div className="divide-y divide-black/5">
              {d.deals.slice(0, 6).map((deal) => (
                <div key={deal.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink-50">{deal.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      <span className="font-semibold capitalize text-brand-700">{deal.stage}</span>
                      <span>·</span>
                      <span className="font-medium text-ink-100">{money(deal.value || 0)}</span>
                      {deal.riskLevel && (<><span>·</span><span className="capitalize">{deal.riskLevel} risk</span></>)}
                    </div>
                    {deal.aiNextBestAction && <div className="mt-1 text-xs text-ink-300">Next: {deal.aiNextBestAction}</div>}
                  </div>
                  <Link to="/pipeline" className="btn-secondary flex-shrink-0 px-3 py-1.5 text-xs">Open</Link>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-ink-50">Team blitz</h3>
            {d.blitz ? (
              <p className="mt-1 text-xs text-ink-400">
                <span className="font-semibold text-ink-100">{d.blitz.name}</span>: {d.callsToday} of {d.blitz.targetCalls} calls, {d.meetingsToday} of {d.blitz.targetMeetings} meetings.
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink-400">No blitz running.</p>
            )}
            <Link to="/salesfloor" className="mt-3 inline-block text-xs font-semibold text-brand-600 hover:underline">{d.blitz ? "Open the salesfloor" : "Start one on the salesfloor"}</Link>
          </div>
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-ink-50">Tools</h3>
            <div className="mt-2 grid gap-1.5 text-xs">
              {[
                { to: "/rooms", l: "Digital sales rooms for a buyer" },
                { to: "/email-coach", l: "Grade a draft email" },
                { to: "/coaching", l: "Practise a call with AI roleplay" },
                { to: "/autopilot", l: "Run an AI SDR on Autopilot" },
              ].map((x) => (
                <Link key={x.to} to={x.to} className="rounded-lg border border-black/5 px-3 py-2 font-medium text-ink-100 hover:bg-black/[0.03]">{x.l}</Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
