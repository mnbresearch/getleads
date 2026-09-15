import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";

export function JoinPage() {
  const [params] = useSearchParams();
  const [f, setF] = useState({ name: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await apiFetch<{ token: string }>("POST", "/v1/auth/join", { token: params.get("token"), ...f });
      auth.set(r.token);
      navigate("/");
    } catch (e2) { setErr((e2 as Error).message); }
  };
  return (
    <div className="mx-auto mt-24 max-w-md p-6">
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold">Join your team on GetLeads</h1>
        <div><label className="label">Your name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label">Choose a password</label><input className="input" type="password" minLength={8} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{err}</div>}
        <button className="btn-primary w-full justify-center">Join</button>
      </form>
    </div>
  );
}
