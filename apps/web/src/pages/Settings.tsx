import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { API_URL, apiFetch, auth, fmtDate } from "../lib/api";
import { limitLabel, metricLabel } from "../lib/metrics";
import { EXTERNAL_REL } from "../lib/safeHref";
import { DeleteButton, LoadError, Page, Spinner, useToast } from "../components/ui";

type Role = "owner" | "admin" | "member";
interface Me { user: { id: string; email: string; role: Role; hasPassword?: boolean } | null; org: { name: string; settings: Record<string, string> } }

/**
 * Who is looking. Members get 403 from API keys, org settings, invites, webhooks and
 * integrations, so those controls are shown only to owners and admins - a button that can
 * only ever fail is worse than none. While unknown (loading/failed) controls stay visible
 * and the server remains the authority.
 */
let meCache: Me | null = null;
// The cache is "who is signed in", so it cannot outlive the session it was read for. It used
// to: sign out as an owner, sign in as a member in the same tab, and Settings briefly showed
// the owner's controls from the previous account.
auth.subscribe(() => { meCache = null; });
function useMe() {
  const [me, setMe] = useState<Me | null>(meCache);
  // `settled`: the role question has been answered one way or the other - the account is
  // known (cached or just loaded) or the lookup failed. Lets a caller wait for the answer
  // before acting on "unknown means allowed", instead of acting and then finding out.
  const [settled, setSettled] = useState<boolean>(!!meCache);
  useEffect(() => {
    apiFetch<Me>("GET", "/v1/auth/me").then((r) => { meCache = r; setMe(r); }).catch(() => {}).finally(() => setSettled(true));
  }, []);
  const role = me?.user?.role;
  return { me, role, settled, canManage: role === undefined || role === "owner" || role === "admin", isOwner: role === undefined || role === "owner" };
}

/** Shown in place of a manage-only panel when the viewer is a member. */
function MembersNote({ what }: { what: string }) {
  return <div className="card p-5 text-sm text-ink-400">Only workspace owners and admins can manage {what}. Ask one of them if you need a change here.</div>;
}

/** Copy to clipboard, saying so when the browser refuses rather than claiming success. */
function copyText(text: string, toast: (m: string, k?: "ok" | "err") => void) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied")).catch(() => toast("Could not copy - select the text and copy it manually", "err"));
}

export function SettingsPage() {
  const { canManage, settled } = useMe();
  // The security log is owner/admin only on the server; members do not get a tab that can
  // only ever answer "forbidden". It appears once the role is known, so it does not flash
  // up for a member and vanish.
  const tabs = [["", "Workspace"], ["team", "Team"], ["api-keys", "API keys"], ["webhooks", "Webhooks"], ["integrations", "Integrations"], ["billing", "Plan & usage"], ...(settled && canManage ? [["security", "Security log"]] : [])];
  return (
    <Page title="Settings">
      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-black/10 px-4 sm:mx-0 sm:px-0">{tabs.map(([p, l]) => <NavLink key={p} to={`/settings/${p}`} end className={({ isActive }) => `shrink-0 px-3 py-2 text-sm ${isActive ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400"}`}>{l}</NavLink>)}</div>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/api-keys" element={<ApiKeys />} />
        <Route path="/team" element={<Team />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/security" element={<SecurityLog />} />
      </Routes>
    </Page>
  );
}

function Workspace() {
  const [org, setOrg] = useState<{ name: string; settings: Record<string, string> } | null>(null);
  const [f, setF] = useState({ name: "", senderName: "", senderCompany: "", valueProp: "" });
  const { toast, Toast } = useToast();
  // `return null` on failure rendered a completely blank tab: no spinner, no message, no
  // way to retry. Three of the six Settings tabs did this.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const loadOrg = useCallback(() => {
    setLoadErr(null);
    apiFetch<{ org: typeof org }>("GET", "/v1/auth/me")
      .then((r) => { setOrg(r.org); setF({ name: r.org!.name, senderName: r.org!.settings.senderName ?? "", senderCompany: r.org!.settings.senderCompany ?? r.org!.name, valueProp: r.org!.settings.valueProp ?? "" }); })
      .catch((e) => setLoadErr((e as Error).message));
  }, []);
  useEffect(() => { loadOrg(); }, [loadOrg]);
  const { canManage } = useMe();
  if (loadErr) return <LoadError message={loadErr} onRetry={loadOrg} />;
  if (!org) return <div className="card p-5"><Spinner label="Loading…" /></div>;
  return (
    <div className="space-y-4">
    <div className="card max-w-xl space-y-3 p-5">
      {Toast}
      {!canManage && <p className="text-xs text-ink-400">Only owners and admins can change workspace settings.</p>}
      <div><label className="label">Workspace name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="pt-2 text-sm font-medium">Defaults for AI-drafted emails</div>
      <div><label className="label">Your name</label><input className="input" value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
      <div><label className="label">Company</label><input className="input" value={f.senderCompany} onChange={(e) => setF({ ...f, senderCompany: e.target.value })} /></div>
      <div><label className="label">Value proposition</label><textarea className="input h-20" value={f.valueProp} onChange={(e) => setF({ ...f, valueProp: e.target.value })} /></div>
      <p className="text-xs text-ink-400">Campaigns use these when a campaign has no sender details of its own.</p>
      {canManage && <button className="btn-primary" onClick={() => apiFetch("PATCH", "/v1/auth/org", { name: f.name, settings: { senderName: f.senderName, senderCompany: f.senderCompany, valueProp: f.valueProp } }).then(() => toast("Saved")).catch((e) => toast(e.message, "err"))}>Save</button>}
    </div>
    <ChangePassword />
    <Sessions />
    </div>
  );
}

function ChangePassword() {
  const { me } = useMe();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // hasPassword comes from /v1/auth/me. Unknown (older server, or not loaded): show the
  // field as optional and say why it might be blank.
  const hasPassword = me?.user?.hasPassword;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setMsg({ ok: false, text: "Use at least 8 characters." });
    if (pw !== pw2) return setMsg({ ok: false, text: "The new passwords don't match." });
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ token?: unknown } | null>("POST", "/v1/auth/password/change", { currentPassword: cur || undefined, newPassword: pw });
      // Changing the password signs every other session out on the server, and this tab's
      // old token goes with them. The response carries the replacement; storing it is what
      // keeps the person who just changed their password signed in. (An older server sends
      // no token and retires nothing, so there is nothing to swap.)
      const fresh = r && typeof r.token === "string" && r.token ? r.token : null;
      if (fresh) auth.set(fresh);
      setCur(""); setPw(""); setPw2("");
      const done = hasPassword === false ? "Password set. You can now also sign in with your email and this password." : "Password changed.";
      setMsg({ ok: true, text: fresh ? `${done} Every other device and browser has been signed out.` : done });
      // auth.set() above cleared the cached account; rebuild it from what this component holds.
      if (me?.user) meCache = { ...me, user: { ...me.user, hasPassword: true } };
    } catch (e2) {
      setMsg({ ok: false, text: (e2 as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card max-w-xl space-y-3 p-5">
      <div className="font-medium">{hasPassword === false ? "Set a password" : "Change password"}</div>
      {hasPassword === false && <p className="text-xs text-ink-400">You sign in with Google. Setting a password lets you sign in with your email as well.</p>}
      {hasPassword !== false && (
        <div>
          <label className="label" htmlFor="pw-current">{hasPassword ? "Current password" : "Current password (leave blank if you signed up with Google)"}</label>
          <input id="pw-current" className="input" type="password" autoComplete="current-password" required={hasPassword === true} value={cur} onChange={(e) => setCur(e.target.value)} />
        </div>
      )}
      <div><label className="label" htmlFor="pw-new">New password</label><input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} required value={pw} onChange={(e) => setPw(e.target.value)} /></div>
      <div><label className="label" htmlFor="pw-new2">Confirm new password</label><input id="pw-new2" className="input" type="password" autoComplete="new-password" minLength={8} required value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
      {msg && <div className={`rounded-lg p-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
      <button className="btn-primary" disabled={busy || pw.length < 8 || pw !== pw2}>{busy ? "Saving…" : hasPassword === false ? "Set password" : "Change password"}</button>
    </form>
  );
}

/**
 * "Sign out of all devices": for a lost laptop, a shared computer, or a session token that
 * may have been seen by someone else. The server retires every session token issued to this
 * account so far - including this tab's - so the tab signs out too and the next sign-in is a
 * fresh one. API keys are separate credentials and are managed on their own tab.
 */
function Sessions() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const signOutEverywhere = async () => {
    if (busy) return;
    if (!confirm("Sign out of all devices?\n\nEvery browser and device signed in to your account is signed out, including this one. You will need to sign in again. API keys keep working.")) return;
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("POST", "/v1/auth/logout-all");
    } catch (e) {
      // 401 means the session was already gone - apiFetch has cleared it and the app is on
      // its way to the login page. Anything else: the other devices are still signed in, so
      // say that rather than signing out locally and implying it worked.
      if ((e as { status?: number }).status !== 401) {
        setErr(`Could not sign out the other devices: ${(e as Error).message}`);
        setBusy(false);
      }
      return;
    }
    auth.set(null);
    navigate("/login", { replace: true });
  };
  return (
    <div className="card max-w-xl space-y-3 p-5">
      <div className="font-medium">Sessions</div>
      <p className="text-sm text-ink-300">Signed in somewhere you no longer trust - a lost phone, a shared computer? This signs your account out everywhere at once. Changing your password does the same for every device except this one.</p>
      {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">{err}</div>}
      <button type="button" className="btn-danger" disabled={busy} onClick={signOutEverywhere}>{busy ? "Signing out…" : "Sign out of all devices"}</button>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<{ id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  // A second click created a second key and only ever displayed the second one. The first
  // is shown once by the server and then unrecoverable, so a double-click silently minted a
  // live credential nobody would ever see again.
  const [creating, setCreating] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { canManage } = useMe();
  const load = () => apiFetch<{ apiKeys: typeof keys }>("GET", "/v1/auth/api-keys").then((r) => { setKeys(r.apiKeys); setLoadErr(null); setLoaded(true); }).catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { if (canManage) load(); }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const revoke = async (k: { id: string; name: string; prefix: string }) => {
    if (!confirm(`Revoke the API key "${k.name}" (${k.prefix}…)?\n\nAnything using it - agents, scripts, the MCP server - stops working immediately. This cannot be undone.`)) return;
    try {
      await apiFetch("DELETE", `/v1/auth/api-keys/${k.id}`);
      toast("Key revoked");
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };
  if (!canManage) return <MembersNote what="API keys" />;
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-2 flex items-center justify-between"><div className="font-medium">API keys</div><button className="btn-primary" disabled={creating} onClick={async () => { if (creating) return; const name = prompt("Key name", "Agent") ?? ""; if (!name) return; setCreating(true); try { const r = await apiFetch<{ key: string }>("POST", "/v1/auth/api-keys", { name }); setFresh(r.key); load(); } catch (e) { toast((e as Error).message, "err"); } finally { setCreating(false); } }}>{creating ? "Creating…" : "Create key"}</button></div>
        {fresh && <div className="mb-3 rounded-lg bg-black p-3 text-xs text-emerald-400"><div className="mb-1 flex items-center justify-between gap-2 text-white/85"><span>Copy now - shown once:</span><button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => copyText(fresh, toast)}>Copy</button></div><code className="break-all">{fresh}</code></div>}
        {loadErr && !loaded && <LoadError message={loadErr} onRetry={load} />}
        {loaded && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="th">Name</th><th className="th">Prefix</th><th className="th">Last used</th><th className="th">Created</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">{keys.map((k) => <tr key={k.id} className={k.revokedAt ? "opacity-50" : ""}><td className="td">{k.name}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td text-xs">{fmtDate(k.lastUsedAt)}</td><td className="td text-xs">{fmtDate(k.createdAt)}</td><td className="td text-right">{!k.revokedAt && <button className="text-red-600" onClick={() => revoke(k)}>Revoke</button>}</td></tr>)}</tbody></table></div>}
        {loaded && keys.length === 0 && <div className="py-3 text-sm text-ink-400">No API keys yet.</div>}
      </div>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Use with AI agents</div>
        <p className="text-ink-300">REST: send <code>x-api-key</code>. OpenAPI spec at <a className="text-brand-600" href={`${API_URL}/openapi.json`} target="_blank" rel={EXTERNAL_REL}>{API_URL}/openapi.json</a>, interactive docs at <a className="text-brand-600" href={`${API_URL}/docs`} target="_blank" rel={EXTERNAL_REL}>/docs</a>.</p>
        <p className="mt-2 text-ink-300">MCP (Claude Desktop, Claude Code, Cursor):</p>
        <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-800">{`{ "mcpServers": { "prospex": { "command": "npx", "args": ["-y", "@prospex/mcp"],
    "env": { "PROSPEX_API_KEY": "px_live_...", "PROSPEX_API_URL": "${API_URL}" } } } }`}</pre>
      </div>
    </div>
  );
}

/**
 * `secret` is present only on the answer to create and rotate. The list carries a preview
 * (`secretPreview`, the first few characters) and which signature scheme the hook uses.
 * `secretPrefix` / `secret` on a list row are what older servers sent; they are read only as
 * a fallback for the preview and never shown in full.
 */
type Hook = { id: string; url: string; events: string[]; secret?: string; secretPrefix?: string; secretPreview?: string | null; signatureVersion?: number; active: boolean; failures: number };

/** What to show for a hook's secret in the list: a few leading characters, never the secret. */
function secretPreviewOf(h: Hook): string | null {
  if (typeof h.secretPreview === "string" && h.secretPreview) return h.secretPreview;
  const legacy = h.secretPrefix ?? h.secret;
  return typeof legacy === "string" && legacy ? `${legacy.slice(0, 6)}...` : null;
}

/**
 * A signing secret, shown exactly once - after creating a webhook and after rotating one.
 * One component for both so the two moments cannot drift apart: the same warning, the same
 * Copy button, the same explicit dismissal.
 */
function SecretOnce({ fresh, onDone, toast }: { fresh: { url: string; secret: string; rotated?: boolean }; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  return (
    <div className="mt-3 rounded-lg bg-black p-3 text-xs text-emerald-600" role="status">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2 text-white/85">
        <span className="min-w-0 [overflow-wrap:anywhere]">{fresh.rotated ? "New signing secret" : "Signing secret"} for {fresh.url} - copy it now, it is not shown again{fresh.rotated ? ". The old secret no longer works; update your endpoint to verify with this one." : ":"}</span>
        <span className="flex shrink-0 gap-2">
          <button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => copyText(fresh.secret, toast)}>Copy</button>
          <button type="button" className="text-white/70 hover:text-white" onClick={onDone}>Done</button>
        </span>
      </div>
      <code className="break-all text-emerald-400">{fresh.secret}</code>
    </div>
  );
}

function Webhooks() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("*");
  const { toast, Toast } = useToast();
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The signing secret is returned in full only by the create and rotate calls; it is shown
  // here once, with a copy button. The list only ever has a short preview of it.
  const [freshSecret, setFreshSecret] = useState<{ url: string; secret: string; rotated?: boolean } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const { canManage } = useMe();
  const load = () => apiFetch<{ webhooks: Hook[] }>("GET", "/v1/webhooks").then((r) => { setHooks(r.webhooks); setLoadErr(null); setLoaded(true); }).catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { if (canManage) load(); }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    try {
      const r = await apiFetch<Hook & { webhook?: Hook; warning?: unknown }>("POST", "/v1/webhooks", { url, events: events.split(",").map((s) => s.trim()).filter(Boolean) });
      const secret = r.secret ?? r.webhook?.secret;
      if (secret) setFreshSecret({ url, secret });
      setUrl("");
      load();
      // The server may accept a hook and say why it will not fire; that outranks "added".
      if (typeof r.warning === "string" && r.warning) toast(r.warning, "err");
      else toast("Webhook added");
    } catch (e) { toast((e as Error).message, "err"); }
  };
  const rotate = async (h: Hook) => {
    if (rotating) return;
    const upgrade = h.signatureVersion === 1 ? "\n\nThis webhook also moves to the v2 signature (HMAC-SHA256): the header value becomes v2=<hex>, so your endpoint's verification code needs the change described under 'Verifying deliveries' on this page." : "";
    if (!confirm(`Rotate the signing secret for ${h.url}?\n\nThe current secret stops working immediately. Deliveries are signed with the new secret from then on, so your endpoint will reject them until you update it.${upgrade}`)) return;
    setRotating(h.id);
    try {
      const r = await apiFetch<{ secret?: unknown }>("POST", `/v1/webhooks/${h.id}/rotate-secret`);
      if (typeof r?.secret === "string" && r.secret) {
        setFreshSecret({ url: h.url, secret: r.secret, rotated: true });
        toast("Secret rotated - copy the new one now");
      } else {
        // Rotated, but nothing to show: saying "done" here would leave the customer with an
        // endpoint that rejects every delivery and no secret to fix it with.
        toast("The secret was rotated but the server did not return it. Rotate again to get a new one.", "err");
      }
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setRotating(null); }
  };
  const test = async (h: Hook) => {
    setTesting(h.id);
    try {
      const r = await apiFetch<{ queued?: boolean; ok?: boolean; delivered?: boolean; status?: number; error?: string; message?: string }>("POST", `/v1/webhooks/${h.id}/test`);
      // Newer servers deliver synchronously and report what the endpoint answered; older
      // ones only queue. Say whichever actually happened.
      if (r.ok === false || r.delivered === false) toast(`Test delivery failed${r.status ? ` (HTTP ${r.status})` : ""}${r.error || r.message ? `: ${r.error ?? r.message}` : ""}`, "err");
      else if (r.ok || r.delivered) toast(`Test delivered${r.status ? ` - your endpoint answered HTTP ${r.status}` : ""}`);
      else toast("Test event queued - check your endpoint in a few seconds");
    } catch (e) { toast((e as Error).message, "err"); } finally { setTesting(null); }
  };
  const remove = async (h: Hook) => {
    if (!confirm(`Delete the webhook to ${h.url}?\n\nEvents stop being sent to it immediately. This cannot be undone.`)) return;
    try {
      await apiFetch("DELETE", `/v1/webhooks/${h.id}`);
      toast("Webhook deleted");
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };
  if (!canManage) return <MembersNote what="webhooks" />;
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-3 font-medium">Webhooks</div>
        <p className="mb-3 text-sm text-ink-300 [overflow-wrap:anywhere]">Events: <code>lead.created</code>, <code>lead.updated</code>, <code>lead.enriched</code>, <code>lead.verified</code>, <code>lead.replied</code>, <code>lead.unsubscribed</code>, <code>search.completed</code>, <code>message.sent</code>, <code>message.opened</code>, <code>message.clicked</code>, <code>campaign.started</code>, or <code>*</code>. Every delivery is signed in the <code>x-prospex-signature</code> header - see "Verifying deliveries" below.</p>
        <div className="flex flex-wrap gap-2"><input className="input min-w-0 flex-1" placeholder="https://your-app.com/hooks/prospex" value={url} onChange={(e) => setUrl(e.target.value)} /><input className="input w-48" value={events} onChange={(e) => setEvents(e.target.value)} placeholder="* or lead.*,message.*" /><button className="btn-primary" disabled={!url} onClick={add}>Add</button></div>
        {freshSecret && <SecretOnce fresh={freshSecret} onDone={() => setFreshSecret(null)} toast={toast} />}
        {loadErr && !loaded && <div className="mt-4"><LoadError message={loadErr} onRetry={load} /></div>}
        <ul className="mt-4 divide-y divide-slate-100 text-sm">{hooks.map((h) => {
          const preview = secretPreviewOf(h);
          return (
            <li key={h.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${h.active ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{h.active ? "active" : "disabled"}</span>
                <span className="min-w-0 break-all font-mono text-xs">{h.url}</span>
                <span className="text-xs text-ink-400 [overflow-wrap:anywhere]">{h.events.join(", ")}</span>
                {preview && <span className="text-xs text-ink-500">secret: <span className="font-mono">{preview}</span></span>}
                {h.signatureVersion !== undefined && <span className="badge bg-black/[0.05] text-ink-300">signature v{h.signatureVersion}</span>}
                {h.failures > 0 && <span className="text-xs text-red-600">{h.failures} failed deliveries</span>}
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <button className="btn-secondary" disabled={testing === h.id} onClick={() => test(h)}>{testing === h.id ? "Testing…" : "Test"}</button>
                  {/* Only where the server can do it: a hook listed without a signature
                      version comes from a server with no rotate endpoint. */}
                  {h.signatureVersion !== undefined && <button className="btn-secondary" disabled={rotating === h.id} onClick={() => rotate(h)}>{rotating === h.id ? "Rotating…" : "Rotate secret"}</button>}
                  <button className="text-red-600" onClick={() => remove(h)}>Delete</button>
                </span>
              </div>
              {h.signatureVersion === 1 && <p className="mt-1 text-xs text-amber-700">Legacy signature - rotate to upgrade to HMAC-SHA256 (v2).</p>}
            </li>
          );
        })}{loaded && hooks.length === 0 && <li className="py-2 text-ink-400">No webhooks yet.</li>}</ul>
      </div>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Verifying deliveries</div>
        {/* Kept word for word in step with webhook.deliver in apps/api/src/jobs.ts: the header
            names, the "v2=" prefix, and the signed string `${timestamp}.${body}`. */}
        <p className="text-ink-300 [overflow-wrap:anywhere]">Each delivery is a JSON <code>POST</code> with three headers: <code>x-prospex-signature</code>, <code>x-prospex-timestamp</code> (milliseconds since 1970, as text) and <code>x-prospex-event</code>. The signature covers the timestamp and the <strong>raw request body</strong>, byte for byte - verify it before parsing, because re-serialised JSON will not match.</p>
        <ul className="mt-3 space-y-2 text-ink-300 [overflow-wrap:anywhere]">
          <li><span className="badge mr-1 bg-emerald-50 text-emerald-700">v2</span> New and rotated webhooks. The header value is <code>v2=&lt;hex&gt;</code>, where <code>&lt;hex&gt;</code> is the lowercase hex of <code>HMAC-SHA256(secret, timestamp + "." + raw body)</code>. Compute the same HMAC with your secret, compare in constant time, and reject the request if they differ or if the timestamp is more than a few minutes old.</li>
          <li><span className="badge mr-1 bg-amber-50 text-amber-700">v1</span> Legacy, for webhooks created before v2. The header value is the bare hex of <code>sha256(secret + "." + timestamp + "." + raw body)</code>, with no prefix. It keeps working so existing integrations do not break; rotate the secret to move a webhook to v2.</li>
        </ul>
        <pre className="mt-3 max-w-full overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-400">{`// Node.js, v2. rawBody is the request body exactly as received (a string or Buffer).
const crypto = require("node:crypto");
function verify(rawBody, headers, secret) {
  const ts = headers["x-prospex-timestamp"];
  const expected = "v2=" + crypto.createHmac("sha256", secret).update(ts + "." + rawBody).digest("hex");
  const a = Buffer.from(headers["x-prospex-signature"] || ""), b = Buffer.from(expected);
  const fresh = Math.abs(Date.now() - Number(ts)) < 5 * 60 * 1000;
  return fresh && a.length === b.length && crypto.timingSafeEqual(a, b);
}`}</pre>
        <p className="mt-2 text-xs text-ink-400">A value that starts with <code>v2=</code> is always a v2 signature, so one endpoint can accept both during a changeover.</p>
      </div>
    </div>
  );
}

const PROVIDER_FIELDS: Record<string, { label: string; fields: [string, string][]; help: string }> = {
  whatsapp: { label: "WhatsApp Cloud API (Meta, free 1k conv/mo)", fields: [["phoneNumberId", "Phone number ID"], ["accessToken", "Permanent access token"], ["templateName", "Approved template name (for first-touch messages)"], ["templateLanguage", "Template language code (en, en_US, hi)"]], help: "developers.facebook.com → WhatsApp → API setup. Outbound-first messages must use an approved template with one {{1}} body variable; Scout passes the personalized text as {{1}}." },
  hubspot: { label: "HubSpot (free CRM)", fields: [["accessToken", "Private app access token"]], help: "HubSpot → Settings → Integrations → Private apps → create with crm.objects.contacts write scope." },
  pipedrive: { label: "Pipedrive", fields: [["apiToken", "API token"], ["companyDomain", "Company subdomain (e.g. mycompany)"]], help: "Pipedrive → Personal preferences → API." },
  zoho: { label: "Zoho CRM (free)", fields: [["accessToken", "OAuth access token"], ["apiDomain", "API domain (https://www.zohoapis.in)"]], help: "Use a self-client OAuth token with ZohoCRM.modules.leads.CREATE scope." },
  cortex: { label: "Cortex (your automation platform)", fields: [["url", "Cortex webhook / ingest URL"], ["authHeader", "Authorization header value (optional)"]], help: "Scout POSTs {source, lead, company} JSON to this URL." },
  webhook: { label: "Generic webhook (Zapier, Make, n8n)", fields: [["url", "Webhook URL"], ["authHeader", "Authorization header (optional)"]], help: "Any endpoint that accepts JSON." },
  sheets: { label: "Google Sheets (Apps Script)", fields: [["url", "Apps Script web app URL"]], help: "Deploy a doPost(e) Apps Script that appends the lead to a sheet." },
};

function Integrations() {
  const [list, setList] = useState<{ provider: string; status: string; lastSyncAt: string | null; settings: { autoSync?: boolean } }[]>([]);
  const [provider, setProvider] = useState("hubspot");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const { toast, Toast } = useToast();
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { canManage } = useMe();
  const load = () => apiFetch<{ integrations: typeof list }>("GET", "/v1/integrations").then((r) => { setList(r.integrations); setLoadErr(null); setLoaded(true); }).catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { if (canManage) load(); }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = PROVIDER_FIELDS[provider];
  const disconnect = async (prov: string) => {
    const label = PROVIDER_FIELDS[prov]?.label ?? prov;
    if (!confirm(`Disconnect ${label}?\n\nScout stops pushing leads to it and forgets the saved credentials; you will need to enter them again to reconnect. Data already pushed stays in ${label}.`)) return;
    try {
      await apiFetch("DELETE", `/v1/integrations/${prov}`);
      toast("Disconnected");
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };
  if (!canManage) return <MembersNote what="integrations" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Toast}
      <div className="card p-5">
        <div className="mb-3 font-medium">Connect a CRM</div>
        <select className="input mb-3" value={provider} onChange={(e) => { setProvider(e.target.value); setCfg({}); }}>{Object.entries(PROVIDER_FIELDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        {p.fields.map(([k, label]) => <div key={k} className="mb-2"><label className="label">{label}</label><input className="input" value={cfg[k] ?? ""} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></div>)}
        <p className="mb-3 text-xs text-ink-400">{p.help}</p>
        <button className="btn-primary" onClick={() => apiFetch("PUT", `/v1/integrations/${provider}`, { config: cfg }).then(() => { toast("Connected"); load(); }).catch((e) => toast(e.message, "err"))}>Save connection</button>
      </div>
      <div className="card p-5">
        <div className="mb-3 font-medium">Connected</div>
        <ul className="divide-y divide-slate-100 text-sm">{list.map((i) => <li key={i.provider} className="flex items-center justify-between py-2"><div><div className="font-medium">{PROVIDER_FIELDS[i.provider]?.label ?? i.provider}</div><div className="text-xs text-ink-400">{i.lastSyncAt ? `last sync ${fmtDate(i.lastSyncAt)}` : "nothing pushed yet"}</div></div><button className="text-red-600" onClick={() => disconnect(i.provider)}>Disconnect</button></li>)}{loaded && list.length === 0 && <li className="py-2 text-ink-400">Nothing connected yet.</li>}</ul>
        {loadErr && !loaded && <LoadError message={loadErr} onRetry={load} />}
        <p className="mt-3 text-xs text-ink-400">
          Push leads from the Leads page: select them, then choose <strong>Push to CRM</strong> in the bar that appears. Or call{" "}
          <code>POST /v1/integrations/{"{provider}"}/sync</code> directly.
        </p>
      </div>
    </div>
  );
}

function Billing() {
  const [u, setU] = useState<{ period: string; plan: string; usage: Record<string, { used: number; limit: number }> } | null>(null);
  const [plans, setPlans] = useState<{ plans: { id: string; name: string; priceUsd: number; limits: Record<string, number | boolean> }[]; stripeEnabled: boolean; pilotMode: boolean } | null>(null);
  const [billErr, setBillErr] = useState<string | null>(null);
  const loadBilling = useCallback(() => {
    setBillErr(null);
    apiFetch<typeof u>("GET", "/v1/usage").then(setU).catch((e) => setBillErr((e as Error).message));
    apiFetch<typeof plans>("GET", "/v1/billing/plans").then(setPlans).catch((e) => setBillErr((e as Error).message));
  }, []);
  useEffect(() => { loadBilling(); }, [loadBilling]);
  if (billErr) return <LoadError message={billErr} onRetry={loadBilling} />;
  if (!u || !plans) return <div className="card p-5"><Spinner label="Loading…" /></div>;
  return (
    <div className="space-y-4">
      <div className="card p-5"><div className="mb-3 font-medium">Current plan: <span className="capitalize">{u.plan}</span> · {u.period}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">{Object.entries(u.usage).map(([k, v]) => <div key={k} className="rounded-lg border border-black/10 p-3"><div className="text-xs text-ink-400">{metricLabel(k)}</div><div className="text-lg font-semibold">{v.used.toLocaleString()} <span className="text-xs font-normal text-ink-500">/ {limitLabel(k, v.limit)}</span></div></div>)}</div>
        {plans.pilotMode && <p className="mt-3 text-sm text-emerald-600">Pilot mode: everything is free during the pilot. Limits reset monthly.</p>}
      </div>
      <div className="grid gap-3 md:grid-cols-4">{/* "pilot" is an internal plan, hidden here exactly as on the landing page - unless it
          is the plan this workspace is on, so the current plan never vanishes. */}
        {plans.plans.filter((p) => p.id !== "pilot" || p.id === u.plan).map((p) => <div key={p.id} className={`card p-4 ${p.id === u.plan ? "ring-2 ring-brand-500/50" : ""}`}><div className="font-semibold">{p.name}</div><div className="text-2xl font-semibold">${p.priceUsd}<span className="text-sm font-normal text-ink-400">/mo</span></div><ul className="mt-2 space-y-0.5 text-xs text-ink-300"><li>{Number(p.limits.leadsPerMonth).toLocaleString()} leads/mo</li><li>{Number(p.limits.verificationsPerMonth).toLocaleString()} verifications</li><li>{Number(p.limits.aiMessagesPerMonth).toLocaleString()} AI messages</li><li>{Number(p.limits.emailsPerMonth).toLocaleString()} emails</li><li>{p.limits.campaigns as number} campaigns</li></ul>{p.priceUsd > 0 && p.id !== u.plan && <Link to={`/upgrade?plan=${p.id}`} className="btn-primary mt-3 w-full justify-center">Upgrade</Link>}</div>)}</div>
    </div>
  );
}


type Invite = { id: string; email: string; role: string; createdAt: string; expiresAt?: string | null; expired?: boolean };
type InviteResult = { id: string; email: string; link?: string; emailed?: boolean; emailError?: string; expiresAt?: string | null };

function Team() {
  const [d, setD] = useState<{ members: { id: string; email: string; name: string; role: string; lastLoginAt: string | null }[]; invites: Invite[]; seats: { used: number; pending?: number; limit: number } } | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  // The result of the last invite/resend. When the email did not go out, the link is the
  // only way the invitee can join, so it is shown with a copy button and said plainly.
  const [sent, setSent] = useState<InviteResult | null>(null);
  const [inviting, setInviting] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  const { canManage, isOwner } = useMe();
  const [teamErr, setTeamErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setTeamErr(null);
    return apiFetch<typeof d>("GET", "/v1/tools/team").then(setD).catch((e) => setTeamErr((e as Error).message));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const announce = (r: InviteResult, verb: string) => {
    setSent(r);
    if (r.emailed === false) toast(`${verb}, but the email could not be sent - copy the link below`, "err");
    else toast(r.emailed ? `${verb} - email sent to ${r.email}` : verb);
  };
  const invite = async () => {
    setInviting(true);
    try {
      const r = await apiFetch<InviteResult>("POST", "/v1/tools/team/invite", { email, role });
      setEmail("");
      announce(r, "Invite created");
      load();
    } catch (e) {
      // 409 (already has an account / already invited) carries a full explanation; shown as-is.
      toast((e as Error).message, "err");
    } finally { setInviting(false); }
  };
  const resend = async (i: Invite) => {
    setRowBusy(i.id);
    try {
      announce(await apiFetch<InviteResult>("POST", `/v1/tools/team/invites/${i.id}/resend`), "Invite renewed for 14 days");
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setRowBusy(null); }
  };
  const revoke = async (i: Invite) => {
    if (!confirm(`Revoke the invite to ${i.email}?\n\nTheir invite link stops working and the seat is freed. You can invite them again later.`)) return;
    setRowBusy(i.id);
    try {
      await apiFetch("DELETE", `/v1/tools/team/invites/${i.id}`);
      if (sent?.id === i.id) setSent(null);
      toast("Invite revoked");
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setRowBusy(null); }
  };
  if (teamErr) return <LoadError message={teamErr} onRetry={load} />;
  if (!d) return <div className="card p-5"><Spinner label="Loading…" /></div>;
  const pending = d.seats.pending ?? d.invites.filter((i) => !i.expired).length;
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between"><div className="font-medium">Members <span className="text-sm text-ink-400">{d.seats.used}{pending ? ` + ${pending} invited` : ""} / {d.seats.limit} seats</span></div></div>
        <ul className="divide-y divide-slate-100 text-sm">{d.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div>{m.name || m.email} <span className="text-ink-400">{m.email}</span> <span className="badge ml-2 bg-black/[0.05] text-ink-300">{m.role}</span></div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-500">last login {fmtDate(m.lastLoginAt)}</span>
              {/* Seats could be consumed but never freed, so a departed colleague kept
                  access to the workspace and kept occupying a seat on the plan. The owner
                  cannot be removed and cannot remove themselves - the server enforces both,
                  and only the owner may remove anyone. */}
              {m.role !== "owner" && isOwner && (
                <DeleteButton
                  what={`${m.name || m.email} from this workspace`}
                  consequence="They lose access immediately and the seat is freed. Leads, campaigns and anything else they created stay."
                  label="Remove"
                  className="text-xs"
                  onDelete={async () => { await apiFetch("DELETE", `/v1/tools/team/${m.id}`); toast("Removed"); await load(); }}
                  onError={(msg) => toast(msg, "err")}
                />
              )}
            </div>
          </li>
        ))}</ul>
        {canManage ? (
          <div className="mt-4 flex flex-wrap gap-2"><input className="input flex-1" type="email" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /><select className="input w-32" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">member</option><option value="admin">admin</option></select><button className="btn-primary" disabled={!email || inviting} onClick={invite}>{inviting ? "Inviting…" : "Invite"}</button></div>
        ) : (
          <p className="mt-4 text-xs text-ink-400">Only owners and admins can invite people.</p>
        )}
        {sent?.link && (
          <div className={`mt-3 rounded-lg border p-3 text-xs ${sent.emailed === false ? "border-amber-300 bg-amber-50 text-amber-900" : "border-black/10 bg-cream text-ink-300"}`} role="status">
            <div className="mb-1">
              {sent.emailed === false
                ? <>Invite email to {sent.email} could not be sent{sent.emailError ? ` (${sent.emailError})` : ""} - copy this link and send it to them yourself:</>
                : sent.emailed
                  ? <>Emailed to {sent.email}. You can also share the link directly:</>
                  : <>Invite link for {sent.email}:</>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all">{sent.link}</code>
              <button type="button" className="btn-secondary py-1 text-xs" onClick={() => copyText(sent.link!, toast)}>Copy link</button>
            </div>
            {sent.expiresAt && <div className="mt-1 text-ink-400">Expires {fmtDate(sent.expiresAt)}.</div>}
          </div>
        )}
      </div>
      {d.invites.length > 0 && (
        <div className="card p-5">
          <div className="mb-2 font-medium">Pending invites</div>
          <ul className="divide-y divide-slate-100 text-sm">{d.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div>
                {i.email} <span className="badge ml-2 bg-black/[0.05] text-ink-300">{i.role}</span>
                {i.expired ? <span className="badge ml-2 bg-red-50 text-red-700">expired</span> : null}
                <div className="text-xs text-ink-400">Invited {fmtDate(i.createdAt)}{i.expiresAt ? ` · ${i.expired ? "expired" : "expires"} ${fmtDate(i.expiresAt)}` : ""}</div>
              </div>
              {canManage && (
                <div className="flex items-center gap-3 text-xs">
                  <button className="text-brand-600 hover:underline disabled:opacity-50" disabled={rowBusy === i.id} onClick={() => resend(i)}>{i.expired ? "Renew & resend" : "Resend"}</button>
                  <button className="text-red-600 disabled:opacity-50" disabled={rowBusy === i.id} onClick={() => revoke(i)}>Revoke</button>
                </div>
              )}
            </li>
          ))}</ul>
        </div>
      )}
    </div>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  actorType?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result?: string | null;
  ip?: string | null;
  createdAt: string;
  data?: Record<string, unknown> | null;
}

/**
 * Security-log actions in plain words. Keyed on the action with its separators normalised
 * ("auth.password_change", "auth.password.change" and "auth:password-change" are one key),
 * so a spelling difference on the server does not turn a row into raw identifiers. Anything
 * not listed still reads as words through the fallback below - a new server action shows up
 * as "Webhook: rotate secret", never as a blank.
 */
const AUDIT_WORDS: Record<string, string> = {
  // Sign-in and sessions
  "auth.login": "Sign-in",
  "auth.login.locked": "Sign-in blocked after too many attempts",
  "auth.google.login": "Sign-in with Google",
  "auth.google.claimed.unverified.account": "Account taken over by its Google owner (old password turned off)",
  "auth.signup": "Workspace created",
  "auth.logout.all": "Signed out of all devices",
  "auth.password.changed": "Password change",
  "auth.password.reset": "Password reset from an emailed link",
  "auth.password.reset.requested": "Password reset requested",
  // Credentials
  "apikey.created": "API key created",
  "apikey.revoked": "API key revoked",
  "webhook.created": "Webhook added",
  "webhook.deleted": "Webhook deleted",
  "webhook.secret.rotated": "Webhook secret rotated",
  "webhook.tested": "Webhook test sent",
  "integration.connected": "Integration connected",
  "integration.disconnected": "Integration disconnected",
  "integration.synced": "Leads pushed to an integration",
  "sender.created": "Sending mailbox added",
  "sender.deleted": "Sending mailbox removed",
  // People
  "team.invited": "Teammate invited",
  "team.invite.resent": "Invite resent",
  "team.invite.revoked": "Invite revoked",
  "team.joined": "Teammate joined from an invite",
  "team.member.removed": "Teammate removed",
  // Data leaving or being destroyed
  "leads.exported": "Leads exported",
  "leads.imported": "Leads imported",
  "leads.bulk.deleted": "Leads deleted in bulk",
  "list.deleted": "List deleted",
  "suppression.added": "Address added to the do-not-contact list",
  "client.created": "Client created",
  "client.deleted": "Client deleted",
  "client.share.disabled": "Client report link turned off",
  "campaign.started": "Campaign started",
  "campaign.paused": "Campaign paused",
  "campaign.deleted": "Campaign deleted",
  "autopilot.created": "Autopilot created",
  "autopilot.deleted": "Autopilot deleted",
  "pixel.created": "Website tracking pixel created",
  "pixel.deleted": "Website tracking pixel deleted",
  "org.settings.changed": "Workspace settings changed",
  "reference.denied": "Request for another workspace's data refused",
  // Scout staff
  "admin.login": "Scout admin sign-in",
};

function auditActionLabel(action: string): string {
  const key = String(action ?? "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (AUDIT_WORDS[key]) return AUDIT_WORDS[key];
  const parts = String(action ?? "").split(/[.:/]+/).map((p) => p.replace(/[_-]+/g, " ").trim()).filter(Boolean);
  if (parts.length === 0) return "Unknown action";
  const head = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.length === 1 ? head : `${head}: ${parts.slice(1).join(" ")}`;
}

const AUDIT_ACTOR: Record<string, string> = { user: "A workspace member", api_key: "API key", admin: "Scout admin", system: "Scout (automatic)", anonymous: "Not signed in" };

function auditWho(e: AuditEntry): string {
  if (e.actorEmail) return e.actorEmail;
  // A failed sign-in has no account behind it; the address that was tried is the only "who".
  const tried = e.data && typeof e.data.email === "string" ? e.data.email : null;
  const label = AUDIT_ACTOR[e.actorType ?? ""] ?? (e.actorType ? e.actorType : "Unknown");
  return tried ? `${label} (as ${tried})` : label;
}

function AuditResult({ result }: { result?: string | null }) {
  const r = result ?? "ok";
  const [cls, text] = r === "ok" ? ["bg-emerald-50 text-emerald-700", "Succeeded"] : r === "denied" ? ["bg-amber-50 text-amber-700", "Blocked"] : r === "failed" ? ["bg-red-50 text-red-700", "Failed"] : ["bg-black/[0.05] text-ink-300", r];
  return <span className={`badge shrink-0 ${cls}`}>{text}</span>;
}

const AUDIT_PAGE = 50;

/**
 * Security log: who signed in, from where, and what they changed that matters for access -
 * passwords, API keys, webhooks, exports. Owners and admins only (the server enforces it).
 *
 * Rows are stacked blocks rather than a five-column table: on a phone a table of timestamp,
 * action, email, IP and result either scrolls sideways or crushes every column, and an
 * email address or an IPv6 address must be allowed to wrap.
 */
function SecurityLog() {
  const { canManage, settled } = useMe();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreErr, setMoreErr] = useState<string | null>(null);
  // The cursor for the next page. The server may hand one back; otherwise it is the
  // timestamp of the oldest row shown.
  const [cursor, setCursor] = useState<string | null>(null);

  type AuditPage = { entries?: AuditEntry[]; nextBefore?: string | null; nextCursor?: string | null; hasMore?: boolean };
  const fetchPage = (before: string | null) =>
    apiFetch<AuditPage>("GET", `/v1/audit-log?limit=${AUDIT_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`).then((r) => {
      // A 200 without an entries array is not "no activity" - it is an answer we cannot read.
      if (!r || !Array.isArray(r.entries)) throw new Error("The server's answer could not be read.");
      const rows = r.entries;
      const next = r.nextBefore ?? r.nextCursor ?? (rows.length ? rows[rows.length - 1].createdAt : null);
      const hasMore = typeof r.hasMore === "boolean" ? r.hasMore : rows.length >= AUDIT_PAGE;
      return { rows, next, hasMore };
    });

  const load = useCallback(() => {
    setErr(null);
    setMoreErr(null);
    fetchPage(null)
      .then(({ rows, next, hasMore }) => { setEntries(rows); setCursor(next); setMore(hasMore && !!next); })
      .catch((e) => setErr((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Waits for the role: asking first and learning "member" second would put a refused
  // request into the very log this page shows.
  useEffect(() => { if (settled && canManage) load(); }, [settled, canManage, load]);

  const loadMore = async () => {
    if (moreBusy || !cursor) return;
    setMoreBusy(true);
    setMoreErr(null);
    try {
      const { rows, next, hasMore } = await fetchPage(cursor);
      // De-duplicated by id: a cursor that is inclusive, or two rows in the same millisecond,
      // must not show the same entry twice.
      const seen = new Set((entries ?? []).map((e) => e.id));
      const added = rows.filter((e) => !seen.has(e.id));
      setEntries([...(entries ?? []), ...added]);
      setCursor(next);
      // No new rows, or a cursor that did not move, is the end - not a button that reloads
      // the same page forever.
      setMore(hasMore && added.length > 0 && !!next && next !== cursor);
    } catch (e) {
      setMoreErr((e as Error).message);
    } finally {
      setMoreBusy(false);
    }
  };

  if (settled && !canManage) return <div className="card p-5 text-sm text-ink-400">Only workspace owners and admins can see the security log.</div>;
  if (err && !entries) return <LoadError message={err} onRetry={load} />;
  if (!entries) return <div className="card p-5"><Spinner label="Loading…" /></div>;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">Security log</div>
          <button type="button" className="btn-secondary py-1 text-xs" onClick={load}>Refresh</button>
        </div>
        <p className="mb-3 text-sm text-ink-300">Sign-ins and changes to access in this workspace - passwords, API keys, webhooks and exports - newest first, with the address each came from. Visible to owners and admins.</p>
        {entries.length === 0 ? (
          <div className="py-6 text-center text-sm text-ink-400">
            <div className="font-medium text-ink-200">Nothing recorded yet</div>
            <div className="mt-1">Sign-ins, password changes, API key and webhook changes will appear here as they happen.</div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {entries.map((e) => (
              <li key={e.id} className="py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 font-medium text-ink-100 [overflow-wrap:anywhere]">{auditActionLabel(e.action)}</div>
                  <AuditResult result={e.result} />
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-400">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{auditWho(e)}</span>
                  <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{e.ip || "address not recorded"}</span>
                  <time dateTime={e.createdAt}>{fmtDate(e.createdAt)}</time>
                </div>
              </li>
            ))}
          </ul>
        )}
        {moreErr && <div className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-600" role="alert">Could not load older entries: {moreErr}</div>}
        {more && <button type="button" className="btn-secondary mt-3 w-full justify-center" disabled={moreBusy} onClick={loadMore}>{moreBusy ? "Loading…" : "Load more"}</button>}
        {!more && entries.length > 0 && <p className="mt-3 text-center text-xs text-ink-500">End of the log.</p>}
      </div>
    </div>
  );
}
