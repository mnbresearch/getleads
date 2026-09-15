import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { API_URL, apiFetch, fmtDate } from "../lib/api";
import { Page, useToast } from "../components/ui";

export function SettingsPage() {
  const tabs = [["", "Workspace"], ["team", "Team"], ["api-keys", "API keys"], ["webhooks", "Webhooks"], ["integrations", "Integrations"], ["billing", "Plan & usage"]];
  return (
    <Page title="Settings">
      <div className="mb-4 flex gap-1 border-b border-white/10">{tabs.map(([p, l]) => <NavLink key={p} to={`/settings/${p}`} end className={({ isActive }) => `px-3 py-2 text-sm ${isActive ? "border-b-2 border-brand-400 font-medium text-brand-300" : "text-ink-400"}`}>{l}</NavLink>)}</div>
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
  useEffect(() => { apiFetch<{ org: typeof org }>("GET", "/v1/auth/me").then((r) => { setOrg(r.org); setF({ name: r.org!.name, senderName: r.org!.settings.senderName ?? "", senderCompany: r.org!.settings.senderCompany ?? r.org!.name, valueProp: r.org!.settings.valueProp ?? "" }); }); }, []);
  if (!org) return null;
  return (
    <div className="card max-w-xl space-y-3 p-5">
      {Toast}
      <div><label className="label">Workspace name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="pt-2 text-sm font-medium">Defaults for AI-drafted emails</div>
      <div><label className="label">Your name</label><input className="input" value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
      <div><label className="label">Company</label><input className="input" value={f.senderCompany} onChange={(e) => setF({ ...f, senderCompany: e.target.value })} /></div>
      <div><label className="label">Value proposition</label><textarea className="input h-20" value={f.valueProp} onChange={(e) => setF({ ...f, valueProp: e.target.value })} /></div>
      <button className="btn-primary" onClick={() => apiFetch("PATCH", "/v1/auth/org", { name: f.name, settings: { senderName: f.senderName, senderCompany: f.senderCompany, valueProp: f.valueProp } }).then(() => toast("Saved")).catch((e) => toast(e.message, "err"))}>Save</button>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<{ id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  const load = () => apiFetch<{ apiKeys: typeof keys }>("GET", "/v1/auth/api-keys").then((r) => setKeys(r.apiKeys));
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-2 flex items-center justify-between"><div className="font-medium">API keys</div><button className="btn-primary" onClick={async () => { const name = prompt("Key name", "Agent") ?? ""; if (!name) return; const r = await apiFetch<{ key: string }>("POST", "/v1/auth/api-keys", { name }); setFresh(r.key); load(); }}>Create key</button></div>
        {fresh && <div className="mb-3 rounded-lg bg-black p-3 text-xs text-emerald-300"><div className="mb-1 text-ink-100">Copy now - shown once:</div><code className="break-all">{fresh}</code></div>}
        <table className="w-full text-sm"><thead><tr><th className="th">Name</th><th className="th">Prefix</th><th className="th">Last used</th><th className="th">Created</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">{keys.map((k) => <tr key={k.id} className={k.revokedAt ? "opacity-50" : ""}><td className="td">{k.name}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td text-xs">{fmtDate(k.lastUsedAt)}</td><td className="td text-xs">{fmtDate(k.createdAt)}</td><td className="td text-right">{!k.revokedAt && <button className="text-red-300" onClick={() => apiFetch("DELETE", `/v1/auth/api-keys/${k.id}`).then(load)}>Revoke</button>}</td></tr>)}</tbody></table>
      </div>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Use with AI agents</div>
        <p className="text-ink-300">REST: send <code>x-api-key</code>. OpenAPI spec at <a className="text-brand-300" href={`${API_URL}/openapi.json`} target="_blank" rel="noreferrer">{API_URL}/openapi.json</a>, interactive docs at <a className="text-brand-300" href={`${API_URL}/docs`} target="_blank" rel="noreferrer">/docs</a>.</p>
        <p className="mt-2 text-ink-300">MCP (Claude Desktop, Claude Code, Cursor):</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-black p-3 text-xs text-emerald-200">{`{ "mcpServers": { "prospex": { "command": "npx", "args": ["-y", "@prospex/mcp"],
    "env": { "PROSPEX_API_KEY": "px_live_...", "PROSPEX_API_URL": "${API_URL}" } } } }`}</pre>
      </div>
    </div>
  );
}

function Webhooks() {
  const [hooks, setHooks] = useState<{ id: string; url: string; events: string[]; secret: string; active: boolean; failures: number }[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("*");
  const { toast, Toast } = useToast();
  const load = () => apiFetch<{ webhooks: typeof hooks }>("GET", "/v1/webhooks").then((r) => setHooks(r.webhooks));
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-3 font-medium">Webhooks</div>
        <p className="mb-3 text-sm text-ink-300">Events: <code>lead.created</code>, <code>lead.updated</code>, <code>lead.enriched</code>, <code>lead.verified</code>, <code>lead.replied</code>, <code>lead.unsubscribed</code>, <code>search.completed</code>, <code>message.sent</code>, <code>message.opened</code>, <code>message.clicked</code>, <code>campaign.started</code>, or <code>*</code>. Signed with <code>x-prospex-signature</code> = sha256(secret.timestamp.body).</p>
        <div className="flex flex-wrap gap-2"><input className="input flex-1" placeholder="https://your-app.com/hooks/prospex" value={url} onChange={(e) => setUrl(e.target.value)} /><input className="input w-48" value={events} onChange={(e) => setEvents(e.target.value)} placeholder="* or lead.*,message.*" /><button className="btn-primary" disabled={!url} onClick={() => apiFetch("POST", "/v1/webhooks", { url, events: events.split(",").map((s) => s.trim()) }).then(() => { setUrl(""); load(); toast("Webhook added"); }).catch((e) => toast(e.message, "err"))}>Add</button></div>
        <ul className="mt-4 divide-y divide-slate-100 text-sm">{hooks.map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2 py-2"><span className={`badge ${h.active ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>{h.active ? "active" : "disabled"}</span><span className="font-mono text-xs">{h.url}</span><span className="text-xs text-ink-400">{h.events.join(", ")}</span><span className="text-xs text-ink-500">secret: {h.secret.slice(0, 8)}…</span><button className="btn-secondary ml-auto" onClick={() => apiFetch("POST", `/v1/webhooks/${h.id}/test`).then(() => toast("Test event queued"))}>Test</button><button className="text-red-300" onClick={() => apiFetch("DELETE", `/v1/webhooks/${h.id}`).then(load)}>Delete</button></li>)}</ul>
      </div>
    </div>
  );
}

const PROVIDER_FIELDS: Record<string, { label: string; fields: [string, string][]; help: string }> = {
  whatsapp: { label: "WhatsApp Cloud API (Meta, free 1k conv/mo)", fields: [["phoneNumberId", "Phone number ID"], ["accessToken", "Permanent access token"], ["templateName", "Approved template name (for first-touch messages)"], ["templateLanguage", "Template language code (en, en_US, hi)"]], help: "developers.facebook.com → WhatsApp → API setup. Outbound-first messages must use an approved template with one {{1}} body variable; Prospex passes the personalized text as {{1}}." },
  hubspot: { label: "HubSpot (free CRM)", fields: [["accessToken", "Private app access token"]], help: "HubSpot → Settings → Integrations → Private apps → create with crm.objects.contacts write scope." },
  pipedrive: { label: "Pipedrive", fields: [["apiToken", "API token"], ["companyDomain", "Company subdomain (e.g. mycompany)"]], help: "Pipedrive → Personal preferences → API." },
  zoho: { label: "Zoho CRM (free)", fields: [["accessToken", "OAuth access token"], ["apiDomain", "API domain (https://www.zohoapis.in)"]], help: "Use a self-client OAuth token with ZohoCRM.modules.leads.CREATE scope." },
  cortex: { label: "Cortex (your automation platform)", fields: [["url", "Cortex webhook / ingest URL"], ["authHeader", "Authorization header value (optional)"]], help: "Prospex POSTs {source, lead, company} JSON to this URL." },
  webhook: { label: "Generic webhook (Zapier, Make, n8n)", fields: [["url", "Webhook URL"], ["authHeader", "Authorization header (optional)"]], help: "Any endpoint that accepts JSON." },
  sheets: { label: "Google Sheets (Apps Script)", fields: [["url", "Apps Script web app URL"]], help: "Deploy a doPost(e) Apps Script that appends the lead to a sheet." },
};

function Integrations() {
  const [list, setList] = useState<{ provider: string; status: string; lastSyncAt: string | null; settings: { autoSync?: boolean } }[]>([]);
  const [provider, setProvider] = useState("hubspot");
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const { toast, Toast } = useToast();
  const load = () => apiFetch<{ integrations: typeof list }>("GET", "/v1/integrations").then((r) => setList(r.integrations));
  useEffect(() => { load(); }, []);
  const p = PROVIDER_FIELDS[provider];
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
        <ul className="divide-y divide-slate-100 text-sm">{list.map((i) => <li key={i.provider} className="flex items-center justify-between py-2"><div><div className="font-medium">{PROVIDER_FIELDS[i.provider]?.label ?? i.provider}</div><div className="text-xs text-ink-400">last sync {fmtDate(i.lastSyncAt)}</div></div><button className="text-red-300" onClick={() => apiFetch("DELETE", `/v1/integrations/${i.provider}`).then(load)}>Disconnect</button></li>)}{list.length === 0 && <li className="py-2 text-ink-400">Nothing connected yet.</li>}</ul>
        <p className="mt-3 text-xs text-ink-400">Push leads from the Leads page (select → sync) or via <code>POST /v1/integrations/{"{provider}"}/sync</code>.</p>
      </div>
    </div>
  );
}

function Billing() {
  const [u, setU] = useState<{ period: string; plan: string; usage: Record<string, { used: number; limit: number }> } | null>(null);
  const [plans, setPlans] = useState<{ plans: { id: string; name: string; priceUsd: number; limits: Record<string, number | boolean> }[]; stripeEnabled: boolean; pilotMode: boolean } | null>(null);
  useEffect(() => { apiFetch<typeof u>("GET", "/v1/usage").then(setU); apiFetch<typeof plans>("GET", "/v1/billing/plans").then(setPlans); }, []);
  if (!u || !plans) return null;
  return (
    <div className="space-y-4">
      <div className="card p-5"><div className="mb-3 font-medium">Current plan: <span className="capitalize">{u.plan}</span> · {u.period}</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{Object.entries(u.usage).map(([k, v]) => <div key={k} className="rounded-lg border border-white/10 p-3"><div className="text-xs capitalize text-ink-400">{k.replace(/([A-Z])/g, " $1")}</div><div className="text-lg font-semibold">{v.used.toLocaleString()} <span className="text-xs font-normal text-ink-500">/ {v.limit.toLocaleString()}</span></div></div>)}</div>
        {plans.pilotMode && <p className="mt-3 text-sm text-emerald-300">Pilot mode: everything is free during the pilot. Limits reset monthly.</p>}
      </div>
      <div className="grid gap-3 md:grid-cols-4">{plans.plans.map((p) => <div key={p.id} className={`card p-4 ${p.id === u.plan ? "ring-2 ring-brand-500/50" : ""}`}><div className="font-semibold">{p.name}</div><div className="text-2xl font-semibold">${p.priceUsd}<span className="text-sm font-normal text-ink-400">/mo</span></div><ul className="mt-2 space-y-0.5 text-xs text-ink-300"><li>{Number(p.limits.leadsPerMonth).toLocaleString()} leads/mo</li><li>{Number(p.limits.verificationsPerMonth).toLocaleString()} verifications</li><li>{Number(p.limits.aiMessagesPerMonth).toLocaleString()} AI messages</li><li>{Number(p.limits.emailsPerMonth).toLocaleString()} emails</li><li>{p.limits.campaigns as number} campaigns</li></ul>{plans.stripeEnabled && p.priceUsd > 0 && p.id !== u.plan && <button className="btn-primary mt-3 w-full justify-center" onClick={() => apiFetch<{ url: string }>("POST", "/v1/billing/checkout", { plan: p.id }).then((r) => (location.href = r.url))}>Upgrade</button>}</div>)}</div>
    </div>
  );
}


function Team() {
  const [d, setD] = useState<{ members: { id: string; email: string; name: string; role: string; lastLoginAt: string | null }[]; invites: { id: string; email: string; role: string; createdAt: string }[]; seats: { used: number; limit: number } } | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  const load = () => apiFetch<typeof d>("GET", "/v1/tools/team").then(setD);
  useEffect(() => { load(); }, []);
  if (!d) return null;
  return (
    <div className="space-y-4">
      {Toast}
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between"><div className="font-medium">Members <span className="text-sm text-ink-400">{d.seats.used} / {d.seats.limit} seats</span></div></div>
        <ul className="divide-y divide-slate-100 text-sm">{d.members.map((m) => <li key={m.id} className="flex items-center justify-between py-2"><div>{m.name || m.email} <span className="text-ink-400">{m.email}</span> <span className="badge ml-2 bg-surface/5 text-ink-300">{m.role}</span></div><span className="text-xs text-ink-500">last login {fmtDate(m.lastLoginAt)}</span></li>)}</ul>
        <div className="mt-4 flex flex-wrap gap-2"><input className="input flex-1" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /><select className="input w-32" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">member</option><option value="admin">admin</option></select><button className="btn-primary" disabled={!email} onClick={() => apiFetch<{ link: string }>("POST", "/v1/tools/team/invite", { email, role }).then((r) => { setLink(r.link); setEmail(""); load(); toast("Invite sent"); }).catch((e) => toast(e.message, "err"))}>Invite</button></div>
        {link && <div className="mt-2 text-xs text-ink-400">Invite link (also emailed if a mail provider is configured): <code className="break-all">{link}</code></div>}
        {d.invites.length > 0 && <div className="mt-3 text-xs text-ink-400">Pending: {d.invites.map((i) => i.email).join(", ")}</div>}
      </div>
    </div>
  );
}
