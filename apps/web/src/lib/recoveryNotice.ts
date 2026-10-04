import { useSyncExternalStore } from "react";
import { auth } from "./api";

/**
 * "You signed in with a recovery code" - whether to say it, and how many codes are left.
 *
 * Kept in sessionStorage so it survives the reload that can follow a sign-in. That also
 * meant it survived things it should not have: signing out (the next person to sign in on
 * that tab was told THEY had used a recovery code), making a new set of codes (the count it
 * quoted was for the old set), and turning two-factor off (there were no codes left to
 * talk about). Each of those now clears it, and the banner listens, so it goes at once
 * rather than on the next page load.
 */
const KEY = "gl.recoveryCodeUsed";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Called by the sign-in step when the server says a recovery code was what got the person in. */
export function noteRecoveryCodeUsed(left: unknown) {
  try {
    sessionStorage.setItem(KEY, typeof left === "number" && left >= 0 ? String(left) : "?");
  } catch {}
  emit();
}

/** The notice no longer applies (dismissed, signed out, new codes made, two-factor off). */
export function clearRecoveryCodeNotice() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
  emit();
}

/** "?" when the count is unknown, the number left as a string, or null when there is nothing to say. */
export function useRecoveryCodeNotice(): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read,
  );
}

// The notice belongs to one signed-in session. Whenever there is no session - signed out,
// expired, ended from another tab - it is gone. (The sign-in step records the notice BEFORE
// it stores the new token, and that event carries a token, so it is not cleared by it.)
auth.subscribe(() => {
  if (!auth.token && read() !== null) clearRecoveryCodeNotice();
});
