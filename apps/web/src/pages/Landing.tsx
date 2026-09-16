import { Link } from "react-router-dom";
import { Logo, BRAND_TAGLINE } from "../components/Logo";

const features = [
  { icon: "⌕", title: "Real-time B2B discovery", desc: "Search live company and people data by industry, size, tech stack, and intent — no stale lists." },
  { icon: "◎", title: "ICP lookalike scoring", desc: "Feed in your best accounts and score every new prospect against your ideal customer profile." },
  { icon: "✉", title: "AI-personalized outreach", desc: "Draft, sequence, and send outbound that reads like it was written by a rep who did the research." },
  { icon: "◉", title: "Website visitor identification", desc: "Turn anonymous traffic into named companies and route hot visitors straight into your pipeline." },
  { icon: "◈", title: "Intent signals", desc: "Track funding, hiring, and buying signals across the web so you reach out at the right moment." },
  { icon: "⚡", title: "Built for AI agents", desc: "A first-class MCP server and REST API mean your agents can prospect, enrich, and send — autonomously." },
];

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo size={28} textClassName="text-lg" />
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

        <section className="grid grid-cols-1 gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="card p-6 transition hover:border-brand-500/30">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-lg text-brand-600">{f.icon}</div>
              <div className="font-semibold text-ink-50">{f.title}</div>
              <p className="mt-1.5 text-sm text-ink-400">{f.desc}</p>
            </div>
          ))}
        </section>

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
