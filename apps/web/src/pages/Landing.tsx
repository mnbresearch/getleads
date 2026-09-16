import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Logo, BRAND_TAGLINE } from "../components/Logo";
import { apiFetch } from "../lib/api";

const features = [
  { icon: "⌕", title: "Real-time B2B discovery", desc: "Search live company and people data by industry, size, tech stack, and intent — no stale lists." },
  { icon: "◎", title: "ICP lookalike scoring", desc: "Feed in your best accounts and score every new prospect against your ideal customer profile." },
  { icon: "✉", title: "AI-personalized outreach", desc: "Draft, sequence, and send outbound that reads like it was written by a rep who did the research." },
  { icon: "◉", title: "Website visitor identification", desc: "Turn anonymous traffic into named companies and route hot visitors straight into your pipeline." },
  { icon: "◈", title: "Intent signals", desc: "Track funding, hiring, and buying signals across the web so you reach out at the right moment." },
  { icon: "⚡", title: "Built for AI agents", desc: "A first-class MCP server and REST API mean your agents can prospect, enrich, and send — autonomously." },
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
    <section id="pricing" className="pb-24 pt-8 scroll-mt-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-ink-50 sm:text-4xl">Simple pricing, real leads</h2>
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
              <div key={p.id} className={`card relative flex flex-col p-6 ${featured ? "border-brand-300 ring-2 ring-brand-200" : ""}`}>
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
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo size={28} textClassName="text-lg" />
        <nav className="hidden items-center gap-6 text-sm text-ink-300 sm:flex">
          <a href="#features" className="hover:text-ink-50">Features</a>
          <a href="#pricing" className="hover:text-ink-50">Pricing</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/login" className="btn-secondary">Sign in</Link>
          <Link to="/signup" className="btn-primary">Get started</Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="flex flex-col items-center py-20 text-center sm:py-28">
          <span className="badge border border-black/10 bg-black/5 text-ink-300">For sales teams and AI agents</span>
          <h1 className="mt-6 max-w-3xl text-4xl font-bold tracking-tight text-ink-50 sm:text-6xl">
            Find, enrich, and reach your next customer — <span className="bg-brand-gradient bg-clip-text text-transparent">before your competitors do</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-300">{BRAND_TAGLINE}. One platform, one API, one MCP server — for your reps and your agents.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/signup" className="btn-primary px-6 py-3 text-base shadow-glow">Start free</Link>
            <Link to="/login" className="btn-secondary px-6 py-3 text-base">Sign in</Link>
          </div>
        </section>

        <section id="features" className="grid scroll-mt-20 grid-cols-1 gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="card p-6 transition hover:border-brand-500/30">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-lg text-brand-600">{f.icon}</div>
              <div className="font-semibold text-ink-50">{f.title}</div>
              <p className="mt-1.5 text-sm text-ink-400">{f.desc}</p>
            </div>
          ))}
        </section>

        <PricingSection />

        <section className="card mb-24 flex flex-col items-center gap-4 p-10 text-center sm:p-16">
          <h2 className="text-2xl font-semibold text-ink-50 sm:text-3xl">Give your agents a pipeline of their own</h2>
          <p className="max-w-lg text-sm text-ink-400">Connect over MCP or the REST API and let your AI agents search, enrich, and reach prospects with the same tools your reps use.</p>
          <Link to="/signup" className="btn-primary px-6 py-3 text-base">Create your workspace</Link>
        </section>
      </main>

      <footer className="border-t border-black/10 py-8 text-center text-xs text-ink-500">
        <Logo size={18} textClassName="text-xs" className="justify-center" />
        <div className="mt-2">Lead intelligence infrastructure for sales teams and AI agents.</div>
      </footer>
    </div>
  );
}
