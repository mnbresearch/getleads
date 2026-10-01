import { useSyncExternalStore } from "react";
import { API_URL, errorCode, errorMessage } from "./api";

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

export function useAdminToken(): string | null {
  return useSyncExternalStore(adminAuth.subscribe, () => adminAuth.token);
}

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
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(adminAuth.token ? { authorization: `Bearer ${adminAuth.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new AdminApiError(0, `The server did not respond within ${ADMIN_TIMEOUT_MS / 1000} seconds.`, "timeout");
    throw new AdminApiError(0, "Could not reach the server. Check your connection and try again.", "network_error");
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    if (res.status === 401) adminAuth.set(null);
    throw new AdminApiError(res.status, errorMessage(data, res.status), errorCode(data));
  }
  return data as T;
}
