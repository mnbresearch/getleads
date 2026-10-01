import { useSyncExternalStore } from "react";
import { Prospex, ProspexError } from "@prospex/sdk";

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8080";

const TOKEN_KEY = "gl.token";
const authListeners = new Set<() => void>();
export const auth = {
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
    authListeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void) {
    authListeners.add(fn);
    return () => authListeners.delete(fn);
  },
};

export function useAuthToken(): string | null {
  return useSyncExternalStore(auth.subscribe, () => auth.token);
}

export function client() {
  return new Prospex({ baseUrl: API_URL, token: auth.token ?? undefined });
}

export { ProspexError };

/**
 * How long any single request may hang before we give up on it.
 *
 * `fetch` has no timeout of its own. A server that accepts the connection, completes the
 * TLS handshake and then sends nothing leaves the promise pending forever - it never
 * resolves and it never rejects - so every caller that shows a spinner until the promise
 * settles shows that spinner until the tab is closed.
 *
 * That is not hypothetical. The landing page sat on "Loading plans…" through an edge
 * outage where the API itself was healthy and answering on its origin URL; the only thing
 * on screen was a spinner, because the code was still politely waiting. A request that
 * cannot be answered has to become an error, or the failure is indistinguishable from
 * slowness and every error state downstream is unreachable.
 *
 * Generous on purpose: this is a backstop against a hang, not a latency budget. Nothing
 * interactive in this app takes anywhere near this long - the slow work (search, scans)
 * runs as a job and is polled - so a request still running at this point is not running.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** Thrown when a request was abandoned rather than answered. */
export const TIMEOUT_CODE = "timeout";

export async function apiFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  raw?: { contentType: string; body: string },
  opts?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // AbortController rather than AbortSignal.timeout: the latter is not in every browser
  // this app is expected to run in, and a missing timeout is exactly the bug being fixed.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(raw ? { "content-type": raw.contentType } : { "content-type": "application/json" }), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    // Reading the body is inside the timer too: a server that sends headers and then stalls
    // mid-body hangs res.text() exactly the way a silent server hangs fetch().
    text = await res.text();
  } catch (e) {
    // Told apart from a network refusal on purpose. "We gave up waiting" and "the browser
    // could not reach the server" have different causes and deserve different words.
    if ((e as Error)?.name === "AbortError") {
      throw new ProspexError(0, TIMEOUT_CODE, `The server did not respond within ${Math.round(timeoutMs / 1000)} seconds.`, null);
    }
    throw new ProspexError(0, "network_error", "Could not reach the server. Check your connection and try again.", null);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && auth.token) {
      // A token we held was rejected: the session ended. Say so on the login page and come
      // back here afterwards, instead of dropping the user on a blank login form with no idea
      // why. (A 401 with no token is a wrong password on /login - not an expiry.)
      markSessionExpired();
      auth.set(null);
    }
    throw new ProspexError(res.status, errorCode(data), errorMessage(data, res.status), data);
  }
  return data as T;
}

/**
 * The human sentence in an error body, whichever shape the server used.
 *
 * Three shapes are in the wild: {error:{code,message,issues}} (current), the validator's
 * {success:false, error:{issues:[{path,message}]}} (older servers), and {error:"...", note}
 * (a few hand-written routes). Reading only error.message turned the last two into a bare
 * "HTTP 400", and a toast handed the error object itself crashed React.
 */
export function errorMessage(data: unknown, status: number): string {
  const d = (data ?? {}) as { error?: unknown; note?: unknown; message?: unknown };
  const e = d.error;
  if (typeof e === "string" && e) return typeof d.note === "string" && d.note ? `${e} - ${d.note}` : e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; issues?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    if (Array.isArray(o.issues) && o.issues.length) {
      return o.issues
        .map((i: { path?: unknown; message?: unknown }) => {
          const path = Array.isArray(i?.path) ? i.path.join(".") : typeof i?.path === "string" ? i.path : "";
          return path ? `${path}: ${String(i?.message ?? "invalid")}` : String(i?.message ?? "invalid");
        })
        .join("; ");
    }
  }
  if (typeof d.note === "string" && d.note) return d.note;
  if (typeof d.message === "string" && d.message) return d.message;
  return `HTTP ${status}`;
}

export function errorCode(data: unknown): string {
  const e = (data as { error?: { code?: unknown } } | null)?.error;
  if (e && typeof e === "object" && typeof e.code === "string") return e.code;
  return "http_error";
}

// Session-expiry hand-off to the login page. sessionStorage, not memory: the redirect to
// /login may be a full reload (Protected renders <Navigate>, but a user may also refresh).
const EXPIRED_KEY = "gl.sessionExpired";
const RETURN_KEY = "gl.returnPath";
const NO_RETURN = ["/login", "/signup", "/forgot-password", "/reset-password", "/join", "/auth/google"];

function markSessionExpired() {
  try {
    sessionStorage.setItem(EXPIRED_KEY, "1");
    const here = window.location.pathname + window.location.search;
    if (!NO_RETURN.some((p) => window.location.pathname.startsWith(p))) sessionStorage.setItem(RETURN_KEY, here);
  } catch {}
}

/** Remember where to go after sign-in (e.g. Protected bouncing a signed-out deep link). */
export function rememberReturnPath(path: string) {
  try {
    if (!NO_RETURN.some((p) => path.startsWith(p))) sessionStorage.setItem(RETURN_KEY, path);
  } catch {}
}

/**
 * The notice the login page should show, once: "Your session expired - sign in again", or
 * null. Reading it clears it so it doesn't reappear on the next visit.
 */
export function sessionExpiredNotice(): string | null {
  try {
    if (sessionStorage.getItem(EXPIRED_KEY)) {
      sessionStorage.removeItem(EXPIRED_KEY);
      return "Your session expired - sign in again.";
    }
  } catch {}
  return null;
}

/**
 * Where to send the user after a successful sign-in, or `fallback`. Reading it clears it.
 * Only same-origin relative paths are returned, so a stored value can't redirect off-site.
 */
export function consumeReturnPath(fallback = "/"): string {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (p && p.startsWith("/") && !p.startsWith("//")) return p;
  } catch {}
  return fallback;
}

export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-");
export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
