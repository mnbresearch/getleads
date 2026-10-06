import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function Page({ title, actions, children, subtitle }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        {/* min-w-0 + anywhere-wrapping: titles are often user data (a client or campaign
            name), and one long unbroken name must wrap, not widen the page past the phone. */}
        <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card min-w-0 p-4 [overflow-wrap:anywhere]">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

export function EmailStatusBadge({ status }: { status?: string | null }) {
  const map: Record<string, string> = {
    valid: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    catch_all: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    risky: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    invalid: "bg-red-50 text-red-700 ring-1 ring-red-200",
    unknown: "bg-black/[0.05] text-ink-300",
  };
  const s = status ?? "unknown";
  return <span className={`badge ${map[s] ?? map.unknown}`}>{s.replace("_", " ")}</span>;
}

export function ScoreBar({ score }: { score?: number | null }) {
  const s = Math.max(0, Math.min(100, Math.round(score ?? 0)));
  const color = s >= 70 ? "bg-emerald-500" : s >= 40 ? "bg-amber-500" : "bg-black/10";
  return (
    <div className="flex items-center gap-2" title={`${s}/100`}>
      <div className="h-1.5 w-16 rounded-full bg-black/[0.05]">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${s}%` }} />
      </div>
      <span className="text-xs tabular-nums text-ink-300">{s}</span>
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16" onClick={onClose}>
      <div className={`card w-full min-w-0 ${wide ? "max-w-3xl" : "max-w-lg"} p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{title}</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-100" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 p-12 text-center">
      <div className="max-w-full text-base font-medium [overflow-wrap:anywhere]">{title}</div>
      {hint && <div className="max-w-md text-sm text-ink-400 [overflow-wrap:anywhere]">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * What a page shows when it could not load.
 *
 * Every list in this app used to render its "you have no data yet" empty state when the
 * request failed, and several detail pages rendered a spinner that never resolved. Both
 * tell the user something false: the first says their account is empty, the second says
 * the page is still working. Neither offers a way out.
 *
 * Same distinction the backend makes everywhere else - a failure to look is not the same
 * as having looked and found nothing - carried through to the screen.
 */
export function LoadError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 p-12 text-center" role="alert">
      <div className="text-base font-medium text-ink-50">This didn&apos;t load</div>
      <div className="max-w-md text-sm text-ink-400">
        {message || "Something went wrong fetching this. It is not that there is nothing here - we could not check."}
      </div>
      {onRetry && (
        <button className="btn-secondary mt-1" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * A destructive action, behind a confirmation that names what is about to go.
 *
 * Kept in one place because every delete in this app needs the same three things and it is
 * easy to ship one that has only two: the name of the thing, a note of what else it takes
 * with it, and an error the user actually sees when the request fails. A silent failure on
 * a delete is worse than a loud one - the row is still on screen, so it reads as done.
 */
export function DeleteButton({
  what,
  consequence,
  onDelete,
  onError,
  label = "Delete",
  className = "",
}: {
  what: string;
  consequence?: string;
  onDelete: () => Promise<unknown>;
  onError?: (message: string) => void;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`text-red-600 disabled:opacity-50 ${className}`}
      disabled={busy}
      onClick={async () => {
        const lines = [`Delete ${what}?`, consequence, "This cannot be undone."].filter(Boolean);
        if (!confirm(lines.join("\n\n"))) return;
        setBusy(true);
        try {
          await onDelete();
        } catch (e) {
          onError?.((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-brand-600" />
      {label}
    </div>
  );
}

/**
 * How long a toast stays up: 3.5 s, plus a second for every ~60 characters, to 12 s at most.
 *
 * Every toast used to get 3.5 s. That is right for "Saved" and far too short for the ones
 * that matter most - "Enrolled 12 leads (3 skipped: their email is not a single valid
 * address - fix it on the lead; 2 skipped: they belong to another client)" was gone before
 * the second clause.
 */
export function toastDuration(text: string): number {
  const len = typeof text === "string" ? text.length : 0;
  return Math.min(12_000, 3_500 + Math.floor(len / 60) * 1_000);
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  // Reading it stops the clock: the pointer resting on a toast (or keyboard focus inside it)
  // holds it open, and the full time starts again when the pointer leaves.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!msg || held) return;
    const t = setTimeout(() => setMsg(null), toastDuration(msg.text));
    return () => clearTimeout(t);
  }, [msg, held]);
  const Toast = msg ? (
    // role/aria-live so the app's primary feedback channel is not invisible to a screen
    // reader. "assertive" for errors because a failed send or a failed save must interrupt.
    <div
      role={msg.kind === "err" ? "alert" : "status"}
      aria-live={msg.kind === "err" ? "assertive" : "polite"}
      data-toast={msg.kind}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`fixed bottom-4 right-4 z-50 flex max-w-[min(32rem,calc(100vw-2rem))] items-start gap-3 rounded-lg px-4 py-2 text-sm shadow-lg ${msg.kind === "ok" ? "bg-black text-white" : "bg-red-600 text-white"}`}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
      {/* Dismissible by hand as well: an error is worth keeping until it has been read, and
          worth being able to clear once it has. */}
      <button type="button" className="-mr-1 shrink-0 rounded px-1 leading-5 text-white/80 hover:text-white" aria-label="Dismiss" onClick={() => { setHeld(false); setMsg(null); }}>✕</button>
    </div>
  ) : null;
  const toast = (text: string, kind: "ok" | "err" = "ok") => {
    setHeld(false);
    // Always a string on screen: a caller handing over an Error (or nothing) must not crash
    // the page that was trying to report a problem.
    const shown = typeof text === "string" ? text : String((text as { message?: unknown } | null | undefined)?.message ?? text ?? "");
    setMsg({ text: shown, kind });
  };
  return { toast, Toast };
}

/**
 * `inputId` / `ariaLabel` name the text box for a `<label htmlFor>` or a screen reader, and
 * `max` stops the list growing past what the server accepts. All optional: without them this
 * behaves exactly as it always has.
 */
export function TagInput({ value, onChange, placeholder, inputId, ariaLabel, max }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; inputId?: string; ariaLabel?: string; max?: number }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const next = [...new Set([...value, ...parts])];
      onChange(max && max > 0 ? next.slice(0, max) : next);
    }
    setDraft("");
  };
  return (
    <div className="input flex flex-wrap items-center gap-1 py-1">
      {value.map((v) => (
        <span key={v} className="badge bg-brand-50 text-brand-700">
          {v}
          <button type="button" className="ml-1 text-brand-600 hover:text-brand-600" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
        id={inputId}
        aria-label={ariaLabel}
        className="min-w-[8rem] flex-1 border-0 bg-transparent p-1 text-sm focus:outline-none"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

/**
 * Show a message handed over by the page we came from.
 *
 * A page that navigates away right after an action (delete, create) unmounts with its own
 * toast still queued, so "Deleted" was never seen. The sender passes
 * `navigate(to, { state: { flash } })`; the receiver calls this once. The state is cleared
 * so a reload or Back doesn't repeat it.
 */
export function useFlash(toast: (m: string, k?: "ok" | "err") => void) {
  const loc = useLocation();
  const navigate = useNavigate();
  const flash = (loc.state as { flash?: unknown } | null)?.flash;
  useEffect(() => {
    if (typeof flash !== "string" || !flash) return;
    toast(flash);
    navigate(loc.pathname + loc.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
}
