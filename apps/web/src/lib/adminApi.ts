import { useSyncExternalStore } from "react";
import { API_URL, UNREADABLE_CODE, UNREADABLE_MESSAGE, errorCode, errorMessage, networkErrorMessage, unreadableSuccess } from "./api";

const TOKEN_KEY = "gl.admin.token";
const listeners = new Set<() => void>();

export const adminAuth = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);
    } catch {}
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Signing out of the admin console in one tab signs out the others (see lib/api.ts).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY || e.key === null) listeners.forEach((fn) => fn());
  });
}

export function useAdminToken(): string | null {
  return useSyncExternalStore(adminAuth.subscribe, () => adminAuth.token);
}

/**
 * "Your admin session expired", handed to the login page.
 *
 * A rejected token used to drop the admin on a bare sign-in form mid-task with no word of
 * why - indistinguishable from having been signed out by someone else, or from a bug.
 * sessionStorage for the same reason as the customer app: the hop to /admin/login may be a
 * full reload.
 */
const EXPIRED_KEY = "gl.admin.sessionExpired";

function markAdminSessionExpired() {
  try {
    sessionStorage.setItem(EXPIRED_KEY, "1");
  } catch {}
}

/** The notice for the admin login page, once. Reading it clears it. */
export function adminSessionExpiredNotice(): string | null {
  try {
    if (sessionStorage.getItem(EXPIRED_KEY)) {
      sessionStorage.removeItem(EXPIRED_KEY);
      return "Your admin session expired - sign in again.";
    }
  } catch {}
  return null;
}

/**
 * The server said this admin token is no longer good: drop it and say so on the login page.
 * Does nothing unless `sentToken` is still the stored one (a slow 401 for an old token must
 * not wipe a newer sign-in).
 */
export function endAdminSession(sentToken: string | null) {
  if (!sentToken || adminAuth.token !== sentToken) return;
  markAdminSessionExpired();
  adminAuth.set(null);
}

/**
 * Sign out: tell the server to retire the token, and forget it here whatever the answer.
 *
 * The local sign-out never waits on, or depends on, the request - an API that is down or
 * that has no logout route yet (older server) must not keep an admin signed in on a shared
 * machine. keepalive lets the request outlive the navigation that follows.
 */
export function adminLogout() {
  const token = adminAuth.token;
  adminAuth.set(null);
  if (!token) return;
  // Remembered until the server has heard it: if this request never arrives (API down, no
  // network), the token would otherwise stay valid server-side until it expires on its own.
  setPendingRevoke(token);
  void revokeAdminToken(token).then((reached) => { if (reached) clearPendingRevoke(token); });
}

const PENDING_REVOKE_KEY = "gl.admin.pendingLogout";

function setPendingRevoke(token: string) {
  try {
    sessionStorage.setItem(PENDING_REVOKE_KEY, token);
  } catch {}
}
function clearPendingRevoke(token: string) {
  try {
    if (sessionStorage.getItem(PENDING_REVOKE_KEY) === token) sessionStorage.removeItem(PENDING_REVOKE_KEY);
  } catch {}
}

/** POST /v1/admin/logout for `token`. Resolves true when the server answered at all. */
function revokeAdminToken(token: string): Promise<boolean> {
  try {
    return fetch(`${API_URL}/v1/admin/logout`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}", keepalive: true }).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * One more try at a sign-out the server never heard, then forget the token either way.
 *
 * Runs once per page load, on an admin page. Best-effort by design: it is not awaited by
 * anything, it never touches the UI, and a second failure is not retried - the token is
 * dropped from this tab regardless, and expires server-side on its own.
 */
export function retryPendingAdminLogout() {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(PENDING_REVOKE_KEY);
    if (token) sessionStorage.removeItem(PENDING_REVOKE_KEY);
  } catch {}
  // Never the token currently in use: signing in again must not be undone by an old sign-out.
  if (!token || token === adminAuth.token) return;
  void revokeAdminToken(token);
}

if (typeof window !== "undefined" && window.location.pathname.startsWith("/admin")) retryPendingAdminLogout();

export class AdminApiError extends Error {
  constructor(public status: number, message: string, public code: string = "http_error") {
    super(message);
  }
}

// Same backstop as apiFetch: fetch never times out on its own, and the admin console showed a
// spinner forever when the API hung or the network dropped.
const ADMIN_TIMEOUT_MS = 45_000;

export async function adminFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ADMIN_TIMEOUT_MS);
  let res: Response;
  let text: string;
  const sentToken = adminAuth.token;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new AdminApiError(0, `The server did not respond within ${ADMIN_TIMEOUT_MS / 1000} seconds.`, "timeout");
    throw new AdminApiError(0, networkErrorMessage(body === undefined ? 0 : JSON.stringify(body).length), "network_error");
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = text;
  let parsed = false;
  try {
    data = JSON.parse(text);
    parsed = true;
  } catch {}
  if (!res.ok) {
    // A rejected admin token is dropped at once rather than left in storage. Only if it is
    // still the stored one: a slow 401 for an old token must not wipe a newer sign-in.
    // The login request itself is excluded: a wrong password is not an expired session.
    if (res.status === 401 && path !== "/v1/admin/login") endAdminSession(sentToken);
    throw new AdminApiError(res.status, errorMessage(data, res.status), errorCode(data));
  }
  // A 200 that is HTML or otherwise not JSON is not an answer (see unreadableSuccess).
  if (unreadableSuccess(text, parsed, res.headers.get("content-type"))) throw new AdminApiError(res.status, UNREADABLE_MESSAGE, UNREADABLE_CODE);
  return data as T;
}
