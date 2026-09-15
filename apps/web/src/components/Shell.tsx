import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";

const nav = [
  { to: "/", label: "Overview", icon: "▦" },
  { to: "/search", label: "Find leads", icon: "⌕" },
  { to: "/leads", label: "Leads", icon: "☰" },
  { to: "/icps", label: "Ideal customers", icon: "◎" },
  { to: "/campaigns", label: "Campaigns", icon: "✉" },
  { to: "/tasks", label: "Tasks", icon: "☑" },
  { to: "/visitors", label: "Website visitors", icon: "◉" },
  { to: "/signals", label: "Intent signals", icon: "◈" },
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
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 transform border-r border-slate-200 bg-white transition sm:static sm:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">G</div>
          <div className="font-semibold">GetLeads</div>
          <span className="ml-auto badge bg-brand-50 text-brand-700">{me?.org.plan ?? ""}</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${isActive ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-50"}`}>
              <span className="w-4 text-center text-slate-400">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full border-t border-slate-200 p-3 text-xs text-slate-500">
          <div className="truncate font-medium text-slate-700">{me?.org.name}</div>
          <div className="truncate">{me?.user.email}</div>
          <button
            className="mt-2 text-brand-600 hover:underline"
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
        <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:hidden">
          <button onClick={() => setOpen((o) => !o)} className="text-xl">☰</button>
          <div className="font-semibold">GetLeads</div>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
