import { zValidator as baseValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodError } from "zod";

/**
 * Turn zod issues into one readable sentence: "email: Invalid email; steps.0.bodyTemplate: Required".
 *
 * The path is what makes it actionable. "Invalid input" says something is wrong; the path
 * says which box on the form to look at.
 */
export function describeIssues(error: ZodError, fallbackPath = "body"): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.length ? i.path.join(".") : fallbackPath}: ${i.message}`)
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
