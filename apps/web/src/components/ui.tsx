import { useEffect, useState, type ReactNode } from "react";

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
    <div className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-sm shadow-lg ${msg.kind === "ok" ? "bg-black text-white" : "bg-red-600 text-white"}`}>{msg.text}</div>
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
