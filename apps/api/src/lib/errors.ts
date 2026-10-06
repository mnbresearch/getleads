import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { QuotaExceededError } from "@prospex/db";
import { ZodError } from "zod";
import { describeIssues } from "./validate.js";

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

/*
 * "The database cannot be reached right now" - as opposed to "the database refused this
 * request". A dropped or refused connection, a failed name lookup, the server shutting down
 * or out of connections. These pass; the caller should simply try again.
 *
 * It matters which one it is: a signed-in request during an outage used to be answered 401
 * (the session check swallowed the error and reported "no such session"), and the web app
 * signs a person out on 401. An outage must never look like a bad session, and never like a
 * broken server (500) either: it is a 503 with a sentence that says to try again.
 */
/** Node's socket and name-lookup failures. Anything that opens a connection can raise these - not only the database. */
const SOCKET_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"]);
/** The Postgres driver's own connection failures: nothing else uses these names. */
const DRIVER_ERROR_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "CONNECTION_CONNECT_TIMEOUT"]);
/** Postgres itself: connection exceptions (class 08), shutting down, starting up, out of connections. */
const isUnavailableSqlState = (code: string) => /^08[0-9A-Z]{3}$/.test(code) || code === "57P01" || code === "57P02" || code === "57P03" || code === "53300";

/** Host and port of the configured database, to recognise a failed connection to it. */
function databaseEndpoint(): { host: string; port: number } | null {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return { host: u.hostname.toLowerCase(), port: Number(u.port) || 5432 };
  } catch {
    return null;
  }
}

/**
 * Is this "the database cannot be reached"?
 *
 * Care is needed because the same low-level error (connection refused, name not found) is
 * raised by every outbound connection this server makes - a customer's webhook, a mail
 * server, a website being read. Those must not be reported as a database outage. So a plain
 * socket error only counts when it demonstrably comes from the database:
 *  - it arrived wrapped by the ORM ("Failed query: ..."), which only wraps database calls;
 *  - or it carries one of the driver's own codes, or a Postgres "cannot connect" SQLSTATE;
 *  - or it is a bare connect / lookup failure naming the database's own host or port (what
 *    opening a transaction raises, which the ORM does not wrap).
 * A failed `fetch` ("fetch failed", with the socket error as its cause) never counts.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  const top = err as { message?: unknown; name?: unknown; constructor?: { name?: string } } | null | undefined;
  if (!top || typeof top !== "object") return false;
  if (top.name === "TypeError" && typeof top.message === "string" && /fetch failed/i.test(top.message)) return false;
  const fromOrm = top.constructor?.name === "DrizzleQueryError" || (typeof top.message === "string" && /^Failed query:/i.test(top.message));
  const db = databaseEndpoint();
  const namesDatabase = (e: { port?: unknown; hostname?: unknown; address?: unknown; host?: unknown }) =>
    !!db && ((typeof e.port === "number" && e.port === db.port) || [e.hostname, e.address, e.host].some((h) => typeof h === "string" && h.toLowerCase() === db.host));
  for (let e: unknown = err, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: unknown; errors?: unknown; port?: unknown; hostname?: unknown; address?: unknown; host?: unknown };
    const code = typeof x.code === "string" ? x.code : "";
    if (DRIVER_ERROR_CODES.has(code) || isUnavailableSqlState(code)) return true;
    // Node reports "tried every address, all refused" as one error holding the attempts.
    const attempts = Array.isArray(x.errors) ? (x.errors as { code?: unknown; port?: unknown; hostname?: unknown; address?: unknown }[]) : [];
    const socketFailure = SOCKET_ERROR_CODES.has(code) || attempts.some((a) => typeof a?.code === "string" && SOCKET_ERROR_CODES.has(a.code));
    if (socketFailure && (fromOrm || namesDatabase(x) || attempts.some((a) => a && namesDatabase(a)))) return true;
  }
  return false;
}

/** What a caller is told while the database cannot be reached. The same sentence the web app uses for a gateway's 503. */
export const TEMPORARILY_UNAVAILABLE = "The server is temporarily unavailable. Try again in a minute.";
export const UNAVAILABLE_RETRY_SECONDS = 10;
export const temporarilyUnavailable = () => new ApiError(503, TEMPORARILY_UNAVAILABLE, "service_unavailable", { retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS });

/** At most one log line per 30 seconds for an outage: every request during it fails the same way. */
let lastUnavailableLog = 0;
export function logDatabaseUnavailable(where: string, err: unknown): void {
  const now = Date.now();
  if (now - lastUnavailableLog < 30_000) return;
  lastUnavailableLog = now;
  const d = describeError(err);
  console.error(`[api] database unavailable (${where}): ${d.name}${d.code ? ` [${d.code}]` : ""}: ${d.message}. Requests are being answered 503 until it is back.`);
}

/** The sentence a caller gets when the database refused one of their values. */
export const UNUSABLE_VALUE_MESSAGE = "Something in that request wasn't in a form we can use. Reload the page and try again.";

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

/**
 * One log line's worth of an unexpected error: class, SQLSTATE, redacted message. Use this
 * instead of `e.message` wherever the error may come from the database - the ORM's message
 * is the whole statement and every bound value (addresses, names, hashes).
 */
export function errorLine(err: unknown): string {
  const d = describeError(err);
  return `${d.name}${d.code ? ` [${d.code}]` : ""}${d.constraint ? ` (${d.constraint})` : ""}: ${d.message}`;
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
  if (err instanceof ApiError) {
    // "Try again later" answers say when: a 429 or 503 whose details carry a wait also
    // carries it as a Retry-After header, the place clients and proxies look for it.
    const wait = (err.details as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
    if ((err.status === 429 || err.status === 503) && typeof wait === "number" && Number.isFinite(wait) && wait > 0) c.header("retry-after", String(Math.ceil(wait)));
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof QuotaExceededError) return c.json({ error: { code: "quota_exceeded", message: err.message, metric: err.metric, used: err.used, limit: err.limit } }, 402);
  // A ZodError thrown from inside a handler (a schema parsed by hand) gets the same readable
  // sentence as one caught by the request validator, instead of a bare "Invalid input".
  if (err instanceof ZodError) return c.json({ error: { code: "validation_error", message: describeIssues(err) || "Invalid input", details: err.flatten(), issues: err.issues } }, 400);
  if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  // Saved credentials that can no longer be decrypted (key rotated, row damaged). Matched by
  // code so this file does not import the crypto module.
  if ((err as { code?: string }).code === "ECREDUNREADABLE") {
    return c.json({ error: { code: "credential_unreadable", message: "A saved credential could not be read. Reconnect that sender or integration in Settings." } }, 409);
  }

  // The database cannot be reached: not this request's fault and not a bug - 503, try again.
  if (isDatabaseUnavailable(err)) {
    logDatabaseUnavailable(`${c.req.method} ${c.req.routePath ?? c.req.path}`, err);
    c.header("retry-after", String(UNAVAILABLE_RETRY_SECONDS));
    return c.json({ error: { code: "service_unavailable", message: TEMPORARILY_UNAVAILABLE, details: { retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS } } }, 503);
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
