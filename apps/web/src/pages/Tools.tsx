import { useState } from "react";
import { apiFetch } from "../lib/api";
import { EmailStatusBadge, Page, useToast } from "../components/ui";
import { CompanyIntelView, DomainHealthView } from "../components/ToolResults";
import { ExtLink } from "../components/ExtLink";

type Row = Record<string, unknown>;

/**
 * Not shown: bulky payloads, and diagnostics that describe how an answer was reached rather
 * than what it is (which verifier was tried, where a name was guessed from). They are in the
 * API response for anyone who wants them; in a results table they were noise with shouting
 * headers - VERIFIERATTEMPTS, GUESSEDNAME - and JSON in the cells.
 */
const HIDDEN_COLS = ["snippet", "raw", "checks", "person", "candidates", "verifierAttempts", "guessedName", "nameSource", "verifiedBy", "mxHost", "source", "pattern"];

/** What each field is called on screen. Unknown keys fall back to their name in words. */
const COL_LABELS: Record<string, string> = {
  url: "LinkedIn URL",
  linkedinUrl: "LinkedIn URL",
  email: "Email",
  emailStatus: "Email status",
  status: "Email status",
  confidence: "Confidence",
  found: "Found",
  reason: "Reason",
  fullName: "Name",
  firstName: "First name",
  lastName: "Last name",
  title: "Title",
  company: "Company",
  companyName: "Company",
  companyDomain: "Company website",
  location: "Location",
  leadId: "Saved",
  saveSkipped: "Why not saved",
};
export const columnLabel = (k: string) => COL_LABELS[k] ?? k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && (v.trim() === "" || v === "null" || v === "undefined")) || (Array.isArray(v) && v.length === 0);

/**
 * One cell, as text. null, "" and [] are "-" (not the words "null" and "[]"); true/false are
 * Yes/No; a 0-1 confidence is a percentage; a saved lead's id is just "Yes".
 */
export function cellText(key: string, v: unknown): string {
  if (key === "leadId") return isEmpty(v) ? "No" : "Yes";
  if (isEmpty(v)) return "-";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return key === "confidence" ? `${Math.round(v <= 1 ? v * 100 : v)}%` : v.toLocaleString();
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== "object") ? v.map((x) => cellText("", x)).join(", ") : `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") {
    const parts = Object.entries(v as Row).filter(([, x]) => !isEmpty(x) && typeof x !== "object").map(([k, x]) => `${columnLabel(k)}: ${cellText(k, x)}`);
    return parts.length ? parts.join(", ") : "-";
  }
  return String(v);
}

/**
 * Columns from every row, in first-seen order. Taking only the first row's keys hid any
 * field the first result happened to lack (no email found, no LinkedIn) for the whole table.
 */
export function columnsOf(rows: Row[]): string[] {
  const seen: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k) && !HIDDEN_COLS.includes(k)) seen.push(k);
  // A full name makes its two halves redundant.
  const cols = seen.includes("fullName") ? seen.filter((k) => k !== "firstName" && k !== "lastName") : seen;
  return cols.slice(0, 8);
}

/**
 * A domain, not a company name. "Acme Inc." contains a dot but is a name; this wants at
 * least one dot-separated label after the first and no spaces.
 */
const looksLikeDomain = (v: string) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test(v.trim());

/** Verification batches: small enough that each request finishes well inside its timeout. */
const VERIFY_CHUNK = 50;

export function ToolsPage() {
  const [tool, setTool] = useState<"linkedin" | "email" | "decision" | "colleagues" | "intel" | "verify" | "health">("decision");
  const [input, setInput] = useState("");
  const [extra, setExtra] = useState("");
  const [out, setOut] = useState<Row[] | Row | null>(null);
  const [busy, setBusy] = useState(false);
  // What the run did NOT do (quota stops, skipped lookups, partial batches), shown beside
  // the results so a short list never reads as the complete answer.
  const [notices, setNotices] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const { toast, Toast } = useToast();
  const lines = () => input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const run = async () => {
    setBusy(true);
    setOut(null);
    setNotices([]);
    setProgress(null);
    try {
      let r: unknown;
      const note: string[] = [];
      if (tool === "linkedin") r = (await apiFetch<{ results: Row[] }>("POST", "/v1/tools/linkedin-to-email", { urls: lines(), save: true })).results;
      if (tool === "email") r = (await apiFetch<{ results: Row[] }>("POST", "/v1/tools/email-to-linkedin", { emails: lines() })).results;
      if (tool === "decision") {
        const v = input.trim();
        const isDomain = looksLikeDomain(v);
        const d = await apiFetch<{ people: Row[]; skipped?: string; saveStopped?: string }>("POST", "/v1/tools/decision-makers", { companyDomain: isDomain ? v : undefined, companyName: isDomain ? undefined : v, personas: extra ? extra.split(",").map((s) => s.trim()).filter(Boolean) : undefined });
        if (d.skipped) note.push(d.skipped);
        if (d.saveStopped) note.push(d.saveStopped);
        r = d.people;
      }
      if (tool === "colleagues") {
        const d = await apiFetch<{ people: Row[]; stopped?: string }>("POST", "/v1/tools/colleagues", { companyDomain: input.trim(), titles: extra ? extra.split(",").map((s) => s.trim()).filter(Boolean) : undefined, save: true });
        if (d.stopped) note.push(d.stopped);
        r = d.people;
      }
      if (tool === "intel") r = await apiFetch<Row>("POST", "/v1/tools/company-intel", { domain: input });
      if (tool === "verify") {
        // Up to 500 addresses in one request could outlast the client timeout while the
        // server kept verifying (and charging). Chunks of 50, each with a generous timeout,
        // and a partial result kept if a later chunk fails.
        const all = lines();
        const results: Row[] = [];
        for (let i = 0; i < all.length; i += VERIFY_CHUNK) {
          setProgress(`Verifying ${Math.min(i + VERIFY_CHUNK, all.length)} of ${all.length}…`);
          try {
            const d = await apiFetch<{ results: Row[] }>("POST", "/v1/tools/verify-batch", { emails: all.slice(i, i + VERIFY_CHUNK) }, undefined, { timeoutMs: 120_000 });
            results.push(...d.results);
          } catch (e) {
            if (!results.length) throw e;
            note.push(`Stopped after ${results.length} of ${all.length}: ${(e as Error).message}. The remaining ${all.length - results.length} were not verified.`);
            break;
          }
        }
        r = results;
      }
      if (tool === "health") r = await apiFetch<Row>("GET", `/v1/tools/domain-health?domain=${encodeURIComponent(input)}`);
      setOut(r as Row[] | Row);
      setNotices(note);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); setProgress(null); }
  };
  const meta: Record<typeof tool, { label: string; ph: string; extra?: string }> = {
    decision: { label: "Decision makers at a company", ph: "razorpay.com or Razorpay", extra: "Personas (optional): CEO / Founder, Sales leader, CMO / Marketing" },
    colleagues: { label: "Colleagues at a domain", ph: "acme.com", extra: "Titles (optional): Head of Sales, CTO" },
    linkedin: { label: "LinkedIn URLs → emails", ph: "https://www.linkedin.com/in/... one per line" },
    email: { label: "Emails → LinkedIn profiles", ph: "one email per line" },
    intel: { label: "Company intelligence (hiring, news, intent)", ph: "company domain" },
    verify: { label: "Bulk email verification", ph: "one email per line (sent in batches of 50)" },
    health: { label: "Sender domain health (SPF/DKIM/DMARC)", ph: "yourdomain.com" },
  };
  return (
    <Page title="Tools" subtitle="One-off enrichment and verification tools. Everything here is also available in the API and MCP server.">
      {Toast}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card min-w-0 p-4 lg:col-span-1">
          <div className="space-y-1">{(Object.keys(meta) as (typeof tool)[]).map((k) => <button key={k} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${tool === k ? "bg-brand-50 font-medium text-brand-600" : "hover:bg-black/[0.05]"}`} onClick={() => { setTool(k); setOut(null); }}>{meta[k].label}</button>)}</div>
        </div>
        <div className="card min-w-0 space-y-3 p-4 lg:col-span-2">
          <div className="font-medium">{meta[tool].label}</div>
          <textarea className="input h-28 font-mono text-xs" placeholder={meta[tool].ph} value={input} onChange={(e) => setInput(e.target.value)} />
          {meta[tool].extra && <input className="input" placeholder={meta[tool].extra} value={extra} onChange={(e) => setExtra(e.target.value)} />}
          <button className="btn-primary" disabled={busy || !input.trim()} onClick={run}>{busy ? progress ?? "Working…" : "Run"}</button>
          {notices.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="status">
              {notices.map((n) => <div key={n}>{n}</div>)}
            </div>
          )}
          {out && (Array.isArray(out) ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm"><thead><tr>{columnsOf(out).map((k) => <th key={k} className="th whitespace-nowrap">{columnLabel(k)}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{out.map((r, i) => <tr key={i}>{columnsOf(out).map((k) => <td key={k} className="td text-xs [overflow-wrap:anywhere]">{(k === "emailStatus" || k === "status") && typeof r[k] === "string" && r[k] ? <EmailStatusBadge status={r[k] as string} /> : (k === "linkedinUrl" || k === "url") && typeof r[k] === "string" && r[k] ? <ExtLink className="text-brand-600 hover:underline" href={r[k]} fallback={r[k] as string}>{r[k] as string}</ExtLink> : cellText(k, r[k])}</td>)}</tr>)}</tbody></table>
              {/* Any reason the server gave is in the notices above; no guessed cause here. */}
              {out.length === 0 && <div className="py-4 text-sm text-ink-400">No results found for this request.</div>}
            </div>
          ) : tool === "intel" ? <CompanyIntelView data={out} /> : tool === "health" ? <DomainHealthView data={out} /> : <pre className="max-h-96 max-w-full overflow-auto rounded-lg bg-black p-3 text-xs text-emerald-800">{JSON.stringify(out, null, 2)}</pre>)}
        </div>
      </div>
    </Page>
  );
}
