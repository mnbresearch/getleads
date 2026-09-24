import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";

export function JoinPage() {
  const [params] = useSearchParams();
  const [f, setF] = useState({ name: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  // An invite token is single-use. Without a submit guard a double-click sent it twice, the
  // second call failed on the already-consumed token, and the user was shown that failure
  // while the first call had actually succeeded.
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ token: string }>("POST", "/v1/auth/join", { token: params.get("token"), ...f });
      auth.set(r.token);
      navigate("/");
    } catch (e2) { setErr((e2 as Error).message); setBusy(false); }
  };
  return (
    <div className="mx-auto mt-24 max-w-md p-6">
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold">Join your team on Scout</h1>
        <div><label className="label" htmlFor="join-name">Your name</label><input id="join-name" className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor="join-password">Choose a password</label><input id="join-password" className="input" type="password" autoComplete="new-password" minLength={8} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Joining…" : "Join"}</button>
      </form>
    </div>
  );
}
