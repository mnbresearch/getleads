import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Logo } from "../components/Logo";

/**
 * Shown for any address the app does not know.
 *
 * Unknown paths used to redirect silently: signed out they went to the sign-in page, signed
 * in they went to the overview. Either way a mistyped or stale link looked like the app had
 * ignored the click, and a signed-out visitor was asked for a password to see a page that
 * never existed. Saying "not found" plainly, with a way forward, is both more honest and
 * more useful. Routes that genuinely need an account still redirect to sign-in.
 *
 * `inApp` is true when it renders inside the signed-in shell, which already draws the logo
 * and navigation, so only the message is drawn.
 */
export function NotFoundPage({ inApp = false }: { inApp?: boolean }) {
  const loc = useLocation();
  useEffect(() => {
    const prev = document.title;
    document.title = "Page not found - Scout";
    return () => {
      document.title = prev;
    };
  }, []);

  const body = (
    <div className="mx-auto max-w-lg py-16 text-center" data-testid="not-found">
      <div className="text-sm font-semibold uppercase tracking-wide text-brand-600">404</div>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink-50 sm:text-3xl">This page does not exist</h1>
      <p className="mt-3 break-words text-sm text-ink-400">
        Nothing lives at <code className="rounded bg-black/[0.05] px-1.5 py-0.5 text-ink-200">{loc.pathname}</code>. The link may be
        mistyped, or the page may have moved.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {inApp ? (
          <>
            <Link to="/" className="btn-primary">Go to the overview</Link>
            <Link to="/leads" className="btn-secondary">Open leads</Link>
          </>
        ) : (
          <>
            <Link to="/" className="btn-primary">Go to the home page</Link>
            <Link to="/login" className="btn-secondary">Sign in</Link>
          </>
        )}
      </div>
    </div>
  );

  if (inApp) return body;
  return (
    <div className="min-h-screen px-4 sm:px-6">
      <header className="mx-auto flex max-w-6xl items-center py-4">
        <Link to="/" aria-label="Scout home">
          <Logo size={28} textClassName="text-lg" />
        </Link>
      </header>
      <main>{body}</main>
    </div>
  );
}
