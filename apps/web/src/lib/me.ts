import { useEffect, useState } from "react";
import { apiFetch, auth } from "./api";

export type Role = "owner" | "admin" | "member";
export interface Me {
  user: { id: string; email: string; role: Role; hasPassword?: boolean } | null;
  org: { name: string; settings: Record<string, string> };
}

/**
 * Who is looking, for deciding which controls to show.
 *
 * Members get 403 from the things only an owner or admin may do - API keys, workspace
 * settings, invites, webhooks, integrations, sender accounts, client report links, pushing
 * leads to a CRM - so those controls are shown only to owners and admins. A button that can
 * only ever answer "Only a workspace owner or admin can do this" is worse than no button.
 *
 * While the role is unknown (still loading, or the lookup failed) `canManage` is TRUE: the
 * controls stay visible and the server remains the authority. That is deliberate - hiding
 * until known would make every owner's buttons flash in a moment after the page, and a
 * failed lookup would lock an owner out of their own settings. Use `settled` where acting
 * on "unknown" has a cost (see the security log, which waits rather than logging a refusal).
 */
let meCache: Me | null = null;
let inflight: Promise<Me> | null = null;

// The cache is "who is signed in", so it cannot outlive the session it was read for. It used
// to: sign out as an owner, sign in as a member in the same tab, and Settings briefly showed
// the owner's controls from the previous account.
auth.subscribe(() => {
  meCache = null;
  inflight = null;
});

/** One request however many components ask at once (a page and three panels on it). */
function fetchMe(): Promise<Me> {
  if (inflight) return inflight;
  const forToken = auth.token;
  const p: Promise<Me> = apiFetch<Me>("GET", "/v1/auth/me")
    .then((r) => {
      // Not cached if the session changed while this was in the air: it describes whoever
      // was signed in when it was sent.
      if (auth.token === forToken) meCache = r;
      return r;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Replace the cached account after a change this app made itself (e.g. a password was set). */
export function rememberMe(me: Me | null) {
  meCache = me;
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(meCache);
  // `settled`: the role question has been answered one way or the other - the account is
  // known (cached or just loaded) or the lookup failed. Lets a caller wait for the answer
  // before acting on "unknown means allowed", instead of acting and then finding out.
  const [settled, setSettled] = useState<boolean>(!!meCache);
  useEffect(() => {
    let live = true;
    fetchMe()
      .then((r) => { if (live) setMe(r); })
      .catch(() => {})
      .finally(() => { if (live) setSettled(true); });
    return () => { live = false; };
  }, []);
  const role = me?.user?.role;
  return { me, role, settled, canManage: role === undefined || role === "owner" || role === "admin", isOwner: role === undefined || role === "owner" };
}
