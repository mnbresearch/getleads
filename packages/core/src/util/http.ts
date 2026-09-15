const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ProspexBot/0.1 (+https://prospex.dev/bot)";

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchWithTimeout(url: string, opts: FetchOpts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12_000);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en", ...(opts.headers ?? {}) },
      redirect: "follow",
    });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text|html|json|xml/.test(ct)) return null;
    const max = opts.maxBytes ?? 1_500_000;
    const buf = await res.arrayBuffer();
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, max));
  } catch {
    return null;
  }
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run async tasks with bounded concurrency. */
export async function pMap<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>, concurrency = 5): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
