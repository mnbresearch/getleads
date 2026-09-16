import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, auth } from "../lib/api";
import { Logo, BRAND_NAME, BRAND_TAGLINE } from "../components/Logo";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const [form, setForm] = useState({ email: "", password: "", name: "", orgName: "", inviteCode: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ token: string; apiKey?: string }>("POST", `/v1/auth/${mode}`, mode === "login" ? { email: form.email, password: form.password } : { ...form, inviteCode: form.inviteCode || undefined, orgName: form.orgName || undefined, name: form.name || undefined });
      auth.set(r.token);
      if (r.apiKey) setApiKey(r.apiKey);
      else navigate("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (apiKey)
    return (
      <div className="mx-auto mt-24 max-w-md p-6">
        <div className="card p-6">
          <h1 className="text-xl font-semibold">Welcome to {BRAND_NAME}</h1>
          <p className="mt-2 text-sm text-ink-300">Here is your API key for agents and integrations. It is shown only once; you can create more in Settings.</p>
          <code className="mt-3 block break-all rounded-lg bg-black p-3 text-xs text-emerald-600">{apiKey}</code>
          <button className="btn-primary mt-4 w-full justify-center" onClick={() => navigate("/")}>Go to dashboard</button>
        </div>
      </div>
    );
  return (
    <div className="mx-auto mt-16 max-w-md p-6">
      <div className="mb-2 flex items-center justify-center">
        <Logo size={34} textClassName="text-2xl" />
      </div>
      <p className="mb-6 text-center text-sm text-ink-400">{BRAND_TAGLINE}</p>
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold">{mode === "login" ? "Sign in" : "Create your workspace"}</h1>
        {mode === "signup" && (
          <>
            <div><label className="label">Your name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label">Company / workspace</label><input className="input" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} /></div>
          </>
        )}
        <div><label className="label">Email</label><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label">Password</label><input className="input" type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        {mode === "signup" && <div><label className="label">Invite code (if required)</label><input className="input" value={form.inviteCode} onChange={(e) => setForm({ ...form, inviteCode: e.target.value })} /></div>}
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <div className="text-center text-sm text-ink-400">
          {mode === "login" ? <>No account? <Link className="text-brand-600" to="/signup">Sign up</Link></> : <>Have an account? <Link className="text-brand-600" to="/login">Sign in</Link></>}
        </div>
      </form>
    </div>
  );
}
