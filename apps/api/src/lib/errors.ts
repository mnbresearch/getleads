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

/**
 * Postgres SQLSTATEs that mean "the caller sent something unusable", not "the server broke".
 *
 * 22P02 invalid_text_representation - e.g. "abc" into a uuid column, the common case here.
 * 22003 numeric_value_out_of_range, 22007/22008 bad or out-of-range datetime, 22001 value
 * too long for the column. All of them are decided by the request, so all of them are 400s.
 */
const CLIENT_DATA_ERRORS = new Set(["22P02", "22003", "22007", "22008", "22001"]);

/** Dig the SQLSTATE out of a driver error or whatever the ORM wrapped it in. */
function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  if (err instanceof QuotaExceededError) return c.json({ error: { code: "quota_exceeded", message: err.message, metric: err.metric, used: err.used, limit: err.limit } }, 402);
  if (err instanceof ZodError) return c.json({ error: { code: "validation_error", message: "Invalid input", details: err.flatten() } }, 400);
  if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);

  // Postgres rejecting a value the CLIENT supplied is a bad request, not a server fault.
  // Every route that takes an :id passes it straight into a uuid column, so `/v1/leads/abc`
  // reached the database and came back a 500 - which pages an on-call, buries the real
  // errors in the log, and tells the user their data is broken when their URL was.
  const pg = pgCode(err);
  if (pg && CLIENT_DATA_ERRORS.has(pg)) {
    return c.json({ error: { code: "bad_request", message: "One of the values in this request is not in a form the server can use (for example an id that is not a UUID)." } }, 400);
  }

  console.error("[api] unhandled", err);
  return c.json({ error: { code: "internal_error", message: process.env.NODE_ENV === "production" ? "Internal error" : err.message } }, 500);
}
