import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch, fmtDate, expectLists } from "../lib/api";
import { LoadError, Page, Spinner, TagInput, useToast } from "../components/ui";

/** The API's caps on a search (routes/search.ts searchInput). Checked here so the user gets a sentence, not a 400. */
const MAX_TAGS = 10;
const MAX_DOMAINS = 50;
const MAX_LIMIT = 200;

interface Search { id: string; status: string; resultCount: number; query: Record<string, unknown>; createdAt: string; error: string | null; jobId: string | null; clientId?: string | null; clientClaim?: { claimed: number; ownedByAnotherClient: number; skipped?: string; error?: string } | null }

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [titles, setTitles] = useState<string[]>([]);
  const [industries, setIndustries] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [limit, setLimit] = useState(25);
  const [findEmails, setFindEmails] = useState(true);
  const [icps, setIcps] = useState<{ id: string; name: string }[]>([]);
  const [icpId, setIcpId] = useState("");
  // A search can be run for a client: its leads are delivered straight to that client. Opened
  // from a client's page, the client is pre-selected.
  const [params] = useSearchParams();
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [clientId, setClientId] = useState(params.get("clientId") ?? "");
  const [searches, setSearches] = useState<Search[]>([]);
  // null until the first answer: "No searches yet" must only show after we have looked.
  const [loaded, setLoaded] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [icpErr, setIcpErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const { toast, Toast } = useToast();

  /**
   * Per-job progress for the searches still running.
   *
   * The page told people a search takes 20-90 seconds and then showed them a spinner
   * labelled "running" for all of it. The job row has carried a `progress` percentage and a
   * stage label the whole time, and GET /v1/search/jobs/:jobId returns them - nothing
   * fetched either. A minute of no information reads as a minute of nothing happening.
   */
  const [progress, setProgress] = useState<Record<string, number>>({});

  const load = async () => {
    // Polled every 4s: without a catch every failed poll was an unhandled rejection and the
    // table read "No searches yet" as though the history were empty.
    let r: { searches: Search[] };
    try {
      r = await apiFetch<{ searches: Search[] }>("GET", "/v1/search");
    } catch (e) {
      setListErr((e as Error).message);
      return;
    }
    setSearches(r.searches);
    setLoaded(true);
    setListErr(null);

    const running = r.searches.filter((s) => (s.status === "running" || s.status === "queued") && s.jobId);
    if (running.length === 0) { setProgress({}); return; }
    const pairs = await Promise.all(
      running.map(async (s) => {
        try {
          const j = await apiFetch<{ progress: number | null }>("GET", `/v1/search/jobs/${s.jobId}`);
          return [s.id, j.progress ?? 0] as const;
        } catch {
          return [s.id, -1] as const; // -1: we could not check, which is not 0%
        }
      }),
    );
    setProgress(Object.fromEntries(pairs));
  };

  useEffect(() => {
    load();
    loadIcps();
    apiFetch<{ clients: { id: string; name: string }[] }>("GET", "/v1/clients").then((r) => setClients(expectLists(r, "clients").clients)).catch(() => setClients([]));
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, []);

  const loadIcps = () => {
    apiFetch<{ icps: { id: string; name: string }[] }>("GET", "/v1/icps")
      .then((r) => { setIcps(r.icps); setIcpErr(null); })
      .catch((e) => setIcpErr((e as Error).message));
  };

  /** Why this search can't be sent as-is, in words - or null. */
  const invalid = (): string | null => {
    if (titles.length > MAX_TAGS) return `Use at most ${MAX_TAGS} job titles (you have ${titles.length}).`;
    if (industries.length > MAX_TAGS) return `Use at most ${MAX_TAGS} industries (you have ${industries.length}).`;
    if (locations.length > MAX_TAGS) return `Use at most ${MAX_TAGS} locations (you have ${locations.length}).`;
    if (domains.length > MAX_DOMAINS) return `Use at most ${MAX_DOMAINS} company domains (you have ${domains.length}).`;
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) return `Max leads must be between 1 and ${MAX_LIMIT}.`;
    return null;
  };
  const problem = invalid();

  const searchBody = () => ({ query: query || undefined, titles: titles.length ? titles : undefined, industries: industries.length ? industries : undefined, locations: locations.length ? locations : undefined, companyDomains: domains.length ? domains : undefined, limit, findEmails, icpId: icpId || undefined });

  const saveSearch = async () => {
    if (problem) return toast(problem, "err");
    const name = prompt("Name this saved search", query || titles.join(", "));
    if (!name) return;
    const alert = confirm("Email me when new leads appear (daily)?");
    try {
      const me = alert ? await apiFetch<{ user: { email: string } | null }>("GET", "/v1/auth/me") : null;
      await apiFetch("POST", "/v1/tools/saved-searches", { name, query: searchBody(), alert, alertEmail: alert ? me?.user?.email : undefined, clientId: clientId || undefined });
      toast("Saved - see Autopilot page");
    } catch (e) {
      toast(`Couldn't save the search: ${(e as Error).message}`, "err");
    }
  };

  const parse = async () => {
    if (!query) return;
    setParsing(true);
    try {
      const r = await apiFetch<{ titles?: string[]; industries?: string[]; locations?: string[] }>("POST", "/v1/search/parse", { query });
      setTitles(r.titles ?? []);
      setIndustries(r.industries ?? []);
      setLocations(r.locations ?? []);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setParsing(false);
    }
  };

  const run = async () => {
    if (problem) return toast(problem, "err");
    setBusy(true);
    try {
      await apiFetch("POST", "/v1/search", { ...searchBody(), clientId: clientId || undefined });
      const forClient = clients.find((c) => c.id === clientId);
      toast(forClient ? `Search started for ${forClient.name} - new leads are delivered to them as they are found` : "Search started - results appear in Leads as they are found");
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Find leads" subtitle="Describe who you want. Scout searches the open web + LinkedIn, enriches companies, finds and verifies emails, and scores fit.">
      {Toast}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-4 p-5 lg:col-span-2">
          <div>
            <label className="label">Describe your ideal lead</label>
            <div className="flex gap-2">
              <input className="input" placeholder='e.g. "Heads of Growth at Series A fintech startups in Bengaluru"' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && parse()} />
              <button className="btn-secondary whitespace-nowrap" onClick={parse} disabled={parsing || !query}>{parsing ? "…" : "Extract filters"}</button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Job titles</label><TagInput value={titles} onChange={setTitles} placeholder="Head of Sales, CTO…" /></div>
            <div><label className="label">Industries</label><TagInput value={industries} onChange={setIndustries} placeholder="fintech, D2C…" /></div>
            <div><label className="label">Locations</label><TagInput value={locations} onChange={setLocations} placeholder="Bengaluru, India…" /></div>
            <div><label className="label">Specific company domains (optional)</label><TagInput value={domains} onChange={setDomains} placeholder="razorpay.com, zerodha.com…" /></div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div><label className="label">Max leads</label><input type="number" className="input w-24" min={1} max={MAX_LIMIT} value={Number.isFinite(limit) ? limit : ""} onChange={(e) => setLimit(e.target.value === "" ? NaN : Number(e.target.value))} /></div>
            <div><label className="label">Score against ICP</label>
              <select className="input w-56" value={icpId} onChange={(e) => setIcpId(e.target.value)}><option value="">(search filters only)</option>{icps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
              {icpErr && <div className="mt-1 text-xs text-red-600">Couldn&apos;t load ICPs. <button className="underline" onClick={loadIcps}>Retry</button></div>}
            </div>
            {clients.length > 0 && (
              <div><label className="label">Deliver to client</label>
                <select className="input w-52" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Deliver leads to client">
                  <option value="">No client (pool)</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={findEmails} onChange={(e) => setFindEmails(e.target.checked)} /> Find + verify emails</label>
            <button className="btn-secondary ml-auto" disabled={!query && !titles.length && !domains.length} onClick={saveSearch}>Save search</button>
            <button className="btn-primary" onClick={run} disabled={busy || !!problem || (!query && !titles.length && !domains.length)}>{busy ? "Starting…" : "Run search"}</button>
          </div>
          {problem && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">{problem}</div>}
        </div>
        <div className="card p-5 text-sm text-ink-300">
          <div className="mb-2 font-medium text-ink-50">How it works</div>
          <ol className="list-decimal space-y-1 pl-4">
            <li>Query → LinkedIn profile search across Brave / Google / DuckDuckGo / Bing.</li>
            <li>Company websites crawled: description, tech stack, team, public emails.</li>
            <li>Email pattern inferred, candidates verified via MX + SMTP handshake.</li>
            <li>Every lead scored 0-100 against your filters or an ICP.</li>
          </ol>
          <div className="mt-3 text-xs">Searches run in the background. Typical time: 20-90s for 25 leads.</div>
        </div>
      </div>

      {(() => {
        // The newest search finished with nothing and a reason: say so above the table, not
        // in 11px under a "0", because "0 results" alone reads as "nobody matches".
        const last = searches[0];
        if (!last || last.resultCount > 0 || !last.error || (last.status !== "done" && last.status !== "failed")) return null;
        return (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
            <div className="font-medium">Your last search returned no leads - and it was not because nobody matched.</div>
            <div className="mt-1">{last.error}</div>
          </div>
        );
      })()}
      {listErr && !loaded ? <div className="mt-6"><LoadError message={listErr} onRetry={() => { void load(); }} /></div> : (
      <div className="card mt-6 overflow-x-auto">
        {listErr && <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Couldn&apos;t refresh search history ({listErr}). Showing the last loaded results; retrying.</div>}
        <table className="w-full">
          <thead className="border-b border-black/10 bg-cream"><tr><th className="th">When</th><th className="th">Query</th><th className="th">Status</th><th className="th">Results</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {searches.map((s) => (
              <tr key={s.id}>
                <td className="td whitespace-nowrap text-ink-400">{fmtDate(s.createdAt)}</td>
                <td className="td">{String(s.query.query ?? (s.query.titles as string[] | undefined)?.join(", ") ?? (s.query.companyDomains as string[] | undefined)?.join(", ") ?? "")}</td>
                <td className="td">{s.status === "running" || s.status === "queued" ? (
                  <div className="space-y-1">
                    <Spinner label={progress[s.id] > 0 ? `${s.status} · ${progress[s.id]}%` : s.status} />
                    {progress[s.id] > 0 && (
                      <div className="h-1.5 w-28 rounded-full bg-black/[0.05]">
                        <div className="h-1.5 rounded-full bg-brand-600 transition-all" style={{ width: `${Math.min(100, progress[s.id])}%` }} />
                      </div>
                    )}
                  </div>
                ) : <span className={`badge ${s.status === "done" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{s.status}</span>}{s.error && (s.status !== "done"
                  ? <div className="text-xs text-red-600">{s.error}</div>
                  /* A done search carries a note for two very different reasons: the plan's
                     limit cut it short, or a data provider could not answer. Only the first
                     is fixed by upgrading, and putting "See plans" next to the message that
                     explicitly says the fault is ours reads as billing off our own outage. */
                  : /plan's limit/i.test(s.error)
                    ? <div className="mt-1 text-xs text-amber-700">{s.error} <Link className="underline" to="/settings/billing">See plans</Link></div>
                    : <div className="mt-1 text-xs text-amber-700">{s.error}</div>)}</td>
                <td className="td tabular-nums">
                  {s.resultCount}
                  {s.clientClaim && (
                    // What the client claim did, said on the search itself: otherwise "12
                    // results" for a client search hides that 3 of them stayed with the
                    // client that already had them.
                    <div className="text-[11px] font-normal text-ink-400">
                      {s.clientClaim.skipped
                        ? s.clientClaim.skipped === "client_archived" ? "client archived - not delivered" : "client deleted - not delivered"
                        : s.clientClaim.error
                          ? "delivery to client failed"
                          : `${s.clientClaim.claimed} delivered to ${clients.find((c) => c.id === s.clientId)?.name ?? "client"}${s.clientClaim.ownedByAnotherClient ? ` · ${s.clientClaim.ownedByAnotherClient} already another client's` : ""}`}
                    </div>
                  )}
                </td>
                <td className="td text-right">{s.status === "done" && s.resultCount > 0 && <Link className="text-brand-600 hover:underline" to={`/leads?tag=search:${s.id.slice(0, 8)}`}>View leads →</Link>}</td>
              </tr>
            ))}
            {loaded && searches.length === 0 && <tr><td className="td py-8 text-center text-ink-400" colSpan={5}>No searches yet.</td></tr>}
            {!loaded && <tr><td className="td py-8" colSpan={5}><Spinner label="Loading searches…" /></td></tr>}
          </tbody>
        </table>
      </div>
      )}
    </Page>
  );
}
