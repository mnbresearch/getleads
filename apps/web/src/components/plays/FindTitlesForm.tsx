import { useState } from "react";

/** Asks which job titles to look for at a company, for a play that has none saved. */
export function FindTitlesForm({ id, name, busy, onFind }: { id: string; name: string; busy: boolean; onFind: (titles: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const wanted = draft.split(",").map((t) => t.trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" data-testid="find-titles" onSubmit={(e) => { e.preventDefault(); if (wanted.length) onFind(wanted); }}>
      <div className="min-w-0 flex-1 basis-56">
        <label className="label" htmlFor={`find-titles-${id}`}>Which job titles to look for at {name}</label>
        <input id={`find-titles-${id}`} className="input py-1.5" autoFocus maxLength={600} placeholder="VP Operations, Head of Customer Success" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <button type="submit" className="btn-secondary py-1.5" disabled={busy || wanted.length === 0}>Find</button>
      <p className="basis-full text-xs text-ink-400">This play has no job titles saved. Separate several with commas - or add them to the play under Edit so you are not asked again.</p>
    </form>
  );
}
