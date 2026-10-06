import { Link } from "react-router-dom";
import { fmtDate } from "../../lib/api";
import { DeleteButton } from "../ui";
import { plural } from "../../lib/plural";
import { ago, clean, playInputs, runFailed, runProblemTitle, runSentence, scheduleLabel, typeName, typeTone, type PlayOut, type PlayTypeInfo } from "../../lib/plays";

export interface RunProblem { message: string; quota: boolean }

/**
 * One play: what it looks for, what is waiting, what its last run said, and what to do next.
 *
 * A run that could not search is never shown as a quiet "found 0" - that reads as "there is
 * nobody out there". It gets an amber banner with the server's own sentence instead.
 */
export function PlayCard({
  play, types, campaignName, clientName, running, problem, toggling, onRun, onUpload, onEdit, onToggle, onDelete, onReview, onError,
}: {
  play: PlayOut;
  types: PlayTypeInfo[] | null;
  campaignName?: string;
  clientName?: string;
  running: boolean;
  problem?: RunProblem;
  toggling: boolean;
  onRun: () => void;
  onUpload: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => Promise<unknown>;
  onReview: () => void;
  onError: (message: string) => void;
}) {
  const upload = play.type === "engagers_upload";
  const paused = play.status === "paused";
  const last = play.lastResult;
  const failed = runFailed(last?.status);
  const titles = (play.targetTitles ?? []).map((t) => clean(t, 100)).filter(Boolean);
  const inputs = playInputs(play.type, play.config);
  const counts = play.counts ?? { pending: 0, approved: 0, skipped: 0 };
  const lastWhen = ago(play.lastRunAt);
  const name = clean(play.name, 120) || "Untitled play";
  return (
    <li className="card flex flex-col p-4 [overflow-wrap:anywhere]" data-testid="play-card" data-id={play.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className={`badge ${typeTone(play.type)}`}>{typeName(types, play.type)}</span>
          <h3 className="mt-1 text-base font-semibold text-ink-50">{name}</h3>
        </div>
        <span className={`badge shrink-0 ${running ? "bg-brand-50 text-brand-700" : paused ? "bg-black/[0.05] text-ink-300" : "bg-emerald-50 text-emerald-700"}`}>{running ? "running" : paused ? "paused" : "active"}</span>
      </div>
      {inputs && <p className="mt-1 text-sm text-ink-300">{inputs}</p>}
      {titles.length > 0 && <p className="mt-1 text-xs text-ink-400">Looks for: {titles.slice(0, 4).join(", ")}{titles.length > 4 ? ` and ${titles.length - 4} more` : ""}</p>}

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className={`rounded-lg p-2 ${counts.pending > 0 ? "bg-brand-50" : "bg-cream"}`}><dt className="text-ink-400">Waiting</dt><dd className="text-base font-semibold tabular-nums" data-testid="count-pending">{(counts.pending ?? 0).toLocaleString()}</dd></div>
        <div className="rounded-lg bg-cream p-2"><dt className="text-ink-400">Approved</dt><dd className="text-base font-semibold tabular-nums">{(counts.approved ?? 0).toLocaleString()}</dd></div>
        <div className="rounded-lg bg-cream p-2"><dt className="text-ink-400">Skipped</dt><dd className="text-base font-semibold tabular-nums">{(counts.skipped ?? 0).toLocaleString()}</dd></div>
      </dl>

      {problem && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert" data-testid="run-problem">
          This play did not start: {problem.message} {problem.quota && <Link className="font-medium underline" to="/settings/billing">See plan &amp; usage</Link>}
        </div>
      )}
      {failed && !running && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert" data-testid="run-blocked">
          <span className="font-medium">{runProblemTitle(last?.status)}</span> {runSentence(last)}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-400" data-testid="last-run">
        {running ? "Running now - this usually takes a minute or two."
          : !play.lastRunAt && !last ? (upload ? "Nothing uploaded yet." : "Not run yet.")
          : failed ? (play.lastRunAt ? <span title={fmtDate(play.lastRunAt)}>{last?.status === "skipped" ? "Last ran" : "Last tried"} {lastWhen || fmtDate(play.lastRunAt)}.</span> : "Not run yet.")
          : <><span title={fmtDate(play.lastRunAt)}>{upload ? "Last upload" : "Last run"} {lastWhen || fmtDate(play.lastRunAt)}:</span> {runSentence(last) || "finished."}</>}
      </p>
      <p className="mt-1 text-xs text-ink-400">
        {upload ? "Fed by your uploads" : paused ? `Paused - ${play.runEveryHours ? "its schedule is on hold" : "runs when you press Run"}` : scheduleLabel(play.runEveryHours)}
        {!upload && !paused && play.runEveryHours && play.nextRunAt ? ` · next ${ago(play.nextRunAt) || fmtDate(play.nextRunAt)}` : ""}
        {play.campaignId ? ` · campaign: ${clean(campaignName, 60) || "attached"}` : ""}
        {play.clientId ? ` · for client: ${clean(clientName, 60) || "assigned"}` : ""}
      </p>
      {play.autoApprove && <p className="mt-1 text-xs font-medium text-amber-700">Approves on its own: people scoring {play.minScore} or more become leads without review.</p>}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs">
        {counts.pending > 0 && <button type="button" className="btn-primary py-1" onClick={onReview}>Review {counts.pending.toLocaleString()}</button>}
        {upload
          ? <button type="button" className="btn-secondary py-1" onClick={onUpload}>Upload</button>
          : <button type="button" className="btn-secondary py-1" disabled={running} onClick={onRun}>{running ? "Running…" : "Run now"}</button>}
        <button type="button" className="btn-secondary py-1" onClick={onEdit}>Edit</button>
        <button type="button" className="btn-secondary py-1" disabled={toggling} onClick={onToggle}>{paused ? "Resume" : "Pause"}</button>
        <DeleteButton
          what={`the play "${name}"`}
          consequence={`${counts.pending > 0 ? `${plural(counts.pending, "person", "people")} waiting for review ${counts.pending === 1 ? "is" : "are"} removed with it, along with its run history.` : "Its run history and anyone still waiting for review are removed with it."} Leads you already approved stay.`}
          className="ml-auto"
          onDelete={onDelete}
          onError={onError}
        />
      </div>
    </li>
  );
}
