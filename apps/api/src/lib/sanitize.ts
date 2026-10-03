/**
 * Small, dependency-free cleaners for text that arrives from outside and is later stored,
 * put in an email header, or written into a URL attribute.
 *
 * They live in one file so every ingestion point applies the same rule. The defects these
 * close all had the same shape: one path (POST /v1/leads) validated a value, and a second
 * path to the same column (the CSV import, the public pixel) did not.
 */

/** Postgres text cannot hold U+0000; the driver error for it used to surface as a 500. */
export function stripNul(s: string): string {
  return s.indexOf("\u0000") === -1 ? s : s.replace(/\u0000/g, "");
}

/** `stripNul` over every string in a JSON-shaped value (keys included), without mutating it. */
export function stripNulDeep<T>(v: T, depth = 0): T {
  if (typeof v === "string") return stripNul(v) as unknown as T;
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => stripNulDeep(x, depth + 1)) as unknown as T;
  // Only plain objects: a File, Date or Buffer in a form body is passed through untouched.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // Assigning to `__proto__` on a plain object sets its prototype instead of a key.
    // JSON.parse creates it as an ordinary own key, so it is dropped here, once, for all.
    if (k === "__proto__") continue;
    out[stripNul(k)] = stripNulDeep(x, depth + 1);
  }
  return out as T;
}

/** Remove every C0/C1 control character (CR, LF, TAB, NUL, ESC ...) and the bidi overrides. */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ");
}

/**
 * A tenant-chosen name that is about to go into the SUBJECT of a platform email.
 *
 * The invite and alert emails are sent by Scout, from Scout's address, to an address the
 * tenant picked. The org name, the inviter's name and a saved search's name are all free
 * text, so the subject line was a tenant-authored sentence delivered with our reputation:
 * "ACTION REQUIRED - your mailbox is suspended, sign in at https://phish.example".
 * Control characters are removed (header injection), anything that reads as a link is
 * removed (the phishing payload), and the result is capped.
 */
export function safeHeaderText(raw: unknown, max = 80, fallback = ""): string {
  // Cut first. The result is at most `max` characters, and a link is removed whole, so
  // nothing past a generous window can end up in it - while the patterns below are not
  // linear on a hostile input: `(?:label\.)+` over "a.a.a.a..." re-scanned the rest of the
  // string from every label, 8-20 seconds for a 100 KB workspace name.
  const window = Math.max(2_000, max * 20);
  let s = stripControl(String(raw ?? "").slice(0, window));
  // URLs with a scheme, www. hosts, and host.tld/path shapes. A bare "Acme.io" is left
  // alone: plenty of real companies are named after their domain, and without a scheme or
  // a path it is a name, not a destination.
  s = s.replace(/[a-z][a-z0-9+.-]{0,30}:\/\/\S*/gi, " ").replace(/\bwww\.\S+/gi, " ");
  // At most 8 labels of at most 63 characters: bounded work per starting position, so the
  // pass is linear in the (already cut) input. A longer host still loses its last 8 labels
  // and the path, which is the part that made it a link.
  s = s.replace(/\b(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}\/\S*/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s || fallback;
}

/**
 * A display name for a From header: `Name <address>`.
 *
 * `< > " , ;` are the characters that end the display name and start another mailbox, so a
 * fromName of `CEO <ceo@bigbank.example>, Real` produced a From with two addresses and an
 * envelope sender that was the attacker's choice. They are removed, along with control
 * characters (CRLF injects headers).
 */
export function safeDisplayName(raw: unknown, max = 100): string {
  const s = stripControl(String(raw ?? ""))
    .replace(/[<>",;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, max).trim();
}

/**
 * An http(s) URL, normalised, or null.
 *
 * `z.string().url()` accepts `javascript:alert(1)` and `data:text/html,...`: they are valid
 * URLs. A LinkedIn URL is rendered as an `<a href>` in the app, so storing one was a stored
 * XSS waiting on a click. Anything that is not http or https is refused here.
 */
export function httpUrlOrNull(raw: unknown, maxLength = 2000): string | null {
  if (typeof raw !== "string") return null;
  const s = stripNul(raw).trim();
  if (!s || s.length > maxLength) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return s;
}

/** The bare address out of a `Name <address>` configuration value such as MAIL_FROM. */
export function addressOf(mailbox: string): string {
  const m = mailbox.match(/<([^<>\s]+)>\s*$/);
  return (m ? m[1] : mailbox).trim().toLowerCase();
}
