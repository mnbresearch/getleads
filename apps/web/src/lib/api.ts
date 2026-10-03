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

// The token lives in localStorage, which every tab of this app shares - but a tab only
// re-reads it when told to. Without this, signing out (or "Sign out of all devices") in one
// tab left every other open tab showing the signed-in app until its next failed request.
// `storage` fires only in the *other* tabs, which is exactly who needs telling.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TOKEN_KEY || e.key === null) authListeners.forEach((fn) => fn());
  });
}

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
  opts?: {
    timeoutMs?: number;
    /**
     * Send no Authorization header and leave the stored session alone whatever the answer.
     * For calls that establish a session rather than use one (the Google code exchange): a
     * rejected sign-in attempt must not sign out, or mark as "expired", a session it never
     * touched.
     */
    anonymous?: boolean;
    /**
     * This request re-confirms who is asking - it carries the password or a two-factor code
     * along with the session (turning two-factor off, deleting the workspace). A 401 for it
     * that is anything other than "unauthorized" means the password or code was wrong, not
     * that the session ended: the person stays signed in and sees the reason. A session that
     * really is gone still answers "unauthorized" and is ended as usual.
     */
    reconfirm?: boolean;
  },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The token this request is sent with, kept so a 401 can be attributed to it (below).
  const sentToken = opts?.anonymous ? null : auth.token;
  // AbortController rather than AbortSignal.timeout: the latter is not in every browser
  // this app is expected to run in, and a missing timeout is exactly the bug being fixed.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  let text: string;
  const sentBody = raw ? raw.body : body === undefined ? undefined : JSON.stringify(body);
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(raw ? { "content-type": raw.contentType } : { "content-type": "application/json" }), ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}) },
      body: sentBody,
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
    // A server (or the proxy in front of it) that refuses an oversized upload usually just
    // closes the connection mid-send. The browser reports that exactly like being offline, so
    // "check your connection" sent people looking in the wrong place.
    throw new ProspexError(0, "network_error", networkErrorMessage(sentBody?.length ?? 0), null);
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
    if (res.status === 401) {
      // A token we held was rejected: the session ended. Say so on the login page and come
      // back here afterwards, instead of dropping the user on a blank login form with no idea
      // why. (A 401 with no token is a wrong password on /login - not an expiry.)
      //
      // Only when the rejected token is still the one in use. Changing the password retires
      // every older token and hands this tab a fresh one; a request already in flight with
      // the old token then comes back 401, and clearing the session on that would sign the
      // user out of the one tab that is supposed to stay signed in.
      if (!(opts?.reconfirm && errorCode(data) !== "unauthorized")) rejectSession(sentToken);
    }
    throw new ProspexError(res.status, errorCode(data), errorMessage(data, res.status), data);
  }
  if (unreadableSuccess(text, parsed, res.headers.get("content-type"))) throw unreadableAnswer(res.status);
  return data as T;
}

/** What the screen says when the server answered "200 OK" with something that is not an answer. */
export const UNREADABLE_MESSAGE = "The server gave an answer this app could not read. Reload the page; if it keeps happening, contact support.";
export const UNREADABLE_CODE = "unreadable_response";

/**
 * A 2xx whose body is not what an API sends: a captive portal's sign-in page, a proxy's
 * placeholder, or this app's own index.html when the API address points at the web host.
 *
 * Those used to be handed to the caller as a string. Nothing threw, so nothing was reported:
 * lists sat on "Loading…" forever or rendered as empty. An empty body is still fine (a 204,
 * a DELETE) - it is a body that is present and is not JSON that is the problem.
 */
export function unreadableSuccess(text: string, parsed: boolean, contentType: string | null): boolean {
  if (text.trim() === "") return false;
  return !parsed || /\bhtml\b/i.test(contentType ?? "");
}

export function unreadableAnswer(status = 200): ProspexError {
  return new ProspexError(status, UNREADABLE_CODE, UNREADABLE_MESSAGE, null);
}

/**
 * The response, once it is known to hold a list under each of `keys` - otherwise the
 * "could not read" error.
 *
 * Valid JSON of the wrong shape (`{"ok":true}` from something that is not this API) is the
 * same failure as HTML, one step later: `setRows(r.leads)` with no `leads` either crashed the
 * page or left it loading. A list page calls this on what it loaded, so a wrong shape takes
 * the same visible error-with-Retry path as any other failed load.
 */
export function expectLists<T>(r: T, ...keys: string[]): T {
  const o = r as unknown as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || keys.some((k) => !Array.isArray(o[k]))) throw unreadableAnswer();
  return r;
}

/** The same check for any other shape: `expectShape(r, (x) => typeof x.token === "string")`. */
export function expectShape<T>(r: T, ok: (r: T) => boolean): T {
  let good = false;
  try {
    good = !!r && typeof r === "object" && ok(r);
  } catch {}
  if (!good) throw unreadableAnswer();
  return r;
}

/** What a gateway error, a rate limit and an oversized upload are called when the server gave no sentence of its own. */
export const UNAVAILABLE_MESSAGE = "The server is temporarily unavailable. Try again in a minute.";
export const RATE_LIMITED_MESSAGE = "Too many requests. Wait a moment and try again.";
export const TOO_LARGE_MESSAGE = "That is larger than the server accepts. Split it into smaller parts and try again.";

/** A request body big enough that "the connection dropped" may really mean "too large". */
const LARGE_BODY_CHARS = 1_000_000;

/** The words for a request that never got an answer, given how much was being sent. */
export function networkErrorMessage(sentChars: number): string {
  if (sentChars >= LARGE_BODY_CHARS) {
    return "The upload did not get through. It may be larger than the server accepts - split it into smaller parts and try again. If it keeps failing, check your connection.";
  }
  return "Could not reach the server. Check your connection and try again.";
}

/** The sentence the server itself sent, or null when the body carried none. */
function serverSentence(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { error?: unknown; note?: unknown; message?: unknown };
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
  return null;
}

/**
 * The human sentence in an error body, whichever shape the server used.
 *
 * Three shapes are in the wild: {error:{code,message,issues}} (current), the validator's
 * {success:false, error:{issues:[{path,message}]}} (older servers), and {error:"...", note}
 * (a few hand-written routes). Reading only error.message turned the last two into a bare
 * "HTTP 400", and a toast handed the error object itself crashed React.
 *
 * And a fourth that is not ours at all: the hosting platform's own error page. A deploy in
 * progress or a sleeping instance answers 502/503/504 with HTML, which used to reach the
 * screen as "HTTP 502" - true, and no use to anyone. The server's own sentence always wins;
 * these words are only for an answer that had none.
 */
export function errorMessage(data: unknown, status: number): string {
  const said = serverSentence(data);
  if (said) return said;
  const html = typeof data === "string" && /^\s*<(!doctype|html|head|body|\?xml)/i.test(data);
  if (status === 429) return RATE_LIMITED_MESSAGE;
  if (status === 413) return TOO_LARGE_MESSAGE;
  if (status === 502 || status === 503 || status === 504 || (html && status >= 500)) return UNAVAILABLE_MESSAGE;
  if (html) return `The server gave an answer this app could not read (HTTP ${status}). Try again in a minute.`;
  if (status >= 500) return `The server hit an error (HTTP ${status}). Try again in a minute.`;
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
const NO_RETURN = ["/login", "/signup", "/forgot-password", "/reset-password", "/join", "/auth/google", "/verify-email"];

/**
 * The server answered 401 to a request sent with `sentToken`: drop that session.
 *
 * Exported for the few requests that cannot go through apiFetch (a file download needs the
 * raw Response) - they must end a dead session the same way, or a rejected token stays in
 * storage and the app keeps presenting it.
 *
 * Does nothing unless `sentToken` is still the stored token; see the note in apiFetch.
 */
export function rejectSession(sentToken: string | null | undefined) {
  if (!sentToken || auth.token !== sentToken) return;
  markSessionExpired();
  auth.set(null);
}

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
/** A day, without the time: "10 October 2026". For dates that are deadlines, not moments. */
export const fmtDay = (d: string | Date | null | undefined) => {
  if (!d) return "-";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "-" : t.toLocaleDateString(undefined, { dateStyle: "long" });
};
