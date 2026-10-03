import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";
import { audit } from "./audit.js";
import { requireRole, type Env } from "../middleware.js";

/**
 * `requireRole`, with the refusal written to the audit log.
 *
 * A member probing owner-only actions (rotating a webhook secret, turning on a client's
 * public report link) was refused and left no trace. This wraps the same check - it does
 * not re-implement it, so the rule for who passes stays in middleware.ts - and records a
 * `denied` row naming the action before the 403 goes back.
 *
 * `action` is the audit action the request would have performed, e.g. "webhook.secret_rotated".
 */
export function roleGate(action: string, ...roles: string[]): MiddlewareHandler<Env> {
  const inner = requireRole(...roles);
  return async (c, next) => {
    let passed = false;
    // This gate writes the refusal under the action's own name; tell requireRole not to
    // write its generic "role.denied" row as well (one refusal, one row).
    (c as unknown as { set: (k: string, v: unknown) => void }).set("roleAuditHandled", true);
    try {
      await inner(c, async () => {
        passed = true;
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        await audit(c, action, { result: "denied", data: { reason: "role", role: c.get("auth")?.user?.role ?? null, method: c.req.method, path: c.req.path } });
      }
      throw e;
    }
    if (passed) await next();
  };
}

/** Owner or admin (API keys pass, as with requireRole), audited on refusal. */
export const ownerOrAdmin = (action: string) => roleGate(action, "owner", "admin");
