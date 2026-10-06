import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, expectLists, expectShape, ProspexError } from "../lib/api";
import { useMe } from "../lib/me";
import { Empty, LoadError, Modal, Page, Spinner, useToast } from "../components/ui";
import { plural } from "../lib/plural";
import { clean, isForbidden, isMissingRoute, isQuota, messageOf, runFailed, runSentence, type PlayOut, type PlayRun, type PlayTypeInfo } from "../lib/plays";
import { PlanFlow } from "../components/plays/PlanFlow";
import { PlayCard, type RunProblem } from "../components/plays/PlayCard";
import { PlayForm } from "../components/plays/PlayForm";
import { ReviewQueue } from "../components/plays/ReviewQueue";
import { ResultsTab } from "../components/plays/ResultsTab";
import { UploadModal } from "../components/plays/UploadModal";

type Tab = "review" | "plays" | "results";
const TABS: { id: Tab; label: string }[] = [{ id: "review", label: "Review" }, { id: "plays", label: "Plays" }, { id: "results", label: "Results" }];
const SUBTITLE = "Find the people who need you this week - with the proof.";

/** How often a started run is checked, and for how long, before the page stops waiting. */
const POLL_MS = 15_000;
const POLL_FOR_MS = 5 * 60_000;

type Named = { id: string; name: string };

/**
 * Plays: saved recipes that find the people who need the product this week, each with a
 * one-sentence reason and the page that proves it; a person approves or skips; every play is
 * then judged by what happened afterwards.
 *
 * Three tabs - Review (what is waiting for a decision), Plays (the recipes), Results (the
 * scoreboard) - over one list of plays loaded here.
 */
export function PlaysPage() {
  const [params, setParams] = useSearchParams();
  const { toast, Toast } = useToast();
  const { me } = useMe();

  const [types, setTypes] = useState<PlayTypeInfo[] | null>(null);
  const [typesErr, setTypesErr] = useState<string | null>(null);
  // An API without these routes at all: the feature has not reached this server yet.
  const [typesMissing, setTypesMissing] = useState(false);
  const [playsMissing, setPlaysMissing] = useState(false);
  const missing = typesMissing || playsMissing;
  const [plays, setPlays] = useState<PlayOut[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [icps, setIcps] = useState<Named[]>([]);
  const [lists, setLists] = useState<Named[]>([]);
  const [campaigns, setCampaigns] = useState<Named[]>([]);
  const [pickErr, setPickErr] = useState<string | null>(null);

  const [homeTab, setHomeTab] = useState<Tab | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  // Decisions the server has confirmed since the plays were last loaded, so the count on the
  // Review tab follows the queue without a request per decision.
  const [decided, setDecided] = useState(0);
  const decidedRef = useRef(0);
  decidedRef.current = decided;
  const [epoch, setEpoch] = useState(0);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [problems, setProblems] = useState<Record<string, RunProblem>>({});
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [forbidden, setForbidden] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [justCreated, setJustCreated] = useState<PlayOut | null>(null);
  const [editing, setEditing] = useState<PlayOut | null>(null);
  const [uploadFor, setUploadFor] = useState<PlayOut | null>(null);

  const alive = useRef(true);
  const timers = useRef<Record<string, number>>({});
  const playsSeq = useRef(0);
  const firstLoad = useRef(true);
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      Object.values(timers.current).forEach((t) => clearTimeout(t));
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const loadTypes = useCallback(() => {
    setTypesErr(null);
    apiFetch<{ types: PlayTypeInfo[] }>("GET", "/v1/plays/types")
      .then((r) => {
        if (!alive.current) return;
        setTypes(expectLists(r, "types").types.filter((t) => t && typeof t.type === "string").map((t) => ({ ...t, name: clean(t.name, 80) || t.type, summary: clean(t.summary, 300), fields: Array.isArray(t.fields) ? t.fields.filter((f) => f && typeof f.key === "string" && !["__proto__", "constructor", "prototype"].includes(f.key)) : [] })));
        setTypesMissing(false);
      })
      .catch((e) => { if (!alive.current) return; if (isMissingRoute(e)) setTypesMissing(true); else setTypesErr(messageOf(e)); });
  }, []);

  const loadPlays = useCallback(() => {
    const mine = ++playsSeq.current;
    const counted = decidedRef.current;
    return apiFetch<{ plays: PlayOut[] }>("GET", "/v1/plays")
      .then((r) => {
        if (!alive.current || mine !== playsSeq.current) return;
        const list = expectLists(r, "plays").plays.filter((p) => p && typeof p.id === "string");
        setPlays(list);
        setListErr(null);
        setLoaded(true);
        setPlaysMissing(false);
        // This answer already includes every decision confirmed before it was asked for.
        setDecided((d) => d - counted);
        if (firstLoad.current) {
          firstLoad.current = false;
          setHomeTab(list.some((p) => (p.counts?.pending ?? 0) > 0) ? "review" : "plays");
          if (list.length === 0) setShowPlan(true);
        }
      })
      .catch((e) => { if (!alive.current || mine !== playsSeq.current) return; if (isMissingRoute(e)) setPlaysMissing(true); else setListErr(messageOf(e)); });
  }, []);

  const loadPickers = useCallback(() => {
    const fails: string[] = [];
    Promise.all([
      apiFetch<{ icps: Named[] }>("GET", "/v1/icps").then((r) => setIcps(expectLists(r, "icps").icps)).catch((e) => { fails.push(`ideal customers (${messageOf(e)})`); }),
      apiFetch<{ lists: Named[] }>("GET", "/v1/leads/lists/all").then((r) => setLists(expectLists(r, "lists").lists)).catch((e) => { fails.push(`lists (${messageOf(e)})`); }),
      apiFetch<{ campaigns: Named[] }>("GET", "/v1/campaigns").then((r) => setCampaigns(expectLists(r, "campaigns").campaigns)).catch((e) => { fails.push(`campaigns (${messageOf(e)})`); }),
    ]).then(() => { if (alive.current) setPickErr(fails.length ? `Couldn't load ${fails.join(", ")}.` : null); });
  }, []);

  const loadAll = useCallback(() => { loadTypes(); void loadPlays(); loadPickers(); }, [loadTypes, loadPlays, loadPickers]);
  useEffect(() => { loadAll(); }, [loadAll]);

  // With no plays left (the last one was deleted), the way back in is the website box.
  useEffect(() => { if (loaded && plays.length === 0) setShowPlan(true); }, [loaded, plays.length]);

  // ── Tabs and the review filters live in the URL, so a play's "Review 12" is a link ───────
  const tabParam = params.get("tab");
  const tab: Tab | null = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : homeTab;
  const playFilter = /^[0-9a-zA-Z-]{1,64}$/.test(params.get("play") ?? "") ? (params.get("play") as string) : "";
  const kindFilter = ["person", "company", "post"].includes(params.get("kind") ?? "") ? (params.get("kind") as string) : "";
  const go = useCallback((to: Tab, filter?: { playId?: string; kind?: string }) => {
    const p = new URLSearchParams();
    p.set("tab", to);
    if (to === "review") {
      if (filter?.playId) p.set("play", filter.playId);
      if (filter?.kind) p.set("kind", filter.kind);
    }
    setParams(p);
  }, [setParams]);

  const pending = Math.max(0, plays.reduce((n, p) => n + (p.counts?.pending ?? 0), 0) - decided);
  const onPendingChange = useCallback((n: number) => {
    setDecided((d) => d + n);
    // Reconcile with the server shortly after the reviewer pauses, not after every keystroke.
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => { void loadPlays(); }, 1500);
  }, [loadPlays]);

  const onForbidden = useCallback((message: string) => setForbidden(message), []);

  // ── Running a play ──────────────────────────────────────────────────────────────────────
  const stopWatching = useCallback((id: string) => {
    if (timers.current[id]) clearTimeout(timers.current[id]);
    delete timers.current[id];
    setRunning((s) => { const n = new Set(s); n.delete(id); return n; });
  }, []);

  const finished = useCallback((play: PlayOut, run: Pick<PlayRun, "status" | "found" | "added" | "duplicates" | "note" | "error">) => {
    stopWatching(play.id);
    toast(`${clean(play.name, 80)}: ${runSentence(run)}`, runFailed(run.status) ? "err" : "ok");
    void loadPlays();
    setEpoch((e) => e + 1);
  }, [loadPlays, stopWatching, toast]);

  /** Check on a started run every 15 seconds, for up to 5 minutes, and report how it ended. */
  const watch = useCallback((play: PlayOut, runId: string | null) => {
    const started = Date.now();
    let watched = runId;
    if (timers.current[play.id]) clearTimeout(timers.current[play.id]);
    setRunning((s) => new Set(s).add(play.id));
    const tick = async () => {
      if (!alive.current) return;
      let done: PlayRun | null = null;
      try {
        const r = await apiFetch<{ play: PlayOut; runs: PlayRun[] }>("GET", `/v1/plays/${encodeURIComponent(play.id)}`);
        const runs = Array.isArray(r.runs) ? r.runs : [];
        // With no run id (a schedule or a teammate started it), the run in progress is the
        // one to follow; if it already ended before this check, the newest run is it.
        if (!watched) watched = runs.find((x) => x.status === "running")?.id ?? null;
        const run = watched ? runs.find((x) => x.id === watched) : runs[0];
        if (run && run.status !== "running") done = run;
      } catch {
        // A blip between checks is not the run failing; the next check asks again.
      }
      if (!alive.current) return;
      if (done) { finished(play, done); return; }
      if (Date.now() - started >= POLL_FOR_MS) {
        stopWatching(play.id);
        toast(`${clean(play.name, 80)} is still running. Its result will be on the play when it finishes - check back in a few minutes.`);
        void loadPlays();
        return;
      }
      timers.current[play.id] = window.setTimeout(tick, POLL_MS);
    };
    timers.current[play.id] = window.setTimeout(tick, POLL_MS);
  }, [finished, loadPlays, stopWatching, toast]);

  const runNow = useCallback(async (play: PlayOut): Promise<boolean> => {
    setProblems((m) => { const n = { ...m }; delete n[play.id]; return n; });
    setRunning((s) => new Set(s).add(play.id));
    try {
      const r = await apiFetch<{ jobId?: string; runId?: string; run?: PlayRun }>("POST", `/v1/plays/${encodeURIComponent(play.id)}/run`);
      if (r?.run && typeof r.run.status === "string" && r.run.status !== "running") {
        finished(play, r.run);
      } else {
        toast(`Run started for "${clean(play.name, 80)}". This usually takes a minute or two - the people it finds will appear in Review.`);
        watch(play, r?.runId ?? r?.run?.id ?? null);
      }
      return true;
    } catch (e) {
      const said = messageOf(e);
      if (e instanceof ProspexError && e.status === 409) {
        // Already running (a schedule, or a teammate): not a failure, so wait for that run.
        toast(said);
        watch(play, null);
        return true;
      }
      stopWatching(play.id);
      setProblems((m) => ({ ...m, [play.id]: { message: said, quota: isQuota(e) } }));
      if (isForbidden(e)) setForbidden(said);
      toast(`"${clean(play.name, 80)}" did not start: ${said}`, "err");
      return false;
    }
  }, [finished, stopWatching, toast, watch]);

  const toggle = async (play: PlayOut) => {
    setToggling((s) => new Set(s).add(play.id));
    try {
      const r = await apiFetch<{ play: PlayOut }>("PATCH", `/v1/plays/${encodeURIComponent(play.id)}`, { status: play.status === "paused" ? "active" : "paused" });
      const next = expectShape(r, (x) => typeof x.play?.id === "string").play;
      setPlays((list) => list.map((p) => (p.id === next.id ? next : p)));
      toast(next.status === "paused" ? "Paused - it will not run on its schedule until you resume it" : "Resumed");
    } catch (e) {
      const said = messageOf(e);
      if (isForbidden(e)) setForbidden(said);
      toast(said, "err");
    } finally {
      setToggling((s) => { const n = new Set(s); n.delete(play.id); return n; });
    }
  };

  const remove = async (play: PlayOut) => {
    try {
      await apiFetch("DELETE", `/v1/plays/${encodeURIComponent(play.id)}`);
    } catch (e) {
      if (isForbidden(e)) setForbidden(messageOf(e));
      throw e;
    }
    stopWatching(play.id);
    setPlays((list) => list.filter((p) => p.id !== play.id));
    toast(`Deleted "${clean(play.name, 80)}". Leads you approved from it are still in Leads.`);
    void loadPlays();
    setEpoch((e) => e + 1);
  };

  const onCreated = useCallback((play: PlayOut) => {
    setPlays((list) => (list.some((p) => p.id === play.id) ? list : [play, ...list]));
    void loadPlays();
  }, [loadPlays]);

  const closeForm = () => { setFormOpen(false); setJustCreated(null); };
  const campaignNames = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns]);
  const pickers = { icps, lists, campaigns, error: pickErr, retry: loadPickers };
  const anyDialog = formOpen || !!editing || !!uploadFor;
  const website = clean(me?.org?.settings?.website ?? me?.org?.settings?.domain ?? "", 200);

  if (missing) {
    return (
      <Page title="Plays" subtitle={SUBTITLE}>
        <div className="card flex flex-col items-center gap-3 p-12 text-center" role="status" data-testid="plays-setup">
          <div className="text-base font-medium text-ink-50">Plays is being set up</div>
          <p className="max-w-md text-sm text-ink-400">This workspace does not have Plays switched on yet - the update has not reached it. Nothing is wrong with your account or your data, and everything else works as usual.</p>
          <button type="button" className="btn-secondary" onClick={() => { setTypesMissing(false); setPlaysMissing(false); loadAll(); }}>Check again</button>
        </div>
      </Page>
    );
  }

  const actions = loaded ? (
    <>
      {!showPlan && <button type="button" className="btn-secondary" onClick={() => { setShowPlan(true); go("plays"); }}>Suggest plays from my website</button>}
      <button type="button" className={showPlan && plays.length === 0 ? "btn-secondary" : "btn-primary"} onClick={() => setFormOpen(true)}>New play</button>
    </>
  ) : undefined;

  return (
    <Page title="Plays" subtitle={SUBTITLE} actions={actions}>
      {Toast}
      {forbidden && (
        <div className="mb-3 flex flex-wrap items-start gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert" data-testid="plays-forbidden">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">You can look at plays here but that change was not allowed: {forbidden}</span>
          <button type="button" className="shrink-0 underline" onClick={() => setForbidden(null)}>Dismiss</button>
        </div>
      )}
      {!loaded ? (
        listErr ? <LoadError message={listErr} onRetry={loadAll} /> : <Spinner label="Loading your plays…" />
      ) : (
        <>
          <nav className="-mx-4 mb-4 flex gap-2 overflow-x-auto whitespace-nowrap border-b border-black/10 px-4 sm:mx-0 sm:px-0" aria-label="Plays sections">
            {TABS.map((t) => (
              <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} data-testid={`tab-${t.id}`} className={`flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm ${tab === t.id ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400 hover:text-ink-100"}`} onClick={() => go(t.id)}>
                {t.label}
                {t.id === "review" && pending > 0 && <span className="badge bg-brand-600 text-white" data-testid="pending-count" aria-label={`${plural(pending, "person", "people")} waiting`}>{pending.toLocaleString()}</span>}
                {t.id === "plays" && plays.length > 0 && <span className="text-xs text-ink-400">({plays.length})</span>}
              </button>
            ))}
          </nav>
          {listErr && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">Your plays could not be refreshed ({listErr}). What you see was loaded earlier. <button type="button" className="underline" onClick={loadAll}>Try again</button></div>}

          {tab === "review" && (plays.length === 0 ? (
            <Empty title="Nothing to review yet" hint="A play finds people who need you and puts them here, each with one sentence saying why and a link to the proof. You approve or skip. Start by telling Scout your website." action={<button type="button" className="btn-primary" onClick={() => { setShowPlan(true); go("plays"); }}>Start from your website</button>} />
          ) : (
            <ReviewQueue plays={plays} types={types} playId={playFilter} kind={kindFilter} onFilter={(next) => go("review", { playId: next.playId ?? playFilter, kind: next.kind ?? kindFilter })} epoch={epoch} shortcuts={!anyDialog} toast={toast} onPendingChange={onPendingChange} onForbidden={onForbidden} onGoToPlays={() => go("plays")} />
          ))}

          {tab === "plays" && (
            <>
              {showPlan && (
                <PlanFlow
                  types={types}
                  defaultWebsite={website}
                  runningIds={running}
                  onCreated={onCreated}
                  onRun={runNow}
                  onForbidden={onForbidden}
                  onDone={() => setShowPlan(false)}
                  onClose={plays.length > 0 ? () => setShowPlan(false) : undefined}
                  onManual={() => setFormOpen(true)}
                />
              )}
              {plays.length > 0 && (
                <>
                  {showPlan && <h2 className="mb-3 mt-8 text-base font-semibold text-ink-50">Your plays</h2>}
                  <ul className="grid gap-3 md:grid-cols-2" data-testid="play-list">
                    {plays.map((p) => (
                      <PlayCard
                        key={p.id}
                        play={p}
                        types={types}
                        campaignName={p.campaignId ? campaignNames.get(p.campaignId) : undefined}
                        running={running.has(p.id)}
                        problem={problems[p.id]}
                        toggling={toggling.has(p.id)}
                        onRun={() => { void runNow(p); }}
                        onUpload={() => setUploadFor(p)}
                        onEdit={() => setEditing(p)}
                        onToggle={() => { void toggle(p); }}
                        onDelete={() => remove(p)}
                        onReview={() => go("review", { playId: p.id })}
                        onError={(m) => toast(m, "err")}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {tab === "results" && <ResultsTab types={types} epoch={epoch} onGoToPlays={() => go("plays")} />}
        </>
      )}

      <Modal open={formOpen} onClose={closeForm} title={justCreated ? "Your play is ready" : "New play"} wide>
        {justCreated ? (
          <div data-testid="play-created" className="[overflow-wrap:anywhere]">
            <p className="text-sm text-ink-200">&quot;{clean(justCreated.name, 120)}&quot; has been created.</p>
            <p className="mt-1 text-sm text-ink-400">
              {justCreated.type === "engagers_upload"
                ? "It is fed by you: upload the people who engaged and they will land in Review with what they did as the reason."
                : "Run it now to fill your review queue. A run counts as one search on your plan, and nobody is contacted until you approve them."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {justCreated.type === "engagers_upload"
                ? <button type="button" className="btn-primary" onClick={() => { const p = justCreated; closeForm(); setUploadFor(p); }}>Upload people</button>
                : <button type="button" className="btn-primary" onClick={() => { const p = justCreated; closeForm(); go("plays"); void runNow(p); }}>Run now</button>}
              <button type="button" className="btn-secondary" onClick={() => { closeForm(); go("plays"); }}>Not now</button>
            </div>
          </div>
        ) : (
          formOpen && <PlayForm types={types} typesError={typesErr} onRetryTypes={loadTypes} pickers={pickers} toast={toast} onForbidden={onForbidden} onSaved={(play) => { onCreated(play); setShowPlan(false); setJustCreated(play); }} />
        )}
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit play" wide>
        {editing && <PlayForm key={editing.id} initial={editing} types={types} typesError={typesErr} onRetryTypes={loadTypes} pickers={pickers} toast={toast} onForbidden={onForbidden} onSaved={(play) => { setPlays((list) => list.map((p) => (p.id === play.id ? play : p))); setEditing(null); void loadPlays(); }} />}
      </Modal>
      <UploadModal play={uploadFor} onClose={() => setUploadFor(null)} onDone={() => { void loadPlays(); setEpoch((e) => e + 1); }} onReview={(p) => { setUploadFor(null); go("review", { playId: p.id }); }} onForbidden={onForbidden} />
    </Page>
  );
}
