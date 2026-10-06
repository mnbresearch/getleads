/**
 * Play: an uploaded list of people who engaged - reacted to a post, commented, followed,
 * signed up, attended. Pure: rows in, findings and rejected rows out. No network.
 *
 * The reason says only what the customer told us (what the people did, and to what). The
 * names, titles and companies come from an upload, so they are cleaned like any outside
 * text before they are stored or shown.
 */
import { extractDomain, normalizeLinkedinUrl } from "../util/domain.js";
import { splitName } from "../util/names.js";
import { isPublicHost } from "../util/publicHost.js";
import { finishFinding, safeHttpUrl } from "./shared.js";
import type { PlayFinding } from "./types.js";
import { cleanLine, cleanQuote, playDedupeKey } from "./util.js";

export type Engagement = "reacted" | "commented" | "reposted" | "followed" | "signed_up" | "attended" | "other";

export interface EngagerRow {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
  companyDomain?: string;
  linkedinUrl?: string;
  email?: string;
  location?: string;
  note?: string;
}

const ENGAGEMENTS: Engagement[] = ["reacted", "commented", "reposted", "followed", "signed_up", "attended", "other"];
/** Rows read from one upload. Anything beyond is rejected with a reason, never silently dropped. */
const MAX_ROWS = 5000;

function reasonFor(engagement: Engagement, title: string, author: string): string {
  const quoted = title ? `"${title.replace(/["\u201C\u201D]/g, "'")}"` : "";
  switch (engagement) {
    case "reacted":
    case "commented":
    case "reposted": {
      const verb = engagement === "reacted" ? "Reacted to" : engagement === "commented" ? "Commented on" : "Reposted";
      if (quoted) return `${verb} the post ${quoted}.`;
      if (author) return `${verb} a post by ${author}.`;
      return `${verb} a post on your uploaded list.`;
    }
    case "followed":
      return author ? `Followed ${author}.` : "On your uploaded list of new followers.";
    case "signed_up":
      return quoted ? `Signed up for ${quoted}.` : "On your uploaded list of sign-ups.";
    case "attended":
      return quoted ? `Attended ${quoted}.` : "On your uploaded list of attendees.";
    default:
      if (quoted) return `Engaged with ${quoted}.`;
      if (author) return `Engaged with ${author}.`;
      return "On your uploaded list of people who engaged.";
  }
}

/** A LinkedIn PROFILE link as its canonical URL, or null. The link must really be on linkedin.com. */
function profileUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "linkedin.com" && !/^[a-z0-9-]{1,20}\.linkedin\.com$/.test(host)) return null;
  const li = normalizeLinkedinUrl(`https://www.linkedin.com${u.pathname}`);
  return li && li.includes("/in/") && /\/in\/[^/]{2,100}$/.test(li) ? li : null;
}

function emailOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 254) return null;
  return /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(s) && !/\.\./.test(s) ? s : null;
}

export function engagersFromRows(
  rows: EngagerRow[],
  ctx: { engagement: Engagement; postUrl?: string; postTitle?: string; postAuthor?: string; when?: Date },
): { findings: PlayFinding[]; rejected: { row: number; reason: string }[] } {
  const findings: PlayFinding[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const list = Array.isArray(rows) ? rows : [];
  const engagement: Engagement = ENGAGEMENTS.includes(ctx?.engagement) ? ctx.engagement : "other";
  const postTitle = cleanLine(ctx?.postTitle, 120);
  const postAuthor = cleanLine(ctx?.postAuthor, 120);
  const evidenceUrl = safeHttpUrl(ctx?.postUrl);
  const when = ctx?.when instanceof Date && Number.isFinite(ctx.when.getTime()) ? ctx.when : undefined;
  const reason = reasonFor(engagement, postTitle, postAuthor);
  const evidenceTitle = postTitle || (postAuthor ? `Post by ${postAuthor}` : "Uploaded list");
  const seen = new Map<string, number>();

  for (let i = 0; i < list.length; i++) {
    const rowNo = i + 1;
    if (i >= MAX_ROWS) {
      // One line says it for all the rest.
      rejected.push({ row: rowNo, reason: `Only the first ${MAX_ROWS} rows of an upload are read. Rows ${rowNo} to ${list.length} were not.` });
      break;
    }
    const r = list[i];
    if (!r || typeof r !== "object") {
      rejected.push({ row: rowNo, reason: "The row is empty." });
      continue;
    }
    const gaveLinkedin = typeof r.linkedinUrl === "string" && r.linkedinUrl.trim() !== "";
    const gaveEmail = typeof r.email === "string" && r.email.trim() !== "";
    const linkedinUrl = profileUrl(r.linkedinUrl);
    const email = emailOf(r.email);
    let fullName = cleanLine(r.fullName, 160);
    let firstName = cleanLine(r.firstName, 80);
    let lastName = cleanLine(r.lastName, 80);
    if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (fullName && !firstName && !lastName) {
      const split = splitName(fullName);
      firstName = split.firstName ?? "";
      lastName = split.lastName ?? "";
    }
    const companyName = cleanLine(r.companyName, 160);
    const rawDomain = typeof r.companyDomain === "string" ? r.companyDomain.trim().slice(0, 300) : "";
    const domain = rawDomain ? extractDomain(rawDomain) : null;
    const companyDomain = domain && isPublicHost(domain) ? domain : "";

    if (!linkedinUrl && !email && !(fullName && (companyName || companyDomain))) {
      rejected.push({
        row: rowNo,
        reason:
          gaveLinkedin && !linkedinUrl
            ? "The LinkedIn link is not a profile link (it should look like linkedin.com/in/name)."
            : gaveEmail && !email
              ? "The email address is not valid."
              : "Needs a LinkedIn profile link, an email address, or a name with a company.",
      });
      continue;
    }
    const note = cleanQuote(typeof r.note === "string" ? r.note : "", 500);
    const f = finishFinding({
      kind: "person",
      ...(fullName ? { fullName } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      title: cleanLine(r.title, 200),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(email ? { email } : {}),
      location: cleanLine(r.location, 160),
      ...(companyName ? { companyName } : {}),
      ...(companyDomain ? { companyDomain } : {}),
      relevantBecause: reason,
      ...(evidenceUrl ? { evidenceUrl } : {}),
      evidenceTitle,
      ...(note ? { evidenceQuote: note } : {}),
      signalType: "post_engagement",
      ...(when ? { signalAt: when } : {}),
      confidence: 0.9,
    });
    if (!f) {
      rejected.push({ row: rowNo, reason: "The row could not be read." });
      continue;
    }
    const key = playDedupeKey(f);
    const first = seen.get(key);
    if (first !== undefined) {
      rejected.push({ row: rowNo, reason: `The same person as row ${first}.` });
      continue;
    }
    seen.set(key, rowNo);
    findings.push(f);
  }
  return { findings, rejected };
}
