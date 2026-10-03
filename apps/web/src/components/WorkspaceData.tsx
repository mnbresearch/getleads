import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, ProspexError, UNREADABLE_MESSAGE, apiFetch, auth, errorCode, errorMessage, fmtDay, networkErrorMessage, rejectSession } from "../lib/api";
import { CANCEL_DELETION_CONFIRM, cancelDeletion, loadDeletion, pausedNote, setDeletion, useDeletion } from "../lib/account";
import { fileSlug, saveBlob } from "../lib/download";
import { useMe } from "../lib/me";
import { Spinner } from "./ui";

/** A whole workspace can take a while to gather; this is a backstop against a hang, not a budget. */
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

const sizeText = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`);

/**
 * Which proof the server asks for before an export or a deletion: a two-factor code when
 * that is on, otherwise the password - and for an account with neither (it signs in with
 * Google and never set a password) there is nothing to check, so it has to set one first.
 */
type Proof = "code" | "password" | "none";
function useProof(): Proof {
  const { me } = useMe();
  const u = me?.user;
  return u?.twoFactorEnabled ? "code" : u?.hasPassword === false ? "none" : "password";
}

const NO_PROOF = "Your account signs in with Google and has no password to confirm with. Set a password (above) or turn on two-factor sign-in first, then come back here.";
const WRONG_CODE = "That code is not right. Enter the code your app is showing now, or a recovery code you have not used.";

function ProofField({ proof, id, value, onChange, disabled }: { proof: Proof; id: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  if (proof === "none") return <p className="text-sm text-amber-800" role="status">{NO_PROOF}</p>;
  return proof === "code" ? (
    <div>
      <label className="label" htmlFor={id}>Code from your authenticator app, or a recovery code</label>
      <input id={id} className="input max-w-xs font-mono" autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  ) : (
    <div>
      <label className="label" htmlFor={id}>Your password</label>
      <input id={id} className="input max-w-sm" type="password" autoComplete="current-password" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * "Export all data": one JSON file of everything the workspace owns.
 *
 * Not through apiFetch - that reads the body as text to parse it, and this body is the
 * file. So it does for itself what apiFetch does: turns an error body into the server's own
 * sentence (a 429 says how long to wait), ends a session the server no longer accepts, and
 * refuses to save something that is not the export (an error page would otherwise be
 * downloaded under a file name that says "export").
 *
 * The server asks who is asking once more first - the password, or a two-factor code - so
 * a tab left open is not enough to walk away with the whole workspace.
 */
function ExportCard({ orgName }: { orgName: string }) {
  const proof = useProof();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const request = async (sentToken: string | null, signal: AbortSignal): Promise<Response> => {
    const authz: Record<string, string> = sentToken ? { authorization: `Bearer ${sentToken}` } : {};
    const given = proof === "code" ? { code: secret.trim() } : proof === "password" ? { password: secret } : {};
    const res = await fetch(`${API_URL}/v1/account/export`, { method: "POST", headers: { ...authz, "content-type": "application/json" }, body: JSON.stringify(given), signal });
    if (res.status !== 404 && res.status !== 405) return res;
    // A server that only has the GET form takes the confirmation in headers (never in the
    // address, where it would be logged). Percent-encoded: a password may hold any
    // character, a header may not.
    const confirm: Record<string, string> = proof === "code" ? { "x-confirm-code": encodeURIComponent(secret.trim()) } : proof === "password" ? { "x-confirm-password": encodeURIComponent(secret) } : {};
    return fetch(`${API_URL}/v1/account/export`, { headers: { ...authz, ...confirm }, signal });
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || proof === "none" || !secret.trim()) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    const sentToken = auth.token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EXPORT_TIMEOUT_MS);
    const slow = "The export took too long and was stopped. Try again; if it keeps happening, contact support.";
    try {
      let res: Response;
      try {
        res = await request(sentToken, ctrl.signal);
      } catch (x) {
        throw new Error((x as Error)?.name === "AbortError" ? slow : networkErrorMessage(0));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let data: unknown = text;
        try { data = JSON.parse(text); } catch {}
        const code = errorCode(data);
        // "unauthorized" is the session itself being refused; any other 401 here is a wrong
        // password or code, and the person stays signed in to try again.
        if (res.status === 401 && code === "unauthorized") rejectSession(sentToken);
        if (res.status === 404 || res.status === 405) throw new Error("Exporting all data is not available yet. Try again later.");
        throw new Error(code === "invalid_2fa_code" ? WRONG_CODE : errorMessage(data, res.status));
      }
      if (/\bhtml\b/i.test(res.headers.get("content-type") ?? "")) throw new Error(UNREADABLE_MESSAGE);
      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (x) {
        throw new Error((x as Error)?.name === "AbortError" ? slow : "The download was interrupted before it finished. Check your connection and try again in 10 minutes (one export is allowed every 10 minutes).");
      }
      if (blob.size === 0) throw new Error("The export came back empty, so nothing was saved. Try again.");
      // The server names the file after the workspace; that name is used when the browser is allowed to read it.
      const named = /filename="?([A-Za-z0-9._-]+\.json)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const name = named ?? `scout-export-${fileSlug(orgName)}-${new Date().toISOString().slice(0, 10)}.json`;
      saveBlob(blob, name);
      setDone(`Saved ${name} (${sizeText(blob.size)}). Check your downloads folder.`);
      setOpen(false);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      clearTimeout(timer);
      setSecret("");
      setBusy(false);
    }
  };

  return (
    <div className="card max-w-xl space-y-3 p-5" data-testid="export-card">
      <div className="font-medium">Export all data</div>
      <p className="text-sm text-ink-300">Download everything this workspace holds as one JSON file: leads, companies, lists, clients, campaigns with their messages, the do-not-contact list, settings and the security log. Passwords, API keys and integration credentials are never included. One export every 10 minutes.</p>
      {done && <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700 [overflow-wrap:anywhere]" role="status">{done}</div>}
      {!open ? (
        <>
          {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>}
          <button type="button" className="btn-secondary" onClick={() => { setOpen(true); setErr(null); setDone(null); }}>Export all data</button>
        </>
      ) : (
        <form onSubmit={run} className="space-y-3 rounded-lg border border-black/10 bg-black/[0.02] p-3" data-testid="export-form">
          <p className="text-sm text-ink-200">Confirm it is you. The file holds every lead and message in the workspace.</p>
          <ProofField proof={proof} id="export-proof" value={secret} onChange={setSecret} disabled={busy} />
          {busy && (
            <div role="status">
              <Spinner label="Preparing your export…" />
              <p className="mt-1 text-xs text-ink-400">This can take a minute for a large workspace. Keep this tab open - the file downloads when it is ready.</p>
            </div>
          )}
          {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || proof === "none" || !secret.trim()}>{busy ? "Preparing…" : "Download export"}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setOpen(false); setSecret(""); setErr(null); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * "Delete workspace": the danger zone.
 *
 * Deletion is scheduled, not immediate - the server sets a date a week out, pauses the
 * campaigns, and the owner can call it off until then. The form asks for the workspace's
 * exact name and for proof it is really the owner asking (the password, or a two-factor
 * code when that is on), because a signed-in tab left open must not be enough.
 */
function DeleteCard({ orgName }: { orgName: string }) {
  const proof = useProof();
  const deletion = useDeletion();
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);

  const check = useCallback(() => {
    setCheckErr(null);
    loadDeletion().catch((e) => setCheckErr((e as Error).message));
  }, []);
  useEffect(() => { check(); }, [check]);
  useEffect(() => { if (open) nameField.current?.focus(); }, [open]);

  const matches = name === orgName;
  const canSubmit = !busy && matches && proof !== "none" && secret.trim().length > 0;
  // What scheduling did to the campaigns, said once, right after it happened.
  const [paused, setPaused] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = { confirmName: name, ...(proof === "code" ? { code: secret.trim() } : proof === "password" ? { password: secret } : {}) };
      const r = await apiFetch<{ scheduledFor?: unknown; pausedCampaigns?: unknown }>("POST", "/v1/account/delete", body, undefined, { reconfirm: true });
      const when = typeof r?.scheduledFor === "string" && r.scheduledFor ? r.scheduledFor : null;
      setPaused(pausedNote(r));
      // Only the owner gets this far, and the owner may cancel.
      setDeletion({ pending: true, scheduledFor: when, canCancel: true });
      setOpen(false);
      setName("");
      setSecret("");
      // The date is the point of the answer; if it was not in it, ask.
      if (!when) loadDeletion().catch(() => {});
    } catch (x) {
      const pe = x as ProspexError;
      setErr(pe.status === 404 || pe.status === 405 ? "Deleting a workspace from here is not available yet. Write to contact@mnbresearch.com and we will do it for you." : pe.code === "invalid_2fa_code" ? WRONG_CODE : pe.message);
      setSecret("");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    if (!confirm(CANCEL_DELETION_CONFIRM)) return;
    setBusy(true);
    setErr(null);
    try {
      setNote(`Deletion cancelled - this workspace is staying. ${await cancelDeletion()}`);
      setPaused("");
    } catch (x) {
      setErr(`Could not cancel the deletion: ${(x as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card max-w-xl space-y-3 border-red-200 p-5" data-testid="delete-card">
      <div className="font-medium text-red-700">Delete workspace</div>
      {note && <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700 [overflow-wrap:anywhere]" role="status">{note}</div>}
      {deletion?.pending ? (
        <>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="status" data-testid="delete-scheduled">
            This workspace is scheduled for deletion{deletion.scheduledFor ? <> on <b className="font-semibold">{fmtDay(deletion.scheduledFor)}</b></> : ""}. Until then it keeps working, with campaigns paused. On that date everything in it is permanently deleted for everyone on the team.
            {paused ? ` ${paused}` : ""}
          </div>
          <p className="text-sm text-ink-300">Changed your mind? Cancelling keeps everything exactly as it is.</p>
          {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>}
          <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>{busy ? "Cancelling…" : "Cancel deletion"}</button>
        </>
      ) : checkErr && !deletion ? (
        // Not "nothing scheduled": we could not look. Offering the form on a guess could
        // schedule a second deletion over one that is already running.
        <div className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800 [overflow-wrap:anywhere]" role="alert">
          Could not check whether a deletion is already scheduled ({checkErr}). <button type="button" className="inline-flex min-h-[40px] items-center font-medium underline" onClick={check}>Try again</button>
        </div>
      ) : !deletion ? (
        <Spinner label="Checking…" />
      ) : (
        <>
          <p className="text-sm text-ink-300">Permanently deletes this workspace and everything in it - leads, lists, clients, campaigns, messages, API keys and every teammate's access. It is scheduled for 7 days from now: until then the workspace keeps working with campaigns paused, and you can cancel. After that it cannot be recovered. Export your data first if you may want it later.</p>
          {!open ? (
            <button type="button" className="btn-danger" onClick={() => { setOpen(true); setErr(null); setNote(null); }}>Delete workspace…</button>
          ) : (
            <form onSubmit={submit} className="space-y-3 rounded-lg border border-red-200 bg-red-50/40 p-3" data-testid="delete-form">
              <div>
                <label className="label" htmlFor="del-name">Type the workspace name to confirm</label>
                <p className="mb-1 text-sm text-ink-200 [overflow-wrap:anywhere]">The name is <b className="font-semibold" data-testid="delete-name">{orgName}</b></p>
                <input id="del-name" ref={nameField} className="input" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} aria-invalid={name.length > 0 && !matches} />
                {name.length > 0 && !matches && <p className="mt-1 text-xs text-red-700">That does not match yet. Capital letters and spaces count.</p>}
              </div>
              <ProofField proof={proof} id="del-proof" value={secret} onChange={setSecret} disabled={busy} />
              {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>}
              <div className="flex flex-wrap gap-2">
                <button className="btn bg-red-600 text-white hover:bg-red-700" disabled={!canSubmit}>{busy ? "Scheduling…" : "Schedule deletion"}</button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setOpen(false); setName(""); setSecret(""); setErr(null); }}>Keep workspace</button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Settings > Workspace, for the owner: take everything out, and close the workspace.
 * The server allows both to the owner only, so nobody else is shown them - and they wait
 * for the role to be known rather than appearing for a moment and vanishing.
 */
export function WorkspaceData({ orgName }: { orgName: string }) {
  const { role, settled } = useMe();
  if (!settled || role !== "owner") return null;
  return (
    <>
      <ExportCard orgName={orgName} />
      <DeleteCard orgName={orgName} />
    </>
  );
}
