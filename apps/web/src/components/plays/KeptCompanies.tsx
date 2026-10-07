import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, expectLists } from "../../lib/api";
import { ExtLink } from "../ExtLink";
import { plural } from "../../lib/plural";
import { ago, candidateName, clean, hostOf, isForbidden, leavesQueue, messageOf, normalizeDecide, type Candidate } from "../../lib/plays";
import { FindTitlesForm } from "./FindTitlesForm";

const PAGE = 50;

export type FindOutcome = { ok: true; added: number; peopleFound?: number } | { ok: false; message: string };

/**
 * "Companies kept": the companies someone approved, which stay in their play.
 *
 * Approving a company keeps it, but a company is nobody to write to - the next step is Find
 * people. The line that appears where the card was only lasts while the page is open; this
 * section is read from the server, so the company is still here after a reload, with its
 * reason, its proof, how many people have been found for it, Find people, and Dismiss.
 *
 * It shows nothing at all when there are none, or on a server that does not report how many
 * people were found (one from before this section existed).
 */
export function KeptCompanies({
  playId, refreshKey, openByDefault, findHint, needsTitles, onFind, onDismissed, onCount, onForbidden, toast,
}: {
  playId: string;
  /** Bumped when a company was just approved, so the list is read again. */
  refreshKey: number;
  /** Open when there is nothing else to look at (the queue is empty); otherwise one line. */
  openByDefault: boolean;
  /** The server's sentence about finding people when no search source is connected. */
  findHint?: string;
  needsTitles: (c: Candidate) => boolean;
  onFind: (c: Candidate, titles?: string[]) => Promise<FindOutcome>;
  onDismissed: (id: string) => void;
  /** How many are kept across every play: the number itself, or - when the list is narrowed to one play - how it changed. */
  onCount?: (n: number | ((now: number) => number)) => void;
  onForbidden: (message: string) => void;
  toast: (m: string, k?: "ok" | "err") => void;
}) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [supported, setSupported] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Record<string, "find" | "dismiss">>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [titlesFor, setTitlesFor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const rowsRef = useRef<Candidate[]>([]);
  rowsRef.current = rows;

  const load = useCallback((offset = 0) => {
    const mine = ++seq.current;
    const qs = new URLSearchParams({ status: "approved", kind: "company", limit: String(PAGE), offset: String(offset) });
    if (playId) qs.set("playId", playId);
    if (offset > 0) setMore(true);
    apiFetch<{ candidates: Candidate[]; total: number }>("GET", `/v1/plays/candidates?${qs.toString()}`)
      .then((r) => {
        if (mine !== seq.current) return;
        const got = expectLists(r, "candidates").candidates.filter((c) => c && typeof c.id === "string" && c.kind === "company");
        // A server that does not say how many people were found predates this section.
        const knows = got.every((c) => typeof c.peopleFound === "number");
        setSupported(knows);
        const next = offset > 0 ? [...rowsRef.current, ...got.filter((c) => !rowsRef.current.some((x) => x.id === c.id))] : got;
        setRows(next);
        setTotal(Math.max(next.length, typeof r.total === "number" ? r.total : next.length));
        setLoadErr(null);
        setCountedFor(playId);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        // Never the reason the queue above does not work: said only where a list was already showing.
        setLoadErr(messageOf(e));
      })
      .finally(() => { if (mine === seq.current) setMore(false); });
  }, [playId]);
  useEffect(() => { setRows([]); setTotal(0); setSupported(false); setRowErr({}); setTitlesFor(null); }, [playId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  // Which filter the numbers on screen were read for (null until the first answer).
  const [countedFor, setCountedFor] = useState<string | null>(null);
  const reported = useRef<{ playId: string; n: number } | null>(null);
  useEffect(() => {
    if (countedFor !== playId) return;
    const now = supported ? total : 0;
    const before = reported.current;
    if (!playId) onCount?.(now);
    else if (before && before.playId === playId && before.n !== now) onCount?.((n) => Math.max(0, n + now - before.n));
    reported.current = { playId, n: now };
  }, [playId, countedFor, supported, total, onCount]);

  if (!supported || rows.length === 0) return null;
  const isOpen = open ?? openByDefault;

  const find = async (c: Candidate, titles?: string[]) => {
    if (!titles && needsTitles(c)) { setTitlesFor((t) => (t === c.id ? null : c.id)); return; }
    setTitlesFor(null);
    setBusy((b) => ({ ...b, [c.id]: "find" }));
    setRowErr((m) => { const n = { ...m }; delete n[c.id]; return n; });
    const r = await onFind(c, titles);
    setBusy((b) => { const n = { ...b }; delete n[c.id]; return n; });
    if (!r.ok) { setRowErr((m) => ({ ...m, [c.id]: `Nobody was looked up: ${r.message}` })); return; }
    setRows((list) => list.map((x) => (x.id === c.id ? { ...x, peopleFound: typeof r.peopleFound === "number" ? r.peopleFound : (x.peopleFound ?? 0) + r.added } : x)));
  };

  const dismiss = async (c: Candidate) => {
    const name = candidateName(c);
    setBusy((b) => ({ ...b, [c.id]: "dismiss" }));
    setRowErr((m) => { const n = { ...m }; delete n[c.id]; return n; });
    try {
      const r = normalizeDecide(await apiFetch("POST", "/v1/plays/candidates/decide", { decisions: [{ id: c.id, decision: "skip" }] }));
      const refused = r.notApplied.find((x) => x.id === c.id);
      const done = r.applied ? r.applied.includes(c.id) : !refused && r.skipped > 0;
      if (done || (refused && leavesQueue(refused))) {
        setRows((list) => list.filter((x) => x.id !== c.id));
        setTotal((t) => Math.max(0, t - 1));
        onDismissed(c.id);
        toast(done ? `Dismissed ${name}. Nothing else changed - people already found there stay where they are.` : `${name} was already taken off this list.`);
      } else {
        setRowErr((m) => ({ ...m, [c.id]: `Not dismissed: ${refused?.reason ?? "the server did not confirm it."}` }));
      }
    } catch (e) {
      const said = messageOf(e);
      setRowErr((m) => ({ ...m, [c.id]: `Not dismissed: ${said}` }));
      if (isForbidden(e)) onForbidden(said);
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[c.id]; return n; });
    }
  };

  return (
    <section className="card mb-3 [overflow-wrap:anywhere]" aria-label="Companies kept" data-testid="kept-companies">
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-sm" aria-expanded={isOpen} aria-controls="kept-companies-list" onClick={() => setOpen(!isOpen)}>
        <span className="font-medium text-ink-50">Companies kept</span>
        <span className="badge bg-black/[0.05] text-ink-300" data-testid="kept-count">{total.toLocaleString()}</span>
        <span className="order-last min-w-0 basis-full text-xs text-ink-400 sm:order-none sm:flex-1 sm:basis-0">Companies you approved. Find the right person at each, or dismiss the ones you are done with.</span>
        <span className="ml-auto text-ink-400 sm:ml-0" aria-hidden>{isOpen ? "▴" : "▾"}</span>
      </button>
      {isOpen && (
        <div id="kept-companies-list" className="border-t border-black/[0.06]">
          {findHint && <p className="px-4 pt-3 text-xs text-amber-700" data-testid="kept-find-hint">{findHint}</p>}
          {loadErr && <p className="px-4 pt-3 text-xs text-amber-700" role="alert">This list could not be refreshed ({loadErr}). <button type="button" className="underline" onClick={() => load()}>Try again</button></p>}
          <ul className="divide-y divide-slate-100">
            {rows.map((c) => {
              const name = candidateName(c);
              const domain = clean(c.companyDomain, 120);
              const evTitle = clean(c.evidenceTitle, 200);
              const host = hostOf(c.evidenceUrl);
              const found = typeof c.peopleFound === "number" ? c.peopleFound : 0;
              const when = ago(c.decidedAt);
              return (
                <li key={c.id} className="px-4 py-3 text-sm" data-testid="kept-company" data-id={c.id}>
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold text-ink-50">{name}</span>
                        {domain && domain.toLowerCase() !== name.toLowerCase() && <span className="text-xs text-ink-400">{domain}</span>}
                        <span className="text-xs text-ink-400">{clean(c.playName, 80)}{when ? ` · kept ${when}` : ""}</span>
                      </div>
                      <p className="mt-0.5 text-ink-200"><span className="font-medium">Relevant because:</span> {clean(c.relevantBecause, 400) || "No reason was recorded."}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-400">
                        <span className="font-semibold uppercase tracking-wide">Proof</span>
                        <ExtLink className="font-medium text-brand-600 hover:underline" href={c.evidenceUrl} fallback={<span className="text-ink-300">{evTitle || "From your own data - no public page"}</span>}>{evTitle || host || "Open the page"} ↗</ExtLink>
                        {host && evTitle && <span>{host}</span>}
                        <span data-testid="kept-people">· {found > 0 ? `${plural(found, "person", "people")} found` : "nobody found yet"}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button type="button" className="btn-secondary py-1" disabled={!!busy[c.id]} aria-expanded={titlesFor === c.id || undefined} onClick={() => find(c)}>{busy[c.id] === "find" ? "Finding people…" : found > 0 ? "Find more people" : "Find people"}</button>
                      <button type="button" className="text-ink-400 hover:text-ink-100 disabled:opacity-50" disabled={!!busy[c.id]} aria-label={`Dismiss ${name}`} onClick={() => dismiss(c)}>{busy[c.id] === "dismiss" ? "…" : "Dismiss"}</button>
                    </div>
                  </div>
                  {titlesFor === c.id && <FindTitlesForm id={`kept-${c.id}`} name={name} busy={!!busy[c.id]} onFind={(titles) => find(c, titles)} />}
                  {rowErr[c.id] && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-red-700" role="alert">{rowErr[c.id]}</div>}
                </li>
              );
            })}
          </ul>
          {rows.length < total && <div className="border-t border-black/[0.06] px-4 py-2"><button type="button" className="btn-secondary py-1 text-xs" disabled={more} onClick={() => load(rows.length)}>{more ? "Loading…" : `Show more (${(total - rows.length).toLocaleString()} more)`}</button></div>}
        </div>
      )}
    </section>
  );
}
