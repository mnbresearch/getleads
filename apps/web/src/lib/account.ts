import { useSyncExternalStore } from "react";
import { ProspexError, apiFetch, auth } from "./api";

/**
 * Whether this workspace is scheduled for deletion.
 *
 * One answer shared by the banner in the app shell and the "Delete workspace" card in
 * Settings, so scheduling or cancelling in Settings changes the banner at once instead of
 * after the next reload.
 *
 * `null` means "not known yet" (not asked, or the question failed). The banner treats that
 * as nothing to show; the Settings card says it could not check, because there a wrong
 * "not scheduled" would invite scheduling it twice.
 */
export interface Deletion {
  pending: boolean;
  scheduledFor: string | null;
  /** Whether this person may call it off, when the server says (otherwise: the owner may). */
  canCancel?: boolean;
  /** Who asked for it, when the server says and that person is still in the workspace. */
  requestedBy?: string | null;
}

let state: Deletion | null = null;
let inflight: Promise<Deletion> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

// The answer belongs to the workspace that was signed in when it was asked.
auth.subscribe(() => {
  state = null;
  inflight = null;
  emit();
});

export function setDeletion(d: Deletion | null) {
  state = d;
  emit();
}

/** True when the server simply has no such thing (an older server) or will not say to this role. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ProspexError && (e.status === 404 || e.status === 405);
}

/**
 * Ask the server. An older server (404) and a role the server will not answer (403) both
 * come back as "nothing pending": there is nothing this person could be shown or could do.
 * Anything else is a failed check and is thrown, so the caller can say so.
 */
export function loadDeletion(): Promise<Deletion> {
  if (inflight) return inflight;
  const forToken = auth.token;
  const p: Promise<Deletion> = apiFetch<{ pending?: unknown; scheduledFor?: unknown; canCancel?: unknown; requestedBy?: { name?: unknown; email?: unknown } | null }>("GET", "/v1/account/deletion")
    .then((r): Deletion => {
      const by = r?.requestedBy;
      const who = by && typeof by === "object" ? (typeof by.name === "string" && by.name ? by.name : typeof by.email === "string" && by.email ? by.email : null) : null;
      return {
        pending: r?.pending === true,
        scheduledFor: typeof r?.scheduledFor === "string" && r.scheduledFor ? r.scheduledFor : null,
        ...(typeof r?.canCancel === "boolean" ? { canCancel: r.canCancel } : {}),
        requestedBy: who,
      };
    })
    .catch((e) => {
      if (isUnavailable(e) || (e instanceof ProspexError && e.status === 403)) return { pending: false, scheduledFor: null };
      throw e;
    })
    .then((d) => {
      if (auth.token === forToken) setDeletion(d);
      return d;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export function useDeletion(): Deletion | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/** Campaign names from a server answer, as "A, B and 2 more". */
function campaignNames(list: unknown): { count: number; text: string } {
  const names = Array.isArray(list) ? list.map((c) => (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string" ? (c as { name: string }).name : null)).filter((n): n is string => !!n) : [];
  const count = Array.isArray(list) ? list.length : 0;
  const shown = names.slice(0, 3).join(", ");
  return { count, text: names.length > 3 ? `${shown} and ${count - 3} more` : shown };
}

/**
 * What scheduling the deletion did to the campaigns, in a sentence - or "" when the server
 * did not say.
 */
export function pausedNote(r: { pausedCampaigns?: unknown } | null | undefined): string {
  if (!Array.isArray(r?.pausedCampaigns)) return "";
  const { count, text } = campaignNames(r.pausedCampaigns);
  if (count === 0) return "No campaigns were running, so none had to be paused.";
  return `${count === 1 ? "1 campaign was" : `${count} campaigns were`} paused${text ? `: ${text}` : ""}.`;
}

/**
 * The sentence after "Deletion cancelled".
 *
 * The server does not restart the campaigns it paused - that would send email nobody asked
 * for again - and lists them instead, so they can be started deliberately. Without that
 * list (a server that does not send one) the advice is the version that is true either way.
 */
export function cancelNote(r: { note?: unknown; message?: unknown; pausedCampaigns?: unknown } | null | undefined): string {
  const said = typeof r?.note === "string" && r.note ? r.note : typeof r?.message === "string" && r.message ? r.message : null;
  if (said) return said;
  if (Array.isArray(r?.pausedCampaigns)) {
    const { count, text } = campaignNames(r.pausedCampaigns);
    if (count === 0) return "No campaigns had been paused, so there is nothing to restart.";
    return `${count === 1 ? "1 campaign" : `${count} campaigns`} paused by the deletion ${count === 1 ? "stays" : "stay"} paused${text ? ` (${text})` : ""} - start ${count === 1 ? "it" : "them"} again from Campaigns when you are ready.`;
  }
  return "Check Campaigns: any that were paused may need starting again.";
}

/** What the owner is asked before a scheduled deletion is called off. */
export const CANCEL_DELETION_CONFIRM = "Cancel the deletion of this workspace?\n\nNothing is deleted and the workspace carries on as before. Campaigns that were paused are not restarted automatically - you start them again yourself.";

/** Call off a scheduled deletion. Resolves with the sentence to show; the banner updates itself. */
export async function cancelDeletion(): Promise<string> {
  const r = await apiFetch<{ note?: unknown; message?: unknown; pausedCampaigns?: unknown } | null>("POST", "/v1/account/delete/cancel");
  setDeletion({ pending: false, scheduledFor: null });
  return cancelNote(r);
}
