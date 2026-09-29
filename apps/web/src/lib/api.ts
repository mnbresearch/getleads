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
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(raw ? { "content-type": raw.contentType } : { "content-type": "application/json" }), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
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
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    if (res.status === 401) auth.set(null);
    throw new ProspexError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, data);
  }
  return data as T;
}

export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-");
export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
