/**
 * Text sanitisers for values that come from a caller and end up in a URL or a provider request.
 */

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD so the string is well-formed Unicode.
 *
 * `encodeURIComponent("\ud800")` throws `URIError: URI malformed` on a lone surrogate, and
 * `fetch`/`URL` reject one too. A search term carrying one (easy to send in JSON) therefore
 * turned a provider lookup into an uncaught 500. A lone surrogate cannot represent any real
 * character anyway, so replacing it is lossless for real input.
 *
 * `String.prototype.toWellFormed` does exactly this on Node >= 20; the manual pass is the
 * fallback for older runtimes.
 */
export function wellFormed(s: string): string {
  if (typeof (String.prototype as unknown as { toWellFormed?: () => string }).toWellFormed === "function") {
    return (s as unknown as { toWellFormed: () => string }).toWellFormed();
  }
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** `encodeURIComponent` that never throws on malformed input. */
export function encodeURIComponentSafe(s: string): string {
  return encodeURIComponent(wellFormed(s));
}
