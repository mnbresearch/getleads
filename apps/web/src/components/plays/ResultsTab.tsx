import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, expectLists } from "../../lib/api";
import { Empty, LoadError, Spinner } from "../ui";
import { clean, messageOf, pct, typeName, typeTone, type Performance, type PerformanceRow, type PlayTypeInfo } from "../../lib/plays";

const NOT_ENOUGH = "not enough sends yet";

/**
 * A rate, or the plain statement that there is not enough behind it yet.
 *
 * The server decides (`sufficient`). Below its threshold the figure is still shown - hiding
 * it would look like no data at all - but greyed and labelled in words, so two replies out
 * of three sends never reads as "67% reply rate".
 */
function Rate({ value, sufficient }: { value: number | null; sufficient: boolean }) {
  if (sufficient) return <span className="tabular-nums font-medium text-ink-50">{pct(value)}</span>;
  return (
    <span className="text-ink-400">
      <span className="tabular-nums">{pct(value)}</span>
      <span className="block text-[11px] leading-tight">{NOT_ENOUGH}</span>
    </span>
  );
}

/**
 * The scoreboard: every play judged by what happened after it found someone.
 *
 * Found, approved, contacted, replied, replied positively - the numbers are the server's,
 * and so is the judgement about which play is best (it names one only among plays with
 * enough sends to compare).
 */
export function ResultsTab({ types, epoch, onGoToPlays }: { types: PlayTypeInfo[] | null; epoch: number; onGoToPlays: () => void }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Performance | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const shownFor = useRef<number | null>(null);

  const load = useCallback(() => {
    const mine = ++seq.current;
    if (shownFor.current !== days) setLoading(true);
    apiFetch<Performance>("GET", `/v1/plays/performance?days=${days}`)
      .then((r) => { if (mine !== seq.current) return; setData(expectLists(r, "plays")); shownFor.current = days; setErr(null); })
      .catch((e) => {
        if (mine !== seq.current) return;
        // Numbers belong to the window they were loaded for.
        if (shownFor.current !== days) { setData(null); shownFor.current = null; }
        setErr(messageOf(e));
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [days]);
  useEffect(() => { load(); }, [load, epoch]);

  const rows: PerformanceRow[] = data?.plays ?? [];
  const note = clean(data?.note, 500);
  const best = data?.best && typeof data.best.name === "string" ? data.best : null;

  return (
    <div data-testid="results">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-ink-300">Which source of intent actually starts conversations. Rates are per person contacted.</p>
        <select className="input w-40" aria-label="Time window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>

      {loading ? (
        <Spinner label="Loading results…" />
      ) : err && !data ? (
        <LoadError message={err} onRetry={load} />
      ) : rows.length === 0 ? (
        <>
          {note && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 [overflow-wrap:anywhere]" data-testid="results-note">{note}</div>}
          <Empty title="No results in this window yet" hint="Results appear once a play has found people. Approve them, contact them, and this shows which play earns replies." action={<button type="button" className="btn-primary" onClick={onGoToPlays}>Go to your plays</button>} />
        </>
      ) : (
        <>
          {err && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">These numbers could not be refreshed ({err}). <button type="button" className="underline" onClick={load}>Try again</button></div>}
          {best ? (
            <div className="mb-3 rounded-xl border border-brand-200 bg-brand-50 p-4 [overflow-wrap:anywhere]" data-testid="best-play">
              <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Best play right now</div>
              <div className="mt-1 text-lg font-semibold text-ink-50">{clean(best.name, 120)}</div>
              {best.why && <p className="mt-0.5 text-sm text-ink-200">{clean(best.why, 400)}</p>}
            </div>
          ) : (
            <div className="mb-3 rounded-xl border border-black/[0.06] bg-surface p-4 [overflow-wrap:anywhere]" data-testid="no-best-play">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Best play right now</div>
              <p className="mt-1 text-sm text-ink-200">Too early to call. A play needs enough people contacted before its rates can be compared with another&apos;s.</p>
            </div>
          )}
          {note && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 [overflow-wrap:anywhere]" data-testid="results-note">{note}</div>}

          {/* Wide screens: one table. Phones: the same numbers as a card per play, so nothing scrolls sideways. */}
          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-black/10 bg-cream">
                <tr>
                  <th className="th">Play</th><th className="th">Found</th><th className="th">Approved</th><th className="th">Contacted</th>
                  <th className="th">Replied</th><th className="th">Positive</th><th className="th">Reply rate</th><th className="th">Positive rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.playId} data-testid="results-row" className={best && best.playId === r.playId ? "bg-brand-50/40" : undefined}>
                    <td className="td max-w-[18rem]">
                      <div className="truncate font-medium text-ink-50" title={clean(r.name, 200)}>{clean(r.name, 200)}</div>
                      <span className={`badge mt-0.5 ${typeTone(r.type)}`}>{typeName(types, r.type)}</span>
                    </td>
                    <td className="td tabular-nums">{(r.found ?? 0).toLocaleString()}</td>
                    <td className="td tabular-nums">{(r.approved ?? 0).toLocaleString()}</td>
                    <td className="td tabular-nums">{(r.contacted ?? 0).toLocaleString()}</td>
                    <td className="td tabular-nums">{(r.replied ?? 0).toLocaleString()}</td>
                    <td className="td tabular-nums">{(r.positive ?? 0).toLocaleString()}</td>
                    <td className="td"><Rate value={r.replyRate} sufficient={!!r.sufficient} /></td>
                    <td className="td"><Rate value={r.positiveRate} sufficient={!!r.sufficient} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 md:hidden" aria-label="Results per play">
            {rows.map((r) => (
              <li key={r.playId} className={`card p-4 [overflow-wrap:anywhere] ${best && best.playId === r.playId ? "ring-1 ring-brand-200" : ""}`} data-testid="results-card">
                <div className="font-semibold text-ink-50">{clean(r.name, 200)}</div>
                <span className={`badge mt-1 ${typeTone(r.type)}`}>{typeName(types, r.type)}</span>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  {([["Found", r.found], ["Approved", r.approved], ["Contacted", r.contacted], ["Replied", r.replied], ["Positive", r.positive]] as [string, number][]).map(([l, v]) => (
                    <div key={l} className="rounded-lg bg-cream p-2"><dt className="text-ink-400">{l}</dt><dd className="text-base font-semibold tabular-nums">{(v ?? 0).toLocaleString()}</dd></div>
                  ))}
                </dl>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-cream p-2"><dt className="text-xs text-ink-400">Reply rate</dt><dd><Rate value={r.replyRate} sufficient={!!r.sufficient} /></dd></div>
                  <div className="rounded-lg bg-cream p-2"><dt className="text-xs text-ink-400">Positive rate</dt><dd><Rate value={r.positiveRate} sufficient={!!r.sufficient} /></dd></div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-400">Found counts people a play brought in during this window. Contacted, replied and positive count the ones you approved and then wrote to. A positive reply is one that shows interest or refers you to someone.</p>
        </>
      )}
    </div>
  );
}
