import { useEffect, useState } from "react";
import { apiFetch, auth } from "./api";

export type Role = "owner" | "admin" | "member";
export interface Me {
  /**
   * `emailVerified`, `twoFactorEnabled` and `twoFactorEnabledAt` are absent on an older
   * server. Absent is "this server has no such feature", never "off": the controls that
   * depend on them are not offered at all rather than offered and refused.
   */
  user: { id: string; email: string; role: Role; hasPassword?: boolean; emailVerified?: boolean; twoFactorEnabled?: boolean; twoFactorEnabledAt?: string | null } | null;
  org: { name: string; settings: Record<string, string>; emailVerificationAvailable?: boolean };
  emailVerificationAvailable?: boolean;
}

/**
 * Whether this deployment can send a confirmation email at all. When it cannot, nothing is
 * restricted for an unconfirmed address, so nothing should nag about one either. The server
 * may say so at the top level or on the workspace; either is read.
 */
export function emailVerificationAvailable(me: { emailVerificationAvailable?: unknown; org?: { emailVerificationAvailable?: unknown } | null } | null | undefined): boolean {
  return me?.emailVerificationAvailable === true || me?.org?.emailVerificationAvailable === true;
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

/**
 * Replace the cached account after a change this app made itself (e.g. a password was set,
 * two-factor was turned on).
 *
 * Every mounted useMe() hears about it. It used to update only the cache, which was enough
 * while each change was read back by the component that made it; turning two-factor on in
 * one card has to reach the password form next to it, which must then ask for a code.
 */
const meListeners = new Set<(me: Me) => void>();
export function rememberMe(me: Me | null) {
  meCache = me;
  if (me) meListeners.forEach((fn) => fn(me));
}

/** Drop the cached account so the next reader asks the server (e.g. the email was just confirmed). */
export function forgetMe() {
  meCache = null;
  inflight = null;
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
    const onChange = (m: Me) => { if (live) setMe(m); };
    meListeners.add(onChange);
    return () => { live = false; meListeners.delete(onChange); };
  }, []);
  const role = me?.user?.role;
  return { me, role, settled, canManage: role === undefined || role === "owner" || role === "admin", isOwner: role === undefined || role === "owner" };
}
