import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../lib/api";
import { Logo } from "../components/Logo";

/**
 * Where the Google sign-in lands.
 *
 * The API redirects here with the session token in the URL *fragment* rather than the query
 * string. A fragment is never sent to a server, so the token cannot end up in an access log,
 * a proxy log, or a Referer header on the next outbound link. The trade is that only the
 * browser can read it, which is exactly what this page is for.
 *
 * First thing after reading it: rewrite the address bar. Otherwise the token sits in history
 * and in the shared-screen risk of a visible URL.
 */
export function GoogleCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // React 18 runs effects twice in development; the token is consumed once.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = fragment.get("token");
    const next = fragment.get("next") ?? "/";

    // Strip the token from the URL before doing anything else with it.
    window.history.replaceState({}, "", "/auth/google");

    if (!token) {
      setError("No sign-in token was returned. Please try again.");
      return;
    }
    auth.set(token);
    // Only ever a path on this app; an absolute URL here would be an open redirect.
    navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
  }, [navigate]);

  return (
    <div className="mx-auto mt-24 max-w-md p-6 text-center">
      <div className="mb-4 flex items-center justify-center">
        <Logo size={30} textClassName="text-xl" />
      </div>
      {error ? (
        <div className="card p-6">
          <p className="text-sm text-red-600">{error}</p>
          <button className="btn-primary mt-4 w-full justify-center" onClick={() => navigate("/login", { replace: true })}>
            Back to sign in
          </button>
        </div>
      ) : (
        <p className="text-sm text-ink-400">Signing you in…</p>
      )}
    </div>
  );
}
