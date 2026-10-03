import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, auth, consumeReturnPath, sessionExpiredNotice, unreadableAnswer } from "../lib/api";
import { googleStartUrl } from "../lib/googleSignIn";
import { Logo, BRAND_NAME, BRAND_TAGLINE } from "../components/Logo";
import { TwoFactorStep, twoFactorChallenge } from "../components/TwoFactorStep";

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
  // Read once, at mount: someone already signed in who lands on /login or /signup goes
  // to the app. Not reactive on purpose - signing in on this page sets the token too, and
  // that path has its own destination (the API-key screen, or the saved return path).
  const [signedInAtMount] = useState(() => !!auth.token);
  const [notice, setNotice] = useState<string | null>(null);
  const loc = useLocation();
  useEffect(() => {
    // The API client flags a rejected token; say so instead of a blank login form.
    // Only set, never cleared here: StrictMode runs this twice and the second read is empty.
    const n = sessionExpiredNotice();
    if (n) setNotice(n);
    // Or a page that sent the person here with something to say (a password reset that
    // still needs the two-factor step and could not finish it).
    const handed = (loc.state as { notice?: unknown } | null)?.notice;
    if (!n && typeof handed === "string" && handed) setNotice(handed);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Set once the password has been accepted for an account with two-factor on: the server
  // has not signed anyone in yet, and holds this sign-in open for a few minutes.
  const [challenge, setChallenge] = useState<string | null>(null);

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
  // Google sign-in leaves the page, so it is a navigation rather than a fetch - but not a
  // plain link any more: the browser first makes the one-time verifier that the callback
  // page has to present (see lib/googleSignIn.ts for why).
  const [googleBusy, setGoogleBusy] = useState(false);
  const startGoogle = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setErr(null);
    try {
      window.location.assign(await googleStartUrl({ next: "/" }));
      // No reset on success: the page is on its way out, and re-enabling the button would
      // invite a second click that replaces the verifier mid-flight.
    } catch (e) {
      setErr((e as Error).message);
      setGoogleBusy(false);
    }
  };
  // Pressing Back from Google's page restores this one from the browser's page cache with
  // its state intact - including a disabled "Opening Google…" button that would never
  // re-enable. `pageshow` with persisted=true is that restore.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setGoogleBusy(false); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ token: string; apiKey?: string }>("POST", `/v1/auth/${mode}`, mode === "login" ? { email: form.email, password: form.password } : { ...form, inviteCode: form.inviteCode || undefined, orgName: form.orgName || undefined, name: form.name || undefined });
      // Password accepted, but this account also needs the code from an authenticator app.
      const pending = mode === "login" ? twoFactorChallenge(r) : null;
      if (pending) {
        setNotice(null);
        setChallenge(pending);
        return;
      }
      // A 200 with no session in it is not a sign-in; storing "undefined" as the token used
      // to look like one for a moment and then bounce back here with no explanation.
      if (!r || typeof r.token !== "string" || !r.token) throw unreadableAnswer();
      if (r.apiKey) setApiKey(r.apiKey);
      auth.set(r.token);
      // Back to where the session ran out (or a deep link that bounced here), else home.
      if (!r.apiKey) navigate(consumeReturnPath("/"), { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (signedInAtMount && !apiKey) return <Navigate to="/" replace />;
  if (apiKey)
    return (
      <div className="mx-auto mt-24 max-w-md p-6">
        <div className="card p-6">
          <h1 className="text-xl font-semibold">Welcome to {BRAND_NAME}</h1>
          <p className="mt-2 text-sm text-ink-300">Here is your API key for agents and integrations. It is shown only once; you can create more in Settings.</p>
          <code className="mt-3 block break-all rounded-lg bg-black p-3 text-xs text-emerald-600">{apiKey}</code>
          <button className="btn-primary mt-4 w-full justify-center" onClick={() => navigate(consumeReturnPath("/"))}>Go to dashboard</button>
        </div>
      </div>
    );
  if (challenge && mode === "login")
    return (
      <div className="mx-auto mt-16 max-w-md p-4 sm:p-6">
        <div className="mb-6 flex items-center justify-center">
          <Logo size={34} textClassName="text-2xl" />
        </div>
        <TwoFactorStep
          challenge={challenge}
          intro={form.email ? `Signing in as ${form.email}.` : undefined}
          onSignedIn={(token) => {
            auth.set(token);
            // The same destination as a sign-in without the second step.
            navigate(consumeReturnPath("/"), { replace: true });
          }}
          onExpired={(text) => {
            setChallenge(null);
            setForm((f) => ({ ...f, password: "" }));
            setErr(null);
            setNotice(text);
          }}
          onBack={() => {
            setChallenge(null);
            setForm((f) => ({ ...f, password: "" }));
            setErr(null);
          }}
        />
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
        {notice && mode === "login" && <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800" role="status">{notice}</div>}
        {mode === "signup" && (
          <>
            <div><label className="label" htmlFor="auth-name">Your name</label><input id="auth-name" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label" htmlFor="auth-org">Company / workspace</label><input id="auth-org" className="input" autoComplete="organization" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} /></div>
          </>
        )}
        {/* htmlFor/id so a screen reader announces the field rather than an unlabelled box.
            Without it this form - the entry point to the whole product - was unusable. */}
        <div><label className="label" htmlFor="auth-email">Email</label><input id="auth-email" className="input" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label" htmlFor="auth-password">Password</label><input id="auth-password" className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        {mode === "signup" && <div><label className="label" htmlFor="auth-invite">Invite code (if required)</label><input id="auth-invite" className="input" value={form.inviteCode} onChange={(e) => setForm({ ...form, inviteCode: e.target.value })} /></div>}
        {mode === "login" && (
          <div className="-mt-1 text-right text-xs">
            <Link className="text-brand-600 hover:underline" to="/forgot-password">Forgot password?</Link>
          </div>
        )}
        {/* The server's own message (e.g. a suspended workspace) is shown as-is. */}
        {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</button>
        {mode === "signup" && (
          <p className="text-center text-xs text-ink-400">
            By signing up you agree to the <Link className="text-brand-600 hover:underline" to="/terms">Terms of Service</Link> and <Link className="text-brand-600 hover:underline" to="/privacy">Privacy Policy</Link>.
          </p>
        )}

        {googleEnabled && (
          <>
            <div className="flex items-center gap-3 py-1 text-xs text-ink-400">
              <span className="h-px flex-1 bg-black/10" />
              or
              <span className="h-px flex-1 bg-black/10" />
            </div>
            {/* type="button": this sits inside the form and must not submit it. */}
            <button type="button" className="btn-secondary w-full justify-center gap-2" onClick={startGoogle} disabled={googleBusy}>
              <GoogleMark />
              {googleBusy ? "Opening Google…" : "Continue with Google"}
            </button>
          </>
        )}
        <div className="text-center text-sm text-ink-400">
          {mode === "login" ? <>No account? <Link className="text-brand-600" to="/signup">Sign up</Link></> : <>Have an account? <Link className="text-brand-600" to="/login">Sign in</Link></>}
        </div>
      </form>
    </div>
  );
}
