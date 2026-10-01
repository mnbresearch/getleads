import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { Logo } from "../components/Logo";

/**
 * Request a password reset link.
 *
 * The server answers {ok:true} whether or not the address has an account, so the page says
 * the same thing either way - telling the visitor "no such account" would let anyone probe
 * which emails are Scout customers.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("POST", "/v1/auth/password/forgot", { email: email.trim() });
      setSent(true);
    } catch (e2) {
      // A network or server failure is not "sent": say so, so they can try again.
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto mt-16 max-w-md p-6">
      <div className="mb-6 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      {sent ? (
        <div className="card space-y-3 p-6" role="status">
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p className="text-sm text-ink-300">
            If an account exists for <span className="font-medium text-ink-100">{email.trim()}</span>, we&apos;ve emailed a link to reset its password. The link works once and expires soon, so use it shortly.
          </p>
          <p className="text-xs text-ink-400">Nothing arrived after a few minutes? Check spam, or try again. If you signed up with Google, use "Continue with Google" on the sign-in page instead.</p>
          <div className="flex gap-2">
            <button className="btn-secondary flex-1 justify-center" onClick={() => setSent(false)}>Try again</button>
            <Link className="btn-primary flex-1 justify-center" to="/login">Back to sign in</Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="card space-y-3 p-6">
          <h1 className="text-lg font-semibold">Reset your password</h1>
          <p className="text-sm text-ink-400">Enter the email you sign in with and we&apos;ll send you a reset link.</p>
          <div>
            <label className="label" htmlFor="forgot-email">Email</label>
            <input id="forgot-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}</div>}
          <button className="btn-primary w-full justify-center" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send reset link"}</button>
          <div className="text-center text-sm text-ink-400">
            Remembered it? <Link className="text-brand-600" to="/login">Sign in</Link>
          </div>
        </form>
      )}
    </div>
  );
}

export default ForgotPasswordPage;
