import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, expectLists, fmtDate } from "../../lib/api";
import { EmailStatusBadge, Empty, LoadError, ScoreBar, Spinner } from "../ui";
import { ExtLink } from "../ExtLink";
import { plural } from "../../lib/plural";
import {
  ago, candidateName, clean, DECIDE_MAX, decisionSummary, hostOf, isForbidden, isQuota, lookup, messageOf, normalizeDecide, REVIEW_PAGE, SKIP_REASONS, typeName, typeTone,
  type Candidate, type DecideResult, type PlayOut, type PlayTypeInfo,
} from "../../lib/plays";

type Decision = { id: string; decision: "approve" | "skip"; skipReason?: string };
/** When this few are left on screen and the server holds more, the next ones are fetched. */
const TOP_UP_AT = 10;
type Notice = { message: string; detail?: string; quota?: boolean; tone: "amber" | "red" };

const KIND_LABEL: Record<string, string> = { person: "Person", company: "Company", post: "Conversation" };

/** A field where a letter key is text, not a shortcut. Checkboxes and buttons are not. */
function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  const type = ((t as HTMLInputElement).type || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "range", "file", "color"].includes(type);
}

/**
 * The review queue: what the plays found, waiting for a person to say yes or no.
 *
 * Two rules shape everything here.
 *
 * Nothing is shown as decided until the server has said so. A card leaves the list only
 * after the answer arrives and accounts for it; when a request fails, or the answer says a
 * decision was not applied, the card stays exactly where it was with the reason on it.
 * When the answer cannot be matched to individual cards (the server stopped part-way), the
 * queue is read again from the server rather than guessed at.
 *
 * And it is quick: A approves, S skips, J and K move, with focus following the queue so a
 * reviewer never has to reach for the pointer.
 */
export function ReviewQueue({
  plays, types, playId, kind, onFilter, epoch, shortcuts, toast, onPendingChange, onForbidden, onGoToPlays,
}: {
  plays: PlayOut[];
  types: PlayTypeInfo[] | null;
  playId: string;
  kind: string;
  onFilter: (next: { playId?: string; kind?: string }) => void;
  /** Bumped by the page when something outside the queue changed it (a run finished, an upload). */
  epoch: number;
  /** False while a dialog is open, so a letter typed there is never a decision here. */
  shortcuts: boolean;
  toast: (m: string, k?: "ok" | "err") => void;
  /** The number waiting changed by this much (negative when people were added). */
  onPendingChange: (decided: number) => void;
  onForbidden: (message: string) => void;
  onGoToPlays: () => void;
}) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, "approve" | "skip" | "find">>({});
  const [cardErr, setCardErr] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [enroll, setEnroll] = useState(false);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [titlesFor, setTitlesFor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const key = `${playId}|${kind}`;
  const seq = useRef(0);
  const shownFor = useRef<string | null>(null);
  const rowsRef = useRef<Candidate[]>([]);
  rowsRef.current = rows;
  const totalRef = useRef(0);
  totalRef.current = total;
  // Ids the server has confirmed as decided. A slower, older read of the queue must not put
  // one of them back on screen.
  const gone = useRef<Set<string>>(new Set());
  const cardEls = useRef<Record<string, HTMLElement | null>>({});
  const emptyEl = useRef<HTMLDivElement | null>(null);
  const wantFocus = useRef<string | "empty" | null>(null);
  // Set when the list is about to be re-read because of something the reviewer just did:
  // focus must land on a card again, not fall back to the top of the document.
  const refocus = useRef(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  // Decisions already on their way to the server, so one card is never sent twice.
  const inflight = useRef<Set<string>>(new Set());

  const playsById = useMemo(() => new Map(plays.map((p) => [p.id, p])), [plays]);
  const hasCampaign = useCallback((c: Candidate) => !!playsById.get(c.playId)?.campaignId, [playsById]);

  const load = useCallback((mode: "replace" | "more" = "replace", from?: number) => {
    const mine = ++seq.current;
    const offset = mode === "more" ? from ?? rowsRef.current.length : 0;
    if (mode === "more") setLoadingMore(true);
    else if (shownFor.current !== key) setLoading(true);
    const qs = new URLSearchParams({ status: "pending", limit: String(REVIEW_PAGE), offset: String(offset) });
    if (playId) qs.set("playId", playId);
    if (kind) qs.set("kind", kind);
    apiFetch<{ candidates: Candidate[]; total: number }>("GET", `/v1/plays/candidates?${qs.toString()}`)
      .then((r) => {
        if (mine !== seq.current) return;
        const got = expectLists(r, "candidates").candidates.filter((c) => c && typeof c.id === "string" && (c.status === undefined || c.status === "pending"));
        const fresh = got.filter((c) => !gone.current.has(c.id));
        const hidden = got.length - fresh.length;
        const next = mode === "more" ? [...rowsRef.current, ...fresh.filter((c) => !rowsRef.current.some((x) => x.id === c.id))] : fresh;
        setRows(next);
        setTotal(Math.max(next.length, (typeof r.total === "number" ? r.total : next.length) - hidden));
        shownFor.current = key;
        setErr(null);
        if (mode === "replace") setStale(false);
        const ids = new Set(next.map((c) => c.id));
        setSel((s) => new Set([...s].filter((id) => ids.has(id))));
        setCardErr((m) => Object.fromEntries(Object.entries(m).filter(([id]) => ids.has(id))));
        const nextActive = activeRef.current && ids.has(activeRef.current) ? activeRef.current : next[0]?.id ?? null;
        setActiveId(nextActive);
        if (refocus.current) { refocus.current = false; wantFocus.current = nextActive ?? "empty"; }
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        // Rows belong to the filter they were loaded for: a failed load of a different
        // filter must not leave the previous filter's people on screen as its answer.
        if (shownFor.current !== key) { setRows([]); setTotal(0); setSel(new Set()); shownFor.current = null; }
        refocus.current = false;
        setErr(messageOf(e));
      })
      .finally(() => { if (mine === seq.current) { setLoading(false); setLoadingMore(false); } });
  }, [key, playId, kind]);

  useEffect(() => { load(); }, [load]);
  // Something outside the queue added to it (a run finished). An empty queue is simply
  // re-read. A queue someone is working through is NOT rearranged under them - the card a
  // keystroke is about to decide must not change - so it offers the refresh instead.
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === seenEpoch.current) return;
    seenEpoch.current = epoch;
    if (rowsRef.current.length === 0) load();
    else setStale(true);
  }, [epoch, load]);
  // A different filter is a different list: nothing stays selected across it.
  useEffect(() => { setSel(new Set()); setReasonFor(null); setTitlesFor(null); setNotice(null); }, [key]);

  // Focus follows the queue: after a card leaves, the next one (or the empty state) takes it.
  useEffect(() => {
    const want = wantFocus.current;
    if (!want) return;
    wantFocus.current = null;
    const el = want === "empty" ? emptyEl.current : cardEls.current[want];
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); }
  });

  const decide = useCallback(async (all: Decision[], bulk: boolean) => {
    const items = all.filter((i) => !inflight.current.has(i.id));
    if (items.length === 0) return;
    const ids = items.map((i) => i.id);
    for (const id of ids) inflight.current.add(id);
    const verb = (id: string) => (items.find((i) => i.id === id)?.decision === "approve" ? "approve" : "skip") as "approve" | "skip";
    setBusy((b) => ({ ...b, ...Object.fromEntries(ids.map((id) => [id, verb(id)])) }));
    setCardErr((m) => Object.fromEntries(Object.entries(m).filter(([id]) => !ids.includes(id))));
    setNotice(null);
    setReasonFor(null);

    // Enrolment is only asked for when it was offered: at least one of these candidates
    // belongs to a play with a campaign. A tick left over from another filter sends nothing.
    const wantEnroll = enroll && items.some((i) => i.decision === "approve" && rowsRef.current.some((c) => c.id === i.id && hasCampaign(c)));
    const sum: DecideResult = { approved: 0, skipped: 0, leadsCreated: 0, leadsExisting: 0, tasksCreated: 0, enrolled: 0, queuedForEmail: 0, notApplied: [] };
    const answered: Decision[] = [];
    // The ids the server says it applied - or null as soon as one answer does not say.
    let named: string[] | null = [];
    let failure: unknown = null;
    for (let i = 0; i < items.length; i += DECIDE_MAX) {
      const chunk = items.slice(i, i + DECIDE_MAX);
      try {
        const r = normalizeDecide(await apiFetch("POST", "/v1/plays/candidates/decide", { decisions: chunk, ...(wantEnroll ? { enroll: true } : {}) }));
        sum.approved += r.approved; sum.skipped += r.skipped; sum.leadsCreated += r.leadsCreated; sum.leadsExisting += r.leadsExisting;
        sum.tasksCreated += r.tasksCreated; sum.enrolled += r.enrolled; sum.queuedForEmail += r.queuedForEmail;
        sum.notApplied.push(...r.notApplied);
        if (named && r.applied) named.push(...r.applied);
        else named = null;
        answered.push(...chunk);
        if (r.stopped) { sum.stopped = r.stopped; break; }
      } catch (e) {
        failure = e;
        break;
      }
    }
    for (const id of ids) inflight.current.delete(id);
    setBusy((b) => Object.fromEntries(Object.entries(b).filter(([id]) => !ids.includes(id))));

    const refused = new Map(sum.notApplied.map((x) => [x.id, x.reason]));
    const changed = sum.approved + sum.skipped;
    const sent = new Set(answered.map((a) => a.id));
    // Which cards leave: the ones the server names as applied. A server that only counts is
    // read the careful way - what it refused plus what it counted must add up to what was
    // sent - and when that does not hold (it stopped part-way), which cards were applied is
    // not something this page may guess: the queue is read again instead.
    const byName = named !== null && answered.length > 0;
    const inferred = !sum.stopped && changed + refused.size === answered.length && [...refused.keys()].every((id) => sent.has(id));
    const exact = byName || inferred;
    const applied = byName ? (named ?? []).filter((id) => sent.has(id)) : inferred ? answered.filter((a) => !refused.has(a.id)).map((a) => a.id) : [];

    const notChanged = (why: string) => `Still waiting - this was not changed: ${why}`;
    const errs: Record<string, string> = {};
    // When the server stopped part-way it lists everything it did not reach, all with the
    // same sentence; the notice says that once. A reason only one or two cards carry is
    // theirs, and is shown on them.
    const shared = new Map<string, number>();
    for (const reason of refused.values()) shared.set(reason, (shared.get(reason) ?? 0) + 1);
    for (const [id, reason] of refused) if (!sum.stopped || (shared.get(reason) ?? 0) <= 2) errs[id] = notChanged(reason);
    if (failure) {
      const said = messageOf(failure);
      const unanswered = items.filter((i) => !answered.includes(i));
      if (!bulk) for (const u of unanswered) errs[u.id] = notChanged(said);
      if (isForbidden(failure)) onForbidden(said);
      if (bulk || isQuota(failure)) {
        setNotice({ tone: isQuota(failure) ? "amber" : "red", quota: isQuota(failure), message: bulk ? `${plural(unanswered.length, "decision")} ${unanswered.length === 1 ? "was" : "were"} not applied: ${said}` : said, detail: bulk ? "They are still waiting below." : undefined });
      }
      if (bulk) toast(`${changed > 0 ? `${decisionSummary(sum)} ` : ""}The rest did not go through: ${said}`, "err");
    }
    if (Object.keys(errs).length) setCardErr((m) => ({ ...m, ...errs }));
    if (sum.stopped) setNotice({ tone: "amber", quota: sum.stopped.reason === "quota", message: sum.stopped.message });

    if (applied.length) {
      for (const id of applied) gone.current.add(id);
      const before = rowsRef.current;
      const left = before.filter((c) => !gone.current.has(c.id));
      // Whoever sat where the first decided card was is next; at the end of the list, the last one.
      const firstIdx = before.findIndex((c) => applied.includes(c.id));
      const nextCard = left[Math.min(Math.max(firstIdx, 0), left.length - 1)];
      setRows(left);
      setTotal((t) => Math.max(left.length, t - applied.length));
      setSel((s) => new Set([...s].filter((id) => !gone.current.has(id))));
      setActiveId(nextCard?.id ?? null);
      wantFocus.current = nextCard ? nextCard.id : "empty";
      const remaining = Math.max(left.length, totalRef.current - applied.length);
      // The page is empty but the server may hold more: fetch them and focus the first.
      if (left.length === 0) { refocus.current = true; load(); }
      // Running low with more waiting: bring the next ones in underneath, so a reviewer
      // working down a long queue never reaches the bottom of a page.
      else if (exact && left.length <= TOP_UP_AT && remaining > left.length) load("more", left.length);
    }
    if (changed > 0) onPendingChange(changed);
    if (!failure || !bulk) {
      if (changed > 0) toast(decisionSummary({ ...sum, notApplied: sum.notApplied.filter((x) => errs[x.id]) }), "ok");
      else if (refused.size > 0 && !sum.stopped) toast(decisionSummary(sum), "err");
      else if (sum.stopped) toast("Nothing was changed.", "err");
    }
    // Not every card could be matched to the answer: read the truth back.
    if (!exact && (changed > 0 || sum.stopped)) { refocus.current = true; load(); }
  }, [enroll, hasCampaign, load, onForbidden, onPendingChange, toast]);

  const findPeople = useCallback(async (c: Candidate, titles?: string[]) => {
    setTitlesFor(null);
    setBusy((b) => ({ ...b, [c.id]: "find" }));
    setCardErr((m) => { const n = { ...m }; delete n[c.id]; return n; });
    try {
      const r = await apiFetch<{ added: number; candidates: Candidate[]; note?: string }>("POST", `/v1/plays/candidates/${encodeURIComponent(c.id)}/find-people`, titles?.length ? { titles } : {});
      const added = typeof r.added === "number" && r.added > 0 ? r.added : 0;
      const people = (Array.isArray(r.candidates) ? r.candidates : []).filter((p) => p && typeof p.id === "string" && (p.status === undefined || p.status === "pending") && !gone.current.has(p.id));
      const fits = people.filter((p) => !kind || p.kind === kind);
      const before = rowsRef.current;
      const fresh = fits.filter((p) => !before.some((x) => x.id === p.id));
      if (fresh.length) {
        const at = before.findIndex((x) => x.id === c.id);
        const next = [...before.slice(0, at + 1), ...fresh, ...before.slice(at + 1)];
        setRows(next);
        setTotal((t) => t + fresh.length);
      }
      if (added > 0) onPendingChange(-added);
      const company = candidateName(c);
      const note = clean(r.note, 300);
      if (added > 0) toast(`Found ${plural(added, "person", "people")} at ${company}. ${fresh.length ? "They are next in the queue, with the same reason and proof." : "They are waiting in the queue under People."}${note ? ` ${note}` : ""}`);
      else toast(note || `Nobody was found at ${company} this time.`, note ? "ok" : "err");
    } catch (e) {
      const said = messageOf(e);
      setCardErr((m) => ({ ...m, [c.id]: `Nobody was looked up: ${said}` }));
      if (isForbidden(e)) onForbidden(said);
      if (isQuota(e)) setNotice({ tone: "amber", quota: true, message: said });
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[c.id]; return n; });
    }
  }, [kind, onForbidden, onPendingChange, toast]);

  // The cards are memoised: with a couple of hundred on screen, moving the highlight or
  // deciding one must redraw that card, not all of them. So what a card calls never changes
  // identity - it reaches the current functions through this ref.
  const now = useRef({ decide, findPeople, playsById });
  now.current = { decide, findPeople, playsById };
  const handlers = useMemo<CardHandlers>(() => ({
    register: (id, el) => { if (el) cardEls.current[id] = el; else delete cardEls.current[id]; },
    active: (id) => setActiveId(id),
    select: (id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }),
    approve: (id) => { void now.current.decide([{ id, decision: "approve" }], false); },
    skip: (id, why) => { void now.current.decide([{ id, decision: "skip", ...(why ? { skipReason: why } : {}) }], false); },
    toggleReason: (id) => setReasonFor((r) => (r === id ? null : id)),
    findPeople: (c, titles) => {
      // The search needs job titles. A play that has none asks for them here, once.
      if (!titles && !(now.current.playsById.get(c.playId)?.targetTitles ?? []).length) setTitlesFor((t) => (t === c.id ? null : c.id));
      else void now.current.findPeople(c, titles);
    },
  }), []);

  // ── Keyboard: A approve, S skip, J / K move ─────────────────────────────────────────────
  const live = useRef({ rows, activeId, busy, decide });
  live.current = { rows, activeId, busy, decide };
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : "";
      if (k !== "a" && k !== "s" && k !== "j" && k !== "k") return;
      const { rows: list, activeId: active, busy: working, decide: go } = live.current;
      if (list.length === 0) return;
      const at = Math.max(0, list.findIndex((c) => c.id === active));
      e.preventDefault();
      if (k === "j" || k === "k") {
        const to = list[Math.min(list.length - 1, Math.max(0, at + (k === "j" ? 1 : -1)))];
        setActiveId(to.id);
        wantFocus.current = to.id;
        return;
      }
      // Holding a key down must not approve its way through the queue.
      if (e.repeat) return;
      const c = list[at];
      if (working[c.id]) return;
      setActiveId(c.id);
      void go([{ id: c.id, decision: k === "a" ? "approve" : "skip" }], false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  const selected = rows.filter((c) => sel.has(c.id));
  const anyBusy = Object.keys(busy).length > 0;
  const allOnPage = rows.length > 0 && rows.every((c) => sel.has(c.id));
  const enrollOffered = (selected.length ? selected : rows).some(hasCampaign);
  const enrollBox = (
    <label className="flex items-center gap-2 text-sm text-ink-200">
      <input type="checkbox" checked={enroll} onChange={(e) => setEnroll(e.target.checked)} />
      Also add approved people to the play&apos;s campaign
    </label>
  );
  const filtered = !!(playId || kind);

  return (
    <div data-testid="review-queue">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <select className="input w-full sm:w-60" aria-label="Filter by play" value={playId} onChange={(e) => onFilter({ playId: e.target.value })}>
          <option value="">All plays</option>
          {plays.map((p) => <option key={p.id} value={p.id}>{clean(p.name, 80)}</option>)}
        </select>
        <select className="input w-full sm:w-44" aria-label="Filter by kind" value={kind} onChange={(e) => onFilter({ kind: e.target.value })}>
          <option value="">All kinds</option>
          <option value="person">People</option>
          <option value="company">Companies</option>
          <option value="post">Conversations</option>
        </select>
        {rows.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={allOnPage} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((c) => c.id)) : new Set())} />
            Select all on this page
          </label>
        )}
        {rows.length > 0 && selected.length === 0 && enrollOffered && enrollBox}
        {rows.length > 0 && (
          <span className="ml-auto hidden text-xs text-ink-400 md:inline">
            Keys: <Kbd>A</Kbd> approve · <Kbd>S</Kbd> skip · <Kbd>J</Kbd> <Kbd>K</Kbd> move
          </span>
        )}
      </div>

      {notice && (
        <div className={`mb-3 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-sm ${notice.tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`} role="alert" data-testid="review-notice">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.message}{notice.detail ? ` ${notice.detail}` : ""}</span>
          {notice.quota && <Link className="shrink-0 font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
          <button type="button" className="shrink-0 underline" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {stale && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-brand-50 px-3 py-2 text-sm text-ink-200" role="status" data-testid="review-stale">
          <span className="min-w-0 flex-1">A play has just finished running and may have found more people.</span>
          <button type="button" className="shrink-0 font-medium text-brand-600 underline" onClick={() => { refocus.current = true; load(); }}>Refresh the queue</button>
        </div>
      )}

      {selected.length > 0 && !loading && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm shadow-card ring-1 ring-brand-100" data-testid="bulk-bar">
          <span className="font-medium text-brand-600">{selected.length} selected</span>
          <button type="button" className="btn-primary py-1.5" disabled={anyBusy} onClick={() => decide(selected.map((c) => ({ id: c.id, decision: "approve" as const })), true)}>Approve {selected.length}</button>
          <button type="button" className="btn-secondary py-1.5" disabled={anyBusy} onClick={() => decide(selected.map((c) => ({ id: c.id, decision: "skip" as const })), true)}>Skip {selected.length}</button>
          <select
            className="input w-48 py-1.5"
            aria-label="Skip the selected with a reason"
            disabled={anyBusy}
            value=""
            onChange={(e) => { const why = e.target.value; if (why) void decide(selected.map((c) => ({ id: c.id, decision: "skip" as const, skipReason: why })), true); }}
          >
            <option value="">Skip with a reason…</option>
            {SKIP_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            <option value="Other">Other</option>
          </select>
          {enrollOffered && enrollBox}
          <button type="button" className="ml-auto text-ink-400 hover:text-ink-100" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading the review queue…" />
      ) : err && rows.length === 0 ? (
        <LoadError message={err} onRetry={() => load()} />
      ) : rows.length === 0 ? (
        <div ref={emptyEl} tabIndex={-1} className="rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300" data-testid="review-empty">
          {filtered ? (
            <Empty title="Nobody waiting matches these filters" hint="Other plays or kinds may still have people waiting." action={<button type="button" className="btn-secondary" onClick={() => onFilter({ playId: "", kind: "" })}>Show everyone waiting</button>} />
          ) : (
            <Empty title="You are all caught up" hint="Nobody is waiting for review. Run a play to look for more people, or wait for its next scheduled run - new people land here with their reason and proof." action={<button type="button" className="btn-primary" onClick={onGoToPlays}>Go to your plays</button>} />
          )}
        </div>
      ) : (
        <>
          {err && (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
              The queue could not be refreshed ({err}). What you see was loaded earlier. <button type="button" className="underline" onClick={() => load()}>Try again</button>
            </div>
          )}
          <ul className="space-y-3" aria-label="People waiting for review">
            {rows.map((c) => (
              <CandidateCard
                key={c.id}
                c={c}
                types={types}
                active={c.id === activeId}
                selected={sel.has(c.id)}
                busy={busy[c.id]}
                error={cardErr[c.id]}
                reasonOpen={reasonFor === c.id}
                willEnroll={enroll && hasCampaign(c)}
                titlesOpen={titlesFor === c.id}
                h={handlers}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-400">
            <span data-testid="review-count">Showing {rows.length.toLocaleString()} of {total.toLocaleString()} waiting</span>
            {rows.length < total && <button type="button" className="btn-secondary py-1.5" disabled={loadingMore} onClick={() => load("more")}>{loadingMore ? "Loading…" : "Show more"}</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-black/10 bg-surface px-1 py-px font-sans text-[11px] font-medium text-ink-200">{children}</kbd>;
}

interface CardHandlers {
  register: (id: string, el: HTMLElement | null) => void;
  active: (id: string) => void;
  select: (id: string, on: boolean) => void;
  approve: (id: string) => void;
  skip: (id: string, why?: string) => void;
  toggleReason: (id: string) => void;
  findPeople: (c: Candidate, titles?: string[]) => void;
}

const CandidateCard = memo(function CandidateCard({
  c, types, active, selected, busy, error, reasonOpen, titlesOpen, willEnroll, h,
}: {
  c: Candidate;
  types: PlayTypeInfo[] | null;
  active: boolean;
  selected: boolean;
  busy?: "approve" | "skip" | "find";
  error?: string;
  reasonOpen: boolean;
  titlesOpen: boolean;
  willEnroll: boolean;
  h: CardHandlers;
}) {
  const innerRef = useCallback((el: HTMLElement | null) => h.register(c.id, el), [h, c.id]);
  const onActive = () => h.active(c.id);
  const onSelect = (on: boolean) => h.select(c.id, on);
  const onApprove = () => h.approve(c.id);
  const onSkip = (why?: string) => h.skip(c.id, why);
  const onToggleReason = () => h.toggleReason(c.id);
  const onFindPeople = (titles?: string[]) => h.findPeople(c, titles);
  const [other, setOther] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const wanted = titleDraft.split(",").map((t) => t.trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  useEffect(() => { if (!reasonOpen) setOther(null); }, [reasonOpen]);
  const name = candidateName(c);
  const title = clean(c.title, 160);
  const company = clean(c.companyName, 160);
  const domain = clean(c.companyDomain, 120);
  const evTitle = clean(c.evidenceTitle, 200);
  const quote = clean(c.evidenceQuote, 500);
  const host = hostOf(c.evidenceUrl);
  const when = ago(c.signalAt);
  const found = ago(c.createdAt);
  const subtitle = c.kind === "person"
    ? [title, company].filter(Boolean).join(title && company ? " at " : "")
    : c.kind === "company"
      ? (domain && domain.toLowerCase() !== name.toLowerCase() ? domain : "")
      : evTitle;
  const consequence = c.kind === "post"
    ? "Approving creates a task to answer it. No lead is created."
    : c.kind === "company"
      ? "Approving saves the company. Find people to get someone to contact."
      : c.alreadyLead
        ? "Approving adds this reason to the lead you already have."
        : willEnroll ? "Approving makes them a lead and adds them to the campaign." : "";
  const reasonsId = `skip-reasons-${c.id}`;
  return (
    <li>
      <article
        ref={innerRef}
        tabIndex={-1}
        aria-label={`${name}${subtitle ? `, ${subtitle}` : ""}`}
        aria-current={active ? "true" : undefined}
        data-testid="candidate"
        data-id={c.id}
        data-kind={c.kind}
        onFocus={onActive}
        onMouseDown={onActive}
        className={`card p-4 outline-none transition [overflow-wrap:anywhere] ${active ? "ring-2 ring-brand-300" : ""} ${busy ? "opacity-70" : ""}`}
      >
        <div className="flex items-start gap-3">
          <input type="checkbox" className="mt-1.5 shrink-0" aria-label={`Select ${name}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="min-w-0 text-base font-semibold text-ink-50">{name}</h3>
              <span className="badge bg-black/[0.05] text-ink-300">{lookup(KIND_LABEL, c.kind) ?? "Person"}</span>
              {c.alreadyLead && <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Already a lead</span>}
              {typeof c.confidence === "number" && c.confidence < 0.5 && <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-200" title="The match is less certain than usual. Open the proof before approving.">Check the proof</span>}
            </div>
            {subtitle && <div className="mt-0.5 text-sm text-ink-300">{subtitle}</div>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
              <span className={`badge ${typeTone(c.playType)}`}>{typeName(types, c.playType)}</span>
              <span className="min-w-0">{clean(c.playName, 120)}</span>
            </div>

            <div className="mt-3 rounded-lg border border-black/[0.06] bg-cream/70 p-3">
              <p className="text-[15px] leading-snug text-ink-50"><span className="font-semibold">Relevant because:</span> {clean(c.relevantBecause, 400) || "No reason was recorded."}</p>
              {quote && <blockquote className="mt-2 border-l-2 border-brand-200 pl-3 text-sm italic text-ink-300">&ldquo;{quote}&rdquo;</blockquote>}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400">
                <span className="font-semibold uppercase tracking-wide">Proof</span>
                <ExtLink className="font-medium text-brand-600 hover:underline" href={c.evidenceUrl} fallback={<span className="text-ink-300">{evTitle || "No page recorded"}</span>}>
                  {evTitle || host || "Open the page"} ↗
                </ExtLink>
                {host && evTitle && <span>{host}</span>}
                {!c.evidenceUrl && <span>From your own data - there is no public page to open.</span>}
                {(when || found) && <span title={fmtDate(c.signalAt ?? c.createdAt)}>· {when || `found ${found}`}</span>}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400">
              {c.score !== null && c.score !== undefined && (
                <span className="flex items-center gap-2" title={c.scoreReasons?.length ? c.scoreReasons.map((r) => clean(r, 160)).join(" · ") : undefined}>
                  <span>Fit</span><ScoreBar score={c.score} />
                </span>
              )}
              <ExtLink className="text-brand-600 hover:underline" href={c.linkedinUrl}>LinkedIn ↗</ExtLink>
              {c.email && <span className="flex min-w-0 flex-wrap items-center gap-1.5"><span className="text-ink-200">{clean(c.email, 200)}</span>{c.emailStatus && <EmailStatusBadge status={c.emailStatus} />}</span>}
              {c.location && <span>{clean(c.location, 120)}</span>}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary py-1.5" disabled={!!busy} aria-keyshortcuts="A" onClick={onApprove}>{busy === "approve" ? "Approving…" : "Approve"}</button>
              <span className="inline-flex">
                <button type="button" className="btn-secondary rounded-r-none py-1.5" disabled={!!busy} aria-keyshortcuts="S" onClick={() => onSkip()}>{busy === "skip" ? "Skipping…" : "Skip"}</button>
                <button type="button" className="btn-secondary -ml-px rounded-l-none px-2 py-1.5" disabled={!!busy} aria-expanded={reasonOpen} aria-controls={reasonsId} aria-label={`Skip ${name} with a reason`} onClick={onToggleReason}>▾</button>
              </span>
              {c.kind === "company" && <button type="button" className="btn-secondary py-1.5" disabled={!!busy} aria-expanded={titlesOpen || undefined} onClick={() => onFindPeople()}>{busy === "find" ? "Finding people…" : "Find people"}</button>}
              {consequence && <span className="text-xs text-ink-400">{consequence}</span>}
            </div>

            {reasonOpen && (
              <div id={reasonsId} role="group" aria-label={`Why skip ${name}?`} className="mt-2 flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onToggleReason(); } }}>
                {SKIP_REASONS.map((r) => <button key={r} type="button" className="rounded-full border border-black/10 bg-surface px-3 py-1 text-xs font-medium text-ink-200 hover:bg-black/[0.05]" disabled={!!busy} onClick={() => onSkip(r)}>{r}</button>)}
                {other === null ? (
                  <button type="button" className="rounded-full border border-black/10 bg-surface px-3 py-1 text-xs font-medium text-ink-200 hover:bg-black/[0.05]" disabled={!!busy} onClick={() => setOther("")}>Other</button>
                ) : (
                  <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); onSkip(other.trim() || "Other"); }}>
                    <input className="input min-w-0 flex-1 py-1 text-xs" autoFocus maxLength={200} aria-label="Your reason for skipping" placeholder="Your reason" value={other} onChange={(e) => setOther(e.target.value)} />
                    <button type="submit" className="btn-secondary py-1 text-xs" disabled={!!busy}>Skip</button>
                  </form>
                )}
              </div>
            )}

            {titlesOpen && (
              <form className="mt-2 flex flex-wrap items-end gap-2" data-testid="find-titles" onSubmit={(e) => { e.preventDefault(); if (wanted.length) onFindPeople(wanted); }}>
                <div className="min-w-0 flex-1 basis-56">
                  <label className="label" htmlFor={`find-titles-${c.id}`}>Which job titles to look for at {name}</label>
                  <input id={`find-titles-${c.id}`} className="input py-1.5" autoFocus maxLength={600} placeholder="VP Operations, Head of Customer Success" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
                </div>
                <button type="submit" className="btn-secondary py-1.5" disabled={!!busy || wanted.length === 0}>Find</button>
                <p className="basis-full text-xs text-ink-400">This play has no job titles saved. Separate several with commas - or add them to the play under Edit so you are not asked again.</p>
              </form>
            )}

            {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert" data-testid="candidate-error">{error}</div>}
          </div>
        </div>
      </article>
    </li>
  );
});
