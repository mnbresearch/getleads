import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";
import { Logo } from "./Logo";

const nav = [
  { to: "/", label: "Overview", icon: "▦" },
  { to: "/search", label: "Find leads", icon: "⌕" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/icps", label: "Ideal customers", icon: "◎" },
  { to: "/campaigns", label: "Campaigns", icon: "✉" },
  { to: "/tasks", label: "Tasks", icon: "☑" },
  { to: "/visitors", label: "Website visitors", icon: "◉" },
  { to: "/signals", label: "Intent signals", icon: "◈" },
  { to: "/visibility", label: "AI visibility", icon: "◇" },
  { to: "/autopilot", label: "Autopilot", icon: "∞" },
  { to: "/tools", label: "Tools", icon: "⚒" },
  { to: "/agent", label: "Agent console", icon: "⚡" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<{ user: { email: string; name: string }; org: { name: string; plan: string } } | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    apiFetch<typeof me>("GET", "/v1/auth/me").then(setMe).catch(() => navigate("/login"));
  }, [navigate]);
  return (
    <div className="flex min-h-screen bg-cream">
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 transform border-r border-black/10 bg-surface/90 backdrop-blur transition sm:static sm:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-14 items-center gap-2 border-b border-black/10 px-4">
          <Logo size={26} textClassName="text-base" />
          <span className="ml-auto badge bg-brand-50 text-brand-700 capitalize">{me?.org.plan ?? ""}</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
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
        <div className="absolute bottom-0 w-full border-t border-black/10 p-3 text-xs text-ink-400">
          <div className="truncate font-medium text-ink-100">{me?.org.name}</div>
          <div className="truncate">{me?.user.email}</div>
          <button
            className="mt-2 text-brand-600 hover:text-brand-800 hover:underline"
            onClick={() => {
              auth.set(null);
              navigate("/login");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-black/10 bg-surface/90 px-4 backdrop-blur sm:hidden">
          <button onClick={() => setOpen((o) => !o)} className="text-xl text-ink-100">☰</button>
          <Logo size={22} textClassName="text-sm" />
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
