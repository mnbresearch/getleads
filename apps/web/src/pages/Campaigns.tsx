import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiFetch, expectLists, fmtDate } from "../lib/api";
import { DeleteButton, EmailStatusBadge, Empty, LoadError, Modal, Page, Spinner, useToast } from "../components/ui";
import { useMe } from "../lib/me";
import { plural } from "../lib/plural";
import { recipientLabel, recipientRemoved } from "../lib/recipient";

interface Step { id?: string; delayDays: number; channel?: string; subjectTemplate: string; bodyTemplate: string; aiPersonalize: boolean; aiInstructions?: string | null; variants?: { subjectTemplate: string; bodyTemplate: string }[] }
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
  const [params, setParams] = useSearchParams();
  // ClientDetail's "New campaign" links here with ?clientId=, so the new campaign arrives
  // already tagged to that client instead of the user having to pick it again.
  const presetClientId = params.get("clientId") ?? "";
  const [open, setOpen] = useState(!!presetClientId);
  const [accOpen, setAccOpen] = useState(false);
  const [sysAvail, setSysAvail] = useState(false);
  const { toast, Toast } = useToast();
  const navigate = useNavigate();
  // Without this the list rendered "No campaigns yet" whenever the request failed, telling
  // a customer with live campaigns that they had none.
  const [listErr, setListErr] = useState<string | null>(null);
  // Same for the sender list: a failed fetch used to read as "Add a sender account first".
  const [accErr, setAccErr] = useState<string | null>(null);
  const [refsErr, setRefsErr] = useState<string | null>(null);
  const [accLoaded, setAccLoaded] = useState(false);
  // Adding and removing sender accounts is owner/admin only on the server. Members can see
  // which senders exist (they pick one for a campaign) but are not shown buttons that can
  // only answer "Only a workspace owner or admin can do this".
  const { canManage } = useMe();
  const load = useCallback(() => {
    apiFetch<{ campaigns: Campaign[] }>("GET", "/v1/campaigns")
      .then((r) => { setRows(expectLists(r, "campaigns").campaigns); setListErr(null); })
      .catch((e) => setListErr((e as Error).message));
  }, []);
  const loadAccounts = useCallback(() => {
    apiFetch<{ emailAccounts: Account[]; systemProviderAvailable: boolean }>("GET", "/v1/campaigns/email-accounts")
      .then((r) => { setAccounts(expectLists(r, "emailAccounts").emailAccounts); setSysAvail(r.systemProviderAvailable); setAccErr(null); setAccLoaded(true); })
      .catch((e) => setAccErr((e as Error).message));
  }, []);
  const loadRefs = useCallback(() => {
    Promise.all([
      apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(expectLists(r, "lists").lists)),
      apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(expectLists(r, "icps").icps)),
    ])
      .then(() => setRefsErr(null))
      .catch((e) => setRefsErr((e as Error).message));
  }, []);
  // Only the campaign list (which carries the live stats) is polled. Re-fetching senders,
  // lists and ICPs every 8s re-rendered the create form under the user and re-filled a
  // sender select they had just cleared.
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { loadAccounts(); loadRefs(); }, [loadAccounts, loadRefs]);
  const closeCreate = () => {
    setOpen(false);
    if (presetClientId) { params.delete("clientId"); setParams(params, { replace: true }); }
  };

  return (
    <Page title="Campaigns" subtitle="AI-personalized sequences with send windows, daily limits, open/click/reply tracking and auto-stop on reply." actions={<><button className="btn-secondary" onClick={() => setAccOpen(true)}>Sender accounts ({accErr && !accLoaded ? "?" : accounts.length})</button><button className="btn-primary" onClick={() => setOpen(true)}>New campaign</button></>}>
      {Toast}
      <SendingHealthPanel />
      {accErr ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">Could not load your sender accounts: {accErr} <button className="underline" onClick={loadAccounts}>Try again</button></div>
      ) : accLoaded && accounts.length === 0 && (
        canManage
          ? <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">Add a sender account first (Resend free tier: 3,000 emails/month, or any SMTP like Brevo/Gmail). <button className="underline" onClick={() => setAccOpen(true)}>Add sender</button></div>
          : <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">This workspace has no sender account yet, so campaigns cannot send. Ask an owner or admin to add a sender.</div>
      )}
      {/* A sender whose connection test failed sends nothing, and the server refuses to
          start a campaign that uses one. Said here, before someone builds a campaign on it. */}
      <FailedSendersBanner accounts={accounts} canManage={canManage} onOpen={() => setAccOpen(true)} />
      {refsErr && <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">Could not load your lead lists and ICPs: {refsErr} <button className="underline" onClick={loadRefs}>Try again</button></div>}
      {listErr && rows.length === 0 ? <LoadError message={listErr} onRetry={load} /> : rows.length === 0 ? <Empty title="No campaigns yet" hint="Create a sequence, enroll leads from a list or by ICP score, and start sending." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="border-b border-black/10 bg-cream"><tr><th className="th">Campaign</th><th className="th">Status</th><th className="th">Contacts</th><th className="th">Sent</th><th className="th">Opened</th><th className="th">Replied</th><th className="th">Created</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-black/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open campaign ${c.name}`}
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/campaigns/${c.id}`); } }}
                >
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
      <CampaignModal open={open} onClose={closeCreate} accounts={accounts} lists={lists} icps={icps} refsErr={refsErr} initialClientId={presetClientId} onDone={(id) => { closeCreate(); navigate(`/campaigns/${id}`); }} toast={toast} />
      <AccountsModal open={accOpen} onClose={() => setAccOpen(false)} accounts={accounts} campaigns={rows} sysAvail={sysAvail} canManage={canManage} onChanged={() => { loadAccounts(); load(); }} toast={toast} />
    </Page>
  );
}

/**
 * Which senders cannot send, said once per address and in a sentence that agrees with itself.
 *
 * The old line joined one address per failed sender - the same address twice when it had been
 * added twice - and then chose "its"/"their" from the sender count while saying "Remove it"
 * regardless.
 */
export function failedSendersSentence(accounts: { fromEmail: string; status: string }[]): { text: string; many: boolean } | null {
  const failed = accounts.filter((a) => a.status !== "active");
  if (failed.length === 0) return null;
  const addrs = [...new Set(failed.map((a) => a.fromEmail.trim().toLowerCase()))];
  const many = failed.length > 1;
  if (!many) return { text: `The sender ${addrs[0]} failed its connection test and cannot send.`, many };
  if (addrs.length === 1) return { text: `${failed.length} senders using ${addrs[0]} failed their connection test and cannot send.`, many };
  return { text: `${addrs.length} senders failed their connection test and cannot send: ${addrs.join(", ")}.`, many };
}

function FailedSendersBanner({ accounts, canManage, onOpen }: { accounts: Account[]; canManage: boolean; onOpen: () => void }) {
  const s = failedSendersSentence(accounts);
  if (!s) return null;
  const it = s.many ? "them" : "it";
  return (
    <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere]" role="status">
      {s.text}{" "}
      {canManage ? <>Fix the settings and test {it} again, or remove {it} and add {it} again. <button className="underline" onClick={onOpen}>Open sender accounts</button></> : `Ask an owner or admin to fix ${it}.`}
    </div>
  );
}

interface Health { status: "ok" | "warn" | "halt"; bounceRate: number; complaintRate: number; recommendedDailyCap: number; rampDay: number | null; reasons: string[]; actions: string[] }

/**
 * Deliverability verdict per sender. A "halt" here is not advisory: the scheduler has
 * already paused the campaign, so this explains why sending stopped.
 */
function SendingHealthPanel() {
  const [rows, setRows] = useState<{ account: { id: string; fromEmail: string; dailyLimit: number }; health: Health }[]>([]);
  // A failed check used to look exactly like "all senders healthy", hiding a halt.
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { apiFetch<{ accounts: typeof rows }>("GET", "/v1/analytics/sending-health").then((r) => setRows(r.accounts ?? [])).catch((e) => setErr((e as Error).message)); }, []);
  const notable = rows.filter((r) => r.health.status !== "ok" || r.health.rampDay != null);
  if (err) return <div className="mb-4 rounded-lg border border-black/10 bg-cream p-3 text-xs text-ink-400">Could not check sender deliverability right now ({err}), so any sending pause is not shown here.</div>;
  if (notable.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {notable.map(({ account, health }) => {
        const tone = health.status === "halt" ? "border-red-300 bg-red-50 text-red-800" : health.status === "warn" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-black/10 bg-cream text-ink-300";
        const label = health.status === "halt" ? "Sending halted" : health.status === "warn" ? "Deliverability at risk" : "Warming up";
        return (
          <div key={account.id} className={`rounded-lg border p-3 text-sm ${tone}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{label} · {account.fromEmail}</span>
              <span className="text-xs">bounce {(health.bounceRate * 100).toFixed(1)}% · cap {health.recommendedDailyCap}/day{health.rampDay != null ? ` · day ${health.rampDay} of warm-up` : ""}</span>
            </div>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {health.reasons.map((r) => <li key={r}>{r}</li>)}
              {health.actions.map((a) => <li key={a} className="font-medium">{a}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({ s }: { s: string }) {
  const m: Record<string, string> = { active: "bg-emerald-50 text-emerald-700", paused: "bg-amber-50 text-amber-700", draft: "bg-black/[0.05] text-ink-300", completed: "bg-brand-50 text-brand-700", replied: "bg-emerald-50 text-emerald-700", queued: "bg-black/[0.05] text-ink-300", bounced: "bg-red-50 text-red-700", unsubscribed: "bg-red-50 text-red-700", failed: "bg-red-50 text-red-700", sent: "bg-brand-50 text-brand-700", opened: "bg-emerald-50 text-emerald-700", clicked: "bg-emerald-50 text-emerald-700" };
  return <span className={`badge ${m[s] ?? "bg-black/[0.05] text-ink-300"}`}>{s}</span>;
}

const BLANK_FORM = { name: "", clientId: "", emailAccountId: "", listId: "", icpId: "", senderName: "", senderCompany: "", senderTitle: "", valueProp: "", tone: "friendly", dailyLimit: 50, timezone: "Asia/Kolkata", start: "09:00", end: "18:00" };

/**
 * Only the fields the step editor edits, shaped for the API. GET returns steps with
 * server-side columns (aiInstructions: null, stepNo, campaignId...) and echoing them back
 * verbatim failed validation, so a campaign could not be saved without touching every step.
 * The step id goes back so the server can keep per-step history (A/B stats) attached.
 */
function stepForApi(s: Step) {
  return {
    ...(s.id ? { id: s.id } : {}),
    delayDays: s.delayDays,
    channel: s.channel ?? "email",
    subjectTemplate: s.subjectTemplate ?? "",
    bodyTemplate: s.bodyTemplate,
    aiPersonalize: s.aiPersonalize,
    aiInstructions: s.aiInstructions || undefined,
    variants: (s.variants ?? []).map((v) => ({ subjectTemplate: v.subjectTemplate, bodyTemplate: v.bodyTemplate })),
  };
}

function CampaignModal({ open, onClose, accounts, lists, icps, onDone, toast, existing, refsErr, initialClientId }: { open: boolean; onClose: () => void; accounts: Account[]; lists: { id: string; name: string }[]; icps: { id: string; name: string }[]; onDone: (id: string) => void; toast: (m: string, k?: "ok" | "err") => void; existing?: Campaign; refsErr?: string | null; initialClientId?: string }) {
  const [clientOptions, setClientOptions] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    apiFetch<{ clients: { id: string; name: string }[] }>("GET", "/v1/clients").then((r) => setClientOptions(expectLists(r, "clients").clients)).catch(() => setClientOptions([]));
  }, [open]);
  const [f, setF] = useState(BLANK_FORM);
  const [steps, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [busy, setBusy] = useState(false);
  // Seed the form once per opening. Seeding on every change of `existing` meant the detail
  // page's 6s poll (a new object each time) wiped whatever the user was typing.
  const existingRef = useRef(existing);
  existingRef.current = existing;
  const autoPickedSender = useRef(false);
  useEffect(() => {
    if (!open) return;
    autoPickedSender.current = false;
    const ex = existingRef.current;
    if (ex) {
      const s = ex.settings as Record<string, string | number | { start: string; end: string }>;
      setF({ name: ex.name, clientId: (ex as Campaign & { clientId?: string | null }).clientId ?? "", emailAccountId: ex.emailAccountId ?? "", listId: ex.listId ?? "", icpId: ex.icpId ?? "", senderName: String(s.senderName ?? ""), senderCompany: String(s.senderCompany ?? ""), senderTitle: String(s.senderTitle ?? ""), valueProp: String(s.valueProp ?? ""), tone: String(s.tone ?? "friendly"), dailyLimit: Number(s.dailyLimit ?? 50), timezone: String(s.timezone ?? "Asia/Kolkata"), start: (s.sendWindow as { start: string })?.start ?? "09:00", end: (s.sendWindow as { end: string })?.end ?? "18:00" });
      setSteps(ex.steps?.length ? ex.steps.map((x) => ({ ...x })) : DEFAULT_STEPS);
      autoPickedSender.current = true;
    } else {
      // A fresh form every time "New campaign" opens - the previous campaign's fields
      // used to still be there after saving.
      setF({ ...BLANK_FORM, clientId: initialClientId ?? "" });
      setSteps(DEFAULT_STEPS);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Default a new campaign to the first sender - once. Doing it on every render re-filled a
  // select the user had deliberately cleared.
  useEffect(() => {
    if (!open || existing || autoPickedSender.current || !accounts[0]) return;
    autoPickedSender.current = true;
    setF((x) => (x.emailAccountId ? x : { ...x, emailAccountId: accounts[0].id }));
  }, [open, existing, accounts]);
  const save = async () => {
    setBusy(true);
    try {
      // On edit, a select the user emptied is sent as null so it actually detaches. Null
      // goes only when there was something to detach, so an untouched empty field is
      // omitted as before; on create empties are always omitted.
      const detach = (was: string | null | undefined) => (existing && was ? null : undefined);
      const ex = existing as (Campaign & { clientId?: string | null }) | undefined;
      const body = { name: f.name, clientId: f.clientId || (existing ? null : undefined), emailAccountId: f.emailAccountId || detach(ex?.emailAccountId), listId: f.listId || detach(ex?.listId), icpId: f.icpId || detach(ex?.icpId), settings: { senderName: f.senderName, senderCompany: f.senderCompany, senderTitle: f.senderTitle, valueProp: f.valueProp, tone: f.tone, dailyLimit: f.dailyLimit, timezone: f.timezone, sendWindow: { start: f.start, end: f.end, days: [1, 2, 3, 4, 5] } }, steps: steps.map(stepForApi) };
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
          <div><label className="label">Sender account</label><select className="input" value={f.emailAccountId} onChange={(e) => setF({ ...f, emailAccountId: e.target.value })}><option value="">{existing ? "None (detach sender)" : "Select…"}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.fromName} &lt;{a.fromEmail}&gt; ({a.provider}){a.status !== "active" ? " - connection failed, cannot send" : ""}</option>)}</select>{accounts.some((a) => a.id === f.emailAccountId && a.status !== "active") && <p className="mt-1 text-xs text-red-700">This sender failed its connection test. The campaign will not start until the sender passes a new test (Campaigns → Sender accounts → Test again) or another sender is chosen.</p>}</div>
          {clientOptions.length > 0 && (
            <div><label className="label">For client</label><select className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">No client</option>{clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          )}
          <div><label className="label">Lead list (for enrolment)</label><select className="input" value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}><option value="">None</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div><label className="label">ICP (scores enrolment by ICP fit)</label><select className="input" value={f.icpId} onChange={(e) => setF({ ...f, icpId: e.target.value })}><option value="">None</option>{icps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
          {refsErr && <div className="text-xs text-red-700 sm:col-span-2" role="alert">Lead lists and ICPs could not be loaded ({refsErr}), so those dropdowns may be incomplete.</div>}
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
        {/* Stated, not offered: the unsubscribe link is on every email whatever a campaign's
            settings say, so a switch here would be a control that does nothing. */}
        <div className="flex items-start gap-2 rounded-lg border border-black/10 bg-black/[0.02] p-3 text-sm" data-testid="unsubscribe-always">
          <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-emerald-700" aria-hidden><path d="M7.6 13.2 4.4 10l-1.1 1.1 4.3 4.3 9.1-9.1-1.1-1.1z" /></svg>
          <div className="min-w-0">
            <div className="font-medium text-ink-50">Unsubscribe link: always included</div>
            <p className="mt-0.5 text-xs text-ink-400">Every email in this campaign ends with an unsubscribe link. It cannot be turned off. Anyone who uses it is added to your do-not-contact list and the sequence to them stops. If your workspace has a mailing address (<Link className="text-brand-600 hover:underline" to="/settings">Settings</Link>), it is shown there too.</p>
          </div>
        </div>
        <button className="btn-primary w-full justify-center" disabled={busy || !f.name || steps.length === 0} onClick={save}>{busy ? "Saving…" : "Save campaign"}</button>
      </div>
    </Modal>
  );
}

function AccountsModal({ open, onClose, accounts, campaigns = [], sysAvail, canManage = true, onChanged, toast }: { open: boolean; onClose: () => void; accounts: Account[]; campaigns?: Campaign[]; sysAvail: boolean; canManage?: boolean; onChanged: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const blank = { provider: sysAvail ? "system" : "resend", fromName: "", fromEmail: "", replyTo: "", signature: "", dailyLimit: 50, apiKey: "", host: "", port: 587, user: "", pass: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // For the platform sender the From address is the platform's, never the customer's. The
  // form shows it (when a platform sender already exists, its address is known) instead of
  // asking. Without the signed-in address to hand - it is what the request carries in that
  // field - the form falls back to asking, as before.
  const { me } = useMe();
  const myEmail = me?.user?.email || null;
  const platformForm = f.provider === "system" && !!myEmail;
  const platformAddress = accounts.find((a) => a.provider === "system")?.fromEmail ?? null;
  const [retesting, setRetesting] = useState<string | null>(null);
  // Why the last "Test again" failed, per sender - kept on the row, because the reason is
  // what tells the user which setting to fix and a toast is gone in seconds.
  const [retestErr, setRetestErr] = useState<Record<string, string>>({});
  const retest = async (a: Account) => {
    setRetesting(a.id);
    setRetestErr((m) => { const n = { ...m }; delete n[a.id]; return n; });
    try {
      const r = await apiFetch<{ emailAccount?: { status?: string }; test?: { ok?: boolean; error?: string } }>("POST", `/v1/campaigns/email-accounts/${a.id}/retest`);
      const ok = r?.test?.ok === true || (r?.test === undefined && r?.emailAccount?.status === "active");
      if (ok) toast(`${a.fromEmail} passed its connection test and can send again`);
      else {
        const why = r?.test?.error || "The connection test failed again.";
        setRetestErr((m) => ({ ...m, [a.id]: why }));
        toast(`${a.fromEmail} is still failing its connection test: ${why}`, "err");
      }
      onChanged();
    } catch (e) {
      // An older server has no retest route; say what still works instead of "Not found".
      const status = (e as { status?: number }).status;
      const said = (e as Error).message;
      const noRoute = status === 405 || (status === 404 && !/account|sender/i.test(said));
      const why = noRoute ? "Testing a sender again is not available yet. Remove this sender and add it again with working settings." : said;
      setRetestErr((m) => ({ ...m, [a.id]: why }));
      toast(why, "err");
    } finally { setRetesting(null); }
  };
  const remove = async (a: Account) => {
    // Deleting a sender detaches it from every campaign using it (the FK is ON DELETE SET
    // NULL), and those campaigns then stop sending. Say which ones before it happens.
    const using = campaigns.filter((c) => c.emailAccountId === a.id);
    const lines = [
      `Remove the sender ${a.fromEmail}?`,
      using.length
        ? `${plural(using.length, "campaign")} ${using.length === 1 ? "uses" : "use"} this sender and will be left without one (they stop sending until you pick another):\n${using.map((c) => `- ${c.name}`).join("\n")}`
        : "Any campaign using this sender will be left without one and stop sending until you pick another.",
    ];
    if (!confirm(lines.join("\n\n"))) return;
    setRemoving(a.id);
    try {
      await apiFetch("DELETE", `/v1/campaigns/email-accounts/${a.id}`);
      toast("Sender removed");
      onChanged();
    } catch (e) { toast((e as Error).message, "err"); } finally { setRemoving(null); }
  };
  const add = async () => {
    setBusy(true);
    try {
      const config = f.provider === "resend" ? { apiKey: f.apiKey } : f.provider === "smtp" ? { host: f.host, port: Number(f.port), user: f.user || undefined, pass: f.pass || undefined, secure: Number(f.port) === 465 } : undefined;
      // The platform sender always sends from the platform's own address, so the form does
      // not ask for one. The request still needs an address in that field; the person's own
      // is sent, which the server uses only to decide where replies go when no Reply-to is given.
      const fromEmail = platformForm ? myEmail! : f.fromEmail;
      const r = await apiFetch<{ test: { ok: boolean; error?: string }; emailAccount?: { fromEmail?: unknown; replyTo?: unknown } }>("POST", "/v1/campaigns/email-accounts", { provider: f.provider, fromName: f.fromName, fromEmail, replyTo: f.replyTo || undefined, signature: f.signature || undefined, dailyLimit: f.dailyLimit, config });
      const sendsFrom = typeof r.emailAccount?.fromEmail === "string" ? r.emailAccount.fromEmail : null;
      const repliesTo = typeof r.emailAccount?.replyTo === "string" ? r.emailAccount.replyTo : null;
      toast(
        !r.test.ok
          ? `Added but connection test failed: ${r.test.error}`
          : platformForm && sendsFrom
            ? `Sender added. Emails go out from ${sendsFrom}${repliesTo ? ` and replies come to ${repliesTo}` : ""}.`
            : "Sender added and verified",
        r.test.ok ? "ok" : "err",
      );
      setF(blank);
      onChanged();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Sender accounts" wide>
      <ul className="mb-4 divide-y divide-slate-100 text-sm">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              {a.fromName} &lt;{a.fromEmail}&gt; <span className="badge ml-2 bg-black/[0.05] text-ink-300">{a.provider}</span>{" "}
              {a.status === "active" ? <StatusBadge s="active" /> : <span className="badge bg-red-50 text-red-700 ring-1 ring-red-200">connection failed</span>}
              {a.status === "active"
                ? <div className="text-xs text-ink-400">{a.sentToday}/{a.dailyLimit} sent today</div>
                : <div className="text-xs text-red-700">This sender failed its connection test, so it sends nothing and a campaign using it will not start. {canManage ? "Fix the settings with your email provider, then use Test again. If the settings themselves were wrong, remove it and add it again." : "Ask an owner or admin to fix it."}</div>}
              {retestErr[a.id] && a.status !== "active" && <div className="mt-1 text-xs text-red-700" role="alert">Last test: {retestErr[a.id]}</div>}
            </div>
            {canManage && (
              <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                {a.status !== "active" && <button className="text-brand-600 hover:underline disabled:opacity-50" disabled={retesting === a.id || removing === a.id} onClick={() => retest(a)}>{retesting === a.id ? "Testing…" : "Test again"}</button>}
                <button className="text-red-600 disabled:opacity-50" disabled={removing === a.id || retesting === a.id} onClick={() => remove(a)}>{removing === a.id ? "Removing…" : "Remove"}</button>
              </div>
            )}
          </li>
        ))}
        {accounts.length === 0 && <li className="py-2 text-ink-400">No sender accounts yet.</li>}
      </ul>
      {!canManage ? (
        <p className="text-xs text-ink-400">Only owners and admins can add or remove sender accounts. Ask an owner or admin to add a sender.</p>
      ) : (<>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Provider</label><select className="input" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{sysAvail && <option value="system">Platform default (free, shared)</option>}<option value="resend">Resend (3,000/mo free)</option><option value="smtp">SMTP (Brevo, Gmail, Zoho…)</option></select></div>
        <div><label className="label">Daily limit</label><input type="number" className="input" value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} /></div>
        <div><label className="label">From name</label><input className="input" value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></div>
        {platformForm ? (
          // Not a field: whatever was typed here was replaced by the platform's address on
          // the server, so asking for it only set up a surprise.
          <div data-testid="platform-from">
            <div className="label">From email</div>
            <div className="rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 text-sm text-ink-300 [overflow-wrap:anywhere]">{platformAddress ?? "Scout's shared sending address"}</div>
            <p className="mt-1 text-xs text-ink-400">The platform sender always sends from this address - it cannot be changed. Recipients see your From name. To send from your own address, choose Resend or SMTP.</p>
          </div>
        ) : (
          <div><label className="label" htmlFor="sender-from-email">From email</label><input id="sender-from-email" className="input" type="email" autoComplete="off" value={f.fromEmail} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></div>
        )}
        <div><label className="label" htmlFor="sender-reply-to">{platformForm ? "Replies go to (optional)" : "Reply-to (optional)"}</label><input id="sender-reply-to" className="input" type="email" autoComplete="off" value={f.replyTo} placeholder={platformForm ? myEmail ?? "" : ""} onChange={(e) => setF({ ...f, replyTo: e.target.value })} />{platformForm && <p className="mt-1 text-xs text-ink-400">Must be the address of someone in this workspace. Left empty, replies come to you.</p>}</div>
        {f.provider === "resend" && <div><label className="label" htmlFor="sender-resend-key">Resend API key</label><input id="sender-resend-key" className="input" autoComplete="off" spellCheck={false} value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></div>}
        {f.provider === "smtp" && <>
          <div><label className="label">SMTP host</label><input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp-relay.brevo.com" /></div>
          <div><label className="label">Port</label><input type="number" className="input" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></div>
          <div><label className="label" htmlFor="sender-smtp-user">Username</label><input id="sender-smtp-user" className="input" autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></div>
          {/* new-password: this is the mail server's password, not the Scout one. Without it a
              password manager offers (and can silently fill) the person's Scout sign-in here. */}
          <div><label className="label" htmlFor="sender-smtp-pass">Password</label><input id="sender-smtp-pass" type="password" autoComplete="new-password" className="input" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} /></div>
        </>}
        <div className="sm:col-span-2"><label className="label">Signature</label><textarea className="input h-16" value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></div>
      </div>
      <button className="btn-primary mt-3 w-full justify-center" disabled={busy || !f.fromName || (!platformForm && !f.fromEmail)} onClick={add}>{busy ? "Testing…" : "Add sender"}</button>
      </>)}
    </Modal>
  );
}

export function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<{ messages: Record<string, number>; contacts: Record<string, number>; rates: Record<string, number>; variants?: { stepId: string | null; variant: number; sent: number; opened: number; replied: number }[] } | null>(null);
  const [contacts, setContacts] = useState<{ id: string; status: string; currentStep: number; nextSendAt: string | null; lastError?: string | null; sendFailures?: number | null; lead: { id: string; fullName: string | null; email: string | null; emailStatus: string; title: string | null; company: { name: string | null } | null } }[]>([]);
  const [messages, setMessages] = useState<{ id: string; toEmail: string | null; recipientRemoved?: boolean; subject: string; status: string; sentAt: string | null; openedAt: string | null; repliedAt: string | null; bodyText: string; direction: string; intent?: string | null; draftReply?: { subject: string; body: string } | null }[]>([]);
  const [tab, setTab] = useState<"contacts" | "messages">("contacts");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string; count: number }[]>([]);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const { toast, Toast } = useToast();
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // One error per panel: a failed contacts fetch used to read as "No contacts enrolled".
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [contactsErr, setContactsErr] = useState<string | null>(null);
  const [messagesErr, setMessagesErr] = useState<string | null>(null);
  const [refsErr, setRefsErr] = useState<string | null>(null);
  const [refsLoaded, setRefsLoaded] = useState(false);
  const load = useCallback(() => {
    if (!id) return;
    // Uncaught before, so a deleted campaign or a stale bookmark left a spinner turning
    // forever while the 6s poll silently re-failed behind it.
    apiFetch<Campaign>("GET", `/v1/campaigns/${id}`)
      .then((r) => { setC(r); setLoadErr(null); })
      .catch((e) => setLoadErr((e as Error).message));
    apiFetch<typeof stats>("GET", `/v1/campaigns/${id}/stats`).then((r) => { setStats(r); setStatsErr(null); }).catch((e) => setStatsErr((e as Error).message));
    apiFetch<{ contacts: typeof contacts }>("GET", `/v1/campaigns/${id}/contacts`).then((r) => { setContacts(expectLists(r, "contacts").contacts); setContactsErr(null); }).catch((e) => setContactsErr((e as Error).message));
    apiFetch<{ messages: typeof messages }>("GET", `/v1/campaigns/${id}/messages`).then((r) => { setMessages(expectLists(r, "messages").messages); setMessagesErr(null); }).catch((e) => setMessagesErr((e as Error).message));
  }, [id]);
  // Paused while the edit modal is open: nothing on screen behind it needs refreshing, and
  // each poll handed the form a new campaign object.
  const editingRef = useRef(false);
  editingRef.current = editOpen;
  useEffect(() => { load(); const t = setInterval(() => { if (!editingRef.current) load(); }, 6000); return () => clearInterval(t); }, [load]);
  const loadRefs = useCallback(() => {
    Promise.all([
      apiFetch<{ emailAccounts: Account[] }>("GET", "/v1/campaigns/email-accounts").then((r) => setAccounts(expectLists(r, "emailAccounts").emailAccounts)),
      apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(expectLists(r, "lists").lists)),
      apiFetch<{ icps: typeof icps }>("GET", "/v1/icps").then((r) => setIcps(expectLists(r, "icps").icps)),
    ])
      .then(() => { setRefsErr(null); setRefsLoaded(true); })
      .catch((e) => setRefsErr((e as Error).message));
  }, []);
  useEffect(() => { loadRefs(); }, [loadRefs]);
  if (loadErr && !c) {
    return (
      <Page title="Campaign" actions={<Link to="/campaigns" className="btn-secondary">← All campaigns</Link>}>
        <LoadError message={loadErr} onRetry={load} />
      </Page>
    );
  }
  if (!c) return <Page title="Campaign"><Spinner /></Page>;
  // Name the action that happened, and pass on any warning the server attached (e.g.
  // starting a campaign with nobody enrolled succeeds but will send nothing).
  //
  // A refusal is kept on the page as well as toasted. The server's reason for not starting
  // (e.g. "The sender x failed its connection test ... remove that sender and add it again")
  // is a sentence with instructions in it; a toast that leaves after a few seconds is not
  // long enough to read and act on.
  const act = (path: string, success: string) => {
    setActErr(null);
    return apiFetch<{ warning?: string }>("POST", `/v1/campaigns/${c.id}/${path}`)
      .then((r) => { toast(r?.warning ? `${success}. ${r.warning}` : success, r?.warning ? "err" : "ok"); load(); })
      .catch((e) => { toast(e.message, "err"); setActErr(e.message); });
  };
  const sender = accounts.find((a) => a.id === c.emailAccountId);
  const senderFailed = !!sender && sender.status !== "active";
  return (
    <Page title={c.name} subtitle={`${plural(c.steps?.length ?? 0, "step")} · ${plural(c.contacts, "contact")}`} actions={<>
      <Link to="/campaigns" className="btn-secondary">← All campaigns</Link>
      <button className="btn-secondary" onClick={() => setEditOpen(true)}>Edit</button>
      <button className="btn-secondary" onClick={() => setEnrollOpen(true)}>Enroll leads</button>
      {c.status === "active" ? <button className="btn-secondary" onClick={() => act("pause", "Campaign paused")}>Pause</button> : <button className="btn-primary" onClick={() => act("start", "Campaign started")}>Start</button>}
      <DeleteButton
        what={`the campaign "${c.name}"`}
        consequence={`${plural(c.contacts, "enrolled contact")} and this campaign's send history go with it. Campaigns count towards your plan limit, so a test campaign you cannot delete permanently occupies a slot.`}
        onDelete={async () => {
          await apiFetch("DELETE", `/v1/campaigns/${c.id}`);
          navigate("/campaigns");
        }}
        onError={(msg) => toast(msg, "err")}
        className="btn-secondary"
      />
    </>}>
      {Toast}
      <div className="mb-4 flex items-center gap-2"><StatusBadge s={c.status} /><span className="text-sm text-ink-400">Sends only inside the send window and daily limit. Sequences stop automatically on reply or unsubscribe.</span></div>
      {actErr && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
          <span className="min-w-0 [overflow-wrap:anywhere]">{actErr}</span>
          <button className="shrink-0 underline" onClick={() => setActErr(null)}>Dismiss</button>
        </div>
      )}
      {senderFailed && !actErr && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="status">
          The sender {sender!.fromEmail} failed its connection test, so this campaign cannot send and will not start. Fix its settings and test it again (Campaigns → Sender accounts), or choose another sender under Edit.
        </div>
      )}
      {statsErr && !stats && <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">Could not load this campaign's numbers: {statsErr} <button className="underline" onClick={load}>Try again</button></div>}
      {refsErr && <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">Could not load sender accounts, lists and ICPs ({refsErr}), so Edit and Enroll may show them as missing. <button className="underline" onClick={loadRefs}>Try again</button></div>}
      {stats && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-6">
          {[["Sent", stats.messages.sent], ["Opened", stats.messages.opened, stats.rates.open], ["Clicked", stats.messages.clicked, stats.rates.click], ["Replied", stats.messages.replied, stats.rates.reply], ["Bounced", stats.messages.bounced], ["Failed", stats.messages.failed]].map(([l, v, r]) => (
            <div key={String(l)} className="card p-3"><div className="text-xs uppercase text-ink-400">{l}</div><div className="text-xl font-semibold">{v ?? 0}{r !== undefined && <span className="ml-1 text-xs font-normal text-ink-400">{Math.round(Number(r) * 100)}%</span>}</div></div>
          ))}
        </div>
      )}
      <ExperimentsPanel campaignId={c.id} />
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto whitespace-nowrap border-b border-black/10 px-4 sm:mx-0 sm:px-0">{(["contacts", "messages"] as const).map((t) => <button key={t} className={`shrink-0 px-3 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-brand-400 font-medium text-brand-600" : "text-ink-400"}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "contacts" && contactsErr && contacts.length === 0 ? <LoadError message={contactsErr} onRetry={load} /> : tab === "messages" && messagesErr && messages.length === 0 ? <LoadError message={messagesErr} onRetry={load} /> : tab === "contacts" ? (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="border-b border-black/10 bg-cream"><tr><th className="th">Lead</th><th className="th">Email</th><th className="th">Status</th><th className="th">Step</th><th className="th">Next send</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {contacts.map((x) => (
                <tr key={x.id}>
                  <td className="td"><div className="font-medium">{x.lead.fullName || x.lead.email || "Unnamed lead"}</div><div className="text-xs text-ink-400">{[x.lead.title, x.lead.company?.name].filter(Boolean).join(" · ")}</div></td>
                  <td className="td">{x.lead.email} <EmailStatusBadge status={x.lead.emailStatus} /></td>
                  <td className="td">
                    <StatusBadge s={x.status} />
                    {/* Why a send didn't go: a bounce or a provider error is worth seeing
                        here rather than only as a "failed" badge. */}
                    {/* Shown for waiting contacts too: "sending is paused", "daily limit reached" and
                        "AI draft rejected; sent the template" are notes on a contact that is still queued. */}
                    {(x.lastError || (x.sendFailures ?? 0) > 0) && (
                      <div className={`mt-1 max-w-[240px] text-xs ${x.status === "bounced" || x.status === "failed" || (x.sendFailures ?? 0) > 0 ? "text-red-700" : "text-amber-700"}`} title={x.lastError ?? undefined}>
                        {(x.sendFailures ?? 0) > 0 && <span>{plural(x.sendFailures, "failed attempt")}{x.lastError ? ": " : ""}</span>}
                        {x.lastError && <span className="line-clamp-2">{x.lastError}</span>}
                      </div>
                    )}
                  </td>
                  <td className="td tabular-nums">{x.currentStep}/{c.steps?.length ?? 0}</td>
                  <td className="td text-xs text-ink-400">{fmtDate(x.nextSendAt)}</td>
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-3">
                      {/* A contact is stopped when a send's outcome could not be
                          established - neither resending nor moving on is safe without
                          knowing which way it went. Somebody who checks the mailbox can
                          settle it, and without this the sequence ends there permanently. */}
                      {x.status === "failed" && (
                        <>
                          <button
                            className="text-xs text-brand-600 hover:underline"
                            title="The prospect did receive it - continue to the next step"
                            onClick={() => apiFetch("POST", `/v1/campaigns/${c.id}/contacts/${x.id}/resume`, { resend: false }).then(() => { toast("Moved on to the next step"); load(); }).catch((e) => toast((e as Error).message, "err"))}
                          >
                            It arrived
                          </button>
                          <button
                            className="text-xs text-brand-600 hover:underline"
                            title="The prospect never received it - send this step again"
                            onClick={() => apiFetch("POST", `/v1/campaigns/${c.id}/contacts/${x.id}/resume`, { resend: true }).then(() => { toast("Will send that step again"); load(); }).catch((e) => toast((e as Error).message, "err"))}
                          >
                            Send again
                          </button>
                        </>
                      )}
                      <button className="text-brand-600 hover:underline" onClick={() => apiFetch<{ subject: string; body: string }>("POST", `/v1/campaigns/${c.id}/preview`, { leadId: x.lead.id, stepNo: Math.min((c.steps?.length ?? 1), x.currentStep + 1) }).then(setPreview).catch((e) => toast(e.message, "err"))}>Preview</button>
                    </div>
                  </td>
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
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <StatusBadge s={m.status} /><span className="font-medium">{m.subject}</span>
                {/* A message whose contact was deleted is kept as a record, without the person:
                    the server sends no address (an older one sent a "sha256:..." fingerprint,
                    which is never shown). */}
                <span className="text-ink-400" data-testid="message-recipient">{m.direction === "inbound" ? "from" : "to"} {recipientLabel(m)}</span>
                {m.intent && <span className="badge bg-brand-50 text-brand-700">{m.intent.replace(/_/g, " ")}</span>}
                <span className="ml-auto text-xs text-ink-500">{fmtDate(m.sentAt)}{m.openedAt && " · opened"}{m.repliedAt && " · replied"}</span>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-200">{m.bodyText}</pre>
              {/* Every inbound message can be answered from here. The box used to render only
                  when an AI draft existed, so a workspace with no AI had no way to reply at all. */}
              {recipientRemoved(m) && <p className="mt-2 text-xs text-ink-400">This contact was deleted, so the message is kept as a record only: who it was {m.direction === "inbound" ? "from" : "to"} and what it said have been removed.</p>}
              {m.direction === "inbound" && !recipientRemoved(m) && <ReplyBox message={{ ...m, toEmail: m.toEmail ?? "" }} onSent={() => { toast(`Reply sent to ${m.toEmail}`); load(); }} onFailed={load} toast={toast} />}
            </details>
          ))}
          {messages.length === 0 && <div className="p-8 text-center text-sm text-ink-400">No messages yet.</div>}
        </div>
      )}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.subject ?? ""}><pre className="whitespace-pre-wrap font-sans text-sm">{preview?.body}</pre></Modal>
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} campaign={c} lists={lists} listsLoaded={refsLoaded} onDone={() => { setEnrollOpen(false); load(); }} toast={toast} />
      <CampaignModal open={editOpen} onClose={() => setEditOpen(false)} accounts={accounts} lists={lists} icps={icps} refsErr={refsErr} existing={c} onDone={() => { setEditOpen(false); load(); }} toast={toast} />
    </Page>
  );
}

interface Experiment {
  stepId: string;
  stepNo: number;
  subjects: string[];
  result: {
    winner: number | null;
    confident: boolean;
    totalSent: number;
    summary: string;
    allocation: Record<number, number>;
    ranked: { variant: number; sent: number; positives: number; rate: number }[];
  };
}

/**
 * A/B results with an actual verdict. Raw per-variant reply rates are easy to over-read,
 * so the winner is only named once the difference is statistically separable, and the
 * traffic split in force is shown either way.
 */
function ExperimentsPanel({ campaignId }: { campaignId: string }) {
  const [rows, setRows] = useState<Experiment[]>([]);
  useEffect(() => {
    apiFetch<{ experiments: Experiment[] }>("GET", `/v1/campaigns/${campaignId}/experiments`).then((r) => setRows(r.experiments ?? [])).catch(() => setRows([]));
  }, [campaignId]);
  if (rows.length === 0) return null;
  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 font-medium">A/B results</div>
      <div className="mb-3 text-xs text-ink-400">Winners are only called once the gap is bigger than the noise. Until then traffic stays evenly split.</div>
      <div className="space-y-3">
        {rows.map((e) => (
          <div key={e.stepId} className="rounded-lg border border-black/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">Step {e.stepNo}</span>
              <span className={`badge ${e.result.confident ? "bg-emerald-50 text-emerald-700" : "bg-black/[0.05] text-ink-300"}`}>
                {e.result.confident ? `Variant ${String.fromCharCode(65 + (e.result.winner ?? 0))} wins` : "Inconclusive"}
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-300">{e.result.summary}</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {e.result.ranked.map((v) => (
                <div key={v.variant} className={`rounded-md px-3 py-2 text-xs ${e.result.confident && v.variant === e.result.winner ? "bg-emerald-50" : "bg-cream"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Variant {String.fromCharCode(65 + v.variant)}</span>
                    <span className="text-ink-400">{Math.round((e.result.allocation[v.variant] ?? 0) * 100)}% of new sends</span>
                  </div>
                  <div className="truncate text-ink-400" title={e.subjects[v.variant]}>{e.subjects[v.variant]}</div>
                  <div className="mt-0.5">{v.positives}/{v.sent} replied ({Math.round(v.rate * 100)}%)</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Re: <their subject>", without stacking a second "Re:" on a subject that already has one. */
export function replySubject(theirs: string | null | undefined): string {
  const t = (theirs ?? "").trim();
  if (!t) return "Re:";
  return /^re\s*:/i.test(t) ? t : `Re: ${t}`;
}

/**
 * Answer an inbound message.
 *
 * Starts from the AI draft when there is one (and says it is a draft), otherwise from an
 * empty body with the subject filled in. What the server refuses - no sender, a sender that
 * failed its test, sending paused, the daily limit, a suppressed address - is shown in its
 * own words and stays in the box: those are instructions, and a toast is gone before they
 * can be followed.
 */
function ReplyBox({ message, onSent, onFailed, toast }: { message: { id: string; subject: string; toEmail: string; draftReply?: { subject: string; body: string } | null }; onSent: () => void; onFailed?: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const draft = message.draftReply?.body ? message.draftReply : null;
  const [subject, setSubject] = useState(draft?.subject || replySubject(message.subject));
  const [body, setBody] = useState(draft?.body ?? "");
  const [fromDraft, setFromDraft] = useState(!!draft);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // A draft that arrives after the box was opened (the AI writes it a moment after the reply
  // lands) is offered - but never over something the user has started typing.
  useEffect(() => {
    if (!draft || touched || sent || fromDraft) return;
    setSubject(draft.subject || replySubject(message.subject));
    setBody(draft.body);
    setFromDraft(true);
  }, [draft?.subject, draft?.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiFetch("POST", `/v1/campaigns/messages/${message.id}/send-reply`, { subject: subject.trim(), body });
      setSent(true);
      setBody("");
      setTouched(false);
      setFromDraft(false);
      onSent();
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      toast(m, "err");
      // A refused or failed send can still have written a row (the attempt, marked failed) and
      // moved the Failed counter. Shown now, not at the next 6 s poll - until then the list
      // said "queued" and the counter 0, which read as "it is on its way".
      onFailed?.();
    } finally { setBusy(false); }
  };
  const fid = `reply-${message.id}`;
  return (
    <div className="mt-3 rounded-lg bg-cream p-3" data-testid="reply-box">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
        {fromDraft && !touched ? "AI-suggested reply · a draft - review before sending" : fromDraft ? "Reply · started from an AI draft" : `Reply to ${message.toEmail}`}
      </div>
      {sent && !err && <div className="mb-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-700" role="status">Reply sent to {message.toEmail}. You can send another below.</div>}
      <label className="label" htmlFor={`${fid}-subject`}>Subject</label>
      <input id={`${fid}-subject`} className="input mb-2" value={subject} maxLength={300} onChange={(e) => { setSubject(e.target.value); setTouched(true); }} />
      <label className="label" htmlFor={`${fid}-body`}>Message</label>
      <textarea id={`${fid}-body`} className="input h-28" value={body} placeholder="Write your reply…" onChange={(e) => { setBody(e.target.value); setTouched(true); setSent(false); }} />
      {err && <div className="mt-2 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800 [overflow-wrap:anywhere]" role="alert">{err}</div>}
      <button className="btn-primary mt-2" disabled={busy || !subject.trim() || !body.trim()} onClick={send}>{busy ? "Sending…" : "Send reply"}</button>
    </div>
  );
}

interface EnrollResult { enrolled: number; skippedNoEmail?: number; skippedInvalidEmail?: number; claimedForClient?: number; skippedOtherClient?: number }

/** What enrolling did, and - as loudly - what it did not do and why. */
export function enrollMessage(r: EnrollResult): string {
  const extra = [
    r.skippedNoEmail ? `${r.skippedNoEmail} skipped: no valid email` : "",
    // `skippedInvalidEmail` comes from newer servers only; absent means nothing to report.
    r.skippedInvalidEmail && r.skippedInvalidEmail > 0 ? `${r.skippedInvalidEmail} skipped: their email is not a single valid address - fix it on the lead` : "",
    r.skippedOtherClient ? `${r.skippedOtherClient} skipped: they belong to another client` : "",
    r.claimedForClient ? `${plural(r.claimedForClient, "unassigned lead")} ${r.claimedForClient === 1 ? "was" : "were"} assigned to this campaign's client` : "",
  ].filter(Boolean);
  return `Enrolled ${plural(r.enrolled, "lead")}${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

function EnrollModal({ open, onClose, campaign, lists, listsLoaded = true, onDone, toast }: { open: boolean; onClose: () => void; campaign: Campaign; lists: { id: string; name: string; count: number }[]; listsLoaded?: boolean; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [mode, setMode] = useState<"list" | "score">("list");
  const [minScore, setMinScore] = useState(60);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<EnrollResult>("POST", `/v1/campaigns/${campaign.id}/enroll`, mode === "list" ? { fromList: true } : { minScore });
      // Nobody enrolled and people skipped is not a success, whatever the status code said.
      const skippedAny = (r.skippedNoEmail ?? 0) + (r.skippedInvalidEmail ?? 0) + (r.skippedOtherClient ?? 0) > 0;
      toast(enrollMessage(r), r.enrolled === 0 && skippedAny ? "err" : "ok");
      onDone();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const list = lists.find((l) => l.id === campaign.listId);
  return (
    <Modal open={open} onClose={onClose} title="Enroll leads">
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "list"} onChange={() => setMode("list")} /> Everyone in the campaign's list {list ? `(${list.name}, ${list.count})` : campaign.listId && !listsLoaded ? "(list details could not be loaded)" : "(no list attached - edit campaign)"}</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "score"} onChange={() => setMode("score")} /> All leads with ICP score ≥ <input type="number" className="input w-20" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
        <p className="text-xs text-ink-400">Only leads with a non-invalid email are enrolled. Suppressed/unsubscribed addresses are always skipped - see the do-not-contact list on the Leads page.</p>
        <button className="btn-primary w-full justify-center" disabled={busy || (mode === "list" && !campaign.listId)} onClick={go}>{busy ? "Enrolling…" : "Enroll"}</button>
      </div>
    </Modal>
  );
}
