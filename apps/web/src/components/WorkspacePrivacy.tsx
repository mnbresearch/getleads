import { useCallback, useEffect, useRef, useState } from "react";
import { ProspexError, apiFetch, expectShape } from "../lib/api";
import { isUnavailable } from "../lib/account";
import { useMe } from "../lib/me";
import { Spinner } from "./ui";

/** The server's limit for the address; the field counts down against the same number. */
export const MAILING_ADDRESS_MAX = 300;

interface Privacy {
  aiAssist: boolean;
  mailingAddress: string;
}

/** The two fields this card needs, or a refusal to treat anything else as an answer. */
function readPrivacy(r: unknown): Privacy {
  const x = expectShape(r as { aiAssist?: unknown; mailingAddress?: unknown }, (o) => typeof o.aiAssist === "boolean");
  return { aiAssist: x.aiAssist === true, mailingAddress: typeof x.mailingAddress === "string" ? x.mailingAddress : "" };
}

/**
 * Settings > Workspace: "AI assistance" and "Mailing address".
 *
 * Two workspace-wide choices that change what leaves the building:
 *
 *  - AI assistance. On, Scout sends lead and reply content to AI providers to draft, score
 *    and classify. Off, none of that content goes to any AI provider and each feature uses
 *    its plain version instead. Some customers are not allowed to share prospect data with
 *    a model at all; before this switch their only option was not to use the product.
 *  - Mailing address. A postal address next to the unsubscribe link of every campaign email,
 *    which commercial-email rules in several countries require.
 *
 * Three states are kept apart on purpose: "the server has no such setting" (an older
 * server - the card does not render at all), "could not check" (said, with a retry), and
 * the answer. A failed check never renders as a switch in some default position: that would
 * be a statement about where the workspace's data goes that nobody verified.
 */
export function WorkspacePrivacy() {
  const { canManage } = useMe();
  const [saved, setSaved] = useState<Privacy | null>(null);
  const [form, setForm] = useState<Privacy>({ aiAssist: true, mailingAddress: "" });
  const [hidden, setHidden] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoadErr(null);
    apiFetch<unknown>("GET", "/v1/account/privacy")
      .then((r) => {
        if (mine !== seq.current) return;
        const p = readPrivacy(r);
        setSaved(p);
        setForm(p);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        // An older server has no such setting: there is nothing to show and nothing to change.
        if (isUnavailable(e)) setHidden(true);
        else setLoadErr((e as Error).message || "Something went wrong.");
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  if (hidden) return null;

  const address = form.mailingAddress;
  const tooLong = address.length > MAILING_ADDRESS_MAX;
  const dirty = !!saved && (form.aiAssist !== saved.aiAssist || address.trim() !== saved.mailingAddress.trim());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saved || busy || !dirty || tooLong) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    // Only what changed goes up: two people editing different halves do not undo each other.
    const body: { aiAssist?: boolean; mailingAddress?: string } = {};
    if (form.aiAssist !== saved.aiAssist) body.aiAssist = form.aiAssist;
    if (address.trim() !== saved.mailingAddress.trim()) body.mailingAddress = address.trim();
    try {
      const p = readPrivacy(await apiFetch<unknown>("PATCH", "/v1/account/privacy", body));
      setSaved(p);
      setForm(p);
      setDone(
        body.aiAssist === false
          ? "Saved. AI assistance is off: lead and reply content is no longer sent to AI providers."
          : body.aiAssist === true
            ? "Saved. AI assistance is on."
            : "Saved.",
      );
    } catch (x) {
      const status = x instanceof ProspexError ? x.status : 0;
      setErr(
        status === 403
          ? "Only workspace owners and admins can change this."
          : isUnavailable(x)
            ? "These settings cannot be changed on this server yet. Try again later."
            : (x as Error).message || "Could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="card max-w-xl space-y-4 p-5" data-testid="privacy-card" aria-label="AI assistance and mailing address">
      <div className="font-medium">AI assistance and mailing address</div>

      {loadErr && !saved && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert" data-testid="privacy-load-error">
          Could not check these settings: {loadErr} <button type="button" className="underline" onClick={load}>Try again</button>
        </div>
      )}
      {!loadErr && !saved && <Spinner label="Loading…" />}

      {saved && (
        <>
          {!canManage && <p className="text-xs text-ink-400">Only owners and admins can change these settings.</p>}

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <label className="text-sm font-medium text-ink-50" htmlFor="privacy-ai" id="privacy-ai-label">AI assistance</label>
              <p className="mt-1 text-sm text-ink-300" id="privacy-ai-help">
                {form.aiAssist
                  ? "On: Scout uses AI models to draft and personalise messages, score and summarise leads, and read replies."
                  : "Off: nothing about your leads, prospects or their replies is sent to an AI provider. Features that use AI fall back to their plain versions and say so - for example, campaign emails use your template as written."}
              </p>
            </div>
            <button
              type="button"
              id="privacy-ai"
              role="switch"
              aria-checked={form.aiAssist}
              aria-describedby="privacy-ai-help"
              disabled={!canManage || busy}
              data-testid="privacy-ai-switch"
              onClick={() => { setForm((f) => ({ ...f, aiAssist: !f.aiAssist })); setDone(null); }}
              className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-brand-300/60 disabled:cursor-not-allowed disabled:opacity-60 ${form.aiAssist ? "bg-brand-600" : "bg-black/20"}`}
            >
              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${form.aiAssist ? "translate-x-[22px]" : "translate-x-0.5"}`} aria-hidden />
              <span className="sr-only">{form.aiAssist ? "On" : "Off"}</span>
            </button>
          </div>

          <div>
            <label className="label" htmlFor="privacy-address">Mailing address</label>
            <textarea
              id="privacy-address"
              className="input h-20"
              value={address}
              readOnly={!canManage}
              disabled={busy}
              placeholder={"Acme Pvt Ltd\n12 Example Road, Faridabad 121001, India"}
              aria-describedby="privacy-address-help"
              aria-invalid={tooLong}
              autoComplete="street-address"
              data-testid="privacy-address"
              onChange={(e) => { setForm((f) => ({ ...f, mailingAddress: e.target.value })); setDone(null); }}
            />
            <div className="mt-1 flex flex-wrap items-start justify-between gap-2 text-xs text-ink-400">
              <p id="privacy-address-help" className="min-w-0">
                {saved.mailingAddress.trim()
                  ? "Shown at the bottom of every campaign email, with the unsubscribe link."
                  : "When you add one, it is shown at the bottom of every campaign email, with the unsubscribe link. Anti-spam rules in many countries require a postal address in marketing email."}{" "}
                Plain text only.
              </p>
              <span className={`shrink-0 tabular-nums ${tooLong ? "font-medium text-red-700" : ""}`} data-testid="privacy-address-count">{address.length}/{MAILING_ADDRESS_MAX}</span>
            </div>
            {tooLong && <p className="mt-1 text-xs text-red-700" role="alert">That is longer than {MAILING_ADDRESS_MAX} characters. Shorten it to save.</p>}
          </div>

          {err && <div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 [overflow-wrap:anywhere]" role="alert" data-testid="privacy-error">{err}</div>}
          {done && <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-700 [overflow-wrap:anywhere]" role="status" data-testid="privacy-done">{done}</div>}

          {canManage && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" disabled={busy || !dirty || tooLong} data-testid="privacy-save">{busy ? "Saving…" : "Save"}</button>
              {dirty && !busy && <span className="text-xs text-amber-800" role="status">Not saved yet.</span>}
            </div>
          )}
        </>
      )}
    </form>
  );
}
