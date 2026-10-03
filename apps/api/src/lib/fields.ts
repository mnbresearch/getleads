import { z } from "zod";
import { canonicalEmail, profileUrlOrNull } from "../services/leads.js";
import { httpUrlOrNull } from "./sanitize.js";

/**
 * Zod fields shared by every route that takes an address or a link.
 *
 * `z.string().email()` and `z.string().url()` were used in some routes and nothing in
 * others, and neither is the rule we want: `.url()` accepts `javascript:` and `data:`, and
 * each route lower-cased (or did not) on its own. These produce the stored form.
 */

/** Exactly one address, returned in canonical form (see canonicalEmail). */
export const emailField = z.string().transform((v, ctx) => {
  const e = canonicalEmail(v);
  if (!e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid email" });
    return z.NEVER;
  }
  return e;
});

/** http(s) only: these are rendered as links, and `javascript:` is a valid URL. */
export const httpUrlField = (max = 500) => z.string().max(max).refine((v) => httpUrlOrNull(v, max) !== null, { message: "Must be a full http:// or https:// URL" });

/**
 * A person's profile link (LinkedIn), returned in the form it is stored: http(s) only.
 * "linkedin.com/in/jane" - how people paste it - is accepted and gets https://.
 */
export const profileUrlField = z.string().max(500).transform((v, ctx) => {
  const u = profileUrlOrNull(v, 500);
  if (!u) {
    // A whole sentence (it ends with a period), so it is shown as written - see describeIssue.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LinkedIn URL must be a web address starting with http:// or https://." });
    return z.NEVER;
  }
  return u;
});
