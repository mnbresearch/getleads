import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { adminAuth, adminFetch } from "../lib/adminApi";

export function AdminLoginPage() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await adminFetch<{ token: string }>("POST", "/v1/admin/login", form);
      adminAuth.set(r.token);
      navigate("/admin");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 max-w-sm p-6">
      <div className="mb-2 flex items-center justify-center">
        <Logo size={30} textClassName="text-xl" />
      </div>
      <p className="mb-6 text-center text-sm text-ink-400">Admin dashboard</p>
      <form onSubmit={submit} className="card space-y-3 p-6">
        <h1 className="text-lg font-semibold text-ink-50">Sign in</h1>
        <div><label className="label">Admin email</label><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label">Password</label><input className="input" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : "Sign in"}</button>
      </form>
    </div>
  );
}
