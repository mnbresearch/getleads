/**
 * "Where to go after sign-in" - the only gate a remembered or handed-over path passes
 * before the app navigates to it.
 *
 * The check used to be `startsWith("/") && !startsWith("//")`. That stops "https://evil" and
 * "//evil", but a browser reads several other spellings as "another site":
 *
 *   /\evil.example        a backslash is a slash to the URL parser  ->  //evil.example
 *   /<tab>/evil.example   tabs and newlines are removed before parsing  ->  //evil.example
 *   /.//evil.example      resolves to the path "//evil.example", which is protocol-relative
 *                         the next time anything treats it as a URL
 *
 * So: one leading slash, no backslash and no control character anywhere, and the value must
 * still be a path on this origin after the browser's own parser has had its say. What comes
 * back is the parsed form (path + query + hash), never the raw string.
 *
 * Returns null for anything else; callers fall back to "/".
 */
const BASE = "https://app.invalid";

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 2048) return null;
  if (value[0] !== "/" || value[1] === "/") return null;
  // Backslashes, control characters (tab, CR, LF included) and DEL: never part of a path this app makes.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value, BASE);
  } catch {
    return null;
  }
  if (u.origin !== BASE) return null;
  if (!u.pathname.startsWith("/") || u.pathname.startsWith("//")) return null;
  return u.pathname + u.search + u.hash;
}
