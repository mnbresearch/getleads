import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { LoadError, Page, Spinner, useToast } from "../components/ui";

interface ChainLink {
  id: string;
  name: string;
  configured: boolean;
  description: string;
}

interface FindResult {
  email?: string;
  status: string;
  confidence: number;
  pattern?: string;
  verifiedBy?: string;
  source?: string;
  candidates?: { email: string; status?: string }[];
}

/**
 * Email verification: the chain this workspace really runs, and a live test of it.
 *
 * This page used to show invented hit rates ("94.6% match", "1,240 enriched") and a
 * "simulation" that built firstname.lastname@domain, labelled it verified at 98% and added a
 * random US mobile number. The chain now comes from GET /v1/scale/waterfall (which providers
 * have a key), and the test is the real email finder, charged as one verification.
 */
export function WaterfallPage() {
  const [chain, setChain] = useState<ChainLink[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", domain: "" });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FindResult | null>(null);
  const { toast, Toast } = useToast();

  const load = () => {
    setErr(null);
    apiFetch<{ chain: ChainLink[] }>("GET", "/v1/scale/waterfall")
      .then((r) => setChain(r.chain))
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setResult(null);
    try {
      setResult(await apiFetch<FindResult>("POST", "/v1/search/find-email", form));
    } catch (x) {
      toast((x as Error).message, "err");
    } finally {
      setRunning(false);
    }
  };

  const subtitle = "Scout checks an address in order, cheapest first, and stops at the first verdict. Known-bad addresses are never sent to.";
  if (err) return <Page title="Email verification" subtitle={subtitle}><LoadError message={err} onRetry={load} /></Page>;
  if (!chain) return <Page title="Email verification" subtitle={subtitle}><Spinner label="Loading…" /></Page>;

  const live = chain.filter((c) => c.configured).length;
  return (
    <Page title="Email verification" subtitle={subtitle}>
      {Toast}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card p-6 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between border-b border-black/5 pb-4">
            <div>
              <h3 className="text-base font-semibold text-ink-50">Your verification chain</h3>
              <p className="mt-0.5 text-xs text-ink-400">{live} of {chain.length} steps are switched on for this workspace. Connect your own Hunter key in Settings, Integrations.</p>
            </div>
          </div>
          <ol className="space-y-3">
            {chain.map((c, i) => (
              <li key={c.id} className={`flex items-start gap-3 rounded-xl border p-4 ${c.configured ? "border-black/[0.08] bg-surface" : "border-dashed border-black/10 bg-black/[0.015] opacity-70"}`}>
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-50">{c.name}</span>
                    <span className={`badge text-[10px] ${c.configured ? "border border-emerald-200 bg-emerald-50 text-emerald-700" : "bg-black/5 text-ink-400"}`}>{c.configured ? "On" : "Not configured"}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-400">{c.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-ink-400">Scout does not look up mobile numbers. Phone numbers come from your own lists and CRM.</p>
        </div>

        <form onSubmit={run} className="card space-y-3 p-6">
          <h3 className="text-base font-semibold text-ink-50">Try it on a real person</h3>
          <p className="text-xs text-ink-400">Runs the email finder and the chain above. Uses one verification from your plan.</p>
          <input className="input w-full" placeholder="First name" value={form.firstName} maxLength={200} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
          <input className="input w-full" placeholder="Last name" value={form.lastName} maxLength={200} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
          <input className="input w-full" placeholder="Company domain, e.g. acme.com" value={form.domain} maxLength={300} onChange={(e) => setForm({ ...form, domain: e.target.value })} required />
          <button type="submit" className="btn-primary w-full" disabled={running}>{running ? "Checking…" : "Find and verify"}</button>
          {result && (
            <div className="rounded-lg border border-black/10 bg-surface p-3 text-xs">
              {result.email ? (
                <>
                  <div className="font-mono text-sm font-semibold text-ink-50 [overflow-wrap:anywhere]">{result.email}</div>
                  <div className="mt-1 text-ink-400">Status: <strong className="text-ink-100">{result.status}</strong> · confidence {Math.round((result.confidence ?? 0) * 100)}%{result.verifiedBy ? ` · checked by ${result.verifiedBy}` : ""}</div>
                  {result.status !== "valid" && <div className="mt-1 text-ink-400">Not confirmed: treat it as a best guess.</div>}
                </>
              ) : (
                <div className="text-ink-300">No address found ({result.status}).</div>
              )}
              <Link to="/tools" className="mt-2 inline-block font-semibold text-brand-600 hover:underline">More tools</Link>
            </div>
          )}
        </form>
      </div>
    </Page>
  );
}
