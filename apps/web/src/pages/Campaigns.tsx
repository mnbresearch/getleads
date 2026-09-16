import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiFetch, fmtDate } from "../lib/api";
import { EmailStatusBadge, Empty, Modal, Page, Spinner, useToast } from "../components/ui";

interface Step { delayDays: number; channel?: string; subjectTemplate: string; bodyTemplate: string; aiPersonalize: boolean; aiInstructions?: string; variants?: { subjectTemplate: string; bodyTemplate: string }[] }
interface Campaign { id: string; name: string; status: string; listId: string | null; icpId: string | null; emailAccountId: string | null; settings: Record<string, unknown>; stats: Record<string, number>; contacts: number; steps?: Step[]; createdAt: string }
interface Account { id: string; provider: string; fromName: string; fromEmail: string; dailyLimit: number; status: string; sentToday: number }

const DEFAULT_STEPS: Step[] = [
  { delayDays: 0, subjectTemplate: 'Quick question, {{first_name | fallback:"there"}}', bodyTemplate: "Hi {{first_name}},\n\nNoticed {{company}} and thought this might be relevant. [value proposition]\n\nWorth a 15-minute chat next week?\n\n{{sender_name}}", aiPersonalize: true },
  { delayDays: 3, subjectTemplate: "Re: Quick question", bodyTemplate: "Hi {{first_name}}, bumping this in case it got buried. Happy to share a 2-minute overview if useful.\n\n{{sender_name}}", aiPersonalize: true },
  { delayDays: 5, subjectTemplate: "Closing the loop", bodyTemplate: "Last note from me, {{first_name}}. If timing isn't right, no worries - I'll leave it here.\n\n{{sender_name}}", aiPersonalize: false },
];

export function CampaignsPage() {
  const [rows, setRows] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string; count: number }[]>([]);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [accOpen, setAccOpen] = useState(false);
  const [sysAvail, setSysAvail] = useState(false);
  const { toast, Toast } = useToast();
  const navigate = useNavigate();
  const load = useCallback(() => {
    apiFetch<{ campaigns: Campaign[] }>("GET", "/v1/campaigns").then((r) => setRows(r.campaigns));
    apiFetch<{ emailAccounts: Account[]; systemProviderAvailable: boolean }>("GET", "/v1/campaigns/email-accounts").then((r) => { setAccounts(r.emailAccounts); setSysAvail(r.systemProviderAvailable); });
    apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(r.lists));
    apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(r.icps));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  return (
    <Page title="Campaigns" subtitle="AI-personalized sequences with send windows, daily limits, open/click/reply tracking and auto-stop on reply." actions={<><button className="btn-secondary" onClick={() => setAccOpen(true)}>Sender accounts ({accounts.length})</button><button className="btn-primary" onClick={() => setOpen(true)}>New campaign</button></>}>
      {Toast}
      {accounts.length === 0 && <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">Add a sender account first (Resend free tier: 3,000 emails/month, or any SMTP like Brevo/Gmail). <button className="underline" onClick={() => setAccOpen(true)}>Add sender</button></div>}
      {rows.length === 0 ? <Empty title="No campaigns yet" hint="Create a sequence, enroll leads from a list or by ICP score, and start sending." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="border-b border-black/10 bg-cream"><tr><th className="th">Campaign</th><th className="th">Status</th><th className="th">Contacts</th><th className="th">Sent</th><th className="th">Opened</th><th className="th">Replied</th><th className="th">Created</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-black/[0.05]" onClick={() => navigate(`/campaigns/${c.id}`)}>
                  <td className="td font-medium">{c.name}</td>
                  <td className="td"><StatusBadge s={c.status} /></td>
                  <td className="td tabular-nums">{c.contacts}</td>
                  <td className="td tabular-nums">{c.stats.sent ?? 0}</td>
                  <td className="td tabular-nums">{c.stats.opened ?? 0}</td>
                  <td className="td tabular-nums">{c.stats.replied ?? 0}</td>
                  <td className="td text-xs text-ink-400">{fmtDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CampaignModal open={open} onClose={() => setOpen(false)} accounts={accounts} lists={lists} icps={icps} onDone={(id) => { setOpen(false); navigate(`/campaigns/${id}`); }} toast={toast} />
      <AccountsModal open={accOpen} onClose={() => setAccOpen(false)} accounts={accounts} sysAvail={sysAvail} onChanged={load} toast={toast} />
    </Page>
  );
}

function StatusBadge({ s }: { s: string }) {
  const m: Record<string, string> = { active: "bg-emerald-50 text-emerald-700", paused: "bg-amber-50 text-amber-700", draft: "bg-black/[0.05] text-ink-300", completed: "bg-brand-50 text-brand-700", replied: "bg-emerald-50 text-emerald-700", queued: "bg-black/[0.05] text-ink-300", bounced: "bg-red-50 text-red-700", unsubscribed: "bg-red-50 text-red-700", failed: "bg-red-50 text-red-700", sent: "bg-brand-50 text-brand-700", opened: "bg-emerald-50 text-emerald-700", clicked: "bg-emerald-50 text-emerald-700" };
  return <span className={`badge ${m[s] ?? "bg-black/[0.05] text-ink-300"}`}>{s}</span>;
}

function CampaignModal({ open, onClose, accounts, lists, icps, onDone, toast, existing }: { open: boolean; onClose: () => void; accounts: Account[]; lists: { id: string; name: string }[]; icps: { id: string; name: string }[]; onDone: (id: string) => void; toast: (m: string, k?: "ok" | "err") => void; existing?: Campaign }) {
  const [f, setF] = useState({ name: "", emailAccountId: "", listId: "", icpId: "", senderName: "", senderCompany: "", senderTitle: "", valueProp: "", tone: "friendly", dailyLimit: 50, timezone: "Asia/Kolkata", start: "09:00", end: "18:00" });
  const [steps, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (existing) {
      const s = existing.settings as Record<string, string | number | { start: string; end: string }>;
      setF({ name: existing.name, emailAccountId: existing.emailAccountId ?? "", listId: existing.listId ?? "", icpId: existing.icpId ?? "", senderName: String(s.senderName ?? ""), senderCompany: String(s.senderCompany ?? ""), senderTitle: String(s.senderTitle ?? ""), valueProp: String(s.valueProp ?? ""), tone: String(s.tone ?? "friendly"), dailyLimit: Number(s.dailyLimit ?? 50), timezone: String(s.timezone ?? "Asia/Kolkata"), start: (s.sendWindow as { start: string })?.start ?? "09:00", end: (s.sendWindow as { end: string })?.end ?? "18:00" });
      setSteps(existing.steps?.length ? existing.steps : DEFAULT_STEPS);
    } else if (accounts[0] && !f.emailAccountId) setF((x) => ({ ...x, emailAccountId: accounts[0].id }));
  }, [existing, accounts]); // eslint-disable-line
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, emailAccountId: f.emailAccountId || undefined, listId: f.listId || undefined, icpId: f.icpId || undefined, settings: { senderName: f.senderName, senderCompany: f.senderCompany, senderTitle: f.senderTitle, valueProp: f.valueProp, tone: f.tone, dailyLimit: f.dailyLimit, timezone: f.timezone, sendWindow: { start: f.start, end: f.end, days: [1, 2, 3, 4, 5] } }, steps };
      const r = existing ? await apiFetch<{ id: string }>("PATCH", `/v1/campaigns/${existing.id}`, body) : await apiFetch<{ id: string }>("POST", "/v1/campaigns", body);
      toast("Campaign saved");
      onDone(r.id);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? "Edit campaign" : "New campaign"} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="label">Sender account</label><select className="input" value={f.emailAccountId} onChange={(e) => setF({ ...f, emailAccountId: e.target.value })}><option value="">Select…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.fromName} &lt;{a.fromEmail}&gt; ({a.provider})</option>)}</select></div>
          <div><label className="label">Lead list (for enrolment)</label><select className="input" value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}><option value="">None</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div><label className="label">Your name (for LinkedIn/WhatsApp steps)</label><input className="input" value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} /></div>
          <div><label className="label">Your company</label><input className="input" value={f.senderCompany} onChange={(e) => setF({ ...f, senderCompany: e.target.value })} /></div>
          <div><label className="label">Your title</label><input className="input" value={f.senderTitle} onChange={(e) => setF({ ...f, senderTitle: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label">Value proposition (AI uses this to personalize)</label><textarea className="input h-16" value={f.valueProp} onChange={(e) => setF({ ...f, valueProp: e.target.value })} placeholder="We help D2C brands automate order ops and cut support cost 40% in 30 days." /></div>
          <div><label className="label">Tone</label><select className="input" value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>{["friendly", "direct", "formal", "casual"].map((t) => <option key={t}>{t}</option>)}</select></div>
          <div><label className="label">Daily limit</label><input type="number" className="input" value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} /></div>
          <div><label className="label">Timezone</label><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></div>
          <div className="flex gap-2"><div className="flex-1"><label className="label">Window start</label><input className="input" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div><div className="flex-1"><label className="label">End</label><input className="input" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div></div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><div className="label mb-0">Sequence steps</div><button className="btn-secondary" onClick={() => setSteps([...steps, { delayDays: 3, subjectTemplate: "Re: ", bodyTemplate: "", aiPersonalize: true }])}>+ Step</button></div>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="rounded-lg border border-black/10 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium">Step {i + 1}</span>
                  <select className="input w-44 py-1" value={s.channel ?? "email"} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, channel: e.target.value } : x)))}><option value="email">Email</option><option value="linkedin_connect">LinkedIn connect (task)</option><option value="linkedin_message">LinkedIn message (task)</option><option value="whatsapp">WhatsApp</option><option value="call">Call (task)</option><option value="task">Custom task</option></select>
                  {i > 0 && <label className="flex items-center gap-1">wait <input type="number" className="input w-16" value={s.delayDays} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, delayDays: Number(e.target.value) } : x)))} /> days</label>}
                  <label className="flex items-center gap-1"><input type="checkbox" checked={s.aiPersonalize} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, aiPersonalize: e.target.checked } : x)))} /> AI personalize</label>
                  <button className="ml-auto text-red-600" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>
                </div>
                {(s.channel ?? "email") === "email" && <input className="input mb-2" placeholder="Subject" value={s.subjectTemplate} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, subjectTemplate: e.target.value } : x)))} />}
                <textarea className="input h-24 font-mono text-xs" placeholder="Body - use {{first_name}}, {{company}}, {{title}}, {{sender_name}}" value={s.bodyTemplate} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, bodyTemplate: e.target.value } : x)))} />
                {(s.channel ?? "email") === "email" && <div className="mt-2">
                  {(s.variants ?? []).map((v, vi) => <div key={vi} className="mb-2 rounded border border-dashed border-black/20 p-2"><div className="mb-1 flex items-center justify-between text-xs text-ink-400"><span>Variant {String.fromCharCode(66 + vi)} (A/B test)</span><button className="text-red-600" onClick={() => setSteps(steps.map((x, j) => (j === i ? { ...x, variants: (x.variants ?? []).filter((_, k) => k !== vi) } : x)))}>remove</button></div><input className="input mb-1" placeholder="Subject" value={v.subjectTemplate} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, variants: (x.variants ?? []).map((vv, k) => (k === vi ? { ...vv, subjectTemplate: e.target.value } : vv)) } : x)))} /><textarea className="input h-16 font-mono text-xs" value={v.bodyTemplate} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, variants: (x.variants ?? []).map((vv, k) => (k === vi ? { ...vv, bodyTemplate: e.target.value } : vv)) } : x)))} /></div>)}
                  {(s.variants ?? []).length < 3 && <button className="text-xs text-brand-600" onClick={() => setSteps(steps.map((x, j) => (j === i ? { ...x, variants: [...(x.variants ?? []), { subjectTemplate: "", bodyTemplate: "" }] } : x)))}>+ Add A/B variant</button>}
                </div>}
              </div>
            ))}
          </div>
        </div>
        <button className="btn-primary w-full justify-center" disabled={busy || !f.name || steps.length === 0} onClick={save}>{busy ? "Saving…" : "Save campaign"}</button>
      </div>
    </Modal>
  );
}

function AccountsModal({ open, onClose, accounts, sysAvail, onChanged, toast }: { open: boolean; onClose: () => void; accounts: Account[]; sysAvail: boolean; onChanged: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState({ provider: sysAvail ? "system" : "resend", fromName: "", fromEmail: "", replyTo: "", signature: "", dailyLimit: 50, apiKey: "", host: "", port: 587, user: "", pass: "" });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const config = f.provider === "resend" ? { apiKey: f.apiKey } : f.provider === "smtp" ? { host: f.host, port: Number(f.port), user: f.user || undefined, pass: f.pass || undefined, secure: Number(f.port) === 465 } : undefined;
      const r = await apiFetch<{ test: { ok: boolean; error?: string } }>("POST", "/v1/campaigns/email-accounts", { provider: f.provider, fromName: f.fromName, fromEmail: f.fromEmail, replyTo: f.replyTo || undefined, signature: f.signature || undefined, dailyLimit: f.dailyLimit, config });
      toast(r.test.ok ? "Sender added and verified" : `Added but connection test failed: ${r.test.error}`, r.test.ok ? "ok" : "err");
      onChanged();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Sender accounts" wide>
      <ul className="mb-4 divide-y divide-slate-100 text-sm">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2"><div>{a.fromName} &lt;{a.fromEmail}&gt; <span className="badge ml-2 bg-black/[0.05] text-ink-300">{a.provider}</span> <StatusBadge s={a.status === "active" ? "active" : "failed"} /><div className="text-xs text-ink-400">{a.sentToday}/{a.dailyLimit} sent today</div></div><button className="text-red-600" onClick={() => apiFetch("DELETE", `/v1/campaigns/email-accounts/${a.id}`).then(onChanged)}>Remove</button></li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Provider</label><select className="input" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{sysAvail && <option value="system">Platform default (free, shared)</option>}<option value="resend">Resend (3,000/mo free)</option><option value="smtp">SMTP (Brevo, Gmail, Zoho…)</option></select></div>
        <div><label className="label">Daily limit</label><input type="number" className="input" value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} /></div>
        <div><label className="label">From name</label><input className="input" value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></div>
        <div><label className="label">From email</label><input className="input" value={f.fromEmail} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></div>
        <div><label className="label">Reply-to (optional)</label><input className="input" value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} /></div>
        {f.provider === "resend" && <div><label className="label">Resend API key</label><input className="input" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></div>}
        {f.provider === "smtp" && <>
          <div><label className="label">SMTP host</label><input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp-relay.brevo.com" /></div>
          <div><label className="label">Port</label><input type="number" className="input" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></div>
          <div><label className="label">Username</label><input className="input" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></div>
          <div><label className="label">Password</label><input type="password" className="input" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} /></div>
        </>}
        <div className="sm:col-span-2"><label className="label">Signature</label><textarea className="input h-16" value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></div>
      </div>
      <button className="btn-primary mt-3 w-full justify-center" disabled={busy || !f.fromName || !f.fromEmail} onClick={add}>{busy ? "Testing…" : "Add sender"}</button>
    </Modal>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const [c, setC] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<{ messages: Record<string, number>; contacts: Record<string, number>; rates: Record<string, number>; variants?: { stepId: string | null; variant: number; sent: number; opened: number; replied: number }[] } | null>(null);
  const [contacts, setContacts] = useState<{ id: string; status: string; currentStep: number; nextSendAt: string | null; lead: { id: string; fullName: string | null; email: string | null; emailStatus: string; title: string | null; company: { name: string | null } | null } }[]>([]);
  const [messages, setMessages] = useState<{ id: string; toEmail: string; subject: string; status: string; sentAt: string | null; openedAt: string | null; repliedAt: string | null; bodyText: string; direction: string }[]>([]);
  const [tab, setTab] = useState<"contacts" | "messages">("contacts");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string; count: number }[]>([]);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const { toast, Toast } = useToast();
  const load = useCallback(() => {
    if (!id) return;
    apiFetch<Campaign>("GET", `/v1/campaigns/${id}`).then(setC);
    apiFetch<typeof stats>("GET", `/v1/campaigns/${id}/stats`).then(setStats);
    apiFetch<{ contacts: typeof contacts }>("GET", `/v1/campaigns/${id}/contacts`).then((r) => setContacts(r.contacts));
    apiFetch<{ messages: typeof messages }>("GET", `/v1/campaigns/${id}/messages`).then((r) => setMessages(r.messages));
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    apiFetch<{ emailAccounts: Account[] }>("GET", "/v1/campaigns/email-accounts").then((r) => setAccounts(r.emailAccounts));
    apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(r.lists));
    apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(r.icps));
  }, []);
  if (!c) return <Page title="Campaign"><Spinner /></Page>;
  const act = (path: string) => apiFetch("POST", `/v1/campaigns/${c.id}/${path}`).then(() => { toast("Done"); load(); }).catch((e) => toast(e.message, "err"));
  return (
    <Page title={c.name} subtitle={`${c.steps?.length ?? 0} steps · ${c.contacts} contacts`} actions={<>
      <Link to="/campaigns" className="btn-secondary">← All campaigns</Link>
      <button className="btn-secondary" onClick={() => setEditOpen(true)}>Edit</button>
      <button className="btn-secondary" onClick={() => setEnrollOpen(true)}>Enroll leads</button>
      {c.status === "active" ? <button className="btn-secondary" onClick={() => act("pause")}>Pause</button> : <button className="btn-primary" onClick={() => act("start")}>Start</button>}
    </>}>
      {Toast}
      <div className="mb-4 flex items-center gap-2"><StatusBadge s={c.status} /><span className="text-sm text-ink-400">Sends only inside the send window and daily limit. Sequences stop automatically on reply or unsubscribe.</span></div>
      {stats && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-6">
          {[["Sent", stats.messages.sent], ["Opened", stats.messages.opened, stats.rates.open], ["Clicked", stats.messages.clicked, stats.rates.click], ["Replied", stats.messages.replied, stats.rates.reply], ["Bounced", stats.messages.bounced], ["Failed", stats.messages.failed]].map(([l, v, r]) => (
            <div key={String(l)} className="card p-3"><div className="text-xs uppercase text-ink-400">{l}</div><div className="text-xl font-semibold">{v ?? 0}{r !== undefined && <span className="ml-1 text-xs font-normal text-ink-400">{Math.round(Number(r) * 100)}%</span>}</div></div>
          ))}
        </div>
      )}
      {stats?.variants && stats.variants.length > 1 && <div className="card mb-4 p-3 text-sm"><div className="mb-1 font-medium">A/B results</div><div className="flex flex-wrap gap-3">{stats.variants.map((v, i) => <div key={i} className="rounded-lg bg-cream px-3 py-2 text-xs">Step {(c.steps ?? []).findIndex((st) => (st as unknown as { id: string }).id === v.stepId) + 1 || "?"} · Variant {String.fromCharCode(65 + v.variant)}: {v.sent} sent · {v.sent ? Math.round((v.opened / v.sent) * 100) : 0}% open · {v.sent ? Math.round((v.replied / v.sent) * 100) : 0}% reply</div>)}</div></div>}
      <div className="mb-3 flex gap-2 border-b border-black/10">{(["contacts", "messages"] as const).map((t) => <button key={t} className={`px-3 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400"}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "contacts" ? (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="border-b border-black/10 bg-cream"><tr><th className="th">Lead</th><th className="th">Email</th><th className="th">Status</th><th className="th">Step</th><th className="th">Next send</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map((x) => (
                <tr key={x.id}>
                  <td className="td"><div className="font-medium">{x.lead.fullName}</div><div className="text-xs text-ink-400">{x.lead.title} · {x.lead.company?.name}</div></td>
                  <td className="td">{x.lead.email} <EmailStatusBadge status={x.lead.emailStatus} /></td>
                  <td className="td"><StatusBadge s={x.status} /></td>
                  <td className="td tabular-nums">{x.currentStep}/{c.steps?.length ?? 0}</td>
                  <td className="td text-xs text-ink-400">{fmtDate(x.nextSendAt)}</td>
                  <td className="td text-right"><button className="text-brand-600 hover:underline" onClick={() => apiFetch<{ subject: string; body: string }>("POST", `/v1/campaigns/${c.id}/preview`, { leadId: x.lead.id, stepNo: Math.min((c.steps?.length ?? 1), x.currentStep + 1) }).then(setPreview).catch((e) => toast(e.message, "err"))}>Preview</button></td>
                </tr>
              ))}
              {contacts.length === 0 && <tr><td colSpan={6} className="td py-8 text-center text-ink-400">No contacts enrolled. Use "Enroll leads".</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {messages.map((m) => (
            <details key={m.id} className="p-3">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"><StatusBadge s={m.status} /><span className="font-medium">{m.subject}</span><span className="text-ink-400">{m.direction === "inbound" ? "from" : "to"} {m.toEmail}</span><span className="ml-auto text-xs text-ink-500">{fmtDate(m.sentAt)}{m.openedAt && " · opened"}{m.repliedAt && " · replied"}</span></summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-200">{m.bodyText}</pre>
            </details>
          ))}
          {messages.length === 0 && <div className="p-8 text-center text-sm text-ink-400">No messages yet.</div>}
        </div>
      )}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.subject ?? ""}><pre className="whitespace-pre-wrap font-sans text-sm">{preview?.body}</pre></Modal>
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} campaign={c} lists={lists} onDone={() => { setEnrollOpen(false); load(); }} toast={toast} />
      <CampaignModal open={editOpen} onClose={() => setEditOpen(false)} accounts={accounts} lists={lists} icps={icps} existing={c} onDone={() => { setEditOpen(false); load(); }} toast={toast} />
    </Page>
  );
}

function EnrollModal({ open, onClose, campaign, lists, onDone, toast }: { open: boolean; onClose: () => void; campaign: Campaign; lists: { id: string; name: string; count: number }[]; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [mode, setMode] = useState<"list" | "score">("list");
  const [minScore, setMinScore] = useState(60);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<{ enrolled: number; skippedNoEmail: number }>("POST", `/v1/campaigns/${campaign.id}/enroll`, mode === "list" ? { fromList: true } : { minScore });
      toast(`Enrolled ${r.enrolled} leads${r.skippedNoEmail ? ` (${r.skippedNoEmail} skipped: no valid email)` : ""}`);
      onDone();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const list = lists.find((l) => l.id === campaign.listId);
  return (
    <Modal open={open} onClose={onClose} title="Enroll leads">
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "list"} onChange={() => setMode("list")} /> Everyone in the campaign's list {list ? `(${list.name}, ${list.count})` : "(no list attached - edit campaign)"}</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "score"} onChange={() => setMode("score")} /> All leads with ICP score ≥ <input type="number" className="input w-20" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
        <p className="text-xs text-ink-400">Only leads with a non-invalid email are enrolled. Suppressed/unsubscribed addresses are always skipped.</p>
        <button className="btn-primary w-full justify-center" disabled={busy || (mode === "list" && !list)} onClick={go}>{busy ? "Enrolling…" : "Enroll"}</button>
      </div>
    </Modal>
  );
}
