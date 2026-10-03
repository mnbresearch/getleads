import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ProspexError, apiFetch, useAuthToken } from "../lib/api";
import { forgetMe } from "../lib/me";
import { Logo } from "../components/Logo";

/**
 * Confirm an email address from the link in the confirmation email (?token=...).
 *
 * Public: the link is opened from a mail app, often in a browser that is not signed in. The
 * link works once, so the request for a given token is made once however many times the
 * component mounts (React's development double-mount would otherwise spend the token on the
 * first call and report "invalid" from the second).
 */
type Outcome =
  | { kind: "ok" }
  /** The link is spent, expired or mangled. */
  | { kind: "bad" }
  /** The server has no such feature (an older server). */
  | { kind: "unavailable" }
  /** The check itself failed: network, 5xx, rate limit. Worth trying again. */
  | { kind: "error"; message: string };

const attempts = new Map<string, Promise<Outcome>>();

function confirm(token: string): Promise<Outcome> {
  const known = attempts.get(token);
  if (known) return known;
  const p: Promise<Outcome> = apiFetch("POST", "/v1/auth/verify/confirm", { token }, undefined, { anonymous: true }).then(
    (): Outcome => ({ kind: "ok" }),
    (e): Outcome => {
      const pe = e as ProspexError;
      if (pe.status === 404 || pe.status === 405) return { kind: "unavailable" };
      // 400 is the server's "this link is no good" - by its code, or a validator complaint
      // about a token too short to be one.
      if (pe.status === 400 || pe.status === 410 || pe.code === "invalid_verification_token") return { kind: "bad" };
      // Not remembered: a failed check may be retried with the same link.
      attempts.delete(token);
      return { kind: "error", message: pe.message || "Something went wrong." };
    },
  );
  attempts.set(token, p);
  return p;
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const signedIn = !!useAuthToken();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // For a spent link opened while signed in: the address may simply be confirmed already.
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  const [resend, setResend] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });

  const run = useCallback(() => {
    if (!token) return;
    setOutcome(null);
    let live = true;
    void confirm(token).then((o) => {
      if (!live) return;
      setOutcome(o);
      // The signed-in app caches "who am I"; it has to ask again to learn the address is confirmed.
      if (o.kind === "ok") forgetMe();
    });
    return () => { live = false; };
  }, [token]);
  useEffect(() => run(), [run]);

  useEffect(() => {
    if (outcome?.kind !== "bad" || !signedIn) return;
    let live = true;
    apiFetch<{ user?: { emailVerified?: unknown } | null }>("GET", "/v1/auth/me")
      .then((r) => { if (live && r?.user?.emailVerified === true) setAlreadyConfirmed(true); })
      .catch(() => {});
    return () => { live = false; };
  }, [outcome, signedIn]);

  const sendAgain = async () => {
    if (resend.busy) return;
    setResend({ busy: true });
    try {
      const r = await apiFetch<{ emailed?: unknown }>("POST", "/v1/auth/verify/resend");
      if (r?.emailed === false) setResend({ busy: false, err: "We could not send the email just now. Try again in a few minutes; if it keeps failing, write to contact@mnbresearch.com." });
      else setResend({ busy: false, ok: "Sent. Open the newest email from Scout and use the link in it - older links stop working." });
    } catch (e) {
      const pe = e as ProspexError;
      setResend({ busy: false, err: pe.status === 404 ? "Sending a new link is not available yet. Try again later." : pe.message });
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto mt-16 max-w-md p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      {children}
    </div>
  );
  const onward = signedIn ? <Link className="btn-primary w-full justify-center" to="/">Continue to Scout</Link> : <Link className="btn-primary w-full justify-center" to="/login">Sign in</Link>;

  if (!token)
    return shell(
      <div className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold">This link is incomplete</h1>
        <p className="text-sm text-ink-300">The link you opened is missing its confirmation code. Open the link from the email again - if your mail app split it across two lines, copy the whole address into the browser.</p>
        {signedIn ? <Link className="btn-secondary w-full justify-center" to="/">Go to Scout</Link> : <Link className="btn-secondary w-full justify-center" to="/login">Sign in to send a new link</Link>}
      </div>,
    );

  if (!outcome)
    return shell(
      <div className="card space-y-3 p-6" role="status">
        <h1 className="text-lg font-semibold">Confirming your email…</h1>
        <p className="text-sm text-ink-300">This takes a moment.</p>
      </div>,
    );

  if (outcome.kind === "ok" || alreadyConfirmed)
    return shell(
      <div className="card space-y-3 p-6" role="status" data-testid="verify-ok">
        <h1 className="text-lg font-semibold">{outcome.kind === "ok" ? "Email confirmed" : "Your email is already confirmed"}</h1>
        <p className="text-sm text-ink-300">{outcome.kind === "ok" ? "Thanks - your address is confirmed. You can now invite teammates and send from the shared sender." : "There is nothing more to do - this address was confirmed earlier."}</p>
        {onward}
      </div>,
    );

  if (outcome.kind === "unavailable")
    return shell(
      <div className="card space-y-3 p-6" role="alert">
        <h1 className="text-lg font-semibold">Email confirmation is not available yet</h1>
        <p className="text-sm text-ink-300">This link could not be checked right now. Nothing is wrong with your account - try the link again later.</p>
        {onward}
      </div>,
    );

  if (outcome.kind === "error")
    return shell(
      <div className="card space-y-3 p-6" role="alert">
        <h1 className="text-lg font-semibold">We could not confirm your email</h1>
        <p className="text-sm text-ink-300 [overflow-wrap:anywhere]">{outcome.message} Your link has not been used up - try again.</p>
        <button className="btn-primary w-full justify-center" onClick={run}>Try again</button>
        {signedIn ? <Link className="btn-secondary w-full justify-center" to="/">Go to Scout</Link> : <Link className="btn-secondary w-full justify-center" to="/login">Sign in</Link>}
      </div>,
    );

  return shell(
    <div className="card space-y-3 p-6" role="alert" data-testid="verify-bad">
      <h1 className="text-lg font-semibold">This confirmation link does not work any more</h1>
      <p className="text-sm text-ink-300">Confirmation links last 24 hours and work once. This one has expired, has already been used, or was replaced by a newer email. If you already confirmed your address, there is nothing more to do.</p>
      {signedIn ? (
        <>
          {resend.ok && <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700" role="status">{resend.ok}</div>}
          {resend.err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{resend.err}</div>}
          {!resend.ok && <button className="btn-primary w-full justify-center" disabled={resend.busy} onClick={sendAgain}>{resend.busy ? "Sending…" : "Send a new link"}</button>}
          <Link className="btn-secondary w-full justify-center" to="/">Go to Scout</Link>
        </>
      ) : (
        <>
          <Link className="btn-primary w-full justify-center" to="/login">Sign in</Link>
          <p className="text-xs text-ink-400">After you sign in, use "Send again" in the bar at the top of the app to get a new link.</p>
        </>
      )}
    </div>,
  );
}

export default VerifyEmailPage;
