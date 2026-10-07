import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch, expectShape } from "../../lib/api";
import { LoadError, Spinner, TagInput } from "../ui";
import {
  clean, competitorsOf, fieldMin, findsCompanies, isForbidden, isQuota, lookup, messageOf, SCHEDULES, typeTone,
  type Competitor, type FieldOption, type PlayOut, type PlayTypeField, type PlayTypeInfo,
} from "../../lib/plays";
import { plural } from "../../lib/plural";

export interface Pickers { icps: { id: string; name: string }[]; lists: { id: string; name: string }[]; campaigns: { id: string; name: string }[]; clients: { id: string; name: string }[]; error: string | null; retry: () => void }

const FINDS: Record<string, string> = { people: "Finds people", companies: "Finds companies", conversations: "Finds conversations" };

const optionOf = (o: FieldOption) => (typeof o === "string" ? { value: o, label: o.charAt(0).toUpperCase() + o.slice(1).replace(/_/g, " ") } : { value: String(o.value), label: clean(o.label ?? String(o.value), 80) });

/** Name + optional website pairs, as removable chips. Used for "your competitors". */
export function CompetitorsInput({ value, onChange, max = 10, idBase, placeholder }: { value: Competitor[]; onChange: (v: Competitor[]) => void; max?: number; idBase: string; placeholder?: string }) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const full = value.length >= max;
  const add = () => {
    const n = name.trim().slice(0, 120);
    if (!n || full) return;
    if (value.some((c) => c.name.toLowerCase() === n.toLowerCase())) { setName(""); setDomain(""); return; }
    const d = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").slice(0, 200);
    onChange([...value, { name: n, ...(d ? { domain: d } : {}) }]);
    setName("");
    setDomain("");
  };
  const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Competitors">
          {value.map((c) => (
            <li key={c.name} className="badge bg-brand-50 py-1 text-brand-700 [overflow-wrap:anywhere]">
              {c.name}{c.domain ? <span className="ml-1 font-normal text-brand-600/80">{c.domain}</span> : null}
              <button type="button" className="ml-1.5 text-brand-600 hover:text-brand-800" aria-label={`Remove ${c.name}`} onClick={() => onChange(value.filter((x) => x.name !== c.name))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input id={idBase} className="input min-w-0 flex-1 basis-40" maxLength={120} placeholder={placeholder ?? "Competitor name"} value={name} disabled={full} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
        <input className="input min-w-0 flex-1 basis-40" maxLength={200} aria-label="Competitor website (optional)" placeholder="Their website (optional)" value={domain} disabled={full} onChange={(e) => setDomain(e.target.value)} onKeyDown={onEnter} />
        <button type="button" className="btn-secondary" disabled={full || !name.trim()} onClick={add}>Add</button>
      </div>
      {full && <p className="mt-1 text-xs text-ink-400">That is the most a play can watch ({max}). Remove one to add another.</p>}
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: PlayTypeField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `play-field-${field.key}`;
  const options = (field.options ?? []).map(optionOf);
  // A field with options is a set of choices, sent as a list ("where to look": LinkedIn,
  // Reddit, ...). Only a field the server caps at one choice is a single pick.
  const multi = options.length > 0 && field.max !== 1;
  let control: JSX.Element;
  if (field.kind === "competitors") {
    control = <CompetitorsInput idBase={id} value={competitorsOf(value)} onChange={onChange} max={field.max ?? 10} placeholder={field.placeholder} />;
  } else if (multi) {
    const chosen = (Array.isArray(value) ? (value as unknown[]) : typeof value === "string" && value ? [value] : []).filter((v): v is string => typeof v === "string");
    const cap = field.max && field.max > 1 ? field.max : options.length;
    control = (
      <div role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={chosen.includes(o.value)} disabled={!chosen.includes(o.value) && chosen.length >= cap} onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))} />
            {o.label}
          </label>
        ))}
      </div>
    );
  } else if (field.kind === "tags") {
    control = <TagInput inputId={id} value={Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : []} onChange={onChange} placeholder={field.placeholder} max={field.max} />;
  } else if (field.kind === "select") {
    control = (
      <select id={id} className="input" value={typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : ""} onChange={(e) => onChange(e.target.value)}>
        {!field.required && <option value="">No preference</option>}
        {field.required && typeof value !== "string" && <option value="">Choose…</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (field.kind === "number") {
    control = <input id={id} type="number" inputMode="numeric" min={fieldMin(field)} max={field.max} className="input" placeholder={field.placeholder} value={typeof value === "number" || typeof value === "string" ? String(value) : ""} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input id={id} className="input" maxLength={field.max && field.max > 0 ? field.max : 500} placeholder={field.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="sm:col-span-2">
      {multi
        ? <div className="label" id={`${id}-label`}>{field.label}{field.required ? " (required)" : ""}</div>
        : <label className="label" htmlFor={id}>{field.label}{field.required ? " (required)" : ""}</label>}
      {control}
      {field.help && <p className="mt-1 text-xs text-ink-400">{field.help}</p>}
    </div>
  );
}

/** A field's value as the API wants it, or undefined when it was left empty. */
function fieldValue(field: PlayTypeField, raw: unknown): unknown {
  if (field.kind === "competitors") { const c = competitorsOf(raw); return c.length ? c.map((x) => ({ name: x.name, ...(x.domain ? { domain: x.domain } : {}) })) : undefined; }
  if (Array.isArray(raw)) { const a = raw.filter((v) => typeof v === "string" && v.trim()); return a.length ? a : undefined; }
  if (field.kind === "number") { if (raw === "" || raw === null || raw === undefined) return undefined; const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
  if (typeof raw === "string") return raw.trim() ? raw.trim() : undefined;
  return raw ?? undefined;
}

/**
 * New play (pick a type, then fill in what it needs) or, with `initial`, edit one.
 *
 * The types and their fields come from the server: this form draws whatever
 * GET /v1/plays/types describes, so a type added there needs no change here. A type the
 * workspace cannot use yet is shown, greyed, with the server's reason - knowing it exists
 * and what it needs is more use than not seeing it.
 */
export function PlayForm({
  types, typesError, onRetryTypes, initial, startType, findHint, searchDependable, pickers, onSaved, onForbidden, toast,
}: {
  types: PlayTypeInfo[] | null;
  typesError: string | null;
  onRetryTypes: () => void;
  initial?: PlayOut;
  /** Open a new play straight at this kind (when it exists and is available), skipping the picker. */
  startType?: string;
  /** The server's sentence about finding people when no search source is connected. */
  findHint?: string;
  searchDependable?: boolean;
  pickers: Pickers;
  onSaved: (play: PlayOut, created: boolean) => void;
  onForbidden: (message: string) => void;
  toast: (m: string, k?: "ok" | "err") => void;
}) {
  const [type, setType] = useState<string | null>(initial?.type ?? null);
  const info = useMemo(() => types?.find((t) => t.type === type) ?? null, [types, type]);
  const [name, setName] = useState(initial?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({ ...(initial?.config ?? {}) }));
  const [titles, setTitles] = useState<string[]>(initial?.targetTitles ?? []);
  const [icpId, setIcpId] = useState(initial?.icpId ?? "");
  const [listId, setListId] = useState(initial?.listId ?? "");
  const [campaignId, setCampaignId] = useState(initial?.campaignId ?? "");
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [every, setEvery] = useState<number | null>(initial?.runEveryHours ?? null);
  const [autoApprove, setAutoApprove] = useState(initial?.autoApprove ?? false);
  const [minScore, setMinScore] = useState<string>(String(initial?.minScore ?? 70));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current || initial || !startType || !types) return;
    started.current = true;
    const t = types.find((x) => x.type === startType && x.available !== false);
    if (!t) return;
    setType(t.type);
    setName(t.name);
    setConfig({});
    setTitles(t.defaultTitles ?? []);
  }, [types, startType, initial]);

  if (!types) return typesError ? <LoadError message={typesError} onRetry={onRetryTypes} /> : <Spinner label="Loading the kinds of play…" />;

  const pick = (t: PlayTypeInfo) => {
    setType(t.type);
    setName(t.name);
    setConfig({});
    setTitles(t.defaultTitles ?? []);
    setError(null);
  };

  // ── Step 1: what kind of play ───────────────────────────────────────────────────────────
  if (!type) {
    return (
      <div>
        <p className="mb-3 text-sm text-ink-300">A play watches one source of buying intent and looks for the people behind it. Each one it finds comes with a reason and the proof. Pick where to look.{searchDependable === false ? " The kinds that work today are listed first." : ""}</p>
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Kinds of play">
          {types.map((t) => {
            // Unavailable only when the server says so; a server that does not say is not refusing.
            const off = t.available === false;
            return (
            <li key={t.type}>
              <button
                type="button"
                disabled={off}
                data-testid="play-type"
                data-type={t.type}
                onClick={() => pick(t)}
                className={`flex h-full w-full flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition [overflow-wrap:anywhere] ${!off ? "border-black/10 bg-surface hover:border-brand-300 hover:shadow-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600" : "cursor-not-allowed border-black/[0.06] bg-black/[0.02]"}`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`font-semibold ${!off ? "text-ink-50" : "text-ink-400"}`}>{t.name}</span>
                  <span className={`badge ${!off ? typeTone(t.type) : "bg-black/[0.05] text-ink-400"}`}>{lookup(FINDS, t.finds) ?? "Finds people"}</span>
                </span>
                <span className={`text-sm ${!off ? "text-ink-300" : "text-ink-400"}`}>{t.summary}</span>
                {off && <span className="text-xs font-medium text-amber-700">Not available yet: {t.unavailableReason || "this workspace is not set up for it."}</span>}
                {!off && t.setupHint && <span className={`text-xs ${t.needsSearch || searchDependable === undefined ? "text-amber-700" : "text-ink-400"}`} data-testid="type-hint">{t.setupHint}</span>}
              </button>
            </li>
            );
          })}
        </ul>
        {types.length === 0 && <p className="text-sm text-ink-400">No kinds of play are available on this workspace yet.</p>}
      </div>
    );
  }

  // ── Step 2: what it needs ───────────────────────────────────────────────────────────────
  const fields = info?.fields ?? [];
  const upload = type === "engagers_upload";
  const scoreNum = Number(minScore);
  const missing = fields.filter((f) => f.required && fieldValue(f, config[f.key]) === undefined).map((f) => f.label);
  const numberErr = fields.find((f) => f.kind === "number" && config[f.key] !== undefined && config[f.key] !== "" && (!Number.isFinite(Number(config[f.key])) || Number(config[f.key]) < fieldMin(f) || (f.max !== undefined && Number(config[f.key]) > f.max)));
  // Job titles are for plays that find a company first. A play that is handed people (an
  // upload, job changes) or finds conversations has no use for them, so it is not asked.
  const wantsTitles = findsCompanies(types, type);
  const problem =
    !name.trim() ? "Give the play a name."
    : missing.length ? `Fill in: ${missing.join(", ")}.`
    : numberErr ? `${numberErr.label} must be a number ${numberErr.max !== undefined ? `from ${fieldMin(numberErr)} to ${numberErr.max}` : `of ${fieldMin(numberErr)} or more`}.`
    : autoApprove && (!Number.isInteger(scoreNum) || scoreNum < 0 || scoreNum > 100) ? "The minimum score must be a whole number from 0 to 100."
    : null;
  // Like Find leads: offered only to a workspace that works for clients. A play already
  // delivering to a client this list does not show (archived since) keeps it, named as such.
  const showClient = pickers.clients.length > 0;
  const clientMissing = !!clientId && !pickers.clients.some((c) => c.id === clientId);
  const schedules = SCHEDULES.some((s) => s.value === every) ? SCHEDULES : [...SCHEDULES, { value: every, label: `Every ${plural(every ?? 0, "hour")}` }];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // Keys this form does not draw (a newer server's, or a type whose fields did not
      // load) are kept as they were; the ones it does draw are replaced or removed.
      const cfg: Record<string, unknown> = { ...(initial?.config ?? {}) };
      for (const f of fields) {
        const v = fieldValue(f, config[f.key]);
        if (v === undefined) delete cfg[f.key];
        else cfg[f.key] = v;
      }
      const shared = {
        name: name.trim(),
        config: cfg,
        ...(wantsTitles ? { targetTitles: titles } : {}),
        autoApprove,
        ...(autoApprove ? { minScore: scoreNum } : {}),
        runEveryHours: upload ? null : every,
      };
      // A picker left on "none" is sent only when it clears something the play already had.
      const ref = (key: "icpId" | "listId" | "campaignId" | "clientId", v: string) => (v ? { [key]: v } : initial?.[key] ? { [key]: null } : {});
      // The client is only sent when its picker was on screen (or to keep what is saved).
      const client = showClient ? ref("clientId", clientId) : {};
      const body = { ...shared, ...ref("icpId", icpId), ...ref("listId", listId), ...ref("campaignId", campaignId), ...client };
      const r = initial
        ? await apiFetch<{ play: PlayOut }>("PATCH", `/v1/plays/${encodeURIComponent(initial.id)}`, body)
        : await apiFetch<{ play: PlayOut }>("POST", "/v1/plays", { ...body, type });
      const play = expectShape(r, (x) => typeof x.play?.id === "string").play;
      if (initial) toast("Play updated");
      onSaved(play, !initial);
    } catch (e) {
      const said = messageOf(e);
      setError({ message: said, quota: isQuota(e) });
      if (isForbidden(e)) onForbidden(said);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="play-form">
      {!initial && (
        <div className="flex flex-wrap items-center gap-2 text-sm sm:col-span-2">
          <span className={`badge ${typeTone(type)}`}>{info?.name ?? type}</span>
          <span className="min-w-0 flex-1 text-ink-300">{info?.summary}</span>
          <button type="button" className="text-brand-600 hover:underline" onClick={() => setType(null)}>Choose a different kind</button>
        </div>
      )}
      {info?.setupHint && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">{info.setupHint}</div>}
      {initial && !info && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">This kind of play is not described by the server right now, so what it looks for cannot be changed here. Its name, people, lists and schedule can.</div>}
      {pickers.error && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2" role="alert">{pickers.error} The pickers below may be incomplete. <button type="button" className="underline" onClick={pickers.retry}>Retry</button></div>}

      <div className="sm:col-span-2"><label className="label" htmlFor="play-name">Name</label><input id="play-name" className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>

      {fields.map((f) => <FieldInput key={f.key} field={f} value={config[f.key]} onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))} />)}

      {wantsTitles && <div className="sm:col-span-2">
        <label className="label" htmlFor="play-titles">Job titles to look for</label>
        <TagInput inputId="play-titles" value={titles} onChange={setTitles} max={20} placeholder="VP Sales, Head of Growth…" />
        <p className="mt-1 text-xs text-ink-400">When the play finds a company, these are the people Scout looks for there. Leave empty to get the company and choose people yourself.</p>
        {findHint && <p className="mt-1 text-xs text-amber-700" data-testid="find-hint">{findHint}</p>}
      </div>}

      <div><label className="label" htmlFor="play-icp">Score against an ideal customer</label><select id="play-icp" className="input" value={icpId} onChange={(e) => setIcpId(e.target.value)}><option value="">Do not score</option>{pickers.icps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
      <div><label className="label" htmlFor="play-list">Add approved people to a list</label><select id="play-list" className="input" value={listId} onChange={(e) => setListId(e.target.value)}><option value="">No list</option>{pickers.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div>
        <label className="label" htmlFor="play-campaign">Campaign for approved people</label>
        <select id="play-campaign" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}><option value="">No campaign</option>{pickers.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <p className="mt-1 text-xs text-ink-400">Nobody is added on their own. When you approve, you choose whether they join it.</p>
      </div>
      {showClient && (
        <div>
          <label className="label" htmlFor="play-client">Deliver approved people to a client</label>
          <select id="play-client" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">No client (pool)</option>
            {clientMissing && <option value={clientId}>The client it delivers to now</option>}
            {pickers.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-400">People you approve from this play are assigned to this client.</p>
        </div>
      )}
      {!upload && (
        <div>
          <label className="label" htmlFor="play-schedule">How often to run</label>
          <select id="play-schedule" className="input" value={every === null ? "" : String(every)} onChange={(e) => setEvery(e.target.value ? Number(e.target.value) : null)}>
            {schedules.map((s) => <option key={String(s.value)} value={s.value === null ? "" : String(s.value)}>{s.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-400">Each run counts as one search on your plan.</p>
        </div>
      )}

      <div className="rounded-lg border border-black/10 p-3 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm font-medium text-ink-100">
          <input type="checkbox" role="switch" aria-checked={autoApprove} checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Approve automatically, without review
        </label>
        <p className="mt-1 text-xs text-ink-400">Off by default. When it is on, people this play finds are added to your leads without anyone looking at them first, and each new one counts towards your plan.</p>
        {autoApprove && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="play-minscore">Only people scoring at least</label>
            <input id="play-minscore" type="number" inputMode="numeric" min={0} max={100} className="input w-20 py-1" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
            <span className="text-ink-400">out of 100</span>
          </div>
        )}
      </div>

      {error && (
        <div className={`rounded-lg px-3 py-2 text-sm sm:col-span-2 ${error.quota ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`} role="alert" data-testid="play-form-error">
          {initial ? "Not saved" : "Not created"}: {error.message} {error.quota && <Link className="font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
        </div>
      )}
      <div className="sm:col-span-2">
        <button type="button" className="btn-primary w-full justify-center" disabled={busy || !!problem} onClick={save}>{busy ? "Saving…" : initial ? "Save changes" : "Create play"}</button>
        {problem && <p className="mt-1 text-center text-xs text-ink-400">{problem}</p>}
      </div>
    </div>
  );
}
