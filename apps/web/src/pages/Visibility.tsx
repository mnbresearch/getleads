import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Empty, Modal, Page, Spinner, TagInput, useToast } from "../components/ui";

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
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, Toast } = useToast();

  const load = useCallback(() => {
    apiFetch<Overview>("GET", "/v1/visibility/overview").then(setD).catch((e) => toast((e as Error).message, "err"));
    apiFetch<{ prompts: Prompt[] }>("GET", "/v1/visibility/prompts").then((r) => setPrompts(r.prompts)).catch(() => setPrompts([]));
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
          <div className="text-xs text-ink-400">Last {d.windowDays} days · {d.metrics.runs} usable answers{d.excludedRuns > 0 ? ` · ${d.excludedRuns} excluded (refusals/errors)` : ""}</div>
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

      {d.byEngine.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="font-medium">By engine</div>
          <div className="mb-2 text-xs text-ink-400">
            Engines are trained and retrieved differently and often disagree, so act on these rows. The headline above blends them and describes no single engine.
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
          <table className="w-full text-sm">
            <thead className="border-b border-black/10"><tr><th className="th">Brand</th><th className="th">Appears in</th><th className="th">Avg position</th><th className="th">Wins without you</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {d.competitors.map((c) => (
                <tr key={c.name}>
                  <td className="td font-medium">{c.name}</td>
                  <td className="td tabular-nums">{pct(c.appearanceRate)}</td>
                  <td className="td tabular-nums">{c.avgPosition ?? "—"}</td>
                  <td className="td tabular-nums">{c.beatsYou}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.gaps.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="font-medium">Winnable gaps</div>
          <div className="mb-2 text-xs text-ink-400">Questions where a rival proves the answer slot exists and it is not yours. Ranked above questions nobody wins.</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {d.gaps.map((g) => (
              <div key={g.promptId} className="rounded-lg border border-black/10 p-3 text-sm">
                <div className="font-medium">{g.prompt}</div>
                <div className="mt-1 text-xs text-ink-400">You: {pct(g.mentionRate)} · {g.topRival ? `${g.topRival}: ${pct(g.rivalRate)}` : "no clear rival"} · {g.runs} answers</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card mt-4 p-4">
        <div className="mb-2 font-medium">Tracked questions</div>
        {prompts.length === 0 ? (
          <Empty title="No questions tracked yet" hint="Add the questions your buyers actually ask an AI before they buy, like 'best B2B lead generation tools for small teams'." action={<button className="btn-primary" onClick={() => setAddOpen(true)}>Track a question</button>} />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {prompts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{p.text}</div>
                  <div className="text-xs text-ink-400">{p.samplesPerRun} samples/day{p.topic ? ` · ${p.topic}` : ""}{p.lastRunAt ? ` · last ${new Date(p.lastRunAt).toLocaleDateString()}` : " · never run"}</div>
                </div>
                <button className="btn-secondary" disabled={busy === p.id} onClick={() => run(p)}>{busy === p.id ? "Sampling…" : "Sample now"}</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfigModal open={cfgOpen} onClose={() => setCfgOpen(false)} onSaved={() => { setCfgOpen(false); load(); }} toast={toast} />
      <AddPromptModal open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); load(); }} toast={toast} />
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
  useEffect(() => {
    if (!open) return;
    apiFetch<{ brand: { name: string; aliases?: string[]; domain?: string | null }; competitors: { name: string }[] }>("GET", "/v1/visibility/config")
      .then((c) => { setBrand({ name: c.brand.name, aliases: c.brand.aliases ?? [], domain: c.brand.domain ?? "" }); setRivals(c.competitors.map((x) => x.name)); })
      .catch(() => {});
  }, [open]);
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
        <button className="btn-primary w-full justify-center" disabled={busy || !brand.name} onClick={save}>{busy ? "Saving…" : "Save"}</button>
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
