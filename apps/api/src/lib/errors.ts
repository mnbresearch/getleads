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

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  if (err instanceof QuotaExceededError) return c.json({ error: { code: "quota_exceeded", message: err.message, metric: err.metric, used: err.used, limit: err.limit } }, 402);
  if (err instanceof ZodError) return c.json({ error: { code: "validation_error", message: "Invalid input", details: err.flatten() } }, 400);
  if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  console.error("[api] unhandled", err);
  return c.json({ error: { code: "internal_error", message: process.env.NODE_ENV === "production" ? "Internal error" : err.message } }, 500);
}
