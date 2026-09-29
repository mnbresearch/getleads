import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { CLIENT_COLORS, type TargetProgress } from "../lib/clients";
import { Modal } from "./ui";

export function ClientDot({ color, size = 10 }: { color: string | null; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color ?? "#a8987f" }} aria-hidden />;
}

/**
 * Delivery against the monthly target, with where it should be by today.
 *
 * The tick is the point. 30% delivered reads very differently on the 5th and the 28th, and a
 * bare percentage makes both look the same.
 */
export function TargetBar({ t, compact }: { t: TargetProgress | null; compact?: boolean }) {
  if (!t) return <div className="text-xs text-ink-500">No monthly target set</div>;
  const pct = Math.min(100, Math.round(t.share * 100));
  const expected = Math.min(100, Math.round((t.expectedByNow / Math.max(1, t.target)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="tabular-nums text-ink-200">
          <span className="font-semibold text-ink-50">{t.delivered.toLocaleString()}</span> / {t.target.toLocaleString()} this month
        </span>
        <span className={t.onTrack ? "text-emerald-700" : "font-medium text-amber-700"}>{t.onTrack ? "On track" : `Behind · ${t.expectedByNow} expected by today`}</span>
      </div>
      <div className={`relative mt-1.5 ${compact ? "h-1.5" : "h-2"} rounded-full bg-black/[0.06]`}>
        <div className={`h-full rounded-full ${t.onTrack ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
        <div className="absolute -top-1 h-[calc(100%+8px)] w-0.5 rounded bg-ink-300" style={{ left: `${expected}%` }} title={`Expected by today: ${t.expectedByNow}`} />
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls = status === "active" ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : status === "paused" ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200" : "bg-black/[0.05] text-ink-400";
  return <span className={`badge capitalize ${cls}`}>{status}</span>;
}

export interface ClientFormValue {
  name: string;
  domain: string;
  industry: string;
  monthlyLeadTarget: string;
  icpId: string;
  color: string;
  notes: string;
}

export const emptyClientForm = (): ClientFormValue => ({ name: "", domain: "", industry: "", monthlyLeadTarget: "", icpId: "", color: CLIENT_COLORS[0], notes: "" });

export function toClientPayload(f: ClientFormValue) {
  return {
    name: f.name.trim(),
    domain: f.domain.trim() || null,
    industry: f.industry.trim() || null,
    monthlyLeadTarget: f.monthlyLeadTarget ? Number(f.monthlyLeadTarget) : null,
    icpId: f.icpId || null,
    color: f.color || null,
    notes: f.notes.trim() || null,
  };
}

/** Create or edit a client. The ICP is what routing uses, so it is asked for up front. */
export function ClientFormModal({
  open,
  onClose,
  initial,
  title,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  initial: ClientFormValue;
  title: string;
  submitLabel: string;
  onSubmit: (v: ClientFormValue) => Promise<void>;
}) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    setF(initial);
    setErr(null);
    apiFetch<{ icps: { id: string; name: string }[] }>("GET", "/v1/icps").then((r) => setIcps(r.icps)).catch(() => setIcps([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof ClientFormValue, v: string) => setF((p) => ({ ...p, [k]: v }));

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!f.name.trim()) return setErr("Give the client a name.");
          setBusy(true);
          setErr(null);
          try {
            await onSubmit(f);
          } catch (x) {
            setErr((x as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <label className="label" htmlFor="cf-name">Client name</label>
          <input id="cf-name" className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Acme Payments" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="cf-domain">Website</label>
            <input id="cf-domain" className="input" value={f.domain} onChange={(e) => set("domain", e.target.value)} placeholder="acme.com" />
          </div>
          <div>
            <label className="label" htmlFor="cf-industry">Industry</label>
            <input id="cf-industry" className="input" value={f.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Fintech" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="cf-target">Leads promised per month</label>
            <input id="cf-target" className="input" type="number" min={0} value={f.monthlyLeadTarget} onChange={(e) => set("monthlyLeadTarget", e.target.value)} placeholder="200" />
          </div>
          <div>
            <label className="label" htmlFor="cf-icp">Ideal customer profile</label>
            <select id="cf-icp" className="input" value={f.icpId} onChange={(e) => set("icpId", e.target.value)}>
              <option value="">None yet</option>
              {icps.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-ink-400">The ICP is what lets Scout route unassigned leads to this client. Without one, leads only arrive here when you assign them or search for this client.</p>
        <div>
          <span className="label">Colour</span>
          <div className="flex gap-2">
            {CLIENT_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => set("color", c)}
                className={`h-7 w-7 rounded-full ring-offset-2 transition ${f.color === c ? "ring-2 ring-ink-300" : "hover:scale-110"}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                aria-pressed={f.color === c}
              />
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="cf-notes">Notes</label>
          <textarea id="cf-notes" className="input h-16" value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Point of contact, what they sell, anything the team should know" />
        </div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{err}</div>}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      </form>
    </Modal>
  );
}
