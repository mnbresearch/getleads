import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";
import { Logo } from "../components/Logo";

/**
 * Set a new password from an emailed reset link (?token=...).
 *
 * On success the server returns the same body as /v1/auth/login, so the user is signed in
 * straight away exactly the way the login form does it, rather than being sent back to type
 * the password they just chose.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      auth.set(r.token);
      navigate("/", { replace: true });
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-md p-6">
      <div className="mb-6 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      {!token ? (
        <div className="card space-y-3 p-6">
          <h1 className="text-lg font-semibold">This reset link is incomplete</h1>
          <p className="text-sm text-ink-300">The link is missing its reset code. Open it again from the email, or request a new one.</p>
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
