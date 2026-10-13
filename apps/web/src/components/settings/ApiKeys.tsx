import { useEffect, useState } from "react";
import { API_URL, apiFetch, expectLists, fmtDate, fmtDay } from "../../lib/api";
import { EXTERNAL_REL } from "../../lib/safeHref";
import { LoadError, useToast } from "../ui";

type Scope = "full" | "read";
type Status = "active" | "expiring" | "expired" | "revoked";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  scope?: string | null;
  scopes?: string[] | null;
  // Newer servers only; an older one sends none of these and every key reads as before.
  expiresAt?: string | null;
  rotatedFromId?: string | null;
  status?: Status | null;
}

/** Choices offered for a new key's lifetime. "" is never. */
const EXPIRY_CHOICES: [string, string][] = [["", "Never"], ["30", "30 days"], ["90", "90 days"], ["180", "180 days"], ["365", "1 year"]];
/** How long the old key keeps working after a rotation, in minutes. */
const OVERLAP_CHOICES: [number, string][] = [[0, "Immediately"], [60, "After 1 hour"], [1440, "After 24 hours"]];

/** Copy to clipboard, saying so when the browser refuses rather than claiming success. */
function copyText(text: string, toast: (m: string, k?: "ok" | "err") => void) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied")).catch(() => toast("Could not copy - select the text and copy it manually", "err"));
}

/** What a listed key may do. Only an explicit "read" is read-only; anything else is the full key it always was. */
function keyScope(k: { scope?: string | null; scopes?: string[] | null }): Scope {
  if (k.scope === "read") return "read";
  if (k.scope) return "full";
  return Array.isArray(k.scopes) && k.scopes.length > 0 && !k.scopes.includes("*") && k.scopes.every((x) => x === "read") ? "read" : "full";
}

/** The key's standing. The server says; for an older server it is worked out from the dates. */
function keyStatus(k: ApiKeyRow): Status {
  if (k.status === "active" || k.status === "expiring" || k.status === "expired" || k.status === "revoked") return k.status;
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function StatusBadge({ k }: { k: ApiKeyRow }) {
  const s = keyStatus(k);
  if (s === "expiring") return <span className="badge whitespace-nowrap bg-amber-50 text-amber-800" title="Expires within 7 days - rotate it before then">Expiring soon</span>;
  if (s === "expired") return <span className="badge whitespace-nowrap bg-red-50 text-red-700">Expired</span>;
  if (s === "revoked") return <span className="badge whitespace-nowrap bg-black/[0.05] text-ink-400">Revoked</span>;
  return <span className="badge whitespace-nowrap bg-emerald-50 text-emerald-800">Active</span>;
}

function ScopeBadge({ k }: { k: ApiKeyRow }) {
  return keyScope(k) === "read" ? (
    <span className="badge whitespace-nowrap bg-sky-50 text-sky-800" title="Can look things up; cannot create, change, send or delete">Read-only</span>
  ) : (
    <span className="badge whitespace-nowrap bg-black/[0.05] text-ink-300" title="Can do everything through the API">Full access</span>
  );
}

/** "Expires on ..." for a key with an expiry, "No expiry" otherwise. */
function expiryText(k: ApiKeyRow) {
  if (!k.expiresAt) return "No expiry";
  return `${keyStatus(k) === "expired" ? "Expired" : "Expires"} ${fmtDay(k.expiresAt)}`;
}

/** A key shown once, right after it was made, with a copy button. */
type Fresh = { key: string; scope: Scope | null; label: string; note?: string };

/**
 * The API keys tab: create (with access and an optional expiry), rotate (with a choice of how
 * long the old key keeps working) and revoke. Owners and admins only; the caller checks.
 */
export function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [newName, setNewName] = useState("Agent");
  const [newScope, setNewScope] = useState<Scope>("full");
  const [newExpiry, setNewExpiry] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const { toast, Toast } = useToast();
  // A second click created a second key and only ever displayed the second one. The first
  // is shown once by the server and then unrecoverable, so a double-click silently minted a
  // live credential nobody would ever see again. The same holds for rotation.
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<ApiKeyRow | null>(null);
  const [overlap, setOverlap] = useState(0);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = () =>
    apiFetch<{ apiKeys: ApiKeyRow[] }>("GET", "/v1/auth/api-keys")
      .then((r) => { setKeys(expectLists(r, "apiKeys").apiKeys); setLoadErr(null); setLoaded(true); })
      .catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async (k: ApiKeyRow) => {
    if (!confirm(`Revoke the API key "${k.name}" (${k.prefix}…)?\n\nAnything using it - agents, scripts, the MCP server - stops working immediately. This cannot be undone.`)) return;
    try {
      await apiFetch("DELETE", `/v1/auth/api-keys/${k.id}`);
      toast("Key revoked");
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (creating || !name) return;
    setCreating(true);
    try {
      // Only the choices the person made are sent: "full" and "never" are what the server
      // assumes, so an older server still gets a request it understands for the defaults.
      const body: Record<string, unknown> = { name };
      if (newScope === "read") body.scope = "read";
      if (newExpiry) body.expiresInDays = Number(newExpiry);
      const r = await apiFetch<{ key: string; scope?: unknown; expiresAt?: string | null }>("POST", "/v1/auth/api-keys", body);
      // Asked for read-only and the server did not say it made one: it is an older server
      // that ignored the choice, and the key in hand can do everything. Say so, loudly.
      const made = r.scope === "read" || r.scope === "full" ? r.scope : newScope === "read" ? null : "full";
      setFresh({ key: r.key, scope: made, label: "Copy now - shown once:", note: r.expiresAt ? `Expires ${fmtDay(r.expiresAt)}.` : undefined });
      if (made === null) toast("This key was created, but the server could not confirm it is read-only. Treat it as a full-access key, or revoke it.", "err");
      else if (newExpiry && !r.expiresAt) toast("This key was created without an expiry: the server did not accept one. Revoke it when you no longer need it.", "err");
      setFormOpen(false);
      setNewName("Agent");
      setNewScope("full");
      setNewExpiry("");
      load();
    } catch (x) { toast((x as Error).message, "err"); } finally { setCreating(false); }
  };

  const rotate = async () => {
    if (!rotating || rotateBusy) return;
    setRotateBusy(true);
    try {
      const r = await apiFetch<{ key: string; scope?: unknown; expiresAt?: string | null; previous?: { worksUntil?: string | null } }>("POST", `/v1/auth/api-keys/${rotating.id}/rotate`, { overlapMinutes: overlap });
      const scope = r.scope === "read" || r.scope === "full" ? r.scope : keyScope(rotating);
      const until = r.previous?.worksUntil;
      setFresh({
        key: r.key,
        scope,
        label: `New key for "${rotating.name}" - copy now, shown once:`,
        note: `${until ? `The old key (${rotating.prefix}…) keeps working until ${fmtDate(until)}.` : `The old key (${rotating.prefix}…) has stopped working.`}${r.expiresAt ? ` The new key expires ${fmtDay(r.expiresAt)}.` : ""}`,
      });
      toast("Key rotated");
      setRotating(null);
      setOverlap(0);
      load();
    } catch (x) { toast((x as Error).message, "err"); } finally { setRotateBusy(false); }
  };

  // A key whose replacement is still live cannot be rotated again (the API answers 409
  // api_key_already_rotated); offer only Revoke, which is what ends the overlap early.
  const replaced = (k: ApiKeyRow) => keys.some((r) => r.rotatedFromId === k.id && keyStatus(r) !== "revoked" && keyStatus(r) !== "expired");
  const canRotate = (k: ApiKeyRow) => { const s = keyStatus(k); return (s === "active" || s === "expiring") && !replaced(k); };
  const actions = (k: ApiKeyRow, cls: string) =>
    canRotate(k) ? (
      <span className="inline-flex gap-3">
        <button className={`${cls} text-brand-600`} onClick={() => { setRotating(k); setOverlap(0); }}>Rotate</button>
        <button className={`${cls} text-red-600`} onClick={() => revoke(k)}>Revoke</button>
      </span>
    ) : replaced(k) && keyStatus(k) !== "revoked" ? (
      <span className="inline-flex items-center gap-3">
        <span className="text-xs text-ink-500">Replaced</span>
        <button className={`${cls} text-red-600`} onClick={() => revoke(k)}>Revoke</button>
      </span>
    ) : keyStatus(k) === "expired" ? (
      <button className={`${cls} text-red-600`} onClick={() => revoke(k)}>Revoke</button>
    ) : null;

  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div className="font-medium">API keys</div>{!formOpen && <button className="btn-primary" disabled={creating} onClick={() => setFormOpen(true)}>Create key</button>}</div>
        {formOpen && (
          <form onSubmit={create} className="mb-3 space-y-3 rounded-lg border border-black/10 bg-black/[0.02] p-3" data-testid="apikey-form">
            <div>
              <label className="label" htmlFor="apikey-name">Key name</label>
              <input id="apikey-name" className="input max-w-sm" autoFocus maxLength={60} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="What will use this key?" />
            </div>
            <fieldset>
              <legend className="label">Access</legend>
              <div className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-5">
                <label className="flex min-h-[40px] items-center gap-2"><input type="radio" name="apikey-scope" checked={newScope === "full"} onChange={() => setNewScope("full")} /> Full access</label>
                <label className="flex min-h-[40px] items-center gap-2"><input type="radio" name="apikey-scope" checked={newScope === "read"} onChange={() => setNewScope("read")} /> Read-only</label>
              </div>
              <p className="text-xs text-ink-400">{newScope === "read" ? "Read-only: the key can look things up (leads, campaigns, analytics) but cannot create, change, send or delete anything." : "Full access: the key can do everything you can through the API - find and change leads, run campaigns, send email."}</p>
            </fieldset>
            <div>
              <label className="label" htmlFor="apikey-expiry">Expires</label>
              <select id="apikey-expiry" className="input max-w-[12rem]" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} data-testid="apikey-expiry">
                {EXPIRY_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <p className="mt-1 text-xs text-ink-400">A key that expires stops working on its own. Rotate it before then to switch to a new one without a gap.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={creating || !newName.trim()}>{creating ? "Creating…" : "Create key"}</button>
              <button type="button" className="btn-secondary" disabled={creating} onClick={() => setFormOpen(false)}>Cancel</button>
            </div>
          </form>
        )}
        {rotating && (
          <div className="mb-3 space-y-3 rounded-lg border border-black/10 bg-black/[0.02] p-3" data-testid="apikey-rotate" role="dialog" aria-labelledby="apikey-rotate-title">
            <div id="apikey-rotate-title" className="text-sm font-medium">Rotate "{rotating.name}" ({rotating.prefix}…)</div>
            <p className="text-xs text-ink-400">A new key with the same name and access replaces this one. Update whatever uses the old key, then let it stop.</p>
            <fieldset>
              <legend className="label">Old key stops working</legend>
              <div className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-5">
                {OVERLAP_CHOICES.map(([m, l]) => (
                  <label key={m} className="flex min-h-[40px] items-center gap-2"><input type="radio" name="apikey-overlap" checked={overlap === m} onChange={() => setOverlap(m)} /> {l}</label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={rotateBusy} onClick={rotate}>{rotateBusy ? "Rotating…" : "Rotate key"}</button>
              <button type="button" className="btn-secondary" disabled={rotateBusy} onClick={() => setRotating(null)}>Cancel</button>
            </div>
          </div>
        )}
        {fresh && (
          <div className="mb-3 rounded-lg bg-black p-3 text-xs text-emerald-400" data-testid="apikey-fresh">
            <div className="mb-1 flex items-center justify-between gap-2 text-white/85">
              <span>{fresh.scope === "read" ? `Read-only key. ${fresh.label}` : fresh.scope === "full" ? `Full-access key. ${fresh.label}` : fresh.label}</span>
              <span className="flex shrink-0 gap-1">
                <button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => copyText(fresh.key, toast)}>Copy</button>
                <button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => setFresh(null)} aria-label="Hide key">Done</button>
              </span>
            </div>
            <code className="break-all">{fresh.key}</code>
            {fresh.note && <div className="mt-1 text-white/70">{fresh.note}</div>}
          </div>
        )}
        {loadErr && !loaded && <LoadError message={loadErr} onRetry={load} />}
        {/* On a phone the table pushed the actions off the side of the screen; there each key is
            a card with everything, the actions included, in view. */}
        {loaded && keys.length > 0 && (
          <ul className="divide-y divide-black/5 sm:hidden" data-testid="apikey-cards">
            {keys.map((k) => (
              <li key={k.id} className={`flex items-start justify-between gap-3 py-3 ${keyStatus(k) === "revoked" || keyStatus(k) === "expired" ? "opacity-60" : ""}`}>
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-ink-50 [overflow-wrap:anywhere]">{k.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge k={k} />
                    <ScopeBadge k={k} />
                    <span className="font-mono text-xs text-ink-300">{k.prefix}…</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-400">{expiryText(k)} · last used {k.lastUsedAt ? fmtDate(k.lastUsedAt) : "never"} · created {fmtDate(k.createdAt)}</div>
                </div>
                <div className="shrink-0">{actions(k, "inline-flex min-h-[40px] items-center px-1 text-sm")}</div>
              </li>
            ))}
          </ul>
        )}
        {loaded && (
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead><tr><th className="th">Name</th><th className="th">Status</th><th className="th">Access</th><th className="th">Prefix</th><th className="th">Expires</th><th className="th">Last used</th><th className="th">Created</th><th className="th"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {keys.map((k) => (
                  <tr key={k.id} className={keyStatus(k) === "revoked" || keyStatus(k) === "expired" ? "opacity-60" : ""}>
                    <td className="td">{k.name}</td>
                    <td className="td"><StatusBadge k={k} /></td>
                    <td className="td"><ScopeBadge k={k} /></td>
                    <td className="td font-mono text-xs">{k.prefix}…</td>
                    <td className="td text-xs">{k.expiresAt ? fmtDay(k.expiresAt) : "Never"}</td>
                    <td className="td text-xs">{fmtDate(k.lastUsedAt)}</td>
                    <td className="td text-xs">{fmtDate(k.createdAt)}</td>
                    <td className="td whitespace-nowrap text-right">{actions(k, "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loaded && keys.length === 0 && <div className="py-3 text-sm text-ink-400">No API keys yet.</div>}
      </div>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Use with AI agents</div>
        <p className="text-ink-300">REST: send <code>x-api-key</code>. OpenAPI spec at <a className="text-brand-600" href={`${API_URL}/openapi.json`} target="_blank" rel={EXTERNAL_REL}>{API_URL}/openapi.json</a>, interactive docs at <a className="text-brand-600" href={`${API_URL}/docs`} target="_blank" rel={EXTERNAL_REL}>/docs</a>.</p>
        {/* This used to print an `npx` command for a package name on the public registry that is
            not ours - anyone could publish under it, and the command would have run their code
            with the customer's API key in its environment. */}
        <p className="mt-2 text-ink-300" data-testid="mcp-note">Scout has an MCP server for AI assistants (Claude Desktop, Cursor). It is not published to a public package registry. <a className="text-brand-600 hover:underline" href="mailto:contact@mnbresearch.com?subject=Scout%20MCP%20server">Ask support</a> for the package, or use the REST API and OpenAPI document with your API key.</p>
      </div>
    </div>
  );
}
