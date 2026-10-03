import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { DeleteButton, Empty, LoadError, Modal, Page, Spinner, TagInput, useToast } from "../components/ui";
import { plural } from "../lib/plural";

interface Rate { value: number; ci: { lower: number; upper: number }; n: number; positives: number }
interface Prompt { id: string; text: string; topic: string | null; samplesPerRun: number; active: boolean; lastRunAt: string | null }
interface Overview {
  brand: { name: string; aliases?: string[]; domain?: string | null };
  windowDays: number;
  metrics: { runs: number; mentionRate: Rate; citationRate: Rate; avgPosition: number | null; topSpotRate: Rate; shareOfVoice: Rate; sufficient: boolean; minRuns: number; summary: string };
  competitors: { name: string; appearances: number; appearanceRate: number; avgPosition: number | null; beatsYou: number }[];
  change: { significant: boolean; direction: "up" | "down" | "flat"; deltaPoints: number; summary: string };
  byEngine: { engine: string; metrics: Overview["metrics"] }[];
  engineDisagreement: { disagree: boolean; best: { engine: string }; worst: { engine: string }; summary: string } | null;
  engineHealth: { engine: string; total: number; usable: number; errored: number; refused: number; healthy: boolean; problem: string | null }[];
  gaps: { promptId: string; prompt: string; runs: number; mentionRate: number; topRival: string | null; rivalRate: number }[];
  excludedRuns: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function VisibilityPage() {
  const [d, setD] = useState<Overview | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [engines, setEngines] = useState<{ engine: string; model: string }[]>([]);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, Toast } = useToast();

  const [loadErr, setLoadErr] = useState<string | null>(null);
  // A failed prompts fetch used to render "No questions tracked yet" over a live set.
  const [promptsErr, setPromptsErr] = useState<string | null>(null);

  const [answersFor, setAnswersFor] = useState<Prompt | null>(null);

  const patch = async (p: Prompt, body: Record<string, unknown>) => {
    try {
      await apiFetch("PATCH", `/v1/visibility/prompts/${p.id}`, body);
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const remove = async (p: Prompt) => {
    await apiFetch("DELETE", `/v1/visibility/prompts/${p.id}`);
    toast("Stopped tracking that question");
    load();
  };

  const load = useCallback(() => {
    setLoadErr(null);
    // The catch used to only raise a toast - but the early return below unmounted the page
    // before {Toast} ever rendered, so a failure showed a spinner that span forever with no
    // message at all. The error now has somewhere to live that the user can actually see.
    apiFetch<Overview>("GET", "/v1/visibility/overview").then(setD).catch((e) => setLoadErr((e as Error).message));
    apiFetch<{ prompts: Prompt[] }>("GET", "/v1/visibility/prompts").then((r) => { setPrompts(r.prompts); setPromptsErr(null); }).catch((e) => setPromptsErr((e as Error).message));
    apiFetch<{ engines: typeof engines }>("GET", "/v1/visibility/engines").then((r) => setEngines(r.engines ?? [])).catch(() => setEngines([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const run = async (p: Prompt) => {
    setBusy(p.id);
    try {
      const r = await apiFetch<{ engines: string[]; samplesPerEngine: number; total: number; usable: number; mentioned: number; note?: string }>("POST", `/v1/visibility/prompts/${p.id}/run`, {});
      toast(r.note ?? `Sampled ${r.engines.join(", ")} ${r.samplesPerEngine}x each; mentioned in ${r.mentioned} of ${r.total}`);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); }
  };

  if (loadErr) {
    return (
      <Page title="AI visibility">
        <LoadError message={loadErr} onRetry={load} />
      </Page>
    );
  }
  if (!d) return <Page title="AI visibility"><Spinner label="Loading…" /></Page>;

  return (
    <Page
      title="AI visibility"
      subtitle={engines.length ? `Sampling ${engines.map((e) => e.engine).join(", ")}. What a buyer researching your category is told, measured by repeated sampling rather than single answers.` : "What AI engines tell a buyer who researches your category, measured by repeated sampling rather than single answers."}
      actions={<><button className="btn-secondary" onClick={() => setCfgOpen(true)}>Brand & rivals</button><button className="btn-primary" onClick={() => setAddOpen(true)}>Track a question</button></>}
    >
      {Toast}

      {/* Headline. Deliberately leads with the honest summary, not a vanity number. */}
      <div className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-medium">{d.brand.name}</div>
          <div className="text-xs text-ink-400">Last {plural(d.windowDays, "day")} · {plural(d.metrics.runs, "usable answer")}{d.excludedRuns > 0 ? ` · ${d.excludedRuns} excluded (refusals/errors)` : ""}</div>
        </div>
        <p className="mt-2 text-sm text-ink-300">{d.metrics.summary}</p>
        {d.metrics.sufficient && (
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Mention rate" rate={d.metrics.mentionRate} />
            <Metric label="Cited directly" rate={d.metrics.citationRate} />
            <Metric label="Named first" rate={d.metrics.topSpotRate} />
            <div className="rounded-lg border border-black/10 p-3">
              <div className="text-xs uppercase text-ink-400">Avg position</div>
              <div className="text-xl font-semibold">{d.metrics.avgPosition ?? "—"}</div>
              <div className="text-xs text-ink-400">when present, lower is better</div>
            </div>
          </div>
        )}
        <div className={`mt-3 rounded-lg p-2 text-xs ${d.change.significant ? (d.change.direction === "up" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700") : "bg-black/[0.05] text-ink-300"}`}>
          {d.change.summary}
        </div>
      </div>

      {(d.engineHealth ?? []).filter((e) => e.problem).map((e) => (
        <div key={e.engine} className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-medium">{e.engine} is contributing no data</div>
          <div className="mt-1 text-xs">{e.problem}</div>
          <div className="mt-1 text-xs">This is a configuration problem, not a visibility problem. Its answers are excluded from the rates above rather than counted against you.</div>
        </div>
      ))}

      {d.byEngine.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="font-medium">By engine</div>
          <div className="mb-2 text-xs text-ink-400">
            Engines are trained and retrieved differently and often disagree, so act on these rows. The headline above blends them and describes no single engine.
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.byEngine.map((e) => (
              <div key={e.engine} className="rounded-lg border border-black/10 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{e.engine}</span>
                  <span className="text-xs text-ink-400">n={e.metrics.runs}</span>
                </div>
                {e.metrics.sufficient ? (
                  <>
                    <div className="text-xl font-semibold">{pct(e.metrics.mentionRate.value)}</div>
                    <div className="text-xs text-ink-400">
                      {pct(e.metrics.mentionRate.ci.lower)}–{pct(e.metrics.mentionRate.ci.upper)}
                      {e.metrics.avgPosition ? ` · avg position ${e.metrics.avgPosition}` : ""}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-xs text-ink-400">Not enough samples yet ({e.metrics.runs} of {e.metrics.minRuns}).</div>
                )}
              </div>
            ))}
          </div>
          {d.engineDisagreement && (
            <div className={`mt-3 rounded-lg p-2 text-xs ${d.engineDisagreement.disagree ? "bg-amber-50 text-amber-800" : "bg-black/[0.05] text-ink-300"}`}>
              {d.engineDisagreement.summary}
            </div>
          )}
        </div>
      )}

      {d.competitors.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="font-medium">Who owns these answers</div>
          <div className="mb-2 text-xs text-ink-400">"Wins without you" counts answers where they appear and you do not. That is the gap worth closing.</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-black/10"><tr><th className="th">Brand</th><th className="th">Appears in</th><th className="th">Avg position</th><th className="th">Wins without you</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {d.competitors.map((c) => (
                <tr key={c.name}>
                  <td className="td max-w-[14rem] font-medium [overflow-wrap:anywhere]">{c.name}</td>
                  <td className="td tabular-nums">{pct(c.appearanceRate)}</td>
                  <td className="td tabular-nums">{c.avgPosition ?? "—"}</td>
                  <td className="td tabular-nums">{c.beatsYou}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {d.gaps.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="font-medium">Winnable gaps</div>
          <div className="mb-2 text-xs text-ink-400">Questions where a rival proves the answer slot exists and it is not yours. Ranked above questions nobody wins.</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {d.gaps.map((g) => (
              <div key={g.promptId} className="min-w-0 rounded-lg border border-black/10 p-3 text-sm [overflow-wrap:anywhere]">
                <div className="font-medium">{g.prompt}</div>
                <div className="mt-1 text-xs text-ink-400">You: {pct(g.mentionRate)} · {g.topRival ? `${g.topRival}: ${pct(g.rivalRate)}` : "no clear rival"} · {g.runs} answers</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card mt-4 p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">Tracked questions</div>
          {prompts.length > 0 && (
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setSuggestOpen(true)}>Suggest more</button>
              <button className="btn-secondary" onClick={() => setAddOpen(true)}>Add one</button>
            </div>
          )}
        </div>
        {promptsErr && prompts.length === 0 ? (
          <LoadError message={promptsErr} onRetry={load} />
        ) : prompts.length === 0 ? (
          <Empty
            title="No questions tracked yet"
            hint="Scout can write the set for you from your brand, your rivals and your ICP, so you are not guessing in a keyword tool."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button className="btn-primary" onClick={() => setSuggestOpen(true)}>Suggest questions</button>
                <button className="btn-secondary" onClick={() => setAddOpen(true)}>Add one myself</button>
              </div>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {prompts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0 max-w-full">
                  <div className="truncate font-medium" title={p.text}>
                    {p.text}
                    {p.active === false && <span className="badge ml-2 bg-black/[0.05] text-ink-300">paused</span>}
                  </div>
                  <div className="text-xs text-ink-400">{plural(p.samplesPerRun, "sample")}/day{p.topic ? ` · ${p.topic}` : ""}{p.lastRunAt ? ` · last ${new Date(p.lastRunAt).toLocaleDateString()}` : " · never run"}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* "Suggest more" installs up to ten of these in one click, so every one of
                      them needs a way back out. Pausing keeps the history a resumed question
                      is measured against; deleting does not. */}
                  <select
                    className="input w-auto py-1 text-xs"
                    value={p.samplesPerRun}
                    aria-label={`Samples per day for "${p.text}"`}
                    onChange={(e) => patch(p, { samplesPerRun: Number(e.target.value) })}
                  >
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}/day</option>)}
                  </select>
                  <button className="btn-secondary py-1 text-xs" onClick={() => patch(p, { active: p.active === false })}>
                    {p.active === false ? "Resume" : "Pause"}
                  </button>
                  <button className="btn-secondary py-1 text-xs" onClick={() => setAnswersFor(p)}>Answers</button>
                  <button className="btn-secondary" disabled={busy === p.id} onClick={() => run(p)}>{busy === p.id ? "Sampling…" : "Sample now"}</button>
                  <DeleteButton
                    what={`the tracked question "${p.text.slice(0, 60)}${p.text.length > 60 ? "…" : ""}"`}
                    consequence="Every answer recorded for it is deleted too, and it disappears from your visibility history. Pause it instead if you want to stop sampling but keep the history."
                    onDelete={() => remove(p)}
                    onError={(m) => toast(m, "err")}
                    label="Remove"
                    className="text-xs"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfigModal open={cfgOpen} onClose={() => setCfgOpen(false)} onSaved={() => { setCfgOpen(false); load(); }} toast={toast} />
      <AddPromptModal open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); load(); }} toast={toast} />
      <SuggestModal open={suggestOpen} onClose={() => setSuggestOpen(false)} onSaved={() => { setSuggestOpen(false); load(); }} toast={toast} />
      <AnswersModal prompt={answersFor} onClose={() => setAnswersFor(null)} />
    </Page>
  );
}

/** A rate is never shown without its interval and sample size. */
function Metric({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="rounded-lg border border-black/10 p-3">
      <div className="text-xs uppercase text-ink-400">{label}</div>
      <div className="text-xl font-semibold">{pct(rate.value)}</div>
      <div className="text-xs text-ink-400">{pct(rate.ci.lower)}–{pct(rate.ci.upper)} · n={rate.n}</div>
    </div>
  );
}

function ConfigModal({ open, onClose, onSaved, toast }: { open: boolean; onClose: () => void; onSaved: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [brand, setBrand] = useState({ name: "", aliases: [] as string[], domain: "" });
  const [rivals, setRivals] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Saving a form that never loaded would overwrite the real brand and rival list with
  // blanks, so a failed load blocks Save and says why.
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [cfgTry, setCfgTry] = useState(0);
  useEffect(() => {
    if (!open) return;
    setCfgErr(null);
    apiFetch<{ brand: { name: string; aliases?: string[]; domain?: string | null }; competitors: { name: string }[] }>("GET", "/v1/visibility/config")
      .then((c) => { setBrand({ name: c.brand.name, aliases: c.brand.aliases ?? [], domain: c.brand.domain ?? "" }); setRivals(c.competitors.map((x) => x.name)); })
      .catch((e) => setCfgErr((e as Error).message));
  }, [open, cfgTry]);
  const save = async () => {
    setBusy(true);
    try {
      await apiFetch("PUT", "/v1/visibility/config", {
        brand: { name: brand.name, aliases: brand.aliases, domain: brand.domain || null },
        competitors: rivals.map((n) => ({ name: n, aliases: [], domain: null })),
      });
      toast("Saved");
      onSaved();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Brand and rivals">
      <div className="space-y-3">
        <div><label className="label">Your brand name</label><input className="input" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} placeholder="Scout" /></div>
        <div><label className="label">Other spellings that count as you</label><TagInput value={brand.aliases} onChange={(v) => setBrand({ ...brand, aliases: v })} placeholder="Scout by MNB" /></div>
        <div><label className="label">Your domain (to detect citations)</label><input className="input" value={brand.domain} onChange={(e) => setBrand({ ...brand, domain: e.target.value })} placeholder="scout.mnbresearch.com" /></div>
        <div><label className="label">Competitors to track</label><TagInput value={rivals} onChange={setRivals} placeholder="Apollo" /></div>
        <p className="text-xs text-ink-400">Rivals you do not list are still detected once they appear in answers, so an unknown competitor cannot hide.</p>
        {cfgErr && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-700" role="alert">Your current settings could not be loaded ({cfgErr}). <button className="underline" onClick={() => setCfgTry((n) => n + 1)}>Try again</button></div>}
        <button className="btn-primary w-full justify-center" disabled={busy || !brand.name || !!cfgErr} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

function AddPromptModal({ open, onClose, onSaved, toast }: { open: boolean; onClose: () => void; onSaved: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [text, setText] = useState("");
  const [samples, setSamples] = useState(3);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await apiFetch("POST", "/v1/visibility/prompts", { text, samplesPerRun: samples }); toast("Tracking"); setText(""); onSaved(); }
    catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Track a question">
      <div className="space-y-3">
        <div>
          <label className="label">The question a buyer would ask an AI</label>
          <textarea className="input h-20" value={text} onChange={(e) => setText(e.target.value)} placeholder="best B2B lead generation tools for a small sales team" />
          <p className="mt-1 text-xs text-ink-400">Write it the way a buyer would, and do not name yourself. Naming your brand in the question biases the answer and measures the prompt instead of your visibility.</p>
        </div>
        <div>
          <label className="label">Samples per day: {samples}</label>
          <input type="range" min={1} max={10} value={samples} onChange={(e) => setSamples(Number(e.target.value))} className="w-full" />
          <p className="mt-1 text-xs text-ink-400">Per engine, per day. Every configured engine is sampled this many times, so the per-engine denominators stay balanced. Below about 20 answers for an engine, no rate is reported for it.</p>
        </div>
        <button className="btn-primary w-full justify-center" disabled={busy || text.trim().length < 5} onClick={save}>{busy ? "Saving…" : "Track"}</button>
      </div>
    </Modal>
  );
}

interface Suggestion { text: string; topic: string; intent: string; rationale: string }

/**
 * Suggested questions.
 *
 * Shows where each set came from, because "the AI wrote these" is a claim that has to
 * stay true: a generation that failed and fell back to the deterministic pack says so
 * instead of passing the pack off as AI output. Nothing is installed without review.
 */
function SuggestModal({ open, onClose, onSaved, toast }: { open: boolean; onClose: () => void; onSaved: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [source, setSource] = useState<"ai" | "starter">("starter");
  const [note, setNote] = useState<string | undefined>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const fetchSet = async (ai: boolean) => {
    setBusy(true);
    try {
      const r = await apiFetch<{ source: "ai" | "starter"; prompts: Suggestion[]; note?: string }>("POST", "/v1/visibility/prompts/suggest", { ai });
      setItems(r.prompts);
      setSource(r.source);
      setNote(r.note);
      setPicked(Object.fromEntries(r.prompts.map((p) => [p.text, true])));
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  useEffect(() => { if (open && items === null) void fetchSet(false); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (items ?? []).filter((i) => picked[i.text]);

  const install = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<{ created: unknown[]; skipped: number }>("POST", "/v1/visibility/prompts/bulk", {
        prompts: chosen.map((c) => ({ text: c.text, topic: c.topic })),
      });
      toast(`Tracking ${plural(r.created.length, "new question")}${r.skipped ? `, ${r.skipped} already tracked` : ""}`);
      setItems(null);
      onSaved();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Questions worth tracking">
      <p className="text-sm text-ink-400">
        The questions your buyers ask never name you. Tracking your own name measures nothing, so these are category,
        comparison and problem questions where you may be missing today.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary" disabled={busy} onClick={() => void fetchSet(false)}>Starter set</button>
        <button className="btn-primary" disabled={busy} onClick={() => void fetchSet(true)}>Write them with AI</button>
        <span className="text-xs text-ink-400">
          {source === "ai" ? "Written by AI from your brand, rivals and ICP" : "Deterministic set, no AI call"}
        </span>
      </div>
      {note && <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{note}</div>}

      {busy && items === null ? (
        <div className="py-8"><Spinner /></div>
      ) : (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {(items ?? []).map((i) => (
            <li key={i.text} className="flex gap-2 rounded-lg border border-black/10 p-3">
              <input type="checkbox" className="mt-1" checked={!!picked[i.text]} onChange={(e) => setPicked({ ...picked, [i.text]: e.target.checked })} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{i.text}</div>
                <div className="mt-0.5 text-xs text-ink-400">{i.intent}{i.rationale ? ` · ${i.rationale}` : ""}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || chosen.length === 0} onClick={install}>
          {busy ? "Saving…" : `Track ${chosen.length} question${chosen.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </Modal>
  );
}

interface Run {
  id: string;
  engine: string;
  model: string | null;
  answer: string;
  /** Present at all - named in prose, linked, or both. */
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  brands: string[];
  usable: boolean;
  error: string | null;
  createdAt: string;
  /** Whether the engine wrote the brand's name, as opposed to only linking to it. */
  analysis?: { brand?: { named?: boolean } | null };
}

/**
 * The raw answers behind the numbers.
 *
 * Every answer has always been stored, and the landing page says so - "keeps every raw
 * answer verbatim, so any number traces back to the text it came from" - but there was no
 * screen anywhere in the product that would show you one. A traceability claim you cannot
 * act on is not traceability, it is a sentence. This is the screen.
 *
 * Refusals and errors are shown too, marked as excluded, because the honest version of
 * "you were mentioned in 40% of answers" includes which answers were left out of the
 * denominator and why.
 */
function AnswersModal({ prompt, onClose }: { prompt: Prompt | null; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setState("loading");
    setErr(null);
    apiFetch<{ runs: Run[] }>("GET", `/v1/visibility/runs?promptId=${prompt.id}&limit=50`)
      .then((r) => { setRuns(r.runs); setState("idle"); })
      .catch((e) => { setErr((e as Error).message); setState("error"); });
  }, [prompt]);

  const usable = runs.filter((r) => r.usable);
  const excluded = runs.length - usable.length;

  return (
    <Modal open={!!prompt} onClose={onClose} title="What the engines actually said" wide>
      {prompt && (
        <div className="space-y-3">
          <div className="text-sm text-ink-300">{prompt.text}</div>
          {state === "loading" && <Spinner label="Loading answers…" />}
          {state === "error" && <LoadError message={err ?? undefined} />}
          {state === "idle" && runs.length === 0 && (
            <Empty title="No answers recorded yet" hint="Use “Sample now” on this question, or wait for the next scheduled run." />
          )}
          {state === "idle" && runs.length > 0 && (
            <>
              <div className="text-xs text-ink-400">
                {usable.length} answer{usable.length === 1 ? "" : "s"} counted towards this question&apos;s numbers
                {excluded > 0 && `, ${excluded} excluded as refusals or errors rather than counted as absence`}.
              </div>
              <div className="max-h-[60vh] space-y-3 overflow-auto pr-1">
                {runs.map((r) => (
                  <div key={r.id} className={`rounded-lg border p-3 ${r.usable ? "border-black/10" : "border-amber-300 bg-amber-50"}`}>
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                      <span className="badge bg-black/[0.05] text-ink-200">{r.engine}{r.model ? ` · ${r.model}` : ""}</span>
                      <span>{new Date(r.createdAt).toLocaleString()}</span>
                      {r.usable ? (
                        <>
                          {/* "named" means the engine wrote the name in its answer. A brand
                              that only appears as a source link is present, but calling
                              that "named" is the overstatement the analyzer exists to
                              avoid, so it gets its own, weaker label. */}
                          {r.analysis?.brand?.named && <span className="badge bg-emerald-50 text-emerald-700">named{r.position ? ` · #${r.position}` : ""}</span>}
                          {r.cited && <span className="badge bg-brand-50 text-brand-700">{r.analysis?.brand?.named ? "linked" : "linked only, not named"}</span>}
                          {!r.mentioned && !r.cited && <span className="badge bg-black/[0.05] text-ink-300">absent</span>}
                        </>
                      ) : (
                        <span className="badge bg-amber-100 text-amber-800">excluded — {r.error ? r.error.slice(0, 80) : "refusal or empty answer"}</span>
                      )}
                    </div>
                    {r.brands.length > 0 && (
                      <div className="mb-2 flex flex-wrap items-baseline gap-1 text-xs">
                        <span className="text-ink-400">Order named:</span>
                        {r.brands.map((b, i) => <span key={`${b}-${i}`} className="badge bg-black/[0.05] text-ink-200">{i + 1}. {b}</span>)}
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap break-words text-xs text-ink-300">{r.answer || "(empty answer)"}</pre>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
