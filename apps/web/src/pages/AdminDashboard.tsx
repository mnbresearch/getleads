import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { adminAuth, adminFetch, useAdminToken } from "../lib/adminApi";
import { fmtDate, fmtNum } from "../lib/api";

type PlanLimits = Record<string, number | boolean>;
type OrgRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  createdAt: string;
  leadsUsed: number;
  premiumLeadsUsed: number;
  userCount: number;
  ownerEmail: string | null;
  ownerName: string | null;
  limits: PlanLimits;
};
type OrgUser = { id: string; email: string; name: string; role: string; lastLoginAt: string | null; createdAt: string };
type OrgDetail = { org: OrgRow & { planLimits: Record<string, unknown> }; users: OrgUser[]; usage: Record<string, number>; period: string };
type UpgradeRequest = { id: string; orgId: string | null; name: string; email: string; mobile: string; country: string; planId: string; message: string | null; status: string; createdAt: string };
type Plan = { id: string; name: string; priceUsd: number; limits: PlanLimits };

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  deactivated: "bg-amber-50 text-amber-800",
  revoked: "bg-red-50 text-red-600",
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_STYLES[status] ?? "bg-black/5 text-ink-300"}`}>{status}</span>;
}

function OrgDetailPanel({ orgId, plans, onChanged, onClose }: { orgId: string; plans: Plan[]; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [creditForm, setCreditForm] = useState({ metric: "premiumLeads", action: "grant" as "grant" | "set", amount: 0 });
  const [confirmingStatus, setConfirmingStatus] = useState<string | null>(null);

  const load = () => adminFetch<OrgDetail>("GET", `/v1/admin/orgs/${orgId}`).then((d) => { setDetail(d); setPlan(d.org.plan); });
  useEffect(() => { load(); }, [orgId]);

  if (!detail) return <div className="card p-5 text-sm text-ink-400">Loading…</div>;

  const savePlan = async () => {
    setBusy(true);
    try {
      await adminFetch("PATCH", `/v1/admin/orgs/${orgId}/plan`, { plan });
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: string) => {
    if (status !== "active" && confirmingStatus !== status) {
      setConfirmingStatus(status);
      return;
    }
    setConfirmingStatus(null);
    setBusy(true);
    try {
      await adminFetch("PATCH", `/v1/admin/orgs/${orgId}/status`, { status });
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const applyCredits = async () => {
    setBusy(true);
    try {
      await adminFetch("PATCH", `/v1/admin/orgs/${orgId}/credits`, creditForm);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card sticky top-4 space-y-5 p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-semibold text-ink-50">{detail.org.name}</div>
          <div className="text-xs text-ink-400">{detail.org.slug}</div>
        </div>
        <button className="text-sm text-ink-400 hover:text-ink-50" onClick={onClose}>Close</button>
      </div>

      <div>
        <div className="label">Plan</div>
        <div className="flex gap-2">
          <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name} (${p.priceUsd}/mo)</option>)}
          </select>
          <button className="btn-secondary" disabled={busy || plan === detail.org.plan} onClick={savePlan}>Save</button>
        </div>
      </div>

      <div>
        <div className="label">Status</div>
        <div className="flex flex-wrap items-center gap-2">
          {["active", "deactivated", "revoked"].map((s) => (
            <button key={s} className={`badge cursor-pointer ${detail.org.status === s ? STATUS_STYLES[s] : "border border-black/10 bg-black/5 text-ink-300 hover:text-ink-50"}`} disabled={busy} onClick={() => setStatus(s)}>{s}</button>
          ))}
        </div>
        {confirmingStatus && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            <span>{confirmingStatus === "revoked" ? "Revoke" : "Deactivate"} {detail.org.name}? They'll be locked out immediately.</span>
            <button className="btn-secondary py-1 text-xs" disabled={busy} onClick={() => setStatus(confirmingStatus)}>Confirm</button>
            <button className="text-ink-400 hover:text-ink-50" onClick={() => setConfirmingStatus(null)}>Cancel</button>
          </div>
        )}
      </div>

      <div>
        <div className="label">Grant / set credits ({detail.period})</div>
        <div className="grid grid-cols-3 gap-2">
          <select className="input" value={creditForm.metric} onChange={(e) => setCreditForm({ ...creditForm, metric: e.target.value })}>
            {["leads", "premiumLeads", "searches", "verifications", "aiMessages", "emails"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className="input" value={creditForm.action} onChange={(e) => setCreditForm({ ...creditForm, action: e.target.value as "grant" | "set" })}>
            <option value="grant">Grant +N</option>
            <option value="set">Set used to N</option>
          </select>
          <input className="input" type="number" value={creditForm.amount} onChange={(e) => setCreditForm({ ...creditForm, amount: Number(e.target.value) })} />
        </div>
        <button className="btn-secondary mt-2 w-full justify-center" disabled={busy} onClick={applyCredits}>Apply</button>
        <div className="mt-2 text-xs text-ink-400">
          Used this period: {Object.entries(detail.usage).map(([m, n]) => `${m} ${fmtNum(n)}`).join(" · ") || "none yet"}
        </div>
      </div>

      <div>
        <div className="label">Users ({detail.users.length})</div>
        <ul className="space-y-1 text-sm text-ink-300">
          {detail.users.map((u) => <li key={u.id}>{u.name || u.email} <span className="text-ink-500">· {u.email} · {u.role}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

function OrgsTab({ plans }: { plans: Plan[] }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => adminFetch<{ orgs: OrgRow[] }>("GET", `/v1/admin/orgs${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => setOrgs(r.orgs));
  useEffect(() => { load(); }, [q]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="card overflow-x-auto p-0">
        <div className="border-b border-black/10 p-3">
          <input className="input" placeholder="Search workspace or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-400"><th className="th">Workspace</th><th className="th">Plan</th><th className="th">Status</th><th className="th">Leads</th><th className="th">Premium</th><th className="th">Users</th><th className="th">Joined</th></tr></thead>
          <tbody>
            {orgs?.map((o) => (
              <tr key={o.id} className={`cursor-pointer hover:bg-black/[0.03] ${selected === o.id ? "bg-brand-50" : ""}`} onClick={() => setSelected(o.id)}>
                <td className="td"><div className="font-medium text-ink-50">{o.name}</div><div className="text-xs text-ink-400">{o.ownerEmail ?? "—"}</div></td>
                <td className="td capitalize">{o.plan}</td>
                <td className="td"><StatusBadge status={o.status} /></td>
                <td className="td">{fmtNum(o.leadsUsed)}/{fmtNum(Number(o.limits.leadsPerMonth))}</td>
                <td className="td">{fmtNum(o.premiumLeadsUsed)}/{fmtNum(Number(o.limits.premiumLeadsPerMonth))}</td>
                <td className="td">{o.userCount}</td>
                <td className="td">{fmtDate(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orgs && orgs.length === 0 && <div className="p-6 text-center text-sm text-ink-400">No workspaces match.</div>}
      </div>
      {selected ? <OrgDetailPanel orgId={selected} plans={plans} onChanged={load} onClose={() => setSelected(null)} /> : <div className="card p-5 text-sm text-ink-400">Select a workspace to manage its plan, status, and credits.</div>}
    </div>
  );
}

function LeadsTab({ plans }: { plans: Plan[] }) {
  const [requests, setRequests] = useState<UpgradeRequest[] | null>(null);
  const load = () => adminFetch<{ requests: UpgradeRequest[] }>("GET", "/v1/admin/upgrade-requests").then((r) => setRequests(r.requests));
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    await adminFetch("PATCH", `/v1/admin/upgrade-requests/${id}`, { status });
    load();
  };

  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-ink-400"><th className="th">Name</th><th className="th">Contact</th><th className="th">Country</th><th className="th">Plan wanted</th><th className="th">Status</th><th className="th">Received</th></tr></thead>
        <tbody>
          {requests?.map((r) => (
            <tr key={r.id}>
              <td className="td font-medium text-ink-50">{r.name}{r.message && <div className="max-w-xs truncate text-xs font-normal text-ink-400" title={r.message}>{r.message}</div>}</td>
              <td className="td"><a className="text-brand-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a><div className="text-xs text-ink-400">{r.mobile}</div></td>
              <td className="td">{r.country}</td>
              <td className="td">{plans.find((p) => p.id === r.planId)?.name ?? r.planId}</td>
              <td className="td">
                <select className="input py-1 text-xs" value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}>
                  {["new", "contacted", "converted", "dismissed"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td className="td text-xs text-ink-400">{fmtDate(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {requests && requests.length === 0 && <div className="p-6 text-center text-sm text-ink-400">No upgrade requests yet.</div>}
    </div>
  );
}

function PlansTab({ plans }: { plans: Plan[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
      {plans.map((p) => (
        <div key={p.id} className="card p-4">
          <div className="font-semibold text-ink-50">{p.name}</div>
          <div className="text-2xl font-semibold text-ink-50">${p.priceUsd}<span className="text-sm font-normal text-ink-400">/mo</span></div>
          <ul className="mt-2 space-y-0.5 text-xs text-ink-300">
            <li>{fmtNum(Number(p.limits.leadsPerMonth))} leads/mo</li>
            <li>{fmtNum(Number(p.limits.premiumLeadsPerMonth))} premium leads/mo</li>
            <li>{fmtNum(Number(p.limits.verificationsPerMonth))} verifications</li>
            <li>{fmtNum(Number(p.limits.emailsPerMonth))} emails</li>
            <li>{String(p.limits.seats)} seats · {String(p.limits.campaigns)} campaigns</li>
          </ul>
        </div>
      ))}
      <p className="col-span-full text-xs text-ink-500">Prices and limits are defined in code (packages/db/src/plans.ts) so margins stay auditable — this is a read-only reference, not an editor.</p>
    </div>
  );
}

export function AdminDashboardPage() {
  const token = useAdminToken();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"orgs" | "leads" | "plans">("orgs");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    if (!token) return;
    adminFetch<{ ok: boolean }>("GET", "/v1/admin/session").catch(() => setAuthError(true));
    adminFetch<{ plans: Plan[] }>("GET", "/v1/admin/plans").then((r) => setPlans(r.plans)).catch(() => setPlans([]));
  }, [token]);

  if (!token) return <Navigate to="/admin/login" replace />;
  if (authError) { adminAuth.set(null); return <Navigate to="/admin/login" replace />; }
  if (!plans) return null;

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-4">
        <div className="flex items-center gap-3">
          <Logo size={24} textClassName="text-base" />
          <span className="badge border border-black/10 bg-black/5 text-ink-300">Admin</span>
        </div>
        <button className="btn-secondary" onClick={() => { adminAuth.set(null); navigate("/admin/login"); }}>Sign out</button>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <nav className="mb-5 flex gap-2">
          {([["orgs", "Users & workspaces"], ["leads", "Upgrade requests"], ["plans", "Pricing"]] as const).map(([id, label]) => (
            <button key={id} className={`rounded-lg px-3 py-1.5 text-sm ${tab === id ? "bg-brand-600 text-white" : "text-ink-300 hover:bg-black/5"}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        {tab === "orgs" && <OrgsTab plans={plans} />}
        {tab === "leads" && <LeadsTab plans={plans} />}
        {tab === "plans" && <PlansTab plans={plans} />}
      </main>
    </div>
  );
}
