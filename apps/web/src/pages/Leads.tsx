import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { API_URL, apiFetch, auth, fmtDate } from "../lib/api";
import { EmailStatusBadge, Empty, Modal, Page, ScoreBar, Spinner, useToast } from "../components/ui";

interface Company { id: string; domain: string; name: string | null; industry: string | null; size: string | null; description: string | null; techStack: string[]; location: string | null; linkedinUrl: string | null; emailPattern: string | null }
interface Lead { id: string; fullName: string | null; firstName: string | null; lastName: string | null; title: string | null; seniority: string | null; email: string | null; emailStatus: string; emailConfidence: number; linkedinUrl: string | null; phone: string | null; location: string | null; score: number; scoreReasons: string[]; tags: string[]; source: string; createdAt: string; company: Company | null; custom: Record<string, unknown> }

export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Lead | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [lists, setLists] = useState<{ id: string; name: string; count: number }[]>([]);
  const { toast, Toast } = useToast();

  const q = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    v ? p.set(k, v) : p.delete(k);
    p.delete("offset");
    setParams(p);
  };
  const limit = Number(q.limit ?? 50);
  const offset = Number(q.offset ?? 0);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: q.sort ?? "created", order: q.order ?? "desc", ...Object.fromEntries(Object.entries(q).filter(([k, v]) => v && !["limit", "offset", "sort", "order"].includes(k))) });
    apiFetch<{ leads: Lead[]; total: number }>("GET", `/v1/leads?${qs}`).then((r) => { setRows(r.leads); setTotal(r.total); }).finally(() => setLoading(false));
  }, [q, limit, offset]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!detail) return; const t = setInterval(() => load(true), 4000); return () => clearInterval(t); }, [detail?.id, load]);
  // keep the open detail modal in sync with freshly loaded rows
  useEffect(() => { if (detail) { const fresh = rows.find((r) => r.id === detail.id); if (fresh && fresh !== detail) setDetail(fresh); } }, [rows]); // eslint-disable-line
  useEffect(() => { apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(r.lists)); }, []);

  const ids = [...sel];
  const bulk = async (action: string) => {
    try {
      if (action === "enrich") { await apiFetch("POST", "/v1/leads/bulk/enrich", { ids }); toast(`Enrichment queued for ${ids.length} leads`); }
      if (action === "delete") { if (!confirm(`Delete ${ids.length} leads?`)) return; await apiFetch("POST", "/v1/leads/bulk/delete", { ids }); toast("Deleted"); }
      if (action.startsWith("list:")) { await apiFetch("POST", `/v1/leads/lists/${action.slice(5)}/leads`, { ids }); toast("Added to list"); }
      if (action === "newlist") { const name = prompt("List name"); if (!name) return; const l = await apiFetch<{ id: string }>("POST", "/v1/leads/lists", { name }); await apiFetch("POST", `/v1/leads/lists/${l.id}/leads`, { ids }); toast("List created"); apiFetch<{ lists: typeof lists }>("GET", "/v1/leads/lists/all").then((r) => setLists(r.lists)); }
      if (action === "tag") { const t = prompt("Tag to add"); if (!t) return; await apiFetch("POST", "/v1/leads/bulk/tag", { ids, add: [t] }); toast("Tagged"); }
      setSel(new Set());
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const exportCsv = async () => {
    const qs = new URLSearchParams(Object.entries(q).filter(([k, v]) => v && !["limit", "offset"].includes(k)));
    const res = await fetch(`${API_URL}/v1/leads/export.csv?${qs}`, { headers: { authorization: `Bearer ${auth.token}` } });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "leads.csv";
    a.click();
  };

  return (
    <Page title="Leads" subtitle={`${total.toLocaleString()} leads`} actions={<><button className="btn-secondary" onClick={() => setImportOpen(true)}>Import CSV</button><button className="btn-secondary" onClick={exportCsv}>Export CSV</button><button className="btn-primary" onClick={() => setAddOpen(true)}>Add lead</button></>}>
      {Toast}
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <input className="input w-56" placeholder="Search name, email, title…" defaultValue={q.q ?? ""} onKeyDown={(e) => e.key === "Enter" && set("q", (e.target as HTMLInputElement).value)} />
        <select className="input w-40" value={q.emailStatus ?? ""} onChange={(e) => set("emailStatus", e.target.value)}><option value="">Any email status</option><option value="valid">valid</option><option value="catch_all">catch-all</option><option value="risky">risky</option><option value="invalid">invalid</option><option value="unknown">unknown</option></select>
        <select className="input w-40" value={q.seniority ?? ""} onChange={(e) => set("seniority", e.target.value)}><option value="">Any seniority</option>{["c_level", "vp", "director", "manager", "senior", "individual", "entry"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="input w-40" value={q.listId ?? ""} onChange={(e) => set("listId", e.target.value)}><option value="">All lists</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}</select>
        <input className="input w-28" placeholder="Min score" type="number" defaultValue={q.minScore ?? ""} onKeyDown={(e) => e.key === "Enter" && set("minScore", (e.target as HTMLInputElement).value)} />
        {q.tag && <span className="badge bg-brand-50 text-brand-700">tag: {q.tag} <button className="ml-1" onClick={() => set("tag", "")}>×</button></span>}
        <select className="input ml-auto w-40" value={`${q.sort ?? "created"}:${q.order ?? "desc"}`} onChange={(e) => { const [s, o] = e.target.value.split(":"); const p = new URLSearchParams(params); p.set("sort", s); p.set("order", o); setParams(p); }}>
          <option value="created:desc">Newest</option><option value="score:desc">Highest score</option><option value="updated:desc">Recently updated</option><option value="name:asc">Name A-Z</option>
        </select>
      </div>

      {sel.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm">
          <span className="font-medium text-brand-600">{sel.size} selected</span>
          <button className="btn-secondary" onClick={() => bulk("enrich")}>Enrich</button>
          <button className="btn-secondary" onClick={() => bulk("tag")}>Tag</button>
          <select className="input w-44" onChange={(e) => { if (e.target.value) bulk(e.target.value); e.target.value = ""; }}><option value="">Add to list…</option>{lists.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}<option value="newlist">+ New list</option></select>
          <button className="btn-danger" onClick={() => bulk("delete")}>Delete</button>
          <button className="ml-auto text-ink-400" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {loading ? <Spinner label="Loading leads…" /> : rows.length === 0 ? <Empty title="No leads match" hint="Run a search or import a CSV to get started." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="border-b border-black/10 bg-base">
              <tr>
                <th className="th w-8"><input type="checkbox" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                <th className="th">Name</th><th className="th">Company</th><th className="th">Email</th><th className="th">Score</th><th className="th">Location</th><th className="th">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((l) => (
                <tr key={l.id} className="cursor-pointer hover:bg-black/[0.05]" onClick={() => setDetail(l)}>
                  <td className="td" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(l.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(l.id) : s.delete(l.id); setSel(s); }} /></td>
                  <td className="td"><div className="font-medium">{l.fullName ?? "-"}</div><div className="text-xs text-ink-400">{l.title ?? ""}</div></td>
                  <td className="td"><div>{l.company?.name ?? l.company?.domain ?? "-"}</div><div className="text-xs text-ink-400">{l.company?.industry ?? l.company?.domain ?? ""}</div></td>
                  <td className="td">{l.email ? <div className="text-sm">{l.email}</div> : <span className="text-ink-500">-</span>}<EmailStatusBadge status={l.emailStatus} /></td>
                  <td className="td"><ScoreBar score={l.score} /></td>
                  <td className="td text-ink-300">{l.location ?? l.company?.location ?? "-"}</td>
                  <td className="td whitespace-nowrap text-xs text-ink-400">{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-black/10 px-3 py-2 text-sm text-ink-400">
            <span>{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-2">
              <button className="btn-secondary" disabled={offset === 0} onClick={() => { const p = new URLSearchParams(params); p.set("offset", String(Math.max(0, offset - limit))); setParams(p); }}>Prev</button>
              <button className="btn-secondary" disabled={offset + limit >= total} onClick={() => { const p = new URLSearchParams(params); p.set("offset", String(offset + limit)); setParams(p); }}>Next</button>
            </div>
          </div>
        </div>
      )}

      <LeadDetail lead={detail} onClose={() => setDetail(null)} onChanged={load} toast={toast} />
      <AddLeadModal open={addOpen} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); load(); }} toast={toast} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); load(); }} toast={toast} />
    </Page>
  );
}

function LeadDetail({ lead, onClose, onChanged, toast }: { lead: Lead | null; onClose: () => void; onChanged: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  useEffect(() => setDraft(null), [lead?.id]);
  if (!lead) return null;
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try { await fn(); onChanged(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); }
  };
  return (
    <Modal open={!!lead} onClose={onClose} title={lead.fullName ?? "Lead"} wide>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2 text-sm">
          <div className="text-ink-400">{lead.title}</div>
          <div><span className="text-ink-400">Email:</span> {lead.email ?? "-"} <EmailStatusBadge status={lead.emailStatus} /> <span className="text-xs text-ink-500">{Math.round((lead.emailConfidence ?? 0) * 100)}%</span></div>
          {lead.phone && <div><span className="text-ink-400">Phone:</span> {lead.phone}</div>}
          {lead.linkedinUrl && <div><a className="text-brand-600 hover:underline" href={lead.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn profile ↗</a></div>}
          <div><span className="text-ink-400">Location:</span> {lead.location ?? "-"}</div>
          <div><span className="text-ink-400">Source:</span> {lead.source}</div>
          <div className="flex flex-wrap gap-1">{lead.tags.map((t) => <span key={t} className="badge bg-black/[0.05] text-ink-300">{t}</span>)}</div>
          <div className="pt-2"><ScoreBar score={lead.score} /><ul className="mt-1 text-xs text-ink-400">{lead.scoreReasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
        </div>
        <div className="space-y-2 text-sm">
          <div className="font-medium">{lead.company?.name ?? lead.company?.domain ?? "No company"}</div>
          {lead.company && <>
            <div><a className="text-brand-600 hover:underline" href={`https://${lead.company.domain}`} target="_blank" rel="noreferrer">{lead.company.domain} ↗</a> {lead.company.linkedinUrl && <a className="ml-2 text-brand-600 hover:underline" href={lead.company.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn ↗</a>}</div>
            <div className="text-ink-300">{lead.company.description ?? ""}</div>
            <div className="text-xs text-ink-400">{[lead.company.industry, lead.company.size, lead.company.location].filter(Boolean).join(" · ")}</div>
            {lead.company.techStack?.length > 0 && <div className="flex flex-wrap gap-1">{lead.company.techStack.map((t) => <span key={t} className="badge bg-black/[0.05] text-ink-300">{t}</span>)}</div>}
            {lead.company.emailPattern && <div className="text-xs text-ink-400">Email pattern: <code>{lead.company.emailPattern}</code></div>}
          </>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-black/5 pt-4">
        <button className="btn-secondary" disabled={!!busy} onClick={() => act("enrich", () => apiFetch("POST", `/v1/leads/${lead.id}/enrich`).then(() => toast("Enrichment queued")))}>{busy === "enrich" ? "…" : "Enrich"}</button>
        <button className="btn-secondary" disabled={!!busy || !lead.email} onClick={() => act("verify", () => apiFetch("POST", `/v1/leads/${lead.id}/verify`).then(() => toast("Verified")))}>{busy === "verify" ? "…" : "Verify email"}</button>
        <button className="btn-secondary" disabled={!!busy || !lead.company} onClick={() => act("find", () => apiFetch<{ email?: string; status: string }>("POST", `/v1/leads/${lead.id}/find-email`).then((r) => toast(r.email ? `Found ${r.email} (${r.status})` : "No email found", r.email ? "ok" : "err")))}>{busy === "find" ? "…" : "Find email"}</button>
        <button className="btn-primary" disabled={!!busy} onClick={() => act("gen", async () => { const org = await apiFetch<{ org: { name: string; settings: Record<string, string> } }>("GET", "/v1/auth/me"); const r = await apiFetch<{ subject: string; body: string }>("POST", "/v1/campaigns/generate", { leadId: lead.id, sender: { name: org.org.settings.senderName ?? "", company: org.org.settings.senderCompany ?? org.org.name, valueProp: org.org.settings.valueProp ?? "We help companies like yours grow faster." } }); setDraft(r); })}>{busy === "gen" ? "Writing…" : "Draft AI email"}</button>
        <button className="btn-danger ml-auto" onClick={() => act("del", () => apiFetch("DELETE", `/v1/leads/${lead.id}`).then(onClose))}>Delete</button>
      </div>
      {draft && <div className="mt-4 rounded-lg bg-base p-3 text-sm"><div className="font-medium">{draft.subject}</div><pre className="mt-2 whitespace-pre-wrap font-sans text-ink-200">{draft.body}</pre><button className="btn-secondary mt-2" onClick={() => navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).then(() => toast("Copied"))}>Copy</button></div>}
    </Modal>
  );
}

function AddLeadModal({ open, onClose, onDone, toast }: { open: boolean; onClose: () => void; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [f, setF] = useState({ fullName: "", title: "", email: "", linkedinUrl: "", companyName: "", companyDomain: "", location: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await apiFetch("POST", "/v1/leads", Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
      toast("Lead saved");
      onDone();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add lead">
      <div className="grid gap-3 sm:grid-cols-2">
        {(["fullName", "title", "email", "linkedinUrl", "companyName", "companyDomain", "location"] as const).map((k) => (
          <div key={k} className={k === "fullName" ? "sm:col-span-2" : ""}><label className="label">{k.replace(/([A-Z])/g, " $1")}</label><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
        ))}
      </div>
      <button className="btn-primary mt-4 w-full justify-center" disabled={busy || !f.fullName} onClick={submit}>{busy ? "Saving…" : "Save lead"}</button>
    </Modal>
  );
}

function ImportModal({ open, onClose, onDone, toast }: { open: boolean; onClose: () => void; onDone: () => void; toast: (m: string, k?: "ok" | "err") => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<{ created: number; updated: number; errors: unknown[] }>("POST", "/v1/leads/import", undefined, { contentType: "text/csv", body: text });
      toast(`Imported: ${r.created} new, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} errors` : ""}`);
      onDone();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Import CSV" wide>
      <p className="mb-2 text-sm text-ink-300">Paste CSV or choose a file. Recognized headers: name / first name / last name, title, email, company, website / domain, linkedin, phone, location. Extra columns are kept as custom fields. Duplicates (by email or LinkedIn) are merged.</p>
      <input type="file" accept=".csv,text/csv" className="mb-2 text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setText); }} />
      <textarea className="input h-48 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Name,Title,Company,Website,Email\nJane Doe,VP Sales,Acme,acme.com,jane@acme.com"} />
      <button className="btn-primary mt-3 w-full justify-center" disabled={busy || !text.trim()} onClick={submit}>{busy ? "Importing…" : "Import"}</button>
    </Modal>
  );
}
