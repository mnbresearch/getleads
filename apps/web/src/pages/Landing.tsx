import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { FAQS } from "../content/faq";
import { API_URL, apiFetch } from "../lib/api";
import { sendPageView, sendPageViewWhenSeen } from "../lib/pageview";

/**
 * MNB SCOUT - LANDING PAGE
 *
 * Brand: MNB Scout (owned by MNB Research)
 * Category: AI-Powered Lead Discovery, Prospect Intelligence and Custom Audience Generation Platform
 * Positioning: "Find Anyone. Find Any Business. Find Your Next Customer."
 *
 * Structure follows the 17 specified sections from the Master Redesign Prompt.
 * Absolutely zero emojis. Zero unverified "free leads" or "free trial" claims.
 */

/* =========================================================================
   SVG ICONS (Clean, modern, zero emojis)
   ========================================================================= */

function CheckIcon({ className = "h-4 w-4 text-brand-600" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ArrowRightIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
    </svg>
  );
}

function SearchIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function SparklesIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
    </svg>
  );
}

function ShieldCheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function BuildingIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  );
}

function UsersIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function TargetIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <circle cx="12" cy="12" r="5" strokeWidth={2} />
      <circle cx="12" cy="12" r="1" strokeWidth={2} />
    </svg>
  );
}

function DatabaseIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <ellipse cx="12" cy="5" rx="9" ry="3" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

/* =========================================================================
   PRICING DATA TYPES & DEFAULTS
   ========================================================================= */

type PlanLimits = {
  leadsPerMonth: number;
  premiumLeadsPerMonth: number;
  searchesPerMonth: number;
  verificationsPerMonth: number;
  aiMessagesPerMonth: number;
  emailsPerMonth: number;
  /** Hosted MCP tool calls a month; 0 = not on the plan. Optional: older API responses lack it. */
  mcpCallsPerMonth?: number;
  campaigns: number;
  seats: number;
};
type Plan = { id: string; name: string; priceUsd: number; limits: PlanLimits };

const PLAN_ORDER = ["free", "starter", "growth", "scale", "enterprise"];
const PLAN_BLURB: Record<string, string> = {
  free: "Zero-credit sandbox for platform testing & open-web discovery.",
  starter: "For founders and early sales teams discovering their first qualified leads.",
  growth: "For high-velocity outbound teams requiring scaled email verification.",
  scale: "For revenue teams scaling outbound discovery across the entire company.",
  enterprise: "For high-volume enterprises needing dedicated pipelines, SLAs & seats.",
};

function planFeatures(p: Plan): string[] {
  const l = p.limits;
  const out = [`${l.leadsPerMonth.toLocaleString()} leads/mo`];
  out.push(l.premiumLeadsPerMonth > 0 ? `${l.premiumLeadsPerMonth.toLocaleString()} verified provider leads/mo` : "Web-sourced discovery testing");
  out.push(`${l.verificationsPerMonth.toLocaleString()} email verifications/mo`);
  out.push(`${l.emailsPerMonth.toLocaleString()} outbound emails/mo`);
  if ((l.mcpCallsPerMonth ?? 0) > 0) out.push(`Hosted MCP for Claude Code & Cursor · ${l.mcpCallsPerMonth!.toLocaleString()} tool calls/mo`);
  out.push(`${l.seats} seat${l.seats === 1 ? "" : "s"} · ${l.campaigns} campaign${l.campaigns === 1 ? "" : "s"}`);
  return out;
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Sandbox",
    priceUsd: 0,
    limits: {
      leadsPerMonth: 50,
      premiumLeadsPerMonth: 0,
      searchesPerMonth: 20,
      verificationsPerMonth: 50,
      aiMessagesPerMonth: 50,
      mcpCallsPerMonth: 0,
      emailsPerMonth: 100,
      campaigns: 1,
      seats: 1,
    },
  },
  {
    id: "starter",
    name: "Starter",
    priceUsd: 109,
    limits: {
      leadsPerMonth: 1500,
      premiumLeadsPerMonth: 150,
      searchesPerMonth: 500,
      verificationsPerMonth: 500,
      aiMessagesPerMonth: 500,
      mcpCallsPerMonth: 0,
      emailsPerMonth: 2000,
      campaigns: 3,
      seats: 2,
    },
  },
  {
    id: "growth",
    name: "Growth",
    priceUsd: 359,
    limits: {
      leadsPerMonth: 6000,
      premiumLeadsPerMonth: 500,
      searchesPerMonth: 2000,
      verificationsPerMonth: 1500,
      aiMessagesPerMonth: 1500,
      mcpCallsPerMonth: 5000,
      emailsPerMonth: 8000,
      campaigns: 15,
      seats: 5,
    },
  },
  {
    id: "scale",
    name: "Scale",
    priceUsd: 1199,
    limits: {
      leadsPerMonth: 20000,
      premiumLeadsPerMonth: 1500,
      searchesPerMonth: 8000,
      verificationsPerMonth: 5000,
      aiMessagesPerMonth: 5000,
      mcpCallsPerMonth: 25000,
      emailsPerMonth: 40000,
      campaigns: 100,
      seats: 15,
    },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceUsd: 3199,
    limits: {
      leadsPerMonth: 60000,
      premiumLeadsPerMonth: 5000,
      searchesPerMonth: 25000,
      verificationsPerMonth: 15000,
      aiMessagesPerMonth: 15000,
      mcpCallsPerMonth: 100000,
      emailsPerMonth: 120000,
      campaigns: 1000,
      seats: 50,
    },
  },
];

/* =========================================================================
   SECTION 1: NAVIGATION BAR
   ========================================================================= */

const NAV_LINKS = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#features", label: "Plays" },
  { href: "#developers", label: "Developers" },
  { href: "#compare", label: "Compare" },
  { href: "#agencies", label: "Agencies" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

function NavigationBar() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-50 border-b border-black/5 bg-cream/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
        <Link to="/" className="flex items-center gap-2">
          <Logo size={28} textClassName="text-lg font-bold" showBadge={true} />
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden items-center gap-5 whitespace-nowrap text-xs font-semibold text-ink-300 lg:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-ink-50">
              {l.label}
            </a>
          ))}
        </nav>

        {/* Action Buttons */}
        <div className="flex items-center gap-2.5">
          <Link to="/login" className="btn-secondary text-xs px-3.5 py-2 font-medium">
            Sign In
          </Link>
          <Link to="/signup" className="btn-primary text-xs px-4 py-2 font-semibold shadow-xs">
            Find My First Leads
          </Link>
          <button
            type="button"
            data-testid="landing-menu-button"
            className="grid h-10 w-10 place-items-center rounded-lg border border-black/10 bg-black/[0.03] text-ink-100 lg:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden className="text-base leading-none">{menuOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {menuOpen && (
        <nav className="border-t border-black/5 bg-cream px-4 pb-4 pt-3 lg:hidden shadow-lg animate-fade-in">
          <ul className="grid grid-cols-2 gap-1 text-xs font-medium text-ink-200">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className="block rounded-lg px-3 py-2.5 hover:bg-black/[0.04] hover:text-ink-50"
                  onClick={() => setMenuOpen(false)}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}

/* =========================================================================
   SECTION 2: HERO SECTION & CENTERPIECE SEARCH DEMONSTRATION
   ========================================================================= */

interface HeroProspect {
  id: string;
  name: string;
  designation: string;
  company: string;
  industry: string;
  location: string;
  headcount: string;
  matchScore: number;
  contactStatus: "Verified Work Email" | "MX Handshake Checked";
  sourceProof: string;
  tags: string[];
}

const HERO_SAMPLE_RESULTS: Record<string, HeroProspect[]> = {
  saas: [
    {
      id: "1",
      name: "Aditya Sharma",
      designation: "Founder & CEO",
      company: "ZetaPulse Technologies",
      industry: "B2B SaaS / Enterprise",
      location: "Bengaluru, India",
      headcount: "65 employees",
      matchScore: 96,
      contactStatus: "Verified Work Email",
      sourceProof: "MCA official company filing & LinkedIn founder confirmation",
      tags: ["Founder", "Series A", "B2B Software", "India"],
    },
    {
      id: "2",
      name: "Priya Kapoor",
      designation: "Co-Founder & Chief Operating Officer",
      company: "Nimbus Cloud Platform",
      industry: "Cloud Infrastructure",
      location: "Gurgaon, India",
      headcount: "140 employees",
      matchScore: 94,
      contactStatus: "Verified Work Email",
      sourceProof: "Speaker roster at SaaS India Conclave 2026",
      tags: ["C-Level", "High Growth", "Cloud Infra"],
    },
    {
      id: "3",
      name: "Nikhil Chawla",
      designation: "VP Revenue Operations",
      company: "Lattice Pay India",
      industry: "Fintech & Payments",
      location: "Mumbai, India",
      headcount: "110 employees",
      matchScore: 91,
      contactStatus: "MX Handshake Checked",
      sourceProof: "Published leadership profile on latticepay.com",
      tags: ["VP Level", "Fintech", "Active Hiring"],
    },
  ],
  rice: [
    {
      id: "4",
      name: "Rajesh Singhania",
      designation: "Managing Director & Co-Founder",
      company: "Arogya Rice & Packaged Meals Ltd",
      industry: "Food & Beverage / FMCG",
      location: "Karnal, Haryana, India",
      headcount: "180 employees",
      matchScore: 95,
      contactStatus: "Verified Work Email",
      sourceProof: "APEDA registered exporter directory & corporate website",
      tags: ["Managing Director", "Food Processing", "Ready-to-Eat Rice", "FMCG"],
    },
    {
      id: "5",
      name: "Kavita Deshmukh",
      designation: "Head of Sourcing & Supply Chain",
      company: "Veda Fresh Foods",
      industry: "Packaged Goods / Agri-Food",
      location: "Pune, Maharashtra, India",
      headcount: "95 employees",
      matchScore: 93,
      contactStatus: "Verified Work Email",
      sourceProof: "Corporate leadership page & food industry summit panelist",
      tags: ["Head of Sourcing", "Packaged Meals", "Supply Chain"],
    },
  ],
  healthcare: [
    {
      id: "6",
      name: "Marcus Vance",
      designation: "Chief Financial Officer",
      company: "Aura Health Solutions",
      industry: "Digital Health / Medical",
      location: "San Francisco, CA, USA",
      headcount: "210 employees",
      matchScore: 97,
      contactStatus: "Verified Work Email",
      sourceProof: "SEC 10-Q filing executive list & healthcare tech index",
      tags: ["CFO", "Series B", "Digital Health"],
    },
    {
      id: "7",
      name: "Elena Rostova",
      designation: "VP Operations",
      company: "Synapse Clinical",
      industry: "Healthcare SaaS",
      location: "San Diego, CA, USA",
      headcount: "85 employees",
      matchScore: 92,
      contactStatus: "MX Handshake Checked",
      sourceProof: "Official press release on clinical trial platform expansion",
      tags: ["VP Operations", "Clinical Trials", "California"],
    },
  ],
};

function HeroSection() {
  const [mode, setMode] = useState<"people" | "companies" | "customers">("people");
  const [activeQueryKey, setActiveQueryKey] = useState<"saas" | "rice" | "healthcare">("saas");
  const [emailInput, setEmailInput] = useState("");
  const navigate = useNavigate();

  const handleHeroSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (emailInput.trim()) {
      navigate(`/signup?email=${encodeURIComponent(emailInput.trim())}`);
    } else {
      navigate("/signup");
    }
  };

  const sampleResults = HERO_SAMPLE_RESULTS[activeQueryKey] ?? HERO_SAMPLE_RESULTS.saas;

  return (
    <section className="relative overflow-hidden bg-ink-50 pt-14 pb-20 text-white sm:pt-20 sm:pb-24">
      {/* Warm glow behind the headline; decorative only. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[520px] max-w-4xl rounded-full bg-brand-500/25 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex justify-center">
          <a href="#developers" className="group inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition hover:border-white/30">
            <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">New</span>
            <span>Scout now runs inside Claude Code and Cursor, with one command</span>
            <ArrowRightIcon className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
          </a>
        </div>

        <div className="mx-auto mt-7 max-w-4xl text-center">
          <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            Pipeline from the live web.{" "}
            <span className="bg-brand-gradient bg-clip-text text-transparent">For your reps and your agents.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            Describe the customer you want in plain English. Scout finds the people and companies that match from live sources, finds and verifies their work email, tells you why each one fits, and runs the outreach. Use it in the app, over the API, or straight from your AI assistant.
          </p>

          <form onSubmit={handleHeroSubmit} className="mx-auto mt-8 flex max-w-md flex-col items-center justify-center gap-2 sm:flex-row">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="Enter your work email"
              className="w-full rounded-lg border border-white/15 bg-white/[0.07] px-4 py-3 text-sm text-white placeholder:text-white/40 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/30"
              aria-label="Work email"
            />
            <button type="submit" className="btn-primary w-full whitespace-nowrap px-6 py-3 text-sm font-semibold shadow-glow sm:w-auto">
              Find my first leads
            </button>
          </form>
          <div className="mt-3 text-xs text-white/50">Free plan to start · No card needed · Every lead comes with the reason it matches</div>

          <div className="mx-auto mt-8 grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 text-left sm:grid-cols-4">
            {[
              { k: "Live", v: "web and registry discovery, not a resold list" },
              { k: "Verified", v: "work emails; a known-bad address is never sent to" },
              { k: "60+", v: "tools for Claude and Cursor over hosted MCP" },
              { k: "2,000+", v: "businesses served by MNB Research" },
            ].map((x) => (
              <div key={x.k} className="bg-ink-50/90 p-4">
                <div className="text-lg font-bold text-white">{x.k}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-white/55">{x.v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Centerpiece Interactive Scout Search Dashboard */}
        <div className="mt-12 rounded-2xl border border-black/10 bg-surface shadow-xl p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/5">
            <div className="flex items-center gap-2">
              <span className="flex h-3 w-3 rounded-full bg-red-400" />
              <span className="flex h-3 w-3 rounded-full bg-amber-400" />
              <span className="flex h-3 w-3 rounded-full bg-emerald-400" />
              <span className="ml-2 font-mono text-xs font-semibold text-ink-400">
                MNB Scout · Lead discovery console
              </span>
            </div>

            {/* Mode Selector */}
            <div className="flex items-center rounded-lg bg-black/[0.04] p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setMode("people")}
                className={`rounded-md px-3 py-1 transition ${
                  mode === "people" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300 hover:text-ink-50"
                }`}
              >
                People
              </button>
              <button
                type="button"
                onClick={() => setMode("companies")}
                className={`rounded-md px-3 py-1 transition ${
                  mode === "companies" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300 hover:text-ink-50"
                }`}
              >
                Companies
              </button>
              <button
                type="button"
                onClick={() => setMode("customers")}
                className={`rounded-md px-3 py-1 transition ${
                  mode === "customers" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300 hover:text-ink-50"
                }`}
              >
                Potential Customers
              </button>
            </div>
          </div>

          {/* Natural Language Prompt Box */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-ink-400">
                Natural Language Prospecting Query
              </label>
              <span className="text-[11px] text-ink-400">Click a preset to test Scout&apos;s semantic breakdown:</span>
            </div>

            {/* Clickable Preset Pills */}
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={() => setActiveQueryKey("saas")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  activeQueryKey === "saas"
                    ? "border-brand-500 bg-brand-50 text-brand-800"
                    : "border-black/10 bg-cream/50 text-ink-300 hover:border-black/20"
                }`}
              >
                &quot;Founders of Indian SaaS companies with 20-200 staff&quot;
              </button>
              <button
                type="button"
                onClick={() => setActiveQueryKey("rice")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  activeQueryKey === "rice"
                    ? "border-brand-500 bg-brand-50 text-brand-800"
                    : "border-black/10 bg-cream/50 text-ink-300 hover:border-black/20"
                }`}
              >
                &quot;Rice meal manufacturers and ready-to-eat food brands in India&quot;
              </button>
              <button
                type="button"
                onClick={() => setActiveQueryKey("healthcare")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  activeQueryKey === "healthcare"
                    ? "border-brand-500 bg-brand-50 text-brand-800"
                    : "border-black/10 bg-cream/50 text-ink-300 hover:border-black/20"
                }`}
              >
                &quot;CFOs of healthcare tech companies in California&quot;
              </button>
            </div>

            <div className="relative">
              <div className="flex items-center gap-3 rounded-xl border border-black/15 bg-white px-4 py-3 shadow-xs">
                <SearchIcon className="h-5 w-5 text-brand-600 shrink-0" />
                <div className="flex-1 font-mono text-xs sm:text-sm text-ink-50 truncate">
                  {activeQueryKey === "saas" && "Find founders and CEOs of Indian SaaS companies with 20–200 employees"}
                  {activeQueryKey === "rice" && "Find rice meal manufacturers and ready-to-eat packaged food brands in India"}
                  {activeQueryKey === "healthcare" && "Find CFOs and VP Operations at healthcare software companies in California"}
                </div>
                <Link to="/signup" className="btn-primary text-xs py-2 px-4 shrink-0 font-semibold">
                  Discover Leads
                </Link>
              </div>
            </div>
          </div>

          {/* Dynamic Filter Pills */}
          <div className="mt-4 flex flex-wrap items-center gap-2 pt-3 border-t border-black/5 text-xs">
            <span className="font-semibold text-ink-400">Targeting Rules Extracted:</span>
            {activeQueryKey === "saas" && (
              <>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Roles: Founder, CEO</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Industry: B2B Software / SaaS</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Size: 20-200 Staff</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Location: India</span>
              </>
            )}
            {activeQueryKey === "rice" && (
              <>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Roles: Managing Director, Owner, Head of Sourcing</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Industry: Food & Beverage / FMCG / Packaged Foods</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Keywords: rice meals, ready to eat, food processing</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Location: India</span>
              </>
            )}
            {activeQueryKey === "healthcare" && (
              <>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Roles: CFO, VP Operations</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Industry: Healthcare / Medical Technology</span>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Location: California, USA</span>
              </>
            )}
            <span className="ml-auto text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              Live Web Discovery · Zero Stale Exports
            </span>
          </div>

          {/* Dynamic Result Preview Cards */}
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between text-xs text-ink-400 pb-1">
              <span className="font-semibold text-ink-50">Discovered Prospects Preview</span>
              <span className="font-mono text-[11px]">Simulated Interactive Demo · Real Discovery on Sign In</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sampleResults.map((p) => (
                <div
                  key={p.id}
                  className="rounded-xl border border-black/10 bg-cream/40 p-4 transition hover:border-brand-300 hover:shadow-sm flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="font-bold text-sm text-ink-50">{p.name}</h4>
                        <div className="text-xs font-medium text-brand-700">{p.designation}</div>
                        <div className="text-xs text-ink-400">{p.company}</div>
                      </div>
                      <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                        {p.matchScore}% Fit
                      </span>
                    </div>

                    <div className="mt-3 space-y-1.5 text-xs text-ink-300 border-t border-black/5 pt-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-400">Location:</span>
                        <span className="font-medium text-ink-100">{p.location}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-400">Headcount:</span>
                        <span className="font-medium text-ink-100">{p.headcount}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-400">Email Status:</span>
                        <span className="font-medium text-emerald-700 flex items-center gap-1">
                          <CheckIcon className="h-3 w-3" /> {p.contactStatus}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2.5 rounded bg-black/[0.03] p-2 text-[10px] text-ink-400 leading-snug">
                      <strong className="text-ink-50">Proof:</strong> {p.sourceProof}
                    </div>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-black/5 flex items-center justify-between gap-2">
                    <Link to="/signup" className="text-[11px] font-semibold text-brand-600 hover:underline">
                      View Full Dossier →
                    </Link>
                    <span className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-ink-400">
                      Sample Data
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-black/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-ink-400">
            <div>
              Every result includes source proof, company registry validation, and MX deliverability checks before contacting.
            </div>
            <Link to="/signup" className="btn-primary text-xs py-2 px-5 font-semibold shrink-0">
              Launch Real Search in Scout →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 3: WHAT CAN YOU FIND WITH SCOUT?
   ========================================================================= */

function WhatCanYouFindSection() {
  const cards = [
    {
      title: "People & Decision-Makers",
      badge: "Targeted Individuals",
      description:
        "Discover founders, C-suite executives, senior managers, technical specialists, and key commercial decision-makers. Target by exact title, seniority, responsibilities, and geographic jurisdiction.",
      example: "e.g. Chief Technology Officers, Heads of Sourcing, VP Revenue Operations, Medical Directors.",
      icon: <UsersIcon className="h-5 w-5 text-brand-600" />,
    },
    {
      title: "Companies & Organisations",
      badge: "Account Discovery",
      description:
        "Discover startups, enterprises, regional manufacturers, digital agencies, and specialized service providers. Target by business category, technology stack, hiring sprees, and verified websites.",
      example: "e.g. Indian D2C food brands, B2B software scaleups, commercial solar installers, logistics 3PLs.",
      icon: <BuildingIcon className="h-5 w-5 text-brand-600" />,
    },
    {
      title: "Potential Customers & High Intent",
      badge: "Active Buying Signals",
      description:
        "Identify high-intent prospects entering active buying cycles using public announcements, open job requisitions, competitor customer references, and first-party visitor telemetry.",
      example: "e.g. Companies actively hiring for roles you replace, or scaling their outbound infrastructure.",
      icon: <TargetIcon className="h-5 w-5 text-brand-600" />,
    },
    {
      title: "Custom Audiences & Micro-Niches",
      badge: "Hyper-Targeted Segments",
      description:
        "Build precise audience segments combining dozens of multi-dimensional criteria: headcount ranges, installed software, revenue indicators, recent leadership changes, and negative exclusion lists.",
      example: "e.g. Ready-to-eat food brands in India with >50 staff, excluding previous customer domains.",
      icon: <DatabaseIcon className="h-5 w-5 text-brand-600" />,
    },
  ];

  return (
    <section id="product" className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-3xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Comprehensive Discovery Scope
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          One platform for finding, checking and reaching prospects
        </h2>
        <p className="mt-3 text-sm sm:text-base text-ink-300 leading-relaxed">
          Scout moves far beyond static email directories. Search across people, companies, high-intent buyers, and bespoke audience segments using one unified intelligence engine.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {cards.map((c) => (
          <div
            key={c.title}
            className="card p-6 sm:p-7 flex flex-col justify-between border-black/[0.08] hover:border-brand-300 transition-all hover:shadow-md"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 border border-brand-200">
                  {c.icon}
                </div>
                <span className="rounded bg-black/[0.05] px-2 py-0.5 text-[10px] font-bold text-ink-400 uppercase tracking-wide">
                  {c.badge}
                </span>
              </div>
              <h3 className="text-lg font-bold text-ink-50">{c.title}</h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-300 leading-relaxed">{c.description}</p>
            </div>
            <div className="mt-5 pt-3.5 border-t border-black/5 text-xs text-brand-800 bg-brand-50/40 rounded-lg p-2.5 font-medium">
              <strong className="text-ink-50">Discovery Example:</strong> {c.example}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 4: DESCRIBE YOUR IDEAL CUSTOMER (CUSTOM FILTER BUILDER)
   ========================================================================= */

function CustomFilterBuilderSection() {
  const [activeTab, setActiveTab] = useState<"natural" | "structured">("natural");
  const [selectedIndustry, setSelectedIndustry] = useState("Food & Beverage / FMCG");
  const [selectedLocation, setSelectedLocation] = useState("India (Delhi, Mumbai, Bengaluru, Pune)");
  const [selectedSize, setSelectedSize] = useState("20–200 Employees");
  const [selectedSeniority, setSelectedSeniority] = useState("Founder, Managing Director, Owner, Head of Sourcing");
  const [selectedKeywords, setSelectedKeywords] = useState("rice meals, ready to eat, packaged food");

  return (
    <section id="find-leads" className="py-20 border-y border-black/5 bg-cream/40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Unrestricted Targeting Freedom
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            Your Search. Your Rules. Your Ideal Audience.
          </h2>
          <p className="mt-3 text-sm sm:text-base text-ink-300 leading-relaxed">
            Never settle for generic pre-packaged lists. Tell Scout your exact requirements in plain conversational language, or combine fine-grained filters with inclusion/exclusion logic.
          </p>
        </div>

        <div className="rounded-2xl border border-black/10 bg-surface shadow-lg overflow-hidden">
          {/* Header Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-black/10 bg-cream/70 px-6 py-4 gap-3">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-ink-400">
                Advanced Audience Builder
              </span>
              <div className="text-sm font-semibold text-ink-50 mt-0.5">
                Convert Natural Intent into Production-Grade Targeting Rules
              </div>
            </div>
            <div className="flex items-center rounded-lg bg-black/[0.04] p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab("natural")}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "natural" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300"
                }`}
              >
                AI Prompt Mode
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("structured")}
                className={`rounded-md px-3 py-1.5 transition ${
                  activeTab === "structured" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300"
                }`}
              >
                Structured Criteria Builder
              </button>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            {activeTab === "natural" ? (
              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-2">
                    Plain English Target Description
                  </label>
                  <div className="rounded-xl border border-brand-300 bg-brand-50/20 p-4 font-mono text-sm text-ink-50 leading-relaxed">
                    &quot;I want decision-makers at Indian food brands and manufacturers specializing in rice meals, ready-to-eat foods, and FMCG products with 20 to 200 employees.&quot;
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs font-semibold text-brand-700">
                  <SparklesIcon className="h-4 w-4" />
                  <span>Scout AI Semantic Engine converts this into structured targeting criteria:</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-xl border border-black/10 bg-surface p-3.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 block mb-1">
                      Roles & Seniority
                    </span>
                    <div className="font-semibold text-xs text-ink-50">
                      Founder, Co-Founder, Managing Director, Owner, Head of Sourcing
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/10 bg-surface p-3.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 block mb-1">
                      Industries
                    </span>
                    <div className="font-semibold text-xs text-ink-50">
                      Food & Beverage, FMCG, Packaged Foods, Food Processing
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/10 bg-surface p-3.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 block mb-1">
                      Keywords
                    </span>
                    <div className="font-semibold text-xs text-ink-50">
                      rice meals, ready to eat, food processing, FMCG
                    </div>
                  </div>
                  <div className="rounded-xl border border-black/10 bg-surface p-3.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 block mb-1">
                      Geography
                    </span>
                    <div className="font-semibold text-xs text-ink-50">
                      India (National & Regional Hubs)
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Industry / Category
                  </label>
                  <input
                    type="text"
                    value={selectedIndustry}
                    onChange={(e) => setSelectedIndustry(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Geography / Locations
                  </label>
                  <input
                    type="text"
                    value={selectedLocation}
                    onChange={(e) => setSelectedLocation(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Company Headcount
                  </label>
                  <input
                    type="text"
                    value={selectedSize}
                    onChange={(e) => setSelectedSize(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Designation / Seniority
                  </label>
                  <input
                    type="text"
                    value={selectedSeniority}
                    onChange={(e) => setSelectedSeniority(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Commercial Keywords
                  </label>
                  <input
                    type="text"
                    value={selectedKeywords}
                    onChange={(e) => setSelectedKeywords(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                    Negative Exclusions
                  </label>
                  <div className="rounded-lg border border-black/10 bg-black/[0.02] p-2 text-xs text-ink-400">
                    Existing clients, Unverified mailboxes, Competitors
                  </div>
                </div>
              </div>
            )}

            {/* Estimated Pool Bar */}
            <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-emerald-800">
                  Estimated Discoverable Opportunity Pool
                </div>
                <div className="text-sm font-semibold text-emerald-950 mt-0.5">
                  ~1,840 verified decision-makers across 390 operating businesses matching criteria
                </div>
              </div>
              <Link to="/signup" className="btn-primary text-xs px-5 py-2.5 font-semibold shrink-0 shadow-xs">
                Generate My Target Audience →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 5: HOW SCOUT WORKS
   ========================================================================= */

function HowScoutWorksSection() {
  const steps = [
    {
      n: "01",
      title: "Describe",
      desc: "Tell Scout what kind of people, companies, or customers you want to find using natural conversational language or structured filters.",
    },
    {
      n: "02",
      title: "Customise",
      desc: "Fine-tune industry categories, geographic locations, headcount ranges, specific seniority tiers, tech stack, and exclusion rules.",
    },
    {
      n: "03",
      title: "Discover",
      desc: "Scout queries live open-web sources, corporate registries, official job listings, and directories in real time to locate matching prospects.",
    },
    {
      n: "04",
      title: "Qualify & Act",
      desc: "Review transparent match fit scores (0–100), source evidence, and multi-tier verified business contact details. Export or launch outreach.",
    },
  ];

  return (
    <section id="how-it-works" className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Transparent Methodology
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          From an Idea to a Qualified Lead List in Minutes
        </h2>
        <p className="mt-3 text-sm text-ink-300">
          Four predictable steps. No opaque black boxes and no recycled databases.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {steps.map((s) => (
          <div
            key={s.n}
            className="card p-6 flex flex-col justify-between border-black/[0.08] hover:border-brand-300 transition-all hover:shadow-md"
          >
            <div>
              <span className="font-mono text-2xl font-black text-brand-600 block mb-3">
                {s.n}
              </span>
              <h3 className="text-base font-bold text-ink-50">{s.title}</h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-300 leading-relaxed">{s.desc}</p>
            </div>
            <div className="mt-5 pt-3 border-t border-black/5 text-[11px] font-mono text-ink-400">
              Deterministic verification
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 6: AI-POWERED PROSPECT INTELLIGENCE
   ========================================================================= */

function ProspectIntelligenceSection() {
  return (
    <section className="py-20 border-y border-black/5 bg-cream/30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Context Beyond Contact Details
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            More Than Names. Understand Your Prospects.
          </h2>
          <p className="mt-3 text-sm sm:text-base text-ink-300 leading-relaxed">
            A verified email address is only valuable if you know why the prospect is relevant today. Scout surfaces the context, business signals, and fit breakdown behind every contact.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-center">
          {/* Left Feature Column */}
          <div className="space-y-4">
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Comprehensive Account Research</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Scout crawls official company websites to evaluate offerings, technology installations, hiring requisitions, and market focus.
              </p>
            </div>
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Multi-Tier Contact Verification</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Emails go through syntax checks, MX lookup, domain health and an SMTP probe, and each one is labelled valid, risky or invalid before you send.
              </p>
            </div>
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Signals & Leadership Tracking</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Detect when companies secure funding, launch major hiring surges, or when champions transition into new target accounts.
              </p>
            </div>
          </div>

          {/* Centerpiece Intelligence Dossier Card */}
          <div className="card p-6 sm:p-7 border-brand-300 ring-2 ring-brand-200/60 bg-surface shadow-xl">
            <div className="flex items-center justify-between pb-4 border-b border-black/5">
              <div>
                <span className="badge bg-brand-50 border border-brand-200 text-brand-700 text-[10px] font-bold uppercase">
                  Prospect Fit Score
                </span>
                <div className="text-3xl font-black text-brand-600 mt-1">92 / 100</div>
              </div>
              <span className="rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs font-bold text-emerald-800">
                Highly Qualified
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-ink-400">
                Fit Justification & Matched Rules
              </div>
              <ul className="space-y-2 text-xs text-ink-200">
                <li className="flex items-start gap-2">
                  <CheckIcon className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Matches target industry: Food & Beverage / FMCG manufacturing</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckIcon className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Located in specified regional geography (Haryana / NCR, India)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckIcon className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Verified decision-making designation: Managing Director & Owner</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckIcon className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Matches employee bracket: 180 employees (within 20–200 range)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckIcon className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>Buying signal detected: Active supply chain and export expansion</span>
                </li>
              </ul>
            </div>

            <div className="mt-6 pt-4 border-t border-black/5">
              <div className="text-xs text-ink-400">
                <strong className="text-ink-50">Verification Status:</strong> Primary MX verified via direct socket probe. Catch-all: False. Bounce risk: Low.
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-4">
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Checked when you find them</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Bought lists go stale while they sit in a spreadsheet. Scout looks people up from live sources when you search, and verifies the email before it goes into a campaign.
              </p>
            </div>
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Algorithmic Deliverability Defense</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Sending warms up gradually and halts automatically when bounces climb, so a bad list cannot burn your sending domain.
              </p>
            </div>
            <div className="card p-5 border-black/[0.08]">
              <h4 className="font-bold text-sm text-ink-50">Audience Segmentation & Tags</h4>
              <p className="mt-1 text-xs text-ink-300 leading-relaxed">
                Tag leads by campaign, client, or segment. Easily sort by match score to focus your reps on top-tier opportunities first.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 7: INTENT-BASED LEAD DISCOVERY / PLAYS
   ========================================================================= */

function IntentPlaysSection() {
  const playCards = [
    {
      title: "Competitor Customer Displacement",
      badge: "Competitor Evidence",
      desc: "Discovers organizations named as customers in public case studies and testimonials of your direct competitors, catching buyers who already understand the problem.",
    },
    {
      title: "Hiring Surges in Your Selling Category",
      badge: "Hiring Spikes",
      desc: "Monitors live job listings for companies hiring the exact roles you empower or replace. Arrive when budget is actively allocated.",
    },
    {
      title: "Funding & Growth Announcements",
      badge: "Capital Allocation",
      desc: "Tracks verified seed, venture, and debt funding rounds to connect with founders and executives during strategic expansion.",
    },
    {
      title: "Public Requests & Category Demand",
      badge: "Open Inquiries",
      desc: "Surfaces public posts and discussions where professionals specifically ask for alternatives or recommendations in your industry.",
    },
  ];

  return (
    <section id="features" className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          High-Velocity Buying Windows
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          Find Opportunities When They Actually Happen
        </h2>
        <p className="mt-3 text-sm text-ink-300">
          Timing beats volume. Scout Plays continuously monitor live intent sources and deliver pre-qualified prospects straight to your review queue with source proof attached.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {playCards.map((p) => (
          <div key={p.title} className="card p-6 flex flex-col justify-between border-black/[0.08] hover:border-brand-300 transition hover:shadow-md">
            <div>
              <span className="rounded bg-brand-50 text-brand-800 border border-brand-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider block w-fit mb-3">
                {p.badge}
              </span>
              <h3 className="text-base font-bold text-ink-50">{p.title}</h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-300 leading-relaxed">{p.desc}</p>
            </div>
            <div className="mt-5 pt-3 border-t border-black/5 text-[11px] text-ink-400 font-mono">
              Includes citation & URL proof
            </div>
          </div>
        ))}
      </div>

      {/* Review Queue Proof Box */}
      <div className="mt-8 card p-6 border-black/10 bg-cream/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-ink-400">
            Honest Intent Architecture
          </div>
          <p className="text-xs sm:text-sm text-ink-300 mt-1 max-w-2xl">
            Plays reads public pages and your own permitted data. Scout never logs in to personal social media accounts, never automates private profiles, and never buys decaying contact lists.
          </p>
        </div>
        <Link to="/signup" className="btn-primary text-xs px-5 py-2.5 font-semibold shrink-0">
          Explore Scout Plays →
        </Link>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 8: FROM LEAD DISCOVERY TO SALES EXECUTION
   ========================================================================= */

function SalesExecutionSection() {
  const executionPillars = [
    {
      title: "Research-Driven AI Email Drafting",
      desc: "Drafts tailored cold emails generated from what Scout actually uncovered about the account, maintaining your distinct brand voice and value proposition.",
    },
    {
      title: "Buying Committee Multi-Threading",
      desc: "Maps the complete buying group (Champions, CFO Economic Buyers, SecOps, Legal) to safeguard against single-threaded deal stalls.",
    },
    {
      title: "Call Queue & Battlecards",
      desc: "Work a prioritised call list with objection battlecards beside each lead. Calls go out from your phone and the outcome is logged back to the lead.",
    },
    {
      title: "Digital Sales Rooms (DSR)",
      desc: "Give your champion a shared deal page with the proposal, a mutual action plan and the next steps, and see when they open it.",
    },
    {
      title: "CRM & Sheets Export",
      desc: "Send leads to HubSpot, Pipedrive, Zoho CRM or Google Sheets, or to Zapier and Make by webhook.",
    },
    {
      title: "AI Search Visibility",
      desc: "See whether AI assistants name your company when buyers ask about your category. Sampled on Gemini and Llama today.",
    },
    {
      title: "Autopilot Saved Searches",
      desc: "Run searches on a recurring background schedule. Scout continuously watches for new prospects and adds only new matches to your list.",
    },
  ];

  return (
    <section className="py-20 border-y border-black/5 bg-surface">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Complete Revenue Motion
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            Finding Leads Is Just the Beginning
          </h2>
          <p className="mt-3 text-sm text-ink-300">
            Convert discovered prospects into qualified pipeline without subscribing to five separate point solutions.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {executionPillars.map((p) => (
            <div key={p.title} className="card p-6 border-black/[0.08] hover:border-brand-300 transition">
              <h3 className="text-base font-bold text-ink-50">{p.title}</h3>
              <p className="mt-2 text-xs sm:text-sm text-ink-300 leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 9: WHO IS SCOUT FOR? (8 DEDICATED USE CASES)
   ========================================================================= */

function WhoIsScoutForSection() {
  const useCases = [
    {
      role: "B2B Sales Teams",
      desc: "Replace fragmented point tools. Search target accounts, identify decision-makers, verify emails, and multi-thread buying committees.",
      example: "e.g. SDRs booking meetings with VP Sales and RevOps leads at Series B SaaS companies.",
    },
    {
      role: "Marketing & Lead Gen Agencies",
      desc: "Manage multiple client prospecting campaigns from one workspace with partitioned lead lists and white-labeled reporting.",
      example: "e.g. Growth agencies delivering 50+ verified enterprise leads per month per client.",
    },
    {
      role: "Recruitment & Executive Search",
      desc: "Discover specialized candidates and executives matching exact professional criteria, seniority levels, and domain experience.",
      example: "e.g. Sourcing Principal Machine Learning Engineers and Heads of Product across Europe.",
    },
    {
      role: "Startup Founders & GTM Teams",
      desc: "Identify your first 100 enterprise customers and build targeted custom audiences without expensive annual lock-in contracts.",
      example: "e.g. Seed-stage founders reaching CFOs at mid-market companies to validate new solutions.",
    },
    {
      role: "Consultants & Professional Services",
      desc: "Connect with managing partners, directors, and business owners who require advisory, legal, or accounting expertise.",
      example: "e.g. Supply chain consultants targeting manufacturing directors at regional plants.",
    },
    {
      role: "Real Estate & Local Businesses",
      desc: "Discover commercial property developers, local business proprietors, and corporate tenants expanding into new territories.",
      example: "e.g. Commercial brokers connecting with expanding regional retail and warehouse owners.",
    },
    {
      role: "Education Consultants",
      desc: "Organise and target institutional partners, school administrators, and international admissions directors using verified public data.",
      example: "e.g. Edtech consultants reaching university department heads and vocational program leaders.",
    },
    {
      role: "Enterprise Revenue Organizations",
      desc: "Deploy autonomous prospect discovery across global divisions with row-level security, REST API integration, and audit logging.",
      example: "e.g. Global enterprise sales teams identifying and engaging 10+ stakeholders per opportunity.",
    },
  ];

  return (
    <section id="use-cases" className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-3xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Built For Modern Teams
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          Who Is Scout For?
        </h2>
        <p className="mt-3 text-sm sm:text-base text-ink-300 leading-relaxed">
          From solo founders to global lead generation agencies, Scout delivers custom prospect intelligence tailored to your operational model.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {useCases.map((u) => (
          <div key={u.role} className="card p-5 flex flex-col justify-between border-black/[0.08] hover:border-brand-300 transition">
            <div>
              <span className="font-bold text-sm text-ink-50 block">{u.role}</span>
              <p className="mt-2 text-xs text-ink-300 leading-relaxed">{u.desc}</p>
            </div>
            <div className="mt-4 pt-3 border-t border-black/5 text-[11px] text-brand-800 font-medium">
              {u.example}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 10: AGENCY WORKSPACE
   ========================================================================= */

function AgencyWorkspaceSection() {
  const agencyFeatures = [
    { title: "Separate Client Profiles", desc: "Each client has its own dedicated ICP, search history, custom targeting rules, and lead lists." },
    { title: "Monthly Targets & Pace", desc: "Set monthly lead delivery quotas per client. Scout calculates pace to ensure your team hits every deliverable on time." },
    { title: "Smart Lead Routing", desc: "Assign or move leads between clients in bulk. Discovered contacts are automatically deduplicated across client accounts." },
    { title: "Shareable Read-Only Reports", desc: "Provide clients with tokenized report links. Clients see delivered counts and verified proof without accessing your database." },
  ];

  return (
    <section id="agencies" className="py-20 border-y border-black/5 bg-cream/40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Agency Infrastructure
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            One Scout workspace for every client you run
          </h2>
          <p className="mt-3 text-sm sm:text-base text-ink-300 leading-relaxed">
            Eliminate chaotic spreadsheets and multiple logins. Run lead generation for all your clients from one centralized, collaborative agency dashboard.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {agencyFeatures.map((f) => (
            <div key={f.title} className="card p-6 border-black/[0.08] bg-surface flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-sm text-ink-50">{f.title}</h3>
                <p className="mt-2 text-xs text-ink-300 leading-relaxed">{f.desc}</p>
              </div>
              <div className="mt-4 pt-3 border-t border-black/5 text-[11px] text-brand-700 font-mono">
                Included in Growth & Scale
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link to="/signup" className="btn-primary text-xs px-6 py-3 font-semibold shadow-xs">
            Start Your Agency Workspace →
          </Link>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 11: INTEGRATIONS AND AUTOMATION
   ========================================================================= */

function IntegrationsSection() {
  const steps = [
    { title: "Scout Discovery", desc: "AI natural language search queries live web surfaces." },
    { title: "Waterfall Enrichment", desc: "Multi-tier email verification & company data crawling." },
    { title: "CRM Sync", desc: "Bi-directional push into HubSpot, Pipedrive, or Zoho." },
    { title: "Outreach & Sequences", desc: "AI-researched emails & phone dialer execution." },
    { title: "Revenue Pipeline", desc: "Track replies, meetings, and closed-won deals." },
  ];

  return (
    <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Seamless Workflow
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          Connect Your Entire Sales Workflow
        </h2>
        <p className="mt-3 text-sm text-ink-300">
          Scout connects directly with your revenue tech stack. Discovered leads flow smoothly into your existing pipelines.
        </p>
      </div>

      {/* Visual Workflow Pipeline */}
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 mb-12">
        {steps.map((st, i) => (
          <div key={st.title} className="rounded-xl border border-black/10 bg-cream/30 p-4 text-center relative flex flex-col justify-between">
            <div>
              <span className="font-mono text-xs font-bold text-brand-600 block mb-1">Step 0{i + 1}</span>
              <h3 className="font-bold text-xs text-ink-50">{st.title}</h3>
              <p className="mt-1 text-[11px] text-ink-400 leading-snug">{st.desc}</p>
            </div>
            {i < 4 && (
              <div className="hidden sm:block absolute -right-2 top-1/2 -translate-y-1/2 z-10 text-ink-300">
                →
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Integration Badges */}
      <div className="flex flex-wrap items-center justify-center gap-4 text-xs font-semibold text-ink-300">
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">HubSpot CRM</span>
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">Pipedrive</span>
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">Zoho CRM</span>
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">Google Sheets</span>
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">Zapier & Make Webhooks</span>
        <span className="rounded-lg border border-black/10 bg-surface px-4 py-2">REST API & MCP Server for AI Agents</span>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 11b: DEVELOPERS AND AI AGENTS
   One key, four surfaces. Every snippet here is a real command against the real API: the
   hosted MCP endpoint is apps/api/src/routes/mcp.ts, the REST calls are in openapi.ts.
   ========================================================================= */

const DEV_SNIPPETS: Record<string, { label: string; code: string }> = {
  claude: {
    label: "Claude Code",
    code: `claude mcp add --transport http scout ${API_URL}/mcp \\\n  --header "Authorization: Bearer px_live_..."\n\n# then, in Claude Code:\n> Find 25 heads of procurement at Indian textile mills,\n  verify their emails and draft a first touch for each.`,
  },
  cursor: {
    label: "Cursor / Claude Desktop",
    code: JSON.stringify({ mcpServers: { scout: { url: `${API_URL}/mcp`, headers: { Authorization: "Bearer px_live_..." } } } }, null, 2),
  },
  rest: {
    label: "REST",
    code: `curl -X POST ${API_URL}/v1/agent/prospect \\\n  -H "x-api-key: px_live_..." -H "content-type: application/json" \\\n  -d '{"query":"heads of growth at Series A fintechs in Bengaluru","limit":10}'`,
  },
  clay: {
    label: "Clay / n8n / Make",
    code: `# Any "HTTP request" step can call Scout per row.\nPOST ${API_URL}/v1/search/verify\nx-api-key: px_live_...\ncontent-type: application/json\n\n{ "email": "{{Work Email}}" }`,
  },
};

function DevelopersSection() {
  const [tab, setTab] = useState<keyof typeof DEV_SNIPPETS>("claude");
  const cards = [
    { t: "Hosted MCP", d: "Claude Code, Cursor and Claude Desktop get 60+ Scout tools with one command. Nothing to install, nothing to host. Growth plan and above." },
    { t: "REST API + OpenAPI", d: "Every action in the app is an endpoint, documented at /docs. Long jobs return a job id to poll." },
    { t: "TypeScript SDK", d: "Typed client for every route, with ids and domains validated before a request is made." },
    { t: "Webhooks + CRM sync", d: "Signed events for new leads and replies, plus HubSpot, Pipedrive, Zoho and Google Sheets." },
  ];
  return (
    <section id="developers" className="scroll-mt-20 border-y border-white/5 bg-ink-50 py-20 text-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:items-center">
        <div>
          <span className="inline-flex rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-xs font-semibold text-white/80">For developers and AI agents</span>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">One API key. Your reps, your scripts and your agents.</h2>
          <p className="mt-4 text-sm leading-relaxed text-white/65">
            Contact-data APIs stop at a JSON record. Scout gives an agent the whole motion: find the right accounts from live sources, find and verify the people, explain why each one fits, write the sequence, and sync the CRM. The key carries your plan limits and its own scope, so a read-only key can research and can never send.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {cards.map((c) => (
              <div key={c.t} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                <div className="text-sm font-semibold">{c.t}</div>
                <div className="mt-1 text-xs leading-relaxed text-white/55">{c.d}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <Link to="/signup" className="btn-primary px-5 py-2.5 font-semibold">Get an API key</Link>
            <a href={`${API_URL}/docs`} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-white/20 px-5 py-2.5 font-semibold text-white/85 hover:border-white/40">Read the API docs</a>
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/40 shadow-glow">
          <div className="flex flex-wrap gap-1 border-b border-white/10 p-2" role="tablist" aria-label="Integration">
            {(Object.keys(DEV_SNIPPETS) as (keyof typeof DEV_SNIPPETS)[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${tab === k ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"}`}
              >
                {DEV_SNIPPETS[k].label}
              </button>
            ))}
          </div>
          <pre className="max-w-full overflow-x-auto p-5 text-[12px] leading-relaxed text-emerald-200"><code>{DEV_SNIPPETS[tab].code}</code></pre>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 12: PRODUCT DIFFERENTIATION MATRIX
   ========================================================================= */

function DifferentiationMatrixSection() {
  // Columns are categories, not named vendors: a claim about somebody else's product is one
  // we cannot keep true. Rows where Scout does NOT lead are kept on purpose.
  const COMPARE_COLS = ["MNB Scout", "Contact-data APIs", "Static B2B databases", "Point email finders"];
  const matrix = [
    { capability: "Natural-language search for people and companies", cells: [true, false, "varies", false] },
    { capability: "Live web and registry discovery, not a resold static list", cells: [true, false, false, false] },
    { capability: "Works outside the US: India, SEA, the Middle East, SMBs and commodity trades", cells: [true, "varies", "varies", "varies"] },
    { capability: "A reason on every lead: the sentence and source that make it a match", cells: [true, false, false, false] },
    { capability: "Work-email finding with verification before sending", cells: [true, true, "varies", true] },
    { capability: "Intent plays: hiring, funding, competitor customers, job changes", cells: [true, false, "varies", false] },
    { capability: "Sequences, CRM sync, dialer and deal rooms in the same product", cells: [true, false, "varies", false] },
    { capability: "Hosted MCP for Claude Code and Cursor, plus REST and SDK", cells: [true, "varies", "varies", false] },
    { capability: "A web app your reps can use, not only an API", cells: [true, false, true, true] },
    { capability: "Agency client workspaces and branded client reports", cells: [true, false, false, false] },
    { capability: "Carrier-verified mobile numbers", cells: [false, "varies", "varies", false] },
    { capability: "Flat-price unlimited lookups", cells: [false, "varies", false, false] },
  ];

  return (
    <section id="compare" className="py-20 border-y border-black/5 bg-cream/30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Honest comparison
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            Data APIs sell records. Scout delivers pipeline.
          </h2>
          <p className="mt-3 text-sm text-ink-300">
            Contact-data APIs and static databases hand you a row and leave the rest to you. Scout finds the accounts from live sources, explains why each one fits and runs the outreach. Where we do not lead yet, the table says so.
          </p>
        </div>

        <div className="card overflow-x-auto p-0 border-black/10 shadow-sm">
          <table className="w-full min-w-[680px] text-xs">
            <thead>
              <tr className="border-b border-black/10 bg-cream">
                <th className="px-5 py-3.5 text-left font-semibold text-ink-400 uppercase tracking-wide">
                  Capability
                </th>
                {COMPARE_COLS.map((c) => (
                  <th
                    key={c}
                    className={`px-4 py-3.5 text-center font-semibold uppercase tracking-wide ${
                      c === "MNB Scout" ? "bg-brand-50/80 text-brand-800 font-bold" : "text-ink-400"
                    }`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 bg-surface">
              {matrix.map((row) => (
                <tr key={row.capability} className="hover:bg-black/[0.01]">
                  <td className="px-5 py-3 font-medium text-ink-50">{row.capability}</td>
                  {row.cells.map((cell, idx) => (
                    <td
                      key={idx}
                      className={`px-4 py-3 text-center ${idx === 0 ? "bg-brand-50/30" : ""}`}
                    >
                      {cell === true ? (
                        <span className="font-bold text-brand-600">✓</span>
                      ) : cell === "varies" ? (
                        <span className="text-ink-400 italic">Varies</span>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 13: INTERACTIVE PRODUCT DEMO
   ========================================================================= */

function InteractiveProductDemoSection() {
  const [targetType, setTargetType] = useState<"people" | "companies" | "audiences">("people");
  const [queryInput, setQueryInput] = useState("Rice meal manufacturers and ready-to-eat brands in India");
  const [activeTab, setActiveTab] = useState<"results" | "dossier">("results");
  const [discovered, setDiscovered] = useState(true);

  const handleRunDemo = () => {
    setDiscovered(false);
    setTimeout(() => {
      setDiscovered(true);
    }, 400);
  };

  return (
    <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Interactive Simulation
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          Try Finding Your Ideal Prospects
        </h2>
        <p className="mt-3 text-sm text-ink-300">
          A worked example with sample data: how Scout turns a sentence into targeting criteria and matches. Your results come from live sources.
        </p>
      </div>

      <div className="card border-black/10 shadow-lg p-6 sm:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Controls Column */}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                Step 1: Target Entity Type
              </label>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/[0.04] p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setTargetType("people")}
                  className={`py-1.5 rounded text-center transition ${
                    targetType === "people" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300"
                  }`}
                >
                  People
                </button>
                <button
                  type="button"
                  onClick={() => setTargetType("companies")}
                  className={`py-1.5 rounded text-center transition ${
                    targetType === "companies" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300"
                  }`}
                >
                  Companies
                </button>
                <button
                  type="button"
                  onClick={() => setTargetType("audiences")}
                  className={`py-1.5 rounded text-center transition ${
                    targetType === "audiences" ? "bg-white text-ink-50 shadow-xs" : "text-ink-300"
                  }`}
                >
                  Audiences
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                Step 2: Natural Language Query
              </label>
              <textarea
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                rows={3}
                className="input text-xs w-full resize-none"
                placeholder="Describe who you want to discover..."
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-400">
                Step 3: Sample Presets
              </label>
              <button
                type="button"
                onClick={() => setQueryInput("Rice meal manufacturers and ready-to-eat brands in India")}
                className="w-full text-left rounded-lg border border-black/10 bg-cream/40 px-3 py-2 text-xs font-medium text-ink-300 hover:border-black/20"
              >
                Rice meal brands in India
              </button>
              <button
                type="button"
                onClick={() => setQueryInput("Founders of Indian D2C brands with 20-200 staff")}
                className="w-full text-left rounded-lg border border-black/10 bg-cream/40 px-3 py-2 text-xs font-medium text-ink-300 hover:border-black/20"
              >
                D2C brand founders in India
              </button>
              <button
                type="button"
                onClick={() => setQueryInput("CFOs of healthcare SaaS companies in California")}
                className="w-full text-left rounded-lg border border-black/10 bg-cream/40 px-3 py-2 text-xs font-medium text-ink-300 hover:border-black/20"
              >
                Healthcare CFOs in California
              </button>
            </div>

            <button
              type="button"
              onClick={handleRunDemo}
              className="btn-primary w-full py-2.5 text-xs font-semibold shadow-xs"
            >
              Discover Matching Prospects →
            </button>
          </div>

          {/* Results Column */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between border-b border-black/5 pb-2 text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveTab("results")}
                  className={`font-semibold ${activeTab === "results" ? "text-brand-700 underline" : "text-ink-400"}`}
                >
                  Matching Results
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => setActiveTab("dossier")}
                  className={`font-semibold ${activeTab === "dossier" ? "text-brand-700 underline" : "text-ink-400"}`}
                >
                  Matched Criteria Dossier
                </button>
              </div>
              <span className="font-mono text-[11px] text-ink-400">Simulated Results Demo</span>
            </div>

            {discovered ? (
              activeTab === "results" ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-black/10 bg-cream/30 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-bold text-sm text-ink-50">Rajesh Singhania</h4>
                        <div className="text-xs font-medium text-brand-700">Managing Director & Co-Founder</div>
                        <div className="text-xs text-ink-400">Arogya Rice & Packaged Meals Ltd · Karnal, Haryana, India</div>
                      </div>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
                        95% Match
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Managing Director</span>
                      <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Food Processing / Rice Meals</span>
                      <span className="rounded bg-emerald-50 text-emerald-800 px-2 py-0.5 font-medium">Verified Business Email</span>
                    </div>
                    <p className="mt-2 text-xs text-ink-400">
                      <strong>Relevance proof:</strong> APEDA official registered grain exporter registry & corporate product catalogue for ready-to-eat rice meals.
                    </p>
                  </div>

                  <div className="rounded-xl border border-black/10 bg-cream/30 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-bold text-sm text-ink-50">Kavita Deshmukh</h4>
                        <div className="text-xs font-medium text-brand-700">Head of Sourcing & Operations</div>
                        <div className="text-xs text-ink-400">Veda Fresh Foods · Pune, India</div>
                      </div>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
                        93% Match
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Head of Sourcing</span>
                      <span className="rounded bg-black/[0.05] px-2 py-0.5 text-ink-300">Packaged Meals / FMCG</span>
                      <span className="rounded bg-emerald-50 text-emerald-800 px-2 py-0.5 font-medium">Verified Business Email</span>
                    </div>
                    <p className="mt-2 text-xs text-ink-400">
                      <strong>Relevance proof:</strong> FMCG brand registry and corporate sourcing announcement.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-black/10 bg-cream/30 p-5 space-y-3 text-xs">
                  <h4 className="font-bold text-sm text-ink-50">Why This Prospect Matches Your Query</h4>
                  <ul className="space-y-2 text-ink-300">
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-4 w-4 text-emerald-600" />
                      <span><strong>Target Industry:</strong> Matches Food & Beverage / FMCG / Packaged Meals.</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-4 w-4 text-emerald-600" />
                      <span><strong>Target Designation:</strong> Matches leadership decision-maker criteria (Managing Director / Owner).</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-4 w-4 text-emerald-600" />
                      <span><strong>Geography:</strong> Matches specified region (India).</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckIcon className="h-4 w-4 text-emerald-600" />
                      <span><strong>Deliverability:</strong> Passed MX and SMTP handshake validation.</span>
                    </li>
                  </ul>
                </div>
              )
            ) : (
              <div className="h-48 flex items-center justify-center font-mono text-xs text-ink-400">
                Searching live sources...
              </div>
            )}

            <div className="pt-3 border-t border-black/5 flex items-center justify-between text-xs">
              <span className="text-ink-400">Ready to run your real search?</span>
              <Link to="/signup" className="btn-primary text-xs py-2 px-4 font-semibold">
                Start Finding Leads →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 14: PRICING SECTION
   ========================================================================= */

function PricingSection() {
  const [plans, setPlans] = useState<Plan[]>(DEFAULT_PLANS);
  const [unreachable, setUnreachable] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => sendPageViewWhenSeen(sectionRef.current, "/pricing"), []);
  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("GET", "/v1/billing/plans")
      .then((r) =>
        setPlans(
          r.plans
            .filter((p) => p.id !== "pilot")
            .sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))
        )
      )
      .catch(() => setUnreachable(true));
  }, []);

  // Monthly only. An "annual, save 20%" switch used to sit here, but checkout sells one monthly
  // price per plan and /upgrade ignored ?billing=annual, so the discounted figure was a price
  // nobody could be charged. It would also take every plan under its 80% margin floor at full
  // use (packages/db/src/economics.ts). Annual terms are agreed, not self-served.
  const displayPrice = (p: Plan) => p.priceUsd;

  return (
    <section id="pricing" ref={sectionRef} className="py-20 border-y border-black/5 bg-cream/40 scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
            Predictable Pricing
          </span>
          <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
            Simple, Transparent Plans
          </h2>
          <p className="mt-3 text-sm text-ink-300 leading-relaxed">
            Test platform workflows and open-web discovery in our free sandbox. Paid plans include verified external provider credits and high-volume email verification.
          </p>

          <p className="mt-5 text-xs text-ink-400">Prices are per month, in US dollars. Paying yearly? <a href="mailto:contact@mnbresearch.com" className="font-semibold text-brand-600 hover:underline">Talk to us</a>.</p>
        </div>

        {plans.length === 0 ? (
          <div className="card mx-auto mt-10 max-w-lg p-8 text-center">
            <div className="font-semibold text-ink-50">
              {unreachable ? "Pricing could not be loaded just now" : "Updating plans"}
            </div>
            <p className="mt-2 text-xs text-ink-400">
              Please refresh or reach out directly to contact@mnbresearch.com for current pricing options.
            </p>
          </div>
        ) : (
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
            {plans.map((p) => {
              const featured = p.id === "growth";
              const isCustom = p.id === "enterprise";
              const price = displayPrice(p);
              return (
                <div
                  key={p.id}
                  className={`card relative flex flex-col p-6 transition-all hover:-translate-y-0.5 hover:shadow-lg ${
                    featured ? "border-brand-300 ring-2 ring-brand-200 bg-surface" : "border-black/[0.08] bg-surface"
                  }`}
                >
                  {featured && (
                    <span className="badge absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white text-[10px] font-bold uppercase tracking-wider">
                      Most Popular
                    </span>
                  )}
                  <div className="font-bold text-base text-ink-50">{p.name}</div>
                  <p className="mt-1 text-xs text-ink-400 min-h-[32px]">{PLAN_BLURB[p.id]}</p>
                  <div className="mt-4 pb-4 border-b border-black/5">
                    {p.priceUsd === 0 ? (
                      <div className="text-3xl font-extrabold text-ink-50">$0</div>
                    ) : isCustom ? (
                      <div>
                        <span className="text-xs text-ink-400">from </span>
                        <span className="text-3xl font-extrabold text-ink-50">${price.toLocaleString()}</span>
                        <span className="text-xs text-ink-400">/mo</span>
                      </div>
                    ) : (
                      <div>
                        <span className="text-3xl font-extrabold text-ink-50">${price.toLocaleString()}</span>
                        <span className="text-xs text-ink-400">/mo</span>
                      </div>
                    )}
                  </div>

                  <ul className="mt-5 flex-1 space-y-2.5 text-xs text-ink-300">
                    {planFeatures(p).map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <CheckIcon className="h-3.5 w-3.5 text-brand-600 shrink-0 mt-0.5" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <Link
                    to={p.priceUsd === 0 ? "/signup" : `/upgrade?plan=${p.id}`}
                    className={`mt-6 justify-center text-xs py-2.5 font-semibold ${
                      featured ? "btn-primary" : "btn-secondary"
                    }`}
                  >
                    {isCustom ? "Talk to Sales" : p.priceUsd === 0 ? "Start Sandbox" : "Choose Your Plan"}
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        {/* Pricing Transparency Strip */}
        <div className="mt-12 max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
          <div className="card p-5 border-black/[0.08] bg-surface">
            <span className="badge bg-emerald-100 text-emerald-800 text-[10px] font-bold uppercase mb-2 inline-block">
              Free Sandbox Testing
            </span>
            <h4 className="text-sm font-bold text-ink-50">Zero-Credit Platform Tools</h4>
            <p className="mt-1 text-xs text-ink-400 leading-relaxed">
              Explore open-web prospect discovery, test natural-language targeting and build a digital sales room without entering a credit card.
            </p>
          </div>
          <div className="card p-5 border-brand-200 bg-brand-50/20">
            <span className="badge bg-brand-600 text-white text-[10px] font-bold uppercase mb-2 inline-block">
              Paid Tiers
            </span>
            <h4 className="text-sm font-bold text-ink-50">External Provider Costs & Scaled Volume</h4>
            <p className="mt-1 text-xs text-ink-400 leading-relaxed">
              Paid plans cover external verification providers (Hunter, Reoon, MillionVerifier), premium provider leads, higher sending volume and more seats. Growth and above add hosted MCP, so Claude Code and Cursor can run Scout directly.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 15: FAQ
   ========================================================================= */

function FaqSection() {
  return (
    <section id="faq" className="py-20 max-w-4xl mx-auto px-4 sm:px-6">
      <div className="text-center max-w-2xl mx-auto mb-14">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs">
          Direct Answers
        </span>
        <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-50">
          Frequently Asked Questions
        </h2>
        <p className="mt-3 text-sm text-ink-300">
          Clear, honest information about how Scout discovers, enriches, and verifies prospects.
        </p>
      </div>

      <div className="divide-y divide-black/10 rounded-2xl border border-black/10 bg-surface shadow-xs overflow-hidden">
        {FAQS.map((f) => (
          <details key={f.q} className="group p-5 sm:p-6 open:bg-black/[0.015]">
            <summary className="flex cursor-pointer list-none items-center justify-between font-bold text-sm text-ink-50 focus:outline-none">
              <span>{f.q}</span>
              <span className="text-base text-ink-400 transition-transform group-open:rotate-45 shrink-0 ml-4">
                +
              </span>
            </summary>
            <p className="mt-3 text-xs sm:text-sm text-ink-300 leading-relaxed pr-6">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 16: FINAL CONVERSION SECTION
   ========================================================================= */

function FinalConversionSection() {
  return (
    <section className="py-20 border-t border-black/5 bg-gradient-to-b from-surface via-brand-50/20 to-cream">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        <span className="badge border border-brand-200 bg-brand-50 text-brand-700 font-semibold text-xs mb-3 inline-block">
          Start Your Discovery Today
        </span>
        <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-ink-50 leading-tight">
          Your Next Customer Is Out There.
          <br />
          <span className="bg-brand-gradient bg-clip-text text-transparent">
            Find Them with Scout.
          </span>
        </h2>
        <p className="mt-4 text-sm sm:text-base text-ink-300 max-w-2xl mx-auto leading-relaxed">
          Stop spending hours searching through stale directories manually. Tell Scout what you need, customise your criteria, and start discovering high-converting opportunities.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/signup" className="btn-primary px-8 py-3.5 text-sm font-semibold shadow-xs">
            Find My First Leads →
          </Link>
          <a href="#pricing" className="btn-secondary px-6 py-3.5 text-sm font-medium">
            Explore Pricing
          </a>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-ink-400">
          <span className="flex items-center gap-1 font-medium"><CheckIcon className="h-3.5 w-3.5 text-brand-600" /> Simple Onboarding</span>
          <span className="flex items-center gap-1 font-medium"><CheckIcon className="h-3.5 w-3.5 text-brand-600" /> Custom Targeting</span>
          <span className="flex items-center gap-1 font-medium"><CheckIcon className="h-3.5 w-3.5 text-brand-600" /> AI-Powered Discovery</span>
          <span className="flex items-center gap-1 font-medium"><CheckIcon className="h-3.5 w-3.5 text-brand-600" /> Transparent Pricing</span>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION 17: FOOTER
   ========================================================================= */

function Footer() {
  return (
    <footer className="border-t border-black/10 bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 text-xs">
          {/* Col 1: Brand */}
          <div className="col-span-2 sm:col-span-1">
            <Logo size={24} textClassName="text-base font-bold" />
            <p className="mt-3 text-ink-400 leading-relaxed max-w-[240px]">
              AI-powered prospect discovery, sales intelligence, and custom audience generation by MNB Research.
            </p>
          </div>

          {/* Col 2: Product */}
          <div>
            <div className="font-bold uppercase tracking-wider text-ink-400 mb-3">Product</div>
            <ul className="space-y-2 text-ink-300">
              <li><a href="#find-people" className="hover:text-ink-50">Find People</a></li>
              <li><a href="#find-companies" className="hover:text-ink-50">Find Companies</a></li>
              <li><a href="#find-leads" className="hover:text-ink-50">Custom Targeting</a></li>
              <li><a href="#features" className="hover:text-ink-50">Intent Plays</a></li>
              <li><a href="#agencies" className="hover:text-ink-50">For Agencies</a></li>
              <li><a href="#pricing" className="hover:text-ink-50">Pricing</a></li>
            </ul>
          </div>

          {/* Col 3: Resources */}
          <div>
            <div className="font-bold uppercase tracking-wider text-ink-400 mb-3">Resources</div>
            <ul className="space-y-2 text-ink-300">
              <li><a href="#how-it-works" className="hover:text-ink-50">How It Works</a></li>
              <li><a href="#faq" className="hover:text-ink-50">FAQ</a></li>
              <li><Link to="/login" className="hover:text-ink-50">Sign In</Link></li>
              <li><Link to="/signup" className="hover:text-ink-50">Create Account</Link></li>
            </ul>
          </div>

          {/* Col 4: Company & Legal */}
          <div>
            <div className="font-bold uppercase tracking-wider text-ink-400 mb-3">Company</div>
            <ul className="space-y-2 text-ink-300">
              <li><a href="https://mnbresearch.com" target="_blank" rel="noopener noreferrer" className="hover:text-ink-50">MNB Research</a></li>
              <li><a href="mailto:contact@mnbresearch.com" className="hover:text-ink-50">contact@mnbresearch.com</a></li>
              <li><Link to="/privacy" className="hover:text-ink-50">Privacy Policy</Link></li>
              <li><Link to="/terms" className="hover:text-ink-50">Terms of Service</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-black/5 text-center text-[11px] text-ink-400">
          © {new Date().getFullYear()} MNB Scout. A product by MNB Research. All rights reserved.
        </div>
      </div>
    </footer>
  );
}

/* =========================================================================
   STICKY ACTIONS & SCROLL HELPERS
   ========================================================================= */

function StickyConversionBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > 800);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-black/10 bg-surface/95 backdrop-blur px-4 py-2.5 shadow-xl transition-all duration-300">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-brand-600 animate-pulse hidden sm:inline-block" />
          <div className="text-xs font-semibold text-ink-50">
            Ready to discover exact matching prospects and custom audiences?
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/signup" className="btn-primary text-xs py-2 px-4 font-semibold shadow-xs">
            Find My First Leads →
          </Link>
        </div>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Scroll to top"
      className="fixed bottom-6 right-6 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-surface/90 text-ink-300 shadow-md backdrop-blur hover:text-ink-50"
    >
      ↑
    </button>
  );
}

/* =========================================================================
   MAIN LANDING PAGE EXPORT
   ========================================================================= */

export function LandingPage() {
  useEffect(() => {
    sendPageView("/");
  }, []);

  return (
    <div className="min-h-screen bg-cream text-ink-100 overflow-x-hidden selection:bg-brand-500/20">
      <NavigationBar />
      <main>
        <HeroSection />
        <WhatCanYouFindSection />
        <CustomFilterBuilderSection />
        <HowScoutWorksSection />
        <ProspectIntelligenceSection />
        <IntentPlaysSection />
        <SalesExecutionSection />
        <WhoIsScoutForSection />
        <AgencyWorkspaceSection />
        <IntegrationsSection />
        <DevelopersSection />
        <DifferentiationMatrixSection />
        <InteractiveProductDemoSection />
        <PricingSection />
        <FaqSection />
        <FinalConversionSection />
      </main>
      <Footer />
      <StickyConversionBar />
      <ScrollToTop />
    </div>
  );
}
