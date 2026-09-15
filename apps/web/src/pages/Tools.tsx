import { useState } from "react";
import { apiFetch } from "../lib/api";
import { EmailStatusBadge, Page, useToast } from "../components/ui";

type Row = Record<string, unknown>;

export function ToolsPage() {
  const [tool, setTool] = useState<"linkedin" | "email" | "decision" | "colleagues" | "intel" | "verify" | "health">("decision");
  const [input, setInput] = useState("");
  const [extra, setExtra] = useState("");
  const [out, setOut] = useState<Row[] | Row | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast, Toast } = useToast();
  const lines = () => input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const run = async () => {
    setBusy(true);
    setOut(null);
    try {
      let r: unknown;
      if (tool === "linkedin") r = (await apiFetch<{ results: Row[] }>("POST", "/v1/tools/linkedin-to-email", { urls: lines(), save: true })).results;
      if (tool === "email") r = (await apiFetch<{ results: Row[] }>("POST", "/v1/tools/email-to-linkedin", { emails: lines() })).results;
      if (tool === "decision") r = (await apiFetch<{ people: Row[] }>("POST", "/v1/tools/decision-makers", { companyDomain: input.includes(".") ? input : undefined, companyName: input.includes(".") ? undefined : input, personas: extra ? extra.split(",").map((s) => s.trim()) : undefined })).people;
      if (tool === "colleagues") r = (await apiFetch<{ people: Row[] }>("POST", "/v1/tools/colleagues", { companyDomain: input, titles: extra ? extra.split(",").map((s) => s.trim()) : undefined, save: true })).people;
      if (tool === "intel") r = await apiFetch<Row>("POST", "/v1/tools/company-intel", { domain: input });
      if (tool === "verify") r = (await apiFetch<{ results: Row[]; summary: Row }>("POST", "/v1/tools/verify-batch", { emails: lines() })).results;
      if (tool === "health") r = await apiFetch<Row>("GET", `/v1/tools/domain-health?domain=${encodeURIComponent(input)}`);
      setOut(r as Row[] | Row);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const meta: Record<typeof tool, { label: string; ph: string; extra?: string }> = {
    decision: { label: "Decision makers at a company", ph: "razorpay.com or Razorpay", extra: "Personas (optional): CEO / Founder, Sales leader, CMO / Marketing" },
    colleagues: { label: "Colleagues at a domain", ph: "acme.com", extra: "Titles (optional): Head of Sales, CTO" },
    linkedin: { label: "LinkedIn URLs → emails", ph: "https://www.linkedin.com/in/... one per line" },
    email: { label: "Emails → LinkedIn profiles", ph: "one email per line" },
    intel: { label: "Company intelligence (hiring, news, intent)", ph: "company domain" },
    verify: { label: "Bulk email verification", ph: "one email per line (max 500)" },
    health: { label: "Sender domain health (SPF/DKIM/DMARC)", ph: "yourdomain.com" },
  };
  return (
    <Page title="Tools" subtitle="One-off enrichment and verification tools. Everything here is also available in the API and MCP server.">
      {Toast}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-1">
          <div className="space-y-1">{(Object.keys(meta) as (typeof tool)[]).map((k) => <button key={k} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${tool === k ? "bg-brand-500/10 font-medium text-brand-300" : "hover:bg-surface/5"}`} onClick={() => { setTool(k); setOut(null); }}>{meta[k].label}</button>)}</div>
        </div>
        <div className="card space-y-3 p-4 lg:col-span-2">
          <div className="font-medium">{meta[tool].label}</div>
          <textarea className="input h-28 font-mono text-xs" placeholder={meta[tool].ph} value={input} onChange={(e) => setInput(e.target.value)} />
          {meta[tool].extra && <input className="input" placeholder={meta[tool].extra} value={extra} onChange={(e) => setExtra(e.target.value)} />}
          <button className="btn-primary" disabled={busy || !input.trim()} onClick={run}>{busy ? "Working…" : "Run"}</button>
          {out && (Array.isArray(out) ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm"><thead><tr>{Object.keys(out[0] ?? {}).filter((k) => !["snippet", "raw", "checks", "person", "candidates"].includes(k)).slice(0, 8).map((k) => <th key={k} className="th">{k}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{out.map((r, i) => <tr key={i}>{Object.keys(out[0] ?? {}).filter((k) => !["snippet", "raw", "checks", "person", "candidates"].includes(k)).slice(0, 8).map((k) => <td key={k} className="td text-xs">{k === "emailStatus" || k === "status" ? <EmailStatusBadge status={String(r[k] ?? "")} /> : typeof r[k] === "object" ? JSON.stringify(r[k]) : String(r[k] ?? "")}</td>)}</tr>)}</tbody></table>
              {out.length === 0 && <div className="py-4 text-sm text-ink-400">No results (keyless search engines are rate-limited from cloud IPs; add a Brave/Google key or Apollo/Hunter for consistent results).</div>}
            </div>
          ) : <pre className="max-h-96 overflow-auto rounded-lg bg-black p-3 text-xs text-emerald-200">{JSON.stringify(out, null, 2)}</pre>)}
        </div>
      </div>
    </Page>
  );
}
