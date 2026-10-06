import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth, ProspexError } from "../lib/api";

/** What the invite check found, before anything is typed. */
type InviteCheck =
  | { state: "checking" }
  /** No answer worth acting on (an older server, a rate limit, an outage): show the form, as before. */
  | { state: "unknown" }
  | { state: "valid"; orgName: string; email: string }
  | { state: "invalid"; reason: string };

/** The same words the join route uses for each reason, so the page says one thing before and after. */
const INVITE_GONE: Record<string, { title: string; text: string; signIn?: boolean }> = {
  expired: { title: "This invite has expired", text: "Ask the workspace to re-send it." },
  used: { title: "This invite has already been used", text: "Sign in instead.", signIn: true },
  revoked: { title: "This invite was cancelled", text: "The workspace cancelled it. Ask them to send a new one." },
  not_found: { title: "This invite link is not valid", text: "Ask the workspace to send a new one. If they re-sent your invite, use the link in the newest email." },
};

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
  // An expired, used or cancelled link is said straight away, not after a name and a
  // password have been typed into a form that could never work. The check changes nothing
  // (it does not use the invite up), and any answer that is not a clear yes or no falls
  // back to showing the form.
  const [check, setCheck] = useState<InviteCheck>({ state: token ? "checking" : "unknown" });
  useEffect(() => {
    if (!token) return;
    let live = true;
    apiFetch<{ valid?: unknown; reason?: unknown; orgName?: unknown; email?: unknown }>("POST", "/v1/auth/join/check", { token }, undefined, { anonymous: true, timeoutMs: 10_000 })
      .then((r) => {
        if (!live) return;
        if (r?.valid === true) setCheck({ state: "valid", orgName: typeof r.orgName === "string" ? r.orgName.slice(0, 80) : "", email: typeof r.email === "string" ? r.email.slice(0, 120) : "" });
        else if (r?.valid === false) setCheck({ state: "invalid", reason: typeof r.reason === "string" && Object.prototype.hasOwnProperty.call(INVITE_GONE, r.reason) ? r.reason : "not_found" });
        else setCheck({ state: "unknown" });
      })
      .catch((e) => {
        if (!live) return;
        // A token the server will not even read (too long, malformed) is not a usable link.
        setCheck((e as ProspexError)?.status === 400 ? { state: "invalid", reason: "not_found" } : { state: "unknown" });
      });
    return () => { live = false; };
  }, [token]);
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
  if (check.state === "checking") {
    return (
      <div className="mx-auto mt-24 max-w-md p-6">
        <div className="card p-6 text-sm text-ink-400" role="status" data-testid="join-checking">Checking your invite…</div>
      </div>
    );
  }
  if (check.state === "invalid") {
    const gone = INVITE_GONE[check.reason] ?? INVITE_GONE.not_found;
    return (
      <div className="mx-auto mt-24 max-w-md p-6">
        <div className="card space-y-3 p-6" role="alert" data-testid="join-invalid">
          <h1 className="text-lg font-semibold">{gone.title}</h1>
          <p className="text-sm text-ink-300">{gone.text}</p>
          <Link className={`${gone.signIn ? "btn-primary" : "btn-secondary"} w-full justify-center`} to="/login">Go to sign in</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-24 max-w-md p-6">
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold [overflow-wrap:anywhere]">{check.state === "valid" && check.orgName ? `Join ${check.orgName} on Scout` : "Join your team on Scout"}</h1>
        {check.state === "valid" && check.email && <p className="text-sm text-ink-300 [overflow-wrap:anywhere]" data-testid="join-invited-as">You were invited as {check.email}.</p>}
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
