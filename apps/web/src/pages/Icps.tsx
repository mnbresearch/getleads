import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { Empty, Modal, Page, TagInput, useToast } from "../components/ui";

interface Icp { id: string; name: string; description: string | null; criteria: Record<string, string[] | undefined>; seedDomains: string[]; aiProfile: { summary?: string; searchQueries?: string[] } | null; leadCount: number; createdAt: string }

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
    <Page title="Ideal customer profiles" subtitle="Describe your best customers (or give example domains) and GetLeads builds lookalike criteria to score every lead." actions={<button className="btn-primary" onClick={() => setEdit({ criteria: {}, seedDomains: [] })}>New ICP</button>}>
      {Toast}
      {icps.length === 0 ? <Empty title="No ICPs yet" hint="Create one from a description like 'B2B SaaS founders in India with 20-200 employees' or from 3-5 of your best customers' websites." action={<button className="btn-primary" onClick={() => setEdit({ criteria: {}, seedDomains: [] })}>Create ICP</button>} /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {icps.map((i) => (
            <div key={i.id} className="card p-5">
              <div className="flex items-start justify-between gap-2">
                <div><div className="font-semibold">{i.name}</div><div className="text-xs text-slate-500">{i.leadCount} leads assigned</div></div>
                <div className="flex gap-2"><button className="btn-secondary" onClick={() => score(i)}>Score leads</button><button className="btn-secondary" onClick={() => setEdit(i)}>Edit</button></div>
              </div>
              {i.aiProfile?.summary ? <p className="mt-3 text-sm text-slate-600">{i.aiProfile.summary}</p> : i.description ? <p className="mt-3 text-sm text-slate-600">{i.description}</p> : null}
              <div className="mt-3 space-y-1 text-xs">
                {FIELDS.filter(([k]) => i.criteria[k]?.length).map(([k, label]) => (
                  <div key={k} className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-slate-500">{label}</span>{i.criteria[k]!.map((v) => <span key={v} className="badge bg-slate-100 text-slate-700">{v}</span>)}</div>
                ))}
                {i.seedDomains.length > 0 && <div className="flex flex-wrap items-baseline gap-1"><span className="w-28 shrink-0 text-slate-500">Seed customers</span>{i.seedDomains.map((v) => <span key={v} className="badge bg-brand-50 text-brand-700">{v}</span>)}</div>}
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
    </Page>
  );
}
