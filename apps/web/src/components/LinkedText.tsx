import { Fragment } from "react";
import { ExtLink } from "./ExtLink";

/** A web address inside running text, up to the first space or closing bracket/quote. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]{1,2000}/gi;
/** Punctuation that ends the sentence around a link rather than the link itself. */
const TRAILING = /[.,;:!?]+$/;

/**
 * Text that may contain web addresses (a task's body, a note), with each http(s) address
 * made clickable.
 *
 * The text is somebody else's - a reason built from a public page, a link a play found - so
 * it stays text: the pieces between links are rendered as they are, and a link only becomes
 * an anchor through ExtLink (http/https, new tab, no opener, no referrer). Anything that is
 * not a valid http(s) address is left as the characters it is.
 */
export function LinkedText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  const parts: { text: string; link: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const start = m.index ?? 0;
    const url = m[0].replace(TRAILING, "");
    if (!url) continue;
    if (start > at) parts.push({ text: text.slice(at, start), link: false });
    parts.push({ text: url, link: true });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), link: false });
  return (
    <>
      {parts.map((p, i) => (p.link ? <ExtLink key={i} href={p.text} className={className ?? "text-brand-600 underline"} fallback={p.text}>{p.text}</ExtLink> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}
