import { zValidator as baseValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z, type ZodError, type ZodIssue, type ZodTypeAny } from "zod";
import { stripNulDeep } from "./sanitize.js";

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

const n = (v: unknown) => (typeof v === "bigint" ? v.toString() : typeof v === "number" ? v.toLocaleString("en-US") : String(v));
const TYPE_WORDS: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  float: "a number",
  bigint: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  date: "a date",
};

/**
 * One zod issue as a sentence a person can act on, or null when zod's own wording is not
 * one of the ones translated here.
 *
 * Zod's defaults are written for a developer reading a stack trace: "String must contain at
 * most 300 character(s)", "Expected number, received nan". They reached customers verbatim -
 * in a toast after saving a form, and as the reason a CSV row was skipped.
 */
function plainIssue(field: string, issue: ZodIssue): string | null {
  switch (issue.code) {
    case "too_big": {
      const max = n(issue.maximum);
      if (issue.type === "string") return issue.exact ? `${field} must be exactly ${max} character${issue.maximum === 1 ? "" : "s"} long` : `${field} is too long (${max} character${issue.maximum === 1 ? "" : "s"} at most)`;
      if (issue.type === "number" || issue.type === "bigint") return issue.inclusive ? `${field} must be ${max} or less` : `${field} must be less than ${max}`;
      if (issue.type === "array" || issue.type === "set") return `${field} has too many items (${max} at most)`;
      return null;
    }
    case "too_small": {
      const min = n(issue.minimum);
      if (issue.type === "string") {
        if (issue.exact) return `${field} must be exactly ${min} character${issue.minimum === 1 ? "" : "s"} long`;
        // "At least 1 character" is an empty box: say that.
        return issue.minimum === 1 ? `${field} is required` : `${field} is too short (at least ${min} characters)`;
      }
      if (issue.type === "number" || issue.type === "bigint") return issue.inclusive ? `${field} must be ${min} or more` : `${field} must be more than ${min}`;
      if (issue.type === "array" || issue.type === "set") return `${field} needs at least ${min} item${issue.minimum === 1 ? "" : "s"}`;
      return null;
    }
    case "invalid_type": {
      if (issue.received === "undefined" || issue.received === "null") return `${field} is required`;
      if (issue.received === "nan" || issue.expected === "number" || issue.expected === "float") return `${field} must be a number`;
      const want = TYPE_WORDS[issue.expected];
      return want ? `${field} must be ${want}` : null;
    }
    case "invalid_enum_value":
      return `${field} must be one of: ${issue.options.slice(0, 20).map(String).join(", ")}`;
    case "invalid_literal":
      return `${field} must be ${JSON.stringify(issue.expected)}`;
    case "invalid_string": {
      if (issue.validation === "email") return `${field} is not a valid email address`;
      if (issue.validation === "url") return `${field} is not a valid web address`;
      if (issue.validation === "uuid") return `${field} is not a valid id`;
      if (issue.validation === "datetime") return `${field} is not a valid date and time`;
      if (issue.validation === "date") return `${field} is not a valid date`;
      if (issue.validation === "regex") return `${field} is not in the expected format`;
      return null;
    }
    case "invalid_date":
      return `${field} is not a valid date`;
    case "not_multiple_of":
      return `${field} must be a multiple of ${n(issue.multipleOf)}`;
    case "not_finite":
      return `${field} must be a number`;
    case "invalid_union":
    case "invalid_union_discriminator":
      return `${field} is not valid`;
    case "unrecognized_keys":
      return `${field} has ${issue.keys.length === 1 ? "a field" : "fields"} that ${issue.keys.length === 1 ? "is" : "are"} not accepted: ${issue.keys.slice(0, 10).join(", ")}`;
    default:
      return null;
  }
}

/** Messages our own schemas write that are zod-flavoured shorthand; the same plain wording. */
const OWN_SHORTHAND: Record<string, (field: string) => string> = {
  "Invalid email": (f) => `${f} is not a valid email address`,
  Required: (f) => `${f} is required`,
};

/**
 * One issue as the customer reads it.
 *
 * A message a schema wrote ITSELF is already written for a person and is kept. How it is
 * shown depends on how it was written:
 *
 *  - a COMPLETE SENTENCE - it ends with a period - names what it is about and is shown
 *    exactly as written: "Send window times must be 24-hour HH:MM, for example 09:00."
 *    Putting the field's name in front of one gave "Send window start: Send window times
 *    must be ..." and "Request: A setting's text is too long ...".
 *  - a fragment ("Enter a sender name using letters or digits") goes after the field's
 *    name: "Sender name: Enter a sender name using letters or digits".
 *
 * So a schema marks its message as complete by ending it with a period. Only zod's
 * built-in wording is replaced.
 */
export function describeIssue(issue: ZodIssue, fallbackPath = "body"): string {
  const field = humanizePath(issue.path, fallbackPath);
  let builtIn: string | undefined;
  try {
    builtIn = z.defaultErrorMap(issue as Parameters<typeof z.defaultErrorMap>[0], { defaultError: "Invalid input", data: undefined }).message;
  } catch {
    builtIn = undefined;
  }
  if (builtIn !== undefined && issue.message === builtIn) return plainIssue(field, issue) ?? `${field}: ${issue.message}`;
  const own = OWN_SHORTHAND[issue.message];
  if (own) return own(field);
  return isCompleteSentence(issue.message) ? issue.message.trim() : `${field}: ${issue.message}`;
}

/** A schema-authored message that stands by itself: starts with a capital (or a quote) and ends with a period. */
function isCompleteSentence(message: string): boolean {
  const m = message.trim();
  return m.length > 1 && m.endsWith(".") && !m.endsWith("..") && /^["'A-Z0-9]/.test(m);
}

/**
 * Turn zod issues into one readable sentence: "Email is not a valid email address; Body
 * template is required".
 *
 * The field name is what makes it actionable. "Invalid input" says something is wrong; the
 * name says which box on the form to look at. The raw paths (and zod's own messages) stay
 * in `issues` for code.
 */
export function describeIssues(error: ZodError, fallbackPath = "body"): string {
  const parts = [...new Set(error.issues.slice(0, 10).map((i) => describeIssue(i, fallbackPath)))];
  // "; " between clauses; a part that is already a finished sentence is followed by a space.
  return parts.map((p, i) => (i === parts.length - 1 ? p : p.endsWith(".") ? `${p} ` : `${p}; `)).join("");
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
    // U+0000 is removed from every string before validation. Postgres text columns cannot
    // hold it, so one NUL in a name used to travel all the way to the INSERT and come back
    // as a 500 - with the whole statement, parameters included, in the log.
    z.preprocess((v) => stripNulDeep(v), schema as ZodTypeAny) as never,
    hook ??
      (((result: { success: boolean; error?: ZodError }, c: Context) => {
        if (!result.success && result.error) return validationFailure(c, result.error, String(target));
      }) as never),
  )) as unknown as typeof baseValidator;

/** Short alias, for new code. */
export const zv = zValidator;
