/**
 * Mask credentials in text that is about to be stored, logged or shown.
 *
 * Upstream error bodies routinely echo what we sent them: the key ("Key sk-... exceeded
 * quota"), the provider-side organisation id, the request URL with `?api_key=` in it. That
 * text was copied into job errors, provider health details and - through the campaign send
 * path - into `campaign_contacts.last_error`, which a tenant reads back over the API.
 *
 * `redact()` is the last line, not the first: callers that face a tenant should say a
 * CATEGORY ("AI unavailable; sent the template") and keep upstream text for operators only.
 */

/** Token shapes that are credentials on sight. Exported for the outreach guard. */
export const SECRET_RE =
  /\b(?:sk|pk|rk|px)_(?:live|test)_[A-Za-z0-9_-]{8,}|\bre_[A-Za-z0-9_]{16,}|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bkey-[A-Za-z0-9_-]{16,}|\bgsk_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/;

/** Env var names whose VALUES must never appear in output. */
const SECRET_ENV = /(_API_KEY|_KEY|_SECRET|_TOKEN|_PASS|_PASSWORD|^JWT_SECRET|^ENCRYPTION_KEY|^DATABASE_URL|^GOOGLE_CSE_CX)$/;

/** Bounded on purpose: an unbounded local part is quadratic on a long run with no "@". */
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;

export interface RedactOptions {
  /** Also mask email addresses (for text shown outside the workspace that owns them). */
  maskEmails?: boolean;
  /** Where configured secrets are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Truncate the result to this many characters. */
  max?: number;
}

/** A long unbroken run that mixes letters and digits is a token, not prose. */
function looksLikeToken(s: string): boolean {
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

export function redact(text: unknown, opts: RedactOptions = {}): string {
  let out = String(text ?? "");
  if (!out) return "";
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  // Our own configured secrets first, by value: whatever shape they have, they are known.
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_ENV.test(k) && out.includes(v)) out = out.split(v).join(`[${k}]`);
  }
  out = out
    // ?api_key=..., &token=..., &password=...
    .replace(/([?&;\s](?:api_?key|apikey|key|token|access_token|refresh_token|api_token|auth|password|passwd|pass|secret|client_secret|signature|sig|cx)=)[^&\s"'<>]+/gi, "$1[redacted]")
    // Authorization: Bearer ..., x-api-key: ...
    .replace(/((?:authorization|proxy-authorization|x-api-key|api-key)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|zoho-oauthtoken\s+)?)[^\s"',}]+/gi, "$1[redacted]")
    // A bare "Bearer <token>" anywhere.
    .replace(/\b(bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    // https://user:password@host
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:[redacted]@")
    // Provider-side account identifiers ("in organization org_abc123").
    .replace(/\b(?:org|proj|acct)[_-][A-Za-z0-9]{8,}\b/g, (m) => (/[0-9]/.test(m) ? "[provider-account-id]" : m))
    .replace(new RegExp(SECRET_RE.source, "g"), "[redacted-key]")
    // Long hex (hashes, hex keys) and long base64-ish runs.
    .replace(/\b[a-fA-F0-9]{32,}\b/g, "[redacted-hex]")
    .replace(/[A-Za-z0-9+_-]{40,}={0,2}/g, (m) => (looksLikeToken(m) ? "[redacted-token]" : m));
  if (opts.maskEmails) out = out.replace(EMAIL_RE, "[email]");
  return opts.max !== undefined ? out.slice(0, opts.max) : out;
}

/**
 * A short, redacted excerpt of an upstream error body: status first, a category the caller
 * supplies, and at most `max` characters of what the provider said.
 */
export function redactedExcerpt(body: unknown, max = 120): string {
  return redact(String(body ?? "").replace(/\s+/g, " ").trim()).slice(0, max);
}
