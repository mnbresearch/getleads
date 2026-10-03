import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, auth, consumeReturnPath } from "../lib/api";
import { takeGoogleVerifier } from "../lib/googleSignIn";
import { Logo } from "../components/Logo";

/**
 * Where the Google sign-in lands.
 *
 * The API redirects here with a one-time `code` in the URL *fragment*. A fragment is never
 * sent to a server, so the code cannot end up in an access log, a proxy log, or a Referer
 * header. This page trades the code, together with the verifier this tab stored before it
 * left for Google, for the session (POST /v1/auth/google/exchange).
 *
 * What this page must never do again is accept a session token from the URL. It used to
 * store whatever was in `#token=`, so a link to /auth/google#token=<someone else's token>
 * signed whoever opened it into that other person's workspace without a word. A token in
 * the fragment is now ignored and reported as a failed sign-in; the only thing that signs
 * anyone in is a code that the API will exchange for *this* browser's verifier.
 *
 * First thing after reading the fragment: rewrite the address bar, so the code does not sit
 * in history or on a shared screen. (It is single-use and short-lived as well.)
 */
const NOT_STARTED_HERE =
  "This Google sign-in was not started from this browser tab, or it was already used. Start again from the sign-in page.";

export function GoogleCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // React 18 runs effects twice in development; the code and the verifier are single-use.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const code = fragment.get("code");
    const next = fragment.get("next") ?? "/";

    // Strip the fragment from the URL before doing anything else with it.
    window.history.replaceState({}, "", "/auth/google");

    // Read (and remove) the verifier whether or not there is a code: it is for one attempt.
    const verifier = takeGoogleVerifier();

    if (!code) {
      // Includes the old `#token=` shape, deliberately: see the note above.
      setError(fragment.has("token") ? NOT_STARTED_HERE : "Google did not complete the sign-in. Please try again.");
      return;
    }
    if (!verifier) {
      setError(NOT_STARTED_HERE);
      return;
    }

    apiFetch<{ token?: string }>("POST", "/v1/auth/google/exchange", { code, verifier }, undefined, { anonymous: true })
      .then((r) => {
        if (!r || typeof r.token !== "string" || !r.token) {
          setError("Google sign-in did not return a session. Please try again.");
          return;
        }
        auth.set(r.token);
        // Only ever a path on this app; an absolute URL here would be an open redirect.
        const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
        // The login button always asks for "/"; if a session expired mid-page, go back there.
        navigate(safeNext === "/" ? consumeReturnPath("/") : safeNext, { replace: true });
      })
      .catch((e) => {
        const status = (e as { status?: number }).status ?? 0;
        // 0 = never reached the server, 429/5xx = the server's own words are the useful ones.
        // 404 = an API that does not have the exchange route yet (mid-deploy).
        // Anything else is a code the server would not honour for this browser.
        if (status === 0 || status === 429 || status >= 500) setError((e as Error).message);
        else if (status === 404) setError("Google sign-in is being updated and is not available for a moment. Try again shortly, or sign in with your email and password.");
        else setError(NOT_STARTED_HERE);
      });
  }, [navigate]);

  return (
    <div className="mx-auto mt-24 max-w-md p-6 text-center">
      <div className="mb-4 flex items-center justify-center">
        <Logo size={30} textClassName="text-xl" />
      </div>
      {error ? (
        <div className="card p-6" role="alert">
          <h1 className="text-base font-semibold text-ink-50">Sign-in was not completed</h1>
          <p className="mt-2 text-sm text-red-600 [overflow-wrap:anywhere]">{error}</p>
          <Link className="btn-primary mt-4 w-full justify-center" to="/login" replace>
            Back to sign in
          </Link>
        </div>
      ) : (
        <p className="text-sm text-ink-400" role="status">Signing you in…</p>
      )}
    </div>
  );
}
