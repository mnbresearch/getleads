import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectLists, expectShape, fmtDate, fmtNum } from "../lib/api";
import { PrivacySections } from "./AdminPrivacy";
import { AUDIT_ACTOR, AuditResult, auditActionLabel, auditEntryLabel, auditReason, auditWho, type AuditEntry } from "../components/AuditBits";

/** Same thumb-sized targets as the rest of the console (see AdminDashboard). */
const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

const errText = (e: unknown, what: string) => {
  // An older server has neither endpoint; "HTTP 404" would read as a broken console.
  if (e instanceof AdminApiError && (e.status === 404 || e.status === 405)) return `${what} is not available on this server yet.`;
  return (e as Error)?.message || "Something went wrong.";
};

// ── Summary ──
type Summary = {
  window?: string;
  failedLogins?: number;
  lockedAccounts?: number;
  deniedActions?: number;
  adminLogins?: number;
  newWorkspaces?: number;
  exports?: number;
  bulkDeletes?: number;
  pendingDeletions?: number;
  topFailingIps?: { ip: string; count: number }[];
};

/** [key, label, hint, "watch": a number above zero here is worth a second look]. */
const TILES: readonly (readonly [keyof Summary, string, string, boolean])[] = [
  ["failedLogins", "Failed sign-ins", "Wrong password or code", true],
  ["lockedAccounts", "Locked accounts", "Too many failed attempts", true],
  ["deniedActions", "Refused actions", "Blocked by role, scope or ownership", true],
  ["adminLogins", "Admin sign-ins", "To this console", false],
  ["newWorkspaces", "New workspaces", "Signed up", false],
  ["exports", "Exports", "Data taken out", false],
  ["bulkDeletes", "Bulk deletes", "Leads removed in bulk", false],
  ["pendingDeletions", "Pending deletions", "Workspaces scheduled to be deleted", true],
];

const windowText = (w?: string) => (w === "24h" || !w ? "the last 24 hours" : `the last ${w}`);

function SummarySection() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    return adminFetch<Summary>("GET", "/v1/admin/security/summary")
      .then((r) => {
        if (mine !== seq.current) return;
        // A 200 with none of the counts in it is not "all quiet" - it is not this answer.
        setSum(expectShape(r, (x) => TILES.some(([k]) => typeof x[k] === "number")));
        setErr(null);
      })
      .catch((e) => { if (mine === seq.current) setErr(errText(e, "The security summary")); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ips = Array.isArray(sum?.topFailingIps) ? sum.topFailingIps.filter((x) => x && typeof x.ip === "string") : [];
  const quiet = !!sum && TILES.filter(([, , , watch]) => watch).every(([k]) => !sum[k]);

  return (
    <section aria-label="Security summary" data-testid="security-summary">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-50">Across every workspace, {windowText(sum?.window)}</h2>
        <button className="btn-secondary max-lg:min-h-[40px]" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : sum || !err ? "Refresh" : "Retry"}</button>
      </div>
      {err && (
        <div className="card mb-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
          {sum ? "Could not refresh the summary" : "Could not load the summary"}: {err}
          {sum ? " The numbers below are from the last successful check." : ""}{" "}
          <button className={LINK_BTN} onClick={() => void load()} disabled={busy}>Retry</button>
        </div>
      )}
      {sum ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {TILES.map(([k, label, hint, watch]) => {
              const n = sum[k];
              const hot = watch && typeof n === "number" && n > 0;
              return (
                <div key={k} className={`card min-w-0 p-3 sm:p-4 ${hot ? "border-amber-300 bg-amber-50/50" : ""}`} data-tile={k}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400 [overflow-wrap:anywhere]">{label}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-50">{typeof n === "number" ? fmtNum(n) : "-"}</div>
                  <div className="mt-0.5 text-xs text-ink-400">{typeof n === "number" ? hint : "Not reported by the server"}</div>
                </div>
              );
            })}
          </div>
          <div className="card mt-3 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Addresses with the most failed sign-ins</div>
            {ips.length === 0 ? (
              <div className="mt-2 text-sm text-ink-400">{quiet ? "Nothing to report: no failed sign-ins, locks, refusals or pending deletions in this period." : "No address stands out for failed sign-ins in this period."}</div>
            ) : (
              <ul className="mt-2 divide-y divide-black/5 text-sm">
                {ips.map((x) => (
                  <li key={x.ip} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 font-mono text-xs text-ink-200 [overflow-wrap:anywhere]">{x.ip}</span>
                    <span className="shrink-0 tabular-nums text-ink-50"><b>{fmtNum(x.count)}</b> failed</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : !err ? (
        <div className="card p-5 text-sm text-ink-400" role="status">Loading the security summary…</div>
      ) : null}
    </section>
  );
}

// ── Audit log ──
const PAGE = 50;
type Filters = { orgId: string; action: string; result: string; actorType: string };
const NO_FILTERS: Filters = { orgId: "", action: "", result: "", actorType: "" };
type LogPage = { entries: AuditEntry[]; hasMore?: boolean; nextBefore?: string | null };

/**
 * The actions offered in the filter, spelled the way the server records them. Whatever
 * else turns up in the rows that have loaded is added to the list, so an action this build
 * has never heard of can still be filtered on.
 */
const KNOWN_ACTIONS = [
  "auth.login", "auth.login_locked", "auth.google_login", "auth.signup", "auth.logout_all", "auth.password_changed", "auth.password_reset", "auth.password_reset_requested",
  "auth.2fa_challenge", "auth.2fa_setup", "auth.2fa_enabled", "auth.2fa_disabled", "auth.2fa_failed", "auth.2fa_recovery_codes_regenerated", "auth.email_verified", "auth.verification_sent",
  "role.denied", "reference.denied", "apikey.scope_denied",
  "apikey.created", "apikey.revoked", "webhook.created", "webhook.deleted", "webhook.secret_rotated", "integration.connected", "integration.disconnected", "sender.created", "sender.deleted",
  "team.invited", "team.invite_resent", "team.invite_revoked", "team.joined", "team.member_removed",
  "leads.exported", "leads.imported", "leads.bulk_deleted", "list.deleted", "client.created", "client.deleted", "client.share_enabled", "client.share_disabled", "client.share_rotated",
  "campaign.started", "campaign.paused", "campaign.deleted",
  "org.settings_changed", "account.export_started", "account.exported", "account.deletion_requested", "account.deletion_cancelled", "account.deletion_reminder", "account.purged",
  "admin.login", "admin.logout", "admin.2fa_reset", "admin.plan_changed", "admin.status_changed", "admin.credits_changed",
];

/**
 * Whole families at once. The server reads a trailing "*" as "starts with", so "auth.*" is
 * every sign-in and account-security event.
 */
const ACTION_GROUPS: readonly (readonly [string, string])[] = [
  ["auth.*", "Sign-in and account security"],
  ["account.*", "Workspace export and deletion"],
  ["apikey.*", "API keys"],
  ["team.*", "Team and invites"],
  ["admin.*", "Scout admin console"],
];

function qs(f: Filters, before: string | null): string {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.orgId) p.set("orgId", f.orgId);
  if (f.action) p.set("action", f.action);
  if (f.result) p.set("result", f.result);
  if (f.actorType) p.set("actorType", f.actorType);
  if (before) p.set("before", before);
  return p.toString();
}

function AuditSection({ onViewOrg }: { onViewOrg: (orgId: string) => void }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreErr, setMoreErr] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null);
  const [orgsErr, setOrgsErr] = useState(false);
  // Only the newest request may write: a slow answer for the previous filters must not
  // replace the rows for the current ones.
  const seq = useRef(0);

  const fetchPage = (f: Filters, before: string | null) =>
    adminFetch<LogPage>("GET", `/v1/admin/audit-log?${qs(f, before)}`).then((r) => {
      const rows = expectLists(r, "entries").entries;
      const next = r.nextBefore ?? (rows.length ? rows[rows.length - 1].createdAt : null);
      return { rows, next, hasMore: typeof r.hasMore === "boolean" ? r.hasMore : rows.length >= PAGE };
    });

  const load = useCallback((f: Filters) => {
    const mine = ++seq.current;
    setBusy(true);
    setMoreErr(null);
    return fetchPage(f, null)
      .then(({ rows, next, hasMore }) => {
        if (mine !== seq.current) return;
        setEntries(rows);
        setCursor(next);
        setMore(hasMore && !!next);
        setErr(null);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        // Rows for other filters are not an answer to these ones; they go, the error stays.
        setEntries(null);
        setErr(errText(e, "The platform audit log"));
      })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);
  useEffect(() => { void load(filters); }, [filters, load]);

  useEffect(() => {
    let live = true;
    adminFetch<{ orgs: { id: string; name: string }[] }>("GET", "/v1/admin/orgs")
      .then((r) => { if (live) setOrgs(expectLists(r, "orgs").orgs.map((o) => ({ id: o.id, name: o.name }))); })
      .catch(() => { if (live) setOrgsErr(true); });
    return () => { live = false; };
  }, []);

  const loadMore = async () => {
    if (moreBusy || !cursor) return;
    const mine = seq.current;
    setMoreBusy(true);
    setMoreErr(null);
    try {
      const { rows, next, hasMore } = await fetchPage(filters, cursor);
      if (mine !== seq.current) return;
      const seen = new Set((entries ?? []).map((e) => e.id));
      const added = rows.filter((e) => !seen.has(e.id));
      setEntries([...(entries ?? []), ...added]);
      setCursor(next);
      // No new rows, or a cursor that did not move, is the end - not a button that reloads
      // the same page for ever.
      setMore(hasMore && added.length > 0 && !!next && next !== cursor);
    } catch (e) {
      if (mine === seq.current) setMoreErr(errText(e, "The platform audit log"));
    } finally {
      setMoreBusy(false);
    }
  };

  const orgOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orgs ?? []) m.set(o.id, o.name);
    for (const e of entries ?? []) if (e.orgId && !m.has(e.orgId)) m.set(e.orgId, e.orgName || e.orgId);
    if (filters.orgId && !m.has(filters.orgId)) m.set(filters.orgId, filters.orgId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orgs, entries, filters.orgId]);
  const actionOptions = useMemo(() => {
    const s = new Set(KNOWN_ACTIONS);
    for (const e of entries ?? []) if (e.action) s.add(e.action);
    if (filters.action && !filters.action.endsWith("*")) s.add(filters.action);
    return [...s].map((a) => [a, auditActionLabel(a)] as const).sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries, filters.action]);

  const filtered = !!(filters.orgId || filters.action || filters.result || filters.actorType);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const orgCell = (e: AuditEntry) =>
    e.orgId ? (
      <span className="inline-flex max-w-full flex-wrap items-center gap-x-2">
        {/* No side padding (unlike TAP): the name lines up with the text above and below it. */}
        <button className="inline-flex min-w-0 items-center text-left text-ink-100 hover:underline max-lg:min-h-[40px] [overflow-wrap:anywhere]" title="Show only this workspace" onClick={() => set({ orgId: e.orgId! })}>{e.orgName || "Unnamed workspace"}</button>
        <button className="inline-flex shrink-0 items-center text-xs text-brand-600 hover:underline max-lg:min-h-[40px] max-lg:min-w-[40px]" onClick={() => onViewOrg(e.orgId!)}>Open</button>
      </span>
    ) : (
      <span className="text-ink-400" title="Not tied to one workspace: the admin console, or a sign-in that matched no account">Platform</span>
    );
  const addr = (e: AuditEntry) => e.ip || "not recorded";
  const tone = (e: AuditEntry) => ((e.result ?? "ok") === "ok" ? "" : e.result === "denied" ? "border-l-4 border-amber-500" : "border-l-4 border-red-500");

  return (
    <section aria-label="Platform audit log" className="mt-6" data-testid="security-audit">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-50">Audit log</h2>
        <span className="flex flex-wrap items-center gap-2">
          {filtered && <button className={`${TAP} text-sm text-brand-600 hover:underline`} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
          <button className="btn-secondary max-lg:min-h-[40px]" onClick={() => void load(filters)} disabled={busy}>{busy ? "Loading…" : entries || !err ? "Refresh" : "Retry"}</button>
        </span>
      </div>
      <div className="card overflow-hidden p-0">
        <div className="grid grid-cols-1 gap-2 border-b border-black/10 p-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <select className="input min-w-0 max-lg:min-h-[40px]" aria-label="Workspace" value={filters.orgId} onChange={(e) => set({ orgId: e.target.value })}>
            <option value="">{orgs || !orgsErr ? "All workspaces" : "All workspaces (list not loaded)"}</option>
            {orgOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select className="input min-w-0 max-lg:min-h-[40px]" aria-label="Action" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">All actions</option>
            <optgroup label="Groups">
              {ACTION_GROUPS.map(([a, label]) => <option key={a} value={a}>{label} (all)</option>)}
            </optgroup>
            <optgroup label="One action">
              {actionOptions.map(([a, label]) => <option key={a} value={a}>{label}</option>)}
            </optgroup>
          </select>
          <select className="input min-w-0 max-lg:min-h-[40px]" aria-label="Result" value={filters.result} onChange={(e) => set({ result: e.target.value })}>
            <option value="">Any result</option>
            <option value="ok">Succeeded</option>
            <option value="denied">Refused</option>
            <option value="failed">Failed</option>
          </select>
          <select className="input min-w-0 max-lg:min-h-[40px]" aria-label="Who did it" value={filters.actorType} onChange={(e) => set({ actorType: e.target.value })}>
            <option value="">Anyone</option>
            {Object.entries(AUDIT_ACTOR).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>

        {err && (
          <div className="border-b border-red-200 bg-red-50 p-3 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
            Could not load the audit log: {err} <button className={LINK_BTN} onClick={() => void load(filters)} disabled={busy}>Retry</button>
          </div>
        )}
        {!entries && !err && <div className="p-6 text-center text-sm text-ink-400" role="status">Loading the audit log…</div>}
        {entries && busy && <div className="border-b border-black/5 bg-black/[0.02] px-3 py-1.5 text-xs text-ink-400" role="status">Updating…</div>}

        {/* Below the desktop breakpoint: one card per entry. Six columns do not fit a phone. */}
        <ul className="divide-y divide-black/5 lg:hidden" data-testid="audit-cards">
          {entries?.map((e) => {
            const reason = auditReason(e);
            return (
              <li key={e.id} className="p-3 text-sm">
                <div className={tone(e) ? `${tone(e)} pl-3` : undefined}>
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="min-w-0 font-medium text-ink-50 [overflow-wrap:anywhere]">{auditEntryLabel(e)}</div>
                    <AuditResult result={e.result} />
                  </div>
                  {reason && <div className={`text-xs ${e.result === "denied" ? "text-amber-800" : "text-red-700"}`}>{reason}</div>}
                  <div className="[overflow-wrap:anywhere]">{orgCell(e)}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-400">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{auditWho(e)}</span>
                    <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{addr(e)}</span>
                    <time dateTime={e.createdAt}>{fmtDate(e.createdAt)}</time>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead><tr className="text-left text-ink-400"><th className="th">When</th><th className="th">Workspace</th><th className="th">Action</th><th className="th">Who</th><th className="th">Result</th><th className="th">Address</th></tr></thead>
            <tbody className="divide-y divide-black/5">
              {entries?.map((e) => {
                const reason = auditReason(e);
                return (
                  <tr key={e.id}>
                    <td className={`td whitespace-nowrap text-xs text-ink-400 ${tone(e)}`}><time dateTime={e.createdAt}>{fmtDate(e.createdAt)}</time></td>
                    <td className="td max-w-[14rem]">{orgCell(e)}</td>
                    <td className="td max-w-[18rem] [overflow-wrap:anywhere]">
                      <div className="font-medium text-ink-50">{auditEntryLabel(e)}</div>
                      {reason && <div className={`text-xs ${e.result === "denied" ? "text-amber-800" : "text-red-700"}`}>{reason}</div>}
                    </td>
                    <td className="td max-w-[14rem] text-xs [overflow-wrap:anywhere]">{auditWho(e)}</td>
                    <td className="td"><AuditResult result={e.result} /></td>
                    <td className="td max-w-[11rem] font-mono text-xs [overflow-wrap:anywhere]">{addr(e)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {entries && entries.length === 0 && !err && (
          <div className="p-6 text-center text-sm text-ink-400" data-testid="audit-empty">
            {filtered ? (
              <>Nothing matches these filters. <button className={LINK_BTN} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button></>
            ) : (
              "Nothing has been recorded yet. Sign-ins, refusals and changes to access appear here as they happen."
            )}
          </div>
        )}
        {moreErr && <div className="border-t border-red-200 bg-red-50 p-3 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">Could not load older entries: {moreErr}</div>}
        {more && entries && entries.length > 0 && (
          <div className="border-t border-black/5 p-3">
            <button className="btn-secondary w-full justify-center max-lg:min-h-[40px]" disabled={moreBusy} onClick={loadMore}>{moreBusy ? "Loading…" : "Load more"}</button>
          </div>
        )}
        {!more && entries && entries.length > 0 && <p className="border-t border-black/5 p-3 text-center text-xs text-ink-500">End of the log{filtered ? " for these filters" : ""}.</p>}
      </div>
    </section>
  );
}

/**
 * Admin > Security: what happened across every workspace in the last day, the audit log
 * behind it, and (on a server that has them) the platform suppression list and the lookup
 * for a person's data. Each part loads on its own - a summary that fails must not hide the
 * log, and the other way round.
 */
export function SecurityTab({ onViewOrg }: { onViewOrg: (orgId: string) => void }) {
  return (
    <div>
      <SummarySection />
      <AuditSection onViewOrg={onViewOrg} />
      <PrivacySections onViewOrg={onViewOrg} />
    </div>
  );
}
