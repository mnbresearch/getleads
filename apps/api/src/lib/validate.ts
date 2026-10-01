import { zValidator as baseValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodError } from "zod";

/** Path segments that only group fields; naming them adds nothing ("Settings daily limit"). */
const CONTAINERS = new Set(["body", "query", "settings", "criteria", "data", "payload", "filters", "params", "config", "options", "credentials"]);
/** Words shown in capitals rather than sentence case. */
const ACRONYMS: Record<string, string> = { url: "URL", id: "ID", icp: "ICP", ai: "AI", api: "API", csv: "CSV", mx: "MX", smtp: "SMTP", crm: "CRM", utc: "UTC" };

function words(seg: string): string[] {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A zod path as a person would name the field: "settings.sendWindow.start" -> "Send window
 * start", "fromEmail" -> "From email", "steps.0.bodyTemplate" -> "Body template".
 *
 * The last segment names the field; its parent is added when the last segment alone is a
 * bare word that means little by itself (start, end, days) and the parent is not just a
 * grouping object like `settings`.
 */
export function humanizePath(path: (string | number)[], fallback = "body"): string {
  const segs = path.filter((p): p is string => typeof p === "string" && !/^\d+$/.test(p));
  if (!segs.length) return fallback === "body" ? "Request" : fallback;
  const last = segs[segs.length - 1];
  // The parent counts only when it directly holds the field: in "leads.0.email" the parent
  // is a list, and "Leads email" reads worse than "Email".
  const lastIdx = path.lastIndexOf(last);
  const directParent = lastIdx > 0 ? path[lastIdx - 1] : null;
  const parent = typeof directParent === "string" && !/^\d+$/.test(directParent) ? directParent : null;
  const bare = words(last).length === 1;
  const parts = parent && bare && !CONTAINERS.has(parent) ? [...words(parent), ...words(last)] : words(last);
  const out = parts.map((w) => ACRONYMS[w] ?? w);
  const first = out[0] ?? last;
  out[0] = first === first.toUpperCase() ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return out.join(" ");
}

/**
 * Turn zod issues into one readable sentence: "Email: Invalid email; Body template: Required".
 *
 * The field name is what makes it actionable. "Invalid input" says something is wrong; the
 * name says which box on the form to look at. The raw paths stay in `issues` for code.
 */
export function describeIssues(error: ZodError, fallbackPath = "body"): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${humanizePath(i.path, fallbackPath)}: ${i.message}`)
    .join("; ");
}

/**
 * The response every request-validation failure gets.
 *
 * @hono/zod-validator's default answers `{ success: false, error: { issues } }`, which is a
 * different shape from every other error this API returns (`{ error: { code, message } }`).
 * The web client reads `error.message`, found none, and showed the user "HTTP 400" - so a
 * form with one bad field said nothing about which field. Same status, one shape.
 */
export function validationFailure(c: Context, error: ZodError, target: string) {
  return c.json({ error: { code: "validation_error", message: describeIssues(error, target === "json" ? "body" : target), issues: error.issues } }, 400);
}

/**
 * Drop-in replacement for @hono/zod-validator's `zValidator` with our error shape as the
 * default hook. Typed as the original so `c.req.valid(...)` inference is unchanged; a route
 * that passes its own hook still gets it.
 */
export const zValidator = ((target: never, schema: never, hook?: never) =>
  baseValidator(
    target,
    schema,
    hook ??
      (((result: { success: boolean; error?: ZodError }, c: Context) => {
        if (!result.success && result.error) return validationFailure(c, result.error, String(target));
      }) as never),
  )) as unknown as typeof baseValidator;

/** Short alias, for new code. */
export const zv = zValidator;
