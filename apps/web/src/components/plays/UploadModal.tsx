import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../lib/api";
import { Modal } from "../ui";
import { plural } from "../../lib/plural";
import { clean, ENGAGEMENTS, isForbidden, isQuota, messageOf, runFailed, UPLOAD_MAX_CSV_CHARS, UPLOAD_MAX_PEOPLE, type PlayOut, type UploadResult } from "../../lib/plays";

/**
 * Add people to an "uploaded engagers" play: everyone who reacted to a post, signed up,
 * followed, attended.
 *
 * The customer brings the list - Scout does not log in to LinkedIn to collect it. Each row
 * becomes a candidate with a reason built from what they did ("Commented on the post ...")
 * and, when a post link is given, that link as the proof. Rows the server could not use come
 * back with the reason, by row number, and are shown rather than dropped silently.
 */
export function UploadModal({ play, onClose, onDone, onReview, onForbidden }: { play: PlayOut | null; onClose: () => void; onDone: () => void; onReview: (play: PlayOut) => void; onForbidden: (message: string) => void }) {
  const [engagement, setEngagement] = useState("commented");
  const [postUrl, setPostUrl] = useState("");
  const [postTitle, setPostTitle] = useState("");
  const [postAuthor, setPostAuthor] = useState("");
  const [mode, setMode] = useState<"paste" | "csv">("paste");
  const [pasted, setPasted] = useState("");
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // A fresh form for each play: the previous upload's post and people belong to it.
    setEngagement("commented"); setPostUrl(""); setPostTitle(""); setPostAuthor(""); setMode("paste"); setPasted(""); setCsv(null); setError(null); setResult(null); setBusy(false);
  }, [play?.id]);
  useEffect(() => { if (result) resultRef.current?.focus(); }, [result]);

  if (!play) return null;

  const lines = pasted.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const postOk = !postUrl.trim() || /^https?:\/\/\S+$/i.test(postUrl.trim());
  const tooLong = lines.findIndex((l) => l.length > 600);
  const problem =
    !postOk ? "The post link must start with http:// or https://."
    : mode === "paste" && lines.length === 0 ? "Paste at least one profile link."
    : mode === "paste" && tooLong >= 0 ? `Line ${tooLong + 1} is too long to be a profile link. Put one link on each line.`
    : mode === "paste" && lines.length > UPLOAD_MAX_PEOPLE ? `That is ${plural(lines.length, "line")}. One upload takes up to ${UPLOAD_MAX_PEOPLE.toLocaleString()} - split the list and upload it in parts.`
    : mode === "csv" && !csv ? "Choose a CSV file."
    : null;

  const pickFile = async (file: File | undefined) => {
    setError(null);
    if (!file) { setCsv(null); return; }
    try {
      const text = await file.text();
      if (text.length > UPLOAD_MAX_CSV_CHARS) {
        setCsv(null);
        if (fileRef.current) fileRef.current.value = "";
        setError({ message: "That file is larger than one upload accepts (about 2 MB). Split it into smaller files and upload them one at a time.", quota: false });
        return;
      }
      setCsv({ name: file.name, text });
    } catch {
      setCsv(null);
      setError({ message: "That file could not be read. Choose it again, or paste the profile links instead.", quota: false });
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { engagement };
      if (postUrl.trim()) body.postUrl = postUrl.trim();
      if (postTitle.trim()) body.postTitle = postTitle.trim();
      if (postAuthor.trim()) body.postAuthor = postAuthor.trim();
      // One row per pasted line, in order, so "row 3" in the answer is the third line pasted.
      if (mode === "paste") body.people = lines.map((l) => (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(l) ? { email: l } : { linkedinUrl: l }));
      else body.csv = csv?.text ?? "";
      const r = await apiFetch<UploadResult>("POST", `/v1/plays/${encodeURIComponent(play.id)}/upload`, body, undefined, { timeoutMs: 120_000 });
      const rejected = Array.isArray(r.rejected) ? r.rejected.filter((x) => x && typeof x.row === "number") : [];
      setResult({ run: r.run ?? null, added: Number(r.added) || 0, duplicates: Number(r.duplicates) || 0, rejected, rejectedCount: typeof r.rejectedCount === "number" ? r.rejectedCount : rejected.length });
      onDone();
    } catch (e) {
      const said = messageOf(e);
      setError({ message: said, quota: isQuota(e) });
      if (isForbidden(e)) onForbidden(said);
    } finally {
      setBusy(false);
    }
  };

  const runNote = result?.run ? clean(result.run.note, 400) : "";

  return (
    <Modal open onClose={onClose} title={`Upload people to "${clean(play.name, 80)}"`} wide>
      {result ? (
        <div ref={resultRef} tabIndex={-1} className="outline-none" data-testid="upload-result">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-cream p-3"><div className="text-xs text-ink-400">Added for review</div><div className="text-xl font-semibold" data-testid="upload-added">{result.added.toLocaleString()}</div></div>
            <div className="rounded-lg bg-cream p-3"><div className="text-xs text-ink-400">Already in this play</div><div className="text-xl font-semibold" data-testid="upload-duplicates">{result.duplicates.toLocaleString()}</div></div>
            <div className={`rounded-lg p-3 ${result.rejectedCount > 0 ? "bg-amber-50" : "bg-cream"}`}><div className="text-xs text-ink-400">Not used</div><div className="text-xl font-semibold" data-testid="upload-rejected">{result.rejectedCount.toLocaleString()}</div></div>
          </div>
          {result.run && runFailed(result.run.status) && <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">{runNote || "The upload could not be processed. Nothing was added."}</div>}
          {result.run && !runFailed(result.run.status) && runNote && <p className="mt-3 text-sm text-ink-300 [overflow-wrap:anywhere]">{runNote}</p>}
          {result.added === 0 && result.rejectedCount === 0 && result.duplicates > 0 && <p className="mt-3 text-sm text-ink-300">Everyone in this upload was already in the play, so nothing new was added.</p>}
          {result.rejected.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-ink-100">Rows that were not used, and why</div>
              <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-black/10 text-sm" data-testid="upload-rejected-rows">
                {result.rejected.map((r, i) => (
                  <li key={`${r.row}-${i}`} className="flex gap-3 px-3 py-1.5 [overflow-wrap:anywhere]"><span className="w-16 shrink-0 tabular-nums text-ink-400">Row {r.row}</span><span className="min-w-0 text-ink-200">{clean(r.reason, 300) || "This row could not be used."}</span></li>
                ))}
              </ul>
              {result.rejectedCount > result.rejected.length && <p className="mt-1 text-xs text-ink-400">Showing the first {result.rejected.length} of {plural(result.rejectedCount, "row")} that were not used.</p>}
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            {result.added > 0 && <button type="button" className="btn-primary" onClick={() => onReview(play)}>Review {plural(result.added, "person", "people")}</button>}
            <button type="button" className="btn-secondary" onClick={() => { setResult(null); setPasted(""); setCsv(null); }}>Upload more</button>
            <button type="button" className="btn-secondary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="upload-form">
          <p className="text-sm text-ink-300 sm:col-span-2">Bring the list of people who engaged - from a post&apos;s reactions and comments, a sign-up sheet, an event. Each one lands in Review with what they did as the reason. Nobody is contacted until you approve them.</p>
          <div>
            <label className="label" htmlFor="up-engagement">What did they do?</label>
            <select id="up-engagement" className="input" value={engagement} onChange={(e) => setEngagement(e.target.value)}>{ENGAGEMENTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          </div>
          <div>
            <label className="label" htmlFor="up-url">Link to the post (optional)</label>
            <input id="up-url" className="input" inputMode="url" maxLength={2000} placeholder="https://www.linkedin.com/posts/…" value={postUrl} onChange={(e) => setPostUrl(e.target.value)} />
            <p className="mt-1 text-xs text-ink-400">Shown as the proof on each person.</p>
          </div>
          <div><label className="label" htmlFor="up-title">Post title (optional)</label><input id="up-title" className="input" maxLength={200} placeholder="What the post was about" value={postTitle} onChange={(e) => setPostTitle(e.target.value)} /></div>
          <div><label className="label" htmlFor="up-author">Who posted it (optional)</label><input id="up-author" className="input" maxLength={120} placeholder="Name of the author" value={postAuthor} onChange={(e) => setPostAuthor(e.target.value)} /></div>

          <fieldset className="sm:col-span-2">
            <legend className="label">The people</legend>
            <div className="mb-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="up-mode" checked={mode === "paste"} onChange={() => setMode("paste")} /> Paste profile links</label>
              <label className="flex items-center gap-2"><input type="radio" name="up-mode" checked={mode === "csv"} onChange={() => setMode("csv")} /> Upload a CSV</label>
            </div>
            {mode === "paste" ? (
              <>
                <textarea className="input h-40 font-mono text-xs" aria-label="LinkedIn profile links, one per line" placeholder={"https://www.linkedin.com/in/priya-raman\nhttps://www.linkedin.com/in/james-okafor"} value={pasted} onChange={(e) => setPasted(e.target.value)} />
                <p className="mt-1 text-xs text-ink-400">One LinkedIn profile link per line{lines.length > 0 ? ` - ${plural(lines.length, "line")} so far` : ""}. An email address on a line works too.</p>
              </>
            ) : (
              <>
                <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" aria-label="CSV file of people" className="block w-full text-sm text-ink-200 file:mr-3 file:rounded-lg file:border file:border-black/10 file:bg-black/[0.03] file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink-100" onChange={(e) => pickFile(e.target.files?.[0])} />
                <p className="mt-1 text-xs text-ink-400">{csv ? `${csv.name} is ready. ` : ""}Recognised columns: name, title, company, website, linkedin, email, location. Each row needs a LinkedIn profile link, an email, or a name and a company.</p>
              </>
            )}
          </fieldset>

          {error && (
            <div className={`rounded-lg px-3 py-2 text-sm sm:col-span-2 ${error.quota ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`} role="alert" data-testid="upload-error">
              Nothing was uploaded: {error.message} {error.quota && <Link className="font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
            </div>
          )}
          <div className="sm:col-span-2">
            <button type="button" className="btn-primary w-full justify-center" disabled={busy || !!problem} onClick={submit}>{busy ? "Uploading…" : "Upload"}</button>
            {problem && <p className="mt-1 text-center text-xs text-ink-400">{problem}</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
