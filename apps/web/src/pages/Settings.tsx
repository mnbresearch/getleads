import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { API_URL, apiFetch, fmtDate } from "../lib/api";
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
function useMe() {
  const [me, setMe] = useState<Me | null>(meCache);
  useEffect(() => {
    apiFetch<Me>("GET", "/v1/auth/me").then((r) => { meCache = r; setMe(r); }).catch(() => {});
  }, []);
  const role = me?.user?.role;
  return { me, role, canManage: role === undefined || role === "owner" || role === "admin", isOwner: role === undefined || role === "owner" };
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
  const tabs = [["", "Workspace"], ["team", "Team"], ["api-keys", "API keys"], ["webhooks", "Webhooks"], ["integrations", "Integrations"], ["billing", "Plan & usage"]];
  return (
    <Page title="Settings">
      <div className="mb-4 flex gap-1 border-b border-black/10">{tabs.map(([p, l]) => <NavLink key={p} to={`/settings/${p}`} end className={({ isActive }) => `px-3 py-2 text-sm ${isActive ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400"}`}>{l}</NavLink>)}</div>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/api-keys" element={<ApiKeys />} />
        <Route path="/team" element={<Team />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/billing" element={<Billing />} />
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
      await apiFetch("POST", "/v1/auth/password/change", { currentPassword: cur || undefined, newPassword: pw });
      setCur(""); setPw(""); setPw2("");
      setMsg({ ok: true, text: hasPassword === false ? "Password set. You can now also sign in with your email and this password." : "Password changed." });
      if (meCache?.user) meCache = { ...meCache, user: { ...meCache.user, hasPassword: true } };
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
        {fresh && <div className="mb-3 rounded-lg bg-black p-3 text-xs text-emerald-600"><div className="mb-1 flex items-center justify-between gap-2 text-ink-100"><span>Copy now - shown once:</span><button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => copyText(fresh, toast)}>Copy</button></div><code className="break-all">{fresh}</code></div>}
        {loadErr && !loaded && <LoadError message={loadErr} onRetry={load} />}
        {loaded && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="th">Name</th><th className="th">Prefix</th><th className="th">Last used</th><th className="th">Created</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">{keys.map((k) => <tr key={k.id} className={k.revokedAt ? "opacity-50" : ""}><td className="td">{k.name}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td text-xs">{fmtDate(k.lastUsedAt)}</td><td className="td text-xs">{fmtDate(k.createdAt)}</td><td className="td text-right">{!k.revokedAt && <button className="text-red-600" onClick={() => revoke(k)}>Revoke</button>}</td></tr>)}</tbody></table></div>}
        {loaded && keys.length === 0 && <div className="py-3 text-sm text-ink-400">No API keys yet.</div>}
      </div>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Use with AI agents</div>
        <p className="text-ink-300">REST: send <code>x-api-key</code>. OpenAPI spec at <a className="text-brand-600" href={`${API_URL}/openapi.json`} target="_blank" rel="noreferrer">{API_URL}/openapi.json</a>, interactive docs at <a className="text-brand-600" href={`${API_URL}/docs`} target="_blank" rel="noreferrer">/docs</a>.</p>
        <p className="mt-2 text-ink-300">MCP (Claude Desktop, Claude Code, Cursor):</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-800">{`{ "mcpServers": { "prospex": { "command": "npx", "args": ["-y", "@prospex/mcp"],
    "env": { "PROSPEX_API_KEY": "px_live_...", "PROSPEX_API_URL": "${API_URL}" } } } }`}</pre>
      </div>
    </div>
  );
}

type Hook = { id: string; url: string; events: string[]; secret?: string; secretPrefix?: string; active: boolean; failures: number };

function Webhooks() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("*");
  const { toast, Toast } = useToast();
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The signing secret is returned in full only by the create call; it is shown here once,
  // with a copy button, instead of only an 8-character prefix nobody could verify against.
  const [freshSecret, setFreshSecret] = useState<{ url: string; secret: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const { canManage } = useMe();
  const load = () => apiFetch<{ webhooks: Hook[] }>("GET", "/v1/webhooks").then((r) => { setHooks(r.webhooks); setLoadErr(null); setLoaded(true); }).catch((e) => setLoadErr((e as Error).message));
  useEffect(() => { if (canManage) load(); }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    try {
      const r = await apiFetch<Hook & { webhook?: Hook }>("POST", "/v1/webhooks", { url, events: events.split(",").map((s) => s.trim()).filter(Boolean) });
      const secret = r.secret ?? r.webhook?.secret;
      if (secret) setFreshSecret({ url, secret });
      setUrl("");
      load();
      toast("Webhook added");
    } catch (e) { toast((e as Error).message, "err"); }
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
        <p className="mb-3 text-sm text-ink-300">Events: <code>lead.created</code>, <code>lead.updated</code>, <code>lead.enriched</code>, <code>lead.verified</code>, <code>lead.replied</code>, <code>lead.unsubscribed</code>, <code>search.completed</code>, <code>message.sent</code>, <code>message.opened</code>, <code>message.clicked</code>, <code>campaign.started</code>, or <code>*</code>. Signed with <code>x-prospex-signature</code> = sha256(secret.timestamp.body).</p>
        <div className="flex flex-wrap gap-2"><input className="input flex-1" placeholder="https://your-app.com/hooks/prospex" value={url} onChange={(e) => setUrl(e.target.value)} /><input className="input w-48" value={events} onChange={(e) => setEvents(e.target.value)} placeholder="* or lead.*,message.*" /><button className="btn-primary" disabled={!url} onClick={add}>Add</button></div>
        {freshSecret && (
          <div className="mt-3 rounded-lg bg-black p-3 text-xs text-emerald-600" role="status">
            <div className="mb-1 flex items-center justify-between gap-2 text-ink-100">
              <span>Signing secret for {freshSecret.url} - copy it now, it is not shown again:</span>
              <span className="flex gap-2">
                <button type="button" className="rounded bg-white/10 px-2 py-0.5 text-white hover:bg-white/20" onClick={() => copyText(freshSecret.secret, toast)}>Copy</button>
                <button type="button" className="text-ink-300 hover:text-white" onClick={() => setFreshSecret(null)}>Done</button>
              </span>
            </div>
            <code className="break-all">{freshSecret.secret}</code>
          </div>
        )}
        {loadErr && !loaded && <div className="mt-4"><LoadError message={loadErr} onRetry={load} /></div>}
        <ul className="mt-4 divide-y divide-slate-100 text-sm">{hooks.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className={`badge ${h.active ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{h.active ? "active" : "disabled"}</span>
            <span className="break-all font-mono text-xs">{h.url}</span>
            <span className="text-xs text-ink-400">{h.events.join(", ")}</span>
            {(h.secretPrefix || h.secret) && <span className="text-xs text-ink-500">secret: {(h.secretPrefix ?? h.secret ?? "").slice(0, 8)}…</span>}
            {h.failures > 0 && <span className="text-xs text-red-600">{h.failures} failed deliveries</span>}
            <button className="btn-secondary ml-auto" disabled={testing === h.id} onClick={() => test(h)}>{testing === h.id ? "Testing…" : "Test"}</button>
            <button className="text-red-600" onClick={() => remove(h)}>Delete</button>
          </li>
        ))}{loaded && hooks.length === 0 && <li className="py-2 text-ink-400">No webhooks yet.</li>}</ul>
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{Object.entries(u.usage).map(([k, v]) => <div key={k} className="rounded-lg border border-black/10 p-3"><div className="text-xs capitalize text-ink-400">{k.replace(/([A-Z])/g, " $1")}</div><div className="text-lg font-semibold">{v.used.toLocaleString()} <span className="text-xs font-normal text-ink-500">/ {v.limit.toLocaleString()}</span></div></div>)}</div>
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
