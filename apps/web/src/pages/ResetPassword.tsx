import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ProspexError, apiFetch, auth, unreadableAnswer } from "../lib/api";
import { Logo } from "../components/Logo";
import { TwoFactorStep, twoFactorChallenge } from "../components/TwoFactorStep";

/**
 * Set a new password from an emailed reset link (?token=...).
 *
 * On success the server returns the same body as /v1/auth/login, so the user is signed in
 * straight away exactly the way the login form does it, rather than being sent back to type
 * the password they just chose.
 */
const BAD_LINK = "This reset link is invalid or has expired. Request a new one.";

/**
 * Whether a failed reset was the link's fault rather than the password's.
 *
 * A malformed token comes back as a validator error ("token: String must contain at least
 * 10 character(s)"), which is accurate and useless to someone who clicked a link. Anything
 * about the token gets the one sentence that tells them what to do.
 */
function isTokenProblem(e: unknown): boolean {
  if (!(e instanceof ProspexError) || e.status !== 400) return false;
  if (["invalid_reset_token", "invalid_token", "expired_token", "token_expired", "token_used"].includes(e.code)) return true;
  if (/token/i.test(e.code)) return true;
  const body = e.details as { error?: { issues?: { path?: unknown }[] } } | null | undefined;
  const issues = body?.error?.issues;
  if (Array.isArray(issues) && issues.some((i) => (Array.isArray(i?.path) ? i.path[0] : i?.path) === "token")) return true;
  // Older validator shape and message-only fallbacks.
  return /^token\b/i.test(e.message);
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkBad, setLinkBad] = useState(false);
  // The password was changed, but this account has two-factor on: the reset does not sign in
  // by itself, it hands back the same "now the code" step the login form gets.
  const [challenge, setChallenge] = useState<string | null>(null);

  const mismatch = confirmPw.length > 0 && pw !== confirmPw;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (pw.length < 8) return setErr("Use at least 8 characters.");
    if (pw !== confirmPw) return setErr("The two passwords don't match.");
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ token: string }>("POST", "/v1/auth/password/reset", { token, password: pw });
      const pending = twoFactorChallenge(r);
      if (pending) {
        setChallenge(pending);
        setBusy(false);
        return;
      }
      if (!r || typeof r.token !== "string" || !r.token) throw unreadableAnswer();
      auth.set(r.token);
      navigate("/", { replace: true });
    } catch (e2) {
      if (isTokenProblem(e2)) setLinkBad(true);
      else setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-md p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      {challenge ? (
        // The reset link is spent and the new password is saved by now, so "start again"
        // here means the ordinary sign-in form with the new password - not this page.
        <TwoFactorStep
          challenge={challenge}
          intro="Your password has been changed. Enter a code to finish signing in."
          backLabel="Sign in later"
          onSignedIn={(t) => {
            auth.set(t);
            navigate("/", { replace: true });
          }}
          onExpired={() => navigate("/login", { replace: true, state: { notice: "Your password has been changed. That sign-in took too long to finish - sign in with your new password." } })}
          onBack={() => navigate("/login", { replace: true, state: { notice: "Your password has been changed. Sign in with your new password." } })}
        />
      ) : !token || linkBad ? (
        <div className="card space-y-3 p-6" role={linkBad ? "alert" : undefined}>
          <h1 className="text-lg font-semibold">Reset link not valid</h1>
          <p className="text-sm text-ink-300">{BAD_LINK}</p>
          <Link className="btn-primary w-full justify-center" to="/forgot-password">Request a new link</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="card space-y-3 p-6">
          <h1 className="text-lg font-semibold">Choose a new password</h1>
          <div>
            <label className="label" htmlFor="reset-pw">New password</label>
            <input id="reset-pw" className="input" type="password" autoComplete="new-password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} />
            <p className="mt-1 text-xs text-ink-400">At least 8 characters.</p>
          </div>
          <div>
            <label className="label" htmlFor="reset-pw2">Confirm new password</label>
            <input id="reset-pw2" className="input" type="password" autoComplete="new-password" required minLength={8} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} aria-invalid={mismatch} />
            {mismatch && <p className="mt-1 text-xs text-red-600">Passwords don&apos;t match.</p>}
          </div>
          {err && (
            <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">
              {err} <Link className="underline" to="/forgot-password">Request a new link</Link>
            </div>
          )}
          <button className="btn-primary w-full justify-center" disabled={busy || pw.length < 8 || pw !== confirmPw}>{busy ? "Saving…" : "Set password and sign in"}</button>
        </form>
      )}
    </div>
  );
}

export default ResetPasswordPage;
