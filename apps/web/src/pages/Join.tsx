import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth, ProspexError } from "../lib/api";

export function JoinPage() {
  const [params] = useSearchParams();
  const [f, setF] = useState({ name: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  // An invite token is single-use. Without a submit guard a double-click sent it twice, the
  // second call failed on the already-consumed token, and the user was shown that failure
  // while the first call had actually succeeded.
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const token = params.get("token");
  const [alreadyHasAccount, setAlreadyHasAccount] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ token: string }>("POST", "/v1/auth/join", { token, ...f });
      auth.set(r.token);
      navigate("/");
    } catch (e2) {
      const pe = e2 as ProspexError & { status?: number; code?: string };
      // 409: this email already has a Scout account. Say how to proceed rather than just
      // "conflict" - they sign in to their existing account instead.
      if (pe.status === 409 || pe.code === "exists" || pe.code === "already_registered") setAlreadyHasAccount(true);
      setErr(joinErrorText(pe));
      setBusy(false);
    }
  };
  // Opened without ?token (a mangled or truncated link): nothing to submit, so say so
  // instead of posting token: null and showing a validation error.
  if (!token) {
    return (
      <div className="mx-auto mt-24 max-w-md p-6">
        <div className="card space-y-3 p-6">
          <h1 className="text-lg font-semibold">This invite link is incomplete</h1>
          <p className="text-sm text-ink-300">The link you opened is missing its invite code. Open the link from your invite email again, or ask whoever invited you to resend the invite.</p>
          <Link className="btn-secondary w-full justify-center" to="/login">Go to sign in</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-24 max-w-md p-6">
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold">Join your team on Scout</h1>
        <div><label className="label" htmlFor="join-name">Your name</label><input id="join-name" className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor="join-password">Choose a password</label><input id="join-password" className="input" type="password" autoComplete="new-password" minLength={8} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}{alreadyHasAccount && <> <Link className="underline" to="/login">Sign in</Link></>}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Joining…" : "Join"}</button>
      </form>
    </div>
  );
}

function joinErrorText(e: { status?: number; code?: string; message: string }): string {
  if (e.status === 409 || e.code === "exists" || e.code === "already_registered") return "An account with this email already exists. Sign in with it instead - ask the person who invited you if you need to be moved to this team.";
  const code = e.code ?? "";
  if (/expired/.test(code) || /expired/i.test(e.message)) return "This invite has expired. Ask whoever invited you to send a new one.";
  if (/revoked/.test(code) || /revoked/i.test(e.message)) return "This invite was withdrawn. Ask whoever invited you to send a new one.";
  if (code === "invalid_invite") return "This invite is no longer valid - it may have been used already, withdrawn, or expired. Ask whoever invited you to send a new one.";
  return e.message;
}
