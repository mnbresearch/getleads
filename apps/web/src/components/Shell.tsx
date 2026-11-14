import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { apiFetch, auth, ProspexError } from "../lib/api";
import { Logo } from "./Logo";
import { DeletionBanner, RecoveryCodeNotice, VerifyEmailBanner } from "./AccountBanners";
import { emailVerificationAvailable } from "../lib/me";
import { CommandPalette } from "./CommandPalette";

interface NavCategory {
  name: string;
  items: { to: string; label: string; icon: string; badge?: string }[];
}

const navCategories: NavCategory[] = [
  {
    name: "Revenue Pipeline",
    items: [
      { to: "/", label: "Command Center", icon: "▦" },
      { to: "/pipeline", label: "Deals & CRM", icon: "📊" },
      { to: "/salesfloor", label: "Virtual Salesfloor", icon: "👥", badge: "Live" },
      { to: "/rooms", label: "Digital Sales Rooms", icon: "🤝" },
      { to: "/committees", label: "Buying Committees", icon: "👥" },
    ],
  },
  {
    name: "Prospecting & Intent Radar",
    items: [
      { to: "/search", label: "Find Leads", icon: "⌕" },
      { to: "/waterfall", label: "Waterfall Enrichment", icon: "💧", badge: "Moat" },
      { to: "/surges", label: "Signal Surges", icon: "⚡", badge: "Hot" },
      { to: "/leads", label: "Leads Database", icon: "☰" },
      { to: "/visitors", label: "Website Visitors", icon: "◉" },
      { to: "/signals", label: "Intent Signals", icon: "◈" },
      { to: "/icps", label: "Ideal Customers", icon: "◎" },
    ],
  },
  {
    name: "Autonomous Outbound",
    items: [
      { to: "/gtm", label: "Autonomous GTM", icon: "🎯", badge: "New" },
      { to: "/dialer", label: "AI Sales Dialer", icon: "📞" },
      { to: "/email-coach", label: "Email Coach", icon: "✉" },
      { to: "/campaigns", label: "Campaigns", icon: "📨" },
      { to: "/plays", label: "Plays & Cadences", icon: "▷" },
      { to: "/autopilot", label: "Autopilot Engine", icon: "∞" },
    ],
  },
  {
    name: "AI Workforce & Agents",
    items: [
      { to: "/digital-workers", label: "Digital SDRs (Alice & Jordan)", icon: "🤖", badge: "24/7" },
      { to: "/agent", label: "Agent Console", icon: "⚡" },
      { to: "/coaching", label: "AI Roleplay Coaching", icon: "🎯" },
      { to: "/visibility", label: "AI Search Visibility", icon: "◇" },
    ],
  },
  {
    name: "Workspace & Controls",
    items: [
      { to: "/analytics", label: "Analytics & Quota", icon: "▤" },
      { to: "/tasks", label: "Tasks", icon: "☑" },
      { to: "/automation", label: "Automation", icon: "⟳" },
      { to: "/tools", label: "Diagnostic Tools", icon: "⚒" },
      { to: "/clients", label: "Agency Clients", icon: "◧" },
      { to: "/settings", label: "Settings", icon: "⚙" },
    ],
  },
];

const AI_ENGINES = [
  { id: "Scout Autonomous Router", label: "⚡ Scout Router", desc: "Auto-routes between models for optimal precision" },
  { id: "Gemini 1.5 Pro", label: "🧠 Gemini 1.5 Pro", desc: "Deep multi-source intent & company dossiers" },
  { id: "Claude 3.5 Sonnet", label: "🖋️ Claude 3.5", desc: "Hyper-personalized outbound copy & battlecards" },
  { id: "DeepSeek R1", label: "🔬 DeepSeek R1", desc: "Chain-of-thought buying committee graph mapping" },
];

function DemoBanner({ daysLeft, expiresAt }: { daysLeft: number | null; expiresAt: string | null }) {
  const formattedDate = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-200 dark:border-brand-900 bg-brand-50/90 dark:bg-brand-950/40 px-4 py-2 text-xs text-brand-900 dark:text-brand-300 shadow-sm" role="status">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">⚡</span>
        <span>
          <strong className="font-semibold">7-Day Demo Account:</strong> {daysLeft !== null ? (
            <span>
              <span className="font-bold text-brand-700 dark:text-brand-400">{daysLeft} {daysLeft === 1 ? "day" : "days"} remaining</span> (valid until {formattedDate})
            </span>
          ) : "Active trial"} · Upgrading is compulsory after 7 days to preserve access.
        </span>
      </div>
      <a href="/upgrade" className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-brand-700">
        Upgrade plan ↗
      </a>
    </div>
  );
}

function DemoExpiredPaywall({ onSignOut, expiresAt }: { onSignOut: () => void; expiresAt?: string | null }) {
  const formattedDate = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "recently";
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream dark:bg-slate-950 p-6">
      <div className="card max-w-lg p-8 text-center shadow-xl border-brand-200 dark:border-brand-900">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 text-xl font-bold">
          ⏱
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-tight text-ink-50 dark:text-white">Your 7-Day Demo Has Ended</h2>
        <p className="mt-2 text-sm text-ink-300 dark:text-slate-300">
          Your demo workspace trial ended on {formattedDate}. As per the 7-day evaluation policy, upgrade your workspace to a paid plan to restore full pipeline access, contact discovery, and AI research capabilities.
        </p>

        <div className="mt-6 rounded-lg border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-900 p-4 text-left">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-400 dark:text-slate-400">Available Plans</div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded border border-black/5 dark:border-white/10 p-2.5">
              <div className="font-semibold text-ink-50 dark:text-white">Starter · $109/mo</div>
              <div className="text-ink-400 dark:text-slate-400 mt-1">1,500 leads, 150 verified premium, 3 campaigns</div>
            </div>
            <div className="rounded border border-brand-200 dark:border-brand-800 bg-brand-50/40 dark:bg-brand-950/40 p-2.5">
              <div className="font-semibold text-brand-700 dark:text-brand-400">Growth · $359/mo</div>
              <div className="text-ink-400 dark:text-slate-400 mt-1">6,000 leads, 500 premium, 15 campaigns</div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <a href="/upgrade" className="btn-primary justify-center px-6 py-2.5 text-sm font-semibold shadow-glow">
            Choose Plan & Upgrade Now
          </a>
          <button className="btn-secondary justify-center px-4 py-2.5 text-sm" onClick={onSignOut}>
            Sign Out
          </button>
        </div>

        <p className="mt-4 text-xs text-ink-400 dark:text-slate-400">
          Need an extension or have questions? Email us at{" "}
          <a href="mailto:contact@mnbresearch.com" className="text-brand-600 dark:text-brand-400 hover:underline">
            contact@mnbresearch.com
          </a>
        </p>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<{ user: { email: string; name: string; role?: string; emailVerified?: boolean } | null; org: { name: string; plan: string; emailVerificationAvailable?: boolean; settings?: Record<string, unknown> }; emailVerificationAvailable?: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [demoExpired, setDemoExpired] = useState(false);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);

  // Theme Management (Dark / Light Mode Toggle)
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("scout_theme");
      if (saved) return saved === "dark";
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });

  // Active AI Model Engine Selection
  const [activeModel, setActiveModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("scout_ai_engine") || "Scout Autonomous Router";
    }
    return "Scout Autonomous Router";
  });

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("scout_theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("scout_theme", "light");
    }
  }, [isDarkMode]);

  const toggleTheme = () => {
    setIsDarkMode((prev) => !prev);
  };

  const handleSelectModel = (model: string) => {
    setActiveModel(model);
    localStorage.setItem("scout_ai_engine", model);
    setEngineMenuOpen(false);
  };

  // Keyboard shortcut listener for Command Palette (⌘K or Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const signOut = useCallback(() => {
    auth.set(null);
    navigate("/login");
  }, [navigate]);

  const loadMe = useCallback(() => {
    apiFetch<typeof me>("GET", "/v1/auth/me")
      .then((r) => {
        setMe(r);
        setMeErr(null);
        setSuspended(false);
        const settings = (r?.org as any)?.settings as Record<string, unknown> | undefined;
        if (settings?.isDemo && settings?.demoExpiresAt) {
          const expired = new Date(settings.demoExpiresAt as string).getTime() <= Date.now();
          setDemoExpired(expired);
        }
      })
      .catch((e) => {
        if (e instanceof ProspexError && e.status === 403 && e.code === "account_suspended") setSuspended(true);
        else if (e instanceof ProspexError && e.status === 402 && e.code === "demo_expired") setDemoExpired(true);
        else if (!(e instanceof ProspexError && e.status === 401)) setMeErr((e as Error).message);
      });
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  if (suspended) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream dark:bg-slate-950 p-6">
        <div className="card max-w-md p-6 text-center" role="alert">
          <Logo size={28} textClassName="text-base" />
          <div className="mt-4 text-lg font-semibold text-ink-50 dark:text-white">This workspace is suspended</div>
          <p className="mt-2 text-sm text-ink-400 dark:text-slate-400">
            Contact support to restore access:{" "}
            <a className="text-brand-600 dark:text-brand-400 hover:underline" href="mailto:contact@mnbresearch.com">contact@mnbresearch.com</a>
          </p>
          <button className="btn-secondary mt-4" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  const orgSettings = (me?.org as any)?.settings as Record<string, unknown> | undefined;
  const isDemo = !!orgSettings?.isDemo;
  const demoExpiresAt = (orgSettings?.demoExpiresAt as string) ?? null;
  const isExpired = demoExpired || (isDemo && demoExpiresAt ? new Date(demoExpiresAt).getTime() <= Date.now() : false);
  const demoDaysLeft = isDemo && demoExpiresAt ? Math.max(0, Math.ceil((new Date(demoExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;

  if (isExpired) {
    return <DemoExpiredPaywall onSignOut={signOut} expiresAt={demoExpiresAt} />;
  }

  return (
    <div className="flex min-h-screen bg-cream dark:bg-slate-950 text-ink-100 dark:text-slate-100 transition-colors duration-200">
      {/* Krater.ai SuperApp Left Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 transform flex-col border-r border-black/10 dark:border-white/10 bg-surface/95 dark:bg-slate-900/95 backdrop-blur transition-transform sm:sticky sm:top-0 sm:h-screen sm:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand & Workspace Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-black/10 dark:border-white/10 px-4">
          <Logo size={26} textClassName="text-base" />
          <span className="badge bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-400 border border-brand-200 dark:border-brand-800 text-[10px] font-semibold uppercase tracking-wider">
            {me?.org.plan || "Sandbox"}
          </span>
        </div>

        {/* Quick Omnibar Launcher */}
        <div className="p-3 border-b border-black/5 dark:border-white/5">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] text-xs text-ink-400 dark:text-slate-400 hover:border-brand-400 dark:hover:border-brand-500 transition group"
          >
            <div className="flex items-center gap-2">
              <span className="text-ink-400 group-hover:text-brand-600 dark:group-hover:text-brand-400">⌕</span>
              <span>Quick command...</span>
            </div>
            <kbd className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-ink-400 dark:text-slate-300">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Categorized Nav Hierarchy */}
        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
          {navCategories.map((cat) => (
            <div key={cat.name} className="space-y-0.5">
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-400 dark:text-slate-400">
                {cat.name}
              </div>
              {cat.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center justify-between rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      isActive
                        ? "bg-brand-500 text-white shadow-sm dark:bg-brand-600"
                        : "text-ink-300 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink-50 dark:hover:text-white"
                    }`
                  }
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <span className="w-4 text-center text-sm">{item.icon}</span>
                    <span className="truncate">{item.label}</span>
                  </div>
                  {item.badge && (
                    <span
                      className={`badge text-[9px] uppercase px-1.5 py-0.2 ${
                        location.pathname === item.to
                          ? "bg-white/20 text-white"
                          : "bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-brand-400 border border-brand-200 dark:border-brand-800"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Real-time Sandbox & Credits Meter */}
        <div className="shrink-0 border-t border-black/10 dark:border-white/10 p-3 bg-black/[0.01] dark:bg-white/[0.02]">
          <div className="rounded-lg border border-black/5 dark:border-white/10 p-2.5 bg-surface dark:bg-slate-900">
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="font-semibold text-ink-50 dark:text-white flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Zero-Cost Sandbox
              </span>
              <a href="/upgrade" className="text-[10px] font-bold text-brand-600 dark:text-brand-400 hover:underline">
                Upgrade ↗
              </a>
            </div>
            <p className="text-[10px] text-ink-400 dark:text-slate-400 leading-tight">
              Test platform features without burning costly verified provider credits.
            </p>
          </div>

          {/* User profile & actions */}
          <div className="mt-3 flex items-center justify-between text-xs text-ink-400 dark:text-slate-400">
            <div className="min-w-0 pr-2">
              <div className="truncate font-medium text-ink-100 dark:text-slate-200">{me?.org.name}</div>
              <div className="truncate text-[11px] text-ink-400 dark:text-slate-400">{me?.user?.email}</div>
            </div>
            <button
              className="text-xs text-ink-400 hover:text-red-600 dark:hover:text-red-400 transition"
              onClick={signOut}
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Execution Viewport */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top High-Velocity Action Bar (Krater.ai SuperApp Header) */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-black/10 dark:border-white/10 bg-surface/90 dark:bg-slate-900/90 px-4 backdrop-blur">
          {/* Mobile Menu Button */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOpen((o) => !o)}
              aria-label="Toggle navigation menu"
              aria-expanded={open}
              className="text-xl text-ink-100 dark:text-white sm:hidden"
            >
              ☰
            </button>
            <div className="sm:hidden">
              <Logo size={22} textClassName="text-sm" />
            </div>

            {/* Desktop Quick Omnibar Search Trigger */}
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] text-xs text-ink-400 dark:text-slate-400 hover:border-brand-400 dark:hover:border-brand-500 transition w-72 lg:w-96 text-left"
            >
              <span>⌕</span>
              <span className="flex-1 truncate">Search leads, run AI actions, switch models...</span>
              <kbd className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-ink-400 dark:text-slate-300">
                ⌘K
              </kbd>
            </button>
          </div>

          {/* Right Top Bar Controls: AI Engine Switcher & Dark/Light Toggle */}
          <div className="flex items-center gap-2.5">
            {/* Active AI Intelligence Engine Selector (Krater.ai Model Switcher) */}
            <div className="relative">
              <button
                onClick={() => setEngineMenuOpen((prev) => !prev)}
                className="flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-ink-100 dark:text-white hover:bg-black/5 dark:hover:bg-white/10 transition"
              >
                <span>{activeModel.split(" ")[0]}</span>
                <span className="hidden md:inline">{activeModel}</span>
                <span className="text-[10px] text-ink-400">▾</span>
              </button>

              {engineMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setEngineMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 z-50 w-72 rounded-xl border border-black/10 dark:border-white/10 bg-surface dark:bg-slate-900 shadow-xl p-2 space-y-1 animate-rise">
                    <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-400 dark:text-slate-400 border-b border-black/5 dark:border-white/5 mb-1">
                      Select Intelligence Engine
                    </div>
                    {AI_ENGINES.map((eng) => (
                      <div
                        key={eng.id}
                        onClick={() => handleSelectModel(eng.id)}
                        className={`p-2 rounded-lg text-xs cursor-pointer transition ${
                          activeModel === eng.id
                            ? "bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-brand-400 border border-brand-200 dark:border-brand-800"
                            : "hover:bg-black/5 dark:hover:bg-white/5 text-ink-100 dark:text-slate-200"
                        }`}
                      >
                        <div className="font-semibold flex items-center justify-between">
                          <span>{eng.label}</span>
                          {activeModel === eng.id && <span className="text-brand-600">✓</span>}
                        </div>
                        <div className="text-[10px] text-ink-400 dark:text-slate-400 mt-0.5">{eng.desc}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Dark / Light Mode Switcher */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle dark/light theme"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] text-sm text-ink-300 dark:text-slate-300 hover:text-ink-50 dark:hover:text-white transition"
              title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDarkMode ? "☀" : "🌙"}
            </button>

            {/* Action Shortcut to Dialer */}
            <NavLink
              to="/dialer"
              className="hidden lg:inline-flex items-center gap-1.5 btn-primary text-xs py-1.5 px-3"
            >
              <span>📞</span>
              <span>Launch Dialer</span>
            </NavLink>
          </div>
        </header>

        {/* Global Error Banner */}
        {meErr && (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800" role="alert">
            <span>Couldn&apos;t reach Scout to load your account ({meErr}). Some data may be out of date.</span>
            <button className="font-medium underline" onClick={loadMe}>Retry</button>
          </div>
        )}

        {isDemo && !isExpired && <DemoBanner daysLeft={demoDaysLeft} expiresAt={demoExpiresAt} />}
        <DeletionBanner isOwner={me?.user?.role === "owner"} />
        <RecoveryCodeNotice />
        {me?.user && me.user.emailVerified === false && emailVerificationAvailable(me) && (
          <VerifyEmailBanner key={me.user.email} email={me.user.email} onRecheck={loadMe} />
        )}

        {/* Viewport Content */}
        <main className="flex-1">{children}</main>
      </div>

      {/* Global Command Palette (⌘K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        activeModel={activeModel}
        onSelectModel={handleSelectModel}
      />
    </div>
  );
}
