import { useState } from "react";
import { API_URL, apiFetch } from "../lib/api";
import { EmailStatusBadge, Page, ScoreBar, useToast } from "../components/ui";
import { ExtLink } from "../components/ExtLink";

interface Result { leadId?: string; name: string; title?: string; company?: string; domain?: string; email?: string; emailStatus?: string; score?: number; scoreReasons?: string[]; linkedinUrl?: string; companyDescription?: string; draftEmail?: { subject: string; body: string } }

interface AgentResponse {
  leads: Result[];
  skipped?: { saving?: string; drafting?: string };
  note?: string;
  notes?: string[];
  error?: string;
  providerFailures?: ({ provider?: string; message?: string } | string)[];
}

/** Collect every explanation the API attached, de-duplicated, in the order given. */
function explain(r: AgentResponse): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === "string" && v.trim() && !out.includes(v.trim())) out.push(v.trim()); };
  add(r.error);
  add(r.note);
  (r.notes ?? []).forEach(add);
  for (const f of r.providerFailures ?? []) {
    if (typeof f === "string") add(f);
    else if (f && f.message) add(f.provider ? `${f.provider}: ${f.message}` : f.message);
  }
  return out;
}

export function AgentPage() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [gen, setGen] = useState(false);
  const [sender, setSender] = useState({ name: "", company: "", valueProp: "" });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [skipped, setSkipped] = useState<{ saving?: string; drafting?: string } | null>(null);
  // Why a run came back the way it did, as the server explains it. Shown instead of a
  // guessed cause, so "nothing matched" and "the search engines failed" never look alike.
  const [reasons, setReasons] = useState<string[]>([]);
  const { toast, Toast } = useToast();
  const run = async () => {
    setBusy(true);
    setRes(null);
    const t0 = Date.now();
    try {
      const r = await apiFetch<AgentResponse>("POST", "/v1/agent/prospect", { query, limit, generateEmails: gen, sender: gen ? sender : undefined, save: true });
      setRes(r.leads);
      setSkipped(r.skipped ?? null);
      setReasons(explain(r));
      setElapsed(Math.round((Date.now() - t0) / 1000));
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const curl = `curl -X POST ${API_URL}/v1/agent/prospect \\
  -H "x-api-key: px_live_..." -H "content-type: application/json" \\
  -d '{"query": ${JSON.stringify(query || "CTOs at Series A SaaS startups in Pune")}, "limit": ${limit}${gen ? `, "generateEmails": true, "sender": ${JSON.stringify(sender)}` : ""}}'`;
  return (
    <Page title="Agent console" subtitle="The same single-call workflow your AI agents use: describe → discover → enrich → verify → score → (draft). Also available as an MCP server.">
      {Toast}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-5 lg:col-span-2">
          <div><label className="label">Who do you want?</label><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Founders of D2C skincare brands in Mumbai using Shopify" onKeyDown={(e) => e.key === "Enter" && query && run()} /></div>
          <div className="flex flex-wrap items-end gap-3">
            <div><label className="label">Results</label><input type="number" className="input w-20" min={1} max={10} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></div>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={gen} onChange={(e) => setGen(e.target.checked)} /> Draft a personalized email per lead</label>
            <button className="btn-primary ml-auto" onClick={run} disabled={busy || !query}>{busy ? "Working (5-40s)…" : "Run"}</button>
          </div>
          {gen && <div className="grid gap-2 sm:grid-cols-3"><input className="input" placeholder="Your name" value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} /><input className="input" placeholder="Your company" value={sender.company} onChange={(e) => setSender({ ...sender, company: e.target.value })} /><input className="input" placeholder="Value proposition" value={sender.valueProp} onChange={(e) => setSender({ ...sender, valueProp: e.target.value })} /></div>}
        </div>
        <div className="card min-w-0 p-4"><div className="label">Equivalent API call</div><pre className="max-w-full overflow-x-auto rounded-lg bg-black p-3 text-[11px] leading-relaxed text-emerald-800">{curl}</pre><div className="mt-2 text-xs text-ink-400 [overflow-wrap:anywhere]">MCP: <code>npx @prospex/mcp</code> with <code>PROSPEX_API_KEY</code>. Docs at <a className="text-brand-600" href={`${API_URL}/docs`} target="_blank" rel="noopener noreferrer">{API_URL}/docs</a></div></div>
      </div>
      {res && (
        <div className="mt-6">
          {/* "Saved" is only claimed for leads that actually came back with a leadId; a quota
              stop or a fault mid-run is said out loud instead of hidden behind the count. */}
          <div className="mb-2 text-sm text-ink-400">
            {res.length} leads in {elapsed}s
            {res.length > 0 && (() => {
              const saved = res.filter((r) => r.leadId).length;
              return saved === res.length ? " · saved to your Leads (tag: agent)" : ` · ${saved} of ${res.length} saved to your Leads (tag: agent)`;
            })()}
          </div>
          {skipped && (skipped.saving || skipped.drafting) && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="status">
              {skipped.saving && <div>Not all leads were saved: {skipped.saving}</div>}
              {skipped.drafting && <div>Not all emails were drafted: {skipped.drafting}</div>}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {res.map((r, i) => (
              <div key={i} className="card min-w-0 p-4 [overflow-wrap:anywhere]">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-semibold">{r.name}</div><div className="text-sm text-ink-300">{r.title} {r.company && <>· {r.company}</>}</div></div><ScoreBar score={r.score} /></div>
                <div className="mt-2 text-sm">{r.email ? <>{r.email} <EmailStatusBadge status={r.emailStatus} /></> : <span className="text-ink-500">no email found</span>}</div>
                <ExtLink className="text-xs text-brand-600" href={r.linkedinUrl}>LinkedIn ↗</ExtLink>
                {r.companyDescription && <p className="mt-2 line-clamp-2 text-xs text-ink-400">{r.companyDescription}</p>}
                {r.draftEmail && <div className="mt-3 rounded-lg bg-cream p-3 text-xs"><div className="font-medium">{r.draftEmail.subject}</div><pre className="mt-1 whitespace-pre-wrap font-sans">{r.draftEmail.body}</pre></div>}
              </div>
            ))}
            {res.length === 0 && (
              <div className="card p-6 text-sm text-ink-400 md:col-span-2 [overflow-wrap:anywhere]">
                {reasons.length === 0 ? "No matching people found for this request." : (
                  <>
                    <div className="font-medium text-ink-200">No results for this request.</div>
                    <ul className="mt-1 list-inside list-disc">{reasons.map((m, i) => <li key={i}>{m}</li>)}</ul>
                  </>
                )}
              </div>
            )}
            {res.length > 0 && reasons.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 md:col-span-2 [overflow-wrap:anywhere]" role="status">
                <ul className="list-inside list-disc">{reasons.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
