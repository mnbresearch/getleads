/**
 * Who a stored message or do-not-contact entry is about, as something fit to show.
 *
 * When a lead is deleted, the records the workspace is allowed to keep (that a message was
 * sent, that someone unsubscribed) stay, but without the person in them. The server marks
 * those with `recipientRemoved` and sends no address. An older server stored a one-way
 * fingerprint in the address field instead ("sha256:..."), which must never reach the
 * screen: it means nothing to the reader and looks like a fault.
 */
export const REMOVED_CONTACT = "a removed contact";

export function recipientRemoved(row: { recipientRemoved?: unknown; toEmail?: unknown; email?: unknown } | null | undefined): boolean {
  if (!row) return false;
  if (row.recipientRemoved === true) return true;
  const address = "toEmail" in row ? row.toEmail : row.email;
  if (address === null || address === undefined || address === "") return true;
  return typeof address === "string" && /^sha256:/i.test(address.trim());
}

/** The address, or "a removed contact". */
export function recipientLabel(row: { recipientRemoved?: unknown; toEmail?: unknown; email?: unknown } | null | undefined): string {
  if (recipientRemoved(row)) return REMOVED_CONTACT;
  const address = row && "toEmail" in row ? row.toEmail : row?.email;
  return String(address);
}
