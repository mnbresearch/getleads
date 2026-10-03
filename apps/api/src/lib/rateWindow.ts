import { ApiError } from "./errors.js";

/**
 * Sliding-window counters for actions that send something to a third party.
 *
 * `rateLimit()` in middleware.ts is a per-minute token bucket keyed on the caller. That is
 * the wrong shape for "how many invitation emails may this workspace send in an hour" and
 * cannot express "how many may ONE ADDRESS receive, from anyone": 60 re-sends of one invite
 * went through as 60 emails to a stranger. These are keyed on whatever the caller passes
 * (an org id, a target address) and count over a window.
 *
 * In memory, per process - the same trade-off as `rateLimit()`: right for a single API
 * instance, and to be moved to a shared store with it if the API is ever scaled out.
 */
const MAX_KEYS = 20_000;
const hits = new Map<string, number[]>();

function recent(key: string, windowMs: number, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  return list;
}

/** How many more hits `key` may make in this window (never negative). */
export function windowRemaining(key: string, limit: number, windowMs: number): number {
  return Math.max(0, limit - recent(key, windowMs, Date.now()).length);
}

/** Record one hit. */
export function windowHit(key: string, windowMs: number): void {
  const now = Date.now();
  const list = recent(key, windowMs, now);
  list.push(now);
  hits.delete(key);
  hits.set(key, list);
  if (hits.size > MAX_KEYS) {
    const it = hits.keys();
    for (let n = hits.size - MAX_KEYS; n > 0; n--) hits.delete(it.next().value as string);
  }
}

/**
 * Throw 429 unless every `[key, limit]` pair still has room, then count one hit on each.
 * All-or-nothing: a refused request does not use up anyone's allowance.
 */
export function enforceWindows(checks: { key: string; limit: number; message: string }[], windowMs: number): void {
  const now = Date.now();
  for (const ch of checks) {
    const list = recent(ch.key, windowMs, now);
    if (list.length >= ch.limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000));
      const e = new ApiError(429, ch.message, "rate_limited", { retryAfterSeconds: retryAfter });
      throw e;
    }
  }
  for (const ch of checks) windowHit(ch.key, windowMs);
}

/** Test hook: forget every counter. */
export function resetWindows(): void {
  hits.clear();
}
