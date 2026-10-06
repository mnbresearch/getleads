import { useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError, adminFetch } from "../lib/adminApi";
import { expectLists, expectShape, fmtDate, fmtNum } from "../lib/api";
import { LIST_SEARCH_MAX } from "../lib/listSearch";

/** Same thumb-sized targets as the rest of the console (see AdminDashboard). */
const TAP = "inline-flex items-center max-lg:min-h-[40px] max-lg:px-2";
const LINK_BTN = `${TAP} underline`;

/** The server has no such route: an older server, where these sections do not exist at all. */
const isMissing = (e: unknown) => e instanceof AdminApiError && (e.status === 404 || e.status === 405);
const said = (e: unknown) => (e as Error)?.message || "Something went wrong.";

/** An address as the server keys it: trimmed, lower case. Not a validator - the server decides. */
export const normaliseEmail = (s: string) => s.trim().toLowerCase();
/** Enough to stop an obvious slip before a request is made. */
export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(s));

// ───────────────────────── Platform suppression list ─────────────────────────

interface Suppression {
  id: string;
  email: string;
  reason?: string | null;
  note?: string | null;
  createdAt?: string | null;
}

const LIST_LIMIT = 100;

/**
 * Addresses nobody on the platform may be emailed at, whichever workspace is sending.
 *
 * A workspace's own do-not-contact list stops that workspace. This one is for the cases a
 * single workspace cannot settle: a person who wrote to us asking never to hear from anyone
 * using Scout, an address a court or regulator named, an abuse desk.
 *
 * `onMissing` is called when the server has no such list (an older server); the caller then
 * renders none of this, rather than an error box for a feature that is simply not there yet.
 */
function SuppressionsSection({ onMissing, refreshKey, onLogged }: { onMissing: () => void; refreshKey: number; onLogged: () => void }) {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftQ, setDraftQ] = useState("");
  const [q, setQ] = useState("");
  const [add, setAdd] = useState({ email: "", reason: "", note: "" });
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    (query: string) => {
      const mine = ++seq.current;
      setBusy(true);
      const p = new URLSearchParams({ limit: String(LIST_LIMIT) });
      if (query) p.set("q", query);
      return adminFetch<{ suppressions: Suppression[] }>("GET", `/v1/admin/suppressions?${p.toString()}`)
        .then((r) => {
          if (mine !== seq.current) return;
          // A 200 without the list is not "the list is empty".
          setRows(expectLists(r, "suppressions").suppressions.filter((s) => s && typeof s.id === "string" && typeof s.email === "string"));
          setErr(null);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          if (isMissing(e)) return onMissing();
          // Rows for another search are not an answer to this one.
          setRows(null);
          setErr(said(e));
        })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    },
    [onMissing],
  );
  useEffect(() => { void load(q); }, [q, refreshKey, load]);

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = normaliseEmail(add.email);
    if (adding || !looksLikeEmail(email)) return;
    setAdding(true);
    setAddErr(null);
    setNote(null);
    try {
      const body: { email: string; reason?: string; note?: string } = { email };
      if (add.reason.trim()) body.reason = add.reason.trim();
      if (add.note.trim()) body.note = add.note.trim();
      const r = await adminFetch<{ suppression?: Suppression }>("POST", "/v1/admin/suppressions", body);
      expectShape(r, (x) => !!x.suppression && typeof x.suppression.email === "string");
      setAdd({ email: "", reason: "", note: "" });
      setNote(`${r.suppression!.email} is on the platform list. No workspace can send to it.`);
      onLogged();
      await load(q);
    } catch (x) {
      setAddErr(isMissing(x) ? "The platform list is not available on this server yet." : said(x));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: Suppression) => {
    if (removing) return;
    if (!confirm(`Remove ${s.email} from the platform list?\n\nWorkspaces will be able to email this address again, unless it is on their own do-not-contact list.`)) return;
    setRemoving(s.id);
    setRowErr(null);
    setNote(null);
    try {
      await adminFetch("DELETE", `/v1/admin/suppressions/${encodeURIComponent(s.id)}`);
      setNote(`${s.email} was removed from the platform list.`);
      onLogged();
      await load(q);
    } catch (x) {
      // The row stays on screen, so a silent failure would read as "done".
      setRowErr(`Could not remove ${s.email}: ${isMissing(x) ? "it is no longer on the list. Refresh to see the current list." : said(x)}`);
    } finally {
      setRemoving(null);
    }
  };

  const emailOk = looksLikeEmail(add.email);

  return (
    <section aria-label="Platform suppression list" className="mt-6" data-testid="admin-suppressions">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-50">Platform suppression list</h2>
        <button className="btn-secondary max-lg:min-h-[40px]" onClick={() => void load(q)} disabled={busy}>{busy ? "Checking…" : rows || !err ? "Refresh" : "Retry"}</button>
      </div>
      <p className="mb-3 text-sm text-ink-300">Addresses here are never emailed by any workspace, whatever that workspace's own lists say. Use it for a person who asked not to be contacted through Scout at all.</p>

      <form onSubmit={submitAdd} className="card mb-3 grid gap-3 p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end" data-testid="suppression-add">
        <div className="min-w-0"><label className="label" htmlFor="sup-email">Email address</label><input id="sup-email" className="input" type="email" autoComplete="off" spellCheck={false} maxLength={320} value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} placeholder="person@example.com" /></div>
        <div className="min-w-0"><label className="label" htmlFor="sup-reason">Reason (optional)</label><input id="sup-reason" className="input" maxLength={100} value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} placeholder="request" /></div>
        <div className="min-w-0"><label className="label" htmlFor="sup-note">Note (optional)</label><input id="sup-note" className="input" maxLength={500} value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} placeholder="Asked by email on 3 October" /></div>
        <button className="btn-primary justify-center max-lg:min-h-[40px]" disabled={adding || !emailOk}>{adding ? "Adding…" : "Add"}</button>
        {addErr && <div className="text-sm text-red-700 [overflow-wrap:anywhere] sm:col-span-4" role="alert" data-testid="suppression-add-error">{addErr}</div>}
      </form>

      {note && <div className="mb-3 rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700 [overflow-wrap:anywhere]" role="status" data-testid="suppression-note">{note}</div>}
      {rowErr && <div className="mb-3 rounded-lg bg-red-50 p-2 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert" data-testid="suppression-row-error">{rowErr}</div>}

      <div className="card">
        <form className="flex flex-wrap items-end gap-2 border-b border-black/5 p-3" onSubmit={(e) => { e.preventDefault(); setQ(draftQ.trim()); }} role="search">
          <div className="min-w-0 flex-1"><label className="label" htmlFor="sup-q">Search the list</label><input id="sup-q" className="input" value={draftQ} maxLength={LIST_SEARCH_MAX} onChange={(e) => setDraftQ(e.target.value)} placeholder="Address or part of one" /></div>
          <button className="btn-secondary max-lg:min-h-[40px]" disabled={busy}>Search</button>
          {q && <button type="button" className="btn-secondary max-lg:min-h-[40px]" onClick={() => { setDraftQ(""); setQ(""); }}>Clear</button>}
        </form>
        {err && (
          <div className="p-4 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert" data-testid="suppression-error">
            Could not load the platform list: {err} <button className={LINK_BTN} onClick={() => void load(q)} disabled={busy}>Retry</button>
          </div>
        )}
        {!err && !rows && <div className="p-4 text-sm text-ink-400">Loading…</div>}
        {rows && rows.length === 0 && (
          <div className="p-6 text-center text-sm text-ink-400" data-testid="suppression-empty">{q ? `No address on the list matches "${q}".` : "The platform list is empty."}</div>
        )}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-black/5" data-testid="suppression-rows">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-ink-50 [overflow-wrap:anywhere]">{s.email}</div>
                  <div className="text-xs text-ink-400 [overflow-wrap:anywhere]">{[s.reason || "no reason given", s.note || null, s.createdAt ? fmtDate(s.createdAt) : null].filter(Boolean).join(" · ")}</div>
                </div>
                <button className={`${TAP} shrink-0 text-red-700 disabled:opacity-50`} disabled={removing !== null} onClick={() => void remove(s)}>{removing === s.id ? "Removing…" : "Remove"}</button>
              </li>
            ))}
          </ul>
        )}
        {rows && rows.length >= LIST_LIMIT && <p className="border-t border-black/5 p-3 text-center text-xs text-ink-500">Showing the first {LIST_LIMIT}. Search to find a specific address.</p>}
      </div>
    </section>
  );
}

// ───────────────────────── Find a person's data ─────────────────────────

interface SubjectWorkspace {
  orgId: string;
  orgName?: string | null;
  leads?: number;
  campaignContacts?: number;
  /** Message rows that still hold the address. */
  messages?: number;
  /** Message rows kept as records, with the address and the text removed. Absent on an older server. */
  anonymisedMessages?: number;
  /** People waiting in (or skipped from) a play's review queue who carry the address. Absent on an older server. */
  candidates?: number;
  suppressed?: boolean;
}
interface SubjectReport {
  email: string;
  globallySuppressed?: boolean;
  /** Whether any workspace still holds the person's data. Absent on an older server. */
  held?: boolean;
  workspaces: SubjectWorkspace[];
}
interface EraseResult {
  ok?: boolean;
  workspaces?: number | unknown[];
  leadsDeleted?: number;
  messagesAnonymised?: number;
  globallySuppressed?: boolean;
}

const count = (n: unknown) => (typeof n === "number" ? fmtNum(n) : "-");
const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
/** A workspace still holds the person when it has a lead, a campaign contact, a message with their address, or has them in a play's review queue. */
const holds = (w: SubjectWorkspace) => num(w.leads) > 0 || num(w.campaignContacts) > 0 || num(w.messages) > 0 || num(w.candidates) > 0;

/**
 * What a lookup found, in the terms the request is asked in: is this person's data still
 * held, and what records remain without them in it.
 *
 * `held` is the server's answer where it gives one. Without it (an older server, which has
 * no anonymised rows to tell apart) every listed workspace counts as holding the person,
 * as before.
 */
export function subjectSummary(r: SubjectReport): { held: boolean; holding: number; kept: number; keptIn: number } {
  const split = r.workspaces.some((w) => typeof w.anonymisedMessages === "number") || typeof r.held === "boolean";
  const holding = split ? r.workspaces.filter(holds).length : r.workspaces.length;
  const held = typeof r.held === "boolean" ? r.held : holding > 0;
  const kept = r.workspaces.reduce((n, w) => n + num(w.anonymisedMessages), 0);
  const keptIn = r.workspaces.filter((w) => num(w.anonymisedMessages) > 0).length;
  return { held, holding: held ? Math.max(holding, 1) : 0, kept, keptIn };
}

const records = (n: number) => `${fmtNum(n)} message ${n === 1 ? "record" : "records"}`;
/** What "kept without content" means, once, where the number is first shown. */
const KEPT_MEANS = "when a message was sent and what happened to it, not who it was to or what it said";

/**
 * A data-subject request, start to finish: where does this person appear, and erase them.
 *
 * Erasing is the one action in this console that destroys customers' data across every
 * workspace at once, so it asks for the address to be typed again - the same address that
 * was looked up, not whatever is in the search box now - and it says exactly what it will do
 * before the button is live. What happened is then reported from the server's own numbers.
 */
function DataSubjectSection({ onViewOrg, onErased, onLogged }: { onViewOrg: (orgId: string) => void; onErased: () => void; onLogged: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<SubjectReport | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [erasing, setErasing] = useState(false);
  const [eraseErr, setEraseErr] = useState<string | null>(null);
  const [erased, setErased] = useState<string | null>(null);
  const seq = useRef(0);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = normaliseEmail(email);
    if (busy || !looksLikeEmail(target)) return;
    const mine = ++seq.current;
    setBusy(true);
    setErr(null);
    setErased(null);
    setEraseErr(null);
    setConfirmText("");
    try {
      const r = await adminFetch<SubjectReport>("GET", `/v1/admin/data-subject?email=${encodeURIComponent(target)}`);
      if (mine !== seq.current) return;
      // A 200 without the list of workspaces is not "this person appears nowhere".
      const ok = expectLists(expectShape(r, (x) => typeof x.email === "string"), "workspaces");
      setReport({ ...ok, workspaces: ok.workspaces.filter((w) => w && typeof w.orgId === "string") });
      // Looking someone up is itself recorded.
      onLogged();
    } catch (x) {
      if (mine !== seq.current) return;
      setReport(null);
      setErr(isMissing(x) ? "Looking up a person's data is not available on this server yet." : said(x));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const target = report?.email ?? "";
  const matches = !!report && normaliseEmail(confirmText) === normaliseEmail(target);
  const summary = report ? subjectSummary(report) : null;
  const found = summary ? summary.holding : 0;
  const listed = report ? report.workspaces.length : 0;
  const showKept = !!report && report.workspaces.some((w) => typeof w.anonymisedMessages === "number");
  // Plays hold a person before they are a lead. Shown only when the server reports it.
  const showCandidates = !!report && report.workspaces.some((w) => typeof w.candidates === "number");
  // Erased already: nothing held, and the address is on the platform list.
  const alreadyErased = !!report && !!summary && !summary.held && report.globallySuppressed === true;
  const totalLeads = report ? report.workspaces.reduce((n, w) => n + (typeof w.leads === "number" ? w.leads : 0), 0) : 0;

  const erase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report || erasing || !matches) return;
    setErasing(true);
    setEraseErr(null);
    try {
      const r = await adminFetch<EraseResult>("POST", "/v1/admin/data-subject/erase", { email: report.email, confirm: normaliseEmail(confirmText) });
      // Anything short of an explicit "ok" is not a completed erasure, and must not read as one.
      expectShape(r, (x) => x.ok === true);
      const spaces = typeof r.workspaces === "number" ? r.workspaces : Array.isArray(r.workspaces) ? r.workspaces.length : null;
      const leads = typeof r.leadsDeleted === "number" ? r.leadsDeleted : null;
      const kept = typeof r.messagesAnonymised === "number" ? r.messagesAnonymised : null;
      setErased(
        [
          `The data held about ${report.email} is erased: ${leads === null ? "their lead records were" : `${fmtNum(leads)} lead ${leads === 1 ? "record was" : "records were"}`} removed${spaces === null ? "" : ` across ${fmtNum(spaces)} ${spaces === 1 ? "workspace" : "workspaces"}`}, along with the copies of their details in messages and activity.`,
          kept === null ? "" : kept === 0 ? "No message records are kept." : `${records(kept)} ${kept === 1 ? "is" : "are"} kept without content (${KEPT_MEANS}).`,
          "The address is now on the platform suppression list, so no workspace can email it again.",
        ].filter(Boolean).join(" "),
      );
      setReport(null);
      setConfirmText("");
      setEmail("");
      onErased();
      onLogged();
    } catch (x) {
      setEraseErr(
        isMissing(x)
          ? "Erasing is not available on this server yet. Nothing was removed."
          : `${said(x)} Nothing is confirmed as removed - look the address up again to see what is still held.`,
      );
    } finally {
      setErasing(false);
    }
  };

  return (
    <section aria-label="Find a person's data" className="mt-6" data-testid="admin-data-subject">
      <h2 className="mb-1 text-sm font-semibold text-ink-50">Find a person's data</h2>
      <p className="mb-3 text-sm text-ink-300">For access and erasure requests: see every workspace that holds an address, then erase it everywhere if the person asked for that.</p>

      <form onSubmit={lookup} className="card flex flex-wrap items-end gap-2 p-4" data-testid="subject-lookup" role="search">
        <div className="min-w-0 flex-1"><label className="label" htmlFor="subject-email">Email address</label><input id="subject-email" className="input" type="email" autoComplete="off" spellCheck={false} maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" /></div>
        <button className="btn-primary max-lg:min-h-[40px]" disabled={busy || !looksLikeEmail(email)}>{busy ? "Looking…" : "Look up"}</button>
      </form>

      {err && <div className="card mt-3 border border-red-200 bg-red-50 p-4 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert" data-testid="subject-error">Could not look that address up: {err}</div>}
      {erased && <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 [overflow-wrap:anywhere]" role="status" data-testid="subject-erased">{erased}</div>}

      {report && (
        <div className="card mt-3" data-testid="subject-report">
          <div className="border-b border-black/5 p-4 text-sm">
            <div className="font-mono text-xs text-ink-50 [overflow-wrap:anywhere]">{report.email}</div>
            <div className="mt-1 text-ink-300" data-testid="subject-summary">
              {alreadyErased ? "This person's data has been erased: no workspace holds it." : found === 0 ? "No workspace holds this address." : `Held by ${fmtNum(found)} ${found === 1 ? "workspace" : "workspaces"}.`}{" "}
              {summary && summary.kept > 0 ? `${records(summary.kept)} ${summary.kept === 1 ? "is" : "are"} kept without content in ${fmtNum(summary.keptIn)} ${summary.keptIn === 1 ? "workspace" : "workspaces"} (${KEPT_MEANS}). ` : ""}
              {report.globallySuppressed === true ? "It is on the platform suppression list." : report.globallySuppressed === false ? "It is not on the platform suppression list." : ""}
            </div>
          </div>
          {listed > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="subject-table">
                <thead><tr><th className="th">Workspace</th><th className="th text-right">Leads</th><th className="th text-right">In campaigns</th><th className="th text-right">Messages</th>{showCandidates && <th className="th text-right">Plays</th>}{showKept && <th className="th text-right">Kept without content</th>}<th className="th">Do-not-contact there</th></tr></thead>
                <tbody className="divide-y divide-black/5">
                  {report.workspaces.map((w) => (
                    <tr key={w.orgId}>
                      <td className="td min-w-[9rem]"><button className={`${LINK_BTN} text-left text-brand-600 [overflow-wrap:anywhere]`} onClick={() => onViewOrg(w.orgId)}>{w.orgName || w.orgId}</button></td>
                      <td className="td text-right tabular-nums">{count(w.leads)}</td>
                      <td className="td text-right tabular-nums">{count(w.campaignContacts)}</td>
                      <td className="td text-right tabular-nums">{count(w.messages)}</td>
                      {showCandidates && <td className="td text-right tabular-nums" data-testid="subject-candidates" title={num(w.candidates) > 0 ? "Found by a play and not yet a lead. This still counts as holding the person's data." : undefined}>{num(w.candidates) > 0 ? `${fmtNum(num(w.candidates))} held by Plays (in review, skipped or approved)` : count(w.candidates)}</td>}
                      {showKept && <td className="td text-right tabular-nums">{count(w.anonymisedMessages)}</td>}
                      <td className="td">{w.suppressed === true ? "Yes" : w.suppressed === false ? "No" : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {alreadyErased ? (
            <p className="border-t border-black/5 p-4 text-sm text-ink-300" data-testid="subject-nothing-to-erase">There is nothing left to erase, and the address cannot be added or emailed by any workspace while it stays on the platform suppression list.</p>
          ) : (
          <form onSubmit={erase} className="space-y-3 border-t border-black/5 bg-red-50/40 p-4" data-testid="subject-erase">
            <div className="text-sm font-medium text-red-800">Erase this person everywhere</div>
            <p className="text-sm text-ink-200">
              This removes {found === 0 ? "any record of" : totalLeads > 0 ? `the ${fmtNum(totalLeads)} lead ${totalLeads === 1 ? "record" : "records"} for` : "every record of"} <b className="[overflow-wrap:anywhere]">{report.email}</b> from every workspace, together with the copies of their details in messages{showCandidates ? ", activity and play review queues" : " and activity"}, and adds the address to the platform suppression list so nobody can email it again. The workspaces are not asked first. It cannot be undone.
            </p>
            <div>
              <label className="label" htmlFor="subject-confirm">Type the address to confirm</label>
              <input id="subject-confirm" className="input max-w-md font-mono" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={confirmText} disabled={erasing} onChange={(e) => setConfirmText(e.target.value)} aria-invalid={confirmText.length > 0 && !matches} />
            </div>
            {eraseErr && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert" data-testid="subject-erase-error">{eraseErr}</div>}
            <button className="btn-danger max-lg:min-h-[40px]" disabled={erasing || !matches} data-testid="subject-erase-button">{erasing ? "Erasing…" : "Erase everywhere"}</button>
          </form>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Admin > Security, lower half: the platform suppression list and data-subject requests.
 *
 * Both arrived on the server together. On a server that has neither (the list answers
 * "no such route") this renders nothing at all - no heading, no error - because from the
 * admin's side the feature does not exist yet. Any other failure is shown where it happened.
 */
export function PrivacySections({ onViewOrg, onLogged = () => {} }: { onViewOrg: (orgId: string) => void; onLogged?: () => void }) {
  const [missing, setMissing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const onMissing = useCallback(() => setMissing(true), []);
  const onErased = useCallback(() => setRefreshKey((k) => k + 1), []);
  if (missing) return null;
  return (
    <>
      <SuppressionsSection onMissing={onMissing} refreshKey={refreshKey} onLogged={onLogged} />
      <DataSubjectSection onViewOrg={onViewOrg} onErased={onErased} onLogged={onLogged} />
    </>
  );
}
