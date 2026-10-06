import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, auth, ProspexError } from "../lib/api";
import { Logo } from "./Logo";
import { DeletionBanner, RecoveryCodeNotice, VerifyEmailBanner } from "./AccountBanners";
import { emailVerificationAvailable } from "../lib/me";

const nav = [
  { to: "/", label: "Overview", icon: "▦" },
  { to: "/plays", label: "Plays", icon: "▷" },
  { to: "/clients", label: "Clients", icon: "◧" },
  { to: "/search", label: "Find leads", icon: "⌕" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/icps", label: "Ideal customers", icon: "◎" },
  { to: "/campaigns", label: "Campaigns", icon: "✉" },
  { to: "/tasks", label: "Tasks", icon: "☑" },
  { to: "/visitors", label: "Website visitors", icon: "◉" },
  { to: "/signals", label: "Intent signals", icon: "◈" },
  { to: "/visibility", label: "AI visibility", icon: "◇" },
  { to: "/autopilot", label: "Autopilot", icon: "∞" },
  { to: "/automation", label: "Automation", icon: "⟳" },
  { to: "/analytics", label: "Analytics", icon: "▤" },
  { to: "/tools", label: "Tools", icon: "⚒" },
  { to: "/agent", label: "Agent console", icon: "⚡" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<{ user: { email: string; name: string; role?: string; emailVerified?: boolean } | null; org: { name: string; plan: string; emailVerificationAvailable?: boolean }; emailVerificationAvailable?: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [meErr, setMeErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const signOut = useCallback(() => {
    auth.set(null);
    navigate("/login");
  }, [navigate]);
  const loadMe = useCallback(() => {
    // Only a 401 means "signed out", and apiFetch already clears the token for that (which
    // sends Protected to /login). A suspended workspace, a 5xx or a dropped connection used
    // to log people out too, so a blip in the API read as "your session is gone".
    apiFetch<typeof me>("GET", "/v1/auth/me")
      .then((r) => {
        setMe(r);
        setMeErr(null);
        setSuspended(false);
      })
      .catch((e) => {
        if (e instanceof ProspexError && e.status === 403 && e.code === "account_suspended") setSuspended(true);
        else if (!(e instanceof ProspexError && e.status === 401)) setMeErr((e as Error).message);
      });
  }, []);
  useEffect(() => {
    loadMe();
  }, [loadMe]);
  if (suspended) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream p-6">
        <div className="card max-w-md p-6 text-center" role="alert">
          <Logo size={28} textClassName="text-base" />
          <div className="mt-4 text-lg font-semibold">This workspace is suspended</div>
          <p className="mt-2 text-sm text-ink-400">
            Contact support to restore access:{" "}
            <a className="text-brand-600 hover:underline" href="mailto:contact@mnbresearch.com">contact@mnbresearch.com</a>
          </p>
          <button className="btn-secondary mt-4" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen bg-cream">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col border-r border-black/10 bg-surface/90 backdrop-blur transition sm:sticky sm:top-0 sm:h-screen sm:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-black/10 px-4">
          <Logo size={26} textClassName="text-base" />
          <span className="ml-auto badge bg-brand-50 text-brand-700 capitalize">{me?.org.plan ?? ""}</span>
        </div>
        {/* The nav scrolls and the footer sits below it: an absolutely-positioned footer used to cover the last nav items on short (phone) screens. */}
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? "bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-200" : "text-ink-300 hover:bg-black/5 hover:text-ink-50"
                }`
              }
            >
              <span className="w-4 text-center text-ink-500">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="shrink-0 border-t border-black/10 p-3 text-xs text-ink-400">
          <div className="truncate font-medium text-ink-100">{me?.org.name}</div>
          <div className="truncate">{me?.user?.email}</div>
          <button className="mt-2 text-brand-600 hover:text-brand-800 hover:underline" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-black/10 bg-surface/90 px-4 backdrop-blur sm:hidden">
          <button onClick={() => setOpen((o) => !o)} className="text-xl text-ink-100">☰</button>
          <Logo size={22} textClassName="text-sm" />
        </header>
        {meErr && (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800" role="alert">
            <span>Couldn&apos;t reach Scout to load your account ({meErr}). Some data may be out of date.</span>
            <button className="font-medium underline" onClick={loadMe}>Retry</button>
          </div>
        )}
        {/* Nothing for a session that never loaded its account, an older server that does not
            say whether the address is confirmed, or a deployment that cannot send the email. */}
        <DeletionBanner isOwner={me?.user?.role === "owner"} />
        <RecoveryCodeNotice />
        {me?.user && me.user.emailVerified === false && emailVerificationAvailable(me) && <VerifyEmailBanner key={me.user.email} email={me.user.email} onRecheck={loadMe} />}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
