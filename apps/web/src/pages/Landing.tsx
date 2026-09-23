import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";
import { HeroDemo } from "../components/HeroDemo";
import { apiFetch } from "../lib/api";

/**
 * Landing page.
 *
 * Written problem-first on purpose: the buyer already knows what a prospecting tool does,
 * so the page leads with the four ways outbound actually breaks and names the mechanism
 * that fixes each one. Claims here must stay things the product genuinely does.
 */

const problems = [
  {
    pain: "Half your list bounces, and your domain pays for it.",
    why: "Exported lists rot at roughly 2% a month. Send into them and your reputation goes down with them.",
    fix: "Scout verifies before it sends, holds back risky addresses, and trips a circuit breaker the moment bounce rates climb.",
  },
  {
    pain: "Everyone is emailing the same exported list.",
    why: "If you bought the list, so did your competitors. The prospect has read your email four times already.",
    fix: "Live discovery from the open web plus funding, hiring and leadership signals, so you arrive while the need is fresh.",
  },
  {
    pain: "Real personalisation takes 20 minutes a prospect.",
    why: "So it does not happen, and the template goes out instead, and reply rates keep sliding.",
    fix: "Scout researches the account first and drafts from what it actually found, then learns which angles earn replies.",
  },
  {
    pain: "They read your email, then ask ChatGPT about you.",
    why: "Whatever the AI says next is now part of your funnel, and almost nobody can tell you what it said.",
    fix: "Scout asks the engines your buyers use and shows you the answer, the rivals named, and where you are missing.",
  },
];

const features = [
  { icon: "⌕", title: "Real-time B2B discovery", desc: "Search live company and people data by industry, size, tech stack and intent, instead of buying a list that is already stale." },
  { icon: "◎", title: "ICP that learns from replies", desc: "Feed in your best accounts, then let outcomes reshape the profile as real replies come in." },
  { icon: "✉", title: "Outreach written from research", desc: "Drafts built on what Scout found about the account, sequenced and A/B tested with a statistical winner, not a hunch." },
  { icon: "◉", title: "Website visitor identification", desc: "Turn anonymous traffic into named companies and route hot visitors straight into the pipeline." },
  { icon: "◈", title: "Intent signals", desc: "Funding, hiring, leadership changes and news, watched continuously so timing stops being luck." },
  { icon: "◐", title: "AI visibility across engines", desc: "Track what Gemini, Groq and the rest say when a buyer researches you, per engine, with the raw answers kept." },
  { icon: "⚑", title: "Deliverability that defends you", desc: "Warm-up, per-mailbox health scoring and an automatic stop before a bad run damages your domain." },
  { icon: "⚡", title: "Built for AI agents", desc: "A first-class MCP server and REST API, so your agents can prospect, enrich and send with the same tools your reps use." },
];

/**
 * Comparison matrix. Rows are what Scout does; columns are categories rather than named
 * vendors, and anything uncertain says "varies" rather than asserting a competitor's
 * behaviour we have not verified.
 */
const COMPARE_COLS = ["Scout", "Prospecting tools", "AI visibility tools", "SEO / keyword tools"] as const;
const compare: { row: string; cells: (true | false | "varies")[] }[] = [
  { row: "Finds and verifies buyers from live sources", cells: [true, true, false, false] },
  { row: "Writes outreach from real account research", cells: [true, true, false, false] },
  { row: "Measures what AI answers say about you", cells: [true, false, true, "varies"] },
  { row: "Reports per engine, not one blended number", cells: [true, false, "varies", false] },
  { row: "Confidence intervals and sample sizes on every rate", cells: [true, false, "varies", false] },
  { row: "Keeps raw answers so past data can be recomputed", cells: [true, false, "varies", false] },
  { row: "Writes the tracked questions from your own ICP", cells: [true, false, false, false] },
  { row: "Outbound outcomes and AI answers in one database", cells: [true, false, false, false] },
];

/**
 * How the AI-visibility half actually runs, in the order it runs.
 *
 * Written out because "AEO" and "GEO" are the terms buyers arrive with and are mostly sold as
 * a black box. The mechanism is the product here, so stating it plainly is the pitch.
 */
const aeoSteps = [
  {
    n: "01",
    title: "The questions get written for you",
    desc: "Scout reads your brand, your rivals and your ICP and writes the category, comparison, alternative, problem and evaluation questions a buyer actually types. None of them name you, because a question that names you guarantees you appear.",
  },
  {
    n: "02",
    title: "Every engine you have gets asked, repeatedly",
    desc: "The same questions go to each AI engine you have configured, on a schedule, many times over. One answer is a sample, not a measurement: ask twice and you get different brands in a different order.",
  },
  {
    n: "03",
    title: "Each answer is read, not keyword-matched",
    desc: "Scout parses who was named, in what position, and which sources were cited. Aliases resolve to one brand, overlapping names are not double counted, and a refusal is told apart from an answer that simply left you out.",
  },
  {
    n: "04",
    title: "You get rates, rivals and ranked gaps",
    desc: "Mention rate and share of voice per engine with a confidence interval, who owns the answers you are missing from, and which questions are winnable - ranked so a rival holding a slot beats a question nobody wins.",
  },
];

/** The question people actually ask, answered without the usual hand-waving. */
const aeoScope = {
  does: [
    "Tells you whether AI engines name you for the questions your buyers ask, with a number you can defend.",
    "Names the rivals who own the answers you are absent from, including ones you never thought to track.",
    "Shows which sources each engine cites, so you know which pages and publications the answer is actually built from.",
    "Ranks the gaps by winnability, so effort goes where a slot demonstrably exists.",
    "Keeps every raw answer verbatim, so any number traces back to the text it came from and history can be recomputed.",
  ],
  doesNot: [
    "Write your content or publish it for you. Scout tells you what to go and earn; earning it is still work.",
    "Promise a ranking. Nobody can, and anyone selling AEO or GEO guarantees is selling you variance.",
    "Report a rate before it has enough usable answers to mean anything. Below the threshold it says what it still needs.",
    "Count a refusal as you being absent, which is how other tools manufacture a collapse that never happened.",
  ],
};

/** The AI does work here that a person would otherwise do badly or not at all. */
const aiWork = [
  {
    label: "Writes the questions",
    title: "Prompt sets, generated from your ICP",
    body: "Most tools hand you an empty box and let you track your own brand name, which you always win and no buyer ever asks. Scout reads your brand, rivals and ICP and writes the category, comparison and problem questions a real buyer would type.",
    guard: "Every generated question is validated before it is stored, including a rule that it must not name you.",
  },
  {
    label: "Reads the answers",
    title: "Brand mentions parsed, not keyword-matched",
    body: "Each answer is parsed for who was named, in what order, and who was linked. Aliases resolve to one brand and overlapping names are not double counted, so share of voice is computed over mention slots rather than raw string hits.",
    guard: "Refusals and errors are excluded from the denominator instead of being counted as absence.",
  },
  {
    label: "Writes the outreach",
    title: "Drafts built from what was actually found",
    body: "Account research first, draft second. Variants are A/B tested and the winner is chosen when the intervals separate, not when one is briefly ahead.",
    guard: "The ICP is reshaped by real reply outcomes, so the targeting learns instead of staying as first typed.",
  },
];

const steps = [
  { n: "01", title: "Describe who you're after", desc: "Titles, industries, company size, tech stack, or plain language. Scout turns it into a live search." },
  { n: "02", title: "Scout finds, verifies and ranks", desc: "Every result is enriched, checked and scored against your ICP before it ever reaches your list." },
  { n: "03", title: "Reach out, and watch both sides", desc: "Send from the app or hand the tools to your agent, then see what the AI engines tell buyers who go looking." },
];

type PlanLimits = {
  leadsPerMonth: number;
  premiumLeadsPerMonth: number;
  searchesPerMonth: number;
  verificationsPerMonth: number;
  aiMessagesPerMonth: number;
  emailsPerMonth: number;
  campaigns: number;
  seats: number;
};
type Plan = { id: string; name: string; priceUsd: number; limits: PlanLimits };

const PLAN_ORDER = ["free", "starter", "growth", "scale", "enterprise"];
const PLAN_BLURB: Record<string, string> = {
  free: "Try it with zero-cost, web-sourced leads.",
  starter: "For a founder or small team running their first campaigns.",
  growth: "For a sales team that needs verified emails at real volume.",
  scale: "For revenue teams scaling outbound across the org.",
  enterprise: "For companies that need volume, seats, and a dedicated line.",
};

function planFeatures(p: Plan): string[] {
  const l = p.limits;
  const out = [`${l.leadsPerMonth.toLocaleString()} leads/mo`];
  out.push(l.premiumLeadsPerMonth > 0 ? `${l.premiumLeadsPerMonth.toLocaleString()} verified premium leads/mo` : "Free web-sourced leads only");
  out.push(`${l.verificationsPerMonth.toLocaleString()} email verifications/mo`);
  out.push(`${l.emailsPerMonth.toLocaleString()} outbound emails/mo`);
  out.push(`${l.seats} seat${l.seats === 1 ? "" : "s"} · ${l.campaigns} campaign${l.campaigns === 1 ? "" : "s"}`);
  return out;
}

function PricingSection() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("GET", "/v1/billing/plans")
      .then((r) => setPlans(r.plans.filter((p) => p.id !== "pilot").sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))))
      .catch(() => setPlans([]));
  }, []);

  return (
    <section id="pricing" className="pb-24 pt-8 scroll-mt-24">
      <div className="mx-auto max-w-2xl text-center">
        <span className="badge border border-black/10 bg-black/5 text-ink-300">Pricing</span>
        <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Simple pricing, real leads</h2>
        <p className="mt-3 text-ink-300">Every plan sources what it can for free first — you only pay for verified, provider-backed leads. Cancel anytime.</p>
      </div>

      {plans === null ? (
        <div className="mt-10 text-center text-sm text-ink-400">Loading plans…</div>
      ) : (
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {plans.map((p) => {
            const featured = p.id === "growth";
            const custom = p.id === "enterprise";
            return (
              <div
                key={p.id}
                className={`card relative flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg ${featured ? "border-brand-300 ring-2 ring-brand-200" : ""}`}
              >
                {featured && <span className="badge absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white">Most popular</span>}
                <div className="font-semibold text-ink-50">{p.name}</div>
                <p className="mt-1 text-xs text-ink-400">{PLAN_BLURB[p.id]}</p>
                <div className="mt-4">
                  {custom ? (
                    <span className="text-3xl font-bold text-ink-50">${p.priceUsd.toLocaleString()}</span>
                  ) : p.priceUsd === 0 ? (
                    <span className="text-3xl font-bold text-ink-50">Free</span>
                  ) : (
                    <>
                      <span className="text-3xl font-bold text-ink-50">${p.priceUsd.toLocaleString()}</span>
                      <span className="text-sm text-ink-400">/mo</span>
                    </>
                  )}
                </div>
                <ul className="mt-5 flex-1 space-y-2 text-sm text-ink-300">
                  {planFeatures(p).map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-brand-600">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  to={p.priceUsd === 0 ? "/signup" : `/upgrade?plan=${p.id}`}
                  className={`mt-6 justify-center ${featured ? "btn-primary" : "btn-secondary"}`}
                >
                  {custom ? "Talk to us" : p.priceUsd === 0 ? "Start free" : "Yes, I'm interested — upgrade me"}
                </Link>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-8 text-center text-xs text-ink-500">Prices in USD, billed monthly. Every paid plan is priced for real provider costs at real usage — no surprise overages.</p>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-50 border-b border-black/5 bg-cream/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Logo size={28} textClassName="text-lg" />
          <nav className="hidden items-center gap-6 text-sm text-ink-300 sm:flex">
            <a href="#problems" className="hover:text-ink-50">Why Scout</a>
            <a href="#ai" className="hover:text-ink-50">The AI layer</a>
            <a href="#visibility" className="hover:text-ink-50">AI visibility</a>
            <a href="#how-aeo" className="hover:text-ink-50">AEO / GEO</a>
            <a href="#compare" className="hover:text-ink-50">Compare</a>
            <a href="#pricing" className="hover:text-ink-50">Pricing</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link to="/login" className="btn-secondary">Sign in</Link>
            <Link to="/signup" className="btn-primary">Get started</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="flex flex-col items-center pb-8 pt-14 text-center sm:pt-16">
          <span className="badge border border-black/10 bg-black/5 text-ink-300">Outbound and AI visibility, in one system</span>
          <h1 className="mt-6 max-w-3xl text-[2rem] font-bold leading-[1.12] tracking-tight text-ink-50 sm:text-5xl">
            The list is stale. The emails bounce. And when they check you out,{" "}
            <span className="bg-brand-gradient bg-clip-text text-transparent">the AI recommends someone else.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base text-ink-300 sm:text-lg">
            Scout finds buyers who actually exist, writes outreach worth replying to, and shows you what the AI engines say
            about you when the prospect goes looking. Both halves of the funnel, one place.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link to="/signup" className="btn-primary px-6 py-3 text-base shadow-glow">Start free</Link>
            <a href="#problems" className="btn-secondary px-6 py-3 text-base">See what it fixes</a>
          </div>
          <p className="mt-4 text-xs text-ink-400">No credit card required · Free web-sourced leads on day one</p>
          <HeroDemo />
        </section>

        <section id="problems" className="scroll-mt-24 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Sound familiar?</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Four ways outbound quietly stops working</h2>
            <p className="mt-3 text-ink-300">Each one has a mechanism behind it, not a feature name.</p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {problems.map((p) => (
              <div key={p.pain} className="card flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg">
                <div className="text-lg font-semibold leading-snug text-ink-50">{p.pain}</div>
                <p className="mt-2 text-sm text-ink-400">{p.why}</p>
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-brand-100 bg-brand-50/60 p-3 text-sm text-ink-200">
                  <span className="mt-0.5 shrink-0 text-brand-600">→</span>
                  <span>{p.fix}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="visibility" className="scroll-mt-24 pb-24">
          <div className="card relative overflow-hidden p-8 sm:p-12">
            <div className="pointer-events-none absolute inset-0 bg-brand-gradient opacity-[0.05]" aria-hidden />
            <div className="relative grid gap-10 lg:grid-cols-2 lg:items-center">
              <div>
                <span className="badge border border-black/10 bg-black/5 text-ink-300">AEO / GEO, measured honestly</span>
                <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">
                  Your email lands. Then they ask an AI whether you're any good.
                </h2>
                <p className="mt-4 text-ink-300">
                  This is the thing now sold as <strong className="font-semibold text-ink-100">Answer Engine Optimisation</strong> and{" "}
                  <strong className="font-semibold text-ink-100">Generative Engine Optimisation</strong>. Buyers no longer arrive from ten
                  blue links; they ask an assistant and act on one answer. If that answer names three competitors and not
                  you, the deal ended before anyone opened your email.
                </p>
                <p className="mt-3 text-ink-300">
                  Prospecting tools optimise the sending and know nothing about that moment. AEO tools measure that moment
                  and know nothing about who you contacted. Scout is the only place both sit on one schema.
                </p>
                <ul className="mt-6 space-y-3 text-sm text-ink-200">
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> Track the questions your buyers actually ask, across every engine you have configured.</li>
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> See which rivals own the answer, and which questions are winnable.</li>
                  <li className="flex gap-2"><span className="text-brand-600">✓</span> Raw answers stored verbatim, so a number can always be traced back to the text it came from.</li>
                </ul>
                <Link to="/signup" className="btn-primary mt-8 px-6 py-3 text-base">Find out what AI says about you</Link>
              </div>
              <div className="rounded-xl border border-black/[0.06] bg-surface p-6">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Why our numbers look less exciting</div>
                <p className="mt-3 text-sm text-ink-200">
                  An AI answer is a sample, not a measurement. Ask twice and you get different brands in a different order.
                  Most tools run a prompt once, find you missing, and report that visibility collapsed.
                </p>
                <p className="mt-3 text-sm text-ink-200">
                  Scout reports a rate only with its confidence interval and sample size, calls a change real only when the
                  intervals separate, and excludes refusals instead of counting them as absence.
                </p>
                <p className="mt-4 border-t border-black/[0.06] pt-4 text-sm font-medium text-ink-50">
                  It will tell you "not enough data yet" rather than be confidently wrong. That is the point.
                </p>
              </div>
            </div>
          </div>
        </section>


        <section id="how-aeo" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">How AI visibility actually works</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">
              Four steps, and none of them are a black box
            </h2>
            <p className="mt-3 text-ink-300">
              AEO and GEO are mostly sold as magic. Here is the whole mechanism, in the order it runs, so you can judge
              whether the number at the end deserves your trust.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {aeoSteps.map((a) => (
              <div key={a.n} className="card flex gap-4 p-6">
                <div className="shrink-0 text-sm font-semibold tabular-nums text-brand-600">{a.n}</div>
                <div>
                  <div className="text-lg font-semibold leading-snug text-ink-50">{a.title}</div>
                  <p className="mt-2 text-sm text-ink-400">{a.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="card p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-ink-400">What Scout does</div>
              <ul className="mt-4 space-y-3 text-sm text-ink-200">
                {aeoScope.does.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-brand-600">&#10003;</span>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card p-6">
              <div className="text-sm font-semibold uppercase tracking-wide text-ink-400">What Scout does not do</div>
              <ul className="mt-4 space-y-3 text-sm text-ink-200">
                {aeoScope.doesNot.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-ink-400">&#8212;</span>
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-black/[0.06] pt-4 text-sm font-medium text-ink-50">
                A tool that cannot say what it will not do is not measuring anything.
              </p>
            </div>
          </div>
        </section>

        <section id="ai" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Where the AI actually does the work</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">It writes the questions, not just the emails</h2>
            <p className="mt-3 text-ink-300">
              Three places Scout does work a person would otherwise do badly, or skip. Each one ships with the guardrail
              that keeps it honest.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-3">
            {aiWork.map((a) => (
              <div key={a.title} className="card flex flex-col p-6 transition hover:-translate-y-0.5 hover:shadow-lg">
                <span className="badge w-fit bg-brand-50 text-brand-700">{a.label}</span>
                <div className="mt-3 text-lg font-semibold leading-snug text-ink-50">{a.title}</div>
                <p className="mt-2 flex-1 text-sm text-ink-400">{a.body}</p>
                <div className="mt-4 flex items-start gap-2 border-t border-black/[0.06] pt-3 text-xs text-ink-300">
                  <span className="mt-0.5 shrink-0 text-brand-600">&#9673;</span>
                  <span>{a.guard}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="card mt-6 overflow-hidden p-0">
            <div className="border-b border-black/[0.06] px-6 py-4">
              <div className="font-semibold text-ink-50">One click, a tracked set worth measuring</div>
              <p className="mt-1 text-sm text-ink-400">
                A generated set, reviewed before anything is stored. If the model returns too little to be a set, Scout
                says so and falls back rather than passing a thin result off as generated.
              </p>
            </div>
            <ul className="divide-y divide-black/[0.05] text-sm">
              {[
                { q: "What is the best B2B lead generation platform for small sales teams?", tag: "category" },
                { q: "What are the top alternatives to Apollo?", tag: "alternative" },
                { q: "Apollo vs Clay: which is better for outbound in 2026?", tag: "comparison" },
                { q: "How do teams usually deal with lead lists going stale?", tag: "problem" },
                { q: "What should I look for when choosing a prospecting tool?", tag: "evaluation" },
              ].map((r) => (
                <li key={r.q} className="flex items-center justify-between gap-3 px-6 py-3">
                  <span className="min-w-0 text-ink-200">{r.q}</span>
                  <span className="badge shrink-0 bg-black/5 text-ink-400">{r.tag}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-black/[0.06] bg-black/[0.015] px-6 py-3 text-xs text-ink-400">
              Not one of them names you. A question that names you guarantees you appear, which measures the question
              rather than your visibility.
            </div>
          </div>
        </section>

        <section id="compare" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Why Scout instead of the alternatives</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Each category owns half the problem</h2>
            <p className="mt-3 text-ink-300">
              Prospecting tools know who you contacted. Visibility tools know what the AI said. Neither holds both, which
              is why nobody can tell you whether being cited actually converts.
            </p>
          </div>
          <div className="card mt-12 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-400">Capability</th>
                  {COMPARE_COLS.map((c) => (
                    <th
                      key={c}
                      className={`px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide ${c === "Scout" ? "bg-brand-50/60 text-brand-700" : "text-ink-400"}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05]">
                {compare.map((r) => (
                  <tr key={r.row}>
                    <td className="px-5 py-3 text-ink-200">{r.row}</td>
                    {r.cells.map((cell, i) => (
                      <td key={i} className={`px-4 py-3 text-center ${i === 0 ? "bg-brand-50/40" : ""}`}>
                        {cell === true ? (
                          <span className="font-semibold text-brand-600">&#10003;</span>
                        ) : cell === "varies" ? (
                          <span className="text-xs text-ink-400">varies</span>
                        ) : (
                          <span className="text-ink-600">&mdash;</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center text-xs text-ink-500">
            Columns are categories, not specific vendors, and "varies" means exactly that. Individual products differ, so
            check the one you are comparing against.
          </p>
        </section>

        <section id="how-it-works" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">How it works</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">From "who do we want" to "sent" in minutes</h2>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-3">
            {steps.map((s, i) => (
              <div key={s.n} className="relative">
                <div className="text-5xl font-bold text-brand-200">{s.n}</div>
                <div className="mt-3 font-semibold text-ink-50">{s.title}</div>
                <p className="mt-1.5 text-sm text-ink-400">{s.desc}</p>
                {i < steps.length - 1 && <div className="absolute right-[-1rem] top-6 hidden text-2xl text-ink-600 sm:block">→</div>}
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <span className="badge border border-black/10 bg-black/5 text-ink-300">Features</span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Everything a modern pipeline needs</h2>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((f) => (
              <div key={f.title} className="card p-6 transition hover:-translate-y-0.5 hover:border-brand-500/30 hover:shadow-lg">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-lg text-brand-600">{f.icon}</div>
                <div className="font-semibold text-ink-50">{f.title}</div>
                <p className="mt-1.5 text-sm text-ink-400">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <PricingSection />

        <section className="card relative mb-24 flex flex-col items-center gap-4 overflow-hidden p-10 text-center sm:p-16">
          <div className="pointer-events-none absolute inset-0 bg-brand-gradient opacity-[0.06]" aria-hidden />
          <h2 className="relative text-2xl font-semibold text-ink-50 sm:text-3xl">Give your agents a pipeline of their own</h2>
          <p className="relative max-w-lg text-sm text-ink-400">Connect over MCP or the REST API and let your AI agents search, enrich, and reach prospects with the same tools your reps use.</p>
          <div className="relative flex flex-wrap items-center justify-center gap-3">
            <Link to="/signup" className="btn-primary px-6 py-3 text-base">Create your workspace</Link>
            <a href="#pricing" className="btn-secondary px-6 py-3 text-base">See pricing</a>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-6 py-12 text-sm sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <Logo size={22} textClassName="text-sm" />
            <p className="mt-3 max-w-[220px] text-xs text-ink-400">Lead intelligence infrastructure for sales teams and AI agents.</p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Product</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              <li><a href="#problems" className="hover:text-ink-50">Why Scout</a></li>
              <li><a href="#ai" className="hover:text-ink-50">The AI layer</a></li>
              <li><a href="#visibility" className="hover:text-ink-50">AI visibility</a></li>
              <li><a href="#how-aeo" className="hover:text-ink-50">How AEO / GEO works</a></li>
              <li><a href="#compare" className="hover:text-ink-50">Compare</a></li>
              <li><a href="#how-it-works" className="hover:text-ink-50">How it works</a></li>
              <li><a href="#features" className="hover:text-ink-50">Features</a></li>
              <li><a href="#pricing" className="hover:text-ink-50">Pricing</a></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Account</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              <li><Link to="/signup" className="hover:text-ink-50">Get started</Link></li>
              <li><Link to="/login" className="hover:text-ink-50">Sign in</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Contact</div>
            <ul className="mt-3 space-y-2 text-ink-300">
              <li><a href="mailto:contact@mnbresearch.com" className="hover:text-ink-50">contact@mnbresearch.com</a></li>
              <li className="text-ink-500">A product by MNB Research</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-black/5 py-6 text-center text-xs text-ink-500">
          © {new Date().getFullYear()} Scout. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
