import { useEffect, useRef, useState } from "react";
import { ProspexError, apiFetch, fmtDay } from "../lib/api";
import { saveText } from "../lib/download";
import { useGoogleEnabled } from "../lib/googleSignIn";
import { rememberMe, useMe } from "../lib/me";
import { digitsOnly } from "./TwoFactorStep";

const NOT_AVAILABLE = "Two-factor sign-in is not available yet. Try again later.";

/** A failed call, in words. An older server (404) is "not available yet", not "HTTP 404". */
function words(e: unknown, wrongCode?: string): string {
  const pe = e as ProspexError;
  if (pe?.status === 404 || pe?.status === 405) return NOT_AVAILABLE;
  if (wrongCode && pe?.code === "invalid_2fa_code") return wrongCode;
  return pe?.message || "Something went wrong. Try again.";
}

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP": a 32-character key is typed in fours. */
const grouped = (secret: string) => secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/** The ten recovery codes as a file someone can keep. */
export function recoveryCodesFile(codes: string[], email: string): string {
  return [
    "Scout recovery codes",
    email ? `Account: ${email}` : null,
    `Created: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Each code signs you in once if you cannot use your authenticator app.",
    "Keep them somewhere safe and private. Making new codes cancels these.",
    "",
    ...codes,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Draw the QR code in the browser, from the bundled library - the key in it must never go
 * to a third-party image service, and the page's security policy would refuse one anyway.
 * The library is loaded only when someone actually sets two-factor up.
 */
async function qrDataUrl(text: string): Promise<string> {
  const mod = (await import("qrcode")) as unknown as { toDataURL?: typeof import("qrcode").toDataURL; default?: { toDataURL: typeof import("qrcode").toDataURL } };
  const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
  if (!toDataURL) throw new Error("QR library did not load");
  return toDataURL(text, { margin: 2, width: 232, errorCorrectionLevel: "M" });
}

type View =
  | { at: "idle" }
  | { at: "password" }
  | { at: "scan"; secret: string; otpauthUrl: string }
  | { at: "codes"; codes: string[]; fresh: "enabled" | "regenerated" }
  | { at: "regen" }
  | { at: "off" };

/**
 * Settings > "Two-factor sign-in": turn it on (QR code, then a code to prove the app
 * works, then the recovery codes - once), make new recovery codes, turn it off.
 *
 * Not rendered at all when the server does not say whether it is on: that is an older
 * server with no such feature, and a "Set up" that can only fail is worse than no button.
 */
export function TwoFactorCard() {
  const { me } = useMe();
  const googleEnabled = useGoogleEnabled();
  const [view, setView] = useState<View>({ at: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<{ url?: string; failed?: boolean }>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const user = me?.user;
  const enabled = user?.twoFactorEnabled;
  const showingCodes = view.at === "codes";

  useEffect(() => { field.current?.focus(); }, [view.at]);

  // The codes are shown once. Closing the tab with them unsaved cannot be undone from here,
  // so the browser asks first.
  useEffect(() => {
    if (!showingCodes || saved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [showingCodes, saved]);

  const otpauthUrl = view.at === "scan" ? view.otpauthUrl : null;
  useEffect(() => {
    if (!otpauthUrl) return;
    let live = true;
    setQr({});
    qrDataUrl(otpauthUrl).then(
      (url) => { if (live) setQr({ url }); },
      () => { if (live) setQr({ failed: true }); },
    );
    return () => { live = false; };
  }, [otpauthUrl]);

  if (!me || !user || enabled === undefined) return null;

  const go = (v: View) => {
    setView(v);
    setErr(null);
    setCode("");
    setPassword("");
    setCopied(null);
  };
  const copy = (text: string, what: string) => {
    const fail = () => setCopied(`Could not copy - select the ${what} and copy it by hand.`);
    if (!navigator.clipboard) return fail();
    navigator.clipboard.writeText(text).then(() => setCopied(`Copied the ${what}.`), fail);
  };
  const setEnabled = (on: boolean) => rememberMe({ ...me, user: { ...user, twoFactorEnabled: on, twoFactorEnabledAt: on ? new Date().toISOString() : null } });

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await apiFetch<{ secret?: unknown; otpauthUrl?: unknown }>("POST", "/v1/auth/2fa/setup", password ? { currentPassword: password } : {}, undefined, { reconfirm: true });
      if (typeof r?.secret !== "string" || !r.secret || typeof r.otpauthUrl !== "string" || !r.otpauthUrl) throw new Error("The server did not return a setup key. Try again.");
      go({ at: "scan", secret: r.secret, otpauthUrl: r.otpauthUrl });
    } catch (x) {
      setErr(words(x));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ recoveryCodes?: unknown }>("POST", "/v1/auth/2fa/enable", { code }, undefined, { reconfirm: true });
      const codes = Array.isArray(r?.recoveryCodes) ? r.recoveryCodes.filter((c): c is string => typeof c === "string" && !!c) : [];
      setEnabled(true);
      setSaved(false);
      go({ at: "codes", codes, fresh: "enabled" });
    } catch (x) {
      setErr(words(x, "That code is not right. Enter the code your app is showing now - and check that your phone's clock is set automatically, because the codes depend on the time."));
      setCode("");
      setTimeout(() => field.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ recoveryCodes?: unknown }>("POST", "/v1/auth/2fa/recovery-codes", { code: code.trim() }, undefined, { reconfirm: true });
      const codes = Array.isArray(r?.recoveryCodes) ? r.recoveryCodes.filter((c): c is string => typeof c === "string" && !!c) : [];
      if (codes.length === 0) throw new Error("The server did not return any codes. Try again.");
      setSaved(false);
      go({ at: "codes", codes, fresh: "regenerated" });
    } catch (x) {
      setErr(words(x, "That code is not right. Enter the code your app is showing now, or a recovery code you have not used."));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("POST", "/v1/auth/2fa/disable", { code: code.trim() }, undefined, { reconfirm: true });
      setEnabled(false);
      go({ at: "idle" });
      setDone("Two-factor sign-in is off. Signing in now needs only your password.");
    } catch (x) {
      setErr(words(x, "That code is not right. Enter the code your app is showing now, or a recovery code you have not used."));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const errBox = err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert">{err}</div>;
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="font-medium">Two-factor sign-in</div>
      <span className={`badge ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-black/[0.05] text-ink-300"}`} data-testid="tf-state">{enabled ? "On" : "Off"}</span>
    </div>
  );

  // ── Recovery codes, once ──
  if (view.at === "codes") {
    const text = view.codes.join("\n");
    return (
      <div className="card max-w-xl space-y-3 p-5" data-testid="tf-card">
        {header}
        <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700" role="status">
          {view.fresh === "enabled" ? "Two-factor sign-in is on. From now on, signing in with your password also asks for a code from your app." : "New recovery codes made. The old ones no longer work."}
        </div>
        {view.codes.length > 0 ? (
          <>
            <div className="text-sm font-medium">Save your recovery codes</div>
            <p className="text-sm text-ink-300">Each code signs you in once if you lose your phone or cannot use your app. They are shown only this one time - keep them somewhere safe that is not this phone, such as a password manager or a printout.</p>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-lg bg-black p-3 font-mono text-sm text-emerald-400 min-[380px]:grid-cols-2" data-testid="tf-codes">
              {view.codes.map((c) => <li key={c} className="[overflow-wrap:anywhere]">{c}</li>)}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary" onClick={() => copy(text, "codes")}>Copy</button>
              <button type="button" className="btn-secondary" onClick={() => { saveText(recoveryCodesFile(view.codes, user.email), "scout-recovery-codes.txt"); setCopied("Downloaded scout-recovery-codes.txt."); }}>Download</button>
              {copied && <span className="text-xs text-ink-400" role="status">{copied}</span>}
            </div>
            <label className="flex min-h-[40px] items-center gap-2 text-sm text-ink-200">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I saved these codes
            </label>
          </>
        ) : (
          <p className="text-sm text-amber-800" role="alert">The server did not return recovery codes. Use "New recovery codes" below to make a set now - without them, losing your phone means losing access.</p>
        )}
        <button type="button" className="btn-primary" disabled={view.codes.length > 0 && !saved} onClick={() => go({ at: "idle" })}>Done</button>
      </div>
    );
  }

  // ── Scan and confirm ──
  if (view.at === "scan") {
    return (
      <form onSubmit={enable} className="card max-w-xl space-y-3 p-5" data-testid="tf-card">
        {header}
        <div className="text-sm font-medium">1. Add Scout to your authenticator app</div>
        <p className="text-sm text-ink-300">Open your authenticator app, choose to add an account, and scan this code.</p>
        <div className="flex min-h-[232px] items-center justify-center rounded-lg border border-black/10 bg-white p-2">
          {qr.url ? (
            <img src={qr.url} width={232} height={232} alt="QR code that adds Scout to your authenticator app" data-testid="tf-qr" className="h-auto max-w-full" />
          ) : qr.failed ? (
            <span className="p-4 text-center text-sm text-ink-400" role="status">The QR code could not be drawn here. Type the key below into your app instead.</span>
          ) : (
            <span className="text-sm text-ink-400" role="status">Drawing the code…</span>
          )}
        </div>
        <div>
          <div className="label">Cannot scan it? Type this key into the app instead</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-sm [overflow-wrap:anywhere]" data-testid="tf-secret">{grouped(view.secret)}</code>
            <button type="button" className="btn-secondary" onClick={() => copy(view.secret, "key")}>Copy</button>
          </div>
          {copied && <div className="mt-1 text-xs text-ink-400" role="status">{copied}</div>}
          <p className="mt-1 text-xs text-ink-400">Account type: time-based, 6 digits.</p>
        </div>
        <div className="pt-1 text-sm font-medium">2. Enter the 6-digit code the app shows</div>
        <div>
          <label className="label" htmlFor="tf-enable-code">Code from your authenticator app</label>
          <input id="tf-enable-code" ref={field} className="input max-w-[12rem] font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} placeholder="000000" value={code} disabled={busy} onChange={(e) => setCode(digitsOnly(e.target.value))} />
        </div>
        {errBox}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Turn on"}</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => go({ at: "idle" })}>Cancel</button>
        </div>
      </form>
    );
  }

  // ── Off ──
  if (!enabled) {
    return (
      <form onSubmit={start} className="card max-w-xl space-y-3 p-5" data-testid="tf-card">
        {header}
        {done && <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700" role="status">{done}</div>}
        <p className="text-sm text-ink-300">
          Adds a second step when you sign in with your password: a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy and others). Someone who learns your password still cannot get in without your phone.
          {googleEnabled ? " Signing in with Google is not affected - Google runs its own second step." : ""}
        </p>
        {view.at === "password" && user.hasPassword !== false && (
          <div>
            <label className="label" htmlFor="tf-password">{user.hasPassword ? "Your current password" : "Your current password (leave blank if you only sign in with Google)"}</label>
            <input id="tf-password" ref={field} className="input" type="password" autoComplete="current-password" required={user.hasPassword === true} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        {errBox}
        {view.at === "password" && user.hasPassword !== false ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || (user.hasPassword === true && !password)}>{busy ? "Checking…" : "Continue"}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => go({ at: "idle" })}>Cancel</button>
          </div>
        ) : (
          // An account with no password (Google only) has nothing to re-enter; setup starts at once.
          <button type="button" className="btn-primary" disabled={busy} onClick={() => { setDone(null); if (user.hasPassword === false) void start(); else go({ at: "password" }); }}>{busy ? "Starting…" : "Set up"}</button>
        )}
      </form>
    );
  }

  // ── On ──
  const since = user.twoFactorEnabledAt ? fmtDay(user.twoFactorEnabledAt) : null;
  const asking = view.at === "regen" || view.at === "off";
  return (
    <form onSubmit={view.at === "off" ? turnOff : regenerate} className="card max-w-xl space-y-3 p-5" data-testid="tf-card">
      {header}
      <p className="text-sm text-ink-300">
        {since && since !== "-" ? <>On since <b className="font-semibold text-ink-100">{since}</b>. </> : null}
        Signing in with your password also asks for a code from your authenticator app.
      </p>
      {asking && (
        <>
          <p className="text-sm text-ink-200">
            {view.at === "off"
              ? "Turning it off means your password alone is enough to sign in. Enter a code to confirm."
              : "New recovery codes replace the old ones, which stop working at once. Enter a code to confirm."}
          </p>
          <div>
            <label className="label" htmlFor="tf-confirm-code">Code from your authenticator app, or a recovery code</label>
            <input id="tf-confirm-code" ref={field} className="input max-w-xs font-mono" autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} />
          </div>
        </>
      )}
      {errBox}
      {asking ? (
        <div className="flex flex-wrap gap-2">
          <button className={view.at === "off" ? "btn-danger" : "btn-primary"} disabled={busy || !code.trim()}>{busy ? "Checking…" : view.at === "off" ? "Turn off two-factor" : "Make new codes"}</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => go({ at: "idle" })}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => { setDone(null); go({ at: "regen" }); }}>New recovery codes</button>
          <button type="button" className="btn-danger" onClick={() => { setDone(null); go({ at: "off" }); }}>Turn off</button>
        </div>
      )}
    </form>
  );
}
