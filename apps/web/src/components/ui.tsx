import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function Page({ title, actions, children, subtitle }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
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
    <div className="card p-4">
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
      <div className={`card w-full ${wide ? "max-w-3xl" : "max-w-lg"} p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
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
      <div className="text-base font-medium">{title}</div>
      {hint && <div className="max-w-md text-sm text-ink-400">{hint}</div>}
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

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const Toast = msg ? (
    // role/aria-live so the app's primary feedback channel is not invisible to a screen
    // reader. "assertive" for errors because a failed send or a failed save must interrupt.
    <div
      role={msg.kind === "err" ? "alert" : "status"}
      aria-live={msg.kind === "err" ? "assertive" : "polite"}
      className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-sm shadow-lg ${msg.kind === "ok" ? "bg-black text-white" : "bg-red-600 text-white"}`}
    >
      {msg.text}
    </div>
  ) : null;
  return { toast: (text: string, kind: "ok" | "err" = "ok") => setMsg({ text, kind }), Toast };
}

export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  return (
    <div className="input flex flex-wrap items-center gap-1 py-1">
      {value.map((v) => (
        <span key={v} className="badge bg-brand-50 text-brand-700">
          {v}
          <button className="ml-1 text-brand-600 hover:text-brand-600" onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
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
