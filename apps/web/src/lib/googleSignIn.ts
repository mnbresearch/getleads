import { API_URL } from "./api";

/**
 * Google sign-in, bound to the browser that started it.
 *
 * The API used to finish Google sign-in by redirecting to /auth/google#token=<session JWT>,
 * and this app stored whatever token it found there. That made any link of that shape a
 * login: an attacker could send someone https://app/auth/google#token=<the attacker's own
 * token> and the victim would be silently signed into the attacker's workspace, then upload
 * their leads and mailbox credentials into it (login CSRF / session fixation).
 *
 * Now the browser proves it started the flow, the same way PKCE does:
 *   1. Before leaving for Google, make a random `verifier`, keep it in sessionStorage (this
 *      tab only), and send only its SHA-256 (`cv`) to the API.
 *   2. The API carries `cv` through Google in its signed state and comes back with a
 *      one-time `#code=`, stored server-side next to that `cv`.
 *   3. This app trades {code, verifier} for the session. The API refuses unless
 *      sha256(verifier) matches the `cv` the code was issued for.
 * A code minted in the attacker's browser is useless in the victim's: the victim's tab has
 * no verifier for it. And the code is single-use and short-lived, so one that leaks through
 * history is spent.
 */
const VERIFIER_KEY = "gl.googleVerifier";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create and remember a verifier, and return the URL that starts Google sign-in.
 *
 * `cv` = base64url( SHA-256( the verifier string, as UTF-8 bytes ) ), unpadded - the PKCE
 * S256 construction. The verifier itself is 32 random bytes, base64url, unpadded.
 *
 * Throws with a sentence for the user when the browser cannot do it (no Web Crypto outside a
 * secure context, or storage blocked): without a stored verifier the sign-in could not be
 * completed on the way back, so it is better not to start.
 */
export async function googleStartUrl(params: Record<string, string> = {}): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error("This browser cannot start Google sign-in securely. Sign in with your email and password instead.");
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const cv = base64url(new Uint8Array(digest));
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    if (sessionStorage.getItem(VERIFIER_KEY) !== verifier) throw new Error("not stored");
  } catch {
    throw new Error("Your browser is blocking the storage Google sign-in needs. Allow site data for this page, or sign in with your email and password.");
  }
  const qs = new URLSearchParams(params);
  qs.set("cv", cv);
  return `${API_URL}/v1/auth/google/start?${qs.toString()}`;
}

/** The verifier for the sign-in this tab started, or null. Reading it removes it: one use. */
export function takeGoogleVerifier(): string | null {
  try {
    const v = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    return v || null;
  } catch {
    return null;
  }
}
