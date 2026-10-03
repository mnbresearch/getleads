import type { ReactNode } from "react";
import { EXTERNAL_REL, safeHref } from "../lib/safeHref";

/**
 * A link to somewhere outside the app, built from a value this app did not write.
 *
 * It becomes an anchor only when the URL is http(s) (see lib/safeHref.ts); otherwise
 * `fallback` is rendered - by default nothing, because a label like "LinkedIn ↗" with no
 * link behind it is a dead control. Pass the text as `fallback` when the text is the content
 * (a headline, a result title) and should stay readable without its link.
 *
 * Always a new tab with no opener and no Referer: the page being left often has a lead's
 * name or a report token in its URL, and the destination is a third party.
 */
export function ExtLink({ href, className, children, fallback = null, title }: { href: unknown; className?: string; children: ReactNode; fallback?: ReactNode; title?: string }) {
  const safe = safeHref(href);
  if (!safe) return <>{fallback}</>;
  return (
    <a className={className} href={safe} target="_blank" rel={EXTERNAL_REL} title={title}>
      {children}
    </a>
  );
}
