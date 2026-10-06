import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch, expectShape } from "../../lib/api";
import { Spinner, TagInput } from "../ui";
import { CompetitorsInput } from "./PlayForm";
import { plural } from "../../lib/plural";
import { clean, competitorsOf, isForbidden, isQuota, messageOf, playInputs, typeName, typeTone, type Competitor, type PlanPlay, type PlayOut, type PlayPlan, type PlayTypeInfo } from "../../lib/plays";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => clean(x, 100)) : []);

/**
 * The suggestion as it will be created, after the reviewer's edits.
 *
 * The competitor list and the job titles on screen are editable, and a suggestion that
 * depends on them is created with what is on screen, not with what the server first guessed.
 */
function withEdits(p: PlanPlay, competitors: Competitor[], titles: string[], planTitles: string[]): PlanPlay {
  const config: Record<string, unknown> = { ...(p.config ?? {}) };
  if ("competitors" in config) {
    const asObjects = Array.isArray(config.competitors) && config.competitors.some((c) => c && typeof c === "object");
    config.competitors = asObjects || p.type === "competitor_customers" ? competitors.map((c) => ({ name: c.name, ...(c.domain ? { domain: c.domain } : {}) })) : competitors.map((c) => c.name);
    // An optional list that was emptied is left out; a required one is caught by blockedByEdits.
    if (competitors.length === 0 && p.type !== "competitor_customers") delete config.competitors;
  }
  // Titles follow the edit only where the suggestion was using the plan's own titles.
  const own = p.targetTitles ?? [];
  const usesPlanTitles = own.length > 0 && own.length === planTitles.length && own.every((t, i) => t === planTitles[i]);
  return { ...p, config, targetTitles: usesPlanTitles ? titles : own };
}

/** Whether what is left after the edits is still enough to create the play. */
function blockedByEdits(p: PlanPlay): string | null {
  if (p.type === "competitor_customers" && competitorsOf(p.config.competitors).length === 0) return "Add at least one competitor above to use this play.";
  if (p.type === "public_asks" && competitorsOf(p.config.competitors).length === 0 && strings(p.config.problems).length === 0 && !(typeof p.config.category === "string" && p.config.category.trim())) return "Add a competitor above to use this play.";
  return null;
}

/**
 * "Start from your website".
 *
 * The first thing a new workspace sees on Plays, because a blank "New play" form asks a
 * question most people cannot answer yet. One input: Scout reads the site's public pages,
 * says back what it understood (what is sold, who buys it, who the competitors are - all
 * editable), and proposes plays with the reason for each. Nothing is saved until a play is
 * created, and nothing runs until Run is pressed.
 */
export function PlanFlow({
  types, defaultWebsite, runningIds, onCreated, onRun, onForbidden, onDone, onClose, onManual,
}: {
  types: PlayTypeInfo[] | null;
  defaultWebsite?: string;
  runningIds: Set<string>;
  /** A play was created: the page adds it to its list. */
  onCreated: (play: PlayOut) => void;
  /** Resolves true when the run started (or already finished), false when it could not start. */
  onRun: (play: PlayOut) => Promise<boolean>;
  onForbidden: (message: string) => void;
  /** Leave the flow for the list of plays. */
  onDone: () => void;
  /** Present when there is something to go back to (the workspace already has plays). */
  onClose?: () => void;
  /** Open the blank form instead. */
  onManual: () => void;
}) {
  const [website, setWebsite] = useState(defaultWebsite ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);
  const [plan, setPlan] = useState<PlayPlan | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [titles, setTitles] = useState<string[]>([]);
  const [created, setCreated] = useState<Record<number, PlayOut>>({});
  const [creating, setCreating] = useState<Record<number, boolean>>({});
  const [createErr, setCreateErr] = useState<Record<number, { message: string; quota: boolean }>>({});
  const [ran, setRan] = useState<Record<number, "starting" | "started">>({});
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const seq = useRef(0);

  // The workspace's own website, once it is known, unless something was already typed.
  useEffect(() => { if (!touched && defaultWebsite && !website) setWebsite(defaultWebsite); }, [defaultWebsite]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (plan) headingRef.current?.focus(); }, [plan]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const site = website.trim();
    if (!site || busy) return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<PlayPlan>("POST", "/v1/plays/plan", { website: site }, undefined, { timeoutMs: 120_000 });
      if (mine !== seq.current) return;
      const p = expectShape(r, (x) => Array.isArray(x.plays));
      const planTitles = strings(p.titles);
      setPlan({ ...p, product: p.product && typeof p.product === "object" ? p.product : { domain: site }, titles: planTitles, competitors: competitorsOf(p.competitors), notes: strings(p.notes).map((n) => clean(n, 400)), plays: p.plays.filter((x) => x && typeof x.type === "string") });
      setCompetitors(competitorsOf(p.competitors));
      setTitles(planTitles);
      setCreated({}); setCreating({}); setCreateErr({}); setRan({});
    } catch (err) {
      if (mine !== seq.current) return;
      const said = messageOf(err);
      setError({ message: said, quota: isQuota(err) });
      if (isForbidden(err)) onForbidden(said);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const suggestions = plan ? plan.plays.map((p) => withEdits(p, competitors, titles, plan.titles)) : [];
  const creatable = suggestions.map((p, i) => ({ p, i })).filter(({ p, i }) => p.available !== false && !created[i] && !blockedByEdits(p));

  const create = async (i: number): Promise<"ok" | "failed" | "quota"> => {
    const p = suggestions[i];
    if (!p || created[i] || creating[i]) return "ok";
    setCreating((m) => ({ ...m, [i]: true }));
    setCreateErr((m) => { const n = { ...m }; delete n[i]; return n; });
    try {
      const r = await apiFetch<{ play: PlayOut }>("POST", "/v1/plays", { name: clean(p.name, 120) || typeName(types, p.type), type: p.type, config: p.config, targetTitles: p.targetTitles.slice(0, 20) });
      const play = expectShape(r, (x) => typeof x.play?.id === "string").play;
      setCreated((m) => ({ ...m, [i]: play }));
      onCreated(play);
      return "ok";
    } catch (e) {
      const said = messageOf(e);
      setCreateErr((m) => ({ ...m, [i]: { message: said, quota: isQuota(e) } }));
      if (isForbidden(e)) onForbidden(said);
      return isQuota(e) || isForbidden(e) ? "quota" : "failed";
    } finally {
      setCreating((m) => { const n = { ...m }; delete n[i]; return n; });
    }
  };
  // One after another, and a plan limit (or a refusal) stops the rest: the play that hit it
  // shows the reason, and the ones after it are left for the reviewer to create or not.
  const createAll = async () => { for (const { i } of creatable) if ((await create(i)) === "quota") break; };
  const run = async (i: number, play: PlayOut) => {
    setRan((m) => ({ ...m, [i]: "starting" }));
    const started = await onRun(play);
    setRan((m) => { const n = { ...m }; if (started) n[i] = "started"; else delete n[i]; return n; });
  };

  const anyCreating = Object.keys(creating).length > 0;
  const createdCount = Object.keys(created).length;
  const product = plan?.product;
  const productName = clean(product?.name, 120) || clean(product?.domain, 120);
  const icp = (plan?.icp && typeof plan.icp === "object" ? plan.icp : {}) as Record<string, unknown>;
  const buyers = [...strings(icp.industries).slice(0, 4), ...strings(icp.companySizes).slice(0, 2), ...strings(icp.locations).slice(0, 2), ...strings(icp.countries).slice(0, 2)];

  return (
    <div data-testid="plan-flow">
      <div className="card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink-50">Start from your website</h2>
          {onClose && <button type="button" className="text-ink-500 hover:text-ink-100" aria-label="Close the suggestions" onClick={onClose}>✕</button>}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-ink-300">
          A play finds the people who need you this week from one source of buying intent - a competitor&apos;s published customers, a job posting, a funding round, a public request for a tool like yours. Tell Scout your website and it suggests the plays worth running. Nothing is saved until you create one.
        </p>
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={submit}>
          <div className="min-w-0 flex-1 basis-64">
            <label className="label" htmlFor="plan-website">Your website</label>
            <input id="plan-website" className="input" inputMode="url" autoComplete="url" maxLength={300} placeholder="yourcompany.com" value={website} onChange={(e) => { setWebsite(e.target.value); setTouched(true); }} />
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !website.trim()}>{busy ? "Reading your website…" : plan ? "Suggest again" : "Suggest plays"}</button>
          <button type="button" className="btn-secondary" onClick={onManual}>Build one myself</button>
        </form>
        {busy && <div className="mt-3"><Spinner label="Reading your public pages and working out who buys from you. This can take up to a minute." /></div>}
        {error && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${error.quota ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`} role="alert" data-testid="plan-error">
            No suggestions were made: {error.message} {error.quota && <Link className="font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
          </div>
        )}
      </div>

      {plan && (
        <div className="mt-4 space-y-4" data-testid="plan-result">
          <div className="card p-5 [overflow-wrap:anywhere]">
            <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-ink-50 outline-none">What Scout understood</h3>
            <p className="mt-0.5 text-xs text-ink-400">Correct anything that is off - the suggestions below follow your edits.</p>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <div className="label">What you sell</div>
                <div className="text-sm font-medium text-ink-50">{productName || clean(website, 120)}{product?.name && product?.domain ? <span className="ml-2 font-normal text-ink-400">{clean(product.domain, 120)}</span> : null}</div>
                <p className="mt-1 text-sm text-ink-300">{clean(product?.description, 500) || "Scout could not find a description on the site."}</p>
                {buyers.length > 0 && (
                  <>
                    <div className="label mt-3">Who buys it</div>
                    <div className="flex flex-wrap gap-1">{buyers.map((b, i) => <span key={`${b}-${i}`} className="badge bg-black/[0.05] text-ink-300">{b}</span>)}</div>
                  </>
                )}
              </div>
              <div>
                <label className="label" htmlFor="plan-titles">People to look for</label>
                <TagInput inputId="plan-titles" value={titles} onChange={setTitles} max={20} placeholder="Add a job title" />
                <label className="label mt-3" htmlFor="plan-competitor">Competitors</label>
                <CompetitorsInput idBase="plan-competitor" value={competitors} onChange={setCompetitors} max={10} />
                {competitors.length === 0 && <p className="mt-1 text-xs text-ink-400">None found. Add the ones you lose deals to - two of the plays below are built on them.</p>}
              </div>
            </div>
            {plan.notes.length > 0 && (
              <ul className="mt-4 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="plan-notes">
                {plan.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink-50">Suggested plays</h3>
            <div className="flex flex-wrap gap-2">
              {creatable.length > 1 && <button type="button" className="btn-primary" disabled={anyCreating} onClick={createAll}>{anyCreating ? "Creating…" : `Create all ${creatable.length} available`}</button>}
              {createdCount > 0 && <button type="button" className="btn-secondary" onClick={onDone}>See my {plural(createdCount, "play")}</button>}
            </div>
          </div>

          {suggestions.length === 0 ? (
            <div className="card p-6 text-sm text-ink-300">Scout could not suggest a play from this website. You can still build one yourself. <button type="button" className="text-brand-600 underline" onClick={onManual}>Build one myself</button></div>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {suggestions.map((p, i) => {
                const made = created[i];
                const unavailable = p.available === false;
                const blocked = !unavailable && !made ? blockedByEdits(p) : null;
                const failed = createErr[i];
                const inputs = playInputs(p.type, p.config);
                return (
                  <li key={`${p.type}-${i}`} className={`card flex flex-col p-4 [overflow-wrap:anywhere] ${unavailable ? "bg-black/[0.02]" : ""}`} data-testid="plan-play" data-type={p.type}>
                    <div><span className={`badge ${unavailable ? "bg-black/[0.05] text-ink-400" : typeTone(p.type)}`}>{typeName(types, p.type)}</span></div>
                    <div className={`mt-1 font-semibold ${unavailable ? "text-ink-400" : "text-ink-50"}`}>{clean(p.name, 120) || typeName(types, p.type)}</div>
                    {p.why && <p className="mt-1 text-sm text-ink-300"><span className="font-medium text-ink-200">Why:</span> {clean(p.why, 400)}</p>}
                    {inputs && <p className="mt-1 text-xs text-ink-400">{inputs}</p>}
                    {p.targetTitles.length > 0 && <p className="mt-1 text-xs text-ink-400">Looks for: {p.targetTitles.slice(0, 4).join(", ")}{p.targetTitles.length > 4 ? ` and ${p.targetTitles.length - 4} more` : ""}</p>}
                    {unavailable && <p className="mt-2 text-xs font-medium text-amber-700">Not available yet: {clean(p.unavailableReason, 300) || "this workspace is not set up for it."}</p>}
                    {blocked && <p className="mt-2 text-xs font-medium text-amber-700">{blocked}</p>}
                    {failed && (
                      <div className={`mt-2 rounded-lg px-3 py-2 text-sm ${failed.quota ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`} role="alert">
                        Not created: {failed.message} {failed.quota && <Link className="font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
                      </div>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                      {made ? (
                        <>
                          <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Created</span>
                          {made.type !== "engagers_upload" && (
                            runningIds.has(made.id)
                              ? <span className="text-sm text-ink-300" role="status">Run started - the people it finds will appear in Review.</span>
                              : ran[i] === "started"
                                ? <span className="text-sm text-ink-300" role="status">The run has finished. Its result is on the play, under Plays.</span>
                                : <button type="button" className="btn-primary py-1.5" disabled={ran[i] === "starting"} onClick={() => run(i, made)}>{ran[i] === "starting" ? "Starting…" : "Run now"}</button>
                          )}
                        </>
                      ) : !unavailable ? (
                        <button type="button" className="btn-secondary py-1.5" disabled={!!creating[i] || !!blocked} onClick={() => create(i)}>{creating[i] ? "Creating…" : "Create"}</button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {createdCount > 0 && <p className="text-xs text-ink-400">Created plays run when you press Run. To put one on a schedule, open it under Plays and choose how often.</p>}
        </div>
      )}
    </div>
  );
}
