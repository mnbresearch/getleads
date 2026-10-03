import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { QuotaExceededError } from "@prospex/db";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "error", public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, `${what} not found`, "not_found");
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, msg, "bad_request", details);
export const forbidden = (msg = "Forbidden") => new ApiError(403, msg, "forbidden");
export const nothingToUpdate = () => new ApiError(400, "Nothing to update: send at least one field to change.", "nothing_to_update");

/** Throw a 400 for an empty PATCH body before it reaches Drizzle's "No values to set". */
export function requireSomeFields(body: Record<string, unknown> | undefined | null) {
  if (!body || Object.values(body).every((v) => v === undefined)) throw nothingToUpdate();
}

/**
 * Postgres SQLSTATEs that mean "the caller sent something unusable", not "the server broke".
 *
 * 22P02 invalid_text_representation - e.g. "abc" into a uuid column, the common case here.
 * 22003 numeric_value_out_of_range, 22007/22008 bad or out-of-range datetime, 22001 value
 * too long for the column. All of them are decided by the request, so all of them are 400s.
 *
 * 22021 character_not_in_repertoire (a NUL byte or broken UTF-8 in a text value), 22P05
 * untranslatable_character and 54000 program_limit_exceeded (an index row too large for a
 * 100 KB "name") are the same kind of thing: the value is the caller's, the driver just
 * noticed last.
 */
const CLIENT_DATA_ERRORS = new Set(["22P02", "22003", "22007", "22008", "22001", "22021", "22P05", "54000"]);

/** The sentence a caller gets when the database refused one of their values. */
export const UNUSABLE_VALUE_MESSAGE = "One of the values in this request is not in a form the server can use (for example an id that is not a UUID, or text containing characters that cannot be stored).";

/**
 * Is this a database error caused by the VALUE the caller sent (as opposed to a fault)?
 * Exported for loops that handle rows one by one (the import) and must not echo a driver
 * message back.
 */
export function isClientDataError(err: unknown): boolean {
  const pg = pgError(err);
  return !!pg && CLIENT_DATA_ERRORS.has(pg.code);
}

/**
 * What may be said about an unexpected error - in a log line or to a caller.
 *
 * Drizzle wraps a driver error as `Failed query: <the whole SQL> params: <every bound
 * value>`. Logging the error object therefore wrote a signup's bcrypt hash and email
 * address into the log, and the import loop returned that same text to the client. This
 * keeps what identifies the failure - error class, SQLSTATE, constraint, the driver's own
 * one-line message - and drops the statement and its parameters.
 */
export function describeError(err: unknown): { name: string; code?: string; constraint?: string; message: string } {
  const e = err as { name?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  const pg = pgError(err);
  // Prefer the innermost (driver) message: it names the problem without the statement.
  let msg = "";
  for (let x: unknown = err, depth = 0; x && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    const m = (x as { message?: unknown }).message;
    if (typeof m === "string" && m && !/^Failed query:/i.test(m)) msg = m;
  }
  if (!msg) msg = typeof e?.message === "string" ? e.message : String(err);
  return {
    name: typeof e?.name === "string" ? e.name : "Error",
    ...(pg ? { code: pg.code, ...(pg.constraint ? { constraint: pg.constraint } : {}) } : {}),
    message: redactMessage(msg),
  };
}

/** Cut a message at the point a query, its parameters or a credential would begin. */
export function redactMessage(message: string): string {
  let m = message;
  const cut = m.search(/Failed query:|\bparams:|\binsert into\b|\bupdate\s+"|\bselect\s+"|\bdelete from\b/i);
  if (cut >= 0) m = `${m.slice(0, cut).trim()} [query omitted]`.trim();
  m = m
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g, "[hash]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt]")
    .replace(/\b(px|sk|pk|re|whsec)_[A-Za-z0-9_-]{12,}\b/g, "[key]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, "$1***@")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  return m.replace(/\s+/g, " ").slice(0, 300);
}

/** Dig the SQLSTATE out of a driver error or whatever the ORM wrapped it in. */
function pgError(err: unknown): { code: string; constraint?: string; detail?: string } | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const x = e as { constraint_name?: string; constraint?: string; detail?: string };
      return { code, constraint: x.constraint_name ?? x.constraint, detail: x.detail };
    }
  }
  return undefined;
}

/**
 * Unique-constraint names a person could trip over, in their words. Anything not listed gets
 * the generic sentence; the constraint name itself is never shown, it means nothing to them.
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  leads_org_email_idx: "Another lead in this workspace already has that email address.",
  users_email_idx: "An account with that email address already exists.",
  companies_org_domain_idx: "A company with that domain already exists in this workspace.",
  integrations_uniq: "That integration is already connected.",
  suppressions_uniq: "That address is already suppressed.",
};

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  if (err instanceof QuotaExceededError) return c.json({ error: { code: "quota_exceeded", message: err.message, metric: err.metric, used: err.used, limit: err.limit } }, 402);
  if (err instanceof ZodError) return c.json({ error: { code: "validation_error", message: "Invalid input", details: err.flatten() } }, 400);
  if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  // Saved credentials that can no longer be decrypted (key rotated, row damaged). Matched by
  // code so this file does not import the crypto module.
  if ((err as { code?: string }).code === "ECREDUNREADABLE") {
    return c.json({ error: { code: "credential_unreadable", message: "A saved credential could not be read. Reconnect that sender or integration in Settings." } }, 409);
  }

  // Postgres rejecting a value the CLIENT supplied is a bad request, not a server fault.
  // Every route that takes an :id passes it straight into a uuid column, so `/v1/leads/abc`
  // reached the database and came back a 500 - which pages an on-call, buries the real
  // errors in the log, and tells the user their data is broken when their URL was.
  const pg = pgError(err);
  if (pg && CLIENT_DATA_ERRORS.has(pg.code)) {
    return c.json({ error: { code: "bad_request", message: UNUSABLE_VALUE_MESSAGE } }, 400);
  }
  // 23505: the write collides with a row that already exists - a conflict the caller can
  // resolve (pick another email), not a server fault. Editing a lead's email to one another
  // lead already has used to come back "Internal error".
  if (pg?.code === "23505") {
    return c.json({ error: { code: "conflict", message: (pg.constraint && UNIQUE_MESSAGES[pg.constraint]) ?? "That conflicts with a record that already exists." } }, 409);
  }
  // 23503: the request names a row that is not there (or was deleted mid-request). Ownership
  // checks catch the common case with a 404 first; this is the backstop, so a stale id is a
  // 400 that says so rather than a 500.
  if (pg?.code === "23503") {
    return c.json({ error: { code: "invalid_reference", message: "This request refers to a record that does not exist (it may have been deleted)." } }, 400);
  }
  // 23502: a required value was missing.
  if (pg?.code === "23502") {
    return c.json({ error: { code: "bad_request", message: "A required value is missing from this request." } }, 400);
  }

  // Drizzle refuses an UPDATE with an empty SET. Routes check for an empty PATCH body
  // themselves; this is the backstop for one that does not, so it is a 400 and not a 500.
  if (err.message === "No values to set") return c.json({ error: { code: "bad_request", message: "Nothing to update: the request did not include any field that can be changed." } }, 400);

  // Name, SQLSTATE, a redacted one-line message and the route - never the error object
  // itself, whose `query`/`params` (and message) carry the statement and its bound values.
  const d = describeError(err);
  console.error(`[api] unhandled ${c.req.method} ${c.req.routePath ?? c.req.path}: ${d.name}${d.code ? ` [${d.code}]` : ""}${d.constraint ? ` (${d.constraint})` : ""}: ${d.message}`);
  return c.json({ error: { code: "internal_error", message: process.env.NODE_ENV === "production" ? "Internal error" : d.message } }, 500);
}
