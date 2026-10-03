import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { adminFetch, adminLogout, endAdminSession, useAdminToken } from "../lib/adminApi";
import { expectLists, expectShape, fmtDate, fmtNum } from "../lib/api";
import { plural } from "../lib/plural";

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
// `overrides` (the limits that differ from the plan's own) is sent by newer servers, at the
// top level or on the org; older ones send neither and it is worked out here (overridesOf).
type OrgDetail = { org: OrgRow & { planLimits: Record<string, unknown> | null; overrides?: Record<string, unknown> | null }; overrides?: Record<string, unknown> | null; users: OrgUser[]; usage: Record<string, number>; period: string };
type UpgradeRequest = { id: string; orgId: string | null; orgName?: string | null; name: string; email: string; mobile: string; country: string; planId: string; message: string | null; status: string; createdAt: string };
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

/**
 * Text-style buttons (Close, Cancel, Retry) and badge-buttons are a few pixels tall on a
 * desktop, which is fine with a mouse and a miss with a thumb. Below the desktop breakpoint
 * they get a 40px target; the visible text does not change.
 */
const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

/** Below this the workspace panel is a full-screen sheet instead of a side column. */
const NARROW_QUERY = "(max-width: 1023.98px)";
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

const errText = (e: unknown) => (e as Error)?.message || "Something went wrong.";

// ── Plan limits, in words ──
const LIMIT_LABELS: Record<string, string> = {
  leadsPerMonth: "leads/month",
  premiumLeadsPerMonth: "premium leads/month",
  searchesPerMonth: "searches/month",
  verificationsPerMonth: "verifications/month",
  aiMessagesPerMonth: "AI messages/month",
  emailsPerMonth: "emails/month",
  emailsPerDay: "emails/day",
  campaigns: "campaigns",
  seats: "seats",
  apiAccess: "API access",
  integrations: "integrations",
};
const limitLabel = (k: string) => LIMIT_LABELS[k] ?? k.replace(/PerMonth$/, "/month").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
/**
 * A stored monthly limit of 0 means "no limit" - except premium leads, where 0 is the plan
 * including none (the same rule the customer dashboard applies, lib/metrics.ts). Printed as a
 * bare 0 it read as the opposite: "3/0" looked over quota and "leads/month 0" like a block.
 */
const ZERO_IS_UNLIMITED = new Set(["leadsPerMonth", "searchesPerMonth", "verificationsPerMonth", "aiMessagesPerMonth", "emailsPerMonth"]);
const limitValue = (v: unknown, key?: string) =>
  typeof v === "number"
    ? v <= 0 && key && ZERO_IS_UNLIMITED.has(key) ? "no limit" : fmtNum(v)
    : typeof v === "boolean" ? (v ? "on" : "off") : v === null || v === undefined ? "-" : typeof v === "string" ? v : JSON.stringify(v);
const overridesText = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${limitLabel(k)} ${limitValue(v, k)}`).join(", ");
/** "12 / 1,000", "12 / no limit", "0 / 0" (premium leads) - a usage cell. */
const usedOf = (used: number, limit: unknown, key: string) => `${fmtNum(used)} / ${typeof limit === "number" ? limitValue(limit, key) : "-"}`;

/**
 * The limits this workspace has that its plan does not give it.
 *
 * Newer servers say so directly. For an older one it is the stored limits that differ from
 * the plan's defaults - or null ("cannot tell") when the plan list has not loaded or the
 * workspace is on a plan this build does not know.
 */
function overridesOf(detail: OrgDetail, plans: Plan[] | null): Record<string, unknown> | null {
  const fromServer = detail.overrides ?? detail.org.overrides;
  if (fromServer && typeof fromServer === "object" && !Array.isArray(fromServer)) return fromServer;
  const base = plans?.find((p) => p.id === detail.org.plan)?.limits;
  const stored = detail.org.planLimits;
  if (!base) return null;
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (JSON.stringify(v) !== JSON.stringify(base[k])) out[k] = v;
  return out;
}

// ── Credits ──
const CREDIT_METRICS = [
  ["leads", "Leads", "leadsPerMonth"],
  ["premiumLeads", "Premium leads", "premiumLeadsPerMonth"],
  ["searches", "Searches", "searchesPerMonth"],
  ["verifications", "Verifications", "verificationsPerMonth"],
  ["aiMessages", "AI messages", "aiMessagesPerMonth"],
  ["emails", "Emails", "emailsPerMonth"],
] as const;
const metricLabel = (m: string) => CREDIT_METRICS.find(([id]) => id === m)?.[1] ?? m;
const metricLimitKey = (m: string) => CREDIT_METRICS.find(([id]) => id === m)?.[2];
const CREDIT_MAX = 1_000_000;

/**
 * What the admin typed, as the number to send - or the reason it will not be sent.
 *
 * The field used to be a number held in state. Typing "-5" passed through "-" (which a
 * number input reports as empty, i.e. 0) and came out as "05": the admin asked to take five
 * away and five were granted. "abc" and an empty field sent 0 and were reported as saved,
 * "1e3" sent 3. So the text is kept exactly as typed and judged once, here, on Apply.
 */
export function parseCreditAmount(raw: string, action: "grant" | "set"): { ok: true; amount: number } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: false, error: "Enter an amount." };
  if (!/^[+-]?\d+$/.test(t)) return { ok: false, error: `"${t}" is not a whole number. Use digits only, e.g. 500 or -500.` };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || Math.abs(n) > CREDIT_MAX) return { ok: false, error: `The amount must be between -${fmtNum(CREDIT_MAX)} and ${fmtNum(CREDIT_MAX)}.` };
  if (action === "grant" && n === 0) return { ok: false, error: "Enter a non-zero amount: a positive number gives credits, a negative number takes them away." };
  if (action === "set" && n < 0) return { ok: false, error: "Used cannot be set below 0." };
  // -0 is a number JSON cannot say; "set used to -0" means 0.
  return { ok: true, amount: n === 0 ? 0 : n };
}

type PlanResponse = { plan?: string; limits?: Record<string, unknown>; overrides?: Record<string, unknown> | null; changed?: boolean; note?: string };
type CreditsResponse = { metric?: string; used?: number; limit?: number | null; changed?: boolean; note?: string };

function OrgDetailPanel({ orgId, plans, plansLoading, onChanged, onClose }: { orgId: string; plans: Plan[] | null; plansLoading: boolean; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [plan, setPlan] = useState("");
  const [clearOverrides, setClearOverrides] = useState(false);
  const [busy, setBusy] = useState(false);
  // The amount is text, not a number - see parseCreditAmount.
  const [creditForm, setCreditForm] = useState({ metric: "premiumLeads", action: "grant" as "grant" | "set", amount: "" });
  const [creditErr, setCreditErr] = useState<string | null>(null);
  const [confirmingStatus, setConfirmingStatus] = useState<string | null>(null);
  /**
   * These three operations change a customer's plan, deactivate their workspace and grant
   * them credits. All three used to be try/finally with no catch: a failure re-enabled the
   * button, showed nothing, and left the admin believing it had worked. A destructive
   * action that fails silently is worse than one that refuses loudly.
   */
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<{ text: string; unchanged: boolean } | null>(null);
  // A save that worked but whose refresh failed is two facts, said separately.
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const load = useCallback(
    () =>
      adminFetch<OrgDetail>("GET", `/v1/admin/orgs/${orgId}`)
        .then((r) => {
          const d = expectShape(expectLists(r, "users"), (x) => !!x.org && typeof x.org.id === "string" && !!x.usage && typeof x.usage === "object");
          setDetail(d); setPlan(d.org.plan); setClearOverrides(false); setRefreshErr(null);
          return d;
        })
        .catch((e) => { setRefreshErr(errText(e)); return null; }),
    [orgId],
  );
  useEffect(() => { void load(); }, [load]);

  if (!detail) {
    return refreshErr ? (
      <div className="card p-5 text-sm text-red-600" role="alert">Could not load this workspace: {refreshErr} <button className={LINK_BTN} onClick={() => void load()}>Retry</button></div>
    ) : (
      <div className="card p-5 text-sm text-ink-400" role="status">Loading workspace…</div>
    );
  }

  /**
   * Run an admin mutation, and say plainly what it did - including when it did nothing.
   * A server that answers `changed: false` made no change and wrote no audit row; "saved"
   * for that is a small lie that makes the audit log look incomplete later.
   */
  const run = async <R,>(what: string, fn: () => Promise<R>, describe?: (r: R) => string | null) => {
    setBusy(true);
    setErr(null);
    setOkMsg(null);
    try {
      const r = await fn();
      const info = (r ?? {}) as { changed?: unknown; note?: unknown };
      const unchanged = info.changed === false;
      const line = describe?.(r) ?? null;
      // "Nothing changed." is said once, here. A note that opens with the same words has them
      // taken off rather than printed twice.
      const rawNote = typeof info.note === "string" ? info.note.trim() : "";
      const note = (unchanged ? rawNote.replace(/^nothing changed[.:!]?\s*/i, "") : rawNote) || null;
      setOkMsg({ text: [unchanged ? "Nothing changed." : line ? null : `${what} saved.`, line, note].filter(Boolean).join(" "), unchanged });
      await load();
      onChanged();
      return true;
    } catch (e) {
      setErr(`${what} failed: ${errText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const org = detail.org;
  const knownPlan = plans?.find((p) => p.id === org.plan) ?? null;
  const planUnknown = !!plans && plans.length > 0 && !knownPlan;
  const overrides = overridesOf(detail, plans);
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
  const planDirty = plan !== org.plan;
  const canSavePlan = !busy && !!plans?.some((p) => p.id === plan) && (planDirty || (clearOverrides && hasOverrides));

  const savePlan = () =>
    run(
      "Plan change",
      () => adminFetch<PlanResponse>("PATCH", `/v1/admin/orgs/${orgId}/plan`, { plan, ...(clearOverrides ? { overrides: {} } : {}) }),
      (r) => {
        const name = plans?.find((p) => p.id === (r?.plan ?? plan))?.name ?? r?.plan ?? plan;
        const kept = r?.overrides && typeof r.overrides === "object" ? Object.keys(r.overrides).length : null;
        // The server's own note (when it sends one) already says which limits were kept.
        return `Plan is ${name}.${r?.note || kept === null ? "" : kept === 0 ? " No custom limits." : ` Custom limits: ${overridesText(r.overrides!)}.`}`;
      },
    );

  const setStatus = async (status: string) => {
    if (status === org.status) return;
    if (status !== "active" && confirmingStatus !== status) {
      setConfirmingStatus(status);
      return;
    }
    setConfirmingStatus(null);
    await run(`Status change to ${status}`, () => adminFetch<{ status?: string; changed?: boolean; note?: string }>("PATCH", `/v1/admin/orgs/${orgId}/status`, { status }), (r) => `Status is ${r?.status ?? status}.`);
  };

  const applyCredits = async () => {
    const parsed = parseCreditAmount(creditForm.amount, creditForm.action);
    if (!parsed.ok) {
      // Nothing is sent. The message sits under the field, not in the banner at the top of
      // the panel, because that is where the admin is looking.
      // The green line above is about the previous save, not this attempt.
      setOkMsg(null);
      setErr(null);
      setCreditErr(parsed.error);
      return;
    }
    setCreditErr(null);
    const { metric, action } = creditForm;
    const limitKey = metricLimitKey(metric);
    const knownLimit = limitKey && typeof org.limits?.[limitKey] === "number" ? (org.limits[limitKey] as number) : undefined;
    const saved = await run(
      "Credit change",
      () => adminFetch<CreditsResponse>("PATCH", `/v1/admin/orgs/${orgId}/credits`, { metric, action, amount: parsed.amount }),
      (r) => {
        if (typeof r?.used !== "number") return null;
        // `limit` comes with newer servers (null = no limit); an older one sends only `used`.
        const limit = r.limit === null ? null : typeof r.limit === "number" ? r.limit : knownLimit;
        const none = limit === null || (limit === 0 && metric !== "premiumLeads");
        return `${metricLabel(metric)}: ${fmtNum(r.used)} used${none ? " (no limit)" : limit === undefined ? "" : ` of ${fmtNum(limit as number)}`} this period.`;
      },
    );
    if (saved) setCreditForm((f) => ({ ...f, amount: "" }));
  };

  const usedNow = detail.usage[creditForm.metric] ?? 0;
  const usageLine = CREDIT_METRICS.filter(([id]) => detail.usage[id] !== undefined).map(([id, label, key]) => {
    const lim = org.limits?.[key];
    return `${label} ${typeof lim === "number" ? usedOf(detail.usage[id], lim, key) : fmtNum(detail.usage[id])}`;
  });

  return (
    <div className="card space-y-5 p-5" data-testid="org-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2 className="font-semibold text-ink-50" data-testid="org-panel-heading">{org.name}</h2>
          <div className="text-xs text-ink-400">{org.slug}</div>
        </div>
        <button className={`${TAP} shrink-0 text-sm text-ink-400 hover:text-ink-50 max-lg:hidden`} onClick={onClose}>Close</button>
      </div>

      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
          {err}
        </div>
      )}
      {okMsg && !err && (
        <div className={`rounded-lg border p-3 text-sm [overflow-wrap:anywhere] ${okMsg.unchanged ? "border-black/10 bg-black/[0.03] text-ink-200" : "border-emerald-300 bg-emerald-50 text-emerald-700"}`} role="status" data-testid="org-panel-result">
          {okMsg.text}
        </div>
      )}
      {refreshErr && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 [overflow-wrap:anywhere]" role="alert">
          This panel could not be refreshed ({refreshErr}), so the values below may be out of date. <button className={LINK_BTN} onClick={() => void load()}>Retry</button>
        </div>
      )}

      <div>
        <div className="label">Plan</div>
        {planUnknown && (
          <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="status">
            Unknown plan: <b>{org.plan}</b> - pick a plan to repair. Until then this workspace gets no plan limits of its own.
          </div>
        )}
        <div className="flex gap-2">
          <select className="input min-w-0" aria-label="Plan" value={plan} disabled={!plans?.length} onChange={(e) => setPlan(e.target.value)}>
            {!knownPlan && <option value={org.plan} disabled>{plans && plans.length > 0 ? `Unknown plan: ${org.plan}` : `${org.plan} (${plansLoading ? "loading plans…" : "plan list not loaded"})`}</option>}
            {plans?.map((p) => <option key={p.id} value={p.id}>{p.name} (${p.priceUsd}/mo)</option>)}
          </select>
          <button className="btn-secondary shrink-0" disabled={!canSavePlan} onClick={savePlan}>Save</button>
        </div>
        {overrides === null ? (
          plans && plans.length > 0 ? <div className="mt-2 text-xs text-ink-400">Custom limits cannot be shown until this workspace is on a known plan.</div> : null
        ) : hasOverrides ? (
          <div className="mt-2 rounded-lg bg-black/[0.03] p-2 text-xs text-ink-300" data-testid="org-overrides">
            <div className="font-medium text-ink-200">Custom limits</div>
            <ul className="mt-1 space-y-0.5 [overflow-wrap:anywhere]">
              {Object.entries(overrides).map(([k, v]) => <li key={k}>{limitLabel(k)} <b className="font-semibold text-ink-100">{limitValue(v, k)}</b></li>)}
            </ul>
            {planDirty && !clearOverrides && <div className="mt-2 text-amber-800">These custom limits are kept when the plan changes, unless you clear them.</div>}
            <label className="mt-2 flex items-center gap-2 max-lg:min-h-[40px]">
              <input type="checkbox" checked={clearOverrides} onChange={(e) => setClearOverrides(e.target.checked)} />
              <span>Clear custom limits (use the plan's own limits) when saving</span>
            </label>
          </div>
        ) : (
          <div className="mt-2 text-xs text-ink-400">No custom limits - this workspace has exactly what its plan gives.</div>
        )}
      </div>

      <div>
        <div className="label">Status</div>
        <div className="flex flex-wrap items-center gap-2">
          {["active", "deactivated", "revoked"].map((s) => {
            const current = org.status === s;
            return (
              <button
                key={s}
                className={`badge max-lg:min-h-[40px] max-lg:px-3 ${current ? `${STATUS_STYLES[s]} cursor-default ring-1 ring-black/10` : "cursor-pointer border border-black/10 bg-black/5 text-ink-300 hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-60"}`}
                disabled={busy || current}
                aria-pressed={current}
                title={current ? "This is the current status" : undefined}
                onClick={() => setStatus(s)}
              >
                {s}
              </button>
            );
          })}
          {!["active", "deactivated", "revoked"].includes(org.status) && <span className="text-xs text-amber-800">Current status: {org.status} (not one this console knows)</span>}
        </div>
        {confirmingStatus && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
            <span>{confirmingStatus === "revoked" ? "Revoke" : "Deactivate"} {org.name}? They'll be locked out immediately.</span>
            <button className="btn-secondary py-1 text-xs max-lg:min-h-[40px]" disabled={busy} onClick={() => setStatus(confirmingStatus)}>Confirm</button>
            <button className={`${TAP} text-ink-400 hover:text-ink-50`} onClick={() => setConfirmingStatus(null)}>Cancel</button>
          </div>
        )}
      </div>

      <div>
        <div className="label">Grant / set credits ({detail.period})</div>
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          <select className="input" aria-label="Credit type" value={creditForm.metric} onChange={(e) => { setCreditForm({ ...creditForm, metric: e.target.value }); setCreditErr(null); }}>
            {CREDIT_METRICS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select className="input" aria-label="How to apply" value={creditForm.action} onChange={(e) => { setCreditForm({ ...creditForm, action: e.target.value as "grant" | "set" }); setCreditErr(null); }}>
            <option value="grant">Grant N credits</option>
            <option value="set">Set used to N</option>
          </select>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className={`input min-w-0 flex-1 ${creditErr ? "border-red-400" : ""}`}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="Amount"
            aria-invalid={!!creditErr}
            aria-describedby={creditErr ? "credit-amount-error" : "credit-amount-hint"}
            placeholder={creditForm.action === "grant" ? "e.g. 500, or -500 to take away" : "e.g. 0"}
            value={creditForm.amount}
            onChange={(e) => { setCreditForm({ ...creditForm, amount: e.target.value }); if (creditErr) setCreditErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) { e.preventDefault(); void applyCredits(); } }}
          />
          <button className="btn-secondary shrink-0 justify-center" disabled={busy} onClick={() => void applyCredits()}>{busy ? "Saving…" : "Apply"}</button>
        </div>
        {creditErr ? (
          <div id="credit-amount-error" className="mt-1 text-xs text-red-700" role="alert">{creditErr} Nothing was sent.</div>
        ) : (
          <div id="credit-amount-hint" className="mt-1 text-xs text-ink-400">
            {creditForm.action === "grant"
              ? `Granting lowers "used" for this period. ${metricLabel(creditForm.metric)} used now: ${fmtNum(usedNow)}.`
              : `Sets "used" for this period to exactly N. ${metricLabel(creditForm.metric)} used now: ${fmtNum(usedNow)}.`}
          </div>
        )}
        <div className="mt-2 text-xs text-ink-400 [overflow-wrap:anywhere]">
          Used this period: {usageLine.length ? usageLine.join(" · ") : "none yet"}
        </div>
      </div>

      <div>
        <div className="label">Users ({detail.users.length})</div>
        <ul className="space-y-1 text-sm text-ink-300 [overflow-wrap:anywhere]">
          {detail.users.map((u) => <li key={u.id}>{u.name || u.email} <span className="text-ink-500">· {u.email} · {u.role}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

function OrgsTab({ plans, plansLoading, selected, onSelect }: { plans: Plan[] | null; plansLoading: boolean; selected: string | null; onSelect: (id: string | null) => void }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const narrow = useNarrow();
  const backRef = useRef<HTMLButtonElement>(null);
  // Searches used to fire on every keystroke, and a slow early response could land after a
  // later one and overwrite it. Debounce, and only accept the newest request's answer.
  const seq = useRef(0);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = () => {
    const mine = ++seq.current;
    return adminFetch<{ orgs: OrgRow[] }>("GET", `/v1/admin/orgs${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ""}`)
      .then((r) => { if (mine === seq.current) { setOrgs(expectLists(r, "orgs").orgs); setLoadErr(null); } })
      .catch((e) => { if (mine === seq.current) setLoadErr(errText(e)); });
  };
  useEffect(() => { load(); }, [debouncedQ]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * On a phone the panel used to render below the table - thousands of pixels below the row
   * that was tapped, with nothing on screen to say anything had happened. There it is a
   * full-screen sheet with a Back button; the page behind it does not scroll.
   */
  const sheet = narrow && !!selected;
  useEffect(() => {
    if (!sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [sheet, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    const id = selected;
    onSelect(null);
    // Back to the row the admin came from, not the top of the document.
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-org-row="${id}"]`)?.focus(), 0);
  };
  const planCell = (id: string) => {
    const known = plans?.find((p) => p.id === id);
    if (known) return known.name;
    return plans && plans.length > 0 ? <span className="text-amber-800" title="This plan id is not one of the plans this build knows">Unknown ({id})</span> : <span className="capitalize">{id}</span>;
  };

  return (
    // items-start: a stretched side column made the sticky panel as tall as the whole list,
    // so with a long list the panel's content sat far above the viewport.
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="card min-w-0 overflow-x-auto p-0">
        <div className="border-b border-black/10 p-3">
          <input className="input" placeholder="Search workspace or email…" aria-label="Search workspace or email" maxLength={200} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mt-2 text-xs text-ink-400 lg:hidden">Tap a workspace to manage its plan, status and credits.</div>
        </div>
        {loadErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not load workspaces: {loadErr} <button className={LINK_BTN} onClick={load}>Retry</button></div>}
        {!orgs && !loadErr && <div className="p-6 text-center text-sm text-ink-400" role="status">Loading workspaces…</div>}
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-400"><th className="th">Workspace</th><th className="th">Plan</th><th className="th">Status</th><th className="th">Leads</th><th className="th">Premium</th><th className="th">Users</th><th className="th">Joined</th></tr></thead>
          <tbody>
            {orgs?.map((o) => (
              <tr
                key={o.id}
                data-org-row={o.id}
                className={`cursor-pointer hover:bg-black/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${selected === o.id ? "bg-brand-50" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={`Select workspace ${o.name}`}
                aria-pressed={selected === o.id}
                onClick={() => onSelect(o.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(o.id); } }}
              >
                <td className="td"><div className="font-medium text-ink-50">{o.name}</div><div className="text-xs text-ink-400">{o.ownerEmail ?? "-"}</div></td>
                <td className="td">{planCell(o.plan)}</td>
                <td className="td"><StatusBadge status={o.status} /></td>
                <td className="td whitespace-nowrap">{usedOf(o.leadsUsed, o.limits?.leadsPerMonth, "leadsPerMonth")}</td>
                <td className="td whitespace-nowrap">{usedOf(o.premiumLeadsUsed, o.limits?.premiumLeadsPerMonth, "premiumLeadsPerMonth")}</td>
                <td className="td">{o.userCount}</td>
                <td className="td">{fmtDate(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orgs && orgs.length === 0 && !loadErr && <div className="p-6 text-center text-sm text-ink-400">No workspaces match.</div>}
      </div>
      {selected ? (
        <div
          className={narrow ? "fixed inset-0 z-40 overflow-y-auto bg-cream" : "sticky top-2 -m-2 max-h-[calc(100vh-1rem)] self-start overflow-y-auto p-2"}
          data-testid="org-panel-wrap"
          {...(narrow ? { role: "dialog", "aria-modal": true, "aria-label": "Workspace details" } : {})}
        >
          {narrow && (
            <div className="sticky top-0 z-10 border-b border-black/10 bg-cream px-4 py-2">
              <button ref={backRef} className="btn-secondary min-h-[40px]" onClick={close}>← Back to workspaces</button>
            </div>
          )}
          <div className={narrow ? "p-4" : ""}>
            {/* key: a fresh panel per workspace. Without it the previous org's state (loaded detail,
                pending confirm) survived the switch and actions could fire against the wrong org. */}
            <OrgDetailPanel key={selected} orgId={selected} plans={plans} plansLoading={plansLoading} onChanged={load} onClose={close} />
          </div>
        </div>
      ) : (
        <div className="card p-5 text-sm text-ink-400 max-lg:hidden">Select a workspace to manage its plan, status, and credits.</div>
      )}
    </div>
  );
}

const REQUEST_STATUSES = ["new", "contacted", "converted", "dismissed"];

function LeadsTab({ plans, onViewOrg }: { plans: Plan[] | null; onViewOrg: (orgId: string) => void }) {
  const [requests, setRequests] = useState<UpgradeRequest[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const loadSeq = useRef(0);
  // One counter per row: only the newest change to a row may write its result back.
  const rowSeq = useRef(new Map<string, number>());
  const load = () => {
    const mine = ++loadSeq.current;
    return adminFetch<{ requests: UpgradeRequest[] }>("GET", "/v1/admin/upgrade-requests")
      .then((r) => { if (mine === loadSeq.current) { setRequests(expectLists(r, "requests").requests); setLoadErr(null); } })
      .catch((e) => { if (mine === loadSeq.current) setLoadErr(errText(e)); });
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Change one request's status.
   *
   * It used to PATCH and then reload the whole list, with the select live throughout. Two
   * quick changes raced: the first reload could land after the second PATCH and put the old
   * value back on screen, so the row ended on a status the admin had not chosen last. Now
   * the row's select is disabled while its save is in flight, the row is updated from the
   * PATCH's own answer, and an answer that is not the newest for that row is ignored.
   */
  const setStatus = async (id: string, status: string) => {
    const prev = requests?.find((r) => r.id === id)?.status;
    if (prev === undefined || prev === status) return;
    const mine = (rowSeq.current.get(id) ?? 0) + 1;
    rowSeq.current.set(id, mine);
    // A list fetch already in the air predates this change; its answer must not undo it.
    loadSeq.current++;
    const put = (s: string) => setRequests((rs) => rs?.map((r) => (r.id === id ? { ...r, status: s } : r)) ?? rs);
    setActionErr(null);
    setNotice(null);
    setSaving((s) => new Set(s).add(id));
    put(status);
    try {
      const row = await adminFetch<{ status?: string; changed?: boolean }>("PATCH", `/v1/admin/upgrade-requests/${id}`, { status });
      if (rowSeq.current.get(id) !== mine) return;
      put(typeof row?.status === "string" ? row.status : status);
      if (row?.changed === false) setNotice("Nothing changed - that request already had this status.");
    } catch (e) {
      if (rowSeq.current.get(id) !== mine) return;
      put(prev);
      setActionErr(`Status change failed: ${errText(e)} The request is still "${prev}".`);
    } finally {
      if (rowSeq.current.get(id) === mine) setSaving((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const planName = (id: string) => plans?.find((p) => p.id === id)?.name ?? id;
  const statusSelect = (r: UpgradeRequest) => (
    <select className="input w-auto py-1 text-xs max-lg:min-h-[40px]" aria-label={`Status of the request from ${r.name}`} value={r.status} disabled={saving.has(r.id)} onChange={(e) => setStatus(r.id, e.target.value)}>
      {!REQUEST_STATUSES.includes(r.status) && <option value={r.status}>{r.status}</option>}
      {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
  const workspace = (r: UpgradeRequest) =>
    r.orgId ? (
      <button className="btn-secondary whitespace-nowrap py-1 text-xs max-lg:min-h-[40px]" title={r.orgName ? `Open ${r.orgName}` : "Open the workspace this request came from"} onClick={() => onViewOrg(r.orgId!)}>View workspace</button>
    ) : (
      <span className="text-xs text-ink-400" title="Sent from the public pricing page, not from inside a workspace">No workspace</span>
    );

  return (
    <div className="card overflow-hidden p-0">
      {loadErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">Could not load upgrade requests: {loadErr} <button className={LINK_BTN} onClick={load}>Retry</button></div>}
      {actionErr && <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{actionErr}</div>}
      {notice && !actionErr && <div className="border-b border-black/10 bg-black/[0.03] p-3 text-sm text-ink-200" role="status">{notice}</div>}
      {!requests && !loadErr && <div className="p-6 text-center text-sm text-ink-400" role="status">Loading upgrade requests…</div>}

      {/* Below the desktop breakpoint: one card per request. The table showed only its first
          column at 390px, and between 768 and 1100px still needed a sideways scroll to reach
          the status control and "View workspace". */}
      <ul className="divide-y divide-black/5 lg:hidden">
        {requests?.map((r) => (
          <li key={r.id} className="space-y-2 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <div className="font-medium text-ink-50">{r.name}</div>
                {r.orgName && <div className="text-xs text-ink-400">{r.orgName}</div>}
              </div>
              {statusSelect(r)}
            </div>
            <div className="[overflow-wrap:anywhere]"><a className="text-brand-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a>{r.mobile && <span className="text-xs text-ink-400"> · {r.mobile}</span>}</div>
            <div className="text-xs text-ink-400">Wants <b className="font-semibold text-ink-200">{planName(r.planId)}</b> · {r.country} · {fmtDate(r.createdAt)}</div>
            {r.message && <div className="whitespace-pre-wrap text-xs text-ink-300 [overflow-wrap:anywhere]">{r.message}</div>}
            <div>{workspace(r)}</div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-400"><th className="th">Name</th><th className="th">Contact</th><th className="th">Country</th><th className="th">Plan wanted</th><th className="th">Status</th><th className="th">Workspace</th><th className="th">Received</th></tr></thead>
          <tbody>
            {requests?.map((r) => (
              <tr key={r.id}>
                <td className="td font-medium text-ink-50">{r.name}{r.message && <div className="max-w-xs truncate text-xs font-normal text-ink-400" title={r.message}>{r.message}</div>}</td>
                <td className="td"><a className="text-brand-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a><div className="text-xs text-ink-400">{r.mobile}</div></td>
                <td className="td">{r.country}</td>
                <td className="td">{planName(r.planId)}</td>
                <td className="td">{statusSelect(r)}</td>
                <td className="td">{r.orgName && <div className="mb-1 max-w-[12rem] truncate text-xs text-ink-400" title={r.orgName}>{r.orgName}</div>}{workspace(r)}</td>
                <td className="td text-xs text-ink-400">{fmtDate(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

// The same ceiling the server applies to a tool limit.
const TOOL_LIMIT_MAX = 1_000_000_000;

function ToolRow({ tool, onSaved }: { tool: ToolSummary; onSaved: (t: ToolSummary) => void }) {
  const [editing, setEditing] = useState(false);
  // Text, judged on Save - a number in state cannot be emptied or hold what was typed.
  const [limit, setLimit] = useState("");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // What the last save did, said on the row: the editor closing is not an answer.
  const [saved, setSaved] = useState<string | null>(null);
  // 0 has always meant "no limit set" on the server side of this; "0 / 0 /month" with an
  // empty bar said the opposite.
  const hasLimit = tool.usageLimit !== null && tool.usageLimit > 0;

  // Seeded from the saved values every time the editor opens: Cancel used to keep whatever
  // had been typed, and reopening showed it as if it were the stored limit.
  const open = () => {
    setLimit(hasLimit ? String(tool.usageLimit) : "");
    setThreshold(String(tool.alertThresholdPct));
    setSaveErr(null);
    setSaved(null);
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setSaveErr(null); };

  const save = async () => {
    const l = limit.trim();
    const t = threshold.trim();
    setSaved(null);
    if (l !== "" && !/^\d+$/.test(l)) return setSaveErr("The limit must be a whole number, or blank for no limit.");
    if (l !== "" && Number(l) > TOOL_LIMIT_MAX) return setSaveErr(`The limit can be at most ${fmtNum(TOOL_LIMIT_MAX)}.`);
    if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 100) return setSaveErr("The alert threshold must be a whole number from 1 to 100 (percent used).");
    setBusy(true);
    setSaveErr(null);
    try {
      const { changed, ...updated } = await adminFetch<ToolSummary & { changed?: boolean }>("PATCH", `/v1/admin/tools/${tool.provider}`, {
        usageLimit: l === "" || Number(l) === 0 ? null : Number(l),
        alertThresholdPct: Number(t),
      });
      onSaved(updated);
      setSaved(changed === false ? "Nothing changed" : "Saved");
      setEditing(false);
    } catch (e) {
      // Without this a rejected limit closed nothing and said nothing - it looked saved.
      setSaveErr(errText(e));
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
            <span className={`badge w-fit whitespace-nowrap ${KEY_STATUS_STYLES[tool.keyStatus]}`} title={tool.lastDetail ?? undefined}>
              {tool.keyStatusLabel}
            </span>
            {tool.keyStatus === "unverified" && tool.category !== "Infrastructure" && <span className="text-[11px] text-ink-500">nothing has called it yet</span>}
            {tool.lastDetail && tool.keyStatus !== "working" && <span className="max-w-[220px] text-[11px] text-ink-500">{tool.lastDetail}</span>}
            {tool.keyStatus === "not_configured" && <span className="text-[11px] text-ink-500">{tool.keyEnvVar}</span>}
          </span>
        ) : (
          "keyless"
        )}
      </td>
      <td className="td min-w-[14rem] text-xs text-ink-400">{tool.freeTierNote ?? "-"}{tool.notes && <div className="mt-0.5 italic">{tool.notes}</div>}</td>
      <td className="td">
        {hasLimit ? (
          <div className="w-32">
            <div className="mb-1 whitespace-nowrap text-xs text-ink-400">{fmtNum(tool.used)} / {fmtNum(tool.usageLimit)} <span className="text-ink-500">/{tool.period}</span></div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className={`h-full ${tool.status === "critical" ? "bg-red-500" : tool.status === "warning" ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(100, tool.percentUsed ?? 0)}%` }}
              />
            </div>
          </div>
        ) : (
          <span className="text-xs text-ink-400"><span className="whitespace-nowrap">{plural(tool.used, "call")}{tool.period ? ` /${tool.period}` : ""}</span> · <span className="whitespace-nowrap">no limit</span></span>
        )}
      </td>
      <td className="td"><span className={`badge whitespace-nowrap ${hasLimit ? TOOL_STATUS_STYLES[tool.status] : TOOL_STATUS_STYLES.unmetered}`}>{!hasLimit || tool.status === "unmetered" ? "no alert set" : tool.status}</span></td>
      <td className="td">
        {editing ? (
          <div className="min-w-[15rem]">
            <div className="flex flex-wrap items-center gap-1.5">
              <input className="input w-24 py-1 text-xs max-lg:min-h-[40px]" type="text" inputMode="numeric" autoComplete="off" placeholder="no limit" aria-label={`Usage limit for ${tool.label} (blank for none)`} value={limit} onChange={(e) => setLimit(e.target.value)} />
              <input className="input w-16 py-1 text-xs max-lg:min-h-[40px]" type="text" inputMode="numeric" autoComplete="off" aria-label="Alert at percent used" title="Alert at % used" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              <span className="text-xs text-ink-400">%</span>
              <button className="btn-primary py-1 text-xs max-lg:min-h-[40px]" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
              <button className={`${TAP} text-xs text-ink-400 hover:text-ink-50`} disabled={busy} onClick={cancel}>Cancel</button>
            </div>
            {saveErr && <div className="mt-1 max-w-[18rem] text-xs text-red-600" role="alert">{saveErr}</div>}
          </div>
        ) : (
          <>
            <button className="btn-secondary whitespace-nowrap py-1 text-xs max-lg:min-h-[40px]" onClick={open}>{hasLimit ? "Change limit" : "Set limit"}</button>
            {saved && <div className="mt-1 whitespace-nowrap text-[11px] text-ink-400" role="status">{saved}</div>}
          </>
        )}
      </td>
    </tr>
  );
}

/** What each key check is called. The check endpoint answers with slugs ("apollo-enrich"). */
const CHECK_LABELS: Record<string, string> = {
  apollo: "Apollo (people search)",
  "apollo-enrich": "Apollo (people match)",
  hunter: "Hunter.io",
  pdl: "People Data Labs",
  google_cse: "Google Programmable Search",
  serper: "Serper",
  serpapi: "SerpAPI",
  brave: "Brave Search",
  resend: "Resend",
  reoon: "Reoon (verification)",
  millionverifier: "MillionVerifier (verification)",
  groq: "Groq (AI)",
  gemini: "Google Gemini (AI)",
  anthropic: "Anthropic Claude (AI)",
  ipinfo: "ipinfo.io",
};

// `notTested`: providers that hold a key no check exercises. Newer servers list them (with a
// reason each); an older one sends nothing, and a bare slug is tolerated too.
type CheckResponse = { results: (ProviderCheck & { label?: string })[]; summary: string; checkedAt: string; retired?: string[]; testedCount?: number; tested?: number; notTested?: (string | { provider: string; label?: string; reason?: string })[] };

function ToolsTab() {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Uncaught before: a failed load left "Loading…" on screen forever.
  const load = () => adminFetch<{ tools: ToolSummary[] }>("GET", "/v1/admin/tools")
    .then((r) => { setTools(expectLists(r, "tools").tools); setLoadErr(null); })
    .catch((e) => setLoadErr(errText(e)));
  useEffect(() => { load(); }, []);

  // Spends one real request per configured provider. Worth saying out loud on a page whose
  // whole subject is free tiers measured in tens of calls a month.
  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const r = expectShape(expectLists(await adminFetch<CheckResponse>("POST", "/v1/admin/tools/check", {}), "results"), (x) => typeof x.summary === "string");
      setCheck(r);
      await load();
    } catch (e) {
      setCheckError(errText(e));
    } finally {
      setChecking(false);
    }
  };

  if (!tools && loadErr) return <div className="card p-5 text-sm text-red-700" role="alert">Could not load tools: {loadErr} <button className={LINK_BTN} onClick={load}>Retry</button></div>;
  if (!tools) return <div className="card p-5 text-sm text-ink-400" role="status">Loading tools…</div>;

  // Retired providers are deliberately excluded: a banner that keeps demanding a fix which
  // does not exist teaches people to stop reading banners.
  const keyProblems = tools.filter(
    (t) => !t.retired && (t.keyStatus === "rejected" || t.keyStatus === "erroring" || t.keyStatus === "gated" || t.keyStatus === "rate_limited" || t.keyStatus === "out_of_credit"),
  );
  const retired = tools.filter((t) => t.retired);
  const needsAttention = tools.filter((t) => (t.status === "warning" || t.status === "critical") && !!t.usageLimit);
  const byCategory = tools.reduce<Record<string, ToolSummary[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  const checkLabel = (r: { provider: string; label?: string }) => r.label ?? CHECK_LABELS[r.provider] ?? tools.find((t) => t.provider === r.provider)?.label ?? r.provider;
  const results = Array.isArray(check?.results) ? check!.results : [];
  const retiredSlugs = new Set(check?.retired ?? []);
  const tested = results.filter((r) => r.configured);
  // The count the server reports when it sends one (it leaves retired providers out);
  // otherwise the rows shown below.
  const testedCount = typeof check?.testedCount === "number" ? check.testedCount : typeof check?.tested === "number" ? check.tested : tested.length;
  // Named, not counted: "all configured providers responded" over a list of eleven grey
  // "no key" rows read as eleven passes.
  const noKey = [...new Set(results.filter((r) => !r.configured).map(checkLabel))];
  const untestable = (Array.isArray(check?.notTested) ? check!.notTested! : []).map((n) => (typeof n === "string" ? { label: checkLabel({ provider: n }), reason: "" } : { label: n.label ?? checkLabel({ provider: n.provider }), reason: n.reason ?? "" }));

  return (
    <div className="space-y-4">
      {loadErr && <div className="card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">Could not refresh this list ({loadErr}), so it may be out of date. <button className={LINK_BTN} onClick={load}>Retry</button></div>}
      {needsAttention.length > 0 && (
        <div className="card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-semibold">Needs attention:</span>{" "}
          {needsAttention.map((t) => `${t.label} (${t.percentUsed}% of ${fmtNum(t.usageLimit)}/${t.period})`).join(", ")}
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

      {checkError && <div className="card border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{checkError}</div>}

      {check && (
        <div className="card p-0" data-testid="check-results">
          {/* The server's own sentence, word for word - it knows what it did and did not test. */}
          <div className="border-b border-black/5 px-4 py-2 text-sm text-ink-100" role="status">{check.summary}</div>
          <div className="border-b border-black/5 px-4 py-2 text-xs text-ink-500">
            Checked {new Date(check.checkedAt).toLocaleString()} · {plural(testedCount, "provider")} tested
          </div>
          {(untestable.length > 0 || noKey.length > 0) && (
            <div className="border-b border-black/5 px-4 py-2 text-xs text-ink-400 [overflow-wrap:anywhere]" data-testid="check-not-tested">
              {untestable.length > 0 && (
                <div>
                  <span className="font-medium text-ink-200">Has a key but was not tested:</span>
                  <ul className="mt-0.5 list-inside list-disc">{untestable.map((n) => <li key={n.label}>{n.label}{n.reason ? ` - ${n.reason}` : ""}</li>)}</ul>
                </div>
              )}
              {noKey.length > 0 && <div className={untestable.length ? "mt-1" : ""}><span className="font-medium text-ink-200">No key set, so not tested:</span> {noKey.join(", ")}</div>}
            </div>
          )}
          {tested.length > 0 && (
            <ul className="divide-y divide-black/5 text-sm">
              {tested.map((r) => (
                <li key={r.provider} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-medium">{checkLabel(r)}</span>
                    <span className="ml-2 text-xs text-ink-400">{r.endpoint ?? ""}</span>
                    <div className="text-xs text-ink-500">{r.summary}</div>
                  </div>
                  <span
                    className={`badge shrink-0 whitespace-nowrap ${r.ok ? "bg-emerald-50 text-emerald-700" : retiredSlugs.has(r.provider) ? "bg-black/5 text-ink-400" : r.outcome === "forbidden" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`}
                  >
                    {r.ok ? `ok · ${r.ms}ms` : retiredSlugs.has(r.provider) ? "retired" : r.outcome.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-ink-500">
        Every 3rd-party API Scout calls, reconciled against what's actually used, with the free-tier limit for each. Set (or adjust) a limit and Scout emails you the moment a tool crosses it, so you know exactly which one to upgrade.
      </p>
      {Object.entries(byCategory).map(([category, rows]) => (
        <div key={category} className="card overflow-x-auto p-0">
          <div className="border-b border-black/5 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{category}</div>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-ink-400">
                <th className="th">Tool</th>
                <th className="th">Key</th>
                <th className="th">Free tier</th>
                <th className="th whitespace-nowrap">Usage this period</th>
                <th className="th">Status</th>
                <th className="th whitespace-nowrap">Alert limit</th>
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

function PlansTab({ plans, loading, error, onRetry }: { plans: Plan[] | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (!plans?.length) {
    if (loading) return <div className="card p-5 text-sm text-ink-400" role="status">Loading plans…</div>;
    return <div className="card p-5 text-sm text-red-700" role="alert">Could not load plans{error ? `: ${error}` : "."} <button className={LINK_BTN} onClick={onRetry}>Retry</button></div>;
  }
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
            <li>{plural(Number(p.limits.seats), "seat")} · {plural(Number(p.limits.campaigns), "campaign")}</li>
          </ul>
        </div>
      ))}
      <p className="col-span-full text-xs text-ink-500">Prices and limits are defined in code (packages/db/src/plans.ts) so margins stay auditable - this is a read-only reference, not an editor.</p>
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
      // A wrong shape is an error with Retry - not "No providers reported a balance."
      setRows(expectLists(r, "balances").balances);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const order = { error: 0, ok: 1, no_endpoint: 2, not_configured: 3 } as const;
  const sorted = [...(rows ?? [])].sort((a, b) => Number(b.low) - Number(a.low) || (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));
  const tone = (b: ProviderBalance) =>
    b.status === "error" ? "border-red-200 bg-red-50/40" : b.low ? "border-amber-200 bg-amber-50/40" : b.status === "not_configured" ? "opacity-70" : "";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-400">
          Remaining credits, read from each provider's own account API. Providers with no such API say so and point to their dashboard, rather than showing a number we would have to make up.
        </p>
        <button className="btn-secondary max-lg:min-h-[40px]" onClick={load} disabled={busy}>{busy ? "Checking…" : rows || !err ? "Refresh" : "Retry"}</button>
      </div>
      {err && (
        <div className="card mb-4 border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {rows ? "Could not refresh the balances" : "Could not check the balances"}: {err}
          {rows ? " The numbers below are from the last successful check." : ""}
        </div>
      )}
      {/* The spinner means "still asking". It is shown only while that is true: with an error
          on screen and nothing loaded, "Checking every provider…" under it never ended. */}
      {rows ? (
        rows.length === 0 ? (
          <div className="card p-5 text-sm text-ink-400">No providers reported a balance.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sorted.map((b) => (
              <div key={b.provider} className={`card p-4 ${tone(b)}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-ink-50">{b.name}</div>
                    <div className="text-xs text-ink-400">{b.role}</div>
                  </div>
                  <span className={`badge whitespace-nowrap ${b.status === "ok" ? (b.low ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700") : b.status === "error" ? "bg-red-50 text-red-700" : "bg-black/[0.05] text-ink-400"}`}>
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
        )
      ) : !err ? (
        <div className="card p-5 text-sm text-ink-400" role="status">Checking every provider…</div>
      ) : null}
    </div>
  );
}

type Tab = "orgs" | "leads" | "tools" | "credits" | "plans";
const TABS: readonly (readonly [Tab, string])[] = [["orgs", "Users & workspaces"], ["leads", "Upgrade requests"], ["tools", "Tools & limits"], ["credits", "Credits left"], ["plans", "Pricing"]];

export function AdminDashboardPage() {
  const token = useAdminToken();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("orgs");
  // null = not loaded (yet, or the load failed - see plansErr). The page never waits on it.
  const [plans, setPlans] = useState<Plan[] | null>(null);
  // true from the first paint: the request starts in the effect below, and "not loading, no
  // plans" would flash the Pricing tab's error state for a frame.
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansErr, setPlansErr] = useState<string | null>(null);
  // Lives here, not in the Orgs tab, so "View workspace" on an upgrade request can open it.
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);

  const loadPlans = useCallback(() => {
    setPlansLoading(true);
    adminFetch<{ plans: Plan[] }>("GET", "/v1/admin/plans")
      .then((r) => { setPlans(expectLists(r, "plans").plans); setPlansErr(null); })
      .catch((e) => setPlansErr(errText(e)))
      .finally(() => setPlansLoading(false));
  }, []);

  useEffect(() => {
    if (!token) return;
    // Only a rejected token means "sign in again"; a network blip used to log the admin out.
    // A 401 is handled inside adminFetch (it ends the session and leaves the "expired" note
    // for the login page); a 403 is the same verdict for this console.
    adminFetch<{ ok: boolean }>("GET", "/v1/admin/session").catch((e) => { if ((e as { status?: number }).status === 403) endAdminSession(token); });
    loadPlans();
  }, [token, loadPlans]);

  if (!token) return <Navigate to="/admin/login" replace />;

  /**
   * The header and tabs render at once, whatever the plan list is doing.
   *
   * This used to be `if (!plans) return null`: the whole console was a blank white page
   * until GET /v1/admin/plans answered - up to 45 seconds when the API was slow, with no
   * sign-out button and no way to reach the tabs that do not need plans at all. Each tab
   * now loads its own data and says so; plans fill in the names when they arrive.
   */
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-black/10 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Logo size={24} textClassName="text-base" />
          <span className="badge border border-black/10 bg-black/5 text-ink-300">Admin</span>
        </div>
        <button className="btn-secondary" onClick={() => { adminLogout(); navigate("/admin/login", { replace: true }); }}>Sign out</button>
      </header>
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        {plansErr && !plans && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            Could not load plans ({plansErr}) - plan names and the plan picker will be incomplete.{" "}
            <button className={LINK_BTN} disabled={plansLoading} onClick={loadPlans}>{plansLoading ? "Retrying…" : "Retry"}</button>
          </div>
        )}
        <nav className="-mx-4 mb-5 flex gap-2 overflow-x-auto whitespace-nowrap px-4 sm:mx-0 sm:px-0" aria-label="Admin sections">
          {TABS.map(([id, label]) => (
            <button key={id} className={`shrink-0 rounded-lg px-3 py-1.5 text-sm max-lg:min-h-[40px] ${tab === id ? "bg-brand-600 text-white" : "text-ink-300 hover:bg-black/5"}`} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        {tab === "orgs" && <OrgsTab plans={plans} plansLoading={plansLoading} selected={selectedOrg} onSelect={setSelectedOrg} />}
        {tab === "leads" && <LeadsTab plans={plans} onViewOrg={(id) => { setSelectedOrg(id); setTab("orgs"); }} />}
        {tab === "tools" && <ToolsTab />}
        {tab === "credits" && <CreditsTab />}
        {tab === "plans" && <PlansTab plans={plans} loading={plansLoading} error={plansErr} onRetry={loadPlans} />}
      </main>
    </div>
  );
}
