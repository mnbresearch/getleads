import { useSyncExternalStore } from "react";
import { API_URL } from "./api";

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
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function adminFetch<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(adminAuth.token ? { authorization: `Bearer ${adminAuth.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    if (res.status === 401) adminAuth.set(null);
    const err = (data as { error?: { message?: string } })?.error;
    throw new AdminApiError(res.status, err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}
