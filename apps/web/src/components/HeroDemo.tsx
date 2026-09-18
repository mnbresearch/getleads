import { useEffect, useMemo, useState } from "react";

/**
 * Animated hero demo: a buyer's question types itself, the work happens step by step,
 * and the answer arrives.
 *
 * It alternates between the two halves of the product on purpose - outbound discovery and
 * AI visibility - because the pitch is that both live in one place. Nothing here is a real
 * screenshot or real data; it is an illustration of the flow.
 */

type LeadRow = { name: string; sub: string; score: number; tag: string; tagTone: "green" | "amber" | "brand" };
type EngineRow = { engine: string; verdict: string; rate: string; detail: string; tone: "good" | "warn" | "flat" };

type Scene =
  | { kind: "leads"; chip: string; query: string; steps: string[]; rows: LeadRow[]; footer: string }
  | { kind: "visibility"; chip: string; query: string; steps: string[]; engines: EngineRow[]; footer: string };

const SCENES: Scene[] = [
  {
    kind: "leads",
    chip: "Find buyers",
    query: "Heads of Growth at Series B fintechs in the US",
    steps: ["Searching live sources", "Enriching profiles", "Verifying emails", "Scoring against your ICP"],
    rows: [
      { name: "Priya Kapoor", sub: "VP Growth · Nimbus Cloud · 240 staff", score: 94, tag: "Verified", tagTone: "green" },
      { name: "Daniel Osei", sub: "Head of RevOps · Lattice Pay · impressions up 3x", score: 88, tag: "Verified", tagTone: "green" },
      { name: "Wei Chen", sub: "Director Sales · Forma Health · 95 staff", score: 81, tag: "Risky - held back", tagTone: "amber" },
    ],
    footer: "1 address looked risky, so it was held back instead of burning your domain.",
  },
  {
    kind: "visibility",
    chip: "See what AI says",
    query: "What does AI tell buyers when they ask about us?",
    steps: ["Asking Gemini", "Asking Groq", "Parsing brand mentions", "Computing confidence"],
    engines: [
      { engine: "Gemini", verdict: "You appear in 7 of 12 answers", rate: "58%", detail: "95% CI 32-81%, n=12 · usually listed after Apollo", tone: "good" },
      { engine: "Groq", verdict: "You appear in 2 of 11 answers", rate: "18%", detail: "95% CI 5-48%, n=11 · Clay owns this answer", tone: "warn" },
      { engine: "Both", verdict: "Change vs last week", rate: "No call", detail: "Intervals overlap - not enough data to claim a move", tone: "flat" },
    ],
    footer: "Engines disagree. A blended headline number would describe no engine that exists.",
  },
  {
    kind: "leads",
    chip: "Catch the moment",
    query: "D2C brands that just raised and are hiring supply chain",
    steps: ["Watching funding feeds", "Matching to your ICP", "Finding decision makers", "Drafting first touch"],
    rows: [
      { name: "Aarav Mehta", sub: "COO · Loomly Goods · raised $18M, 6 days ago", score: 96, tag: "Funding signal", tagTone: "brand" },
      { name: "Sofia Ramos", sub: "Head of Ops · Brightbar · 4 supply chain roles open", score: 90, tag: "Hiring signal", tagTone: "brand" },
      { name: "Tomas Lind", sub: "Founder · Nordkit · new 3PL partnership", score: 83, tag: "Verified", tagTone: "green" },
    ],
    footer: "Reached while the budget is still being decided, not three months after.",
  },
];

const TYPE_MS = 44;
const ERASE_MS = 16;
const STEP_MS = 235;
const HOLD_MS = 3600;

type Phase = "typing" | "working" | "results" | "erasing";

/** True while the tab is actually on screen. Chrome clamps timers in a hidden tab to about
 * one per second, which would leave the demo stranded half-typed; pausing and restarting the
 * scene is cleaner than letting it crawl, and costs nothing while nobody is looking. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Counts up to `to` once, so a fit score lands rather than just appearing. */
function Count({ to, animate }: { to: number; animate: boolean }) {
  const [v, setV] = useState(animate ? 0 : to);
  useEffect(() => {
    if (!animate) {
      setV(to);
      return;
    }
    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      setV(Math.round(to * Math.min(1, frame / 16)));
      if (frame >= 16) window.clearInterval(id);
    }, 24);
    return () => window.clearInterval(id);
  }, [to, animate]);
  return <>{v}</>;
}

const TAG_TONE: Record<LeadRow["tagTone"], string> = {
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  brand: "bg-brand-50 text-brand-700",
};

const ENGINE_TONE: Record<EngineRow["tone"], string> = {
  good: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  flat: "bg-black/5 text-ink-300",
};

export function HeroDemo() {
  const reduced = usePrefersReducedMotion();
  const visible = usePageVisible();
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("typing");
  const [step, setStep] = useState(0);

  const scene = SCENES[idx];
  const done = phase === "results";

  useEffect(() => {
    if (reduced) {
      setTyped(SCENES[0].query);
      setPhase("results");
      setStep(SCENES[0].steps.length);
    }
  }, [reduced]);

  // Coming back into view restarts the current scene from the top rather than resuming a
  // frozen half-typed line.
  useEffect(() => {
    if (reduced || !visible) return;
    setTyped("");
    setStep(0);
    setPhase("typing");
  }, [visible, reduced]);

  useEffect(() => {
    if (reduced || !visible) return;
    let t: number | undefined;

    if (phase === "typing") {
      if (typed.length < scene.query.length) {
        t = window.setTimeout(() => setTyped(scene.query.slice(0, typed.length + 1)), TYPE_MS);
      } else {
        t = window.setTimeout(() => {
          setStep(0);
          setPhase("working");
        }, 380);
      }
    } else if (phase === "working") {
      if (step < scene.steps.length) {
        t = window.setTimeout(() => setStep(step + 1), STEP_MS);
      } else {
        t = window.setTimeout(() => setPhase("results"), 240);
      }
    } else if (phase === "results") {
      t = window.setTimeout(() => setPhase("erasing"), HOLD_MS);
    } else if (typed.length > 0) {
      t = window.setTimeout(() => setTyped(typed.slice(0, -1)), ERASE_MS);
    } else {
      setIdx((n) => (n + 1) % SCENES.length);
      setStep(0);
      setPhase("typing");
    }

    return () => window.clearTimeout(t);
  }, [phase, typed, step, idx, reduced, visible, scene]);

  const caret = phase === "typing" || phase === "erasing";
  const label = useMemo(() => (scene.kind === "leads" ? "Live search" : "AI visibility"), [scene.kind]);

  return (
    <div className="relative mx-auto mt-10 w-full max-w-3xl">
      <div className="absolute -inset-x-8 -top-8 h-full rounded-[2rem] bg-brand-gradient opacity-[0.12] blur-3xl" aria-hidden />

      <div className="card relative overflow-hidden p-0 shadow-xl">
        {/* window chrome */}
        <div className="flex items-center gap-1.5 border-b border-black/[0.06] px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
          <span className="ml-3 text-xs font-medium text-ink-400">{label}</span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-400">
            <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${done ? "" : "animate-soft-pulse"}`} />
            {done ? "done" : "working"}
          </span>
        </div>

        {/* the query, typing itself */}
        <div className="border-b border-black/[0.06] px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-1 text-sm text-brand-600">⌕</span>
            <p className="min-h-[2.75rem] text-left text-base font-medium leading-snug text-ink-50 sm:min-h-[1.5rem] sm:text-lg">
              {typed}
              {caret && <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-brand-600 align-baseline animate-caret" />}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {scene.steps.map((s, i) => {
              const active = phase === "working" ? i < step : done;
              return (
                <span
                  key={s}
                  className={`badge border text-[11px] transition-colors duration-300 ${
                    active ? "border-brand-200 bg-brand-50 text-brand-700" : "border-black/[0.06] bg-black/[0.02] text-ink-500"
                  }`}
                >
                  <span className="mr-1">{active ? "✓" : "·"}</span>
                  {s}
                </span>
              );
            })}
          </div>
        </div>

        {/* the answer */}
        <div className="relative min-h-[13.2rem]">
          {!done ? (
            <div className="divide-y divide-black/[0.05]">
              {[0, 1, 2].map((i) => (
                <div key={i} className="relative overflow-hidden px-5 py-[1.15rem]">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 shrink-0 rounded-full bg-black/[0.05]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-2.5 w-1/3 rounded bg-black/[0.06]" />
                      <div className="h-2 w-2/3 rounded bg-black/[0.04]" />
                    </div>
                  </div>
                  <div
                    className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent animate-shimmer"
                    style={{ animationDelay: `${i * 140}ms` }}
                    aria-hidden
                  />
                </div>
              ))}
            </div>
          ) : scene.kind === "leads" ? (
            <div className="divide-y divide-black/[0.05]">
              {scene.rows.map((r, i) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between gap-3 px-5 py-4 animate-rise"
                  style={{ animationDelay: `${i * 110}ms` }}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-sm font-semibold text-brand-600">
                      {r.name.split(" ").map((w) => w[0]).join("")}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink-50">{r.name}</div>
                      <div className="truncate text-xs text-ink-400">{r.sub}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className={`badge ${TAG_TONE[r.tagTone]}`}>{r.tag}</span>
                    <span className="badge bg-brand-50 tabular-nums text-brand-700">
                      <Count key={`${idx}-${r.name}`} to={r.score} animate={!reduced} /> fit
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-black/[0.05]">
              {scene.engines.map((e, i) => (
                <div
                  key={e.engine}
                  className="flex items-center justify-between gap-3 px-5 py-4 animate-rise"
                  style={{ animationDelay: `${i * 110}ms` }}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-50">
                      {e.engine} <span className="font-normal text-ink-300">— {e.verdict}</span>
                    </div>
                    <div className="truncate text-xs text-ink-400">{e.detail}</div>
                  </div>
                  <span className={`badge shrink-0 tabular-nums ${ENGINE_TONE[e.tone]}`}>{e.rate}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-black/[0.06] bg-black/[0.015] px-5 py-3 text-left text-xs text-ink-400">
          {done ? scene.footer : " "}
        </div>
      </div>

      {/* scene dots */}
      <div className="mt-5 flex items-center justify-center gap-2">
        {SCENES.map((s, i) => (
          <button
            key={s.query}
            type="button"
            aria-label={s.chip}
            onClick={() => {
              setIdx(i);
              setTyped(reduced ? s.query : "");
              setStep(reduced ? s.steps.length : 0);
              setPhase(reduced ? "results" : "typing");
            }}
            className={`h-1.5 rounded-full transition-all ${i === idx ? "w-7 bg-brand-500" : "w-1.5 bg-black/15 hover:bg-black/25"}`}
          />
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-ink-500">Illustrative - not real customer data.</p>
    </div>
  );
}
