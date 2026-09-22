import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth, API_URL } from "../lib/api";
import { Logo, BRAND_NAME, BRAND_TAGLINE } from "../components/Logo";

/** Google's four-colour mark, drawn inline so the button needs no external request. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const [form, setForm] = useState({ email: "", password: "", name: "", orgName: "", inviteCode: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  // The Google button only appears when the server actually has OAuth credentials. A button
  // that leads to "not configured" is worse than no button.
  useEffect(() => {
    apiFetch<{ enabled: boolean }>("GET", "/v1/auth/google/status")
      .then((r) => setGoogleEnabled(r.enabled))
      .catch(() => setGoogleEnabled(false));
  }, []);

  // The OAuth callback redirects here with ?error=... when something went wrong, so the
  // person sees the reason on the form they started from rather than a dead-end page.
  useEffect(() => {
    const e = params.get("error");
    if (e) setErr(e);
  }, [params]);
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

        {googleEnabled && (
          <>
            <div className="flex items-center gap-3 py-1 text-xs text-ink-400">
              <span className="h-px flex-1 bg-black/10" />
              or
              <span className="h-px flex-1 bg-black/10" />
            </div>
            {/* A plain link, not fetch: OAuth is a full-page browser redirect by design. */}
            <a className="btn-secondary w-full justify-center gap-2" href={`${API_URL}/v1/auth/google/start?next=${encodeURIComponent("/")}`}>
              <GoogleMark />
              Continue with Google
            </a>
          </>
        )}
        <div className="text-center text-sm text-ink-400">
          {mode === "login" ? <>No account? <Link className="text-brand-600" to="/signup">Sign up</Link></> : <>Have an account? <Link className="text-brand-600" to="/login">Sign in</Link></>}
        </div>
      </form>
    </div>
  );
}
