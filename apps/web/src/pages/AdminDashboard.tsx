import { useEffect, useRef, useState } from "react";
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
type ToolSummary = {
  provider: string;
  label: string;
  category: string;
  keyEnvVar: string | null;
  configured: boolean;
  hasFreeTier: boolean;
  freeTierNote: string | null;
  usageLimit: number | null;
  period: string;
  alertThresholdPct: number;
  notes: string | null;
  currentPeriodKey: string;
  used: number;
  percentUsed: number | null;
  status: "ok" | "warning" | "critical" | "unmetered";
  keyStatus: "not_configured" | "unverified" | "working" | "rejected" | "gated" | "rate_limited" | "out_of_credit" | "erroring" | "retired";
  keyStatusLabel: string;
  retired: boolean;
  lastOutcome: string | null;
  lastStatusCode: number | null;
  lastDetail: string | null;
  lastSeenAt: string | null;
  lastOkAt: string | null;
};

type ProviderCheck = { provider: string; configured: boolean; ok: boolean; outcome: string; status?: number; detail: string; summary: string; endpoint?: string; ms: number };

/**
 * A key's real state, which is not the same as whether the env var is set.
 * "Rejected" and "not on this plan" are kept apart on purpose: a new key fixes the first
 * and does nothing for the second.
 */
const KEY_STATUS_STYLES: Record<ToolSummary["keyStatus"], string> = {
  working: "bg-emerald-50 text-emerald-700",
  unverified: "bg-black/5 text-ink-400",
  not_configured: "bg-black/5 text-ink-400",
  rejected: "bg-red-50 text-red-700",
  gated: "bg-amber-50 text-amber-800",
  rate_limited: "bg-amber-50 text-amber-800",
  out_of_credit: "bg-red-50 text-red-700",
  erroring: "bg-red-50 text-red-700",
  // Grey, not red: there is nothing to fix, so it must not compete for attention with a
  // key that genuinely needs replacing.
  retired: "bg-black/5 text-ink-400",
};

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
  /**
   * These three operations change a customer's plan, deactivate their workspace and grant
   * them credits. All three used to be try/finally with no catch: a failure re-enabled the
   * button, showed nothing, and left the admin believing it had worked. A destructive
   * action that fails silently is worse than one that refuses loudly.
   */
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = () => adminFetch<OrgDetail>("GET", `/v1/admin/orgs/${orgId}`).then((d) => { setDetail(d); setPlan(d.org.plan); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, [orgId]);

  if (err && !detail) return <div className="card p-5 text-sm text-red-600" role="alert">Could not load this workspace: {err} <button className="ml-2 underline" onClick={load}>Retry</button></div>;
  if (!detail) return <div className="card p-5 text-sm text-ink-400">Loading…</div>;

  /** Run an admin mutation, and say plainly whether it worked. */
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      await fn();
      await load();
      onChanged();
      setOkMsg(`${what} saved`);
    } catch (e) {
      setErr(`${what} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const savePlan = () => run("Plan change", () => adminFetch("PATCH", `/v1/admin/orgs/${orgId}/plan`, { plan }));

  const setStatus = async (status: string) => {
    if (status !== "active" && confirmingStatus !== status) {
      setConfirmingStatus(status);
      return;
    }
    setConfirmingStatus(null);
    await run(`Status change to ${status}`, () => adminFetch("PATCH", `/v1/admin/orgs/${orgId}/status`, { status }));
  };

  const applyCredits = () => run("Credit change", () => adminFetch("PATCH", `/v1/admin/orgs/${orgId}/credits`, creditForm));

  return (
    <div className="card sticky top-4 space-y-5 p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-semibold text-ink-50">{detail.org.name}</div>
          <div className="text-xs text-ink-400">{detail.org.slug}</div>
        </div>
        <button className="text-sm text-ink-400 hover:text-ink-50" onClick={onClose}>Close</button>
      </div>

      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {err}
        </div>
      )}
      {okMsg && !err && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700" role="status">
          {okMsg}
        </div>
      )}

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
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Searches used to fire on every keystroke, and a slow early response could land after a
  // later one and overwrite it. Debounce, and only accept the newest request's answer.
  const seq = useRef(0);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = () => {
    const mine = ++seq.current;
    return adminFetch<{ orgs: OrgRow[] }>("GET", `/v1/admin/orgs${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ""}`)
      .then((r) => { if (mine === seq.current) { setOrgs(r.orgs); setLoadErr(null); } })
      .catch((e) => { if (mine === seq.current) setLoadErr((e as Error).message); });
  };
  useEffect(() => { load(); }, [debouncedQ]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="card overflow-x-auto p-0">
        <div className="border-b border-black/10 p-3">
          <input className="input" placeholder="Search workspace or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {loadErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not load workspaces: {loadErr} <button className="ml-2 underline" onClick={load}>Retry</button></div>}
        {!orgs && !loadErr && <div className="p-6 text-center text-sm text-ink-400">Loading…</div>}
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-400"><th className="th">Workspace</th><th className="th">Plan</th><th className="th">Status</th><th className="th">Leads</th><th className="th">Premium</th><th className="th">Users</th><th className="th">Joined</th></tr></thead>
          <tbody>
            {orgs?.map((o) => (
              <tr
                key={o.id}
                className={`cursor-pointer hover:bg-black/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${selected === o.id ? "bg-brand-50" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={`Select workspace ${o.name}`}
                onClick={() => setSelected(o.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(o.id); } }}
              >
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
        {orgs && orgs.length === 0 && !loadErr && <div className="p-6 text-center text-sm text-ink-400">No workspaces match.</div>}
      </div>
      {/* key: a fresh panel per workspace. Without it the previous org's state (loaded detail,
          pending confirm) survived the switch and actions could fire against the wrong org. */}
      {selected ? <OrgDetailPanel key={selected} orgId={selected} plans={plans} onChanged={load} onClose={() => setSelected(null)} /> : <div className="card p-5 text-sm text-ink-400">Select a workspace to manage its plan, status, and credits.</div>}
    </div>
  );
}

function LeadsTab({ plans }: { plans: Plan[] }) {
  const [requests, setRequests] = useState<UpgradeRequest[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const load = () => adminFetch<{ requests: UpgradeRequest[] }>("GET", "/v1/admin/upgrade-requests")
    .then((r) => { setRequests(r.requests); setLoadErr(null); })
    .catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    setActionErr(null);
    try {
      await adminFetch("PATCH", `/v1/admin/upgrade-requests/${id}`, { status });
    } catch (e) {
      setActionErr(`Status change failed: ${(e as Error).message}`);
    }
    load();
  };

  return (
    <div className="card overflow-x-auto p-0">
      {loadErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not load upgrade requests: {loadErr} <button className="ml-2 underline" onClick={load}>Retry</button></div>}
      {actionErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{actionErr}</div>}
      {!requests && !loadErr && <div className="p-6 text-center text-sm text-ink-400">Loading…</div>}
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

const TOOL_STATUS_STYLES: Record<ToolSummary["status"], string> = {
  ok: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-800",
  critical: "bg-red-50 text-red-600",
  unmetered: "bg-black/5 text-ink-400",
};

function ToolRow({ tool, onSaved }: { tool: ToolSummary; onSaved: (t: ToolSummary) => void }) {
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(tool.usageLimit ?? "");
  const [threshold, setThreshold] = useState(tool.alertThresholdPct);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const updated = await adminFetch<ToolSummary>("PATCH", `/v1/admin/tools/${tool.provider}`, {
        usageLimit: limit === "" ? null : Number(limit),
        alertThresholdPct: threshold,
      });
      onSaved(updated);
      setEditing(false);
    } catch (e) {
      // Without this a rejected limit closed nothing and said nothing - it looked saved.
      setSaveErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="td">
        <div className="font-medium text-ink-50">{tool.label}</div>
        <div className="text-xs text-ink-400">{tool.category}</div>
      </td>
      <td className="td text-xs text-ink-400">
        {tool.keyEnvVar ? (
          <span className="flex flex-col gap-1">
            <span className={`badge w-fit ${KEY_STATUS_STYLES[tool.keyStatus]}`} title={tool.lastDetail ?? undefined}>
              {tool.keyStatusLabel}
            </span>
            {tool.keyStatus === "unverified" && <span className="text-[11px] text-ink-500">nothing has called it yet</span>}
            {tool.lastDetail && tool.keyStatus !== "working" && <span className="max-w-[220px] text-[11px] text-ink-500">{tool.lastDetail}</span>}
            {tool.keyStatus === "not_configured" && <span className="text-[11px] text-ink-500">{tool.keyEnvVar}</span>}
          </span>
        ) : (
          "keyless"
        )}
      </td>
      <td className="td text-xs text-ink-400">{tool.freeTierNote ?? "—"}{tool.notes && <div className="mt-0.5 italic">{tool.notes}</div>}</td>
      <td className="td">
        {tool.usageLimit !== null ? (
          <div className="w-32">
            <div className="mb-1 text-xs text-ink-400">{fmtNum(tool.used)} / {fmtNum(tool.usageLimit)} <span className="text-ink-500">/{tool.period}</span></div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className={`h-full ${tool.status === "critical" ? "bg-red-500" : tool.status === "warning" ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(100, tool.percentUsed ?? 0)}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-xs text-ink-400">{fmtNum(tool.used)} calls{tool.period ? ` /${tool.period}` : ""} · no limit set</span>
        )}
      </td>
      <td className="td"><span className={`badge ${TOOL_STATUS_STYLES[tool.status]}`}>{tool.status === "unmetered" ? "no alert set" : tool.status}</span></td>
      <td className="td">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input className="input w-20 py-1 text-xs" type="number" min={0} placeholder="limit" value={limit} onChange={(e) => setLimit(e.target.value === "" ? "" : Number(e.target.value))} />
            <input className="input w-16 py-1 text-xs" type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} title="Alert at % used" />
            <button className="btn-primary py-1 text-xs" disabled={busy} onClick={save}>Save</button>
            <button className="text-xs text-ink-400 hover:text-ink-50" onClick={() => { setEditing(false); setSaveErr(null); }}>Cancel</button>
            {saveErr && <span className="text-xs text-red-600" role="alert">{saveErr}</span>}
          </div>
        ) : (
          <button className="btn-secondary py-1 text-xs" onClick={() => setEditing(true)}>Set limit</button>
        )}
      </td>
    </tr>
  );
}

function ToolsTab() {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ results: ProviderCheck[]; summary: string; checkedAt: string } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Uncaught before: a failed load left "Loading…" on screen forever.
  const load = () => adminFetch<{ tools: ToolSummary[] }>("GET", "/v1/admin/tools")
    .then((r) => { setTools(r.tools); setLoadErr(null); })
    .catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { load(); }, []);

  // Spends one real request per configured provider. Worth saying out loud on a page whose
  // whole subject is free tiers measured in tens of calls a month.
  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const r = await adminFetch<{ results: ProviderCheck[]; summary: string; checkedAt: string }>("POST", "/v1/admin/tools/check", {});
      setCheck(r);
      await load();
    } catch (e) {
      setCheckError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!tools && loadErr) return <div className="card p-5 text-sm text-red-700" role="alert">Could not load tools: {loadErr} <button className="ml-2 underline" onClick={load}>Retry</button></div>;
  if (!tools) return <div className="card p-5 text-sm text-ink-400">Loading…</div>;

  // Retired providers are deliberately excluded: a banner that keeps demanding a fix which
  // does not exist teaches people to stop reading banners.
  const keyProblems = tools.filter(
    (t) => !t.retired && (t.keyStatus === "rejected" || t.keyStatus === "erroring" || t.keyStatus === "gated" || t.keyStatus === "rate_limited" || t.keyStatus === "out_of_credit"),
  );
  const retired = tools.filter((t) => t.retired);
  const needsAttention = tools.filter((t) => t.status === "warning" || t.status === "critical");
  const byCategory = tools.reduce<Record<string, ToolSummary[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {needsAttention.length > 0 && (
        <div className="card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-semibold">Needs attention:</span>{" "}
          {needsAttention.map((t) => `${t.label} (${t.percentUsed}% of ${t.usageLimit}/${t.period})`).join(", ")}
        </div>
      )}
      {keyProblems.length > 0 && (
        <div className="card border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <div className="font-semibold">Keys not working</div>
          <ul className="mt-1 space-y-0.5">
            {keyProblems.map((t) => (
              <li key={t.provider}>
                <span className="font-medium">{t.label}</span>: {t.keyStatusLabel}
                {t.lastDetail ? ` - ${t.lastDetail}` : ""}
                {t.keyStatus === "gated" ? " (the key is fine; a replacement will not help)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {retired.length > 0 && (
        <div className="card border border-black/10 bg-black/[0.02] p-4 text-sm text-ink-300">
          <div className="font-semibold text-ink-100">Retired by the provider</div>
          <ul className="mt-1 space-y-0.5">
            {retired.map((t) => (
              <li key={t.provider}>
                <span className="font-medium">{t.label}</span>
                {t.notes ? ` - ${t.notes}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          <div className="font-medium">Are these keys actually working?</div>
          <p className="mt-0.5 text-xs text-ink-500">
            A key being set is not the same as a key being accepted. This calls each provider once, for real, and records
            what came back. It spends one request per provider against free tiers that are measured in tens of calls a month.
          </p>
        </div>
        <button className="btn-primary shrink-0" disabled={checking} onClick={runCheck}>
          {checking ? "Testing…" : "Test all keys"}
        </button>
      </div>

      {checkError && <div className="card border border-red-200 bg-red-50 p-3 text-sm text-red-800">{checkError}</div>}

      {check && (
        <div className="card p-0">
          <div className="border-b border-black/5 px-4 py-2 text-xs text-ink-500">
            {check.summary} Checked {new Date(check.checkedAt).toLocaleString()}.
          </div>
          <ul className="divide-y divide-black/5 text-sm">
            {check.results.map((r) => (
              <li key={r.provider} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2">
                <div className="min-w-0">
                  <span className="font-medium">{r.provider}</span>
                  <span className="ml-2 text-xs text-ink-400">{r.endpoint ?? ""}</span>
                  <div className="text-xs text-ink-500">{r.summary}</div>
                </div>
                <span
                  className={`badge shrink-0 ${!r.configured ? "bg-black/5 text-ink-400" : r.ok ? "bg-emerald-50 text-emerald-700" : r.outcome === "forbidden" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`}
                >
                  {!r.configured ? "no key" : r.ok ? `ok · ${r.ms}ms` : r.outcome}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-ink-500">
        Every 3rd-party API Scout calls, reconciled against what's actually used, with the free-tier limit for each. Set (or adjust) a limit and Scout emails you the moment a tool crosses it, so you know exactly which one to upgrade.
      </p>
      {Object.entries(byCategory).map(([category, rows]) => (
        <div key={category} className="card overflow-x-auto p-0">
          <div className="border-b border-black/5 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{category}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-400">
                <th className="th">Tool</th>
                <th className="th">Key</th>
                <th className="th">Free tier</th>
                <th className="th">Usage this period</th>
                <th className="th">Status</th>
                <th className="th">Alert limit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <ToolRow key={t.provider} tool={t} onSaved={(updated) => setTools((prev) => prev!.map((x) => (x.provider === updated.provider ? updated : x)))} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
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

interface BalanceLine { label: string; remaining: number | null; used: number | null; limit: number | null }
interface ProviderBalance { provider: string; name: string; role: string; configured: boolean; status: "ok" | "error" | "not_configured" | "no_endpoint"; lines: BalanceLine[]; resetsAt: string | null; billing: string; summary: string; low: boolean; checkedAt: string }

/**
 * What is left on every paid provider, read live from each provider's own free account
 * endpoint. Nothing here spends a credit.
 */
function CreditsTab() {
  const [rows, setRows] = useState<ProviderBalance[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await adminFetch<{ balances: ProviderBalance[] }>("GET", "/v1/admin/balances");
      setRows(r.balances);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const order = { error: 0, ok: 1, no_endpoint: 2, not_configured: 3 } as const;
  const sorted = [...(rows ?? [])].sort((a, b) => Number(b.low) - Number(a.low) || order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const tone = (b: ProviderBalance) =>
    b.status === "error" ? "border-red-200 bg-red-50/40" : b.low ? "border-amber-200 bg-amber-50/40" : b.status === "not_configured" ? "opacity-70" : "";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-400">
          Remaining credits, read from each provider's own account API. Providers with no such API say so and point to their dashboard, rather than showing a number we would have to make up.
        </p>
        <button className="btn-secondary" onClick={load} disabled={busy}>{busy ? "Checking…" : "Refresh"}</button>
      </div>
      {err && <div className="card mb-4 p-4 text-sm text-red-700">{err}</div>}
      {!rows ? (
        <div className="card p-5 text-sm text-ink-400">Checking every provider…</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sorted.map((b) => (
            <div key={b.provider} className={`card p-4 ${tone(b)}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-ink-50">{b.name}</div>
                  <div className="text-xs text-ink-400">{b.role}</div>
                </div>
                <span className={`badge ${b.status === "ok" ? (b.low ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700") : b.status === "error" ? "bg-red-50 text-red-700" : "bg-black/[0.05] text-ink-400"}`}>
                  {b.status === "ok" ? (b.low ? "Low" : "OK") : b.status === "error" ? "Error" : b.status === "no_endpoint" ? "No balance API" : "Not set up"}
                </span>
              </div>
              {b.lines.length > 0 && (
                <div className="mt-3 space-y-1">
                  {b.lines.map((l) => (
                    <div key={l.label} className="flex items-baseline justify-between text-sm">
                      <span className="capitalize text-ink-300">{l.label}</span>
                      <span className="tabular-nums text-ink-50">
                        <b>{l.remaining === null ? "-" : l.remaining.toLocaleString()}</b> left
                        {l.limit !== null && <span className="text-ink-400"> of {l.limit.toLocaleString()}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 text-xs text-ink-300">{b.summary}</div>
              <div className="mt-1 text-[11px] text-ink-400">{b.billing}{b.resetsAt ? ` · resets ${b.resetsAt}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminDashboardPage() {
  const token = useAdminToken();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"orgs" | "leads" | "tools" | "credits" | "plans">("orgs");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [authError, setAuthError] = useState(false);
  const [plansErr, setPlansErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    // Only a rejected token means "sign in again"; a network blip used to log the admin out.
    adminFetch<{ ok: boolean }>("GET", "/v1/admin/session").catch((e) => { if ([401, 403].includes((e as { status?: number }).status ?? 0)) setAuthError(true); });
    adminFetch<{ plans: Plan[] }>("GET", "/v1/admin/plans").then((r) => { setPlans(r.plans); setPlansErr(null); }).catch((e) => { setPlans([]); setPlansErr((e as Error).message); });
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
        {plansErr && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not load plans ({plansErr}) - plan names and the plan picker will be incomplete. Reload to retry.</div>}
        <nav className="mb-5 flex gap-2">
          {([["orgs", "Users & workspaces"], ["leads", "Upgrade requests"], ["tools", "Tools & limits"], ["credits", "Credits left"], ["plans", "Pricing"]] as const).map(([id, label]) => (
            <button key={id} className={`rounded-lg px-3 py-1.5 text-sm ${tab === id ? "bg-brand-600 text-white" : "text-ink-300 hover:bg-black/5"}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        {tab === "orgs" && <OrgsTab plans={plans} />}
        {tab === "leads" && <LeadsTab plans={plans} />}
        {tab === "tools" && <ToolsTab />}
        {tab === "credits" && <CreditsTab />}
        {tab === "plans" && <PlansTab plans={plans} />}
      </main>
    </div>
  );
}
