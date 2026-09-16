import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Empty, Modal, Page, TagInput, useToast } from "../components/ui";

interface Icp { id: string; name: string; description: string | null; criteria: Record<string, string[] | undefined>; seedDomains: string[]; aiProfile: { summary?: string; searchQueries?: string[] } | null; chatHistory: { role: "user" | "assistant"; content: string }[]; leadCount: number; createdAt: string }

const FIELDS: [keyof Icp["criteria"] & string, string, string][] = [
  ["titles", "Job titles", "Head of Sales, CTO…"],
  ["seniorities", "Seniorities", "c_level, vp, director, manager"],
  ["industries", "Industries", "fintech, logistics…"],
  ["companySizes", "Company sizes", "11-50, 51-200…"],
  ["locations", "Locations", "Bengaluru, Mumbai…"],
  ["keywords", "Keywords (boost)", "B2B, SaaS…"],
  ["excludeKeywords", "Exclude keywords", "intern, student…"],
  ["techStack", "Tech stack", "Shopify, HubSpot…"],
];

export function IcpPage() {
  const [icps, setIcps] = useState<Icp[]>([]);
  const [edit, setEdit] = useState<Partial<Icp> | null>(null);
  const [chatIcp, setChatIcp] = useState<Icp | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast, Toast } = useToast();
  const load = () => apiFetch<{ icps: Icp[] }>("GET", "/v1/icps").then((r) => setIcps(r.icps));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = { name: edit.name, description: edit.description, criteria: edit.criteria ?? {}, seedDomains: edit.seedDomains ?? [], buildWithAi: true };
      if (edit.id) await apiFetch("PATCH", `/v1/icps/${edit.id}`, body);
      else await apiFetch("POST", "/v1/icps", body);
      toast(edit.id ? "Saved" : "ICP created - AI is building the lookalike profile");
      setEdit(null);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const score = async (icp: Icp) => {
    try {
      const r = await apiFetch<{ scored: unknown[] }>("POST", `/v1/icps/${icp.id}/score`, { assign: true, aiRerankTop: 20 });
      toast(`Scored ${r.scored.length} leads against "${icp.name}"`);
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  return (
    <Page title="Ideal customer profiles" subtitle="Describe your best customers (or give example domains) and Scout builds lookalike criteria to score every lead." actions={<button className="btn-primary" onClick={() => setEdit({ criteria: {}, seedDomains: [] })}>New ICP</button>}>
      {Toast}
      <IcpLearningPanel />
      {icps.length === 0 ? <Empty title="No ICPs yet" hint="Create one from a description like 'B2B SaaS founders in India with 20-200 employees' or from 3-5 of your best customers' websites." action={<button className="btn-primary" onClick={() => setEdit({ criteria: {}, seedDomains: [] })}>Create ICP</button>} /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {icps.map((i) => (
            <div key={i.id} className="card p-5">
              <div className="flex items-start justify-between gap-2">
                <div><div className="font-semibold">{i.name}</div><div className="text-xs text-ink-400">{i.leadCount} leads assigned</div></div>
                <div className="flex gap-2"><button className="btn-secondary" onClick={() => score(i)}>Score leads</button><button className="btn-secondary" onClick={() => setChatIcp(i)}>Chat</button><button className="btn-secondary" onClick={() => setEdit(i)}>Edit</button></div>
              </div>
              {i.aiProfile?.summary ? <p className="mt-3 text-sm text-ink-300">{i.aiProfile.summary}</p> : i.description ? <p className="mt-3 text-sm text-ink-300">{i.description}</p> : null}
              <div className="mt-3 space-y-1 text-xs">
                {FIELDS.filter(([k]) => i.criteria[k]?.length).map(([k, label]) => (
                  <div key={k} className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-ink-400">{label}</span>{i.criteria[k]!.map((v) => <span key={v} className="badge bg-black/[0.05] text-ink-200">{v}</span>)}</div>
                ))}
                {i.seedDomains.length > 0 && <div className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-ink-400">Seed customers</span>{i.seedDomains.map((v) => <span key={v} className="badge bg-brand-50 text-brand-700">{v}</span>)}</div>}
              </div>
              {!i.aiProfile && (i.description || i.seedDomains.length > 0) && <div className="mt-3 text-xs text-amber-600">AI profile building… (needs an AI key configured on the server; otherwise your manual criteria are used as-is)</div>}
            </div>
          ))}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit ICP" : "New ICP"} wide>
        {edit && (
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">Describe your best customers (AI turns this into criteria)</label><textarea className="input h-20" value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="e.g. Founders and heads of ops at Indian D2C brands doing ₹5-50Cr revenue who run on Shopify and need automation" /></div>
            <div><label className="label">Seed customer domains (optional)</label><TagInput value={edit.seedDomains ?? []} onChange={(v) => setEdit({ ...edit, seedDomains: v })} placeholder="bestcustomer.com" /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map(([k, label, ph]) => (
                <div key={k}><label className="label">{label}</label><TagInput value={edit.criteria?.[k] ?? []} onChange={(v) => setEdit({ ...edit, criteria: { ...(edit.criteria ?? {}), [k]: v } })} placeholder={ph} /></div>
              ))}
            </div>
            <button className="btn-primary w-full justify-center" disabled={busy || !edit.name} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          </div>
        )}
      </Modal>
      <IcpChatModal icp={chatIcp} onClose={() => setChatIcp(null)} onUpdated={(next) => { setChatIcp(next); load(); }} />
    </Page>
  );
}

interface Insight { attribute: string; value: string; n: number; positives: number; rate: number; lift: number; direction: "outperforms" | "underperforms"; reason: string }
interface Learning { sampleSize: number; positives: number; baseline: number; sufficient: boolean; insights: Insight[]; suggestions: { add: Record<string, string[]>; avoid: Record<string, string[]> }; summary: string }

const ATTR_LABEL: Record<string, string> = { seniority: "Seniority", department: "Department", industry: "Industry", companySize: "Company size", country: "Country", emailStatus: "Email status" };

/**
 * The declared ICP vs the one the reply data implies. Shown above the ICPs themselves
 * because it is the evidence you would want before editing them.
 */
function IcpLearningPanel() {
  const [d, setD] = useState<Learning | null>(null);
  useEffect(() => { apiFetch<Learning>("GET", "/v1/analytics/icp-learning").then(setD).catch(() => setD(null)); }, []);
  if (!d) return null;
  return (
    <div className="card mb-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">What's actually working</div>
          <div className="text-xs text-ink-400">Learned from who really replied, not from what the ICP claims. Updates as you send.</div>
        </div>
        {d.sufficient && <span className="badge bg-black/[0.05] text-ink-300">{d.sampleSize} contacted · {d.positives} positive · {Math.round(d.baseline * 100)}% baseline</span>}
      </div>
      <p className="mt-3 text-sm text-ink-300">{d.summary}</p>
      {d.sufficient && d.insights.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {d.insights.slice(0, 6).map((i) => (
            <div key={`${i.attribute}:${i.value}`} className="rounded-lg border border-black/10 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-medium">{i.value}</div>
                <span className={`badge ${i.direction === "outperforms" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                  {i.direction === "outperforms" ? `${i.lift.toFixed(1)}x` : "low"}
                </span>
              </div>
              <div className="text-xs text-ink-400">{ATTR_LABEL[i.attribute] ?? i.attribute}</div>
              <div className="mt-1 text-xs text-ink-300">{i.positives}/{i.n} replied ({Math.round(i.rate * 100)}%)</div>
            </div>
          ))}
        </div>
      )}
      {d.sufficient && (Object.keys(d.suggestions.add).length > 0 || Object.keys(d.suggestions.avoid).length > 0) && (
        <div className="mt-3 space-y-1 text-xs">
          {Object.entries(d.suggestions.add).map(([k, vs]) => (
            <div key={`a${k}`} className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-emerald-700">Lean into</span><span className="text-ink-400">{ATTR_LABEL[k] ?? k}:</span>{vs.map((v) => <span key={v} className="badge bg-emerald-50 text-emerald-700">{v}</span>)}</div>
          ))}
          {Object.entries(d.suggestions.avoid).map(([k, vs]) => (
            <div key={`v${k}`} className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-red-700">Cut back</span><span className="text-ink-400">{ATTR_LABEL[k] ?? k}:</span>{vs.map((v) => <span key={v} className="badge bg-red-50 text-red-700">{v}</span>)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function IcpChatModal({ icp, onClose, onUpdated }: { icp: Icp | null; onClose: () => void; onUpdated: (icp: Icp) => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, Toast } = useToast();
  if (!icp) return null;
  const send = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ reply: string; criteria: Icp["criteria"]; chatHistory: Icp["chatHistory"] }>("POST", `/v1/icps/${icp.id}/chat`, { message });
      setMessage("");
      onUpdated({ ...icp, criteria: r.criteria, chatHistory: r.chatHistory });
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!icp} onClose={onClose} title={`Refine "${icp.name}" with AI`} wide>
      {Toast}
      <p className="mb-3 text-sm text-ink-300">Chat about who you want to target - the assistant proposes updates to your criteria as you go.</p>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg bg-cream p-3">
        {icp.chatHistory.length === 0 && <div className="text-sm text-ink-400">Say something like "focus more on fintech companies under 50 people" to get started.</div>}
        {icp.chatHistory.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <span className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-brand-600 text-white" : "bg-white text-ink-200"}`}>{m.content}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input flex-1" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && send()} placeholder="Tell the assistant how to refine this ICP…" />
        <button className="btn-primary" disabled={busy || !message.trim()} onClick={send}>{busy ? "…" : "Send"}</button>
      </div>
    </Modal>
  );
}
