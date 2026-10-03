import { useEffect, useRef, useState } from "react";
import { ProspexError, apiFetch, expectShape } from "../lib/api";
import { noteRecoveryCodeUsed } from "./AccountBanners";

/** What POST /v1/auth/login (or a password reset) answers for an account with two-factor on. */
export function twoFactorChallenge(r: unknown): string | null {
  const o = r as { twoFactorRequired?: unknown; challenge?: unknown } | null;
  return o && typeof o === "object" && o.twoFactorRequired === true && typeof o.challenge === "string" && o.challenge ? o.challenge : null;
}

/** The server keeps a sign-in open this long between the password and the code. */
const CHALLENGE_MS = 5 * 60 * 1000;

export const CHALLENGE_EXPIRED_NOTICE = "That sign-in took too long, so for your safety it has to start again. Enter your password once more.";

/** A six-digit code as typed or pasted: "123 456" and "123-456" are the same six digits. */
export const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, 6);

/**
 * Whether a failed second step means "start again" rather than "wrong code".
 *
 * The server's word for it is not fixed by the contract, so anything that names the
 * challenge counts (invalid_challenge, challenge_expired, a validator complaint about the
 * `challenge` field), as does 410 Gone. And one case the server cannot be relied on to tell
 * apart at all: a code refused after the five minutes are up is treated as an expired
 * sign-in, because retyping codes into a sign-in that no longer exists never ends.
 */
function challengeGone(e: unknown, startedAt: number): boolean {
  if (!(e instanceof ProspexError)) return false;
  if (e.status === 410) return true;
  if (e.code === "too_many_attempts" || e.status === 429) return false;
  if (/challenge|expired/i.test(e.code)) return true;
  const issues = (e.details as { error?: { issues?: { path?: unknown }[] } } | null | undefined)?.error?.issues;
  if (Array.isArray(issues) && issues.some((i) => (Array.isArray(i?.path) ? i.path[0] : i?.path) === "challenge")) return true;
  return (e.status === 400 || e.status === 401) && Date.now() - startedAt > CHALLENGE_MS;
}

/**
 * The second step of signing in: the code from an authenticator app, or a recovery code.
 *
 * Used by the login form and by the reset-password page (a reset on an account with
 * two-factor on changes the password but does not sign in by itself).
 */
export function TwoFactorStep({
  challenge,
  onSignedIn,
  onExpired,
  onBack,
  intro,
  backLabel = "Back",
}: {
  challenge: string;
  /** The server accepted the code; `token` is the session, exactly as a normal sign-in returns it. */
  onSignedIn: (token: string) => void;
  /** The sign-in has to start again from the password. */
  onExpired: (notice: string) => void;
  onBack: () => void;
  intro?: string;
  backLabel?: string;
}) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  // The auto-submit at six digits and the button can both fire; one request at a time.
  const sending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [recovery]);

  const send = async (value: string) => {
    const v = value.trim();
    if (!v || sending.current) return;
    sending.current = true;
    setBusy(true);
    setErr(null);
    try {
      // anonymous: this establishes a session, it does not use one - a refused code must not
      // be read as "your session expired".
      const r = expectShape(await apiFetch<{ token: string; usedRecoveryCode?: unknown; recoveryCodesLeft?: unknown }>("POST", "/v1/auth/2fa/verify", { challenge, code: v }, undefined, { anonymous: true }), (x) => typeof x.token === "string" && x.token.length > 0);
      // A recovery code is spent by this; the app says so (and how many are left) once inside.
      if (r.usedRecoveryCode === true) noteRecoveryCodeUsed(r.recoveryCodesLeft);
      onSignedIn(r.token);
    } catch (e) {
      if (challengeGone(e, startedAt.current)) return onExpired(CHALLENGE_EXPIRED_NOTICE);
      const pe = e as ProspexError;
      if (pe.code === "invalid_2fa_code") {
        setErr(recovery ? "That recovery code is not right, or it has already been used. Each recovery code works once." : "That code is not right. Codes change every 30 seconds - enter the one showing in your authenticator app now.");
      } else if (pe.status === 404) {
        setErr("Two-factor sign-in is not available right now. Try again in a minute.");
      } else {
        // Too many attempts (with how long to wait), a rate limit, a network failure: the
        // server's or the client's own sentence already says what happened.
        setErr(pe.message || "Something went wrong. Try again.");
      }
      setCode("");
      setBusy(false);
      sending.current = false;
      // After the state settles, so the cleared field is the one that takes focus.
      setTimeout(() => input.current?.focus(), 0);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(code);
  };

  return (
    <form onSubmit={submit} className="card space-y-3 p-6" data-testid="two-factor-step">
      <h1 className="text-lg font-semibold">Two-factor sign-in</h1>
      {intro && <p className="text-sm text-ink-300">{intro}</p>}
      {recovery ? (
        <div>
          <label className="label" htmlFor="tf-recovery">Recovery code</label>
          <input
            id="tf-recovery"
            ref={input}
            className="input font-mono"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="xxxx-xxxx-xxxx"
            maxLength={64}
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-400">One of the recovery codes you saved when you turned two-factor on. Each one works once.</p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="tf-code">Enter the 6-digit code from your authenticator app</label>
          <input
            id="tf-code"
            ref={input}
            className="input text-center font-mono text-lg tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            value={code}
            disabled={busy}
            onChange={(e) => {
              const d = digitsOnly(e.target.value);
              setCode(d);
              // Six digits is the whole answer; nobody should have to find a button.
              if (d.length === 6) void send(d);
            }}
          />
        </div>
      )}
      {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>}
      <button className="btn-primary w-full justify-center" disabled={busy || (recovery ? !code.trim() : code.length !== 6)}>{busy ? "Checking…" : "Sign in"}</button>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <button type="button" className="inline-flex min-h-[40px] items-center text-ink-400 hover:text-ink-100" onClick={onBack}>← {backLabel}</button>
        <button
          type="button"
          className="inline-flex min-h-[40px] items-center text-brand-600 hover:underline"
          onClick={() => { setRecovery((r) => !r); setCode(""); setErr(null); }}
        >
          {recovery ? "Use the code from your app instead" : "Use a recovery code instead"}
        </button>
      </div>
    </form>
  );
}
