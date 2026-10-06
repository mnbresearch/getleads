import { ExtLink } from "../ExtLink";
import { clean, hostOf } from "../../lib/plays";

/**
 * Why this lead is here, for a lead that was approved from a play.
 *
 * The reason and the link were stored on the lead when it was approved (`custom.relevant_because`,
 * `custom.evidence_url`, `custom.play_name`). They began life on somebody else's web page, so
 * the sentence is rendered as text and the link only through ExtLink. A lead that did not
 * come from a play has none of these and renders nothing.
 */
export function PlayReason({ custom }: { custom: Record<string, unknown> | null | undefined }) {
  const reason = clean(custom?.relevant_because, 400);
  if (!reason) return null;
  const play = clean(custom?.play_name, 120);
  const host = hostOf(custom?.evidence_url);
  return (
    <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50/60 p-3 text-sm [overflow-wrap:anywhere]" data-testid="lead-play-reason">
      <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Relevant because</div>
      <p className="mt-1 text-ink-50">{reason}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400">
        {play && <span>Found by the play &quot;{play}&quot;</span>}
        <ExtLink className="text-brand-600 hover:underline" href={custom?.evidence_url}>
          See the proof{host ? ` on ${host}` : ""} ↗
        </ExtLink>
      </div>
    </div>
  );
}
