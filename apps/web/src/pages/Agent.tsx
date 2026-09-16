import { useState } from "react";
import { API_URL, apiFetch } from "../lib/api";
import { EmailStatusBadge, Page, ScoreBar, useToast } from "../components/ui";

interface Result { leadId?: string; name: string; title?: string; company?: string; domain?: string; email?: string; emailStatus?: string; score?: number; scoreReasons?: string[]; linkedinUrl?: string; companyDescription?: string; draftEmail?: { subject: string; body: string } }

export function AgentPage() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [gen, setGen] = useState(false);
  const [sender, setSender] = useState({ name: "", company: "", valueProp: "" });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const { toast, Toast } = useToast();
  const run = async () => {
    setBusy(true);
    setRes(null);
    const t0 = Date.now();
    try {
      const r = await apiFetch<{ leads: Result[] }>("POST", "/v1/agent/prospect", { query, limit, generateEmails: gen, sender: gen ? sender : undefined, save: true });
      setRes(r.leads);
      setElapsed(Math.round((Date.now() - t0) / 1000));
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const curl = `curl -X POST ${API_URL}/v1/agent/prospect \\
  -H "x-api-key: px_live_..." -H "content-type: application/json" \\
  -d '{"query": ${JSON.stringify(query || "CTOs at Series A SaaS startups in Pune")}, "limit": ${limit}${gen ? `, "generateEmails": true, "sender": ${JSON.stringify(sender)}` : ""}}'`;
  return (
    <Page title="Agent console" subtitle="The same single-call workflow your AI agents use: describe → discover → enrich → verify → score → (draft). Also available as an MCP server.">
      {Toast}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-5 lg:col-span-2">
          <div><label className="label">Who do you want?</label><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Founders of D2C skincare brands in Mumbai using Shopify" onKeyDown={(e) => e.key === "Enter" && query && run()} /></div>
          <div className="flex flex-wrap items-end gap-3">
            <div><label className="label">Results</label><input type="number" className="input w-20" min={1} max={10} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></div>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={gen} onChange={(e) => setGen(e.target.checked)} /> Draft a personalized email per lead</label>
            <button className="btn-primary ml-auto" onClick={run} disabled={busy || !query}>{busy ? "Working (5-40s)…" : "Run"}</button>
          </div>
          {gen && <div className="grid gap-2 sm:grid-cols-3"><input className="input" placeholder="Your name" value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} /><input className="input" placeholder="Your company" value={sender.company} onChange={(e) => setSender({ ...sender, company: e.target.value })} /><input className="input" placeholder="Value proposition" value={sender.valueProp} onChange={(e) => setSender({ ...sender, valueProp: e.target.value })} /></div>}
        </div>
        <div className="card p-4"><div className="label">Equivalent API call</div><pre className="overflow-x-auto rounded-lg bg-black p-3 text-[11px] leading-relaxed text-emerald-800">{curl}</pre><div className="mt-2 text-xs text-ink-400">MCP: <code>npx @prospex/mcp</code> with <code>PROSPEX_API_KEY</code>. Docs at <a className="text-brand-600" href={`${API_URL}/docs`} target="_blank" rel="noreferrer">{API_URL}/docs</a></div></div>
      </div>
      {res && (
        <div className="mt-6">
          <div className="mb-2 text-sm text-ink-400">{res.length} leads in {elapsed}s · saved to your Leads (tag: agent)</div>
          <div className="grid gap-3 md:grid-cols-2">
            {res.map((r, i) => (
              <div key={i} className="card p-4">
                <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{r.name}</div><div className="text-sm text-ink-300">{r.title} {r.company && <>· {r.company}</>}</div></div><ScoreBar score={r.score} /></div>
                <div className="mt-2 text-sm">{r.email ? <>{r.email} <EmailStatusBadge status={r.emailStatus} /></> : <span className="text-ink-500">no email found</span>}</div>
                {r.linkedinUrl && <a className="text-xs text-brand-600" href={r.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn ↗</a>}
                {r.companyDescription && <p className="mt-2 line-clamp-2 text-xs text-ink-400">{r.companyDescription}</p>}
                {r.draftEmail && <div className="mt-3 rounded-lg bg-cream p-3 text-xs"><div className="font-medium">{r.draftEmail.subject}</div><pre className="mt-1 whitespace-pre-wrap font-sans">{r.draftEmail.body}</pre></div>}
              </div>
            ))}
            {res.length === 0 && <div className="card p-6 text-sm text-ink-400 md:col-span-2">No results. From datacenter IPs the keyless engines are often blocked; add a free Brave Search API key (2,000 queries/month) or Google CSE key in the server .env for reliable discovery.</div>}
          </div>
        </div>
      )}
    </Page>
  );
}
