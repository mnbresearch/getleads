import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ProspexError, apiFetch, fmtDay } from "../lib/api";
import { CANCEL_DELETION_CONFIRM, cancelDeletion, loadDeletion, useDeletion } from "../lib/account";

/** Stretches a text-sized control to a thumb-sized one without changing how it reads. */
const TAP = "inline-flex min-h-[40px] items-center";

const DISMISS_KEY = "gl.verifyBanner.dismissed";

function dismissedFor(email: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === email;
  } catch {
    return false;
  }
}

/**
 * "Confirm your email address", for an account whose address is not confirmed yet - and only
 * where the server can actually send a confirmation email. Where it cannot, nothing is
 * restricted, and a bar asking for something that cannot be done would be noise.
 *
 * Dismissing it hides it for this browser session (it is back after signing in again): the
 * restriction it describes is still there, so it should not be possible to lose it for good.
 */
export function VerifyEmailBanner({ email, onRecheck }: { email: string; onRecheck: () => void }) {
  const [hidden, setHidden] = useState(() => dismissedFor(email));
  const [state, setState] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });

  // The link is usually opened in another tab. Coming back to this one asks again, so the
  // bar goes away by itself instead of staying up until a reload.
  useEffect(() => {
    if (hidden) return;
    const onVisible = () => { if (document.visibilityState === "visible") onRecheck(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [hidden, onRecheck]);

  if (hidden) return null;

  const send = async () => {
    if (state.busy) return;
    setState({ busy: true });
    try {
      const r = await apiFetch<{ emailed?: unknown; alreadyVerified?: unknown; message?: unknown }>("POST", "/v1/auth/verify/resend");
      if (r?.alreadyVerified === true) {
        // Confirmed in another tab since this bar was drawn: nothing to send, and the bar
        // goes once the account is read again.
        setState({ busy: false, ok: "Your email address is already confirmed - thank you." });
        onRecheck();
      }
      // The server can accept the request and still fail to hand the message to the mail
      // service. "Sent" for that would have the person waiting on an email that is not coming.
      else if (r?.emailed === false) setState({ busy: false, err: typeof r.message === "string" && r.message ? r.message : "We could not send the email just now. Try again in a few minutes; if it keeps failing, write to contact@mnbresearch.com." });
      else setState({ busy: false, ok: `Sent to ${email}. It can take a minute to arrive - check spam too. Only the newest link works.` });
    } catch (e) {
      const pe = e as ProspexError;
      setState({ busy: false, err: pe.status === 404 ? "Sending a new link is not available yet. Try again later." : pe.message });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-sm text-amber-900" role="status" data-testid="verify-banner">
      <span className="min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">
        {state.ok ? state.ok : <>Confirm your email address to send invites and use the shared sender. We sent a link to <b className="font-semibold">{email}</b>.</>}
        {state.err && <span className="block text-red-700" role="alert">{state.err}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <button type="button" className={`${TAP} font-medium underline disabled:opacity-60`} disabled={state.busy} onClick={send}>{state.busy ? "Sending…" : state.ok ? "Send it again" : "Send again"}</button>
        <button
          type="button"
          className={`${TAP} justify-center px-2 text-amber-800 hover:text-amber-950`}
          aria-label="Hide this message until you next sign in"
          title="Hide until you next sign in"
          onClick={() => {
            try { sessionStorage.setItem(DISMISS_KEY, email); } catch {}
            setHidden(true);
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * "This workspace is scheduled for deletion", on every page until the date passes or the
 * owner cancels. Not dismissible: it is the one thing everyone in the workspace needs to
 * know, and the only place most of them would ever find out.
 */
export function DeletionBanner({ isOwner }: { isOwner: boolean }) {
  const deletion = useDeletion();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // What to say once it is cancelled: the server's own note when it sends one (it knows
  // whether the campaigns it paused were started again), otherwise advice that is true
  // either way.
  const [cancelled, setCancelled] = useState<string | null>(null);

  useEffect(() => {
    // A failed check shows nothing here; Settings > Workspace says so where it matters.
    loadDeletion().catch(() => {});
  }, []);

  if (cancelled && !deletion?.pending)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm text-emerald-800" role="status" data-testid="deletion-cancelled">
        <span className="min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">Deletion cancelled - this workspace is staying. {cancelled}</span>
        <button type="button" className={`${TAP} px-2`} aria-label="Dismiss" onClick={() => setCancelled(null)}>✕</button>
      </div>
    );
  if (!deletion?.pending) return null;
  // The server's word on who may cancel, when it gives one; otherwise the owner.
  const mayCancel = deletion.canCancel ?? isOwner;

  const cancel = async () => {
    if (busy) return;
    if (!confirm(CANCEL_DELETION_CONFIRM)) return;
    setBusy(true);
    setErr(null);
    try {
      setCancelled(await cancelDeletion());
    } catch (e) {
      setErr(`Could not cancel the deletion: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-300 bg-red-50 px-4 py-1.5 text-sm text-red-800" role="alert" data-testid="deletion-banner">
      <span className="min-w-0 flex-1 basis-64 [overflow-wrap:anywhere]">
        This workspace is scheduled for deletion{deletion.scheduledFor ? <> on <b className="font-semibold">{fmtDay(deletion.scheduledFor)}</b></> : ""}. Campaigns are paused.
        {deletion.requestedBy ? ` Requested by ${deletion.requestedBy}.` : ""}
        {!mayCancel && " Only the workspace owner can cancel it."}
        {err && <span className="block font-medium">{err}</span>}
      </span>
      {mayCancel && <button type="button" className={`${TAP} shrink-0 font-semibold underline disabled:opacity-60`} disabled={busy} onClick={cancel}>{busy ? "Cancelling…" : "Cancel deletion"}</button>}
    </div>
  );
}

const RECOVERY_KEY = "gl.recoveryCodeUsed";

/** Called by the sign-in step when the server says a recovery code was what got the person in. */
export function noteRecoveryCodeUsed(left: unknown) {
  try {
    sessionStorage.setItem(RECOVERY_KEY, typeof left === "number" && left >= 0 ? String(left) : "?");
  } catch {}
}

/**
 * "You signed in with a recovery code", once, after such a sign-in. A recovery code is a
 * spare key: it is gone now, and the person should know how many are left before the last
 * one is a surprise.
 */
export function RecoveryCodeNotice() {
  const [left, setLeft] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(RECOVERY_KEY);
    } catch {
      return null;
    }
  });
  if (left === null) return null;
  const n = left === "?" ? null : Number(left);
  const close = () => {
    try { sessionStorage.removeItem(RECOVERY_KEY); } catch {}
    setLeft(null);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-sm text-amber-900" role="status" data-testid="recovery-notice">
      <span className="min-w-0 flex-1 basis-64">
        You signed in with a recovery code, which cannot be used again.
        {n === null ? "" : n === 0 ? " That was your last one." : ` ${n} ${n === 1 ? "is" : "are"} left.`}
        {" "}Make a new set under Settings &gt; Two-factor sign-in{n !== null && n <= 2 ? " now, while you still can" : ""}.
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <Link className={`${TAP} font-medium underline`} to="/settings" onClick={close}>Open Settings</Link>
        <button type="button" className={`${TAP} justify-center px-2`} aria-label="Dismiss" onClick={close}>✕</button>
      </span>
    </div>
  );
}
