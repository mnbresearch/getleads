import { GetLeads, GetLeadsError } from "@getleads/sdk";

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8080";

const TOKEN_KEY = "gl.token";
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
  },
};

export function client() {
  return new GetLeads({ baseUrl: API_URL, token: auth.token ?? undefined });
}

export { GetLeadsError };

export async function apiFetch<T = unknown>(method: string, path: string, body?: unknown, raw?: { contentType: string; body: string }): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(raw ? { "content-type": raw.contentType } : { "content-type": "application/json" }), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    if (res.status === 401) auth.set(null);
    throw new GetLeadsError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, data);
  }
  return data as T;
}

export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-");
export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
