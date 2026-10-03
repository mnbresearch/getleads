import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { adminAuth, adminFetch, adminSessionExpiredNotice, useAdminToken } from "../lib/adminApi";
import { expectShape } from "../lib/api";

export function AdminLoginPage() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const token = useAdminToken();

  useEffect(() => {
    // Why the admin is looking at a sign-in form mid-task. Only set here, never cleared:
    // StrictMode runs this twice and the second read is already empty.
    const n = adminSessionExpiredNotice();
    if (n) setNotice(n);
  }, []);

  // Already signed in: the form has nothing to offer. (A token the server no longer accepts
  // is dropped by the dashboard's own session check, which lands back here with the notice.)
  if (token) return <Navigate to="/admin" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // A 200 with no token in it is not a sign-in. It used to do nothing at all: no error,
      // no navigation, the button simply came back.
      const r = expectShape(await adminFetch<{ token: string }>("POST", "/v1/admin/login", form), (x) => typeof x.token === "string" && x.token.length > 0);
      adminAuth.set(r.token);
      navigate("/admin", { replace: true });
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
        <div><label className="label" htmlFor="admin-email">Admin email</label><input id="admin-email" className="input" autoComplete="email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label" htmlFor="admin-password">Password</label><input id="admin-password" className="input" autoComplete="current-password" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        {notice && !err && <div className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800" role="status">{notice}</div>}
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : "Sign in"}</button>
      </form>
    </div>
  );
}
