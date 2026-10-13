import { API_URL } from "./api";

/**
 * Count a view of a public page (landing, pricing, sign-up) for the platform's own funnel.
 *
 * Nothing identifies the visitor: no cookie, no storage, no id. The request carries the path
 * (no query string), the host of the site that linked here and any utm_* tags; the API stores
 * no IP address. A browser with Do Not Track or Global Privacy Control on sends nothing at all
 * (and the API ignores the request too, if one arrives with either header).
 *
 * Sent as text/plain so it is a "simple" request: no CORS preflight, and sendBeacon accepts
 * it. It never throws and nothing waits on it.
 */
const sentThisLoad = new Set<string>();

function optedOut(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
    const w = window as Window & { doNotTrack?: string };
    const dnt = nav.doNotTrack ?? w.doNotTrack ?? nav.msDoNotTrack;
    return nav.globalPrivacyControl === true || dnt === "1" || dnt === "yes";
  } catch {
    return true;
  }
}

function utmTags(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const q = new URLSearchParams(window.location.search);
    for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
      const v = q.get(k);
      if (v) out[k] = v.slice(0, 80);
    }
  } catch {}
  return out;
}

/** Only the referring site's origin is sent; the API keeps its host and nothing else. */
function referrerOrigin(): string | undefined {
  try {
    if (!document.referrer) return undefined;
    const u = new URL(document.referrer);
    return u.origin === window.location.origin ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

export function sendPageView(path: string): void {
  try {
    if (optedOut()) return;
    const clean = path.split(/[?#]/, 1)[0].slice(0, 200);
    if (!clean.startsWith("/")) return;
    // Once per path per page load: StrictMode runs effects twice in development, and a
    // re-render must not count the same view again.
    if (sentThisLoad.has(clean)) return;
    sentThisLoad.add(clean);
    const body = JSON.stringify({ path: clean, ref: referrerOrigin(), ...utmTags() });
    const url = `${API_URL}/v1/public/pv`;
    const blob = new Blob([body], { type: "text/plain" });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, blob)) return;
    void fetch(url, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: true, credentials: "omit", mode: "cors" }).catch(() => {});
  } catch {}
}

/**
 * Call `sendPageView(path)` once, the first time `el` is at least a third on screen. Returns
 * a cleanup function. Without IntersectionObserver nothing is sent: guessing would count
 * views that did not happen.
 */
export function sendPageViewWhenSeen(el: Element | null, path: string): () => void {
  if (!el || typeof IntersectionObserver !== "function") return () => {};
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        sendPageView(path);
        io.disconnect();
      }
    },
    { threshold: 0.33 },
  );
  io.observe(el);
  return () => io.disconnect();
}
